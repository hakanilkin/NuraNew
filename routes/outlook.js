const express = require('express');

const D = require('../lib/demandSignal');
const S = require('../lib/staffingShape');
const { getParam } = require('../utils/tenantColumns');

// Volume & Staffing Outlook (VolumeOutlook.md).
//
// The question this answers is not "what are all the forecast numbers" — it is
// "over the next two to four weeks, where is volume above or below plan, what
// kind of volume is driving it, and is that day staffed for it". The whole
// chain reads in one exception row, which is why the forward staffing view
// lives here rather than on Staffing Patterns.
//
// Every figure comes from lib/demandSignal.js and lib/staffingShape.js, the same
// modules Staffing Patterns and the ScenarioPanel's Pillar 2 call. Nothing here
// re-derives a room-hour.

const DOW_LABEL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday',
                   'Saturday', 'Sunday'];
const sqlDowToJs = wd => (Number(wd) + 5) % 7;
const num = x => (Number.isFinite(Number(x)) ? Number(x) : 0);
const round1 = x => (x == null ? null : Math.round(x * 10) / 10);

// The four DURwTurn columns, summed the same way the Radar and the Briefs
// forward layer sum them.
const BOOKED_MINS = `
  ISNULL(SCHEDULED_INPATIENT_DURwTurn,0) + ISNULL(SCHEDULED_OUTPATIENT_DURwTurn,0)
+ ISNULL(FORECAST_INPATIENT_DURwTurn,0)  + ISNULL(FORECAST_OUTPATIENT_DURwTurn,0)`;
const FORECAST_CASES = `
  ISNULL(SCHEDULED_INPATIENT,0) + ISNULL(SCHEDULED_OUTPATIENT,0)
+ ISNULL(FORECAST_INPATIENT,0)  + ISNULL(FORECAST_OUTPATIENT,0)`;
const SCHEDULED_CASES = 'ISNULL(SCHEDULED_INPATIENT,0) + ISNULL(SCHEDULED_OUTPATIENT,0)';
const BUDGET_CASES = 'ISNULL(BUDGET_INPATIENT,0) + ISNULL(BUDGET_OUTPATIENT,0)';

module.exports = function outlookRoutes(getTenantPool, sql, requireTenant) {
  const router = express.Router();
  router.use(requireTenant);

  function thresholds(tenant) {
    return {
      onPlanPct:    num(getParam(tenant, 'outlook_on_plan_pct'))    || D.DEFAULT_THRESHOLDS.onPlanPct,
      exceptionPct: num(getParam(tenant, 'outlook_exception_pct'))  || D.DEFAULT_THRESHOLDS.exceptionPct,
      minCases:     num(getParam(tenant, 'outlook_min_cases'))      || D.DEFAULT_THRESHOLDS.minCases,
    };
  }

  const siteFilter = (r, raw, alias = '') => {
    const list = String(raw || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!list.length) return '';
    const ph = list.map((v, i) => { r.input(`site${i}`, sql.NVarChar, v); return `@site${i}`; });
    return ` AND ISNULL(${alias}ORGRP2, 'Unknown') IN (${ph.join(', ')})`;
  };

  // Forecast and budget per date (and optionally per site), over the window.
  async function dailyTotals(db, { days, sites, bySite }) {
    const r = db.request();
    r.input('days', sql.Int, days);
    const filter = siteFilter(r, sites);
    const siteCol = bySite ? "ISNULL(ORGRP2, 'Unknown')" : "'All sites'";
    const res = await r.query(`
      SELECT CONVERT(VARCHAR(10), Date, 23)  AS Date,
             ${siteCol}                      AS Site,
             MIN(DATEPART(WEEKDAY, Date))    AS Wd,
             MIN(DaysAhead)                  AS DaysAhead,
             SUM(${SCHEDULED_CASES})         AS Scheduled,
             SUM(${FORECAST_CASES})          AS Forecast,
             SUM(${BUDGET_CASES})            AS Budget,
             SUM(${BOOKED_MINS})             AS BookedMins
      FROM V4_FORECAST_COMPILE
      WHERE DaysAhead BETWEEN 1 AND @days${filter}
      GROUP BY Date, ${siteCol}
      ORDER BY Date
    `);
    return res.recordset.map(x => ({
      date: x.Date, site: x.Site, dow: sqlDowToJs(x.Wd), daysAhead: num(x.DaysAhead),
      scheduled: round1(num(x.Scheduled)),
      forecast: round1(num(x.Forecast)),
      budget: round1(num(x.Budget)),
      bookedMins: num(x.BookedMins),
    }));
  }

  // Service-line mix for the same window, at the grain the forecast carries.
  async function mixByDate(db, { days, sites, bySite }) {
    const r = db.request();
    r.input('days', sql.Int, days);
    const filter = siteFilter(r, sites);
    const siteCol = bySite ? "ISNULL(ORGRP2, 'Unknown')" : "'All sites'";
    const res = await r.query(`
      SELECT CONVERT(VARCHAR(10), Date, 23)          AS Date,
             ${siteCol}                              AS Site,
             ISNULL(SurgeonService, 'Unknown')       AS Service,
             SUM(${FORECAST_CASES})                  AS Forecast,
             SUM(${BUDGET_CASES})                    AS Budget
      FROM V4_FORECAST_COMPILE
      WHERE DaysAhead BETWEEN 1 AND @days${filter}
      GROUP BY Date, ${siteCol}, SurgeonService
    `);
    const byKey = new Map();
    for (const x of res.recordset) {
      const key = `${x.Date}|${x.Site}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push({
        service: x.Service,
        forecast: round1(num(x.Forecast)),
        budget: round1(num(x.Budget)),
        delta: round1(num(x.Forecast) - num(x.Budget)),
      });
    }
    return byKey;
  }

  // Trailing actual case length by service, for the mix-weighted conversion.
  async function durationsByService(db, sites) {
    const r = db.request();
    const list = String(sites || '').split(',').map(s => s.trim()).filter(Boolean);
    let filter = '';
    if (list.length) {
      const ph = list.map((v, i) => { r.input(`s${i}`, sql.NVarChar, v); return `@s${i}`; });
      filter = ` AND ISNULL(Loc_ORGrp2, 'Unknown') IN (${ph.join(', ')})`;
    }
    const res = await r.query(`
      SELECT ISNULL(Case_SurgeonService, 'Unknown') AS Service,
             AVG(CAST(Dur_ORIn_OROut AS FLOAT))     AS AvgMins
      FROM DS_CASES
      WHERE Case_CanCode IS NULL AND Dur_ORIn_OROut > 0
        AND Date_SchedDate >= DATEADD(week, -12, CAST(GETDATE() AS DATE))
        AND Date_SchedDate <  CAST(GETDATE() AS DATE)${filter}
      GROUP BY Case_SurgeonService
    `);
    return Object.fromEntries(res.recordset.map(x => [x.Service, num(x.AvgMins)]));
  }

  // The staffing plan per site and weekday. Absent for a tenant that has none,
  // which is what keeps RECOMMENDED off those tenants rather than faking it.
  async function plansBySiteDow(db) {
    try {
      const res = await db.request().query(`
        SELECT Site, DayOfWeek, StaffedRooms, CoverageRatio, ShiftStart, ShiftEnd
        FROM StaffingPlan
      `);
      const map = new Map();
      for (const p of res.recordset) {
        map.set(`${p.Site}|${num(p.DayOfWeek) - 1}`, {
          staffedRooms: num(p.StaffedRooms),
          coverageRatio: num(p.CoverageRatio) || 1,
          shiftStart: p.ShiftStart, shiftEnd: p.ShiftEnd,
        });
      }
      return map;
    } catch (err) {
      // No StaffingPlan table on this tenant: degrade to POTENTIAL, never break.
      console.error('/api/outlook staffing plan unavailable:', err.message);
      return new Map();
    }
  }

  const parseWeeks = q => Math.min(Math.max(parseInt(q, 10) || 4, 1), 12);

  // ── GET /api/outlook/calendar ─────────────────────────────────────────────
  router.get('/calendar', async (req, res) => {
    try {
      const tenant = req.tenantName || 'default';
      const weeks = parseWeeks(req.query.weeks);
      const t = thresholds(tenant);
      const db = await getTenantPool(req.session.tenantId);
      const rows = await dailyTotals(db, {
        days: weeks * 7, sites: req.query.sites, bySite: req.query.bySite === 'true',
      });

      const byWeek = new Map();
      for (const row of rows.filter(x => x.dow < 5)) {
        const v = D.variance(row.forecast, row.budget);
        const d = new Date(`${row.date}T00:00:00`);
        d.setDate(d.getDate() - row.dow);              // the Monday of that week
        const weekOf = d.toISOString().slice(0, 10);
        if (!byWeek.has(weekOf)) byWeek.set(weekOf, []);
        byWeek.get(weekOf).push({
          date: row.date, dow: row.dow, label: DOW_LABEL[row.dow],
          site: row.site, forecast: v.forecast, budget: v.budget,
          variance: v.variance, variancePct: v.variancePct,
          onPlan: D.isOnPlan(v, t),
        });
      }
      res.json({
        weeks: [...byWeek.entries()].sort((a, b) => a[0].localeCompare(b[0]))
          .map(([weekOf, days]) => ({ weekOf, days: days.sort((a, b) => a.dow - b.dow) })),
        thresholds: t,
      });
    } catch (err) {
      console.error('/api/outlook/calendar error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/outlook/exceptions ───────────────────────────────────────────
  // The whole chain in one row: demand, driver, staffing implication, tier. The
  // flex computation is composed here rather than linked to, so a row is one
  // request and cannot disagree with itself.
  router.get('/exceptions', async (req, res) => {
    try {
      const tenant = req.tenantName || 'default';
      const weeks = parseWeeks(req.query.weeks);
      const t = thresholds(tenant);
      const db = await getTenantPool(req.session.tenantId);
      const days = weeks * 7;

      const [rows, mix, durations, plans] = await Promise.all([
        dailyTotals(db, { days, sites: req.query.sites, bySite: true }),
        mixByDate(db, { days, sites: req.query.sites, bySite: true }),
        durationsByService(db, req.query.sites),
        plansBySiteDow(db),
      ]);

      const turnover = num(getParam(tenant, 'turnover_minutes')) || 33;
      const exceptions = [];
      for (const row of rows) {
        if (row.dow > 4) continue;
        const v = D.variance(row.forecast, row.budget);
        if (!D.isException(v, t)) continue;
        const dayMix = mix.get(`${row.date}|${row.site}`) || [];
        exceptions.push(D.buildSignal({
          date: row.date, site: row.site, v,
          drivers: D.primaryDrivers(dayMix),
          plan: plans.get(`${row.site}|${row.dow}`) || null,
          mix: dayMix, durationsByService: durations,
          bookedMinutes: row.bookedMins, turnoverMinutes: turnover,
        }));
      }
      // Biggest miss first, in cases — the unit a director acts on.
      exceptions.sort((a, b) => Math.abs(num(b.variance)) - Math.abs(num(a.variance)));

      res.json({ weeks, exceptions, thresholds: t });
    } catch (err) {
      console.error('/api/outlook/exceptions error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/outlook/daily ────────────────────────────────────────────────
  router.get('/daily', async (req, res) => {
    try {
      const weeks = parseWeeks(req.query.weeks);
      const db = await getTenantPool(req.session.tenantId);
      const rows = await dailyTotals(db, {
        days: weeks * 7, sites: req.query.sites, bySite: true,
      });
      res.json({
        rows: rows.filter(x => x.dow < 5).map(row => {
          const v = D.variance(row.forecast, row.budget);
          return {
            date: row.date, dow: row.dow, label: DOW_LABEL[row.dow], site: row.site,
            scheduled: row.scheduled,
            // The mechanics, kept as the subtitle rather than the headline.
            expectedAdds: round1(num(row.forecast) - num(row.scheduled)),
            ...v,
          };
        }),
      });
    } catch (err) {
      console.error('/api/outlook/daily error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/outlook/daily/:date/mix ──────────────────────────────────────
  router.get('/daily/:date/mix', async (req, res) => {
    try {
      const date = String(req.params.date);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
      }
      const r = (await getTenantPool(req.session.tenantId)).request();
      r.input('date', sql.Date, date);
      const filter = siteFilter(r, req.query.site);
      const out = await r.query(`
        SELECT ISNULL(SurgeonService, 'Unknown') AS Service,
               SUM(${FORECAST_CASES})            AS Forecast,
               SUM(${BUDGET_CASES})              AS Budget
        FROM V4_FORECAST_COMPILE
        WHERE CAST(Date AS DATE) = @date${filter}
        GROUP BY SurgeonService
        ORDER BY SUM(${FORECAST_CASES}) DESC
      `);
      res.json({
        date,
        services: out.recordset.map(x => ({
          service: x.Service,
          forecast: round1(num(x.Forecast)),
          budget: round1(num(x.Budget)),
          delta: round1(num(x.Forecast) - num(x.Budget)),
        })),
      });
    } catch (err) {
      console.error('/api/outlook/daily/:date/mix error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/outlook/flex ─────────────────────────────────────────────────
  // Absorbed from /api/staffing/forward. Same lib/staffingShape.js call the
  // exception rows make, so the two surfaces cannot show different rooms.
  router.get('/flex', async (req, res) => {
    try {
      const weeks = parseWeeks(req.query.weeks);
      const db = await getTenantPool(req.session.tenantId);
      const [rows, plans] = await Promise.all([
        dailyTotals(db, { days: weeks * 7, sites: req.query.sites, bySite: true }),
        plansBySiteDow(db),
      ]);

      const days = rows.filter(x => x.dow < 5).map(row => {
        const plan = plans.get(`${row.site}|${row.dow}`);
        if (!plan) return null;
        const implied = S.impliedRooms(row.bookedMins, plan);
        const flag = S.flexFlag(plan.staffedRooms, implied);
        const shiftMins = S.hhmmToMinutes(plan.shiftEnd) - S.hhmmToMinutes(plan.shiftStart);
        return {
          date: row.date, dow: row.dow, label: DOW_LABEL[row.dow], site: row.site,
          daysAhead: row.daysAhead,
          plannedRooms: plan.staffedRooms,
          impliedRooms: implied,
          recommendedRooms: S.recommendedRooms(implied, plan.staffedRooms),
          bookedRoomHours: round1(row.bookedMins / 60),
          flag,
          drivers: [
            { key: 'booked', label: 'Booked room-time',
              detail: `${round1(row.bookedMins / 60)} room-hours booked including turnover.` },
            { key: 'implied', label: 'Implied rooms',
              detail: `Over a ${round1(shiftMins / 60)}-hour shift that needs ${implied} rooms; `
                    + `the plan staffs ${plan.staffedRooms}.` },
          ],
        };
      }).filter(Boolean);

      res.json({ weeks, days });
    } catch (err) {
      console.error('/api/outlook/flex error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
};

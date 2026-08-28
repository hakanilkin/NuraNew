const express = require('express');

const D = require('../lib/demandSignal');
const S = require('../lib/staffingShape');
const F = require('../lib/censusFootprint');
const R = require('../lib/recoveryDemand');
const { getParam } = require('../utils/tenantColumns');

// Volume Impact (VolumeImpact.md).
//
// Everything downstream of the surgical schedule is a consequence of forecasted
// volume, so this is one page asking "what does the volume coming at us do to
// the rest of the operation" across four tabs: budget, beds, rooms, recovery.
//
// Every number comes from a shared lib — demandSignal, staffingShape,
// censusFootprint, recoveryDemand — the same modules the ScenarioPanel's pillars
// compute from. No tab recomputes what another already has.

const DOW_LABEL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday',
                   'Saturday', 'Sunday'];
const sqlDowToJs = wd => (Number(wd) + 5) % 7;
const num = x => (Number.isFinite(Number(x)) ? Number(x) : 0);
const round1 = x => (x == null ? null : Math.round(x * 10) / 10);
const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

const BOOKED_MINS = `
  ISNULL(SCHEDULED_INPATIENT_DURwTurn,0) + ISNULL(SCHEDULED_OUTPATIENT_DURwTurn,0)
+ ISNULL(FORECAST_INPATIENT_DURwTurn,0)  + ISNULL(FORECAST_OUTPATIENT_DURwTurn,0)`;
const SCHED_MINS = 'ISNULL(SCHEDULED_INPATIENT_DURwTurn,0) + ISNULL(SCHEDULED_OUTPATIENT_DURwTurn,0)';
const FORECAST_CASES = `
  ISNULL(SCHEDULED_INPATIENT,0) + ISNULL(SCHEDULED_OUTPATIENT,0)
+ ISNULL(FORECAST_INPATIENT,0)  + ISNULL(FORECAST_OUTPATIENT,0)`;
const SCHEDULED_CASES = 'ISNULL(SCHEDULED_INPATIENT,0) + ISNULL(SCHEDULED_OUTPATIENT,0)';
const BUDGET_CASES = 'ISNULL(BUDGET_INPATIENT,0) + ISNULL(BUDGET_OUTPATIENT,0)';

module.exports = function impactRoutes(getTenantPool, sql, requireTenant) {
  const router = express.Router();
  router.use(requireTenant);

  // ── Shared context ────────────────────────────────────────────────────────
  // One header sets site and window for every tab, so the four consequences are
  // always of the same forecast.
  function windowOf(q) {
    const today = new Date();
    const from = isDate(q.from) ? q.from
      : new Date(today.getTime() + 86400000).toISOString().slice(0, 10);
    const to = isDate(q.to) ? q.to
      : new Date(today.getTime() + 28 * 86400000).toISOString().slice(0, 10);
    return { from, to };
  }

  const thresholds = tenant => ({
    onPlanPct:    num(getParam(tenant, 'impact_on_plan_pct'))    || 5,
    exceptionPct: num(getParam(tenant, 'outlook_exception_pct')) || 15,
    minCases:     num(getParam(tenant, 'outlook_min_cases'))     || 4,
    crunchPct:    num(getParam(tenant, 'crunch_occupancy_pct'))  || 92,
    underWeight:  num(getParam(tenant, 'under_weight'))          || 1.0,
    overWeight:   num(getParam(tenant, 'over_weight'))           || 0.6,
  });

  function siteFilter(r, raw, col = 'ORGRP2') {
    const list = String(raw || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!list.length) return '';
    const ph = list.map((v, i) => { r.input(`site${i}`, sql.NVarChar, v); return `@site${i}`; });
    return ` AND ISNULL(${col}, 'Unknown') IN (${ph.join(', ')})`;
  }

  // Per date (and optionally site) over the window. The booked/expected split is
  // carried everywhere, because collapsing it is what makes a booked-schedule
  // tool under-count four weeks out.
  async function dailyTotals(db, { from, to, sites, bySite }) {
    const r = db.request();
    r.input('from', sql.Date, from);
    r.input('to', sql.Date, to);
    const filter = siteFilter(r, sites);
    const siteCol = bySite ? "ISNULL(ORGRP2, 'Unknown')" : "'All sites'";
    const groupBy = bySite ? `CAST(Date AS DATE), ${siteCol}` : 'CAST(Date AS DATE)';
    const res = await r.query(`
      SELECT CONVERT(VARCHAR(10), CAST(Date AS DATE), 23) AS Date,
             ${siteCol}                                   AS Site,
             MIN(DATEPART(WEEKDAY, Date))                 AS Wd,
             SUM(${SCHEDULED_CASES})                      AS Booked,
             SUM(${FORECAST_CASES})                       AS Forecast,
             SUM(${BUDGET_CASES})                         AS Budget,
             SUM(${BOOKED_MINS})                          AS ForecastMins,
             SUM(${SCHED_MINS})                           AS BookedMins
      FROM V4_FORECAST_COMPILE
      WHERE CAST(Date AS DATE) BETWEEN @from AND @to${filter}
      GROUP BY ${groupBy}
      ORDER BY CAST(Date AS DATE)
    `);
    return res.recordset.map(x => ({
      date: x.Date, site: x.Site, dow: sqlDowToJs(x.Wd),
      booked: round1(num(x.Booked)),
      forecast: round1(num(x.Forecast)),
      budget: round1(num(x.Budget)),
      expectedAdds: round1(num(x.Forecast) - num(x.Booked)),
      forecastMins: num(x.ForecastMins),
      bookedMins: num(x.BookedMins),
    }));
  }

  async function plansBySiteDow(db) {
    try {
      const res = await db.request().query(`
        SELECT Site, DayOfWeek, StaffedRooms, CoverageRatio, ShiftStart, ShiftEnd
        FROM StaffingPlan
      `);
      const map = new Map();
      for (const p of res.recordset) {
        map.set(`${p.Site}|${num(p.DayOfWeek) - 1}`, {
          staffedRooms: num(p.StaffedRooms), coverageRatio: num(p.CoverageRatio) || 1,
          shiftStart: p.ShiftStart, shiftEnd: p.ShiftEnd,
        });
      }
      return map;
    } catch (err) {
      // A tenant without a staffing plan loses this tab, not the page.
      console.error('/api/impact staffing plan unavailable:', err.message);
      return new Map();
    }
  }

  // ── Which tabs this tenant can actually show ─────────────────────────────
  router.get('/tabs', async (req, res) => {
    try {
      const db = await getTenantPool(req.session.tenantId);
      const has = async (table) => {
        try {
          await db.request().query(`SELECT TOP 1 1 AS ok FROM ${table}`);
          return true;
        } catch { return false; }
      };
      const [unitMap, plan, recovery] = await Promise.all([
        has('ServiceUnitMap'), has('StaffingPlan'), has('ServiceRecoveryProfile'),
      ]);
      // Budget needs only the forecast, which every tenant has.
      res.json({ budget: true, inpatient: unitMap, staffing: plan, recovery });
    } catch (err) {
      console.error('/api/impact/tabs error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/impact/summary ──────────────────────────────────────────────
  router.get('/summary', async (req, res) => {
    try {
      const db = await getTenantPool(req.session.tenantId);
      const { from, to } = windowOf(req.query);
      const rows = await dailyTotals(db, { from, to, sites: req.query.sites, bySite: false });
      const sum = k => round1(rows.reduce((s, x) => s + num(x[k]), 0));
      const forecast = sum('forecast');
      const budget = sum('budget');
      const v = D.variance(forecast, budget);
      res.json({
        from, to,
        forecast, budget,
        // Never one figure: the split is the answer to "why isn't this the
        // EMR's own report".
        booked: sum('booked'),
        expectedAdds: sum('expectedAdds'),
        variance: v.variance, variancePct: v.variancePct,
        days: rows.length,
      });
    } catch (err) {
      console.error('/api/impact/summary error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Tab 1 — Budget ───────────────────────────────────────────────────────
  router.get('/budget', async (req, res) => {
    try {
      const tenant = req.tenantName || 'default';
      const t = thresholds(tenant);
      const db = await getTenantPool(req.session.tenantId);
      const { from, to } = windowOf(req.query);
      const bySite = req.query.bySite === 'true';
      const rows = (await dailyTotals(db, { from, to, sites: req.query.sites, bySite }))
        .filter(x => x.dow < 5);

      const byWeek = new Map();
      const days = [];
      for (const row of rows) {
        const v = D.variance(row.forecast, row.budget);
        const flagged = D.isException(v, t);
        days.push({
          date: row.date, dow: row.dow, label: DOW_LABEL[row.dow], site: row.site,
          booked: row.booked, expectedAdds: row.expectedAdds, ...v, flagged,
        });

        const d = new Date(`${row.date}T00:00:00`);
        d.setDate(d.getDate() - row.dow);
        const weekOf = d.toISOString().slice(0, 10);
        if (!byWeek.has(weekOf)) byWeek.set(weekOf, []);
        byWeek.get(weekOf).push({
          date: row.date, dow: row.dow, label: DOW_LABEL[row.dow], site: row.site,
          forecast: v.forecast, budget: v.budget,
          variance: v.variance, variancePct: v.variancePct,
          onPlan: D.isOnPlan(v, t), flagged,
        });
      }

      res.json({
        from, to, thresholds: t,
        grid: [...byWeek.entries()].sort((a, b) => a[0].localeCompare(b[0]))
          .map(([weekOf, d]) => ({ weekOf, days: d.sort((a, b) => a.dow - b.dow) })),
        days,
      });
    } catch (err) {
      console.error('/api/impact/budget error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/budget/:date/mix', async (req, res) => {
    try {
      if (!isDate(req.params.date)) {
        return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
      }
      const r = (await getTenantPool(req.session.tenantId)).request();
      r.input('date', sql.Date, req.params.date);
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
        date: req.params.date,
        services: out.recordset.map(x => ({
          service: x.Service,
          forecast: round1(num(x.Forecast)),
          budget: round1(num(x.Budget)),
          delta: round1(num(x.Forecast) - num(x.Budget)),
        })),
      });
    } catch (err) {
      console.error('/api/impact/budget/:date/mix error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Tab 2 — Inpatient ────────────────────────────────────────────────────
  // Projected census for the window, from the trailing pattern for that unit
  // and weekday, with the controllable share traced back through
  // DS_Bedplacement. Computed in lib/censusFootprint.js, which Pillar 3 also
  // calls, so the page and the panel cannot disagree.
  router.get('/inpatient', async (req, res) => {
    try {
      const tenant = req.tenantName || 'default';
      const t = thresholds(tenant);
      const db = await getTenantPool(req.session.tenantId);
      const { from, to } = windowOf(req.query);
      const weeks = 8;

      const [census, occupants] = await Promise.all([
        db.request().input('weeks', sql.Int, weeks).query(`
          SELECT c.Unit, c.StaffedBeds,
                 DATEPART(WEEKDAY, o.Datehour)  AS Wd,
                 AVG(CAST(o.Occupancy AS FLOAT)) AS Census
          FROM UnitCapacity c
          JOIN DS_Occupancy o ON o.DEP_NAME = c.Unit
          WHERE DATEPART(HOUR, o.Datehour) = 7
            AND o.Datehour >= DATEADD(week, -@weeks, CAST(GETDATE() AS DATE))
          GROUP BY c.Unit, c.StaffedBeds, DATEPART(WEEKDAY, o.Datehour)
        `),
        db.request().input('weeks', sql.Int, weeks).query(`
          WITH census_times AS (
            SELECT DISTINCT DEP_NAME AS Unit, Datehour
            FROM DS_Occupancy
            WHERE DATEPART(HOUR, Datehour) = 7
              AND Datehour >= DATEADD(week, -@weeks, CAST(GETDATE() AS DATE))
          )
          SELECT ct.Unit, DATEPART(WEEKDAY, ct.Datehour) AS Wd,
                 COUNT(*) AS Occupants,
                 SUM(CASE WHEN b.SOURCE_DEPTLOC = 'Surgery'
                            OR b.SOURCE_DEPTNAME LIKE '%PACU%'      THEN 1 ELSE 0 END) AS OrOccupants,
                 SUM(CASE WHEN b.SOURCE_DEPTNAME LIKE '%EMERGENCY%' THEN 1 ELSE 0 END) AS EdOccupants
          FROM census_times ct
          JOIN DS_Encounters e
            ON e.DEP_LASTDEPTLOC = ct.Unit
           AND e.TIME_HOSPADMISSION <= ct.Datehour
           AND e.TIME_HOSPDISCHARGE >  ct.Datehour
          LEFT JOIN DS_Bedplacement b
            ON b.EPICCSN = e.EPICCSN AND b.EVENT_TYPE_MOD = 'Admission'
          GROUP BY ct.Unit, DATEPART(WEEKDAY, ct.Datehour)
        `),
      ]);

      const shares = new Map();
      for (const a of occupants.recordset) {
        const total = num(a.Occupants);
        if (!total) continue;
        shares.set(`${a.Unit}|${sqlDowToJs(a.Wd)}`,
          { or: num(a.OrOccupants) / total, ed: num(a.EdOccupants) / total });
      }
      const byUnitDow = new Map();
      for (const c of census.recordset) {
        byUnitDow.set(`${c.Unit}|${sqlDowToJs(c.Wd)}`,
          { census: num(c.Census), capacity: num(c.StaffedBeds) });
      }

      // Every weekday date in the window.
      const dates = [];
      for (let d = new Date(`${from}T00:00:00`); d <= new Date(`${to}T00:00:00`);
           d.setDate(d.getDate() + 1)) {
        const dow = (d.getDay() + 6) % 7;
        if (dow < 5) dates.push({ date: d.toISOString().slice(0, 10), dow });
      }

      const unitNames = [...new Set(census.recordset.map(c => c.Unit))].sort();
      const units = unitNames.map(unit => {
        const days = dates.map(({ date, dow }) => {
          const base = byUnitDow.get(`${unit}|${dow}`);
          if (!base) return { date, dow, label: DOW_LABEL[dow], census: null, crunch: false };
          const share = shares.get(`${unit}|${dow}`) || { or: 0, ed: 0 };
          return {
            date, dow, label: DOW_LABEL[dow],
            ...F.attributeCensus({
              census: base.census, capacity: base.capacity,
              orAdmitted: base.census * share.or,
              edAdmitted: base.census * share.ed,
            }, t.crunchPct),
          };
        });
        return { unit, capacity: days.find(d => d.capacity)?.capacity ?? null, days };
      });

      // One suggestion per crunch cluster, stated plainly. Not a scenario
      // builder — the panel is where "what if" lives.
      const crunchByDow = new Map();
      for (const u of units) {
        for (const d of u.days) {
          if (!d.crunch) continue;
          const k = d.dow;
          crunchByDow.set(k, (crunchByDow.get(k) || 0) + 1);
        }
      }
      const suggestions = [];
      if (crunchByDow.size) {
        const worst = [...crunchByDow.entries()].sort((a, b) => b[1] - a[1])[0];
        const lightest = [0, 1, 2, 3, 4]
          .filter(d => !crunchByDow.has(d))
          .sort((a, b) => (crunchByDow.get(a) || 0) - (crunchByDow.get(b) || 0))[0];
        if (lightest != null) {
          const totalCrunch = [...crunchByDow.values()].reduce((s, n) => s + n, 0);
          suggestions.push({
            fromDow: worst[0], toDow: lightest,
            text: `Shifting inpatient-heavy cases from ${DOW_LABEL[worst[0]]} to `
                + `${DOW_LABEL[lightest]} would relieve ${worst[1]} of ${totalCrunch} `
                + `crunch unit-days in this window.`,
          });
        }
      }

      res.json({ from, to, crunchOccupancyPct: t.crunchPct, units, suggestions });
    } catch (err) {
      console.error('/api/impact/inpatient error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Tab 3 — Staffing ─────────────────────────────────────────────────────
  router.get('/staffing', async (req, res) => {
    try {
      const tenant = req.tenantName || 'default';
      const t = thresholds(tenant);
      const target = num(getParam(tenant, 'block_fill_target')) || 75;
      const db = await getTenantPool(req.session.tenantId);
      const { from, to } = windowOf(req.query);

      const [rows, plans, releasable] = await Promise.all([
        dailyTotals(db, { from, to, sites: req.query.sites, bySite: true }),
        plansBySiteDow(db),
        // Blocks on a given day that are booked below target — the time that
        // could be sold rather than given up.
        (async () => {
          const r = db.request();
          r.input('from', sql.Date, from);
          r.input('to', sql.Date, to);
          const filter = siteFilter(r, req.query.sites);
          const out = await r.query(`
            SELECT CONVERT(VARCHAR(10), CAST(Date AS DATE), 23) AS Date,
                   ISNULL(ORGRP2, 'Unknown')                    AS Site,
                   ISNULL(Caseblock, 'Unknown')                 AS CaseBlock,
                   SUM(ISNULL(BLOCKTIME, 0))                    AS BlockMins,
                   SUM(${SCHED_MINS})                           AS BookedMins
            FROM V4_FORECAST_COMPILE
            WHERE CAST(Date AS DATE) BETWEEN @from AND @to
              AND ISNULL(Caseblock, 'Unknown') <> 'Open'${filter}
            GROUP BY Date, ORGRP2, Caseblock
            HAVING SUM(ISNULL(BLOCKTIME, 0)) > 0
          `);
          const map = new Map();
          for (const x of out.recordset) {
            const fill = num(x.BlockMins) > 0 ? (num(x.BookedMins) / num(x.BlockMins)) * 100 : null;
            if (fill == null || fill >= target) continue;
            const k = `${x.Date}|${x.Site}`;
            if (!map.has(k)) map.set(k, []);
            map.get(k).push({ caseBlock: x.CaseBlock, fillPct: round1(fill),
                              hours: round1(num(x.BlockMins) / 60) });
          }
          return map;
        })(),
      ]);

      const days = rows.filter(x => x.dow < 5).map(row => {
        const plan = plans.get(`${row.site}|${row.dow}`);
        if (!plan) return null;
        const implied = S.impliedRooms(row.forecastMins, plan);
        const shiftMins = S.hhmmToMinutes(plan.shiftEnd) - S.hhmmToMinutes(plan.shiftStart);
        const cover = S.coverageImpact(
          { staffedRooms: plan.staffedRooms, shiftHours: shiftMins / 60,
            requiredRoomHours: row.forecastMins / 60, coverageRatio: plan.coverageRatio },
          0, num(getParam(tenant, 'isscm')?.packingCeiling) || 0.85);

        const slack = plan.staffedRooms - implied;
        // Under and over are not symmetric: a room short costs late finishes,
        // overtime and possibly a cancellation; a room over costs idle salary.
        const flag = slack <= -t.underWeight ? 'UNDER'
          : slack >= 2 / t.overWeight ? 'OVER' : null;

        const spare = releasable.get(`${row.date}|${row.site}`) || [];
        let implication, link = null;
        if (flag === 'UNDER') {
          implication = `Booked volume implies ${implied} rooms against ${plan.staffedRooms} `
                      + `staffed; about ${round1(cover.overtimeAfter)} room-hours would run past shift end.`;
        } else if (flag === 'OVER' && spare.length) {
          // Fill before flex. Flex-down language belongs only where the time
          // genuinely cannot be sold, and nurse leaders hear it as a cut.
          implication = `${spare.length} block${spare.length === 1 ? '' : 's'} `
                      + `(${round1(spare.reduce((s, x) => s + x.hours, 0))}h) are booked under `
                      + `${target}% — consider releasing and re-offering before reducing rooms.`;
          link = { label: 'Open Release Time Mgmt', href: '/open-time/radar' };
        } else if (flag === 'OVER') {
          implication = `Booked volume implies ${implied} rooms against ${plan.staffedRooms} `
                      + `staffed, and no block on this day has sellable time left.`;
        } else {
          implication = `Booked volume implies ${implied} rooms against ${plan.staffedRooms} staffed.`;
        }

        return {
          date: row.date, dow: row.dow, label: DOW_LABEL[row.dow], site: row.site,
          impliedRooms: implied, staffedRooms: plan.staffedRooms,
          bookedRoomHours: round1(row.forecastMins / 60),
          lateDayHours: round1(cover.overtimeAfter),
          flag, implication, link,
          releasable: spare,
        };
      }).filter(Boolean);

      res.json({ from, to, blockFillTarget: target, days });
    } catch (err) {
      console.error('/api/impact/staffing error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Tab 4 — PACU & ancillary ─────────────────────────────────────────────
  // Bay demand, not nurse ratios. Always POTENTIAL, and the tier is a field.
  router.get('/recovery', async (req, res) => {
    try {
      const db = await getTenantPool(req.session.tenantId);
      const { from, to } = windowOf(req.query);

      const [profRes, bayRes] = await Promise.all([
        db.request().query('SELECT Service, PreOpMins, Phase1Mins, Phase2Mins, BayType FROM ServiceRecoveryProfile'),
        db.request().query('SELECT Site, PreOpBays, PacuBays, Phase2Bays FROM RecoveryCapacity'),
      ]);
      const profiles = Object.fromEntries(profRes.recordset.map(p => [p.Service, {
        preOpMins: num(p.PreOpMins), phase1Mins: num(p.Phase1Mins),
        phase2Mins: num(p.Phase2Mins), bayType: p.BayType,
      }]));
      const bays = new Map(bayRes.recordset.map(b => [b.Site, {
        preop: num(b.PreOpBays), pacu: num(b.PacuBays), phase2: num(b.Phase2Bays),
      }]));

      // The forward schedule has no case times, so the day's shape is taken
      // from how that site and weekday actually ran, scaled to the forecast.
      const r = db.request();
      r.input('from', sql.Date, from);
      r.input('to', sql.Date, to);
      const filter = siteFilter(r, req.query.sites, 'Loc_ORGrp2');
      const shape = await r.query(`
        SELECT ISNULL(Loc_ORGrp2, 'Unknown')            AS Site,
               DATEPART(WEEKDAY, Date_SchedDate)        AS Wd,
               ISNULL(Case_SurgeonService, 'Unknown')   AS Service,
               DATEPART(HOUR, Time_ORin) * 60 + DATEPART(MINUTE, Time_ORin)  AS InMin,
               DATEPART(HOUR, Time_OROut) * 60 + DATEPART(MINUTE, Time_OROut) AS OutMin,
               COUNT(*)                                 AS N,
               COUNT(DISTINCT CAST(Date_SchedDate AS DATE)) OVER (PARTITION BY Loc_ORGrp2, DATEPART(WEEKDAY, Date_SchedDate)) AS Days
        FROM DS_CASES
        WHERE Case_CanCode IS NULL AND Time_ORin IS NOT NULL AND Time_OROut IS NOT NULL
          AND Date_SchedDate >= DATEADD(week, -8, CAST(GETDATE() AS DATE))
          AND Date_SchedDate <  CAST(GETDATE() AS DATE)${filter}
        GROUP BY Loc_ORGrp2, DATEPART(WEEKDAY, Date_SchedDate), Case_SurgeonService,
                 DATEPART(HOUR, Time_ORin) * 60 + DATEPART(MINUTE, Time_ORin),
                 DATEPART(HOUR, Time_OROut) * 60 + DATEPART(MINUTE, Time_OROut)
      `);

      const bySiteDow = new Map();
      for (const x of shape.recordset) {
        const k = `${x.Site}|${sqlDowToJs(x.Wd)}`;
        if (!bySiteDow.has(k)) bySiteDow.set(k, { cases: [], days: num(x.Days) || 1 });
        bySiteDow.get(k).cases.push({
          service: x.Service, orInMinutes: num(x.InMin), orOutMinutes: num(x.OutMin),
        });
      }

      const days = [];
      for (let d = new Date(`${from}T00:00:00`); d <= new Date(`${to}T00:00:00`);
           d.setDate(d.getDate() + 1)) {
        const dow = (d.getDay() + 6) % 7;
        if (dow >= 5) continue;
        const date = d.toISOString().slice(0, 10);
        for (const [key, entry] of bySiteDow) {
          const [site, kdow] = key.split('|');
          if (Number(kdow) !== dow) continue;
          // A typical day of this weekday: the trailing cases divided by how
          // many of those days there were.
          const perDay = Math.max(1, entry.days);
          const sample = entry.cases.filter((_, i) => i % perDay === 0);
          days.push(R.dayDemand({
            date, site, cases: sample, profiles, bays: bays.get(site),
          }));
        }
      }

      res.json({ from, to, tier: 'POTENTIAL', days });
    } catch (err) {
      console.error('/api/impact/recovery error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
};

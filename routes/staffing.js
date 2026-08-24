const express = require('express');

const S = require('../lib/staffingShape');
const { getFeatures } = require('../utils/tenantColumns');

// Demand–Staffing Alignment (StaffingAlignment.md).
//
// OR staffing is planned as a static rectangle — all rooms, one shift, five
// days. Demand has a shape by hour and day. The gap leaks money in both
// directions at once: idle staffed hours where the rectangle exceeds demand,
// overtime exposure where demand runs past its edge. This router supplies the
// shape; lib/staffingShape.js does the arithmetic, and the ISSCM engine's
// Pillar 2 computes from that same module.

const DOW_LABEL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday',
                   'Saturday', 'Sunday'];
const jsDowToSql = dow => ((Number(dow) + 1) % 7) + 1;
const sqlDowToJs = wd => (Number(wd) + 5) % 7;
const num = x => (Number.isFinite(Number(x)) ? Number(x) : 0);
const round1 = x => (x == null ? null : Math.round(x * 10) / 10);

// 'HH:MM' or 'HH:MM:SS' -> minutes past midnight.
function slotMinutes(v) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(v ?? ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

module.exports = function staffingRoutes(getTenantPool, sql, requireTenant) {
  const router = express.Router();
  router.use(requireTenant);

  // The page is hidden where the tenant has no staffing plan or no room-running
  // history. Half a page is worse than no page for a client tenant.
  router.use((req, res, next) => {
    if (!getFeatures(req.tenantName)?.staffing) {
      return res.status(404).json({ error: 'not_available' });
    }
    next();
  });

  async function plansFor(db, site) {
    const r = await db.request()
      .input('site', sql.NVarChar, site)
      .query(`SELECT DayOfWeek, StaffedRooms, CoverageRatio, ShiftStart, ShiftEnd
              FROM StaffingPlan WHERE Site = @site ORDER BY DayOfWeek`);
    const byDow = new Map();
    for (const p of r.recordset) {
      byDow.set(num(p.DayOfWeek) - 1, {          // StaffingPlan is 1 = Monday
        staffedRooms: num(p.StaffedRooms),
        coverageRatio: num(p.CoverageRatio) || 1,
        shiftStart: p.ShiftStart,
        shiftEnd: p.ShiftEnd,
      });
    }
    return byDow;
  }

  // Average rooms running per timeslot per weekday — the same DS_RR the Room
  // Running page reads, so the two pages cannot show different demand.
  async function shapeFor(db, site, weeks) {
    const r = await db.request()
      .input('site', sql.NVarChar, site)
      .input('weeks', sql.Int, weeks)
      .query(`
        SELECT DATEPART(WEEKDAY, rrDate) AS Wd, rrtimeslot,
               AVG(CAST(TotalOccupied AS FLOAT)) AS AvgRooms
        FROM DS_RR
        WHERE ISNULL(ORGroup, 'Unknown') = @site
          AND rrDate >= DATEADD(week, -@weeks, CAST(GETDATE() AS DATE))
          AND rrDate <  CAST(GETDATE() AS DATE)
        GROUP BY DATEPART(WEEKDAY, rrDate), rrtimeslot
        ORDER BY Wd, rrtimeslot
      `);
    const byDow = new Map();
    let width = null;
    for (const row of r.recordset) {
      const minute = slotMinutes(row.rrtimeslot);
      if (minute == null) continue;
      const dow = sqlDowToJs(row.Wd);
      if (!byDow.has(dow)) byDow.set(dow, []);
      byDow.get(dow).push({ minuteOfDay: minute, rooms: num(row.AvgRooms) });
    }
    // Slot width is whatever the tenant's DS_RR uses; read it rather than assume.
    for (const slots of byDow.values()) {
      slots.sort((a, b) => a.minuteOfDay - b.minuteOfDay);
      if (width == null && slots.length > 1) width = slots[1].minuteOfDay - slots[0].minuteOfDay;
    }
    return { byDow, slotMinutes: width || 15 };
  }

  // ── GET /api/staffing/shape ───────────────────────────────────────────────
  router.get('/shape', async (req, res) => {
    try {
      const site = String(req.query.site || '');
      if (!site) return res.status(400).json({ error: 'site is required' });
      const weeks = Math.min(Math.max(parseInt(req.query.weeks, 10) || 8, 1), 52);
      const db = await getTenantPool(req.session.tenantId);
      const [{ byDow, slotMinutes: width }, plans] = await Promise.all([
        shapeFor(db, site, weeks), plansFor(db, site),
      ]);

      res.json({
        site, weeks, slotMinutes: width,
        days: [0, 1, 2, 3, 4, 5, 6]
          .filter(d => byDow.has(d) || plans.has(d))
          .map(dow => ({
            dow, label: DOW_LABEL[dow],
            byHour: (byDow.get(dow) || []).map(s => ({ minuteOfDay: s.minuteOfDay, avgRooms: round1(s.rooms) })),
            plan: plans.get(dow) || null,
          })),
      });
    } catch (err) {
      console.error('/api/staffing/shape error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/staffing/ledger ──────────────────────────────────────────────
  router.get('/ledger', async (req, res) => {
    try {
      const site = String(req.query.site || '');
      if (!site) return res.status(400).json({ error: 'site is required' });
      const weeks = Math.min(Math.max(parseInt(req.query.weeks, 10) || 8, 1), 52);
      const db = await getTenantPool(req.session.tenantId);
      const [{ byDow, slotMinutes: width }, plans] = await Promise.all([
        shapeFor(db, site, weeks), plansFor(db, site),
      ]);

      const rows = [];
      for (const [dow, shape] of [...byDow.entries()].sort((a, b) => a[0] - b[0])) {
        const plan = plans.get(dow);
        if (!plan) continue;
        rows.push({ dow, label: DOW_LABEL[dow], plan, ...S.ledgerRow(shape, plan, width) });
      }

      const idleWk = rows.reduce((s, r) => s + num(r.idleRoomHours), 0);
      const overtimeWk = rows.reduce((s, r) => s + num(r.overtimeRoomHours), 0);
      const staffedWk = rows.reduce((s, r) => s + num(r.plan.staffedRooms)
        * ((S.hhmmToMinutes(r.plan.shiftEnd) - S.hhmmToMinutes(r.plan.shiftStart)) / 60), 0);
      const worst = (key) => rows.reduce(
        (w, r) => (w === null || num(r[key]) > num(w[key]) ? r : w), null);

      // The financials hook is deliberately visible and dormant: the column
      // exists, and prices arrive when Financial Analysis unparks.
      const costPerRoomHour = null;

      res.json({
        site, weeks, byDow: rows,
        summary: {
          idleWk: round1(idleWk),
          overtimeWk: round1(overtimeWk),
          staffedWk: round1(staffedWk),
          alignmentPct: staffedWk > 0 ? round1(((staffedWk - idleWk) / staffedWk) * 100) : null,
          worstIdleDow: worst('idleRoomHours')?.dow ?? null,
          worstOvertimeDow: worst('overtimeRoomHours')?.dow ?? null,
          costPerRoomHour,
        },
      });
    } catch (err) {
      console.error('/api/staffing/ledger error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/staffing/forward ─────────────────────────────────────────────
  // Booked minutes per day over the shift length, rounded up: the rooms the
  // schedule already implies, against the rooms the plan staffs.
  router.get('/forward', async (req, res) => {
    try {
      const site = String(req.query.site || '');
      if (!site) return res.status(400).json({ error: 'site is required' });
      const weeks = Math.min(Math.max(parseInt(req.query.weeks, 10) || 4, 1), 12);
      const db = await getTenantPool(req.session.tenantId);

      const [fwd, plans] = await Promise.all([
        db.request()
          .input('site', sql.NVarChar, site)
          .input('days', sql.Int, weeks * 7)
          .query(`
            SELECT CONVERT(VARCHAR(10), Date, 23)      AS Date,
                   MIN(DATEPART(WEEKDAY, Date))        AS Wd,
                   MIN(DaysAhead)                      AS DaysAhead,
                   SUM(ISNULL(SCHEDULED_INPATIENT_DURwTurn,0) + ISNULL(SCHEDULED_OUTPATIENT_DURwTurn,0)
                     + ISNULL(FORECAST_INPATIENT_DURwTurn,0)  + ISNULL(FORECAST_OUTPATIENT_DURwTurn,0))
                                                       AS BookedMins
            FROM V4_FORECAST_COMPILE
            WHERE ISNULL(ORGRP2, 'Unknown') = @site
              AND DaysAhead BETWEEN 1 AND @days
            GROUP BY Date
            ORDER BY Date
          `),
        plansFor(db, site),
      ]);

      const days = fwd.recordset.map(row => {
        const dow = sqlDowToJs(row.Wd);
        const plan = plans.get(dow);
        if (!plan) return null;
        const implied = S.impliedRooms(num(row.BookedMins), plan);
        const flag = S.flexFlag(plan.staffedRooms, implied);
        const shiftMins = S.hhmmToMinutes(plan.shiftEnd) - S.hhmmToMinutes(plan.shiftStart);
        return {
          date: row.Date, dow, label: DOW_LABEL[dow], daysAhead: num(row.DaysAhead),
          plannedRooms: plan.staffedRooms,
          impliedRooms: implied,
          recommendedRooms: S.recommendedRooms(implied, plan.staffedRooms),
          bookedRoomHours: round1(num(row.BookedMins) / 60),
          flag,
          // The reasoning is the figures it was derived from, in the house idiom.
          drivers: [
            { key: 'booked', label: 'Booked room-time',
              detail: `${round1(num(row.BookedMins) / 60)} room-hours booked including turnover.` },
            { key: 'implied', label: 'Implied rooms',
              detail: `Over a ${round1(shiftMins / 60)}-hour shift that needs ${implied} rooms; `
                    + `the plan staffs ${plan.staffedRooms}.` },
            ...(flag === 'FLEX_DOWN' ? [{ key: 'flex', label: 'Flex down',
              detail: `Staffing ${S.recommendedRooms(implied, plan.staffedRooms)} keeps a room in `
                    + 'hand and retires the rest.' }] : []),
            ...(flag === 'FLEX_UP' ? [{ key: 'flex', label: 'Flex up',
              detail: 'The booked volume needs more rooms than the plan staffs.' }] : []),
          ],
        };
      }).filter(Boolean);

      res.json({ site, weeks, days });
    } catch (err) {
      console.error('/api/staffing/forward error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
};

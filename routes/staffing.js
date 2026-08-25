const express = require('express');

const S = require('../lib/staffingShape');
const { getFeatures } = require('../utils/tenantColumns');

// Staffing Patterns (StaffingAlignment.md rev 2).
//
// The structural half: over a trailing quarter, does the staffing template fit
// the demand pattern at all? OR staffing is planned as a static rectangle — all
// rooms, one shift, five days — and demand has a shape by hour and day. The gap
// leaks money in both directions at once: idle staffed hours where the
// rectangle exceeds demand, overtime exposure where demand runs past its edge.
//
// The forward, week-to-week half lives on Volume & Staffing Outlook. This page
// says stop staffing Fridays that way; the Outlook says flex this Friday.
//
// lib/staffingShape.js does the arithmetic here, on the Outlook, and in the
// ISSCM engine's Pillar 2 — one room-hour everywhere.

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

  // The forward flex plan moved to /api/outlook/flex, together with the demand
  // forecast that drives it. A boundary whose fix was "make sure these two pages
  // always agree" was two halves of one page; see VolumeOutlook.md rev 2.

  return router;
};

const express = require('express');

const { evaluate, DEFAULT_CFG } = require('../lib/isscmScenario');
const { getParam, resolveColumn } = require('../utils/tenantColumns');

// ISSCM scenario API (ISSCMIntegrationView.md §6).
//
// This is not a page. There is no /isscm route in the client — the deliverable
// is an evaluation panel summoned in context from the ISSCM nav group, and these
// endpoints feed it. Integration is a property of every decision, not a
// destination.
//
// Everything here does one job: turn live tenant data into the baseline shapes
// lib/isscmScenario.js expects, then get out of the way. No reasoning lives in
// this file — if a verdict needs explaining, the explanation is a driver in the
// engine, not a string built here.

// Required fields per decision kind, so a malformed decision fails at the door
// rather than as a silent zero three pillars deep.
const KINDS_ALLOWED = {
  REALLOCATE: ['fromBlock', 'toService'],
  SHIFT_DOW: ['service', 'casesPerWeek'],
  FLEX_STAFFING: ['rooms'],
};

const DEFAULT_TRAILING_WEEKS = 8;
const DEFAULT_HORIZON_WEEKS = 4;

// SQL Server's DATEPART(WEEKDAY) is 1 = Sunday by default; JS/ISO weekday is
// 0 = Monday. One conversion, in one place.
const jsDowToSql = dow => ((Number(dow) + 1) % 7) + 1;
const DOW_LABEL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday',
                   'Saturday', 'Sunday'];

const num = x => (Number.isFinite(Number(x)) ? Number(x) : 0);

// A TIME column arrives from mssql as a Date pinned to the epoch, but a driver
// or a tenant may hand back 'HH:MM:SS' instead. Read both rather than assume.
function minutesOfDay(v) {
  if (v == null) return 0;
  if (v instanceof Date) return v.getUTCHours() * 60 + v.getUTCMinutes();
  const m = /^(\d{1,2}):(\d{2})/.exec(String(v));
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

function isscmConfig(tenantName) {
  const cfg = getParam(tenantName, 'isscm') || {};
  return {
    ...DEFAULT_CFG,
    ...cfg,
    thresholds: { ...DEFAULT_CFG.thresholds, ...(cfg.thresholds || {}) },
  };
}

module.exports = function isscmRoutes(getTenantPool, sql, requireTenant) {
  const router = express.Router();
  router.use(requireTenant);

  // ── Pillar 1 inputs ───────────────────────────────────────────────────────
  // Block utilisation is in-window; true utilisation credits everything that
  // ran in the block's own rooms on its own days, which is where the argument
  // against slot-occupancy thinking lives.
  async function blockBaseline(db, block, weekday, weeks) {
    const r = db.request();
    r.input('block', sql.NVarChar, block);
    r.input('weeks', sql.Int, weeks);
    r.input('dow', sql.Int, jsDowToSql(weekday));
    const res = await r.query(`
      WITH instances AS (
        SELECT DISTINCT CAST(BlockDate AS DATE) AS d, ORLoc, LocationGroup
        FROM V4_BlockResultsView
        WHERE ISNULL(CaseBlock, 'Unknown') = @block
          AND BlockDate >= DATEADD(week, -@weeks, CAST(GETDATE() AS DATE))
          AND BlockDate <  CAST(GETDATE() AS DATE)
          AND DATEPART(WEEKDAY, BlockDate) = @dow
      ),
      own AS (
        SELECT SUM(ISNULL(v.blockTime, 0)) AS AllocMins,
               SUM(ISNULL(v.InBlock, 0))   AS InBlockMins,
               MAX(v.LocationGroup)        AS Site
        FROM V4_BlockResultsView v
        JOIN instances i ON i.d = CAST(v.BlockDate AS DATE) AND i.ORLoc = v.ORLoc
        WHERE ISNULL(v.CaseBlock, 'Unknown') = @block
      ),
      room AS (
        SELECT SUM(ISNULL(v.Total_Prime_Time, 0)) AS RoomPrimeMins
        FROM V4_BlockResultsView v
        JOIN instances i ON i.d = CAST(v.BlockDate AS DATE) AND i.ORLoc = v.ORLoc
      )
      SELECT (SELECT COUNT(*) FROM instances) AS Instances,
             own.AllocMins, own.InBlockMins, own.Site, room.RoomPrimeMins
      FROM own CROSS JOIN room
    `);
    const row = res.recordset[0] || {};
    const alloc = num(row.AllocMins);
    const instances = num(row.Instances) || 1;
    return {
      site: row.Site || null,
      instances: num(row.Instances),
      allocatedHours: alloc / instances / 60,
      blockUtilPct: alloc > 0 ? (num(row.InBlockMins) / alloc) * 100 : 0,
      trueUtilPct: alloc > 0 ? (num(row.RoomPrimeMins) / alloc) * 100 : 0,
    };
  }

  // Forward booked volume against the service's own trailing baseline, per
  // operating day so a longer forward window does not read as growth.
  async function pipelineLift(db, service, horizonDays, trailingDays) {
    const r = db.request();
    r.input('svc', sql.NVarChar, service);
    r.input('horizon', sql.Int, horizonDays);
    r.input('trailing', sql.Int, trailingDays);
    const res = await r.query(`
      SELECT
        SUM(CASE WHEN DaysAhead BETWEEN 1 AND @horizon
                 THEN ISNULL(SCHEDULED_INPATIENT,0) + ISNULL(SCHEDULED_OUTPATIENT,0)
                    + ISNULL(FORECAST_INPATIENT,0)  + ISNULL(FORECAST_OUTPATIENT,0)
                 ELSE 0 END)                                          AS FwdCases,
        COUNT(DISTINCT CASE WHEN DaysAhead BETWEEN 1 AND @horizon
                            THEN CAST(Date AS DATE) END)              AS FwdDays,
        SUM(CASE WHEN DaysAhead <= 0 AND DaysAhead >= -@trailing
                 THEN ISNULL(ACTUAL_INPATIENT,0) + ISNULL(ACTUAL_OUTPATIENT,0)
                 ELSE 0 END)                                          AS HistCases,
        COUNT(DISTINCT CASE WHEN DaysAhead <= 0 AND DaysAhead >= -@trailing
                            THEN CAST(Date AS DATE) END)              AS HistDays
      FROM V4_FORECAST_COMPILE
      WHERE ISNULL(SurgeonService, 'Unknown') = @svc
    `);
    const row = res.recordset[0] || {};
    const fwd = num(row.FwdDays) ? num(row.FwdCases) / num(row.FwdDays) : 0;
    const hist = num(row.HistDays) ? num(row.HistCases) / num(row.HistDays) : 0;
    return {
      vsBaselinePct: hist > 0 ? (fwd / hist - 1) * 100 : 0,
      forwardCasesPerDay: fwd,
      baselineCasesPerDay: hist,
    };
  }

  // ── Pillar 2 inputs ───────────────────────────────────────────────────────
  // The staffing plan is tenant configuration, not a fabricated FTE model. What
  // the data supplies is the demand: room-hours drawn and rooms running at once.
  async function staffingBaseline(db, site, weekday, weeks) {
    const r = db.request();
    r.input('site', sql.NVarChar, site);
    r.input('dowSql', sql.Int, jsDowToSql(weekday));
    r.input('planDow', sql.Int, weekday + 1);       // StaffingPlan is 1 = Monday
    r.input('weeks', sql.Int, weeks);

    const plan = await r.query(`
      SELECT TOP 1 StaffedRooms, CoverageRatio, ShiftStart, ShiftEnd
      FROM StaffingPlan WHERE Site = @site AND DayOfWeek = @planDow
    `);
    const p = plan.recordset[0];
    if (!p) return null;

    const shiftHours = (minutesOfDay(p.ShiftEnd) - minutesOfDay(p.ShiftStart)) / 60;

    const demand = await db.request()
      .input('site', sql.NVarChar, site)
      .input('dowSql', sql.Int, jsDowToSql(weekday))
      .input('weeks', sql.Int, weeks)
      .query(`
        SELECT AVG(CAST(DayMins AS FLOAT)) / 60.0 AS AvgRoomHours,
               COUNT(*)                           AS Days
        FROM (
          SELECT CAST(Date_SchedDate AS DATE) AS d,
                 SUM(ISNULL(Dur_ORIn_OROut, 0) + 33) AS DayMins
          FROM DS_CASES
          WHERE ISNULL(Loc_ORGrp2, 'Unknown') = @site
            AND Case_CanCode IS NULL
            AND Date_SchedDate >= DATEADD(week, -@weeks, CAST(GETDATE() AS DATE))
            AND Date_SchedDate <  CAST(GETDATE() AS DATE)
            AND DATEPART(WEEKDAY, Date_SchedDate) = @dowSql
          GROUP BY CAST(Date_SchedDate AS DATE)
        ) x
      `);

    // Concurrency comes from DS_RR where the tenant has it; the table is absent
    // for some tenants (§7), and a missing peak simply drops that driver rather
    // than inventing one.
    let concurrencyPeak = 0;
    try {
      const rr = await db.request()
        .input('site', sql.NVarChar, site)
        .input('dowSql', sql.Int, jsDowToSql(weekday))
        .input('weeks', sql.Int, weeks)
        .query(`
          SELECT MAX(AvgOccupied) AS Peak FROM (
            SELECT rrtimeslot, AVG(CAST(TotalOccupied AS FLOAT)) AS AvgOccupied
            FROM DS_RR
            WHERE ISNULL(ORGroup, 'Unknown') = @site
              AND rrDate >= DATEADD(week, -@weeks, CAST(GETDATE() AS DATE))
              AND rrDate <  CAST(GETDATE() AS DATE)
              AND DATEPART(WEEKDAY, rrDate) = @dowSql
            GROUP BY rrtimeslot
          ) s
        `);
      concurrencyPeak = num(rr.recordset[0]?.Peak);
    } catch (err) {
      console.error('/api/isscm concurrency unavailable:', err.message);
    }

    return {
      staffedRooms: num(p.StaffedRooms),
      shiftHours: shiftHours > 0 ? shiftHours : 8.5,
      coverageRatio: num(p.CoverageRatio) || 1,
      requiredRoomHours: num(demand.recordset[0]?.AvgRoomHours),
      pastShiftRoomHours: 0,      // folded into the engine's spill calculation
      concurrencyPeak,
    };
  }

  // ── Pillar 3 inputs ───────────────────────────────────────────────────────
  async function capacityBaseline(db, service, weekday, weeks, tenantName) {
    const slCol = resolveColumn(tenantName, 'SERVICE_LINE');

    const units = await db.request()
      .input('dowSql', sql.Int, jsDowToSql(weekday))
      .input('weeks', sql.Int, weeks)
      .query(`
        SELECT c.Unit, c.StaffedBeds,
               AVG(CAST(o.Occupancy AS FLOAT)) AS ProjectedCensus
        FROM UnitCapacity c
        LEFT JOIN DS_Occupancy o
          ON o.DEP_NAME = c.Unit
         AND DATEPART(HOUR, o.Datehour) = 7
         AND DATEPART(WEEKDAY, o.Datehour) = @dowSql
         AND o.Datehour >= DATEADD(week, -@weeks, CAST(GETDATE() AS DATE))
        GROUP BY c.Unit, c.StaffedBeds
        ORDER BY c.Unit
      `);

    const mix = await db.request()
      .input('svc', sql.NVarChar, service)
      .query('SELECT Unit, SharePct FROM ServiceUnitMap WHERE Service = @svc');

    // Phase 1 reads the conversion rate from encounter volume against case
    // volume for the service. The real case -> admission -> unit join is Phase 4;
    // this is the same ratio, without the per-case linkage.
    const conv = await db.request()
      .input('svc', sql.NVarChar, service)
      .input('weeks', sql.Int, weeks)
      .query(`
        SELECT
          (SELECT COUNT(*) FROM DS_Encounters
            WHERE ISNULL(${slCol}, 'Unknown') = @svc AND BEDDED = 'Y'
              AND TIME_HOSPADMISSION >= DATEADD(week, -@weeks, CAST(GETDATE() AS DATE))) AS Admits,
          (SELECT COUNT(*) FROM DS_CASES
            WHERE ISNULL(Case_SurgeonService, 'Unknown') = @svc AND Case_CanCode IS NULL
              AND Date_SchedDate >= DATEADD(week, -@weeks, CAST(GETDATE() AS DATE))
              AND Date_SchedDate < CAST(GETDATE() AS DATE))                              AS Cases
      `);
    const cRow = conv.recordset[0] || {};
    const rate = num(cRow.Cases) > 0 ? Math.min(1, num(cRow.Admits) / num(cRow.Cases)) : 0;

    const dur = await db.request()
      .input('svc', sql.NVarChar, service)
      .input('weeks', sql.Int, weeks)
      .query(`
        SELECT AVG(CAST(Dur_ORIn_OROut AS FLOAT)) / 60.0 AS AvgHours
        FROM DS_CASES
        WHERE ISNULL(Case_SurgeonService, 'Unknown') = @svc
          AND Case_CanCode IS NULL AND Dur_ORIn_OROut > 0
          AND Date_SchedDate >= DATEADD(week, -@weeks, CAST(GETDATE() AS DATE))
      `);

    return {
      units: units.recordset.map(u => ({
        unit: u.Unit, staffedBeds: num(u.StaffedBeds),
        projectedCensus: num(u.ProjectedCensus),
      })),
      inpatientConversionRate: { [service]: rate },
      serviceUnitMap: {
        [service]: Object.fromEntries(mix.recordset.map(m => [m.Unit, num(m.SharePct)])),
      },
      averageCaseHours: num(dur.recordset[0]?.AvgHours) || 2.0,
    };
  }

  async function buildBaseline(db, tenantName, { block, service, weekday, weeks, horizonDays }) {
    const blk = await blockBaseline(db, block, weekday, weeks);
    const site = blk.site;
    const [pipe, staffing, capacity] = await Promise.all([
      pipelineLift(db, service, horizonDays, weeks * 7),
      site ? staffingBaseline(db, site, weekday, weeks) : null,
      capacityBaseline(db, service, weekday, weeks, tenantName),
    ]);

    return {
      site, block, dayOfWeek: weekday,
      surgeon: {
        allocatedHours: blk.allocatedHours,
        blockUtilPct: blk.blockUtilPct,
        trueUtilPct: blk.trueUtilPct,
        receivingService: service,
        receivingPipelineVsBaselinePct: pipe.vsBaselinePct,
        strategicWeight: null,
      },
      staffing: staffing || {},
      capacity,
      _instances: blk.instances,
    };
  }

  // ── Scenario catalogue ────────────────────────────────────────────────────
  // A scenarioId is never trusted as a path fragment or a query value: it is
  // resolved against the tenant's own list, and anything not on it is a 404.
  async function scenarioCatalogue(db, tenantName, horizonDays) {
    const r = db.request();
    r.input('horizon', sql.Int, horizonDays);
    const res = await r.query(`
      SELECT TOP 25
        ISNULL(f.Caseblock, 'Unknown')      AS CaseBlock,
        ISNULL(f.ORGRP2, 'Unknown')         AS Site,
        ISNULL(f.SurgeonService, 'Unknown') AS Service,
        MIN(DATEPART(WEEKDAY, f.Date))      AS DowSql,
        SUM(ISNULL(f.BLOCKTIME, 0))         AS BlockMins,
        SUM(ISNULL(f.SCHEDULED_INPATIENT,0) + ISNULL(f.SCHEDULED_OUTPATIENT,0)
          + ISNULL(f.FORECAST_INPATIENT,0)  + ISNULL(f.FORECAST_OUTPATIENT,0)) AS Cases,
        SUM(ISNULL(f.SCHEDULED_INPATIENT_DURwTurn,0) + ISNULL(f.SCHEDULED_OUTPATIENT_DURwTurn,0)
          + ISNULL(f.FORECAST_INPATIENT_DURwTurn,0)  + ISNULL(f.FORECAST_OUTPATIENT_DURwTurn,0)) AS BookedMins
      FROM V4_FORECAST_COMPILE f
      WHERE f.DaysAhead BETWEEN 1 AND @horizon
        AND ISNULL(f.Caseblock, 'Unknown') <> 'Open'
      GROUP BY f.Caseblock, f.ORGRP2, f.SurgeonService
      HAVING SUM(ISNULL(f.BLOCKTIME, 0)) > 0
      ORDER BY SUM(ISNULL(f.SCHEDULED_INPATIENT_DURwTurn,0) + ISNULL(f.SCHEDULED_OUTPATIENT_DURwTurn,0)
                 + ISNULL(f.FORECAST_INPATIENT_DURwTurn,0)  + ISNULL(f.FORECAST_OUTPATIENT_DURwTurn,0))
             / NULLIF(SUM(ISNULL(f.BLOCKTIME, 0)), 0) ASC
    `);

    const target = num(getParam(tenantName, 'block_fill_target')) || 75;
    return res.recordset.map(row => {
      const fill = num(row.BlockMins) > 0 ? (num(row.BookedMins) / num(row.BlockMins)) * 100 : null;
      const weekday = (num(row.DowSql) + 5) % 7;
      return {
        scenarioId: `${row.Site}|${row.CaseBlock}|${weekday}`,
        label: `${row.CaseBlock} — ${DOW_LABEL[weekday]}`,
        block: row.CaseBlock,
        site: row.Site,
        service: row.Service,
        weekday,
        forwardFillPct: fill == null ? null : Math.round(fill * 10) / 10,
        rationale: fill == null
          ? `${row.CaseBlock} has no forward block time in this window.`
          : `${Math.round(fill)}% of the next ${Math.round(horizonDays / 7)} weeks is booked `
            + `against a ${target}% target.`,
      };
    });
  }

  // ── Endpoints ─────────────────────────────────────────────────────────────

  router.get('/config', (req, res) => {
    const tenant = req.tenantName || 'default';
    res.json({ tenant, ...isscmConfig(tenant) });
  });

  router.get('/scenarios', async (req, res) => {
    try {
      const tenant = req.tenantName || 'default';
      const weeks = Math.min(Math.max(parseInt(req.query.horizonWeeks, 10) || DEFAULT_HORIZON_WEEKS, 1), 12);
      const db = await getTenantPool(req.session.tenantId);
      res.json({ horizonWeeks: weeks, scenarios: await scenarioCatalogue(db, tenant, weeks * 7) });
    } catch (err) {
      console.error('/api/isscm/scenarios error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/baseline', async (req, res) => {
    try {
      const tenant = req.tenantName || 'default';
      const db = await getTenantPool(req.session.tenantId);
      const weeks = Math.min(Math.max(parseInt(req.query.weeks, 10) || DEFAULT_TRAILING_WEEKS, 1), 52);
      const horizonDays = Math.min(Math.max(parseInt(req.query.horizonDays, 10) || 28, 7), 120);

      const catalogue = await scenarioCatalogue(db, tenant, horizonDays);
      const entry = catalogue.find(s => s.scenarioId === req.query.scenarioId);
      if (!entry) return res.status(404).json({ error: 'Unknown scenario' });

      const baseline = await buildBaseline(db, tenant, {
        block: entry.block, service: req.query.toService || entry.service,
        weekday: entry.weekday, weeks, horizonDays,
      });
      res.json({ scenario: entry, baseline });
    } catch (err) {
      console.error('/api/isscm/baseline error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Full ScenarioResult for a curated scenario, including the alternatives that
  // make step 7 of the demo click path work: the same decision on other days.
  router.get('/scenarios/:scenarioId', async (req, res) => {
    try {
      const tenant = req.tenantName || 'default';
      const db = await getTenantPool(req.session.tenantId);
      const cfg = isscmConfig(tenant);
      const weeks = Math.min(Math.max(parseInt(req.query.weeks, 10) || DEFAULT_TRAILING_WEEKS, 1), 52);
      const horizonDays = Math.min(Math.max(parseInt(req.query.horizonDays, 10) || 28, 7), 120);

      const catalogue = await scenarioCatalogue(db, tenant, horizonDays);
      const entry = catalogue.find(s => s.scenarioId === req.params.scenarioId);
      if (!entry) return res.status(404).json({ error: 'Unknown scenario' });

      const toService = req.query.toService || null;
      const hours = Math.min(Math.max(parseFloat(req.query.hours) || 4, 0.5), 12);

      // The receiving service is whichever one is booking hardest against its
      // own baseline — the same signal the Release Radar ranks candidates by.
      const receiving = toService || await bestReceivingService(db, entry, horizonDays, weeks);

      const baseline = await buildBaseline(db, tenant, {
        block: entry.block, service: receiving,
        weekday: entry.weekday, weeks, horizonDays,
      });
      const decision = {
        kind: 'REALLOCATE', fromBlock: entry.block, toService: receiving,
        hours, dayOfWeek: entry.weekday, dayOfWeekLabel: DOW_LABEL[entry.weekday],
        weeks, scenarioId: entry.scenarioId,
      };
      const result = evaluate(baseline, decision, cfg);

      // Alternatives: the same reallocation on the other operating days. The
      // engine scores them the same way, so a day that clears all three pillars
      // surfaces on its own rather than being asserted.
      const alternatives = [];
      for (const day of [0, 1, 2, 3, 4]) {
        if (day === entry.weekday) continue;
        const altBaseline = await buildBaseline(db, tenant, {
          block: entry.block, service: receiving, weekday: day, weeks, horizonDays,
        });
        // The block's own utilisation does not change with the receiving day.
        altBaseline.surgeon = baseline.surgeon;
        const alt = evaluate(altBaseline, { ...decision, dayOfWeek: day,
          dayOfWeekLabel: DOW_LABEL[day], scenarioId: `${entry.scenarioId}|alt${day}` }, cfg);
        alternatives.push({
          scenarioId: alt.scenarioId,
          label: `${entry.block} hours to ${receiving} on ${DOW_LABEL[day]}`,
          pillarStatuses: Object.fromEntries(
            Object.entries(alt.pillars).map(([k, p]) => [k, p.status])),
          conflicts: alt.conflicts.length,
          summary: alt.conflicts.length
            ? alt.conflicts[0].summary
            : 'All three pillars clear.',
        });
      }
      // Cleanest first: fewest conflicts, then fewest degrading pillars, then
      // most improving. Counting degrading pillars is what puts a day that
      // breaks two of them below one that breaks one.
      const rank = a => a.conflicts * 10
        + Object.values(a.pillarStatuses).filter(s => s === 'degrades').length
        - Object.values(a.pillarStatuses).filter(s => s === 'improves').length;
      alternatives.sort((a, b) => rank(a) - rank(b));

      res.json({ ...result, scenario: entry, baseline, alternatives });
    } catch (err) {
      console.error('/api/isscm/scenarios/:id error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  async function bestReceivingService(db, entry, horizonDays, weeks) {
    const r = db.request();
    r.input('horizon', sql.Int, horizonDays);
    r.input('trailing', sql.Int, weeks * 7);
    const res = await r.query(`
      SELECT TOP 1 ISNULL(SurgeonService, 'Unknown') AS Service
      FROM V4_FORECAST_COMPILE
      GROUP BY SurgeonService
      HAVING SUM(CASE WHEN DaysAhead <= 0 AND DaysAhead >= -@trailing
                      THEN ISNULL(ACTUAL_INPATIENT,0) + ISNULL(ACTUAL_OUTPATIENT,0)
                      ELSE 0 END) > 0
      ORDER BY
        SUM(CASE WHEN DaysAhead BETWEEN 1 AND @horizon
                 THEN ISNULL(SCHEDULED_INPATIENT,0) + ISNULL(SCHEDULED_OUTPATIENT,0)
                    + ISNULL(FORECAST_INPATIENT,0)  + ISNULL(FORECAST_OUTPATIENT,0)
                 ELSE 0 END)
        / NULLIF(SUM(CASE WHEN DaysAhead <= 0 AND DaysAhead >= -@trailing
                          THEN ISNULL(ACTUAL_INPATIENT,0) + ISNULL(ACTUAL_OUTPATIENT,0)
                          ELSE 0 END), 0) DESC
    `);
    return res.recordset[0]?.Service || entry.service;
  }

  // Ad-hoc decisions (§6, Phase 5). The engine is pure, so this is the same
  // evaluation the curated scenarios get.
  router.post('/evaluate', async (req, res) => {
    try {
      const tenant = req.tenantName || 'default';
      const d = req.body?.decision || {};
      const kind = String(d.kind || 'REALLOCATE');
      if (!Object.prototype.hasOwnProperty.call(KINDS_ALLOWED, kind)) {
        return res.status(400).json({ error: 'unknown decision kind' });
      }
      if (d.dayOfWeek == null) {
        return res.status(400).json({ error: 'decision.dayOfWeek is required' });
      }
      // Each kind needs different fields: a flex has no receiving service, a
      // shift has no source block.
      const missing = KINDS_ALLOWED[kind].filter(f => d[f] == null || d[f] === '');
      if (missing.length) {
        return res.status(400).json({ error: `decision.${missing[0]} is required for ${kind}` });
      }
      const weekday = Math.min(Math.max(parseInt(d.dayOfWeek, 10), 0), 6);
      const hours = Math.min(Math.max(parseFloat(d.hours) || 4, 0.5), 12);
      const weeks = DEFAULT_TRAILING_WEEKS;

      const db = await getTenantPool(req.session.tenantId);
      const service = String(d.toService || d.service || '');
      const baseline = await buildBaseline(db, tenant, {
        block: String(d.fromBlock || d.service || ''), service,
        weekday, weeks, horizonDays: 28,
      });
      res.json(evaluate(baseline, {
        ...d, kind, hours,
        dayOfWeek: weekday, dayOfWeekLabel: DOW_LABEL[weekday], weeks,
      }, isscmConfig(tenant)));
    } catch (err) {
      console.error('/api/isscm/evaluate error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
};

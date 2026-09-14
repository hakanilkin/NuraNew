const express = require('express');
const path = require('path');

const { tenantDataDir, readJsonFile } = require('../lib/tenantData');
const { getParam } = require('../utils/tenantColumns');

// Block Allocations (BlockAllocations.md).
//
// The decision this serves is a quarterly block committee review, and the
// question is not "which blocks have low utilization" — it is "where does the
// allocated grid disagree with how surgeons actually practise, and what should
// we change". The action is reallocation, not release.
//
// The classification is the pipeline's (block_patterns.py), because it is a
// quarterly judgement over a quarter of data. This route serves it, joins the
// live forward trend that qualifies each recommendation, and adds the release
// history that turns a repeat offender on the Radar into an allocation finding.

const num = x => (Number.isFinite(Number(x)) ? Number(x) : 0);

// The trailing window a block's own baseline is measured over.
const TRAILING_DAYS = 90;

// Cases a week over a window of days. One helper, used by both the row and the
// drawer, because two ways of averaging is two different percentages.
const weekly = (total, days) => (days > 0 ? (total / days) * 7 : 0);

// The label bands are tenant configuration; block_patterns.py owns the defaults
// and this mirrors them so a row and its drawer read the same word.
function trendLabel(pct, cfg) {
  if (pct == null) return null;
  const grow = Number(cfg?.growing_pct ?? 12);
  const drop = Number(cfg?.declining_pct ?? -12);
  if (pct >= grow) return 'GROWING';
  if (pct <= drop) return 'DECLINING';
  return 'STABLE';
}
const round1 = x => (x == null ? null : Math.round(x * 10) / 10);

const FORECAST_CASES = `
  ISNULL(SCHEDULED_INPATIENT,0) + ISNULL(SCHEDULED_OUTPATIENT,0)
+ ISNULL(FORECAST_INPATIENT,0)  + ISNULL(FORECAST_OUTPATIENT,0)`;

module.exports = function blockRoutes(getTenantPool, sql, requireTenant, store) {
  const router = express.Router();
  router.use(requireTenant);

  // Forward booked volume per block against its own trailing baseline. The
  // trend qualifies a recommendation rather than making one: a surgeon whose
  // volume is growing should not have their block cut on trailing data alone.
  async function trendByBlock(db, horizonDays, trailingDays) {
    const r = db.request();
    r.input('horizon', sql.Int, horizonDays);
    r.input('trailing', sql.Int, trailingDays);
    const res = await r.query(`
      SELECT ISNULL(Caseblock, 'Unknown') AS CaseBlock,
             SUM(CASE WHEN DaysAhead BETWEEN 1 AND @horizon THEN ${FORECAST_CASES} ELSE 0 END) AS Fwd,
             COUNT(DISTINCT CASE WHEN DaysAhead BETWEEN 1 AND @horizon
                                 THEN CAST(Date AS DATE) END)                                 AS FwdDays,
             SUM(CASE WHEN DaysAhead <= 0 AND DaysAhead >= -@trailing
                      THEN ISNULL(ACTUAL_INPATIENT,0) + ISNULL(ACTUAL_OUTPATIENT,0) ELSE 0 END) AS Hist,
             COUNT(DISTINCT CASE WHEN DaysAhead <= 0 AND DaysAhead >= -@trailing
                                 THEN CAST(Date AS DATE) END)                                 AS HistDays
      FROM V4_FORECAST_COMPILE
      WHERE ISNULL(Caseblock, 'Unknown') <> 'Open'
      GROUP BY Caseblock
    `);
    const map = new Map();
    for (const x of res.recordset) {
      // Divided by the window, not by the days that happen to carry rows: a
      // block with three booked days in four weeks is booking three days a
      // month, not three days a week. This is also the denominator the drawer
      // uses, so the row's percentage and the evidence behind it agree.
      const fwd = weekly(num(x.Fwd), horizonDays);
      const hist = weekly(num(x.Hist), trailingDays);
      map.set(x.CaseBlock, {
        forwardPerWeek: round1(fwd), baselinePerWeek: round1(hist),
        forwardDays: num(x.FwdDays), baselineDays: num(x.HistDays),
        pct: hist > 0 ? round1((fwd / hist - 1) * 100) : null,
      });
    }
    return map;
  }

  // The loop from Release Time Mgmt: a block released week after week is not a
  // release problem, and this is the evidence a periop committee has never had.
  function releasesFromStore(tenantId) {
    const counts = new Map();
    if (!store) return counts;
    try {
      for (const r of store.listRequests(tenantId)) {
        if (r.status !== 'RELEASED' || !r.caseBlock) continue;
        counts.set(r.caseBlock, (counts.get(r.caseBlock) || 0) + 1);
      }
    } catch (err) {
      console.error('/api/blocks release history unavailable:', err.message);
    }
    return counts;
  }

  function loadAllocations(tenant) {
    const file = path.join(tenantDataDir(tenant), 'performance_briefs.json');
    const data = readJsonFile(file);
    return { period: data.period ?? null, allocations: data.allocations ?? null };
  }

  // ── GET /api/blocks/allocations ───────────────────────────────────────────
  router.get('/allocations', async (req, res) => {
    try {
      const tenant = req.tenantName || 'default';
      let period, allocations;
      try {
        ({ period, allocations } = loadAllocations(tenant));
      } catch (err) {
        if (err.message === 'not_found') {
          return res.json({
            error: 'no_atlas_data',
            message: 'Block allocations have not been generated for this organization yet.',
          });
        }
        throw err;
      }
      if (!allocations) {
        // The file predates the allocation view; say so rather than render an
        // empty page that looks like "no findings".
        return res.json({
          error: 'no_allocation_data',
          message: 'This tenant\'s briefs file predates the allocation view. '
                 + 'Re-run performance_briefs_pipeline.py.',
        });
      }

      const horizonDays = Math.min(Math.max(parseInt(req.query.horizonDays, 10) || 28, 7), 120);
      const sites = String(req.query.sites || '').split(',').map(s => s.trim()).filter(Boolean);

      let trend = new Map();
      try {
        trend = await trendByBlock(await getTenantPool(req.session.tenantId), horizonDays, TRAILING_DAYS);
      } catch (err) {
        // Without the forward join every recommendation still stands; it simply
        // is not qualified by where the volume is heading.
        console.error('/api/blocks/allocations trend unavailable:', err.message);
      }
      const releases = releasesFromStore(req.session.tenantId);

      const cfg = getParam(tenant, 'block_pattern_thresholds') ?? null;
      const owners = allocations
        .filter(a => !sites.length || sites.includes(a.site))
        .map(a => {
          const fwd = trend.get(a.owner) ?? null;
          // The live forward join is the fresher of the two, so it wins when it
          // has a baseline to divide by; the pipeline's own figure stands in
          // when the join was unavailable.
          const pct = fwd && fwd.pct != null ? fwd.pct : a.trendPct;
          return {
            ...a,
            trendPct: pct ?? null,
            trend: trendLabel(pct, cfg) ?? a.trend,
            forwardTrend: fwd,
            releaseHistory: {
              ...a.releaseHistory,
              // The workflow store knows about releases the block view cannot see.
              requested: releases.get(a.owner) ?? 0,
            },
          };
        })
        // Magnitude, not utilization: a committee has agenda time for the four
        // findings that move the most hours.
        .sort((x, y) => num(y.mismatchHours) - num(x.mismatchHours));

      res.json({
        period, horizonDays,
        thresholds: cfg,
        owners,
        counts: owners.reduce((acc, o) => ({ ...acc, [o.pattern]: (acc[o.pattern] || 0) + 1 }), {}),
      });
    } catch (err) {
      console.error('/api/blocks/allocations error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/blocks/allocations/:owner ────────────────────────────────────
  router.get('/allocations/:owner', async (req, res) => {
    try {
      const tenant = req.tenantName || 'default';
      let allocations;
      try {
        ({ allocations } = loadAllocations(tenant));
      } catch (err) {
        if (err.message === 'not_found') return res.status(404).json({ error: 'Not found' });
        throw err;
      }
      // Resolved against the tenant's own list, never trusted as a lookup key.
      const owner = (allocations ?? []).find(a => a.owner === req.params.owner);
      if (!owner) return res.status(404).json({ error: 'Unknown block' });

      const horizonDays = Math.min(Math.max(parseInt(req.query.horizonDays, 10) || 28, 7), 120);
      let series = [];
      let pipeline = null;
      try {
        const r = (await getTenantPool(req.session.tenantId)).request();
        r.input('owner', sql.NVarChar, owner.owner);
        const out = await r.query(`
          SELECT FORMAT(BlockDate, 'yyyy-MM')      AS Month,
                 SUM(ISNULL(blockTime, 0)) / 60.0  AS AllocHours,
                 SUM(ISNULL(InBlock, 0))   / 60.0  AS UsedHours
          FROM V4_BlockResultsView
          WHERE ISNULL(CaseBlock, 'Unknown') = @owner
            AND BlockDate >= DATEADD(month, -12, CAST(GETDATE() AS DATE))
          GROUP BY FORMAT(BlockDate, 'yyyy-MM')
          ORDER BY FORMAT(BlockDate, 'yyyy-MM')
        `);
        series = out.recordset.map(x => ({
          month: x.Month, alloc: round1(num(x.AllocHours)), used: round1(num(x.UsedHours)),
        }));
      } catch (err) {
        console.error('/api/blocks/allocations/:owner series unavailable:', err.message);
      }

      // The evidence behind the Pipeline column: forward booked cases a week,
      // against this owner's own trailing baseline. Bucketed by lead time
      // rather than by calendar week, so every bucket is a whole seven days —
      // a part-week at the edge of the horizon reads as a collapse in demand.
      try {
        const r = (await getTenantPool(req.session.tenantId)).request();
        r.input('owner', sql.NVarChar, owner.owner);
        r.input('horizon', sql.Int, horizonDays);
        r.input('trailing', sql.Int, TRAILING_DAYS);
        const out = await r.query(`
          SELECT ((DaysAhead - 1) / 7) + 1                       AS WeekAhead,
                 SUM(${FORECAST_CASES})                          AS Cases
          FROM V4_FORECAST_COMPILE
          WHERE ISNULL(Caseblock, 'Unknown') = @owner
            AND DaysAhead BETWEEN 1 AND @horizon
          GROUP BY ((DaysAhead - 1) / 7) + 1
          ORDER BY 1
        `);
        const base = await r.query(`
          SELECT CAST(SUM(ISNULL(ACTUAL_INPATIENT,0)
                        + ISNULL(ACTUAL_OUTPATIENT,0)) AS FLOAT)  AS Cases,
                 COUNT(DISTINCT CAST(Date AS DATE))               AS Days
          FROM V4_FORECAST_COMPILE
          WHERE ISNULL(Caseblock, 'Unknown') = @owner
            AND DaysAhead <= 0 AND DaysAhead >= -@trailing
        `);
        const b = base.recordset[0] ?? {};
        const baselinePerWeek = num(b.Days) > 0 ? weekly(num(b.Cases), TRAILING_DAYS) : null;
        const weeks = out.recordset.map(x => ({
          weekAhead: num(x.WeekAhead), cases: round1(num(x.Cases)),
        }));
        const booked = weeks.reduce((t, w) => t + w.cases, 0);
        const forwardPerWeek = weekly(booked, horizonDays);
        pipeline = {
          weeks,
          baselinePerWeek: round1(baselinePerWeek),
          forwardPerWeek: round1(forwardPerWeek),
          baselineDays: num(b.Days),
          trailingDays: TRAILING_DAYS,
          pct: baselinePerWeek > 0 ? round1((forwardPerWeek / baselinePerWeek - 1) * 100) : null,
        };
      } catch (err) {
        // The week shape and the day table are the drawer's first half and do
        // not depend on this; render them and say the pipeline is unavailable.
        console.error('/api/blocks/allocations/:owner pipeline unavailable:', err.message);
      }

      res.json({ ...owner, series, pipeline });
    } catch (err) {
      console.error('/api/blocks/allocations/:owner error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
};

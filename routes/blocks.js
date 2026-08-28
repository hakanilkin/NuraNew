const express = require('express');
const path = require('path');

const { tenantDataDir, readJsonFile } = require('../lib/tenantData');
const { getParam } = require('../utils/tenantColumns');

// Block Allocations (BlockAllocations.md).
//
// The decision this serves is a quarterly block committee review, and the
// question is not "which blocks have low utilisation" — it is "where does the
// allocated grid disagree with how surgeons actually practise, and what should
// we change". The action is reallocation, not release.
//
// The classification is the pipeline's (block_patterns.py), because it is a
// quarterly judgement over a quarter of data. This route serves it, joins the
// live forward trend that qualifies each recommendation, and adds the release
// history that turns a repeat offender on the Radar into an allocation finding.

const num = x => (Number.isFinite(Number(x)) ? Number(x) : 0);
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
      const fwd = num(x.FwdDays) ? num(x.Fwd) / num(x.FwdDays) : 0;
      const hist = num(x.HistDays) ? num(x.Hist) / num(x.HistDays) : 0;
      map.set(x.CaseBlock, {
        forwardPerDay: round1(fwd), baselinePerDay: round1(hist),
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
        trend = await trendByBlock(await getTenantPool(req.session.tenantId), horizonDays, 90);
      } catch (err) {
        // Without the forward join every recommendation still stands; it simply
        // is not qualified by where the volume is heading.
        console.error('/api/blocks/allocations trend unavailable:', err.message);
      }
      const releases = releasesFromStore(req.session.tenantId);

      const owners = allocations
        .filter(a => !sites.length || sites.includes(a.site))
        .map(a => ({
          ...a,
          forwardTrend: trend.get(a.owner) ?? null,
          releaseHistory: {
            ...a.releaseHistory,
            // The workflow store knows about releases the block view cannot see.
            requested: releases.get(a.owner) ?? 0,
          },
        }))
        // Magnitude, not utilisation: a committee has agenda time for the four
        // findings that move the most hours.
        .sort((x, y) => num(y.mismatchHours) - num(x.mismatchHours));

      res.json({
        period, horizonDays,
        thresholds: getParam(tenant, 'block_pattern_thresholds') ?? null,
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

      let series = [];
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

      res.json({ ...owner, series });
    } catch (err) {
      console.error('/api/blocks/allocations/:owner error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
};

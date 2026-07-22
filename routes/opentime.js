const express      = require('express');
const makeFilters  = require('./filters');
const { scoreBlocks } = require('../lib/releaseRisk');

// OR Open Time — Block Release & Reallocation.
// Phase 1: the Release Radar. Read-only; scores upcoming block instances for
// under-utilization risk live from V4_FORECAST_COMPILE (forward signal) and
// V4_BlockResultsView (historical utilization + actual releases). See OROpenTime.md.
module.exports = function openTimeRoutes(getTenantPool, sql, requireTenant) {
  const router = express.Router();
  router.use(requireTenant);

  const { isValidDate } = makeFilters(sql);

  const fmtDate = d =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  // Default radar horizon: ~4 weeks out, with a small buffer band (14–35 days).
  function defaultWindow() {
    const today = new Date();
    const from  = new Date(today); from.setDate(from.getDate() + 14);
    const to    = new Date(today); to.setDate(to.getDate() + 35);
    return { from: fmtDate(from), to: fmtDate(to) };
  }

  // Build an `IN (@p0, @p1, …)` filter from a comma-separated query param.
  function inFilter(request, raw, column, prefix) {
    if (!raw) return '';
    const vals = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (!vals.length) return '';
    const ph = vals.map((v, i) => { request.input(`${prefix}${i}`, sql.NVarChar, v); return `@${prefix}${i}`; });
    return ` AND ISNULL(${column}, 'Unknown') IN (${ph.join(', ')})`;
  }

  // ── GET /api/opentime/radar ────────────────────────────────────────────────
  // Query: from, to (YYYY-MM-DD), sites, services (CSV), minRisk (0–100), histDays
  router.get('/radar', async (req, res) => {
    try {
      const win  = defaultWindow();
      const from = isValidDate(req.query.from) ? req.query.from : win.from;
      const to   = isValidDate(req.query.to)   ? req.query.to   : win.to;
      const histDays = Math.min(Math.max(parseInt(req.query.histDays, 10) || 90, 14), 365);
      const minRisk  = Math.min(Math.max(parseInt(req.query.minRisk, 10)  || 0, 0), 100);

      const db = await getTenantPool(req.session.tenantId);

      // Forward signal — one row per upcoming block instance.
      const fwdReq = db.request();
      fwdReq.input('from', sql.Date, from);
      fwdReq.input('to',   sql.Date, to);
      const siteFilter = inFilter(fwdReq, req.query.sites,    'ORGRP2',        'site');
      const svcFilter  = inFilter(fwdReq, req.query.services, 'SurgeonService', 'svc');

      const fwdResult = await fwdReq.query(`
        SELECT
          CONVERT(VARCHAR(10), Date, 23)      AS Date,
          MAX(DOW_LONG)                       AS DayOfWeek,
          ISNULL(ORGRP2, 'Unknown')           AS Site,
          ISNULL(Caseblock, 'Unknown')        AS CaseBlock,
          ISNULL(SurgeonService, 'Unknown')   AS Service,
          MIN(DaysAhead)                      AS DaysAhead,
          SUM(ISNULL(SCHEDULED_INPATIENT, 0) + ISNULL(SCHEDULED_OUTPATIENT, 0))  AS ScheduledCases,
          SUM(ISNULL(FORECAST_INPATIENT, 0)  + ISNULL(FORECAST_OUTPATIENT, 0))   AS ForecastAddition,
          SUM(ISNULL(SCHEDULED_INPATIENT_DURwTurn, 0) + ISNULL(SCHEDULED_OUTPATIENT_DURwTurn, 0)
            + ISNULL(FORECAST_INPATIENT_DURwTurn, 0)  + ISNULL(FORECAST_OUTPATIENT_DURwTurn, 0)) AS TotalDurwTurn,
          SUM(ISNULL(BLOCKTIME, 0))           AS BlockTime
        FROM V4_FORECAST_COMPILE
        WHERE Date >= @from
          AND Date <= @to
          ${siteFilter}
          ${svcFilter}
        GROUP BY Date, ORGRP2, Caseblock, SurgeonService
        HAVING SUM(ISNULL(BLOCKTIME, 0)) > 0
        ORDER BY Date, ORGRP2, Caseblock
      `);

      // Historical signal — trailing utilization + releases per case block.
      const histReq = db.request();
      histReq.input('histDays', sql.Int, histDays);
      const histResult = await histReq.query(`
        SELECT
          ISNULL(CaseBlock, 'Unknown')                  AS CaseBlock,
          COUNT(DISTINCT CAST(BlockDate AS DATE))       AS BlockDays,
          SUM(ISNULL(Total_Prime_Time, 0))              AS SumPrime,
          SUM(ISNULL(blockTime, 0))                     AS SumBlock,
          SUM(ISNULL(ReleasedTime, 0))                  AS SumReleased
        FROM V4_BlockResultsView
        WHERE BlockDate >= DATEADD(day, -@histDays, CAST(GETDATE() AS DATE))
          AND BlockDate <  CAST(GETDATE() AS DATE)
          AND DATEPART(WEEKDAY, BlockDate) IN (2, 3, 4, 5, 6)
        GROUP BY CaseBlock
      `);

      const histMap = new Map(histResult.recordset.map(h => [h.CaseBlock, h]));
      const rows = scoreBlocks(fwdResult.recordset, histMap)
        .filter(r => (r.risk ?? 0) >= minRisk)
        .sort((a, b) => (b.risk ?? -1) - (a.risk ?? -1));

      res.json({ window: { from, to, histDays }, rows });
    } catch (err) {
      console.error('/api/opentime/radar error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
};

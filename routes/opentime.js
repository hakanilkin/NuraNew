const express      = require('express');
const makeFilters  = require('./filters');
const { scoreBlocks } = require('../lib/releaseRisk');
const store        = require('../lib/openTimeStore');

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

  // ── Release requests (demo store — no email; response links are the "email") ─

  // POST /api/opentime/requests  — record a sent release request
  router.post('/requests', (req, res) => {
    try {
      const b = req.body || {};
      if (!b.blockDate || !b.site || !b.caseBlock) {
        return res.status(400).json({ error: 'blockDate, site and caseBlock are required' });
      }
      const created = store.createRequest(req.session.tenantId, b);
      res.status(201).json(created);
    } catch (err) {
      console.error('/api/opentime/requests POST error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/opentime/requests  — tracker board
  router.get('/requests', (req, res) => {
    res.json({ requests: store.listRequests(req.session.tenantId) });
  });

  // POST /api/opentime/requests/:id/snooze
  router.post('/requests/:id/snooze', (req, res) => {
    const r = store.snoozeRequest(req.session.tenantId, req.params.id, (req.body || {}).until || null);
    if (!r) return res.status(404).json({ error: 'Request not found' });
    res.json(r);
  });

  // ── Open-time slots + reallocation ──────────────────────────────────────────

  // GET /api/opentime/slots  — released-time inventory
  router.get('/slots', (req, res) => {
    res.json({ slots: store.listSlots(req.session.tenantId) });
  });

  // GET /api/opentime/slots/:id/candidates
  // Ranks other service lines to offer the freed time to, by forward demand
  // (V4_FORECAST_COMPILE) blended with tenant strategic-goal weights.
  router.get('/slots/:id/candidates', async (req, res) => {
    try {
      const slot = store.getSlot(req.session.tenantId, req.params.id);
      if (!slot) return res.status(404).json({ error: 'Slot not found' });

      const db = await getTenantPool(req.session.tenantId);
      const r  = db.request();
      r.input('site', sql.NVarChar, slot.site);
      const demand = await r.query(`
        SELECT
          ISNULL(SurgeonService, 'Unknown') AS Service,
          SUM(ISNULL(SCHEDULED_INPATIENT, 0) + ISNULL(SCHEDULED_OUTPATIENT, 0)
            + ISNULL(FORECAST_INPATIENT, 0)  + ISNULL(FORECAST_OUTPATIENT, 0)) AS ForecastCases
        FROM V4_FORECAST_COMPILE
        WHERE Date >= CAST(GETDATE() AS DATE)
          AND Date <= DATEADD(day, 42, CAST(GETDATE() AS DATE))
          AND ISNULL(ORGRP2, 'Unknown') = @site
        GROUP BY SurgeonService
      `);

      const goals    = store.getGoals(req.session.tenantId);
      const goalMap  = new Map(goals.map(g => [g.service.toLowerCase(), Number(g.weight) || 0]));
      const maxGoal  = Math.max(1, ...goals.map(g => Number(g.weight) || 0));

      // Candidate pool = services with forward demand at this site, minus the
      // one that just gave up the time.
      const pool = demand.recordset
        .filter(d => (d.Service || '').toLowerCase() !== (slot.service || '').toLowerCase())
        .map(d => ({ service: d.Service, forecastCases: Number(d.ForecastCases) || 0 }));
      const maxCases = Math.max(1, ...pool.map(p => p.forecastCases));

      const W_DEMAND = 0.6, W_STRATEGIC = 0.4;
      // Scores keep full precision here so ranking and any future tie-break
      // stay exact; rounding is the render layer's job.
      const candidates = pool.map(p => {
        const demandNorm = p.forecastCases / maxCases;
        const goalW      = goalMap.get(p.service.toLowerCase()) || 0;
        const goalNorm   = goalW / maxGoal;
        const score      = (W_DEMAND * demandNorm + W_STRATEGIC * goalNorm) * 100;
        const drivers = [
          { key: 'demand', label: 'Forward demand', contribution: demandNorm * 100,
            detail: `${Math.round(p.forecastCases)} cases forecast at this site over the next 6 weeks` },
        ];
        if (goalW > 0) drivers.push({
          key: 'strategic', label: 'Strategic priority', contribution: goalNorm * 100,
          detail: `Growth target (weight ${goalW})`,
        });
        return { candidate: p.service, service: p.service, matchScore: score, forecastCases: p.forecastCases, isStrategic: goalW > 0, drivers };
      }).sort((a, b) => b.matchScore - a.matchScore);

      res.json({ slot, candidates });
    } catch (err) {
      console.error('/api/opentime/slots/:id/candidates error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/opentime/slots/:id/offer  — send fill offer(s)
  router.post('/slots/:id/offer', (req, res) => {
    const candidates = (req.body || {}).candidates;
    if (!Array.isArray(candidates) || !candidates.length) {
      return res.status(400).json({ error: 'candidates[] is required' });
    }
    const slot = store.createOffers(req.session.tenantId, req.params.id, candidates);
    if (!slot) return res.status(404).json({ error: 'Slot not found' });
    res.status(201).json(slot);
  });

  // ── Fulfillment queue ───────────────────────────────────────────────────────
  //
  // Nura decides; the EMR transacts. These are the entries a scheduler still has
  // to make by hand. A worklist, not a tracking instrument — see
  // OpenTimeFulfillment.md §1 for why nothing here ages, scores or ranks.

  const VALID_STATUS = new Set(['PENDING', 'DONE', 'CANCELLED', 'ALL']);

  // GET /api/opentime/tasks?status=PENDING|DONE|ALL
  router.get('/tasks', (req, res) => {
    try {
      const raw = String(req.query.status || 'ALL').toUpperCase();
      const status = VALID_STATUS.has(raw) ? raw : 'ALL';
      const all = store.listTasks(req.session.tenantId, 'ALL');
      res.json({
        tasks: status === 'ALL' ? all : all.filter(t => t.status === status),
        summary: {
          pending: all.filter(t => t.status === 'PENDING').length,
          done: all.filter(t => t.status === 'DONE').length,
        },
      });
    } catch (err) {
      console.error('/api/opentime/tasks error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/opentime/tasks/:id/complete
  router.post('/tasks/:id/complete', (req, res) => {
    try {
      // Who completed it comes from the session, never the request body.
      const who = req.session?.email || req.session?.username || 'A teammate';
      const task = store.completeTask(req.session.tenantId, req.params.id, {
        completedBy: who, note: (req.body || {}).note,
      });
      if (!task) return res.status(404).json({ error: 'Task not found or already closed' });
      res.json(task);
    } catch (err) {
      console.error('/api/opentime/tasks complete error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/opentime/tasks/:id/cancel — the decision behind it was reversed
  router.post('/tasks/:id/cancel', (req, res) => {
    try {
      const note = (req.body || {}).note;
      if (!note) return res.status(400).json({ error: 'note is required when cancelling' });
      const who = req.session?.email || req.session?.username || 'A teammate';
      const task = store.cancelTask(req.session.tenantId, req.params.id, { completedBy: who, note });
      if (!task) return res.status(404).json({ error: 'Task not found or already closed' });
      res.json(task);
    } catch (err) {
      console.error('/api/opentime/tasks cancel error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── The funnel ──────────────────────────────────────────────────────────────
  // Released hours alone flatter the product. Released-and-filled is the honest
  // number, and it is the one nobody else publishes.

  router.get('/summary', (req, res) => {
    try {
      const { from, to } = req.query;
      res.json(store.summary(req.session.tenantId, {
        from: isValidDate(from) ? from : undefined,
        to:   isValidDate(to)   ? to   : undefined,
      }));
    } catch (err) {
      console.error('/api/opentime/summary error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Strategic goals ─────────────────────────────────────────────────────────

  router.get('/goals', (req, res) => {
    res.json({ goals: store.getGoals(req.session.tenantId) });
  });

  router.put('/goals', (req, res) => {
    const goals = store.setGoals(req.session.tenantId, (req.body || {}).goals);
    res.json({ goals });
  });

  return router;
};

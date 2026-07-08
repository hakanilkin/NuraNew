const express   = require('express');
const { getParam } = require('../utils/tenantColumns');

module.exports = function orServiceLineRoutes(getTenantPool, sql, requireTenant) {
  const router = express.Router();
  router.use(requireTenant);

  function isValidDate(s) {
    return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  }

  function defaultRange() {
    const to   = new Date();
    const from = new Date(to.getFullYear(), to.getMonth() - 5, 1);
    const fmt  = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { from: fmt(from), to: fmt(to) };
  }

  function parseRange(query) {
    const def = defaultRange();
    return {
      from: isValidDate(query.from) ? query.from : def.from,
      to:   isValidDate(query.to)   ? query.to   : def.to,
    };
  }

  // Compute the same-length window immediately before `from`.
  function priorPeriod(from, to) {
    const d1     = new Date(from + 'T00:00:00Z');
    const d2     = new Date(to   + 'T00:00:00Z');
    const diffMs = d2 - d1 + 86400000;
    const prevTo   = new Date(d1.getTime() - 86400000);
    const prevFrom = new Date(d1.getTime() - diffMs);
    const fmt = d => d.toISOString().slice(0, 10);
    return { prevFrom: fmt(prevFrom), prevTo: fmt(prevTo) };
  }

  // Data-aware quarter selection: finds the two most recent complete quarters whose end
  // date falls on or before anchorDate. Falls back to yesterday when anchorDate is absent.
  function twoCompleteQuartersFrom(anchorDate) {
    // anchorDate is a JS Date from SQL (may be null/invalid for empty tables)
    let ay, am, ad;
    if (anchorDate instanceof Date && !isNaN(anchorDate)) {
      ay = anchorDate.getUTCFullYear();
      am = anchorDate.getUTCMonth() + 1; // 1-indexed
      ad = anchorDate.getUTCDate();
    } else {
      const yesterday = new Date(Date.now() - 86400000);
      ay = yesterday.getUTCFullYear();
      am = yesterday.getUTCMonth() + 1;
      ad = yesterday.getUTCDate();
    }
    const anchorInt = ay * 10000 + am * 100 + ad;

    // Quarter end dates [endMonth, endDay] for Q1..Q4
    const QE = [[3, 31], [6, 30], [9, 30], [12, 31]];
    const p  = n => String(n).padStart(2, '0');

    const candidates = [];
    for (let y = ay - 2; y <= ay; y++) {
      for (let qi = 0; qi < 4; qi++) {
        const [em, ed] = QE[qi];
        const endInt   = y * 10000 + em * 100 + ed;
        if (endInt <= anchorInt) {
          const sm = qi * 3 + 1;
          candidates.push({
            label: `Q${qi + 1} ${y}`,
            from:  `${y}-${p(sm)}-01`,
            to:    `${y}-${p(em)}-${p(ed)}`,
            endInt,
          });
        }
      }
    }

    candidates.sort((a, b) => b.endInt - a.endInt);
    return { curr: candidates[0], prior: candidates[1] };
  }

  // Status classification matching pipeline_config.py brief_status_rules (first-match).
  function classifyStatus(ib, pt) {
    if (ib == null || pt == null) return 'watch';
    if (ib < 65  && pt > 75)     return 'misaligned';
    if (ib > 75  && pt > 75)     return 'under_allocated';
    if (ib >= 70 && ib <= 80 && pt >= 70 && pt <= 80) return 'right_sized';
    if (ib < 60  && pt < 65)     return 'over_allocated';
    return 'watch';
  }

  // Append optional location / case_type WHERE clauses (both fully parameterized).
  function addOptionalFilters(dbReq, query, w) {
    if (query.location) {
      dbReq.input('location',  sql.NVarChar(200), query.location);
      w += ' AND Loc_ORGrp2 = @location';
    }
    if (query.case_type) {
      dbReq.input('case_type', sql.NVarChar(200), query.case_type);
      w += ' AND Case_CaseType = @case_type';
    }
    return w;
  }

  // ── GET /api/orserviceline/summary ─────────────────────────────────────────
  // System-level headline metrics for the selected date window.

  router.get('/summary', async (req, res) => {
    try {
      const db          = await getTenantPool(req.session.tenantId);
      const dbReq       = db.request();
      dbReq.timeout     = 30000;
      const { from, to }  = parseRange(req.query);
      const postedValue   = getParam(req.tenantName, 'case_posted_value') ?? 'Posted';

      dbReq.input('from',        sql.Date,         from);
      dbReq.input('to',          sql.Date,         to);
      dbReq.input('postedValue', sql.NVarChar(50), postedValue);

      let w = `CaseLogStatus = @postedValue AND Date_Scheddate BETWEEN @from AND @to`;
      w = addOptionalFilters(dbReq, req.query, w);

      const result = await dbReq.query(`
        SELECT
          COUNT(*) AS total_cases,
          COUNT(DISTINCT Case_SurgeonService) AS distinct_service_lines,
          CAST(
            100.0
            * SUM(CASE WHEN Turnover_Orderofcaseinroom = 1 AND Dur_Act_vs_SchedStart <= 0 THEN 1 ELSE 0 END)
            / NULLIF(SUM(CASE WHEN Turnover_Orderofcaseinroom = 1 AND Dur_Act_vs_SchedStart IS NOT NULL THEN 1 ELSE 0 END), 0)
          AS DECIMAL(5,1)) AS system_fcot_pct,
          CAST(AVG(CASE WHEN Turnover_Turnover BETWEEN 0 AND 240
            THEN CAST(Turnover_Turnover AS FLOAT) ELSE NULL END) AS DECIMAL(5,1)) AS avg_turnover,
          CAST(AVG(CAST(Dur_Act_vs_SchedDur AS FLOAT)) AS DECIMAL(5,1)) AS avg_dur_delta
        FROM DS_CASES
        WHERE ${w}
      `);
      res.json(result.recordset[0] ?? {});
    } catch (err) {
      console.error('/api/orserviceline/summary error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/orserviceline/by-service ──────────────────────────────────────
  // Per-service-line metrics with QoQ volume delta vs the same-length prior window.
  // Only services with >= 20 cases in the current window are returned.

  router.get('/by-service', async (req, res) => {
    try {
      const db          = await getTenantPool(req.session.tenantId);
      const dbReq       = db.request();
      dbReq.timeout     = 30000;
      const { from, to }         = parseRange(req.query);
      const { prevFrom, prevTo } = priorPeriod(from, to);
      const postedValue           = getParam(req.tenantName, 'case_posted_value') ?? 'Posted';

      dbReq.input('from',        sql.Date,         from);
      dbReq.input('to',          sql.Date,         to);
      dbReq.input('prevFrom',    sql.Date,         prevFrom);
      dbReq.input('prevTo',      sql.Date,         prevTo);
      dbReq.input('postedValue', sql.NVarChar(50), postedValue);

      let w = `CaseLogStatus = @postedValue
        AND (Date_Scheddate BETWEEN @from AND @to OR Date_Scheddate BETWEEN @prevFrom AND @prevTo)
        AND Case_SurgeonService IS NOT NULL`;
      w = addOptionalFilters(dbReq, req.query, w);

      const result = await dbReq.query(`
        SELECT
          Case_SurgeonService AS service,
          SUM(CASE WHEN Date_Scheddate BETWEEN @from    AND @to    THEN 1 ELSE 0 END) AS n_cases,
          SUM(CASE WHEN Date_Scheddate BETWEEN @prevFrom AND @prevTo THEN 1 ELSE 0 END) AS n_prior,
          CAST(
            100.0
            * SUM(CASE WHEN Date_Scheddate BETWEEN @from AND @to
                        AND Turnover_Orderofcaseinroom = 1
                        AND Dur_Act_vs_SchedStart <= 0 THEN 1 ELSE 0 END)
            / NULLIF(SUM(CASE WHEN Date_Scheddate BETWEEN @from AND @to
                               AND Turnover_Orderofcaseinroom = 1
                               AND Dur_Act_vs_SchedStart IS NOT NULL THEN 1 ELSE 0 END), 0)
          AS DECIMAL(5,1)) AS fcot_pct,
          CAST(AVG(CASE WHEN Date_Scheddate BETWEEN @from AND @to
                         AND Turnover_Turnover BETWEEN 0 AND 240
                         THEN CAST(Turnover_Turnover AS FLOAT) ELSE NULL END) AS DECIMAL(5,1)) AS avg_turnover,
          CAST(AVG(CASE WHEN Date_Scheddate BETWEEN @from AND @to
                         THEN CAST(Sched_SchedDur   AS FLOAT) ELSE NULL END) AS DECIMAL(5,1)) AS avg_sched_dur,
          CAST(AVG(CASE WHEN Date_Scheddate BETWEEN @from AND @to
                         THEN CAST(Dur_ORIn_OROut   AS FLOAT) ELSE NULL END) AS DECIMAL(5,1)) AS avg_actual_dur,
          CAST(AVG(CASE WHEN Date_Scheddate BETWEEN @from AND @to
                         THEN CAST(Dur_Act_vs_SchedDur AS FLOAT) ELSE NULL END) AS DECIMAL(5,1)) AS avg_dur_delta,
          CAST(
            100.0
            * SUM(CASE WHEN Date_Scheddate BETWEEN @from AND @to
                        AND Case_AddOnCode = 'Add-on Case' THEN 1 ELSE 0 END)
            / NULLIF(SUM(CASE WHEN Date_Scheddate BETWEEN @from AND @to THEN 1 ELSE 0 END), 0)
          AS DECIMAL(5,1)) AS addon_pct,
          CAST(AVG(CASE WHEN Date_Scheddate BETWEEN @from AND @to
                         THEN CAST(Case_DaysScheduledAhead AS FLOAT) ELSE NULL END) AS DECIMAL(5,1)) AS avg_days_sched_ahead
        FROM DS_CASES
        WHERE ${w}
        GROUP BY Case_SurgeonService
        HAVING SUM(CASE WHEN Date_Scheddate BETWEEN @from AND @to THEN 1 ELSE 0 END) >= 20
        ORDER BY n_cases DESC
      `);

      const rows = result.recordset.map(r => ({
        ...r,
        vol_delta_pct: r.n_prior > 0
          ? Math.round(((r.n_cases - r.n_prior) / r.n_prior) * 1000) / 10
          : null,
      }));
      res.json(rows);
    } catch (err) {
      console.error('/api/orserviceline/by-service error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/orserviceline/service-blocks ──────────────────────────────────
  // Block distribution for a specific service line (or all services if omitted).

  router.get('/service-blocks', async (req, res) => {
    try {
      const db          = await getTenantPool(req.session.tenantId);
      const dbReq       = db.request();
      dbReq.timeout     = 30000;
      const { from, to } = parseRange(req.query);
      const postedValue  = getParam(req.tenantName, 'case_posted_value') ?? 'Posted';

      dbReq.input('from',        sql.Date,         from);
      dbReq.input('to',          sql.Date,         to);
      dbReq.input('postedValue', sql.NVarChar(50), postedValue);

      let w = `CaseLogStatus = @postedValue AND Date_Scheddate BETWEEN @from AND @to`;
      if (req.query.service) {
        dbReq.input('service', sql.NVarChar(200), req.query.service);
        w += ' AND Case_SurgeonService = @service';
      }
      w = addOptionalFilters(dbReq, req.query, w);

      const result = await dbReq.query(`
        SELECT
          ISNULL(Case_CaseBlock, 'No block') AS caseblock,
          COUNT(*) AS n_cases
        FROM DS_CASES
        WHERE ${w}
        GROUP BY Case_CaseBlock
        ORDER BY n_cases DESC
      `);
      res.json(result.recordset);
    } catch (err) {
      console.error('/api/orserviceline/service-blocks error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/orserviceline/trend ───────────────────────────────────────────
  // Monthly volume + FCOT + avg turnover. Pass ?service= to filter by service line.

  router.get('/trend', async (req, res) => {
    try {
      const db          = await getTenantPool(req.session.tenantId);
      const dbReq       = db.request();
      dbReq.timeout     = 30000;
      const { from, to } = parseRange(req.query);
      const postedValue  = getParam(req.tenantName, 'case_posted_value') ?? 'Posted';

      dbReq.input('from',        sql.Date,         from);
      dbReq.input('to',          sql.Date,         to);
      dbReq.input('postedValue', sql.NVarChar(50), postedValue);

      let w = `CaseLogStatus = @postedValue AND Date_Scheddate BETWEEN @from AND @to`;
      if (req.query.service) {
        dbReq.input('service', sql.NVarChar(200), req.query.service);
        w += ' AND Case_SurgeonService = @service';
      }
      w = addOptionalFilters(dbReq, req.query, w);

      const result = await dbReq.query(`
        SELECT
          DD_Year_Month AS month,
          COUNT(*) AS n_cases,
          CAST(
            100.0
            * SUM(CASE WHEN Turnover_Orderofcaseinroom = 1 AND Dur_Act_vs_SchedStart <= 0 THEN 1 ELSE 0 END)
            / NULLIF(SUM(CASE WHEN Turnover_Orderofcaseinroom = 1 AND Dur_Act_vs_SchedStart IS NOT NULL THEN 1 ELSE 0 END), 0)
          AS DECIMAL(5,1)) AS fcot_pct,
          CAST(AVG(CASE WHEN Turnover_Turnover BETWEEN 0 AND 240
            THEN CAST(Turnover_Turnover AS FLOAT) ELSE NULL END) AS DECIMAL(5,1)) AS avg_turnover
        FROM DS_CASES
        WHERE ${w}
        GROUP BY DD_Year_Month
        ORDER BY DD_Year_Month
      `);
      res.json(result.recordset);
    } catch (err) {
      console.error('/api/orserviceline/trend error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/orserviceline/filter-options ──────────────────────────────────
  // Distinct filter values for the current date window.

  router.get('/filter-options', async (req, res) => {
    try {
      const db          = await getTenantPool(req.session.tenantId);
      const { from, to } = parseRange(req.query);
      const postedValue  = getParam(req.tenantName, 'case_posted_value') ?? 'Posted';

      const makeReq = () => {
        const r = db.request();
        r.timeout = 30000;
        r.input('from',        sql.Date,         from);
        r.input('to',          sql.Date,         to);
        r.input('postedValue', sql.NVarChar(50), postedValue);
        return r;
      };

      const base = `CaseLogStatus = @postedValue AND Date_Scheddate BETWEEN @from AND @to`;

      const [locRes, typeRes, svcRes] = await Promise.all([
        makeReq().query(`SELECT DISTINCT ISNULL(Loc_ORGrp2, 'Unknown') AS value FROM DS_CASES WHERE ${base} ORDER BY value`),
        makeReq().query(`SELECT DISTINCT Case_CaseType AS value FROM DS_CASES WHERE ${base} AND Case_CaseType IS NOT NULL ORDER BY value`),
        makeReq().query(`SELECT DISTINCT Case_SurgeonService AS value FROM DS_CASES WHERE ${base} AND Case_SurgeonService IS NOT NULL ORDER BY value`),
      ]);

      res.json({
        locations:     locRes.recordset.map(r => r.value),
        case_types:    typeRes.recordset.map(r => r.value),
        service_lines: svcRes.recordset.map(r => r.value),
      });
    } catch (err) {
      console.error('/api/orserviceline/filter-options error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/orserviceline/operational ────────────────────────────────────
  // Per-quarter operational metrics for a single service line.
  // Quarters are derived server-side; @from/@to are not read.

  router.get('/operational', async (req, res) => {
    try {
      if (!req.query.service) return res.status(400).json({ error: 'service is required' });

      const db          = await getTenantPool(req.session.tenantId);
      const postedValue = getParam(req.tenantName, 'case_posted_value') ?? 'Posted';

      // One lightweight query to find max posted date — selects quarters the data covers.
      const maxReq = db.request();
      maxReq.timeout = 30000;
      maxReq.input('postedValue', sql.NVarChar(50), postedValue);
      const maxResult = await maxReq.query(
        `SELECT MAX(Date_Scheddate) AS MaxDate FROM DS_CASES WHERE CaseLogStatus = @postedValue`
      );
      const { curr, prior } = twoCompleteQuartersFrom(maxResult.recordset[0]?.MaxDate ?? null);

      const dbReq       = db.request();
      dbReq.timeout     = 30000;

      dbReq.input('service',     sql.NVarChar(200), req.query.service);
      dbReq.input('currFrom',    sql.Date,          curr.from);
      dbReq.input('currTo',      sql.Date,          curr.to);
      dbReq.input('priorFrom',   sql.Date,          prior.from);
      dbReq.input('priorTo',     sql.Date,          prior.to);
      dbReq.input('postedValue', sql.NVarChar(50),  postedValue);

      const result = await dbReq.query(`
        SELECT
          CASE
            WHEN Date_Scheddate BETWEEN @currFrom  AND @currTo  THEN 'current'
            WHEN Date_Scheddate BETWEEN @priorFrom AND @priorTo THEN 'prior'
          END AS period,
          COUNT(*) AS n_cases,
          CAST(
            100.0
            * SUM(CASE WHEN Turnover_Orderofcaseinroom = 1 AND Dur_Act_vs_SchedStart <= 0 THEN 1 ELSE 0 END)
            / NULLIF(SUM(CASE WHEN Turnover_Orderofcaseinroom = 1 AND Dur_Act_vs_SchedStart IS NOT NULL THEN 1 ELSE 0 END), 0)
          AS DECIMAL(5,1)) AS fcot_pct,
          CAST(AVG(CASE WHEN Turnover_Turnover BETWEEN 0 AND 240
            THEN CAST(Turnover_Turnover AS FLOAT) ELSE NULL END) AS DECIMAL(5,1)) AS avg_turnover,
          CAST(AVG(CAST(Sched_SchedDur AS FLOAT)) AS DECIMAL(5,1)) AS avg_sched_dur,
          CAST(AVG(CAST(Dur_ORIn_OROut AS FLOAT)) AS DECIMAL(5,1)) AS avg_actual_dur,
          CAST(AVG(CAST(Dur_Act_vs_SchedDur AS FLOAT)) AS DECIMAL(5,1)) AS dur_delta,
          CAST(
            100.0
            * SUM(CASE WHEN Case_AddOnCode = 'Add-on Case' THEN 1 ELSE 0 END)
            / NULLIF(COUNT(*), 0)
          AS DECIMAL(5,1)) AS addon_pct,
          CAST(AVG(CAST(Case_DaysScheduledAhead AS FLOAT)) AS DECIMAL(5,1)) AS avg_days_sched_ahead,
          COUNT(DISTINCT Case_Surgeon) AS distinct_surgeons,
          COUNT(DISTINCT Loc_ORLoc)    AS distinct_rooms
        FROM DS_CASES
        WHERE CaseLogStatus = @postedValue
          AND Case_SurgeonService = @service
          AND (Date_Scheddate BETWEEN @currFrom  AND @currTo
            OR Date_Scheddate BETWEEN @priorFrom AND @priorTo)
        GROUP BY
          CASE
            WHEN Date_Scheddate BETWEEN @currFrom  AND @currTo  THEN 'current'
            WHEN Date_Scheddate BETWEEN @priorFrom AND @priorTo THEN 'prior'
          END
      `);

      const byPeriod = {};
      for (const r of result.recordset) { const { period, ...rest } = r; byPeriod[period] = rest; }

      res.json({
        current: { quarter_label: curr.label,  ...(byPeriod.current ?? {}) },
        prior:   { quarter_label: prior.label, ...(byPeriod.prior   ?? {}) },
      });
    } catch (err) {
      console.error('/api/orserviceline/operational error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/orserviceline/utilization ─────────────────────────────────────
  // Per-quarter block utilization for a single service line from V4_BlockResultsView.
  // Quarters are derived server-side. Returns a status classification.

  router.get('/utilization', async (req, res) => {
    try {
      if (!req.query.service) return res.status(400).json({ error: 'service is required' });

      const db = await getTenantPool(req.session.tenantId);

      // One lightweight query to find max block date — selects quarters the data covers.
      const maxReq = db.request();
      maxReq.timeout = 30000;
      const maxResult = await maxReq.query(
        `SELECT MAX(BlockDate) AS MaxDate FROM V4_BlockResultsView`
      );
      const { curr, prior } = twoCompleteQuartersFrom(maxResult.recordset[0]?.MaxDate ?? null);

      const dbReq   = db.request();
      dbReq.timeout = 30000;

      dbReq.input('service',   sql.NVarChar(200), req.query.service);
      dbReq.input('currFrom',  sql.Date,          curr.from);
      dbReq.input('currTo',    sql.Date,          curr.to);
      dbReq.input('priorFrom', sql.Date,          prior.from);
      dbReq.input('priorTo',   sql.Date,          prior.to);

      const result = await dbReq.query(`
        SELECT
          CASE
            WHEN BlockDate BETWEEN @currFrom  AND @currTo  THEN 'current'
            WHEN BlockDate BETWEEN @priorFrom AND @priorTo THEN 'prior'
          END AS period,
          CAST(SUM(ISNULL(blockTime, 0)) / 60.0 AS DECIMAL(8,1)) AS allocated_hours,
          CAST(
            100.0 * SUM(ISNULL(InBlock, 0)) / NULLIF(SUM(ISNULL(blockTime, 0)), 0)
          AS DECIMAL(5,1)) AS inblock_util,
          CAST(
            100.0 * SUM(ISNULL(Total_Prime_Time, 0)) / NULLIF(SUM(ISNULL(blockTime, 0)), 0)
          AS DECIMAL(5,1)) AS primetime_util,
          CAST(
            100.0 * SUM(ISNULL(ReleasedTime, 0)) / NULLIF(SUM(ISNULL(blockTime, 0)), 0)
          AS DECIMAL(5,1)) AS released_pct,
          CAST(
            100.0 * SUM(ISNULL(OutofBlock, 0))
            / NULLIF(SUM(ISNULL(InBlock, 0)) + SUM(ISNULL(OutofBlock, 0)), 0)
          AS DECIMAL(5,1)) AS outofblock_pct
        FROM V4_BlockResultsView
        WHERE Surgeonservice = @service
          AND (BlockDate BETWEEN @currFrom  AND @currTo
            OR BlockDate BETWEEN @priorFrom AND @priorTo)
        GROUP BY
          CASE
            WHEN BlockDate BETWEEN @currFrom  AND @currTo  THEN 'current'
            WHEN BlockDate BETWEEN @priorFrom AND @priorTo THEN 'prior'
          END
      `);

      const byPeriod = {};
      for (const r of result.recordset) { const { period, ...rest } = r; byPeriod[period] = rest; }

      const ib     = byPeriod.current?.inblock_util   ?? null;
      const pt     = byPeriod.current?.primetime_util ?? null;
      const status = classifyStatus(ib != null ? Number(ib) : null, pt != null ? Number(pt) : null);

      res.json({
        current: { quarter_label: curr.label,  ...(byPeriod.current ?? {}) },
        prior:   { quarter_label: prior.label, ...(byPeriod.prior   ?? {}) },
        status,
      });
    } catch (err) {
      console.error('/api/orserviceline/utilization error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/orserviceline/pipeline ────────────────────────────────────────
  // Forward-looking scheduled cases grouped by ISO week, with baseline comparison.

  router.get('/pipeline', async (req, res) => {
    try {
      if (!req.query.service) return res.status(400).json({ error: 'service is required' });
      const weeksAhead = Math.min(Math.max(parseInt(req.query.weeks_ahead, 10) || 8, 1), 52);

      const db          = await getTenantPool(req.session.tenantId);
      const postedValue = getParam(req.tenantName, 'case_posted_value') ?? 'Posted';

      function makeR() {
        const r = db.request();
        r.timeout = 30000;
        r.input('service',     sql.NVarChar(200), req.query.service);
        r.input('postedValue', sql.NVarChar(50),  postedValue);
        return r;
      }

      const fwdReq = makeR();
      fwdReq.input('weeksAhead', sql.Int, weeksAhead);

      const baseReq = makeR();

      const [fwdResult, baseResult] = await Promise.all([
        fwdReq.query(`
          SELECT
            CAST(DATEPART(YEAR, Date_Scheddate) AS NVARCHAR(4))
              + '-W'
              + RIGHT('0' + CAST(DATEPART(WEEK, Date_Scheddate) AS NVARCHAR(2)), 2) AS week_label,
            COUNT(*) AS n_cases,
            COUNT(DISTINCT Case_Surgeon) AS distinct_surgeons
          FROM DS_CASES
          WHERE CaseLogStatus = @postedValue
            AND Case_SurgeonService = @service
            AND Date_Scheddate > CAST(GETDATE() AS DATE)
            AND Date_Scheddate <= DATEADD(week, @weeksAhead, CAST(GETDATE() AS DATE))
          GROUP BY
            DATEPART(YEAR, Date_Scheddate),
            DATEPART(WEEK, Date_Scheddate)
          ORDER BY week_label
        `),
        baseReq.query(`
          SELECT
            SUM(sub.n) AS total_cases,
            COUNT(*)   AS n_weeks
          FROM (
            SELECT
              CAST(DATEPART(YEAR, Date_Scheddate) AS NVARCHAR(4))
                + '-W'
                + RIGHT('0' + CAST(DATEPART(WEEK, Date_Scheddate) AS NVARCHAR(2)), 2) AS wk,
              COUNT(*) AS n
            FROM DS_CASES
            WHERE CaseLogStatus = @postedValue
              AND Case_SurgeonService = @service
              AND Date_Scheddate BETWEEN DATEADD(week, -4, CAST(GETDATE() AS DATE))
                                     AND CAST(GETDATE() AS DATE)
            GROUP BY
              DATEPART(YEAR, Date_Scheddate),
              DATEPART(WEEK, Date_Scheddate)
          ) sub
        `),
      ]);

      const bRow           = baseResult.recordset[0] ?? {};
      const totalBase      = Number(bRow.total_cases ?? 0);
      const nWeeks         = Number(bRow.n_weeks ?? 0);
      const baselinePerWk  = nWeeks > 0 ? Math.round((totalBase / nWeeks) * 10) / 10 : 0;

      const weeks = fwdResult.recordset.map(r => ({
        week_label:        r.week_label,
        n_cases:           r.n_cases,
        distinct_surgeons: r.distinct_surgeons,
        vs_baseline_pct:   baselinePerWk > 0
          ? Math.round(((r.n_cases - baselinePerWk) / baselinePerWk) * 1000) / 10
          : null,
      }));

      res.json({ weeks, baseline_per_week: baselinePerWk });
    } catch (err) {
      console.error('/api/orserviceline/pipeline error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/orserviceline/utilization-trend ───────────────────────────────
  // Monthly in-block and prime-time utilization from V4_BlockResultsView.

  router.get('/utilization-trend', async (req, res) => {
    try {
      if (!req.query.service) return res.status(400).json({ error: 'service is required' });

      const db      = await getTenantPool(req.session.tenantId);
      const dbReq   = db.request();
      dbReq.timeout = 30000;
      const { from, to } = parseRange(req.query);

      dbReq.input('service', sql.NVarChar(200), req.query.service);
      dbReq.input('from',    sql.Date,          from);
      dbReq.input('to',      sql.Date,          to);

      const result = await dbReq.query(`
        SELECT
          CAST(YEAR(BlockDate) AS NVARCHAR(4))
            + '-'
            + RIGHT('0' + CAST(MONTH(BlockDate) AS NVARCHAR(2)), 2) AS month,
          CAST(
            100.0 * SUM(ISNULL(InBlock, 0)) / NULLIF(SUM(ISNULL(blockTime, 0)), 0)
          AS DECIMAL(5,1)) AS inblock_util,
          CAST(
            100.0 * SUM(ISNULL(Total_Prime_Time, 0)) / NULLIF(SUM(ISNULL(blockTime, 0)), 0)
          AS DECIMAL(5,1)) AS primetime_util
        FROM V4_BlockResultsView
        WHERE Surgeonservice = @service
          AND BlockDate BETWEEN @from AND @to
        GROUP BY YEAR(BlockDate), MONTH(BlockDate)
        ORDER BY YEAR(BlockDate), MONTH(BlockDate)
      `);
      res.json(result.recordset);
    } catch (err) {
      console.error('/api/orserviceline/utilization-trend error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
};

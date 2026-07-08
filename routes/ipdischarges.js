const express = require('express')
const { getFeatures } = require('../utils/tenantColumns')

const LOC_EXPR = `CASE
  WHEN DEP_LASTDEPT LIKE '%EMERGENCY%' THEN 'Emergency'
  WHEN DEP_LASTDEPT IN ('OLLH OR','VORH OR','VORH JRI OR','MEMH OR','MARH OR') THEN 'Surgery'
  WHEN DEP_LASTDEPT LIKE '%ENDOSCOPY%' THEN 'Endoscopy'
  WHEN DEP_LASTDEPT = 'UNK' THEN 'UNK'
  WHEN DEP_LASTDEPTLOC IS NULL THEN 'Other'
  ELSE DEP_LASTDEPTLOC
END`

const DIM_MAP = {
  hospital:        'DEP_LASTDEPTHOSPITAL',
  dept:            'DEP_LASTDEPT',
  loc:             `(${LOC_EXPR})`,
  patclass:        'PATCLASS',
  provider:        `ISNULL(PROV_LASTPROV,N'') + N' - ' + ISNULL(PROV_LASTPROVSPECIALTY,N'')`,
  specialty:       'PROV_LASTPROVSPECIALTY',
  service:         'ENC_HOSPITALSERVICE',
  financial_class: 'ACCOUNT_FINANCIALCLASS',
  disposition:     'ENC_DISCHDISPO',
}

module.exports = function ipdischargesRoutes(getTenantPool, sql, requireTenant) {
  const router = express.Router()
  router.use(requireTenant)

  function isValidDate(s) {
    return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
  }

  function buildWhere(query, dbReq) {
    const { from, to, hospital, dept, loc, patclass, provider, specialty, financial_class, disposition, service } = query
    dbReq.input('from', sql.VarChar(10), from)
    dbReq.input('to',   sql.VarChar(10), to)
    let w = `CAST(TIME_HOSPDISCHARGE AS DATE) BETWEEN @from AND @to
      AND TIME_HOSPDISCHARGE IS NOT NULL
      AND BEDDED = 'Y'`
    if (hospital)        { dbReq.input('hospital',        sql.NVarChar, hospital);        w += ` AND DEP_LASTDEPTHOSPITAL = @hospital` }
    if (dept)            { dbReq.input('dept',            sql.NVarChar, dept);            w += ` AND DEP_LASTDEPT = @dept` }
    if (loc)             { dbReq.input('loc',             sql.NVarChar, loc);             w += ` AND (${LOC_EXPR}) = @loc` }
    if (patclass)        { dbReq.input('patclass',        sql.NVarChar, patclass);        w += ` AND PATCLASS = @patclass` }
    if (provider)        { dbReq.input('provider',        sql.NVarChar, provider);        w += ` AND PROV_LASTPROV = @provider` }
    if (specialty)       { dbReq.input('specialty',       sql.NVarChar, specialty);       w += ` AND PROV_LASTPROVSPECIALTY = @specialty` }
    if (financial_class) { dbReq.input('financial_class', sql.NVarChar, financial_class); w += ` AND ACCOUNT_FINANCIALCLASS = @financial_class` }
    if (disposition)     { dbReq.input('disposition',     sql.NVarChar, disposition);     w += ` AND ENC_DISCHDISPO = @disposition` }
    if (service)         { dbReq.input('service',         sql.NVarChar, service);         w += ` AND ENC_HOSPITALSERVICE = @service` }
    return w
  }

  // ── 1. /summary ────────────────────────────────────────────────────────────

  router.get('/summary', async (req, res) => {
    const { from, to } = req.query
    if (!isValidDate(from) || !isValidDate(to)) return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' })
    try {
      console.log('[ipdischarges/summary] tenantName=%s sessionTenantName=%s', req.tenantName, req.session?.tenantName)
      const db    = await getTenantPool(req.session.tenantId)
      const dbReq = db.request()
      dbReq.timeout = 30000
      const where = buildWhere(req.query, dbReq)
      const result = await dbReq.query(`
        SELECT
          COUNT(*) AS total_discharges,
          SUM(CASE WHEN DATEPART(HOUR, TIME_HOSPDISCHARGE) < 14 THEN 1.0 ELSE 0 END) * 100.0
            / NULLIF(COUNT(*), 0)                                                AS pct_disch_before_2pm,
          AVG(CAST(DATEPART(HOUR, TIME_HOSPDISCHARGE) AS FLOAT)
            + CAST(DATEPART(MINUTE, TIME_HOSPDISCHARGE) AS FLOAT) / 60.0)       AS avg_disch_hour,
          SUM(CASE WHEN DISCHORDER_ORDERINST IS NOT NULL
                        AND DATEPART(HOUR, DISCHORDER_ORDERINST) < 10 THEN 1.0 ELSE 0 END) * 100.0
            / NULLIF(SUM(CASE WHEN DISCHORDER_ORDERINST IS NOT NULL THEN 1 ELSE 0 END), 0)
                                                                                 AS pct_dc_order_before_10am,
          AVG(CASE WHEN DISCHORDER_ORDERINST IS NOT NULL
                   THEN CAST(DATEPART(HOUR, DISCHORDER_ORDERINST) AS FLOAT)
                      + CAST(DATEPART(MINUTE, DISCHORDER_ORDERINST) AS FLOAT) / 60.0 END)
                                                                                 AS avg_dc_order_hour,
          AVG(CASE WHEN DISCHORDER_ORDERINST IS NOT NULL
                        AND DATEDIFF(minute, DISCHORDER_ORDERINST, TIME_HOSPDISCHARGE) BETWEEN 0 AND 2880
                   THEN CAST(DATEDIFF(minute, DISCHORDER_ORDERINST, TIME_HOSPDISCHARGE) AS FLOAT) END)
                                                                                 AS avg_do_dc_mins,
          SUM(CASE WHEN DRG_FINALDRGWEIGHT IS NOT NULL THEN DRG_FINALDRGWEIGHT ELSE 0 END)
            / NULLIF(SUM(CASE WHEN DRG_FINALDRG IS NOT NULL THEN 1 ELSE 0 END), 0)
                                                                                 AS cmi
        FROM DS_Encounters
        WHERE ${where}
      `)
      res.json(result.recordset[0] ?? {})
    } catch (err) {
      console.error('/api/ipdischarges/summary error:', err.message)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ── 2. /by-dimension ───────────────────────────────────────────────────────

  router.get('/by-dimension', async (req, res) => {
    const { from, to, dimension, hierarchy } = req.query
    if (!isValidDate(from) || !isValidDate(to)) return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' })

    // ── Hierarchy mode: Hospital → LOC → Dept with all tab metrics ───────────
    if (hierarchy === 'true') {
      try {
        const db    = await getTenantPool(req.session.tenantId)
        const dbReq = db.request()
        dbReq.timeout = 30000
        const where = buildWhere(req.query, dbReq)
        const result = await dbReq.query(`
          SELECT
            ISNULL(DEP_LASTDEPTHOSPITAL, N'Unknown')  AS hospital,
            ISNULL((${LOC_EXPR}), N'Unknown')          AS loc,
            ISNULL(DEP_LASTDEPT, N'Unknown')            AS dept,
            -- ── Discharge Execution ───────────────────────────────────────────
            COUNT(*)                                    AS n,
            -- raw counts (for parent-level weighted aggregation on client)
            SUM(CASE WHEN DATEPART(HOUR, TIME_HOSPDISCHARGE) < 14 THEN 1 ELSE 0 END)
                                                        AS n_before_2pm,
            SUM(CASE WHEN DISCHORDER_ORDERINST IS NOT NULL THEN 1 ELSE 0 END)
                                                        AS n_dc_with_order,
            SUM(CASE WHEN DISCHORDER_ORDERINST IS NOT NULL
                          AND DATEPART(HOUR, DISCHORDER_ORDERINST) < 10 THEN 1 ELSE 0 END)
                                                        AS n_dc_before_10am,
            -- computed metrics (for leaf-level display)
            SUM(CASE WHEN DATEPART(HOUR, TIME_HOSPDISCHARGE) < 14 THEN 1.0 ELSE 0 END) * 100.0
              / NULLIF(COUNT(*), 0)                     AS pct_before_2pm,
            SUM(CASE WHEN DISCHORDER_ORDERINST IS NOT NULL
                          AND DATEPART(HOUR, DISCHORDER_ORDERINST) < 10 THEN 1.0 ELSE 0 END) * 100.0
              / NULLIF(SUM(CASE WHEN DISCHORDER_ORDERINST IS NOT NULL THEN 1 ELSE 0 END), 0)
                                                        AS pct_dc_order_before_10am,
            AVG(CASE WHEN DISCHORDER_ORDERINST IS NOT NULL
                          AND DATEDIFF(minute, DISCHORDER_ORDERINST, TIME_HOSPDISCHARGE) BETWEEN 0 AND 2880
                     THEN CAST(DATEDIFF(minute, DISCHORDER_ORDERINST, TIME_HOSPDISCHARGE) AS FLOAT) END)
                                                        AS avg_do_dc_mins,
            -- ── TDC Process ───────────────────────────────────────────────────
            SUM(CASE WHEN TDC_Status = N'TDC Workflow Complete' THEN 1 ELSE 0 END)
                                                        AS n_complete,
            SUM(CASE WHEN TDC_Status = N'TDC Workflow Complete' THEN 1.0 ELSE 0 END) * 100.0
              / NULLIF(COUNT(*), 0)                     AS pct_tdc_complete,
            AVG(CASE WHEN TDC_Status = N'TDC Workflow Complete'
                     THEN CAST(TDC_Workflow_Complete_DischOrd_to_TDCEngaged AS FLOAT) END)
                                                        AS avg_dc_order_to_engaged,
            AVG(CASE WHEN TDC_Status = N'TDC Workflow Complete'
                     THEN CAST(TDC_Workflow_Complete_Engaged_to_Complete AS FLOAT) END)
                                                        AS avg_engaged_to_complete,
            AVG(CASE WHEN TDC_Status = N'TDC Workflow Complete'
                     THEN CAST(TDC_Workflow_Complete_to_Discharge AS FLOAT) END)
                                                        AS avg_complete_to_discharge,
            AVG(CASE WHEN TDC_Status = N'TDC Workflow Complete'
                     THEN CAST(TDC_Workflow_Complete_TDCEngaged_to_AVSPrinted AS FLOAT) END)
                                                        AS avg_engaged_to_avs,
            -- ── Lost Hours ────────────────────────────────────────────────────
            SUM(CASE WHEN TIME_HOSPDISCHARGEENTRY IS NOT NULL
                          AND TIME_HOSPDISCHARGE <= TIME_HOSPDISCHARGEENTRY THEN 1 ELSE 0 END)
                                                        AS n_lh,
            SUM(CASE WHEN TIME_HOSPDISCHARGEENTRY IS NOT NULL
                          AND TIME_HOSPDISCHARGE <= TIME_HOSPDISCHARGEENTRY
                          AND DATEDIFF(minute, TIME_HOSPDISCHARGE, TIME_HOSPDISCHARGEENTRY) >= 30
                     THEN 1 ELSE 0 END)                 AS n_lh_above_target,
            SUM(CASE WHEN TIME_HOSPDISCHARGEENTRY IS NOT NULL
                          AND TIME_HOSPDISCHARGE <= TIME_HOSPDISCHARGEENTRY
                          AND DATEDIFF(minute, TIME_HOSPDISCHARGE, TIME_HOSPDISCHARGEENTRY) >= 30
                     THEN 1.0 ELSE 0 END) * 100.0
              / NULLIF(SUM(CASE WHEN TIME_HOSPDISCHARGEENTRY IS NOT NULL
                                    AND TIME_HOSPDISCHARGE <= TIME_HOSPDISCHARGEENTRY
                               THEN 1 ELSE 0 END), 0)   AS pct_above_target,
            AVG(CASE WHEN TIME_HOSPDISCHARGEENTRY IS NOT NULL
                          AND TIME_HOSPDISCHARGE <= TIME_HOSPDISCHARGEENTRY
                     THEN CAST(DATEDIFF(minute, TIME_HOSPDISCHARGE, TIME_HOSPDISCHARGEENTRY) AS FLOAT) END)
                                                        AS avg_lost_mins,
            SUM(CASE WHEN TIME_HOSPDISCHARGEENTRY IS NOT NULL
                          AND TIME_HOSPDISCHARGE <= TIME_HOSPDISCHARGEENTRY
                     THEN CAST(DATEDIFF(minute, TIME_HOSPDISCHARGE, TIME_HOSPDISCHARGEENTRY) AS FLOAT)
                     ELSE 0 END) / 60.0                 AS total_lost_hours,
            -- ── ED Throughput ─────────────────────────────────────────────────
            SUM(CASE WHEN EDENCOUNTER = N'Y' THEN 1 ELSE 0 END)
                                                        AS n_ed,
            AVG(CASE WHEN EDENCOUNTER = N'Y'
                          AND TIME_EDARRIVALTIME IS NOT NULL AND ADMORDER_ORDERINST IS NOT NULL
                          AND DATEDIFF(minute, TIME_EDARRIVALTIME, ADMORDER_ORDERINST) BETWEEN 0 AND 2880
                     THEN CAST(DATEDIFF(minute, TIME_EDARRIVALTIME, ADMORDER_ORDERINST) AS FLOAT) END)
                                                        AS avg_arrival_to_admit_order,
            AVG(CASE WHEN EDENCOUNTER = N'Y'
                          AND TIME_EDARRIVALTIME IS NOT NULL AND TIME_ED_DISPO_TIME IS NOT NULL
                          AND TIME_ED_DISPO_TIME <= TIME_ED_DEPARTURE_TIME
                          AND DATEDIFF(minute, TIME_EDARRIVALTIME, TIME_ED_DISPO_TIME) >= 0
                     THEN CAST(DATEDIFF(minute, TIME_EDARRIVALTIME, TIME_ED_DISPO_TIME) AS FLOAT) END)
                                                        AS avg_arrival_to_dispo
          FROM DS_Encounters
          WHERE ${where}
          GROUP BY DEP_LASTDEPTHOSPITAL, (${LOC_EXPR}), DEP_LASTDEPT
          ORDER BY DEP_LASTDEPTHOSPITAL, (${LOC_EXPR}), DEP_LASTDEPT
        `)
        return res.json(result.recordset)
      } catch (err) {
        console.error('/api/ipdischarges/by-dimension (hierarchy) error:', err.message)
        return res.status(500).json({ error: 'Internal server error' })
      }
    }

    // ── Flat dimension mode ───────────────────────────────────────────────────
    if (!dimension || !DIM_MAP[dimension])
      return res.status(400).json({ error: `Invalid dimension. Must be one of: ${Object.keys(DIM_MAP).join(', ')}` })
    const dimExpr = DIM_MAP[dimension]
    try {
      const db    = await getTenantPool(req.session.tenantId)
      const dbReq = db.request()
      dbReq.timeout = 30000
      const where = buildWhere(req.query, dbReq)
      const result = await dbReq.query(`
        SELECT
          ISNULL(CAST((${dimExpr}) AS NVARCHAR(500)), N'Unknown') AS label,
          COUNT(*) AS n,
          SUM(CASE WHEN DATEPART(HOUR, TIME_HOSPDISCHARGE) < 14 THEN 1.0 ELSE 0 END) * 100.0
            / NULLIF(COUNT(*), 0)                                    AS pct_before_2pm,
          SUM(CASE WHEN DISCHORDER_ORDERINST IS NOT NULL
                        AND DATEPART(HOUR, DISCHORDER_ORDERINST) < 10 THEN 1.0 ELSE 0 END) * 100.0
            / NULLIF(SUM(CASE WHEN DISCHORDER_ORDERINST IS NOT NULL THEN 1 ELSE 0 END), 0)
                                                                     AS pct_dc_order_before_10am,
          AVG(CASE WHEN DISCHORDER_ORDERINST IS NOT NULL
                        AND DATEDIFF(minute, DISCHORDER_ORDERINST, TIME_HOSPDISCHARGE) BETWEEN 0 AND 2880
                   THEN CAST(DATEDIFF(minute, DISCHORDER_ORDERINST, TIME_HOSPDISCHARGE) AS FLOAT) END)
                                                                     AS avg_do_dc_mins,
          AVG(CAST(DATEPART(HOUR, TIME_HOSPDISCHARGE) AS FLOAT)
            + CAST(DATEPART(MINUTE, TIME_HOSPDISCHARGE) AS FLOAT) / 60.0) AS avg_disch_hour
        FROM DS_Encounters
        WHERE ${where}
        GROUP BY ${dimExpr}
        HAVING COUNT(*) >= 10
        ORDER BY COUNT(*) DESC
      `)
      res.json(result.recordset)
    } catch (err) {
      console.error('/api/ipdischarges/by-dimension error:', err.message)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ── 3. /by-hour ────────────────────────────────────────────────────────────

  const HOUR_METRICS = { discharge: 'TIME_HOSPDISCHARGE', dc_order: 'DISCHORDER_ORDERINST' }

  router.get('/by-hour', async (req, res) => {
    const { from, to, metric, color_by } = req.query
    if (!isValidDate(from) || !isValidDate(to)) return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' })
    if (!HOUR_METRICS[metric])
      return res.status(400).json({ error: `Invalid metric. Must be one of: ${Object.keys(HOUR_METRICS).join(', ')}` })
    if (color_by && !DIM_MAP[color_by]) return res.status(400).json({ error: 'Invalid color_by.' })
    const timeCol   = HOUR_METRICS[metric]
    const colorExpr = color_by ? DIM_MAP[color_by] : null
    const colorSel  = colorExpr ? `, ISNULL(CAST((${colorExpr}) AS NVARCHAR(200)), N'Unknown') AS color_group` : ''
    const colorGrp  = colorExpr ? `, ${colorExpr}` : ''
    try {
      const db    = await getTenantPool(req.session.tenantId)
      const dbReq = db.request()
      dbReq.timeout = 30000
      const where = buildWhere(req.query, dbReq)
      const result = await dbReq.query(`
        SELECT DATEPART(HOUR, ${timeCol}) AS hour${colorSel}, COUNT(*) AS n
        FROM DS_Encounters
        WHERE ${where} AND ${timeCol} IS NOT NULL
        GROUP BY DATEPART(HOUR, ${timeCol})${colorGrp}
        ORDER BY hour${color_by ? ', color_group' : ''}
      `)
      res.json(result.recordset)
    } catch (err) {
      console.error('/api/ipdischarges/by-hour error:', err.message)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ── 4. /do-dc-distribution ─────────────────────────────────────────────────

  router.get('/do-dc-distribution', async (req, res) => {
    const { from, to } = req.query
    if (!isValidDate(from) || !isValidDate(to)) return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' })
    try {
      const db    = await getTenantPool(req.session.tenantId)
      const dbReq = db.request()
      dbReq.timeout = 30000
      const where = buildWhere(req.query, dbReq)
      const result = await dbReq.query(`
        WITH diffs AS (
          SELECT DATEDIFF(minute, DISCHORDER_ORDERINST, TIME_HOSPDISCHARGE) AS d
          FROM DS_Encounters
          WHERE ${where}
            AND DISCHORDER_ORDERINST IS NOT NULL AND TIME_HOSPDISCHARGE IS NOT NULL
            AND DATEDIFF(minute, DISCHORDER_ORDERINST, TIME_HOSPDISCHARGE) BETWEEN 0 AND 2880
        ),
        bins AS (
          SELECT
            CASE WHEN d > 720 THEN 721 ELSE FLOOR(d / 30) * 30 END AS bin_start,
            COUNT(*) AS n
          FROM diffs
          GROUP BY CASE WHEN d > 720 THEN 721 ELSE FLOOR(d / 30) * 30 END
        ),
        totals AS (SELECT SUM(n) AS total FROM bins)
        SELECT
          CASE WHEN b.bin_start = 721 THEN N'>720 min'
               ELSE CAST(b.bin_start AS VARCHAR) + N'–' + CAST(b.bin_start + 30 AS VARCHAR) + N' min'
          END AS bin_label,
          b.bin_start, b.n,
          SUM(b2.n) * 100.0 / NULLIF(t.total, 0) AS cumulative_pct
        FROM bins b CROSS JOIN totals t JOIN bins b2 ON b2.bin_start <= b.bin_start
        GROUP BY b.bin_start, b.n, t.total ORDER BY b.bin_start
      `)
      res.json(result.recordset)
    } catch (err) {
      console.error('/api/ipdischarges/do-dc-distribution error:', err.message)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ── 5. /tdc ────────────────────────────────────────────────────────────────

  router.get('/tdc', async (req, res) => {
    if (!getFeatures(req.tenantName || 'default').tdc)
      return res.status(404).json({ error: 'TDC data not available for this tenant' })
    const { from, to, dimension } = req.query
    if (!isValidDate(from) || !isValidDate(to)) return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' })
    if (dimension && !DIM_MAP[dimension]) return res.status(400).json({ error: 'Invalid dimension.' })
    const dimExpr = dimension ? DIM_MAP[dimension] : null
    try {
      const db = await getTenantPool(req.session.tenantId)
      const queries = [
        (() => {
          const r = db.request(); r.timeout = 30000
          const w = buildWhere(req.query, r)
          return r.query(`
            SELECT
              COUNT(*) AS total,
              SUM(CASE WHEN TDC_Status = 'TDC Workflow Complete' THEN 1 ELSE 0 END)     AS tdc_complete,
              SUM(CASE WHEN TDC_Engaged_Not_Completed = 1 THEN 1 ELSE 0 END)            AS engaged_not_complete,
              SUM(CASE WHEN TDC_Engaged_Disch_Delayed_Canceled = 1 THEN 1 ELSE 0 END)  AS delayed_canceled
            FROM DS_Encounters WHERE ${w}`)
        })(),
        (() => {
          const r = db.request(); r.timeout = 30000
          const w = buildWhere(req.query, r)
          return r.query(`
            SELECT
              COUNT(*) AS n_complete,
              AVG(CAST(TDC_Workflow_Complete_DischOrd_to_TDCEngaged AS FLOAT))   AS avg_dc_order_to_engaged,
              AVG(CAST(TDC_Workflow_Complete_Engaged_to_Complete AS FLOAT))       AS avg_engaged_to_complete,
              AVG(CAST(TDC_Workflow_Complete_to_Discharge AS FLOAT))              AS avg_complete_to_discharge,
              AVG(CAST(TDC_Workflow_Complete_TDCEngaged_to_AVSPrinted AS FLOAT)) AS avg_engaged_to_avs
            FROM DS_Encounters WHERE ${w} AND TDC_Status = 'TDC Workflow Complete'`)
        })(),
        ...(dimExpr ? [(() => {
          const r = db.request(); r.timeout = 30000
          const w = buildWhere(req.query, r)
          return r.query(`
            SELECT
              ISNULL(CAST((${dimExpr}) AS NVARCHAR(500)), N'Unknown') AS label,
              COUNT(*) AS n_complete,
              AVG(CAST(TDC_Workflow_Complete_DischOrd_to_TDCEngaged AS FLOAT))   AS avg_dc_order_to_engaged,
              AVG(CAST(TDC_Workflow_Complete_Engaged_to_Complete AS FLOAT))       AS avg_engaged_to_complete,
              AVG(CAST(TDC_Workflow_Complete_to_Discharge AS FLOAT))              AS avg_complete_to_discharge,
              AVG(CAST(TDC_Workflow_Complete_TDCEngaged_to_AVSPrinted AS FLOAT)) AS avg_engaged_to_avs
            FROM DS_Encounters WHERE ${w} AND TDC_Status = 'TDC Workflow Complete'
            GROUP BY ${dimExpr} HAVING COUNT(*) >= 5 ORDER BY COUNT(*) DESC`)
        })()] : []),
      ]
      const [sumRes, phaseRes, byDimRes] = await Promise.all(queries)
      const s = sumRes.recordset[0] ?? {}
      const not_engaged = Math.max(0, (s.total ?? 0) - (s.tdc_complete ?? 0) - (s.engaged_not_complete ?? 0) - (s.delayed_canceled ?? 0))
      res.json({
        tdc_summary: {
          total: s.total, tdc_complete: s.tdc_complete,
          engaged_not_complete: s.engaged_not_complete, delayed_canceled: s.delayed_canceled,
          not_engaged,
          pct_complete:             s.total ? s.tdc_complete / s.total * 100 : null,
          pct_engaged_not_complete: s.total ? s.engaged_not_complete / s.total * 100 : null,
          pct_delayed:              s.total ? s.delayed_canceled / s.total * 100 : null,
          pct_not_engaged:          s.total ? not_engaged / s.total * 100 : null,
        },
        tdc_phases:   phaseRes.recordset[0] ?? {},
        by_dimension: byDimRes?.recordset ?? [],
      })
    } catch (err) {
      console.error('/api/ipdischarges/tdc error:', err.message)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ── 6. /lost-hours ─────────────────────────────────────────────────────────

  router.get('/lost-hours', async (req, res) => {
    const { from, to, dimension } = req.query
    if (!isValidDate(from) || !isValidDate(to)) return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' })
    if (dimension && !DIM_MAP[dimension]) return res.status(400).json({ error: 'Invalid dimension.' })
    const dimExpr = dimension ? DIM_MAP[dimension] : null
    try {
      const db = await getTenantPool(req.session.tenantId)
      const queries = [
        (() => {
          const r = db.request(); r.timeout = 30000
          const w = buildWhere(req.query, r)
          return r.query(`
            WITH lh AS (
              SELECT DATEDIFF(minute, TIME_HOSPDISCHARGE, TIME_HOSPDISCHARGEENTRY) AS lost_mins
              FROM DS_Encounters
              WHERE ${w} AND TIME_HOSPDISCHARGEENTRY IS NOT NULL AND TIME_HOSPDISCHARGE <= TIME_HOSPDISCHARGEENTRY
            )
            SELECT
              COUNT(*)                                                              AS total_encounters_with_entry,
              SUM(CASE WHEN lost_mins >= 30 THEN 1.0 ELSE 0 END) * 100.0
                / NULLIF(COUNT(*), 0)                                              AS pct_above_target,
              SUM(CAST(lost_mins AS FLOAT)) / 60.0                                AS total_lost_hours,
              AVG(CAST(lost_mins AS FLOAT))                                        AS avg_lost_mins
            FROM lh`)
        })(),
        (() => {
          const r = db.request(); r.timeout = 30000
          const w = buildWhere(req.query, r)
          return r.query(`
            WITH lh AS (
              SELECT DATEDIFF(minute, TIME_HOSPDISCHARGE, TIME_HOSPDISCHARGEENTRY) AS lost_mins
              FROM DS_Encounters
              WHERE ${w} AND TIME_HOSPDISCHARGEENTRY IS NOT NULL AND TIME_HOSPDISCHARGE <= TIME_HOSPDISCHARGEENTRY
            ),
            bins AS (
              SELECT CASE WHEN lost_mins > 180 THEN 181 ELSE FLOOR(lost_mins / 15) * 15 END AS bin_start, COUNT(*) AS n
              FROM lh GROUP BY CASE WHEN lost_mins > 180 THEN 181 ELSE FLOOR(lost_mins / 15) * 15 END
            ),
            totals AS (SELECT SUM(n) AS total FROM bins)
            SELECT
              CASE WHEN b.bin_start = 181 THEN N'>180 min'
                   ELSE CAST(b.bin_start AS VARCHAR) + N'–' + CAST(b.bin_start + 15 AS VARCHAR) + N' min'
              END AS bin_label,
              b.bin_start, b.n, SUM(b2.n) * 100.0 / NULLIF(t.total, 0) AS cumulative_pct
            FROM bins b CROSS JOIN totals t JOIN bins b2 ON b2.bin_start <= b.bin_start
            GROUP BY b.bin_start, b.n, t.total ORDER BY b.bin_start`)
        })(),
        ...(dimExpr ? [(() => {
          const r = db.request(); r.timeout = 30000
          const w = buildWhere(req.query, r)
          return r.query(`
            SELECT
              ISNULL(CAST((${dimExpr}) AS NVARCHAR(500)), N'Unknown') AS label,
              COUNT(*) AS n,
              SUM(CASE WHEN DATEDIFF(minute, TIME_HOSPDISCHARGE, TIME_HOSPDISCHARGEENTRY) >= 30
                       THEN 1.0 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0)       AS pct_above_target,
              AVG(CAST(DATEDIFF(minute, TIME_HOSPDISCHARGE, TIME_HOSPDISCHARGEENTRY) AS FLOAT))
                                                                                  AS avg_lost_mins,
              SUM(CAST(DATEDIFF(minute, TIME_HOSPDISCHARGE, TIME_HOSPDISCHARGEENTRY) AS FLOAT)) / 60.0
                                                                                  AS total_lost_hours
            FROM DS_Encounters
            WHERE ${w} AND TIME_HOSPDISCHARGEENTRY IS NOT NULL AND TIME_HOSPDISCHARGE <= TIME_HOSPDISCHARGEENTRY
            GROUP BY ${dimExpr} HAVING COUNT(*) >= 10
            ORDER BY SUM(CAST(DATEDIFF(minute, TIME_HOSPDISCHARGE, TIME_HOSPDISCHARGEENTRY) AS FLOAT)) DESC`)
        })()] : []),
      ]
      const [sumRes, distRes, byDimRes] = await Promise.all(queries)
      res.json({ summary: sumRes.recordset[0] ?? {}, distribution: distRes.recordset, by_dimension: byDimRes?.recordset ?? [] })
    } catch (err) {
      console.error('/api/ipdischarges/lost-hours error:', err.message)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ── 7. /ed ─────────────────────────────────────────────────────────────────

  router.get('/ed', async (req, res) => {
    const { from, to } = req.query
    if (!isValidDate(from) || !isValidDate(to)) return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' })
    try {
      const db = await getTenantPool(req.session.tenantId)
      const [sumRes, hrRes, dowRes] = await Promise.all([
        (() => {
          const r = db.request(); r.timeout = 30000
          const w = buildWhere(req.query, r)
          return r.query(`
            SELECT
              COUNT(*) AS ed_admissions,
              AVG(CASE WHEN TIME_EDARRIVALTIME IS NOT NULL AND ADMORDER_ORDERINST IS NOT NULL
                            AND DATEDIFF(minute, TIME_EDARRIVALTIME, ADMORDER_ORDERINST) BETWEEN 0 AND 2880
                       THEN CAST(DATEDIFF(minute, TIME_EDARRIVALTIME, ADMORDER_ORDERINST) AS FLOAT) END)
                AS avg_arrival_to_admit_order,
              AVG(CASE WHEN TIME_EDARRIVALTIME IS NOT NULL AND TIME_ED_DISPO_TIME IS NOT NULL
                            AND TIME_ED_DISPO_TIME <= TIME_ED_DEPARTURE_TIME
                            AND DATEDIFF(minute, TIME_EDARRIVALTIME, TIME_ED_DISPO_TIME) >= 0
                       THEN CAST(DATEDIFF(minute, TIME_EDARRIVALTIME, TIME_ED_DISPO_TIME) AS FLOAT) END)
                AS avg_arrival_to_dispo
            FROM DS_Encounters WHERE ${w} AND EDENCOUNTER = 'Y'`)
        })(),
        (() => {
          const r = db.request(); r.timeout = 30000
          const w = buildWhere(req.query, r)
          return r.query(`
            SELECT DATEPART(HOUR, TIME_EDARRIVALTIME) AS hour, COUNT(*) AS n
            FROM DS_Encounters WHERE ${w} AND EDENCOUNTER = 'Y' AND TIME_EDARRIVALTIME IS NOT NULL
            GROUP BY DATEPART(HOUR, TIME_EDARRIVALTIME) ORDER BY hour`)
        })(),
        (() => {
          const r = db.request(); r.timeout = 30000
          const w = buildWhere(req.query, r)
          return r.query(`
            SELECT DATEPART(WEEKDAY, TIME_EDARRIVALTIME) AS dow_num,
                   DATENAME(WEEKDAY, TIME_EDARRIVALTIME) AS dow, COUNT(*) AS n
            FROM DS_Encounters WHERE ${w} AND EDENCOUNTER = 'Y' AND TIME_EDARRIVALTIME IS NOT NULL
            GROUP BY DATEPART(WEEKDAY, TIME_EDARRIVALTIME), DATENAME(WEEKDAY, TIME_EDARRIVALTIME)
            ORDER BY dow_num`)
        })(),
      ])
      res.json({ summary: sumRes.recordset[0] ?? {}, hourly: hrRes.recordset, by_dow: dowRes.recordset })
    } catch (err) {
      console.error('/api/ipdischarges/ed error:', err.message)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ── 8. /trend ──────────────────────────────────────────────────────────────

  router.get('/trend', async (req, res) => {
    const { from, to } = req.query
    if (!isValidDate(from) || !isValidDate(to)) return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' })
    try {
      const db    = await getTenantPool(req.session.tenantId)
      const dbReq = db.request()
      dbReq.timeout = 30000
      const where = buildWhere(req.query, dbReq)
      const result = await dbReq.query(`
        SELECT
          FORMAT(TIME_HOSPDISCHARGE, 'yyyy-MM') AS month,
          COUNT(*) AS n,
          SUM(CASE WHEN DATEPART(HOUR, TIME_HOSPDISCHARGE) < 14 THEN 1.0 ELSE 0 END) * 100.0
            / NULLIF(COUNT(*), 0) AS pct_before_2pm,
          SUM(CASE WHEN DISCHORDER_ORDERINST IS NOT NULL
                        AND DATEPART(HOUR, DISCHORDER_ORDERINST) < 10 THEN 1.0 ELSE 0 END) * 100.0
            / NULLIF(SUM(CASE WHEN DISCHORDER_ORDERINST IS NOT NULL THEN 1 ELSE 0 END), 0)
                                  AS pct_dc_order_before_10am,
          AVG(CASE WHEN DISCHORDER_ORDERINST IS NOT NULL
                        AND DATEDIFF(minute, DISCHORDER_ORDERINST, TIME_HOSPDISCHARGE) BETWEEN 0 AND 2880
                   THEN CAST(DATEDIFF(minute, DISCHORDER_ORDERINST, TIME_HOSPDISCHARGE) AS FLOAT) END)
                                  AS avg_do_dc_mins,
          AVG(CASE WHEN TIME_HOSPDISCHARGEENTRY IS NOT NULL AND TIME_HOSPDISCHARGE <= TIME_HOSPDISCHARGEENTRY
                   THEN CAST(DATEDIFF(minute, TIME_HOSPDISCHARGE, TIME_HOSPDISCHARGEENTRY) AS FLOAT) END)
                                  AS avg_lost_mins,
          SUM(CASE WHEN TIME_HOSPDISCHARGEENTRY IS NOT NULL AND TIME_HOSPDISCHARGE <= TIME_HOSPDISCHARGEENTRY
                        AND DATEDIFF(minute, TIME_HOSPDISCHARGE, TIME_HOSPDISCHARGEENTRY) >= 30 THEN 1.0 ELSE 0 END) * 100.0
            / NULLIF(SUM(CASE WHEN TIME_HOSPDISCHARGEENTRY IS NOT NULL
                              AND TIME_HOSPDISCHARGE <= TIME_HOSPDISCHARGEENTRY THEN 1 ELSE 0 END), 0)
                                  AS pct_lost_above_target,
          SUM(CASE WHEN DRG_FINALDRGWEIGHT IS NOT NULL THEN DRG_FINALDRGWEIGHT ELSE 0 END)
            / NULLIF(SUM(CASE WHEN DRG_FINALDRG IS NOT NULL THEN 1 ELSE 0 END), 0) AS cmi,
          AVG(CASE WHEN EDENCOUNTER = 'Y' AND TIME_EDARRIVALTIME IS NOT NULL AND ADMORDER_ORDERINST IS NOT NULL
                        AND DATEDIFF(minute, TIME_EDARRIVALTIME, ADMORDER_ORDERINST) BETWEEN 0 AND 2880
                   THEN CAST(DATEDIFF(minute, TIME_EDARRIVALTIME, ADMORDER_ORDERINST) AS FLOAT) END)
                                  AS avg_arrival_to_admit_order,
          SUM(CASE WHEN TDC_Status = 'TDC Workflow Complete' THEN 1.0 ELSE 0 END) * 100.0
            / NULLIF(COUNT(*), 0) AS tdc_pct_complete
        FROM DS_Encounters
        WHERE ${where}
        GROUP BY FORMAT(TIME_HOSPDISCHARGE, 'yyyy-MM')
        ORDER BY month
      `)
      res.json(result.recordset)
    } catch (err) {
      console.error('/api/ipdischarges/trend error:', err.message)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ── 9. /filter-options ─────────────────────────────────────────────────────

  router.get('/filter-options', async (req, res) => {
    const { from, to } = req.query
    if (!isValidDate(from) || !isValidDate(to)) return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' })
    try {
      const db = await getTenantPool(req.session.tenantId)
      function fq(expr) {
        const r = db.request()
        r.timeout = 30000
        r.input('from', sql.VarChar(10), from)
        r.input('to',   sql.VarChar(10), to)
        return r.query(`
          SELECT DISTINCT CAST((${expr}) AS NVARCHAR(500)) AS v
          FROM DS_Encounters
          WHERE CAST(TIME_HOSPDISCHARGE AS DATE) BETWEEN @from AND @to
            AND TIME_HOSPDISCHARGE IS NOT NULL AND BEDDED = 'Y'
            AND (${expr}) IS NOT NULL
          ORDER BY v`)
      }
      const [hospRes, locRes, pcRes, specRes, fcRes, dispoRes, svcRes] = await Promise.all([
        fq('DEP_LASTDEPTHOSPITAL'),
        fq(LOC_EXPR),
        fq('PATCLASS'),
        fq('PROV_LASTPROVSPECIALTY'),
        fq('ACCOUNT_FINANCIALCLASS'),
        fq('ENC_DISCHDISPO'),
        fq('ENC_HOSPITALSERVICE'),
      ])
      res.json({
        hospitals:        hospRes.recordset.map(r => r.v),
        locs:             locRes.recordset.map(r => r.v),
        patient_classes:  pcRes.recordset.map(r => r.v),
        specialties:      specRes.recordset.map(r => r.v),
        financial_classes:fcRes.recordset.map(r => r.v),
        dispositions:     dispoRes.recordset.map(r => r.v),
        services:         svcRes.recordset.map(r => r.v),
      })
    } catch (err) {
      console.error('/api/ipdischarges/filter-options error:', err.message)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  return router
}

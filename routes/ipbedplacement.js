const express = require('express')

const SRC_LOC = `CASE
  WHEN SOURCE_DEPTNAME LIKE '%EMERGENCY%' THEN 'Emergency'
  WHEN SOURCE_DEPTNAME IN ('OLLH OR','VORH OR','VORH JRI OR','MEMH OR','MARH OR') THEN 'Surgery'
  WHEN SOURCE_DEPTNAME LIKE '%ENDOSCOPY%' THEN 'Endoscopy'
  WHEN SOURCE_DEPTNAME = 'UNK' THEN 'UNK'
  WHEN SOURCE_DEPTLOC IS NULL THEN 'Other'
  ELSE SOURCE_DEPTLOC
END`

const DST_LOC = `CASE
  WHEN DEST_DEPTNAME LIKE '%EMERGENCY%' THEN 'Emergency'
  WHEN DEST_DEPTNAME IN ('OLLH OR','VORH OR','VORH JRI OR','MEMH OR','MARH OR') THEN 'Surgery'
  WHEN DEST_DEPTNAME LIKE '%ENDOSCOPY%' THEN 'Endoscopy'
  WHEN DEST_DEPTNAME = 'UNK' THEN 'UNK'
  WHEN DEST_DEPTLOC IS NULL THEN 'Other'
  ELSE DEST_DEPTLOC
END`

module.exports = function ipbedplacementRoutes(getTenantPool, sql, requireTenant) {
  const router = express.Router()
  router.use(requireTenant)

  function isValidDate(s) {
    return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
  }

  function buildWhere(query, dbReq) {
    const { from, to, hospital, source_loc, dest_loc, event_type, source_dept, dest_dept } = query
    dbReq.input('from', sql.VarChar(10), from)
    dbReq.input('to',   sql.VarChar(10), to)

    let w = `TIME_REQUESTTIME BETWEEN @from AND @to
      AND DUR_Requested_Complete >= 0
      AND DUR_Requested_Complete <= 1900
      AND DUR_Requested_Complete IS NOT NULL
      AND DEST_DEPTHOSPITAL = SOURCE_DEPTHOSPITAL`

    if (hospital)    { dbReq.input('hospital',    sql.NVarChar, hospital);    w += ` AND SOURCE_DEPTHOSPITAL = @hospital` }
    if (event_type)  { dbReq.input('event_type',  sql.NVarChar, event_type);  w += ` AND EVENT_TYPE_MOD = @event_type` }
    if (source_dept) { dbReq.input('source_dept', sql.NVarChar, source_dept); w += ` AND SOURCE_DEPTNAME = @source_dept` }
    if (dest_dept)   { dbReq.input('dest_dept',   sql.NVarChar, dest_dept);   w += ` AND DEST_DEPTNAME = @dest_dept` }
    if (source_loc)  { dbReq.input('source_loc',  sql.NVarChar, source_loc);  w += ` AND (${SRC_LOC}) = @source_loc` }
    if (dest_loc)    { dbReq.input('dest_loc',    sql.NVarChar, dest_loc);    w += ` AND (${DST_LOC}) = @dest_loc` }

    return w
  }

  // ── GET /api/ipbedplacement/summary ────────────────────────────────────────

  router.get('/summary', async (req, res) => {
    const { from, to } = req.query
    if (!isValidDate(from) || !isValidDate(to))
      return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' })
    try {
      const db    = await getTenantPool(req.session.tenantId)
      const dbReq = db.request()
      const where = buildWhere(req.query, dbReq)
      const result = await dbReq.query(`
        WITH filtered AS (
          SELECT
            DUR_Requested_Complete,
            CASE WHEN DUR_Requested_Assigned >= 0 AND DUR_Requested_Assigned <= 1900
                      AND DUR_Requested_Assigned IS NOT NULL
                 THEN DUR_Requested_Assigned ELSE NULL END AS DUR_Req_Assigned_Valid,
            DUR_EVSRequested_Completed
          FROM DS_Bedplacement
          WHERE ${where}
        ),
        agg AS (
          SELECT
            COUNT(*)                                                   AS total_movements,
            AVG(CAST(DUR_Requested_Complete AS FLOAT))                 AS avg_req_to_complete,
            SUM(CASE WHEN DUR_Requested_Complete <= 120 THEN 1.0 ELSE 0 END) * 100.0
              / NULLIF(COUNT(*), 0)                                    AS pct_within_target_complete,
            AVG(CAST(DUR_Req_Assigned_Valid AS FLOAT))                 AS avg_req_to_assigned,
            SUM(CASE WHEN DUR_Req_Assigned_Valid IS NOT NULL AND DUR_Req_Assigned_Valid <= 30
                     THEN 1.0 ELSE 0 END) * 100.0
              / NULLIF(SUM(CASE WHEN DUR_Req_Assigned_Valid IS NOT NULL THEN 1 ELSE 0 END), 0)
                                                                       AS pct_within_target_assigned,
            SUM(CASE WHEN DUR_EVSRequested_Completed IS NOT NULL AND DUR_EVSRequested_Completed <= 60
                     THEN 1.0 ELSE 0 END) * 100.0
              / NULLIF(SUM(CASE WHEN DUR_EVSRequested_Completed IS NOT NULL THEN 1 ELSE 0 END), 0)
                                                                       AS pct_within_target_evs
          FROM filtered
        ),
        pctls AS (
          SELECT TOP 1
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY DUR_Requested_Complete)
              OVER()                                                   AS median_req_to_complete,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY DUR_Req_Assigned_Valid)
              OVER()                                                   AS median_req_to_assigned,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY DUR_EVSRequested_Completed)
              OVER()                                                   AS median_evs
          FROM filtered
        )
        SELECT a.*, p.median_req_to_complete, p.median_req_to_assigned, p.median_evs
        FROM agg a CROSS JOIN pctls p
      `)
      res.json(result.recordset[0] ?? {})
    } catch (err) {
      console.error('/api/ipbedplacement/summary error:', err.message)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ── GET /api/ipbedplacement/by-hospital ───────────────────────────────────

  router.get('/by-hospital', async (req, res) => {
    const { from, to } = req.query
    if (!isValidDate(from) || !isValidDate(to))
      return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' })
    try {
      const db = await getTenantPool(req.session.tenantId)

      const [byHospRes, grandTotalRes] = await Promise.all([
        (() => {
          const r = db.request()
          const w = buildWhere(req.query, r)
          return r.query(`
            SELECT
              ISNULL(DEST_DEPTHOSPITAL, 'Unknown')                          AS hospital,
              ${DST_LOC}                                                     AS dest_loc,
              ISNULL(DEST_DEPTNAME, 'Unknown')                              AS dest_dept,
              COUNT(*)                                                        AS movements,
              SUM(CASE WHEN DUR_Requested_Assigned <= 30  THEN 1.0 ELSE 0 END) * 100.0
                / NULLIF(COUNT(*), 0)                                         AS pct_target_assigned,
              SUM(CASE WHEN DUR_Requested_Complete <= 120 THEN 1.0 ELSE 0 END) * 100.0
                / NULLIF(COUNT(*), 0)                                         AS pct_target_complete,
              AVG(CAST(DUR_Requested_Assigned AS FLOAT))                     AS avg_req_to_assigned,
              AVG(CAST(DUR_Assigned_Complete   AS FLOAT))                    AS avg_assigned_to_complete,
              AVG(CAST(DUR_Requested_Complete  AS FLOAT))                    AS avg_req_to_complete
            FROM DS_Bedplacement
            WHERE ${w}
            GROUP BY DEST_DEPTHOSPITAL, ${DST_LOC}, DEST_DEPTNAME
            ORDER BY DEST_DEPTHOSPITAL, ${DST_LOC}, DEST_DEPTNAME
          `)
        })(),
        (() => {
          const r = db.request()
          const w = buildWhere(req.query, r)
          return r.query(`
            SELECT
              COUNT(*)                                                        AS movements,
              SUM(CASE WHEN DUR_Requested_Assigned <= 30  THEN 1.0 ELSE 0 END) * 100.0
                / NULLIF(COUNT(*), 0)                                         AS pct_target_assigned,
              SUM(CASE WHEN DUR_Requested_Complete <= 120 THEN 1.0 ELSE 0 END) * 100.0
                / NULLIF(COUNT(*), 0)                                         AS pct_target_complete,
              AVG(CAST(DUR_Requested_Assigned AS FLOAT))                     AS avg_req_to_assigned,
              AVG(CAST(DUR_Assigned_Complete   AS FLOAT))                    AS avg_assigned_to_complete,
              AVG(CAST(DUR_Requested_Complete  AS FLOAT))                    AS avg_req_to_complete
            FROM DS_Bedplacement
            WHERE ${w}
          `)
        })(),
      ])

      res.json({
        hospitals:   byHospRes.recordset,
        grand_total: grandTotalRes.recordset[0] ?? {},
      })
    } catch (err) {
      console.error('/api/ipbedplacement/by-hospital error:', err.message)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ── GET /api/ipbedplacement/flow-matrix ────────────────────────────────────

  router.get('/flow-matrix', async (req, res) => {
    const { from, to } = req.query
    if (!isValidDate(from) || !isValidDate(to))
      return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' })
    try {
      const db    = await getTenantPool(req.session.tenantId)
      const dbReq = db.request()
      const where = buildWhere(req.query, dbReq)
      const result = await dbReq.query(`
        SELECT
          EVENT_TYPE_MOD                                               AS event_type,
          SOURCE_DEPTHOSPITAL                                          AS source_hospital,
          ${SRC_LOC}                                                   AS source_loc,
          SOURCE_DEPTNAME                                              AS source_dept,
          DEST_DEPTHOSPITAL                                            AS dest_hospital,
          ${DST_LOC}                                                   AS dest_loc,
          DEST_DEPTNAME                                                AS dest_dept,
          COUNT(*)                                                     AS movements,
          AVG(CAST(DUR_Requested_Assigned AS FLOAT))                  AS avg_req_to_assigned,
          AVG(CAST(DUR_Requested_Complete AS FLOAT))                  AS avg_req_to_complete,
          SUM(CASE WHEN DUR_Requested_Assigned <= 30  THEN 1.0 ELSE 0 END) * 100.0 / COUNT(*) AS pct_target_assigned,
          SUM(CASE WHEN DUR_Requested_Complete <= 120 THEN 1.0 ELSE 0 END) * 100.0 / COUNT(*) AS pct_target_complete
        FROM DS_Bedplacement
        WHERE ${where}
        GROUP BY
          EVENT_TYPE_MOD, SOURCE_DEPTHOSPITAL,
          ${SRC_LOC},
          SOURCE_DEPTNAME,
          DEST_DEPTHOSPITAL,
          ${DST_LOC},
          DEST_DEPTNAME
        HAVING COUNT(*) >= 3
        ORDER BY COUNT(*) DESC
      `)
      res.json(result.recordset)
    } catch (err) {
      console.error('/api/ipbedplacement/flow-matrix error:', err.message)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ── GET /api/ipbedplacement/trend ──────────────────────────────────────────

  const TREND_GROUP_BY = {
    source_loc:  `(${SRC_LOC})`,
    dest_loc:    `(${DST_LOC})`,
    source_dept: 'SOURCE_DEPTNAME',
    dest_dept:   'DEST_DEPTNAME',
  }

  router.get('/trend', async (req, res) => {
    const { from, to, group_by } = req.query
    if (!isValidDate(from) || !isValidDate(to))
      return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' })
    if (group_by && !TREND_GROUP_BY[group_by])
      return res.status(400).json({ error: `Invalid group_by. Must be one of: ${Object.keys(TREND_GROUP_BY).join(', ')}` })

    const groupExpr = group_by ? TREND_GROUP_BY[group_by] : null
    const groupSel  = groupExpr ? `, ${groupExpr} AS group_col` : ''
    const partBy    = groupExpr ? ', group_col' : ''
    const orderBy   = groupExpr ? 'month, group_col' : 'month'

    try {
      const db    = await getTenantPool(req.session.tenantId)
      const dbReq = db.request()
      dbReq.timeout = 30000
      const where = buildWhere(req.query, dbReq)
      const result = await dbReq.query(`
        WITH base AS (
          SELECT
            FORMAT(TIME_REQUESTTIME, 'yyyy-MM') AS month
            ${groupSel},
            DUR_Requested_Complete,
            CASE WHEN DUR_Requested_Assigned >= 0 AND DUR_Requested_Assigned <= 1900
                      AND DUR_Requested_Assigned IS NOT NULL
                 THEN DUR_Requested_Assigned ELSE NULL END AS DUR_Req_Assigned_Valid
          FROM DS_Bedplacement
          WHERE ${where}
        )
        SELECT DISTINCT
          month
          ${groupExpr ? ', group_col' : ''},
          COUNT(*) OVER (PARTITION BY month${partBy})                              AS n,
          AVG(CAST(DUR_Requested_Complete AS FLOAT)) OVER (PARTITION BY month${partBy})
                                                                                   AS avg_req_to_complete,
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY DUR_Requested_Complete)
            OVER (PARTITION BY month${partBy})                                     AS median_req_to_complete,
          SUM(CASE WHEN DUR_Requested_Complete <= 120 THEN 1.0 ELSE 0 END)
            OVER (PARTITION BY month${partBy}) * 100.0
            / NULLIF(COUNT(*) OVER (PARTITION BY month${partBy}), 0)              AS pct_within_target_complete,
          AVG(CAST(DUR_Req_Assigned_Valid AS FLOAT)) OVER (PARTITION BY month${partBy})
                                                                                   AS avg_req_to_assigned,
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY DUR_Req_Assigned_Valid)
            OVER (PARTITION BY month${partBy})                                     AS median_req_to_assigned,
          SUM(CASE WHEN DUR_Req_Assigned_Valid IS NOT NULL AND DUR_Req_Assigned_Valid <= 30
                   THEN 1.0 ELSE 0 END) OVER (PARTITION BY month${partBy}) * 100.0
            / NULLIF(SUM(CASE WHEN DUR_Req_Assigned_Valid IS NOT NULL THEN 1 ELSE 0 END)
                     OVER (PARTITION BY month${partBy}), 0)                        AS pct_within_target_assigned
        FROM base
        ORDER BY ${orderBy}
      `)
      res.json(result.recordset)
    } catch (err) {
      console.error('/api/ipbedplacement/trend error:', err.message)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ── GET /api/ipbedplacement/by-hour ────────────────────────────────────────

  const HOUR_TIME_FIELDS = {
    request:     'TIME_REQUESTTIME',
    complete:    'TIME_COMPLETE',
    evs_request: 'TIME_EVSREQUESTED',
  }
  const HOUR_COLOR_BY = {
    source_loc: `(${SRC_LOC})`,
    dest_loc:   `(${DST_LOC})`,
  }

  router.get('/by-hour', async (req, res) => {
    const { from, to, time_field, color_by } = req.query
    if (!isValidDate(from) || !isValidDate(to))
      return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' })
    if (!HOUR_TIME_FIELDS[time_field])
      return res.status(400).json({ error: `Invalid time_field. Must be one of: ${Object.keys(HOUR_TIME_FIELDS).join(', ')}` })
    if (color_by && !HOUR_COLOR_BY[color_by])
      return res.status(400).json({ error: `Invalid color_by. Must be one of: ${Object.keys(HOUR_COLOR_BY).join(', ')}` })

    const timeCol  = HOUR_TIME_FIELDS[time_field]
    const colorSel = color_by ? `, ${HOUR_COLOR_BY[color_by]} AS color_group` : ''
    const colorGrp = color_by ? `, ${HOUR_COLOR_BY[color_by]}` : ''

    try {
      const db    = await getTenantPool(req.session.tenantId)
      const dbReq = db.request()
      const where = buildWhere(req.query, dbReq)
      const result = await dbReq.query(`
        SELECT
          DATEPART(HOUR, ${timeCol}) AS hour
          ${colorSel},
          COUNT(*) AS n
        FROM DS_Bedplacement
        WHERE ${where}
          AND ${timeCol} IS NOT NULL
        GROUP BY DATEPART(HOUR, ${timeCol})${colorGrp}
        ORDER BY hour${color_by ? ', color_group' : ''}
      `)
      res.json(result.recordset)
    } catch (err) {
      console.error('/api/ipbedplacement/by-hour error:', err.message)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ── GET /api/ipbedplacement/distribution ───────────────────────────────────

  const DIST_METRICS = {
    req_to_complete: { col: 'DUR_Requested_Complete',    bin: 30, extra: '' },
    req_to_assigned: { col: 'DUR_Requested_Assigned',     bin: 15, extra: ' AND DUR_Requested_Assigned >= 0 AND DUR_Requested_Assigned <= 1900 AND DUR_Requested_Assigned IS NOT NULL' },
    evs:             { col: 'DUR_EVSRequested_Completed', bin: 15, extra: ' AND DUR_EVSRequested_Completed IS NOT NULL' },
  }

  router.get('/distribution', async (req, res) => {
    const { from, to, metric } = req.query
    if (!isValidDate(from) || !isValidDate(to))
      return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' })
    if (!DIST_METRICS[metric])
      return res.status(400).json({ error: `Invalid metric. Must be one of: ${Object.keys(DIST_METRICS).join(', ')}` })

    const { col, bin, extra } = DIST_METRICS[metric]
    try {
      const db    = await getTenantPool(req.session.tenantId)
      const dbReq = db.request()
      const where = buildWhere(req.query, dbReq)
      const result = await dbReq.query(`
        WITH bins AS (
          SELECT
            CASE WHEN ${col} > 300 THEN 301
                 ELSE FLOOR(${col} / ${bin}) * ${bin}
            END AS bin_start,
            COUNT(*) AS n
          FROM DS_Bedplacement
          WHERE ${where}${extra}
          GROUP BY
            CASE WHEN ${col} > 300 THEN 301
                 ELSE FLOOR(${col} / ${bin}) * ${bin}
            END
        ),
        totals AS (SELECT SUM(n) AS total FROM bins)
        SELECT
          CASE WHEN b.bin_start = 301 THEN '>300 min'
               ELSE CAST(b.bin_start AS VARCHAR) + N'–' + CAST(b.bin_start + ${bin} AS VARCHAR) + ' min'
          END AS bin_label,
          b.bin_start,
          b.n,
          SUM(b2.n) * 100.0 / NULLIF(t.total, 0) AS cumulative_pct
        FROM bins b
        CROSS JOIN totals t
        JOIN bins b2 ON b2.bin_start <= b.bin_start
        GROUP BY b.bin_start, b.n, t.total
        ORDER BY b.bin_start
      `)
      res.json(result.recordset)
    } catch (err) {
      console.error('/api/ipbedplacement/distribution error:', err.message)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ── GET /api/ipbedplacement/evs ────────────────────────────────────────────

  router.get('/evs', async (req, res) => {
    const { from, to } = req.query
    if (!isValidDate(from) || !isValidDate(to))
      return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' })
    try {
      const db = await getTenantPool(req.session.tenantId)

      const [byDestRes, systemRes, hourlyRes] = await Promise.all([
        // Grouped by Dest Hospital → Dest LOC → Dest Dept
        (() => {
          const r = db.request()
          const w = buildWhere(req.query, r)
          return r.query(`
            SELECT
              ISNULL(DEST_DEPTHOSPITAL, 'Unknown')                          AS dest_hospital,
              ${DST_LOC}                                                     AS dest_loc,
              ISNULL(DEST_DEPTNAME, 'Unknown')                              AS dest_dept,
              COUNT(*)                                                        AS evs_requests,
              SUM(CASE WHEN DUR_EVSRequested_Completed <= 60 THEN 1 ELSE 0 END)
                                                                             AS evs_within_target,
              SUM(CASE WHEN DUR_EVSRequested_Completed <= 60 THEN 1.0 ELSE 0 END) * 100.0
                / NULLIF(COUNT(*), 0)                                         AS pct_within_target,
              AVG(CAST(DUR_EVSRequested_Completed  AS FLOAT))                AS avg_evs_req_to_complete,
              AVG(CAST(DUR_EVSRequested_Assigned   AS FLOAT))                AS avg_evs_req_to_assigned,
              AVG(CAST(DUR_EVSAssigned_InProgress  AS FLOAT))                AS avg_evs_assigned_to_inprogress,
              AVG(CAST(DUR_EVSInProgress_Completed AS FLOAT))                AS avg_evs_inprogress_to_completed
            FROM DS_Bedplacement
            WHERE ${w} AND DUR_EVSRequested_Completed IS NOT NULL
            GROUP BY DEST_DEPTHOSPITAL, ${DST_LOC}, DEST_DEPTNAME
            ORDER BY DEST_DEPTHOSPITAL, ${DST_LOC}, DEST_DEPTNAME
          `)
        })(),
        // System-level KPIs
        (() => {
          const r = db.request()
          const w = buildWhere(req.query, r)
          return r.query(`
            WITH evs_data AS (
              SELECT DUR_EVSRequested_Completed
              FROM DS_Bedplacement
              WHERE ${w} AND DUR_EVSRequested_Completed IS NOT NULL
            ),
            agg AS (
              SELECT
                COUNT(*)                                                     AS total_evs_requests,
                SUM(CASE WHEN DUR_EVSRequested_Completed <= 60 THEN 1.0 ELSE 0 END) * 100.0
                  / NULLIF(COUNT(*), 0)                                      AS pct_within_target_evs
              FROM evs_data
            ),
            pctls AS (
              SELECT TOP 1
                PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY DUR_EVSRequested_Completed)
                  OVER()                                                      AS median_evs
              FROM evs_data
            )
            SELECT a.*, p.median_evs FROM agg a CROSS JOIN pctls p
          `)
        })(),
        // Hourly % within target (line chart)
        (() => {
          const r = db.request()
          const w = buildWhere(req.query, r)
          return r.query(`
            SELECT
              DATEPART(HOUR, TIME_EVSREQUESTED)                             AS hour,
              COUNT(*)                                                        AS n,
              SUM(CASE WHEN DUR_EVSRequested_Completed <= 60 THEN 1.0 ELSE 0 END) * 100.0
                / NULLIF(COUNT(*), 0)                                         AS pct_within_target
            FROM DS_Bedplacement
            WHERE ${w}
              AND DUR_EVSRequested_Completed IS NOT NULL
              AND TIME_EVSREQUESTED IS NOT NULL
            GROUP BY DATEPART(HOUR, TIME_EVSREQUESTED)
            ORDER BY hour
          `)
        })(),
      ])

      res.json({
        by_dest: byDestRes.recordset,
        system:  systemRes.recordset[0] ?? {},
        hourly:  hourlyRes.recordset,
      })
    } catch (err) {
      console.error('/api/ipbedplacement/evs error:', err.message)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ── GET /api/ipbedplacement/filter-options ─────────────────────────────────

  router.get('/filter-options', async (req, res) => {
    const { from, to } = req.query
    if (!isValidDate(from) || !isValidDate(to))
      return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' })
    try {
      const db = await getTenantPool(req.session.tenantId)

      const [hospitalsRes, srcLocsRes, dstLocsRes, eventTypesRes] = await Promise.all([
        (() => {
          const r = db.request()
          r.input('from', sql.VarChar(10), from)
          r.input('to',   sql.VarChar(10), to)
          return r.query(`SELECT DISTINCT SOURCE_DEPTHOSPITAL AS v FROM DS_Bedplacement WHERE TIME_REQUESTTIME BETWEEN @from AND @to AND SOURCE_DEPTHOSPITAL IS NOT NULL ORDER BY v`)
        })(),
        (() => {
          const r = db.request()
          r.input('from', sql.VarChar(10), from)
          r.input('to',   sql.VarChar(10), to)
          return r.query(`SELECT DISTINCT ${SRC_LOC} AS v FROM DS_Bedplacement WHERE TIME_REQUESTTIME BETWEEN @from AND @to ORDER BY v`)
        })(),
        (() => {
          const r = db.request()
          r.input('from', sql.VarChar(10), from)
          r.input('to',   sql.VarChar(10), to)
          return r.query(`SELECT DISTINCT ${DST_LOC} AS v FROM DS_Bedplacement WHERE TIME_REQUESTTIME BETWEEN @from AND @to ORDER BY v`)
        })(),
        (() => {
          const r = db.request()
          r.input('from', sql.VarChar(10), from)
          r.input('to',   sql.VarChar(10), to)
          return r.query(`SELECT DISTINCT EVENT_TYPE_MOD AS v FROM DS_Bedplacement WHERE TIME_REQUESTTIME BETWEEN @from AND @to AND EVENT_TYPE_MOD IS NOT NULL ORDER BY v`)
        })(),
      ])

      res.json({
        hospitals:   hospitalsRes.recordset.map(r => r.v),
        source_locs: srcLocsRes.recordset.map(r => r.v),
        dest_locs:   dstLocsRes.recordset.map(r => r.v),
        event_types: eventTypesRes.recordset.map(r => r.v),
      })
    } catch (err) {
      console.error('/api/ipbedplacement/filter-options error:', err.message)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  return router
}

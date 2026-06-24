const express = require('express')

module.exports = function iplosRoutes(getTenantPool, sql, requireTenant) {
  const router = express.Router()
  router.use(requireTenant)

  const DIM_MAP = {
    service_line:          'SERVICE_LINE',
    service_line_2:        'SERVICE_LINE_2',
    unit:                  'DEST_CATEGORY',
    disposition:           'ENC_DISCHDISPO',
    payer:                 'ACCOUNT_FINANCIALCLASS',
    admission_hour:        `CASE WHEN DATEPART(HOUR, TIME_HOSPADMISSION) BETWEEN 0 AND 5 THEN 'Overnight (12a-6a)' WHEN DATEPART(HOUR, TIME_HOSPADMISSION) BETWEEN 6 AND 11 THEN 'Morning (6a-12p)' WHEN DATEPART(HOUR, TIME_HOSPADMISSION) BETWEEN 12 AND 16 THEN 'Afternoon (12p-5p)' ELSE 'Evening (5p-12a)' END`,
    admitting_physician:   'PROV_ADMPROV',
    discharging_physician: 'PROV_LASTPROV',
    admitting_specialty:   'PROV_ADMPROVSPECIALTY',
    discharging_specialty: 'PROV_LASTPROVSPECIALTY',
  }

  const PHYSICIAN_DIMS = new Set([
    'admitting_physician', 'discharging_physician',
    'admitting_specialty', 'discharging_specialty',
  ])

  function isValidDate(s) {
    return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
  }

  function buildBaseCTE(dbReq, from, to) {
    dbReq.input('from', sql.Date, from)
    dbReq.input('to',   sql.Date, to)
    return `
WITH base AS (
  SELECT
    SERVICE_LINE,
    SERVICE_LINE_2,
    ENC_DISCHDISPO,
    ACCOUNT_FINANCIALCLASS,
    PROV_ADMPROV,
    PROV_LASTPROV,
    PROV_ADMPROVSPECIALTY,
    PROV_LASTPROVSPECIALTY,
    CASE
      WHEN DEP_LASTDEPT LIKE '%2E%' OR DEP_LASTDEPT LIKE '%2W%' THEN '2nd Floor'
      WHEN DEP_LASTDEPT LIKE '%3E%' OR DEP_LASTDEPT LIKE '%3W%' THEN '3rd Floor'
      WHEN DEP_LASTDEPT LIKE '%5W%' OR DEP_LASTDEPT LIKE '%6N%' THEN '6N/5W'
      WHEN DEP_LASTDEPT LIKE '%ICU%' OR DEP_LASTDEPT LIKE '%CORONARY CARE%' THEN 'ICU'
      WHEN DEP_LASTDEPT LIKE '%PCU%' THEN 'PCU'
      WHEN (DEP_LASTDEPT LIKE '%MOTHER BABY%' OR DEP_LASTDEPT LIKE '%LABOR%'
        OR DEP_LASTDEPT LIKE '%SPECIAL CARE NURS%'
        OR DEP_LASTDEPT LIKE '%NEWBORN%') THEN 'Maternal Child Health'
      WHEN DEP_LASTDEPT LIKE '%HOSPITAL AT HOME%' THEN 'Hospital at Home'
      WHEN DEP_LASTDEPT LIKE '%IP REHAB%' THEN 'Rehab'
      ELSE 'Other'
    END AS DEST_CATEGORY,
    TIME_HOSPADMISSION,
    CAST(ACCOUNT_IPLOS     AS FLOAT) AS LOS,
    CAST(DRG_FINALDRGGMLOS AS FLOAT) AS GMLOS,
    CAST(ACCOUNT_IPLOS     AS FLOAT) - CAST(DRG_FINALDRGGMLOS AS FLOAT) AS EXCESS,
    CASE WHEN CAST(ACCOUNT_IPLOS AS FLOAT) - CAST(DRG_FINALDRGGMLOS AS FLOAT) > 0
         THEN CAST(ACCOUNT_IPLOS AS FLOAT) - CAST(DRG_FINALDRGGMLOS AS FLOAT)
         ELSE 0
    END AS POS_EXCESS
  FROM DS_Encounters
  WHERE DEP_LASTDEPTHOSPITAL = 'Our Lady of Lourdes Hospital'
    AND BEDDED = 'Y'
    AND ACCOUNT_IPLOS IS NOT NULL
    AND DRG_FINALDRGGMLOS IS NOT NULL
    AND TIME_HOSPDISCHARGE BETWEEN @from AND @to
    AND ISNULL(SERVICE_LINE, 'NULL') NOT IN (
      'W&C Obstetrics','W&C Neonates','W&C Newborns','W&C Gynecology',
      'No DRG Match','NULL','Pediatrics','Behavioral Health'
    )
    AND ENC_DISCHDISPO NOT LIKE '%Expired%'
    AND ENC_DISCHDISPO NOT LIKE '%Left AMA%'
    AND ENC_DISCHDISPO NOT LIKE '%Court%'
    AND ENC_DISCHDISPO NOT LIKE '%Elopement%'
    AND ENC_DISCHDISPO NOT LIKE '%Transfer to Short Term Hospital%'
)`
  }

  const AGG_COLS = `
    COUNT(*) AS n_cases,
    SUM(POS_EXCESS) AS total_excess_days,
    AVG(EXCESS) AS avg_excess,
    AVG(LOS) AS avg_los,
    AVG(GMLOS) AS avg_gmlos,
    CASE WHEN AVG(GMLOS) = 0 THEN NULL ELSE AVG(LOS) / AVG(GMLOS) END AS oe_ratio`

  // ── GET /api/iplos/summary ────────────────────────────────────────────────

  router.get('/summary', async (req, res) => {
    const { from, to } = req.query
    if (!isValidDate(from) || !isValidDate(to))
      return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' })
    try {
      const db    = await getTenantPool(req.session.tenantId)
      const dbReq = db.request()
      const cte   = buildBaseCTE(dbReq, from, to)
      const result = await dbReq.query(`
        ${cte}
        SELECT
          COUNT(*) AS total_discharges,
          SUM(POS_EXCESS) AS total_excess_days,
          AVG(EXCESS) AS avg_excess,
          100.0 * SUM(CASE WHEN EXCESS > 0 THEN 1 ELSE 0 END)
            / NULLIF(COUNT(*), 0)                          AS pct_with_excess,
          AVG(LOS) AS avg_los,
          AVG(GMLOS) AS avg_gmlos,
          CASE WHEN AVG(GMLOS) = 0 THEN NULL
               ELSE AVG(LOS) / AVG(GMLOS) END              AS oe_ratio
        FROM base
      `)
      res.json(result.recordset[0])
    } catch (err) {
      console.error('/api/iplos/summary error:', err.message)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ── GET /api/iplos/breakdown ──────────────────────────────────────────────

  router.get('/breakdown', async (req, res) => {
    const { dim, from, to, parent } = req.query
    if (!DIM_MAP[dim])
      return res.status(400).json({ error: `Invalid dim. Must be one of: ${Object.keys(DIM_MAP).join(', ')}` })
    if (!isValidDate(from) || !isValidDate(to))
      return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' })

    const col      = DIM_MAP[dim]
    const minCount = PHYSICIAN_DIMS.has(dim) ? 20 : 10

    try {
      const db    = await getTenantPool(req.session.tenantId)
      const dbReq = db.request()
      const cte   = buildBaseCTE(dbReq, from, to)

      let parentFilter = ''
      if (dim === 'service_line_2' && parent) {
        dbReq.input('parentVal', sql.NVarChar, parent)
        parentFilter = 'AND SERVICE_LINE = @parentVal'
      }

      const result = await dbReq.query(`
        ${cte}
        SELECT
          ISNULL(${col}, 'Unknown') AS group_name,
          ${AGG_COLS}
        FROM base
        WHERE 1=1 ${parentFilter}
        GROUP BY ${col}
        HAVING COUNT(*) >= ${minCount}
        ORDER BY SUM(POS_EXCESS) DESC
      `)
      res.json(result.recordset)
    } catch (err) {
      console.error('/api/iplos/breakdown error:', err.message)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ── GET /api/iplos/filter-options ────────────────────────────────────────

  router.get('/filter-options', async (req, res) => {
    const { from, to } = req.query
    if (!isValidDate(from) || !isValidDate(to))
      return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' })

    const OPTION_DIMS = [
      'service_line', 'service_line_2', 'unit', 'disposition',
      'payer', 'admitting_physician', 'discharging_physician',
    ]

    try {
      const db      = await getTenantPool(req.session.tenantId)
      const results = await Promise.all(OPTION_DIMS.map(async dim => {
        const dbReq    = db.request()
        const cte      = buildBaseCTE(dbReq, from, to)
        const col      = DIM_MAP[dim]
        const minCount = PHYSICIAN_DIMS.has(dim) ? 20 : 10
        const result   = await dbReq.query(`
          ${cte}
          SELECT ISNULL(${col}, 'Unknown') AS v
          FROM base
          GROUP BY ${col}
          HAVING COUNT(*) >= ${minCount}
          ORDER BY ISNULL(${col}, 'Unknown')
        `)
        return [dim, result.recordset.map(r => r.v)]
      }))
      res.json(Object.fromEntries(results))
    } catch (err) {
      console.error('/api/iplos/filter-options error:', err.message)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ── GET /api/iplos/trend ──────────────────────────────────────────────────

  router.get('/trend', async (req, res) => {
    const {
      from, to,
      filter_service_line, filter_service_line_2, filter_unit,
      filter_disposition, filter_payer,
      filter_admitting_physician, filter_discharging_physician,
    } = req.query

    if (!isValidDate(from) || !isValidDate(to))
      return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' })

    try {
      const db = await getTenantPool(req.session.tenantId)

      function buildTrendRequest(fromDate, toDate) {
        const r = db.request()
        r.input('from', sql.Date, fromDate)
        r.input('to',   sql.Date, toDate)
        let fc = ''
        if (filter_service_line)          { r.input('fsl',        sql.NVarChar, filter_service_line);          fc += ' AND SERVICE_LINE = @fsl' }
        if (filter_service_line_2)        { r.input('fsl2',       sql.NVarChar, filter_service_line_2);        fc += ' AND SERVICE_LINE_2 = @fsl2' }
        if (filter_disposition)           { r.input('fdispo',     sql.NVarChar, filter_disposition);           fc += ' AND ENC_DISCHDISPO = @fdispo' }
        if (filter_payer)                 { r.input('fpayer',     sql.NVarChar, filter_payer);                 fc += ' AND ACCOUNT_FINANCIALCLASS = @fpayer' }
        if (filter_admitting_physician)   { r.input('fadmprov',   sql.NVarChar, filter_admitting_physician);   fc += ' AND PROV_ADMPROV = @fadmprov' }
        if (filter_discharging_physician) { r.input('fdischprov', sql.NVarChar, filter_discharging_physician); fc += ' AND PROV_LASTPROV = @fdischprov' }
        if (filter_unit)                  { r.input('funit',      sql.NVarChar, filter_unit) }
        const cte = `
WITH base AS (
  SELECT
    FORMAT(TIME_HOSPDISCHARGE, 'yyyy-MM') AS month,
    CASE
      WHEN DEP_LASTDEPT LIKE '%2E%' OR DEP_LASTDEPT LIKE '%2W%' THEN '2nd Floor'
      WHEN DEP_LASTDEPT LIKE '%3E%' OR DEP_LASTDEPT LIKE '%3W%' THEN '3rd Floor'
      WHEN DEP_LASTDEPT LIKE '%5W%' OR DEP_LASTDEPT LIKE '%6N%' THEN '6N/5W'
      WHEN DEP_LASTDEPT LIKE '%ICU%' OR DEP_LASTDEPT LIKE '%CORONARY CARE%' THEN 'ICU'
      WHEN DEP_LASTDEPT LIKE '%PCU%' THEN 'PCU'
      WHEN (DEP_LASTDEPT LIKE '%MOTHER BABY%' OR DEP_LASTDEPT LIKE '%LABOR%'
        OR DEP_LASTDEPT LIKE '%SPECIAL CARE NURS%'
        OR DEP_LASTDEPT LIKE '%NEWBORN%') THEN 'Maternal Child Health'
      WHEN DEP_LASTDEPT LIKE '%HOSPITAL AT HOME%' THEN 'Hospital at Home'
      WHEN DEP_LASTDEPT LIKE '%IP REHAB%' THEN 'Rehab'
      ELSE 'Other'
    END AS DEST_CATEGORY,
    CAST(ACCOUNT_IPLOS     AS FLOAT) AS LOS,
    CAST(DRG_FINALDRGGMLOS AS FLOAT) AS GMLOS,
    CAST(ACCOUNT_IPLOS AS FLOAT) - CAST(DRG_FINALDRGGMLOS AS FLOAT) AS EXCESS,
    CASE WHEN CAST(ACCOUNT_IPLOS AS FLOAT) - CAST(DRG_FINALDRGGMLOS AS FLOAT) > 0
         THEN CAST(ACCOUNT_IPLOS AS FLOAT) - CAST(DRG_FINALDRGGMLOS AS FLOAT)
         ELSE 0
    END AS POS_EXCESS
  FROM DS_Encounters
  WHERE DEP_LASTDEPTHOSPITAL = 'Our Lady of Lourdes Hospital'
    AND BEDDED = 'Y'
    AND ACCOUNT_IPLOS IS NOT NULL
    AND DRG_FINALDRGGMLOS IS NOT NULL
    AND TIME_HOSPDISCHARGE BETWEEN @from AND @to
    AND ISNULL(SERVICE_LINE, 'NULL') NOT IN (
      'W&C Obstetrics','W&C Neonates','W&C Newborns','W&C Gynecology',
      'No DRG Match','NULL','Pediatrics','Behavioral Health'
    )
    AND ENC_DISCHDISPO NOT LIKE '%Expired%'
    AND ENC_DISCHDISPO NOT LIKE '%Left AMA%'
    AND ENC_DISCHDISPO NOT LIKE '%Court%'
    AND ENC_DISCHDISPO NOT LIKE '%Elopement%'
    AND ENC_DISCHDISPO NOT LIKE '%Transfer to Short Term Hospital%'
    ${fc}
)`
        return { r, cte }
      }

      const unitWhere  = filter_unit ? ' AND DEST_CATEGORY = @funit' : ''
      const outerWhere = `WHERE DEST_CATEGORY <> 'Rehab'${unitWhere}`

      const shiftYear = (s, d) => {
        const dt = new Date(s)
        dt.setFullYear(dt.getFullYear() + d)
        return dt.toISOString().slice(0, 10)
      }

      // Each WITH base AS (...) CTE covers only the single SELECT that follows it.
      // Run three separate requests in parallel — one statement each.
      const { r: rKpis,    cte: cteKpis    } = buildTrendRequest(from, to)
      const { r: rMonthly, cte: cteMonthly } = buildTrendRequest(from, to)
      const { r: rPrior,   cte: ctePrior   } = buildTrendRequest(shiftYear(from, -1), shiftYear(to, -1))

      const MONTHLY_SELECT = `
        SELECT
          month,
          COUNT(*) AS n_cases,
          AVG(LOS) AS avg_los,
          AVG(GMLOS) AS avg_gmlos,
          AVG(EXCESS) AS avg_excess,
          SUM(POS_EXCESS) AS total_excess_days,
          CASE WHEN AVG(GMLOS) = 0 THEN NULL ELSE AVG(LOS)/AVG(GMLOS) END AS oe_ratio
        FROM base
        ${outerWhere}
        GROUP BY month
        ORDER BY month`

      const [kpisResult, monthlyResult, priorResult] = await Promise.all([
        rKpis.query(`
          ${cteKpis}
          SELECT
            COUNT(*) AS n_cases,
            SUM(POS_EXCESS) AS total_excess_days,
            AVG(EXCESS) AS avg_excess,
            AVG(LOS) AS avg_los,
            AVG(GMLOS) AS avg_gmlos,
            CASE WHEN AVG(GMLOS) = 0 THEN NULL ELSE AVG(LOS)/AVG(GMLOS) END AS oe_ratio,
            100.0 * SUM(CASE WHEN EXCESS > 0 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0) AS pct_with_excess
          FROM base
          ${outerWhere}
        `),
        rMonthly.query(`${cteMonthly}${MONTHLY_SELECT}`),
        rPrior.query(`${ctePrior}${MONTHLY_SELECT}`),
      ])

      res.json({
        kpis:               kpisResult.recordset[0],
        monthly:            monthlyResult.recordset,
        prior_year_monthly: priorResult.recordset,
      })
    } catch (err) {
      console.error('/api/iplos/trend error:', err.message)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ── GET /api/iplos/explorer ───────────────────────────────────────────────

  router.get('/explorer', async (req, res) => {
    const { dim, from, to, filter_service_line, filter_service_line_2, filter_unit, filter_disposition, filter_payer } = req.query
    if (!DIM_MAP[dim])
      return res.status(400).json({ error: `Invalid dim. Must be one of: ${Object.keys(DIM_MAP).join(', ')}` })
    if (!isValidDate(from) || !isValidDate(to))
      return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' })

    const col = DIM_MAP[dim]
    try {
      const db    = await getTenantPool(req.session.tenantId)
      const dbReq = db.request()
      const cte   = buildBaseCTE(dbReq, from, to)

      let filters = ''
      if (filter_service_line) {
        dbReq.input('fsl', sql.NVarChar, filter_service_line)
        filters += ' AND SERVICE_LINE = @fsl'
      }
      if (filter_unit) {
        dbReq.input('fu', sql.NVarChar, filter_unit)
        filters += ' AND DEST_CATEGORY = @fu'
      }
      if (filter_disposition) {
        dbReq.input('fdispo', sql.NVarChar, filter_disposition)
        filters += ' AND ENC_DISCHDISPO = @fdispo'
      }
      if (filter_payer) {
        dbReq.input('fpayer', sql.NVarChar, filter_payer)
        filters += ' AND ACCOUNT_FINANCIALCLASS = @fpayer'
      }
      if (filter_service_line_2) {
        dbReq.input('fsl2', sql.NVarChar, filter_service_line_2)
        filters += ' AND SERVICE_LINE_2 = @fsl2'
      }

      const result = await dbReq.query(`
        ${cte}
        SELECT
          ISNULL(${col}, 'Unknown') AS group_name,
          ${AGG_COLS}
        FROM base
        WHERE 1=1 ${filters}
        GROUP BY ${col}
        ORDER BY SUM(POS_EXCESS) DESC
      `)
      res.json(result.recordset)
    } catch (err) {
      console.error('/api/iplos/explorer error:', err.message)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  return router
}

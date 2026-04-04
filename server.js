require('dotenv').config();
//console.log('DB_USER:', process.env.DB_USER);
// console.log('DB_PASSWORD length:', process.env.DB_PASSWORD?.length, '| value:', process.env.DB_PASSWORD);
const express = require('express');
const sql = require('mssql');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// SQL Server connection config — SQL authentication (sa)
const dbConfig = {
  server: process.env.DB_SERVER,
  database: process.env.DB_DATABASE,
  port: parseInt(process.env.DB_PORT) || 1433,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: {
    encrypt: true,
    trustServerCertificate: true,
    enableArithAbort: true,
  },
};

let pool;
async function getPool() {
  if (!pool) pool = await sql.connect(dbConfig);
  return pool;
}

// Helper – builds a parameterised IN clause for the sites CSV param
function addSitesFilter(request, sitesParam) {
  if (!sitesParam) return '';
  const sites = sitesParam.split(',').map(s => s.trim()).filter(Boolean);
  if (!sites.length) return '';
  const placeholders = sites.map((s, i) => {
    request.input(`site${i}`, sql.NVarChar, s);
    return `@site${i}`;
  });
  return ` AND ISNULL(Loc_ORGrp2, 'Unknown') IN (${placeholders.join(', ')})`;
}

// -----------------------------------------------------------------
// GET /api/sites
// Returns distinct site names for the filter dropdown
// -----------------------------------------------------------------
app.get('/api/sites', async (req, res) => {
  try {
    const db = await getPool();
    const result = await db.request().query(`
      SELECT DISTINCT ISNULL(Loc_ORGrp2, 'Unknown') AS Site
      FROM DS_CASES
      ORDER BY Site
    `);
    res.json(result.recordset.map(r => r.Site));
  } catch (err) {
    console.error('/api/sites error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------
// GET /api/summary?startDate=&endDate=&sites=
// Returns total cases and OR duration per site for the given range
// -----------------------------------------------------------------
app.get('/api/summary', async (req, res) => {
  try {
    const db      = await getPool();
    const request = db.request();
    const startDate = req.query.startDate || '2025-01-01';
    const endDate   = req.query.endDate   || '2025-12-31';
    request.input('startDate', sql.Date, startDate);
    request.input('endDate',   sql.Date, endDate);
    const siteFilter = addSitesFilter(request, req.query.sites);

    const result = await request.query(`
      SELECT
        ISNULL(Loc_ORGrp2, 'Unknown') AS Site,
        COUNT(*)                       AS TotalCases,
        SUM(ISNULL(Dur_ORIn_OROut, 0)) AS TotalORDuration
      FROM DS_CASES
      WHERE Date_SchedDate >= @startDate
        AND Date_SchedDate <= @endDate
        ${siteFilter}
      GROUP BY Loc_ORGrp2
      ORDER BY Loc_ORGrp2
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error('/api/summary error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------
// GET /api/monthly-trend?startDate=&endDate=&sites=
// Returns monthly case count for the given date range / sites
// -----------------------------------------------------------------
app.get('/api/monthly-trend', async (req, res) => {
  try {
    const db      = await getPool();
    const request = db.request();
    const startDate = req.query.startDate || '2025-01-01';
    const endDate   = req.query.endDate   || '2025-12-31';
    request.input('startDate', sql.Date, startDate);
    request.input('endDate',   sql.Date, endDate);
    const siteFilter = addSitesFilter(request, req.query.sites);

    const result = await request.query(`
      SELECT
        YEAR(Date_SchedDate)  AS Year,
        MONTH(Date_SchedDate) AS Month,
        COUNT(*)              AS TotalCases
      FROM DS_CASES
      WHERE Date_SchedDate >= @startDate
        AND Date_SchedDate <= @endDate
        ${siteFilter}
      GROUP BY YEAR(Date_SchedDate), MONTH(Date_SchedDate)
      ORDER BY Year, Month
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error('/api/monthly-trend error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =================================================================
// CAPACITY ENDPOINTS  (source: V4_BlockResultsView)
// Note: column names assume BlockDate, LocationGroup,
//       Total_Prime_Time, blockTime, Total_Non_Prime_time, total_Time
// =================================================================

// Helper – builds parameterised IN clause for locations CSV param
function addLocationsFilter(request, locParam) {
  if (!locParam) return '';
  const locs = locParam.split(',').map(s => s.trim()).filter(Boolean);
  if (!locs.length) return '';
  const placeholders = locs.map((l, i) => {
    request.input(`loc${i}`, sql.NVarChar, l);
    return `@loc${i}`;
  });
  return ` AND ISNULL(LocationGroup, 'Unknown') IN (${placeholders.join(', ')})`;
}

// Helper – builds parameterised IN clause for caseblocks CSV param
function addCaseBlocksFilter(request, cbParam) {
  if (!cbParam) return '';
  const blocks = cbParam.split(',').map(s => s.trim()).filter(Boolean);
  if (!blocks.length) return '';
  const placeholders = blocks.map((b, i) => {
    request.input(`cb${i}`, sql.NVarChar, b);
    return `@cb${i}`;
  });
  return ` AND ISNULL(CaseBlock, 'Unknown') IN (${placeholders.join(', ')})`;
}

// Helper – builds DATEPART(WEEKDAY) IN clause from CSV of day numbers
function addDowFilter(dowParam) {
  if (!dowParam) return '';
  const days = dowParam.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
  if (!days.length) return '';
  return ` AND DATEPART(WEEKDAY, BlockDate) IN (${days.join(', ')})`;
}

// -----------------------------------------------------------------
// GET /api/capacity/location-groups
// Distinct LocationGroup values for the filter dropdown
// -----------------------------------------------------------------
app.get('/api/capacity/location-groups', async (req, res) => {
  try {
    const db = await getPool();
    const result = await db.request().query(`
      SELECT DISTINCT ISNULL(LocationGroup, 'Unknown') AS LocationGroup
      FROM V4_BlockResultsView
      ORDER BY LocationGroup
    `);
    res.json(result.recordset.map(r => r.LocationGroup));
  } catch (err) {
    console.error('/api/capacity/location-groups error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------
// GET /api/capacity/prime-time?startDate=&endDate=&locations=&dow=
// Prime Time Utilization = SUM(Total_Prime_Time) / SUM(blockTime)
// -----------------------------------------------------------------
app.get('/api/capacity/prime-time', async (req, res) => {
  try {
    const db      = await getPool();
    const request = db.request();
    const startDate = req.query.startDate || '2025-01-01';
    const endDate   = req.query.endDate   || '2025-12-31';
    request.input('startDate', sql.Date, startDate);
    request.input('endDate',   sql.Date, endDate);
    const locFilter = addLocationsFilter(request, req.query.locations);
    const dowFilter = addDowFilter(req.query.dow);

    const result = await request.query(`
      SELECT
        ISNULL(LocationGroup, 'Unknown')     AS LocationGroup,
        SUM(ISNULL(Total_Prime_Time, 0))     AS SumPrimeTime,
        SUM(ISNULL(blockTime, 0))            AS SumBlockTime,
        CASE WHEN SUM(ISNULL(blockTime, 0)) = 0 THEN 0
             ELSE ROUND(
               100.0 * SUM(ISNULL(Total_Prime_Time, 0))
                     / SUM(ISNULL(blockTime, 0)), 2)
        END AS PrimeTimeUtil
      FROM V4_BlockResultsView
      WHERE BlockDate >= @startDate
        AND BlockDate <= @endDate
        ${locFilter}
        ${dowFilter}
      GROUP BY LocationGroup
      ORDER BY LocationGroup
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error('/api/capacity/prime-time error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------
// GET /api/capacity/non-prime-time?startDate=&endDate=&locations=&dow=
// Non-Prime Time Use = SUM(Total_Non_Prime_time) / SUM(total_Time)
// -----------------------------------------------------------------
app.get('/api/capacity/non-prime-time', async (req, res) => {
  try {
    const db      = await getPool();
    const request = db.request();
    const startDate = req.query.startDate || '2025-01-01';
    const endDate   = req.query.endDate   || '2025-12-31';
    request.input('startDate', sql.Date, startDate);
    request.input('endDate',   sql.Date, endDate);
    const locFilter = addLocationsFilter(request, req.query.locations);
    const dowFilter = addDowFilter(req.query.dow);

    const result = await request.query(`
      SELECT
        ISNULL(LocationGroup, 'Unknown')         AS LocationGroup,
        SUM(ISNULL(Total_Non_Prime_time, 0))     AS SumNonPrimeTime,
        SUM(ISNULL(totalTime, 0))               AS SumTotalTime,
        CASE WHEN SUM(ISNULL(totalTime, 0)) = 0 THEN 0
             ELSE ROUND(
               100.0 * SUM(ISNULL(Total_Non_Prime_time, 0))
                     / SUM(ISNULL(totalTime, 0)), 2)
        END AS NonPrimeTimeUtil
      FROM V4_BlockResultsView
      WHERE BlockDate >= @startDate
        AND BlockDate <= @endDate
        ${locFilter}
        ${dowFilter}
      GROUP BY LocationGroup
      ORDER BY LocationGroup
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error('/api/capacity/non-prime-time error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =================================================================
// BLOCK UTILIZATION ENDPOINTS  (source: V4_BlockResultsView)
// =================================================================

// -----------------------------------------------------------------
// GET /api/blockutil/caseblocks?startDate=&endDate=&locations=
// Distinct CaseBlock values for the filter dropdown
// -----------------------------------------------------------------
app.get('/api/blockutil/caseblocks', async (req, res) => {
  try {
    const db      = await getPool();
    const request = db.request();
    const startDate = req.query.startDate || '2025-01-01';
    const endDate   = req.query.endDate   || '2025-12-31';
    request.input('startDate', sql.Date, startDate);
    request.input('endDate',   sql.Date, endDate);
    const locFilter = addLocationsFilter(request, req.query.locations);

    const result = await request.query(`
      SELECT DISTINCT ISNULL(CaseBlock, 'Unknown') AS CaseBlock
      FROM V4_BlockResultsView
      WHERE BlockDate >= @startDate
        AND BlockDate <= @endDate
        ${locFilter}
        AND DATEPART(WEEKDAY, BlockDate) IN (2, 3, 4, 5, 6)
      ORDER BY CaseBlock
    `);
    res.json(result.recordset.map(r => r.CaseBlock));
  } catch (err) {
    console.error('/api/blockutil/caseblocks error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------
// GET /api/blockutil/data?startDate=&endDate=&locations=
// Returns block utilization by CaseBlock, WeekOfMonth, DayOfWeek
// Restricted to weekdays (Mon–Fri) only
// -----------------------------------------------------------------
app.get('/api/blockutil/data', async (req, res) => {
  try {
    const db      = await getPool();
    const request = db.request();
    const startDate = req.query.startDate || '2025-01-01';
    const endDate   = req.query.endDate   || '2025-12-31';
    request.input('startDate', sql.Date, startDate);
    request.input('endDate',   sql.Date, endDate);
    const locFilter = addLocationsFilter(request, req.query.locations);
    const cbFilter  = addCaseBlocksFilter(request, req.query.caseblocks);

    const result = await request.query(`
      SELECT
        ISNULL(CaseBlock, 'Unknown')              AS CaseBlock,
        COALESCE(Group_Service, Surgeonservice)    AS Service,
        dd_WeekofMonth                             AS WeekOfMonth,
        DATEPART(WEEKDAY, BlockDate)               AS DayOfWeek,
        COUNT(DISTINCT CaseID)                     AS CaseCount,
        SUM(ISNULL(Total_Prime_Time, 0))           AS SumPrimeTime,
        SUM(ISNULL(blockTime, 0))                  AS SumBlockTime,
        SUM(ISNULL(Total_Non_Prime_time, 0))       AS SumNonPrimeTime,
        SUM(ISNULL(totalTime, 0))                  AS SumTotalTime,
        SUM(ISNULL(ReleasedTime, 0))               AS SumReleasedTime
      FROM V4_BlockResultsView
      WHERE BlockDate >= @startDate
        AND BlockDate <= @endDate
        ${locFilter}
        ${cbFilter}
        AND DATEPART(WEEKDAY, BlockDate) IN (2, 3, 4, 5, 6)
      GROUP BY CaseBlock,COALESCE(Group_Service, Surgeonservice), DD_WeekOfMonth, DATEPART(WEEKDAY, BlockDate)
      ORDER BY CaseBlock, 2, 3
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error('/api/blockutil/data error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------
// GET /api/blockutil/monthly-detail?startDate=&endDate=&locations=
// Same as /data but also groups by Month — used for cell hover tooltips
// -----------------------------------------------------------------
app.get('/api/blockutil/monthly-detail', async (req, res) => {
  try {
    const db      = await getPool();
    const request = db.request();
    const startDate = req.query.startDate || '2025-01-01';
    const endDate   = req.query.endDate   || '2025-12-31';
    request.input('startDate', sql.Date, startDate);
    request.input('endDate',   sql.Date, endDate);
    const locFilter = addLocationsFilter(request, req.query.locations);
    const cbFilter  = addCaseBlocksFilter(request, req.query.caseblocks);

    const result = await request.query(`
      SELECT
        ISNULL(CaseBlock, 'Unknown')               AS CaseBlock,
        COALESCE(Group_Service, Surgeonservice)    AS Service,        
        dd_WeekofMonth                             AS WeekOfMonth,
        DATEPART(WEEKDAY, BlockDate)               AS DayOfWeek,
        MONTH(BlockDate)                           AS Month,
        COUNT(DISTINCT CaseID)                     AS CaseCount,
        SUM(ISNULL(Total_Prime_Time, 0))           AS SumPrimeTime,
        SUM(ISNULL(blockTime, 0))                  AS SumBlockTime,
        SUM(ISNULL(Total_Non_Prime_time, 0))       AS SumNonPrimeTime,
        SUM(ISNULL(totalTime, 0))                  AS SumTotalTime,
        SUM(ISNULL(ReleasedTime, 0))               AS SumReleasedTime
      FROM V4_BlockResultsView
      WHERE BlockDate >= @startDate
        AND BlockDate <= @endDate
        ${locFilter}
        ${cbFilter}
        AND DATEPART(WEEKDAY, BlockDate) IN (2, 3, 4, 5, 6)
      GROUP BY CaseBlock,
              COALESCE(Group_Service, Surgeonservice) ,
               dd_WeekofMonth,
               DATEPART(WEEKDAY, BlockDate),
               MONTH(BlockDate)
      ORDER BY CaseBlock, 2, 3, Month
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error('/api/blockutil/monthly-detail error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Surgical Dashboard running at http://localhost:${PORT}`);
});

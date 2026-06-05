const express = require('express');

module.exports = function analyticsRoutes(getTenantPool, sql, requireTenant) {
  const router = express.Router();

  // All data routes require a tenant to be selected
  router.use(requireTenant);

  // ── Filter helpers ──────────────────────────────────────────────────────────

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

  function addDowFilter(dowParam) {
    if (!dowParam) return '';
    const days = dowParam.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
    if (!days.length) return '';
    return ` AND DATEPART(WEEKDAY, BlockDate) IN (${days.join(', ')})`;
  }

  // ── GET /api/sites ──────────────────────────────────────────────────────────

  router.get('/sites', async (req, res) => {
    try {
      const db = await getTenantPool(req.session.tenantId);
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

  // ── GET /api/summary ────────────────────────────────────────────────────────

  router.get('/summary', async (req, res) => {
    try {
      const db        = await getTenantPool(req.session.tenantId);
      const request   = db.request();
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

  // ── GET /api/monthly-trend ──────────────────────────────────────────────────

  router.get('/monthly-trend', async (req, res) => {
    try {
      const db        = await getTenantPool(req.session.tenantId);
      const request   = db.request();
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

  // ── GET /api/capacity/location-groups ──────────────────────────────────────

  router.get('/capacity/location-groups', async (req, res) => {
    try {
      const db = await getTenantPool(req.session.tenantId);
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

  // ── GET /api/capacity/prime-time ────────────────────────────────────────────

  router.get('/capacity/prime-time', async (req, res) => {
    try {
      const db        = await getTenantPool(req.session.tenantId);
      const request   = db.request();
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

  // ── GET /api/capacity/non-prime-time ───────────────────────────────────────

  router.get('/capacity/non-prime-time', async (req, res) => {
    try {
      const db        = await getTenantPool(req.session.tenantId);
      const request   = db.request();
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
          SUM(ISNULL(totalTime, 0))                AS SumTotalTime,
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

  // ── GET /api/blockutil/caseblocks ──────────────────────────────────────────

  router.get('/blockutil/caseblocks', async (req, res) => {
    try {
      const db        = await getTenantPool(req.session.tenantId);
      const request   = db.request();
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

  // ── GET /api/blockutil/data ─────────────────────────────────────────────────

  router.get('/blockutil/data', async (req, res) => {
    try {
      const db        = await getTenantPool(req.session.tenantId);
      const request   = db.request();
      const startDate = req.query.startDate || '2025-01-01';
      const endDate   = req.query.endDate   || '2025-12-31';
      request.input('startDate', sql.Date, startDate);
      request.input('endDate',   sql.Date, endDate);
      const locFilter = addLocationsFilter(request, req.query.locations);
      const cbFilter  = addCaseBlocksFilter(request, req.query.caseblocks);

      const result = await request.query(`
        SELECT
          ISNULL(CaseBlock, 'Unknown')            AS CaseBlock,
          COALESCE(Group_Service, Surgeonservice)  AS Service,
          dd_WeekofMonth                           AS WeekOfMonth,
          DATEPART(WEEKDAY, BlockDate)             AS DayOfWeek,
          COUNT(DISTINCT CaseID)                   AS CaseCount,
          SUM(ISNULL(Total_Prime_Time, 0))         AS SumPrimeTime,
          SUM(ISNULL(blockTime, 0))                AS SumBlockTime,
          SUM(ISNULL(Total_Non_Prime_time, 0))     AS SumNonPrimeTime,
          SUM(ISNULL(totalTime, 0))                AS SumTotalTime,
          SUM(ISNULL(ReleasedTime, 0))             AS SumReleasedTime
        FROM V4_BlockResultsView
        WHERE BlockDate >= @startDate
          AND BlockDate <= @endDate
          ${locFilter}
          ${cbFilter}
          AND DATEPART(WEEKDAY, BlockDate) IN (2, 3, 4, 5, 6)
        GROUP BY CaseBlock, COALESCE(Group_Service, Surgeonservice), DD_WeekOfMonth, DATEPART(WEEKDAY, BlockDate)
        ORDER BY CaseBlock, 2, 3
      `);
      res.json(result.recordset);
    } catch (err) {
      console.error('/api/blockutil/data error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/blockutil/monthly-detail ──────────────────────────────────────

  router.get('/blockutil/monthly-detail', async (req, res) => {
    try {
      const db        = await getTenantPool(req.session.tenantId);
      const request   = db.request();
      const startDate = req.query.startDate || '2025-01-01';
      const endDate   = req.query.endDate   || '2025-12-31';
      request.input('startDate', sql.Date, startDate);
      request.input('endDate',   sql.Date, endDate);
      const locFilter = addLocationsFilter(request, req.query.locations);
      const cbFilter  = addCaseBlocksFilter(request, req.query.caseblocks);

      const result = await request.query(`
        SELECT
          ISNULL(CaseBlock, 'Unknown')            AS CaseBlock,
          COALESCE(Group_Service, Surgeonservice)  AS Service,
          dd_WeekofMonth                           AS WeekOfMonth,
          DATEPART(WEEKDAY, BlockDate)             AS DayOfWeek,
          MONTH(BlockDate)                         AS Month,
          COUNT(DISTINCT CaseID)                   AS CaseCount,
          SUM(ISNULL(Total_Prime_Time, 0))         AS SumPrimeTime,
          SUM(ISNULL(blockTime, 0))                AS SumBlockTime,
          SUM(ISNULL(Total_Non_Prime_time, 0))     AS SumNonPrimeTime,
          SUM(ISNULL(totalTime, 0))                AS SumTotalTime,
          SUM(ISNULL(ReleasedTime, 0))             AS SumReleasedTime
        FROM V4_BlockResultsView
        WHERE BlockDate >= @startDate
          AND BlockDate <= @endDate
          ${locFilter}
          ${cbFilter}
          AND DATEPART(WEEKDAY, BlockDate) IN (2, 3, 4, 5, 6)
        GROUP BY CaseBlock, COALESCE(Group_Service, Surgeonservice),
                 dd_WeekofMonth, DATEPART(WEEKDAY, BlockDate), MONTH(BlockDate)
        ORDER BY CaseBlock, 2, 3, Month
      `);
      res.json(result.recordset);
    } catch (err) {
      console.error('/api/blockutil/monthly-detail error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/rr/meta ───────────────────────────────────────────────────────
  // Returns max rrDate and distinct ORGroup values for filter defaults

  router.get('/rr/meta', async (req, res) => {
    try {
      const db = await getTenantPool(req.session.tenantId);
      const [dateRes, groupRes] = await Promise.all([
        db.request().query(`SELECT MAX(rrDate) AS MaxDate FROM DS_RR`),
        db.request().query(`SELECT DISTINCT ISNULL(ORGroup, 'Unknown') AS ORGroup FROM DS_RR ORDER BY ORGroup`),
      ]);
      res.json({
        maxDate:  dateRes.recordset[0]?.MaxDate ?? null,
        orGroups: groupRes.recordset.map(r => r.ORGroup),
      });
    } catch (err) {
      console.error('/api/rr/meta error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/rr/data ────────────────────────────────────────────────────────
  // Returns avg and stdev of TotalOccupied per rrtimeslot

  router.get('/rr/data', async (req, res) => {
    try {
      const db        = await getTenantPool(req.session.tenantId);
      const request   = db.request();
      const startDate = req.query.startDate;
      const endDate   = req.query.endDate;
      request.input('startDate', sql.Date, startDate);
      request.input('endDate',   sql.Date, endDate);

      // OR group filter
      let orGroupFilter = '';
      if (req.query.orGroups) {
        const groups = req.query.orGroups.split(',').map(s => s.trim()).filter(Boolean);
        if (groups.length) {
          const placeholders = groups.map((g, i) => {
            request.input(`og${i}`, sql.NVarChar, g);
            return `@og${i}`;
          });
          orGroupFilter = ` AND ISNULL(ORGroup, 'Unknown') IN (${placeholders.join(', ')})`;
        }
      }

      // Day of week filter
      let dowFilter = '';
      if (req.query.dow) {
        const days = req.query.dow.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
        if (days.length) dowFilter = ` AND DATEPART(WEEKDAY, rrDate) IN (${days.join(', ')})`;
      }

      const result = await request.query(`
        SELECT
          rrtimeslot,
          AVG(CAST(TotalOccupied AS FLOAT))                          AS AvgOccupied,
          ISNULL(STDEV(CAST(TotalOccupied AS FLOAT)), 0)             AS StdevOccupied
        FROM DS_RR
        WHERE rrDate >= @startDate
          AND rrDate <= @endDate
          ${orGroupFilter}
          ${dowFilter}
        GROUP BY rrtimeslot
        ORDER BY rrtimeslot
      `);
      res.json(result.recordset);
    } catch (err) {
      console.error('/api/rr/data error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/blazesql/url ───────────────────────────────────────────────────

  router.get('/blazesql/url', async (req, res) => {
    const apiKey = process.env.BLAZESQL_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'BLAZESQL_API_KEY not configured' });
    const email = req.session.email;
    if (!email) return res.status(400).json({ error: 'No email on your account — ask an admin to add one.' });
    try {
      const response = await fetch('https://api.blazesql.com/user_authentication_api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey, user_email: email, hide_sidebar: false }),
      });
      const text = await response.text();
      if (!response.ok || !text.startsWith('http')) {
        return res.status(502).json({ error: text || 'BlazeSql auth failed' });
      }
      res.json({ url: text });
    } catch (err) {
      console.error('/api/blazesql/url error:', err.message);
      res.status(500).json({ error: 'Could not reach BlazeSql' });
    }
  });

  return router;
};

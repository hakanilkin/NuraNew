const express     = require('express');
const makeFilters = require('./filters');

module.exports = function analyticsRoutes(getTenantPool, sql, requireTenant) {
  const router = express.Router();

  // All data routes require a tenant to be selected
  router.use(requireTenant);

  const {
    addSitesFilter, addLocationsFilter, addCaseBlocksFilter,
    addDowFilter, dateOr, isValidDate,
  } = makeFilters(sql);

  // Default to the trailing 12 months when no valid range is supplied
  function dateRange(query) {
    const fmt   = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth() - 11, 1);
    return {
      startDate: dateOr(query.startDate, fmt(start)),
      endDate:   dateOr(query.endDate,   fmt(today)),
    };
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
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/meta/dates ─────────────────────────────────────────────────────
  // Max available date per filtered column, used by the OR analytics pages to
  // default their end date to the latest data actually in the database.

  router.get('/meta/dates', async (req, res) => {
    try {
      const db = await getTenantPool(req.session.tenantId);
      const [caseRes, blockRes] = await Promise.all([
        db.request().query(`SELECT MAX(Date_SchedDate) AS MaxDate FROM DS_CASES`),
        db.request().query(`SELECT MAX(BlockDate) AS MaxDate FROM V4_BlockResultsView`),
      ]);
      res.json({
        maxCaseDate:  caseRes.recordset[0]?.MaxDate  ?? null,
        maxBlockDate: blockRes.recordset[0]?.MaxDate ?? null,
      });
    } catch (err) {
      console.error('/api/meta/dates error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/summary ────────────────────────────────────────────────────────

  router.get('/summary', async (req, res) => {
    try {
      const db        = await getTenantPool(req.session.tenantId);
      const request   = db.request();
      const { startDate, endDate } = dateRange(req.query);
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
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/monthly-trend ──────────────────────────────────────────────────

  router.get('/monthly-trend', async (req, res) => {
    try {
      const db        = await getTenantPool(req.session.tenantId);
      const request   = db.request();
      const { startDate, endDate } = dateRange(req.query);
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
      res.status(500).json({ error: 'Internal server error' });
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
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/capacity/prime-time ────────────────────────────────────────────

  router.get('/capacity/prime-time', async (req, res) => {
    try {
      const db        = await getTenantPool(req.session.tenantId);
      const request   = db.request();
      const { startDate, endDate } = dateRange(req.query);
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
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/capacity/non-prime-time ───────────────────────────────────────

  router.get('/capacity/non-prime-time', async (req, res) => {
    try {
      const db        = await getTenantPool(req.session.tenantId);
      const request   = db.request();
      const { startDate, endDate } = dateRange(req.query);
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
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/blockutil/caseblocks ──────────────────────────────────────────

  router.get('/blockutil/caseblocks', async (req, res) => {
    try {
      const db        = await getTenantPool(req.session.tenantId);
      const request   = db.request();
      const { startDate, endDate } = dateRange(req.query);
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
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/blockutil/data ─────────────────────────────────────────────────

  router.get('/blockutil/data', async (req, res) => {
    try {
      const db        = await getTenantPool(req.session.tenantId);
      const request   = db.request();
      const { startDate, endDate } = dateRange(req.query);
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
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/blockutil/monthly-detail ──────────────────────────────────────

  router.get('/blockutil/monthly-detail', async (req, res) => {
    try {
      const db        = await getTenantPool(req.session.tenantId);
      const request   = db.request();
      const { startDate, endDate } = dateRange(req.query);
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
      res.status(500).json({ error: 'Internal server error' });
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
      if (err.message && (err.message.includes('Invalid object name') || err.message.includes('DS_RR'))) {
        return res.status(404).json({ error: 'no_rr_data', message: 'Room Running data not available for this organization' });
      }
      console.error('/api/rr/meta error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/rr/data ────────────────────────────────────────────────────────
  // Returns avg and stdev of TotalOccupied per rrtimeslot

  router.get('/rr/data', async (req, res) => {
    try {
      const { startDate, endDate } = req.query;
      if (!isValidDate(startDate) || !isValidDate(endDate)) {
        return res.status(400).json({ error: 'startDate and endDate are required (YYYY-MM-DD)' });
      }
      const db      = await getTenantPool(req.session.tenantId);
      const request = db.request();
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
      if (err.message && (err.message.includes('Invalid object name') || err.message.includes('DS_RR'))) {
        return res.status(404).json({ error: 'no_rr_data', message: 'Room Running data not available for this organization' });
      }
      console.error('/api/rr/data error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/sf/meta ───────────────────────────────────────────────────────
  // Returns distinct ORGRP2 sites and SurgeonService values from V4_FORECAST_COMPILE

  router.get('/sf/meta', async (req, res) => {
    try {
      const db = await getTenantPool(req.session.tenantId);
      const [siteRes, svcRes] = await Promise.all([
        db.request().query(`SELECT DISTINCT ISNULL(ORGRP2, 'Unknown') AS Site FROM V4_FORECAST_COMPILE ORDER BY Site`),
        db.request().query(`SELECT DISTINCT ISNULL(SurgeonService, 'Unknown') AS Service FROM V4_FORECAST_COMPILE ORDER BY Service`),
      ]);
      res.json({
        sites:    siteRes.recordset.map(r => r.Site),
        services: svcRes.recordset.map(r => r.Service),
      });
    } catch (err) {
      console.error('/api/sf/meta error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/sf/cases ──────────────────────────────────────────────────────
  // Cases vs Budget summary grouped by Site + SurgeonService

  router.get('/sf/cases', async (req, res) => {
    try {
      const { startDate, endDate } = req.query;
      if (!isValidDate(startDate) || !isValidDate(endDate)) {
        return res.status(400).json({ error: 'startDate and endDate are required (YYYY-MM-DD)' });
      }
      const db      = await getTenantPool(req.session.tenantId);
      const request = db.request();
      request.input('startDate', sql.Date, startDate);
      request.input('endDate',   sql.Date, endDate);

      let siteFilter = '';
      if (req.query.sites) {
        const sites = req.query.sites.split(',').map(s => s.trim()).filter(Boolean);
        if (sites.length) {
          const ph = sites.map((s, i) => { request.input(`site${i}`, sql.NVarChar, s); return `@site${i}`; });
          siteFilter = ` AND ISNULL(ORGRP2, 'Unknown') IN (${ph.join(', ')})`;
        }
      }

      let svcFilter = '';
      if (req.query.services) {
        const svcs = req.query.services.split(',').map(s => s.trim()).filter(Boolean);
        if (svcs.length) {
          const ph = svcs.map((s, i) => { request.input(`svc${i}`, sql.NVarChar, s); return `@svc${i}`; });
          svcFilter = ` AND ISNULL(SurgeonService, 'Unknown') IN (${ph.join(', ')})`;
        }
      }

      const result = await request.query(`
        SELECT
          ISNULL(ORGRP2, 'Unknown')             AS Site,
          ISNULL(SurgeonService, 'Unknown')     AS Service,
          SUM(ISNULL(ACTUAL_INPATIENT, 0))      AS ActualInpatient,
          SUM(ISNULL(BUDGET_INPATIENT, 0))      AS BudgetInpatient,
          SUM(ISNULL(ACTUAL_OUTPATIENT, 0))     AS ActualOutpatient,
          SUM(ISNULL(BUDGET_OUTPATIENT, 0))     AS BudgetOutpatient,
          SUM(ISNULL(ACTUAL, 0))                AS TotalActual,
          SUM(ISNULL(BUDGET, 0))                AS TotalBudget
        FROM V4_FORECAST_COMPILE
        WHERE Date >= @startDate
          AND Date <= @endDate
          ${siteFilter}
          ${svcFilter}
        GROUP BY ORGRP2, SurgeonService
        ORDER BY ORGRP2, SurgeonService
      `);
      res.json(result.recordset);
    } catch (err) {
      console.error('/api/sf/cases error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/sf/daily ──────────────────────────────────────────────────────
  // Daily site summary: cases + duration grouped by Date × ORGRP2

  router.get('/sf/daily', async (req, res) => {
    try {
      const { startDate, endDate } = req.query;
      if (!isValidDate(startDate) || !isValidDate(endDate)) {
        return res.status(400).json({ error: 'startDate and endDate are required (YYYY-MM-DD)' });
      }
      const db      = await getTenantPool(req.session.tenantId);
      const request = db.request();
      request.input('startDate', sql.Date, startDate);
      request.input('endDate',   sql.Date, endDate);

      let siteFilter = '';
      if (req.query.sites) {
        const sites = req.query.sites.split(',').map(s => s.trim()).filter(Boolean);
        if (sites.length) {
          const ph = sites.map((s, i) => { request.input(`site${i}`, sql.NVarChar, s); return `@site${i}`; });
          siteFilter = ` AND ISNULL(ORGRP2, 'Unknown') IN (${ph.join(', ')})`;
        }
      }

      const result = await request.query(`
        SELECT
          CONVERT(VARCHAR(10), Date, 23)    AS Date,
          MAX(DOW_LONG)                     AS DayOfWeek,
          ISNULL(ORGRP2, 'Unknown')         AS Site,
          SUM(ISNULL(SCHEDULED_INPATIENT, 0) + ISNULL(SCHEDULED_OUTPATIENT, 0))               AS ScheduledTotal,
          SUM(ISNULL(FORECAST_OUTPATIENT, 0) + ISNULL(FORECAST_INPATIENT, 0))                 AS ForecastedAddition,
          SUM(ISNULL(SCHEDULED_INPATIENT, 0) + ISNULL(SCHEDULED_OUTPATIENT, 0)
            + ISNULL(FORECAST_OUTPATIENT, 0) + ISNULL(FORECAST_INPATIENT, 0))                 AS TotalForecasted,
          SUM(ISNULL(BUDGET, 0))            AS TotalBudget,
          SUM(ISNULL(SCHEDULED_INPATIENT_DURwTurn, 0) + ISNULL(SCHEDULED_OUTPATIENT_DURwTurn, 0)) AS SchedDurwTurn,
          SUM(ISNULL(FORECAST_INPATIENT_DURwTurn, 0) + ISNULL(FORECAST_OUTPATIENT_DURwTurn, 0))   AS FcstDurwTurn,
          SUM(ISNULL(SCHEDULED_INPATIENT_DURwTurn, 0) + ISNULL(SCHEDULED_OUTPATIENT_DURwTurn, 0)
            + ISNULL(FORECAST_INPATIENT_DURwTurn, 0) + ISNULL(FORECAST_OUTPATIENT_DURwTurn, 0))   AS TotalDurwTurn,
          SUM(ISNULL(BLOCKTIME, 0))         AS BlockTime
        FROM V4_FORECAST_COMPILE
        WHERE Date >= @startDate
          AND Date <= @endDate
          ${siteFilter}
        GROUP BY Date, ORGRP2
        ORDER BY Date, ORGRP2
      `);
      res.json(result.recordset);
    } catch (err) {
      console.error('/api/sf/daily error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/sf/detail/calendar ─────────────────────────────────────────────
  // Per-day % Filled for one site, future days only (DaysAhead >= 0).
  // Used to color the day picker calendar.

  router.get('/sf/detail/calendar', async (req, res) => {
    try {
      const site = req.query.site;
      if (!site) return res.status(400).json({ error: 'site is required' });
      const db      = await getTenantPool(req.session.tenantId);
      const request = db.request();
      request.input('site', sql.NVarChar, site);

      const result = await request.query(`
        SELECT
          CONVERT(VARCHAR(10), CAST(Date AS DATE), 23) AS Date,
          SUM(ISNULL(SCHEDULED_INPATIENT_DURwTurn, 0) + ISNULL(SCHEDULED_OUTPATIENT_DURwTurn, 0)
            + ISNULL(FORECAST_INPATIENT_DURwTurn, 0) + ISNULL(FORECAST_OUTPATIENT_DURwTurn, 0)) AS TotalDurwTurn,
          SUM(ISNULL(BLOCKTIME, 0)) AS BlockTime
        FROM V4_FORECAST_COMPILE
        WHERE DaysAhead >= 0
          AND ISNULL(ORGRP2, 'Unknown') = @site
        GROUP BY CAST(Date AS DATE)
        ORDER BY CAST(Date AS DATE)
      `);

      const days = result.recordset.map(r => ({
        date: r.Date,
        pct:  r.BlockTime > 0 ? (r.TotalDurwTurn / r.BlockTime * 100) : null,
      }));
      res.json({ days });
    } catch (err) {
      console.error('/api/sf/detail/calendar error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/sf/detail ──────────────────────────────────────────────────────
  // CaseBlock-level detail for one site on one day. Drops case blocks with
  // no forecast and no block time.

  router.get('/sf/detail', async (req, res) => {
    try {
      const { date, site } = req.query;
      if (!isValidDate(date)) return res.status(400).json({ error: 'date is required (YYYY-MM-DD)' });
      if (!site)             return res.status(400).json({ error: 'site is required' });
      const db      = await getTenantPool(req.session.tenantId);
      const request = db.request();
      request.input('date', sql.Date, date);
      request.input('site', sql.NVarChar, site);

      const result = await request.query(`
        SELECT
          ISNULL(Caseblock, 'Unknown') AS CaseBlock,
          SUM(ISNULL(SCHEDULED_INPATIENT, 0) + ISNULL(SCHEDULED_OUTPATIENT, 0))               AS ScheduledTotal,
          SUM(ISNULL(FORECAST_INPATIENT, 0) + ISNULL(FORECAST_OUTPATIENT, 0))                 AS ForecastedAddition,
          SUM(ISNULL(SCHEDULED_INPATIENT, 0) + ISNULL(SCHEDULED_OUTPATIENT, 0)
            + ISNULL(FORECAST_INPATIENT, 0) + ISNULL(FORECAST_OUTPATIENT, 0))                 AS TotalForecasted,
          SUM(ISNULL(SCHEDULED_INPATIENT_DURwTurn, 0) + ISNULL(SCHEDULED_OUTPATIENT_DURwTurn, 0)) AS SchedDurwTurn,
          SUM(ISNULL(FORECAST_INPATIENT_DURwTurn, 0) + ISNULL(FORECAST_OUTPATIENT_DURwTurn, 0))   AS FcstDurwTurn,
          SUM(ISNULL(SCHEDULED_INPATIENT_DURwTurn, 0) + ISNULL(SCHEDULED_OUTPATIENT_DURwTurn, 0)
            + ISNULL(FORECAST_INPATIENT_DURwTurn, 0) + ISNULL(FORECAST_OUTPATIENT_DURwTurn, 0))   AS TotalDurwTurn,
          SUM(ISNULL(BLOCKTIME, 0))    AS BlockTime
        FROM V4_FORECAST_COMPILE
        WHERE CAST(Date AS DATE) = @date
          AND ISNULL(ORGRP2, 'Unknown') = @site
        GROUP BY Caseblock
        HAVING NOT (
          SUM(ISNULL(SCHEDULED_INPATIENT, 0) + ISNULL(SCHEDULED_OUTPATIENT, 0)
            + ISNULL(FORECAST_INPATIENT, 0) + ISNULL(FORECAST_OUTPATIENT, 0)) = 0
          AND SUM(ISNULL(BLOCKTIME, 0)) = 0
        )
        ORDER BY Caseblock
      `);
      res.json(result.recordset);
    } catch (err) {
      console.error('/api/sf/detail error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
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

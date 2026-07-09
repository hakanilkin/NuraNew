-- ================================================================
-- Nura — ED Admissions Forecast profile (run in the OHS database)
--
-- Builds a by-source-ED / by-destination-department demand profile of
-- patients admitted through the ED, for the inpatient throughput
-- forecasting application.
--
-- Population : DS_Encounters, BEDDED = 'Y' AND ER_ARRIVAL = 'Y'
-- Source     : the ED department the patient arrived to
-- Destination: the first bedded (inpatient) department
-- Expected arrival at destination = admission order time + @LeadTimeMinutes
--                                   (default 60, parameterized)
-- Output grain: SourceEDDept × DestinationDept × MonthOfYear ×
--               DayOfWeek × HourOfDay, with the average number of
--               expected patients per occurrence of that day.
--
-- Objects created:
--   dbo.vw_ED_Admission_Source        column-mapping view (edit here if
--                                     physical column names differ)
--   dbo.EDAdmissionsForecast          the calculated table
--   dbo.usp_Build_EDAdmissionsForecast(@LeadTimeMinutes) rebuild proc
--
-- ----------------------------------------------------------------
-- ⚠ COLUMN NAMES TO CONFIRM before running:
--   ER_ARRIVAL          ED-arrival flag ('Y'). Other tenants use
--                       EDENCOUNTER = 'Y' — swap in the view if needed.
--   DEP_EDDEPARTMENT    source ED department name  ← confirm
--   DEP_FIRSTBEDDEDDEPT first bedded department    ← confirm
--   ADMORDER_ORDERINST  admission order time (used elsewhere in Nura)
--
-- Run this to discover the actual names in OHS:
--   SELECT COLUMN_NAME, DATA_TYPE
--   FROM INFORMATION_SCHEMA.COLUMNS
--   WHERE TABLE_NAME = 'DS_Encounters'
--     AND (COLUMN_NAME LIKE '%ED%' OR COLUMN_NAME LIKE '%ER%'
--          OR COLUMN_NAME LIKE 'DEP%' OR COLUMN_NAME LIKE '%ADMORDER%'
--          OR COLUMN_NAME LIKE '%BEDDED%')
--   ORDER BY COLUMN_NAME;
-- ================================================================

-- ----------------------------------------------------------------
-- 1. Column-mapping view — the ONLY place physical column names live.
--    If OHS uses different names, edit them here and re-run.
-- ----------------------------------------------------------------
CREATE OR ALTER VIEW dbo.vw_ED_Admission_Source
AS
SELECT
  e.DEP_EDDEPARTMENT     AS SourceEDDept,        -- ⚠ confirm column name
  e.DEP_FIRSTBEDDEDDEPT  AS DestinationDept,     -- ⚠ confirm column name
  e.ADMORDER_ORDERINST   AS AdmissionOrderTime
FROM dbo.DS_Encounters e
WHERE e.BEDDED     = 'Y'
  AND e.ER_ARRIVAL = 'Y'                          -- ⚠ or EDENCOUNTER = 'Y'
  AND e.ADMORDER_ORDERINST IS NOT NULL;
GO

-- ----------------------------------------------------------------
-- 2. The calculated table
-- ----------------------------------------------------------------
IF OBJECT_ID('dbo.EDAdmissionsForecast', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.EDAdmissionsForecast (
    SourceEDDept        NVARCHAR(200) NOT NULL,  -- ED department (source)
    DestinationDept     NVARCHAR(200) NOT NULL,  -- first bedded department
    MonthOfYear         TINYINT       NOT NULL,  -- 1–12
    MonthName           NVARCHAR(20)  NOT NULL,
    DayOfWeek           TINYINT       NOT NULL,  -- 1 = Monday … 7 = Sunday
    DayOfWeekName       NVARCHAR(20)  NOT NULL,
    HourOfDay           TINYINT       NOT NULL,  -- 0–23, hour patient is expected at destination
    TotalPatients       INT           NOT NULL,  -- historical patients in this cell
    DaysInBucket        INT           NOT NULL,  -- calendar days of this month × weekday in the data window
    AvgExpectedPatients DECIMAL(10,4) NOT NULL,  -- TotalPatients / DaysInBucket
    LeadTimeMinutes     INT           NOT NULL,  -- lead time used for this build
    RefreshedAt         DATETIME2     NOT NULL,
    CONSTRAINT PK_EDAdmissionsForecast
      PRIMARY KEY (SourceEDDept, DestinationDept, MonthOfYear, DayOfWeek, HourOfDay)
  );
END;
GO

-- ----------------------------------------------------------------
-- 3. Rebuild procedure
--    @LeadTimeMinutes — minutes from admission order to expected
--    arrival at the destination unit (default 60).
-- ----------------------------------------------------------------
CREATE OR ALTER PROCEDURE dbo.usp_Build_EDAdmissionsForecast
  @LeadTimeMinutes INT = 60
AS
BEGIN
  SET NOCOUNT ON;
  SET XACT_ABORT ON;

  ------------------------------------------------------------------
  -- Expected arrival at the destination unit for every qualifying
  -- encounter, using all data available in DS_Encounters.
  ------------------------------------------------------------------
  SELECT
    s.SourceEDDept,
    s.DestinationDept,
    DATEADD(MINUTE, @LeadTimeMinutes, s.AdmissionOrderTime) AS ExpectedArrival
  INTO #expected
  FROM dbo.vw_ED_Admission_Source s
  WHERE s.SourceEDDept    IS NOT NULL
    AND s.DestinationDept IS NOT NULL;

  IF NOT EXISTS (SELECT 1 FROM #expected)
  BEGIN
    RAISERROR('No qualifying encounters found — check the column mappings in dbo.vw_ED_Admission_Source.', 16, 1);
    RETURN;
  END;

  ------------------------------------------------------------------
  -- Calendar spine over the full data window, so the average divides
  -- by every occurrence of a month × weekday — including days when a
  -- given source/destination saw zero patients.
  ------------------------------------------------------------------
  DECLARE @MinDate DATE, @MaxDate DATE;
  SELECT @MinDate = MIN(CAST(ExpectedArrival AS DATE)),
         @MaxDate = MAX(CAST(ExpectedArrival AS DATE))
  FROM #expected;

  SELECT
    MONTH(d.CalDate)                       AS MonthOfYear,
    (DATEDIFF(DAY, 0, d.CalDate) % 7) + 1  AS DayOfWeek,   -- 1 = Monday, DATEFIRST-independent
    COUNT(*)                               AS DaysInBucket
  INTO #daycounts
  FROM (
    SELECT DATEADD(DAY, n.rn, @MinDate) AS CalDate
    FROM (
      SELECT TOP (DATEDIFF(DAY, @MinDate, @MaxDate) + 1)
             ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) - 1 AS rn
      FROM sys.all_objects a CROSS JOIN sys.all_objects b
    ) n
  ) d
  GROUP BY MONTH(d.CalDate), (DATEDIFF(DAY, 0, d.CalDate) % 7) + 1;

  ------------------------------------------------------------------
  -- Aggregate and load
  ------------------------------------------------------------------
  BEGIN TRAN;

  DELETE FROM dbo.EDAdmissionsForecast;

  INSERT INTO dbo.EDAdmissionsForecast (
    SourceEDDept, DestinationDept,
    MonthOfYear, MonthName, DayOfWeek, DayOfWeekName, HourOfDay,
    TotalPatients, DaysInBucket, AvgExpectedPatients,
    LeadTimeMinutes, RefreshedAt
  )
  SELECT
    agg.SourceEDDept,
    agg.DestinationDept,
    agg.MonthOfYear,
    DATENAME(MONTH, DATEFROMPARTS(2000, agg.MonthOfYear, 1))   AS MonthName,
    agg.DayOfWeek,
    DATENAME(WEEKDAY, DATEADD(DAY, agg.DayOfWeek - 1, 0))      AS DayOfWeekName, -- day 0 = Monday
    agg.HourOfDay,
    agg.TotalPatients,
    dc.DaysInBucket,
    CAST(agg.TotalPatients AS DECIMAL(18,4)) / dc.DaysInBucket AS AvgExpectedPatients,
    @LeadTimeMinutes,
    SYSDATETIME()
  FROM (
    SELECT
      e.SourceEDDept,
      e.DestinationDept,
      MONTH(e.ExpectedArrival)                                AS MonthOfYear,
      (DATEDIFF(DAY, 0, CAST(e.ExpectedArrival AS DATE)) % 7) + 1 AS DayOfWeek,
      DATEPART(HOUR, e.ExpectedArrival)                       AS HourOfDay,
      COUNT(*)                                                AS TotalPatients
    FROM #expected e
    GROUP BY
      e.SourceEDDept,
      e.DestinationDept,
      MONTH(e.ExpectedArrival),
      (DATEDIFF(DAY, 0, CAST(e.ExpectedArrival AS DATE)) % 7) + 1,
      DATEPART(HOUR, e.ExpectedArrival)
  ) agg
  JOIN #daycounts dc
    ON dc.MonthOfYear = agg.MonthOfYear
   AND dc.DayOfWeek   = agg.DayOfWeek;

  COMMIT;

  -- Cells absent from the table are true zeros for that
  -- source × destination × month × weekday × hour combination.
END;
GO

-- ----------------------------------------------------------------
-- 4. Build the table (default 60-minute lead time)
-- ----------------------------------------------------------------
EXEC dbo.usp_Build_EDAdmissionsForecast @LeadTimeMinutes = 60;
GO

-- Rebuild later with a different lead time, e.g. 45 minutes:
--   EXEC dbo.usp_Build_EDAdmissionsForecast @LeadTimeMinutes = 45;

-- Sample: expected Monday-in-January arrivals by hour for one unit
--   SELECT HourOfDay, SourceEDDept, AvgExpectedPatients
--   FROM dbo.EDAdmissionsForecast
--   WHERE DestinationDept = '<unit>' AND MonthOfYear = 1 AND DayOfWeek = 1
--   ORDER BY HourOfDay, SourceEDDept;

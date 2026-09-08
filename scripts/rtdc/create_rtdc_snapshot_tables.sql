-- ================================================================
-- Nura RTDC — snapshot landing tables (run in each TENANT database)
--
-- The Reporting Workbench extract (Phase 1) or the FHIR Bulk export
-- (Phase 2) lands here three times a day: S1 pre-huddle (~06:00),
-- S2 huddle (~08:20), S3 post-2 PM scoring (nightly). Column names are
-- the logical names in RTDC.md §2.1 / §2.2; physical names can be
-- remapped per tenant through config/tenantColumns.json if a site's
-- extract differs. JSON columns hold JSON text.
--
-- Nura only reads these tables. Nothing Nura enters (effective beds,
-- barrier confirmations, rules) is stored here — that lives in NuraOps.
-- ================================================================

CREATE TABLE DS_RTDC_Snapshot (
  SNAPSHOT_DATE             DATE          NOT NULL,
  SNAPSHOT_KIND             CHAR(2)       NOT NULL,   -- 'S1' | 'S2' | 'S3'
  SNAPSHOT_AT               DATETIME2     NOT NULL,
  ENCOUNTER_KEY             NVARCHAR(50)  NOT NULL,   -- EPICCSN
  HOSPITAL                  NVARCHAR(100) NULL,
  UNIT                      NVARCHAR(100) NULL,
  ROOM_BED                  NVARCHAR(30)  NULL,
  PATIENT_INITIALS          NVARCHAR(4)   NULL,
  ADMIT_AT                  DATETIME2     NULL,
  LOS_DAYS                  DECIMAL(6,2)  NULL,
  GMLOS                     DECIMAL(6,2)  NULL,
  PATIENT_CLASS             NVARCHAR(30)  NULL,
  LEVEL_OF_CARE             NVARCHAR(30)  NULL,
  HOSPITAL_SERVICE          NVARCHAR(100) NULL,
  ATTENDING                 NVARCHAR(100) NULL,
  EXPECTED_DISPOSITION      NVARCHAR(40)  NULL,
  PRED_SOURCE_DATE          DATE          NULL,       -- EDD date
  PRED_SOURCE_TIME          TIME(0)       NULL,       -- EDD time where captured
  PRED_FLAG_RAW             NVARCHAR(10)  NULL,       -- dedicated Y/N field where used
  PRED_UNKNOWN              BIT           NULL,
  DC_NARRATIVE              NVARCHAR(MAX) NULL,       -- EDD comment
  NARRATIVE_OWNER_ROLE      NVARCHAR(10)  NULL,
  PRED_LAST_EDIT_AT         DATETIME2     NULL,
  PRED_LAST_EDIT_ROLE       NVARCHAR(10)  NULL,
  PRED_EDIT_LOG             NVARCHAR(MAX) NULL,       -- JSON [{at, role, old, new, review?}]
  MRD                       BIT           NULL,
  ORD                       BIT           NULL,
  DC_ORDER_AT               DATETIME2     NULL,
  DC_MILESTONES             NVARCHAR(MAX) NULL,       -- JSON [{name, status, completed_at}]
  DC_DELAY_REASON           NVARCHAR(100) NULL,
  PENDING_ITEMS             NVARCHAR(MAX) NULL,       -- JSON [{class, name, ordered_at, status, resulted_at}]; NULL when unavailable
  PLACEMENT_STATUS          NVARCHAR(20)  NULL,       -- pending | accepted | authorized
  TRANSPORT_REQUESTED_AT    DATETIME2     NULL,
  FLAGS                     NVARCHAR(MAX) NULL,       -- JSON ["isolation","sitter",...]
  DISCHARGED_AT             DATETIME2     NULL,       -- S3 only
  DISCHARGE_ENTERED_AT      DATETIME2     NULL,       -- S3 only
  DISCHARGE_DISPOSITION     NVARCHAR(40)  NULL,       -- S3 only
  CONSTRAINT PK_DS_RTDC_Snapshot PRIMARY KEY (SNAPSHOT_DATE, SNAPSHOT_KIND, ENCOUNTER_KEY)
);

CREATE TABLE DS_RTDC_UnitSnapshot (
  SNAPSHOT_DATE             DATE          NOT NULL,
  SNAPSHOT_KIND             CHAR(2)       NOT NULL,
  SNAPSHOT_AT               DATETIME2     NOT NULL,
  HOSPITAL                  NVARCHAR(100) NULL,
  UNIT                      NVARCHAR(100) NOT NULL,
  LEVEL_OF_CARE             NVARCHAR(30)  NULL,
  STAFFED_BEDS              INT           NULL,
  OCCUPIED_BEDS             INT           NULL,
  BLOCKED_BEDS              INT           NULL,
  PENDING_BED_REQUESTS_IN   NVARCHAR(MAX) NULL,       -- JSON [{source_dept, requested_at, state}]
  OR_EXPECTED_ADMITS_BY_2PM INT           NULL,
  DOWNGRADE_REQUESTS_IN     INT           NULL,
  ED_LIKELY_ADMITS          INT           NULL,
  PROCEDURAL_EXPECTED       INT           NULL,
  DOWNGRADES_ANTICIPATED    INT           NULL,
  ED_FORECAST_8_14          DECIMAL(6,2)  NULL,
  CONSTRAINT PK_DS_RTDC_UnitSnapshot PRIMARY KEY (SNAPSHOT_DATE, SNAPSHOT_KIND, UNIT)
);

CREATE INDEX IX_DS_RTDC_Snapshot_Date ON DS_RTDC_Snapshot (SNAPSHOT_DATE, SNAPSHOT_KIND) INCLUDE (UNIT);

#!/usr/bin/env python3
"""
Static configuration for the Bright Memorial Health demo tenant.

Everything here is authored, not fitted: the physical plant (sites, rooms,
units), the weekly block grid, the staffing rectangle, the vocabularies the
app's queries expect, and the numeric targets for the engineered storylines in
DemoTenant.md section 4.

Shapes (durations, LOS, conversion rates, arrival curves) live in
demo_distributions.json instead — see fit_distributions.py.

Nothing in this file is derived from client data.
"""

import os


# ── ODBC connection ──────────────────────────────────────────────────────────

def odbc_connection_string(server, database, user, password):
    """
    Build a connection string against whichever SQL Server ODBC driver is
    actually installed. The rest of the repo hardcodes "ODBC Driver 17"; some
    machines only ship 18, so prefer the newest present and let ODBC_DRIVER
    override when a specific one is needed.
    """
    driver = os.getenv('ODBC_DRIVER')
    if not driver:
        try:
            import pyodbc
            installed = [d for d in pyodbc.drivers() if 'SQL Server' in d]
        except Exception:
            installed = []
        driver = sorted(installed)[-1] if installed else 'ODBC Driver 17 for SQL Server'
    return (f'DRIVER={{{driver}}};SERVER={server};DATABASE={database};'
            f'UID={user};PWD={password}')


# ── Tables replicated from the NHS/Virtua analytics DB (DemoTenant.md 5.1) ────
# The DDL is extracted from the source tenant by extract_schema.py; this is the
# manifest of which objects to extract, in load order.

REPLICATED_TABLES = [
    'DS_CASES',
    'DS_Encounters',
    'DS_Bedplacement',
    'DS_Occupancy',
    'DS_RR',
    'V4_BlockResultsView',
    'V4_FORECAST_COMPILE',
    'V4_Inpatient_Forecast_Compile',
]

# New tables that exist only in Demo for now (DemoTenant.md 5.2). Future tenants
# get them when the ISSCM features go live.
NEW_TABLE_DDL = """
-- ── ISSCM pillar 2: the staffed "rectangle" demand is compared against ───────
IF OBJECT_ID('dbo.StaffingPlan', 'U') IS NOT NULL DROP TABLE dbo.StaffingPlan;
CREATE TABLE dbo.StaffingPlan (
    Site          NVARCHAR(100)  NOT NULL,
    DayOfWeek     TINYINT        NOT NULL,   -- 1 = Monday
    ShiftStart    TIME           NOT NULL,
    ShiftEnd      TIME           NOT NULL,
    StaffedRooms  INT            NOT NULL,
    CoverageRatio DECIMAL(4,2)   NOT NULL,
    CONSTRAINT PK_StaffingPlan PRIMARY KEY (Site, DayOfWeek, ShiftStart)
);

-- ── ISSCM pillar 3: headroom denominator ────────────────────────────────────
IF OBJECT_ID('dbo.UnitCapacity', 'U') IS NOT NULL DROP TABLE dbo.UnitCapacity;
CREATE TABLE dbo.UnitCapacity (
    Unit        NVARCHAR(100) NOT NULL PRIMARY KEY,
    LevelOfCare NVARCHAR(50)  NOT NULL,
    StaffedBeds INT           NOT NULL
);

-- ── Case mix -> where it lands. Shares per service sum to 100. ──────────────
IF OBJECT_ID('dbo.ServiceUnitMap', 'U') IS NOT NULL DROP TABLE dbo.ServiceUnitMap;
CREATE TABLE dbo.ServiceUnitMap (
    Service  NVARCHAR(100) NOT NULL,
    Unit     NVARCHAR(100) NOT NULL,
    SharePct DECIMAL(5,2)  NOT NULL,
    CONSTRAINT PK_ServiceUnitMap PRIMARY KEY (Service, Unit)
);
"""

# ── Physical plant ───────────────────────────────────────────────────────────

MAIN_SITE = 'Bright Memorial Hospital'
ASC_SITE  = 'Bright Surgery Center'

SITES = {
    MAIN_SITE: {
        'abbr': 'BMH',
        'rooms': [f'BMH OR {i:02d}' for i in range(1, 10)],   # 9 ORs
        'prime_start': '07:00',
        'prime_end':   '16:00',
        'block_start': '07:30',
        'block_end':   '15:30',
        'inpatient': True,
    },
    ASC_SITE: {
        'abbr': 'BSC',
        'rooms': [f'BSC OR {i:02d}' for i in range(1, 5)],    # 4 ORs
        'prime_start': '07:00',
        'prime_end':   '15:30',
        'block_start': '07:30',
        'block_end':   '14:30',
        'inpatient': False,   # ASC: outpatient only, no admissions
    },
}

# Inpatient units at the main site. StaffedBeds feed UnitCapacity and the
# occupancy denominator.
UNITS = [
    # name,        level of care,   staffed beds, department code (DEP_LASTDEPT)
    ('5 Central',  'Med-Surg',      32, 'BMH 5 CENTRAL MED SURG'),
    ('4 East',     'Med-Surg',      28, 'BMH 4 EAST MED SURG'),
    ('3 West',     'Telemetry',     24, 'BMH 3 WEST TELEMETRY'),
    ('ICU',        'Critical Care', 16, 'BMH ICU'),
    ('Stepdown',   'Stepdown',      12, 'BMH STEPDOWN PCU'),
]

SERVICES = [
    'Orthopedics', 'Spine', 'General Surgery', 'Urology', 'GYN',
    'ENT', 'Plastics', 'Vascular', 'Colorectal', 'Robotics-General',
]

# Relative share of total case volume per service. Normalised at load.
SERVICE_VOLUME_WEIGHT = {
    'Orthopedics':      0.19,
    'General Surgery':  0.17,
    'Urology':          0.12,
    'GYN':              0.11,
    'ENT':              0.10,
    'Spine':            0.08,
    'Robotics-General': 0.08,
    'Plastics':         0.06,
    'Colorectal':       0.05,
    'Vascular':         0.04,
}

# Share of a service's cases that are inpatient-intent (drives admissions).
# ASC cases are forced outpatient regardless.
SERVICE_INPATIENT_RATE = {
    'Orthopedics':      0.35,
    'Spine':            0.56,
    'General Surgery':  0.22,
    'Urology':          0.14,
    'GYN':              0.12,
    'ENT':              0.05,
    'Plastics':         0.04,
    'Vascular':         0.45,
    'Colorectal':       0.44,
    'Robotics-General': 0.22,
}

# ServiceUnitMap: where a service's admitted patients land. Shares sum to 100.
SERVICE_UNIT_MAP = {
    'Orthopedics':      {'5 Central': 68, '4 East': 24, '3 West':  5, 'Stepdown': 3},
    'Spine':            {'5 Central': 62, '4 East': 18, '3 West': 12, 'Stepdown': 6, 'ICU': 2},
    'General Surgery':  {'4 East':    52, '5 Central': 28, '3 West': 12, 'ICU': 5, 'Stepdown': 3},
    'Urology':          {'4 East':    58, '5 Central': 30, '3 West': 12},
    'GYN':              {'4 East':    64, '5 Central': 26, '3 West': 10},
    'ENT':              {'4 East':    60, '3 West': 30, 'Stepdown': 10},
    'Plastics':         {'4 East':    70, '5 Central': 30},
    'Vascular':         {'3 West':    44, 'Stepdown': 22, 'ICU': 20, '4 East': 14},
    'Colorectal':       {'4 East':    46, '5 Central': 30, '3 West': 14, 'ICU': 10},
    'Robotics-General': {'4 East':    50, '5 Central': 30, '3 West': 14, 'ICU': 6},
}

# ── Weekly block grid ────────────────────────────────────────────────────────
# (block name, site, room, weekday [0=Mon], service). Rooms/days not listed here
# are open time: cases still land there, they just are not in anyone's block.

BLOCK_TEMPLATE = [
    # Bright Memorial Hospital — 11 block lines
    ('Ortho C',      MAIN_SITE, 'BMH OR 01', 0, 'Orthopedics'),
    ('Ortho A',      MAIN_SITE, 'BMH OR 01', 3, 'Orthopedics'),      # ST-1 Thursday
    ('Ortho B',      MAIN_SITE, 'BMH OR 02', 1, 'Orthopedics'),
    ('Ortho B',      MAIN_SITE, 'BMH OR 02', 4, 'Orthopedics'),
    ('Spine',        MAIN_SITE, 'BMH OR 03', 0, 'Spine'),
    ('Spine',        MAIN_SITE, 'BMH OR 03', 2, 'Spine'),
    ('Spine B',      MAIN_SITE, 'BMH OR 03', 4, 'Spine'),
    ('General A',    MAIN_SITE, 'BMH OR 04', 1, 'General Surgery'),
    ('General A',    MAIN_SITE, 'BMH OR 04', 3, 'General Surgery'),
    ('General B',    MAIN_SITE, 'BMH OR 05', 2, 'General Surgery'),
    ('General B',    MAIN_SITE, 'BMH OR 05', 4, 'General Surgery'),
    ('Robotics 1',   MAIN_SITE, 'BMH OR 06', 0, 'Robotics-General'),
    ('Robotics 1',   MAIN_SITE, 'BMH OR 06', 2, 'Robotics-General'),
    ('Robotics 1',   MAIN_SITE, 'BMH OR 06', 4, 'Robotics-General'),
    ('Uro/Gyn',      MAIN_SITE, 'BMH OR 07', 1, 'Urology'),
    ('Uro/Gyn',      MAIN_SITE, 'BMH OR 07', 3, 'GYN'),
    ('Vascular',     MAIN_SITE, 'BMH OR 08', 2, 'Vascular'),
    ('Colorectal',   MAIN_SITE, 'BMH OR 08', 0, 'Colorectal'),
    ('Colorectal',   MAIN_SITE, 'BMH OR 08', 4, 'Colorectal'),
    ('ENT',          MAIN_SITE, 'BMH OR 09', 1, 'ENT'),
    ('Plastics',     MAIN_SITE, 'BMH OR 09', 3, 'Plastics'),
    # Bright Surgery Center — 5 block lines
    ('ASC Ortho',    ASC_SITE,  'BSC OR 01', 0, 'Orthopedics'),
    ('ASC Ortho',    ASC_SITE,  'BSC OR 01', 2, 'Orthopedics'),
    ('ASC Uro/Gyn',  ASC_SITE,  'BSC OR 02', 1, 'Urology'),
    ('ASC Uro/Gyn',  ASC_SITE,  'BSC OR 02', 3, 'GYN'),
    ('ASC ENT',      ASC_SITE,  'BSC OR 03', 0, 'ENT'),
    ('ASC ENT',      ASC_SITE,  'BSC OR 03', 2, 'ENT'),
    ('ASC Plastics', ASC_SITE,  'BSC OR 03', 4, 'Plastics'),
    ('ASC General',  ASC_SITE,  'BSC OR 04', 1, 'General Surgery'),
    ('ASC General',  ASC_SITE,  'BSC OR 04', 4, 'General Surgery'),
]

# ── Staffing plan (ISSCM pillar 2) ───────────────────────────────────────────
# ST-3: the main site staffs 9 rooms 07:00-15:30 Mon-Fri. There is deliberately
# no second shift — that is what makes 15:30 a cliff rather than a handoff.

STAFFING_PLAN = (
    [(MAIN_SITE, dow, '07:00', '15:30', 9, 1.00) for dow in range(1, 6)] +
    [(ASC_SITE,  dow, '07:00', '15:00', 4, 1.00) for dow in range(1, 6)]
)

# ── Vocabularies the app's queries expect (DemoTenant.md 8.2) ────────────────

CASE_LOG_STATUS   = 'Posted'
CASE_TYPES        = ['Elective', 'Urgent', 'Emergent']
ADDON_CODE_YES    = 'Add On'
ASA_CODES         = ['1', '2', '3', '4']
ASA_WEIGHTS       = [0.12, 0.46, 0.34, 0.08]
ANESTHESIA_TYPES  = ['General', 'MAC', 'Regional', 'Spinal', 'Local']
ANESTHESIA_WEIGHT = [0.62, 0.16, 0.11, 0.08, 0.03]
CANCEL_CODES      = ['Patient Cancelled', 'Medical Reason', 'Facility Reason', 'Surgeon Cancelled']

ADMISSION_TYPES   = ['Elective', 'Emergency', 'Urgent']
PATIENT_CLASSES   = ['Inpatient', 'Observation']
FINANCIAL_CLASSES = ['Commercial', 'Medicare', 'Medicaid', 'Self Pay', 'Other Government']
FINANCIAL_WEIGHTS = [0.42, 0.36, 0.14, 0.03, 0.05]

# Dispositions must match pipeline_config.py's NHS matching rules so the
# DO->DC, LOS and LOS-segment pipelines classify them correctly.
DISPOSITIONS = [
    ('Disch to Home or Self Care',        0.62),
    ('Disch to Home-Health Care Svc',     0.16),
    ('Disch/trans to SNF',                0.11),
    ('Disch/trans to Rehab Facility',     0.05),
    ('Disch/trans to Skilled Nursing',    0.03),
    ('Expired',                           0.015),
    ('Left AMA',                          0.01),
    ('Transfer to Short Term Hospital',   0.015),
]

EVENT_TYPES = ['Admission', 'Transfer', 'Discharge']

# ── Storyline targets (DemoTenant.md section 4) ──────────────────────────────
# The generator bends its inputs to hit these; --verify measures the output
# against them and prints actual vs target.

STORYLINES = {
    # ST-1 The Thursday Ortho block
    'st1': {
        'block': 'Ortho A',
        'site': MAIN_SITE,
        'weekday': 3,                     # Thursday
        'allocated_minutes': 480,
        'trailing_block_util_pct': 58.0,  # +/- tolerance below
        'trailing_true_util_pct': 61.0,
        'forward_fill_pct_range': (35.0, 55.0),
        'release_instance_rate': 0.25,    # ~1 in 4 historical instances released
        'healthy_day_util_pct': 78.0,     # Ortho A on Monday is fine
        'spine_forward_surge_pct': 38.0,  # counterweight: Spine pipeline +38%
        'tolerance_pct': 4.0,
    },
    # ST-2 The Wednesday 5 Central peak
    'st2': {
        'unit': '5 Central',
        'weekday': 2,                     # Wednesday
        'peak_census': 30,                # of 32 staffed
        'or_attributed_share_pct': 28.0,
        'min_crunch_days_per_week': 2,
        'crunch_occupancy_pct': 92.0,
        'light_weekdays': [3, 4],         # Thu/Fri elective inpatient volume light
        'tolerance_pct': 4.0,
    },
    # ST-3 The 15:30 staffing cliff and the Friday flex-down
    'st3': {
        'site': MAIN_SITE,
        'cliff_time': '15:30',
        'cliff_weekdays': [1, 2, 3],      # Tue-Thu
        'rooms_running_at_cliff': (3, 4),
        'overtime_room_hours_per_week': (10.0, 14.0),
        'friday_peak_rooms': 6,
        # Rev 2026-08-24: the original ~12/week point target was arithmetically
        # impossible against 9 staffed rooms and a 6-room peak. The storyline is
        # the visible gap, so this is a floor, not a target.
        'friday_idle_staffed_hours_min': 25.0,
        'tolerance_pct': 20.0,
    },
    # ST-4 The teachable FCOT driver
    'st4': {
        'addon_delay_minutes': 22.0,
        'spine_delay_minutes': 16.0,
        'monday_delay_minutes': 12.0,
        'outlier_extra_delay_minutes': 20.0,
        'top_features': ['Case_AddOnCode', 'Case_SurgeonService', 'DD_DOW_Long'],
    },
    # ST-5 The robot room turnover story
    'st5': {
        'robotics_service': 'Robotics-General',
        'robotics_room_block': 'Robotics 1',
        'different_surgeon_extra_minutes': 18.0,
        'robotics_room_extra_minutes': 9.0,
    },
    # ST-7 The risk gradient
    #
    # A radar with one at-risk row reads as a demo, not a work queue. Practices
    # book at different paces, and a practice that books late looks like a
    # release candidate long before it looks like a problem — so the gradient
    # comes from booking pace on forward dates, which leaves every historical
    # utilisation figure ST-0 depends on untouched.
    'st7': {
        # The radar's own badge thresholds (client/src/pages/OpenTimeRadar.jsx).
        'badge_high': 67,
        'badge_medium': 34,
        # What the gradient actually delivers, measured on forward fill rather
        # than on the badge: a band of blocks worth a scheduler's attention,
        # spread across services and sites, over a healthy floor.
        # Measured on booked fill, which is what the radar shows: a block at
        # 40% booked two to five weeks out is worth a scheduler's attention.
        'attention_fill_pct': 40,
        'attention_rows': (5, 25),
        'attention_services': 3,
        'top_ranked_block': 'Ortho A',
        # lib/releaseRisk.js scores risk as a weighted mean of three features.
        # Two of them — trailing utilisation against a 75% target, and share of
        # block time previously released — sit near zero for any block that runs
        # at all, so risk is in practice about half the forward-fill shortfall
        # and tops out near 50. Reaching the badge's High threshold would need a
        # block that is barely booked, chronically half-used AND frequently
        # released. See the note in verify.py's ST-7 check.
        'model_ceiling_note': True,
        # Booking pace by block, as a multiplier on how far along a block's
        # forward book is at a given lead time. Below 1 books late.
        #
        # The slow end stops short of Ortho A's own fill: ST-1 requires Ortho A
        # to rank first, and the scorer ranks almost entirely on forward fill,
        # so any block that books slower than it takes the top row away. The
        # gradient therefore sits above ST-1's block rather than around it.
        'booking_pace': {
            'Ortho A':      1.00,   # ST-1: pace left alone; its light book is ST-1's own
            'Uro/Gyn':      0.98,
            'ASC Plastics': 0.87,
            'General B':    0.88,
            'Plastics':     0.90,
            'Colorectal':   0.92,
            'ENT':          0.94,
            'ASC ENT':      0.96,
            'Ortho C':      0.90,
            'General A':    0.95,
            'ASC General':  1.00,
            'Ortho B':      1.02,
            'Robotics 1':   1.05,
            'Vascular':     1.06,
            'ASC Ortho':    1.08,
            'ASC Uro/Gyn':  1.10,
            'Spine B':      1.12,
            'Spine':        1.15,   # the surging counterweight books earliest
        },
    },
    # ST-6 The Tuesday resolution — derived, never seeded. These are the
    # headroom conditions the seeder must leave in place for the ISSCM engine
    # to find the Thursday conflict and the Tuesday resolution on its own.
    'st6': {
        'resolution_weekday': 1,          # Tuesday
        'tuesday_staffing_headroom_rooms_min': 2,
        'tuesday_unit_headroom_beds_min': 5,
        'thursday_staffing_headroom_rooms_max': 0,
    },
}

# ── Background plausibility targets (ST-0) ───────────────────────────────────

BACKGROUND = {
    'primetime_util_pct':  (70.0, 75.0),
    'fcot_pct':            (68.0, 74.0),
    'median_turnover_min': 45.0,
    'addon_rate':          0.12,
    'cancellation_rate':   0.028,
    'inblock_util_pct':    (68.0, 78.0),
}

# ── Generation window ────────────────────────────────────────────────────────

HISTORY_MONTHS  = 13
FORWARD_WEEKS   = 6
DEFAULT_SEED    = 42

# US holidays with reduced elective volume, as (month, day) or rule name.
FIXED_HOLIDAYS = [(1, 1), (7, 4), (12, 24), (12, 25), (12, 31)]
HOLIDAY_VOLUME_FACTOR = 0.25

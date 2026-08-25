#!/usr/bin/env python3
"""
Shared tenant configuration for all EBM pipelines.

Each pipeline calls parse_tenant_arg() after load_dotenv() to get the
tenant config, then calls get_db_params(cfg) to retrieve DB credentials
from the appropriate env-var prefix.

Usage in a pipeline:
    load_dotenv()
    from pipeline_config import parse_tenant_arg, get_db_params
    args, cfg = parse_tenant_arg('My pipeline description')
    server, database, user, password = get_db_params(cfg)
    # cfg['output_dir']      → relative path, e.g. 'public/data/nhs'
    # cfg['hospital_filter'] → WHERE value, or None to omit the filter
    # cfg['service_line_col'] → actual DB column name for SERVICE_LINE
    # cfg['or_combo_locs']   → tuple of OR locations, or None = no filter
    # cfg['rf_exclude_locs'] → set of locations to exclude from RuleFit
"""

import os
import argparse


# ── Tenant definitions ────────────────────────────────────────────────────────
#
# IMPORTANT: a tenant's key here (and the last segment of its 'output_dir') must
# equal its TenantName from the Tenants table, lowercased with every
# non-alphanumeric character stripped -- that is exactly how routes/atlas.js
# derives the Atlas data directory:
#     'Bright Memorial Health' -> 'brightmemorialhealth'
# If these drift apart the server looks in a directory the pipelines never wrote
# and every Atlas tab renders "No Atlas data for this organization".

TENANTS = {
    'nhs': {
        # database: the analytics DB name on the Azure SQL server (not a secret).
        # Still 'Virtua' — the tenant was renamed to NHS but the underlying
        # Azure SQL database name was not changed.
        # Server/user/password come from env vars: DB_SERVER, DB_USER, DB_PASSWORD.
        'env_prefix':        '',
        'database':          'Virtua',
        'output_dir':        os.path.join('public', 'data', 'nhs'),
        'hospital_filter':   'Our Lady of Lourdes Hospital',
        'service_line_col':  'SERVICE_LINE',
        'service_line_2_col': 'SERVICE_LINE_2',
        # Turnover pipeline: locations included in combinations query
        # None = no Loc_ORGrp2 filter (use all OR locations)
        'or_combo_locs': ('MARH OR', 'MEMH OR', 'OLLH OR', 'VORH JRI OR', 'VORH OR'),
        # Turnover pipeline: locations excluded from RuleFit training
        'rf_exclude_locs': {
            'MARH ENDOSCOPY', 'MARH IR',
            'MEMH ENDOSCOPY', 'MEMH MHAS OR',
            'OLLH ENDOSCOPY',
            'VORH ENDOSCOPY',
            'VSSC ENDOSCOPY', 'VSSC OR',
        },
        # Disposition matching for do_los / do_dc / los_segments pipelines
        'dispo_selfcare_exact':      'Disch to Home or Self Care',
        'dispo_homehealth_contains': ['Home-Health Care'],
        'dispo_facility_contains':   ['SNF', 'Skilled', 'Rehab', 'LTACH'],
        'dispo_exclusions_contains': [
            'Expired', 'Left AMA', 'Court', 'Elopement', 'Transfer to Short Term',
        ],
        # Date ranges for OR pipelines
        'fcot_date_range':  ('2023-01-01', '2025-12-31'),
        'case_date_range':  ('2023-01-01', '2025-12-31'),
        # First-case identification: 'column' = Turnover_Orderofcaseinroom = 1
        'first_case_strategy': 'column',
        # CaseLogStatus filter value (NHS stores the label; OHS stores a numeric code)
        'case_posted_value': 'Posted',
        # Performance Briefs: status classification thresholds (first-match wins)
        'brief_status_rules': {
            'misaligned':      {'inblock_util_lt': 65,  'primetime_util_gt': 75},
            'under_allocated': {'inblock_util_gt': 75,  'primetime_util_gt': 75},
            'right_sized':     {'inblock_util_min': 70, 'inblock_util_max': 80,
                                'primetime_util_min': 70, 'primetime_util_max': 80},
            'over_allocated':  {'inblock_util_lt': 60,  'primetime_util_lt': 65},
        },
    },
    'ohs': {
        # Server/user/password come from OHS_-prefixed env vars: OHS_DB_SERVER, etc.
        'env_prefix':        'OHS_',
        'database':          'OHS',
        'output_dir':        os.path.join('public', 'data', 'ohs'),
        'hospital_filter':   None,      # None = omit the hospital WHERE clause
        'service_line_col':  'ENC_HOSPITALSERVICE',
        'service_line_2_col': None,     # no sub-service line for OHS
        'or_combo_locs':     None,      # None = no location filter on combinations
        'rf_exclude_locs':   set(),     # nothing to exclude
        # Disposition matching for do_los / do_dc / los_segments pipelines
        'dispo_selfcare_exact':      'Discharge to Home',
        'dispo_homehealth_contains': ['Home Health'],
        'dispo_facility_contains':   ['Skilled Nursing', 'Acute Rehab', 'LTACH', 'Intermediate Care'],
        'dispo_exclusions_contains': [
            'Expired', 'AMA', 'Law Enforcement', 'Eloped', 'Transfer to Short Term',
            'Still A Patient', 'Arrived in Error', 'Left Without Being Seen', 'Metro ED',
        ],
        # Date ranges for OR pipelines
        'fcot_date_range':  ('2023-01-01', '2025-12-31'),
        'case_date_range':  ('2023-01-01', '2025-12-31'),
        # First-case identification: 'derived' = ROW_NUMBER() CTE (Turnover_Orderofcaseinroom is NULL)
        'first_case_strategy': 'derived',
        # CaseLogStatus filter value (OHS stores '2' for Posted, not the label)
        'case_posted_value': '2',
        # Performance Briefs: status classification thresholds (first-match wins)
        'brief_status_rules': {
            'misaligned':      {'inblock_util_lt': 65,  'primetime_util_gt': 75},
            'under_allocated': {'inblock_util_gt': 75,  'primetime_util_gt': 75},
            'right_sized':     {'inblock_util_min': 70, 'inblock_util_max': 80,
                                'primetime_util_min': 70, 'primetime_util_max': 80},
            'over_allocated':  {'inblock_util_lt': 60,  'primetime_util_lt': 65},
        },
    },
    'brightmemorialhealth': {
        # Demo tenant.  TenantName is 'Bright Memorial Health', which sanitizes
        # to 'brightmemorialhealth' -- hence this key and the output_dir below.
        #
        # Same Azure SQL server as the other tenants, but a separate 'Demo'
        # database.  env_prefix 'DEMO_' is optional: get_db_params() falls back
        # to the unprefixed DB_SERVER/DB_USER/DB_PASSWORD when the DEMO_ vars
        # are absent, so no new env vars are required unless the Demo database
        # needs its own credentials.
        'env_prefix':        'DEMO_',
        'database':          'Demo',
        'output_dir':        os.path.join('public', 'data', 'brightmemorialhealth'),
        # No hospital filter: unlike Virtua/OLLH the Demo database is not known
        # to contain that hospital name, and a non-matching filter would
        # silently train every model on zero rows.  Set this once the Demo
        # data's hospital values are confirmed.
        'hospital_filter':   None,
        # Column and vocabulary settings below mirror NHS on the assumption that
        # Demo is a copy of that schema.  Verify against the real Demo database
        # before trusting pipeline output.
        'service_line_col':  'SERVICE_LINE',
        'service_line_2_col': 'SERVICE_LINE_2',
        'or_combo_locs':     None,      # None = no location filter
        'rf_exclude_locs':   set(),     # nothing to exclude
        # Disposition matching for do_los / do_dc / los_segments pipelines
        'dispo_selfcare_exact':      'Disch to Home or Self Care',
        'dispo_homehealth_contains': ['Home-Health Care'],
        'dispo_facility_contains':   ['SNF', 'Skilled', 'Rehab', 'LTACH'],
        'dispo_exclusions_contains': [
            'Expired', 'Left AMA', 'Court', 'Elopement', 'Transfer to Short Term',
        ],
        # Date ranges for OR pipelines
        'fcot_date_range':  ('2023-01-01', '2025-12-31'),
        'case_date_range':  ('2023-01-01', '2025-12-31'),
        'first_case_strategy': 'column',
        'case_posted_value': 'Posted',
        # Performance Briefs: status classification thresholds (first-match wins)
        'brief_status_rules': {
            'misaligned':      {'inblock_util_lt': 65,  'primetime_util_gt': 75},
            'under_allocated': {'inblock_util_gt': 75,  'primetime_util_gt': 75},
            'right_sized':     {'inblock_util_min': 70, 'inblock_util_max': 80,
                                'primetime_util_min': 70, 'primetime_util_max': 80},
            'over_allocated':  {'inblock_util_lt': 60,  'primetime_util_lt': 65},
        },
    },
}


# ── Helper functions ──────────────────────────────────────────────────────────

def get_tenant_config(name='nhs'):
    """Return config dict for the named tenant."""
    key = (name or 'nhs').lower().strip()
    if key not in TENANTS:
        raise ValueError(f"Unknown tenant '{key}'. Known: {list(TENANTS.keys())}")
    return TENANTS[key]


def get_db_params(cfg):
    """
    Return (server, database, user, password) for the given tenant config.

    database comes from cfg['database'] (hardcoded per-tenant, not an env var).
    server/user/password come from env vars with the tenant's prefix:
      nhs (prefix ''):     DB_SERVER, DB_USER, DB_PASSWORD
      ohs (prefix 'OHS_'): OHS_DB_SERVER (fallback DB_SERVER), etc.
    """
    p        = cfg['env_prefix']
    database = cfg['database']
    server   = os.getenv(f'{p}DB_SERVER')   or os.getenv('DB_SERVER')
    user     = os.getenv(f'{p}DB_USER')     or os.getenv('DB_USER')
    password = os.getenv(f'{p}DB_PASSWORD') or os.getenv('DB_PASSWORD')
    if not all([server, user, password]):
        hint = f"'{p}DB_SERVER/USER/PASSWORD' or " if p else ''
        raise EnvironmentError(
            f'Missing DB credentials. Set {hint}DB_SERVER/DB_USER/DB_PASSWORD in .env'
        )
    return server, database, user, password


def parse_tenant_arg(description='Run EBM pipeline for a specific tenant.'):
    """
    Parse --tenant CLI argument and return (args, cfg).

    Call this AFTER load_dotenv() so env vars are populated before get_db_params().
    """
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument(
        '--tenant',
        default='nhs',
        choices=list(TENANTS.keys()),
        help='Tenant name (default: nhs)',
    )
    args = parser.parse_args()
    cfg  = get_tenant_config(args.tenant)
    print(f"  Tenant: {args.tenant}  |  database: {cfg['database']}  |  output_dir: {cfg['output_dir']}")
    return args, cfg

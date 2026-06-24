#!/usr/bin/env python3
"""
Excess LOS EBM Pipeline
Trains four ExplainableBoostingRegressor models for excess inpatient length of stay
(actual LOS minus geometric mean LOS) at Our Lady of Lourdes Hospital.

Outputs:
    public/data/do_los_overall_ebm.json
    public/data/do_los_facility_ebm.json
    public/data/do_los_selfcare_ebm.json
    public/data/do_los_homehealth_ebm.json

Usage:
    pip install python-dotenv pyodbc interpret scikit-learn pandas numpy
    python do_los_pipeline.py
"""

import os
import json
import datetime
import time

import pandas as pd
import numpy as np
import pyodbc
from dotenv import load_dotenv
from interpret.glassbox import ExplainableBoostingRegressor
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_absolute_error, r2_score


# ── Model configuration ───────────────────────────────────────────────────────

TARGET  = 'EXCESS_DAYS'
LOS_CAP = 30  # drop rows above this many excess days

ALL_CAT_COLS = [
    'SERVICE_LINE', 'DEST_CATEGORY', 'ACCOUNT_FINANCIALCLASS', 'ENC_DISCHDISPO',
    'ENC_ADMISSIONTYPE', 'DAY_OF_WEEK', 'QUARTER', 'ADMISSION_HOUR_BUCKET',
]
ALL_NUM_COLS = ['HOSPITAL_CENSUS_7AM']

_SUB_PAIRS = [
    ('SERVICE_LINE',          'DEST_CATEGORY',          'Service × Discharging unit'),
    ('SERVICE_LINE',          'ACCOUNT_FINANCIALCLASS',  'Service × Financial class'),
    ('SERVICE_LINE',          'DAY_OF_WEEK',             'Service × Day of week'),
    ('SERVICE_LINE',          'ADMISSION_HOUR_BUCKET',   'Service × Admission hour'),
    ('DEST_CATEGORY',         'DAY_OF_WEEK',             'Unit × Day of week'),
    ('ACCOUNT_FINANCIALCLASS','DAY_OF_WEEK',             'Financial class × Day of week'),
]
_OVERALL_PAIRS = _SUB_PAIRS + [
    ('ENC_DISCHDISPO', 'SERVICE_LINE',  'Disposition × Service'),
    ('ENC_DISCHDISPO', 'DEST_CATEGORY', 'Disposition × Discharging unit'),
]

MODELS = [
    {
        'key':            'overall',
        'label':          'Overall',
        'filter_type':    None,
        'cat_cols':       ALL_CAT_COLS,
        'num_cols':       ALL_NUM_COLS,
        'interactions':   8,
        'out_file':       'do_los_overall_ebm.json',
        'target_description': (
            'Regression — predicts excess inpatient LOS (actual − geometric mean LOS) '
            'across all dispositions at OLLH'
        ),
        'combo_pairs':    _OVERALL_PAIRS,
    },
    {
        'key':             'facility',
        'label':           'Facility-bound',
        'filter_type':     'contains',
        'filter_col':      'ENC_DISCHDISPO',
        'filter_keywords': ['SNF', 'Skilled', 'Rehab', 'LTACH'],
        'cat_cols':        [c for c in ALL_CAT_COLS if c != 'ENC_DISCHDISPO'],
        'num_cols':        ALL_NUM_COLS,
        'interactions':    8,
        'out_file':        'do_los_facility_ebm.json',
        'target_description': (
            'Regression — predicts excess inpatient LOS for patients discharged '
            'to a skilled nursing facility, rehab, or LTACH at OLLH'
        ),
        'combo_pairs':     _SUB_PAIRS,
    },
    {
        'key':             'selfcare',
        'label':           'Self-care Home',
        'filter_type':     'exact',
        'filter_col':      'ENC_DISCHDISPO',
        'filter_value':    'Disch to Home or Self Care',
        'cat_cols':        [c for c in ALL_CAT_COLS if c != 'ENC_DISCHDISPO'],
        'num_cols':        ALL_NUM_COLS,
        'interactions':    8,
        'out_file':        'do_los_selfcare_ebm.json',
        'target_description': (
            'Regression — predicts excess inpatient LOS for patients discharged '
            'home (self care, no services) at OLLH'
        ),
        'combo_pairs':     _SUB_PAIRS,
    },
    {
        'key':             'homehealth',
        'label':           'Home Health',
        'filter_type':     'contains',
        'filter_col':      'ENC_DISCHDISPO',
        'filter_keywords': ['Home-Health Care'],
        'cat_cols':        [c for c in ALL_CAT_COLS if c != 'ENC_DISCHDISPO'],
        'num_cols':        ALL_NUM_COLS,
        'interactions':    8,
        'out_file':        'do_los_homehealth_ebm.json',
        'target_description': (
            'Regression — predicts excess inpatient LOS for patients discharged '
            'to home health care (related or unrelated to admission) at OLLH'
        ),
        'combo_pairs':     _SUB_PAIRS,
    },
]


# ── Step 1: Load credentials & connect ───────────────────────────────────────

print("=" * 60)
print("Step 1: Loading credentials and connecting to database...")
print("=" * 60)

load_dotenv()

server   = os.getenv("DB_SERVER")
database = os.getenv("DB_DATABASE")
user     = os.getenv("DB_USER")
password = os.getenv("DB_PASSWORD")

if not all([server, database, user, password]):
    raise EnvironmentError("Missing one or more DB_* variables in .env")

conn_str = (
    f"DRIVER={{ODBC Driver 17 for SQL Server}};"
    f"SERVER={server};"
    f"DATABASE={database};"
    f"UID={user};"
    f"PWD={password}"
)


def connect_with_retry(max_attempts=3, delay=10):
    """Connect to SQL Server, retrying on Azure 08S01 communication errors."""
    for attempt in range(1, max_attempts + 1):
        try:
            conn = pyodbc.connect(conn_str, timeout=30)
            return conn
        except pyodbc.OperationalError as exc:
            if '08S01' in str(exc) and attempt < max_attempts:
                print(f"  08S01 communication error (attempt {attempt}/{max_attempts}), "
                      f"retrying in {delay}s…")
                time.sleep(delay)
            else:
                raise


def run_query_with_retry(query, max_attempts=3, delay=10):
    """Execute a query, reconnecting on Azure 08S01 communication errors."""
    for attempt in range(1, max_attempts + 1):
        try:
            conn = connect_with_retry()
            df = pd.read_sql(query, conn)
            conn.close()
            return df
        except pyodbc.OperationalError as exc:
            if '08S01' in str(exc) and attempt < max_attempts:
                print(f"  08S01 query error (attempt {attempt}/{max_attempts}), "
                      f"retrying in {delay}s…")
                time.sleep(delay)
            else:
                raise


conn = connect_with_retry()
conn.close()
print(f"  Connected to {server} / {database}")


# ── Step 2: Pull training data ────────────────────────────────────────────────

print()
print("=" * 60)
print("Step 2: Pulling excess LOS training data...")
print("=" * 60)

QUERY = """
SELECT
  e.ACCOUNT_IPLOS,
  e.DRG_FINALDRGGMLOS,
  e.SERVICE_LINE,
  e.ACCOUNT_FINANCIALCLASS,
  e.ENC_DISCHDISPO,
  e.ENC_ADMISSIONTYPE,
  DATENAME(WEEKDAY, e.TIME_HOSPADMISSION)          AS DAY_OF_WEEK,
  CASE
    WHEN MONTH(e.TIME_HOSPADMISSION) IN (1,2,3) THEN 'Q1'
    WHEN MONTH(e.TIME_HOSPADMISSION) IN (4,5,6) THEN 'Q2'
    WHEN MONTH(e.TIME_HOSPADMISSION) IN (7,8,9) THEN 'Q3'
    ELSE 'Q4'
  END                                              AS QUARTER,
  CASE
    WHEN DATEPART(HOUR, e.TIME_HOSPADMISSION) BETWEEN  6 AND 11 THEN 'Morning (6a-12p)'
    WHEN DATEPART(HOUR, e.TIME_HOSPADMISSION) BETWEEN 12 AND 16 THEN 'Afternoon (12p-5p)'
    WHEN DATEPART(HOUR, e.TIME_HOSPADMISSION) BETWEEN 17 AND 21 THEN 'Evening (5p-10p)'
    ELSE 'Night (10p-6a)'
  END                                              AS ADMISSION_HOUR_BUCKET,
  CASE
    WHEN e.DEP_LASTDEPT LIKE '%2E%' OR e.DEP_LASTDEPT LIKE '%2W%' THEN '2nd Floor'
    WHEN e.DEP_LASTDEPT LIKE '%3E%' OR e.DEP_LASTDEPT LIKE '%3W%' THEN '3rd Floor'
    WHEN e.DEP_LASTDEPT LIKE '%5W%' OR e.DEP_LASTDEPT LIKE '%6N%' THEN '6N/5W'
    WHEN e.DEP_LASTDEPT LIKE '%ICU%' OR e.DEP_LASTDEPT LIKE '%CORONARY CARE%' THEN 'ICU'
    WHEN e.DEP_LASTDEPT LIKE '%PCU%' THEN 'PCU'
    WHEN e.DEP_LASTDEPT LIKE '%MOTHER BABY%' OR e.DEP_LASTDEPT LIKE '%LABOR%'
      OR e.DEP_LASTDEPT LIKE '%SPECIAL CARE NURS%'
      OR e.DEP_LASTDEPT LIKE '%NEWBORN%' THEN 'Maternal Child Health'
    WHEN e.DEP_LASTDEPT LIKE '%HOSPITAL AT HOME%' THEN 'Hospital at Home'
    WHEN e.DEP_LASTDEPT LIKE '%IP REHAB%' THEN 'Rehab'
    ELSE 'Other'
  END                                              AS DEST_CATEGORY,
  o.HOSPITAL_CENSUS_7AM
FROM DS_Encounters e
LEFT JOIN (
  SELECT
    CAST(Datehour AS DATE)  AS occ_date,
    SUM(Occupancy)          AS HOSPITAL_CENSUS_7AM
  FROM DS_Occupancy
  WHERE DEP_Hospital = 'Our Lady of Lourdes Hospital'
    AND DATEPART(HOUR, Datehour) = 7
    AND StaffedBeds > 0
  GROUP BY CAST(Datehour AS DATE)
) o ON o.occ_date = CAST(e.TIME_HOSPADMISSION AS DATE)
WHERE e.DEP_LASTDEPTHOSPITAL = 'Our Lady of Lourdes Hospital'
  AND e.BEDDED = 'Y'
  AND e.TIME_HOSPADMISSION >= '2025-01-01'
  AND e.ACCOUNT_IPLOS IS NOT NULL
  AND e.DRG_FINALDRGGMLOS IS NOT NULL
  AND e.SERVICE_LINE IS NOT NULL
  AND e.SERVICE_LINE NOT IN (
    'W&C Obstetrics', 'W&C Neonates', 'W&C Newborns', 'W&C Gynecology',
    'No DRG Match', 'NULL', 'Pediatrics', 'Behavioral Health'
  )
"""

df_raw = run_query_with_retry(QUERY)
print(f"  Pulled {len(df_raw):,} rows × {df_raw.shape[1]} columns")


# ── Step 3: Compute target and preprocess ─────────────────────────────────────

print()
print("=" * 60)
print("Step 3: Computing EXCESS_DAYS and preprocessing...")
print("=" * 60)

# Compute target: actual LOS minus geometric mean LOS
df_raw[TARGET] = df_raw['ACCOUNT_IPLOS'] - df_raw['DRG_FINALDRGGMLOS']
print(f"  EXCESS_DAYS computed. Raw range: [{df_raw[TARGET].min():.2f}, {df_raw[TARGET].max():.2f}]")
print(f"  Raw mean: {df_raw[TARGET].mean():.2f}  std: {df_raw[TARGET].std():.2f}")
print(f"  Negative (faster than expected): {(df_raw[TARGET] < 0).sum():,}  "
      f"({(df_raw[TARGET] < 0).mean()*100:.1f}%)")
print(f"  Positive (slower than expected): {(df_raw[TARGET] > 0).sum():,}  "
      f"({(df_raw[TARGET] > 0).mean()*100:.1f}%)")

# Drop rows above cap — negative values are informative, keep them
before = len(df_raw)
df_raw = df_raw[df_raw[TARGET] <= LOS_CAP].reset_index(drop=True)
print(f"  Dropped {before - len(df_raw):,} rows with EXCESS_DAYS > {LOS_CAP}")

# Drop raw LOS columns (target is now EXCESS_DAYS)
df_raw = df_raw.drop(columns=['ACCOUNT_IPLOS', 'DRG_FINALDRGGMLOS'])

# Print disposition breakdown (before any model-level filtering)
print()
print("  Distinct ENC_DISCHDISPO values:")
for val, cnt in df_raw['ENC_DISCHDISPO'].value_counts().items():
    print(f"    {cnt:>6,}  {val}")

# Categorical null fills
print()
null_fills = {
    'SERVICE_LINE':          'Unknown',
    'ACCOUNT_FINANCIALCLASS':'Unknown',
    'ENC_ADMISSIONTYPE':     'Unknown',
    'DAY_OF_WEEK':           'Unknown',
    'DEST_CATEGORY':         'Other',
}
for col, fill_val in null_fills.items():
    n = int(df_raw[col].isna().sum())
    if n:
        print(f"  {col}: filled {n:,} nulls with '{fill_val}'")
    df_raw[col] = df_raw[col].fillna(fill_val).astype(str)

# Handle string 'NULL' in ENC_DISCHDISPO (already excluded via WHERE clause, guard anyway)
df_raw['ENC_DISCHDISPO'] = (
    df_raw['ENC_DISCHDISPO']
    .fillna('Unknown')
    .replace({'NULL': 'Unknown', 'None': 'Unknown', '': 'Unknown'})
    .astype(str)
)

# Numeric null fills
for col in ['HOSPITAL_CENSUS_7AM']:
    n = int(df_raw[col].isna().sum())
    if n:
        med = df_raw[col].median()
        print(f"  {col}: filled {n:,} nulls with median ({med:.2f})")
        df_raw[col] = df_raw[col].fillna(med)

# ── Exclusion 1: Non-discharge outcomes ──────────────────────────────────────
# These aren't discharge-efficiency opportunities and shouldn't inflate headlines.
print()
NON_DISCHARGE_TERMS = [
    'Expired', 'Left AMA', 'Court/Law Enforcement', 'Elopement',
    'Transfer to Short Term Hospital',
]
non_dc_pattern = '|'.join(NON_DISCHARGE_TERMS)
non_dc_mask    = df_raw['ENC_DISCHDISPO'].str.contains(non_dc_pattern, case=False, na=False)
print(f"  Excluding non-discharge outcomes ({non_dc_mask.sum():,} rows):")
for term in NON_DISCHARGE_TERMS:
    cnt = df_raw['ENC_DISCHDISPO'].str.contains(term, case=False, na=False).sum()
    if cnt:
        print(f"    {cnt:>6,}  {term}")
before = len(df_raw)
df_raw = df_raw[~non_dc_mask].reset_index(drop=True)
print(f"  After exclusion: {before:,} → {len(df_raw):,} rows")

# ── Exclusion 2: Rehab-unit discharges ───────────────────────────────────────
# DEST_CATEGORY = 'Rehab': ACCOUNT_IPLOS includes inpatient rehab days while
# GMLOS expects acute-only, so excess is partly structural, not operational.
# Capture summary stats first, then remove from all three models.
rehab_df = df_raw[df_raw['DEST_CATEGORY'] == 'Rehab'].copy()
_rehab_pos = rehab_df[TARGET] > 0
rehab_unit_summary = {
    'n_cases':          int(len(rehab_df)),
    'mean_excess':      round(float(rehab_df[TARGET].mean()), 2) if len(rehab_df) else None,
    'median_excess':    round(float(rehab_df[TARGET].median()), 2) if len(rehab_df) else None,
    'total_excess_days': round(float(rehab_df.loc[_rehab_pos, TARGET].sum()), 0) if len(rehab_df) else 0.0,
    'note': (
        'Excluded from models — ACCOUNT_IPLOS includes inpatient rehab days '
        'while DRG GMLOS reflects acute-only expectations.'
    ),
}
print()
print(f"  Rehab-unit discharge summary (excluded from all models):")
print(f"    n_cases          : {rehab_unit_summary['n_cases']:,}")
print(f"    mean_excess      : {rehab_unit_summary['mean_excess']} days")
print(f"    median_excess    : {rehab_unit_summary['median_excess']} days")
print(f"    total_excess_days: {rehab_unit_summary['total_excess_days']:,.0f}")

before = len(df_raw)
df_raw = df_raw[df_raw['DEST_CATEGORY'] != 'Rehab'].reset_index(drop=True)
print(f"  Removed Rehab rows: {before:,} → {len(df_raw):,} rows")

print(f"\n  Final base dataset: {len(df_raw):,} rows")


# ── Shared helper functions ───────────────────────────────────────────────────

def _dict_get(d, *keys, default=None):
    if not isinstance(d, dict):
        return default
    for k in keys:
        if k in d and d[k] is not None:
            return d[k]
    return default


def _axis_x(raw, n_scores):
    vals = [float(v) for v in raw]
    if len(vals) == n_scores + 1:
        vals = [(vals[j] + vals[j + 1]) / 2 for j in range(n_scores)]
    return vals


def _is_2d(arr):
    if arr is None or (hasattr(arr, '__len__') and len(arr) == 0):
        return False
    if hasattr(arr, 'ndim'):
        return arr.ndim == 2
    if isinstance(arr[0], (list, tuple)):
        return True
    return False


def build_Xy(df_in, model_cfg):
    df       = df_in.copy()
    cat_cols = model_cfg['cat_cols']
    num_cols = model_cfg['num_cols']

    # Filter to disposition subset if needed
    if model_cfg['filter_type'] == 'exact':
        val    = model_cfg['filter_value']
        before = len(df)
        mask   = df[model_cfg['filter_col']] == val
        df     = df[mask].reset_index(drop=True)
        print(f"  Filtered {model_cfg['filter_col']} == '{val}': {before:,} → {len(df):,} rows")
    elif model_cfg['filter_type'] == 'contains':
        pattern = '|'.join(model_cfg['filter_keywords'])
        before  = len(df)
        mask    = df[model_cfg['filter_col']].str.contains(pattern, case=False, na=False)
        df      = df[mask].reset_index(drop=True)
        print(f"  Filtered {model_cfg['filter_col']} contains "
              f"{model_cfg['filter_keywords']}: {before:,} → {len(df):,} rows")
        print(f"  Matching dispositions:")
        for val, cnt in df[model_cfg['filter_col']].value_counts().items():
            print(f"    {cnt:>6,}  {val}")

    y = df[TARGET].astype(float)
    print(f"  Target: mean={y.mean():.2f} days  std={y.std():.2f}  "
          f"range=[{y.min():.1f}, {y.max():.1f}]")

    present_cat = [c for c in cat_cols if c in df.columns]
    present_num = [c for c in num_cols if c in df.columns]
    X = df[present_cat + present_num].copy()

    # Coerce and fill categoricals
    for col in present_cat:
        X[col] = X[col].astype(str).replace(
            {'nan': 'Unknown', 'None': 'Unknown', 'NaT': 'Unknown', '': 'Unknown'}
        )

    # Coerce numerics
    for col in present_num:
        X[col] = pd.to_numeric(X[col], errors='coerce')
        n_miss  = int(X[col].isna().sum())
        if n_miss:
            med = X[col].median()
            print(f"    {col}: filled {n_miss:,} remaining nulls with median ({med:.4f})")
            X[col] = X[col].fillna(med)

    # Encode categoricals: category → integer code, store mapping
    cat_mappings = {}
    for col in present_cat:
        X[col] = X[col].astype('category')
        cat_mappings[col] = {int(code): str(label)
                             for code, label in enumerate(X[col].cat.categories)}
        X[col] = X[col].cat.codes.astype(float)

    print(f"  Final shape: {X.shape}  ({len(present_num)} numeric, {len(present_cat)} categorical)")
    return X, y, present_num, present_cat, cat_mappings, df


def extract_explanations(ebm, X_train, cat_cols, cat_mappings):
    ebm_global  = ebm.explain_global()
    global_data = ebm_global.data(-1)

    print(f"  DEBUG type(global_data) = {type(global_data)}")
    if isinstance(global_data, dict):
        print(f"  DEBUG global_data keys  = {list(global_data.keys())}")

    # Resolve feature names
    expl_names = _dict_get(global_data, 'names', 'features', 'feature_names')
    if expl_names is None:
        if hasattr(ebm, 'term_names_'):
            expl_names = list(ebm.term_names_)
            print("  Using ebm.term_names_ for feature names")
        elif hasattr(ebm, 'feature_names_in_'):
            expl_names = list(ebm.feature_names_in_)
            print("  Using ebm.feature_names_in_ for feature names")
        else:
            expl_names = list(X_train.columns)
            print("  Falling back to X_train.columns for feature names")
    else:
        key = next(k for k in ('names', 'features', 'feature_names') if k in global_data)
        print(f"  Got feature names from global_data['{key}']")
    expl_names = list(expl_names)

    # Resolve importance scores
    expl_scores = _dict_get(global_data, 'scores', 'importances', 'importance', 'values')
    if expl_scores is None:
        if hasattr(ebm, 'term_importances') and callable(ebm.term_importances):
            expl_scores = list(ebm.term_importances())
            print("  Using ebm.term_importances() for importance scores")
        elif hasattr(ebm, 'feature_importances_'):
            expl_scores = list(ebm.feature_importances_)
            print("  Using ebm.feature_importances_ for importance scores")
        else:
            expl_scores = [1.0] * len(expl_names)
            print("  WARNING: could not extract importance scores — defaulting to 1.0")
    else:
        key = next(k for k in ('scores', 'importances', 'importance', 'values') if k in global_data)
        print(f"  Got importance scores from global_data['{key}']")
    expl_scores = [float(s) for s in expl_scores]

    ranked_pairs = sorted(
        zip(expl_names, expl_scores), key=lambda kv: abs(kv[1]), reverse=True
    )
    feature_importance = [
        {'feature': name, 'importance_score': float(score), 'rank': rank + 1}
        for rank, (name, score) in enumerate(ranked_pairs)
    ]
    print("  Top 10 features by importance:")
    for item in feature_importance[:10]:
        print(f"    [{item['rank']:>2}] {item['feature']:40s}  {item['importance_score']:.4f}")

    cat_cols_set    = set(cat_cols)
    shape_functions = []
    interactions    = []

    for i, feat_name in enumerate(expl_names):
        feat_data = ebm_global.data(i)

        if i == 0:
            print(f"\n  DEBUG feat[0] ('{feat_name}'): type={type(feat_data)}")
            if isinstance(feat_data, dict):
                print(f"  DEBUG feat[0] keys: {list(feat_data.keys())}")

        raw_x = _dict_get(feat_data, 'names', 'x', 'bins', 'values', default=[])
        raw_y = _dict_get(feat_data, 'scores', 'y', 'values', default=[])
        is_interaction = (' & ' in str(feat_name)) or _is_2d(raw_y)

        if is_interaction:
            parts = str(feat_name).split(' & ')
            feat1 = parts[0].strip() if len(parts) >= 2 else feat_name
            feat2 = parts[1].strip() if len(parts) >= 2 else feat_name
            raw_ax1 = raw_x[0] if (raw_x is not None and len(raw_x) >= 2) else []
            raw_ax2 = raw_x[1] if (raw_x is not None and len(raw_x) >= 2) else []
            scores_matrix = [[float(v) for v in row] for row in raw_y]
            n_rows = len(scores_matrix)
            n_cols = len(scores_matrix[0]) if n_rows > 0 else 0
            interactions.append({
                'feature_1':     feat1,
                'feature_2':     feat2,
                'x_values_1':    _axis_x(raw_ax1, n_rows),
                'x_labels_1':    [],
                'x_values_2':    _axis_x(raw_ax2, n_cols),
                'x_labels_2':    [],
                'scores_matrix': scores_matrix,
            })
        else:
            if raw_y is not None and len(raw_y) > 0 and isinstance(raw_y[0], (list, tuple)):
                raw_y = raw_y[0]
            y_scores = [float(v) for v in raw_y]
            if feat_name in cat_cols_set:
                x_values = _axis_x(raw_x, len(y_scores))
                mapping  = cat_mappings[feat_name]
                shape_functions.append({
                    'feature':       feat_name,
                    'type':          'categorical',
                    'x_values':      x_values,
                    'y_scores':      y_scores,
                    'x_labels':      [mapping.get(int(round(v)), str(v)) for v in x_values],
                    'code_to_label': {str(k): v for k, v in mapping.items()},
                })
            else:
                shape_functions.append({
                    'feature':  feat_name,
                    'type':     'continuous',
                    'x_values': _axis_x(raw_x, len(y_scores)),
                    'y_scores': y_scores,
                    'x_labels': [],
                })

    # Back-fill interaction axis labels from completed shape functions
    label_lookup = {sf['feature']: sf.get('x_labels', []) for sf in shape_functions}
    for ix in interactions:
        ix['x_labels_1'] = label_lookup.get(ix['feature_1'], [])
        ix['x_labels_2'] = label_lookup.get(ix['feature_2'], [])

    print(f"\n  Main effect shape functions : {len(shape_functions)}")
    print(f"  Interaction terms extracted : {len(interactions)}")
    return feature_importance, shape_functions, interactions


def compute_combinations(df_filtered, pairs, min_cnt=150, top_per_pair=7):
    """
    For each categorical pair, compute avg_excess, n_cases, total_excess_days.
    Keep top top_per_pair combinations per pair, ranked by total_excess_days.
    Return all kept rows, globally sorted by total_excess_days descending.
    Only includes combinations above the overall mean (above_mean > 0).
    """
    system_mean = df_filtered[TARGET].mean()
    all_rows = []

    for feat1, feat2, sub_label in pairs:
        if feat1 not in df_filtered.columns or feat2 not in df_filtered.columns:
            continue
        grp = df_filtered.groupby([feat1, feat2]).agg(
            n_cases    = (TARGET, 'count'),
            avg_excess = (TARGET, 'mean'),
        ).reset_index()
        grp = grp[grp['n_cases'] >= min_cnt].copy()
        grp['total_excess_days'] = grp['avg_excess'] * grp['n_cases']
        grp['above_mean']        = (grp['avg_excess'] - system_mean).round(2)
        # Only surface above-average combinations
        grp = grp[grp['above_mean'] > 0]
        # Top N per pair type by total impact
        grp = grp.nlargest(top_per_pair, 'total_excess_days')
        for _, row in grp.iterrows():
            all_rows.append({
                'type':              f"{feat1}_{feat2}",
                'label':             str(row[feat1]),
                'sub':               f"{str(row[feat2])} — {sub_label}",
                'n_cases':           int(row['n_cases']),
                'avg_excess':        round(float(row['avg_excess']), 2),
                'above_mean':        round(float(row['above_mean']), 2),
                'total_excess_days': int(round(float(row['total_excess_days']))),
            })

    all_rows.sort(key=lambda r: r['total_excess_days'], reverse=True)
    return all_rows


# ── Output directory ──────────────────────────────────────────────────────────

script_dir = os.path.dirname(os.path.abspath(__file__))
out_dir    = os.path.join(script_dir, 'public', 'data')
os.makedirs(out_dir, exist_ok=True)

model_summaries = []


# ── Steps 4–8: Train and save each model ─────────────────────────────────────

for model_cfg in MODELS:
    label = model_cfg['label']

    print()
    print("=" * 60)
    print(f"  MODEL: {label}")
    print("=" * 60)

    # ── Step 4: Build features and train ─────────────────────────────────────

    print()
    print(f"Step 4 [{label}]: Building features and training model...")

    X, y, num_cols, cat_cols, cat_mappings, df_filtered = build_Xy(df_raw, model_cfg)

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42
    )
    print(f"  Train: {len(X_train):,}  |  Test: {len(X_test):,}")

    ebm = ExplainableBoostingRegressor(
        interactions=model_cfg['interactions'], random_state=42
    )
    print(f"  Pairwise interactions: auto-detecting top {model_cfg['interactions']}")
    print("  Fitting (this may take a few minutes)...")
    ebm.fit(X_train, y_train)
    print("  Training complete.")

    # ── Step 5: Extract importances, shape functions, interactions ────────────

    print()
    print(f"Step 5 [{label}]: Extracting importances and shape functions...")

    feature_importance, shape_functions, interactions = extract_explanations(
        ebm, X_train, cat_cols, cat_mappings
    )

    # ── Step 6: Evaluate ──────────────────────────────────────────────────────

    print()
    print(f"Step 6 [{label}]: Evaluating on held-out test set...")

    y_pred = ebm.predict(X_test)
    mae    = float(mean_absolute_error(y_test, y_pred))
    r2     = float(r2_score(y_test, y_pred))
    print(f"  MAE : {mae:.4f} days")
    print(f"  R²  : {r2:.4f}")

    # ── Step 7: Compute LOS-specific summary statistics ───────────────────────

    print()
    print(f"Step 7 [{label}]: Computing LOS summary statistics...")

    system_mean   = round(float(df_filtered[TARGET].mean()), 2)
    system_median = round(float(df_filtered[TARGET].median()), 2)

    # total_excess_days: sum of positive excess only (uncapped sum within capped dataset)
    positive_mask       = df_filtered[TARGET] > 0
    total_excess_days   = float(df_filtered.loc[positive_mask, TARGET].sum())
    effective_beds      = round(total_excess_days / 365, 1)
    pct_with_excess     = round(float(positive_mask.mean()) * 100, 1)

    print(f"  System mean excess LOS  : {system_mean:.2f} days")
    print(f"  System median excess LOS: {system_median:.2f} days")
    print(f"  Total excess days       : {total_excess_days:,.0f}")
    print(f"  Effective beds occupied : {effective_beds:.1f}")
    print(f"  % patients with excess  : {pct_with_excess:.1f}%")

    # ── Step 8a: Save initial JSON ────────────────────────────────────────────

    print()
    print(f"Step 8a [{label}]: Saving to public/data/{model_cfg['out_file']}...")

    output = {
        'model_name':           'ExplainableBoostingRegressor',
        'trained_at':           datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'target_description':   model_cfg['target_description'],
        'hospital':             'Our Lady of Lourdes Hospital',
        'disposition':          model_cfg['label'],
        'system_mean':          system_mean,
        'system_median':        system_median,
        'n_training_samples':   int(len(X_train)),
        'mae':                  round(mae, 4),
        'total_excess_days':    round(total_excess_days, 0),
        'effective_beds':       effective_beds,
        'pct_patients_with_excess': pct_with_excess,
        'feature_importance':   feature_importance,
        'shape_functions':      shape_functions,
        'interactions':         interactions,
        'model_stats': {
            'mae': round(mae, 4),
            'r2':  round(r2, 4),
        },
    }

    out_path = os.path.join(out_dir, model_cfg['out_file'])
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(output, f, indent=2, allow_nan=False)

    size_kb = os.path.getsize(out_path) / 1024
    print(f"  Saved: {out_path}  ({size_kb:.1f} KB)")

    # ── Step 8b: Compute worst-performing combinations ────────────────────────

    print()
    print(f"Step 8b [{label}]: Computing top combinations (ranked by total excess days)...")

    combinations = compute_combinations(
        df_filtered, model_cfg['combo_pairs'], min_cnt=150, top_per_pair=7
    )
    print(f"  system_mean: {system_mean} days")
    print(f"  Total combinations found: {len(combinations)}")
    print(f"  Top 3 by total excess days:")
    for row in combinations[:3]:
        print(f"    {row['label']:30s}  {row['sub']:50s}  "
              f"avg={row['avg_excess']:.2f}d  "
              f"above_mean=+{row['above_mean']:.2f}d  "
              f"total={row['total_excess_days']:,}d  "
              f"n={row['n_cases']:,}")

    output['combinations'] = combinations
    if model_cfg['key'] == 'overall':
        output['rehab_unit_summary'] = rehab_unit_summary
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(output, f, indent=2, allow_nan=False)

    size_kb = os.path.getsize(out_path) / 1024
    print(f"  Updated JSON: {out_path}  ({size_kb:.1f} KB)")

    model_summaries.append({
        'key':                model_cfg['key'],
        'label':              label,
        'train_rows':         len(X_train),
        'test_rows':          len(X_test),
        'shape_fns':          len(shape_functions),
        'interactions':       len(interactions),
        'mae':                mae,
        'r2':                 r2,
        'system_mean':        system_mean,
        'total_excess_days':  total_excess_days,
        'effective_beds':     effective_beds,
        'pct_with_excess':    pct_with_excess,
    })


# ── Final summary ─────────────────────────────────────────────────────────────

print()
print("=" * 60)
print("Done. Summary:")
print(f"  {'Model':<16}  {'Train':>7}  {'Test':>6}  {'MAE':>7}  {'R²':>7}  "
      f"{'Mean Exc':>9}  {'Eff.Beds':>9}  {'%Excess':>8}")
print(f"  {'-'*16}  {'-'*7}  {'-'*6}  {'-'*7}  {'-'*7}  {'-'*9}  {'-'*9}  {'-'*8}")
for s in model_summaries:
    print(f"  {s['label']:<16}  {s['train_rows']:>7,}  {s['test_rows']:>6,}"
          f"  {s['mae']:>6.3f}d  {s['r2']:>7.4f}"
          f"  {s['system_mean']:>+8.2f}d"
          f"  {s['effective_beds']:>9.1f}  {s['pct_with_excess']:>7.1f}%")
print("=" * 60)

# Self-care vs Home Health comparison
_sc = next((s for s in model_summaries if s['key'] == 'selfcare'),  None)
_hh = next((s for s in model_summaries if s['key'] == 'homehealth'), None)
if _sc and _hh:
    diff = _hh['system_mean'] - _sc['system_mean']
    print()
    print("  Self-care vs Home Health mean excess comparison:")
    print(f"    Self-care Home : {_sc['system_mean']:+.2f}d  ({_sc['train_rows']:,} train cases)")
    print(f"    Home Health    : {_hh['system_mean']:+.2f}d  ({_hh['train_rows']:,} train cases)")
    print(f"    Difference     : {diff:+.2f}d  (home-health minus self-care)")
    print()

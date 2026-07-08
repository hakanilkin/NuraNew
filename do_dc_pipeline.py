#!/usr/bin/env python3
"""
DO→DC EBM Pipeline
Trains one overall and three disposition-specific ExplainableBoostingRegressor models
for discharge order to departure time (DO→DC) at Our Lady of Lourdes Hospital.

Outputs:
    public/data/do_dc_overall_ebm.json
    public/data/do_dc_home_ebm.json
    public/data/do_dc_snf_ebm.json
    public/data/do_dc_hh_ebm.json

Usage:
    pip install python-dotenv pyodbc interpret scikit-learn pandas numpy
    python do_dc_pipeline.py
"""

import os
import json
import math
import datetime

import pandas as pd
import numpy as np
import pyodbc
from dotenv import load_dotenv
from interpret.glassbox import ExplainableBoostingRegressor
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_absolute_error, r2_score


# ── Model configuration ───────────────────────────────────────────────────────

TARGET = 'DISCHORDER_DISCHARGE'

ALL_CAT_COLS = [
    'ENC_DISCHDISPO', 'DEST_CATEGORY', 'DAY_OF_WEEK', 'QUARTER',
    'ACCOUNT_FINANCIALCLASS', 'DRG_FINALDRGMDC', 'ENC_PATCLASSBASE',
]
ALL_NUM_COLS = ['HOSPITAL_CENSUS_7AM']

_SUB_PAIRS = [
    ('DEST_CATEGORY',        'ACCOUNT_FINANCIALCLASS', 'Unit × Financial class'),
    ('DEST_CATEGORY',        'DAY_OF_WEEK',            'Unit × Day of week'),
    ('DEST_CATEGORY',        'DRG_FINALDRGMDC',        'Unit × DRG MDC'),
    ('DEST_CATEGORY',        'QUARTER',                'Unit × Quarter'),
    ('ACCOUNT_FINANCIALCLASS', 'DAY_OF_WEEK',          'Financial class × Day of week'),
    ('ACCOUNT_FINANCIALCLASS', 'QUARTER',              'Financial class × Quarter'),
    ('DAY_OF_WEEK',          'QUARTER',                'Day of week × Quarter'),
]
_OVERALL_PAIRS = [
    ('ENC_DISCHDISPO', 'DEST_CATEGORY',          'Disposition × Unit'),
    ('ENC_DISCHDISPO', 'ACCOUNT_FINANCIALCLASS', 'Disposition × Financial class'),
    ('ENC_DISCHDISPO', 'DAY_OF_WEEK',            'Disposition × Day of week'),
]

# MODELS is defined after Step 1 so it can reference cfg (tenant disposition config).


def _sanitize(o):
    """Recursively replace float NaN/inf/-inf with None before JSON serialisation."""
    if isinstance(o, dict):  return {k: _sanitize(v) for k, v in o.items()}
    if isinstance(o, list):  return [_sanitize(v) for v in o]
    if isinstance(o, float) and (math.isnan(o) or math.isinf(o)): return None
    return o


# ── Step 1: Load credentials & connect ───────────────────────────────────────

print("=" * 60)
print("Step 1: Loading credentials and connecting to database...")
print("=" * 60)

load_dotenv()
from pipeline_config import parse_tenant_arg, get_db_params  # noqa: E402

args, cfg = parse_tenant_arg('DO→DC EBM pipeline — discharge order to departure time model')
server, database, user, password = get_db_params(cfg)
hospital_filter = cfg['hospital_filter']

MODELS = [
    {
        'key':            'overall',
        'disposition':    'All',
        'filter_type':    None,
        'max_target':     4320,
        'cat_cols':       ALL_CAT_COLS,
        'num_cols':       ALL_NUM_COLS,
        'interactions':   10,
        'out_file':       'do_dc_overall_ebm.json',
        'target_description': (
            'Regression — predicts minutes from discharge order to patient departure '
            'across all dispositions'
        ),
        'benchmarks':     {'home': 180, 'hh': 240, 'snf': 400},
        'combo_pairs':    _OVERALL_PAIRS,
        'combo_benchmark': 400,
    },
    {
        'key':            'home',
        'disposition':    'Home',
        'filter_type':    'exact',
        'filter_value':   cfg['dispo_selfcare_exact'],
        'max_target':     720,
        'cat_cols':       [c for c in ALL_CAT_COLS if c != 'ENC_DISCHDISPO'],
        'num_cols':       ALL_NUM_COLS,
        'interactions':   8,
        'out_file':       'do_dc_home_ebm.json',
        'target_description': (
            'Regression — predicts minutes from discharge order to departure '
            'for home-bound patients'
        ),
        'benchmarks':     None,
        'combo_pairs':    _SUB_PAIRS,
        'combo_benchmark': 180,
    },
    {
        'key':             'snf',
        'disposition':     'SNF',
        'filter_type':     'contains',
        'filter_keywords': cfg['dispo_facility_contains'],
        'max_target':      4320,
        'cat_cols':        [c for c in ALL_CAT_COLS if c != 'ENC_DISCHDISPO'],
        'num_cols':        ALL_NUM_COLS,
        'interactions':    8,
        'out_file':        'do_dc_snf_ebm.json',
        'target_description': (
            'Regression — predicts minutes from discharge order to departure '
            'for facility-bound patients (SNF, rehab, LTACH)'
        ),
        'benchmarks':     None,
        'combo_pairs':    _SUB_PAIRS,
        'combo_benchmark': 400,
    },
    {
        'key':             'hh',
        'disposition':     'HomeHealth',
        'filter_type':     'contains',
        'filter_keywords': cfg['dispo_homehealth_contains'],
        'max_target':      720,
        'cat_cols':        [c for c in ALL_CAT_COLS if c != 'ENC_DISCHDISPO'],
        'num_cols':        ALL_NUM_COLS,
        'interactions':    8,
        'out_file':        'do_dc_hh_ebm.json',
        'target_description': (
            'Regression — predicts minutes from discharge order to departure '
            'for home health patients'
        ),
        'benchmarks':     None,
        'combo_pairs':    _SUB_PAIRS,
        'combo_benchmark': 240,
    },
]

conn_str = (
    f"DRIVER={{ODBC Driver 17 for SQL Server}};"
    f"SERVER={server};"
    f"DATABASE={database};"
    f"UID={user};"
    f"PWD={password}"
)

conn = pyodbc.connect(conn_str, timeout=30)
print(f"  Connected to {server} / {database}")


# ── Step 2: Pull training data ────────────────────────────────────────────────

print()
print("=" * 60)
print("Step 2: Pulling DO→DC training data...")
print("=" * 60)

_occ_hosp_clause = f"\n    AND DEP_Hospital = '{hospital_filter}'" if hospital_filter else ''
_enc_hosp_clause = f"\n  AND e.DEP_LASTDEPTHOSPITAL = '{hospital_filter}'" if hospital_filter else ''

# Build disposition SQL pre-filter from tenant config (server-side config, not user input)
_dispo_parts = (
    [f"e.ENC_DISCHDISPO = '{cfg['dispo_selfcare_exact']}'"]
    + [f"e.ENC_DISCHDISPO LIKE '%{kw}%'" for kw in cfg['dispo_homehealth_contains']]
    + [f"e.ENC_DISCHDISPO LIKE '%{kw}%'" for kw in cfg['dispo_facility_contains']]
)
_dispo_where = '  AND (\n    ' + '\n    OR '.join(_dispo_parts) + '\n  )'

QUERY = f"""
SELECT
  e.EPICCSN,
  e.ENC_DISCHDISPO,
  e.DISCHORDER_DISCHARGE,
  e.ACCOUNT_FINANCIALCLASS,
  e.DRG_FINALDRGMDC,
  e.ENC_PATCLASSBASE,
  DATENAME(WEEKDAY, e.DISCHORDER_ORDERTIME) AS DAY_OF_WEEK,
  CASE
    WHEN MONTH(e.DISCHORDER_ORDERTIME) IN (1,2,3) THEN 'Q1'
    WHEN MONTH(e.DISCHORDER_ORDERTIME) IN (4,5,6) THEN 'Q2'
    WHEN MONTH(e.DISCHORDER_ORDERTIME) IN (7,8,9) THEN 'Q3'
    ELSE 'Q4'
  END AS QUARTER,
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
  END AS DEST_CATEGORY,
  o.HOSPITAL_CENSUS_7AM
FROM DS_Encounters e
LEFT JOIN (
  SELECT
    CAST(Datehour AS DATE)  AS occ_date,
    SUM(Occupancy)          AS HOSPITAL_CENSUS_7AM
  FROM DS_Occupancy
  WHERE DATEPART(HOUR, Datehour) = 7
    AND StaffedBeds > 0{_occ_hosp_clause}
  GROUP BY CAST(Datehour AS DATE)
) o ON o.occ_date = CAST(e.DISCHORDER_ORDERTIME AS DATE)
WHERE e.TIME_HOSPADMISSION >= '2025-01-01'
  AND e.BEDDED = 'Y'{_enc_hosp_clause}
  AND e.DISCHORDER_DISCHARGE IS NOT NULL
  AND e.DISCHORDER_DISCHARGE >= 0
{_dispo_where}
"""

df_raw = pd.read_sql(QUERY, conn)
conn.close()
df_raw = df_raw.drop(columns=['EPICCSN'])

print(f"  Pulled {len(df_raw):,} rows × {df_raw.shape[1]} columns")
print(f"  Disposition breakdown:")
for dispo, cnt in df_raw['ENC_DISCHDISPO'].value_counts().items():
    print(f"    {dispo}: {cnt:,}")
print(f"  Target range: [{df_raw[TARGET].min():.0f}, {df_raw[TARGET].max():.0f}] min")
print(f"  Target mean : {df_raw[TARGET].mean():.1f} min  std: {df_raw[TARGET].std():.1f} min")


# ── Step 3: Preprocessing ─────────────────────────────────────────────────────

print()
print("=" * 60)
print("Step 3: Preprocessing...")
print("=" * 60)

# Categorical null fills
null_fills = {
    'DRG_FINALDRGMDC':       'Unknown',
    'ENC_PATCLASSBASE':      'Unknown',
    'ACCOUNT_FINANCIALCLASS':'Unknown',
    'DAY_OF_WEEK':           'Unknown',
    'DEST_CATEGORY':         'Other',
}
for col, fill_val in null_fills.items():
    n = int(df_raw[col].isna().sum())
    if n:
        print(f"  {col}: filled {n:,} nulls with '{fill_val}'")
    df_raw[col] = df_raw[col].fillna(fill_val).astype(str)

# HOSPITAL_CENSUS_7AM: median imputation
n = int(df_raw['HOSPITAL_CENSUS_7AM'].isna().sum())
if n:
    med = df_raw['HOSPITAL_CENSUS_7AM'].median()
    print(f"  HOSPITAL_CENSUS_7AM: filled {n:,} nulls with median ({med:.1f})")
    df_raw['HOSPITAL_CENSUS_7AM'] = df_raw['HOSPITAL_CENSUS_7AM'].fillna(med)

# Drop rows where target is null
before = len(df_raw)
df_raw = df_raw.dropna(subset=[TARGET])
if len(df_raw) < before:
    print(f"  Dropped {before - len(df_raw):,} rows with null target")

# Exclude Maternal Child Health from all models
before = len(df_raw)
df_raw = df_raw[df_raw['DEST_CATEGORY'] != 'Maternal Child Health'].reset_index(drop=True)
print(f"  Excluded Maternal Child Health: {before:,} → {len(df_raw):,} rows"
      f"  ({before - len(df_raw):,} removed)")

print(f"  Final dataset: {len(df_raw):,} rows")


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
    df        = df_in.copy()
    cat_cols  = model_cfg['cat_cols']
    num_cols  = model_cfg['num_cols']

    # Filter to disposition subset if needed
    if model_cfg['filter_type'] == 'exact':
        val    = model_cfg['filter_value']
        before = len(df)
        df     = df[df['ENC_DISCHDISPO'] == val].reset_index(drop=True)
        print(f"  Filtered ENC_DISCHDISPO == '{val}': {before:,} → {len(df):,} rows")
    elif model_cfg['filter_type'] == 'contains':
        pattern = '|'.join(model_cfg['filter_keywords'])
        before  = len(df)
        mask    = df['ENC_DISCHDISPO'].str.contains(pattern, case=False, na=False)
        df      = df[mask].reset_index(drop=True)
        print(f"  Filtered ENC_DISCHDISPO contains {model_cfg['filter_keywords']}: "
              f"{before:,} → {len(df):,} rows")
        for val, cnt in df['ENC_DISCHDISPO'].value_counts().items():
            print(f"    {cnt:>6,}  {val}")

    # Filter target ceiling
    before = len(df)
    df = df[df[TARGET] <= model_cfg['max_target']].reset_index(drop=True)
    print(f"  Filtered {TARGET} <= {model_cfg['max_target']} min: {before:,} → {len(df):,} rows"
          f"  ({before - len(df):,} removed)")

    y = df[TARGET].astype(float)
    print(f"  Target: mean={y.mean():.1f} min  std={y.std():.1f} min  "
          f"range=[{y.min():.0f}, {y.max():.0f}]")

    present_cat = [c for c in cat_cols if c in df.columns]
    present_num = [c for c in num_cols if c in df.columns]
    X = df[present_cat + present_num].copy()

    # Coerce and fill categoricals
    for col in present_cat:
        X[col] = X[col].astype(str).replace(
            {'nan': 'Unknown', 'None': 'Unknown', 'NaT': 'Unknown', '': 'Unknown'}
        )

    # Coerce numerics (already filled above; guard for any stragglers)
    for col in present_num:
        X[col] = pd.to_numeric(X[col], errors='coerce')
        n_miss = int(X[col].isna().sum())
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
    print("  Top 5 features by importance:")
    for item in feature_importance[:5]:
        print(f"    [{item['rank']}] {item['feature']:35s}  {item['importance_score']:.4f}")

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


def compute_combinations(df_filtered, pairs, benchmark, top_n=7, min_cnt=250):
    df = df_filtered.copy()
    df['_above'] = (df[TARGET] > benchmark).astype(int)
    all_rows = []
    for feat1, feat2, sub_label in pairs:
        if feat1 not in df.columns or feat2 not in df.columns:
            continue
        grp = df.groupby([feat1, feat2]).agg(
            cnt             = (TARGET, 'count'),
            avg_do_to_dc    = (TARGET, 'mean'),
            pct_above_benchmark = ('_above', 'mean'),
        ).reset_index()
        grp = grp[grp['cnt'] >= min_cnt]
        for _, row in grp.iterrows():
            all_rows.append({
                'label':               str(row[feat1]),
                'sub':                 f"{row[feat2]} — {sub_label}",
                'cnt':                 int(row['cnt']),
                'avg_do_to_dc':        round(float(row['avg_do_to_dc']), 1),
                'pct_above_benchmark': round(float(row['pct_above_benchmark']) * 100, 1),
            })
    all_rows.sort(key=lambda r: r['avg_do_to_dc'], reverse=True)
    return all_rows[:top_n]


# ── Output directory ──────────────────────────────────────────────────────────

script_dir = os.path.dirname(os.path.abspath(__file__))
out_dir    = os.path.join(script_dir, cfg['output_dir'])
os.makedirs(out_dir, exist_ok=True)

model_summaries = []


# ── Steps 4–7: Train and save each model ─────────────────────────────────────

for model_cfg in MODELS:
    dispo = model_cfg['disposition']

    print()
    print("=" * 60)
    print(f"  MODEL: {dispo}")
    print("=" * 60)

    # ── Step 4: Build features and train ─────────────────────────────────────

    print()
    print(f"Step 4 [{dispo}]: Building features and training model...")

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
    print(f"Step 5 [{dispo}]: Extracting importances and shape functions...")

    feature_importance, shape_functions, interactions = extract_explanations(
        ebm, X_train, cat_cols, cat_mappings
    )

    # ── Step 6: Evaluate ──────────────────────────────────────────────────────

    print()
    print(f"Step 6 [{dispo}]: Evaluating on held-out test set...")

    y_pred = ebm.predict(X_test)
    mae    = float(mean_absolute_error(y_test, y_pred))
    r2     = float(r2_score(y_test, y_pred))
    print(f"  MAE : {mae:.2f} min")
    print(f"  R²  : {r2:.4f}")

    # ── Step 7: Save JSON ─────────────────────────────────────────────────────

    print()
    print(f"Step 7 [{dispo}]: Saving to public/data/{model_cfg['out_file']}...")

    system_mean   = round(float(df_filtered[TARGET].mean()), 1)
    system_median = round(float(df_filtered[TARGET].median()), 1)

    output = {
        'model_name':         'ExplainableBoostingRegressor',
        'trained_at':         datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'target_description': model_cfg['target_description'],
        'hospital':           hospital_filter or 'All hospitals',
        'disposition':        model_cfg['disposition'],
        'system_mean':        system_mean,
        'system_median':      system_median,
        'n_training_samples': int(len(X_train)),
        'feature_importance': feature_importance,
        'shape_functions':    shape_functions,
        'interactions':       interactions,
        'model_stats': {
            'mae': mae,
            'r2':  r2,
        },
    }

    if model_cfg['benchmarks'] is not None:
        output['benchmarks'] = model_cfg['benchmarks']

    out_path = os.path.join(out_dir, model_cfg['out_file'])
    _tmp = out_path + '.tmp'
    with open(_tmp, 'w', encoding='utf-8') as f:
        json.dump(_sanitize(output), f, indent=2, allow_nan=False)
    os.replace(_tmp, out_path)

    size_kb = os.path.getsize(out_path) / 1024
    print(f"  Saved: {out_path}  ({size_kb:.1f} KB)")

    # ── Step 8b: Compute worst-performing combinations ────────────────────────

    print()
    print(f"Step 8b [{dispo}]: Computing top combinations...")

    combinations = compute_combinations(
        df_filtered, model_cfg['combo_pairs'], model_cfg['combo_benchmark']
    )
    print(f"  system_mean: {system_mean} min  benchmark: {model_cfg['combo_benchmark']} min")
    print(f"  Top 3 worst combinations:")
    for row in combinations[:3]:
        print(f"    {row['label']:25s}  {row['sub']:45s}  "
              f"avg={row['avg_do_to_dc']:.0f} min  "
              f"above_benchmark={row['pct_above_benchmark']:.0f}%  n={row['cnt']:,}")

    output['combinations'] = combinations
    _tmp = out_path + '.tmp'
    with open(_tmp, 'w', encoding='utf-8') as f:
        json.dump(_sanitize(output), f, indent=2, allow_nan=False)
    os.replace(_tmp, out_path)

    size_kb = os.path.getsize(out_path) / 1024
    print(f"  Updated JSON: {out_path}  ({size_kb:.1f} KB)")

    model_summaries.append({
        'disposition': dispo,
        'train_rows':  len(X_train),
        'test_rows':   len(X_test),
        'shape_fns':   len(shape_functions),
        'interactions': len(interactions),
        'mae':         mae,
        'r2':          r2,
    })


# ── Final summary ─────────────────────────────────────────────────────────────

print()
print("=" * 60)
print("Done. Summary:")
print(f"  {'Disposition':<14}  {'Train':>7}  {'Test':>6}  {'MAE':>8}  {'R²':>7}")
print(f"  {'-'*14}  {'-'*7}  {'-'*6}  {'-'*8}  {'-'*7}")
for s in model_summaries:
    print(f"  {s['disposition']:<14}  {s['train_rows']:>7,}  {s['test_rows']:>6,}"
          f"  {s['mae']:>7.1f}m  {s['r2']:>7.4f}")
print("=" * 60)

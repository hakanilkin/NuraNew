#!/usr/bin/env python3
"""
Bed Placement EBM Pipeline
Trains an ExplainableBoostingClassifier on the bed placement dataset and exports
feature importances + shape functions to public/data/bed_placement_ebm.json.

Usage:
    pip install python-dotenv pyodbc interpret scikit-learn pandas numpy
    python bed_placement_pipeline.py
"""

import os
import re
import json
import datetime

import pandas as pd
import numpy as np
import pyodbc
from dotenv import load_dotenv
from interpret.glassbox import ExplainableBoostingClassifier
from sklearn.model_selection import train_test_split
from sklearn.metrics import roc_auc_score, accuracy_score, precision_score, recall_score, f1_score


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

conn = pyodbc.connect(conn_str, timeout=30)
print(f"  Connected to {server} / {database}")


# ── Step 2: Pull bed placement training data ──────────────────────────────────

print()
print("=" * 60)
print("Step 2: Pulling bed placement training data...")
print("=" * 60)

QUERY = """
SELECT
  b.DUR_Requested_Assigned,
  b.SOURCE_DEPTNAME,
  b.DEST_DEPTNAME,
  DATENAME(WEEKDAY, b.TIME_REQUESTTIME)   AS DAY_OF_WEEK,
  DATEPART(HOUR,    b.TIME_REQUESTTIME)   AS HOUR_OF_DAY,
  e.ACCOUNT_FINANCIALCLASS,
  e.DRG_FINALDRGWEIGHT,
  e.DRG_FINALDRGMDC,
  CAST(o.Occupancy AS FLOAT) / NULLIF(o.StaffedBeds, 0)                        AS OCC_PCT,
  CAST(o.BedBlocked_or_Dirty AS FLOAT) / NULLIF(o.StaffedBeds, 0)              AS CONSTRAINED_PCT,
  o.StaffedBeds - o.Occupancy - o.BedBlocked_or_Dirty                          AS AVAILABLE_BEDS,
  o.BEDREQUEST_ED,
  o.BEDREQUEST_OR,
  o.DISCH,
  da.PCT_DC_ORDERS_BY_11,
  da.PCT_DC_BY_2PM,
  da2.HOSPITAL_OCC_7AM,
  da2.HOSPITAL_CENSUS_7AM
FROM DS_Bedplacement b
LEFT JOIN DS_Encounters e
  ON b.EPICCSN = e.EPICCSN
LEFT JOIN DS_Occupancy o
  ON b.DEST_DEPTID = o.DEP_ID
  AND DATEADD(hour, DATEDIFF(hour, 0, b.TIME_REQUESTTIME), 0) = o.Datehour
LEFT JOIN (
  SELECT
    DEP_LASTDEPTHOSPITAL,
    CAST(TIME_HOSPADMISSION AS DATE) AS admit_date,
    SUM(CASE WHEN CAST(DISCHORDER_ORDERTIME AS TIME) <= '11:00:00'
                  AND DISCHORDER_ORDERTIME IS NOT NULL THEN 1 ELSE 0 END)
      * 1.0 / NULLIF(SUM(CASE WHEN DISCHORDER_ORDERTIME IS NOT NULL THEN 1 ELSE 0 END), 0)
      AS PCT_DC_ORDERS_BY_11,
    SUM(CASE WHEN CAST(TIME_HOSPDISCHARGE AS TIME) <= '14:00:00'
                  AND TIME_HOSPDISCHARGE IS NOT NULL THEN 1 ELSE 0 END)
      * 1.0 / NULLIF(COUNT(*), 0)
      AS PCT_DC_BY_2PM
  FROM DS_Encounters
  WHERE BEDDED = 'Y'
    AND DEP_LASTDEPTHOSPITAL = 'Our Lady of Lourdes Hospital'
  GROUP BY DEP_LASTDEPTHOSPITAL, CAST(TIME_HOSPADMISSION AS DATE)
) da
  ON  da.DEP_LASTDEPTHOSPITAL = b.DEST_DEPTHOSPITAL
  AND da.admit_date            = CAST(b.TIME_REQUESTTIME AS DATE)
LEFT JOIN (
  SELECT
    CAST(Datehour AS DATE)                                        AS occ_date,
    CAST(SUM(Occupancy) AS FLOAT) / NULLIF(SUM(StaffedBeds), 0)  AS HOSPITAL_OCC_7AM,
    SUM(Occupancy)                                                AS HOSPITAL_CENSUS_7AM
  FROM DS_Occupancy
  WHERE DEP_Hospital = 'Our Lady of Lourdes Hospital'
    AND DATEPART(HOUR, Datehour) = 7
    AND StaffedBeds > 0
  GROUP BY CAST(Datehour AS DATE)
) da2
  ON da2.occ_date = CAST(b.TIME_REQUESTTIME AS DATE)
WHERE
  b.TIME_REQUESTTIME >= '2025-01-01'
  AND b.EVENT_TYPE_MOD IN ('Transfer', 'OTHER TRANSFER IN')
  AND b.DUR_Requested_Assigned >= 0
  AND b.DUR_Requested_Assigned <= 480
  AND b.DEST_DEPTHOSPITAL = 'Our Lady of Lourdes Hospital'
  AND e.EPICCSN IS NOT NULL
"""

df = pd.read_sql(QUERY, conn)
conn.close()
print(f"  Pulled {len(df):,} rows × {df.shape[1]} columns")
print(f"  Target range: [{df['DUR_Requested_Assigned'].min():.1f}, "
      f"{df['DUR_Requested_Assigned'].max():.1f}] minutes")
print(f"  Target mean : {df['DUR_Requested_Assigned'].mean():.1f} min  "
      f"std: {df['DUR_Requested_Assigned'].std():.1f} min")


# ── Step 3: Preprocess ────────────────────────────────────────────────────────

print()
print("=" * 60)
print("Step 3: Preprocessing...")
print("=" * 60)

TARGET = "DUR_Requested_Assigned"


# ── 3a: Derive SOURCE_CATEGORY and DEST_CATEGORY ──────────────────────────────

def classify_source(name):
    if pd.isna(name) or name in ('NULL', 'UNK', ''):
        return 'Unknown'
    n = str(name).upper()
    if 'EMERGENCY' in n or 'CDU' in n or 'PEDS EMERGENCY' in n:
        return 'ED'
    if ' OR' in n or 'JRI OR' in n:
        return 'OR'
    if 'CATH LAB' in n or 'CARDIAC CATH' in n or 'EP LAB' in n:
        return 'Cath/EP Lab'
    if 'NSICU' in n or 'SURGE NEURO ICU' in n:
        return 'ICU Downgrade'
    if 'ICU' in n or 'CORONARY CARE' in n:
        return 'ICU Downgrade'
    if 'PCU' in n:
        return 'PCU Downgrade'
    if 'LABOR' in n or 'DELIVERY' in n:
        return 'Labor & Delivery'
    return 'Floor Transfer'


def classify_dest(name):
    if pd.isna(name) or name in ('NULL', ''):
        return 'Other'
    n = str(name).upper()
    if '2E' in n or '2W' in n:
        return '2nd Floor'
    if '3E' in n or '3W' in n:
        return '3rd Floor'
    if '5W' in n or '6N' in n:
        return '6N/5W'
    if 'ICU' in n or 'CORONARY CARE' in n:
        return 'ICU'
    if 'PCU' in n:
        return 'PCU'
    if 'MOTHER BABY' in n or 'LABOR' in n or 'SPECIAL CARE NURS' in n or 'NEWBORN' in n:
        return 'Maternal Child Health'
    if 'HOSPITAL AT HOME' in n:
        return 'Hospital at Home'
    if 'IP REHAB' in n:
        return 'Rehab'
    return 'Other'


df['SOURCE_CATEGORY'] = df['SOURCE_DEPTNAME'].apply(classify_source)
df['DEST_CATEGORY']   = df['DEST_DEPTNAME'].apply(classify_dest)

print(f"  SOURCE_CATEGORY distribution:\n"
      + '\n'.join(f"    {v}: {c:,}" for v, c in
                  df['SOURCE_CATEGORY'].value_counts().items()))
print(f"  DEST_CATEGORY distribution:\n"
      + '\n'.join(f"    {v}: {c:,}" for v, c in
                  df['DEST_CATEGORY'].value_counts().items()))

df = df.drop(columns=['SOURCE_DEPTNAME', 'DEST_DEPTNAME'])


# ── 3c: DRG imputation ────────────────────────────────────────────────────────

# Fill DRG_FINALDRGMDC nulls with 'Unknown' before using it as a grouping key
n_mdc_null = df['DRG_FINALDRGMDC'].isna().sum()
if n_mdc_null:
    print(f"  DRG_FINALDRGMDC: filled {n_mdc_null:,} nulls with 'Unknown'")
df['DRG_FINALDRGMDC'] = df['DRG_FINALDRGMDC'].fillna('Unknown').astype(str)

# Impute DRG_FINALDRGWEIGHT: median within MDC group, then overall median fallback
overall_drg_median = df['DRG_FINALDRGWEIGHT'].median()
n_drg_null = df['DRG_FINALDRGWEIGHT'].isna().sum()
if n_drg_null:
    group_medians = df.groupby('DRG_FINALDRGMDC')['DRG_FINALDRGWEIGHT'].transform('median')
    # Where group median is NaN (entire MDC group is null), fall back to overall median
    df['DRG_FINALDRGWEIGHT'] = df['DRG_FINALDRGWEIGHT'].fillna(group_medians)
    df['DRG_FINALDRGWEIGHT'] = df['DRG_FINALDRGWEIGHT'].fillna(overall_drg_median)
    print(f"  DRG_FINALDRGWEIGHT: imputed {n_drg_null:,} nulls "
          f"(per-MDC median, fallback={overall_drg_median:.3f})")


# ── 3d: Drop rows where target is null ───────────────────────────────────────

before = len(df)
df = df.dropna(subset=[TARGET])
dropped = before - len(df)
if dropped:
    print(f"  Dropped {dropped:,} rows with null target")


# ── 3e: Define feature sets ───────────────────────────────────────────────────

KNOWN_NUMERIC = {
    'HOUR_OF_DAY',
    'DRG_FINALDRGWEIGHT',
    'OCC_PCT',
    'CONSTRAINED_PCT',
    'AVAILABLE_BEDS',
    'BEDREQUEST_ED',
    'BEDREQUEST_OR',
    'DISCH',
    'PCT_DC_ORDERS_BY_11',
    'PCT_DC_BY_2PM',
    'HOSPITAL_OCC_7AM',
    'HOSPITAL_CENSUS_7AM',
}

feature_cols = [c for c in df.columns if c != TARGET]
X = df[feature_cols].copy()

PLACEMENT_THRESHOLD = 30
y = (df[TARGET] > PLACEMENT_THRESHOLD).astype(int)
n_above = int(y.sum())
n_below = int(len(y) - n_above)
pct_above = 100 * n_above / len(y)
print(f"  Class balance: {n_above:,} above {PLACEMENT_THRESHOLD} min ({pct_above:.1f}%) | {n_below:,} at/under ({100-pct_above:.1f}%)")

num_cols = [c for c in feature_cols if c in KNOWN_NUMERIC]
cat_cols  = [c for c in feature_cols if c not in KNOWN_NUMERIC]

print(f"\n  Categorical features ({len(cat_cols)}): {cat_cols}")
print(f"  Numeric features    ({len(num_cols)}): {num_cols}")


# ── 3f: Coerce numerics, fill remaining categoricals ─────────────────────────

# Coerce all categoricals to plain strings (handles int/float pyodbc artefacts)
for col in cat_cols:
    X[col] = X[col].astype(str)

for col in cat_cols:
    n_before = (X[col].isin({'nan', 'None', 'NaT', ''})).sum()
    if n_before:
        print(f"    {col}: filled {n_before:,} nulls with 'Unknown'")
    X[col] = X[col].replace({'nan': 'Unknown', 'None': 'Unknown',
                              'NaT': 'Unknown', '': 'Unknown'})

# Coerce and median-fill numeric columns
for col in num_cols:
    X[col] = pd.to_numeric(X[col], errors='coerce')
    n_missing = X[col].isna().sum()
    if n_missing:
        med = X[col].median()
        print(f"    {col}: filled {n_missing:,} nulls with median ({med:.4f})")
        X[col] = X[col].fillna(med)

# Encode categoricals: category → integer code, store code→label mapping
cat_mappings = {}  # {col: {int_code: str_label}}
for col in cat_cols:
    X[col] = X[col].astype('category')
    cat_mappings[col] = {int(code): str(label)
                         for code, label in enumerate(X[col].cat.categories)}
    X[col] = X[col].cat.codes.astype(float)  # float so EBM bins it continuously

print(f"\n  Final shape: {X.shape}")


# ── Step 4: Train/test split ──────────────────────────────────────────────────

print()
print("=" * 60)
print("Step 4: Creating 80/20 train/test split...")
print("=" * 60)

X_train, X_test, y_train, y_test = train_test_split(
    X, y, test_size=0.2, random_state=42
)
print(f"  Train: {len(X_train):,}  |  Test: {len(X_test):,}")

script_dir = os.path.dirname(os.path.abspath(__file__))
out_dir    = os.path.join(script_dir, 'public', 'data')
os.makedirs(out_dir, exist_ok=True)


# ── Step 5: Train ExplainableBoostingClassifier ───────────────────────────────

print()
print("=" * 60)
print("Step 5: Training ExplainableBoostingClassifier...")
print("=" * 60)

ebm = ExplainableBoostingClassifier(interactions=8, random_state=42)
print("  Pairwise interactions: auto-detecting top 8")
print("  Fitting model (this may take a few minutes)...")
ebm.fit(X_train, y_train)
print("  Training complete.")


# ── Step 6: Extract importances, shape functions, interactions ────────────────

print()
print("=" * 60)
print("Step 6: Extracting feature importances and shape functions...")
print("=" * 60)

ebm_global  = ebm.explain_global()
global_data = ebm_global.data(-1)

print(f"  DEBUG type(ebm_global)  = {type(ebm_global)}")
print(f"  DEBUG type(global_data) = {type(global_data)}")
if isinstance(global_data, dict):
    print(f"  DEBUG global_data keys  = {list(global_data.keys())}")


def _dict_get(d, *keys, default=None):
    """Return the value of the first matching key found in dict d."""
    if not isinstance(d, dict):
        return default
    for k in keys:
        if k in d and d[k] is not None:
            return d[k]
    return default


# ── Resolve feature names ──────────────────────────────────────────────────
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

# ── Resolve importance scores ──────────────────────────────────────────────
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
    key = next(k for k in ('scores', 'importances', 'importance', 'values')
               if k in global_data)
    print(f"  Got importance scores from global_data['{key}']")

expl_scores = [float(s) for s in expl_scores]
print(f"  Feature count: {len(expl_names)}")

# ── Build ranked feature importance list ───────────────────────────────────
ranked_pairs = sorted(
    zip(expl_names, expl_scores),
    key=lambda kv: abs(kv[1]),
    reverse=True,
)
feature_importance = [
    {
        'feature':          name,
        'importance_score': float(score),
        'rank':             rank + 1,
    }
    for rank, (name, score) in enumerate(ranked_pairs)
]

print("  Top 5 features by importance:")
for item in feature_importance[:5]:
    print(f"    [{item['rank']}] {item['feature']:35s}  {item['importance_score']:.4f}")


# ── Helpers for axis extraction ────────────────────────────────────────────

def _axis_x(raw, n_scores):
    """Float-ify raw bin data; convert bin-edge format to midpoints."""
    vals = [float(v) for v in raw]
    if len(vals) == n_scores + 1:
        vals = [(vals[j] + vals[j + 1]) / 2 for j in range(n_scores)]
    return vals


def _is_2d(arr):
    """True if arr is a 2-D structure (numpy ndarray or list-of-lists)."""
    if arr is None or (hasattr(arr, '__len__') and len(arr) == 0):
        return False
    if hasattr(arr, 'ndim'):
        return arr.ndim == 2
    if isinstance(arr[0], (list, tuple)):
        return True
    return False


# ── Main loop: route each term to shape_functions or interactions ───────────
shape_functions = []
interactions    = []
cat_cols_set    = set(cat_cols)

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

        ax1_vals = _axis_x(raw_ax1, n_rows)
        ax2_vals = _axis_x(raw_ax2, n_cols)

        interactions.append({
            'feature_1':     feat1,
            'feature_2':     feat2,
            'x_values_1':    ax1_vals,
            'x_labels_1':    [],
            'x_values_2':    ax2_vals,
            'x_labels_2':    [],
            'scores_matrix': scores_matrix,
        })

    else:
        # Guard: some versions nest 1-D scores in a list-of-lists; unwrap
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
            x_values = _axis_x(raw_x, len(y_scores))
            shape_functions.append({
                'feature':  feat_name,
                'type':     'continuous',
                'x_values': x_values,
                'y_scores': y_scores,
                'x_labels': [],
            })

# Back-fill interaction labels from completed main effect shape functions
label_lookup = {sf['feature']: sf.get('x_labels', []) for sf in shape_functions}
for ix in interactions:
    ix['x_labels_1'] = label_lookup.get(ix['feature_1'], [])
    ix['x_labels_2'] = label_lookup.get(ix['feature_2'], [])

print(f"\n  Main effect shape functions : {len(shape_functions)}")
print(f"  Interaction terms extracted : {len(interactions)}")


# ── Step 6b: Model statistics ─────────────────────────────────────────────────

print()
print("=" * 60)
print("Step 6b: Computing model statistics on held-out test set...")
print("=" * 60)

y_pred      = ebm.predict(X_test)
y_pred_prob = ebm.predict_proba(X_test)[:, 1]
auc       = float(roc_auc_score(y_test, y_pred_prob))
accuracy  = float(accuracy_score(y_test, y_pred))
precision = float(precision_score(y_test, y_pred, zero_division=0))
recall    = float(recall_score(y_test, y_pred, zero_division=0))
f1        = float(f1_score(y_test, y_pred, zero_division=0))
print(f"  AUC       : {auc:.4f}")
print(f"  Accuracy  : {accuracy:.4f}")
print(f"  Precision : {precision:.4f}")
print(f"  Recall    : {recall:.4f}")
print(f"  F1        : {f1:.4f}")


# ── Step 7: Save JSON ─────────────────────────────────────────────────────────

print()
print("=" * 60)
print("Step 7: Saving output to public/data/bed_placement_ebm.json...")
print("=" * 60)

output = {
    'model_name':         'ExplainableBoostingClassifier',
    'trained_at':         datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'target_description': (
        'Binary classification — predicts whether bed assignment will exceed '
        'the 30-minute target at Our Lady of Lourdes Hospital'
    ),
    'hospital':           'Our Lady of Lourdes Hospital',
    'threshold_minutes':  PLACEMENT_THRESHOLD,
    'n_above_threshold':  n_above,
    'n_below_threshold':  n_below,
    'n_training_samples': int(len(X_train)),
    'system_mean':        round(float(df[TARGET].mean()), 1),
    'feature_importance': feature_importance,
    'shape_functions':    shape_functions,
    'interactions':       interactions,
    'model_stats': {
        'auc':       auc,
        'accuracy':  accuracy,
        'precision': precision,
        'recall':    recall,
        'f1':        f1,
    },
}

out_path = os.path.join(out_dir, 'bed_placement_ebm.json')

with open(out_path, 'w', encoding='utf-8') as f:
    json.dump(output, f, indent=2, allow_nan=False)

size_kb = os.path.getsize(out_path) / 1024
print(f"  Saved: {out_path}")
print(f"  File size: {size_kb:.1f} KB")


# ── Step 8b: Worst-performing two-way combinations ────────────────────────────

print()
print("=" * 60)
print("Step 8b: Computing worst-performing two-way combinations...")
print("=" * 60)

# Derived bucket columns (operate on the full df, not X)
_hour_bins   = [0, 8, 12, 16, 20, 24]
_hour_labels = ['Overnight', 'Morning', 'Afternoon', 'Evening', 'Night']
df['HOUR_OF_DAY_BUCKET'] = pd.cut(
    df['HOUR_OF_DAY'].astype(float),
    bins=_hour_bins, labels=_hour_labels, right=False,
).astype(str)

def _census_bucket(v):
    if pd.isna(v): return 'Unknown'
    if v < 180:    return 'Low'
    if v <= 210:   return 'Medium'
    return 'High'

df['HOSPITAL_CENSUS_BUCKET'] = df['HOSPITAL_CENSUS_7AM'].apply(_census_bucket)

system_mean_comb = float(df[TARGET].mean())
total_cases_comb = int(len(df))

COMBO_PAIRS = [
    ('SOURCE_CATEGORY',        'DEST_CATEGORY',         'Source × Destination'),
    ('SOURCE_CATEGORY',        'DAY_OF_WEEK',            'Source × Day of Week'),
    ('SOURCE_CATEGORY',        'HOUR_OF_DAY_BUCKET',     'Source × Time of Day'),
    ('DEST_CATEGORY',          'DAY_OF_WEEK',            'Destination × Day of Week'),
    ('DEST_CATEGORY',          'HOUR_OF_DAY_BUCKET',     'Destination × Time of Day'),
    ('HOSPITAL_CENSUS_BUCKET', 'SOURCE_CATEGORY',        'Census × Source'),
    ('HOSPITAL_CENSUS_BUCKET', 'DEST_CATEGORY',          'Census × Destination'),
]

all_combos = []
for feat1, feat2, pair_label in COMBO_PAIRS:
    tmp = df[[feat1, feat2, TARGET]].copy()
    tmp['_above'] = (tmp[TARGET] > PLACEMENT_THRESHOLD).astype(int)

    grp = tmp.groupby([feat1, feat2]).agg(
        cnt           = (TARGET,   'count'),
        avg_min       = (TARGET,   'mean'),
        pct_above_raw = ('_above', 'mean'),
    ).reset_index()

    grp = grp[grp['cnt'] >= 100]
    grp = grp.sort_values('avg_min', ascending=False).head(7)

    type_combos = []
    for _, row in grp.iterrows():
        avg = round(float(row['avg_min']), 1)
        type_combos.append({
            'label':              str(row[feat1]),
            'sub':                f"{row[feat2]} · {pair_label}",
            'type':               pair_label,
            'avg_assignment_min': avg,
            'above_mean':         round(avg - system_mean_comb, 1),
            'pct_above_target':   round(float(row['pct_above_raw']) * 100, 1),
            'cnt':                int(row['cnt']),
        })
    print(f"  {pair_label}: {len(type_combos)} groups (cnt ≥ 100)")
    all_combos.extend(type_combos)

all_combos.sort(key=lambda r: r['avg_assignment_min'], reverse=True)

print(f"  Total combinations (7 types × up to 7 each): {len(all_combos)}")
print("  Top 3 overall:")
for c in all_combos[:3]:
    print(f"    {c['label']} / {c['sub']}")
    print(f"      avg={c['avg_assignment_min']} min  above_mean={c['above_mean']:+.1f}  "
          f"pct_above={c['pct_above_target']}%  n={c['cnt']:,}")

combos_output = {
    'system_mean':    round(system_mean_comb, 1),
    'target_minutes': PLACEMENT_THRESHOLD,
    'total_cases':    total_cases_comb,
    'combinations':   all_combos,
}

combos_path = os.path.join(out_dir, 'bed_placement_combinations.json')
with open(combos_path, 'w', encoding='utf-8') as f:
    json.dump(combos_output, f, indent=2, allow_nan=False)

combos_kb = os.path.getsize(combos_path) / 1024
print(f"  Saved: {combos_path}  ({combos_kb:.1f} KB)")


print()
print("=" * 60)
print("Done.")
print(f"  Features  : {len(shape_functions)} main effects + {len(interactions)} interactions")
print(f"  Train rows: {len(X_train):,}")
print(f"  Test rows : {len(X_test):,}")
print(f"  AUC       : {auc:.4f}")
print(f"  Accuracy  : {accuracy:.4f}")
print(f"  Precision : {precision:.4f}")
print(f"  Recall    : {recall:.4f}")
print(f"  F1        : {f1:.4f}")
print("=" * 60)

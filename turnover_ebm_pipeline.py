#!/usr/bin/env python3
"""
Turnover EBM Pipeline
Trains an ExplainableBoostingRegressor on the OR turnover dataset and exports
feature importances + shape functions to public/data/turnover_ebm.json.

Usage:
    pip install python-dotenv pyodbc interpret scikit-learn pandas numpy
    python turnover_ebm_pipeline.py
"""

import os
import json
import math
import datetime

import pandas as pd
import pyodbc
from dotenv import load_dotenv
from interpret.glassbox import ExplainableBoostingRegressor
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_absolute_error, r2_score


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

args, cfg = parse_tenant_arg('Turnover EBM pipeline — OR turnover time model')
server, database, user, password = get_db_params(cfg)
date_from, date_to   = cfg['case_date_range']
first_case_strategy  = cfg['first_case_strategy']
case_posted          = cfg['case_posted_value']

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
print("Step 2: Pulling Turnover training data...")
print("=" * 60)

if first_case_strategy == 'derived':
    # Turnover_Orderofcaseinroom / Turnover_Maxnumofcasesinroom are NULL for this tenant;
    # derive equivalent values via window functions so the DataFrame has identical structure.
    QUERY = f"""
WITH ranked AS (
  SELECT *,
    ROW_NUMBER() OVER (PARTITION BY Loc_ORLoc, Date_Scheddate ORDER BY Time_ORin) AS derived_order,
    COUNT(*)     OVER (PARTITION BY Loc_ORLoc, Date_Scheddate)                    AS derived_max
  FROM DS_CASES
  WHERE CaseLogStatus = '{case_posted}'
    AND Date_Scheddate BETWEEN '{date_from}' AND '{date_to}'
)
SELECT
    Turnover_Turnover,
    Case_SurgeonService,
    Case_CaseType,
    DD_DOW_Long,
    Loc_ORGrp2,
    Case_ASACode,
    Anes_Anestype,
    Sched_SchedDur,
    Turnover_NextCaseSameSurgeon,
    derived_order AS Turnover_Orderofcaseinroom,
    derived_max   AS Turnover_Maxnumofcasesinroom,
    DD_WeekOfMonth,
    DD_Holiday
FROM ranked
WHERE Turnover_Turnover > 0
  AND Turnover_Turnover <= 120
  AND Turnover_Turnover IS NOT NULL
"""
else:
    QUERY = f"""
SELECT
    Turnover_Turnover,
    Case_SurgeonService,
    Case_CaseType,
    DD_DOW_Long,
    Loc_ORGrp2,
    Case_ASACode,
    Anes_Anestype,
    Sched_SchedDur,
    Turnover_NextCaseSameSurgeon,
    Turnover_Orderofcaseinroom,
    Turnover_Maxnumofcasesinroom,
    DD_WeekOfMonth,
    DD_Holiday
FROM DS_CASES
WHERE CaseLogStatus = '{case_posted}'
  AND Turnover_Turnover > 0
  AND Turnover_Turnover <= 120
  AND Date_Scheddate BETWEEN '{date_from}' AND '{date_to}'
  AND Turnover_Turnover IS NOT NULL
"""

df = pd.read_sql(QUERY, conn)
conn.close()
print(f"  Pulled {len(df):,} rows × {df.shape[1]} columns")
print(f"  Target range: [{df['Turnover_Turnover'].min():.1f}, "
      f"{df['Turnover_Turnover'].max():.1f}] minutes")


# ── Step 3: Preprocess ────────────────────────────────────────────────────────

print()
print("=" * 60)
print("Step 3: Preprocessing...")
print("=" * 60)

TARGET = "Turnover_Turnover"

# Drop rows where target is null (defensive — query already filters, but just in case)
before = len(df)
df = df.dropna(subset=[TARGET])
dropped = before - len(df)
if dropped:
    print(f"  Dropped {dropped} rows with null target")

feature_cols = [c for c in df.columns if c != TARGET]
X = df[feature_cols].copy()
y = df[TARGET].astype(float).copy()

# Force order-of-case columns to numeric (derived via window fn or read from column).
for col in ("Turnover_Orderofcaseinroom", "Turnover_Maxnumofcasesinroom"):
    X[col] = pd.to_numeric(X[col], errors="coerce")

# Authoritative numeric columns for this dataset.
# Everything else is categorical regardless of what dtype pyodbc assigned.
KNOWN_NUMERIC = {
    "Sched_SchedDur",
    "DD_WeekOfMonth",
    "DD_Holiday",
    "Turnover_Orderofcaseinroom",
    "Turnover_Maxnumofcasesinroom",
}

num_cols = [c for c in feature_cols if c in KNOWN_NUMERIC]
cat_cols = [c for c in feature_cols if c not in KNOWN_NUMERIC]

print(f"  Categorical features ({len(cat_cols)}): {cat_cols}")
print(f"  Numeric features    ({len(num_cols)}): {num_cols}")

# Coerce all categorical columns to plain strings first.
# This handles columns that pyodbc returned as int/float as well as VARCHARs.
for col in cat_cols:
    X[col] = X[col].astype(str)   # converts NaN → 'nan', fixed below

# Fill missing categoricals with 'Unknown'
for col in cat_cols:
    n_before = (X[col].isin({"nan", "None", "NaT", ""})).sum()
    if n_before:
        print(f"    {col}: filled {n_before} nulls with 'Unknown'")
    X[col] = X[col].replace({"nan": "Unknown", "None": "Unknown",
                              "NaT": "Unknown", "": "Unknown"})

# Fill missing numerics with column median
for col in num_cols:
    X[col] = pd.to_numeric(X[col], errors="coerce")
    n_missing = X[col].isna().sum()
    if n_missing:
        med = X[col].median()
        print(f"    {col}: filled {n_missing} nulls with median ({med:.2f})")
        X[col] = X[col].fillna(med)

# Encode categoricals: category → integer code, store code→label mapping
cat_mappings = {}  # {col: {int_code: str_label}}
for col in cat_cols:
    X[col] = X[col].astype("category")
    cat_mappings[col] = {int(code): str(label)
                         for code, label in enumerate(X[col].cat.categories)}
    X[col] = X[col].cat.codes.astype(float)  # float so EBM bins it continuously

print(f"\n  Final shape: {X.shape}")
print(f"  Target mean: {y.mean():.2f} min  std: {y.std():.2f} min")


# ── Step 4: Create train/test split ──────────────────────────────────────────

print()
print("=" * 60)
print("Step 4: Creating train/test split...")
print("=" * 60)

X_train, X_test, y_train, y_test = train_test_split(
    X, y, test_size=0.2, random_state=42
)
print(f"  Train: {len(X_train):,}  |  Test: {len(X_test):,}")
print("  Training ExplainableBoostingRegressor...")
ebm = ExplainableBoostingRegressor(interactions=10, random_state=42)
print("  Pairwise interactions: auto-detecting top 10")
print("  Fitting model (this may take a few minutes)...")
ebm.fit(X_train, y_train)
print("  Training complete.")

script_dir = os.path.dirname(os.path.abspath(__file__))
out_dir    = os.path.join(script_dir, cfg['output_dir'])
os.makedirs(out_dir, exist_ok=True)


# ── Step 5: Extract importances & shape functions ─────────────────────────────

print()
print("=" * 60)
print("Step 5: Extracting feature importances and shape functions...")
print("=" * 60)

ebm_global  = ebm.explain_global()
global_data = ebm_global.data(-1)

def _dict_get(d, *keys, default=None):
    if not isinstance(d, dict):
        return default
    for k in keys:
        if k in d and d[k] is not None:
            return d[k]
    return default

expl_names = _dict_get(global_data, "names", "features", "feature_names")
if expl_names is None:
    if hasattr(ebm, "term_names_"):
        expl_names = list(ebm.term_names_)
    elif hasattr(ebm, "feature_names_in_"):
        expl_names = list(ebm.feature_names_in_)
    else:
        expl_names = list(X_train.columns)
expl_names = list(expl_names)

expl_scores = _dict_get(global_data, "scores", "importances", "importance", "values")
if expl_scores is None:
    if hasattr(ebm, "term_importances") and callable(ebm.term_importances):
        expl_scores = list(ebm.term_importances())
    elif hasattr(ebm, "feature_importances_"):
        expl_scores = list(ebm.feature_importances_)
    else:
        expl_scores = [1.0] * len(expl_names)
expl_scores = [float(s) for s in expl_scores]
print(f"  Feature count: {len(expl_names)}")

ranked_pairs = sorted(zip(expl_names, expl_scores), key=lambda kv: abs(kv[1]), reverse=True)
feature_importance = [
    {"feature": name, "importance_score": float(score), "rank": rank + 1}
    for rank, (name, score) in enumerate(ranked_pairs)
]
print("  Top 5 features by importance:")
for item in feature_importance[:5]:
    print(f"    [{item['rank']}] {item['feature']:30s}  {item['importance_score']:.4f}")

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

cat_cols_set     = set(cat_cols)
shape_functions  = []
interactions_out = []


for i, feat_name in enumerate(expl_names):
    feat_data = ebm_global.data(i)
    raw_x = _dict_get(feat_data, "names", "x", "bins", "values", default=[])
    raw_y = _dict_get(feat_data, "scores", "y", "values", default=[])
    is_interaction = (" & " in str(feat_name)) or _is_2d(raw_y)
    if is_interaction:
        parts = str(feat_name).split(" & ")
        feat1 = parts[0].strip() if len(parts) >= 2 else feat_name
        feat2 = parts[1].strip() if len(parts) >= 2 else feat_name
        raw_ax1 = raw_x[0] if (raw_x is not None and len(raw_x) >= 2) else []
        raw_ax2 = raw_x[1] if (raw_x is not None and len(raw_x) >= 2) else []
        scores_matrix = [[float(v) for v in row] for row in raw_y]
        n_rows = len(scores_matrix)
        n_cols = len(scores_matrix[0]) if n_rows > 0 else 0
        interactions_out.append({
            "feature_1":     feat1,
            "feature_2":     feat2,
            "x_values_1":    _axis_x(raw_ax1, n_rows),
            "x_labels_1":    [],
            "x_values_2":    _axis_x(raw_ax2, n_cols),
            "x_labels_2":    [],
            "scores_matrix": scores_matrix,
        })
    else:
        if raw_y is not None and len(raw_y) > 0 and isinstance(raw_y[0], (list, tuple)):
            raw_y = raw_y[0]
        y_scores = [float(v) for v in raw_y]
        if feat_name in cat_cols_set:
            x_values = _axis_x(raw_x, len(y_scores))
            mapping  = cat_mappings[feat_name]
            shape_functions.append({
                "feature":       feat_name,
                "type":          "categorical",
                "x_values":      x_values,
                "y_scores":      y_scores,
                "x_labels":      [mapping.get(int(round(v)), str(v)) for v in x_values],
                "code_to_label": {str(k): v for k, v in mapping.items()},
            })
        else:
            shape_functions.append({
                "feature":  feat_name,
                "type":     "continuous",
                "x_values": _axis_x(raw_x, len(y_scores)),
                "y_scores": y_scores,
                "x_labels": [],
            })

label_lookup = {sf["feature"]: sf.get("x_labels", []) for sf in shape_functions}
for ix in interactions_out:
    ix["x_labels_1"] = label_lookup.get(ix["feature_1"], [])
    ix["x_labels_2"] = label_lookup.get(ix["feature_2"], [])

print(f"  Main effect shape functions : {len(shape_functions)}")
print(f"  Interaction terms extracted : {len(interactions_out)}")


# ── Step 6: Model statistics ──────────────────────────────────────────────────

print()
print("=" * 60)
print("Step 6: Computing model statistics on held-out test set...")
print("=" * 60)

y_pred = ebm.predict(X_test)
mae    = float(mean_absolute_error(y_test, y_pred))
r2     = float(r2_score(y_test, y_pred))
print(f"  MAE : {mae:.2f} minutes")
print(f"  R²  : {r2:.4f}")


# ── Step 7: Save turnover_ebm.json ────────────────────────────────────────────

print()
print("=" * 60)
print("Step 7: Saving turnover_ebm.json...")
print("=" * 60)

system_mean   = round(float(y.mean()), 1)
system_median = round(float(y.median()), 1)
print(f"  system_mean  : {system_mean} min")
print(f"  system_median: {system_median} min")

output_ebm = {
    "model_name":         "ExplainableBoostingRegressor",
    "trained_at":         datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "target_description": (
        "Turnover time (minutes) between the end of one OR case and the incision of the next. "
        "Positive shape function values push predicted turnover higher; negative values lower it."
    ),
    "n_training_samples": int(len(X_train)),
    "system_mean":        system_mean,
    "system_median":      system_median,
    "feature_importance": feature_importance,
    "shape_functions":    shape_functions,
    "interactions":       interactions_out,
    "model_stats": {
        "mae": mae,
        "r2":  r2,
    },
}

ebm_out_path = os.path.join(out_dir, "turnover_ebm.json")
_tmp = ebm_out_path + '.tmp'
with open(_tmp, "w", encoding="utf-8") as f:
    json.dump(_sanitize(output_ebm), f, indent=2, allow_nan=False)
os.replace(_tmp, ebm_out_path)

size_kb = os.path.getsize(ebm_out_path) / 1024
print(f"  Saved: {ebm_out_path}")
print(f"  File size: {size_kb:.1f} KB")

# ── Step 8: Combinations tab pre-computation ─────────────────────────────────

print()
print("=" * 60)
print("Step 8: Pre-computing Atlas Combinations data...")
print("=" * 60)

SYSTEM_MEAN   = round(float(y.mean()), 2)
TARGET_MIN    = 30
TOTAL_CASES   = len(df)
COMBO_LOCS    = cfg['or_combo_locs']   # None = no location filter

if COMBO_LOCS:
    _locs_clause = "AND Loc_ORGrp2 IN ({locs})".format(
        locs=', '.join(f"'{l}'" for l in COMBO_LOCS)
    )
else:
    _locs_clause = ''

BASE_WHERE = (
    f"CaseLogStatus = '{case_posted}' "
    "AND Turnover_Turnover > 0 "
    "AND Turnover_Turnover <= 120 "
    f"AND Date_Scheddate BETWEEN '{date_from}' AND '{date_to}' "
    + _locs_clause
)

COMBO_QUERIES = [
    {
        'type': 'service_surgeon',
        'sub':  'Service line × Surgeon',
        'sql': f"""
            SELECT
                Case_SurgeonService                              AS dim1,
                Turnover_NextCaseSameSurgeon                     AS dim2,
                COUNT(*)                                         AS cnt,
                ROUND(AVG(CAST(Turnover_Turnover AS FLOAT)), 1)  AS avg_turnover
            FROM DS_CASES
            WHERE {BASE_WHERE}
            GROUP BY Case_SurgeonService, Turnover_NextCaseSameSurgeon
            HAVING COUNT(*) >= 1000
        """,
    },
    {
        'type': 'location_surgeon',
        'sub':  'Location × Surgeon',
        'sql': f"""
            SELECT
                Loc_ORGrp2                                       AS dim1,
                Turnover_NextCaseSameSurgeon                     AS dim2,
                COUNT(*)                                         AS cnt,
                ROUND(AVG(CAST(Turnover_Turnover AS FLOAT)), 1)  AS avg_turnover
            FROM DS_CASES
            WHERE {BASE_WHERE}
            GROUP BY Loc_ORGrp2, Turnover_NextCaseSameSurgeon
            HAVING COUNT(*) >= 1000
        """,
    },
    {
        'type': 'service_location',
        'sub':  'Service line × Location',
        'sql': f"""
            SELECT
                Case_SurgeonService                              AS dim1,
                Loc_ORGrp2                                       AS dim2,
                COUNT(*)                                         AS cnt,
                ROUND(AVG(CAST(Turnover_Turnover AS FLOAT)), 1)  AS avg_turnover
            FROM DS_CASES
            WHERE {BASE_WHERE}
            GROUP BY Case_SurgeonService, Loc_ORGrp2
            HAVING COUNT(*) >= 1000
        """,
    },
    {
        'type': 'day_location',
        'sub':  'Day × Location',
        'sql': f"""
            SELECT
                DD_DOW_Long                                      AS dim1,
                Loc_ORGrp2                                       AS dim2,
                COUNT(*)                                         AS cnt,
                ROUND(AVG(CAST(Turnover_Turnover AS FLOAT)), 1)  AS avg_turnover
            FROM DS_CASES
            WHERE {BASE_WHERE}
            GROUP BY DD_DOW_Long, Loc_ORGrp2
            HAVING COUNT(*) >= 1000
        """,
    },
    {
        'type': 'duration_location',
        'sub':  'Duration × Location',
        'sql': f"""
            SELECT
                CASE
                    WHEN CAST(Sched_SchedDur AS FLOAT) <= 60  THEN 'Short (≤60 min)'
                    WHEN CAST(Sched_SchedDur AS FLOAT) <= 120 THEN 'Medium (61-120 min)'
                    WHEN CAST(Sched_SchedDur AS FLOAT) <= 180 THEN 'Long (121-180 min)'
                    ELSE 'Very Long (>180 min)'
                END                                              AS dim1,
                Loc_ORGrp2                                       AS dim2,
                COUNT(*)                                         AS cnt,
                ROUND(AVG(CAST(Turnover_Turnover AS FLOAT)), 1)  AS avg_turnover
            FROM DS_CASES
            WHERE {BASE_WHERE}
              AND Sched_SchedDur IS NOT NULL
            GROUP BY
                CASE
                    WHEN CAST(Sched_SchedDur AS FLOAT) <= 60  THEN 'Short (≤60 min)'
                    WHEN CAST(Sched_SchedDur AS FLOAT) <= 120 THEN 'Medium (61-120 min)'
                    WHEN CAST(Sched_SchedDur AS FLOAT) <= 180 THEN 'Long (121-180 min)'
                    ELSE 'Very Long (>180 min)'
                END,
                Loc_ORGrp2
            HAVING COUNT(*) >= 1000
        """,
    },
]

SURGEON_LABEL = {'YES': 'same surgeon', 'NO': 'surgeon change'}
SURGEON_TYPES = {'service_surgeon', 'location_surgeon'}

def _combo_label(row_type, dim1, dim2):
    if row_type in SURGEON_TYPES:
        surgeon_str = SURGEON_LABEL.get(str(dim2).strip().upper(), str(dim2))
        return f"{dim1} — {surgeon_str}"
    return f"{dim1} — {dim2}"

try:
    conn10 = pyodbc.connect(conn_str, timeout=60)
    cursor10 = conn10.cursor()
    print(f"  DB connection established for combinations queries")

    all_combos = []
    for q in COMBO_QUERIES:
        cursor10.execute(q['sql'])
        rows = cursor10.fetchall()
        kept = 0
        for row in rows:
            dim1, dim2, cnt, avg_t = row.dim1, row.dim2, row.cnt, row.avg_turnover
            if avg_t is None:
                continue
            above_mean = round(float(avg_t) - SYSTEM_MEAN, 1)
            if above_mean <= 0:
                continue
            all_combos.append({
                'type':         q['type'],
                'sub':          q['sub'],
                'label':        _combo_label(q['type'], dim1, dim2),
                'dim1':         str(dim1),
                'dim2':         str(dim2),
                'cnt':          int(cnt),
                'avg_turnover': float(avg_t),
                'above_mean':   above_mean,
            })
            kept += 1
        print(f"  {q['type']:20s}: {len(rows)} groups queried, {kept} above system mean")

    cursor10.close()
    conn10.close()

    all_combos.sort(key=lambda r: r['above_mean'], reverse=True)

    combos_output = {
        'generated_at':  datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'system_mean':   SYSTEM_MEAN,
        'target_minutes': TARGET_MIN,
        'total_cases':   TOTAL_CASES,
        'combinations':  all_combos,
    }

    combos_path = os.path.join(out_dir, 'turnover_combinations.json')
    _tmp = combos_path + '.tmp'
    with open(_tmp, 'w', encoding='utf-8') as f:
        json.dump(_sanitize(combos_output), f, indent=2, allow_nan=False)
    os.replace(_tmp, combos_path)

    size_kb = os.path.getsize(combos_path) / 1024
    print(f"  {len(all_combos)} combinations saved: {combos_path}  ({size_kb:.1f} KB)")

except Exception as e:
    print(f"  Step 8 failed: {e}")
    print("  turnover_combinations.json was NOT written — continuing to final summary")


# ── Final summary ─────────────────────────────────────────────────────────────

print()
print("=" * 60)
print("Done.")
print(f"  EBM MAE    : {mae:.2f} min  |  R² : {r2:.4f}")
print(f"  Train rows : {len(X_train):,}")
print(f"  Output dir : {out_dir}")
print("=" * 60)

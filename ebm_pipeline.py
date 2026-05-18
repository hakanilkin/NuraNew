#!/usr/bin/env python3
"""
FCOT EBM Pipeline
Trains an ExplainableBoostingRegressor on the FCOT dataset and exports
feature importances + shape functions to public/data/fcot_ebm.json.

Usage:
    pip install python-dotenv pyodbc interpret scikit-learn pandas numpy
    python ebm_pipeline.py
"""

import os
import json
import datetime

import pandas as pd
import pyodbc
from dotenv import load_dotenv
from interpret.glassbox import ExplainableBoostingRegressor
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.model_selection import train_test_split


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


# ── Step 2: Pull training data ────────────────────────────────────────────────

print()
print("=" * 60)
print("Step 2: Pulling FCOT training data...")
print("=" * 60)

QUERY = """
SELECT
    Dur_Act_vs_SchedStart,
    Case_SurgeonService,
    Case_CaseType,
    DD_DOW_Long,
    Loc_ORGrp2,
    Case_ASACode,
    Case_AddOnCode,
    Case_DaysScheduledAhead,
    Anes_Anestype,
    Sched_SchedDur,
    DD_Holiday,
    DD_WeekOfMonth,
    DD_Month_Int
FROM DS_CASES
WHERE CaseLogStatus = 'Posted'
  AND Turnover_Orderofcaseinroom = 1
  AND Date_Scheddate >= '2023-01-01'
  AND Date_Scheddate <= '2025-12-31'
  AND Dur_Act_vs_SchedStart IS NOT NULL
"""

df = pd.read_sql(QUERY, conn)
conn.close()
print(f"  Pulled {len(df):,} rows × {df.shape[1]} columns")
print(f"  Target range: [{df['Dur_Act_vs_SchedStart'].min():.1f}, "
      f"{df['Dur_Act_vs_SchedStart'].max():.1f}] minutes")


# ── Step 3: Preprocess ────────────────────────────────────────────────────────

print()
print("=" * 60)
print("Step 3: Preprocessing...")
print("=" * 60)

TARGET = "Dur_Act_vs_SchedStart"

# Drop rows where target is null (defensive — query already filters, but just in case)
before = len(df)
df = df.dropna(subset=[TARGET])
dropped = before - len(df)
if dropped:
    print(f"  Dropped {dropped} rows with null target")

feature_cols = [c for c in df.columns if c != TARGET]
X = df[feature_cols].copy()
y = df[TARGET].astype(float).copy()

# Authoritative numeric columns for this dataset.
# Everything else is categorical regardless of what dtype pyodbc assigned.
KNOWN_NUMERIC = {
    "Case_DaysScheduledAhead",
    "Sched_SchedDur",
    "DD_Holiday",
    "DD_WeekOfMonth",
    "DD_Month_Int",
}

num_cols = [c for c in feature_cols if c in KNOWN_NUMERIC]
cat_cols = [c for c in feature_cols if c not in KNOWN_NUMERIC]

print(f"  Categorical features ({len(cat_cols)}): {cat_cols}")
print(f"  Numeric features    ({len(num_cols)}): {num_cols}")

# Coerce all categorical columns to plain strings first.
# This handles columns that pyodbc returned as int/float (e.g. Case_ASACode
# stored as integer in SQL Server) as well as genuine VARCHAR columns.
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
    # enumerate gives (code, label) pairs in alphabetically sorted category order
    cat_mappings[col] = {int(code): str(label)
                         for code, label in enumerate(X[col].cat.categories)}
    X[col] = X[col].cat.codes.astype(float)  # float so EBM bins it continuously

print(f"\n  Final shape: {X.shape}")
print(f"  Target mean: {y.mean():.2f} min  std: {y.std():.2f} min")


# ── Step 4: Train EBM ─────────────────────────────────────────────────────────

print()
print("=" * 60)
print("Step 4: Training ExplainableBoostingRegressor...")
print("=" * 60)

X_train, X_test, y_train, y_test = train_test_split(
    X, y, test_size=0.2, random_state=42
)
print(f"  Train: {len(X_train):,}  |  Test: {len(X_test):,}")

ebm = ExplainableBoostingRegressor(interactions=15, random_state=42)
print("  Pairwise interactions: auto-detecting top 15")
print("  Fitting model (this may take a few minutes)...")
ebm.fit(X_train, y_train)
print("  Training complete.")


# ── Step 5: Extract importances & shape functions ─────────────────────────────

print()
print("=" * 60)
print("Step 5: Extracting feature importances and shape functions...")
print("=" * 60)

ebm_global = ebm.explain_global()

# ── DEBUG: inspect top-level explanation type ──────────────────────────────
print(f"\n  DEBUG type(ebm_global)            = {type(ebm_global)}")

global_data = ebm_global.data(-1)
print(f"  DEBUG type(global_data)           = {type(global_data)}")
if isinstance(global_data, dict):
    print(f"  DEBUG list(global_data.keys())    = {list(global_data.keys())}")
    for k, v in global_data.items():
        preview = (str(v[:3]) + "...") if isinstance(v, (list, tuple)) and len(v) > 3 else str(v)[:120]
        print(f"    '{k}': {preview}")
else:
    print(f"  DEBUG global_data value           = {str(global_data)[:200]}")

feat0_data = ebm_global.data(0)
print(f"\n  DEBUG type(feat0_data)            = {type(feat0_data)}")
if isinstance(feat0_data, dict):
    print(f"  DEBUG list(feat0_data.keys())     = {list(feat0_data.keys())}")
    for k, v in feat0_data.items():
        preview = (str(v[:3]) + "...") if isinstance(v, (list, tuple)) and len(v) > 3 else str(v)[:120]
        print(f"    '{k}': {preview}")
# ── END DEBUG ──────────────────────────────────────────────────────────────

def _dict_get(d, *keys, default=None):
    """Return the value of the first matching key found in dict d."""
    if not isinstance(d, dict):
        return default
    for k in keys:
        if k in d and d[k] is not None:
            return d[k]
    return default

# ── Resolve feature names ──────────────────────────────────────────────────
# Try the explanation dict first, then fall back to model attributes.
expl_names = _dict_get(global_data, "names", "features", "feature_names")

if expl_names is None:
    if hasattr(ebm, "term_names_"):
        expl_names = list(ebm.term_names_)
        print("\n  Using ebm.term_names_ for feature names")
    elif hasattr(ebm, "feature_names_in_"):
        expl_names = list(ebm.feature_names_in_)
        print("\n  Using ebm.feature_names_in_ for feature names")
    else:
        expl_names = list(X_train.columns)
        print("\n  Falling back to X_train.columns for feature names")
else:
    print(f"\n  Got feature names from global_data key "
          f"'{next(k for k in ('names','features','feature_names') if k in global_data)}'")

expl_names = list(expl_names)

# ── Resolve importance scores ──────────────────────────────────────────────
expl_scores = _dict_get(global_data, "scores", "importances", "importance", "values")

if expl_scores is None:
    if hasattr(ebm, "term_importances") and callable(ebm.term_importances):
        expl_scores = list(ebm.term_importances())
        print("  Using ebm.term_importances() for importance scores")
    elif hasattr(ebm, "feature_importances_"):
        expl_scores = list(ebm.feature_importances_)
        print("  Using ebm.feature_importances_ for importance scores")
    else:
        expl_scores = [1.0] * len(expl_names)
        print("  WARNING: could not extract importance scores — defaulting to 1.0")
else:
    print(f"  Got importance scores from global_data key "
          f"'{next(k for k in ('scores','importances','importance','values') if k in global_data)}'")

expl_scores = [float(s) for s in expl_scores]
print(f"\n  Feature count: {len(expl_names)}")

# ── Build ranked feature importance list ───────────────────────────────────
ranked_pairs = sorted(
    zip(expl_names, expl_scores),
    key=lambda kv: abs(kv[1]),
    reverse=True,
)
feature_importance = [
    {
        "feature":          name,
        "importance_score": float(score),
        "rank":             rank + 1,
    }
    for rank, (name, score) in enumerate(ranked_pairs)
]

print("  Top 5 features by importance:")
for item in feature_importance[:5]:
    print(f"    [{item['rank']}] {item['feature']:30s}  {item['importance_score']:.4f}")

# ── Helpers for axis extraction ────────────────────────────────────────────

def _axis_x(raw, n_scores):
    """Float-ify raw bin data; convert bin-edge format to midpoints."""
    vals = [float(v) for v in raw]
    if len(vals) == n_scores + 1:
        vals = [(vals[j] + vals[j + 1]) / 2 for j in range(n_scores)]
    return vals

def _axis_labels(feat, x_vals):
    """Map float-encoded category codes to string labels."""
    if feat not in cat_cols_set:
        return []
    m = cat_mappings[feat]
    return [m.get(int(round(v)), str(v)) for v in x_vals]

def _is_2d(arr):
    """True if arr is a 2-D structure (numpy ndarray or list-of-lists)."""
    if arr is None or (hasattr(arr, '__len__') and len(arr) == 0):
        return False
    if hasattr(arr, 'ndim'):                    # numpy array
        return arr.ndim == 2
    if isinstance(arr[0], (list, tuple)):        # list of lists
        return True
    return False

# ── Main loop: route each term to shape_functions or interactions ───────────
shape_functions = []
interactions    = []
cat_cols_set    = set(cat_cols)

for i, feat_name in enumerate(expl_names):
    feat_data = ebm_global.data(i)

    # Debug first term's structure (left in from previous debugging step)
    if i == 0:
        print(f"\n  DEBUG feat[0] ('{feat_name}'): type={type(feat_data)}")
        if isinstance(feat_data, dict):
            print(f"  DEBUG feat[0] keys: {list(feat_data.keys())}")

    raw_x = _dict_get(feat_data, "names", "x", "bins", "values", default=[])
    raw_y = _dict_get(feat_data, "scores", "y", "values", default=[])

    # Interaction terms: name contains " & " OR scores array is 2-D
    is_interaction = (" & " in str(feat_name)) or _is_2d(raw_y)

    if is_interaction:
        # ── Interaction term ───────────────────────────────────────────────
        # raw_x = [axis1_bins, axis2_bins];  raw_y = 2-D scores matrix
        parts = str(feat_name).split(" & ")
        feat1 = parts[0].strip() if len(parts) >= 2 else feat_name
        feat2 = parts[1].strip() if len(parts) >= 2 else feat_name

        raw_ax1 = raw_x[0] if (raw_x is not None and len(raw_x) >= 2) else []
        raw_ax2 = raw_x[1] if (raw_x is not None and len(raw_x) >= 2) else []

        scores_matrix = [[float(v) for v in row] for row in raw_y]
        n_rows = len(scores_matrix)
        n_cols = len(scores_matrix[0]) if n_rows > 0 else 0

        ax1_vals   = _axis_x(raw_ax1, n_rows)
        ax2_vals   = _axis_x(raw_ax2, n_cols)

        interactions.append({
            "feature_1":     feat1,
            "feature_2":     feat2,
            "x_values_1":    ax1_vals,
            "x_labels_1":    [],  # back-filled from label_lookup after all main effects are done
            "x_values_2":    ax2_vals,
            "x_labels_2":    [],  # back-filled from label_lookup after all main effects are done
            "scores_matrix": scores_matrix,
        })

    else:
        # ── Main effect term ───────────────────────────────────────────────
        # Guard: some versions nest 1-D scores in a list-of-lists; unwrap
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
            x_values = _axis_x(raw_x, len(y_scores))
            shape_functions.append({
                "feature":  feat_name,
                "type":     "continuous",
                "x_values": x_values,
                "y_scores": y_scores,
                "x_labels": [],
            })

# ── Back-fill interaction labels from completed main effect shape functions ──
# Build a lookup of feature → x_labels from the already-processed main effects.
# This is safer than re-deriving labels from interaction axis values, which may
# have different binning than the main effect bins.
label_lookup = {sf["feature"]: sf.get("x_labels", []) for sf in shape_functions}
for ix in interactions:
    ix["x_labels_1"] = label_lookup.get(ix["feature_1"], [])
    ix["x_labels_2"] = label_lookup.get(ix["feature_2"], [])

print(f"\n  Main effect shape functions : {len(shape_functions)}")
print(f"  Interaction terms extracted : {len(interactions)}")


# ── Step 6: Model stats ───────────────────────────────────────────────────────

print()
print("=" * 60)
print("Step 6: Computing model statistics on held-out test set...")
print("=" * 60)

y_pred = ebm.predict(X_test)
mae    = float(mean_absolute_error(y_test, y_pred))
r2     = float(r2_score(y_test, y_pred))
print(f"  MAE : {mae:.2f} minutes")
print(f"  R²  : {r2:.4f}")


# ── Step 7: Save JSON ─────────────────────────────────────────────────────────

print()
print("=" * 60)
print("Step 7: Saving output to public/data/fcot_ebm.json...")
print("=" * 60)

output = {
    "model_name":         "ExplainableBoostingRegressor",
    "trained_at":         datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "target_description": (
        "Actual OR start time minus scheduled start time (minutes). "
        "Negative = started early; positive = started late."
    ),
    "n_training_samples": int(len(X_train)),
    "feature_importance": feature_importance,
    "shape_functions":    shape_functions,
    "interactions":       interactions,
    "model_stats": {
        "mae": mae,
        "r2":  r2,
    },
}

# Resolve path relative to this script's directory so it works from any cwd
script_dir = os.path.dirname(os.path.abspath(__file__))
out_dir    = os.path.join(script_dir, "public", "data")
out_path   = os.path.join(out_dir, "fcot_ebm.json")

os.makedirs(out_dir, exist_ok=True)

with open(out_path, "w", encoding="utf-8") as f:
    json.dump(output, f, indent=2, allow_nan=False)

size_kb = os.path.getsize(out_path) / 1024
print(f"  Saved: {out_path}")
print(f"  File size: {size_kb:.1f} KB")

print()
print("=" * 60)
print("Done.")
print(f"  Features  : {len(shape_functions)} main effects + {len(interactions)} interactions")
print(f"  Train rows: {len(X_train):,}")
print(f"  MAE       : {mae:.2f} min")
print(f"  R²        : {r2:.4f}")
print("=" * 60)

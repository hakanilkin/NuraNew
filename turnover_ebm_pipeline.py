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
import re
import json
import datetime

import pandas as pd
import pyodbc
from dotenv import load_dotenv
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
print("Step 2: Pulling Turnover training data...")
print("=" * 60)

QUERY = """
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
WHERE CaseLogStatus = 'Posted'
  AND Turnover_Turnover > 0
  AND Turnover_Turnover <= 120
  AND Date_Scheddate >= '2023-01-01'
  AND Date_Scheddate <= '2025-12-31'
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

# Force these two columns to numeric before classification — they may arrive
# from pyodbc as strings or object dtype depending on SQL Server column type.
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
print("  (EBM training skipped — proceeding directly to RuleFit and Skope-Rules)")

script_dir = os.path.dirname(os.path.abspath(__file__))
out_dir    = os.path.join(script_dir, "public", "data")
os.makedirs(out_dir, exist_ok=True)


# ── Step 4b: RuleFit-specific filtered dataset ────────────────────────────────

print()
print("=" * 60)
print("Step 4b: Building RuleFit-specific filtered dataset...")
print("=" * 60)

# Locations excluded from RuleFit training (endoscopy suites, low-volume ORs)
_RF_EXCLUDE_LOCS = {
    'MARH ENDOSCOPY', 'MARH IR',
    'MEMH ENDOSCOPY', 'MEMH MHAS OR',
    'OLLH ENDOSCOPY',
    'VORH ENDOSCOPY',
    'VSSC ENDOSCOPY', 'VSSC OR',
}

mask_excl_locs   = df['Loc_ORGrp2'].isin(_RF_EXCLUDE_LOCS)
mask_wilh_gastro = (
    (df['Loc_ORGrp2'] == 'WILH OR') &
    (df['Case_SurgeonService'] == 'Gastroenterology')
)
df_rulefit = df[~(mask_excl_locs | mask_wilh_gastro)].copy()

print(f"  Original rows                      : {len(df):,}")
print(f"  Excluded (location filter)         : {mask_excl_locs.sum():,}")
print(f"  Excluded (WILH OR + Gastroenterology): {mask_wilh_gastro.sum():,}")
print(f"  RuleFit dataset                    : {len(df_rulefit):,} rows")

# Extract features and target from the filtered subset
X_rf = df_rulefit[feature_cols].copy()
y_rf = df_rulefit[TARGET].astype(float).copy()

# Same numeric pre-coercions as main preprocessing
for col in ("Turnover_Orderofcaseinroom", "Turnover_Maxnumofcasesinroom"):
    X_rf[col] = pd.to_numeric(X_rf[col], errors="coerce")

# Coerce categoricals to string and fill nulls
for col in cat_cols:
    X_rf[col] = X_rf[col].astype(str).replace(
        {"nan": "Unknown", "None": "Unknown", "NaT": "Unknown", "": "Unknown"}
    )

# Fill missing numerics with the filtered-subset median
for col in num_cols:
    X_rf[col] = pd.to_numeric(X_rf[col], errors="coerce")
    n_missing = X_rf[col].isna().sum()
    if n_missing:
        med = X_rf[col].median()
        print(f"    {col}: filled {n_missing} nulls with median ({med:.2f})")
        X_rf[col] = X_rf[col].fillna(med)

# Fresh independent categorical encoding for df_rulefit.
# Codes are re-derived from this subset's own distribution, so categories absent
# after filtering (e.g. excluded locations) are dropped and codes are compact.
rf_cat_mappings = {}  # {col: {int_code: str_label}}
for col in cat_cols:
    X_rf[col] = X_rf[col].astype("category")
    rf_cat_mappings[col] = {int(code): str(label)
                            for code, label in enumerate(X_rf[col].cat.categories)}
    X_rf[col] = X_rf[col].cat.codes.astype(float)

X_train_rf, X_test_rf, y_train_rf, y_test_rf = train_test_split(
    X_rf, y_rf, test_size=0.2, random_state=42
)
print(f"  RuleFit train : {len(X_train_rf):,}  |  test : {len(X_test_rf):,}")


# ── Shared utility: substitute display names and clean rule strings ───────────

FEAT_DISPLAY = {
    'Case_SurgeonService':          'Surgeon Service',
    'Case_CaseType':                'Case Type',
    'DD_DOW_Long':                  'Day of Week',
    'Loc_ORGrp2':                   'Location Group',
    'Case_ASACode':                 'ASA Acuity',
    'Anes_Anestype':                'Anesthesia Type',
    'Sched_SchedDur':               'Scheduled Duration',
    'Turnover_NextCaseSameSurgeon': 'Same Surgeon Next Case',
    'Turnover_Orderofcaseinroom':   'Case Position in Room',
    'Turnover_Maxnumofcasesinroom': 'Cases in Room That Day',
    'DD_WeekOfMonth':               'Week of Month',
    'DD_Holiday':                   'Holiday',
}

# Binary features encoded as 0/1: > 0.5 means YES, <= 0.5 means NO
_BINARY_DISPLAY = {'Same Surgeon Next Case', 'Holiday'}

# Categorical features whose integer codes are arbitrary — thresholds are opaque
# (Location Group, Surgeon Service, ASA Acuity handled separately with resolved labels)
_OPAQUE_CAT_DISPLAY = {
    'Day of Week':     'certain days',
    'Case Type':       'certain case types',
    'Anesthesia Type': 'certain anesthesia types',
}

# Truly numeric features — keep threshold value, round to integer
_NUMERIC_DISPLAY = {
    'Scheduled Duration',
    'Case Position in Room',
    'Cases in Room That Day',
    'Week of Month',
}

def _join_names(names):
    """Join a list of names into a readable 'X, Y, or Z' string."""
    if len(names) == 1:
        return names[0]
    if len(names) == 2:
        return f'{names[0]} or {names[1]}'
    return ', '.join(names[:-1]) + f', or {names[-1]}'

def _resolve_service_lines(op, threshold_str, svc_mapping):
    """
    Resolve 'Surgeon Service op N' to a concise service line phrase.

    Strategy: always name the SHORTER side; the longer side → 'for all other service lines'.
      1-3 items:  name them all  → 'for Urology and Vascular Surgery cases'
      4-9 items:  first 3 + count → 'for Cardiology, Urology, and 2 others'
      10+ items:  too large to enumerate; use generic fallback
    """
    thresh = float(threshold_str)
    sorted_items = sorted((float(code), label) for code, label in svc_mapping.items())
    high = [label for code, label in sorted_items if code > thresh]
    low  = [label for code, label in sorted_items if code <= thresh]

    if not high:
        return 'for all service lines'
    if not low:
        return 'for no service lines'

    # The operator determines which set is "selected" by the rule
    selected = high if op in ('>', '>=') else low

    # Name the shorter side; the other side becomes "all other service lines"
    if len(high) <= len(low):
        short = high
    else:
        short = low
    selecting_short = (selected is short)

    n_short = len(short)
    if n_short >= 10:
        # Both sides too large — avoid listing dozens of names
        return 'for various service lines' if selecting_short else 'for all other service lines'
    elif n_short <= 3:
        named = f'for {_join_names(short)} cases'
    else:
        # 4-9 items: first 3 previewed, remainder counted (capped at actual list size)
        n_others = n_short - 3
        preview  = ', '.join(short[:3])
        named    = f'for {preview}, and {n_others} others'

    return named if selecting_short else 'for all other service lines'

def _resolve_asa(op, threshold_str, asa_mapping):
    """
    Resolve 'ASA Acuity op N' to a simplified clinical phrase.
    Uses the actual category labels from label_mappings to derive the cutpoint.
      > N  → 'for moderate-to-high acuity patients (ASA {min_high}+)'
      <= N → 'for lower acuity patients (ASA {min_low}-{max_low})'
    """
    thresh = float(threshold_str)
    sorted_items = sorted((float(code), label) for code, label in asa_mapping.items())
    high = [label for code, label in sorted_items if code > thresh]
    low  = [label for code, label in sorted_items if code <= thresh]

    if not high or not low:
        return 'for all acuity levels'

    if op in ('>', '>='):
        cutpoint = high[0]   # lowest ASA label above threshold (e.g. '3')
        return f'for moderate-to-high acuity patients (ASA {cutpoint}+)'
    else:
        if len(low) == 1:
            return f'for lower acuity patients (ASA {low[0]})'
        return f'for lower acuity patients (ASA {low[0]}-{low[-1]})'

def _collapse_ranges_raw(rule_str):
    """
    Collapse paired range conditions BEFORE display-name substitution, while
    feature names are still raw column identifiers.

    'Feature <= 6.5 & Feature > 2.5'  →  'Feature between 3 and 6'

    Also normalises Skope-Rules ' and ' connector to ' & ' so both rule
    formats are handled uniformly.
    """
    # Normalise Skope-Rules connector: ' and ' that sits between a number
    # and the start of a new condition (uppercase or underscore-prefixed word)
    normalized = re.sub(r'([\d.]+)\s+and\s+(?=[A-Za-z_])', r'\1 & ', rule_str)
    parts = [p.strip() for p in normalized.split(' & ')]

    cond_pat = re.compile(r'^(.+?)\s*(<=|>=|<|>)\s*([\d.]+)$')
    parsed = []
    for p in parts:
        m = cond_pat.match(p)
        parsed.append(
            (m.group(1).strip(), m.group(2), float(m.group(3)), p) if m
            else (None, None, None, p)
        )

    used      = set()
    new_parts = []
    for i, (feat_i, op_i, val_i, orig_i) in enumerate(parsed):
        if i in used:
            continue
        if feat_i is None:
            new_parts.append(orig_i)
            continue

        collapsed = False
        for j, (feat_j, op_j, val_j, orig_j) in enumerate(parsed):
            if j <= i or j in used or feat_j != feat_i:
                continue

            # Identify which side is lower bound and which is upper
            if op_i in ('>', '>=') and op_j in ('<', '<='):
                lo_op, lo_val, hi_op, hi_val = op_i, val_i, op_j, val_j
            elif op_i in ('<', '<=') and op_j in ('>', '>='):
                lo_op, lo_val, hi_op, hi_val = op_j, val_j, op_i, val_i
            else:
                continue  # same direction — not a range pair

            # Derive integer bounds (.5 midpoints for integer-valued features,
            # exact values for continuous ones — 1-unit precision loss is acceptable)
            lo_bound = int(lo_val) + 1 if lo_op == '>'  else int(lo_val)
            hi_bound = int(hi_val)     if hi_op == '<=' else int(hi_val) - 1

            if lo_bound <= hi_bound:
                new_parts.append(f'{feat_i} between {lo_bound} and {hi_bound}')
                used.update((i, j))
                collapsed = True
                break

        if not collapsed:
            new_parts.append(orig_i)

    return ' & '.join(new_parts)

def _resolve_location(op, threshold_str, loc_mapping):
    """
    Resolve 'Location Group op N' to a readable location-name phrase using
    the actual encoding from the model's own label_mappings.

    Both > and <= reference the "high" set (codes above the threshold):
      > N  → "at <high locations>"
      <= N → "at locations other than <high locations>"
    """
    thresh = float(threshold_str)
    sorted_locs = sorted((float(code), name) for code, name in loc_mapping.items())
    high = [name for code, name in sorted_locs if code > thresh]
    low  = [name for code, name in sorted_locs if code <= thresh]

    if not high:
        return 'at all locations'
    if not low:
        return 'at no locations'

    if op in ('>', '>='):
        return f'at {_join_names(high)}'
    else:
        return f'at locations other than {_join_names(high)}'

def _clean_numeric(feat, op, val_str):
    """Round a numeric threshold to integer and use unicode ≤/≥ symbols."""
    int_val = int(float(val_str))
    display_op = {'<=': '≤', '>=': '≥'}.get(op, op)
    return f'{feat} {display_op} {int_val}'

# ── Theme classification ──────────────────────────────────────────────────────

# Ordered priority: first matching raw column name wins
_THEME_SIGNALS = [
    ('same_surgeon_efficiency',   ['Turnover_NextCaseSameSurgeon']),
    ('case_length_multiplier',    ['Sched_SchedDur']),
    ('location_campus_variation', ['Loc_ORGrp2', 'Case_SurgeonService']),
]

THEMES_META = {
    'same_surgeon_efficiency': {
        'theme_name':  'Same-Surgeon Back-to-Back Cases',
        'description': 'Rules where the primary driver is whether consecutive cases share the same surgeon, capturing workflow-continuity efficiency.',
    },
    'case_length_multiplier': {
        'theme_name':  'Scheduled Case Duration Effects',
        'description': 'Rules primarily driven by scheduled case duration, reflecting how longer-booked procedures correlate with extended room turnovers.',
    },
    'location_campus_variation': {
        'theme_name':  'Location & Service Line Variation',
        'description': 'Rules primarily driven by OR location group or surgeon service, capturing campus- and specialty-level baseline differences in turnover.',
    },
    'other': {
        'theme_name':  'Other Factors',
        'description': 'Rules driven by day-of-week, case position, ASA acuity, or multi-factor combinations not captured by the primary themes.',
    },
}

def _assign_theme(rule_str):
    """Return the theme key for a RuleFit rule based on its primary raw feature."""
    for theme_key, signals in _THEME_SIGNALS:
        if any(sig in rule_str for sig in signals):
            return theme_key
    return 'other'

def to_plain_english(rule_str, label_mappings):
    """
    Substitute display names and clean up RuleFit/SkopeRules threshold artifacts.
    label_mappings: {col: {int_code: str_label}} from the model's own encoding.
    """
    result = str(rule_str)

    # 0. Collapse redundant range conditions on the same feature before any substitution
    result = _collapse_ranges_raw(result)

    # 1. Substitute raw column names (longest first to prevent partial matches)
    for raw, display in sorted(FEAT_DISPLAY.items(), key=lambda x: -len(x[0])):
        result = result.replace(raw, display)

    # 2. Binary features: > 0.5 → is YES, <= 0.5 → is NO
    for feat in _BINARY_DISPLAY:
        result = re.sub(
            rf'{re.escape(feat)}\s*>\s*0\.5',
            f'{feat} is YES',
            result,
        )
        result = re.sub(
            rf'{re.escape(feat)}\s*<=\s*0\.5',
            f'{feat} is NO',
            result,
        )

    # 3. Location Group: resolve threshold using this model's actual encoding
    loc_mapping = label_mappings.get('Loc_ORGrp2', {})
    result = re.sub(
        r'Location Group\s*(<=|>=|<|>)\s*([\d.]+)',
        lambda m: _resolve_location(m.group(1), m.group(2), loc_mapping),
        result,
    )

    # 3a. Surgeon Service: resolve to concise service line description
    svc_mapping = label_mappings.get('Case_SurgeonService', {})
    if svc_mapping:
        result = re.sub(
            r'Surgeon Service\s*(<=|>=|<|>)\s*([\d.]+)',
            lambda m: _resolve_service_lines(m.group(1), m.group(2), svc_mapping),
            result,
        )

    # 3b. ASA Acuity: resolve to plain acuity description
    asa_mapping = label_mappings.get('Case_ASACode', {})
    if asa_mapping:
        result = re.sub(
            r'ASA Acuity\s*(<=|>=|<|>)\s*([\d.]+)',
            lambda m: _resolve_asa(m.group(1), m.group(2), asa_mapping),
            result,
        )

    # 4. Opaque categoricals: replace "Feature op number" with "Feature (description)"
    for feat, desc in _OPAQUE_CAT_DISPLAY.items():
        result = re.sub(
            rf'{re.escape(feat)}\s*(?:<=|>=|<|>)\s*[\d.]+',
            f'{feat} ({desc})',
            result,
        )

    # 5. Numeric features: keep threshold, strip .0/.5 decimal, use ≤/≥ symbols
    for feat in _NUMERIC_DISPLAY:
        result = re.sub(
            rf'{re.escape(feat)}\s*(<=|>=|<|>)\s*([\d.]+)',
            lambda m, f=feat: _clean_numeric(f, m.group(1), m.group(2)),
            result,
        )

    # 6. Final phrase replacements for readability
    result = result.replace('Same Surgeon Next Case is YES', 'back-to-back cases by the same surgeon')
    result = result.replace('Same Surgeon Next Case is NO',  'surgeon change between cases')

    # Fix degenerate "between N and N" (same bound on both sides) → "exactly N"
    # Uses regex backreference \1 to detect identical bounds
    result = re.sub(
        r'Cases in Room That Day between (\d+) and \1\b',
        lambda m: f'exactly {m.group(1)} cases in room',
        result,
    )

    # Fallback: if a "Surgeon Service between X and Y" survived all prior passes
    # (produced by _collapse_ranges_raw before display-name substitution), it means
    # the pair of conditions spanned a range too wide to resolve to a named side
    result = re.sub(
        r'Surgeon Service between \d+ and \d+',
        'for mid-range service lines',
        result,
    )

    return result


# ── Step 8: RuleFit Classifier (turnover > 45 min) ───────────────────────────

print()
print("=" * 60)
print("Step 8: Training RuleFit Classifier (target: turnover > 45 min)...")
print("=" * 60)

rulefit_skipped = False
rulefit_rules   = []

try:
    from imodels import RuleFitClassifier
except ImportError:
    print("  imodels not installed.  Run: pip install imodels")
    print("  Skipping RuleFit Classifier.")
    rulefit_skipped = True
except Exception as e:
    print(f"  imodels import failed unexpectedly: {e}")
    print("  Skipping RuleFit Classifier.")
    rulefit_skipped = True

if not rulefit_skipped:
    # Binary target: 1 = turnover exceeds 45 minutes, 0 = at or under
    TURNOVER_THRESHOLD = 45
    y_binary_rf = (y_train_rf > TURNOVER_THRESHOLD).astype(int)

    n_above = int(y_binary_rf.sum())
    n_below = int(len(y_binary_rf) - n_above)
    pct_above = 100 * n_above / len(y_binary_rf)
    print(f"  Class balance: {n_above:,} above {TURNOVER_THRESHOLD} min ({pct_above:.1f}%)  |  "
          f"{n_below:,} at/under ({100 - pct_above:.1f}%)")

    rf_clf = RuleFitClassifier(max_rules=200, random_state=42)
    print("  Fitting RuleFitClassifier (max_rules=200)...")
    X_train_np = X_train_rf.values.astype(float)
    y_train_np = y_binary_rf.values.astype(int)
    rf_clf.fit(X_train_np, y_train_np, feature_names=list(X_train_rf.columns))
    print("  RuleFitClassifier training complete.")

    print("  Extracting and filtering rules...")
    rules_df = None
    for method_name, extractor in [
        ('get_rules()',           lambda: rf_clf.get_rules()),
        ('_get_rules()',          lambda: rf_clf._get_rules()),
        ('rule_ensemble.rules',   lambda: rf_clf.rule_ensemble.rules),
        ('rules_',                lambda: rf_clf.rules_),
    ]:
        try:
            raw = extractor()
            import pandas as _pd
            if not isinstance(raw, _pd.DataFrame):
                # coerce list/other to DataFrame
                raw = _pd.DataFrame(raw)
            rules_df = raw
            print(f"  Rule extraction succeeded via {method_name}")
            break
        except Exception as _e:
            print(f"  {method_name} failed: {_e}")
    if rules_df is None:
        raise RuntimeError("Could not extract rules from RuleFitClassifier — all methods failed")

    # Keep only tree-derived rules with a non-zero coefficient and ≥2% coverage
    if 'type' in rules_df.columns:
        rules_df = rules_df[rules_df['type'] == 'rule'].copy()

    rules_df = rules_df[
        (rules_df['coef'] != 0) &
        (rules_df['support'] > 0.02)
    ].copy()

    # Derive importance from |coef| × support if not already present
    if 'importance' not in rules_df.columns:
        rules_df['importance'] = rules_df['coef'].abs() * rules_df['support']

    rules_df = rules_df.sort_values('importance', ascending=False).head(20).reset_index(drop=True)
    print(f"  {len(rules_df)} rules pass filters (coef≠0, support>0.02), keeping top 20")

    n_train_rf = len(X_train_rf)
    for _, row in rules_df.iterrows():
        rule_str  = str(row['rule'])
        coef      = float(row['coef'])
        support   = float(row['support'])
        importance = float(row['importance'])

        rulefit_rules.append({
            'rule':          rule_str,
            'importance':    round(importance, 4),
            'support':       round(support, 4),
            'support_count': int(round(support * n_train_rf)),
            'coef':          round(coef, 4),
            'direction':     'risk' if coef > 0 else 'protective',
            'plain_english': to_plain_english(rule_str, rf_cat_mappings),
        })

    if rulefit_rules:
        print(f"  Top rule (importance={rulefit_rules[0]['importance']:.4f}): "
              f"{rulefit_rules[0]['rule']}")

    # Count above/below for the full df_rulefit (train+test) for the JSON header
    y_full_binary = (y_rf > TURNOVER_THRESHOLD).astype(int)
    n_above_full  = int(y_full_binary.sum())
    n_below_full  = int(len(y_full_binary) - n_above_full)

    rulefit_output = {
        'model_name':         'RuleFitClassifier',
        'trained_at':         datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'target_description': (
            'Identifies conditions associated with turnovers exceeding 45 minutes at hospital OR locations. '
            'System average is 51 minutes; aspirational goal is 30 minutes. '
            'coef > 0 (direction=risk) means the rule is associated with longer turnovers; '
            'coef < 0 (direction=protective) means associated with staying under target. '
            'Trained on filtered dataset excluding endoscopy suites, low-volume ORs, '
            'and WILH OR Gastroenterology cases.'
        ),
        'threshold_minutes':   TURNOVER_THRESHOLD,
        'n_training_samples':  n_train_rf,
        'n_above_threshold':   n_above_full,
        'n_below_threshold':   n_below_full,
        'rules':               rulefit_rules,
    }

    rulefit_path = os.path.join(out_dir, 'turnover_rulefit.json')
    with open(rulefit_path, 'w', encoding='utf-8') as f:
        json.dump(rulefit_output, f, indent=2, allow_nan=False)

    size_kb = os.path.getsize(rulefit_path) / 1024
    print(f"  Saved: {rulefit_path}  ({size_kb:.1f} KB)")


# ── Step 9: Skope-Rules ───────────────────────────────────────────────────────

print()
print("=" * 60)
print("Step 9: Training Skope-Rules (binary: turnover > 30 min)...")
print("=" * 60)

skrules_skipped = False
skrules_rules   = []

try:
    from skrules import SkopeRules
except ImportError:
    try:
        from skope_rules import SkopeRules
        print("  Imported SkopeRules from 'skope_rules' (alternate package name)")
    except ImportError:
        print("  Skope-Rules not installed.  Run: pip install skrules")
        print("  Skipping Skope-Rules model.")
        skrules_skipped = True
except Exception as e:
    print(f"  skrules import failed unexpectedly: {e}")
    print("  Skipping Skope-Rules model.")
    skrules_skipped = True

if not skrules_skipped:
    THRESHOLD = 30
    y_binary  = (y_train > THRESHOLD).astype(int)
    n_positive = int(y_binary.sum())
    n_total    = len(y_binary)
    print(f"  Binary target: turnover > {THRESHOLD} min")
    print(f"  Positive cases: {n_positive:,} / {n_total:,} ({100 * n_positive / n_total:.1f}%)")

    sk_model = SkopeRules(
        precision_min=0.6,
        recall_min=0.05,
        n_estimators=10,
        random_state=42,
        feature_names=list(X_train.columns),
    )
    print("  Fitting Skope-Rules (precision_min=0.6, recall_min=0.05)...")
    sk_model.fit(X_train.values, y_binary.values)
    print("  Skope-Rules training complete.")

    print("  Extracting rules...")
    # rules_ is a list of (rule_string, (precision, recall, n_support)) tuples
    for entry in sk_model.rules_:
        rule_str, stats = entry[0], entry[1]
        skrules_rules.append({
            'rule':          rule_str,
            'precision':     round(float(stats[0]), 4),
            'recall':        round(float(stats[1]), 4),
            'support_count': int(stats[2]),
            'plain_english': to_plain_english(rule_str, cat_mappings),
        })

    # Sort by precision descending, take top 15
    skrules_rules.sort(key=lambda r: r['precision'], reverse=True)
    skrules_rules = skrules_rules[:15]

    print(f"  {len(skrules_rules)} rules extracted (top 15 by precision)")
    if skrules_rules:
        print(f"  Top rule (precision={skrules_rules[0]['precision']:.2f}): "
              f"{skrules_rules[0]['rule']}")

    skrules_output = {
        'model_name':         'SkopeRules',
        'trained_at':         datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'target_description': (
            f'Identifies rule-based conditions that predict turnover time exceeding '
            f'{THRESHOLD} minutes. Precision = how often the rule correctly identifies '
            f'a long turnover. Recall = fraction of all long turnovers the rule catches.'
        ),
        'threshold_minutes':  THRESHOLD,
        'n_training_samples': n_total,
        'n_positive_cases':   n_positive,
        'rules':              skrules_rules,
    }

    skrules_path = os.path.join(out_dir, 'turnover_skoperules.json')
    with open(skrules_path, 'w', encoding='utf-8') as f:
        json.dump(skrules_output, f, indent=2, allow_nan=False)

    size_kb = os.path.getsize(skrules_path) / 1024
    print(f"  Saved: {skrules_path}  ({size_kb:.1f} KB)")


# ── Step 10: Combinations tab pre-computation ────────────────────────────────

print()
print("=" * 60)
print("Step 10: Pre-computing Atlas Combinations data...")
print("=" * 60)

SYSTEM_MEAN   = 51.05
TARGET_MIN    = 30
TOTAL_CASES   = 51048
COMBO_LOCS    = ('MARH OR', 'MEMH OR', 'OLLH OR', 'VORH JRI OR', 'VORH OR')

BASE_WHERE = (
    "CaseLogStatus = 'Posted' "
    "AND Turnover_Turnover > 0 "
    "AND Turnover_Turnover <= 120 "
    "AND Loc_ORGrp2 IN ({locs})"
).format(locs=', '.join(f"'{l}'" for l in COMBO_LOCS))

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
    with open(combos_path, 'w', encoding='utf-8') as f:
        json.dump(combos_output, f, indent=2, allow_nan=False)

    size_kb = os.path.getsize(combos_path) / 1024
    print(f"  {len(all_combos)} combinations saved: {combos_path}  ({size_kb:.1f} KB)")

except Exception as e:
    print(f"  Step 10 failed: {e}")
    print("  turnover_combinations.json was NOT written — continuing to final summary")


# ── Final summary ─────────────────────────────────────────────────────────────

print()
print("=" * 60)
print("Done.")
print(f"  RuleFit    : {'skipped (pip install rulefit)' if rulefit_skipped else f'{len(rulefit_rules)} rules saved'}")
print(f"  Skope-Rules: {'skipped (pip install skrules)' if skrules_skipped else f'{len(skrules_rules)} rules saved'}")
print(f"  Train rows : {len(X_train):,}")
print("=" * 60)

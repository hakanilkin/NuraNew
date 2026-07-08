#!/usr/bin/env python3
"""
Performance Briefs Pipeline
Derives block-utilization status, QoQ deltas, and deterministic findings for
every CaseBlock over the two most recent complete quarters, then writes:
  public/data/{tenant}/performance_briefs.json
  public/data/{tenant}/performance_briefs_context.json  (only if missing)

Usage:
    pip install python-dotenv pyodbc pandas
    python performance_briefs_pipeline.py --tenant virtua
    python performance_briefs_pipeline.py --tenant ohs
"""

import os
import json
import math
import datetime

import pandas as pd
import pyodbc
from dotenv import load_dotenv


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

args, cfg = parse_tenant_arg('Performance Briefs Pipeline')
server, database, user, password = get_db_params(cfg)

conn_str = (
    f"DRIVER={{ODBC Driver 18 for SQL Server}};"
    f"SERVER={server};DATABASE={database};"
    f"UID={user};PWD={password};"
    "Encrypt=yes;TrustServerCertificate=no;Connection Timeout=30;"
)
conn = pyodbc.connect(conn_str, timeout=30)
print(f"  Connected to {server} / {database}")


# ── Step 2: Derive two most recent complete quarters ─────────────────────────

print()
print("=" * 60)
print("Step 2: Deriving quarter date ranges...")
print("=" * 60)


def _quarter_end(year, q):
    ends = {1: (3, 31), 2: (6, 30), 3: (9, 30), 4: (12, 31)}
    m, d = ends[q]
    return datetime.date(year, m, d)


def get_two_complete_quarters(anchor=None):
    """
    Return ((label, start, end), (label, start, end)) for the two most recent complete
    quarters whose end date falls on or before *anchor*.  When anchor is None, falls back
    to yesterday so the current calendar quarter (which ends today or later) is excluded.
    """
    if anchor is None:
        anchor = datetime.date.today() - datetime.timedelta(days=1)

    complete = []
    for year in range(anchor.year - 2, anchor.year + 1):
        for q in range(1, 5):
            q_end   = _quarter_end(year, q)
            q_start = datetime.date(year, (q - 1) * 3 + 1, 1)
            if q_end <= anchor:                        # data-aware: ≤ anchor, not < today
                complete.append((f'{year}-Q{q}', q_start, q_end))

    complete.sort(key=lambda x: x[2], reverse=True)
    return complete[0], complete[1]


# Query max block date so lagging tenants pick the quarters their data actually covers.
_max_row = pd.read_sql("SELECT MAX(Blockdate) AS MaxDate FROM V4_BlockResultsView", conn)
_raw_max = _max_row['MaxDate'].iloc[0]
if _raw_max is not None and not pd.isnull(_raw_max):
    _data_anchor = _raw_max.date() if hasattr(_raw_max, 'date') else \
                   datetime.date.fromisoformat(str(_raw_max)[:10])
else:
    _data_anchor = datetime.date.today() - datetime.timedelta(days=1)
    print("  Warning: no rows in V4_BlockResultsView; using yesterday as anchor.")

(curr_label, curr_start, curr_end), (prior_label, prior_start, prior_end) = \
    get_two_complete_quarters(anchor=_data_anchor)

print(f"  Data through {_data_anchor} → current: {curr_label}, prior: {prior_label}")
print(f"  Current quarter : {curr_label}  ({curr_start} → {curr_end})")
print(f"  Prior quarter   : {prior_label}  ({prior_start} → {prior_end})")


# ── Step 3: Pull block results from V4_BlockResultsView ──────────────────────

print()
print("=" * 60)
print("Step 3: Pulling V4_BlockResultsView data...")
print("=" * 60)

# Values are computed dates (not user input) — f-string is safe here.
QUERY = f"""
SELECT
  ISNULL(CaseBlock, 'Unknown') AS CaseBlock,
  CASE
    WHEN BlockDate BETWEEN '{curr_start}'  AND '{curr_end}'  THEN 'current'
    WHEN BlockDate BETWEEN '{prior_start}' AND '{prior_end}' THEN 'prior'
  END AS quarter_key,
  SUM(ISNULL(BlockTime, 0))         AS allocated,
  SUM(ISNULL(InBlock, 0))           AS inblock,
  CASE WHEN SUM(ISNULL(BlockTime, 0)) = 0 THEN NULL
       ELSE 100.0 * SUM(ISNULL(InBlock, 0))
              / NULLIF(SUM(ISNULL(BlockTime, 0)), 0)
  END AS inblock_util,
  CASE WHEN SUM(ISNULL(BlockTime, 0)) = 0 THEN NULL
       ELSE 100.0 * SUM(ISNULL(Total_Prime_Time, 0))
              / NULLIF(SUM(ISNULL(BlockTime, 0)), 0)
  END AS primetime_util,
  SUM(ISNULL(ReleasedTime, 0))      AS released,
  SUM(ISNULL(OutofBlock, 0))        AS outofblock,
  COUNT(DISTINCT CaseID)            AS volume
FROM V4_BlockResultsView
WHERE (BlockDate BETWEEN '{prior_start}' AND '{prior_end}')
   OR (BlockDate BETWEEN '{curr_start}'  AND '{curr_end}')
GROUP BY
  ISNULL(CaseBlock, 'Unknown'),
  CASE
    WHEN BlockDate BETWEEN '{curr_start}'  AND '{curr_end}'  THEN 'current'
    WHEN BlockDate BETWEEN '{prior_start}' AND '{prior_end}' THEN 'prior'
  END
ORDER BY CaseBlock, quarter_key
"""

df = pd.read_sql(QUERY, conn)
conn.close()
print(f"  Rows returned: {len(df):,}  (up to 2 per CaseBlock)")
print(f"  CaseBlocks found: {df['CaseBlock'].nunique():,}")


# ── Step 4: Pivot into one row per CaseBlock ──────────────────────────────────

print()
print("=" * 60)
print("Step 4: Pivoting and computing QoQ deltas...")
print("=" * 60)

METRICS = ['allocated', 'inblock', 'inblock_util', 'primetime_util',
           'released', 'outofblock', 'volume']

curr_df  = df[df['quarter_key'] == 'current'].set_index('CaseBlock')[METRICS]
prior_df = df[df['quarter_key'] == 'prior'].set_index('CaseBlock')[METRICS]

# Only include CaseBlocks that appear in the current quarter
pivot = curr_df.copy()
pivot.columns = [f'curr_{c}' for c in METRICS]

# Join prior quarter (left join — some blocks may be new)
prior_df.columns = [f'prior_{c}' for c in METRICS]
pivot = pivot.join(prior_df, how='left')
pivot = pivot.reset_index()

print(f"  CaseBlocks with current-quarter data : {len(pivot):,}")
print(f"  CaseBlocks with prior-quarter data   : {pivot['prior_volume'].notna().sum():,}")


# ── Step 5: Status classification ────────────────────────────────────────────

print()
print("=" * 60)
print("Step 5: Classifying status...")
print("=" * 60)

rules = cfg['brief_status_rules']


def classify_status(ib, pt):
    """First-match status classification. Returns one of the five status keys."""
    if ib is None or pt is None or (isinstance(ib, float) and math.isnan(ib)) \
            or (isinstance(pt, float) and math.isnan(pt)):
        return 'watch'
    r = rules
    if ib < r['misaligned']['inblock_util_lt']      and pt > r['misaligned']['primetime_util_gt']:
        return 'misaligned'
    if ib > r['under_allocated']['inblock_util_gt']  and pt > r['under_allocated']['primetime_util_gt']:
        return 'under_allocated'
    rs = r['right_sized']
    if rs['inblock_util_min'] <= ib <= rs['inblock_util_max'] \
            and rs['primetime_util_min'] <= pt <= rs['primetime_util_max']:
        return 'right_sized'
    if ib < r['over_allocated']['inblock_util_lt']   and pt < r['over_allocated']['primetime_util_lt']:
        return 'over_allocated'
    return 'watch'


pivot['status'] = pivot.apply(
    lambda row: classify_status(row['curr_inblock_util'], row['curr_primetime_util']),
    axis=1,
)

status_counts = pivot['status'].value_counts().to_dict()
for s in ('misaligned', 'under_allocated', 'right_sized', 'over_allocated', 'watch'):
    print(f"  {s:20s}: {status_counts.get(s, 0)}")


# ── Step 6: Generate findings ─────────────────────────────────────────────────

print()
print("=" * 60)
print("Step 6: Generating findings...")
print("=" * 60)

UTIL_MOVE_THRESHOLD   = 8.0   # percentage points
VOLUME_MOVE_THRESHOLD = 10.0  # percent
OUTOFBLOCK_THRESHOLD  = 20.0  # percent of (inblock + outofblock)
RELEASED_THRESHOLD    = 15.0  # percent of allocated


def _pct(n, d):
    """Safe percentage: n/d*100, or None if d is 0 or None."""
    if not d or (isinstance(d, float) and math.isnan(d)):
        return None
    return n / d * 100.0


def build_findings(row):
    findings = []

    ib_curr  = row['curr_inblock_util']
    pt_curr  = row['curr_primetime_util']
    ib_prior = row['prior_inblock_util']
    pt_prior = row['prior_primetime_util']
    v_curr   = row['curr_volume']
    v_prior  = row['prior_volume']

    # 1. Inblock util moved >8pts QoQ
    if ib_curr is not None and ib_prior is not None \
            and not (isinstance(ib_curr, float) and math.isnan(ib_curr)) \
            and not (isinstance(ib_prior, float) and math.isnan(ib_prior)):
        delta = ib_curr - ib_prior
        if abs(delta) > UTIL_MOVE_THRESHOLD:
            findings.append({
                'type':     'inblock_util_qoq',
                'text':     (f'In-block utilization moved from {ib_prior:.1f}% to {ib_curr:.1f}% '
                             f'QoQ ({delta:+.1f} pts).'),
                'severity': 3 if delta < 0 else 2,
            })

    # 2. Primetime util moved >8pts QoQ
    if pt_curr is not None and pt_prior is not None \
            and not (isinstance(pt_curr, float) and math.isnan(pt_curr)) \
            and not (isinstance(pt_prior, float) and math.isnan(pt_prior)):
        delta = pt_curr - pt_prior
        if abs(delta) > UTIL_MOVE_THRESHOLD:
            findings.append({
                'type':     'primetime_util_qoq',
                'text':     (f'Primetime utilization moved from {pt_prior:.1f}% to {pt_curr:.1f}% '
                             f'QoQ ({delta:+.1f} pts).'),
                'severity': 3 if delta < 0 else 2,
            })

    # 3. Volume moved >10% QoQ
    if v_prior is not None and not (isinstance(v_prior, float) and math.isnan(v_prior)) \
            and v_prior > 0:
        v_pct = (v_curr - v_prior) / v_prior * 100.0
        if abs(v_pct) > VOLUME_MOVE_THRESHOLD:
            findings.append({
                'type':     'volume_qoq',
                'text':     (f'Volume moved from {int(v_prior)} to {int(v_curr)} cases '
                             f'QoQ ({v_pct:+.0f}%).'),
                'severity': 2,
            })

    # 4. Out-of-block > 20% of (inblock + outofblock)
    oob   = row['curr_outofblock']
    ib    = row['curr_inblock']
    total = ib + oob if (ib is not None and oob is not None) else None
    oob_pct = _pct(oob, total)
    if oob_pct is not None and oob_pct > OUTOFBLOCK_THRESHOLD:
        findings.append({
            'type':     'outofblock_high',
            'text':     (f'{oob_pct:.0f}% of OR time was out-of-block this quarter '
                         f'({oob:,.0f} min out of {total:,.0f} min total).'),
            'severity': 2,
        })

    # 5. Released > 15% of allocated
    rel    = row['curr_released']
    alloc  = row['curr_allocated']
    rel_pct = _pct(rel, alloc)
    if rel_pct is not None and rel_pct > RELEASED_THRESHOLD:
        findings.append({
            'type':     'released_high',
            'text':     (f'{rel_pct:.0f}% of allocated block time was released this quarter '
                         f'({rel:,.0f} min of {alloc:,.0f} min allocated).'),
            'severity': 1,
        })

    # Sort by severity descending; take top 4
    findings.sort(key=lambda f: f['severity'], reverse=True)
    return findings[:4]


pivot['findings'] = pivot.apply(build_findings, axis=1)
total_findings = pivot['findings'].apply(len).sum()
print(f"  Total findings generated: {total_findings}")
print(f"  Groups with ≥1 finding  : {pivot['findings'].apply(bool).sum()}")


# ── Step 7: Build output JSON ─────────────────────────────────────────────────

print()
print("=" * 60)
print("Step 7: Building output JSON...")
print("=" * 60)


def _safe_float(v, decimals=1):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    return round(float(v), decimals)


def _safe_int(v):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    return int(v)


groups = []
for _, row in pivot.iterrows():
    v_curr  = _safe_int(row['curr_volume'])
    v_prior = _safe_int(row['prior_volume'])

    if v_prior is not None and v_prior > 0:
        v_delta     = v_curr - v_prior
        v_delta_pct = _safe_float((v_curr - v_prior) / v_prior * 100.0, 1)
    else:
        v_delta     = None
        v_delta_pct = None

    ib_curr  = _safe_float(row['curr_inblock_util'])
    pt_curr  = _safe_float(row['curr_primetime_util'])
    ib_prior = _safe_float(row['prior_inblock_util'])
    pt_prior = _safe_float(row['prior_primetime_util'])

    groups.append({
        'caseblock':       row['CaseBlock'],
        'status':          row['status'],
        'inblock_util':    ib_curr,
        'primetime_util':  pt_curr,
        'volume':          v_curr,
        'deltas': {
            'volume':          v_delta,
            'volume_pct':      v_delta_pct,
            'inblock_util':    _safe_float(ib_curr - ib_prior)
                               if (ib_curr is not None and ib_prior is not None) else None,
            'primetime_util':  _safe_float(pt_curr - pt_prior)
                               if (pt_curr is not None and pt_prior is not None) else None,
        },
        'findings':        row['findings'],
        'allocated_hours': _safe_float(row['curr_allocated'] / 60.0, 2)
                           if row['curr_allocated'] else None,
        'budget':          None,
    })

output = {
    'period': {
        'current_quarter': curr_label,
        'prior_quarter':   prior_label,
    },
    'groups': groups,
}

print(f"  Groups in output: {len(groups)}")


# ── Step 8: Write performance_briefs.json (atomic) ────────────────────────────

print()
print("=" * 60)
print("Step 8: Writing performance_briefs.json...")
print("=" * 60)

script_dir = os.path.dirname(os.path.abspath(__file__))
out_dir    = os.path.join(script_dir, cfg['output_dir'])
os.makedirs(out_dir, exist_ok=True)

briefs_path = os.path.join(out_dir, 'performance_briefs.json')
_tmp = briefs_path + '.tmp'
with open(_tmp, 'w', encoding='utf-8') as f:
    json.dump(_sanitize(output), f, indent=2, allow_nan=False)
os.replace(_tmp, briefs_path)

size_kb = os.path.getsize(briefs_path) / 1024
print(f"  Saved: {briefs_path}")
print(f"  File size: {size_kb:.1f} KB")


# ── Step 9: Create performance_briefs_context.json if missing ─────────────────

print()
print("=" * 60)
print("Step 9: Ensuring performance_briefs_context.json exists...")
print("=" * 60)

ctx_path = os.path.join(out_dir, 'performance_briefs_context.json')

if os.path.exists(ctx_path):
    print(f"  Context file already exists — not overwriting: {ctx_path}")
else:
    # For virtua: seed from mock data where group name matches a real caseblock
    ctx = {}

    mock_path = os.path.join(script_dir, 'public', 'data', 'performance_briefs_mock.json')
    if os.path.exists(mock_path):
        try:
            with open(mock_path, encoding='utf-8') as f:
                mock_data = json.load(f)
            real_caseblocks = {g['caseblock'] for g in groups}
            for mg in mock_data.get('groups', []):
                name = mg.get('name', '')
                if name in real_caseblocks:
                    ctx[name] = {
                        'pipeline': mg.get('brief', ''),
                        'notes':    '',
                    }
            if ctx:
                print(f"  Seeded {len(ctx)} entries from mock data")
        except Exception as e:
            print(f"  Mock seed skipped: {e}")

    _tmp_ctx = ctx_path + '.tmp'
    with open(_tmp_ctx, 'w', encoding='utf-8') as f:
        json.dump(ctx, f, indent=2, allow_nan=False)
    os.replace(_tmp_ctx, ctx_path)
    print(f"  Created: {ctx_path}  ({len(ctx)} pre-seeded entries)")


# ── Final summary ─────────────────────────────────────────────────────────────

print()
print("=" * 60)
print("Done.")
print(f"  Period         : {prior_label} → {curr_label}")
print(f"  Groups         : {len(groups)}")
print(f"  Status breakdown:")
for s in ('misaligned', 'under_allocated', 'right_sized', 'over_allocated', 'watch'):
    print(f"    {s:20s}: {status_counts.get(s, 0)}")
print(f"  Output dir     : {out_dir}")
print("=" * 60)

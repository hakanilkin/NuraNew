#!/usr/bin/env python3
"""
Performance Briefs Pipeline
Derives block-utilization status, QoQ deltas, and deterministic findings for
every CaseBlock over the two most recent complete quarters, then writes:
  public/data/{tenant}/performance_briefs.json
  public/data/{tenant}/performance_briefs_context.json  (only if missing)

Usage:
    pip install python-dotenv pyodbc pandas
    python performance_briefs_pipeline.py --tenant nhs
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

# ── Block allocations (BlockAllocations.md) ──────────────────────────────────
#
# The briefs above say whether a block's volume matches its allocation. This
# says whether the *grid* matches how the surgeons actually practise, which is a
# different question with a different answer: a block on the wrong day looks
# over-allocated to anything that sums the week.
#
# Allocation and in-block use come from V4_BlockResultsView by weekday; the
# volume that lands outside any block comes from DS_CASES. Both over the current
# review period, averaged per week.

print()
print("=" * 60)
print("Step 7b: Block allocation patterns...")
print("=" * 60)

import block_patterns as BP  # noqa: E402
from pipeline_config import _tenant_columns  # noqa: E402

_tenant_block_thresholds = (
    _tenant_columns().get(cfg.get('tenant_config_key') or '', {})
    .get('params', {}).get('block_pattern_thresholds'))

_ALLOC_QUERY = f"""
SELECT ISNULL(CaseBlock, 'Unknown')                  AS CaseBlock,
       ISNULL(Group_Service, 'Unknown')              AS Service,
       ISNULL(LocationGroup, 'Unknown')              AS Site,
       (DATEPART(WEEKDAY, BlockDate) + 5) % 7        AS Dow,
       SUM(ISNULL(blockTime, 0))   / 60.0            AS AllocHours,
       SUM(ISNULL(InBlock, 0))     / 60.0            AS UsedHours,
       SUM(ISNULL(ReleasedTime, 0)) / 60.0           AS ReleasedHours,
       COUNT(DISTINCT CASE WHEN ISNULL(ReleasedTime, 0) > 0
                           THEN CAST(BlockDate AS DATE) END)          AS ReleasedDays,
       COUNT(DISTINCT CAST(BlockDate AS DATE))       AS Instances
FROM V4_BlockResultsView
WHERE BlockDate BETWEEN '{curr_start}' AND '{curr_end}'
  AND DATEPART(WEEKDAY, BlockDate) BETWEEN 2 AND 6
GROUP BY CaseBlock, Group_Service, LocationGroup, (DATEPART(WEEKDAY, BlockDate) + 5) % 7
"""

# In-block case OR-in / OR-out minute of day, per site and weekday. The prime
# window — the operating (block) day — is derived from these: in-block hours are
# prime by definition (BlockAllocationsPrimeTime.md section 2), so the earliest
# starts and latest ends of in-block work, guarded by a 10th/90th percentile,
# are its envelope. Nothing is hardcoded.
_INBLOCK_TIMES_QUERY = f"""
SELECT ISNULL(c.Loc_ORGrp2, 'Unknown')                        AS Site,
       (DATEPART(WEEKDAY, c.Date_SchedDate) + 5) % 7          AS Dow,
       DATEPART(HOUR, c.Time_ORin)  * 60 + DATEPART(MINUTE, c.Time_ORin)  AS InMin,
       DATEPART(HOUR, c.Time_OROut) * 60 + DATEPART(MINUTE, c.Time_OROut) AS OutMin
FROM DS_CASES c
WHERE c.Date_SchedDate BETWEEN '{curr_start}' AND '{curr_end}'
  AND c.Case_CanCode IS NULL
  AND ISNULL(c.Case_CaseBlock, 'Open') <> 'Open'
  AND c.Time_ORin IS NOT NULL AND c.Time_OROut IS NOT NULL
  AND DATEPART(WEEKDAY, c.Date_SchedDate) BETWEEN 2 AND 6
"""

# How far into its block the day actually runs, for the wrong-shape test.
_TAIL_QUERY = f"""
SELECT ISNULL(CaseBlock, 'Unknown') AS CaseBlock,
       AVG(CAST(LastOut AS FLOAT))  AS LastOutHours
FROM (
  SELECT ISNULL(Case_CaseBlock, 'Open')                    AS CaseBlock,
         CAST(Date_SchedDate AS DATE)                      AS d,
         (MAX(DATEPART(HOUR, Time_OROut) * 60 + DATEPART(MINUTE, Time_OROut))
          - 7 * 60) / 60.0                                 AS LastOut
  FROM DS_CASES
  WHERE Date_SchedDate BETWEEN '{curr_start}' AND '{curr_end}'
    AND Case_CanCode IS NULL AND Time_OROut IS NOT NULL
    AND ISNULL(Case_CaseBlock, 'Open') <> 'Open'
  GROUP BY Case_CaseBlock, CAST(Date_SchedDate AS DATE)
) x
GROUP BY CaseBlock
"""

_conn2 = pyodbc.connect(conn_str, timeout=30)
df_alloc = pd.read_sql(_ALLOC_QUERY, _conn2)
df_tail = pd.read_sql(_TAIL_QUERY, _conn2)
df_inblock = pd.read_sql(_INBLOCK_TIMES_QUERY, _conn2)


# ── Prime window per site × dow (BlockAllocationsPrimeTime.md section 2) ──────
# Optional per-site override wins; otherwise derive from the in-block envelope.
# When neither is available the split is suppressed and the page falls back to a
# single outside number, so NHS/OHS keep working (section 9).

def _hhmm_to_min(s):
    h, m = str(s).split(':')
    return int(h) * 60 + int(m)


_prime_override = (
    _tenant_columns().get(cfg.get('tenant_config_key') or '', {})
    .get('params', {}).get('prime_time_window') or {})

_prime_windows = {}   # (site, dow) -> (start_min, end_min)
_site_env = {}        # site -> (start_min, end_min): the fallback for a thin/absent dow

# In-block cases are daytime, but normalise defensively so a case that crosses
# midnight (OutMin < InMin) does not corrupt the envelope quantiles.
if len(df_inblock):
    df_inblock.loc[df_inblock['OutMin'] < df_inblock['InMin'], 'OutMin'] += 1440

try:
    # Derived envelope, guarded so one late outlier does not stretch it.
    if len(df_inblock):
        g = df_inblock.groupby(['Site', 'Dow'])
        derived = {(s, int(d)): (float(grp['InMin'].quantile(0.10)),
                                 float(grp['OutMin'].quantile(0.90)))
                   for (s, d), grp in g}
        # Per-site fallback across weekdays for a (site, dow) with thin data.
        _site_env = {s: (float(grp['InMin'].quantile(0.10)),
                         float(grp['OutMin'].quantile(0.90)))
                     for s, grp in df_inblock.groupby('Site')}
        counts = g.size().to_dict()
        for (s, d), w in derived.items():
            _prime_windows[(s, d)] = w if counts.get((s, d), 0) >= 20 else _site_env.get(s, w)
    # Override is authoritative and applies to every weekday at that site, and is
    # its own site-level fallback too.
    for site, win in _prime_override.items():
        try:
            ws, we = _hhmm_to_min(win[0]), _hhmm_to_min(win[1])
            for d in range(5):
                _prime_windows[(site, d)] = (ws, we)
            _site_env[site] = (ws, we)
        except (ValueError, IndexError, TypeError):
            print(f"  Warning: bad prime_time_window for {site!r}; ignoring.")
except Exception as e:  # derivation must never take the pipeline down
    print(f"  Warning: prime window derivation failed ({e}); split suppressed.")
    _prime_windows, _site_env = {}, {}

_split = bool(_prime_windows)
print(f"  Prime windows resolved for {len(_prime_windows)} site×dow "
      f"({'override + derived' if _prime_override else 'derived'})"
      if _split else "  Prime window unavailable — outside split suppressed.")

# Assertion (section 2): in-block hours are prime by definition. Log, do not
# swallow, any site×dow whose in-block work materially falls outside its window.
if _split and len(df_inblock):
    for (s, d), grp in df_inblock.groupby(['Site', 'Dow']):
        w = _prime_windows.get((s, int(d)))
        if not w:
            continue
        ws, we = w
        inside = ((grp[['OutMin']].clip(upper=we).values
                   - grp[['InMin']].clip(lower=ws).values).clip(min=0)).sum()
        total = (grp['OutMin'] - grp['InMin']).clip(lower=0).sum()
        if total > 0 and inside / total < 0.95:
            print(f"  Warning: in-block hours fall outside the derived prime "
                  f"window at {s} dow {d} ({inside/total:.0%} inside) — window may be wrong.")

# Out-of-block hours and cases per service, site and weekday, split into the
# prime (operating-day) window and after it. The overlap is a standard CASE; the
# per-(site,dow) window bounds are injected below. Cases are counted whole into
# whichever bucket holds the majority of their minutes.
if _split:
    # Exact (site, dow) rows, plus a site-level fallback row per site with a
    # sentinel Dow of -1. A (site, dow) with no window of its own falls back to
    # the site envelope rather than being counted as fully prime — which would
    # suppress NON_PRIME_TIME exactly where in-block data is thinnest.
    def _q(s):
        return s.replace(chr(39), chr(39) * 2)
    _vals = ', '.join(
        [f"('{_q(s)}', {d}, {int(ws)}, {int(we)})"
         for (s, d), (ws, we) in _prime_windows.items()]
        + [f"('{_q(s)}', -1, {int(ws)}, {int(we)})"
           for s, (ws, we) in _site_env.items()])
    _OUTSIDE_QUERY = f"""
WITH oc AS (
  SELECT ISNULL(c.Case_SurgeonService, 'Unknown')          AS Service,
         ISNULL(c.Loc_ORGrp2, 'Unknown')                   AS Site,
         (DATEPART(WEEKDAY, c.Date_SchedDate) + 5) % 7     AS Dow,
         CAST(c.Date_SchedDate AS DATE)                    AS D,
         ISNULL(c.Dur_ORIn_OROut, 0)                       AS DurMin,
         DATEPART(HOUR, c.Time_ORin)  * 60 + DATEPART(MINUTE, c.Time_ORin)  AS InMin,
         -- Minutes from midnight; a case crossing midnight has OutMin < InMin,
         -- so carry it into the next day before any overlap is measured.
         CASE WHEN (DATEPART(HOUR, c.Time_OROut) * 60 + DATEPART(MINUTE, c.Time_OROut))
                 < (DATEPART(HOUR, c.Time_ORin)  * 60 + DATEPART(MINUTE, c.Time_ORin))
              THEN (DATEPART(HOUR, c.Time_OROut) * 60 + DATEPART(MINUTE, c.Time_OROut)) + 1440
              ELSE (DATEPART(HOUR, c.Time_OROut) * 60 + DATEPART(MINUTE, c.Time_OROut))
         END                                               AS OutMin
  FROM DS_CASES c
  WHERE c.Date_SchedDate BETWEEN '{curr_start}' AND '{curr_end}'
    AND c.Case_CanCode IS NULL
    AND ISNULL(c.Case_CaseBlock, 'Open') = 'Open'
    AND c.Time_ORin IS NOT NULL AND c.Time_OROut IS NOT NULL
    AND DATEPART(WEEKDAY, c.Date_SchedDate) BETWEEN 2 AND 6
),
w (Site, Dow, Ws, We) AS (
  SELECT * FROM (VALUES {_vals}) AS v (Site, Dow, Ws, We)
),
split AS (
  SELECT oc.Service, oc.Site, oc.Dow, oc.D, oc.DurMin,
    CASE
      WHEN wm.Ws IS NULL THEN oc.DurMin
      WHEN (CASE WHEN oc.OutMin < wm.We THEN oc.OutMin ELSE wm.We END)
         - (CASE WHEN oc.InMin  > wm.Ws THEN oc.InMin  ELSE wm.Ws END) > 0
      THEN (CASE WHEN oc.OutMin < wm.We THEN oc.OutMin ELSE wm.We END)
         - (CASE WHEN oc.InMin  > wm.Ws THEN oc.InMin  ELSE wm.Ws END)
      ELSE 0
    END AS PrimeMin
  FROM oc
  -- Prefer the exact (site, dow) window; fall back to the site envelope (-1).
  OUTER APPLY (
    SELECT TOP 1 wv.Ws, wv.We
    FROM w wv
    WHERE wv.Site = oc.Site AND (wv.Dow = oc.Dow OR wv.Dow = -1)
    ORDER BY CASE WHEN wv.Dow = oc.Dow THEN 0 ELSE 1 END
  ) wm
)
SELECT Service, Site, Dow,
       SUM(DurMin) / 60.0                 AS OutsideHours,
       SUM(PrimeMin) / 60.0              AS OutsidePrimeHours,
       SUM(DurMin - PrimeMin) / 60.0     AS OutsideNonPrimeHours,
       COUNT(*)                          AS OutsideCases,
       SUM(CASE WHEN PrimeMin >= DurMin - PrimeMin THEN 1 ELSE 0 END) AS OutsidePrimeCases,
       SUM(CASE WHEN PrimeMin <  DurMin - PrimeMin THEN 1 ELSE 0 END) AS OutsideNonPrimeCases,
       COUNT(DISTINCT D)                 AS Days
FROM split
GROUP BY Service, Site, Dow
"""
else:
    _OUTSIDE_QUERY = f"""
SELECT ISNULL(c.Case_SurgeonService, 'Unknown')          AS Service,
       ISNULL(c.Loc_ORGrp2, 'Unknown')                   AS Site,
       (DATEPART(WEEKDAY, c.Date_SchedDate) + 5) % 7     AS Dow,
       SUM(ISNULL(c.Dur_ORIn_OROut, 0)) / 60.0           AS OutsideHours,
       COUNT(*)                                          AS OutsideCases,
       COUNT(DISTINCT CAST(c.Date_SchedDate AS DATE))    AS Days
FROM DS_CASES c
WHERE c.Date_SchedDate BETWEEN '{curr_start}' AND '{curr_end}'
  AND c.Case_CanCode IS NULL
  AND ISNULL(c.Case_CaseBlock, 'Open') = 'Open'
  AND DATEPART(WEEKDAY, c.Date_SchedDate) BETWEEN 2 AND 6
GROUP BY c.Case_SurgeonService, c.Loc_ORGrp2, (DATEPART(WEEKDAY, c.Date_SchedDate) + 5) % 7
"""

df_outside = pd.read_sql(_OUTSIDE_QUERY, _conn2)
_conn2.close()

_weeks = max(1.0, (curr_end - curr_start).days / 7.0)
_tail = {r.CaseBlock: r.LastOutHours for r in df_tail.itertuples()}

# Out-of-block hours and cases per service, site and weekday, per week. Cases
# because a committee argues about cases more readily than about hours. When the
# prime split is available it carries the four columns; `outside` stays their sum
# so nothing downstream breaks before it is updated.
_outside = {}
_outside_cases = {}
_outside_prime = {}
_outside_nonprime = {}
_outside_prime_cases = {}
_outside_nonprime_cases = {}
for r in df_outside.itertuples():
    k = (r.Service, r.Site, int(r.Dow))
    _outside[k] = float(r.OutsideHours or 0) / _weeks
    _outside_cases[k] = float(getattr(r, 'OutsideCases', 0) or 0) / _weeks
    if _split:
        _outside_prime[k] = float(getattr(r, 'OutsidePrimeHours', 0) or 0) / _weeks
        _outside_nonprime[k] = float(getattr(r, 'OutsideNonPrimeHours', 0) or 0) / _weeks
        _outside_prime_cases[k] = float(getattr(r, 'OutsidePrimeCases', 0) or 0) / _weeks
        _outside_nonprime_cases[k] = float(getattr(r, 'OutsideNonPrimeCases', 0) or 0) / _weeks

_service_alloc = (df_alloc[df_alloc['CaseBlock'] != 'Open']
                  .groupby(['Service', 'Site'])['AllocHours'].sum().to_dict())

allocations = []
for (block, service, site), grp in df_alloc.groupby(['CaseBlock', 'Service', 'Site']):
    if block == 'Open':
        continue
    mine = float(grp['AllocHours'].sum())
    pool = _service_alloc.get((service, site), 0.0)
    share = (mine / pool) if pool > 0 else 0.0
    by_dow, release_events, instances = [], 0, 0
    released_by_dow = {}
    outside_cases_by_dow = {}
    outside_prime_cases_by_dow = {}
    outside_nonprime_cases_by_dow = {}
    for d in range(5):
        row = grp[grp['Dow'] == d]
        alloc = float(row['AllocHours'].sum()) / _weeks
        used = float(row['UsedHours'].sum()) / _weeks
        released_by_dow[d] = float(row['ReleasedHours'].sum()) / _weeks
        release_events += int(row['ReleasedDays'].sum())
        instances += int(row['Instances'].sum())
        # Out-of-block volume belongs to this service's blocks in proportion to
        # what each holds; crediting all of it to every block makes three ortho
        # blocks each look like they are losing the same hours.
        k = (service, site, d)
        entry = {'dow': d, 'alloc': alloc, 'used': used,
                 'outside': _outside.get(k, 0.0) * share}
        if _split:
            # The split rides the same apportioning share, so prime + non-prime
            # reconcile to `outside` on every day.
            entry['outsidePrime'] = _outside_prime.get(k, 0.0) * share
            entry['outsideNonPrime'] = _outside_nonprime.get(k, 0.0) * share
        by_dow.append(entry)
        # Apportioned on the same share as the hours, so the caption's cases and
        # its hours describe the same volume.
        outside_cases_by_dow[d] = _outside_cases.get(k, 0.0) * share
        outside_prime_cases_by_dow[d] = _outside_prime_cases.get(k, 0.0) * share
        outside_nonprime_cases_by_dow[d] = _outside_nonprime_cases.get(k, 0.0) * share
    brief = next((g for g in groups if g['caseblock'] == block), None)
    fwd = (brief or {}).get('context', {}).get('pipeline', {}) if brief else {}
    trend, trend_pct = BP.classify_trend(fwd.get('forecasted'), fwd.get('scheduled'))

    found = BP.classify_block(
        by_dow, release_events=release_events, release_of=max(instances, 0),
        last_case_out_hours=_tail.get(block), trend=trend,
        cfg=_tenant_block_thresholds)
    # Released hours are evidence, not a classifier input, so they are merged
    # back onto the weekdays the taxonomy normalised rather than passed through
    # it. The drawer's day table has to reconcile to the week shape beside it.
    found['byDow'] = [{**d,
                       'released': round(released_by_dow.get(d['dow'], 0.0), 2),
                       'outsideCases': round(outside_cases_by_dow.get(d['dow'], 0.0), 2),
                       **({'outsidePrimeCases': round(outside_prime_cases_by_dow.get(d['dow'], 0.0), 2),
                           'outsideNonPrimeCases': round(outside_nonprime_cases_by_dow.get(d['dow'], 0.0), 2)}
                          if _split else {})}
                      for d in found['byDow']]
    allocations.append({
        'owner': block, 'service': service, 'site': site,
        'trendPct': trend_pct, 'instances': instances,
        'releaseHistory': {'count': release_events, 'of': instances},
        **found,
    })

allocations.sort(key=lambda a: -(a['mismatchHours'] or 0))
print(f"  Owners classified: {len(allocations)}")
for pat in (BP.ABANDONED, BP.WRONG_DAY, BP.WRONG_SHAPE, BP.FRAGMENTED,
            BP.MISPLACED, BP.UNDER_ALLOCATED, BP.NON_PRIME_TIME, BP.OVER_ALLOCATED,
            BP.RIGHT_SIZED, BP.UNCLASSIFIED):
    n = sum(1 for a in allocations if a['pattern'] == pat)
    if n:
        print(f"    {pat:16s} {n}")


output = {
    'period': {
        'current_quarter': curr_label,
        'prior_quarter':   prior_label,
    },
    'groups': groups,
    'allocations': allocations,
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
    # For nhs: seed from mock data where group name matches a real caseblock
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

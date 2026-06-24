#!/usr/bin/env python3
"""
LOS Segments Pipeline
Pulls excess LOS data for OLLH and emits a single JSON artifact
(public/data/los_segments.json) for the 'Where to Focus' analysis.

Three structures:
  headline         — DISPO_GROUP × SERVICE_LINE ranked by total net excess days
  facility_segments — facility-bound service lines with sub-specialty + payer drills
  home_segments    — self-care/home-health service lines with sub-specialty + adm-hour drills

Usage:
    pip install python-dotenv pyodbc pandas numpy
    python los_segments_pipeline.py
"""

import os
import json
import datetime
import time

import pandas as pd
import numpy as np
import pyodbc
from dotenv import load_dotenv


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


# ── Step 2: Pull data ─────────────────────────────────────────────────────────

print()
print("=" * 60)
print("Step 2: Pulling excess LOS segment data...")
print("=" * 60)

QUERY = """
SELECT
  e.ACCOUNT_IPLOS,
  e.DRG_FINALDRGGMLOS,
  e.SERVICE_LINE,
  e.SERVICE_LINE_2,
  e.ENC_DISCHDISPO,
  e.ACCOUNT_FINANCIALCLASS,
  e.TIME_HOSPADMISSION,
  CASE
    WHEN e.DEP_LASTDEPT LIKE '%2E%' OR e.DEP_LASTDEPT LIKE '%2W%' THEN '2nd Floor'
    WHEN e.DEP_LASTDEPT LIKE '%3E%' OR e.DEP_LASTDEPT LIKE '%3W%' THEN '3rd Floor'
    WHEN e.DEP_LASTDEPT LIKE '%5W%' OR e.DEP_LASTDEPT LIKE '%6N%' THEN '6N/5W'
    WHEN e.DEP_LASTDEPT LIKE '%ICU%' OR e.DEP_LASTDEPT LIKE '%CORONARY CARE%' THEN 'ICU'
    WHEN e.DEP_LASTDEPT LIKE '%PCU%'                               THEN 'PCU'
    WHEN (e.DEP_LASTDEPT LIKE '%MOTHER BABY%' OR e.DEP_LASTDEPT LIKE '%LABOR%'
      OR  e.DEP_LASTDEPT LIKE '%SPECIAL CARE NURS%'
      OR  e.DEP_LASTDEPT LIKE '%NEWBORN%')                         THEN 'Maternal Child Health'
    WHEN e.DEP_LASTDEPT LIKE '%HOSPITAL AT HOME%'                  THEN 'Hospital at Home'
    WHEN e.DEP_LASTDEPT LIKE '%IP REHAB%'                          THEN 'Rehab'
    ELSE 'Other'
  END AS DEST_CATEGORY
FROM DS_Encounters e
WHERE e.DEP_LASTDEPTHOSPITAL = 'Our Lady of Lourdes Hospital'
  AND e.BEDDED = 'Y'
  AND e.TIME_HOSPADMISSION >= '2025-01-01'
  AND e.ACCOUNT_IPLOS      IS NOT NULL
  AND e.DRG_FINALDRGGMLOS  IS NOT NULL
  AND e.SERVICE_LINE        IS NOT NULL
  AND e.SERVICE_LINE NOT IN (
    'W&C Obstetrics', 'W&C Neonates', 'W&C Newborns', 'W&C Gynecology',
    'No DRG Match', 'NULL', 'Pediatrics', 'Behavioral Health'
  )
"""

df = run_query_with_retry(QUERY)
print(f"  Pulled {len(df):,} rows × {df.shape[1]} columns")


# ── Step 3: Derive columns and apply exclusions ───────────────────────────────

print()
print("=" * 60)
print("Step 3: Deriving columns and applying exclusions...")
print("=" * 60)

df['EXCESS_DAYS'] = (
    pd.to_numeric(df['ACCOUNT_IPLOS'],     errors='coerce') -
    pd.to_numeric(df['DRG_FINALDRGGMLOS'], errors='coerce')
)

before = len(df)
df = df.dropna(subset=['EXCESS_DAYS']).reset_index(drop=True)
if len(df) < before:
    print(f"  Dropped {before - len(df):,} rows with null EXCESS_DAYS")

print(f"  EXCESS_DAYS range: [{df['EXCESS_DAYS'].min():.2f}, {df['EXCESS_DAYS'].max():.2f}]")
print(f"  Mean: {df['EXCESS_DAYS'].mean():.2f}  Std: {df['EXCESS_DAYS'].std():.2f}")

# Cap at 30
before = len(df)
df = df[df['EXCESS_DAYS'] <= 30].reset_index(drop=True)
print(f"  Dropped {before - len(df):,} rows with EXCESS_DAYS > 30")

# String normalisation
df['ENC_DISCHDISPO']         = (df['ENC_DISCHDISPO']
    .fillna('Unknown').replace({'NULL': 'Unknown', 'None': 'Unknown', '': 'Unknown'}).astype(str))
df['SERVICE_LINE']           = df['SERVICE_LINE'].fillna('Unknown').astype(str)
df['SERVICE_LINE_2']         = df['SERVICE_LINE_2'].fillna('Unknown').astype(str)
df['DEST_CATEGORY']          = df['DEST_CATEGORY'].fillna('Other').astype(str)
df['ACCOUNT_FINANCIALCLASS'] = (df['ACCOUNT_FINANCIALCLASS']
    .fillna('Unknown').replace({'NULL': 'Unknown', 'None': 'Unknown', '': 'Unknown'}).astype(str))

# Exclusion 1: non-discharge outcomes
NON_DISCHARGE_TERMS = [
    'Expired', 'Left AMA', 'Court/Law Enforcement', 'Elopement',
    'Transfer to Short Term Hospital',
]
non_dc_mask = df['ENC_DISCHDISPO'].str.contains('|'.join(NON_DISCHARGE_TERMS), case=False, na=False)
print(f"\n  Excluding non-discharge outcomes ({non_dc_mask.sum():,} rows):")
for term in NON_DISCHARGE_TERMS:
    cnt = df['ENC_DISCHDISPO'].str.contains(term, case=False, na=False).sum()
    if cnt:
        print(f"    {cnt:>6,}  {term}")
before = len(df)
df = df[~non_dc_mask].reset_index(drop=True)
print(f"  After exclusion: {before:,} → {len(df):,} rows")

# Exclusion 2: Rehab unit
before = len(df)
df = df[df['DEST_CATEGORY'] != 'Rehab'].reset_index(drop=True)
print(f"  Removed Rehab unit rows: {before:,} → {len(df):,} rows")

print(f"\n  Final dataset: {len(df):,} rows")

# DISPO_GROUP
def _dispo_group(val):
    s = str(val)
    if s == 'Disch to Home or Self Care':
        return 'Self-care Home'
    if 'Home-Health' in s:
        return 'Home Health'
    return 'Facility-bound'

df['DISPO_GROUP'] = df['ENC_DISCHDISPO'].map(_dispo_group)
print("\n  DISPO_GROUP distribution:")
for grp, cnt in df['DISPO_GROUP'].value_counts().items():
    print(f"    {cnt:>6,}  {grp}")

# ADM_BUCKET: 4 buckets from admission hour
df['TIME_HOSPADMISSION'] = pd.to_datetime(df['TIME_HOSPADMISSION'], errors='coerce')

ADM_BUCKET_ORDER = [
    'Overnight (12a-6a)',
    'Morning (6a-12p)',
    'Afternoon (12p-5p)',
    'Evening (5p-12a)',
]

def _adm_bucket(dt):
    if pd.isna(dt):
        return 'Morning (6a-12p)'   # default unknown to daytime
    h = dt.hour
    if h <= 5:
        return 'Overnight (12a-6a)'
    if h <= 11:
        return 'Morning (6a-12p)'
    if h <= 16:
        return 'Afternoon (12p-5p)'
    return 'Evening (5p-12a)'

df['ADM_BUCKET'] = df['TIME_HOSPADMISSION'].map(_adm_bucket)
print("\n  ADM_BUCKET distribution:")
for bucket in ADM_BUCKET_ORDER:
    cnt = (df['ADM_BUCKET'] == bucket).sum()
    print(f"    {cnt:>6,}  {bucket}")

# Positive excess for system-level headline totals only
df['POS_EXCESS'] = df['EXCESS_DAYS'].clip(lower=0)


# ── Shared drill helper ───────────────────────────────────────────────────────

def build_drill_by_dim(subset, dim_col, min_n=20, top_n=6):
    """Group subset by dim_col, filter min_n, rank by net excess, return top_n."""
    grp = (
        subset.groupby(dim_col)
        .agg(
            n                 = ('EXCESS_DAYS', 'count'),
            avg_excess        = ('EXCESS_DAYS', 'mean'),
            total_excess_days = ('EXCESS_DAYS', 'sum'),
        )
        .reset_index()
    )
    grp = (
        grp[grp['n'] >= min_n]
        .sort_values('total_excess_days', ascending=False)
        .head(top_n)
    )
    return [
        {
            'label':            str(r[dim_col]),
            'n':                int(r['n']),
            'avg_excess':       round(float(r['avg_excess']), 2),
            'total_excess_days': round(float(r['total_excess_days']), 1),
        }
        for _, r in grp.iterrows()
    ]


# ── Step 4: Headline (DISPO_GROUP × SERVICE_LINE) ────────────────────────────

print()
print("=" * 60)
print("Step 4: Computing headline (DISPO_GROUP × SERVICE_LINE)...")
print("=" * 60)

system_total_excess = float(df['POS_EXCESS'].sum())   # positive only — unchanged
effective_beds      = round(system_total_excess / 365, 1)

hl_grp = (
    df.groupby(['DISPO_GROUP', 'SERVICE_LINE'])
    .agg(
        n                 = ('EXCESS_DAYS', 'count'),
        avg_excess        = ('EXCESS_DAYS', 'mean'),
        total_excess_days = ('EXCESS_DAYS', 'sum'),   # net excess for ranking
    )
    .reset_index()
    .sort_values('total_excess_days', ascending=False)
    .reset_index(drop=True)
)
hl_grp['cumulative_pct'] = (
    hl_grp['total_excess_days'].cumsum() / system_total_excess * 100
).round(1)

headline_rows = [
    {
        'disposition':      row['DISPO_GROUP'],
        'service_line':     row['SERVICE_LINE'],
        'n':                int(row['n']),
        'avg_excess':       round(float(row['avg_excess']), 2),
        'total_excess_days': round(float(row['total_excess_days']), 1),
        'cumulative_pct':   float(row['cumulative_pct']),
    }
    for _, row in hl_grp.iterrows()
]

headline = {
    'rows':              headline_rows,
    'total_excess_days': round(system_total_excess, 1),   # positive only, for stat cards
    'effective_beds':    effective_beds,
}

print(f"  {len(headline_rows)} DISPO_GROUP × SERVICE_LINE combinations")
print(f"  System total positive excess: {system_total_excess:,.0f} days  ({effective_beds:.1f} effective beds)")
print(f"  Top 5 by net excess:")
for r in headline_rows[:5]:
    print(f"    {r['disposition']:16s}  {r['service_line']:25s}  "
          f"n={r['n']:,}  avg={r['avg_excess']:+.2f}d  "
          f"total={r['total_excess_days']:+,.0f}d  cum={r['cumulative_pct']:.1f}%")


# ── Step 5: Facility segments ─────────────────────────────────────────────────

print()
print("=" * 60)
print("Step 5: Computing facility_segments...")
print("=" * 60)

fac_df = df[df['DISPO_GROUP'] == 'Facility-bound'].copy()
print(f"  Facility-bound rows: {len(fac_df):,}")

sl_grp = (
    fac_df.groupby('SERVICE_LINE')
    .agg(
        n                 = ('EXCESS_DAYS', 'count'),
        avg_excess        = ('EXCESS_DAYS', 'mean'),
        total_excess_days = ('EXCESS_DAYS', 'sum'),
    )
    .reset_index()
    .sort_values('total_excess_days', ascending=False)
)

facility_segments = []
for _, sl_row in sl_grp.iterrows():
    sl        = sl_row['SERVICE_LINE']
    sl_subset = fac_df[fac_df['SERVICE_LINE'] == sl]
    facility_segments.append({
        'disposition':       'Facility-bound',
        'service_line':       sl,
        'n':                  int(sl_row['n']),
        'avg_excess':         round(float(sl_row['avg_excess']), 2),
        'total_excess_days':  round(float(sl_row['total_excess_days']), 1),
        'drill': {
            'by_subspecialty': build_drill_by_dim(sl_subset, 'SERVICE_LINE_2'),
            'by_payer':        build_drill_by_dim(sl_subset, 'ACCOUNT_FINANCIALCLASS'),
        },
    })

print(f"  {len(facility_segments)} facility-bound service lines")
for seg in facility_segments[:3]:
    print(f"    {seg['service_line']:25s}  n={seg['n']:,}  avg={seg['avg_excess']:+.2f}d  "
          f"total={seg['total_excess_days']:+,.0f}d  "
          f"sub={len(seg['drill']['by_subspecialty'])}  payer={len(seg['drill']['by_payer'])}")


# ── Step 6: Home segments ─────────────────────────────────────────────────────

print()
print("=" * 60)
print("Step 6: Computing home_segments (Self-care Home + Home Health)...")
print("=" * 60)

home_df = df[df['DISPO_GROUP'].isin(['Self-care Home', 'Home Health'])].copy()
print(f"  Home rows: {len(home_df):,}")

base_grp = (
    home_df.groupby(['DISPO_GROUP', 'SERVICE_LINE'])
    .agg(
        n                 = ('EXCESS_DAYS', 'count'),
        avg_excess        = ('EXCESS_DAYS', 'mean'),
        total_excess_days = ('EXCESS_DAYS', 'sum'),
    )
    .reset_index()
)
base_grp = (
    base_grp[base_grp['n'] >= 50]
    .sort_values('total_excess_days', ascending=False)
    .reset_index(drop=True)
)

home_segments = []
for _, row in base_grp.iterrows():
    dispo  = row['DISPO_GROUP']
    sl     = row['SERVICE_LINE']
    subset = home_df[(home_df['DISPO_GROUP'] == dispo) & (home_df['SERVICE_LINE'] == sl)]

    # Admission hour drill: fixed order Overnight → Morning → Afternoon → Evening
    adm_grp = (
        subset.groupby('ADM_BUCKET')
        .agg(
            n                 = ('EXCESS_DAYS', 'count'),
            avg_excess        = ('EXCESS_DAYS', 'mean'),
            total_excess_days = ('EXCESS_DAYS', 'sum'),
        )
        .reset_index()
    )
    adm_by_label = {r['ADM_BUCKET']: r for _, r in adm_grp.iterrows()}
    by_admission_hour = []
    for bucket in ADM_BUCKET_ORDER:
        if bucket in adm_by_label:
            r = adm_by_label[bucket]
            by_admission_hour.append({
                'label':            bucket,
                'n':                int(r['n']),
                'avg_excess':       round(float(r['avg_excess']), 2),
                'total_excess_days': round(float(r['total_excess_days']), 1),
            })

    home_segments.append({
        'disposition':       dispo,
        'service_line':       sl,
        'n':                  int(row['n']),
        'avg_excess':         round(float(row['avg_excess']), 2),
        'total_excess_days':  round(float(row['total_excess_days']), 1),
        'drill': {
            'by_subspecialty':   build_drill_by_dim(subset, 'SERVICE_LINE_2'),
            'by_admission_hour': by_admission_hour,
        },
    })

print(f"  {len(home_segments)} home segments (min 50 cases, ranked by net excess)")
for seg in home_segments[:5]:
    print(f"    {seg['disposition']:16s}  {seg['service_line']:20s}  "
          f"n={seg['n']:,}  avg={seg['avg_excess']:+.2f}d  "
          f"total={seg['total_excess_days']:+,.0f}d  "
          f"sub={len(seg['drill']['by_subspecialty'])}  adm={len(seg['drill']['by_admission_hour'])}")


# ── Step 7: Write output JSON ─────────────────────────────────────────────────

print()
print("=" * 60)
print("Step 7: Writing public/data/los_segments.json...")
print("=" * 60)

script_dir = os.path.dirname(os.path.abspath(__file__))
out_dir    = os.path.join(script_dir, 'public', 'data')
os.makedirs(out_dir, exist_ok=True)
out_path   = os.path.join(out_dir, 'los_segments.json')

output = {
    'generated_at':      datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'hospital':          'Our Lady of Lourdes Hospital',
    'headline':          headline,
    'facility_segments': facility_segments,
    'home_segments':     home_segments,
}

with open(out_path, 'w', encoding='utf-8') as f:
    json.dump(output, f, indent=2, allow_nan=False)

size_kb = os.path.getsize(out_path) / 1024
print(f"  Saved: {out_path}  ({size_kb:.1f} KB)")


# ── Final summary ─────────────────────────────────────────────────────────────

print()
print("=" * 60)
print("Done. Summary:")
print(f"  headline rows     : {len(headline_rows)}")
print(f"  facility_segments : {len(facility_segments)}")
print(f"  home_segments     : {len(home_segments)}")
print()
print(f"  System total positive excess : {system_total_excess:>10,.1f} days")
print(f"  Effective beds               : {effective_beds:>10.1f}")
print()

print("  Headline top 10 (DISPO × SERVICE_LINE, ranked by net excess):")
print(f"  {'Disposition':16s}  {'Service line':25s}  {'N':>6}  {'Avg exc':>8}  {'Total exc':>10}  {'Cum%':>6}")
print(f"  {'-'*16}  {'-'*25}  {'-'*6}  {'-'*8}  {'-'*10}  {'-'*6}")
for r in headline_rows[:10]:
    print(f"  {r['disposition']:16s}  {r['service_line']:25s}  "
          f"{r['n']:>6,}  {r['avg_excess']:>+7.2f}d  "
          f"{r['total_excess_days']:>+10,.0f}d  {r['cumulative_pct']:>5.1f}%")

print()
print("  Facility segments (ranked by net excess):")
print(f"  {'Service line':25s}  {'N':>6}  {'Avg exc':>8}  {'Total exc':>10}  {'Sub':>4}  {'Payer':>5}")
print(f"  {'-'*25}  {'-'*6}  {'-'*8}  {'-'*10}  {'-'*4}  {'-'*5}")
for seg in facility_segments:
    print(f"  {seg['service_line']:25s}  {seg['n']:>6,}  {seg['avg_excess']:>+7.2f}d  "
          f"{seg['total_excess_days']:>+10,.0f}d  "
          f"{len(seg['drill']['by_subspecialty']):>4}  {len(seg['drill']['by_payer']):>5}")

print()
print("  Home segments (ranked by net excess):")
print(f"  {'Disposition':16s}  {'Service line':20s}  {'N':>6}  {'Avg exc':>8}  {'Total exc':>10}  {'Sub':>4}  {'Adm':>4}")
print(f"  {'-'*16}  {'-'*20}  {'-'*6}  {'-'*8}  {'-'*10}  {'-'*4}  {'-'*4}")
for seg in home_segments:
    print(f"  {seg['disposition']:16s}  {seg['service_line']:20s}  "
          f"{seg['n']:>6,}  {seg['avg_excess']:>+7.2f}d  "
          f"{seg['total_excess_days']:>+10,.0f}d  "
          f"{len(seg['drill']['by_subspecialty']):>4}  {len(seg['drill']['by_admission_hour']):>4}")

print("=" * 60)

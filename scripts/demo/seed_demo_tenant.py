#!/usr/bin/env python3
"""
Seed the Bright Memorial Health demo tenant.

Generates every table from a fixed RNG seed and either writes them to CSV for
inspection or loads them into the Demo database. The same seed and anchor date
produce a byte-identical database.

    # generate and check the storylines without touching a database
    python scripts/demo/seed_demo_tenant.py --seed 42 --dry-run

    # generate and load
    python scripts/demo/seed_demo_tenant.py --seed 42 --load

    # demo-week refresh: same seed, anchor moves forward
    python scripts/demo/seed_demo_tenant.py --seed 42 --load --reseed

Requires the Demo schema to exist first — see extract_schema.py and
create_demo_schema.sql. Credentials come from DEMO_DB_SERVER / DEMO_DB_USER /
DEMO_DB_PASSWORD in .env, which is never committed.

Prerequisites, in order:
    python scripts/demo/roster.py --seed 42
    python scripts/demo/fit_distributions.py            # or --offline
    python scripts/demo/extract_schema.py               # then run the SQL
"""

import argparse
import csv
import datetime as dt
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)

import demo_config as C            # noqa: E402
import generate_or as GOR          # noqa: E402
import generate_ip as GIP          # noqa: E402
from roster import load_roster     # noqa: E402
from fit_distributions import load_params   # noqa: E402
import verify as V                 # noqa: E402

DEMO_DATABASE = 'Demo'

# Chunk size for executemany. Small enough that a failure report names a narrow
# range of rows, large enough that a 50k-row table still loads in seconds.
LOAD_BATCH = 1000


def coerce(v):
    """
    Reduce a value to something pyodbc can bind without guessing.

    numpy scalars, pandas timestamps and NaN/NaT all reach the driver as objects
    it does not recognise, and the resulting error names neither the column nor
    the row. Converting here means a bad value is impossible rather than merely
    unlikely.
    """
    if v is None:
        return None
    # numpy scalars expose .item(); pandas NaT/NA and float nan are not equal to
    # themselves.
    item = getattr(v, 'item', None)
    if item is not None and type(v).__module__ == 'numpy':
        v = item()
    if isinstance(v, float) and math.isnan(v):
        return None
    if v is not v:                      # NaT, pandas.NA
        return None
    if isinstance(v, bool):
        return int(v)
    if isinstance(v, (int, float, str, bytes, dt.datetime, dt.date, dt.time)):
        return v
    if hasattr(v, 'to_pydatetime'):     # pandas.Timestamp
        return v.to_pydatetime()
    return str(v)

# Internal bookkeeping keys the generators carry between stages. Never loaded.
# Double underscore, because the real schema has columns like _ID_CaseID and a
# single leading underscore would strip them.
INTERNAL_PREFIX = '__'


def strip_internal(rows):
    return [{k: v for k, v in r.items() if not k.startswith(INTERNAL_PREFIX)} for r in rows]


# ── ISSCM tables (DemoTenant.md 5.2) ─────────────────────────────────────────

def _as_time(hhmm):
    """'07:00' -> datetime.time. The column is TIME; a string will not cast."""
    h, m = hhmm.split(':')
    return dt.time(int(h), int(m))


def generate_isscm_tables(roster):
    staffing = [
        {'Site': site, 'DayOfWeek': dow,
         'ShiftStart': _as_time(start), 'ShiftEnd': _as_time(end),
         'StaffedRooms': rooms, 'CoverageRatio': ratio}
        for site, dow, start, end, rooms, ratio in C.STAFFING_PLAN
    ]
    capacity = [
        {'Unit': u['unit'], 'LevelOfCare': u['level_of_care'],
         'StaffedBeds': u['staffed_beds']}
        for u in roster['units']
    ]
    svc_unit = []
    for service, shares in C.SERVICE_UNIT_MAP.items():
        total = sum(shares.values())
        if abs(total - 100) > 0.01:
            raise ValueError(f'ServiceUnitMap shares for {service} sum to {total}, not 100')
        for unit, share in shares.items():
            svc_unit.append({'Service': service, 'Unit': unit, 'SharePct': float(share)})
    return staffing, capacity, svc_unit


def generate_financials(roster, cases):
    """
    Reserved hook for the Financials feature spec. CaseFinancials is parked
    pending Hakan's financial content (DemoTenant.md 5.2); this no-op keeps the
    generation order stable so the table slots in without moving anything.
    """
    return []


# ── Generation ───────────────────────────────────────────────────────────────

def generate_all(anchor, seed):
    rng    = np.random.default_rng(seed)
    roster = load_roster()
    params = load_params()

    print(f'  Roster: {len(roster["surgeons"])} surgeons, {len(roster["blocks"])} block lines')
    print(f'  Distribution params: mode={params["mode"]}'
          + (f', fitted from {params["source_tenant"]}' if params.get('source_tenant') else ''))

    calendar = GOR.build_calendar(anchor)
    hist = [d for d in calendar if not d['is_future']]
    print(f'  Window: {calendar[0]["date"]} .. {calendar[-1]["date"]} '
          f'({len(hist)} historical days, {len(calendar) - len(hist)} forward)')

    print('  Generating DS_CASES ...')
    cases, block_instances = GOR.generate_cases(calendar, roster, params, rng, anchor)

    print('  Generating DS_Encounters ...')
    encounters, unit_meta = GIP.generate_encounters(cases, calendar, params, rng, anchor)

    print('  Generating DS_Bedplacement ...')
    bedplacement = GIP.generate_bedplacement(encounters, unit_meta, params, rng)

    print('  Generating DS_Occupancy ...')
    occupancy = GIP.generate_occupancy(encounters, unit_meta, calendar, rng)

    print('  Generating DS_RR ...')
    rr = GOR.generate_rr(cases)

    print('  Generating V4_BlockResultsView ...')
    block_results = GOR.generate_block_results(cases, block_instances)

    print('  Generating V4_FORECAST_COMPILE ...')
    forecast = GOR.generate_forecast_compile(cases, block_instances, calendar, rng)

    print('  Generating V4_Inpatient_Forecast_Compile ...')
    ip_forecast = GIP.generate_ip_forecast(encounters, unit_meta, occupancy, anchor, params, rng)

    staffing, capacity, svc_unit = generate_isscm_tables(roster)
    generate_financials(roster, cases)

    tables = {
        'DS_CASES':                      strip_internal(cases),
        'DS_Encounters':                 strip_internal(encounters),
        'DS_Bedplacement':               bedplacement,
        'DS_Occupancy':                  occupancy,
        'DS_RR':                         rr,
        'V4_BlockResultsView':           block_results,
        'V4_FORECAST_COMPILE':           forecast,
        'V4_Inpatient_Forecast_Compile': ip_forecast,
        'StaffingPlan':                  staffing,
        'UnitCapacity':                  capacity,
        'ServiceUnitMap':                svc_unit,
    }
    context = {'cases': cases, 'encounters': encounters, 'occupancy': occupancy,
               'block_instances': block_instances, 'forecast': forecast,
               'unit_meta': unit_meta, 'calendar': calendar, 'roster': roster,
               'anchor': anchor}
    return tables, context


# ── Output ───────────────────────────────────────────────────────────────────

def write_csv(tables, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    for name, rows in tables.items():
        path = os.path.join(out_dir, f'{name}.csv')
        if not rows:
            open(path, 'w').close()
            continue
        cols = list(rows[0].keys())
        with open(path, 'w', newline='', encoding='utf-8') as fh:
            w = csv.DictWriter(fh, fieldnames=cols)
            w.writeheader()
            w.writerows(rows)
    print(f'  Wrote {len(tables)} CSV files to {out_dir}')


def report_load_failure(cur, conn, table, sql_text, chunk, keys, db_cols,
                        col_types, offset, exc):
    """
    Say exactly what failed. The driver's own message names neither the table,
    the row nor the column, which makes a mid-load failure almost unactionable.
    """
    print()
    print('=' * 72)
    print(f'  LOAD FAILED: {table}')
    print('=' * 72)
    print(f'  {exc.__class__.__name__}: {exc}')
    print(f'  Chunk starting at row {offset:,} ({len(chunk)} rows, '
          f'source rows {offset:,}-{offset + len(chunk) - 1:,})')
    print()
    print('  First row of the failing chunk:')
    for k, col, val in zip(keys, db_cols, chunk[0]):
        flag = '' if val is None else f'  [{type(val).__name__}]'
        print(f'    {col:34s} {col_types.get(col, "?"):14s} {val!r:.60}{flag}')

    # Retry the chunk one row at a time with fast_executemany off. Batched
    # binding infers a type from the first row and reuses it, so a value that
    # only fails in row 400 is invisible until each row is bound on its own.
    print()
    print('  Retrying the chunk row by row with fast_executemany off '
          'to find the offending value ...')
    cur.fast_executemany = False
    for n, row in enumerate(chunk):
        try:
            cur.execute(sql_text, row)
            conn.rollback()
        except Exception as row_exc:
            print(f'    Row {offset + n:,} rejected: {row_exc}')
            for col, val in zip(db_cols, row):
                print(f'      {col:34s} {col_types.get(col, "?"):14s} {val!r:.60}'
                      + ('' if val is None else f'  [{type(val).__name__}]'))
            conn.rollback()
            break
    else:
        print('    No single row failed on its own — the batch binding is the '
              'problem, not one value. Re-run with --no-fast-executemany.')
    print('=' * 72)


def load_into_db(tables, reseed, batch=LOAD_BATCH, fast=True):
    import pyodbc
    from dotenv import load_dotenv
    load_dotenv()

    server   = os.getenv('DEMO_DB_SERVER')
    user     = os.getenv('DEMO_DB_USER')
    password = os.getenv('DEMO_DB_PASSWORD')
    database = os.getenv('DEMO_DB_DATABASE', DEMO_DATABASE)
    if not all([server, user, password]):
        raise EnvironmentError(
            'Missing DEMO_DB_SERVER / DEMO_DB_USER / DEMO_DB_PASSWORD in .env'
        )

    conn = pyodbc.connect(
        C.odbc_connection_string(server, database, user, password),
        timeout=60, autocommit=False,
    )
    cur = conn.cursor()
    cur.fast_executemany = fast
    print(f'  Connected to {server} / {database}'
          + ('' if fast else '  (fast_executemany off)'))

    # The database is the authority on structure; the generator only offers
    # values for the columns it knows how to author.
    cur.execute("""
        SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
        FROM INFORMATION_SCHEMA.COLUMNS
        ORDER BY TABLE_NAME, ORDINAL_POSITION
    """)
    actual, types = {}, {}
    for tbl, col, dtype, clen in cur.fetchall():
        actual.setdefault(tbl, []).append(col)
        label = f'{dtype}({clen})' if clen not in (None, -1) else str(dtype)
        types.setdefault(tbl, {})[col.lower()] = label

    total = 0
    for name, rows in tables.items():
        if name not in actual:
            print(f'  !! {name} does not exist in {database} — skipped. '
                  f'Run create_demo_schema.sql first.')
            continue
        if reseed:
            cur.execute(f'DELETE FROM dbo.[{name}]')

        if not rows:
            continue

        authored = list(rows[0].keys())
        lower = {c.lower(): c for c in actual[name]}
        usable = [c for c in authored if c.lower() in lower]
        missing = [c for c in authored if c.lower() not in lower]
        if missing:
            print(f'  !! {name}: the seeder authors columns the database does not have: '
                  f'{", ".join(missing)} — re-run extract_schema.py, the schema has drifted.')

        db_cols = [lower[c.lower()] for c in usable]
        placeholders = ', '.join('?' * len(db_cols))
        collist = ', '.join(f'[{c}]' for c in db_cols)
        sql_text = f'INSERT INTO dbo.[{name}] ({collist}) VALUES ({placeholders})'
        col_types = {c: types.get(name, {}).get(c.lower(), '?') for c in db_cols}

        for i in range(0, len(rows), batch):
            chunk = [[coerce(r.get(c)) for c in usable] for r in rows[i:i + batch]]
            try:
                cur.fast_executemany = fast
                cur.executemany(sql_text, chunk)
            except Exception as exc:
                conn.rollback()
                report_load_failure(cur, conn, name, sql_text, chunk, usable, db_cols,
                                    col_types, i, exc)
                raise
        conn.commit()
        total += len(rows)
        print(f'  {name:34s} {len(rows):>8,} rows  ({len(usable)}/{len(actual[name])} columns populated)')

    conn.close()
    print(f'  Loaded {total:,} rows')


def main():
    ap = argparse.ArgumentParser(description='Seed the Bright Memorial demo tenant.')
    ap.add_argument('--seed', type=int, default=C.DEFAULT_SEED)
    ap.add_argument('--anchor-date', default=None,
                    help='YYYY-MM-DD; defaults to today so "next Thursday" is real')
    ap.add_argument('--load', action='store_true', help='load into the Demo database')
    ap.add_argument('--reseed', action='store_true',
                    help='delete existing rows before loading (idempotent)')
    ap.add_argument('--dry-run', action='store_true',
                    help='generate and verify without touching a database')
    ap.add_argument('--out-dir', default=None, help='also write the tables as CSV')
    ap.add_argument('--no-verify', action='store_true')
    ap.add_argument('--no-fast-executemany', action='store_true',
                    help='bind row by row; slower, but some drivers mis-infer '
                         'a column type from the first row of a batch')
    ap.add_argument('--batch', type=int, default=LOAD_BATCH,
                    help=f'rows per insert batch (default {LOAD_BATCH})')
    args = ap.parse_args()

    if not args.load and not args.dry_run and not args.out_dir:
        args.dry_run = True

    anchor = (dt.date.fromisoformat(args.anchor_date) if args.anchor_date
              else dt.date.today())
    print('=' * 72)
    print(f'  Bright Memorial Health demo seed — seed {args.seed}, anchor {anchor}')
    print('=' * 72)

    tables, context = generate_all(anchor, args.seed)

    print()
    for name, rows in tables.items():
        print(f'  {name:34s} {len(rows):>8,} rows')

    if args.out_dir:
        print()
        write_csv(tables, args.out_dir)

    if not args.no_verify:
        print()
        V.run(tables, context)

    if args.load:
        print()
        load_into_db(tables, args.reseed, batch=args.batch,
                     fast=not args.no_fast_executemany)


if __name__ == '__main__':
    main()

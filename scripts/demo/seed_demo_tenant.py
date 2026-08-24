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

# Internal bookkeeping keys the generators carry between stages. Never loaded.
INTERNAL_PREFIX = '_'


def strip_internal(rows):
    return [{k: v for k, v in r.items() if not k.startswith(INTERNAL_PREFIX)} for r in rows]


# ── ISSCM tables (DemoTenant.md 5.2) ─────────────────────────────────────────

def generate_isscm_tables(roster):
    staffing = [
        {'Site': site, 'DayOfWeek': dow, 'ShiftStart': start, 'ShiftEnd': end,
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


def load_into_db(tables, reseed, batch=1000):
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
    cur.fast_executemany = True
    print(f'  Connected to {server} / {database}')

    # The database is the authority on structure; the generator only offers
    # values for the columns it knows how to author.
    cur.execute("""
        SELECT TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        ORDER BY TABLE_NAME, ORDINAL_POSITION
    """)
    actual = {}
    for tbl, col in cur.fetchall():
        actual.setdefault(tbl, []).append(col)

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
        sql = f'INSERT INTO dbo.[{name}] ({collist}) VALUES ({placeholders})'

        for i in range(0, len(rows), batch):
            chunk = [[r.get(c) for c in usable] for r in rows[i:i + batch]]
            cur.executemany(sql, chunk)
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
        load_into_db(tables, args.reseed)


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""
Which tables does the Demo database actually have, and are they populated?

Answers the recurring question "is this a code problem or a stale database?"
Compares what the seeder/DDL expects against what is really there.

Usage:  python scripts/demo/check_demo_tables.py
"""

import os
import sys

from dotenv import load_dotenv

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from demo_config import odbc_connection_string  # noqa: E402

EXPECTED = [
    'DS_CASES', 'DS_Encounters', 'DS_Bedplacement', 'DS_Occupancy', 'DS_RR',
    'V4_BlockResultsView', 'V4_FORECAST_COMPILE', 'V4_Inpatient_Forecast_Compile',
    'StaffingPlan', 'UnitCapacity', 'ServiceUnitMap',
    'ServiceRecoveryProfile', 'RecoveryCapacity',
]


def main():
    load_dotenv()
    import pyodbc
    conn = pyodbc.connect(odbc_connection_string(
        os.getenv('DEMO_DB_SERVER'), os.getenv('DEMO_DB_DATABASE'),
        os.getenv('DEMO_DB_USER'), os.getenv('DEMO_DB_PASSWORD')),
        timeout=60, readonly=True)
    cur = conn.cursor()

    cur.execute("SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE'")
    present = {r[0] for r in cur.fetchall()}

    missing, empty, ok = [], [], []
    for t in EXPECTED:
        if t not in present:
            missing.append(t)
            continue
        try:
            cur.execute(f'SELECT COUNT(*) FROM [{t}]')
            n = cur.fetchone()[0]
        except Exception as e:
            missing.append(f'{t} (unreadable: {e})')
            continue
        (ok if n else empty).append((t, n))

    for t, n in ok:
        print(f'  ok       {t:34} {n:>8,} rows')
    for t, n in empty:
        print(f'  EMPTY    {t:34} {n:>8,} rows')
    for t in missing:
        print(f'  MISSING  {t}')

    extra = sorted(present - set(EXPECTED))
    if extra:
        print(f'\n  (also present, not expected: {", ".join(extra)})')

    print()
    if missing:
        print('=> Tables are MISSING. Re-run the schema before reseeding:')
        print('     python scripts/demo/extract_schema.py')
        print('     python scripts/demo/apply_schema.py')
        print('     python scripts/demo/seed_demo_tenant.py --seed 42 --load --reseed')
        print('   (--reseed alone will NOT create new tables.)')
    elif empty:
        print('=> Tables exist but are empty. Reseed:')
        print('     python scripts/demo/seed_demo_tenant.py --seed 42 --load --reseed')
    else:
        print('=> Schema and data are present. If a page is still blank, it is a '
              'code or query problem, not the database.')

    conn.close()


if __name__ == '__main__':
    main()

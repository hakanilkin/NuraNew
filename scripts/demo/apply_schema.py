#!/usr/bin/env python3
"""
Apply create_demo_schema.sql to the Demo database.

Reads DEMO_DB_* from .env, splits the DDL on GO batch separators, and executes
each batch. Run AFTER extract_schema.py has produced the SQL file and you have
reviewed it.

Usage:
    python scripts/demo/apply_schema.py            # applies create_demo_schema.sql
    python scripts/demo/apply_schema.py --sql path/to/file.sql
"""

import os
import re
import sys
import argparse

from dotenv import load_dotenv

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from demo_config import odbc_connection_string  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_SQL = os.path.join(HERE, 'create_demo_schema.sql')


def batches(sql_text):
    """Split on lines that are just GO (T-SQL batch separator, case-insensitive)."""
    parts = re.split(r'^\s*GO\s*;?\s*$', sql_text, flags=re.MULTILINE | re.IGNORECASE)
    return [p.strip() for p in parts if p.strip()]


def main():
    ap = argparse.ArgumentParser(description='Apply the Demo schema DDL.')
    ap.add_argument('--sql', default=DEFAULT_SQL)
    args = ap.parse_args()

    load_dotenv()
    server   = os.getenv('DEMO_DB_SERVER')
    database = os.getenv('DEMO_DB_DATABASE')
    user     = os.getenv('DEMO_DB_USER')
    password = os.getenv('DEMO_DB_PASSWORD')
    missing = [k for k, v in {
        'DEMO_DB_SERVER': server, 'DEMO_DB_DATABASE': database,
        'DEMO_DB_USER': user, 'DEMO_DB_PASSWORD': password,
    }.items() if not v]
    if missing:
        sys.exit(f'Missing in .env: {", ".join(missing)} — see .env.example.')

    if not os.path.exists(args.sql):
        sys.exit(f'{args.sql} not found — run extract_schema.py first.')

    with open(args.sql, 'r', encoding='utf-8') as f:
        parts = batches(f.read())

    import pyodbc
    print(f'Connecting to {server}/{database} as {user} ...')
    conn = pyodbc.connect(odbc_connection_string(server, database, user, password),
                          autocommit=True)
    cur = conn.cursor()
    ok = 0
    for i, part in enumerate(parts, 1):
        head = part.splitlines()[0][:70]
        try:
            cur.execute(part)
            ok += 1
            print(f'  [{i}/{len(parts)}] ok   {head}')
        except Exception as e:
            print(f'  [{i}/{len(parts)}] FAIL {head}\n        {e}')
            conn.close()
            sys.exit(1)
    conn.close()
    print(f'Done — {ok}/{len(parts)} batches applied.')


if __name__ == '__main__':
    main()

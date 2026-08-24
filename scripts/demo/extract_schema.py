#!/usr/bin/env python3
"""
Extract the analytics schema from a real tenant and emit Demo's DDL.

Structure drift between Demo and the client schema is impossible if the DDL is
read rather than written: this connects read-only to the source tenant, reads
INFORMATION_SCHEMA.COLUMNS for the manifest in demo_config.REPLICATED_TABLES,
and writes:

    scripts/demo/create_demo_schema.sql   -- run this against the Demo DB
    scripts/demo/schema_snapshot.json     -- column/type map the seeder loads

The V4_* objects are views in the source DB; nothing in the app writes to them,
so Demo gets them as plain tables and the seeder populates them directly.
INFORMATION_SCHEMA covers views and tables identically, so no special case is
needed here.

Not every manifest object exists in every source tenant — V4_FORECAST_COMPILE
and V4_Inpatient_Forecast_Compile are absent from Virtua entirely. Rather than
block on that, their DDL is derived from the seeder's own generated frames and
appended in a clearly labelled section. The generator then owns their structure,
which makes scripts/checks/generated_schema_coverage.py part of the contract:
it asserts the generator produces every column the routes select.

Only structure is read from the source. No data.

Usage:
    python scripts/demo/extract_schema.py                 # from nhs
    python scripts/demo/extract_schema.py --tenant ohs
    python scripts/demo/extract_schema.py --no-derive     # skip missing objects
"""

import argparse
import datetime
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)

import demo_config as C   # noqa: E402

SQL_OUT      = os.path.join(HERE, 'create_demo_schema.sql')
SNAPSHOT_OUT = os.path.join(HERE, 'schema_snapshot.json')

# Types whose declaration carries a length.
LEN_TYPES   = {'char', 'varchar', 'nchar', 'nvarchar', 'binary', 'varbinary'}
# Types whose declaration carries precision/scale.
PREC_TYPES  = {'decimal', 'numeric'}
# Types whose declaration carries fractional-seconds precision.
SCALE_TYPES = {'datetime2', 'datetimeoffset', 'time'}


def render_type(col):
    """Render a SQL Server type declaration from an INFORMATION_SCHEMA row."""
    t = col['data_type'].lower()
    if t in LEN_TYPES:
        n = col['char_max_len']
        size = 'MAX' if n in (-1, None) else str(n)
        return f'{t.upper()}({size})'
    if t in PREC_TYPES:
        return f"{t.upper()}({col['num_precision']}, {col['num_scale']})"
    if t in SCALE_TYPES and col['datetime_precision'] is not None:
        return f"{t.upper()}({col['datetime_precision']})"
    return t.upper()


# NVARCHAR widths to round up to, so a slightly longer value later does not
# truncate. Anything past the last one becomes NVARCHAR(MAX).
_NVARCHAR_STEPS = (50, 100, 200, 400, 1000, 4000)


def infer_type(values):
    """
    A SQL Server type wide enough for every value the generator produced.

    Deliberately generous: this schema is written once and loaded by the same
    generator, so a type that is slightly too wide costs nothing while one that
    is slightly too narrow fails the load.
    """
    vals = [v for v in values if v is not None]
    if not vals:
        return 'NVARCHAR(100)', 'all NULL in the generated sample'

    if any(isinstance(v, datetime.datetime) for v in vals):
        return 'DATETIME2(0)', None
    if all(isinstance(v, datetime.date) for v in vals):
        return 'DATE', None
    if all(isinstance(v, datetime.time) for v in vals):
        return 'TIME(0)', None
    if all(isinstance(v, bool) for v in vals):
        return 'BIT', None
    if all(isinstance(v, int) and not isinstance(v, bool) for v in vals):
        lo, hi = min(vals), max(vals)
        return ('BIGINT' if lo < -2147483648 or hi > 2147483647 else 'INT'), None
    if all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in vals):
        return 'FLOAT', None

    longest = max(len(str(v)) for v in vals)
    for step in _NVARCHAR_STEPS:
        if longest <= step:
            return f'NVARCHAR({step})', f'longest generated value: {longest} chars'
    return 'NVARCHAR(MAX)', f'longest generated value: {longest} chars'


def derive_from_generator(missing, seed, anchor):
    """
    Column definitions for manifest objects the source database does not have,
    read off the frames the seeder produces for them.
    """
    sys.path.insert(0, HERE)
    import seed_demo_tenant as S   # noqa: E402 — imported lazily; needs roster + params

    print(f'  Generating a seed to derive structure for: {", ".join(missing)}')
    tables, _ = S.generate_all(anchor, seed)

    derived = {}
    for name in missing:
        rows = tables.get(name) or []
        if not rows:
            print(f'  !! {name}: the generator produced no rows — cannot derive its structure.')
            continue
        cols = []
        for i, col in enumerate(rows[0].keys(), start=1):
            sql_type, note = infer_type([r.get(col) for r in rows])
            cols.append({
                'name': col,
                'ordinal': i,
                'sql_type': sql_type,
                'note': note,
                # Permissive on purpose: a demo-week reseed against a different
                # anchor date can legitimately produce a NULL where this sample
                # had none, and a NOT NULL here would fail that load.
                'nullable': True,
                'derived': True,
            })
        derived[name] = cols
        print(f'  {name:34s} {len(cols):3d} columns derived from {len(rows):,} generated rows')
    return derived


def extract(tenant):
    import pyodbc
    from dotenv import load_dotenv
    load_dotenv()
    from pipeline_config import get_tenant_config, get_db_params

    cfg = get_tenant_config(tenant)
    server, database, user, password = get_db_params(cfg)
    conn = pyodbc.connect(
        C.odbc_connection_string(server, database, user, password),
        timeout=60, readonly=True,
    )
    print(f'  Connected read-only to {server} / {database}')

    cur = conn.cursor()
    placeholders = ', '.join('?' * len(C.REPLICATED_TABLES))
    cur.execute(f"""
        SELECT TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION, DATA_TYPE,
               CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE,
               DATETIME_PRECISION, IS_NULLABLE
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME IN ({placeholders})
        ORDER BY TABLE_NAME, ORDINAL_POSITION
    """, *C.REPLICATED_TABLES)

    tables = {}
    for (tbl, col, pos, dtype, clen, prec, scale, dtprec, nullable) in cur.fetchall():
        tables.setdefault(tbl, []).append({
            'name': col,
            'ordinal': int(pos),
            'data_type': dtype,
            'char_max_len': clen,
            'num_precision': prec,
            'num_scale': scale,
            'datetime_precision': dtprec,
            'nullable': nullable == 'YES',
        })
    conn.close()

    missing = [t for t in C.REPLICATED_TABLES if t not in tables]
    for t, cols in tables.items():
        print(f'  {t:34s} {len(cols):3d} columns')
    if missing:
        print(f'  Not present in {database}: {", ".join(missing)}')
    return tables, database, missing


INDEX_COLUMN = {
    'DS_CASES':                      'Date_SchedDate',
    'DS_Encounters':                 'TIME_HOSPDISCHARGE',
    'DS_Bedplacement':               'TIME_REQUESTTIME',
    'DS_Occupancy':                  'Datehour',
    'DS_RR':                         'rrDate',
    'V4_BlockResultsView':           'BlockDate',
    'V4_FORECAST_COMPILE':           'Date',
    'V4_Inpatient_Forecast_Compile': None,
}


def _column_type(col):
    """Derived columns carry their type directly; extracted ones are rendered."""
    return col['sql_type'] if col.get('derived') else render_type(col)


def _create_table(tbl, cols):
    lines = [
        f"IF OBJECT_ID('dbo.{tbl}', 'U') IS NOT NULL DROP TABLE dbo.{tbl};",
        f'CREATE TABLE dbo.{tbl} (',
    ]
    width = max(len(c['name']) for c in cols) + 2
    body = []
    for i, c in enumerate(cols):
        null = 'NULL' if c['nullable'] else 'NOT NULL'
        pad = ' ' * (width - len(c['name']))
        # The separator has to precede the comment, or the comment swallows it
        # and the statement loses a comma.
        sep = '' if i == len(cols) - 1 else ','
        line = f"    [{c['name']}]{pad}{_column_type(c)} {null}{sep}"
        if c.get('note'):
            line += f"    -- {c['note']}"
        body.append(line)
    lines.append('\n'.join(body))
    lines += [');', '']

    idx_col = INDEX_COLUMN.get(tbl)
    if idx_col and any(c['name'].lower() == idx_col.lower() for c in cols):
        lines += [f'CREATE INDEX IX_{tbl}_{idx_col} ON dbo.{tbl} ([{idx_col}]);', '']
    return lines


def render_sql(tables, derived, source_db, tenant):
    stamp = datetime.datetime.now().isoformat(timespec='seconds')
    lines = [
        '-- Demo tenant schema — Bright Memorial Health',
        '--',
        f'-- Generated by scripts/demo/extract_schema.py on {stamp}',
        f'-- Structure extracted from tenant "{tenant}" (database {source_db}).',
        '-- Structure only: no data, no constraints, no client content.',
        '--',
        '-- Run this against the empty Demo database. Re-running drops and',
        '-- recreates every table, so it is safe to repeat while iterating.',
        '',
    ]
    for tbl in C.REPLICATED_TABLES:
        cols = tables.get(tbl)
        if not cols:
            if tbl in derived:
                lines += [f'-- {tbl} is not in {source_db}; its DDL is in the '
                          f'generator-derived section below.', '']
            else:
                lines += [f'-- !! {tbl} was not found in the source database and could '
                          f'not be derived — skipped.', '']
            continue
        lines += _create_table(tbl, cols)

    if derived:
        lines += [
            '-- ── Generator-derived tables ─────────────────────────────────────────────',
            '--',
            f'-- These objects do not exist in {source_db}, so their structure could not',
            '-- be extracted. It is inferred instead from the frames the seeder produces',
            '-- for them (scripts/demo/generate_or.py, generate_ip.py): dates to DATE,',
            '-- timestamps to DATETIME2, whole numbers to INT, other numbers to FLOAT,',
            '-- text to NVARCHAR sized to the longest value generated.',
            '--',
            '-- That makes the generator the authority on their structure, so',
            '-- scripts/checks/generated_schema_coverage.py asserts it produces every',
            '-- column routes/*.js selects from them. Run it after changing either.',
            '--',
            '-- Every column is nullable: a demo-week reseed against a different anchor',
            '-- date can legitimately produce a NULL where this sample had none.',
            '',
        ]
        for tbl in C.REPLICATED_TABLES:
            if tbl in derived:
                lines += _create_table(tbl, derived[tbl])

    lines += [
        '-- ── Demo-first tables (DemoTenant.md 5.2) ─────────────────────────────────',
        '-- Not present in client databases yet; they arrive there when the ISSCM',
        '-- features go live.',
        C.NEW_TABLE_DDL.strip(),
        '',
    ]
    return '\n'.join(lines)


def main():
    ap = argparse.ArgumentParser(description='Extract Demo DDL from a source tenant.')
    ap.add_argument('--tenant', default='nhs', help='source tenant (default: nhs)')
    ap.add_argument('--sql-out', default=SQL_OUT)
    ap.add_argument('--snapshot-out', default=SNAPSHOT_OUT)
    ap.add_argument('--no-derive', action='store_true',
                    help='do not derive DDL for objects missing from the source')
    ap.add_argument('--seed', type=int, default=C.DEFAULT_SEED,
                    help='seed used when deriving structure from the generator')
    ap.add_argument('--anchor-date', default=None,
                    help='YYYY-MM-DD anchor for the derivation seed (default: today)')
    args = ap.parse_args()

    tables, source_db, missing = extract(args.tenant)

    derived = {}
    if missing and not args.no_derive:
        anchor = (datetime.date.fromisoformat(args.anchor_date) if args.anchor_date
                  else datetime.date.today())
        try:
            derived = derive_from_generator(missing, args.seed, anchor)
        except Exception as exc:
            print(f'  !! Could not derive structure from the generator: {exc}')
            print('     Run roster.py and fit_distributions.py first, or pass --no-derive.')

    still_missing = [t for t in missing if t not in derived]

    with open(args.sql_out, 'w', encoding='utf-8') as fh:
        fh.write(render_sql(tables, derived, source_db, args.tenant))
    with open(args.snapshot_out, 'w', encoding='utf-8') as fh:
        json.dump({
            'source_tenant': args.tenant,
            'source_database': source_db,
            'generated_at': datetime.datetime.now().isoformat(timespec='seconds'),
            'extracted_from_source': sorted(tables),
            'derived_from_generator': sorted(derived),
            'missing': still_missing,
            'tables': {**tables, **derived},
        }, fh, indent=2)
        fh.write('\n')

    print(f'\n  Wrote {args.sql_out}')
    print(f'  Wrote {args.snapshot_out}')
    print(f'  {len(tables)} extracted from {source_db}'
          + (f', {len(derived)} derived from the generator' if derived else ''))
    if derived:
        print('  Derived structure means the generator owns those tables\' shape —')
        print('  run: python scripts/checks/generated_schema_coverage.py')
    if still_missing:
        print(f'  !! Still missing, no DDL emitted: {", ".join(still_missing)}')
    print('  Review the SQL, then run it against the Demo database.')


if __name__ == '__main__':
    main()

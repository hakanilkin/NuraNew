#!/usr/bin/env python3
"""
Do the seeder's generated tables carry every column the app selects from them?

Two objects in the manifest — V4_FORECAST_COMPILE and V4_Inpatient_Forecast_Compile
— do not exist in the source tenant, so their DDL is derived from the seeder's
own frames rather than extracted (see extract_schema.py --allow-derived). That
makes the generator the schema authority for them, and a column the routes select
but the generator never emits becomes an 'Invalid column name' at runtime on a
page nobody ran during the build.

This parses the SQL in routes/*.js, pulls out the columns referenced against each
generated table, and compares them to what the generator actually produces.

The parser is deliberately conservative and has blind spots — a column whose name
collides with a SQL keyword ("Date") or with its own alias ("Caseblock AS
CaseBlock") is dropped rather than risk a false alarm. Those are exactly the
columns a parse would silently let through, so REQUIRED below names them
explicitly and both lists must pass.

Run: python scripts/checks/generated_schema_coverage.py
"""

import datetime as dt
import glob
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'demo'))

# Tables whose structure comes from the generator rather than from a source DB.
GENERATED = ['V4_FORECAST_COMPILE', 'V4_Inpatient_Forecast_Compile']

# Read out of the queries by hand, to cover what the parser drops. Keep in sync
# when a route starts selecting a new column from either object.
REQUIRED = {
    'V4_FORECAST_COMPILE': [
        'Date', 'DOW_LONG', 'ORGRP2', 'Caseblock', 'SurgeonService', 'DaysAhead',
        'SCHEDULED_INPATIENT', 'SCHEDULED_OUTPATIENT',
        'SCHEDULED_INPATIENT_DURwTurn', 'SCHEDULED_OUTPATIENT_DURwTurn',
        'FORECAST_INPATIENT', 'FORECAST_OUTPATIENT',
        'FORECAST_INPATIENT_DURwTurn', 'FORECAST_OUTPATIENT_DURwTurn',
        'ACTUAL_INPATIENT', 'ACTUAL_OUTPATIENT', 'ACTUAL',
        'BUDGET_INPATIENT', 'BUDGET_OUTPATIENT', 'BUDGET',
        'BLOCKTIME',
    ],
    'V4_Inpatient_Forecast_Compile': [
        'DEP_NAME', 'DEP_LevelofCare', 'CENSUS', 'StaffedBeds',
        'EDAdmission_OrderAvailable', 'EDAdmissions_DispoSet',
        'EDAdmissions_Forecast_00_06', 'EDAdmissions_Forecast_06_12',
        'EDAdmissions_Forecast_12_18', 'EDAdmissions_Forecast_18_23',
        'ORAdmissions_Forecast_00_06', 'ORAdmissions_Forecast_06_12',
        'ORAdmissions_Forecast_12_18', 'ORAdmissions_Forecast_18_23',
        'TransferCenter_Forecast', 'OtherTransferIn_Forecast',
        'TransferIntoUnit_Forecast', 'TransferOutofUnit_Forecast',
    ],
}

SQL_WORDS = set("""
SELECT FROM WHERE GROUP BY ORDER HAVING AS ON AND OR NOT IN IS NULL CASE WHEN THEN ELSE END
LEFT RIGHT INNER OUTER JOIN UNION ALL DISTINCT TOP COUNT SUM AVG MIN MAX CAST FLOAT INT DATE
DATETIME DECIMAL NVARCHAR VARCHAR ISNULL COALESCE NULLIF ROUND DATEADD DATEDIFF DATEPART
GETDATE CONVERT PERCENTILE_CONT WITHIN OVER PARTITION ROW_NUMBER WITH BETWEEN LIKE EXISTS
DESC ASC STRING_AGG YEAR MONTH DAY HOUR ABS FORMAT TRY_CAST IIF EOMONTH DATEFROMPARTS CROSS
APPLY VALUES INSERT INTO UPDATE SET DELETE TRUNCATE TABLE CREATE PRIMARY KEY TIME TINYINT BIT
LEN LTRIM RTRIM UPPER LOWER SUBSTRING CHARINDEX REPLACE CONCAT STDEV VAR SIGN FLOOR CEILING
POWER SQRT EXP LOG WEEKDAY
""".split())


def columns_referenced(sql, table):
    """Columns a SQL block selects from `table`, best-effort but conservative."""
    # Drop SQL comments first: prose about the query is not part of it, and a
    # comment mentioning "will" was read as a column named will.
    s = re.sub(r'--[^\n]*', ' ', sql)
    s = re.sub(r'/\*.*?\*/', ' ', s, flags=re.S)
    # Drop JS interpolations and string literals — neither contains a column.
    s = re.sub(r'\$\{[^}]*\}', ' ', s)
    s = re.sub(r"'[^']*'", ' ', s)
    # A table alias is not a column: collect the aliases, unqualify the columns
    # they introduce, then drop the alias names themselves.
    table_aliases = {m.group(1) for m in re.finditer(
        r'\b(?:FROM|JOIN)\s+[A-Za-z_][A-Za-z0-9_.]*\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*)\b',
        s, re.I) if m.group(1).upper() not in SQL_WORDS}
    for a in table_aliases:
        s = re.sub(r'\b' + re.escape(a) + r'\.', ' ', s)
    # Aliases introduced with AS are outputs, not columns of the source table.
    aliases = {m.group(1).upper() for m in re.finditer(r'\bAS\s+([A-Za-z_][A-Za-z0-9_]*)', s, re.I)}
    # Bind parameters are not columns either.
    s = re.sub(r'@[A-Za-z0-9_]+', ' ', s)

    out = set()
    for m in re.finditer(r'\b[A-Za-z_][A-Za-z0-9_]*\b', s):
        tok = m.group(0)
        up = tok.upper()
        if up in SQL_WORDS or up in aliases:
            continue
        if up in (t.upper() for t in GENERATED):
            continue
        if tok in table_aliases:
            continue
        # A bare word immediately followed by '(' is a function call.
        if s[m.end():m.end() + 1] == '(':
            continue
        out.add(tok)
    return out


def route_columns():
    refs = {t: {} for t in GENERATED}   # table -> {COLUMN_UPPER: (column, [files])}
    for path in sorted(glob.glob(os.path.join(ROOT, 'routes', '*.js'))):
        src = open(path, encoding='utf-8').read()
        for block in re.findall(r'`([^`]*)`', src):
            for table in GENERATED:
                if not re.search(r'\b' + table + r'\b', block, re.I):
                    continue
                for col in columns_referenced(block, table):
                    entry = refs[table].setdefault(col.upper(), (col, []))
                    name = os.path.relpath(path, ROOT)
                    if name not in entry[1]:
                        entry[1].append(name)
    return refs


def generated_columns():
    import seed_demo_tenant as S
    tables, _ = S.generate_all(dt.date(2026, 8, 24), 42)
    return {t: [c for c in (tables[t][0].keys() if tables.get(t) else [])] for t in GENERATED}


DATEISH = {'date', 'datetime', 'datetime2', 'smalldatetime', 'time', 'datetimeoffset'}
NUMERIC = {'int', 'bigint', 'smallint', 'tinyint', 'float', 'real', 'decimal',
           'numeric', 'bit', 'money', 'smallmoney'}
TEXT    = {'char', 'varchar', 'nchar', 'nvarchar', 'text', 'ntext'}


def _py_kind(v):
    import datetime as _d
    if v is None:                    return None
    if isinstance(v, bool):          return 'bool'
    if isinstance(v, _d.datetime):   return 'datetime'
    if isinstance(v, _d.date):       return 'date'
    if isinstance(v, _d.time):       return 'time'
    if isinstance(v, int):           return 'int'
    if isinstance(v, float):         return 'float'
    if isinstance(v, str):           return 'str'
    return type(v).__name__


def _kind_fits(sql_type, kind):
    t = sql_type.lower().split('(')[0].strip()
    if t in DATEISH:
        return kind in ('date', 'datetime', 'time')
    if t in NUMERIC:
        return kind in ('int', 'float', 'bool')
    if t in TEXT:
        return kind == 'str'
    return True                      # binary, uniqueidentifier, xml: not our business


def declared_types(snapshot_tables, derived, new_table_ddl):
    """
    column -> declared SQL type, from all three sources of truth: the extraction
    snapshot, the generator-derived DDL, and the hand-written Demo-first DDL.
    """
    out = {}
    for table, cols in (snapshot_tables or {}).items():
        for c in cols:
            t = c.get('sql_type') or c.get('data_type')
            if t:
                out.setdefault(table, {})[c['name'].lower()] = t
    for table, cols in (derived or {}).items():
        for c in cols:
            out.setdefault(table, {})[c['name'].lower()] = c['sql_type']
    # The Demo-first tables are declared inline in demo_config.NEW_TABLE_DDL.
    for block in re.finditer(r'CREATE TABLE dbo\.(\w+) \((.*?)\n\);', new_table_ddl, re.S):
        table, body = block.group(1), block.group(2)
        for line in body.split('\n'):
            m = re.match(r'\s*(\w+)\s+([A-Za-z]+(?:\(\s*[\w,\s]+\))?)', line.split('--')[0])
            if m and m.group(1).upper() not in ('CONSTRAINT', 'PRIMARY'):
                out.setdefault(table, {})[m.group(1).lower()] = m.group(2)
    return out


def check_value_types(all_tables, declared, sample=4000):
    """
    Every value the seeder produces has to be bindable to its column's declared
    type. A string in a BIT column or a 'Y' in a DATETIME2 column is an ODBC
    22018 halfway through the load, with a message that names neither.
    """
    problems = []
    for table, rows in all_tables.items():
        cols = declared.get(table)
        if not cols or not rows:
            continue
        for col in [c for c in rows[0] if not c.startswith('__')]:
            sql_type = cols.get(col.lower())
            if not sql_type:
                continue
            kinds = {_py_kind(r.get(col)) for r in rows[:sample]} - {None}
            bad = sorted({k for k in kinds if not _kind_fits(sql_type, k)})
            if bad:
                problems.append(f'{table}.{col}: column is {sql_type}, seeder produces '
                                f'{", ".join(bad)}')
    return problems


def validate_ddl(sql, derived):
    """
    The derived DDL is hand-rolled text, so check it is well-formed before
    anyone runs it against a database: balanced parentheses, a separator on
    every column but the last, and one column line per derived column.
    """
    problems = []
    if sql.count('(') != sql.count(')'):
        problems.append(f'unbalanced parentheses: {sql.count("(")} open, {sql.count(")")} close')

    for table, cols in derived.items():
        m = re.search(r'CREATE TABLE dbo\.' + re.escape(table) + r' \((.*?)\n\);', sql, re.S)
        if not m:
            problems.append(f'{table}: no CREATE TABLE block in the rendered SQL')
            continue
        body = [l for l in m.group(1).split('\n') if l.strip()]
        if len(body) != len(cols):
            problems.append(f'{table}: {len(body)} column lines for {len(cols)} columns')
        for i, line in enumerate(body):
            decl = line.split('--')[0].rstrip()      # strip any trailing comment
            last = i == len(body) - 1
            if last and decl.endswith(','):
                problems.append(f'{table}: last column has a trailing comma: {decl.strip()}')
            if not last and not decl.endswith(','):
                problems.append(f'{table}: missing separator after {decl.strip()}')
            if not re.match(r'\s*\[[A-Za-z0-9_]+\]\s+\S', decl):
                problems.append(f'{table}: unparseable column line: {line.strip()}')
    return problems


def main():
    print('  Generating a seed to read the produced columns ...')
    gen = generated_columns()
    refs = route_columns()

    failures = []
    for table in GENERATED:
        produced = {c.upper(): c for c in gen[table]}
        referenced = refs[table]
        missing = {k: v for k, v in referenced.items() if k not in produced}
        print(f'\n  {table}')
        print(f'    generator produces : {len(produced)} columns')
        print(f'    routes reference   : {len(referenced)} columns')
        if missing:
            for up, (col, files) in sorted(missing.items()):
                failures.append(f'{table}.{col} is selected in {", ".join(files)} '
                                f'but the generator never produces it')
                print(f'    MISSING            : {col}   ({", ".join(files)})')
        else:
            print('    every referenced column is produced')
        for col in REQUIRED[table]:
            if col.upper() not in produced:
                failures.append(f'{table}.{col} is in the hand-checked required list '
                                f'but the generator never produces it')
                print(f'    MISSING (required) : {col}')
        print(f'    hand-checked list  : {len(REQUIRED[table])} columns, all produced'
              if all(c.upper() in produced for c in REQUIRED[table]) else '')

        unused = sorted(c for up, c in produced.items()
                        if up not in referenced and up not in {r.upper() for r in REQUIRED[table]})
        if unused:
            print(f'    produced but unused: {", ".join(unused)}')

    # The same generator output is what extract_schema.py derives DDL from when
    # the source database lacks these objects, so check that rendering too.
    import datetime as _dt
    sys.path.insert(0, os.path.join(ROOT, 'scripts', 'demo'))
    import extract_schema as E
    derived = E.derive_from_generator(GENERATED, 42, _dt.date(2026, 8, 24))
    ddl = E.render_sql({}, derived, '(source)', '(tenant)')
    print()
    for problem in validate_ddl(ddl, derived):
        failures.append(f'derived DDL: {problem}')
        print(f'  DDL PROBLEM: {problem}')
    for table in GENERATED:
        for col in REQUIRED[table]:
            if f'[{col}]' not in ddl:
                failures.append(f'derived DDL: {table}.{col} is required but not in the DDL')
    if not any(f.startswith('derived DDL') for f in failures):
        print('  derived DDL renders cleanly and carries every required column')

    # ── Authored columns must exist in the extracted schema ─────────────────
    # For the tables that DO come from the source database, the seeder only gets
    # to populate columns that actually exist there. A misnamed one is silently
    # skipped at load time and the page that reads it renders empty, so check it
    # here against the extraction snapshot while there is still time to fix it.
    snapshot = os.path.join(ROOT, 'scripts', 'demo', 'schema_snapshot.json')
    if os.path.exists(snapshot):
        snap = json.load(open(snapshot, encoding='utf-8'))
        real = {t: {c['name'].lower() for c in cols} for t, cols in snap.get('tables', {}).items()}
        import seed_demo_tenant as S
        all_tables, _ = S.generate_all(_dt.date(2026, 8, 24), 42)
        print()
        for table, rows in all_tables.items():
            if table not in real or not rows:
                continue
            authored = [c for c in rows[0] if not c.startswith('__')]
            absent = [c for c in authored if c.lower() not in real[table]]
            if absent:
                for col in absent:
                    failures.append(f'{table}.{col} is authored by the seeder but does not '
                                    f'exist in the extracted schema — it would load as NULL')
                print(f'  {table}: NOT IN EXTRACTED SCHEMA: {", ".join(absent)}')
        if not any('does not\n' in f or 'extracted schema' in f for f in failures):
            print('  every authored column exists in the extracted schema')
    else:
        print('\n  (no schema_snapshot.json yet — run extract_schema.py to enable '
              'the authored-column cross-check)')

    # ── Value types must be bindable to their declared column types ─────────
    import demo_config as _C
    declared = declared_types(
        (json.load(open(snapshot, encoding='utf-8')).get('tables')
         if os.path.exists(snapshot) else {}),
        derived, _C.NEW_TABLE_DDL)
    if 'all_tables' not in dir():
        import seed_demo_tenant as S2
        all_tables, _ = S2.generate_all(_dt.date(2026, 8, 24), 42)
    print()
    type_problems = check_value_types(all_tables, declared)
    for prob in type_problems:
        failures.append(f'value type: {prob}')
        print(f'  TYPE MISMATCH: {prob}')
    if not type_problems:
        print(f'  every value is bindable to its column type '
              f'({sum(len(v) for v in declared.values())} columns declared)')

    if failures:
        print(f'\n  {len(failures)} coverage failure(s):\n')
        for f in failures:
            print('  - ' + f)
        sys.exit(1)
    print('\n  generated schema coverage: OK')


if __name__ == '__main__':
    main()

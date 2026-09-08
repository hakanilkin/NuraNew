#!/usr/bin/env python3
"""
Diagnose why V4_FORECAST_COMPILE / V4_Inpatient_Forecast_Compile were not found
by extract_schema.py. Lists every object in the source DB whose name resembles
them, with its type and schema — tables, views, and synonyms (synonyms do not
appear in INFORMATION_SCHEMA, which is the likely miss).

Usage:  python scripts/demo/find_forecast_objects.py
"""

import os
import sys

from dotenv import load_dotenv

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from demo_config import odbc_connection_string  # noqa: E402


def main():
    load_dotenv()
    server   = os.getenv('DB_SERVER')
    database = os.getenv('DB_DATABASE')
    user     = os.getenv('DB_USER')
    password = os.getenv('DB_PASSWORD')
    if not all([server, database, user, password]):
        sys.exit('DB_SERVER / DB_DATABASE / DB_USER / DB_PASSWORD missing from .env')

    import pyodbc
    conn = pyodbc.connect(odbc_connection_string(server, database, user, password),
                          timeout=60, readonly=True)
    cur = conn.cursor()

    print(f'Searching {database} for forecast-like objects...\n')
    cur.execute("""
        SELECT s.name AS schema_name, o.name AS object_name,
               o.type_desc,
               CAST('' AS NVARCHAR(400)) AS base_object
        FROM sys.objects o
        JOIN sys.schemas s ON s.schema_id = o.schema_id
        WHERE o.name LIKE '%FORECAST%' OR o.name LIKE '%Forecast%'
        UNION ALL
        SELECT s.name, sy.name, 'SYNONYM', sy.base_object_name
        FROM sys.synonyms sy
        JOIN sys.schemas s ON s.schema_id = sy.schema_id
        WHERE sy.name LIKE '%FORECAST%' OR sy.name LIKE '%Forecast%'
        ORDER BY object_name
    """)
    rows = cur.fetchall()
    if not rows:
        print('  Nothing found containing "forecast" — the objects may live in a '
              'different database entirely. Ask Hakan where the app reads '
              'V4_FORECAST_COMPILE from.')
    for r in rows:
        base = f'  ->  {r.base_object}' if r.base_object else ''
        print(f'  {r.schema_name}.{r.object_name:<45} {r.type_desc}{base}')
    conn.close()


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""
Diagnose why the Release Radar returns no rows on the demo tenant.

Runs the exact queries routes/opentime.js /radar executes, plus the checks that
isolate WHERE the rows disappear (date window, HAVING BLOCKTIME > 0, site/block
vocabulary). Also prints the NuraOps tenant list so we can confirm Bright
Memorial's real TenantID.

Usage:  python scripts/demo/diagnose_radar.py
"""

import os
import sys
import datetime

from dotenv import load_dotenv

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from demo_config import odbc_connection_string  # noqa: E402


def rows(cur, sql, *params):
    cur.execute(sql, *params) if params else cur.execute(sql)
    cols = [c[0] for c in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def main():
    load_dotenv()
    import pyodbc

    server = os.getenv('DEMO_DB_SERVER')
    demo   = os.getenv('DEMO_DB_DATABASE')
    user   = os.getenv('DEMO_DB_USER')
    pwd    = os.getenv('DEMO_DB_PASSWORD')
    authdb = os.getenv('AUTH_DB_DATABASE')

    # ── 0. Which TenantID is Bright Memorial? ────────────────────────────────
    if authdb:
        try:
            ac = pyodbc.connect(odbc_connection_string(server, authdb, user, pwd),
                                timeout=60, readonly=True)
            print('NuraOps tenants:')
            for t in rows(ac.cursor(),
                          'SELECT TenantID, TenantName, DBName FROM Tenants ORDER BY TenantID'):
                print(f"   TenantID {t['TenantID']}  {t['TenantName']}  -> {t['DBName']}")
            ac.close()
        except Exception as e:
            print(f'  (could not read NuraOps tenants: {e})')
    print()

    conn = pyodbc.connect(odbc_connection_string(server, demo, user, pwd),
                          timeout=60, readonly=True)
    cur = conn.cursor()

    today = datetime.date.today()
    frm = today + datetime.timedelta(days=14)
    to  = today + datetime.timedelta(days=35)
    print(f'Today {today} -> radar default window {frm} .. {to}\n')

    # ── 1. What forward data exists at all? ──────────────────────────────────
    r = rows(cur, """
        SELECT MIN(Date) AS MinDate, MAX(Date) AS MaxDate, COUNT(*) AS Rows,
               SUM(CASE WHEN ISNULL(BLOCKTIME,0) > 0 THEN 1 ELSE 0 END) AS RowsWithBlockTime
        FROM V4_FORECAST_COMPILE
    """)[0]
    print(f"V4_FORECAST_COMPILE: {r['Rows']} rows, {r['MinDate']} .. {r['MaxDate']}, "
          f"{r['RowsWithBlockTime']} with BLOCKTIME > 0\n")

    # ── 2. Rows inside the radar window, before and after the HAVING ─────────
    n_win = rows(cur, """
        SELECT COUNT(*) AS N FROM V4_FORECAST_COMPILE
        WHERE Date >= ? AND Date <= ?
    """, frm, to)[0]['N']

    grouped = rows(cur, """
        SELECT COUNT(*) AS Groups FROM (
          SELECT Date, ORGRP2, Caseblock, SurgeonService, SUM(ISNULL(BLOCKTIME,0)) AS BT
          FROM V4_FORECAST_COMPILE
          WHERE Date >= ? AND Date <= ?
          GROUP BY Date, ORGRP2, Caseblock, SurgeonService
        ) x
    """, frm, to)[0]['Groups']

    passing = rows(cur, """
        SELECT COUNT(*) AS Groups FROM (
          SELECT Date, ORGRP2, Caseblock, SurgeonService, SUM(ISNULL(BLOCKTIME,0)) AS BT
          FROM V4_FORECAST_COMPILE
          WHERE Date >= ? AND Date <= ?
          GROUP BY Date, ORGRP2, Caseblock, SurgeonService
          HAVING SUM(ISNULL(BLOCKTIME,0)) > 0
        ) x
    """, frm, to)[0]['Groups']

    print(f'In window: {n_win} raw rows -> {grouped} groups -> '
          f'{passing} groups pass HAVING BLOCKTIME > 0')
    if passing == 0:
        print('  *** The radar would return ZERO rows. This is the failure point. ***')
    print()

    # ── 3. Sample of what the radar would return ─────────────────────────────
    sample = rows(cur, """
        SELECT TOP 8
          CONVERT(VARCHAR(10), Date, 23) AS Date, MAX(DOW_LONG) AS DOW,
          ISNULL(ORGRP2,'Unknown') AS Site, ISNULL(Caseblock,'Unknown') AS CaseBlock,
          ISNULL(SurgeonService,'Unknown') AS Service,
          SUM(ISNULL(BLOCKTIME,0)) AS BlockTime,
          SUM(ISNULL(SCHEDULED_INPATIENT,0)+ISNULL(SCHEDULED_OUTPATIENT,0)) AS Cases
        FROM V4_FORECAST_COMPILE
        WHERE Date >= ? AND Date <= ?
        GROUP BY Date, ORGRP2, Caseblock, SurgeonService
        HAVING SUM(ISNULL(BLOCKTIME,0)) > 0
        ORDER BY Date, ORGRP2, Caseblock
    """, frm, to)
    print('Sample rows the radar should show:')
    for s in sample:
        print(f"   {s['Date']} {s['DOW']:<10} {s['Site']:<32} {s['CaseBlock']:<14} "
              f"{s['Service']:<18} block={s['BlockTime']:>6} cases={s['Cases']}")
    if not sample:
        print('   (none)')
    print()

    # ── 4. Vocabulary — do site/block names look sane? ───────────────────────
    print('Distinct ORGRP2 (site) values in the forward window:')
    for s in rows(cur, """
        SELECT ISNULL(ORGRP2,'(null)') AS Site, COUNT(*) AS N
        FROM V4_FORECAST_COMPILE WHERE Date >= ? AND Date <= ?
        GROUP BY ORGRP2 ORDER BY N DESC
    """, frm, to):
        print(f"   {s['Site']!r}  ({s['N']} rows)")
    print()

    # ── 5. The historical half of the radar ──────────────────────────────────
    h = rows(cur, """
        SELECT COUNT(*) AS Blocks, SUM(SumBlock) AS TotalBlock FROM (
          SELECT ISNULL(CaseBlock,'Unknown') AS CaseBlock,
                 SUM(ISNULL(blockTime,0)) AS SumBlock
          FROM V4_BlockResultsView
          WHERE BlockDate >= DATEADD(day, -90, CAST(GETDATE() AS DATE))
            AND BlockDate <  CAST(GETDATE() AS DATE)
            AND DATEPART(WEEKDAY, BlockDate) IN (2,3,4,5,6)
          GROUP BY CaseBlock
        ) x
    """)[0]
    print(f"Historical half (last 90d, Mon-Fri): {h['Blocks']} case blocks, "
          f"total blockTime {h['TotalBlock']}")
    if not h['Blocks']:
        print('  *** No history -> risk scores would have no trailing signal. ***')

    conn.close()


if __name__ == '__main__':
    main()

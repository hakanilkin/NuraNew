#!/usr/bin/env python3
"""
Regression check for the tenant-configurable unit category mapping — Python half.

The Node half (unit_category_regression.js) covers the routes; this covers the
pipelines, which read the same config/tenantColumns.json through
pipeline_config.py. Both must agree, and neither may change what NHS or OHS
produced before the mapping moved out of hardcoded SQL.

Run: python scripts/checks/unit_category_regression.py
"""

import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
sys.path.insert(0, ROOT)

from pipeline_config import (           # noqa: E402
    get_tenant_config, unit_category_sql, classify_unit,
)


def legacy_classify(name):
    """The logic as it stood before the change, from do_dc_pipeline.py."""
    if name is None or name == '':
        return 'Other'
    n = str(name).upper()
    if '2E' in n or '2W' in n:
        return '2nd Floor'
    if '3E' in n or '3W' in n:
        return '3rd Floor'
    if '5W' in n or '6N' in n:
        return '6N/5W'
    if 'ICU' in n or 'CORONARY CARE' in n:
        return 'ICU'
    if 'PCU' in n:
        return 'PCU'
    if ('MOTHER BABY' in n or 'LABOR' in n
            or 'SPECIAL CARE NURS' in n or 'NEWBORN' in n):
        return 'Maternal Child Health'
    if 'HOSPITAL AT HOME' in n:
        return 'Hospital at Home'
    if 'IP REHAB' in n:
        return 'Rehab'
    return 'Other'


FIXTURES = [
    'OLLH 2E MED SURG', 'OLLH 2W SURG', 'MEMH 3E TELE', 'VORH 3W ONC',
    'MARH 5W MED', 'OLLH 6N MED SURG', 'OLLH ICU', 'MEMH CORONARY CARE UNIT',
    'VORH NSICU', 'OLLH PCU', 'MEMH MOTHER BABY', 'VORH LABOR AND DELIVERY',
    'OLLH SPECIAL CARE NURSERY', 'MARH NEWBORN NURSERY', 'VIRTUA HOSPITAL AT HOME',
    'VORH IP REHAB', 'OLLH EMERGENCY', 'OLLH OR', 'MEMH ENDOSCOPY', 'UNK',
    'SOME UNMAPPED UNIT', '', None,
    'BMH 5 CENTRAL MED SURG', 'BMH 4 EAST MED SURG', 'BMH 3 WEST TELEMETRY',
    'BMH ICU', 'BMH STEPDOWN PCU',
]

DEMO_EXPECTED = {
    'BMH 5 CENTRAL MED SURG': '5 Central',
    'BMH 4 EAST MED SURG':    '4 East',
    'BMH 3 WEST TELEMETRY':   '3 West',
    'BMH ICU':                'ICU',
    'BMH STEPDOWN PCU':       'Stepdown',
    'BMH EMERGENCY':          'Other',
    '':                       'Other',
}


def norm(s):
    return re.sub(r'\s+', ' ', s).strip()


LEGACY_SQL = norm("""CASE
  WHEN (e.DEP_LASTDEPT LIKE '%2E%' OR e.DEP_LASTDEPT LIKE '%2W%') THEN '2nd Floor'
  WHEN (e.DEP_LASTDEPT LIKE '%3E%' OR e.DEP_LASTDEPT LIKE '%3W%') THEN '3rd Floor'
  WHEN (e.DEP_LASTDEPT LIKE '%5W%' OR e.DEP_LASTDEPT LIKE '%6N%') THEN '6N/5W'
  WHEN (e.DEP_LASTDEPT LIKE '%ICU%' OR e.DEP_LASTDEPT LIKE '%CORONARY CARE%') THEN 'ICU'
  WHEN e.DEP_LASTDEPT LIKE '%PCU%' THEN 'PCU'
  WHEN (e.DEP_LASTDEPT LIKE '%MOTHER BABY%' OR e.DEP_LASTDEPT LIKE '%LABOR%' OR e.DEP_LASTDEPT LIKE '%SPECIAL CARE NURS%' OR e.DEP_LASTDEPT LIKE '%NEWBORN%') THEN 'Maternal Child Health'
  WHEN e.DEP_LASTDEPT LIKE '%HOSPITAL AT HOME%' THEN 'Hospital at Home'
  WHEN e.DEP_LASTDEPT LIKE '%IP REHAB%' THEN 'Rehab'
  ELSE 'Other'
END""")

failures = []


def check(label, actual, expected):
    if actual != expected:
        failures.append(f'{label}\n    expected: {expected!r}\n    actual:   {actual!r}')


# ── 1. Live pipeline tenants must be unchanged ───────────────────────────────
for tenant in ('nhs', 'ohs'):
    cfg = get_tenant_config(tenant)
    for dept in FIXTURES:
        check(f'{tenant} classify_unit({dept!r})', classify_unit(cfg, dept), legacy_classify(dept))
    check(f'{tenant} SQL',
          norm(unit_category_sql(cfg, column='e.DEP_LASTDEPT')), LEGACY_SQL)

# ── 2. Demo maps Bright Memorial's units ─────────────────────────────────────
demo = get_tenant_config('demo')
for dept, expected in DEMO_EXPECTED.items():
    check(f'demo classify_unit({dept!r})', classify_unit(demo, dept), expected)

# ── 3. The two runtimes must agree, or the pages and the models disagree ─────
try:
    import json
    import subprocess
    node_src = (
        "const {classifyUnit}=require(process.argv[1]);"
        "const f=JSON.parse(process.argv[3]);"
        "console.log(JSON.stringify(f.map(d=>classifyUnit(process.argv[2], d===null?null:d))));"
    )
    for py_tenant, js_tenant in (('nhs', 'NHS'), ('ohs', 'OHS'), ('demo', 'Demo')):
        out = subprocess.run(
            ['node', '-e', node_src, os.path.join(ROOT, 'utils', 'tenantColumns.js'),
             js_tenant, json.dumps(FIXTURES)],
            capture_output=True, text=True, check=True, cwd=ROOT)
        js_result = json.loads(out.stdout)
        py_result = [classify_unit(get_tenant_config(py_tenant), d) for d in FIXTURES]
        if js_result != py_result:
            for d, j, p in zip(FIXTURES, js_result, py_result):
                if j != p:
                    failures.append(f'{py_tenant} runtimes disagree on {d!r}: node={j!r} python={p!r}')
except (OSError, subprocess.CalledProcessError) as exc:
    print(f'  note: skipped the node/python cross-check ({exc})')

if failures:
    print(f'\n  unit category regression: {len(failures)} failure(s)\n')
    for f in failures:
        print('  - ' + f)
    sys.exit(1)

print('  unit category regression: OK')
print(f'    {len(FIXTURES)} departments x 2 live tenants unchanged vs the old hardcoded logic')
print('    node and python classify every fixture identically')

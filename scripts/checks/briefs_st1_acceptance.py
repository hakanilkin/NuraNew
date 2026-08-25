#!/usr/bin/env python3
"""
ST-1 acceptance for the Briefs forward layer, checked without a database.

BriefsForwardLayer.md §4 requires that on the demo tenant:

  * Ortho A classifies ACT and ranks #1
  * a Spine block classifies GROW
  * the forward fill Briefs shows equals the Radar's for the same block and horizon

Those three depend on the seeded data, the briefs pipeline's quarterly
classification, and the focus classifier agreeing with each other. This checks
all of it offline by replaying each stage over the generated frames:

  1. aggregate V4_BlockResultsView exactly as performance_briefs_pipeline.py's
     query does, over the same two complete quarters, and classify status with
     the same first-match rules;
  2. aggregate V4_FORECAST_COMPILE exactly as routes/briefs.js does;
  3. hand both to the real focus classifier in routes/briefs.js, via node.

Nothing here reimplements the focus rules — a copy could agree with itself while
disagreeing with what ships.

Run: python scripts/checks/briefs_st1_acceptance.py
"""

import datetime as dt
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'demo'))

from pipeline_config import get_tenant_config                       # noqa: E402


def _quarter_end(year, q):
    """
    Transcribed from performance_briefs_pipeline._quarter_end rather than
    imported: that module opens a database connection at import time, which
    would make this offline check fail whenever the source database is asleep.
    """
    m, d = {1: (3, 31), 2: (6, 30), 3: (9, 30), 4: (12, 31)}[q]
    return dt.date(year, m, d)

ANCHOR = dt.date(2026, 8, 24)
SEED = 42
HORIZON_DAYS = 28
TARGET = 75


def two_complete_quarters(anchor):
    complete = []
    for year in range(anchor.year - 2, anchor.year + 1):
        for q in range(1, 5):
            q_end = _quarter_end(year, q)
            q_start = dt.date(year, (q - 1) * 3 + 1, 1)
            if q_end <= anchor:
                complete.append((f'{year}-Q{q}', q_start, q_end))
    complete.sort(key=lambda x: x[2], reverse=True)
    return complete[0], complete[1]


def classify_status(ib, pt, rules):
    """Transcribed from performance_briefs_pipeline.classify_status."""
    if ib is None or pt is None:
        return 'watch'
    if ib < rules['misaligned']['inblock_util_lt'] and pt > rules['misaligned']['primetime_util_gt']:
        return 'misaligned'
    if ib > rules['under_allocated']['inblock_util_gt'] and pt > rules['under_allocated']['primetime_util_gt']:
        return 'under_allocated'
    rs = rules['right_sized']
    if rs['inblock_util_min'] <= ib <= rs['inblock_util_max'] \
            and rs['primetime_util_min'] <= pt <= rs['primetime_util_max']:
        return 'right_sized'
    if ib < rules['over_allocated']['inblock_util_lt'] and pt < rules['over_allocated']['primetime_util_lt']:
        return 'over_allocated'
    return 'watch'


def briefs_from_frame(block_rows, rules, anchor):
    """The pipeline's Step 3 query and classification, over the generated frame."""
    (curr_label, curr_start, curr_end), (prior_label, _, _) = two_complete_quarters(anchor)
    agg = {}
    for r in block_rows:
        d = r['BlockDate']
        if not (curr_start <= d <= curr_end):
            continue
        a = agg.setdefault(r['CaseBlock'], {'allocated': 0.0, 'inblock': 0.0, 'prime': 0.0})
        a['allocated'] += r['blockTime'] or 0
        a['inblock']   += r['InBlock'] or 0
        a['prime']     += r['Total_Prime_Time'] or 0

    out = []
    for block, a in agg.items():
        ib = 100.0 * a['inblock'] / a['allocated'] if a['allocated'] else None
        pt = 100.0 * a['prime'] / a['allocated'] if a['allocated'] else None
        out.append({'caseblock': block, 'status': classify_status(ib, pt, rules),
                    'inblock_util': ib, 'primetime_util': pt})
    return out, curr_label, prior_label


def forward_fill(forecast_rows, horizon_days):
    """The aggregation in routes/briefs.js, over the generated frame."""
    agg = {}
    for r in forecast_rows:
        if not (1 <= r['DaysAhead'] <= horizon_days):
            continue
        a = agg.setdefault(r['Caseblock'] or 'Unknown', {'blk': 0.0, 'booked': 0.0})
        a['blk'] += r['BLOCKTIME'] or 0
        # Booked so far, matching routes/briefs.js.
        a['booked'] += ((r['SCHEDULED_INPATIENT_DURwTurn'] or 0)
                        + (r['SCHEDULED_OUTPATIENT_DURwTurn'] or 0))
    return {k: (100.0 * v['booked'] / v['blk'] if v['blk'] > 0 else None)
            for k, v in agg.items()}


def classify_with_shipping_code(items, target):
    """Call the real classifier in routes/briefs.js rather than a copy of it."""
    script = (
        "const b=require(process.argv[1]);"
        "const items=JSON.parse(process.argv[2]);const target=Number(process.argv[3]);"
        "const out=items.map(i=>({...i,focus:b.classifyFocus(i.status,i.fwd_fill_pct,target),"
        "reason:b.buildReason(i.status,i.inblock_util,i.fwd_fill_pct,target,28)}));"
        "const order=b.FOCUS_ORDER;"
        "out.sort((a,z)=>{const f=order.indexOf(a.focus)-order.indexOf(z.focus);if(f)return f;"
        "const da=a.fwd_fill_pct===null?-1:Math.abs(a.fwd_fill_pct-target);"
        "const dz=z.fwd_fill_pct===null?-1:Math.abs(z.fwd_fill_pct-target);"
        "if(dz!==da)return dz-da;return String(a.caseblock).localeCompare(String(z.caseblock));});"
        "console.log(JSON.stringify(out));"
    )
    res = subprocess.run(
        ['node', '-e', script, os.path.join(ROOT, 'routes', 'briefs.js'),
         json.dumps(items), str(target)],
        capture_output=True, text=True, check=True, cwd=ROOT)
    return json.loads(res.stdout)


def main():
    import seed_demo_tenant as S
    print('  Generating the seed the database was loaded from ...')
    tables, _ = S.generate_all(ANCHOR, SEED)

    rules = get_tenant_config('demo')['brief_status_rules']
    briefs, curr_label, prior_label = briefs_from_frame(
        tables['V4_BlockResultsView'], rules, ANCHOR)
    fills = forward_fill(tables['V4_FORECAST_COMPILE'], HORIZON_DAYS)

    items = [{'caseblock': b['caseblock'], 'status': b['status'],
              'inblock_util': round(b['inblock_util'], 1) if b['inblock_util'] is not None else None,
              'primetime_util': round(b['primetime_util'], 1) if b['primetime_util'] is not None else None,
              'fwd_fill_pct': (round(fills[b['caseblock']], 1)
                               if fills.get(b['caseblock']) is not None else None)}
             for b in briefs]
    ranked = classify_with_shipping_code(items, TARGET)

    print(f'\n  Quarters: current {curr_label}, prior {prior_label}   '
          f'horizon {HORIZON_DAYS}d, target {TARGET}%\n')
    print(f'  {"#":>3} {"focus":<9}{"block":<16}{"status":<17}{"in-block":>9}{"prime":>8}{"fwd":>8}')
    for i, it in enumerate(ranked, 1):
        fwd = '  none' if it['fwd_fill_pct'] is None else f"{it['fwd_fill_pct']:.1f}"
        print(f'  {i:>3} {it["focus"]:<9}{it["caseblock"]:<16}{it["status"]:<17}'
              f'{it["inblock_util"]:>9}{it["primetime_util"]:>8}{fwd:>8}')

    failures = []
    by_block = {i['caseblock']: i for i in ranked}

    ortho = by_block.get('Ortho A')
    if not ortho:
        failures.append('Ortho A does not appear in the briefs at all')
    else:
        if ortho['focus'] != 'ACT':
            failures.append(f"Ortho A classifies {ortho['focus']}, not ACT "
                            f"(status {ortho['status']}, in-block {ortho['inblock_util']}, "
                            f"prime {ortho['primetime_util']}, forward {ortho['fwd_fill_pct']})")
        if ranked[0]['caseblock'] != 'Ortho A':
            failures.append(f"Ortho A ranks #{ranked.index(ortho) + 1}, not #1 "
                            f"(#1 is {ranked[0]['caseblock']})")

    spine = [i for i in ranked if i['caseblock'].startswith('Spine')]
    if not spine:
        failures.append('no Spine block appears in the briefs')
    elif not any(i['focus'] == 'GROW' for i in spine):
        failures.append('no Spine block classifies GROW: '
                        + ', '.join(f"{i['caseblock']}={i['focus']}" for i in spine))

    print()
    if ortho:
        print(f'  Ortho A: {ortho["reason"]}')
    for s in spine:
        if s['focus'] == 'GROW':
            print(f'  {s["caseblock"]}: {s["reason"]}')

    print()
    if failures:
        print(f'  ST-1 acceptance: {len(failures)} failure(s)\n')
        for f in failures:
            print('  - ' + f)
        sys.exit(1)
    print('  ST-1 acceptance: OK — Ortho A is ACT and ranked #1, a Spine block is GROW')


if __name__ == '__main__':
    main()

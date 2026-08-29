#!/usr/bin/env python3
"""
ST-8 acceptance for Block Allocations, checked without a database.

BlockAllocations.md section 9 asks the demo tenant to show a legible spread of
patterns — at least one each of WRONG_DAY, OVER_ALLOCATED, UNDER_ALLOCATED and
ABANDONED, with Ortho A abandoned so the Release Radar and this page tell one
story about the same block.

This replays the pipeline's own aggregation over the generated frames and runs
the shipping taxonomy, so it checks the classification the page will show rather
than a restatement of it.

Run: python scripts/checks/block_allocations_acceptance.py
"""

import datetime as dt
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'demo'))

import json                      # noqa: E402
import block_patterns as BP      # noqa: E402
import demo_config as C          # noqa: E402

# Thresholds are tenant configuration, so the check has to use the tenant's.
_TENANTS = json.load(open(os.path.join(ROOT, 'config', 'tenantColumns.json'), encoding='utf-8'))
THRESHOLDS = _TENANTS['Demo']['params'].get('block_pattern_thresholds')

ANCHOR = dt.date(2026, 8, 25)
SEED = 42
WEEKS = 13          # a quarter, as the pipeline reviews




def classify(tables, ctx, anchor=ANCHOR, weeks=WEEKS):
    """
    Replay the pipeline's aggregation and run the shipping taxonomy.

    Shared with verify.py so the storyline check and this acceptance check
    assert against one classification rather than two that can drift.
    """
    since = anchor - dt.timedelta(weeks=weeks)
    failures = []

    def check(label, actual, ok, target):
        print(f'  [{"ok  " if ok else "FAIL"}] {label:<52} {str(actual):>16}   (target {target})')
        if not ok:
            failures.append(f'{label}: {actual}, expected {target}')

    # ── Allocation and in-block use, by block and weekday ───────────────────
    alloc = {}
    for r in tables['V4_BlockResultsView']:
        d = r['BlockDate']
        if not (since <= d < anchor) or d.weekday() > 4 or r['CaseBlock'] == 'Open':
            continue
        key = r['CaseBlock']
        a = alloc.setdefault(key, {'service': r['Group_Service'], 'site': r['LocationGroup'],
                                   'dow': {}, 'released': 0.0, 'instances': set()})
        e = a['dow'].setdefault(d.weekday(), {'alloc': 0.0, 'used': 0.0})
        e['alloc'] += (r['blockTime'] or 0) / 60.0
        e['used'] += (r['InBlock'] or 0) / 60.0
        if r['blockTime']:
            a['instances'].add(d)
        # An instance is released or it is not; dividing hours by a nominal
        # block length counts a half-day release as half an event.
        if r['ReleasedTime']:
            a.setdefault('released_days', set()).add(d)

    # ── Volume booked outside any block, by service and weekday ─────────────
    outside = {}
    for c in ctx['cases']:
        if c['__is_future'] or c['__cancelled'] or c['Case_CaseBlock'] != 'Open':
            continue
        d = c['Date_SchedDate']
        if not (since <= d < anchor) or d.weekday() > 4:
            continue
        k = (c['Case_SurgeonService'], c['Loc_ORGrp2'], d.weekday())
        outside[k] = outside.get(k, 0.0) + (c['Dur_ORIn_OROut'] or 0) / 60.0

    # Out-of-block volume belongs to the blocks of that service in proportion
    # to what they hold. Crediting the whole service's spill to every one of its
    # blocks makes three ortho blocks each look like they are losing all of it.
    service_alloc = {}
    for block, a in alloc.items():
        total = sum(e['alloc'] for e in a['dow'].values())
        service_alloc[(a['service'], a['site'])] = \
            service_alloc.get((a['service'], a['site']), 0.0) + total

    # How far into its block each day actually runs, for the wrong-shape test.
    day_end = {}
    for c in ctx['cases']:
        if c['__is_future'] or c['__cancelled'] or c['Case_CaseBlock'] == 'Open':
            continue
        d = c['Date_SchedDate']
        if not (since <= d < anchor):
            continue
        k = (c['Case_CaseBlock'], d)
        day_end[k] = max(day_end.get(k, 0.0), (c['__end_min'] - 7 * 60) / 60.0)
    tail = {}
    for (blk, _d), hours in day_end.items():
        tail.setdefault(blk, []).append(hours)
    tail = {b: sum(v) / len(v) for b, v in tail.items()}

    findings = []
    for block, a in alloc.items():
        by_dow = []
        mine = sum(e['alloc'] for e in a['dow'].values())
        pool = service_alloc.get((a['service'], a['site']), 0.0)
        share = (mine / pool) if pool > 0 else 0.0
        for d in range(5):
            e = a['dow'].get(d, {'alloc': 0.0, 'used': 0.0})
            by_dow.append({
                'dow': d,
                'alloc': e['alloc'] / weeks,
                'used': e['used'] / weeks,
                'outside': outside.get((a['service'], a['site'], d), 0.0) * share / weeks,
            })
        instances = len(a['instances'])
        release_events = len(a.get('released_days', ()))
        found = BP.classify_block(by_dow, release_events=release_events,
                                  release_of=instances, cfg=THRESHOLDS,
                                  last_case_out_hours=tail.get(block))
        findings.append({'owner': block, 'service': a['service'], **found})

    findings.sort(key=lambda f: -(f['mismatchHours'] or 0))
    return findings
def main():
    import seed_demo_tenant as S
    print('  Generating the seed ...')
    tables, ctx = S.generate_all(ANCHOR, SEED)
    findings = classify(tables, ctx)
    weeks = WEEKS
    failures = []

    def check(label, actual, ok, target):
        print(f'  [{"ok  " if ok else "FAIL"}] {label:<52} {str(actual):>16}   (target {target})')
        if not ok:
            failures.append(f'{label}: {actual}, expected {target}')


    print(f'\n  {len(findings)} blocks classified over {weeks} weeks\n')
    print(f'  {"block":<16}{"service":<18}{"pattern":<17}{"mismatch":>9}  recommendation')
    for f in findings:
        print(f'  {f["owner"]:<16}{f["service"][:17]:<18}{f["pattern"]:<17}'
              f'{f["mismatchHours"]:>9}  {f["recommendation"]["text"][:60]}')

    print()
    seen = {f['pattern'] for f in findings}
    for pat in C.STORYLINES['st8']['required_patterns']:
        n = sum(1 for f in findings if f['pattern'] == pat)
        check(f'ST-8 at least one {pat}', n, n >= 1, '>= 1')

    ortho = next((f for f in findings if f['owner'] == C.STORYLINES['st8']['abandoned_block']), None)
    check('ST-8 Ortho A is ABANDONED', ortho['pattern'] if ortho else None,
          bool(ortho) and ortho['pattern'] == BP.ABANDONED, 'ABANDONED')

    wd = [f for f in findings if f['pattern'] == BP.WRONG_DAY]
    check('ST-8 the wrong-day owner is the expected service',
          wd[0]['service'] if wd else None,
          bool(wd) and wd[0]['service'] == C.STORYLINES['st8']['wrong_day_service'],
          C.STORYLINES['st8']['wrong_day_service'])

    # The inverse of the old assertion, which had it backwards: a roster
    # where most blocks say "no change" is not a demo, and UNCLASSIFIED counts
    # as inert too — an honest gap is still not a finding.
    inert = sum(1 for f in findings
                if f['pattern'] in (BP.RIGHT_SIZED, BP.UNCLASSIFIED))
    check('ST-8 no more than half the roster is inert',
          f'{inert} of {len(findings)}', inert <= len(findings) * 0.5, '<= 50%')

    # Sorted by magnitude, because that is what a committee has agenda time for.
    mism = [f['mismatchHours'] or 0 for f in findings]
    check('ST-8 findings sort by mismatch hours', 'descending',
          mism == sorted(mism, reverse=True), 'descending')

    print()
    if failures:
        print(f'  Block Allocations acceptance: {len(failures)} failure(s)\n')
        for f in failures:
            print('  - ' + f)
        sys.exit(1)
    print('  Block Allocations acceptance: OK')


if __name__ == '__main__':
    main()

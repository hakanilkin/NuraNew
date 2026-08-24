#!/usr/bin/env python3
"""
ST-6 acceptance for the ISSCM scenario engine, checked without a database.

DemoTenant.md ST-6: the ST-1 reallocation evaluated on Thursday must *conflict*
— staffing and inpatient capacity degrade — while the same reallocation on
Tuesday clears all three pillars. The spec is emphatic that this has to fall out
of the engine reading seeded data: "verdicts are derived, never stored. If the
conflict doesn't emerge, the seed numbers are wrong, not the engine."

So this builds the pillar baselines from the generated frames the way
routes/isscm.js will build them from live queries, hands them to the real engine
in lib/isscmScenario.js via node, and checks the verdicts.

Run: python scripts/checks/isscm_st6_acceptance.py
"""

import datetime as dt
import json
import os
import statistics as st
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'demo'))

import demo_config as C          # noqa: E402

ANCHOR = dt.date(2026, 8, 24)
SEED = 42
BLOCK = 'Ortho A'
RECEIVING = 'Spine'
MOVE_HOURS = 4.0
SITE = C.MAIN_SITE


def block_utilisation(block_rows, block, weekday):
    rows = [r for r in block_rows if r['CaseBlock'] == block
            and r['BlockDate'].weekday() == weekday]
    alloc = sum(r['blockTime'] for r in rows)
    inblk = sum(r['InBlock'] for r in rows)
    room_days = {(r['BlockDate'], r['ORLoc']) for r in rows}
    true_prime = sum(r['Total_Prime_Time'] for r in block_rows
                     if (r['BlockDate'], r['ORLoc']) in room_days)
    return {
        'allocatedHours': (alloc / len(room_days) / 60) if room_days else 0,
        'blockUtilPct': 100.0 * inblk / alloc if alloc else 0,
        'trueUtilPct': 100.0 * true_prime / alloc if alloc else 0,
    }


def staffing_baseline(cases, weekday, turnover_min):
    """Room-hours the day actually draws, against the configured rectangle."""
    plan = next(p for p in C.STAFFING_PLAN if p[0] == SITE and p[1] == weekday + 1)
    _, _, start, end, rooms, ratio = plan
    shift_start = int(start[:2]) * 60 + int(start[3:])
    shift_end = int(end[:2]) * 60 + int(end[3:])

    by_day, past_shift = {}, {}
    for c in cases:
        if c['__is_future'] or c['__cancelled'] or c['Loc_ORGrp2'] != SITE:
            continue
        if c['__weekday'] != weekday:
            continue
        d = c['Date_SchedDate']
        by_day.setdefault(d, []).append(c)
        past_shift[d] = past_shift.get(d, 0.0) + max(
            0, c['__end_min'] - max(c['__start_min'], shift_end)) / 60.0

    required, peaks = [], []
    for d, day_cases in by_day.items():
        mins = sum((c['__end_min'] - c['__start_min']) + turnover_min for c in day_cases)
        required.append(mins / 60.0)
        spans = [(c['__start_min'], c['__end_min']) for c in day_cases]
        peaks.append(max((sum(1 for a, b in spans if a <= t < b)
                          for t in range(shift_start, shift_end, 15)), default=0))

    return {
        'staffedRooms': rooms,
        'shiftHours': (shift_end - shift_start) / 60.0,
        'coverageRatio': ratio,
        'requiredRoomHours': round(st.mean(required), 2) if required else 0,
        'pastShiftRoomHours': round(st.mean(past_shift.values()), 2) if past_shift else 0,
        'concurrencyPeak': round(st.mean(peaks)) if peaks else 0,
    }


def capacity_baseline(occupancy, cases, weekday):
    """Projected census on the units, on the day the admissions would land."""
    # The census the OR schedule is deciding into is the one on the day the
    # block runs; see the note in lib/isscmScenario.js evaluateCapacity.
    landing = weekday
    units = []
    for unit, loc, beds, _code in C.UNITS:
        vals = [r['Occupancy'] for r in occupancy
                if r['DEP_NAME'] == unit and r['Datehour'].hour == 7
                and r['Datehour'].weekday() == landing]
        units.append({'unit': unit, 'staffedBeds': beds,
                      'projectedCensus': round(st.mean(vals), 1) if vals else 0})

    done = [c for c in cases if not c['__is_future'] and not c['__cancelled']]
    hours = [(c['__end_min'] - c['__start_min']) / 60.0 for c in done
             if c['Case_SurgeonService'] == RECEIVING]
    return {
        'units': units,
        'inpatientConversionRate': dict(C.SERVICE_INPATIENT_RATE),
        'serviceUnitMap': C.SERVICE_UNIT_MAP,
        'averageCaseHours': round(st.mean(hours), 2) if hours else 2.0,
    }


def spine_pipeline_lift(cases):
    def per_weekday(pred):
        rows = [c for c in cases if pred(c) and c['__weekday'] < 5 and not c['__cancelled']]
        days = len({c['Date_SchedDate'] for c in rows}) or 1
        return len(rows) / days
    fwd = per_weekday(lambda c: c['__is_future'] and c['Case_SurgeonService'] == RECEIVING)
    hist = per_weekday(lambda c: not c['__is_future'] and c['Case_SurgeonService'] == RECEIVING)
    return 100.0 * (fwd / hist - 1) if hist else 0.0


def run_engine(baseline, decision):
    script = (
        "const e=require(process.argv[1]);"
        "console.log(JSON.stringify(e.evaluate(JSON.parse(process.argv[2]),"
        "JSON.parse(process.argv[3]))));"
    )
    res = subprocess.run(
        ['node', '-e', script, os.path.join(ROOT, 'lib', 'isscmScenario.js'),
         json.dumps(baseline), json.dumps(decision)],
        capture_output=True, text=True, check=True, cwd=ROOT)
    return json.loads(res.stdout)


def main():
    import seed_demo_tenant as S
    print('  Generating the seed ...')
    tables, ctx = S.generate_all(ANCHOR, SEED)
    cases = ctx['cases']
    lift = spine_pipeline_lift(cases)

    results = {}
    for label, weekday in (('Thursday', 3), ('Tuesday', 1)):
        util = block_utilisation(tables['V4_BlockResultsView'], BLOCK, 3)   # the block's own day
        baseline = {
            'site': SITE, 'block': BLOCK, 'dayOfWeek': weekday,
            'surgeon': {**util, 'receivingService': RECEIVING,
                        'receivingPipelineVsBaselinePct': round(lift, 1),
                        'strategicWeight': 3},
            'staffing': staffing_baseline(cases, weekday, 33),
            'capacity': capacity_baseline(tables['DS_Occupancy'], cases, weekday),
        }
        decision = {'kind': 'REALLOCATE', 'fromBlock': BLOCK, 'toService': RECEIVING,
                    'hours': MOVE_HOURS, 'dayOfWeek': weekday, 'dayOfWeekLabel': label,
                    'weeks': 8, 'scenarioId': f'demo-{label.lower()}-ortho-to-spine'}
        results[label] = (baseline, run_engine(baseline, decision))

    for label, (baseline, r) in results.items():
        stf, cap = baseline['staffing'], baseline['capacity']
        print(f'\n  ── Move {MOVE_HOURS:g}h of {BLOCK} to {RECEIVING} on {label} ──')
        print(f'     staffed {stf["staffedRooms"]}x{stf["shiftHours"]}h = '
              f'{stf["staffedRooms"] * stf["shiftHours"]:.1f} room-h, '
              f'day draws {stf["requiredRoomHours"]:.1f}')
        for k, p in r['pillars'].items():
            h = p['headline']
            print(f'     {k:9s} {p["status"]:9s} {h["label"]}: '
                  f'{h["before"]} -> {h["after"]} {h["unit"]}')
        for c in r['conflicts']:
            print(f'     CONFLICT ({c["severity"]}): {c["summary"]}')
        if not r['conflicts']:
            print('     no conflict — all pillars clear')

    failures = []
    thu = results['Thursday'][1]
    tue = results['Tuesday'][1]

    if not thu['conflicts']:
        failures.append('Thursday produces no conflict — the demo\'s central moment '
                        'does not happen')
    else:
        degrading = set(thu['conflicts'][0]['pillars'])
        if not degrading & {'staffing', 'capacity'}:
            failures.append(f'Thursday degrades {sorted(degrading)}, but ST-6 is about '
                            'staffing and inpatient capacity')
    if thu['pillars']['surgeon']['status'] != 'improves':
        failures.append('Thursday utilisation does not improve, so there is nothing '
                        'for the other pillars to be in tension with')

    if tue['conflicts']:
        failures.append(f'Tuesday still conflicts: {tue["conflicts"][0]["summary"]}')
    if tue['pillars']['surgeon']['status'] != 'improves':
        failures.append('Tuesday utilisation does not improve')
    for k in ('staffing', 'capacity'):
        if tue['pillars'][k]['status'] == 'degrades':
            failures.append(f'Tuesday {k} degrades — the resolution does not clear')

    print()
    if failures:
        print(f'  ST-6 acceptance: {len(failures)} failure(s)\n')
        for f in failures:
            print('  - ' + f)
        print('\n  Per the spec, this means the seed numbers are wrong, not the engine.')
        sys.exit(1)
    print('  ST-6 acceptance: OK — Thursday conflicts, Tuesday clears all three pillars')


if __name__ == '__main__':
    main()

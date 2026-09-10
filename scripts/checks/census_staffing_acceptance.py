#!/usr/bin/env python3
"""
ST-2 and ST-3 acceptance for the census and staffing arithmetic, offline.

Both pages that used to own these numbers are gone — their forward halves are
Volume Impact's Inpatient and Staffing tabs now — but the libraries they
computed through are the same ones those tabs and the ScenarioPanel's pillars
call, so the figures still have to hold:

  ST-2   Wednesday 5 Central ~30/32 at 07:00, ~27% OR-attributed,
         ~3.3 crunch unit-days per week
  ST-3   ~12.7 overtime room-hours/week, Friday idle >= 25 room-hours,
         3.0-3.2 rooms running at 15:30 Tue-Thu, Friday implied ~6 rooms

Volume Impact computes through lib/censusFootprint.js and lib/staffingShape.js, so
this drives those libraries with the generated frames — the same numbers the
database holds — and checks what the pages will show. The SQL that feeds them in
production still needs a live run; this checks the arithmetic and the seed.

Run: python scripts/checks/census_staffing_acceptance.py
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
SITE = C.MAIN_SITE
WEEKS = 8
DAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']


def call_lib(module, fn, *args):
    """Call the shipping JS so this checks what runs, not a Python copy of it."""
    script = ("const m=require(process.argv[1]);"
              "const a=JSON.parse(process.argv[3]);"
              "console.log(JSON.stringify(m[process.argv[2]](...a)));")
    res = subprocess.run(
        ['node', '-e', script, os.path.join(ROOT, 'lib', module), fn, json.dumps(list(args))],
        capture_output=True, text=True, check=True, cwd=ROOT)
    return json.loads(res.stdout)


def rr_shape(rr_rows, weekday, since):
    """Average rooms per slot for one weekday — what /api/staffing/shape returns."""
    by_slot = {}
    for r in rr_rows:
        if r['ORGroup'] != SITE or r['rrDate'].weekday() != weekday or r['rrDate'] < since:
            continue
        by_slot.setdefault(r['rrtimeslot'], []).append(r['TotalOccupied'])
    out = []
    for slot, vals in by_slot.items():
        h, m = slot.split(':')
        out.append({'minuteOfDay': int(h) * 60 + int(m), 'rooms': st.mean(vals)})
    return sorted(out, key=lambda s: s['minuteOfDay'])


def main():
    import seed_demo_tenant as S
    print('  Generating the seed ...')
    tables, ctx = S.generate_all(ANCHOR, SEED)
    since = ANCHOR - dt.timedelta(weeks=WEEKS)
    failures = []

    def check(label, actual, ok, target, unit=''):
        shown = f'{actual:,.1f}' if isinstance(actual, float) else f'{actual}'
        print(f'  [{"ok  " if ok else "FAIL"}] {label:<50} {shown:>8} {unit:<9} (target {target})')
        if not ok:
            failures.append(f'{label}: {shown} {unit}, expected {target}')

    # ── ST-3, through lib/staffingShape.js ──────────────────────────────────
    print('\n  ── Staffing ledger (lib/staffingShape.js) ──')
    plan = {'staffedRooms': 9, 'shiftStart': '07:00', 'shiftEnd': '15:30'}
    total_ot, fri_idle, cliff = 0.0, None, []
    for weekday in range(5):
        shape = rr_shape(tables['DS_RR'], weekday, since)
        row = call_lib('staffingShape.js', 'ledgerRow', shape, plan, 15)
        total_ot += row['overtimeRoomHours']
        if weekday == 4:
            fri_idle = row['idleRoomHours']
        if weekday in (1, 2, 3):
            cliff.append(row['roomsAtShiftEnd'])
        print(f"     {DAY[weekday]}  idle={row['idleRoomHours']:6.1f}  "
              f"overtime={row['overtimeRoomHours']:5.1f}  "
              f"alignment={row['alignmentPct']:5.1f}%  at 15:30={row['roomsAtShiftEnd']}")

    # verify.py measures case-minutes past 15:30; the ledger measures room-slots
    # occupied after 15:30, because the page must agree with Room Running, which
    # reads DS_RR. A room occupied for five minutes of a fifteen-minute slot
    # counts as the whole slot, so the ledger reads a few hours higher. Both are
    # correct for what they measure; the band allows for the difference.
    # Upper bound widened from 20: ST-8's after-hours ENT emergent list
    # (NON_PRIME_TIME) is real overtime the demo did not carry before. The
    # slot-based ledger reads a few hours above verify.py's room-minute figure,
    # so its ceiling sits above ST-3's own (see demo_config st3).
    check('ST-3 overtime room-hours per week (DS_RR slots)', total_ot,
          10.0 <= total_ot <= 28.0, '10–28', 'h')
    check('ST-3 Friday idle staffed room-hours', fri_idle, fri_idle >= 25, '>= 25', 'h')
    mean_cliff = st.mean(cliff)
    check('ST-3 rooms running at 15:30 (Tue–Thu)', mean_cliff, 2.6 <= mean_cliff <= 4.2, '2.6–4.2', 'rooms')

    fwd_by_day = {}
    for r in tables['V4_FORECAST_COMPILE']:
        if r['ORGRP2'] != SITE or not (1 <= r['DaysAhead'] <= 28):
            continue
        fwd_by_day[r['Date']] = fwd_by_day.get(r['Date'], 0.0) + (
            r['SCHEDULED_INPATIENT_DURwTurn'] + r['SCHEDULED_OUTPATIENT_DURwTurn']
            + r['FORECAST_INPATIENT_DURwTurn'] + r['FORECAST_OUTPATIENT_DURwTurn'])
    fri = [m for d, m in fwd_by_day.items() if d.weekday() == 4]
    fri_implied = call_lib('staffingShape.js', 'impliedRooms', st.mean(fri), plan) if fri else 0
    check('ST-3 Friday implied rooms (forward)', fri_implied, 3 <= fri_implied <= 7, '3–7', 'rooms')
    flag = call_lib('staffingShape.js', 'flexFlag', 9, fri_implied)
    check('ST-3 Friday flex flag', flag, flag == 'FLEX_DOWN', 'FLEX_DOWN')

    # ── ST-2, through lib/censusFootprint.js ────────────────────────────────
    print('\n  ── Census attribution (lib/censusFootprint.js) ──')
    beds = {u: b for u, _loc, b, _c in C.UNITS}
    avg_los = st.mean([e['ACCOUNT_IPLOS'] for e in ctx['encounters']])
    hist_enc = [e for e in ctx['encounters'] if e['__admit'].date() >= since]

    cells = []
    for unit in beds:
        for dow in range(7):
            occ = [r['Occupancy'] for r in tables['DS_Occupancy']
                   if r['DEP_NAME'] == unit and r['Datehour'].hour == 7
                   and r['Datehour'].weekday() == dow and r['Datehour'].date() >= since]
            if not occ:
                continue
            # Who is in the bed at 07:00, by how they got there — the same
            # stock measure routes/smoothing.js computes.
            in_bed, from_or = 0, 0
            for r in tables['DS_Occupancy']:
                if (r['DEP_NAME'] != unit or r['Datehour'].hour != 7
                        or r['Datehour'].weekday() != dow or r['Datehour'].date() < since):
                    continue
                t = r['Datehour']
                here = [e for e in hist_enc if e['__unit'] == unit
                        and e['__admit'] <= t < e['__discharge']]
                in_bed += len(here)
                from_or += sum(1 for e in here if e['__source'] == 'OR')
            mean_census = st.mean(occ)
            or_share = (from_or / in_bed) if in_bed else 0
            ed_share = 1 - or_share
            cell = call_lib('censusFootprint.js', 'attributeCensus', {
                'census': mean_census, 'capacity': beds[unit],
                'orAdmitted': mean_census * or_share,
                'edAdmitted': mean_census * ed_share,
            }, 92)
            cell['unit'], cell['dow'] = unit, dow
            cells.append(cell)

    wed = next(c for c in cells if c['unit'] == '5 Central' and c['dow'] == 2)
    print(f"     Wed 5 Central: census {wed['census']}/{wed['capacity']} ({wed['occupancyPct']}%)  "
          f"OR {wed['or']} ({wed['orPct']}%)  ED {wed['ed']}  other {wed['other']}")
    check('ST-2 Wednesday 5 Central census', wed['census'],
          28 <= wed['census'] <= 32, '28–32', f"of {wed['capacity']}")
    check('ST-2 Wednesday 5 Central OR-attributed', wed['orPct'],
          20 <= wed['orPct'] <= 36, '20–36', '%')

    crunch_days = sum(
        1 for r in tables['DS_Occupancy']
        if r['Datehour'].hour == 7 and r['Datehour'].weekday() < 5
        and r['Datehour'].date() >= since
        and r['Occupancy'] >= 0.92 * beds[r['DEP_NAME']])
    crunch = crunch_days / WEEKS
    check('ST-2 crunch unit-days per week', crunch, 2 <= crunch <= 6, '2–6')

    # ── V1 footprint: a multi-day bed shadow, not a single spike ────────────
    print('\n  ── Bed shadow (lib/censusFootprint.js) ──')
    for service in ('Orthopedics', 'Spine'):
        los = [e['ACCOUNT_IPLOS'] for e in ctx['encounters'] if e['__service'] == service]
        histo = {}
        for v in los:
            histo[round(v)] = histo.get(round(v), 0) + 1
        cases = [c for c in ctx['cases'] if c['Case_SurgeonService'] == service
                 and not c['__is_future'] and not c['__cancelled']]
        span = max(1, len({c['Date_SchedDate'].isocalendar()[:2] for c in cases}))
        fp = call_lib('censusFootprint.js', 'bedShadow', {
            'weeklyCases': len(cases) / span,
            'conversionRate': len(los) / max(1, len(cases)),
            'losDays': [{'days': d, 'share': n} for d, n in sorted(histo.items()) if d > 0],
            'unitShares': C.SERVICE_UNIT_MAP[service],
        }, 7)
        top = fp['units'][0]
        d0, d3 = top['byOffset'][0]['beds'], top['byOffset'][3]['beds']
        print(f"     {service:12s} {fp['weeklyCases']}/wk, {fp['conversionPct']}% convert "
              f"→ {top['unit']}: D0 {d0} beds, D+3 {d3} beds")
        check(f'ST-2 {service} shadow persists past surgery day', d3, d3 > 0, '> 0', 'beds')

    print()
    if failures:
        print(f'  Census/staffing acceptance: {len(failures)} failure(s)\n')
        for f in failures:
            print('  - ' + f)
        sys.exit(1)
    print('  Census/staffing acceptance: OK')


if __name__ == '__main__':
    main()

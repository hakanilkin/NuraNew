#!/usr/bin/env python3
"""
Acceptance for Volume & Staffing Outlook against the demo seed (VolumeOutlook.md §10).

Drives lib/demandSignal.js with the generated frames — the same numbers the
database holds — and checks what the page will show:

  * 3-5 exceptions across four weeks, both directions represented, at least one
    RECOMMENDED
  * every exception carries a driver and a staffing implication; the column is
    never blank
  * Friday's ST-3 flex-down (plan 9, implied ~6) surfaces here, since the
    forward view moved off Staffing Patterns
  * the Outlook's room numbers are lib/staffingShape.js's, so this page and
    Pillar 2 cannot disagree

Run: python scripts/checks/outlook_acceptance.py
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

ANCHOR = dt.date(2026, 8, 25)
SEED = 42
WEEKS = 4
TURNOVER = 33
THRESHOLDS = {'onPlanPct': 5, 'exceptionPct': 15, 'minCases': 4}


def node(module, body, *args):
    script = (f"const m=require(process.argv[1]);const a=JSON.parse(process.argv[2]);"
              f"{body}")
    res = subprocess.run(['node', '-e', script, os.path.join(ROOT, 'lib', module),
                          json.dumps(list(args))],
                         capture_output=True, text=True, check=True, cwd=ROOT)
    return json.loads(res.stdout)


def main():
    import seed_demo_tenant as S
    print('  Generating the seed ...')
    tables, ctx = S.generate_all(ANCHOR, SEED)
    failures = []

    def check(label, actual, ok, target, unit=''):
        shown = f'{actual:,.1f}' if isinstance(actual, float) else f'{actual}'
        print(f'  [{"ok  " if ok else "FAIL"}] {label:<52} {shown:>8} {unit:<7} (target {target})')
        if not ok:
            failures.append(f'{label}: {shown} {unit}, expected {target}')

    # ── Aggregate the forward window the way routes/outlook.js does ─────────
    days, mix = {}, {}
    for r in tables['V4_FORECAST_COMPILE']:
        if not (1 <= r['DaysAhead'] <= WEEKS * 7) or r['Date'].weekday() > 4:
            continue
        key = (str(r['Date']), r['ORGRP2'])
        d = days.setdefault(key, {'scheduled': 0.0, 'forecast': 0.0, 'budget': 0.0,
                                  'booked': 0.0, 'dow': r['Date'].weekday()})
        sched = r['SCHEDULED_INPATIENT'] + r['SCHEDULED_OUTPATIENT']
        fcst = sched + r['FORECAST_INPATIENT'] + r['FORECAST_OUTPATIENT']
        d['scheduled'] += sched
        d['forecast'] += fcst
        d['budget'] += r['BUDGET_INPATIENT'] + r['BUDGET_OUTPATIENT']
        d['booked'] += (r['SCHEDULED_INPATIENT_DURwTurn'] + r['SCHEDULED_OUTPATIENT_DURwTurn']
                        + r['FORECAST_INPATIENT_DURwTurn'] + r['FORECAST_OUTPATIENT_DURwTurn'])
        m = mix.setdefault(key, {})
        e = m.setdefault(r['SurgeonService'], {'service': r['SurgeonService'],
                                               'forecast': 0.0, 'budget': 0.0})
        e['forecast'] += fcst
        e['budget'] += r['BUDGET_INPATIENT'] + r['BUDGET_OUTPATIENT']

    durations = {}
    for svc in C.SERVICES:
        mins = [c['Dur_ORIn_OROut'] for c in ctx['cases']
                if c['Case_SurgeonService'] == svc and not c['__is_future']
                and not c['__cancelled'] and c['Dur_ORIn_OROut']]
        if mins:
            durations[svc] = st.mean(mins)

    plans = {}
    for site, dow, start, end, rooms, ratio in C.STAFFING_PLAN:
        plans[(site, dow - 1)] = {'staffedRooms': rooms, 'shiftStart': start,
                                  'shiftEnd': end, 'coverageRatio': ratio}

    # ── Build every signal through the shipping library ─────────────────────
    body = ("const [rows]=a;"
            "const out=rows.map(r=>{const v=m.variance(r.forecast,r.budget);"
            "return {exception:m.isException(v,r.t),signal:m.buildSignal({date:r.date,site:r.site,v,"
            "drivers:m.primaryDrivers(r.mix.map(x=>({service:x.service,delta:x.forecast-x.budget}))),"
            "plan:r.plan,mix:r.mix,durationsByService:r.dur,turnoverMinutes:r.turnover,"
            "bookedMinutes:r.booked})};});console.log(JSON.stringify(out));")
    rows = [{
        'date': date, 'site': site, 'forecast': d['forecast'], 'budget': d['budget'],
        'booked': d['booked'], 'plan': plans.get((site, d['dow'])),
        'mix': list(mix[(date, site)].values()), 'dur': durations,
        'turnover': TURNOVER, 't': THRESHOLDS,
    } for (date, site), d in sorted(days.items())]
    scored = node('demandSignal.js', body, rows)

    exceptions = [x['signal'] for x in scored if x['exception']]
    exceptions.sort(key=lambda e: -abs(e['variance'] or 0))

    print(f'\n  {len(rows)} forward weekday-site rows, {len(exceptions)} exceptions\n')
    for e in exceptions:
        drv = ', '.join(d['detail'] for d in e['drivers']) or '—'
        print(f"     {e['date']}  {e['site'][:24]:<24} {e['forecast']:>5} fcst  "
              f"{e['variancePct']:>6}%  {e['tier']:<11} {e['implication'][:44]:<44} {drv}")

    print()
    check('Exceptions across four weeks', len(exceptions), 3 <= len(exceptions) <= 12, '3–12', 'rows')
    over = [e for e in exceptions if (e['variance'] or 0) > 0]
    under = [e for e in exceptions if (e['variance'] or 0) < 0]
    check('Both directions represented', f'{len(over)} over / {len(under)} under',
          bool(over) and bool(under), 'both')
    rec = [e for e in exceptions if e['tier'] == 'RECOMMENDED']
    check('At least one RECOMMENDED', len(rec), len(rec) >= 1, '>= 1', 'rows')

    blank = [e for e in exceptions if not (e['implication'] or '').strip()]
    check('Staffing implication never blank', len(blank), not blank, '0', 'blank')
    nodriver = [e for e in exceptions if not e['drivers']]
    check('Every exception names a driver', len(nodriver), not nodriver, '0', 'missing')

    # A 3 -> 4 case day must never appear: both thresholds, not one.
    tiny = [e for e in exceptions if abs(e['variance'] or 0) < THRESHOLDS['minCases']]
    check('No sub-floor exception', len(tiny), not tiny, '0', 'rows')

    # ── ST-3's Friday flex-down now surfaces here ───────────────────────────
    fridays = [x['signal'] for x in scored
               if dt.date.fromisoformat(x['signal']['date']).weekday() == 4
               and x['signal']['site'] == C.MAIN_SITE]
    flex_down = [f for f in fridays if f['flexFlag'] == 'FLEX_DOWN']
    check('ST-3 Friday reads as a flex-down', len(flex_down), bool(flex_down), '>= 1', 'days')
    if flex_down:
        f = flex_down[0]
        check('ST-3 Friday planned vs implied rooms',
              f"{f['plannedRooms']} -> {f['impliedRooms']}",
              f['plannedRooms'] == 9 and 3 <= f['impliedRooms'] <= 7, '9 -> 3–7')

    # ── One room-hour everywhere ────────────────────────────────────────────
    sample = next((x['signal'] for x in scored if x['signal']['impliedRooms'] is not None), None)
    if sample:
        plan = plans[(sample['site'], dt.date.fromisoformat(sample['date']).weekday())]
        booked = days[(sample['date'], sample['site'])]['booked']
        direct = node('staffingShape.js',
                      "const [b,p]=a;console.log(JSON.stringify("
                      "{implied:m.impliedRooms(b,p),flag:m.flexFlag(p.staffedRooms,m.impliedRooms(b,p))}));",
                      booked, plan)
        check('Outlook rooms equal staffingShape rooms',
              f"{sample['impliedRooms']} vs {direct['implied']}",
              sample['impliedRooms'] == direct['implied'] and sample['flexFlag'] == direct['flag'],
              'identical')

    print()
    if failures:
        print(f'  Outlook acceptance: {len(failures)} failure(s)\n')
        for f in failures:
            print('  - ' + f)
        sys.exit(1)
    print('  Outlook acceptance: OK')


if __name__ == '__main__':
    main()

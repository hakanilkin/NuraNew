#!/usr/bin/env python3
"""
Measure the generated demo data against the storyline targets.

DemoTenant.md section 10 calls storyline reconciliation "the real test": every
page that touches a storyline has to tell the same story, and that only holds if
the numbers come out where the spec says. This module measures the generated
tables and prints actual against target.

A FAIL here means the seed constants need tuning — never that a downstream
output should be edited to match.

Called by seed_demo_tenant.py; also runnable on its own against a CSV dump.
"""

import datetime as dt
import statistics as st

import demo_config as C

PASS, WARN, FAIL = 'PASS', 'WARN', 'FAIL'
_results = []


def _check(label, actual, target, ok, unit='', note=''):
    _results.append((ok, label, actual, target, unit, note))


def _band(label, actual, lo, hi, unit='', note=''):
    shown = round(actual, 1) if isinstance(actual, float) else actual
    ok = PASS if (actual is not None and lo <= shown <= hi) else FAIL
    _check(label, actual, f'{lo:g}–{hi:g}', ok, unit, note)
    return ok


def _near(label, actual, target, tol_pct, unit='', note=''):
    if actual is None:
        _check(label, None, target, FAIL, unit, note)
        return FAIL
    tol = abs(target) * tol_pct / 100.0
    shown = round(actual, 1) if isinstance(actual, float) else actual
    ok = PASS if abs(shown - target) <= tol else (
        WARN if abs(shown - target) <= tol * 2 else FAIL)
    _check(label, actual, f'{target:g} ±{tol_pct:g}%', ok, unit, note)
    return ok


def _fmt(v):
    if v is None:
        return 'n/a'
    if isinstance(v, float):
        return f'{v:,.1f}'
    return f'{v:,}' if isinstance(v, int) else str(v)


# ── Individual storyline measurements ────────────────────────────────────────

def _background(tables, ctx):
    cases  = [c for c in ctx['cases'] if not c['__is_future'] and not c['__cancelled']]
    allhist = [c for c in ctx['cases'] if not c['__is_future']]
    br = tables['V4_BlockResultsView']

    prime = sum(r['Total_Prime_Time'] for r in br)
    blk   = sum(r['blockTime'] for r in br)
    _band('Prime-time utilisation', 100.0 * prime / blk if blk else None,
          *C.BACKGROUND['primetime_util_pct'], unit='%')

    inblock = sum(r['InBlock'] for r in br if r['CaseBlock'] != 'Open')
    blk_only = sum(r['blockTime'] for r in br if r['CaseBlock'] != 'Open')
    _band('In-block utilisation', 100.0 * inblock / blk_only if blk_only else None,
          *C.BACKGROUND['inblock_util_pct'], unit='%')

    firsts = [c for c in cases if c['Turnover_Orderofcaseinroom'] == 1
              and c['Dur_Act_vs_SchedStart'] is not None]
    on_time = sum(1 for c in firsts if c['Dur_Act_vs_SchedStart'] <= 0)
    _band('FCOT on-time', 100.0 * on_time / len(firsts) if firsts else None,
          *C.BACKGROUND['fcot_pct'], unit='%', note=f'{len(firsts):,} first cases')

    turns = [c['Turnover_Turnover'] for c in cases
             if c['Turnover_Turnover'] and 0 <= c['Turnover_Turnover'] <= 240]
    _near('Median turnover', st.median(turns) if turns else None,
          C.BACKGROUND['median_turnover_min'], 15, unit='min')

    _near('Add-on rate', 100.0 * sum(1 for c in cases if c['Case_AddOnCode']) / len(cases),
          C.BACKGROUND['addon_rate'] * 100, 30, unit='%')
    _near('Cancellation rate',
          100.0 * sum(1 for c in allhist if c['__cancelled']) / len(allhist),
          C.BACKGROUND['cancellation_rate'] * 100, 35, unit='%')


def _st1(tables, ctx):
    s = C.STORYLINES['st1']
    anchor = ctx['anchor']
    br = tables['V4_BlockResultsView']

    # Trailing 8 weeks of the Thursday instances of the block.
    since = anchor - dt.timedelta(weeks=8)
    rows = [r for r in br
            if r['CaseBlock'] == s['block'] and r['LocationGroup'] == s['site']
            and r['BlockDate'] >= since and r['BlockDate'].weekday() == s['weekday']]
    prime = sum(r['Total_Prime_Time'] for r in rows)
    blk   = sum(r['blockTime'] for r in rows)
    _near(f'ST-1 {s["block"]} Thu block utilisation (trailing 8wk)',
          100.0 * prime / blk if blk else None,
          s['trailing_block_util_pct'], s['tolerance_pct'] * 100 / s['trailing_block_util_pct'],
          unit='%', note=f'{len({r["BlockDate"] for r in rows})} instances')

    # True utilisation: same rooms, same days, all cases including out-of-block.
    room_days = {(r['BlockDate'], r['ORLoc']) for r in rows}
    all_prime = sum(r['Total_Prime_Time'] for r in br
                    if (r['BlockDate'], r['ORLoc']) in room_days)
    _near('ST-1 true utilisation (incl. out-of-block)',
          100.0 * all_prime / blk if blk else None,
          s['trailing_true_util_pct'], s['tolerance_pct'] * 100 / s['trailing_true_util_pct'],
          unit='%')

    # Released instances.
    hist_inst = [b for b in ctx['block_instances']
                 if b['block'] == s['block'] and b['weekday'] == s['weekday']
                 and not b['is_future']]
    released = sum(1 for b in hist_inst if b['released'] > 0)
    _near('ST-1 instances with ReleasedTime > 0',
          100.0 * released / len(hist_inst) if hist_inst else None,
          s['release_instance_rate'] * 100, 45, unit='%')

    # Forward fill for the next four Thursday instances, as the radar computes it.
    fwd = {}
    for r in tables['V4_FORECAST_COMPILE']:
        if r['Caseblock'] != s['block'] or r['ORGRP2'] != s['site']:
            continue
        # The radar's default horizon; anything nearer is already mostly booked.
        if not (14 <= r['DaysAhead'] <= 35) or r['Date'].weekday() != s['weekday']:
            continue
        f = fwd.setdefault(r['Date'], {'dur': 0.0, 'blk': 0.0})
        f['dur'] += (r['SCHEDULED_INPATIENT_DURwTurn'] + r['SCHEDULED_OUTPATIENT_DURwTurn']
                     + r['FORECAST_INPATIENT_DURwTurn'] + r['FORECAST_OUTPATIENT_DURwTurn'])
        f['blk'] += r['BLOCKTIME']
    fills = [100.0 * v['dur'] / v['blk'] for _, v in sorted(fwd.items()) if v['blk']]
    lo, hi = s['forward_fill_pct_range']
    ok = PASS if fills and all(lo - 6 <= f <= hi + 6 for f in fills) else (
        WARN if fills else FAIL)
    _check('ST-1 forward fill, Thursdays 14-35d out',
           ', '.join(f'{f:.0f}' for f in fills) or None, f'{lo:g}–{hi:g}', ok, '%')

    # Spine's forward pipeline against its own trailing baseline. Measured on
    # the cases, because the forecast table discounts forward volume by lead
    # time and would understate a surge that is genuinely there.
    def _per_weekday(pred):
        rows = [c for c in ctx['cases'] if pred(c) and c['__weekday'] < 5 and not c['__cancelled']]
        days = len({c['Date_SchedDate'] for c in rows}) or 1
        return len(rows) / days

    fwd_rate  = _per_weekday(lambda c: c['__is_future'] and c['Case_SurgeonService'] == 'Spine')
    hist_rate = _per_weekday(lambda c: not c['__is_future'] and c['Case_SurgeonService'] == 'Spine')
    _near('ST-1 Spine forward pipeline vs baseline',
          100.0 * (fwd_rate / hist_rate - 1) if hist_rate else None,
          s['spine_forward_surge_pct'], 40, unit='%')

    # And the same surge as a user reads it. Every service's forward number sits
    # below budget, because a future week is only partly booked; what marks Spine
    # out is that it sits far less below budget than everything else.
    fc = tables['V4_FORECAST_COMPILE']

    def _vs_budget(pred):
        rows = [r for r in fc if r['DaysAhead'] > 0 and pred(r)]
        booked = sum(r['SCHEDULED_INPATIENT'] + r['SCHEDULED_OUTPATIENT']
                     + r['FORECAST_INPATIENT'] + r['FORECAST_OUTPATIENT'] for r in rows)
        budget = sum(r['BUDGET_INPATIENT'] + r['BUDGET_OUTPATIENT'] for r in rows)
        return (booked / budget) if budget else None

    spine = _vs_budget(lambda r: r['SurgeonService'] == 'Spine')
    rest  = _vs_budget(lambda r: r['SurgeonService'] != 'Spine')
    lift = 100.0 * (spine - rest) if (spine and rest) else None
    ok = PASS if (lift is not None and lift >= 10) else WARN
    _check('ST-1 Spine forecast-vs-budget, above other services',
           round(lift, 1) if lift else None, '>= 10', ok, 'pts',
           'what the Sched Forecast page shows')


def _st2(tables, ctx):
    s = C.STORYLINES['st2']
    occ = [r for r in tables['DS_Occupancy']
           if r['DEP_NAME'] == s['unit'] and r['Datehour'].hour == 7]
    wed = [r for r in occ if r['Datehour'].weekday() == s['weekday']]
    _near(f'ST-2 {s["unit"]} Wednesday 07:00 census',
          st.mean(r['Occupancy'] for r in wed) if wed else None,
          s['peak_census'], s['tolerance_pct'] * 100 / s['peak_census'],
          unit=f'of {dict((u, b) for u, _, b, _ in C.UNITS)[s["unit"]]} beds')

    # Share of that census that traces back to a scheduled OR admission.
    wed_dates = {r['Datehour'].date() for r in wed}
    or_ct, all_ct = 0, 0
    for e in ctx['encounters']:
        for d in wed_dates:
            t = dt.datetime.combine(d, dt.time(7, 0))
            if e['__unit'] == s['unit'] and e['__admit'] <= t < e['__discharge']:
                all_ct += 1
                if e['__source'] == 'OR':
                    or_ct += 1
    _near('ST-2 Wednesday census attributable to the OR',
          100.0 * or_ct / all_ct if all_ct else None,
          s['or_attributed_share_pct'], s['tolerance_pct'] * 100 / s['or_attributed_share_pct'],
          unit='%')

    # Crunch days per week across the med-surg units.
    beds = {u: b for u, _, b, _ in C.UNITS}
    crunch_days = set()
    weeks = set()
    for r in tables['DS_Occupancy']:
        if r['Datehour'].hour != 7:
            continue
        weeks.add(r['Datehour'].isocalendar()[:2])
        if r['Occupancy'] >= s['crunch_occupancy_pct'] / 100.0 * beds[r['DEP_NAME']]:
            crunch_days.add((r['Datehour'].date(), r['DEP_NAME']))
    per_week = len(crunch_days) / max(1, len(weeks))
    ok = PASS if per_week >= s['min_crunch_days_per_week'] else FAIL
    _check('ST-2 crunch unit-days per week', round(per_week, 2),
           f'>= {s["min_crunch_days_per_week"]}', ok)


def _st3(tables, ctx):
    s = C.STORYLINES['st3']
    cliff = int(s['cliff_time'][:2]) * 60 + int(s['cliff_time'][3:])
    staffed = {(site, dow): rooms for site, dow, _, _, rooms, _ in C.STAFFING_PLAN}
    shift_end = {(site, dow): int(e[:2]) * 60 + int(e[3:])
                 for site, dow, _, e, _, _ in C.STAFFING_PLAN}

    per_day = GOR_rooms_running(ctx['cases'], cliff, s['site'], s['cliff_weekdays'])
    mean_rooms = st.mean(per_day.values()) if per_day else None
    lo, hi = s['rooms_running_at_cliff']
    _band(f'ST-3 rooms running at {s["cliff_time"]} (Tue–Thu)', mean_rooms, lo, hi,
          note=f'{len(per_day)} days')

    # Overtime: room-minutes worked past the end of the staffed shift.
    ot, weeks = 0.0, set()
    for c in ctx['cases']:
        if c['__is_future'] or c['__cancelled'] or c['Loc_ORGrp2'] != s['site']:
            continue
        if c['__weekday'] > 4:
            continue
        weeks.add(c['Date_SchedDate'].isocalendar()[:2])
        end_of_shift = shift_end[(s['site'], c['__weekday'] + 1)]
        ot += max(0, c['__end_min'] - max(c['__start_min'], end_of_shift))
    _band('ST-3 overtime room-hours per week', ot / 60.0 / max(1, len(weeks)),
          *s['overtime_room_hours_per_week'])

    # Friday: peak concurrency and staffed hours nobody used.
    fri_peak = []
    fri_idle = []
    by_day = {}
    for c in ctx['cases']:
        if c['__is_future'] or c['__cancelled'] or c['Loc_ORGrp2'] != s['site'] or c['__weekday'] != 4:
            continue
        by_day.setdefault(c['Date_SchedDate'], []).append(c)
    for d, day_cases in by_day.items():
        spans = [(c['__start_min'], c['__end_min']) for c in day_cases]
        peak = 0
        used_room_minutes = 0.0
        for t in range(7 * 60, 16 * 60, 15):
            n = sum(1 for a, b in spans if a <= t < b)
            peak = max(peak, n)
        for a, b in spans:
            used_room_minutes += max(0, min(b, shift_end[(s['site'], 5)]) - max(a, 7 * 60))
        staffed_minutes = staffed[(s['site'], 5)] * (shift_end[(s['site'], 5)] - 7 * 60)
        fri_peak.append(peak)
        fri_idle.append((staffed_minutes - used_room_minutes) / 60.0)
    _near('ST-3 Friday peak rooms running', st.mean(fri_peak) if fri_peak else None,
          s['friday_peak_rooms'], s['tolerance_pct'])
    # The storyline is the visible flex-down gap, not a point figure, so this is
    # a floor: enough idle staffed time that a Friday reduction is obvious.
    idle = st.mean(fri_idle) if fri_idle else None
    floor = s['friday_idle_staffed_hours_min']
    ok = PASS if (idle is not None and round(idle, 1) >= floor) else FAIL
    _check('ST-3 Friday idle staffed room-hours', round(idle, 1) if idle else None,
           f'>= {floor:g}', ok, 'h',
           f'{staffed[(s["site"], 5)]} staffed rooms against a '
           f'{s["friday_peak_rooms"]}-room peak')


def GOR_rooms_running(cases, when_minutes, site, weekdays):
    per_day = {}
    for c in cases:
        if c['__is_future'] or c['__cancelled'] or c['Loc_ORGrp2'] != site:
            continue
        if c['__weekday'] not in weekdays:
            continue
        per_day.setdefault(c['Date_SchedDate'], 0)
        if c['__start_min'] <= when_minutes < c['__end_min']:
            per_day[c['Date_SchedDate']] += 1
    return per_day


def _st4(tables, ctx):
    s = C.STORYLINES['st4']
    cast = ctx['roster']['cast']
    firsts = [c for c in ctx['cases']
              if not c['__is_future'] and not c['__cancelled']
              and c['Turnover_Orderofcaseinroom'] == 1
              and c['Dur_Act_vs_SchedStart'] is not None]

    def mean_delay(pred):
        v = [c['Dur_Act_vs_SchedStart'] for c in firsts if pred(c)]
        return st.mean(v) if v else None, len(v)

    base, n_base = mean_delay(lambda c: not c['Case_AddOnCode']
                              and c['Case_SurgeonService'] != 'Spine' and c['__weekday'] != 0)
    for label, pred, target in (
        ('add-on',  lambda c: bool(c['Case_AddOnCode']),                s['addon_delay_minutes']),
        ('Spine',   lambda c: c['Case_SurgeonService'] == 'Spine',      s['spine_delay_minutes']),
        ('Monday',  lambda c: c['__weekday'] == 0,                       s['monday_delay_minutes']),
        ('outlier', lambda c: c['Case_Surgeon'] == cast['st4_fcot_offender'],
                                                                        s['outlier_extra_delay_minutes']),
    ):
        m, n = mean_delay(pred)
        lift = (m - base) if (m is not None and base is not None) else None
        ok = PASS if (lift is not None and lift >= target * 0.5) else FAIL
        _check(f'ST-4 first-case delay lift: {label}', round(lift, 1) if lift else None,
               f'>= {target * 0.5:g}', ok, 'min', f'n={n:,}')
    _check('ST-4 baseline first-case delay', round(base, 1) if base else None,
           '(reference)', PASS, 'min', f'n={n_base:,}')


def _st5(tables, ctx):
    s = C.STORYLINES['st5']
    cases = [c for c in ctx['cases'] if not c['__is_future'] and not c['__cancelled']
             and c['Turnover_Turnover']]
    by_room_day = {}
    for c in ctx['cases']:
        by_room_day.setdefault((c['Date_SchedDate'], c['Loc_ORLoc']), []).append(c)
    for lst in by_room_day.values():
        lst.sort(key=lambda c: c['Turnover_Orderofcaseinroom'])

    robotic_diff, baseline = [], []
    for lst in by_room_day.values():
        for i in range(1, len(lst)):
            cur, prev = lst[i], lst[i - 1]
            if cur['__is_future'] or cur['__cancelled'] or not cur['Turnover_Turnover']:
                continue
            if (prev['Case_SurgeonService'] == s['robotics_service']
                    and prev['Case_Surgeon'] != cur['Case_Surgeon']):
                robotic_diff.append(cur['Turnover_Turnover'])
            else:
                baseline.append(cur['Turnover_Turnover'])
    lift = (st.mean(robotic_diff) - st.mean(baseline)) if (robotic_diff and baseline) else None
    ok = PASS if (lift is not None and lift >= s['different_surgeon_extra_minutes'] * 0.5) else FAIL
    _check('ST-5 turnover lift: robotic case, different next surgeon',
           round(lift, 1) if lift else None,
           f">= {s['different_surgeon_extra_minutes'] * 0.5:g}", ok, 'min',
           f'n={len(robotic_diff):,}')

    room = [c['Turnover_Turnover'] for c in cases
            if c['Case_CaseBlock'] == s['robotics_room_block']]
    other = [c['Turnover_Turnover'] for c in cases
             if c['Case_CaseBlock'] != s['robotics_room_block']]
    lift2 = (st.mean(room) - st.mean(other)) if (room and other) else None
    ok = PASS if (lift2 is not None and lift2 >= s['robotics_room_extra_minutes'] * 0.4) else WARN
    _check(f'ST-5 turnover lift: {s["robotics_room_block"]}',
           round(lift2, 1) if lift2 else None,
           f">= {s['robotics_room_extra_minutes'] * 0.4:g}", ok, 'min')


def _st6(tables, ctx):
    """
    ST-6 is derived by the ISSCM engine, never seeded. What the seeder owes it is
    the headroom that makes the Thursday conflict and the Tuesday resolution
    findable: Tuesday must have staffing and bed room, Thursday must not.
    """
    s = C.STORYLINES['st6']
    site = C.STORYLINES['st3']['site']
    staffed = {dow: rooms for st_, dow, _, _, rooms, _ in C.STAFFING_PLAN if st_ == site}

    def peak_rooms(weekday):
        by_day = {}
        for c in ctx['cases']:
            if c['__is_future'] or c['__cancelled'] or c['Loc_ORGrp2'] != site:
                continue
            if c['__weekday'] != weekday:
                continue
            by_day.setdefault(c['Date_SchedDate'], []).append(c)
        peaks = []
        for day_cases in by_day.values():
            spans = [(c['__start_min'], c['__end_min']) for c in day_cases]
            peaks.append(max((sum(1 for a, b in spans if a <= t < b)
                              for t in range(7 * 60, 16 * 60, 15)), default=0))
        return st.mean(peaks) if peaks else None

    tue_headroom = round(staffed[2] - (peak_rooms(1) or 0), 1)
    thu_headroom = round(staffed[4] - (peak_rooms(3) or 0), 1)
    ok = PASS if tue_headroom >= s['tuesday_staffing_headroom_rooms_min'] else FAIL
    _check('ST-6 Tuesday OR staffing headroom', round(tue_headroom, 1),
           f'>= {s["tuesday_staffing_headroom_rooms_min"]}', ok, 'rooms')
    ok = PASS if thu_headroom <= s['thursday_staffing_headroom_rooms_max'] + 1 else FAIL
    _check('ST-6 Thursday OR staffing headroom', round(thu_headroom, 1),
           f'<= {s["thursday_staffing_headroom_rooms_max"] + 1}', ok, 'rooms',
           'must be tight, or the Thursday conflict never surfaces')

    beds = {u: b for u, _, b, _ in C.UNITS}
    unit = C.STORYLINES['st2']['unit']
    for label, wd in (('Tuesday', 1), ('Thursday', 3)):
        occ = [r['Occupancy'] for r in tables['DS_Occupancy']
               if r['DEP_NAME'] == unit and r['Datehour'].hour == 7
               and r['Datehour'].weekday() == wd]
        headroom = round(beds[unit] - (st.mean(occ) if occ else beds[unit]), 1)
        need = s['tuesday_unit_headroom_beds_min']
        ok = (PASS if headroom >= need else FAIL) if wd == 1 else PASS
        _check(f'ST-6 {label} {unit} bed headroom', round(headroom, 1),
               f'>= {need}' if wd == 1 else '(reference)', ok, 'beds')


# ── Entry point ──────────────────────────────────────────────────────────────

def run(tables, ctx):
    _results.clear()
    print('=' * 72)
    print('  Storyline reconciliation — DemoTenant.md section 10')
    print('=' * 72)

    for fn in (_background, _st1, _st2, _st3, _st4, _st5, _st6):
        try:
            fn(tables, ctx)
        except Exception as exc:                    # a broken check must not hide the rest
            _check(f'{fn.__name__} raised', str(exc), '-', FAIL)

    width = max(len(r[1]) for r in _results)
    for ok, label, actual, target, unit, note in _results:
        mark = {PASS: 'ok  ', WARN: 'warn', FAIL: 'FAIL'}[ok]
        line = f'  [{mark}] {label:<{width}}  {_fmt(actual):>10} {unit:<6} (target {target})'
        if note:
            line += f'  {note}'
        print(line)

    fails = sum(1 for r in _results if r[0] == FAIL)
    warns = sum(1 for r in _results if r[0] == WARN)
    print()
    print(f'  {len(_results) - fails - warns} passed, {warns} warnings, {fails} failed')
    if fails:
        print('  Tune the constants in demo_config.py / generate_or.py and reseed.')
        print('  Never edit a downstream output to make a check pass.')
    return fails

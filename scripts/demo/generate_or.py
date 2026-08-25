#!/usr/bin/env python3
"""
OR-side generation for the demo tenant: calendar, DS_CASES, DS_RR,
V4_BlockResultsView and V4_FORECAST_COMPILE.

Everything downstream is derived from the cases this module produces —
DS_RR is computed from case in/out times, and both V4_* OR objects are
aggregated from the same cases, exactly as the real views aggregate real ones.
That derivation is what makes the storyline reconciliation in DemoTenant.md
section 10 automatic rather than patched.

Not run directly; seed_demo_tenant.py calls generate_all().
"""

import datetime as dt
import math

import numpy as np

import demo_config as C

PRIME_GRACE_MIN = 0            # on-time means started at or before scheduled start
STD_TURNOVER_SCHED = 33        # minutes the scheduler assumes between cases
# How far past the end of the staffed shift a room may be booked, by weekday.
# ST-3's cliff is a Tue-Thu phenomenon, so that is where the late finishes live;
# Monday runs to the whistle and Friday is deliberately short.
WEEKDAY_LATE_FINISH = {0: -30, 1: 13, 2: 13, 3: 13, 4: -45}
OPEN_ROOM_AVAILABLE_MIN = 400  # a flex room is staffed for part of the prime window
ASC_TURNOVER_FACTOR = 0.52     # surgery-centre turnovers run about half a hospital OR's
ASC_SCHED_TURNOVER = 18        # and the scheduler books them that way


# ── Calendar ─────────────────────────────────────────────────────────────────

def _nth_weekday(year, month, weekday, n):
    d = dt.date(year, month, 1)
    d += dt.timedelta(days=(weekday - d.weekday()) % 7)
    return d + dt.timedelta(weeks=n - 1)


def _last_weekday(year, month, weekday):
    d = dt.date(year, month, 1) + dt.timedelta(days=31)
    d = d.replace(day=1) - dt.timedelta(days=1)
    while d.weekday() != weekday:
        d -= dt.timedelta(days=1)
    return d


def holidays_for(year):
    """US holidays that visibly suppress elective volume."""
    out = {
        dt.date(year, 1, 1):   "New Year's Day",
        dt.date(year, 7, 4):   'Independence Day',
        dt.date(year, 12, 24): 'Christmas Eve',
        dt.date(year, 12, 25): 'Christmas Day',
        dt.date(year, 12, 31): "New Year's Eve",
        _nth_weekday(year, 1, 0, 3):  'MLK Day',
        _last_weekday(year, 5, 0):    'Memorial Day',
        _nth_weekday(year, 9, 0, 1):  'Labor Day',
        _nth_weekday(year, 11, 3, 4): 'Thanksgiving',
    }
    out[_nth_weekday(year, 11, 3, 4) + dt.timedelta(days=1)] = 'Day after Thanksgiving'
    return out


def build_calendar(anchor, history_months=C.HISTORY_MONTHS, forward_weeks=C.FORWARD_WEEKS):
    """
    Every date in the generation window, tagged. History runs from the first of
    the month `history_months` back; the forward window runs `forward_weeks`
    past the anchor so the radar's 14-35 day band is always full.
    """
    y, m = anchor.year, anchor.month
    m -= history_months
    while m <= 0:
        m += 12
        y -= 1
    start = dt.date(y, m, 1)
    end   = anchor + dt.timedelta(weeks=forward_weeks)

    hols = {}
    for yy in range(start.year, end.year + 1):
        hols.update(holidays_for(yy))

    days = []
    d = start
    while d <= end:
        days.append({
            'date':       d,
            'weekday':    d.weekday(),
            'dow_long':   d.strftime('%A'),
            'is_weekend': d.weekday() >= 5,
            'holiday':    hols.get(d),
            'week_of_month': (d.day - 1) // 7 + 1,
            'is_future':  d > anchor,
            'days_ahead': (d - anchor).days,
        })
        d += dt.timedelta(days=1)
    return days


# ── Helpers ──────────────────────────────────────────────────────────────────

def _hm(s):
    h, m = s.split(':')
    return int(h) * 60 + int(m)


def _overlap(start_min, end_min, win_start, win_end):
    return max(0, min(end_min, win_end) - max(start_min, win_start))


def _weighted_choice(rng, items, weights):
    w = np.asarray(weights, dtype=float)
    w = w / w.sum()
    return items[int(rng.choice(len(items), p=w))]


# ── Weekday demand shaping (ST-2 and ST-3) ───────────────────────────────────
# Mon/Tue carry the inpatient-heavy elective load that stacks census onto
# Wednesday (ST-2); Tue-Thu run hot enough to still have rooms going at 15:30
# and Friday flexes down hard (ST-3).

# Thursday runs tight — that is what makes ST-6's Thursday reallocation conflict
# and the Tuesday one clear. Tuesday keeps the inpatient-heavy service mix that
# stacks ST-2's Wednesday census without also consuming Tuesday's room headroom.
WEEKDAY_FILL_FACTOR    = {0: 1.02, 1: 0.90, 2: 1.08, 3: 1.18, 4: 0.70}
WEEKDAY_OPEN_ROOM_FILL = {0: 0.74, 1: 0.56, 2: 0.76, 3: 0.86, 4: 0.24}
# Probability an unblocked room simply does not run that weekday.
WEEKDAY_DARK_PROB      = {0: 0.18, 1: 0.38, 2: 0.14, 3: 0.05, 4: 0.66}

# Mon/Tue skew toward the inpatient-heavy services — the ST-2 mechanism.
INPATIENT_HEAVY = {'Orthopedics': 2.4, 'Spine': 2.6, 'Colorectal': 1.5, 'Vascular': 1.4}

# ST-1's counterweight has to show up as cases, and a blocked room is already
# near its ceiling, so most of the surge lands in open time.
SPINE_OPEN_TIME_SURGE = 1.32

# Share of a blocked room's cases that belong to someone outside the block.
OUT_OF_BLOCK_SHARE = 0.02

# ST-1's light Thursday attracts more of it than a healthy block would: other
# services already quietly back-fill that room, which is the three-point gap
# between the block's utilisation and the room's true utilisation.
ST1_OUT_OF_BLOCK_SHARE = 0.06

# Extra weight Spine carries in open time on forward dates — the surge has to
# show up as cases, and Spine's own blocks are already near their ceiling.
SPINE_FORWARD_OPEN_WEIGHT = 0.062

# How hard the ST-1 controller pulls the block back onto its authored number.
# One instance either way moves an eight-hour block by twenty points, so a gentle
# gain leaves the trailing average wandering.
ST1_CONTROLLER_GAIN = 2.5

# Two ortho cases fill about 42% of an eight-hour block and three fill about
# 62%, so a single instance lands well off target either way. The forward
# instances are the ones the radar puts on screen three at a time, so bias them
# a little low: a block that reads light every week tells the story the block
# actually has.
ST1_FUTURE_BIAS = -0.045


def _service_weights(weekday, is_future=False, spine_surge=1.0):
    w = dict(C.SERVICE_VOLUME_WEIGHT)
    if weekday in (0, 1):
        for svc, mult in INPATIENT_HEAVY.items():
            w[svc] *= mult
    # ST-1 counterweight: the forward Spine pipeline is surging, which is what
    # gives the radar's reallocation ranking an obvious number one.
    if is_future:
        w['Spine'] = w['Spine'] * spine_surge * SPINE_OPEN_TIME_SURGE + SPINE_FORWARD_OPEN_WEIGHT
    return w


# ── DS_CASES ─────────────────────────────────────────────────────────────────

def generate_cases(calendar, roster, params, rng, anchor):
    """
    One row per case. Storyline bends (DemoTenant.md section 4) are applied here,
    at generation time — nothing downstream patches a number.
    """
    st1, st3, st4, st5 = (C.STORYLINES[k] for k in ('st1', 'st3', 'st4', 'st5'))
    cast = roster['cast']
    spine_surge = 1.0 + st1['spine_forward_surge_pct'] / 100.0
    # The controller steers the trailing window it can see, which lags the window
    # the demo shows by one instance; the offset absorbs that residual.
    st1_target = st1['trailing_block_util_pct'] / 100 + 0.035
    st1_state = {'hist': []}      # (booked minutes, allocated minutes) per instance

    # (room, weekday) -> block line
    block_by_slot = {}
    for name, site, room, dow, service in C.BLOCK_TEMPLATE:
        block_by_slot[(room, dow)] = {'block': name, 'site': site, 'service': service}
    panels = {b['block']: b['panel'] for b in roster['blocks']}

    surgeons_by_service = {}
    for s in roster['surgeons']:
        surgeons_by_service.setdefault(s['service'], []).append(s)

    dur_params  = params['case_duration_lognormal']
    turn_params = params['turnover_lognormal']
    fcd         = params['first_case_delay']
    asa_items   = list(params['asa_mix'].keys())
    asa_w       = list(params['asa_mix'].values())
    anes_items  = list(params['anesthesia_mix'].keys())
    anes_w      = list(params['anesthesia_mix'].values())

    cases = []
    block_instances = []     # one per (date, block, room) — allocation and release
    case_id = 100000

    for day in calendar:
        d, wd = day['date'], day['weekday']
        holiday_factor = C.HOLIDAY_VOLUME_FACTOR if day['holiday'] else 1.0

        for site, site_cfg in C.SITES.items():
            prime_start = _hm(site_cfg['prime_start'])
            prime_end   = _hm(site_cfg['prime_end'])
            block_start = _hm(site_cfg['block_start'])
            block_minutes = _hm(site_cfg['block_end']) - block_start

            for room in site_cfg['rooms']:
                slot = block_by_slot.get((room, wd)) if not day['is_weekend'] else None
                slot = slot if (slot and slot['site'] == site) else None

                # ── Weekend: main site only, occasional urgent/emergent case ──
                if day['is_weekend']:
                    if site != C.MAIN_SITE or rng.random() > 0.10:
                        continue
                    n_target_minutes = float(rng.uniform(90, 260))
                    block_name, block_service = None, None
                    day_start = _hm('08:00')
                # ── Blocked room ──────────────────────────────────────────────
                elif slot:
                    block_name    = slot['block']
                    block_service = slot['service']
                    util_target   = float(rng.normal(1.05, 0.09))

                    # ST-1: the Thursday Ortho A block is chronically light,
                    # while the same block on Monday is perfectly healthy.
                    if block_name == st1['block'] and site == st1['site']:
                        if wd == st1['weekday']:
                            # Steer on the trailing eight instances, because that
                            # is the window the demo actually puts on screen.
                            recent = st1_state['hist'][-8:]
                            alloc = sum(a for _, a in recent)
                            drift = ((sum(u for u, _ in recent) / alloc - st1_target)
                                     if alloc else 0.0)
                            util_target = max(0.15, st1_target - ST1_CONTROLLER_GAIN * drift
                                              + (ST1_FUTURE_BIAS if day['is_future'] else 0.0)
                                              + float(rng.normal(0, 0.02)))
                        else:
                            util_target = float(rng.normal(st1['healthy_day_util_pct'] / 100, 0.07))
                    else:
                        util_target *= WEEKDAY_FILL_FACTOR.get(wd, 1.0)

                    # ST-1 counterweight: Spine's forward pipeline is +38% on
                    # its trailing baseline, so its blocks fill and Ortho A's
                    # empty Thursday has an obvious taker.
                    if day['is_future'] and block_service == 'Spine':
                        util_target *= spine_surge

                    util_target = max(0.15, min(1.30, util_target)) * holiday_factor
                    n_target_minutes = block_minutes * util_target
                    day_start = block_start
                # ── Open (unblocked) room ─────────────────────────────────────
                else:
                    if rng.random() < WEEKDAY_DARK_PROB.get(wd, 0.4):
                        continue
                    block_name, block_service = None, None
                    fill = WEEKDAY_OPEN_ROOM_FILL.get(wd, 0.5) * float(rng.normal(1.0, 0.22))
                    n_target_minutes = block_minutes * max(0.1, fill) * holiday_factor
                    day_start = block_start

                if n_target_minutes < 25:
                    continue

                # ── Draw the day's cases for this room ───────────────────────
                svc_weights = _service_weights(wd, day['is_future'], spine_surge)
                # A day stops when the target is met OR when the next case would
                # push the room well past the end of its staffed shift. Without
                # the second rule, overtime exposure (ST-3) runs away.
                latest_finish = (_hm(site_cfg['block_end'])
                                 + WEEKDAY_LATE_FINISH.get(wd, 0))
                room_cases, used = [], 0.0
                guard = 0
                while used < n_target_minutes and guard < 14:
                    guard += 1
                    oob_share = (ST1_OUT_OF_BLOCK_SHARE
                                 if (block_name == st1['block'] and site == st1['site']
                                     and wd == st1['weekday'])
                                 else OUT_OF_BLOCK_SHARE)
                    out_of_block = bool(block_service and rng.random() < oob_share)
                    if block_service and not out_of_block:
                        service = block_service
                        panel = panels.get(block_name) or []
                        pool = [s for s in surgeons_by_service[service] if s['name'] in panel] \
                            or surgeons_by_service[service]
                    else:
                        service = _weighted_choice(rng, list(svc_weights.keys()),
                                                   list(svc_weights.values()))
                        pool = surgeons_by_service[service]

                    surgeon = _weighted_choice(rng, [s['name'] for s in pool],
                                               [s['service_share'] for s in pool])

                    turn_assumed = (ASC_SCHED_TURNOVER if not site_cfg['inpatient']
                                    else STD_TURNOVER_SCHED)
                    remaining = latest_finish - (day_start + used
                                                 + turn_assumed * len(room_cases))
                    if room_cases and remaining < 30:
                        break

                    # A scheduler fills the tail of a day with a case that fits,
                    # rather than abandoning the room because the first case they
                    # picked up was too long. Without this the greedy draw leaves
                    # an hour on the table in most rooms and utilisation collapses.
                    p = dur_params.get(service, params['case_duration_pooled'])
                    sched_dur = None
                    for _ in range(4):
                        draw = float(np.exp(rng.normal(p['mu'], p['sigma'])))
                        draw = round(max(20.0, min(480.0, draw)) / 5) * 5
                        if not room_cases or draw <= remaining:
                            sched_dur = draw
                            break
                    if sched_dur is None:
                        sched_dur = max(20.0, round(remaining / 5) * 5)

                    # Stop at whichever of "add it" / "leave it" lands closer to
                    # the day's target. A blanket overshoot tolerance let a light
                    # block quietly fill up, which is precisely what ST-1 must not
                    # do.
                    if room_cases and abs(used + sched_dur - n_target_minutes) > abs(used - n_target_minutes):
                        break

                    room_cases.append({'service': service, 'surgeon': surgeon,
                                       'sched_dur': sched_dur,
                                       'out_of_block': out_of_block})
                    used += sched_dur

                is_st1_slot = bool(slot and block_name == st1['block']
                                   and site == st1['site'] and wd == st1['weekday'])
                if not room_cases:
                    if is_st1_slot:
                        st1_state['hist'].append((0.0, block_minutes))
                    continue

                # ── Lay the day out: scheduled grid, then actual clock ───────
                sched_cursor = day_start
                sched_turnover = (ASC_SCHED_TURNOVER if not site_cfg['inpatient']
                                  else STD_TURNOVER_SCHED)
                for i, rc in enumerate(room_cases):
                    rc['sched_start'] = sched_cursor
                    sched_cursor += rc['sched_dur'] + sched_turnover

                n_room = len(room_cases)
                actual_cursor = None
                inst_prime = 0.0
                for i, rc in enumerate(room_cases):
                    service, surgeon = rc['service'], rc['surgeon']
                    is_first = (i == 0)

                    # Add-on rate: elevated for the first case of an open room,
                    # which is where late bookings actually land.
                    addon_p = params['addon_rate'] * (1.9 if (is_first and not block_name) else 0.85)
                    is_addon = bool(rng.random() < min(0.6, addon_p))

                    # ── ST-4: the teachable FCOT drivers ─────────────────────
                    if is_first:
                        delay = float(rng.normal(fcd['mean'], fcd['sigma']))
                        if is_addon:
                            delay += st4['addon_delay_minutes'] * float(rng.uniform(0.6, 1.4))
                        if service == 'Spine':
                            delay += st4['spine_delay_minutes'] * float(rng.uniform(0.5, 1.5))
                        if wd == 0:
                            delay += st4['monday_delay_minutes'] * float(rng.uniform(0.4, 1.6))
                        if surgeon == cast['st4_fcot_offender']:
                            delay += st4['outlier_extra_delay_minutes'] * float(rng.uniform(0.5, 1.5))
                        actual_start = rc['sched_start'] + delay
                        turnover = None
                    else:
                        prev = room_cases[i - 1]
                        t = float(np.exp(rng.normal(turn_params['mu'], turn_params['sigma'])))
                        if not site_cfg['inpatient']:
                            t *= ASC_TURNOVER_FACTOR
                        # ── ST-5: the robot room turnover story ──────────────
                        different_surgeon = prev['surgeon'] != surgeon
                        if prev['service'] == st5['robotics_service'] and different_surgeon:
                            t += st5['different_surgeon_extra_minutes'] * float(rng.uniform(0.6, 1.4))
                        if block_name == st5['robotics_room_block']:
                            t += st5['robotics_room_extra_minutes'] * float(rng.uniform(0.5, 1.5))
                        t = max(8.0, min(240.0, t))
                        turnover = round(t)
                        actual_start = actual_cursor + t

                    actual_dur = rc['sched_dur'] * float(np.exp(rng.normal(0.0, 0.15)))
                    actual_dur = max(12.0, round(actual_dur))
                    actual_end = actual_start + actual_dur
                    actual_cursor = actual_end

                    cancelled = (not day['is_future']) and rng.random() < params['cancellation_rate']

                    case_type = 'Elective'
                    if day['is_weekend']:
                        case_type = 'Emergent' if rng.random() < 0.45 else 'Urgent'
                    elif is_addon and rng.random() < 0.35:
                        case_type = 'Urgent'

                    or_in  = (dt.datetime.combine(d, dt.time())
                              + dt.timedelta(minutes=round(actual_start)))
                    or_out = (dt.datetime.combine(d, dt.time())
                              + dt.timedelta(minutes=round(actual_end)))

                    prime = _overlap(actual_start, actual_end, prime_start, prime_end)
                    if not cancelled and not rc['out_of_block']:
                        inst_prime += prime
                    inpatient_intent = rng.random() < (
                        C.SERVICE_INPATIENT_RATE[service] if site_cfg['inpatient'] else 0.0
                    )

                    case_id += 1
                    cases.append({
                        '_ID_CaseID':                    case_id,
                        'Date_SchedDate':                d,
                        'Loc_ORGrp2':                    site,
                        'Loc_ORLoc':                     room,
                        'Case_CaseBlock':                (block_name if (block_name and not rc['out_of_block'])
                                                          else 'Open'),
                        'Case_Surgeon':                  surgeon,
                        'Case_SurgeonService':           service,
                        'Case_CaseType':                 case_type,
                        'Case_AddOnCode':                C.ADDON_CODE_YES if is_addon else None,
                        'Case_ASACode':                  _weighted_choice(rng, asa_items, asa_w),
                        'Case_CanCode':                  (_weighted_choice(
                            rng, C.CANCEL_CODES, [0.4, 0.3, 0.2, 0.1]) if cancelled else None),
                        'Case_DaysScheduledAhead':       int(max(0, rng.normal(
                            3 if is_addon else 21, 4 if is_addon else 12))),
                        'Anes_Anestype':                 _weighted_choice(rng, anes_items, anes_w),
                        'Sched_SchedDur':                int(rc['sched_dur']),
                        'Dur_ORIn_OROut':                None if day['is_future'] else int(actual_dur),
                        'Dur_Act_vs_SchedDur':           None if day['is_future'] else int(actual_dur - rc['sched_dur']),
                        'Dur_Act_vs_SchedStart':         None if day['is_future'] else int(round(actual_start - rc['sched_start'])),
                        'Time_ORin':                     None if day['is_future'] else or_in,
                        'Time_OROut':                    None if day['is_future'] else or_out,
                        'Turnover_Turnover':             None if day['is_future'] else turnover,
                        'Turnover_Orderofcaseinroom':    i + 1,
                        'Turnover_Maxnumofcasesinroom':  n_room,
                        'Turnover_NextCaseSameSurgeon':  None,   # filled below
                        'DD_DOW_Long':                   day['dow_long'],
                        'DD_Holiday':                    1 if day['holiday'] else 0,
                        'DD_WeekOfMonth':                day['week_of_month'],
                        'DD_Month_Int':                  d.month,
                        'DD_Year_Month':                 f'{d.year}-{d.month:02d}',
                        'CaseLogStatus':                 'Scheduled' if day['is_future'] else C.CASE_LOG_STATUS,
                        # Internal, dropped before load — downstream stages use these.
                        '__prime_min':      prime,
                        '__nonprime_min':   (actual_end - actual_start) - prime,
                        '__start_min':      actual_start,
                        '__end_min':        actual_end,
                        '__or_in':          or_in,
                        '__or_out':         or_out,
                        '__is_future':      day['is_future'],
                        '__inpatient':      inpatient_intent,
                        '__cancelled':      cancelled,
                        '__weekday':        wd,
                        '__site_inpatient': site_cfg['inpatient'],
                    })

                if is_st1_slot:
                    st1_state['hist'].append((inst_prime, block_minutes))

                # Next-case-same-surgeon, needed by the turnover model downstream.
                for i in range(len(room_cases)):
                    idx = len(cases) - len(room_cases) + i
                    nxt = idx + 1
                    if i + 1 < len(room_cases):
                        cases[idx]['Turnover_NextCaseSameSurgeon'] = (
                            'Y' if cases[nxt]['Case_Surgeon'] == cases[idx]['Case_Surgeon'] else 'N'
                        )

                # ── Allocation rows ──────────────────────────────────────────
                # A blocked room commits its block allocation. An open room that
                # ran commits its available prime time. Both are denominators the
                # app divides by, so both have to exist.
                if not slot and not day['is_weekend']:
                    block_instances.append({
                        'date': d, 'block': 'Open', 'site': site, 'room': room,
                        'service': None, 'block_minutes': OPEN_ROOM_AVAILABLE_MIN,
                        'released': 0, 'weekday': wd,
                        'week_of_month': day['week_of_month'],
                        'is_future': day['is_future'], 'days_ahead': day['days_ahead'],
                        'dow_long': day['dow_long'],
                    })

                if slot:
                    released = 0
                    if not day['is_future']:
                        rate = (st1['release_instance_rate']
                                if (block_name == st1['block'] and wd == st1['weekday'])
                                else 0.06)
                        if rng.random() < rate:
                            released = int(round(float(rng.uniform(0.25, 0.6)) * block_minutes / 15) * 15)
                    block_instances.append({
                        'date': d, 'block': block_name, 'site': site, 'room': room,
                        'service': block_service, 'block_minutes': block_minutes,
                        'released': released, 'weekday': wd,
                        'week_of_month': day['week_of_month'],
                        'is_future': day['is_future'], 'days_ahead': day['days_ahead'],
                        'dow_long': day['dow_long'],
                    })

    # Block instances that drew no cases at all still consume allocation.
    seen = {(c['Date_SchedDate'], c['Case_CaseBlock'], c['Loc_ORLoc']) for c in cases}
    for day in calendar:
        if day['is_weekend']:
            continue
        for name, site, room, dow, service in C.BLOCK_TEMPLATE:
            if dow != day['weekday']:
                continue
            if (day['date'], name, room) in seen:
                continue
            if any(b['date'] == day['date'] and b['block'] == name and b['room'] == room
                   for b in block_instances):
                continue
            block_instances.append({
                'date': day['date'], 'block': name, 'site': site, 'room': room,
                'service': service,
                'block_minutes': _hm(C.SITES[site]['block_end']) - _hm(C.SITES[site]['block_start']),
                'released': 0, 'weekday': dow, 'week_of_month': day['week_of_month'],
                'is_future': day['is_future'], 'days_ahead': day['days_ahead'],
                'dow_long': day['dow_long'],
            })

    return cases, block_instances


# ── DS_RR — derived from the cases, never generated independently ────────────
# ST-3 reconciliation depends on this: the concurrency DS_RR reports at 15:30
# must be exactly what the DS_CASES in/out times imply, room for room.

RR_SLOT_MINUTES = 15
RR_START = _hm('05:00')
RR_END   = _hm('21:00')


def generate_rr(cases):
    slots = list(range(RR_START, RR_END, RR_SLOT_MINUTES))
    by_day_site = {}
    for c in cases:
        if c['__is_future'] or c['__cancelled']:
            continue
        by_day_site.setdefault((c['Date_SchedDate'], c['Loc_ORGrp2']), []).append(c)

    rows = []
    for (d, site), day_cases in sorted(by_day_site.items(), key=lambda kv: (kv[0][0], kv[0][1])):
        spans = [(c['__start_min'], c['__end_min']) for c in day_cases]
        for slot in slots:
            slot_end = slot + RR_SLOT_MINUTES
            occupied = sum(1 for s, e in spans if s < slot_end and e > slot)
            rows.append({
                'rrDate':       d,
                'ORGroup':      site,
                'rrtimeslot':   f'{slot // 60:02d}:{slot % 60:02d}',
                'TotalOccupied': occupied,
            })
    return rows


def rooms_running_at(cases, when_minutes, site, weekdays):
    """Average concurrent rooms at a clock time, for the ST-3 checks."""
    per_day = {}
    for c in cases:
        if c['__is_future'] or c['__cancelled'] or c['Loc_ORGrp2'] != site:
            continue
        if c['__weekday'] not in weekdays:
            continue
        if c['__start_min'] <= when_minutes < c['__end_min']:
            per_day[c['Date_SchedDate']] = per_day.get(c['Date_SchedDate'], 0) + 1
        else:
            per_day.setdefault(c['Date_SchedDate'], 0)
    return per_day


# ── V4_BlockResultsView ──────────────────────────────────────────────────────
# Grain: one row per case, plus one allocation-only row per block instance that
# drew no cases. blockTime and ReleasedTime are carried on the first case of an
# instance and zero elsewhere, so SUM(Total_Prime_Time) / SUM(blockTime) — the
# expression every page uses — is the utilisation and not a multiple of it.

def generate_block_results(cases, block_instances):
    alloc_seen = set()
    rows = []

    ordered = sorted(cases, key=lambda c: (c['Date_SchedDate'], c['Loc_ORLoc'],
                                           c['Turnover_Orderofcaseinroom']))
    release_by_instance = {
        (b['date'], b['block'], b['room']): b for b in block_instances
    }

    for c in ordered:
        if c['__is_future'] or c['__cancelled']:
            continue
        block = c['Case_CaseBlock']
        key = (c['Date_SchedDate'], block, c['Loc_ORLoc'])
        inst = release_by_instance.get(key)
        first_of_instance = inst is not None and key not in alloc_seen
        if first_of_instance:
            alloc_seen.add(key)

        in_block = block != 'Open'
        rows.append({
            'BlockDate':            c['Date_SchedDate'],
            'CaseBlock':            block,
            'CaseID':               str(c['_ID_CaseID']),
            'LocationGroup':        c['Loc_ORGrp2'],
            'ORLoc':                c['Loc_ORLoc'],
            'OrGrp2':               c['Loc_ORGrp2'],
            'Group_Service':        c['Case_SurgeonService'],
            'Surgeonservice':       c['Case_SurgeonService'],
            'Total_Prime_Time':     int(c['__prime_min']),
            'Total_Non_Prime_time': int(c['__nonprime_min']),
            'totalTime':            int(c['__prime_min'] + c['__nonprime_min']),
            'InBlock':              int(c['__prime_min']) if in_block else 0,
            'OutofBlock':           0 if in_block else int(c['__prime_min']),
            'blockTime':            inst['block_minutes'] if first_of_instance else 0,
            'ReleasedTime':         inst['released'] if first_of_instance else 0,
            'DD_WeekOfMonth':       ((c['Date_SchedDate'].day - 1) // 7) + 1,
        })

    # Allocation the schedule gave away that no case ever used.
    for b in block_instances:
        if b['is_future']:
            continue
        key = (b['date'], b['block'], b['room'])
        if key in alloc_seen:
            continue
        rows.append({
            'BlockDate':            b['date'],
            'CaseBlock':            b['block'],
            'CaseID':               None,
            'LocationGroup':        b['site'],
            'ORLoc':                b['room'],
            'OrGrp2':               b['site'],
            'Group_Service':        b['service'],
            'Surgeonservice':       b['service'],
            'Total_Prime_Time':     0,
            'Total_Non_Prime_time': 0,
            'totalTime':            0,
            'InBlock':              0,
            'OutofBlock':           0,
            'blockTime':            b['block_minutes'],
            'ReleasedTime':         b['released'],
            'DD_WeekOfMonth':       b['week_of_month'],
        })
    return rows


# ── V4_FORECAST_COMPILE ──────────────────────────────────────────────────────
# Grain: Date x ORGRP2 x Caseblock x SurgeonService. BLOCKTIME sits on the
# block's own service row and is zero on any other service sharing the room, so
# the radar's SUM(BLOCKTIME) is the allocation and not a multiple of it.
#
# Forward rows model a partly-booked schedule: SCHEDULED_* is what is on the
# books today, FORECAST_* is the additional volume the model expects to arrive
# before the date. Together they are the radar's "% filled".

def _booked_fraction(days_ahead):
    """
    Share of a block instance's eventual volume already on the books, by lead
    time. Decays toward a floor rather than linearly: a block five weeks out is
    roughly 40% booked, one two weeks out roughly 60%, and the day itself full.
    """
    return float(0.28 + 0.72 * math.exp(-0.055 * max(0, days_ahead)))


FORECAST_CAPTURE = 0.15   # share of the not-yet-booked remainder the model claims

# A service whose pipeline is surging books further ahead than everyone else, so
# at any given lead time more of its block is already on the books. Without this
# the ST-1 counterweight is invisible on Briefs: Spine's block reads like every
# other partly-booked block, and "bursting and still booking" never surfaces.
SURGING_BOOKING_LEAD = 0.28


def generate_forecast_compile(cases, block_instances, calendar, rng):
    inst_by_key = {(b['date'], b['block'], b['room']): b for b in block_instances}
    day_meta = {d['date']: d for d in calendar}
    # ST-7: how far along each block's forward book is at a given lead time.
    # Applied only to future rows, so nothing measured on history moves.
    pace = C.STORYLINES['st7']['booking_pace']

    # Aggregate the generated cases to the forecast grain.
    agg = {}
    for c in cases:
        if c['__cancelled']:
            continue
        key = (c['Date_SchedDate'], c['Loc_ORGrp2'], c['Case_CaseBlock'],
               c['Case_SurgeonService'])
        a = agg.setdefault(key, {'ip': 0, 'op': 0, 'ip_min': 0.0, 'op_min': 0.0,
                                 'room': c['Loc_ORLoc']})
        dur = (c['Sched_SchedDur'] if c['__is_future']
               else (c['Dur_ORIn_OROut'] or c['Sched_SchedDur']))
        durwturn = dur + STD_TURNOVER_SCHED
        if c['__inpatient']:
            a['ip'] += 1
            a['ip_min'] += durwturn
        else:
            a['op'] += 1
            a['op_min'] += durwturn

    # Trailing per-weekday baseline, which is what a budget actually is.
    hist_totals = {}
    for (d, site, block, service), a in agg.items():
        if day_meta[d]['is_future']:
            continue
        k = (site, block, service, d.weekday())
        h = hist_totals.setdefault(k, {'ip': 0.0, 'op': 0.0, 'days': set()})
        h['ip'] += a['ip']
        h['op'] += a['op']
        h['days'].add(d)

    def _budget(site, block, service, weekday, fallback_ip, fallback_op):
        h = hist_totals.get((site, block, service, weekday))
        if not h or not h['days']:
            return fallback_ip, fallback_op
        n = len(h['days'])
        return h['ip'] / n, h['op'] / n

    rows = []
    for (d, site, block, service), a in sorted(
            agg.items(), key=lambda kv: (kv[0][0], kv[0][1], kv[0][2], kv[0][3])):
        meta = day_meta[d]
        inst = inst_by_key.get((d, block, a['room']))
        # BLOCKTIME belongs to the block's own service only.
        blocktime = inst['block_minutes'] if (inst and inst['service'] == service) else 0

        bud_ip, bud_op = _budget(site, block, service, d.weekday(), a['ip'], a['op'])
        budget_ip = round(bud_ip * float(rng.uniform(0.94, 1.08)), 2)
        budget_op = round(bud_op * float(rng.uniform(0.94, 1.08)), 2)

        if meta['is_future']:
            frac = _booked_fraction(meta['days_ahead']) * pace.get(block, 1.0)
            if service == 'Spine':
                frac = min(1.0, frac + SURGING_BOOKING_LEAD)
            frac = max(0.05, min(1.0, frac))
            sched_ip,  sched_op  = a['ip'] * frac,     a['op'] * frac
            sched_ipm, sched_opm = a['ip_min'] * frac, a['op_min'] * frac
            rest = (1.0 - frac) * FORECAST_CAPTURE
            fc_ip,  fc_op  = a['ip'] * rest,     a['op'] * rest
            fc_ipm, fc_opm = a['ip_min'] * rest, a['op_min'] * rest
            act_ip = act_op = 0
        else:
            sched_ip,  sched_op  = a['ip'],     a['op']
            sched_ipm, sched_opm = a['ip_min'], a['op_min']
            fc_ip = fc_op = fc_ipm = fc_opm = 0.0
            act_ip, act_op = a['ip'], a['op']

        rows.append({
            'Date':                         d,
            'DOW_LONG':                     meta['dow_long'],
            'ORGRP2':                       site,
            'Caseblock':                    block,
            'SurgeonService':               service,
            'DaysAhead':                    meta['days_ahead'],
            'SCHEDULED_INPATIENT':          round(sched_ip, 2),
            'SCHEDULED_OUTPATIENT':         round(sched_op, 2),
            'SCHEDULED_INPATIENT_DURwTurn': round(sched_ipm, 1),
            'SCHEDULED_OUTPATIENT_DURwTurn': round(sched_opm, 1),
            'FORECAST_INPATIENT':           round(fc_ip, 2),
            'FORECAST_OUTPATIENT':          round(fc_op, 2),
            'FORECAST_INPATIENT_DURwTurn':  round(fc_ipm, 1),
            'FORECAST_OUTPATIENT_DURwTurn': round(fc_opm, 1),
            'ACTUAL_INPATIENT':             act_ip,
            'ACTUAL_OUTPATIENT':            act_op,
            # The Cases-vs-Budget page sums un-suffixed ACTUAL and BUDGET
            # alongside the inpatient/outpatient split, so the totals have to
            # exist as their own columns rather than being derived in the query.
            'ACTUAL':                       act_ip + act_op,
            # Budget is the trailing baseline, so a surging service reads as over
            # budget instead of quietly moving its own target. The total is the
            # sum of the two parts, not its own draw — the page shows all three
            # and they have to add up.
            'BUDGET_INPATIENT':             budget_ip,
            'BUDGET_OUTPATIENT':            budget_op,
            'BUDGET':                       round(budget_ip + budget_op, 2),
            'BLOCKTIME':                    blocktime,
        })

    # Future block instances with nothing booked at all still need a row, or the
    # radar cannot see the empty allocation it is supposed to flag.
    have = {(r['Date'], r['ORGRP2'], r['Caseblock'], r['SurgeonService']) for r in rows}
    for b in block_instances:
        if not b['is_future'] or b['block'] == 'Open':
            continue
        key = (b['date'], b['site'], b['block'], b['service'])
        if key in have:
            continue
        meta = day_meta[b['date']]
        rows.append({
            'Date': b['date'], 'DOW_LONG': meta['dow_long'], 'ORGRP2': b['site'],
            'Caseblock': b['block'], 'SurgeonService': b['service'],
            'DaysAhead': meta['days_ahead'],
            'SCHEDULED_INPATIENT': 0, 'SCHEDULED_OUTPATIENT': 0,
            'SCHEDULED_INPATIENT_DURwTurn': 0, 'SCHEDULED_OUTPATIENT_DURwTurn': 0,
            'FORECAST_INPATIENT': 0, 'FORECAST_OUTPATIENT': 0,
            'FORECAST_INPATIENT_DURwTurn': 0, 'FORECAST_OUTPATIENT_DURwTurn': 0,
            'ACTUAL_INPATIENT': 0, 'ACTUAL_OUTPATIENT': 0, 'ACTUAL': 0,
            'BUDGET_INPATIENT': 0, 'BUDGET_OUTPATIENT': 0, 'BUDGET': 0,
            'BLOCKTIME': b['block_minutes'],
        })
    return rows

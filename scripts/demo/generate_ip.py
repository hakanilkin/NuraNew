#!/usr/bin/env python3
"""
Inpatient-side generation for the demo tenant: DS_Encounters, DS_Bedplacement,
DS_Occupancy and V4_Inpatient_Forecast_Compile.

The case -> admission -> unit chain is generated once and everything else reads
it, which is what makes ST-2 reconcile: the OR-attributed share of Wednesday's
5 Central census is a fact about the seeded admissions, not a number written
into a summary table.

ED and medical admissions are produced by a controller that fills whatever the
OR did not, up to an authored occupancy target per unit and weekday. That is how
the Wednesday peak and the Thursday/Friday trough are engineered by construction.
"""

import datetime as dt

import numpy as np

import demo_config as C

# ── Occupancy targets (share of staffed beds at the 07:00 census) ────────────
# ST-2 lives here: 5 Central peaks on Wednesday and 4 East is close behind, so a
# typical week has two crunch days; Thursday and Friday are deliberately light
# so a smoothing scenario has somewhere to move volume to.

OCCUPANCY_TARGET = {
    #             Mon   Tue   Wed   Thu   Fri   Sat   Sun
    '5 Central': [0.79, 0.77, 0.94, 0.87, 0.80, 0.74, 0.72],
    '4 East':    [0.80, 0.84, 0.92, 0.85, 0.79, 0.73, 0.71],
    '3 West':    [0.82, 0.84, 0.88, 0.85, 0.81, 0.77, 0.75],
    'ICU':       [0.78, 0.80, 0.83, 0.81, 0.79, 0.76, 0.75],
    'Stepdown':  [0.76, 0.79, 0.85, 0.82, 0.78, 0.74, 0.72],
}

CRUNCH_OCCUPANCY = C.STORYLINES['st2']['crunch_occupancy_pct'] / 100.0

# Medical/ED length of stay when the admission did not come from an OR case.
ED_LOS = {'median': 3.6, 'sigma': 0.80, 'gmlos': 4.0}

# Medical admissions are not one undifferentiated bucket — the LOS and discharge
# pages break down by service line, and a single "Medical" value would make the
# whole inpatient side read as generated.
MEDICAL_SERVICE_LINES = [
    ('Hospitalist',       0.26),
    ('Cardiology',        0.19),
    ('Pulmonary',         0.14),
    ('Gastroenterology',  0.11),
    ('Nephrology',        0.09),
    ('Neurology',         0.09),
    ('Infectious Disease', 0.07),
    ('Endocrinology',     0.05),
]

MDC_BY_SERVICE = {
    'Orthopedics':      ('08', 'Musculoskeletal System & Connective Tissue'),
    'Spine':            ('08', 'Musculoskeletal System & Connective Tissue'),
    'General Surgery':  ('06', 'Digestive System'),
    'Urology':          ('11', 'Kidney & Urinary Tract'),
    'GYN':              ('13', 'Female Reproductive System'),
    'ENT':              ('03', 'Ear, Nose, Mouth & Throat'),
    'Plastics':         ('09', 'Skin, Subcutaneous Tissue & Breast'),
    'Vascular':         ('05', 'Circulatory System'),
    'Colorectal':       ('06', 'Digestive System'),
    'Robotics-General': ('06', 'Digestive System'),
    'Hospitalist':        ('04', 'Respiratory System'),
    'Cardiology':         ('05', 'Circulatory System'),
    'Pulmonary':          ('04', 'Respiratory System'),
    'Gastroenterology':   ('06', 'Digestive System'),
    'Nephrology':         ('11', 'Kidney & Urinary Tract'),
    'Neurology':          ('01', 'Nervous System'),
    'Infectious Disease': ('18', 'Infectious & Parasitic Diseases'),
    'Endocrinology':      ('10', 'Endocrine, Nutritional & Metabolic'),
    'Medical':            ('04', 'Respiratory System'),
}

PACU_MINUTES = 105          # OR out -> arrives on the unit
DO_TO_DC_MEDIAN = 108       # discharge order -> patient actually leaves


def _medical_service(rng):
    names = [n for n, _ in MEDICAL_SERVICE_LINES]
    w = np.asarray([p for _, p in MEDICAL_SERVICE_LINES], dtype=float)
    return names[int(rng.choice(len(names), p=w / w.sum()))]


def _sample_hour(rng, shape):
    hours = sorted(int(h) for h in shape)
    w = np.asarray([shape[str(h)] for h in hours], dtype=float)
    w = w / w.sum()
    return int(rng.choice(hours, p=w))


def _pick_unit(rng, service):
    shares = C.SERVICE_UNIT_MAP[service]
    units = list(shares.keys())
    w = np.asarray([shares[u] for u in units], dtype=float)
    return units[int(rng.choice(len(units), p=w / w.sum()))]


def _lognormal_days(rng, spec):
    mu = float(np.log(spec['median']))
    v = float(np.exp(rng.normal(mu, spec['sigma'])))
    return max(0.5, min(45.0, v))


def _disposition(rng):
    names = [d[0] for d in C.DISPOSITIONS]
    w = np.asarray([d[1] for d in C.DISPOSITIONS], dtype=float)
    return names[int(rng.choice(len(names), p=w / w.sum()))]


def _financial_class(rng, params):
    mix = params['financial_class_mix']
    names = list(mix.keys())
    w = np.asarray([mix[n] for n in names], dtype=float)
    return names[int(rng.choice(len(names), p=w / w.sum()))]


def _minute(t):
    """Whole-minute timestamps; sub-second precision is a generated-data tell."""
    return t.replace(second=0, microsecond=0)


def _make_encounter(rng, params, csn, service, unit, unit_meta, admit_dt, source,
                    surgeon=None, case_id=None):
    admit_dt = _minute(admit_dt)
    los_spec = params['los_lognormal'].get(service, ED_LOS) if source == 'OR' else ED_LOS
    los_days = _lognormal_days(rng, los_spec)
    gmlos = float(los_spec['gmlos']) * float(rng.uniform(0.92, 1.08))

    disch_day = (admit_dt + dt.timedelta(days=los_days)).date()
    disch_hour = _sample_hour(rng, params['discharge_hour_shape'])
    disch_dt = dt.datetime.combine(disch_day, dt.time(disch_hour, int(rng.integers(0, 60))))
    if disch_dt <= admit_dt:
        disch_dt = admit_dt + dt.timedelta(hours=18)

    do_to_dc = max(15.0, float(rng.normal(DO_TO_DC_MEDIAN, 55)))
    order_dt = disch_dt - dt.timedelta(minutes=do_to_dc)

    mdc_code, mdc_name = MDC_BY_SERVICE.get(service, MDC_BY_SERVICE['Medical'])
    dispo = _disposition(rng)

    tdc_complete = rng.random() < 0.71
    return {
        'EPICCSN':                 str(csn),
        'BEDDED':                  'Y',
        'PATIENT_IN_HOSPITAL_YN':  'N',
        'TIME_HOSPADMISSION':      admit_dt,
        'TIME_HOSPDISCHARGE':      _minute(disch_dt),
        'TIME_HOSPDISCHARGEENTRY': _minute(disch_dt + dt.timedelta(minutes=float(rng.uniform(5, 90)))),
        'ACCOUNT_IPLOS':           round(los_days, 2),
        'DRG_FINALDRG':            f'{int(rng.integers(1, 999)):03d}',
        'DRG_FINALDRGGMLOS':       round(gmlos, 2),
        'DRG_FINALDRGWEIGHT':      round(float(rng.uniform(0.6, 3.4)), 4),
        'DRG_FINALDRGMDC':         f'MDC {mdc_code} {mdc_name}',
        'ENC_ADMISSIONTYPE':       'Elective' if source == 'OR' else 'Emergency',
        'ENC_PATCLASSBASE':        'Inpatient' if los_days >= 1.5 else 'Observation',
        'ENC_DISCHDISPO':          dispo,
        'ENC_HOSPITALSERVICE':     service,
        'SERVICE_LINE':            service,
        'SERVICE_LINE_2':          'Surgical' if source == 'OR' else 'Medical',
        'SERVICE_LINE_3':          unit_meta['level_of_care'],
        'DEP_LASTDEPT':            unit_meta['dept_code'],
        'DEP_LASTDEPTHOSPITAL':    C.MAIN_SITE,
        'DEP_LASTDEPTLOC':         unit,
        'DEP_LASTDEPTID':          str(unit_meta['dep_id']),
        'DISCHORDER_ORDERTIME':    _minute(order_dt),
        'DISCHORDER_ORDERINST':    _minute(order_dt),
        'DISCHORDER_DISCHARGE':    int(round(do_to_dc)),
        'ADMORDER_ORDERINST':      _minute(admit_dt - dt.timedelta(minutes=float(rng.uniform(30, 240)))),
        'ACCOUNT_FINANCIALCLASS':  _financial_class(rng, params),
        'PROV_ADMPROV':            surgeon or 'Hospitalist Service',
        'PROV_ADMPROVSPECIALTY':   service,
        'PROV_LASTPROV':           surgeon or 'Hospitalist Service',
        'PROV_LASTPROVSPECIALTY':  service,
        'TDC_Status':              'Complete' if tdc_complete else (
            'Engaged' if rng.random() < 0.6 else 'Not Engaged'),
        'TDC_Engaged_Not_Completed':            0 if tdc_complete else 1,
        'TDC_Engaged_Disch_Delayed_Canceled':   1 if (not tdc_complete and rng.random() < 0.25) else 0,
        'TDC_Workflow_Complete_DischOrd_to_TDCEngaged':   int(max(0, rng.normal(28, 18))),
        'TDC_Workflow_Complete_Engaged_to_Complete':      int(max(0, rng.normal(41, 24))),
        'TDC_Workflow_Complete_TDCEngaged_to_AVSPrinted': int(max(0, rng.normal(33, 20))),
        'TDC_Workflow_Complete_to_Discharge':             int(max(0, rng.normal(52, 31))),
        'DM_Complete_MedRec':      (_minute(order_dt + dt.timedelta(
            minutes=float(rng.uniform(10, max(15, do_to_dc)))))
            if rng.random() < 0.82 else None),
        # Internal
        '__unit':      unit,
        '__source':    source,
        '__admit':     admit_dt,
        '__discharge': _minute(disch_dt),
        '__case_id':   case_id,
        '__service':   service,
    }


def generate_encounters(cases, calendar, params, rng, anchor):
    """
    OR-derived admissions first, then an ED/medical controller that fills each
    unit up to its authored occupancy target. The split between the two is what
    ST-2's "share of census attributable to the OR" measures.
    """
    unit_meta = {
        u: {'unit': u, 'level_of_care': loc, 'staffed_beds': beds,
            'dept_code': code, 'dep_id': i + 1}
        for i, (u, loc, beds, code) in enumerate(C.UNITS)
    }

    encounters = []
    csn = 900000

    # ── 1. OR-derived admissions ─────────────────────────────────────────────
    for c in sorted(cases, key=lambda x: x['Date_SchedDate']):
        if c['__is_future'] or c['__cancelled'] or not c['__inpatient'] or not c['__site_inpatient']:
            continue
        unit = _pick_unit(rng, c['Case_SurgeonService'])
        admit_dt = c['__or_out'] + dt.timedelta(minutes=PACU_MINUTES * float(rng.uniform(0.7, 1.5)))
        csn += 1
        encounters.append(_make_encounter(
            rng, params, csn, c['Case_SurgeonService'], unit, unit_meta[unit],
            admit_dt, 'OR', surgeon=c['Case_Surgeon'], case_id=c['_ID_CaseID'],
        ))

    # ── 2. ED/medical controller ─────────────────────────────────────────────
    # Walk the calendar forward. For each unit, admit exactly enough to reach
    # tomorrow's authored 07:00 census given who is already staying over.
    active = {u: [] for u in unit_meta}          # encounters currently in-house
    by_unit_admit = {u: [] for u in unit_meta}
    for e in encounters:
        by_unit_admit[e['__unit']].append(e)
    for u in by_unit_admit:
        by_unit_admit[u].sort(key=lambda e: e['__admit'])

    hist_days = [d for d in calendar if not d['is_future']]
    or_idx = {u: 0 for u in unit_meta}

    for day in hist_days:
        d = day['date']
        tomorrow = d + dt.timedelta(days=1)
        census_time_tomorrow = dt.datetime.combine(tomorrow, dt.time(7, 0))

        for unit, meta in unit_meta.items():
            # Everyone admitted so far who is still in-house tomorrow at 07:00.
            lst = by_unit_admit[unit]
            while or_idx[unit] < len(lst) and lst[or_idx[unit]]['__admit'].date() <= d:
                active[unit].append(lst[or_idx[unit]])
                or_idx[unit] += 1
            active[unit] = [e for e in active[unit] if e['__discharge'] > census_time_tomorrow - dt.timedelta(days=3)]

            carryover = sum(
                1 for e in active[unit]
                if e['__admit'] <= census_time_tomorrow < e['__discharge']
            )
            target_frac = OCCUPANCY_TARGET[unit][tomorrow.weekday()]
            target = int(round(target_frac * meta['staffed_beds'] * float(rng.normal(1.0, 0.035))))
            deficit = target - carryover
            if deficit <= 0:
                continue

            for _ in range(deficit):
                hour = _sample_hour(rng, params['ed_admission_hour_shape'])
                admit_dt = dt.datetime.combine(d, dt.time(hour, int(rng.integers(0, 60))))
                csn += 1
                e = _make_encounter(rng, params, csn, _medical_service(rng),
                                    unit, meta, admit_dt, 'ED')
                # ED patients arrive through the ED, so they carry ED timestamps.
                e['TIME_EDARRIVALTIME']     = _minute(admit_dt - dt.timedelta(minutes=float(rng.uniform(150, 480))))
                e['TIME_ED_DISPO_TIME']     = _minute(admit_dt - dt.timedelta(minutes=float(rng.uniform(60, 240))))
                e['TIME_ED_DEPARTURE_TIME'] = _minute(admit_dt - dt.timedelta(minutes=float(rng.uniform(10, 90))))
                encounters.append(e)
                active[unit].append(e)

    encounters.sort(key=lambda e: e['__admit'])
    return encounters, unit_meta


# ── DS_Occupancy — hourly census, derived from the encounters ────────────────

def generate_occupancy(encounters, unit_meta, calendar, rng):
    hist = [d['date'] for d in calendar if not d['is_future']]
    if not hist:
        return []
    start, end = min(hist), max(hist)

    # Bucket each encounter into the hours it occupies.
    counts = {}
    for e in encounters:
        a, dsc = e['__admit'], e['__discharge']
        if dsc.date() < start or a.date() > end:
            continue
        t = a.replace(minute=0, second=0, microsecond=0)
        stop = min(dsc, dt.datetime.combine(end, dt.time(23, 0)))
        while t <= stop:
            counts[(e['__unit'], t)] = counts.get((e['__unit'], t), 0) + 1
            t += dt.timedelta(hours=1)

    rows = []
    d = start
    while d <= end:
        for unit, meta in unit_meta.items():
            beds = meta['staffed_beds']
            for hour in range(24):
                stamp = dt.datetime.combine(d, dt.time(hour, 0))
                occ = counts.get((unit, stamp), 0)
                blocked = int(rng.integers(0, 3))
                rows.append({
                    'DEP_ID':             str(meta['dep_id']),
                    'DEP_NAME':           unit,
                    'DEP_Hospital':       C.MAIN_SITE,
                    'DEP_LOC':            meta['level_of_care'],
                    'Datehour':           stamp,
                    'Occupancy':          occ,
                    'StaffedBeds':        beds,
                    'DirtyBeds':          blocked,
                    'BedBlocked_or_Dirty': blocked,
                })
        d += dt.timedelta(days=1)
    return rows


# ── DS_Bedplacement — one movement per admission, plus some unit transfers ───

def generate_bedplacement(encounters, unit_meta, params, rng):
    rows = []
    for e in encounters:
        from_or = e['__source'] == 'OR'
        src     = 'PACU' if from_or else 'EMERGENCY DEPARTMENT'
        src_loc = 'Surgery' if from_or else 'Emergency'
        req = e['__admit'] - dt.timedelta(minutes=float(rng.uniform(45, 260)))

        req_to_assigned = max(2.0, float(rng.lognormal(3.15, 0.75)))       # median ~23 min
        assigned_to_complete = max(5.0, float(rng.lognormal(3.95, 0.62)))  # median ~52 min
        evs_req = req - dt.timedelta(minutes=float(rng.uniform(20, 180)))
        evs_r_to_a = max(1.0, float(rng.lognormal(2.75, 0.8)))
        evs_a_to_p = max(1.0, float(rng.lognormal(2.55, 0.7)))
        evs_p_to_c = max(3.0, float(rng.lognormal(3.45, 0.6)))

        meta = unit_meta[e['__unit']]
        rows.append({
            'EPICCSN':            str(e['EPICCSN']),
            'EVENT_TYPE_MOD':     'Admission',
            'TIME_REQUESTTIME':   _minute(req),
            'TIME_EVSREQUESTED':  _minute(evs_req),
            'SOURCE_DEPTNAME':    src,
            'SOURCE_DEPTLOC':     src_loc,
            'SOURCE_DEPTHOSPITAL': C.MAIN_SITE,
            'DEST_DEPTNAME':      e['__unit'],
            'DEST_DEPTHOSPITAL':  C.MAIN_SITE,
            'DEST_DEPTID':        str(meta['dep_id']),
            'DEST_DEPTLOC':       meta['level_of_care'],
            'DUR_Requested_Assigned':      int(round(req_to_assigned)),
            'DUR_Assigned_Complete':       int(round(assigned_to_complete)),
            'DUR_Requested_Complete':      int(round(req_to_assigned + assigned_to_complete)),
            'DUR_EVSRequested_Assigned':   int(round(evs_r_to_a)),
            'DUR_EVSAssigned_InProgress':  int(round(evs_a_to_p)),
            'DUR_EVSInProgress_Completed': int(round(evs_p_to_c)),
            'DUR_EVSRequested_Completed':  int(round(evs_r_to_a + evs_a_to_p + evs_p_to_c)),
        })

        # A minority of stays include one unit-to-unit transfer.
        if rng.random() < params['transfer_rates']['into_unit']:
            others = [u for u in unit_meta if u != e['__unit']]
            dest = others[int(rng.integers(0, len(others)))]
            dmeta = unit_meta[dest]
            treq = e['__admit'] + dt.timedelta(hours=float(rng.uniform(8, 60)))
            if treq < e['__discharge']:
                t_ra = max(2.0, float(rng.lognormal(3.05, 0.75)))
                t_ac = max(5.0, float(rng.lognormal(3.85, 0.62)))
                rows.append({
                    'EPICCSN':            str(e['EPICCSN']),
                    'EVENT_TYPE_MOD':     'Transfer',
                    'TIME_REQUESTTIME':   _minute(treq),
                    'TIME_EVSREQUESTED':  _minute(treq - dt.timedelta(minutes=float(rng.uniform(15, 120)))),
                    'SOURCE_DEPTNAME':    e['__unit'],
                    'SOURCE_DEPTLOC':     unit_meta[e['__unit']]['level_of_care'],
                    'SOURCE_DEPTHOSPITAL': C.MAIN_SITE,
                    'DEST_DEPTNAME':      dest,
                    'DEST_DEPTHOSPITAL':  C.MAIN_SITE,
                    'DEST_DEPTID':        str(dmeta['dep_id']),
                    'DEST_DEPTLOC':       dmeta['level_of_care'],
                    'DUR_Requested_Assigned':      int(round(t_ra)),
                    'DUR_Assigned_Complete':       int(round(t_ac)),
                    'DUR_Requested_Complete':      int(round(t_ra + t_ac)),
                    'DUR_EVSRequested_Assigned':   int(round(max(1.0, rng.lognormal(2.7, 0.8)))),
                    'DUR_EVSAssigned_InProgress':  int(round(max(1.0, rng.lognormal(2.5, 0.7)))),
                    'DUR_EVSInProgress_Completed': int(round(max(3.0, rng.lognormal(3.4, 0.6)))),
                    'DUR_EVSRequested_Completed':  int(round(max(6.0, rng.lognormal(4.0, 0.55)))),
                })
    rows.sort(key=lambda r: r['TIME_REQUESTTIME'])
    return rows


# ── V4_Inpatient_Forecast_Compile ───────────────────────────────────────────
# The app sums this table with no date filter, so it holds exactly one row per
# unit: the current day's picture that the morning huddle page renders.

def generate_ip_forecast(encounters, unit_meta, occupancy, anchor, params, rng):
    census_at = {}
    stamp = dt.datetime.combine(anchor - dt.timedelta(days=1), dt.time(7, 0))
    for row in occupancy:
        if row['Datehour'] == stamp:
            census_at[row['DEP_NAME']] = row['Occupancy']

    rows = []
    for unit, meta in unit_meta.items():
        census = census_at.get(unit, int(round(0.8 * meta['staffed_beds'])))
        wd = anchor.weekday()
        share = meta['staffed_beds'] / sum(m['staffed_beds'] for m in unit_meta.values())
        ed_day = params['ed_admissions_per_day'][str(wd)] * share

        def _split(total, weights):
            return [round(total * w, 1) for w in weights]

        ed = _split(ed_day, [0.14, 0.22, 0.32, 0.32])
        # OR admissions land in the afternoon and evening, which is exactly the
        # window ST-2's Wednesday pressure arrives in.
        or_total = sum(
            1 for e in encounters
            if e['__source'] == 'OR' and e['__unit'] == unit
            and e['__admit'].weekday() == wd
        ) / max(1, len({e['__admit'].date() for e in encounters if e['__admit'].weekday() == wd}))
        orr = _split(or_total, [0.02, 0.10, 0.46, 0.42])

        rows.append({
            'DEP_NAME':                     unit,
            'DEP_LevelofCare':              meta['level_of_care'],
            'DEP_Hospital':                 C.MAIN_SITE,
            'CENSUS':                       census,
            'StaffedBeds':                  meta['staffed_beds'],
            'EDAdmission_OrderAvailable':   int(round(ed_day * 0.35)),
            'EDAdmissions_DispoSet':        int(round(ed_day * 0.22)),
            'EDAdmissions_Forecast_00_06':  ed[0],
            'EDAdmissions_Forecast_06_12':  ed[1],
            'EDAdmissions_Forecast_12_18':  ed[2],
            'EDAdmissions_Forecast_18_23':  ed[3],
            'ORAdmissions_Forecast_00_06':  orr[0],
            'ORAdmissions_Forecast_06_12':  orr[1],
            'ORAdmissions_Forecast_12_18':  orr[2],
            'ORAdmissions_Forecast_18_23':  orr[3],
            'TransferCenter_Forecast':      round(params['transfer_rates']['transfer_center'] * meta['staffed_beds'], 1),
            'OtherTransferIn_Forecast':     round(params['transfer_rates']['other_in'] * meta['staffed_beds'], 1),
            'TransferIntoUnit_Forecast':    round(params['transfer_rates']['into_unit'] * meta['staffed_beds'], 1),
            'TransferOutofUnit_Forecast':   round(params['transfer_rates']['out_of_unit'] * meta['staffed_beds'], 1),
        })
    return rows

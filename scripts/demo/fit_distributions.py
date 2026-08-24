#!/usr/bin/env python3
"""
Fit distribution PARAMETERS from a real tenant, for the demo seeder to sample from.

Reads the source tenant (default: nhs) read-only and writes
scripts/demo/demo_distributions.json — shapes, not records. No row, no
identifier and no name leaves the source database: every value written is an
aggregate over hundreds of cases or encounters, and any group thinner than
MIN_GROUP_N is dropped and falls back to the pooled shape.

The output file is safe to commit.

Usage:
    python scripts/demo/fit_distributions.py                 # fit from nhs
    python scripts/demo/fit_distributions.py --tenant ohs
    python scripts/demo/fit_distributions.py --offline       # no DB; plausible defaults

--offline exists so the seeder can be built and rehearsed before source-DB
access is available. Offline params are hand-authored, not fitted; the JSON
records which mode produced it.
"""

import argparse
import datetime
import json
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)

import demo_config as C   # noqa: E402

OUT_PATH = os.path.join(HERE, 'demo_distributions.json')

# Groups thinner than this are dropped rather than published — both for
# statistical sense and so no near-individual aggregate is ever written out.
MIN_GROUP_N = 200

# Demo service -> candidate source-service names, tried in order. Anything that
# does not match falls back to the pooled shape. Kept explicit so the mapping is
# reviewable rather than fuzzy.
SOURCE_SERVICE_HINTS = {
    'Orthopedics':      ['Orthopedics', 'Orthopedic Surgery', 'Ortho'],
    'Spine':            ['Spine', 'Neurosurgery', 'Neuro Spine'],
    'General Surgery':  ['General Surgery', 'General'],
    'Urology':          ['Urology', 'Uro'],
    'GYN':              ['Gynecology', 'GYN', 'W&C Gynecology', 'OB/GYN'],
    'ENT':              ['ENT', 'Otolaryngology'],
    'Plastics':         ['Plastics', 'Plastic Surgery'],
    'Vascular':         ['Vascular', 'Vascular Surgery'],
    'Colorectal':       ['Colorectal', 'Colon and Rectal'],
    'Robotics-General': ['Robotics', 'General Surgery', 'General'],
}


# ── Offline defaults ─────────────────────────────────────────────────────────
# Hand-authored, plausible for a mid-size community system. Replaced wholesale
# by fitted values once fit_distributions.py runs against a real tenant.

def offline_params():
    # (mu, sigma) of ln(duration in minutes) — median = exp(mu)
    dur = {
        'Orthopedics':      (4.62, 0.46),   # median ~101 min
        'Spine':            (5.05, 0.52),   # median ~156 min
        'General Surgery':  (4.38, 0.52),   # median  ~80 min
        'Urology':          (4.14, 0.55),   # median  ~63 min
        'GYN':              (4.28, 0.50),   # median  ~72 min
        'ENT':              (3.95, 0.58),   # median  ~52 min
        'Plastics':         (4.34, 0.56),   # median  ~77 min
        'Vascular':         (4.79, 0.58),   # median ~120 min
        'Colorectal':       (4.86, 0.49),   # median ~129 min
        'Robotics-General': (4.90, 0.44),   # median ~134 min
    }
    los = {
        'Orthopedics':      {'median': 2.4, 'sigma': 0.55, 'gmlos': 2.7},
        'Spine':            {'median': 3.1, 'sigma': 0.60, 'gmlos': 3.4},
        'General Surgery':  {'median': 3.4, 'sigma': 0.72, 'gmlos': 3.8},
        'Urology':          {'median': 2.2, 'sigma': 0.62, 'gmlos': 2.6},
        'GYN':              {'median': 1.9, 'sigma': 0.55, 'gmlos': 2.3},
        'ENT':              {'median': 1.6, 'sigma': 0.52, 'gmlos': 2.0},
        'Plastics':         {'median': 1.8, 'sigma': 0.58, 'gmlos': 2.2},
        'Vascular':         {'median': 4.2, 'sigma': 0.78, 'gmlos': 4.6},
        'Colorectal':       {'median': 4.6, 'sigma': 0.74, 'gmlos': 5.0},
        'Robotics-General': {'median': 2.6, 'sigma': 0.66, 'gmlos': 3.1},
    }
    return {
        'mode': 'offline',
        'source_tenant': None,
        'generated_at': datetime.datetime.now().isoformat(timespec='seconds'),
        'note': 'Hand-authored plausible defaults. Re-run without --offline to fit '
                'from a real tenant before the first live demo.',
        'case_duration_lognormal': {k: {'mu': v[0], 'sigma': v[1]} for k, v in dur.items()},
        'case_duration_pooled':    {'mu': 4.45, 'sigma': 0.58},
        # Relative elective volume by weekday, Mon..Sun (weekends near zero).
        'dow_volume_shape':        {'0': 1.06, '1': 1.10, '2': 1.02, '3': 1.00, '4': 0.82,
                                    '5': 0.06, '6': 0.03},
        'addon_rate':              0.12,
        'cancellation_rate':       0.028,
        'asa_mix':                 dict(zip(C.ASA_CODES, C.ASA_WEIGHTS)),
        'anesthesia_mix':          dict(zip(C.ANESTHESIA_TYPES, C.ANESTHESIA_WEIGHT)),
        'inpatient_conversion':    dict(C.SERVICE_INPATIENT_RATE),
        'los_lognormal':           los,
        # Share of discharges by hour of day, 0..23.
        'discharge_hour_shape': {
            '0': .002, '1': .001, '2': .001, '3': .001, '4': .002, '5': .004,
            '6': .008, '7': .014, '8': .026, '9': .043, '10': .062, '11': .081,
            '12': .095, '13': .108, '14': .112, '15': .104, '16': .090, '17': .073,
            '18': .056, '19': .040, '20': .031, '21': .022, '22': .015, '23': .009,
        },
        # ED admissions per day, by weekday Mon..Sun, at the main site.
        'ed_admissions_per_day':   {'0': 21.5, '1': 19.8, '2': 19.2, '3': 19.6,
                                    '4': 20.4, '5': 18.1, '6': 19.9},
        'ed_admission_hour_shape': {
            '0': .022, '1': .017, '2': .014, '3': .012, '4': .011, '5': .013,
            '6': .018, '7': .026, '8': .034, '9': .043, '10': .052, '11': .058,
            '12': .060, '13': .061, '14': .062, '15': .063, '16': .064, '17': .065,
            '18': .063, '19': .058, '20': .050, '21': .043, '22': .035, '23': .028,
        },
        'turnover_lognormal':      {'mu': 3.82, 'sigma': 0.40},   # median ~46 min
        'first_case_delay':        {'mean': -18.0, 'sigma': 17.0},
        'transfer_rates':          {'into_unit': 0.09, 'out_of_unit': 0.08,
                                    'transfer_center': 0.03, 'other_in': 0.04},
        'financial_class_mix':     dict(zip(C.FINANCIAL_CLASSES, C.FINANCIAL_WEIGHTS)),
    }


# ── Fitting from a real tenant ───────────────────────────────────────────────

def _lognormal_params(values):
    """(mu, sigma) of ln(x) over positive values, trimmed at the 1st/99th pctile."""
    v = np.asarray([x for x in values if x and x > 0], dtype=float)
    if len(v) < MIN_GROUP_N:
        return None
    lo, hi = np.percentile(v, [1, 99])
    v = v[(v >= lo) & (v <= hi)]
    ln = np.log(v)
    return {'mu': round(float(ln.mean()), 4), 'sigma': round(float(ln.std()), 4)}


def _shape(counter):
    """Normalise a dict of counts into shares summing to 1."""
    total = sum(counter.values())
    if not total:
        return {}
    return {str(k): round(v / total, 5) for k, v in sorted(counter.items())}


def fit_from_db(tenant):
    import pyodbc
    from dotenv import load_dotenv
    load_dotenv()
    from pipeline_config import get_tenant_config, get_db_params

    cfg = get_tenant_config(tenant)
    server, database, user, password = get_db_params(cfg)
    conn = pyodbc.connect(
        C.odbc_connection_string(server, database, user, password),
        timeout=60, readonly=True,
    )
    print(f'  Connected read-only to {server} / {database}')

    date_from, date_to = cfg['case_date_range']
    posted   = cfg['case_posted_value']
    sl_col   = cfg['service_line_col']
    hospital = cfg['hospital_filter']
    hosp_or  = f" AND Loc_ORGrp2 = '{hospital}'" if hospital else ''
    hosp_enc = f" AND DEP_LASTDEPTHOSPITAL = '{hospital}'" if hospital else ''

    cur  = conn.cursor()
    base = offline_params()   # every key falls back to the offline value
    out  = {
        'mode': 'fitted',
        'source_tenant': tenant,
        'generated_at': datetime.datetime.now().isoformat(timespec='seconds'),
        'min_group_n': MIN_GROUP_N,
        'note': 'Aggregate distribution parameters only. No rows, identifiers or '
                'names from the source tenant.',
    }

    # ── OR case durations by source service ─────────────────────────────────
    cur.execute(f"""
        SELECT Case_SurgeonService AS svc, Dur_ORIn_OROut
        FROM DS_CASES
        WHERE Date_SchedDate BETWEEN ? AND ?
          AND CaseLogStatus = ?
          AND Case_CanCode IS NULL
          AND Dur_ORIn_OROut > 0{hosp_or}
    """, date_from, date_to, posted)
    by_svc, pooled = {}, []
    for svc, dur in cur.fetchall():
        by_svc.setdefault(svc or 'Unknown', []).append(float(dur))
        pooled.append(float(dur))
    print(f'  Pulled {len(pooled):,} case durations across {len(by_svc)} source services')

    src_dur = {k: p for k, v in by_svc.items() if (p := _lognormal_params(v))}
    out['case_duration_pooled']    = _lognormal_params(pooled) or base['case_duration_pooled']
    out['case_duration_lognormal'] = {}
    out['service_mapping']         = {}
    for demo_svc, hints in SOURCE_SERVICE_HINTS.items():
        match = next((h for h in hints if h in src_dur), None)
        out['service_mapping'][demo_svc] = match or '(pooled)'
        out['case_duration_lognormal'][demo_svc] = (
            src_dur[match] if match else out['case_duration_pooled']
        )

    # ── Day-of-week volume shape, add-on rate, cancellation rate, mixes ──────
    cur.execute(f"""
        SELECT DATEPART(WEEKDAY, Date_SchedDate) AS wd, COUNT(*)
        FROM DS_CASES
        WHERE Date_SchedDate BETWEEN ? AND ? AND CaseLogStatus = ?
          AND Case_CanCode IS NULL{hosp_or}
        GROUP BY DATEPART(WEEKDAY, Date_SchedDate)
    """, date_from, date_to, posted)
    # SQL Server DATEPART(WEEKDAY) is 1=Sunday by default; shift to 0=Monday.
    dow_counts = {(int(wd) + 5) % 7: int(n) for wd, n in cur.fetchall()}
    shape = _shape(dow_counts)
    if shape:
        peak = max(float(v) for v in shape.values())
        out['dow_volume_shape'] = {k: round(float(v) / peak, 4) for k, v in shape.items()}

    cur.execute(f"""
        SELECT
          SUM(CASE WHEN Case_AddOnCode IS NOT NULL THEN 1.0 ELSE 0 END) / NULLIF(COUNT(*), 0),
          COUNT(*)
        FROM DS_CASES
        WHERE Date_SchedDate BETWEEN ? AND ? AND CaseLogStatus = ?
          AND Case_CanCode IS NULL{hosp_or}
    """, date_from, date_to, posted)
    rate, n = cur.fetchone()
    if n and n >= MIN_GROUP_N and rate is not None:
        out['addon_rate'] = round(float(rate), 4)

    cur.execute(f"""
        SELECT
          SUM(CASE WHEN Case_CanCode IS NOT NULL THEN 1.0 ELSE 0 END) / NULLIF(COUNT(*), 0),
          COUNT(*)
        FROM DS_CASES
        WHERE Date_SchedDate BETWEEN ? AND ? AND CaseLogStatus = ?{hosp_or}
    """, date_from, date_to, posted)
    rate, n = cur.fetchone()
    if n and n >= MIN_GROUP_N and rate is not None:
        out['cancellation_rate'] = round(float(rate), 4)

    for col, key in (('Case_ASACode', 'asa_mix'), ('Anes_Anestype', 'anesthesia_mix')):
        cur.execute(f"""
            SELECT {col}, COUNT(*) FROM DS_CASES
            WHERE Date_SchedDate BETWEEN ? AND ? AND CaseLogStatus = ?
              AND {col} IS NOT NULL AND Case_CanCode IS NULL{hosp_or}
            GROUP BY {col}
        """, date_from, date_to, posted)
        counts = {str(k).strip(): int(v) for k, v in cur.fetchall() if v >= MIN_GROUP_N}
        if counts:
            out[key] = _shape(counts)

    # ── Turnover and first-case start variance ──────────────────────────────
    cur.execute(f"""
        SELECT Turnover_Turnover FROM DS_CASES
        WHERE Date_SchedDate BETWEEN ? AND ? AND CaseLogStatus = ?
          AND Turnover_Turnover BETWEEN 1 AND 240{hosp_or}
    """, date_from, date_to, posted)
    p = _lognormal_params([r[0] for r in cur.fetchall()])
    if p:
        out['turnover_lognormal'] = p

    cur.execute(f"""
        SELECT Dur_Act_vs_SchedStart FROM DS_CASES
        WHERE Date_SchedDate BETWEEN ? AND ? AND CaseLogStatus = ?
          AND Turnover_Orderofcaseinroom = 1
          AND Dur_Act_vs_SchedStart IS NOT NULL{hosp_or}
    """, date_from, date_to, posted)
    delays = np.asarray([float(r[0]) for r in cur.fetchall()], dtype=float)
    if len(delays) >= MIN_GROUP_N:
        lo, hi = np.percentile(delays, [1, 99])
        d = delays[(delays >= lo) & (delays <= hi)]
        out['first_case_delay'] = {'mean': round(float(d.mean()), 3),
                                   'sigma': round(float(d.std()), 3)}

    # ── Inpatient LOS by service ────────────────────────────────────────────
    cur.execute(f"""
        SELECT {sl_col} AS svc, CAST(ACCOUNT_IPLOS AS FLOAT), CAST(DRG_FINALDRGGMLOS AS FLOAT)
        FROM DS_Encounters
        WHERE BEDDED = 'Y' AND ACCOUNT_IPLOS IS NOT NULL
          AND DRG_FINALDRGGMLOS IS NOT NULL
          AND TIME_HOSPDISCHARGE >= ?{hosp_enc}
    """, date_from)
    los_by_svc, gmlos_by_svc = {}, {}
    for svc, los, gmlos in cur.fetchall():
        k = svc or 'Unknown'
        los_by_svc.setdefault(k, []).append(float(los))
        gmlos_by_svc.setdefault(k, []).append(float(gmlos))
    src_los = {}
    for k, v in los_by_svc.items():
        p = _lognormal_params(v)
        if p:
            src_los[k] = {'median': round(math.exp(p['mu']), 3), 'sigma': p['sigma'],
                          'gmlos': round(float(np.median(gmlos_by_svc[k])), 3)}
    out['los_lognormal'] = {}
    for demo_svc, hints in SOURCE_SERVICE_HINTS.items():
        match = next((h for h in hints if h in src_los), None)
        out['los_lognormal'][demo_svc] = src_los[match] if match else base['los_lognormal'][demo_svc]

    # ── Discharge hour shape ────────────────────────────────────────────────
    cur.execute(f"""
        SELECT DATEPART(HOUR, TIME_HOSPDISCHARGE), COUNT(*)
        FROM DS_Encounters
        WHERE BEDDED = 'Y' AND TIME_HOSPDISCHARGE >= ?{hosp_enc}
        GROUP BY DATEPART(HOUR, TIME_HOSPDISCHARGE)
    """, date_from)
    counts = {int(h): int(n) for h, n in cur.fetchall() if h is not None}
    if sum(counts.values()) >= MIN_GROUP_N:
        out['discharge_hour_shape'] = _shape(counts)

    # ── ED admission volume and hour shape ──────────────────────────────────
    cur.execute(f"""
        SELECT DATEPART(WEEKDAY, TIME_HOSPADMISSION) AS wd,
               COUNT(*) * 1.0 / NULLIF(COUNT(DISTINCT CAST(TIME_HOSPADMISSION AS DATE)), 0)
        FROM DS_Encounters
        WHERE BEDDED = 'Y' AND TIME_HOSPADMISSION >= ?
          AND ENC_ADMISSIONTYPE LIKE '%Emergency%'{hosp_enc}
        GROUP BY DATEPART(WEEKDAY, TIME_HOSPADMISSION)
    """, date_from)
    per_day = {str((int(wd) + 5) % 7): round(float(v), 3) for wd, v in cur.fetchall() if v}
    if len(per_day) == 7:
        out['ed_admissions_per_day'] = per_day

    cur.execute(f"""
        SELECT DATEPART(HOUR, TIME_HOSPADMISSION), COUNT(*)
        FROM DS_Encounters
        WHERE BEDDED = 'Y' AND TIME_HOSPADMISSION >= ?
          AND ENC_ADMISSIONTYPE LIKE '%Emergency%'{hosp_enc}
        GROUP BY DATEPART(HOUR, TIME_HOSPADMISSION)
    """, date_from)
    counts = {int(h): int(n) for h, n in cur.fetchall() if h is not None}
    if sum(counts.values()) >= MIN_GROUP_N:
        out['ed_admission_hour_shape'] = _shape(counts)

    conn.close()

    # Anything the fit did not produce keeps its offline value, recorded honestly.
    unfitted = [k for k in base if k not in out]
    for k in unfitted:
        out[k] = base[k]
    out['unfitted_keys'] = sorted(
        k for k in unfitted if k not in ('mode', 'source_tenant', 'generated_at', 'note')
    )
    return out


def load_params(path=None):
    path = path or OUT_PATH
    if not os.path.exists(path):
        raise FileNotFoundError(
            f'{path} not found — run: python scripts/demo/fit_distributions.py '
            f'(add --offline to work without source-DB access)'
        )
    with open(path, encoding='utf-8') as fh:
        return json.load(fh)


def main():
    ap = argparse.ArgumentParser(description='Fit demo distribution parameters.')
    ap.add_argument('--tenant', default='nhs', help='source tenant to fit from (default: nhs)')
    ap.add_argument('--offline', action='store_true',
                    help='skip the DB and write hand-authored defaults')
    ap.add_argument('--out', default=OUT_PATH)
    args = ap.parse_args()

    params = offline_params() if args.offline else fit_from_db(args.tenant)
    with open(args.out, 'w', encoding='utf-8') as fh:
        json.dump(params, fh, indent=2, sort_keys=True)
        fh.write('\n')
    print(f"  Wrote {args.out}  (mode: {params['mode']})")
    if params.get('unfitted_keys'):
        print('  Fell back to offline defaults for: ' + ', '.join(params['unfitted_keys']))


if __name__ == '__main__':
    main()

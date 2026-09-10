#!/usr/bin/env python3
"""
Demo acceptance for the Service Line Breakdown tab (ServiceLineBreakdown.md).

Tab 1 is the forecast; tabs 2-5 are what it does to you. It earns that position
only if it makes a cause visible. Two claims are checked against the generated
data rather than asserted in a spec:

  * ST-9 — Thursday is the heaviest column in the Total row, and the services
    that drive recovery load concentrate there, so the PACU tab's Thursday peak
    has a source the room can see for itself.

    Both revisions of the spec asked for *ortho and spine* clustering on the
    Thursdays. The data does not do that and cannot be made to: ST-1 makes
    Ortho A's **Thursday** block deliberately light, and Spine holds Mon/Wed/Fri.
    Monday is the ortho-and-spine day (70% recovery-heavy against Thursday's
    57%). The stripe that is genuinely there is Orthopedics and **Vascular** —
    and Vascular sits on Thursday precisely because that is ST-8's wrong-day
    finding, so two storylines reconcile on one screen. Asserted as the data
    behaves, rather than bending the seeder to a claim that contradicts ST-1.
  * ST-3 — Fridays are light, so they read as low columns in the Total row.

Replays the route's own aggregation over V4_FORECAST_COMPILE, so it checks the
grid the page will draw rather than a restatement of it.

Run: python3 scripts/checks/service_line_breakdown_acceptance.py
"""

import datetime as dt
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'demo'))

ANCHOR = dt.date(2026, 8, 25)
SEED = 42
WINDOW_WEEKS = 4      # the header's default window
DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']
# The services whose recovery profiles drive PACU load (generate_or.RECOVERY_HEAVY).
RECOVERY_SERVICES = ('Orthopedics', 'Spine', 'Vascular', 'Colorectal')
# The one that reads as a vertical stripe: near-zero every day but Thursday.
STRIPE_SERVICE = 'Vascular'
STRIPE_DOW = 3

CASE_COLS = ('SCHEDULED_INPATIENT', 'SCHEDULED_OUTPATIENT',
             'FORECAST_INPATIENT', 'FORECAST_OUTPATIENT')


def build(tables, anchor):
    """The route's aggregation: cases by service line x date, weekdays only."""
    start = anchor + dt.timedelta(days=1)
    end = start + dt.timedelta(days=WINDOW_WEEKS * 7 - 1)
    cells, dates = {}, set()
    for r in tables['V4_FORECAST_COMPILE']:
        d = r['Date']
        if not (start <= d <= end) or d.weekday() > 4:
            continue
        dates.add(d)
        n = sum(float(r.get(c) or 0) for c in CASE_COLS)
        cells[(r['SurgeonService'], d)] = cells.get((r['SurgeonService'], d), 0.0) + n
    return cells, sorted(dates)


def main():
    import seed_demo_tenant as S
    print('  Generating the seed ...')
    tables, _ctx = S.generate_all(ANCHOR, SEED)
    cells, dates = build(tables, ANCHOR)

    failures = []

    def check(label, actual, ok, target):
        print(f'  [{"ok  " if ok else "FAIL"}] {label:<54} {str(actual):>14}   (target {target})')
        if not ok:
            failures.append(f'{label}: {actual}, expected {target}')

    by_dow = {d: 0.0 for d in range(5)}
    recovery_by_dow = {d: 0.0 for d in range(5)}
    stripe_by_dow = {d: 0.0 for d in range(5)}
    for (svc, date), n in cells.items():
        by_dow[date.weekday()] += n
        if svc in RECOVERY_SERVICES:
            recovery_by_dow[date.weekday()] += n
        if svc == STRIPE_SERVICE:
            stripe_by_dow[date.weekday()] += n

    print(f'\n  {len(dates)} operating days over {WINDOW_WEEKS} weeks\n')
    print(f'  {"":<6}{"total":>8}{"recovery-heavy":>16}{STRIPE_SERVICE:>10}')
    for d in range(5):
        print(f'  {DOW[d]:<6}{by_dow[d]:>8.0f}{recovery_by_dow[d]:>16.0f}'
              f'{stripe_by_dow[d]:>10.0f}')
    print()

    check('columns are dates, weekends omitted', len(dates),
          len(dates) == WINDOW_WEEKS * 5 and all(x.weekday() < 5 for x in dates),
          f'{WINDOW_WEEKS * 5} weekdays')

    # Bands are aligned to Monday, so a rolling window that does not start on one
    # has a partial band at each end. That is honest, and it is what keeps the
    # same weekday in the same position; only the interior bands are full.
    weeks = {}
    for date in dates:
        weeks.setdefault(date - dt.timedelta(days=date.weekday()), []).append(date)
    interior = sorted(weeks)[1:-1]
    check('week bands are Monday-aligned and contiguous', len(weeks),
          all(len(weeks[w]) == 5 for w in interior) and len(weeks) <= WINDOW_WEEKS + 1,
          f'<= {WINDOW_WEEKS + 1} bands, interior full')

    # ST-9: the Total row puts the PACU peak's cause on the same screen.
    heaviest = max(by_dow, key=by_dow.get)
    check('ST-9 Thursday is the heaviest column in the Total row', DOW[heaviest],
          heaviest == STRIPE_DOW, 'Thu')
    peak_recovery = max(recovery_by_dow, key=recovery_by_dow.get)
    check('ST-9 recovery-heavy volume peaks there too', DOW[peak_recovery],
          peak_recovery == STRIPE_DOW, 'Thu')

    # The stripe itself: near-zero every day but Thursday, in every band. This
    # is ST-8's wrong-day block seen from the matrix.
    thu = stripe_by_dow[STRIPE_DOW]
    rest = sum(v for d, v in stripe_by_dow.items() if d != STRIPE_DOW)
    check(f'ST-8 {STRIPE_SERVICE} is a vertical stripe on Thursday',
          f'{thu:.0f} vs {rest:.0f} elsewhere', thu >= rest * 4,
          '4x its whole rest of week')

    per_week = []
    for wk, days in sorted(weeks.items()):
        t = next((x for x in days if x.weekday() == STRIPE_DOW), None)
        others = [x for x in days if x.weekday() != STRIPE_DOW]
        if not t or not others:
            continue
        per_week.append(cells.get((STRIPE_SERVICE, t), 0)
                        > sum(cells.get((STRIPE_SERVICE, d), 0) for d in others))
    check('ST-8 and it holds in every full week band',
          f'{sum(per_week)} of {len(per_week)}',
          len(per_week) > 0 and all(per_week), 'all bands')

    # ST-3: light Fridays read as low columns in the Total row.
    check('ST-3 Friday is the lightest column in the Total row', DOW[min(by_dow, key=by_dow.get)],
          min(by_dow, key=by_dow.get) == 4, 'Fri')
    busiest = max(by_dow.values())
    check('ST-3 and visibly so', f'{by_dow[4] / busiest * 100:.0f}% of the peak',
          by_dow[4] <= busiest * 0.85, '<= 85% of the busiest day')

    # Patient-type split (ServiceLineBreakdownPatientType.md): the three type
    # totals reconcile to the grand total over the window. Inpatient nets out
    # SDA, so OP + SDA + (IP - SDA) must equal the total the grid already draws.
    start = ANCHOR + dt.timedelta(days=1)
    end = start + dt.timedelta(days=WINDOW_WEEKS * 7 - 1)
    op = sda = ip_full = grand = 0.0
    for r in tables['V4_FORECAST_COMPILE']:
        d = r['Date']
        if not (start <= d <= end) or d.weekday() > 4:
            continue
        op += float(r.get('SCHEDULED_OUTPATIENT') or 0) + float(r.get('FORECAST_OUTPATIENT') or 0)
        sda += float(r.get('SCHEDULED_SDA') or 0) + float(r.get('FORECAST_SDA') or 0)
        ip_full += float(r.get('SCHEDULED_INPATIENT') or 0) + float(r.get('FORECAST_INPATIENT') or 0)
        grand += sum(float(r.get(c) or 0) for c in CASE_COLS)
    types_sum = op + sda + (ip_full - sda)
    check('patient type: OP + SDA + IP reconciles to the window total',
          f'{types_sum:.0f} vs {grand:.0f}', abs(types_sum - grand) < 0.5, 'equal')

    print()
    if failures:
        print(f'  Service Line Breakdown acceptance: {len(failures)} failure(s)\n')
        for f in failures:
            print(f'  - {f}')
        return 1
    print('  Service Line Breakdown acceptance: OK')
    return 0


if __name__ == '__main__':
    sys.exit(main())

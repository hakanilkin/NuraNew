#!/usr/bin/env python3
"""
The block-allocation mismatch taxonomy (BlockAllocations.md section 2).

Classifying a block as over- or under-allocated tells a committee *that* there
is a mismatch. It does not tell them what kind, and the kind decides the fix.
Two blocks at 58% utilisation can need opposite interventions.

The findings worth having are the ones nobody surfaces: a surgeon who holds
Tuesday but books most of their work on Thursdays does not need less time, they
need different time. That is a far more winnable conversation than "your
utilisation is low", and it is invisible to any measure that sums the week.

Pure: no I/O, no database handle. The pipeline calls it with aggregates; the
tests call it with fixtures.
"""

# Evaluation order is the whole design. A block on the wrong day looks
# over-allocated when you sum its week, and reporting it that way sends the
# committee into the wrong conversation entirely.
ABANDONED = 'ABANDONED'
WRONG_DAY = 'WRONG_DAY'
WRONG_SHAPE = 'WRONG_SHAPE'
FRAGMENTED = 'FRAGMENTED'
MISPLACED = 'MISPLACED'
UNDER_ALLOCATED = 'UNDER_ALLOCATED'
# Out-of-block work that lands after the operating day ends — late starts, long
# cases, add-ons, emergent volume. A different problem from UNDER_ALLOCATED, and
# the answer is investigation, not a bigger daytime allocation. Display label
# "Non-prime time" (BlockAllocationsPrimeTime.md).
NON_PRIME_TIME = 'NON_PRIME_TIME'
OVER_ALLOCATED = 'OVER_ALLOCATED'
RIGHT_SIZED = 'RIGHT_SIZED'
# Nothing matched. An honest gap, never an endorsement: a silent fallback that
# reads as "fine" is the thing a sceptical director catches on a projector.
UNCLASSIFIED = 'UNCLASSIFIED'

GROWING, STABLE, DECLINING = 'GROWING', 'STABLE', 'DECLINING'

DOW_LABEL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday',
             'Saturday', 'Sunday']

DEFAULT_THRESHOLDS = {
    # Volume bands, as in-block used over allocated.
    'right_sized_min_pct': 70.0,
    'right_sized_max_pct': 85.0,
    'over_allocated_lt_pct': 62.0,
    'under_allocated_gt_pct': 88.0,
    # Out-of-block hours a week that count as "material" — the volume is there,
    # it is simply not landing in the block. A single threshold, so a value
    # between two of them can never match nothing.
    'material_outside_hours': 3.0,
    # Prime vs non-prime split of the outside hours (BlockAllocationsPrimeTime.md).
    # primeShare = outsidePrime / (outsidePrime + outsideNonPrime), as a percent.
    # At or above high → the spill is daytime, an allocation ask (UNDER_ALLOCATED);
    # at or below low → it lands after the operating day (NON_PRIME_TIME); between
    # is a stated mix. Undefined below low_outside_hours — never classified on noise.
    'prime_share_high_pct': 60.0,
    'prime_share_low_pct':  40.0,
    'low_outside_hours':    1.0,
    # WRONG_DAY: a held day this empty, against an unheld day this busy.
    'wrong_day_held_used_pct': 45.0,
    'wrong_day_outside_hours': 2.5,
    # WRONG_SHAPE: allocated window longer than the day actually runs — and the
    # day it does run is long enough to be worth keeping.
    'wrong_shape_slack_hours': 2.0,
    'wrong_shape_min_day_hours': 6.0,
    # FRAGMENTED: spread this thin across this many days.
    'fragmented_min_days': 3,
    'fragmented_chunk_hours': 4.0,
    # ABANDONED: released this often out of the instances observed.
    'chronic_release_count': 4,
    'chronic_release_of': 8,
    # Headroom left when recommending a reduction.
    'headroom_pct': 15.0,
    # Trend bands on forward volume against the trailing baseline.
    'growing_pct': 12.0,
    'declining_pct': -12.0,
}


def _num(x):
    try:
        v = float(x)
        return v if v == v else 0.0          # NaN is not a number here either
    except (TypeError, ValueError):
        return 0.0


def _round1(x):
    return None if x is None else round(float(x) + 0.0, 1)


def driver(key, label, contribution, detail):
    """The house driver idiom: a number and the sentence that explains it."""
    return {'key': key, 'label': label,
            'contribution': _round1(contribution), 'detail': detail}


def classify_trend(forward_per_week, baseline_per_week, cfg=None):
    """Forward booked volume against the owner's own trailing baseline."""
    t = {**DEFAULT_THRESHOLDS, **(cfg or {})}
    base = _num(baseline_per_week)
    if base <= 0:
        return STABLE, None
    pct = (_num(forward_per_week) / base - 1) * 100
    if pct >= t['growing_pct']:
        return GROWING, _round1(pct)
    if pct <= t['declining_pct']:
        return DECLINING, _round1(pct)
    return STABLE, _round1(pct)


def classify_block(by_dow, release_events=0, release_of=0,
                   last_case_out_hours=None, trend=STABLE, cfg=None):
    """
    One owner's week, classified.

    `by_dow` is a list of dicts, one per weekday, each with hours per week:
      alloc          — allocated block hours
      used           — in-block case hours
      outside        — case hours booked outside any block that day
      outsidePrime   — of `outside`, the part inside the prime (block-day) window
      outsideNonPrime — of `outside`, the part after the operating day ends

    The prime split is optional: when it is absent (a tenant whose prime window
    cannot be derived) the taxonomy falls back to the single `outside` number and
    NON_PRIME_TIME never fires, exactly as before the split existed.

    Returns the pattern, the mismatch in hours per week, drivers, and a specific
    recommendation. Never "consider adjusting": the committee is deciding
    between numbers, so the numbers are in the sentence.
    """
    t = {**DEFAULT_THRESHOLDS, **(cfg or {})}
    # A tenant either carries the prime/non-prime split on every day or on none;
    # presence of the key on any day is the signal to use it.
    split_present = any(('outsidePrime' in x or 'outsideNonPrime' in x) for x in by_dow)
    days = []
    for d in range(5):
        row = next((x for x in by_dow if int(x.get('dow', -1)) == d), None) or {}
        out = _num(row.get('outside'))
        op = _num(row.get('outsidePrime')) if split_present else out
        onp = _num(row.get('outsideNonPrime')) if split_present else 0.0
        days.append({'dow': d, 'alloc': _num(row.get('alloc')),
                     'used': _num(row.get('used')), 'outside': out,
                     'outsidePrime': op, 'outsideNonPrime': onp})

    alloc = sum(d['alloc'] for d in days)
    used = sum(d['used'] for d in days)
    outside = sum(d['outside'] for d in days)
    outside_prime = sum(d['outsidePrime'] for d in days)
    outside_nonprime = sum(d['outsideNonPrime'] for d in days)
    total = used + outside
    util = (used / alloc * 100) if alloc > 0 else None
    held_days = [d for d in days if d['alloc'] > 0.5]

    # Share of the spill that is daytime. Undefined on noise — a block with a
    # few minutes outside is not classified on the direction of those minutes.
    prime_share = None
    if split_present and (outside_prime + outside_nonprime) >= t['low_outside_hours']:
        denom = outside_prime + outside_nonprime
        prime_share = (outside_prime / denom * 100) if denom > 0 else None
    # The day-based rules read daytime spill only: volume that lands at 18:00 is
    # evidence the day runs long, not that the day needs a block.
    def _out_prime(dd):
        return dd['outsidePrime'] if split_present else dd['outside']

    drivers = [
        driver('utilisation', 'In-block utilisation', util,
               f'{_round1(used)}h used of {_round1(alloc)}h allocated'
               + (f' ({_round1(util)}%)' if util is not None else '')),
        driver('outside', 'Booked outside block', outside,
               f'{_round1(outside)}h a week booked outside any block'),
    ]

    # ── 1. Abandoned ────────────────────────────────────────────────────────
    # A block released week after week has stopped being a release problem.
    # A rate, not a raw count: "4 of 8" means half the instances. Read as
    # "at least 4 events and at least 8 instances" it fires on 7 releases out of
    # 26, which is a block used three weeks in four.
    chronic_rate = t['chronic_release_count'] / t['chronic_release_of']
    if release_of >= t['chronic_release_of'] \
            and (release_events / release_of) >= chronic_rate:
        return _result(
            ABANDONED, alloc, drivers + [driver(
                'releases', 'Release history', release_events,
                f'Released {release_events} of {release_of} instances '
                f'({round(release_events / release_of * 100)}%)')],
            f'Released {release_events} of the last {release_of} instances — reallocate '
            f'rather than re-release.',
            delta_hours=-_round1(alloc), trend=trend, cfg=t, days=days)

    # ── 2. Wrong day ────────────────────────────────────────────────────────
    # Evaluated before anything that sums the week, because summing is exactly
    # what hides it.
    empty_held = [d for d in held_days
                  if d['alloc'] > 0
                  and (d['used'] / d['alloc'] * 100) < t['wrong_day_held_used_pct']]
    busy_unheld = [d for d in days
                   if d['alloc'] <= 0.5 and _out_prime(d) >= t['wrong_day_outside_hours']]
    if empty_held and busy_unheld:
        frm = max(empty_held, key=lambda d: d['alloc'] - d['used'])
        to = max(busy_unheld, key=_out_prime)
        return _result(
            WRONG_DAY, alloc, drivers + [
                driver('held_day', f'{DOW_LABEL[frm["dow"]]} allocation',
                       frm['alloc'] - frm['used'],
                       f'{DOW_LABEL[frm["dow"]]}: {_round1(frm["used"])}h used of '
                       f'{_round1(frm["alloc"])}h held'),
                driver('busy_day', f'{DOW_LABEL[to["dow"]]} volume', _out_prime(to),
                       f'{DOW_LABEL[to["dow"]]}: {_round1(_out_prime(to))}h booked with no block'),
            ],
            f'Move the {DOW_LABEL[frm["dow"]]} block to {DOW_LABEL[to["dow"]]} — '
            f'{_round1(_out_prime(to))}h a week is already being booked there.',
            delta_hours=0.0, trend=trend, cfg=t, days=days,
            target_dow=to['dow'], mismatch_override=min(frm['alloc'], _out_prime(to)))

    # ── 3. Wrong shape ──────────────────────────────────────────────────────
    if last_case_out_hours is not None and held_days:
        window = max(d['alloc'] for d in held_days)
        slack = window - _num(last_case_out_hours)
        # The day the room actually runs has to be a real day. Without this a
        # half-empty block finishes early, shows plenty of slack, and reads as a
        # shape problem — sending the committee to shorten a window when what
        # they should do is reduce the allocation. Gating on utilisation instead
        # would be self-defeating: an over-long window is what depresses
        # utilisation here, so the signature would suppress itself.
        if slack >= t['wrong_shape_slack_hours'] \
                and _num(last_case_out_hours) >= t['wrong_shape_min_day_hours']:
            longest = max(held_days, key=lambda d: d['alloc'])
            return _result(
                WRONG_SHAPE, alloc, drivers + [driver(
                    'tail', 'Unused tail', slack,
                    f'Cases consistently finish by {_round1(last_case_out_hours)}h into a '
                    f'{_round1(window)}h block')],
                f'Shorten {DOW_LABEL[longest["dow"]]} from {_round1(window)}h to '
                f'{_round1(last_case_out_hours + 0.5)}h, or pair a second owner into the tail.',
                delta_hours=-_round1(slack), trend=trend, cfg=t, days=days,
                mismatch_override=slack * max(1, len(held_days)))

    # ── 4. Misplaced ────────────────────────────────────────────────────────
    # Low utilisation with material volume outside matches neither volume
    # pattern — over-allocated wants the volume absent, under-allocated wants
    # the block full. That gap is most of a roster, and it is a real finding.
    # Two departures from the spec, both to close holes it left open. The spec
    # scopes this to util below the right-sized floor, which leaves its own dead
    # zone: a block inside the band with material volume outside it matches
    # nothing either. The bar is the under-allocated threshold instead, so
    # material outside volume always lands somewhere — under-allocated if the
    # block is also full, misplaced if not. And there is no dominant-day guard,
    # because WRONG_DAY is tested above: a block reaching here with a
    # concentrated alternative day is one whose held day was not empty enough to
    # move, and excluding it a second time drops it into nothing at all.
    if util is not None and util < t['under_allocated_gt_pct'] \
            and outside >= t['material_outside_hours']:
        # After-hours-dominant spill is not misplaced daytime work; it is the day
        # running long. Split it to NON_PRIME_TIME. The rest is MISPLACED, judged
        # on the daytime portion — that is the volume a day/shape review is about.
        if prime_share is not None and prime_share <= t['prime_share_low_pct']:
            return _non_prime_result(alloc, drivers, outside_nonprime, prime_share,
                                     trend, t, days)
        window = max((d['alloc'] for d in held_days), default=0.0)
        return _result(
            MISPLACED, alloc, drivers,
            f'Uses {_round1(util)}% of a {_round1(window)}h block while booking '
            f'{_round1(outside)}h a week outside it — review day and shape with the '
            f'owner before changing the allocation.',
            delta_hours=0.0, trend=trend, cfg=t, days=days,
            mismatch_override=min(alloc - used, outside_prime))

    # ── 5. Fragmented ───────────────────────────────────────────────────────
    if len(held_days) >= t['fragmented_min_days'] \
            and all(d['alloc'] < t['fragmented_chunk_hours'] for d in held_days):
        return _result(
            FRAGMENTED, alloc, drivers + [driver(
                'spread', 'Days held', len(held_days),
                f'{len(held_days)} days held, none longer than '
                f'{_round1(max(d["alloc"] for d in held_days))}h')],
            f'Consolidate {len(held_days)} short days into '
            f'{max(1, round(alloc / t["fragmented_chunk_hours"]))} longer blocks.',
            delta_hours=0.0, trend=trend, cfg=t, days=days)

    # ── 6. Volume patterns ──────────────────────────────────────────────────
    if util is not None and util > t['under_allocated_gt_pct'] \
            and outside >= t['material_outside_hours']:
        # High utilisation with material spill was a single UNDER_ALLOCATED leaf;
        # it is now a branch on where the spill lands. After-hours-dominant → the
        # answer is not more block; prime-dominant → it is; a middle band adds the
        # block for the daytime part and says so.
        if prime_share is not None and prime_share <= t['prime_share_low_pct']:
            return _non_prime_result(alloc, drivers, outside_nonprime, prime_share,
                                     trend, t, days)
        # The block time you would actually add is the daytime spill only, so both
        # the ask and the mismatch are sized on outsidePrime, not the total.
        spill = outside_prime
        add = _round1(spill * 0.75)
        if prime_share is not None and prime_share < t['prime_share_high_pct']:
            text = (f'Add about {add}h a week — the block runs at {_round1(util)}% and '
                    f'{_round1(spill)}h of daytime work is spilling outside it; the '
                    f'other {_round1(outside_nonprime)}h a week lands after the operating '
                    f'day and will not be fixed by more block.')
        else:
            text = (f'Add about {add}h a week — the block runs at {_round1(util)}% and '
                    f'{_round1(spill)}h of daytime work is already spilling outside it.')
        return _result(
            UNDER_ALLOCATED, alloc, drivers,
            text, delta_hours=add, trend=trend, cfg=t, days=days,
            mismatch_override=spill)

    # One threshold with two sides rather than two that can overlap or leave a
    # gap: volume outside the block is either material or it is not.
    target = total * (1 + t['headroom_pct'] / 100)
    # Only over-allocated if there is something to give back. Sizing the target
    # from used plus outside can land above the current allocation, and
    # "reduce from 8h to about 10h" is worse than saying nothing.
    if util is not None and util < t['over_allocated_lt_pct'] \
            and outside < t['material_outside_hours'] \
            and target < alloc - 0.5:
        cut = _round1(alloc - target)
        return _result(
            OVER_ALLOCATED, alloc, drivers,
            f'Reduce from {_round1(alloc)}h to about {_round1(target)}h a week — '
            f'the volume is not there and little is booking elsewhere.',
            delta_hours=-cut, trend=trend, cfg=t, days=days,
            mismatch_override=cut)

    # RIGHT_SIZED is an assertion against the configured bands, not the place
    # everything unmatched lands.
    if util is not None and t['right_sized_min_pct'] <= util <= t['right_sized_max_pct'] \
            and outside < t['material_outside_hours']:
        return _result(RIGHT_SIZED, alloc, drivers, 'No change.', delta_hours=0.0,
                       trend=trend, cfg=t, days=days, mismatch_override=0.0)

    return _result(
        UNCLASSIFIED, alloc, drivers,
        'No clear pattern — the numbers do not match any rule cleanly. '
        'Review with the owner.',
        delta_hours=0.0, trend=trend, cfg=t, days=days, mismatch_override=0.0)


def _non_prime_result(alloc, drivers, nonprime_hours, prime_share, trend, cfg, days):
    """
    Out-of-block work that lands after the operating day. Opens a question, does
    not assert a failure — emergent volume is folded in, so a service that takes
    call surfaces here while doing its job correctly. The mismatch is the size of
    the investigation, not the size of an allocation ask.
    """
    after = None if prime_share is None else 100 - prime_share
    d2 = drivers + [driver(
        'after_hours', 'After-hours share', after,
        f'{round(after)}% of outside work lands after the operating day'
        if after is not None else 'Outside work lands after the operating day')]
    return _result(
        NON_PRIME_TIME, alloc, d2,
        f'{_round1(nonprime_hours)}h/wk landing after the operating day. Review start '
        f'times, case-length estimates and add-on routing before changing allocation.',
        delta_hours=0.0, trend=trend, cfg=cfg, days=days,
        mismatch_override=nonprime_hours)


def _result(pattern, alloc, drivers, recommendation, delta_hours, trend, cfg, days,
            target_dow=None, mismatch_override=None):
    """
    Assemble the finding, letting the trend qualify what the recommendation asks
    for. A surgeon whose forward volume is growing should not have their block
    cut on trailing data alone.
    """
    text = recommendation
    delta = delta_hours
    if trend == GROWING and (delta or 0) < 0:
        delta = _round1(delta / 2)
        text = (recommendation.rstrip('.')
                + f' — but forward volume is growing, so cut {abs(delta)}h now and '
                  'revisit next quarter.')
    elif trend == DECLINING and (delta or 0) > 0:
        text = (recommendation.rstrip('.')
                + ' — though forward volume is declining, so confirm the demand first.')

    mismatch = mismatch_override if mismatch_override is not None else abs(delta or 0)
    return {
        'pattern': pattern,
        'mismatchHours': _round1(mismatch),
        'recommendation': {'text': text, 'deltaHours': _round1(delta),
                           'targetDow': target_dow},
        'drivers': drivers,
        'trend': trend,
        'byDow': days,
        'allocatedHours': _round1(alloc),
    }

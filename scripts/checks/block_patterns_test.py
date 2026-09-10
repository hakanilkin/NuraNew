#!/usr/bin/env python3
"""
Tests for block_patterns.py — the allocation mismatch taxonomy.

What is being defended is the evaluation order. A block held on the wrong day
looks over-allocated to anything that sums the week, and reporting it that way
sends a committee into the wrong conversation: "your utilisation is low" instead
of "your block is on the wrong day". The order is the product.

Run: python scripts/checks/block_patterns_test.py
"""

import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
sys.path.insert(0, ROOT)

import block_patterns as B  # noqa: E402

failures = []


def check(label, cond, detail=''):
    print(f'  [{"ok  " if cond else "FAIL"}] {label}' + (f'   {detail}' if detail and not cond else ''))
    if not cond:
        failures.append(label)


def day(d, alloc=0.0, used=0.0, outside=0.0, outside_prime=None, outside_nonprime=None):
    row = {'dow': d, 'alloc': alloc, 'used': used, 'outside': outside}
    # Only carry the split when a test supplies it, so the un-split cases exercise
    # the fallback path (no prime window derivable) exactly as a real tenant would.
    if outside_prime is not None or outside_nonprime is not None:
        row['outsidePrime'] = outside_prime or 0.0
        row['outsideNonPrime'] = outside_nonprime or 0.0
    return row


# ── Evaluation order ────────────────────────────────────────────────────────
wrong_day = B.classify_block([day(1, alloc=8, used=3.0, outside=0.2),
                              day(3, outside=5.4)])
check('a block held on the wrong day is WRONG_DAY, not OVER_ALLOCATED',
      wrong_day['pattern'] == B.WRONG_DAY, wrong_day['pattern'])
check('and it names the day to move to',
      'Thursday' in wrong_day['recommendation']['text']
      and wrong_day['recommendation']['targetDow'] == 3)
check('and it quantifies what is already happening there',
      '5.4h' in wrong_day['recommendation']['text'])

# The same week summed looks simply over-allocated, which is the trap.
summed_util = 3.0 / 8 * 100
check('the summed week alone would have read as low utilisation', summed_util < 62)

# A solid seven-hour day inside a ten-hour window: the room is busy, the window
# is simply the wrong length.
wrong_shape = B.classify_block([day(3, alloc=10, used=7.0, outside=0.3)],
                               last_case_out_hours=7.3)
check('a block longer than its day is WRONG_SHAPE',
      wrong_shape['pattern'] == B.WRONG_SHAPE, wrong_shape['pattern'])
check('and it says what to shorten it to',
      'Shorten Thursday' in wrong_shape['recommendation']['text'])

# The same slack with a short day is a volume problem, not a shape one, and
# shortening the window would be the wrong advice.
short_day = B.classify_block([day(3, alloc=8, used=4.0, outside=0.3)],
                             last_case_out_hours=4.2)
check('a short day with the same slack is not WRONG_SHAPE',
      short_day['pattern'] != B.WRONG_SHAPE, short_day['pattern'])
check('it reads as over-allocated instead',
      short_day['pattern'] == B.OVER_ALLOCATED, short_day['pattern'])

abandoned = B.classify_block([day(3, alloc=8, used=3.0)],
                             release_events=6, release_of=8)
check('chronic release is ABANDONED, ahead of every other pattern',
      abandoned['pattern'] == B.ABANDONED, abandoned['pattern'])
check('and it states the count rather than a rate',
      'Released 6 of the last 8' in abandoned['recommendation']['text'])

fragmented = B.classify_block([day(0, alloc=3, used=2.4), day(2, alloc=3, used=2.5),
                               day(4, alloc=3, used=2.3)])
check('three short days is FRAGMENTED', fragmented['pattern'] == B.FRAGMENTED,
      fragmented['pattern'])

# ── Volume patterns ─────────────────────────────────────────────────────────
over = B.classify_block([day(3, alloc=8, used=4.2, outside=0.3)])
check('low use with nothing spilling is OVER_ALLOCATED', over['pattern'] == B.OVER_ALLOCATED,
      over['pattern'])
check('and it gives a target, not "consider adjusting"',
      'Reduce from 8.0h to about' in over['recommendation']['text'])
check('and the reduction leaves headroom rather than cutting to the bone',
      over['recommendation']['deltaHours'] < 0
      and abs(over['recommendation']['deltaHours']) < 8)

under = B.classify_block([day(3, alloc=8, used=7.4, outside=4.0)])
check('high use with material spill is UNDER_ALLOCATED',
      under['pattern'] == B.UNDER_ALLOCATED, under['pattern'])
check('and the addition is sized from what is spilling',
      under['recommendation']['deltaHours'] > 0)

# ── Prime / non-prime split (BlockAllocationsPrimeTime.md) ──────────────────
# Same block, same 4h of spill. Where it lands decides the finding and the fix.
under_prime = B.classify_block([day(3, alloc=8, used=7.4, outside=4.0,
                                    outside_prime=3.4, outside_nonprime=0.6)])
check('high use with daytime spill stays UNDER_ALLOCATED',
      under_prime['pattern'] == B.UNDER_ALLOCATED, under_prime['pattern'])
check('and the ask and mismatch are sized on the daytime spill only',
      under_prime['mismatchHours'] == 3.4
      and under_prime['recommendation']['deltaHours'] == 2.5)   # 3.4 * 0.75, one dp

non_prime = B.classify_block([day(3, alloc=8, used=7.4, outside=4.0,
                                  outside_prime=0.6, outside_nonprime=3.4)])
check('the same spill landing after the day is NON_PRIME_TIME',
      non_prime['pattern'] == B.NON_PRIME_TIME, non_prime['pattern'])
check('and it opens a question rather than asserting an allocation',
      'after the operating day' in non_prime['recommendation']['text']
      and 'before changing allocation' in non_prime['recommendation']['text'])
check('and its mismatch is the after-hours hours — the size of the investigation',
      non_prime['mismatchHours'] == 3.4)

non_prime_low = B.classify_block([day(3, alloc=8, used=4.0, outside=4.0,
                                     outside_prime=0.8, outside_nonprime=3.2)])
check('low use with after-hours spill is NON_PRIME_TIME, not MISPLACED',
      non_prime_low['pattern'] == B.NON_PRIME_TIME, non_prime_low['pattern'])

misplaced = B.classify_block([day(3, alloc=8, used=4.0, outside=4.0,
                                  outside_prime=3.6, outside_nonprime=0.4)])
check('low use with daytime spill stays MISPLACED',
      misplaced['pattern'] == B.MISPLACED, misplaced['pattern'])

mixed = B.classify_block([day(3, alloc=8, used=7.4, outside=4.0,
                             outside_prime=2.0, outside_nonprime=2.0)])
check('a mixed split reads UNDER_ALLOCATED with the after-hours part stated',
      mixed['pattern'] == B.UNDER_ALLOCATED
      and 'after the operating day' in mixed['recommendation']['text'],
      mixed['pattern'])

wrong_day_np = B.classify_block([day(1, alloc=8, used=3.0, outside=0.2,
                                    outside_prime=0.2, outside_nonprime=0.0),
                                 day(3, outside=5.4, outside_prime=0.5,
                                     outside_nonprime=4.9)])
check('after-hours volume on an unheld day is not read as WRONG_DAY',
      wrong_day_np['pattern'] != B.WRONG_DAY, wrong_day_np['pattern'])

noise = B.classify_block([day(3, alloc=8, used=7.4, outside=0.6,
                             outside_prime=0.0, outside_nonprime=0.6)])
check('spill below the noise floor does not fire NON_PRIME_TIME',
      noise['pattern'] != B.NON_PRIME_TIME, noise['pattern'])

right = B.classify_block([day(3, alloc=8, used=6.2, outside=0.4)])
check('a block matching its volume is RIGHT_SIZED', right['pattern'] == B.RIGHT_SIZED,
      right['pattern'])
check('and RIGHT_SIZED carries no mismatch hours', right['mismatchHours'] == 0)

# ── Trend qualifies the recommendation ──────────────────────────────────────
grow = B.classify_block([day(3, alloc=8, used=4.2, outside=0.3)], trend=B.GROWING)
check('a growing owner is never cut on trailing data alone',
      'revisit next quarter' in grow['recommendation']['text'])
check('and the cut is halved rather than ignored',
      abs(grow['recommendation']['deltaHours']) < abs(over['recommendation']['deltaHours']))

decline = B.classify_block([day(3, alloc=8, used=7.4, outside=4.0)], trend=B.DECLINING)
check('a declining owner is asked to confirm demand before adding',
      'declining' in decline['recommendation']['text'])

# ── Shape of the output ─────────────────────────────────────────────────────
check('every finding carries drivers in the house idiom',
      all(set(d) >= {'key', 'label', 'contribution', 'detail'} for d in wrong_day['drivers']))
check('every finding carries five weekdays',
      len(wrong_day['byDow']) == 5 and [d['dow'] for d in wrong_day['byDow']] == [0, 1, 2, 3, 4])
check('mismatch is expressed in hours a week',
      isinstance(wrong_day['mismatchHours'], float))

# ── Trend classification ────────────────────────────────────────────────────
check('forward volume well above baseline is GROWING',
      B.classify_trend(14, 10)[0] == B.GROWING)
check('forward volume well below baseline is DECLINING',
      B.classify_trend(8, 10)[0] == B.DECLINING)
check('a small move is STABLE', B.classify_trend(10.5, 10)[0] == B.STABLE)
check('no baseline means STABLE rather than a divide by zero',
      B.classify_trend(10, 0)[0] == B.STABLE)

print()
if failures:
    print(f'  block patterns: {len(failures)} failure(s)')
    sys.exit(1)
print('  block patterns: OK')

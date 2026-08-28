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


def day(d, alloc=0.0, used=0.0, outside=0.0):
    return {'dow': d, 'alloc': alloc, 'used': used, 'outside': outside}


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

wrong_shape = B.classify_block([day(3, alloc=8, used=5.0, outside=0.3)],
                               last_case_out_hours=5.2)
check('a block longer than its day is WRONG_SHAPE',
      wrong_shape['pattern'] == B.WRONG_SHAPE, wrong_shape['pattern'])
check('and it says what to shorten it to',
      'Shorten Thursday' in wrong_shape['recommendation']['text'])

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

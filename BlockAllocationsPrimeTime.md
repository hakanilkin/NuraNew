# Block Allocations — prime vs non-prime out-of-block work

> **Status:** Change spec · amends `BlockAllocations.md` §3–§5,
> `BlockAllocationsFixes.md` (pattern chain) and `BlockAllocationsNumbers.md` §2
> **Owner:** Kartheek (product) · 2026-09-10
> **Branch:** `feature/or-demo-updates`, cut from `origin/main` @ f1ec1c9.
> Change 1 of 2 on this branch — `ServiceLineBreakdownPatientType.md` follows
> on the same branch, one PR for both.

---

## 1. Why

Out-of-block hours are a single number today, and that number conflates two
opposite findings.

Work done outside block but **during the operating day** means the service is
competing for the same daytime rooms everyone else wants. That is a demand
signal, and the answer is more or better-placed block.

Work done outside block **after the operating day ends** is a different problem
— late starts, long cases, add-ons, emergent volume — and the answer is
investigation, not a bigger allocation. Telling that service "we'll give you
more Tuesday" does not touch it.

So the split has to change the classification and the recommendation. A number
on the row that everyone reads past is not the point.

---

## 2. What prime time is

**Prime time is the allocated block day.** Derive it from the block calendar;
do not hardcode clock times.

```
for each (site, day-of-week):
    prime window = earliest block start .. latest block end
                   across all blocks at that site on that weekday,
                   computed with a 10th/90th percentile guard
```

The percentile guard exists so one 19:00 outlier block does not stretch the
envelope for everybody at that site.

- A site with no blocks on a weekday falls back to that site's envelope across
  all weekdays.
- Weekends and holidays are non-prime in full.
- Optional per-site override `prime_time_window` in `config/tenantColumns.json`,
  resolved through `utils/tenantColumns.js` like every other tenant param. When
  present it wins over the derived envelope. Do not hardcode NHS assumptions —
  this is the `DEST_CATEGORY` class of bug.

**Assertion worth keeping:** in-block used hours are prime *by definition*. If
any block's in-block hours fall outside its own site/dow prime window, the
derivation is wrong — log it rather than swallowing it.

---

## 3. Attribution

Prime is a property of the room-hour, not of the case. A case running
14:00–17:00 against an 07:00–15:30 window is half prime and half not.

**Hours** split by actual overlap:

```
prime      = max(0, min(case_end, prime_end) - max(case_start, prime_start))
non_prime  = case_duration - prime
```

**Cases** counted whole, into whichever bucket holds the majority of that case's
minutes. Never split a case count fractionally — "3.4 cases" is not a number a
committee will accept.

**Emergent and add-on cases are included**, exactly as today. Do not filter or
separate them. The consequence is that a trauma-taking service will legitimately
read high non-prime, which is a finding and not noise — §6 handles it in the
wording rather than in the data.

---

## 4. Pipeline

`performance_briefs_pipeline.py`, `_OUTSIDE_QUERY`. Replace the single
`OutsideHours` aggregation with four columns:

```
OutsidePrimeHours   OutsideNonPrimeHours
OutsidePrimeCases   OutsideNonPrimeCases
```

Same grain, same join; the overlap is a standard SQL `CASE`. Carry all four
through `_outside[(Service, Site, Dow)]` into each `byDow` entry as
`outsidePrime` / `outsideNonPrime` / `outsidePrimeCases` / `outsideNonPrimeCases`.

Keep the existing `outside` key as the sum of the two, so nothing downstream
breaks before it is updated.

---

## 5. Classifier

`block_patterns.py`. New thresholds in `DEFAULT_THRESHOLDS`, tenant-overridable
through `block_pattern_thresholds`:

```python
'prime_share_high_pct': 60.0,
'prime_share_low_pct':  40.0,
```

`primeShare = outsidePrime / (outsidePrime + outsideNonPrime)` across the week,
as a percentage. **Undefined when total outside hours are below
`low_outside_hours`** — do not classify on noise.

**New pattern: `NON_PRIME_TIME`** (display label "Non-prime time").

Changes to the chain:

**a) `UNDER_ALLOCATED` becomes a branch, not a leaf.** When its current
conditions fire (high utilization + material outside hours):

```
primeShare >= prime_share_high_pct   ->  UNDER_ALLOCATED
primeShare <= prime_share_low_pct    ->  NON_PRIME_TIME
in between                           ->  UNDER_ALLOCATED, mix stated in the
                                         recommendation
```

**b) `WRONG_DAY` and `MISPLACED` evaluate against `outsidePrime` only.** Thursday
volume that all lands at 18:00 is not evidence that Thursday needs a block; it is
evidence the day runs long.

**c) `mismatchHours`.** For `UNDER_ALLOCATED`, count prime outside hours only —
that is the block time you would actually add. For `NON_PRIME_TIME`, it is the
non-prime hours: the size of the investigation, not the size of the ask.

**d) Everything else is unchanged** — `OVER_ALLOCATED`, `ABANDONED`,
`WRONG_SHAPE`, `FRAGMENTED`, `RIGHT_SIZED` and the `UNCLASSIFIED` fallback. Do
not reopen the dead zone `BlockAllocationsFixes.md` closed: every block must
still land in exactly one pattern.

---

## 6. Recommendation text

`UNDER_ALLOCATED`, prime-dominant — today's wording, but cite prime hours:

> 5.2h/wk of daytime work outside block. Candidate for additional Tuesday
> allocation.

`NON_PRIME_TIME` — opens a question, does not assert a failure:

> 6.1h/wk landing after the operating day. Review start times, case-length
> estimates and add-on routing before changing allocation.

The second phrasing matters. Emergent volume is folded in, so a service that
takes call will surface here while doing its job correctly.

---

## 7. UI

`client/src/pages/BlockAllocations.jsx`.

**List caption, line 2 only** (line 1 unchanged per `BlockAllocationsNumbers.md`):

```
  56% of 8.1h in block
  6.5h · 9 cases outside (74% prime)
```

- Parenthetical drops when the split is unavailable for a tenant; the line
  degrades to hours and cases.
- Whole line still suppressed below 0.5h outside, as today.
- Uncoloured, tabular numerals, one decimal on hours.

**Drawer day table** — split the Outside column into `Outside (prime)` and
`Outside (non-prime)`. Totals reconcile with the caption exactly.

**Do not add a second hatch or any fourth encoding to the `WeekShape` bars.**
Five bars already carry outline / fill / hatch; another texture across ~18 rows
makes the column unscannable, and the caption states the split more precisely
than a texture can.

Add the `NON_PRIME_TIME` chip to the pattern legend and the pattern filter, in
the same visual family as the other mismatch patterns.

---

## 8. Seeder and verify — ST-8

Both findings must be present or the distinction does not demo.

- One block, well utilized, out-of-block hours **>= 70% prime** → must classify
  `UNDER_ALLOCATED`.
- One block, well utilized, out-of-block hours **<= 30% prime** → must classify
  `NON_PRIME_TIME`.

`verify.py` asserts each by name, checking both the pattern and the `primeShare`
direction. This sits on top of the ST-8 day-concentration fix.

---

## 9. Constraints

- Feature branch `feature/or-demo-updates`, shared with the patient-type
  change. Do not open the PR until both are done; wait for explicit approval
  before merging.
- Parameterize all SQL via `.input(...)`. No secrets, no PHI.
- Tenant isolation: `getTenantPool(req.session.tenantId)`, no cross-tenant joins.
- **NHS and OHS must keep working.** If the prime window cannot be derived for a
  tenant, fall back to today's single `outside` number and suppress the split in
  the UI rather than erroring.

---

## 10. Acceptance

- [ ] Prime windows derived per site × dow from the block calendar, with the
      percentile guard; `prime_time_window` override honoured when present.
- [ ] In-block hours fall inside their own prime window for every block, or the
      exception is logged.
- [ ] Pipeline emits the four split columns; `outside` still equals their sum.
- [ ] Hours split by overlap; cases assigned whole by majority minutes.
- [ ] Emergent and add-on cases included, unfiltered.
- [ ] `primeShare` undefined below `low_outside_hours`, and no block is
      classified on it there.
- [ ] `UNDER_ALLOCATED` fires only when prime-dominant; `NON_PRIME_TIME` fires
      when non-prime-dominant; the middle band reads as mixed.
- [ ] `WRONG_DAY` and `MISPLACED` use prime hours only.
- [ ] `mismatchHours` correct for both branches.
- [ ] Every block still lands in exactly one pattern; no `UNCLASSIFIED` growth.
- [ ] Caption reads `{h}h · {n} cases outside ({p}% prime)`, degrading cleanly.
- [ ] Drawer splits the Outside column; totals reconcile with the caption.
- [ ] No new encoding on the WeekShape bars.
- [ ] ST-8 seeds both a prime-dominant and a non-prime-dominant block; verify.py
      asserts both.
- [ ] NHS and OHS unaffected.

## Report back

The derived prime windows per site × dow for Demo; the pattern distribution
across all 20 blocks before and after; and every block whose classification
changed.

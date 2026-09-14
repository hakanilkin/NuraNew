# Block Allocations — five verdicts

> **Status:** Change spec · amends `BlockAllocations.md` §3 (presentation) and
> `BlockAllocationsFixes.md` (chip taxonomy)
> **Owner:** Kartheek (product) · 2026-09-11
> **Branch:** `feature/or-demo-updates`. Commit separately; same PR.

> ## Read this first
>
> **This is a display mapping, not a classifier change.**
>
> `block_patterns.py` is NOT modified. The nine internal patterns, their
> thresholds, their evaluation order and the dead-zone fix all stay exactly as
> they are. What changes is how many distinct chips the page shows.
>
> Two reasons it must be done this way:
>
> 1. `verify.py` asserts `WRONG_DAY`, `WRONG_SHAPE`, `MISPLACED`, `ABANDONED`,
>    `OVER_ALLOCATED`, `UNDER_ALLOCATED` and `NON_PRIME_TIME` **by name** in the
>    ST-8 block. Collapsing them in the classifier breaks every one of those
>    assertions, and rebuilding them is most of a day.
> 2. The distinctions are real and load-bearing. `OVER_ALLOCATED` deliberately
>    requires *low* outside volume — shrinking a block whose owner already
>    operates 6.5h/wk elsewhere makes the problem worse. That logic must survive
>    even when the chip no longer says so.
>
> One pass. Do not touch `block_patterns.py`, `performance_briefs_pipeline.py`,
> `verify.py` or any acceptance script.

---

## 1. Why

Nine chips, and one of them — **Misplaced** — holds 8 of 20 blocks.

`MISPLACED` is not a diagnosis; it is a residual. It exists to close the dead
zone where low utilization plus material outside volume matched nothing, and its
bar is `util < 88%`, which almost any block with outside volume clears. Its
recommendation says *"review day and shape with the owner"* — a punt, not an
action.

Meanwhile the page asks a committee to hold nine categories in their head when
they only have five decisions available to them.

**Group by the decision, not the symptom.** The specific diagnosis does not
disappear — it already lives in the recommendation sentence and the drawer,
which is where someone goes when they want it.

---

## 2. The five verdicts

| Chip | Internal patterns | The decision |
|---|---|---|
| **Right-sized** | `RIGHT_SIZED` | leave it |
| **Too much time** | `OVER_ALLOCATED`, `ABANDONED` | reduce or release |
| **Too little time** | `UNDER_ALLOCATED` | grow it |
| **Wrong placement** | `WRONG_DAY`, `WRONG_SHAPE`, `MISPLACED`, `FRAGMENTED` | restructure before resizing |
| **Non-prime time** | `NON_PRIME_TIME` | investigate the late running |
| *(No clear pattern)* | `UNCLASSIFIED` | unchanged — never an endorsement |

`NON_PRIME_TIME` keeps its own name and chip. It is the newest finding, it is
the one with a distinct story on stage, and "runs late" understates it.

Expected demo distribution: **Wrong placement 10, Right-sized 5, Too much time
3, Too little time 2, Non-prime time 1** — one chip per verdict, five chips on
screen instead of eight.

---

## 3. Implementation

`client/src/pages/BlockAllocations.jsx` only.

**Add a verdict map** beside the existing `patternConfig` switch:

```js
const VERDICT = {
  RIGHT_SIZED:     'RIGHT_SIZED',
  OVER_ALLOCATED:  'TOO_MUCH',   ABANDONED:  'TOO_MUCH',
  UNDER_ALLOCATED: 'TOO_LITTLE',
  WRONG_DAY:       'PLACEMENT',  WRONG_SHAPE: 'PLACEMENT',
  MISPLACED:       'PLACEMENT',  FRAGMENTED:  'PLACEMENT',
  NON_PRIME_TIME:  'NON_PRIME_TIME',
}
```

Everything that currently keys off `o.pattern` for **display** keys off
`VERDICT[o.pattern] ?? 'UNCLASSIFIED'` instead: the chip in the Pattern column,
the summary chip row (~line 558), and the counts.

`patternConfig` becomes `verdictConfig` over five verdicts plus the fallback.
Keep the existing idiom — label, glyph and colour, **never colour alone**. Retire
the four absorbed styles rather than leaving them unreachable.

Suggested styling, reusing colours already in the file:

```
Right-sized      ■  green      (as today)
Too much time    ▼  red        (OVER_ALLOCATED's red)
Too little time  ▲  blue       (UNDER_ALLOCATED's blue)
Wrong placement  ⇄  violet     (WRONG_DAY's violet)
Non-prime time   ☾  cyan       (as today)
No clear pattern ?  grey       (as today)
```

**`INERT` stays keyed on the raw pattern** (`RIGHT_SIZED`, `UNCLASSIFIED`) — the
findings count must not change.

**The filter** filters by verdict. Five buttons, not nine.

---

## 4. Where the detail survives

Nothing is lost, and the spec is explicit about where each thing went:

- **The recommendation sentence is unchanged.** A `WRONG_SHAPE` block still reads
  *"Shorten Tuesday from 10h to 7.5h, or pair a second owner into the tail."*
  The verdict says what kind of decision it is; the sentence says what to do.
- **The drawer is unchanged** — day table, week shape, drivers, pipeline.
- **The week-shape bars are unchanged.** They already show the day/shape
  mismatch that `WRONG_DAY` and `WRONG_SHAPE` name.

A reader who wants the specific finding reads the sentence next to the chip. A
reader scanning the page sees five verdicts.

---

## 5. The honest trade

**Wrong placement will hold 10 of 20 blocks** — a bigger bucket than Misplaced
is today. That is deliberate and it is true: half this roster needs restructuring
before anyone argues about hours. It is also a better sentence to say out loud —
*"half these blocks don't need more or less time, they need to be somewhere
else"* — than eight chips reading "Misplaced".

If the concentration proves worse on screen than on paper, the fallback is to
split `PLACEMENT` in two — `WRONG_DAY` + `MISPLACED` as "wrong day", `WRONG_SHAPE`
+ `FRAGMENTED` as "wrong shape" — giving six chips. Decide that after seeing it,
not before.

---

## 6. Tests

**None.** No data, no endpoint, no arithmetic changes. `verify.py` and
`block_allocations_acceptance.py` must keep passing **unchanged** — that is the
proof the classifier was not touched, and it is the one thing to check before
committing.

---

## 7. Deliberately not built

Binding. Do not add these, and do not ask:

- Any change to `block_patterns.py` — thresholds, order, names or logic.
- Any change to `verify.py` or the acceptance scripts.
- A sub-chip, badge or second column showing the underlying pattern.
- Renaming the internal pattern constants.
- A user-facing toggle between the nine-pattern and five-verdict views.
- Changing the recommendation text.

---

## 8. Acceptance

- [ ] Five verdict chips plus the fallback; nine-pattern chips gone from the UI.
- [ ] `block_patterns.py` byte-identical; `git diff` touches only the client.
- [ ] `verify.py` and `block_allocations_acceptance.py` pass unchanged.
- [ ] Demo reads Wrong placement 10, Right-sized 5, Too much time 3, Too little
      time 2, Non-prime time 1.
- [ ] Findings count unchanged — `INERT` still keyed on the raw pattern.
- [ ] Filter offers five verdicts and filters correctly.
- [ ] Every chip carries label + glyph; colour never alone.
- [ ] Recommendation sentences and the drawer are untouched.

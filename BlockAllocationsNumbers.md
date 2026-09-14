# Block Allocations — numbers alongside the week shape

> **Status:** Change spec · amends `BlockAllocations.md` §3
> **Owner:** Kartheek (product) · 2026-08-28
> **Scope:** small. The week-shape bars stay exactly as they are; they gain a
> two-line caption giving the magnitudes they encode.

---

## 1. The problem

The week shape shows *pattern* — which days are held, where volume actually
lands — but not *size*. A committee reading the row can see that Dr. Vance's
Tuesday is short and Thursday is busy without a block; they cannot see whether
that is two hours or twelve, which is the difference between a footnote and an
agenda item.

The numbers exist on the row already (they drive `mismatchHours` and the
recommendation). They are simply not shown next to the picture that encodes them.

---

## 2. The change — a caption under the bars

In the **Week shape** column of the list, directly beneath the five bars:

```
  ▁ ▃ █ ▂ ▁          ← unchanged
  56% of 8.1h in block
  6.5h · 9 cases outside
```

- **Line 1 — `{util}% of {alloc}h in block`.** The percentage and its
  denominator in one phrase, so "56%" is never a number without a scale.
  `alloc` is allocated hours per week; `util` is in-block used ÷ allocated.
- **Line 2 — `{outsideHours}h · {outsideCases} cases outside`.** Mirrors the
  legend's existing wording ("Booked outside a block") so the caption and the
  hatch pattern name the same thing.
- **Omit line 2 entirely when out-of-block volume is negligible** (< 0.5h). A
  row that reads "0h · 0 cases outside" spends two lines saying nothing, and
  the absence is itself informative when scanning the column.

Type: the existing small/muted caption token. Tabular numerals. One decimal on
hours, whole numbers on percentage and cases. Never colour-coded — the pattern
chip already carries status, and a second status signal in the same cell would
compete with it.

**Do not label the individual bars.** Five numbers per row across ~18 rows is
ninety numbers on a page whose job is pattern recognition; the per-day figures
already live in the drawer's day table, which is where someone goes when they
want them.

---

## 3. Cases — one pipeline addition

Hours are already computed. Case counts are not, and `9 cases outside` is the
more visceral half of the line — a committee argues about cases more readily
than about hours.

`performance_briefs_pipeline.py`, `_OUTSIDE_QUERY`: add a count alongside the
existing hours aggregation, carried through `_outside` and into each `byDow`
entry as `outsideCases`, then summed for the caption. Same grain, same join,
one extra column.

If the count is unavailable for a tenant, render line 2 as hours only rather
than suppressing it.

---

## 4. The drawer

No change required — the day table there already carries allocated / used /
outside / released per weekday, which is the full evidence.

*Optional, if it reads well:* the drawer's larger week shape (height 96) has
room for per-day hour labels above each bar. Worth trying, easy to revert; the
list view must not follow suit.

> **Not taken.** The drawer's numeric day table sits directly beneath that
> shape and already gives allocated / used / outside / released per weekday, so
> per-bar labels would print the same five numbers twice, a few pixels apart.
> One line of evidence, not two.

---

## 5. Acceptance

- [ ] Every row shows `{util}% of {alloc}h in block` beneath its bars.
- [ ] Rows with material out-of-block volume also show
      `{hours}h · {cases} cases outside`; rows below 0.5h show nothing.
- [ ] Numbers are tabular, one decimal on hours, uncoloured.
- [ ] No per-bar labels in the list view.
- [ ] `outsideCases` flows from the pipeline through `byDow` to the caption;
      absent counts degrade to hours only.
- [ ] Ortho A's caption matches its drivers and its recommendation text.

      > **Figures updated.** The spec's `56% of 8.1h` / `6.5h` predate
      > `BlockAllocationsFixes.md` and the reseed that came with it. Against the
      > current data Ortho A reads **`60% of 8.1h in block`** /
      > **`7.8h · N cases outside`**; the allocation is unchanged, the
      > utilization and spill moved with the seed. The caption is computed from
      > the same `byDow` the bars are drawn from, so it cannot disagree with them
      > whatever the numbers become.
- [ ] Column width still fits the five bars without wrapping the caption.

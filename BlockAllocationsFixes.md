# Block Allocations — corrections after first build

> **Status:** Change spec · addendum to `BlockAllocations.md`
> **Owner:** Kartheek (product) · 2026-08-24
> **Scope:** four changes — a classifier gap (mine), a seeder gap, and two UI
> changes. Do all of them in **one pass**, then reseed and re-run the pipeline
> once; the acceptance check verifies classifier and data together.

---

## 1. The classifier has a dead zone — RIGHT_SIZED is a fallback, not an assertion

**Evidence from the current demo tenant** (`public/data/demo/performance_briefs.json`):

| Block | Pattern | Util % | Outside h/wk | Released |
|---|---|---|---|---|
| Ortho A | `RIGHT_SIZED` | **55.8** | 6.5 | 4/13 |
| General B | `RIGHT_SIZED` | 63.6 | 6.4 | 1/26 |
| Ortho B | `RIGHT_SIZED` | 67.6 | **12.9** | 3/26 |

Ortho A uses 56% of its block while booking 6.5 h/week elsewhere and is labelled
right-sized. **13 of 20 blocks fall into this gap.**

**Cause — a genuine hole in `BlockAllocations.md` §2, my error:**

- `OVER_ALLOCATED` requires low utilization **and** low outside volume.
- `UNDER_ALLOCATED` requires high utilization **and** material outside volume.
- **Low utilization + material outside volume matches neither**, and falls
  through to `RIGHT_SIZED`.
- Separately, `right_sized_min_pct` / `right_sized_max_pct` exist in config and
  are **never read by `block_patterns.py`**. `RIGHT_SIZED` currently means "no
  rule fired," which is why the logic reads as inconsistent.

### 1a. New pattern — `MISPLACED`

*The volume exists; it simply isn't landing in the block.* This is the honest
name for the dead zone, and it is a real finding a committee can act on.

```
MISPLACED:  util < right_sized_min_pct
            AND outside >= material_outside_hours
            AND no single dominant alternative day (else WRONG_DAY fires first)
```

Evaluate **after** `WRONG_DAY` / `WRONG_SHAPE` and **before** the volume
patterns. Recommendation states both halves of the problem:

> *"Uses 56% of an 8.1h Thursday block while booking 6.5h a week outside it —
> review day and shape with the owner before changing the allocation."*

Mismatch hours = `min(alloc − used, outside)`.

### 1b. `RIGHT_SIZED` becomes an assertion

Use the bands that already exist in config:

```
RIGHT_SIZED:  right_sized_min_pct <= util <= right_sized_max_pct
              AND outside < material_outside_hours
```

Anything that matches **no** rule becomes **`UNCLASSIFIED`**, rendered plainly
as "no clear pattern" — never as an endorsement. A silent fallback that says
"fine" is worse than an honest gap, and on a projector it is the thing a
skeptical director will catch.

### 1c. Fragility to remove

`OVER_ALLOCATED` currently fails for Ortho A by **one hour** of outside volume
(6.5 vs a 5.5 threshold). Once `MISPLACED` exists this stops mattering, but keep
`low_outside_hours` and `material_outside_hours` from overlapping — a value
between them should always match something.

---

## 2. ST-8 is declared in config but absent from the generated data

`demo_config.py` names Vascular as the wrong-day case (held Tuesday, volume
Thursday) and Ortho A as abandoned. Neither is in the data:

- **Vascular** is held **Wednesday** at 77% utilization, with 1.7h on Thursday.
  `WRONG_DAY` needs an unheld day ≥ 2.5h and a held day < 45% — neither holds.
- **Ortho A** shows 4 releases of 13 instances (31%); `ABANDONED` needs ≥ 50%.

**Root cause: out-of-block volume is smeared evenly across all five weekdays.**
Ortho A's outside hours run 2.4 / 1.1 / 1.4 / 1.3 / 0.2. Real out-of-block
volume *concentrates* — a surgeon books wherever they can get time, which is one
or two specific days. Smeared, it can never trigger a day-based rule, by
construction.

**Seeder changes:**

1. **Concentrate out-of-block volume.** Give each owner a preferred alternative
   day or two and place 60–75% of their outside hours there. This is both more
   realistic and what makes any day-based pattern detectable.
2. **Make Vascular's wrong-day signature real:** held day used < 45%, and ≥ 3h
   of outside volume on one specific unheld day.
3. **Make Ortho A's release history real:** ≥ 50% of instances released over the
   review window, so `ABANDONED` fires and the Release Radar and Block
   Allocations tell one story about the same block.
4. Ensure at least one genuine `OVER_ALLOCATED` (low util, genuinely low
   outside) and one `WRONG_SHAPE` (block window materially longer than the
   consistent last-case-out).

`verify.py` asserts one of each of `WRONG_DAY`, `WRONG_SHAPE`,
`OVER_ALLOCATED`, `UNDER_ALLOCATED`, `ABANDONED`, `MISPLACED` exists, that
Ortho A is `ABANDONED`, and that **no more than half** the roster is
`RIGHT_SIZED` or `UNCLASSIFIED` — a page of "no change" is not a demo.

---

## 3. Replace "Evaluate impact" with "See details"

Remove the ScenarioPanel entry point from this page. It is the wrong affordance
here: a committee reviewing allocations wants **evidence**, not a simulation.
(`BlockAllocations.md` §7 is superseded; the panel keeps its Release Time Mgmt
host only, and `ISSCMIntegrationView.md` §8's host table updates accordingly.)

**"See details"** opens a right-hand slide-over — same drawer primitive already
in use — containing exactly two things:

### 3a. The evidence behind the utilization number

- The **week shape** at full size (allocated outline, in-block fill,
  out-of-block hatch).
- Beneath it, the **numeric day table**: weekday · allocated · used · outside ·
  released, with the week total. Every figure on the row is traceable here.

### 3b. The pipeline view

- **Forward booked cases by week** for this owner, against their trailing
  baseline — a small column chart plus the numbers.
- The baseline stated explicitly, so "+38%" has a visible denominator.
- This is the evidence behind the new Pipeline column (§4).

Nothing else. No recommendations restated, no scenario controls, no links out.
The drawer answers "show me why," and stops.

---

## 4. "Trend" column becomes "Pipeline"

Same underlying computation, better presentation: **label plus number**, so the
cell reads without interpretation.

```
Growing  +38%
Stable    +4%
Declining −21%
```

- Label from the existing `growing_pct` / `declining_pct` bands; number is the
  forward-vs-baseline percentage, rounded to whole.
- The label carries meaning by word and by shape/chip — never colour alone.
- Cell is clickable → opens the same drawer, scrolled to the pipeline view.
- Where forward data is thin, show **"No forward data"** rather than 0%.

The column still qualifies the recommendation as specced: an `OVER_ALLOCATED`
owner who is `Growing` reads *"reduce by 2h, revisit next quarter"* rather than
*"reduce by 4h."*

---

## 5. Acceptance

- [ ] `MISPLACED` exists and fires on Ortho A's profile (low util + material
      outside) instead of `RIGHT_SIZED`.
- [ ] `RIGHT_SIZED` only fires inside its configured bands with low outside
      volume; unmatched blocks render as `UNCLASSIFIED` / "no clear pattern".
- [ ] After reseed: all six actionable patterns present; Ortho A `ABANDONED`;
      Vascular `WRONG_DAY` naming a real source and target day; ≤50% of the
      roster `RIGHT_SIZED` or `UNCLASSIFIED`.
- [ ] Out-of-block volume is concentrated, not smeared — spot-check any owner's
      `byDow` and the outside hours should cluster on one or two days.
- [ ] "Evaluate impact" is gone from this page; "See details" opens a right
      slide-over with the week shape, the day table, and the pipeline chart —
      and nothing else.
- [ ] Pipeline column shows label + signed percentage, distinguishable without
      colour, and opens the drawer at the pipeline view.
- [ ] NHS/OHS unaffected.

## 6. Sequencing

One pass: classifier changes → generator changes → `verify.py` assertions → UI
changes. Then **one** reseed (`--load --reseed`) and **one**
`performance_briefs_pipeline.py --tenant demo`. Do not reseed before the
generator changes land; the current data cannot produce the patterns regardless
of classifier fixes.

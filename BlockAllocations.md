# Block Allocations — do allocations match how surgeons actually practice?

> **Status:** Spec — redesign, ready to build
> **Owner:** Kartheek (product) · 2026-08-24
> **Replaces:** the current Performance Briefs page (renamed "Block Allocations"
> in nav) and extends `performance_briefs_pipeline.py`.
>
> **The decision this page serves.** A quarterly block committee review. The
> question is not "which blocks have low utilization" — it is **"where does the
> allocated grid disagree with how surgeons actually practice, and what should
> we change?"** The action is **reallocation**, not release.
>
> **Boundary with Release Time Mgmt.** Release works *instances*: this specific
> Thursday is going unused, give it back. That is a growth play inside the grid
> you have. Block Allocations changes *the grid itself*. A block that shows up on
> the Release Radar week after week has stopped being a release problem and
> become an allocation finding — see §5.
>
> **Related:** `performance_briefs_pipeline.py`, `BriefsForwardLayer.md` (partly
> absorbed — see §6), `VolumeImpact.md`, `OpenTimeFulfillment.md`,
> `ISSCMIntegrationView.md` (ScenarioPanel host — see §7)

---

## 1. The core insight

Classifying a block as over- or under-allocated tells a committee *that* there
is a mismatch. It does not tell them **what kind**, and the kind determines the
fix. Two blocks at 58% utilization can need opposite interventions.

The most valuable findings are the ones nobody surfaces: **wrong day** and
**wrong shape**. A surgeon who holds Tuesday but books most cases on Thursdays
does not need less time — they need *different* time. That is a completely
different conversation, and a far more winnable one, than "your utilization is
low."

---

## 2. The mismatch taxonomy

Per block owner over a trailing review period (default: **2 complete quarters**,
matching today's pipeline).

Notation, all averaged per week and decomposed **by day of week**:
`alloc[d]` allocated hours · `used[d]` in-block case hours ·
`outside[d]` out-of-block case hours · `total[d] = used[d] + outside[d]`.

| Pattern | Detection | Recommendation |
|---|---|---|
| `RIGHT_SIZED` | Σused/Σalloc in target band; outside share low | None |
| `OVER_ALLOCATED` | Σused/Σalloc < low band **and** Σoutside low — the volume simply isn't there | Reduce to ~Σtotal + headroom |
| `UNDER_ALLOCATED` | Σused/Σalloc high **and** Σoutside material | Increase, or add a day |
| `WRONG_DAY` | ∃ day *d* with high `alloc[d]`, low `total[d]`; **and** day *e* with low/zero `alloc[e]`, high `outside[e]` | Move block from *d* to *e* |
| `WRONG_SHAPE` | Allocated window materially longer than the consistent last-case-out time | Shorten *d*, or pair a second owner into the tail |
| `FRAGMENTED` | Allocated across ≥3 days, each below a minimum viable chunk | Consolidate into fewer, longer blocks |
| `ABANDONED` | Release rate above threshold, sustained | Reclaim entirely |

Thresholds are tenant params, not constants. `WRONG_DAY` and `WRONG_SHAPE` are
evaluated **before** the volume-based patterns — a block that is on the wrong day
will look over-allocated, and reporting it that way sends the committee into the
wrong conversation.

Every classification carries drivers in the house
`{ label, contribution, detail }` idiom and a **specific** recommendation:
*"Reduce Thursday from 8h to 5h"*, *"Move Tuesday block to Thursday"* — never
"consider adjusting."

---

## 3. The view that makes it readable in seconds

For each block owner, a **week-shape**: five bars, Monday–Friday.

```
Dr. Vance — Orthopedics          WRONG DAY          mismatch 11.4 h/wk

        Mon     Tue     Wed     Thu     Fri
       ┌───┐   ┌───────┐        ┌───┐
alloc  │   │   │       │        │   │              ← outline = allocated
       │▓▓▓│   │▓▓     │        │▓▓▓│              ← fill    = in-block used
       └───┘   └───────┘  ▒▒▒▒  └───┘              ← hatch   = out-of-block
```

- **Outline = allocated. Fill = used in block. Hatch = booked outside any
  block.** Day mismatch, magnitude mismatch and shape all read at a glance.
- Hatch sitting on a day with no outline is the `WRONG_DAY` signal, visible
  without reading a number.
- Sort the page by mismatch magnitude (hours/week misallocated), not by
  utilization — magnitude is what a committee has agenda time for.
- Encode pattern by **chip + shape**, never colour alone.

Expanding an owner gives the numeric detail: allocated / used / outside /
released by day, trailing trend, and the recommendation with its drivers.

---

## 4. Data — all derivable today

| Need | Source |
|---|---|
| `alloc[d]`, released time, block days | `V4_BlockResultsView` (`blockTime`, `ReleasedTime`, `BlockDate`, `CaseBlock`) |
| `used[d]` / `outside[d]` | `DS_CASES` joined to block windows — in-block vs out-of-block by case start |
| Last-case-out time (for `WRONG_SHAPE`) | `DS_CASES` OR-out timestamps |
| Volume trend | trailing quarters + forward pipeline (§6) |

Pipeline: extend `performance_briefs_pipeline.py` with day-of-week
decomposition, out-of-block attribution, last-case-out, and the §2 taxonomy.
Output stays per-tenant JSON in `public/data/<tenant>/`, same serving path.

---

## 5. The feedback loop from Release Time Mgmt

A block released repeatedly is not a release problem.

- Count release events per block over the review period, from the Open Time
  store / workflow tables **and** `V4_BlockResultsView.ReleasedTime`.
- At or above `chronic_release_count` (default 4 in 8 instances), the block is
  flagged `ABANDONED` with the evidence stated plainly:
  **"Released 6 of the last 8 weeks — reallocate rather than re-release."**
- The row links back to that block's release history.

This is the loop a periop committee has no evidence for today, and it is only
possible because we own both surfaces.

---

## 6. What happens to the briefs forward layer

`BriefsForwardLayer.md`'s ACT/GROW **work-queue framing is dropped.** It existed
to answer "act on this now," which belonged to a triage page that no longer
exists. Reintroducing it here would put a weekly work queue on a quarterly
review page — two cadences, one screen, exactly the confusion this rebuild is
correcting.

The forward-pipeline **join stays**, repurposed as *evidence for the
reallocation decision*: a surgeon whose forward volume is growing should not
have their block cut on trailing data alone. It becomes a **trend column**
(`GROWING` / `STABLE` / `DECLINING`) that qualifies the recommendation — e.g.
`OVER_ALLOCATED` + `GROWING` reads *"reduce by 2h, revisit next quarter"*
rather than *"reduce by 4h."*

Everything else in `BriefsForwardLayer.md` — the `/api/briefs/focus` endpoint,
the focus strip, the ACT/GROW chips — is superseded by this spec. The endpoint's
forward-fill query is reusable as the trend input; the UI is not.

---

## 7. ScenarioPanel

A reallocation recommendation is a **decision** — "what if we moved Dr. Vance's
block from Tuesday to Thursday" — which is exactly what the panel is for.
Volume Impact shows what the forecast already implies; the panel shows what a
proposed change would do. Different questions, different surfaces.

- **"Evaluate impact"** on any recommendation row opens the ScenarioPanel with a
  `REALLOCATE` decision (moving a block also carries `SHIFT_DOW` semantics for
  Pillar 3 — a Tuesday-to-Thursday move changes the census footprint).
- Host table in `ISSCMIntegrationView.md` §8 becomes: **Release Time Mgmt** and
  **Block Allocations** only. Volume Impact does not host the panel (§7 of
  `VolumeImpact.md`).

This is where the panel earns its keep in the demo: a quarterly reallocation
that looks obviously right on block utilization alone, and turns out to move
census onto an already-tight unit.

## 8. API

```
GET /api/blocks/allocations?quarters=2&sites
      → { period, owners: [ { owner, service, site, pattern, mismatchHours,
          trend, byDow: [ { dow, alloc, used, outside, released } ],
          drivers: [...], recommendation: { text, deltaHours, targetDow? },
          releaseHistory: { count, of } } ] }

GET /api/blocks/allocations/:owner
      → full detail + trailing series
```

Tenant-scoped, parameterized, generic errors. Reads the pipeline JSON via
`tenantDataDir()`; the forward-trend half is a live query, same pattern as the
briefs focus endpoint.

---

## 9. Acceptance

- [ ] Every owner carries exactly one primary pattern plus a specific,
      numeric recommendation.
- [ ] `WRONG_DAY` and `WRONG_SHAPE` are evaluated before volume patterns; a
      wrong-day block is not reported as over-allocated.
- [ ] Week-shape renders allocated / used / outside distinguishably without
      colour; out-of-block volume on an unallocated day is visible at a glance.
- [ ] Page sorts by mismatch hours per week.
- [ ] A block released ≥4 of 8 instances is flagged `ABANDONED` with the count
      stated and a link to its release history.
- [ ] Trend qualifies the recommendation; a `GROWING` owner is never cut on
      trailing data alone.
- [ ] Demo tenant shows at least one of each of `WRONG_DAY`, `OVER_ALLOCATED`,
      `UNDER_ALLOCATED`, `ABANDONED` — seeder storyline **ST-8** (§10).
- [ ] NHS/OHS unaffected; degrade cleanly where out-of-block attribution is
      unavailable.

## 10. Seeder work (ST-8)

The demo needs a legible spread of patterns. Add to `DemoTenant.md`:

- One owner with a genuine **wrong-day** signature — block on Tuesday, ~60% of
  their volume booked Thursdays outside block. This is the page's headline.
- One **over-allocated** with flat trend, one **under-allocated** with growth,
  one **abandoned** (chronic releases) — which should be ST-1's Ortho A, so the
  Release Radar and this page tell one story about the same block.
- Everyone else `RIGHT_SIZED`, so the findings read as signal.

`verify.py` asserts one of each pattern exists and that Ortho A is `ABANDONED`.

## 11. Out of scope

Editing allocations in-app (recommendation only — the committee decides);
surgeon-level financials; anaesthesia block; automated reallocation.

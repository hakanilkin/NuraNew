# Performance Briefs — Forward Layer ("Where to Focus")

> **Status:** Spec — ready to build
> **Owner:** Kartheek (product)
> **Last updated:** 2026-08-24
> **Purpose:** turn Briefs from a report card into a work queue. The live pipeline
> already classifies every CaseBlock (misaligned / under-allocated / right-sized /
> over-allocated / watch) over the two most recent complete quarters. This layer
> joins each block's classification to its **forward booked volume**, so the page
> answers "given how this block ran *and* what's coming, where do I act first?"
>
> **Related:** `performance_briefs_pipeline.py` (classification — unchanged),
> `routes/atlas.js` `/performance-briefs` (static serving — unchanged),
> `routes/opentime.js` (the forward-fill query pattern to reuse),
> `client/src/pages/AtlasPerformanceBriefs.jsx`, `DemoTenant.md` (ST-1),
> `config/tenantColumns.json` (`block_fill_target`)

---

## 1. Concept

Retrospective status alone can't prioritize. An over-allocated block whose owner's
pipeline is thin needs action *now*; the same status with a full forward book
self-corrects. An under-allocated block (running hot) whose owner is *also* booking
heavily is a growth candidate, not a problem. Crossing the two axes gives the focus
queue:

| | **Forward fill < target** | **Forward fill ≥ target** |
|---|---|---|
| **Over-allocated / misaligned** | 🔴 **ACT — reclaim.** Chronic underuse and nothing coming. Feed to Release Time Mgmt. | 🟡 **SELF-CORRECTING.** Ran light, but the book is filling. Monitor. |
| **Under-allocated (running hot)** | 🟡 **WATCH.** Hot historically, cooling forward. | 🟢 **GROW.** Bursting and still booking. Priority for released time. |
| **Right-sized** | 🟡 **WATCH** if trending down | ⚪ **OK.** No action. |

The demo symmetry is deliberate: **ACT on Ortho A Thursday, GROW Spine** — the same
story the Release Radar and the ScenarioPanel tell, now visible as a ranked queue on
the Briefs page. Three surfaces, one narrative.

---

## 2. Architecture — live merge, not pipeline change

The pipeline and its JSON stay untouched (classification is quarterly by nature).
The forward signal changes daily, so it is joined **at request time**:

- **New module router `routes/briefs.js`** — factory style like every other:
  `require('./routes/briefs')(getTenantPool, sql, requireTenant)`, mounted at
  `/api/briefs`.
- It reads the tenant's `performance_briefs.json` via the same sanitized
  `tenantDataDir()` resolution `routes/atlas.js` uses (import/extract the helper —
  do not write a second path resolver), queries forward fill live, merges, and
  classifies focus **server-side**. The frontend never merges two sources.

### Forward-fill query

Reuse the radar's aggregation shape (`routes/opentime.js` — note the view's column
is spelled `Caseblock` in the forward rows):

```sql
SELECT ISNULL(Caseblock,'Unknown')            AS CaseBlock,
       SUM(ISNULL(BlockTime,0))               AS FwdBlockMins,
       SUM(ISNULL(TotalDurwTurn,0))           AS FwdBookedMins
FROM   V4_FORECAST_COMPILE
WHERE  DaysAhead BETWEEN 1 AND @horizonDays    -- default 28
GROUP  BY Caseblock
```

`fwd_fill_pct = FwdBookedMins / FwdBlockMins * 100` (null when no forward block
time — some briefs blocks won't appear in the forward window; that's a legitimate
`no_forward_data` state, rendered as such, never as 0%).

### Focus classification (server-side, thresholds from tenant config)

```
target = getParam(tenantName, 'block_fill_target')   // 75, already specced
ACT      = status in (over_allocated, misaligned) && fwd < target
SELF_OK  = status in (over_allocated, misaligned) && fwd >= target
GROW     = status == under_allocated && fwd >= target
WATCH    = (status == under_allocated && fwd < target) || status == watch
OK       = otherwise
```

Every item carries a `reason` string in the house driver idiom, built from the
numbers it was classified with: *"Over-allocated last two quarters (52% in-block)
and forecast fills 41% of the next 4 weeks vs a 75% target."*

### Endpoint

```
GET /api/briefs/focus?horizonDays=28
→ { period, horizonDays, target,
    items: [ { caseblock, status, inblock_util, primetime_util,
               fwd_fill_pct | null, focus, reason } ],
    counts: { ACT, GROW, SELF_OK, WATCH, OK } }
```

Sorted ACT → GROW → SELF_OK → WATCH → OK, secondary by distance from target.
Tenant-scoped and parameterized like everything else; degrade cleanly when either
source is missing (no briefs file → `no_atlas_data`; forward query empty →
items carry `fwd_fill_pct: null` and focus falls back to WATCH/OK by status).

---

## 3. Frontend — additions to `AtlasPerformanceBriefs.jsx`, no new page

1. **Focus header strip** — the five counts as chips (ACT count in the alarm color).
   This is the "where to focus" answer in one glance.
2. **Focus sort as the new default view**, with the existing status grouping one
   toggle away (nothing existing is removed).
3. **Two added columns** per block row: forward fill % (with the `no_forward_data`
   dash state) and the focus chip; the `reason` renders in the existing
   findings/expand area alongside the retrospective findings.
4. **Hand-off links:** an ACT row links to Release Time Mgmt filtered to that block;
   a GROW row links to the Open Time board. Briefs identifies, the ISSCM siblings
   act — the group's division of labor made navigable.

Encode focus by shape + color (chip + dot), not color alone — projector rule.

---

## 4. Demo tenant tie-in (additions to DemoTenant.md acceptance)

- ST-1's `Ortho A` must classify **ACT and rank #1** (misaligned/over-allocated in
  the retrained briefs + ~35–55% forward fill by construction).
- A Spine block must classify **GROW** (under-allocated + the +38% surge), so the
  reclaim/grow symmetry is on screen.
- The forward numbers shown on Briefs must equal the radar's for the same blocks —
  same view, same horizon, same math.

---

## 5. Acceptance criteria

- [ ] `/api/briefs/focus` returns merged, classified, sorted items for NHS and Demo;
      OHS degrades cleanly (briefs exist; forward blocks may be sparse).
- [ ] Focus classification lives only server-side; the page renders `focus` and
      `reason` verbatim.
- [ ] Blocks absent from the forward window show `no_forward_data`, never 0%.
- [ ] Existing briefs page behavior intact with the flag off / endpoint absent.
- [ ] Demo: Ortho A = ACT #1, a Spine block = GROW, Briefs forward % == Radar
      forward % for the same block and horizon.
- [ ] Unit tests on the classifier: all five outcomes + null-forward fallback.

## 6. Out of scope

Pipeline changes; brief text generation changes; per-block targets (single
`block_fill_target` param per prior decision); surgeon-level (vs block-level)
forward decomposition — a natural v2 once the demo lands.

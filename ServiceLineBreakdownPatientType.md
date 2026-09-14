# Service Line Breakdown — patient type

> **Status:** Change spec · amends `ServiceLineBreakdown.md`
> **Owner:** Kartheek (product) · 2026-09-10 (rev 3 — demo-grade, single pass)
> **Branch:** `feature/or-demo-updates`. Commit separately; one PR with the
> prime-time work.

> ## Read this first
>
> **This is demo scaffolding, not production code.** It exists so a roadmap
> capability can be shown on a screen. Build the shortest thing that renders
> correctly and reads plausibly to an OR director.
>
> - Demo tenant only. One flag hides it entirely for NHS and OHS.
> - Do not refactor adjacent code. Do not touch the other four tabs.
> - Do not generalise, add abstraction layers, or handle cases the demo will
>   never hit.
> - Section 6 caps the tests at two assertions. Section 7 is a binding
>   do-not-build list.
>
> If a choice is between "correct for the demo in 20 lines" and "correct in
> general in 200", take the 20.

---

## 1. Why

The tab says what volume is coming, by service line, by day. It does not answer
what every downstream area asks next: **how many of those patients need a bed.**

| Type | Where they go | What they consume |
|---|---|---|
| **Outpatient** | home | PACU phase 2, no bed |
| **Same-day admit** | a unit, post-op | **a bed, unplanned, that afternoon** |
| **Inpatient** | back to their unit | nothing new — they already hold a bed |

The middle row is the point: it creates afternoon bed demand out of nowhere, and
today it is buried inside `FORECAST_INPATIENT` with patients who already have
beds.

---

## 2. Data

Outpatient vs inpatient is **already in the table and being thrown away** —
every consumer, `/api/impact/breakdown` included, does
`ISNULL(FORECAST_INPATIENT,0) + ISNULL(FORECAST_OUTPATIENT,0)`. Stop summing and
two of three rows are free.

Same-day admit does not exist. Add **two columns** to the demo's
`V4_FORECAST_COMPILE`:

```
SCHEDULED_SDA  FLOAT NULL
FORECAST_SDA   FLOAT NULL
```

**`SDA` is a subset of `INPATIENT`, never a sibling:**

```
Outpatient      = OUTPATIENT
Same-day admit  = SDA
Inpatient       = INPATIENT - SDA
Total           = INPATIENT + OUTPATIENT      <- unchanged
```

Purely additive, so every existing `IP + OP` sum in the app stays correct
without being touched. Redefining `INPATIENT` to exclude same-day admits would
silently drop case counts on a dozen pages — do not.

### Gating

`config/tenantColumns.json`, Demo only:

```json
"features": { "patient_type_split": true }
```

Flag on → type columns and rows render. Flag off → the tab is what it is today.
`getFeatures()`, one branch, no fallback variant.

---

## 3. Generator — read the RNG note before writing code

### The RNG stream is shared. Do not disturb it.

`generate_all()` builds a single `np.random.default_rng(seed)` and threads it
through ~35 call sites. **Adding one draw to the existing stream shifts every
value generated after it** — utilisations, durations, block patterns — which
would break ST-1 through ST-9 and the prime-time work already verified on this
branch.

Use an independent stream:

```python
sda_rng = np.random.default_rng(seed + 1001)   # or rng.spawn(1)[0]
```

Draw the SDA decision only from `sda_rng`. Existing generated data then stays
byte-identical and only the two new columns appear. **Verify this**: after the
reseed, the prime-time pattern distribution must be unchanged
(`NON_PRIME_TIME 1`, `MISPLACED 8`, `UNDER_ALLOCATED 2`, `RIGHT_SIZED 5`,
`OVER_ALLOCATED 2`, `WRONG_DAY 1`, `WRONG_SHAPE 1`). If it moved, the stream was
disturbed — fix that before anything else.

### The rate

`demo_config.py` — share of a service's **inpatients** who arrive from home the
morning of surgery rather than already occupying a bed:

```python
SERVICE_SDA_RATE = {
    'Orthopedics':      0.88,
    'Spine':            0.92,
    'General Surgery':  0.70,
    'Urology':          0.85,
    'GYN':              0.90,
    'ENT':              0.85,
    'Plastics':         0.80,
    'Vascular':         0.60,
    'Colorectal':       0.68,
    'Robotics-General': 0.85,
}
```

> Placeholders pending Kartheek. The shape — elective near 0.9, vascular and
> colorectal lower — is what matters.

`generate_or.py`, inside the existing inpatient branch:

```python
sda_intent = inpatient_intent and sda_rng.random() < C.SERVICE_SDA_RATE[service]
```

Aggregate into `SCHEDULED_SDA` / `FORECAST_SDA` beside the existing inpatient
aggregation, same scheduled-vs-forecast rule.

**Reseed with the current seed and the current anchor** — do not re-anchor the
demo date in this change. Re-anchoring shifts every window and will surface
unrelated storyline failures; it is its own task, afterwards.

---

## 4. Layout

```
                 -- Sep 1 ---------   -- Sep 8 ---------  |  Total |   OP   SDA    IP
Orthopedics       8  11   6  19   7    7  10   5  21   6  |   154  |   61    74    19
Spine             4   3   9   5   2    3   4  11   4   3  |    73  |   12    55     6
General Surgery  12  10  11   9  10   11  12  10  11   9  |   157  |   98    51     8
...
---------------------------------------------------------+--------+-----------------
Total            41  44  43  51  35   38  44  44  56  32  |   648  |  381   221    46
  Outpatient     24  26  25  28  21   22  26  26  31  19  |   381
  Same-day admit 14  15  15  19  12   13  15  15  21  11  |   221
  Inpatient       3   3   3   4   2    3   3   3   4   2  |    46
```

- **Three right-hand columns** — service line x type, window totals.
- **Three bottom rows** — type x date. The cut PACU and the units plan against.

Four style rules, all of which are *less* work, not more:

- A rule between the date grid and the right-hand block, and above Total.
- **No shading in the new blocks.** The sequential scale stays on date cells.
- Type rows indented under Total and muted, so they read as its decomposition.
- One muted line beneath the table: *"Same-day admit arrives from home and is
  admitted after surgery; inpatient was already admitted before it."* No
  tooltips, no per-label hover.

**Do not build sticky/pinned columns for the new block.** The demo window fits;
if it ever does not, the block scrolls with the grid and that is fine.

---

## 5. Endpoint

`GET /api/impact/breakdown` extends; no new endpoint.

```
{ dates:    [ { date, dow, holiday? } ],
  services: [ { service, byDate:[n], total,
                byType: { outpatient, sda, inpatient } } ],
  types:    [ { type, byDate:[n], total } ],
  totals:   { byDate:[n], window },
  hasTypes: true }
```

`types` / `byType` present only when the flag is on; the client renders from
`hasTypes`.

---

## 6. Tests — two assertions, no new files

1. **`verify.py`** — `SCHEDULED_SDA <= SCHEDULED_INPATIENT` and
   `FORECAST_SDA <= FORECAST_INPATIENT` on every row.
2. **`scripts/checks/service_line_breakdown_acceptance.py`** (exists, 158 lines
   — **append ~10 lines, do not rewrite**) — over the whole window, the three
   type totals sum to the grand total.

Window-level only. Not per-date, not per-service — the reconciliation is true by
construction and one assertion is enough to catch a wiring mistake.

No new test files. No generator unit tests. Do not extend
`block_patterns_test.py` or `block_allocations_acceptance.py`.

---

## 7. Deliberately not built

Binding. Do not add these, and do not ask:

- The service x type x date cell. Single digits in a 15-column grid; noise.
- Row expansion, drill-downs, or any new interaction.
- Sticky/pinned columns for the new block.
- A two-way (OP/IP) mode for NHS or OHS.
- `ACTUAL_SDA`, `BUDGET_SDA`, type-aware budget or variance.
- Reconciling case-level encounter timestamps with the aggregate. The OR and IP
  generators are not linked; making them agree is its own project.
- Re-anchoring the demo date.
- Percentages, mix ratios, or any second encoding in the new blocks.
- Touching the Budget, Inpatient, Staffing or PACU tabs.

---

## 8. Acceptance

- [ ] `SCHEDULED_SDA` / `FORECAST_SDA` populated; `SDA <= INPATIENT`.
- [ ] **Prime-time pattern distribution unchanged after the reseed** (section 3).
- [ ] Type columns and rows render; totals reconcile at window level.
- [ ] `patient_type_split` is absent for NHS and OHS, so the new branch does not
      execute for them. Code-read is sufficient; do not stand up those tenants.
- [ ] No shading in the new blocks; Total row keeps its weight.
- [ ] Reads plausibly: spine and ortho heavily same-day admit, vascular and
      colorectal visibly less so.

## Report back

The type mix per service line for the demo window, and the prime-time pattern
distribution before and after the reseed.

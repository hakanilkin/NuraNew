# OR Smoothing — "Census Footprint"

> **Status:** Spec — ready to build
> **Owner:** Kartheek (product)
> **Last updated:** 2026-08-24
> **Purpose:** the page that answers *"how much of your inpatient congestion is a
> choice your surgical schedule is making?"* Every elective case casts a bed-shadow:
> cases × inpatient conversion × LOS spread = occupied beds days after surgery.
> Block templates were designed around surgeon preference; nobody designed the
> census they produce. This page makes that design visible — and changeable.
>
> **Demo beat (ST-2):** "Wednesday's peak on 5 Central is ~28% schedule-driven.
> That portion is a decision, not weather." Then a shift scenario flattens it.
>
> **Related:** `DemoTenant.md` (ST-2, ServiceUnitMap/UnitCapacity),
> `ISSCMIntegrationView.md` rev 2 (ScenarioPanel — this page is its second host),
> `routes/isscm.js` (`SHIFT_DOW` decision kind), `client/src/pages/IPForecast.jsx`
> (numbers must reconcile), `verify.py` ST-2 figures (30.3/32 Wed 07:00, 27.0%
> OR-attributed, 3.3 crunch unit-days/wk)

---

## 1. The three views

### V1 — The Footprint (the teaching moment)
Pick a service or block → its bed-shadow: expected occupied beds by **day offset**
(surgery day + 7) by receiving unit.

- Computation: weekly case volume × inpatient conversion rate × empirical LOS
  survival curve (both by service, from `DS_CASES`/`DS_Encounters`) × unit share
  (`ServiceUnitMap`).
- Render as a small-multiple bar strip per unit: D0…D+7 occupied beds. One line of
  copy above it: *"A Tuesday Ortho A block is still holding ~N beds on Friday."*
- This view exists to teach the mechanism in ten seconds; keep it simple.

### V2 — Census Attribution (the argument)
Day-of-week × unit heatmap of projected census, each cell decomposed:
**scheduled-OR** (controllable) vs **ED** vs **other/transfers**.

- Cell body: projected census / capacity; a stacked micro-bar shows attribution.
- Cells at/over a crunch threshold (default: census ≥ 92% of `UnitCapacity`,
  tenant param `crunch_occupancy_pct`) get the alarm treatment — shape + color.
- Header stat row: scheduled census contribution %, crunch unit-days/week, peak
  unit and day. These are the page's owned metrics.
- OR attribution comes from tracing seeded/live admissions back to cases
  (`DS_Bedplacement` → `DS_Encounters` → `DS_CASES`), not from a stored figure —
  same derived-not-asserted rule as everything else.

### V3 — Smoothing Scenario (the action)
Propose a shift: *service X, from day A to day B, n cases/week* → the census
curves re-render before/after, and the crunch-day and peak deltas display.

- The census overlay (before/after curves per affected unit) renders **on the
  page**; the three-pillar verdict opens in the **ScenarioPanel** via this page's
  "Evaluate move" button — decision kind `SHIFT_DOW`, already defined in the
  engine. The page owns the census picture; the panel owns the judgment. Do not
  duplicate pillar cards on the page.
- Scenario candidates: seed the picker with the ranked worst offenders from V2
  (largest controllable contribution to a crunch cell), so the demo needs no
  free-form input. Free-form controls are Phase 2.

---

## 2. API surface

Module router factory, mounted at `/api/smoothing`:

```
GET /api/smoothing/footprint?service|caseBlock&site
      → { service, weeklyCases, conversionPct, units: [ { unit, sharePct,
          byOffset: [ { d, beds } ] } ] }

GET /api/smoothing/census-attribution?site&weeks=8
      → { units: [ { unit, capacity, byDow: [ { dow, census, or, ed, other,
          crunch: bool } ] } ], summary: { orContributionPct, crunchUnitDays,
          peak: { unit, dow, census } } }

GET /api/smoothing/scenarios?site
      → ranked shift candidates with one-line rationale (feeds V3 picker)

POST /api/smoothing/preview   { decision: SHIFT_DOW }
      → before/after census curves for affected units (page overlay only;
        pillar verdicts remain /api/isscm/evaluate)
```

All tenant-scoped via `getTenantPool(req.session.tenantId)`, parameterized,
generic errors. The attribution and preview computations share one lib module
(`lib/censusFootprint.js`) with the ISSCM engine's Pillar 3 so the two can never
disagree — **this is a hard requirement**: Pillar 3's unit-pressure numbers and
V2's cells must come from the same function.

## 3. Frontend

- `client/src/pages/ORSmoothing.jsx`, route `/or-smoothing`, feature flag
  `smoothing` (true for Demo; false for NHS/OHS until ServiceUnitMap data exists
  for them). Nav entry lands with the ISSCM-group restructure.
- Conventions: `MultiSelect` site/service filters, card tables, existing token
  palette; heatmap follows the calendar heat-map idiom from `DailyDetail.jsx`.
- Crunch encoding: shape + color (projector rule).
- "Evaluate move" button per scenario row — opens `ScenarioPanel` with the
  `SHIFT_DOW` decision. Second host page per the panel spec's table.

## 4. Data honesty

- Conversion rate is admissions/cases by service — the same Phase-1 approximation
  the ISSCM engine uses; upgrading both to a true case→admission join is one
  shared change in `lib/censusFootprint.js` (tracked as engine Phase 4).
- LOS survival is empirical, bucketed by service; no parametric model.
- Non-demo tenants without `ServiceUnitMap` rows: flag off, page hidden — never a
  broken page.

## 5. Acceptance

- [ ] V2's Wednesday 5 Central cell shows census ≈30/32 with OR attribution
      ≈27% — matching `verify.py` ST-2 within rounding, from live queries.
- [ ] Crunch unit-days/week ≈3.3 at baseline on Demo.
- [ ] V1 footprint for Ortho/Spine shows multi-day bed-shadow consistent with
      seeded LOS distributions.
- [ ] V3: the top-ranked scenario (shift Tue inpatient-heavy cohort → Thu)
      reduces crunch unit-days and Wednesday peak in the preview overlay; its
      "Evaluate move" opens the panel and Pillar 3 agrees in direction with the
      overlay (shared lib guarantees it).
- [ ] IP Forecast page and V2 show consistent unit census for the same horizon.
- [ ] NHS/OHS: flag off → no nav entry, `/api/smoothing/*` 404, nothing breaks.
- [ ] Unit tests on `lib/censusFootprint.js`: attribution decomposition,
      threshold behavior, shift arithmetic; engine Pillar 3 imports the same fns.

## 6. Out of scope (v1)

Free-form scenario builder; PACU modeling; transfer-center detail; per-unit
nurse staffing (that's the Staffing page's lane); writing anything back.

# ISSCM Scenario Engine & Evaluation Panel — coupled OR capacity decisions

> **Status:** Spec — revised, not started
> **Owner:** (fill in)
> **Last updated:** 2026-08-24 (rev 2)
> **Purpose:** the centerpiece capability for the head-to-head demo against Qventus.
>
> **REVISION 2 (2026-08-24) — read this first, it changes two things:**
> 1. **This is not a page.** There is no `/isscm` route and no nav entry. The
>    deliverable is a shared **evaluation panel** (`ScenarioPanel.jsx`) summoned in
>    context from the ISSCM nav group's pages — Release Time Mgmt first, then OR
>    Smoothing and Staffing when they ship. Integration is a property of every
>    decision, not a destination; a standalone page would contradict the positioning.
> 2. **The demo data source is the Bright Memorial demo tenant** (`DemoTenant.md`),
>    not the mock-JSON mode described in §5. The engine's inputs come from live
>    queries against the seeded Demo DB (which contains `StaffingPlan`,
>    `UnitCapacity`, `ServiceUnitMap` by construction). §5's mock-file mechanism is
>    retained only as an optional offline fallback — build it last, or not at all.
> Sections below are unchanged where the engine, schema, and reasoning rules are
> concerned; read `/isscm`-page references through the two rules above.
>
> **Why this page exists (read before building):** every competitor in this space —
> Qventus, LeanTaaS, and Epic's own OR Capacity module — optimizes *slot occupancy*.
> None of them model what an OR capacity decision does to staffing or to downstream
> inpatient beds, because their products are drawn around transactions on the block
> schedule rather than around decisions. ISSCM's whole premise is that the three
> pillars are coupled. **This page is that premise, made clickable.** If the build
> drifts into "another utilization dashboard," it has failed its purpose.
>
> **Related:** `OROpenTime.md`, `lib/releaseRisk.js` (driver idiom), `routes/atlas.js`
> (per-tenant JSON serving pattern), `routes/orserviceline.js` (`/pipeline`),
> `client/src/pages/AtlasTurnover.jsx` (reasoning-panel conventions),
> `client/src/pages/OpenTimeRadar.jsx` (driver-panel conventions)

---

## 1. What it must prove

One evaluation surface — opened in context from any ISSCM page — where a single OR
capacity decision is judged across all three ISSCM pillars **at the same time**, and
where the pillars are allowed to disagree.

The demo lands when the screen says, in effect: *"This reallocation improves
utilization. It also breaks your Thursday staffing and pushes 5C past capacity.
Here is a Tuesday variant that satisfies all three."*

Three things must be true of every number on the page, or the page does not do its job:

1. **It is attributable.** Every headline figure expands into per-driver contributions
   in the same `{ label, contribution, detail }` shape `lib/releaseRisk.js` already emits.
2. **It is coupled.** Changing the decision updates all three pillars from the same
   scenario evaluation, not from three independent widgets.
3. **It is honest about conflict.** When pillars move in opposite directions the page
   says so explicitly rather than averaging it away into a single score.

---

## 2. The demo click path

Build to this path. It is the acceptance test.

| # | Action | What the screen shows |
|---|---|---|
| 1 | On **Release Time Mgmt**, the ST-1 row (Ortho A, Thursday) is flagged by the radar | The familiar risk score + driver panel — the page the scheduler already lives on. |
| 2 | Click **Evaluate impact** on that row | The **ScenarioPanel** opens over the page: three pillar cards in **baseline** state for this block, plus the candidate decisions with one-line rationales (e.g. *"61% true utilization across the last 8 weeks; Spine pipeline +38%"*). |
| 3 | Select the reallocation scenario | Baseline detail for that block: allocated hours, true utilization, current staffing draw, current downstream admission pattern. |
| 4 | Apply the decision (a lever, e.g. "reallocate 4 of 8 Thursday hours to Spine") | All three pillar cards recompute. Each shows **before → after**, a delta, and a status of `improves` / `neutral` / `degrades`. |
| 5 | — | **Conflict strip** appears: *"1 of 3 pillars improves. Staffing and inpatient capacity degrade."* This is the moment the demo is for. |
| 6 | Expand any pillar | Driver breakdown — which factors produced the delta and by how much, in plain language. |
| 7 | Open **Alternatives** | Ranked variants of the same decision (different day, different split, different receiving service) scored on all three pillars, with the best all-green option first. |
| 8 | Select the Tuesday variant | All three pillars go green. The conflict strip clears. |

**Timing target:** step 1 → step 8 in under five minutes with no dead air.

---

## 3. The three pillars, and what each actually computes

Pillar names come from the capabilities document and must not be renamed in the UI.

### Pillar 1 — Surgeon & Anesthesia Relationships
*Question it answers: does this decision put the time where the demand is?*

| Metric | Definition | Source (live) |
|---|---|---|
| True utilization | Utilization across the full surgical day, crediting volume outside assigned block windows | `V4_BlockResultsView` + case records |
| Block utilization | In-window utilization, for contrast with true utilization | `V4_BlockResultsView` (`Total_Prime_Time / blockTime`) |
| Receiving-service pipeline | Forward booked cases vs. trailing-4-week baseline | `/api/orserviceline/pipeline` (`vs_baseline_pct`, `n_cases`) |
| Pipeline coverage | Of the hours moved, how many the receiving service's pipeline can actually fill | derived |
| Strategic goal weight | Tenant-configured growth priority of the receiving service | Open Time `goals` store |

Deliberate contrast to surface in the UI: show **block utilization and true utilization
side by side**. Competitors report the first. The gap between them is the argument.

### Pillar 2 — Staffing & Operational Management
*Question it answers: can we actually staff the room we just filled?*

| Metric | Definition | Source |
|---|---|---|
| Room-hours required | Case volume × predicted duration incl. turnover, by day and room | `V4_FORECAST_COMPILE`, case history |
| Coverage delta | Required room-hours minus the configured staffing plan for that day/shift | derived vs. config |
| Past-shift exposure | Room-hours projected to run past shift end | derived |
| Overtime exposure | Past-shift room-hours × coverage ratio, in hours/week | derived |
| Concurrency peak | Max simultaneous rooms running, by hour | `DS_RR` (NHS only — see §7) |

**Data honesty:** room-hours and concurrency are derivable from existing data today.
The *staffing plan* to compare against is not in any tenant DB. It is tenant
configuration (§6), seeded with a sensible default. Do not fabricate an FTE model.

### Pillar 3 — Physical Infrastructure & Capital Investment
*Question it answers: where does this volume land after the case ends?*

| Metric | Definition | Source |
|---|---|---|
| Inpatient conversion rate | % of cases in a service line admitting as inpatient | `DS_CASES` → `DS_Encounters` |
| Projected admissions delta | Change in surgical admissions per day from the decision | derived |
| Receiving-unit pressure | Projected occupancy on the units this case mix lands in, by day | `DS_Occupancy`, `DS_Bedplacement`, `V4_Inpatient_Forecast_Compile` |
| Headroom | Unit capacity minus projected census on the affected days | derived |
| Suite/room capability fit | Whether the receiving service can use the room (robotics, specialty suite) | tenant config |

This pillar is **the single most differentiating panel on the page**. It is the one
thing no competitor in the category can show, because their OR and inpatient products
are separate lines.

---

## 4. Scenario evaluation engine

New module: **`lib/isscmScenario.js`**. Mirrors `lib/releaseRisk.js` deliberately —
same philosophy, same output shape, same "the weights *are* the explanation" stance.

```js
// evaluate(baseline, decision, cfg) -> ScenarioResult
{
  scenarioId: 'ollh-thu-ortho-reallocate',
  decision: { kind: 'REALLOCATE', fromBlock, toService, hours, dayOfWeek, weeks },
  pillars: {
    surgeon: {
      status: 'improves',              // improves | neutral | degrades
      headline: { label: 'True utilization', before: 61.4, after: 78.2, unit: '%' },
      secondary: [ { label, before, after, unit } ],
      drivers: [ { key, label, contribution, direction, detail } ],
    },
    staffing:  { /* same shape */ },
    capacity:  { /* same shape */ },
  },
  conflicts: [
    { pillars: ['staffing','capacity'],
      severity: 'high',
      summary: 'Utilization improves but Thursday coverage and 5C occupancy both degrade.' }
  ],
  alternatives: [ { scenarioId, label, pillarStatuses, summary, delta } ],
}
```

**Rules for the engine**

- Every `drivers[]` entry carries a numeric `contribution` and a human `detail` string.
  The UI renders these directly; no second copy of the reasoning anywhere.
- **Never collapse the three pillars into one composite score.** A single number is
  exactly the thing this page exists to argue against. `conflicts[]` is how disagreement
  is expressed.
- `status` thresholds live in tenant config, not in code.
- The engine is pure: `(baseline, decision, cfg) -> result`, no I/O, no DB handles.
  This keeps it unit-testable and makes the mock/live swap in §5 a one-line change.

---

## 5. Data strategy — mock now, live later, same shapes

This is the part most likely to be built wrong. **The mock is not a fixture file the
UI reads directly.** The mock supplies *inputs* to the real engine, in exactly the shapes
the live queries will return. The engine, the API contract, and the UI are identical in
both modes.

```
  mock mode:  isscm_baselines.json  ─┐
                                     ├─► lib/isscmScenario.evaluate() ─► /api/isscm/* ─► UI
  live mode:  tenant SQL queries    ─┘
```

**Mock file:** `public/data/<tenant>/isscm_baselines.json`, served through the same
sanitized per-tenant directory resolution `routes/atlas.js` already implements
(`tenantDataDir()` — reuse it, do not write a second path resolver).

Mode selection follows the existing tenant-feature pattern rather than an env var:
`config/tenantColumns.json` gains `features.isscm_source: "mock" | "live"`.

**Mock file schema** (one entry per demo scenario):

```jsonc
{
  "generatedAt": "2026-08-24T00:00:00Z",
  "site": "Our Lady of Lourdes Hospital",
  "horizonWeeks": 4,
  "staffingPlan": {                      // what Pillar 2 compares against
    "MON": { "roomHours": 72, "shiftEndHour": 17, "coverageRatio": 2.4 },
    "TUE": { "roomHours": 72, "shiftEndHour": 17, "coverageRatio": 2.4 }
    /* … */
  },
  "units": [
    { "unit": "5C", "capacity": 32,
      "projectedCensus": { "MON": 27, "TUE": 26, "WED": 29, "THU": 30, "FRI": 30 } }
  ],
  "services": [
    { "service": "Orthopedics",
      "avgCaseMins": 118, "turnoverMins": 27,
      "inpatientConversionPct": 34,
      "pipelineVsBaselinePct": -4, "pipelineCases": 41,
      "strategicWeight": 3,
      "receivingUnits": [ { "unit": "5C", "sharePct": 62 } ] }
  ],
  "blocks": [
    { "blockId": "ollh-thu-ortho",
      "site": "Our Lady of Lourdes Hospital",
      "caseBlock": "Ortho A", "service": "Orthopedics",
      "dayOfWeek": "THU", "allocatedHours": 8,
      "blockUtilPct": 58.1, "trueUtilPct": 61.4,
      "trailingWeeks": 8 }
  ],
  "scenarios": [
    { "scenarioId": "ollh-thu-ortho-reallocate",
      "label": "Reallocate 4 of 8 Thursday hours from Ortho A to Spine",
      "rationale": "Ortho A has run 61% true utilization for 8 weeks; Spine pipeline is +38% vs baseline",
      "decision": { "kind": "REALLOCATE", "blockId": "ollh-thu-ortho",
                    "toService": "Spine", "hours": 4, "dayOfWeek": "THU" },
      "alternatives": [
        { "scenarioId": "ollh-tue-ortho-reallocate",
          "label": "Same reallocation on Tuesday",
          "decision": { "kind": "REALLOCATE", "blockId": "ollh-thu-ortho",
                        "toService": "Spine", "hours": 4, "dayOfWeek": "TUE" } }
      ] }
  ]
}
```

**Mock generator:** `scripts/generate_isscm_mock.py`, following the conventions of the
existing `*_pipeline.py` scripts. It must be deterministic (fixed seed) so the demo is
reproducible, and it must produce a dataset in which **the headline scenario genuinely
conflicts and the Tuesday alternative genuinely resolves** — do not hand-write the
verdicts, let the engine derive them from the numbers. If the engine does not produce
the conflict on its own, the numbers are wrong, not the engine.

Generate mock files for **both** `nhs` and `ohs` so tenant switching is demoable.

---

## 6. API surface

Module-style router factory matching every other router in `routes/`:

```js
const isscmRouter = require('./routes/isscm')(getTenantPool, sql, requireTenant);
app.use('/api/isscm', isscmRouter);
```

```
GET  /api/isscm/baseline?site&horizonWeeks
       → { site, horizonWeeks, pillars: {...baseline states}, blocks[] }

GET  /api/isscm/scenarios?site
       → [ { scenarioId, label, rationale, blockId, pillarPreview } ]

GET  /api/isscm/scenarios/:scenarioId
       → full ScenarioResult (§4), including conflicts[] and alternatives[]

POST /api/isscm/evaluate      { decision: {...} }
       → ScenarioResult for an ad-hoc decision (powers the levers in §7)

GET  /api/isscm/config        → thresholds, staffing plan, strategic weights
PUT  /api/isscm/config        → admin-only update
```

Non-negotiables, same as the rest of the codebase:

- Every query goes through `getTenantPool(req.session.tenantId)`. No cross-tenant reads.
- All SQL parameterized via `.input(...)`. No interpolation of user input.
- Generic client-facing errors; detail logged server-side only.
- `scenarioId` is validated against the tenant's own scenario list before use in any
  path or query — never trusted as a path fragment.

---

## 7. Multi-tenant handling

Follow `config/tenantColumns.json` and `utils/tenantColumns.js`. Never hardcode a column,
hospital filter, or status code.

- `SERVICE_LINE` resolves through `resolveColumn(tenantName, 'SERVICE_LINE')` —
  it is `ENC_HOSPITALSERVICE` on OHS, and `SERVICE_LINE_2/3` are `null` there.
- Site filtering uses `getParam(tenantName, 'hospital_filter')`, which is `null` on OHS.
- Case-posted status uses `getParam(tenantName, 'case_posted_value')` — `"Posted"` on NHS,
  `"2"` on OHS.

**OHS is missing `DS_RR`, `DS_ORDER_QUESTIONS`, `DS_Orders`.** Concurrency peak in
Pillar 2 depends on `DS_RR`. On OHS the page must **degrade, not crash**: omit the
concurrency driver, keep the rest of Pillar 2, and render an inline note on that one
metric — never an error state on the whole pillar.

New feature flags in `config/tenantColumns.json`:

```jsonc
"features": {
  "isscm": true,                    // ScenarioPanel + Evaluate buttons available
  "isscm_source": "live",           // "live" (Demo tenant / real tenants) | "mock" (offline fallback)
  "isscm_concurrency": true         // false on OHS — no DS_RR
}
```

`features.isscm` gates the **Evaluate impact** buttons and the panel itself — a
tenant without it sees the host pages exactly as they are today. (The generic
`requiresFeature` nav-filtering mechanism moves to the nav-restructure spec, where
the ISSCM group itself needs it.)

---

## 8. Frontend

**New component (no page, no route, no nav entry):**
`client/src/components/ScenarioPanel.jsx` — a full-height drawer (the compose-drawer
idiom from Open Time is the closest existing primitive) opened by an **Evaluate
impact** button on host pages.

**Host pages and their entry points:**

| Host page | Entry point | Decision passed to the panel |
|---|---|---|
| Release Time Mgmt (`OpenTimeRadar.jsx`) | "Evaluate impact" on a radar row | `REALLOCATE` / `RELEASE` for that block instance |

Release Time Mgmt is the only host. Two rows have been removed from this table:

- **Block Allocations** briefly hosted the panel and no longer does
  (`BlockAllocationsFixes.md` §3). A committee reviewing the allocated grid
  wants evidence for the numbers in front of them, not a simulation; that page's
  row action is now **See details**, a drawer showing the week shape, the day
  table and the forward book.
- **OR Smoothing** and **Staffing** never became pages — both were absorbed into
  **Volume Impact**, which deliberately does not host the panel (`VolumeImpact.md`
  §7): it shows what the forecast already implies, not what a proposed change
  would do.

The panel is decision-agnostic: it receives `{ decision }`, calls the API, renders
the result. Host pages own how decisions are proposed; the panel owns how they are
judged. That separation is the architecture claim made literal.

**Layout (inside the drawer)**

```
┌──────────────────────────────────────────────────────────────────┐
│  Decision summary · site · horizon                    [ close ]  │
├──────────────────────────────────────────────────────────────────┤
│  CONFLICT STRIP    (only when conflicts[].length > 0)            │
├────────────────────┬────────────────────┬────────────────────────┤
│ 1 SURGEON &        │ 2 STAFFING &       │ 3 INFRASTRUCTURE &     │
│   ANESTHESIA       │   OPERATIONS       │   CAPACITY             │
│                    │                    │                        │
│ True util          │ Coverage delta     │ Admissions delta       │
│ 61.4 → 78.2  ▲     │ +1.4 rm-hr   ▼     │ +2.6/day       ▼       │
│                    │                    │                        │
│ [ drivers ▾ ]      │ [ drivers ▾ ]      │ [ drivers ▾ ]          │
├────────────────────┴────────────────────┴────────────────────────┤
│  ALTERNATIVES — ranked variants, all-green first                 │
└──────────────────────────────────────────────────────────────────┘
```

**Conventions to reuse** (do not invent new primitives):

- `MultiSelect` for site and service filters.
- Card-table styling and the green/red variance coloring from `ORPerformance.jsx`.
- The expandable driver/reasoning panel from `OpenTimeRadar.jsx` — same visual idiom,
  same `{ label, contribution, detail }` payload.
- Tokens and utility classes from `client/src/index.css`. No new color literals.

**Status encoding:** `improves` / `neutral` / `degrades` must read at a glance from
**shape as well as color** — an arrow plus a chip, not color alone. A periop VP will
be looking at this on a projector.

**Conflict strip** is the emotional centerpiece. It states plainly how many pillars
improve and which degrade. It is never dismissed automatically and never softened into
an aggregate score.

---

## 9. Acceptance criteria

- [ ] On the Demo tenant, "Evaluate impact" on the ST-1 radar row opens the panel in
      baseline state without leaving the page.
- [ ] Selecting the headline scenario updates all three pillars from a single
      `/api/isscm/scenarios/:id` response.
- [ ] The conflict strip appears for the headline scenario and names the two
      degrading pillars.
- [ ] Every headline metric expands to at least two drivers with numeric
      contributions and readable `detail` strings.
- [ ] The Tuesday alternative clears all three pillars to `improves` or `neutral`
      and the conflict strip disappears.
- [ ] Conflicts and statuses are **derived by `lib/isscmScenario.js`**, not stored
      in the mock file. Editing a number in the mock changes the verdict.
- [ ] Switching to OHS renders the page with the concurrency driver omitted and an
      inline note — no error, no blank pillar.
- [ ] `features.isscm: false` removes every Evaluate button and the `/api/isscm/*`
      routes return 404 — host pages render exactly as they do today.
- [ ] Unit tests on `lib/isscmScenario.js` cover: improves-all, mixed-conflict,
      degrades-all, and missing-concurrency-input.
- [ ] No cross-tenant read anywhere; all SQL parameterized; no secrets or PHI in
      mock files or committed JSON.
- [ ] Step 1 → step 8 of §2 completes in under five minutes with no loading stalls
      longer than one second.

---

## 10. Explicitly out of scope

- Writing anything back to Epic or any OR system. This page **recommends**; it does
  not transact. That boundary is the positioning (see the demo positioning material)
  and must not be blurred to make the demo flashier.
- Emailing surgeons or practices. That loop lives in Open Time.
- A composite "ISSCM score." Deliberately excluded — see §4.
- Real staffing/FTE modeling beyond room-hours vs. a configured plan.
- Per-tenant Atlas/EBM models. Separate effort, tracked elsewhere.

---

## 11. Phasing

**Phase 1 — engine + panel on the Demo tenant (demo-ready).**
`lib/isscmScenario.js`, `routes/isscm.js` querying the seeded Demo DB,
`ScenarioPanel.jsx`, Evaluate button on `OpenTimeRadar.jsx`, feature flag. This is
the whole demo. (`scripts/generate_isscm_mock.py` only if the offline fallback is
ever wanted.)

**Phase 2 — live Pillar 1.**
Swap Pillar 1 inputs to live queries against `V4_BlockResultsView`,
`V4_FORECAST_COMPILE`, and `/api/orserviceline/pipeline`. Engine and UI unchanged.

**Phase 3 — live Pillar 2.**
Room-hours and concurrency from live data; staffing plan stays configuration.

**Phase 4 — live Pillar 3.**
The real work: an OR case → inpatient admission → receiving unit pipeline joining
`DS_CASES`, `DS_Encounters`, `DS_Bedplacement`, `DS_Occupancy` and
`V4_Inpatient_Forecast_Compile`. This is also the foundation for surgical smoothing.

**Phase 5 — ad-hoc levers.**
`POST /api/isscm/evaluate` wired to interactive controls so leadership can pose their
own decisions rather than choosing from a curated list.

---

## 12. Open decisions

1. **Which site and service pair headlines the demo.** The spec assumes OLLH Thursday
   Ortho → Spine. Confirm this reflects a real, recognizable pattern at the prospect
   before the mock is generated — a scenario the room recognizes is worth more than a
   clean one.
2. **Staffing plan defaults.** Where do the seed `roomHours` / `coverageRatio` values
   come from for a tenant with no configured plan?
3. **Unit mapping.** Is service-line → receiving-unit share available from
   `DS_Bedplacement` history at usable fidelity, or is it configuration for v1?
4. **Which host pages carry the Evaluate button at launch.** Release Time Mgmt is
   Phase 1; Smoothing and Staffing add theirs in their own specs. Decide whether
   Block Utilization also earns one (a leadership user's natural starting point).
5. **Panel deep-linking.** Whether a panel state gets a shareable URL (e.g.
   `?evaluate=<scenarioId>`) so a demo driver can jump straight to the finale —
   nice insurance for live demos; cheap if decided early.

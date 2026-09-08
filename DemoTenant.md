# Demo Tenant — "Bright Memorial Health"

> **Status:** Spec — ready to build
> **Owner:** Kartheek (product) · Hakan (one Azure task, §9) · Claude Code (everything else)
> **Last updated:** 2026-08-24
> **Purpose:** a third tenant whose database is fully synthetic, engineered so the
> head-to-head demo (Core → Driver Analyses → ISSCM/Predictive → Integration finale)
> runs on the **real app through the real tenant plumbing** with authored, repeatable,
> client-data-free numbers.
>
> **This spec covers data, schema, seeding, config, and provisioning only.**
> Frontend features (OR Smoothing, Staffing, Briefs extension, Financials, ISSCM
> Integration View) are separate specs; this document guarantees the tables they read
> will exist and contain the right stories. See `ISSCMIntegrationView.md` for the
> finale's engine; other feature specs to follow.
>
> **Related:** `CLAUDE.md`, `ISSCMIntegrationView.md`, `pipeline_config.py`,
> `config/tenantColumns.json`, `routes/admin.js` (tenant CRUD), `lib/openTimeStore.js`

---

## 1. Principles

1. **Mock data, real plumbing.** The demo tenant is a row in the NuraOps `Tenants`
   table pointing at a real Azure SQL database with the production schema. Every
   existing page runs its existing queries unmodified. Nothing in the app knows the
   word "demo."
2. **No client data, ever.** Not one row is copied from Virtua or OHS. Realism comes
   from **fitted distribution parameters** (§6.1) — shapes, not records.
3. **Authored, deterministic, reconciled.** The seed is generated from a fixed RNG
   seed. The demo storylines (§4) are engineered into the numbers, and every page
   that touches a storyline must tell the same story — the cross-checks in §10 are
   the definition of done.
4. **NHS and OHS untouched.** No demo artifacts land in client tenants. (The existing
   junk under tenant `2` in `.opentime-demo.json` is cleaned separately — §8.4.)

---

## 2. Tenant identity

| Item | Value |
|---|---|
| System name | **Bright Memorial Health** |
| Tenant key in `tenantColumns.json` | `Demo` |
| Database | `Demo` on `brighthospital.database.windows.net` |
| Sites | **Bright Memorial Hospital** (main, 9 ORs) · **Bright Surgery Center** (ASC, 4 ORs) |
| Inpatient units | 5 Central (med-surg, 32 beds), 4 East (med-surg, 28), 3 West (tele, 24), ICU (16), Stepdown (12) |
| Services (10) | Orthopedics, Spine, General Surgery, Urology, GYN, ENT, Plastics, Vascular, Colorectal, Robotics-General |
| Surgeons | ~48, fictional (§3), volume-weighted panel |
| Blocks | Service-lettered, matching existing `CaseBlock` conventions: `Ortho A`, `Ortho B`, `Spine`, `Uro/Gyn`, `Robotics 1`, `General A`, … (~16 block lines across both sites) |
| History window | 13 full months back from seed date (trailing windows and YoY trends work) |
| Forward window | 6 weeks of schedule/forecast rows (`DaysAhead` populated so the radar's 14–35-day band is full) |

### Naming rules

- **All person and organization names are fictional.** Surgeon names come from a
  name-parts generator inside the seeder (first/last lists combined by the seeded
  RNG) — never from any real roster, never hand-picked from memory.
- Final gate before first demo: sanity-check the generated surgeon list and system
  name against the prospect's market (a real "Bright Memorial" health system or a
  real surgeon with a matching name in their region means regenerate with a new seed
  or swap the name lists).
- Unit, room, and block names follow the conventions the app already renders so
  screenshots look native, not invented.

---

## 3. Surgeon & block roster (seeder-generated, committed as JSON)

The seeder first emits `scripts/demo/roster.json` (surgeons, blocks, rooms, units,
service→unit mapping) and then generates all facts from it. The roster is
**committed** so storyline references ("Dr. Vance", "Ortho A") are stable across
reseeds and demo rehearsals.

Roster requirements:

- Volume distribution: top ~8 surgeons carry ~45% of volume (fitted, §6.1).
- Each storyline (§4) names its cast in the roster file (e.g. the chronically-light
  Thursday block owner; the high-add-on FCOT offender; the Spine surgeon with the
  surging pipeline). These are ordinary roster entries flagged with a
  `storyline: "<id>"` field so the generator knows to bend their numbers.
- Robotic room(s) exist at the main site so Robotics-General cases and the robot
  turnover story have somewhere to live.

---

## 4. Engineered storylines

Each storyline lists: the pages it must light up, the mechanism in the data, and its
reconciliation rule. The generator produces these **by construction**; nothing is
patched into outputs afterward.

### ST-1 · The Thursday Ortho block (release + ISSCM finale headline)
- **Pages:** Release Radar, Block Utilization, Briefs, ISSCM Integration View.
- **Mechanism:** `Ortho A` at Bright Memorial Hospital, Thursdays, 8h allocated.
  Trailing 8 weeks: block utilization ~58%, true utilization ~61% (some out-of-block
  volume). Forward forecast fill for the next 4 Thursdays: 35–55%. Historical
  `ReleasedTime > 0` on ~1 in 4 instances.
- **Counterweight:** Spine service forward pipeline **+38% vs trailing baseline**
  (booked cases in `V4_FORECAST_COMPILE`), so the radar's reallocation candidate
  ranking has an obvious #1.
- **Reconcile:** the same block instance numbers must appear on Block Utilization
  (trailing), Release Radar (forward + drivers), and the ISSCM baseline.

### ST-2 · The Wednesday 5 Central peak (smoothing headline)
- **Pages:** OR Smoothing / Census Footprint, IP Forecast, ISSCM Integration View.
- **Mechanism:** Monday+Tuesday inpatient-heavy Ortho/Spine scheduling (high
  conversion, LOS mode 2–3 days) stacks census onto Wednesday: 5 Central projected
  ~30/32 Wednesdays, with **~28% of Wednesday census attributable to scheduled OR
  admissions** (the rest ED + transfers). ≥2 "crunch days" per typical week at
  baseline.
- **Counterweight:** Thursday/Friday elective inpatient volume is light, so a
  smoothing scenario (shift part of Tuesday joints to Thursday) visibly flattens the
  curve and cuts crunch days.
- **Reconcile:** `DS_Bedplacement` + `DS_Occupancy` history, the OR-admissions
  columns of `V4_Inpatient_Forecast_Compile`, and the smoothing page's attribution
  must all derive from the same case→admission→unit chain.

### ST-3 · The 15:30 staffing cliff and the Friday flex-down (staffing headline)
- **Pages:** Staffing Analyses, Room Running.
- **Mechanism:** staffing plan (`StaffingPlan`, §5.2) staffs 9 rooms 07:00–15:30
  Mon–Fri at the main site. Demand shape from generated cases: Tue–Thu, 3–4 rooms
  still running at 15:30 (overtime exposure ~10–14 room-hours/week); Friday demand
  peaks at 6 rooms with a lighter average across the day, leaving idle staffed
  room-hours **materially high — on the order of 45–50/week** at the default plan.
  *(Rev note 2026-08-24: the original "~12/week" figure was arithmetically wrong —
  9 staffed rooms × 8.5h against a 6-room-peak day necessarily idles far more.
  The storyline's point is the visible gap, not a precise figure; verify against a
  ≥25 room-hour threshold, not a point target.)*
- **Reconcile:** the hour-of-day room concurrency implied by `DS_RR` must equal what
  the generated `DS_CASES` in/out times produce — `DS_RR` is derived from cases, not
  generated independently.

### ST-4 · The teachable FCOT driver (EBM story)
- **Pages:** Atlas FCOT Drivers, Performance Briefs, Ask Nura.
- **Mechanism:** first-case delays concentrated where (a) the case is an add-on,
  (b) service is Spine, (c) Mondays — injected as genuine effects in the generated
  timestamps so the **retrained** EBM (§7) surfaces them as top features with clean
  shape functions. One named surgeon is the visible outlier.
- **Reconcile:** the EBM's top-3 features must match what a human sees filtering the
  cases table; Briefs must narrate the same offender.

### ST-5 · The robot room turnover story (EBM story #2)
- **Pages:** Atlas Turnover, Room Running.
- **Mechanism:** turnover intervals longer for robotic cases when the *next* case is
  a different surgeon, and in `Robotics 1` specifically — again injected as real
  effects for the retrained model.

### ST-6 · The Tuesday resolution (finale)
- **Pages:** ISSCM Integration View.
- **Mechanism:** the ST-1 reallocation evaluated on Thursday **conflicts** (staffing
  cliff ST-3 worsens; 5C pressure ST-2 rises). The same reallocation on **Tuesday**
  clears all three pillars: Tuesday has staffing headroom and 5C headroom by
  construction.
- **Reconcile:** this must fall out of the engine (`lib/isscmScenario.js`) reading
  seeded data — per the ISSCM spec, verdicts are derived, never stored. If the
  conflict doesn't emerge, the seed numbers are wrong, not the engine.

### ST-0 · Everything else is boringly plausible
Volumes, prime-time utilization (low-70s%), FCOT (~68–74%), median turnover
(~45 min), ASA mix, add-on rate (~12%), cancellation rate — all fitted (§6.1), no
drama. The storylines read as signal *because* the background is quiet.

---

## 5. Schema

### 5.1 Replicated tables (structure identical to Virtua)

Manifest — every table the app routes and Python pipelines read (verified by grep,
2026-08-24): `DS_CASES`, `DS_Encounters`, `DS_Bedplacement`, `DS_Occupancy`,
`DS_RR`, `V4_BlockResultsView`, `V4_FORECAST_COMPILE`,
`V4_Inpatient_Forecast_Compile`.

- **DDL is extracted, not hand-written.** `scripts/demo/extract_schema.py` connects
  read-only to Virtua, reads `INFORMATION_SCHEMA.COLUMNS` for the manifest, and
  emits `scripts/demo/create_demo_schema.sql`. Structure drift is impossible.
- **The `V4_*` objects become plain tables in Demo.** They are views in Virtua;
  nothing in the app writes to them, so the seeder populates them directly and we
  skip replicating view logic. The extract script uses the view's column metadata
  (`INFORMATION_SCHEMA` covers views identically).
- `DS_ORDER_QUESTIONS` / `DS_Orders` are not read by any current route or pipeline —
  **excluded** until something needs them.
- NuraOps (`Users`, `Tenants`, `UserTenants`) is not touched by this spec except via
  the Admin UI in §9.

### 5.2 New tables (Demo-first; future tenants get them when the features go live)

These serve the ISSCM feature set. Creating them here, populated by the same seeder,
is the point of folding the concepts into this spec.

```sql
StaffingPlan        -- pillar 2: the "rectangle" demand is compared against
  Site NVARCHAR(100), DayOfWeek TINYINT,        -- 1=Mon
  ShiftStart TIME, ShiftEnd TIME,
  StaffedRooms INT, CoverageRatio DECIMAL(4,2),
  PRIMARY KEY (Site, DayOfWeek, ShiftStart)

UnitCapacity        -- pillar 3: headroom denominator
  Unit NVARCHAR(100) PRIMARY KEY,
  LevelOfCare NVARCHAR(50), StaffedBeds INT

ServiceUnitMap      -- case mix → where it lands
  Service NVARCHAR(100), Unit NVARCHAR(100), SharePct DECIMAL(5,2),
  PRIMARY KEY (Service, Unit)   -- shares per service sum to 100
```

**Decisions recorded here:**
- Briefs misalignment target = single tenant param (`block_fill_target: 75`) in
  `tenantColumns.json` — no `BlockTargets` table for v1 (same pattern as the Open
  Time thresholds). Revisit if per-block expectations become a demo point.
- **`CaseFinancials` is parked** pending Hakan's financial content. The seeder
  reserves a hook (`generate_financials(roster, cases)` stub, no-op) so it slots in
  without touching the generation order. Schema lands in the Financials feature spec.

---

## 6. Seed generator

`scripts/demo/seed_demo_tenant.py` — Python, alongside the existing `*_pipeline.py`,
run from the local machine against the Demo DB (`.venv`, ODBC Driver 17, credentials
via `.env` — never committed).

### 6.1 Distribution fitting (runs against Virtua, read-only, once)

`scripts/demo/fit_distributions.py` reads Virtua and writes
`scripts/demo/demo_distributions.json` — **parameters only, no rows**: case-duration
lognormal params by service; DOW volume shape; add-on and cancellation rates; ASA
mix; inpatient conversion rate by service; LOS distribution by service; discharge
hour-of-day shape; ED admission volume shape. The JSON is committed (it contains
aggregate shapes, nothing identifiable). The seeder consumes it, then bends specific
slices per §4.

### 6.2 Generation order (each stage feeds the next; nothing generated twice)

```
roster.json  →  calendar (13mo back, 6wk fwd, holidays)
  →  block template (weekly grid per site)
  →  DS_CASES            (scheduled + actual times; storyline bends applied here)
  →  DS_Encounters       (admissions from conversion; LOS; disposition)
  →  DS_Bedplacement     (encounter → unit via ServiceUnitMap + jitter)
  →  DS_Occupancy        (daily census by unit = admissions − discharges, + ED base load)
  →  DS_RR               (hourly rooms-running derived from DS_CASES in/out times)
  →  V4_BlockResultsView (aggregated from cases vs block template, incl. ReleasedTime)
  →  V4_FORECAST_COMPILE (forward rows w/ DaysAhead; ST-1 fill gaps; Spine surge)
  →  V4_Inpatient_Forecast_Compile (unit-level census/forecast incl. OR-admission windows)
  →  StaffingPlan, UnitCapacity, ServiceUnitMap (from roster + §4 values)
```

Derivation rules that make reconciliation automatic: `DS_RR` and both `V4_*` OR
views are **computed from the generated cases**, exactly as the real pipelines
compute them from real cases. The seeder re-implements only the arithmetic those
views encode (fill %, utilization, released time) — sanity-check the formulas
against `OROpenTime.md` §2 (`% Filled = TotalDurwTurn / BlockTime`,
util = `Total_Prime_Time / blockTime`).

### 6.3 Operational properties

- `--seed 42` default; same seed ⇒ byte-identical database. `--reseed` truncates and
  reloads everything (idempotent; safe because nothing else writes to Demo).
- `--anchor-date` defaults to today: all dates generated relative to it, so
  re-running the week of the demo makes "next Thursday" genuinely next Thursday.
  **Run a reseed + pipeline refresh (§7) in demo week.**
- Row scale (target): ~30–35k `DS_CASES` rows, ~9–10k encounters, ~400 days ×
  5 units of occupancy, ~110k `DS_RR` hourly rows. Minutes to load, not hours.

---

## 7. Pipelines & Atlas models

- Add to `pipeline_config.py`:
  ```python
  'demo': { ..connection to Demo db.., 'output_dir': os.path.join('public','data','demo') }
  ```
- Run **all** existing pipelines with `--tenant demo` after every reseed:
  FCOT, turnover, bed placement, DO→DC, LOS segments, performance briefs.
  Commit the generated `public/data/demo/*.json`.
- **Model quality gate:** the retrained FCOT EBM must rank the ST-4 features in its
  top 3 with monotonic-looking shape functions, and turnover likewise for ST-5. If
  not, strengthen the injected effect sizes in the seeder — never edit model JSON.
- Note: Ask Nura currently reads model JSON from the `public/data/` root — broken
  for all tenants since the per-tenant move, tracked as the P0 in the demo cleanup
  work. The demo tenant **requires** that fix (point reads at `tenantDataDir`) for
  Ask Nura to answer model questions as Bright Memorial.

---

## 8. App configuration (all repo-side, no code changes to pages)

### 8.1 `config/tenantColumns.json` — add:

```jsonc
"Demo": {
  "columns": { "SERVICE_LINE": "SERVICE_LINE",
               "SERVICE_LINE_2": "SERVICE_LINE_2",
               "SERVICE_LINE_3": "SERVICE_LINE_3" },
  "params":  { "hospital_filter": null,            // both Bright sites visible
               "case_posted_value": "Posted",
               "block_fill_target": 75 },
  "features": { "tdc": true, "service_line_drill": true }
}
```

NHS-shaped on purpose: every feature lights up, including Room Running (`DS_RR`
exists in Demo, unlike OHS).

### 8.2 Case status & vocabulary
Seeder writes `CaseLogStatus = 'Posted'` and NHS-style code vocabularies throughout,
so even the (to-be-fixed) hardcoded queries behave.

### 8.3 Open Time workflow state
`lib/openTimeStore.js` keys by TenantID — the demo tenant gets its own clean bucket
automatically. Seed it via a small `scripts/demo/seed_opentime_store.js`: 4–6
coherent requests referencing ST-1's block and roster practices (realistic practice
emails like `ortho-scheduling@brightmemorial.demo`), one released slot with ranked
candidates led by the Spine surge. Delete nothing from other tenants here (cleanup
of tenant 2's junk entries stays in the cleanup workstream).

### 8.4 Explicitly out of scope for this spec
Frontend nav restructure (Forecasts → ISSCM group) and the five feature builds;
the Ask Nura path/`Posted` fixes and orphan-mock deletion (tracked separately as
demo cleanup); purging the old xlsx from git history (pre-existing note in
`CLAUDE.md`).

---

## 9. Provisioning runbook

**Ask Hakan for exactly this (one sitting, ~15 minutes — he owns all Azure and
tenant administration):**

> 1. Create an empty database `Demo` on `brighthospital.database.windows.net`
>    (same tier as OHS is fine) and a SQL login/user `demo_app` with `db_owner`
>    on `Demo` only.
> 2. Register the tenant **through the app's Admin page** (so the password is
>    stored encrypted via `lib/secrets` — not a hand SQL insert): name
>    **Bright Memorial Health**, server `brighthospital.database.windows.net`,
>    database `Demo`, user `demo_app`.
> 3. Create a dedicated demo login (e.g. `demo@nuraops.com`) mapped **only** to
>    the Bright Memorial tenant (so a projector never shows client tenant names
>    in the switcher), and map Kartheek's user to it as well.
> No schema, no data, no pipeline work — all of that is scripted on the feature
> branch and run by Kartheek. Until seeding runs, the tenant simply shows empty
> pages — harmless.

**Then (Kartheek, from the local machine):**

1. `git checkout -b feature/demo-tenant` — build lands here; PR → Hakan merges.
2. `python scripts/demo/extract_schema.py` → review → run
   `create_demo_schema.sql` against Demo.
3. `python scripts/demo/fit_distributions.py` (reads Virtua, read-only).
4. `python scripts/demo/seed_demo_tenant.py --seed 42`.
5. Run all pipelines `--tenant demo`; commit `public/data/demo/`.
6. `node scripts/demo/seed_opentime_store.js`.
7. Log in as the demo user → switch tenant → run the smoke checklist (§10).

Demo-week refresh: repeat 4–6 with the same seed (anchor date moves forward).
Hakan's three tasks never repeat.

---

## 10. Acceptance criteria

**Every existing page** renders on Bright Memorial with plausible, dense data:
Case Volumes, Prime Time, Block Utilization, Room Running, Actual vs Budget,
Service Lines, Sched Forecast Daily/Detail, all three OR Atlas pages, Ask Nura
(post-fix), Open Time ×3, and the four IP pages + IP Forecast. No empty states, no
errors, no obviously synthetic artifacts (uniform gaps, identical durations,
sequential names).

**Storyline reconciliation (the real test):**
- [ ] ST-1: Block Utilization trailing %, Radar forward fill + drivers, and the
      ISSCM baseline all show the same Ortho A Thursday numbers.
- [ ] ST-2: Wednesday 5 Central census in `DS_Occupancy` history ≈
      `V4_Inpatient_Forecast_Compile` projection, and the OR-attributed share is
      ~28% by tracing actual seeded admissions.
- [ ] ST-3: `DS_RR` concurrency at 15:30 Tue–Thu = what `DS_CASES` in/out times
      imply, room for room.
- [ ] ST-4/5: retrained EBMs rank the injected drivers top-3; Briefs names the same
      offenders.
- [ ] Briefs forward layer (`BriefsForwardLayer.md`): Ortho A classifies **ACT,
      ranked #1**; a Spine block classifies **GROW**; Briefs forward-fill % equals
      the Radar's for the same blocks and horizon.
- [ ] ST-6: the engine derives the Thursday conflict and the Tuesday resolution from
      seeded data alone.

**Hygiene:**
- [ ] Same seed ⇒ identical reload. `--reseed` is clean.
- [ ] Zero rows originate from Virtua/OHS (fit params only); no real person or
      health-system names; sanity pass done against the prospect's market.
- [ ] No credentials in the repo; Demo tenant row created via Admin UI only.
- [ ] NHS and OHS behavior byte-identical before/after the branch (config addition
      is additive; no shared code paths modified by this spec).

---

## 11. Open items

1. **Hakan's financial content** → unparks `CaseFinancials` + the Financials
   feature spec; seeder hook is waiting.
2. **"ISSCM" vs "ISSM"** on-screen label — pick one before the nav restructure spec.
3. Prospect-market name sanity check happens once the prospect is confirmed.
4. Whether the demo login is a dedicated user (recommended: `demo@nuraops.com`
   mapped only to the Demo tenant, so a projector never shows client tenant names
   in the switcher).

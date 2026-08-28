# Staffing — the pillar 2 lens

> **Status:** Spec — rev 3, supersedes `StaffingAlignment.md`
> **Owner:** Kartheek (product) · 2026-08-24
> **Renamed:** "Staffing Patterns" → **"Staffing"**. The page holds both the
> structural and the forward view, so "Patterns" under-describes it.
>
> **Rev 3 changes:** the Forward Flex Plan **returns here** (rev 2 moved it to
> the Outlook; the Outlook is now a dispatcher and should not own analysis).
> Adds the **PACU / pre-op implication** — the one thing in this space no
> competitor claims. This page is the complete ISSCM pillar-2 lens: does staffed
> capacity match demand, structurally and forward?
>
> **Related:** `ForwardPlan.md` (dispatches here), `ISSCMIntegrationView.md`
> (Pillar 2 shares `lib/staffingShape.js`), `DemoTenant.md` (ST-3, StaffingPlan)

---

## 1. Four views

### V1 — Shape vs. rectangle (structural, the teaching moment)
Hour-of-day × day-of-week average rooms running (`DS_RR`), with the staffing
plan drawn over it as the literal rectangle. Name the two misalignment regions
on the chart — **overtime exposure** past `ShiftEnd`, **idle staffed hours**
above demand. The vocabulary is the product.

### V2 — Misalignment ledger (structural, the argument)
Idle and overtime room-hours by site and day-of-week, trended.
Header: idle rm-hrs/wk, overtime rm-hrs/wk, alignment %, worst day each way.

**Financials hook, visible and dormant:** a `$` column per row, rendered only
when `staffed_room_hour_cost` is set; otherwise an em-dash with tooltip
*"pricing arrives with Financial Analysis."* The dangling hook is deliberate.

### V3 — Forward flex plan (returned from the Outlook)
Next 2–4 weeks: implied rooms per day (`ceil(Σ TotalDurwTurn ÷ shiftMinutes)`)
vs. planned staffed rooms → `FLEX_DOWN` / `FLEX_UP`.

- Must support **deep-link to a single date**, because Forward Plan dispatches
  here from a specific row (`/staffing?date=2026-09-20`).
- Each flagged day shows its reasoning inline: booked minutes, implied rooms,
  plan.
- **"Evaluate flex"** opens the ScenarioPanel with `FLEX_STAFFING`.
- Under/over are **not symmetric**: being a room short costs late finishes,
  overtime and a cancellation; being a room over costs idle salary. Weight the
  flag thresholds accordingly (`under_weight`, `over_weight` params) and be more
  willing to flag under- than over-staffing. Where a trade-off is quantified,
  express it as *"one room short ≈ X; one over ≈ Y"* rather than a single
  number — far more defensible to a director than a recommendation taken on faith.

### V4 — PACU / pre-op implication (the differentiator) · NEW

Every competitor stops at the OR room. Epic's OR Staffing Analysis covers
nursing and anaesthesia. LeanTaaS's deepest role claim is the word
"specialisation." Qventus does pre-op *patients*, not pre-op *staffing*.
**Nobody converts a volume forecast into downstream perioperative staffing.**

We already forecast by service line, so this needs one config table:

```sql
ServiceRecoveryProfile
  Service NVARCHAR(100) PRIMARY KEY,
  PreOpMins INT,           -- pre-op hold/prep per case
  Phase1Mins INT,          -- PACU phase I
  Phase2Mins INT,          -- phase II / step-down
  BayType NVARCHAR(30)     -- PACU | PHASE2 | BOTH
```

Computation (`lib/recoveryDemand.js`):
1. Take the day's forecast case mix and scheduled/expected start times.
2. Offset each case's OR-out by service to produce a **PACU arrival curve**.
3. Occupy a bay for `Phase1Mins`, then `Phase2Mins` in its bay type.
4. Sum concurrent occupancy by hour → **bay-hours demand by hour**.
5. Compare against `UnitCapacity`-style PACU bay counts (config).

Output: *"Thursday 13:00–17:00 — PACU demand peaks at 11 bays against 9
staffed."* Tier is **always `POTENTIAL`** — we model bay demand, not nurse
ratios, and must not imply otherwise.

Peak PACU pressure feeds Forward Plan as a contributor to the `ADD` state.

---

## 2. Computation rules

One module, `lib/staffingShape.js`, shared by this page, Forward Plan's capacity
input, and the ScenarioPanel's Pillar 2 — a room-hour is the same room-hour
everywhere.

```
idle(h)     = max(0, staffedRooms − roomsRunning(h))   summed over staffed hours
overtime(h) = roomsRunning(h)                          summed past ShiftEnd
impliedRooms(day) = ceil(Σ TotalDurwTurn ÷ shiftMinutes)
```

`lib/recoveryDemand.js` is separate and consumed by V4 and by Forward Plan.

---

## 3. API

```
GET /api/staffing/shape?site&weeks=8
GET /api/staffing/ledger?site&weeks=8
GET /api/staffing/forward?site&weeks=4&date        (date = deep-link)
GET /api/staffing/recovery?site&date               (V4 — bay demand by hour)
```

---

## 4. Tenant reality

- **Demo:** all four views (`DS_RR`, `StaffingPlan`, `ServiceRecoveryProfile`
  all seeded).
- **NHS:** `DS_RR` exists, no `StaffingPlan` → page stays behind
  `staffing: false` until a plan exists. Don't ship half a page to a client.
- **OHS:** no `DS_RR` → flag off. Documented fallback for later: derive
  concurrency from `DS_CASES` in/out times, which the seeder itself proves is
  equivalent.
- V4 requires `ServiceRecoveryProfile`; absent it, the view is omitted, not
  broken.

---

## 5. Acceptance

- [ ] V2 matches `verify.py` ST-3 within rounding: ~12.7 overtime rm-hrs/wk,
      Friday idle ≥25 (~47 actual); V1 shows 3.0–3.2 rooms at 15:30 Tue–Thu.
- [ ] V1's demand shape agrees with Room Running for the same site and window.
- [ ] V3 flags Friday `FLEX_DOWN` (plan 9, implied ~6); deep-linking a date from
      Forward Plan lands on that day; "Evaluate flex" opens the panel and
      Pillar 2's number equals V3's.
- [ ] Under/over thresholds are separately weighted and configurable.
- [ ] V4 produces an hourly PACU bay-demand curve from case mix, peaks where
      the seeded afternoon volume concentrates, and is labelled `POTENTIAL`.
- [ ] `$` cells render only when `staffed_room_hour_cost` is set.
- [ ] No block-pattern analysis and no census modelling on this page.
- [ ] NHS/OHS: flag off → no nav entry, `/api/staffing/*` 404, nothing breaks.

## 6. Seeder work

`ServiceRecoveryProfile` rows for all 10 demo services (ortho/spine long phase I,
cataract/ENT short), plus PACU and phase-II bay counts in `UnitCapacity`. Target
a Thursday-afternoon PACU peak that exceeds staffed bays — storyline **ST-9** —
so V4 has a finding on screen. `verify.py` asserts it.

## 7. Out of scope

Nurse-ratio or FTE modelling; per-role rosters; anaesthesia staffing; editing
`StaffingPlan` in-app (admin CRUD is Phase 2); day-of-surgery.

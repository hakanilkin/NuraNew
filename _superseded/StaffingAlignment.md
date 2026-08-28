# Staffing Patterns — does the template fit the demand?

> **Status:** Spec — rev 2, ready to build
> **Owner:** Kartheek (product)
> **Last updated:** 2026-08-24
>
> **Rev 2 — scope reduced. V3 (Forward Flex Plan) has moved out** to
> `VolumeOutlook.md` (now *Volume & Staffing Outlook*), which merges the forward
> demand view with the forward staffing response so the chain
> `Forecast → Demand Signal → Staffing Implication → Recommended Action` reads in
> a single row. Page renamed from "Staffing" to **"Staffing Patterns."**
>
> **What this page is now:** the *structural* half — trailing 8+ weeks, asking
> whether the staffing template fits the demand pattern at all. Different horizon
> (quarterly, not weekly), different decision (redesign the plan, not flex
> Tuesday), different audience (VP + finance, not charge nurse). V1 and V2 only.
> **Purpose:** the page that answers *"are you paying for staffed rooms when
> demand isn't there, and paying overtime when it is?"* OR staffing is planned as
> a static rectangle (all rooms, 07:00–15:30, five days); demand has a shape by
> hour and day. The gap leaks money in both directions at once: idle staffed
> hours where the rectangle exceeds demand, overtime exposure where demand runs
> past its edge. Qventus has no staffing product; this is ISSCM pillar 2 as a page.
>
> **Demo beats (ST-3):** the 15:30 cliff — 3–4 rooms still running Tue–Thu
> (~12.7 overtime room-hours/week) — and Friday's rectangle staffing 9 rooms
> against a 6-room peak (~47 idle room-hours). Forward view flags Friday to flex.
>
> **Related:** `DemoTenant.md` (ST-3, StaffingPlan), `ISSCMIntegrationView.md`
> rev 2 (ScenarioPanel — third host page; `FLEX_STAFFING` decision), Room Running
> page (`/api/rr/*` — same DS_RR source, must reconcile), `verify.py` ST-3 figures

---

## 1. The three views

### V1 — The Shape vs the Rectangle (the teaching moment)
Hour-of-day × day-of-week average rooms running (from `DS_RR` history), with the
staffing plan (`StaffingPlan`) drawn over it as the literal rectangle.

- One chart per day-of-week (small multiples), hours 06:00–20:00: the demand
  curve filled underneath, the staffed-rooms rectangle outlined on top.
- The two misalignment regions get named shading: demand above the rectangle
  after `ShiftEnd` = **overtime exposure**; rectangle above demand = **idle
  staffed hours**. Label them on the chart — the vocabulary is the product.

### V2 — The Misalignment Ledger (the argument)
Idle staffed room-hours and overtime-exposure room-hours, by site and day-of-week,
trended by week.

- Header stat row: total idle rm-hrs/wk, total overtime rm-hrs/wk, alignment %
  (demand-hours inside the rectangle ÷ staffed-hours), worst day each direction.
- **Financials hook, visible and dormant:** each ledger column gets a `$` cell
  rendered only when tenant param `staffed_room_hour_cost` exists. Until
  financials unpark, it shows an em-dash with tooltip "pricing arrives with
  Financial Analysis." The dangling hook is deliberate — it previews S1's beat.

### V3 — MOVED
The Forward Flex Plan now lives on **Volume & Staffing Outlook**
(`VolumeOutlook.md` §3 and §6), together with the demand forecast that drives
it. Do not build a forward view here; this page has no 2–4 week surface and no
ScenarioPanel entry point.

The structural finding this page produces — *"the template systematically
over-staffs Friday"* — is the durable version of what the Outlook flags week to
week. That's the intended relationship: the Outlook says flex this Friday;
Staffing Patterns says stop staffing Fridays that way.

---

## 2. API surface

Module router factory, mounted at `/api/staffing`:

```
GET /api/staffing/shape?site&weeks=8
      → { days: [ { dow, byHour: [ { h, avgRooms } ],
          plan: { staffedRooms, shiftStart, shiftEnd } } ] }

GET /api/staffing/ledger?site&weeks=8
      → { weeks: [...], byDow: [ { dow, idleRoomHours, overtimeRoomHours } ],
          summary: { idleWk, overtimeWk, alignmentPct, worstIdleDow,
                     worstOvertimeDow } }
```

`/api/staffing/forward` moves to `/api/outlook/flex` (`VolumeOutlook.md` §8).

Computation rules — one lib module (`lib/staffingShape.js`), **shared with the
ISSCM engine's Pillar 2** (same hard requirement as Smoothing's shared lib: the
panel's coverage-delta numbers and this page's ledger must be the same function):

- `idle(h) = max(0, staffedRooms − roomsRunning(h))` summed over staffed hours.
- `overtime(h) = roomsRunning(h)` summed over hours past `ShiftEnd`.
- Forward implied rooms: `ceil(Σ TotalDurwTurn / shiftMinutes)` per day, from the
  same `V4_FORECAST_COMPILE` aggregation the Radar uses.

## 3. Frontend

- `client/src/pages/StaffingPatterns.jsx`, route `/staffing-patterns` (redirect
  `/staffing`), nav label **"Staffing Patterns"**, feature flag `staffing`.
- Conventions: `MultiSelect`, card tables, tokens; charts follow the existing
  recharts idioms. Encode flags by shape + color (projector rule).
- V1's charts are the page's identity — invest the care there; V2 is a table.

## 4. Tenant reality

- **Demo:** everything on (`DS_RR` + `StaffingPlan` both seeded).
- **NHS:** `DS_RR` exists; `StaffingPlan` doesn't → the page could ship V1's
  demand shape with a "no staffing plan configured" empty state for the overlay,
  but v1 keeps the whole page behind `staffing: false` for NHS until a plan
  exists. Decision recorded: don't ship half a page to a client tenant.
- **OHS:** no `DS_RR` → flag off, full stop (documented fallback for later:
  derive concurrency from `DS_CASES` in/out times, which the seeder itself
  proves is equivalent).

## 5. Acceptance

- [ ] V2 ledger on Demo matches `verify.py` ST-3 within rounding: ~12.7 overtime
      rm-hrs/wk, Friday idle ≥25 (actual ~47), 3.0–3.2 rooms at 15:30 Tue–Thu
      visible in V1.
- [ ] V1's demand shape agrees with the Room Running page for the same site and
      window (same `DS_RR` source, same numbers).
- [ ] No forward/2–4-week surface exists on this page and no ScenarioPanel
      entry point — those live on Volume & Staffing Outlook.
- [ ] `$` cells render only when `staffed_room_hour_cost` is set; em-dash + 
      tooltip otherwise.
- [ ] NHS/OHS: flag off → no nav entry, `/api/staffing/*` 404, nothing breaks.
- [ ] Unit tests on `lib/staffingShape.js`: idle/overtime arithmetic, forward
      implied-rooms, flag thresholds. The same module serves this page, the
      Outlook's flex signals, and Pillar 2 — one room-hour everywhere.

## 6. Out of scope (v1)

Anything forward-looking (see Rev 2); FTE/skill-mix modeling; per-role rosters;
anesthesia coverage; editing the StaffingPlan in-app (admin CRUD is Phase 2).

# Volume Impact — Staffing tab: rooms to target

> **Status:** Change spec · replaces the Staffing tab in `VolumeImpact.md`
> **Owner:** Kartheek (product) · 2026-09-10
> **Branch:** `feature/or-demo-updates`. Commit separately; same PR.
> **Mockup:** "Rooms to Target" (published artifact) — build to that layout.

> ## Read this first
>
> **Demo scaffolding, not production code.** Almost all the arithmetic already
> exists in `lib/staffingShape.js`; this is mostly a reframe of the presentation
> plus one new function and one new query.
>
> - One pass. Do not refactor `staffingShape.js` — add to it.
> - Do not touch the Service Line Breakdown, Budget, Inpatient or PACU tabs.
> - Section 8 is a binding do-not-build list; section 7 caps the tests at two.
> - If the choice is "correct for the demo in 20 lines" or "correct in general
>   in 200", take the 20.

---

## 1. Why the tab is being rebuilt

The current tab reports staffing alignment as a ledger. It never answers the
question the person actually has, which is **how many rooms should I open.**

Utilisation is one identity:

```
utilisation = demand room-hours / staffed room-hours
```

The forecast owns the numerator. Staffing owns the denominator. So the rooms
that hit a target are a division, and the gap to the plan is the recommendation:

```
roomsForTarget = demandRoomHours / (targetPct * shiftHours)
delta          = roomsForTarget - plannedRooms
```

At 9 rooms and 50% utilisation, demand is 4.5 room-days; at a 75% target you
staff 6. Close 3.

**Framing matters here.** The previous version was rejected because every
recommendation read as "flex down". Lead with redistribution, not reduction: in
the demo window Fridays give up room-days and Wednesdays need more, and the net
is small. That is a conversation an OR committee will have; "cut staffing" is
one they refuse.

---

## 2. What already exists — reuse, do not rewrite

`lib/staffingShape.js` (198 lines) already provides `impliedRooms`,
`recommendedRooms`, `idleRoomHours`, `overtimeRoomHours`, `alignmentPct`,
`peak`, `roomsAt`, `flexFlag`, `coverageImpact` and `ledgerRow`.

`routes/impact.js` already has `dailyTotals()` (forecast minutes per date and
site) and `plansBySiteDow()` (StaffedRooms, CoverageRatio, ShiftStart, ShiftEnd
from `StaffingPlan`).

**Add exactly one function** to `staffingShape.js`:

```js
// Rooms that yield `targetPct` utilisation for a day's demand.
function roomsForTarget(demandRoomHours, shiftHours, targetPct) { ... }
```

Round to the **half room** — a schedule is built in half-days, and rounding to
halves is what makes "close a room at 13:00" a first-class answer.

---

## 3. The one data gap: an hour shape for a future day

The stepped plan (section 5) needs rooms-in-use by hour, and the forecast has
only totals. Do not model it. Take the **shape from history and the magnitude
from the forecast**:

1. One query over `DS_CASES` giving average rooms in use by hour, per site x
   day-of-week, over the trailing quarter. Concurrency by hour = count of cases
   whose `Time_ORin`/`Time_OROut` span that hour.
2. Normalise to a shape that sums to 1.
3. Scale by the forecast day's demand room-hours.

Cache it per request; it is one query for the whole window. If it returns
nothing, fall back to a flat shape and suppress the stepped plan — the flat
recommendation still works.

---

## 4. Config

Add to `params` for Demo (and `default`, so nothing breaks):

```json
"prime_util_target": 75
```

Do **not** reuse `block_fill_target`. Block fill and prime-time room utilisation
are different metrics that will drift apart, and sharing one number will produce
a bug nobody can find later.

---

## 5. UI — build to the mockup

**Summary strip.** Projected utilisation, utilisation at the recommended plan,
net change in room-days, and one sentence naming the redistribution (which days
give up rooms, which need more).

**Day list — one row per operating day:**

```
Day        Demand against staffed rooms      Utilisation   To reach target   Rooms
Fri Sep 18 [======|.........]   ^            44% -> 79%    Close 3.5 rooms   - 9 +
```

- **Track** = staffed rooms. **Fill** = demand in room-equivalents. Fill
  overflowing the track = the day is tight; render the overflow in the warning
  tone. This is the same outline/fill idiom as the Block Allocations week shape —
  keep it consistent.
- **Notch** on the track at `roomsForTarget`.
- **Utilisation** as `now -> at target`.
- **Action** in plain words: *"Close 3.5 rooms"*, *"Needs 1.5 more rooms"*, or
  *"Holds at target"*. Use a **deadband of +/- 0.5 rooms** so a day at 74%
  against a 75% target says "holds", not "add 0.1 rooms". Nagging is what killed
  the last version.
- **Stepper** (- / +, half-room steps) that recomputes that row's utilisation and
  the summary strip live. This is the lever the tab exists to demonstrate.

**Detail panel** for the selected day: rooms-in-use by hour as bars, the flat
staffed plan as a dashed line, and the stepped plan as a solid line. One
sentence above it stating the finding, e.g.:

> A flat plan of 9 rooms runs at 44%. Peak demand is 6 rooms, so utilisation
> cannot be fixed by a smaller rectangle — the floor is set by the busiest hour.
> Staffing 6 rooms to 13:00 and 2 after reaches 79% without moving a case.

**The stepped plan is just two numbers**: max rooms in the morning block
(07:00–13:00) and max rooms after. Do not build an optimiser.

---

## 6. The feasibility floor — state it, do not hide it

The arithmetic will happily recommend fewer rooms than the day can physically
run. Two floors apply, and the tab should show rather than silently enforce them:

- **Peak floor** — you cannot staff below the busiest hour's room count without
  moving cases.
- **Packing ceiling** — `isscm.packingCeiling` (0.8 for Demo) already exists in
  `coverageImpact`; effective capacity is never 100%.

Render the binding floor as a second, muted marker on the ladder. When the
target implies fewer rooms than the floor, the action reads *"Floor is N rooms
(peak demand)"* rather than an impossible number.

This is the difference between a tool an OR director engages with and one they
dismiss in ten seconds. It is also cheap: `peak()` and `coverageImpact()` are
already written.

---

## 7. Tests — two assertions, no new files

1. **`scripts/checks/shared_libs.test.js`** (exists — *append*) —
   `roomsForTarget(45, 10, 0.75) === 6`, and the round-trip holds: staffing
   `roomsForTarget(d, h, t)` rooms yields utilisation `t` within rounding.
2. **`scripts/checks/census_staffing_acceptance.py`** (exists — *append ~10
   lines*) — in the demo window at least one day recommends closing rooms and at
   least one recommends opening them, so the tab does not read as all-flex-down.

No new test files. No unit tests for the hour-shape query.

---

## 8. Deliberately not built

Binding. Do not add these, and do not ask:

- An optimiser, solver, or anything that searches for a best plan.
- Staff/FTE/skill-mix modelling. The unit is rooms.
- Writing a changed plan back to `StaffingPlan`. The stepper is a what-if only.
- Per-room identity (robot rooms, hybrid ORs). Note it as a caveat in the UI
  copy; do not model it.
- Cost or dollar figures.
- Multi-day or window-level optimisation. Each day stands alone.
- Any change to the ScenarioPanel.
- Touching the other four tabs.

---

## 9. Acceptance

- [ ] `roomsForTarget` added to `staffingShape.js`; nothing else in that file
      changed.
- [ ] `prime_util_target` read from tenant config, not `block_fill_target`.
- [ ] Each day shows track/fill/notch, utilisation now -> at target, and a plain
      action with the +/- 0.5 deadband.
- [ ] The stepper recomputes the row and the summary strip live.
- [ ] Detail panel shows the hour bars, the flat plan and the stepped plan, with
      the one-sentence finding above it.
- [ ] The binding floor renders when it binds; no recommendation below it.
- [ ] Demo window contains both directions — some days close, some open.
- [ ] Hour shape missing degrades to the flat recommendation without erroring.

## Report back

The per-day table — demand room-hours, planned rooms, rooms at target, action —
for the demo window, and confirmation that both directions appear.

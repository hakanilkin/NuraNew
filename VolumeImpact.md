# Volume Impact — one forecast, four consequences

> **Status:** Spec — ready to build
> **Owner:** Kartheek (product) · 2026-08-24
> **Supersedes:** `ForwardPlan.md`, `Staffing.md`, `ORSmoothing.md` — all three
> merge into this page. Also absorbs Daily Summary / Daily Detail / Actual vs
> Budget.
>
> **The idea.** Everything downstream of the surgical schedule is a *consequence
> of forecasted volume*. Rather than a page per consequence, one page answers
> **"what does the volume coming at us do to the rest of the operation?"** across
> four tabs: budget, inpatient beds, OR staffing, and PACU / pre-op / ancillary.
>
> **Design rule above all others: simplicity.** No triage state machine, no
> dispatch routing, no action-deadline computation, no recommendation engine.
> Each tab shows an impact, flags the days that matter, and states the
> implication in one line. If a section can't be explained in a sentence, it
> doesn't ship.
>
> **Related:** `BlockAllocations.md`, `OpenTimeFulfillment.md`,
> `ISSCMIntegrationView.md` (panel stays, on decisions only — §7),
> `DemoTenant.md`

---

## 1. Nav — three items

```
Capacity Decisions
  ├─ Block Allocations      quarterly · do allocations match practice?
  ├─ Volume Impact          forward   · what does the volume do to us?
  └─ Release Time Mgmt      continuous · use the grid we have
      (Financial Analysis — when unparked)
```

`Forward Plan`, `Staffing`, `Staffing Patterns` and `OR Smoothing` cease to
exist as pages. Old routes redirect to the matching Volume Impact tab.

**Parked (decided 2026-08-24):** the structural staffing analysis — demand shape
vs. staffing rectangle, idle/overtime ledger, the 15:30 cliff, the cost hook. It
is retrospective, so it does not belong on a page about the impact of *forecast*
volume, and Room Running already covers the retrospective view in Analytics.
Revisit post-demo only if a customer asks.

---

## 2. Shared context — set once, applies to every tab

> **Amended by `ServiceLineBreakdown.md`.** The page now has five tabs: the
> forecast itself (Service Line Breakdown, first and default) and the four
> consequences below. The shared header is site, window and the summary line —
> nothing else.

A single header row, always visible:

- **Site** selector · **Window** selector (default: next 4 weeks)
- One summary line stating the forecast and its composition:

```
Next 4 weeks · Bright Memorial
682 cases forecast — 541 booked + ~141 expected to book        +8% vs budget
```

**The two-component split is not optional.** Epic's OR Staffing Analysis reads
the *booked* schedule; four weeks out an elective schedule is only partly
filled, so it systematically under-counts. Modelling what will still book — and
showing both numbers — is the answer to "why isn't this Epic's tool?" Never
collapse them into one figure.

Tabs share the selection. Changing site or window re-renders all four.

---

## 3. Tab 1 — Budget

*Are we going to hit plan, and what's driving it?*

1. **Four-week grid.** Weeks × weekdays, cell = forecast vs budget %, diverging
   scale centred on zero, value always printed so it reads in greyscale.
   Neutral band ±5% (`impact_on_plan_pct`).
2. **Day table.** Date · Site · Forecast · Budget · Variance · Var %.
   Forecast leads; "booked + expected" is its subtitle.
3. **Expand a day → service mix.** Service · Forecast · Budget · Δ. This is what
   makes the number usable — forty joints and forty cataracts are different days.

Flagging: a day is called out when `|variance%| ≥ 15` **and**
`|variance cases| ≥ 4`. The absolute floor matters — without it a 3→4 case day
reads as +33% and the list fills with noise.

---

## 4. Tab 2 — Inpatient

*What does this volume do to beds?*

1. **Unit × day grid** for the window: projected census against capacity, crunch
   cells flagged by shape and colour (`crunch_occupancy_pct`, default 92%).
2. **Attribution on the flagged cells:** how much of that day's census is
   scheduled-OR driven vs. ED vs. transfers. The line that lands:
   *"Wednesday's peak on 5 Central is 27% schedule-driven — that portion is a
   decision, not weather."*
3. **One smoothing suggestion per crunch cluster**, stated plainly:
   *"Shifting 4 inpatient-heavy cases from Tuesday to Thursday drops crunch days
   from 3 to 1."* One suggestion, not a scenario builder.

Computation in `lib/censusFootprint.js`: cases × inpatient conversion by service
× empirical LOS spread × `ServiceUnitMap`. Shared with the ScenarioPanel's
Pillar 3 so the two can never disagree.

---

## 5. Tab 3 — Staffing

*Do we have the rooms and the coverage?*

1. **Rooms needed vs rooms staffed, by day.** `impliedRooms = ceil(Σ TotalDurwTurn
   ÷ shiftMinutes)` against `StaffingPlan`. Days short or over are flagged.
2. **Late-day exposure** for flagged days: rooms projected to run past shift end,
   as room-hours. One number, not a chart.
3. **Implication line per flagged day**, in plain language.

Two rules carried forward from the research:

- **Under and over are not symmetric.** A room short costs late finishes,
  overtime and a possible cancellation; a room over costs idle salary. Weight
  the thresholds separately (`under_weight`, `over_weight`) and be more willing
  to flag under- than over-staffing.
- **Fill before flex.** Where a light day still has releasable block time and a
  service with pipeline, the implication reads *"consider releasing and
  re-offering"* with a link to Release Time Mgmt — not *"flex down."* Flex-down
  language appears only where the time genuinely cannot be sold. This is both
  better product and better positioning: LeanTaaS deliberately avoids flex-down
  vocabulary in the OR because nurse leaders react badly to it.

`lib/staffingShape.js` — shared with the panel's Pillar 2.

---

## 6. Tab 4 — PACU & Ancillary

*What does it do downstream inside perioperative services?*

The differentiator. Epic's staffing analysis stops at nursing and anaesthesia;
LeanTaaS's deepest role claim is the word "specialisation"; Qventus does pre-op
*patients*, not pre-op *staffing*. **Nobody converts a volume forecast into PACU
bay demand.**

One new config table:

```sql
ServiceRecoveryProfile
  Service NVARCHAR(100) PRIMARY KEY,
  PreOpMins INT, Phase1Mins INT, Phase2Mins INT,
  BayType NVARCHAR(30)          -- PACU | PHASE2 | BOTH
```

`lib/recoveryDemand.js`: take the day's forecast case mix and start times →
offset each case's OR-out by service → occupy a bay for `Phase1Mins` then
`Phase2Mins` → sum concurrent occupancy by hour → compare to configured bay
counts.

**The view:** for flagged days, an hourly curve of bay demand against staffed
bays, with the peak called out — *"Thursday 13:00–17:00: PACU demand peaks at 11
bays against 9 staffed."* Pre-op the same, offset before OR-in.

Always labelled **`POTENTIAL`** — we model bay demand, not nurse ratios, and
must not imply otherwise. Tier is a data field, never a copy choice.

---

## 7. What this page does not do

- **No action workflow.** Recommendations link out; the release loop lives in
  Release Time Mgmt.
- **No block-pattern analysis.** That's Block Allocations.
- **No retrospective analysis.** Parked, see §1.
- **No ScenarioPanel.** The panel stays wired to *decisions* — Release Radar
  rows, Block Allocations recommendations — where the subject is "what if we
  did X." Volume Impact's subject is "what the forecast already implies." Two
  different questions; keeping them on different surfaces is what stops the
  panel feeling redundant. (Update `ISSCMIntegrationView.md` §8's host table:
  Release Time Mgmt and Block Allocations only.)

---

## 8. API

```
GET /api/impact/summary?from&to&sites
      → { forecast, booked, expectedAdds, budget, variancePct }

GET /api/impact/budget?from&to&sites
      → { grid: [...], days: [...] }
GET /api/impact/budget/:date/mix?site

GET /api/impact/inpatient?from&to&sites
      → { units: [ { unit, capacity, days: [ { date, census, or, ed, other,
          crunch } ] } ], suggestions: [...] }

GET /api/impact/staffing?from&to&sites
      → { days: [ { date, impliedRooms, staffedRooms, flag, lateDayHours,
          implication, link? } ] }

GET /api/impact/recovery?from&to&sites
      → { days: [ { date, peakBays, staffedBays, byHour: [...] } ] }
```

One router, `routes/impact.js`, factory-style. Tenant-scoped via
`getTenantPool`, parameterized, generic errors.

---

## 9. Acceptance

- [ ] One header sets site and window for every tab; switching tabs keeps
      the selection.
- [ ] Summary line always shows booked and expected-to-book as separate figures.
- [ ] Budget: grid readable in greyscale; both flagging thresholds applied;
      day expands to service mix summing to the day's forecast.
- [ ] Inpatient: ST-2's Wednesday 5 Central shows ≈30/32 with ≈27%
      OR-attribution, matching `verify.py`; one smoothing suggestion appears.
- [ ] Staffing: a light day with releasable time and pipeline reads as
      "release and re-offer", not "flex down"; ST-3's Friday appears as
      over-staffed.
- [ ] PACU: hourly bay-demand curve peaks above staffed bays on the seeded
      Thursday (ST-9); labelled `POTENTIAL`.
- [ ] No page in the app duplicates any tab's content; Forward Plan, Staffing,
      Staffing Patterns and OR Smoothing routes redirect here.
- [ ] Every number on a tab traces to one shared lib function — no tab
      recomputes what another already has.
- [ ] NHS/OHS: tabs whose data is absent (`ServiceUnitMap`, `StaffingPlan`,
      `ServiceRecoveryProfile`) are hidden, not broken.

## 10. Seeder

Existing storylines cover tabs 1–3 (ST-1 volume, ST-2 census, ST-3 staffing).
**ST-9 is new:** a Thursday-afternoon PACU peak above staffed bays, driven by
afternoon ortho/spine concentration. Add `ServiceRecoveryProfile` rows for all
ten services (ortho/spine long phase I, cataract/ENT short) and PACU / phase-II
bay counts. `verify.py` asserts the peak exceeds capacity.

Also: ensure the budget grid is **not monotone negative** — the seed needs days
above plan as well as below, or tab 1 tells a defeatist story.

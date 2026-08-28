# Forward Plan — triage and dispatch

> **Status:** Spec — supersedes `VolumeOutlook.md` entirely
> **Owner:** Kartheek (product) · 2026-08-24
> **Replaces:** Volume & Staffing Outlook. Absorbs Daily Summary / Daily Detail /
> Actual vs Budget. Sits **first** in Capacity Decisions — it is the group's
> front door.
>
> **What this page is.** A triage board for the actionable window. It classifies
> each upcoming day by *what kind of problem it is*, attaches *how long you have
> to act*, and **dispatches to the page that owns that action**. It does not
> analyse staffing, blocks, or downstream beds — those are pillar lenses with
> their own pages. This page decides where you should be looking.
>
> **Three design rules, in priority order:**
> 1. **Fill before flex.** A gap is a demand problem until proven otherwise.
>    Staffing is the last resort, not the first response.
> 2. **Deadlines, not horizons.** Every action has its own lead time. The board
>    sorts by what closes soonest and says when it is too late.
> 3. **Dispatch, don't duplicate.** Every row ends in a link to the owning page.
>
> **Related:** `BlockAllocations.md`, `Staffing.md`, `OpenTimeFulfillment.md`,
> `ORSmoothing.md`, `ISSCMIntegrationView.md` (ScenarioPanel host)

---

## 1. Why not "Four Weeks"

Four weeks is arbitrary and it is also LeanTaaS's published headline. Actions
have different lead times, so a single horizon is wrong for most of them:

| Action | Lead time | Tenant param |
|---|---|---|
| Release a block | 21 days — response + re-offer + booking | `release_lead_days` |
| Offer open time | 14 days | `offer_lead_days` |
| Flex staffing | 14 days — scheduling-notice rules | `staffing_lead_days` |
| Shift cases (smoothing) | 28 days — patients must be rescheduled | `smoothing_lead_days` |

The board covers **8 weeks** and computes, per day and per action,
`actBy = date − leadDays` and `daysLeft = actBy − today`. Rows sort by
`daysLeft` ascending. Nobody in the category tells a director *when it is too
late*; this is the cheapest genuinely novel thing on the page.

It also produces the honest version of flex-down: **a light day whose fill
window has closed is no longer a growth opportunity — it is a staffing
decision.** The ordering rule stops being a slogan and becomes arithmetic.

---

## 2. Day states

Computed per site × day. `capacity` = staffed room-hours (`StaffingPlan`),
`demand` = forecast room-hours, `downstream` = projected unit pressure
(`lib/censusFootprint.js`).

| State | Condition | Action | Dispatches to |
|---|---|---|---|
| `FILL` | demand < capacity, fill window **open**, releasable block exists, receiving pipeline exists | Release the block, offer the time | Release Time Mgmt |
| `FLEX` | demand < capacity, fill window **closed** or no candidate | Recover cost on time that cannot be sold | Staffing |
| `ADD` | demand > capacity | Open a room / extend coverage | Staffing |
| `SMOOTH` | demand within capacity but downstream unit projected over threshold | Shift inpatient-heavy volume off the day | OR Smoothing |
| `PROTECT` | demand > capacity × protect threshold, capacity adequate | Confirm coverage, watch late-day run | — |
| `CLEAR` | none of the above | Nothing | — |

**A day may hold more than one state** (over plan *and* downstream tight). Render
the highest-priority action, list the others in the row's detail. Priority:
`SMOOTH` > `ADD` > `FILL` > `FLEX` > `PROTECT`.

`FILL` requires all three conditions. A light day with nothing releasable and no
pipeline is not a fill opportunity, and claiming otherwise is how the page loses
credibility with a scheduler who knows better.

---

## 3. Layout

### 3a. The grid (top)

8 weeks × weekdays, one cell per site-day.

- Cell is **coloured by state**, not by variance magnitude — this is a triage
  board, and the question is *what kind of day is this*.
- The variance value is printed in the cell, so it is readable in greyscale and
  on a projector.
- Legend maps colour → action. Clicking a cell scrolls to its row in the queue.

### 3b. The action queue (the hero)

Flagged days only, sorted by `daysLeft`.

| Act by | Left | Date | Site | State | Why | Dispatch |
|---|---|---|---|---|---|---|
| Sep 3 | 11d | Thu Sep 24 | Bright Memorial | `FILL` | Ortho A forecast 41% of block; Spine pipeline +38% | → Release Time Mgmt |
| Sep 6 | 14d | Fri Sep 20 | Bright Memorial | `FLEX` | Fill window closed; 3 rooms above demand | → Staffing |
| Sep 8 | 16d | Wed Oct 7 | Bright Memorial | `SMOOTH` | 5 Central projected 31/32 | → OR Smoothing |

- **`daysLeft` ≤ 3 gets an urgency treatment** by shape and label, not colour
  alone.
- Windows already closed are not deleted — they drop to a collapsed "window
  closed" section, because the pattern of repeatedly missing them is itself a
  finding worth seeing.
- **"Evaluate impact"** on any row opens the ScenarioPanel — the check-before-you-act
  step. This page becomes the panel's primary host (see §7).

### 3c. Day detail (expand)

Forecast composition **stated as two components**, which is both more honest and
the precise answer to "why isn't this Epic's OR Staffing Analysis?":

```
Thursday, Sep 24 — Bright Memorial
34 forecast cases  ·  −18% vs budget

   26 booked today
 + ~8 expected to book       (blend weight shifts with lead time)

Service            Forecast   Budget    Δ
Orthopedics            11        16     −5
General Surgery         9        10     −1
…
```

Epic's staffing analysis reads the **booked** schedule. Eight weeks out an
elective schedule is half empty, so it systematically under-counts. Modelling
what will *still* book — and showing the two components separately — is the
differentiator, so never merge them into one number.

---

## 4. What this page does NOT do

Deliberately, so the group stops feeling redundant:

- **No staffing analysis.** No shape-vs-rectangle, no idle/overtime ledger, no
  role-level detail. `FLEX` and `ADD` link to Staffing.
- **No block-pattern analysis.** Chronic mismatch is Block Allocations' subject;
  this page only sees the instance.
- **No census modelling.** `SMOOTH` links to OR Smoothing.
- **No release workflow.** No request drafting, no offers.

If a reviewer can't tell this page from Staffing, the boundary has been violated.

---

## 5. API

```
GET /api/plan/grid?weeks=8&sites
      → { weeks: [ { weekOf, days: [ { date, dow, site, forecast, budget,
          variancePct, state, daysLeft } ] } ] }

GET /api/plan/actions?weeks=8&sites
      → { actions: [ { date, site, state, actBy, daysLeft, headline,
          drivers: [ { label, contribution, detail } ], dispatch:
          { page, params } } ],
          closed: [ ... ], leadTimes: { ... } }

GET /api/plan/day/:date?site
      → { forecast, booked, expectedAdds, budget, variance,
          services: [ { service, forecast, budget, delta } ], states: [...] }
```

State classification lives in **`lib/forwardPlan.js`** — pure, unit-testable,
and it calls `lib/staffingShape.js` (capacity) and `lib/censusFootprint.js`
(downstream) rather than recomputing either. Same shared-library rule as
everywhere else: a room-hour is the same room-hour on every page.

---

## 6. Signals are templated, never generated

Row headlines and driver strings are built from the numbers in the house
`{ label, contribution, detail }` idiom. No LLM in the content path. Generic
commentary ("volume is expected to be elevated…") adds nothing and cannot be
audited against the table beside it.

Tiering carries over from the old spec: `RECOMMENDED` only where the change is
quantified from `StaffingPlan`; `POTENTIAL` everywhere else — always for PACU,
pre-op and ancillary. Never render a `POTENTIAL` in the language of a
`RECOMMENDED`.

---

## 7. ScenarioPanel

This page becomes the panel's **primary host** — it is where decisions are
triaged, so it is the natural place to check coupling before dispatching.
Decision kind follows the row's state: `FILL`/`FLEX` → `REALLOCATE` or
`FLEX_STAFFING`, `SMOOTH` → `SHIFT_DOW`. Update
`ISSCMIntegrationView.md` §8's host table: Forward Plan (primary), Release Time
Mgmt, OR Smoothing, Staffing.

---

## 8. Acceptance

- [ ] Grid shows 8 weeks, cells coloured by state with variance printed;
      readable in greyscale.
- [ ] Every flagged day carries `actBy` and `daysLeft`; queue sorts ascending.
- [ ] A light day inside its fill window is `FILL`; the same day past the window
      is `FLEX`. Moving the system clock flips it.
- [ ] `FILL` never appears without a releasable block **and** a receiving
      pipeline.
- [ ] Closed-window rows are retained in a collapsed section, not dropped.
- [ ] Day detail shows booked and expected-to-book as separate figures.
- [ ] Every row dispatches to the correct page with params applied.
- [ ] Page contains no staffing, block-pattern, or census analysis.
- [ ] Demo tenant: a believable mix across ≥3 states, not monotone `FLEX`;
      at least one `FILL` and one `SMOOTH`; ST-1's Ortho A appears as `FILL`
      and ST-2's Wednesday as `SMOOTH`.
- [ ] NHS/OHS: states requiring absent data (no `StaffingPlan`, no
      `ServiceUnitMap`) are omitted, page still renders.

## 9. Out of scope

Any action execution; role-level staffing quantification (Staffing owns it);
free-form scenario building; day-of-surgery.

# Volume & Staffing Outlook — the next four weeks, end to end

> **Status:** Spec — rev 2, ready to build
> **Owner:** Kartheek (product) · design direction his, 2026-08-24
> **Replaces:** the Forecasts nav group (Daily Summary, Daily Detail), absorbs
> Actual vs Budget, **and absorbs the forward half of the Staffing page**
> (`StaffingAlignment.md` V3, Forward Flex Plan). One page, three tabs, under
> **Capacity Decisions**.
>
> **Rev 2 (2026-08-24) — merged with the Staffing page's forward view.** Rev 1
> split the chain `Forecast → Demand Signal → Staffing Implication → Recommended
> Action` across two pages and patched the seam with cross-links. That break sat
> exactly in the middle of the chain, and a boundary whose fix is "make sure they
> always agree" is usually two halves of one page. Merged, the whole chain reads
> in **a single exception row** (§3), and the disagree-on-a-projector risk is
> eliminated rather than managed.
>
> **What did NOT merge:** the *structural* staffing analysis — demand shape vs
> the staffing rectangle, the idle/overtime ledger, the 15:30 cliff — stays as
> **Staffing Patterns** (`StaffingAlignment.md` rev 2). Different horizon
> (quarterly, not weekly), different decision (redesign the template, not flex
> Tuesday), different audience (VP + finance, not charge nurse). Three things
> existed here, not two; only two of them were one flow.
>
> **The reframe.** Today the page answers *"what are all the forecast numbers?"*
> The OR director's actual question is: *"over the next 2–4 weeks, where is volume
> likely to be above or below plan, what kind of volume is driving it, and where
> should I adjust staffing?"* That is a different product, not a column change.
> The model mechanics (scheduled → forecast addition → total) are analytically
> correct but are not the director's mental model; the forecast becomes the hero
> and the mechanics become its supporting line.
>
> **The arc to build toward:**
> `Forecast → Demand Signal → Staffing Implication → Recommended Action`
>
> **Related:** `NavRestructure.md` (rev 3 — see §1), `StaffingAlignment.md`
> (boundary — see §7), `routes/analytics.js` (`/sf/*` endpoints being replaced),
> `DemoTenant.md`, `config/tenantColumns.json`

---

## 1. Nav — reversing my own recommendation

`NavRestructure.md` rev 2 kept **Forecasts** as its own group, on the argument
that the word advertises the S3 claim to the CIO. **That premise no longer
holds.** Once the page's centre of gravity is "where should I adjust staffing,"
it is a decision surface, and filing it under a readout label undersells it.
The positioning is better served anyway: every item in Capacity Decisions is
forward-looking, so the *group* advertises the claim rather than one label.

**Nav becomes (supersedes NavRestructure.md §1):**

```
Analytics            Case Volumes · Prime Time · Block Util · Room Running
Atlas                FCOT Drivers · Turnover Time
Ask Nura
Capacity Decisions   Performance Briefs
                     Volume & Staffing Outlook   ← this page (3 tabs)
                     Release Time Mgmt           (4 tabs, per OpenTimeFulfillment.md)
                     OR Smoothing
                     Staffing Patterns           (structural half — StaffingAlignment.md rev 2)
                     (Financial Analysis — when unparked)
```

The **Forecasts** group disappears. Page name **"Volume & Staffing Outlook"** —
explicit about carrying both halves of the chain, which is the point of the
merge. Its structural sibling is **"Staffing Patterns."**

**Tabs:** `Planning` (default) · `Daily Detail` · `Actual vs Budget`.
Old routes `/schedule-forecast/daily|detail|cases` redirect to the matching tab.

---

## 2. Layer 1 — the four-week outlook (Planning tab, top)

A calendar heatmap, one cell per weekday, four weeks forward. Cell value =
**forecast vs budget %**.

|  | Mon | Tue | Wed | Thu | Fri |
|---|---|---|---|---|---|
| Aug 31 | −12% | −24% | +3% | +18% | +5% |
| Sep 7 | −3% | +4% | +22% | +17% | −8% |

- **Diverging scale** centred on zero — under plan / on plan / over plan. Colour
  intensity carries magnitude; the number is always printed, so the cell is
  readable without colour (projector + accessibility rule).
- Site selector applies; default is all sites combined, with a per-site toggle.
- **Clicking a cell** drills to that date in the Daily Detail tab, pre-filtered.
- Neutral band is a tenant param (`outlook_on_plan_pct`, default ±5%) so "on
  plan" isn't a hairline.

This is the layer that answers "where do I look?" in two seconds — *"week of
Sep 7 is heavy, especially Wednesday and Thursday."*

---

## 3. Layer 2 — exceptions and signals (the hero)

Directly beneath the heatmap, and the operational centre of gravity of the page.
Leadership should never have to scan twenty rows to find the four that matter.

**Each row carries the whole chain** — demand, driver, staffing implication,
action. This single-row completeness is the reason the merge happened:

| Date | Site | Forecast | vs Budget | Primary driver | Staffing implication | Tier |
|---|---|---|---|---|---|---|
| Wed 9/9 | Bright Memorial | 38 cases | +21% | Orthopedics +8 | Plan supports 33 → gap ~5 cases (~1 room) | `RECOMMENDED` |
| Thu 9/10 | Bright Surgery Center | 21 cases | +18% | GI +4, ENT +3 | Review pre-op / PACU coverage | `POTENTIAL` |
| Tue 9/15 | Bright Memorial | 23 cases | −19% | Gen Surg −6 | Staffs 9 rooms, needs 6 → flex 3 down | `RECOMMENDED` |

The room-level implication is computed here, not linked to from here. Rows with
no quantifiable room change still carry a `POTENTIAL` implication so the column
is never blank — a blank reads as "no staffing impact," which is a different
claim from "we can't quantify it."

### Detection rules (both conditions, or it isn't an exception)

```
|variance_pct|   >= outlook_exception_pct    (tenant param, default 15)
AND |variance_cases| >= outlook_min_cases    (tenant param, default 4)
```

The absolute floor matters: without it, 3 → 4 cases reads as +33% and the list
fills with noise on low-volume days.

**Primary driver** = the service line with the largest absolute contribution to
the day's variance, with runners-up listed when they are within reach. Same
`{ label, contribution, detail }` idiom as every other driver surface in the
product.

### Signal tiering — a first-class field, not a copy choice

Kartheek's distinction, made structural:

| Tier | Meaning | When it is used |
|---|---|---|
| `POTENTIAL` | An unusual workload pattern is present; resource change **not** quantified. | Always for PACU, pre-op, and ancillary — we hold no data on those staffing models. |
| `RECOMMENDED` | A quantified change, with the arithmetic shown. | OR room level only, where `StaffingPlan` exists (§6). |

Never render a `POTENTIAL` signal in the language of a `RECOMMENDED` one. The
tiering is itself a credibility asset in the room: *"we tell you when we're
quantifying and when we're only flagging."* As staffing rules mature, signals
migrate upward — the field exists so that migration is a data change, not a
rewrite.

### Signal text — structured, never generated prose

Signals are **templated from the numbers**, in the house driver idiom. Do not
route these through the LLM for content. Generic commentary ("volume is expected
to be elevated…") adds nothing and cannot be audited.

```
Sep 10 · Bright Memorial
HIGHER STAFFING NEED LIKELY                                    [POTENTIAL]
Forecast volume is 17% above budget, driven primarily by
+6 orthopedic and +3 general surgery cases.
Consider:
  · reviewing OR staffing against expected case mix
  · increasing PACU coverage
  · confirming pre-op staffing
  · reviewing ancillary coverage
```

An LLM may polish phrasing later, but every figure must come from the same
computation the table renders — one source, or the two disagree on a projector.

---

## 4. Layer 3 — daily detail (Daily Detail tab)

The existing table, simplified, as *supporting evidence* rather than the product.

| Date | Site | Scheduled | Expected adds | Forecast | Budget | Variance | Var % |
|---|---|---|---|---|---|---|---|

Duration columns are removed (per direction).

### Forecast is the hero, mechanics are the subtitle

Instead of `Scheduled | Fcst Addition | Total Fcst | Budget | Budget Gap` given
equal weight, the row leads with the number the director actually uses:

```
42 forecast
38 scheduled + ~4 expected additions
+7 vs budget  ·  +20%
```

### Expanding a date — case mix

Expanding a row reveals the service-line breakdown, which is what makes this
usable for pre-op, PACU and ancillary planning. Forty total joints and forty
cataracts are not the same day.

```
Thursday, Sep 10 — Bright Memorial
42 forecast cases | +17% vs budget

Service            Forecast   Budget    Δ
Orthopedics            14        9     +5
General Surgery         9       10     −1
Urology                 7        6     +1
ENT                     6        5     +1
Other                   6        6      —
```

Available today: `V4_FORECAST_COMPILE` carries `SurgeonService` at the same
grain as the forecast and budget columns. Deeper levels (procedure, acuity) are
a later layer — noted in §9, not built now.

---

## 5. Actual vs Budget tab

The existing Cases-vs-Budget view, moved here unchanged for now. It is the
retrospective sibling of the forward view and belongs on the same page: *did we
hit plan* alongside *are we going to*. Simplify only if it conflicts visually
with the other two tabs.

---

## 6. The three reference points — forecast, budget, planned staffing

The change that turns forecasting into decision support. Three comparisons,
three different questions:

| Comparison | Question it answers |
|---|---|
| Forecast vs **budget** | Are we going to hit volume targets? |
| Forecast vs **recent norm** | Will this week be unusually busy? |
| Forecast vs **planned staffing** | Is staffing aligned to the workload we now expect? |

Target surface:

```
Forecast: 44 cases
Budget:   37 cases        → +19%
Staffing plan supports:  ~38 cases
Potential staffing gap:    6 cases                            [RECOMMENDED]
```

### The conversion, stated openly

"Staffing plan supports ~N cases" requires converting staffed rooms into case
capacity. Compute it explicitly in `lib/demandSignal.js`, never inline:

```
capacity_cases = staffedRooms × shiftMinutes ÷ avgCaseMinutesInclTurnover
```

- `staffedRooms`, `shiftMinutes` from `StaffingPlan` (seeded; §7 of
  `DemoTenant.md`).
- `avgCaseMinutesInclTurnover` from trailing actuals for that site, **weighted by
  the forecast's own case mix** — a joints-heavy day has less case capacity than
  a cataract-heavy day, and ignoring that would make the gap wrong in exactly
  the situations it matters.
- Tenant override param for sites that plan differently.

Show the assumption in the UI on hover/expand. A staffing gap whose derivation
is hidden is a number a director will not act on — and cannot defend to their
CFO.

---

## 7. Split with Staffing Patterns — by horizon, not by unit

Rev 1 split these by *unit of analysis* (cases here, rooms there). That was an
analyst's distinction, not a director's, and it broke the chain. The split is
now by **time horizon and decision**:

| | Volume & Staffing Outlook (this page) | Staffing Patterns |
|---|---|---|
| Horizon | Next 2–4 weeks | Trailing 8+ weeks, structural |
| Question | What's coming, and is next Tuesday staffed for it? | Does our staffing template fit our demand pattern at all? |
| Decision | Flex a specific day up or down | Redesign the staffing plan |
| Cadence / audience | Weekly · scheduler, charge nurse | Quarterly · VP, finance |
| Owns | Volume variance, case mix, forward room requirement, flex signals | Demand shape vs rectangle, idle/overtime ledger, the 15:30 cliff, the $ hook |

**The Forward Flex Plan moves here in full.** `StaffingAlignment.md` V3 is
deleted from that spec; its logic and acceptance criteria land in §3 and §6 of
this one. Staffing Patterns keeps V1 and V2 only.

`lib/staffingShape.js` remains shared: this page and Staffing Patterns and the
ScenarioPanel's Pillar 2 all call it, so a room-hour is the same room-hour
everywhere. The **"Evaluate flex"** ScenarioPanel entry point moves to this
page's exception rows — the panel's third host is now the Outlook, not Staffing
Patterns (update `ISSCMIntegrationView.md` §8's host table accordingly).

---

## 8. API

New module router, mounted at `/api/outlook`:

```
GET /api/outlook/calendar?weeks=4&sites
      → { weeks: [ { weekOf, days: [ { date, dow, forecast, budget,
          variancePct, onPlan: bool } ] } ] }

GET /api/outlook/exceptions?weeks=4&sites
      → { exceptions: [ { date, site, forecast, budget, variance, variancePct,
          drivers: [ { service, delta } ], tier: POTENTIAL|RECOMMENDED,
          headline, considerations: [...], roomGap: n|null } ],
          thresholds: { exceptionPct, minCases } }

GET /api/outlook/daily?from&to&sites
      → rows: { date, site, scheduled, expectedAdds, forecast, budget,
                variance, variancePct }

GET /api/outlook/daily/:date/mix?site
      → { services: [ { service, forecast, budget, delta } ] }

GET /api/outlook/flex?weeks=4&sites          (absorbed from /api/staffing/forward)
      → days: { date, dow, plannedRooms, impliedRooms, flag:
                FLEX_DOWN|FLEX_UP|null, drivers: [...] }
```

`/api/outlook/exceptions` composes the flex computation inline so a row is one
request, not two; `/api/outlook/flex` exists for the Daily Detail tab and for
the ScenarioPanel. Both call the same `lib/staffingShape.js` functions.

`/api/sf/cases` stays for the Actual vs Budget tab. Tenant-scoped via
`getTenantPool`, parameterized, generic errors — same rules throughout.

---

## 9. Phasing

**Phase 1 (demo):** tabs + heatmap + exceptions with `POTENTIAL` signals +
simplified detail table with case-mix expansion. Case-mix-weighted room capacity
and the `RECOMMENDED` tier where `StaffingPlan` exists.

**Phase 2:** forecast vs recent-norm as a third comparison; cross-links to the
Staffing page; per-site staffing overrides.

**Phase 3 (needs real staffing rules):** role-level quantification —
"+1 PACU RN 11a–7p, +1 pre-op RN 6a–2p." Only then do PACU/pre-op signals earn
`RECOMMENDED`.

**Phase 4:** procedure- and acuity-level mix beneath service line.

---

## 10. Acceptance

- [ ] Nav: Volume Outlook sits under Capacity Decisions with three tabs;
      the Forecasts group is gone; old `/schedule-forecast/*` routes redirect.
- [ ] Heatmap renders 4 weeks × 5 weekdays with printed values, readable in
      greyscale; clicking a cell drills to that date in Daily Detail.
- [ ] Exceptions apply **both** thresholds; a 3 → 4 case day does not appear.
- [ ] Every exception names a primary driver derived from service-line variance.
- [ ] Signal tier is a data field; `POTENTIAL` never renders as quantified
      advice; PACU/pre-op/ancillary considerations are always `POTENTIAL`.
- [ ] No signal text is LLM-generated; all figures trace to the same computation
      the tables render.
- [ ] Detail row leads with forecast; scheduled + expected adds is the subtitle.
- [ ] Expanding a date shows service-line mix summing to the day's forecast.
- [ ] Room-level gap uses case-mix-weighted average duration, and the assumption
      is inspectable in the UI.
- [ ] Every exception row carries a staffing implication — quantified where
      `StaffingPlan` allows, `POTENTIAL` otherwise. The column is never blank.
- [ ] Friday's ST-3 flex-down (plan 9, implied ~6) appears as a `RECOMMENDED`
      exception here, matching `verify.py`; Staffing Patterns no longer renders
      a forward view at all.
- [ ] "Evaluate flex" on an exception row opens the ScenarioPanel with a
      `FLEX_STAFFING` decision; Pillar 2's number equals the row's.
- [ ] Demo tenant shows a believable spread: 3–5 exceptions across 4 weeks, both
      directions represented, at least one `RECOMMENDED`.
- [ ] NHS/OHS render Planning and Detail; the `RECOMMENDED` tier is absent where
      no `StaffingPlan` exists — degrade, never break.

## 11. Open decisions

1. **Actual vs Budget as a tab vs. left in Analytics** — spec assumes tab.
2. Whether the heatmap defaults to all-sites-combined or splits by site
   immediately (spec assumes combined with a toggle).
3. Whether Staffing Patterns eventually earns its own ScenarioPanel entry point
   (a "what if we changed the template" decision kind) — not needed for the demo.

*Settled 2026-08-24: page names (Volume & Staffing Outlook / Staffing Patterns);
merge scope (forward halves only).*

<!-- RTDC.md — generated from the Nura artifact 'Right-Time, Not Real-Time' (v7, 2026-09-03). Spec for the inpatient RTDC build: data contract, derivations, rules, learning, IA, tables/routes, acceptance. -->

# Right-Time, Not Real-Time

> **Status (2026-09-04): built on `feature/demostuff`.** Bed Meeting (`/ip/bed-meeting/:tab`) and Flow Learning
> (`/ip/flow-learning/:tab`) are live behind `features.rtdc`; the Admin page carries the RTDC section.
> - **Snapshot source** — `lib/rtdcSource.js`: `DS_RTDC_Snapshot` / `DS_RTDC_UnitSnapshot` in the tenant DB
>   (DDL in `scripts/rtdc/create_rtdc_snapshot_tables.sql`), or the deterministic synthetic source
>   `lib/rtdcSynthetic.js` when `params.rtdc.source = "synthetic"` (the demo tenant). Same shape either way.
> - **Nura-owned state** — `lib/rtdcStore.js`, a JSON file (`.rtdc-demo.json`, gitignored) standing in for the
>   NuraOps tables in §8, keyed by TenantID: effective beds, barrier confirmations, reviewed marks, tracker
>   status, the improvement backlog, and admin rule/setting edits.
> - **Pure libs** — `lib/rtdcPredict.js` (§3.1), `rtdcRules.js` (§5), `moveToYes.js` (§4 clocks), `rtdcMismatch.js`
>   (§3.2 status + heatmap), `rtdcOutcome.js` (§6), `rtdcArchetype.js`; `lib/rtdcDay.js` assembles a day and
>   `routes/rtdc.js` serves it. `npm run check:rtdc` covers §9.
> - **Board and discharge list (2026-09-04, from the huddle mockups)** — the Board tab is the
>   "demand & capacity" huddle view: a navy header carrying window / snapshot / staffed beds /
>   occupancy, four summary counts (red · even · green units, projected discharges), then the unit
>   table as `Unit · Staffed beds · Occ. @ S2 · Open beds · Forecasted demand · Proj. discharges ·
>   Net gap · Status`. This renames §7.1's columns and adds the occupancy bar; the arithmetic is
>   unchanged (**Open beds** is the effective-beds entry, and demand still prints its 1st and 2nd
>   pass with their sources). Clicking a row, its net gap, or a summary card opens the **discharge
>   priority list**: `GET /api/rtdc/discharges` returns every unit grouped by status, ranked the
>   same way §7.1 ranks one unit, each patient carrying `chips` — the done / in-progress / blocked
>   activities from `lib/moveToYes.js activityChips()`, in the order a huddle reads a patient.
>   Units with capacity available collapse behind a toggle unless a filter is applied. PHI posture
>   is unchanged: initials, room, and the masked tail of the encounter number — never a name or MRN.
>   A "no expected discharge date" group lists patients whose EDD is empty or flagged Unknown; they
>   are outside every prediction and score, and are shown only as the Epic-fidelity gap they are.
> - **Demo storylines** (by construction in the synthetic source): 5 Central short every Mon/Tue; Home-with-HH on
>   4 East waiting on referral acceptance as the top avoidable-N; one hospitalist ordering late (~13:40);
>   MRD_HOME and ORDER_WRITTEN convert well, LOS_EXCESS and PLACEMENT_SECURED poorly.

RTDC as a Nura product, built on Epic fields that already exist. Units predict in Epic; Nura reads three snapshots a day, surfaces the huddle report, suggests who to escalate, and reconciles what happened — so prediction accuracy, N→Y conversions and "could have been a Y" patterns become the hospital's improvement agenda.

**Epic captures. Nura reckons.** The night shift organizes and the morning nurse manager finalizes a Y/N-by-2 PM call on each patient, plus what has to happen and who owns it — in Epic, in the EDD, its comment, or one custom Y/N field. Nura never writes to Epic. It reads three snapshots a day, turns the Ns into a clean huddle list, flags the Ns worth escalating, and closes the loop after 2 PM: who was right, which escalations converted, and which kinds of N keep turning out to be avoidable. **Right-time, not real-time.**

## 1. The flow, as envisioned

3 PM → 7 AM

#### Night shift organizes

Working from EDDs, the night charge nurse and case manager set the by-2 PM call for tomorrow and write the discharge narrative: what needs to happen, who is doing it. Likelihood ~50%.

`Epic`

7 → 8 AM

#### Nurse manager finalizes

Confirms Y/N to the extent possible, updates the narrative, marks anything that changed overnight. Likelihood ~80%. Nothing is entered anywhere else.

`Epic`

~8:30 AM

#### Nura surfaces the huddle report

Y/N, narrative, owner, EDD, disposition, LOS vs GMLOS, DC order, pending items — organized per unit with the Ns pulled out and their facts in one place.

`Nura reads`

In the huddle

#### Escalation candidates

Nura auto-suggests which Ns to discuss and escalate, from disposition and other factors, with the reason stated. The room decides; nobody types a plan.

`Nura suggests`

After 2 PM

#### Reconcile & learn

Prediction accuracy by unit; which escalation candidates converted N→Y; the most common kinds of N that could have been Y with a process tweak — the improvement backlog.

`Nura scores`

Two things make this different from the v3 spec. The prediction is captured in Epic fields the site already has or a single custom Y/N field — §3.1 defines both modes. And the escalation step is explicitly Nura's job to *suggest*, not just to display; the constraint from earlier still holds — transparent rules, no scoring engine, the room decides.

## 2. The data the flow needs

Assume the data is in Nura's tenant database; how it gets there is a separate question (Appendix A). What follows is the complete list of inputs, at the grain and the moment each flow step needs them. Three snapshot moments carry the whole method: `S1` pre-huddle (~06:00), `S2` huddle (~08:20), `S3` post-2 PM scoring (nightly is fine). Everything below is read-only from Epic; the only Nura-entered value is effective beds.

### 2.1 Patient-level snapshot — one row per inpatient encounter, per snapshot

This is the table the huddle report, the Ns list, the escalation rules and the scoring all read. Same shape at S1, S2 and S3; the snapshot time is part of the key. Logical names; physical columns resolve through `config/tenantColumns.json`.

| Logical column                                             | Type           | Used by            | Notes                                                                                                                                                                             |
|------------------------------------------------------------|----------------|--------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| ENCOUNTER_KEY                                              | id             | all                | EPICCSN today. Only key stored in NuraOps.                                                                                                                                        |
| SNAPSHOT_AT                                                | datetime       | all                | S1 / S2 / S3 stamp.                                                                                                                                                               |
| HOSPITAL, UNIT, ROOM_BED                                   | text           | report, Ns         | UNIT must match `unit_category_map`. Room/bed and initials are the only patient identifiers shown.                                                                                |
| PATIENT_INITIALS                                           | text           | Ns                 | PHI posture: initials + room only.                                                                                                                                                |
| ADMIT_AT, LOS_DAYS, GMLOS                                  | datetime, num  | Ns, rules, learn   | LOS vs GMLOS on every N row; `LOS_EXCESS` rule.                                                                                                                                   |
| PATIENT_CLASS, LEVEL_OF_CARE                               | code           | rules, capacity    | Inpatient/obs; ICU/PCU/acute. ICU excluded from suggestions.                                                                                                                      |
| HOSPITAL_SERVICE, ATTENDING                                | text           | Ns, learn          | Archetype segmentation; attending order-time medians.                                                                                                                             |
| EXPECTED_DISPOSITION                                       | code           | rules, learn       | Home / Home w/ HH / SNF / Rehab / LTACH / Hospice / Other. "Disposition and other factors."                                                                                       |
| PRED_2PM                                                   | Y / N / null   | all                | **The prediction.** Derived (§3.1) from the source the tenant uses.                                                                                                               |
| PRED_SOURCE_DATE, PRED_SOURCE_TIME                         | date, time     | derivation         | EDD date and, where the site captures it, EDD time.                                                                                                                               |
| PRED_FLAG_RAW                                              | text           | derivation         | Optional dedicated Y/N field (flowsheet row / custom item) where a site uses one instead of EDD time.                                                                             |
| PRED_UNKNOWN                                               | bool           | derivation         | EDD Unknown → not on list.                                                                                                                                                        |
| DC_NARRATIVE                                               | text           | Ns, rules, learn   | The clinical discharge narrative (EDD comment or equivalent): what needs to happen, who is doing it. Shown verbatim; keyword-matched by `EDD_SLIPPED`; phrase-segmented in learn. |
| NARRATIVE_OWNER_ROLE                                       | code           | Ns                 | Optional: RN / MD / CM / SW parsed or entered.                                                                                                                                    |
| PRED_LAST_EDIT_AT, PRED_LAST_EDIT_ROLE                     | datetime, code | fidelity           | Last edit to the prediction source (EDD history). Proves night-organized / AM-finalized.                                                                                          |
| PRED_EDIT_LOG                                              | json           | fidelity, learn    | All edits since admission: at, role, old→new. Needed for the night/AM fidelity metric and for "flip" analysis (Y→N overnight).                                                    |
| MRD, ORD                                                   | bool / code    | rules              | Medical / overall readiness for discharge where configured.                                                                                                                       |
| DC_ORDER_AT                                                | datetime       | Ns, rules, scoring | Signed discharge order time; null if none. `ORDER_WRITTEN` rule; "order by 11" clocks.                                                                                            |
| DC_MILESTONES                                              | json           | Ns                 | \[{name, status, completed_at}\] where the site runs milestones. Optional.                                                                                                        |
| DC_DELAY_REASON                                            | code           | learn              | Epic delay reason if documented; seeds barrier code.                                                                                                                              |
| PENDING_ITEMS                                              | json           | Ns, rules          | \[{class: lab\|imaging\|consult\|therapy\|referral\|procedure, name, ordered_at, status, resulted_at}\] — active, unresulted orders. OHS: null (feature flag).                    |
| PLACEMENT_STATUS                                           | code           | rules              | For SNF/rehab/LTACH: pending / accepted / authorized. From milestone, delay reason or CM field. `PLACEMENT_SECURED`.                                                              |
| TRANSPORT_REQUESTED_AT                                     | datetime       | Ns (Y at risk)     | Transport / medical dispatch request time if any.                                                                                                                                 |
| FLAGS                                                      | json           | rules, capacity    | Isolation, 1:1 sitter, in-custody, comfort care, telesitter — exclusions and effective-bed reasons.                                                                               |
| DISCHARGED_AT, DISCHARGE_ENTERED_AT, DISCHARGE_DISPOSITION | datetime, code | scoring (S3)       | Actual departure (ADT), when the event was entered, actual dispo. Only present at S3.                                                                                             |

### 2.2 Unit-level snapshot — one row per unit, per snapshot

| Logical column                            | Type        | Used by         | Notes                                                                                                    |
|-------------------------------------------|-------------|-----------------|----------------------------------------------------------------------------------------------------------|
| HOSPITAL, UNIT, SNAPSHOT_AT               | key         | board           |                                                                                                          |
| STAFFED_BEDS, OCCUPIED_BEDS, BLOCKED_BEDS | int         | board           | Available = staffed − occupied − blocked.                                                                |
| PENDING_BED_REQUESTS_IN                   | json        | demand 1st pass | \[{source_dept, requested_at, state: requested\|assigned\|RTM}\] with destination = this unit.           |
| OR_EXPECTED_ADMITS_BY_2PM                 | int (+json) | demand 1st pass | Today's cases with expected inpatient disposition mapped to this unit (ServiceUnitMap); arrival ≤ 14:00. |
| DOWNGRADE_REQUESTS_IN                     | int         | demand 1st pass | ICU/PCU → this unit, requested, not yet moved.                                                           |
| ED_LIKELY_ADMITS                          | int (+json) | demand 2nd pass | ED patients present with admit decision or likelihood ≥ threshold, expected level of care → this unit.   |
| PROCEDURAL_EXPECTED                       | int         | demand 2nd pass | PACU / cath / IR cases in progress with expected inpatient dispo → this unit.                            |
| DOWNGRADES_ANTICIPATED                    | int         | demand 2nd pass | ICU/PCU patients flagged for downgrade, no request yet.                                                  |
| ED_FORECAST_8_14                          | num         | demand 2nd pass | From `EDAdmissionsForecast`, net of patients already present.                                            |

### 2.3 Reference and history — nightly

| Dataset            | Grain           | Used by          | Notes                                                                                                                                                                  |
|--------------------|-----------------|------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Turnaround medians | unit × metric   | needed-by clocks | DO→DC median; order→result median by order class; attending median DC-order time by unit. Computed from the last 90 days nightly.                                      |
| Unit config        | unit            | board, rules     | Category, staffed-bed baseline, ServiceUnitMap shares, huddle order (flow-coordinator script order).                                                                   |
| Rule config        | tenant × rule   | candidates       | Enabled flag, parameters (LOS delta, likelihood threshold), keyword list for `EDD_SLIPPED`, reason text.                                                               |
| Encounter history  | encounter × day | learn            | Every prior day's S2 row and S3 outcome for the encounter — the same snapshot table, retained. This is how "N on Monday, Y on Tuesday" and repeat-N patients are seen. |

### 2.4 Nura-entered

One value: `EFFECTIVE_BEDS` per unit per day with a reason code and who/when. Everything else on the board is derived. (Barrier confirmation after 2 PM is a one-click override of an inferred value, not data entry.)

## 3. Derivations

### 3.1 The prediction, and the EDD-time question

On whether users can enter an expected discharge *time*: Epic's core EDD item is a date (Clarity `ADT_VISIT_INFO.EXP_DISCHARGE_DATE`, item EPT 10303), and the Connect Care data dictionary lists only the date, its comment, and its history. UI Health Care's education material refers to "the Expected Discharge Date (EDD) and Time in Epic," so a time component exists in at least some Epic builds and versions, and HL7 carries one (PV2-9 is date/time). I have not found Epic documentation confirming it is standard, and Virtua's own notes only mention clinical and predictive EDD. So: **not certain, and site-dependent.** The spec therefore treats the Y/N source as configurable and never assumes a time exists.

    PRED_2PM =
      case tenant.pred_source
        when 'FLAG'      then PRED_FLAG_RAW                       -- dedicated Y/N field (flowsheet row / custom item)
        when 'EDD_TIME'  then 'Y' if EDD_DATE = today and EDD_TIME <= 14:00
                              'N' if EDD_DATE = today and EDD_TIME >  14:00
                              'N' if EDD_DATE <= today + list_horizon_days
                              null otherwise
        when 'EDD_DATE'  then 'Y' if EDD_DATE = today            -- date-only sites: today = Y, tomorrow = N
                              'N' if EDD_DATE <= today + list_horizon_days
                              null otherwise
      end
      ; null also when PRED_UNKNOWN or patient not bedded on an inpatient unit

The `EDD_DATE` mode is the honest baseline: "EDD = today" is what nurse managers can set everywhere, and it is close to RTDC's own definition (a Y is a discharge you expect today, by 2 PM). Its weakness is that it cannot express "today, but after 2 PM" — those show as Y and depress accuracy — which is exactly the case the `FLAG` or `EDD_TIME` modes fix. Recommendation: launch on `EDD_DATE` where nothing else exists, and move a site to `FLAG` as soon as it will build one field. Accuracy is reported with the mode attached so sites are not compared across modes.

### 3.2 Everything else

| Derived value     | Definition                                                                                                                                                                                                                                      |
|-------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Available beds    | STAFFED − OCCUPIED − BLOCKED at S2.                                                                                                                                                                                                             |
| Effective beds    | Available + entered adjustment (reason-coded). Defaults to available.                                                                                                                                                                           |
| Predicted Y       | count(PRED_2PM = 'Y') on the unit at S2. Capacity = effective beds + predicted Y.                                                                                                                                                               |
| Demand            | 1st pass = bed requests + OR expected + downgrade requests; 2nd pass = ED likely + procedural expected + anticipated downgrades + ED forecast. Whole numbers, by source.                                                                        |
| Status            | Capacity − demand; \< 0 red, = 0 even, \> 0 green. Persisted per unit-day in `rtdc_day_unit.status` at S2 (recomputed when effective beds are edited) — the Mismatch Heatmap reads this column, so the heatmap always equals what the room saw. |
| Needed-by         | DC order: 14:00 − unit DO→DC median. Pending item: order needed-by − class order→result median. Floor at now; "already late" if past.                                                                                                           |
| Steps to Yes      | Pending items (ordered by needed-by) + DC order if absent + narrative items not matched by an order (transport, family, scripts) shown as narrative-only.                                                                                       |
| Y at risk         | Y with no DC order by 11:00, or any pending item past needed-by, or dispo Home/HH and no transport request by 12:00.                                                                                                                            |
| Night/AM fidelity | Listed patients with a prediction-source edit in \[15:00, 07:00) ÷ listed; and with an edit or review in \[07:00, 08:20) ÷ listed. From PRED_EDIT_LOG.                                                                                          |
| Outcome (S3)      | MET: Y and DISCHARGED_AT ≤ 14:00 · MISSED: Y and not · UNEXPECTED: N and ≤ 14:00 · NOT_ON_LIST: null and ≤ 14:00.                                                                                                                               |
| Accuracy          | MET ÷ (MET + MISSED) per unit-day, mode-tagged; house pooled.                                                                                                                                                                                   |
| Conversion        | Escalation candidates with DISCHARGED_AT ≤ 14:00 ÷ candidates, per rule / unit / attending.                                                                                                                                                     |
| Avoidable N       | N and (discharged ≤ 14:00) or (discharged ≤ 18:00 and DC_ORDER_AT \< 12:00) or (matched a rule that converted ≥ 50% on the unit in the last 30 days).                                                                                           |
| Archetype         | Weekly grouping of avoidable-N by dispo × service × attending × pending-item class × narrative phrase; n, bed-hours (14:00 → actual departure), suggested bin.                                                                                  |

## 4. The huddle report

One page per hospital, one block per unit, the Ns first. Everything on it is read from the 8:20 snapshot. Nothing on it is typed into Nura except the unit's effective beds (unchanged from v3).

| Block                                 | Contents                                                                                                                                                                                                       | Source                                     |
|---------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|--------------------------------------------|
| Header                                | Date · yesterday's house accuracy · unexpected DCs · N→Y conversions yesterday · units reviewed                                                                                                                | Nura scoring (nightly)                     |
| Unit row                              | Staffed − occupied · effective beds (entered) · predicted Y count · demand by source (bed requests, OR by destination, ED likely, downgrades) · status                                                         | Snapshot + forecasts + effective-bed entry |
| The Ns (per red unit, then all units) | Room · initials · attending · disposition · LOS vs GMLOS · EDD & time · MRD/ORD · DC order status · EDD comment verbatim (need + owner) · pending items with needed-by times · **escalation flag with reason** | Snapshot; turnaround medians; rules (§5)   |
| The Ys at risk                        | Y patients with a late-looking step (no DC order by 11:00; pending item past needed-by; transport not requested)                                                                                               | Snapshot; turnaround medians               |
| Ancillary view                        | Pending items across units for Y and escalated-N patients, grouped by service (PT/OT, echo, pharmacy, imaging, lab, transport, placement)                                                                      | Derived from the N/Y lists                 |

**6 East · Rm 652 · JL**Dr. PatelHome w/ HH (TPN)LOS 6.2 d vs GMLOS 4.1`N · EDD today, after 2 PM``Escalate: MRD yes · home dispo · only order pending`

EDD comment: "DC order, HH TPN needs to be arranged, family transportation."

1.  Home health TPN referral — placed 08:10, not yet accepted — *needed by 10:30*
2.  Discharge order — not written; Dr. Patel's median order time on this unit is 13:40 — *needed by 11:00*
3.  Family transportation — narrative only, no transport order — *needed by 13:00*

Facts and a clock. The escalation reason is a rule name, not a score; the room decides whether to move this patient to "Yes, with plan."

## 5. Escalation candidates — the rules

"Auto-suggest candidates to discuss and escalate based on dispositions and other factors" is implemented as a short, tenant-configurable rule table, evaluated on every N at the 8:20 snapshot. Each rule has a name, a plain-English reason that prints on the report, and — after a few weeks — its own measured conversion rate, so the huddle learns which reasons are worth its time. No weights, no model, no ranking beyond rule order and excess LOS.

| Rule              | Fires when (N patient and…)                                                                             | Why it matters                                                                                                |
|-------------------|---------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------|
| ORDER_WRITTEN     | Discharge order already signed                                                                          | The unit predicted N for a patient the physician has released; usually a transport or narrative-only barrier. |
| MRD_HOME          | MRD = yes, disposition Home or Home with HH, no unresulted labs/imaging, no active consult              | Medically ready and nothing clinical pending — a candidate for "Yes, with plan."                              |
| EDD_SLIPPED       | EDD today but time after 14:00 and the only narrative items are MD order / transport / family / scripts | The primer's central move: convert an after-2 PM discharge to before-2 PM.                                    |
| PLACEMENT_SECURED | Disposition SNF/rehab/LTACH and placement accepted (milestone or delay-reason cleared)                  | The hard part is done; what remains is order and transport timing.                                            |
| LOS_EXCESS        | LOS ≥ GMLOS + 1 day, disposition Home, no ICU/PCU level of care, no isolation flag                      | Long-stay home-bound patients on a red unit are where the relative value of a discharge is highest.           |
| SINGLE_STEP       | Exactly one pending item and it is orderable today (echo, PT eval, lab draw)                            | One phone call away from Y.                                                                                   |
| EXCLUDE           | Comfort care, active isolation with cohort constraint, EDD Unknown, in-custody, level of care ICU       | Never suggested; shown for completeness.                                                                      |

Rules read Epic state only. The one text-derived rule (`EDD_SLIPPED`) uses a small keyword list against the EDD comment, tenant-editable, with the matched phrase shown on the report — no free-form NLP.

## 6. Reconcile and learn

After 2 PM, and again in the nightly run, Nura scores everything against ADT. This is the part of the product Epic has no equivalent for, and the part Kartheek asked to build out fully.

| Question                     | Measure                     | Definition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
|------------------------------|-----------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Were we right?               | Prediction accuracy by unit | Y patients discharged ≤ 14:00 ÷ all Y. Plus UNEXPECTED (N discharged ≤ 14:00) and NOT_ON_LIST (no EDD today, discharged ≤ 14:00). Workbook-compatible.                                                                                                                                                                                                                                                                                                                                                                                   |
| Did escalation work?         | N→Y conversion              | Escalation candidates discharged ≤ 14:00 ÷ candidates. Reported per rule, per unit, per attending — so `MRD_HOME` at 62% and `LOS_EXCESS` at 18% tells the huddle where to spend its minutes, and rules that never convert get retired.                                                                                                                                                                                                                                                                                                  |
| Did the process happen?      | Night/AM fidelity           | Share of listed patients with an EDD edit between 15:00 and 07:00 and a review/edit before 08:00 (from EDD history). Share of Y patients with a non-empty narrative.                                                                                                                                                                                                                                                                                                                                                                     |
| Which Ns could have been Ys? | Avoidable-N archetypes      | Population: N patients that (a) discharged ≤ 14:00 anyway, or (b) discharged 14:00–18:00 with DC order before 12:00, or (c) matched a rule and converted on other days. Segment by disposition × service × attending × pending-item class × narrative phrase; report the top archetypes weekly with counts and hours of bed time, e.g. "Home-with-HH on 6 East waiting on referral acceptance — 11 patients, 38 bed-hours." Each archetype carries a suggested tweak drawn from the barrier bin (Epic config / Epic adoption / process). |
| What keeps recurring?        | Barrier tracker             | Inferred barrier per missed Y (late order, placement, transport, pending result) confirmed in one click; same unit + code ≥ 3 of last 5 weekdays → operational fix; ≥ 6 → PI initiative, handed to the bi-weekly workgroup with expected impact.                                                                                                                                                                                                                                                                                         |
| Is Epic getting truer?       | Epic fidelity               | EDD present and dated today for Y patients; discharge event entered ≤ 15 min after departure; Epic Capacity dashboard "expected discharges" vs Nura's Y count.                                                                                                                                                                                                                                                                                                                                                                           |

## 7. Information architecture — where it lives in the app

Inpatient side only. The sidebar's IP domain gets a fourth group named **RTDC** — the methodology's own name, in the position the OR domain gives Capacity Decisions — so the two domains read the same way: Analytics (what happened), Atlas (why), Ask Nura, RTDC (what to do about it today, and what we're learning), Forecasts. Two pages live in the group. **Bed Meeting** is the daily operation: the board, and pulling up the N discharges on a red unit, are one page. **Flow Learning** is the analytics. Each page has tabs on a `/:tab` route exactly like `ReleaseTimeMgmt` and `VolumeImpact`. The whole group is gated by a tenant feature flag so OHS or a non-RTDC tenant never sees it.

    // client/src/navConfig.js — IP_NAV, inserted after 'ask-nura', before 'forecasts'
    {
      id: 'rtdc', label: 'RTDC', icon: 'Scale', type: 'expander', feature: 'rtdc',
      children: [
        // Today: the meeting and its aftermath — the board and the red-unit Ns are one page, four tabs, in the order the morning runs.
        { id: 'bed-meeting',   label: 'Bed Meeting',   type: 'link', path: '/ip/bed-meeting' },
        // Over time: are we getting better, which units are always mismatched, and what keeps getting in the way.
        { id: 'flow-learning', label: 'Flow Learning', type: 'link', path: '/ip/flow-learning' },
      ],
    },

    // client/src/App.jsx — routes
    <Route path="/ip/bed-meeting"        element={<BedMeeting />} />
    <Route path="/ip/bed-meeting/:tab"   element={<BedMeeting />} />
    <Route path="/ip/flow-learning"      element={<FlowLearning />} />
    <Route path="/ip/flow-learning/:tab" element={<FlowLearning />} />

    // navConfig.js — combined tree for CHILD_PATHS / PAGE_TITLES (new group id; OR's capacity-decisions entry is untouched)
    { id: 'rtdc', type: 'expander', children: childrenOf(IP_NAV, 'rtdc') },

    // config/tenantColumns.json — features
    "features": { "rtdc": true, "rtdc_pending_items": true }      // OHS: rtdc_pending_items false; rtdc false until go-live

`filterByFeature` already honors a `feature` key on any nav item, and `/api/tenant-config` already returns `features`; no new mechanism is needed. Rule administration is a section on the existing `/admin` page, not a nav item.

### 7.1 Page: Bed Meeting — `/ip/bed-meeting/:tab`

Chrome above the tabs, shared by all four: a **date** control (defaults to today; past dates are read-only replays of that day's S2 snapshot), a **hospital** selector for multi-hospital tenants (hidden when `hospital_filter` is set), a **snapshot stamp** ("as of 08:20 · refresh") and a **yesterday strip** in the `FunnelStrip` idiom: accuracy · unexpected DCs · N→Y conversions · units reviewed. Nothing on this page polls; it refreshes on open and on the refresh control.

| Tab         | Route              | What's on it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Interactions                                                                                                                                                                                                                            |
|-------------|--------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Board       | /board (default)   | One row per unit in huddle order (unit config). Columns: Unit · Staffed − occ. · **Effective** · Predicted Y · 1st pass · 2nd pass · Status · Sources. Red / even / green status pill; demand sources as small text under the numbers ("OR 5 · Bed req 3 · ED likely 1"); adjustment reason shown italic when effective ≠ available. Footer: house totals and the same status.                                                                                                                                                                     | Click a row → Move to Yes with that unit selected. Click the Effective cell → inline editor: number, reason code select, optional note, save; shows who/when after save. Sort is fixed to huddle order (the script), no column sorting. |
| Move to Yes | /move-to-yes?unit= | Unit selector (red units first, marked). Header for the unit: capacity, demand, status, gap. Then the **Ns** as patient cards (§4 card): room · initials · attending · disposition · LOS vs GMLOS · EDD (+time if the site has it) · MRD/ORD · DC order status · narrative verbatim · steps with needed-by · escalation chips with reason text. Sorted: escalation candidates first (rule order), then by excess LOS. Below a divider, **Ys at risk** with the late-looking step highlighted. Then remaining Ys collapsed ("14 more predicted Y"). | Cards expand/collapse; chip hover shows the rule's 30-day conversion rate for this unit; no input on this tab. Print/tablet layout: single column, cards dense.                                                                         |
| Ancillary   | /ancillary         | Pending items across the hospital for Y and escalated-N patients, grouped by service (PT/OT · Echo/Vascular · Pharmacy · CT/MRI · Ultrasound · IR · Lab · Respiratory · Placement · Transport). Per service: count, and rows of unit · room · item · ordered at · needed by · Y/N-escalated tag. This is the client worksheet's "Ancillary Prioritization" tab, generated.                                                                                                                                                                         | Filter by service; sort within service by needed-by. Read-only.                                                                                                                                                                         |
| Review      | /review            | Available after 14:00 (before that, shows "scores after 2 PM" with the count of Ys still pending). Per unit: MET / MISSED / UNEXPECTED / NOT_ON_LIST counts and accuracy; then the MISSED list with the inferred barrier chip pre-selected and the timeline facts that produced it (order 13:40, departed 15:10…). Escalation candidates marked converted / not.                                                                                                                                                                                   | One click confirms the inferred barrier or picks another from the fixed list; saves immediately with who/when. "Mark unit reviewed" sets the units-reviewed count the next morning's strip shows.                                       |

### 7.2 Page: Flow Learning — `/ip/flow-learning/:tab`

Chrome: date range (default last 4 weeks), hospital, unit (all / one). Charts follow the dataviz conventions already used on the IP Analytics pages (Recharts, tabular numerals, semantic colors only for red/even/green). The Mismatch Heatmap is the first tab because it answers the question a flow leader asks before any other: which units are always short.

| Tab              | Route               | What's on it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Interactions                                                                                                                                                                                                                                                                                                                                            |
|------------------|---------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Mismatch Heatmap | /mismatch (default) | Grid of unit (rows, huddle order) × day (columns, the selected range). Each cell is that day's S2 status for the unit: capacity − demand, colored on a diverging scale centered at 0 (red short → grey even → green surplus), with the number in the cell. Right-hand margin per unit: % of days red · mean gap on red days · streak of consecutive red days. A second view toggles the columns to weekday (Mon–Sun) with the mean status per unit-weekday, so structural patterns ("5W is short every Monday and Tuesday") read at a glance. Hospital total row at the bottom. | Toggle day / weekday view. Click a cell → that day's Board (historical replay) with the unit highlighted. Click a unit label → filters every other tab to that unit. Optional overlay switch: show effective-bed adjustment as a small corner mark on cells where effective ≠ available, so "always red" can be told apart from "always short-staffed". |
| Scoreboard       | /scoreboard         | Tiles: accuracy (mode-tagged) · % days capacity ≥ demand · unexpected DCs · N→Y conversions · median DC time · effective-bed loss. Charts: accuracy by unit over time (line, one series per unit, house bold); MET/MISSED/UNEXPECTED/NOT_ON_LIST stacked by week; effective-bed loss by reason (stacked bar); night/AM fidelity by unit; Epic fidelity (EDD present; DC entry lag ≤ 15 min).                                                                                                                                                                                    | Unit filter narrows every chart; clicking a unit's line sets the filter.                                                                                                                                                                                                                                                                                |
| Escalations      | /escalations        | Rule table: rule · fired (n) · converted (n) · conversion % · trend; below, the same by unit and by attending for the selected rule. Rules with \< 10 firings show n only.                                                                                                                                                                                                                                                                                                                                                                                                      | Click a rule → its firings list (date · unit · room · outcome). Enable/disable and parameters are edited on /admin, not here.                                                                                                                                                                                                                           |
| Avoidable Ns     | /avoidable          | Weekly archetype table: segment (dispo · service · attending · pending-item class · narrative phrase) · n · bed-hours · suggested bin (Epic config / Epic adoption / process) · status. Top 10 by bed-hours, with the plain-English sentence Nura writes for each ("Home-with-HH on 6 East waiting on referral acceptance — 11 patients, 38 bed-hours").                                                                                                                                                                                                                        | Expand → the encounters (date · room · what happened). "Send to workgroup" creates an `rtdc_improvement` row with the archetype attached and marks status = queued.                                                                                                                                                                                     |
| Barriers         | /barriers           | Barrier tracker: unit × code with times-seen in the window, recurrence flag (≥ 3 of last 5 weekdays), bin, status (open · operational fix · PI initiative · resolved), pilot reference.                                                                                                                                                                                                                                                                                                                                                                                         | Change status; link a pilot; "Send to workgroup" as above. This is the list the bi-weekly workgroup opens with.                                                                                                                                                                                                                                         |

### 7.3 Admin — `/admin` (existing page), new section "RTDC"

Per tenant: prediction source mode (`FLAG` / `EDD_TIME` / `EDD_DATE`) and list horizon; huddle order of units; effective-bed reason codes; barrier codes; escalation rules (enable, parameters, keyword list, reason text); snapshot times. Admin-only via the existing `RequireAdmin`. Changes take effect at the next snapshot, never mid-meeting.

### 7.4 States, roles, and devices

- **No snapshot yet today** (opened before S2 landed): Board shows yesterday's S2 greyed with a banner "Today's 08:20 snapshot not received"; nothing else renders as if current.
- **Stale snapshot** (S2 older than 3 h while viewing today): amber stamp; data still shown.
- **Historical date**: all tabs read-only; Review shows the confirmed barriers as of that day.
- **Roles**: any authenticated tenant user can read every tab; effective beds and barrier confirmation record the user and are open to all users for now (the meeting room is the control); rules and config are admin-only. A `flow_coordinator` role is a later refinement, not a Phase 1 dependency.
- **Devices**: Board and Move to Yes must be legible on a wall display and a tablet in the huddle room — 1 column under 900 px, cards dense, no hover-only information (chip reasons print inline on small screens).
- **Empty tenant states**: `rtdc_pending_items = false` → steps show "narrative only" and Ancillary shows "pending items unavailable for this tenant"; `PRED_EDIT_LOG` absent → fidelity tiles read "not available".

### 7.5 Files

    client/src/pages/BedMeeting.jsx                 tabs shell + shared chrome (date, hospital, stamp, yesterday strip)
    client/src/pages/bedmeeting/BoardTab.jsx        unit rows, EffectiveBedsEditor
    client/src/pages/bedmeeting/MoveToYesTab.jsx    unit selector, PatientCard list, Ys at risk
    client/src/pages/bedmeeting/AncillaryTab.jsx
    client/src/pages/bedmeeting/ReviewTab.jsx       outcome lists, BarrierChips
    client/src/pages/FlowLearning.jsx               tabs shell + range/hospital/unit chrome
    client/src/pages/flowlearning/MismatchHeatmapTab.jsx · ScoreboardTab.jsx · EscalationsTab.jsx · AvoidableTab.jsx · BarriersTab.jsx
    client/src/components/rtdc/PatientCard.jsx · StatusPill.jsx · RuleChip.jsx · EffectiveBedsEditor.jsx · BarrierChips.jsx
    client/src/pages/Admin.jsx                      + RtdcSettings section
    client/src/navConfig.js · client/src/App.jsx    as above

## 8. Nura-owned tables and routes

    -- NuraOps (encounter keys only; no names / MRNs)
    rtdc_snapshot_pt    (tenant_id, snapshot_at, encounter_key, unit, pred_2pm, pred_mode, ...§2.1 columns)   -- retained history
    rtdc_snapshot_unit  (tenant_id, snapshot_at, unit, staffed, occupied, blocked, demand_json)
    rtdc_day_unit       (tenant_id, date, unit, effective_beds, adjustment, adjustment_reason, adjusted_by, adjusted_at, status)
    rtdc_prediction     (tenant_id, date, encounter_key, unit, pred_2pm, pred_mode, narrative, outcome, discharged_at)
    rtdc_candidate      (tenant_id, date, encounter_key, rule_key, reason_text, fired_at, converted)
    rtdc_rule           (tenant_id, rule_key, enabled, params_json, keywords_json, reason_text)
    rtdc_barrier        (tenant_id, date, encounter_key, code, bin, inferred, confirmed_by)
    rtdc_archetype      (tenant_id, week, dispo, service, attending, item_class, phrase, n, bed_hours, suggested_bin)
    rtdc_turnaround     (tenant_id, unit, metric, median_min, n, computed_at)
    rtdc_improvement    (tenant_id, unit, code, first_seen, times_seen, status, pilot_ref)

    -- routes/rtdc.js  (factory: getTenantPool, sql, requireTenant)
    GET  /api/rtdc/board?date=&hospital=            unit rows + header (Board tab; yesterday strip)
    GET  /api/rtdc/unit/:unit/ns?date=              the Ns with facts, steps, needed-by, candidate flags; Ys at risk below   (Move to Yes tab)
    POST /api/rtdc/unit/:unit/effective-beds        { date, effective_beds, reason, note? }   -- the only meeting-time write
    GET  /api/rtdc/ancillary?date=                  pending items across units grouped by service
    GET  /api/rtdc/review?date=                     outcomes + inferred barriers; POST /review/:enc/barrier to confirm
    GET  /api/rtdc/mismatch?from=&to=&hospital=       unit × day status matrix from rtdc_day_unit (+ weekday means, % red, mean gap, streaks)
    GET  /api/rtdc/scoreboard?from=&to=&unit=       accuracy (mode-tagged), unexpected, conversion by rule, fidelity, effective-bed loss
    GET  /api/rtdc/learn/archetypes?from=&to=       weekly avoidable-N archetypes
    GET/PUT /api/rtdc/rules                         admin
    lib/rtdcPredict.js · rtdcMismatch.js · moveToYes.js · rtdcRules.js · rtdcOutcome.js · rtdcArchetype.js   (pure, unit-tested)

## 9. Acceptance criteria

- With `pred_source = EDD_DATE`, a patient with EDD = today is Y and EDD = tomorrow is N; with `EDD_TIME`, EDD today 16:00 is N; with `FLAG`, the raw flag wins. Accuracy output carries `pred_mode`.
- The Ns view for a red unit shows every N with room, initials, attending, disposition, LOS vs GMLOS, EDD (and time if present), MRD/ORD, DC order status, narrative verbatim, steps with needed-by, and candidate rule names with reason text; sorted by rule order then excess LOS; Ys at risk below a divider.
- On OHS (no pending items) the Ns view renders with steps = "narrative only" and no 500.
- A unit with no effective-beds entry uses available beds; entering one changes only that unit's status and records who/when.
- Night/AM fidelity is computed only when `PRED_EDIT_LOG` is populated; otherwise reported as "not available for this tenant".
- Rule conversion rates are computed only over days the rule fired; rules with \< 10 firings show n rather than a rate.
- Weekly archetype report on the demo tenant lists ≥ 1 segment with n ≥ 5 and a bed-hours figure; every archetype row links to its encounters' S2/S3 rows.
- IP sidebar shows an "RTDC" group with Bed Meeting and Flow Learning only when `features.rtdc` is true for the tenant; OR sidebar is unchanged.
- `/ip/flow-learning` opens the Mismatch Heatmap; every unit-day with an S2 snapshot has a cell whose value equals that day's Board status for the unit; the weekday view's cell equals the mean of those values; clicking a cell opens `/ip/bed-meeting/board?date=` for that day.
- `/ip/bed-meeting` opens the Board tab; `/ip/bed-meeting/move-to-yes?unit=6E` opens that unit; unknown tab ids fall back to Board (same behavior as `ReleaseTimeMgmt`).
- Board rows render in the tenant's configured huddle order; clicking a red row navigates to Move to Yes with the unit preselected.
- Review tab before 14:00 shows the pending state, not zeros; after the nightly scoring run it shows outcomes with inferred barriers preselected.
- Board and Move to Yes render single-column under 900 px with chip reasons visible without hover.
- Nothing writes to any tenant DB table; all writes go to NuraOps.

## 10. Boundary and the Epic-optimization case

The boundary is unchanged and, with the EDD design, cleaner than before. Epic holds today's prediction, in an Epic field, entered by nurses in an Epic workflow. Nura holds every prediction ever made and what came of it. Three tests still apply: does it write to Epic (never — the only writes are nurses updating EDDs); does it need a stream (no — three snapshots); would Epic build it for every customer (Epic will show an expected-discharge count on its Capacity dashboard; it will not score a unit's accuracy, rank escalation rules by conversion, or mine avoidable-N archetypes).

The optimization case gets sharper too: RTDC discipline forces EDDs to be real and current on every patient, every morning, because units are scored on them. That improves Epic's own Capacity Management dashboards, its predicted-census models, and any tele-discharge or transport workflow that keys off EDD — the exact gap Virtua's supervisors named when they said they don't trust the dashboard's expected-discharge count.

## 11. Phasing and what to confirm

Phase 0 · no Epic change

#### Huddle report from the nightly extract, EDD as proxy

Yesterday-evening EDDs approximate the night shift's list; report shown in the 9 AM meeting; escalation rules run on Clarity state. Proves the shape; makes the intraday extract the obvious ask.

Phase 1 · intraday extract + EDD convention

#### Live board, real Ns, effective beds, post-2 PM scoring

Reporting Workbench extract at 6:00 and 8:20. Units adopt "EDD time ≤ 14:00 means Y" and the EDD comment as the narrative. Accuracy, N→Y and fidelity metrics start accumulating.

Phase 2 · standards path + embed

#### FHIR Bulk Group export; SMART EHR launch

Extract replaced by `$export` on a customer-defined inpatient Group; huddle report launched inside Hyperspace. Avoidable-N archetypes and the barrier tracker feed the workgroup.

#### Questions for the client's Epic team (and Hakan)

- Is EDD captured with a time at this site, and is EDD time used by any other workflow (transport, tele-discharge)? If not, is a "≤ 14:00 = before-2 PM" convention acceptable?
- Can a Reporting Workbench report of current inpatients with EDD, EDD comment, MRD/ORD, milestones, DC order and bed-request state be scheduled to export at 06:00 and 08:20 to a location Nura's tenant pipeline can read?
- Is FHIR Bulk Data (`Group/$export`) enabled and licensed; can an inpatient registry be exposed as a Group; what is the throttle?
- Are discharge milestones and delay reasons configured, and which Clarity tables hold them here? (Columns to confirm before Move-to-Yes pending items.)
- Will the organization sponsor a clinician-facing SMART app (client ID download + security review) for Phase 2?
- Hakan: extract landing zone in the tenant DB (`DS_RTDC_Snapshot`), and whether the ED admit-decision / expected-level-of-care fields ride on the same report.

## Appendix A · Epic capabilities and access paths (research, parked)

Everything the flow needs to capture exists in Epic's transition-planning toolset. The question is only which field carries the Y/N and how Nura reads it. The EDD family is the strongest fit, because Epic keeps its full history — who set it, when, and when it was marked reviewed — which is exactly the "night organizes, morning finalizes" audit trail RTDC wants.

| Epic element                                      | What it is                                                                                                                                                                                                                                           | Where it lives                                                            | Fit for the flow                                                                                              |
|---------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------|
| Expected Discharge Date (EDD) & time              | Clinician-entered date the patient should be ready to transition; editable from admission orders, the Admission Navigator, patient-list columns, the Discharge Planning sidebar and Rapid Rounds lists. Many sites capture a time as well as a date. | Clarity `ADT_VISIT_INFO.EXP_DISCHARGE_DATE` (item EPT 10303)              | `Primary` Y/N can be derived: EDD = today and time ≤ 14:00 → Y. Nurse managers already edit it from the list. |
| EDD comment                                       | Free-text explanation entered in the EDD editor; Epic archives every comment.                                                                                                                                                                        | EPT 10445 (archived comments)                                             | `Primary` This is the "clinical discharge narrative": what needs to happen and who will do it.                |
| EDD history                                       | Every entry/change with timestamp and user; also stamps when "Mark as Reviewed" is clicked and when the discharge order is entered.                                                                                                                  | EPT 10442 / 10446 / 10447                                                 | `Primary` Proves the night set it and the AM finalized it; feeds the Epic-fidelity metric for free.           |
| EDD Unknown flag                                  | Binary: discharge timing cannot be determined.                                                                                                                                                                                                       | EPT 10308                                                                 | `Useful` Maps to "not on the list" rather than N.                                                             |
| Predicted EDD (Cognitive Computing model)         | Epic's model-generated expected discharge date, distinct from the clinical EDD; Virtua runs both.                                                                                                                                                    | Clarity predictive-score tables (site-specific)                           | `Input` A candidate signal for tomorrow's list; never the prediction itself.                                  |
| Discharge milestones                              | Role-specific tasks that must be completed before discharge, visible across roles; sites configure the list.                                                                                                                                         | Clarity (site-specific milestone tables)                                  | `Useful` Pending-items source where configured; the narrative covers the rest.                                |
| Discharge delays / delay reasons                  | Reason a medically-ready patient has not discharged, from a pick list.                                                                                                                                                                               | Clarity                                                                   | `Useful` Seed for Nura's barrier codes; usually under-documented.                                             |
| Discharge readiness (MRD / ORD)                   | Medical Readiness for Discharge (provider, binary) and Overall Readiness (multidisciplinary incl. nursing, allied health, mobility); shown on patient lists, sidebars, Rapid Rounds.                                                                 | Clarity                                                                   | `Useful` Strong escalation signal: MRD = yes and N is a candidate by definition.                              |
| Ready to Plan / Ready to Move, bed requests       | Grand Central placement states and requests with timestamps.                                                                                                                                                                                         | Clarity `DS_Bedplacement`-equivalent; FHIR Encounter/Location partially   | `Demand` 1st-pass demand; unchanged from v3.                                                                  |
| Discharge order, pending orders/results, consults | Order status and result times.                                                                                                                                                                                                                       | Clarity `DS_Orders`; FHIR ServiceRequest / Observation / DiagnosticReport | `Facts` Steps-to-Yes list and "needed by" clocks.                                                             |
| Flags (isolation, FYI), level of care             | Patient flags and acute/ALC status.                                                                                                                                                                                                                  | FHIR Flag; Clarity                                                        | `Facts` Effective-bed reasons; escalation exclusions.                                                         |
| Custom flowsheet row or SmartData element         | A site-built "Predicted DC by 2 PM" Y/N.                                                                                                                                                                                                             | Flowsheet (FHIR Observation) or SDE (Clarity `SMRTDTA_ELEM_DATA`)         | `Fallback` Only if the site cannot commit to EDD time semantics.                                              |
| Capacity Management dashboards                    | Epic's house-wide census / expected-discharge / boarding views (Johns Hopkins went live system-wide Oct 2025). Virtua's supervisors distrust its expected-discharge count and note it lacks demand prediction.                                       | Epic UI                                                                   | `Not ours` Nura's accuracy scoring is what would make that count trustworthy.                                 |

### A.2 Access options

RTDC needs three reads a day, not a stream: a pre-huddle snapshot (~6 AM), a huddle snapshot (~8:30 AM) and a post-2 PM scoring pass. That shapes which Epic access path fits. The findings below are from Epic's open developer documentation and integrator guides; specifics vary by customer and must be confirmed with each client's Epic team.

| Path                                                | What it gives                                                                                                                                                                                                                               | Cadence / effort                                                                                                                                                                                                                                                             | Verdict                                                                                                                                      |
|-----------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------|
| Clarity nightly (existing pipeline)                 | Everything, including EDD history, comments, milestones, orders, ADT — yesterday's.                                                                                                                                                         | Nightly. Already built for NHS/OHS.                                                                                                                                                                                                                                          | `Keep` Post-2 PM scoring, learning, turnaround medians. Not usable for the 8:30 board.                                                       |
| Reporting Workbench scheduled extract               | An Epic-native report of current inpatients with EDD, EDD time, EDD comment, disposition, MRD, milestones, DC order, bed-request state — scheduled to run at 6:00 and 8:20 and drop a file (SFTP / Azure) into the tenant DB.               | Intraday, minutes of Epic analyst time, no API program. Some sites restrict scheduled exports of PHI.                                                                                                                                                                        | `Phase 1 default` Lowest friction to a same-morning snapshot; Epic-configured, no vendor sponsorship.                                        |
| FHIR Bulk Data — Group `$export` (backend services) | Standards-based snapshot export of a customer-defined Group (e.g. a "current inpatients" registry / patient list) for Encounter, Observation, DocumentReference, Flag, Condition, ServiceRequest… Client-credentials with RS384-signed JWT. | Snapshot-native and throttled — which suits three pulls a day. Groups are defined by the customer admin, not self-serve. Bulk export is in Epic's gated tier (Vendor Services / per-customer sponsorship) and production activation waits on the customer's security review. | `Phase 2 target` The right long-run path: EMR-agnostic in principle (Oracle Health supports the same operation), no Epic report to maintain. |
| FHIR per-patient reads (backend services)           | Encounter / Observation / DocumentReference per patient.                                                                                                                                                                                    | Encounter.Search is patient-scoped — no "all inpatients on unit X" query — so Nura would need the patient list from elsewhere first. Fine for enrichment of a known list.                                                                                                    | `Supplement` Use to pull the EDD comment / clinical notes for the N list if the extract lacks them.                                          |
| HL7 v2 ADT feed (Bridges / Interconnect)            | Real-time A01/A02/A03/A08 with PV1 location and — notably — `PV2-9 Expected Discharge Date/Time` if the site populates it.                                                                                                                  | Standard interface build; a stream Nura would have to host and persist.                                                                                                                                                                                                      | `Optional` Only if a client already has an outbound ADT feed to point at us; otherwise it is Epic's lane, not ours.                          |
| SMART on FHIR — EHR launch (clinician-facing)       | Nura's huddle report opened as an activity inside Hyperspace, in the user's context, no separate login. Display only.                                                                                                                       | Requires app registration, a sponsoring customer downloading the client ID, and their security review; Showroom listing optional (~\$500/yr tier).                                                                                                                           | `Phase 2` The "no new front end" promise made literal. Data still arrives via the paths above; SMART only carries the user into the page.    |
| Caboodle / Cogito                                   | Epic's warehouse and BI layer.                                                                                                                                                                                                              | Nightly like Clarity; some sites refresh intraday.                                                                                                                                                                                                                           | `Alt` Same role as Clarity where a client prefers it.                                                                                        |

#### Recommended architecture

**Snapshots, not streams.** Phase 1: nightly Clarity for scoring plus a Reporting Workbench extract at 6:00 and 8:20 for the board. Phase 2: replace the extract with a FHIR Bulk Group export on the same schedule, and embed the huddle report in Hyperspace via SMART EHR launch. Nura never calls a write API; the only Epic writes are the ones nurses already make to EDD. This keeps every one of the boundary tests: no writes, no stream, nothing Epic would build for everyone.

### A.3 Field options

A · Recommended

#### EDD date + time, EDD comment

Y = EDD today with time ≤ 14:00. N = EDD today with time after 14:00, or EDD tomorrow-plus with the patient on the unit's list. Not on list = EDD blank / Unknown / beyond the horizon. The narrative is the EDD comment.

Zero build. Uses the field nurse managers already edit from Rapid Rounds. Epic keeps who/when for free. Risk: sites that enter date only, or use EDD time for transport scheduling — align the convention (a 2 PM discharge should have EDD time ≤ 14:00 anyway).

B · Fallback

#### Custom flowsheet row

"Predicted DC by 2 PM: Y / N" as a flowsheet row on the unit's huddle template; narrative stays in the EDD comment.

Explicit and unambiguous; readable through FHIR Observation and Clarity flowsheet tables. Costs an Epic build and a second place to click. Use where Option A's convention will not hold.

C · Not recommended

#### Discharge milestone / SDE

A milestone "Predicted by 2 PM" or a SmartData element.

Milestones are tasks, not predictions, and site configurations differ; SDEs are invisible to FHIR. Both work in Clarity but fit the method less well.

Under Option A the "night organizes, AM finalizes" discipline is measurable without any extra field: EDD history shows an evening edit and a morning review on every patient that followed the process, and the share of Y patients whose EDD was touched before 8 AM becomes a unit-level process metric.

## Sources

Sources: [open.epic — FHIR resources by interface type](https://open.epic.com/Interface/FHIR); [Epic on FHIR documentation](https://fhir.epic.com/Documentation?docId=fhir); [Epic FHIR Bulk Data Access tutorial](https://fhir.epic.com/Documentation?docId=fhir_bulk_data); [Connect Care — EDD data components (ADT_VISIT_INFO, EPT items)](https://builders.connect-care.ca/Techniques/reports-and-analytics/metrics-components/EDD-Components); [Connect Care — EDD workflow](https://manual.connect-care.ca/workflows/patient-movement/transition-planning/estimated-discharge-date); [Connect Care — Discharge readiness (MRD/ORD)](https://manual.connect-care.ca/workflows/patient-movement/transition-planning/discharge-readiness); [UI Health Care — EDD, milestones, delays](https://epicsupport.sites.uiowa.edu/epic-resources/case-management); [Epic FHIR integration guide (app types, auth, activation, gating)](https://nirmitee.io/blog/epic-fhir-integration-guide/); [Johns Hopkins — Epic Capacity Management dashboards](https://it.johnshopkins.edu/featured-articles/epic-capacity-management-dashboards-go-live-system-wide/); RTDC More Detail / RTDC_HP decks; Virtua "System wide capacity huddle" notes; IHI RTDC primer.

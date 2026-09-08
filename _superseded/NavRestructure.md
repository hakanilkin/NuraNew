# Nav Restructure — audience-aligned sidebar

> **Status:** Spec — ready to build
> **Owner:** Kartheek (product) · Decisions locked 2026-08-24
> **Purpose:** make the sidebar read as the questions the demo room asks, in demo
> order: *what happened* (Analytics) → *why* (Atlas) → *what's coming* (Forecasts)
> → *what do I do about it* (Capacity Decisions). The sidebar itself becomes a
> demo asset — you walk it top to bottom while narrating those four questions.
>
> **Decisions locked:** group name is **"Capacity Decisions"** (ISSCM remains the
> methodology name in positioning materials, never on screen); the EBM group
> keeps the **"Atlas"** brand; Open Time folds in as **one entry, "Release Time
> Mgmt,"** with Radar/Tracker/Board as tabs inside the page.
>
> **Rev 2 (2026-08-24):** Forecasts **keeps its own group** rather than dissolving
> into Analytics, and **Actual vs Budget moves into it**. Two reasons: a forward
> view inside the retrospective group is a category error, and the sidebar is a
> positioning artifact — a group named "Forecasts" advertises the S3 claim
> ("everyone else tells you what happened; this is your next four weeks") to the
> CIO for the entire demo. It also reunites the `/schedule-forecast/*` family,
> which is currently split across two groups.
>
> **Related:** `client/src/navConfig.js`, `client/src/App.jsx`,
> `OpenTimeRadar/Tracker/Board.jsx`, `ORSmoothing.md`, `StaffingAlignment.md`

---

## 1. Target OR nav

```
Analytics                    (BarChart3)          — what happened
  ├─ Case Volumes            /
  ├─ Prime Time Utilization  /capacity
  ├─ Block Utilization       /block-utilization
  └─ Room Running            /room-running

Atlas                        (Map)                — why
  ├─ FCOT Drivers            /atlas/fcot
  └─ Turnover Time           /atlas/turnover
      (Performance Briefs moves OUT — it is a work queue now, not a model page)

Ask Nura                     (unchanged, global)

Forecasts                    (TrendingUp)         — what's coming
  ├─ Daily Summary           /schedule-forecast/daily
  ├─ Daily Detail            /schedule-forecast/detail
  └─ Actual vs Budget        /schedule-forecast/cases      ← moved from Analytics

Capacity Decisions           (Scale icon — keep what's there)  — what to do
  ├─ Performance Briefs      /atlas/performance-briefs     ← moved from Atlas
  ├─ Release Time Mgmt       /open-time                    ← Open Time folded in
  ├─ OR Smoothing            /or-smoothing
  ├─ Staffing                /staffing
  └─ (Financial Analysis — added when unparked; leave no placeholder)
```

The standalone **Open Time** group disappears; **Forecasts stays** (see Rev 2
above) and gains Actual vs Budget, reuniting all three `/schedule-forecast/*`
routes in one group. Ordering within Forecasts puts the drill sequence first
(Summary → Detail) with the vs-plan view last; easy to flip if the demo reads
better the other way. IP nav is untouched by this spec.

## 2. Release Time Mgmt — one page, three tabs

- `/open-time` renders a single page with **Radar / Tracker / Board** as tabs,
  using the existing tab idiom (the surgical/endoscopy pattern). The three
  current page components become the tab bodies — refactor the shells, do not
  rewrite the content.
- **Route stability:** `/open-time/radar`, `/open-time/tracker`,
  `/open-time/board` keep working — redirect (or deep-link) to the matching tab.
  The Briefs ACT hand-off (`?caseBlock=`) and GROW→Board hand-off must land on
  the right tab with their params intact — regression-check both.
- Default tab: Radar.

## 3. Rules

- **Routes do not change.** This is a nav + page-shell change only; no API
  changes, no renamed paths. Deep links and the two Briefs hand-offs are the
  regression surface.
- Keep per-page titles as they are (`navConfig.js` `pageTitle` mechanism).
- Feature flags: `smoothing` / `staffing` entries render only when the tenant
  has the flag (as built); Briefs and Release Time Mgmt render for all tenants.
- Update the combined `navConfig` export (CHILD_PATHS / PAGE_TITLES union) to
  match — it currently indexes by group position, which this restructure will
  break if done naively.

## 4. Acceptance

- [ ] Sidebar shows exactly the four groups + Ask Nura above, in that order:
      Analytics · Atlas · Ask Nura · Forecasts · Capacity Decisions.
- [ ] Actual vs Budget appears under Forecasts and no longer under Analytics;
      `/schedule-forecast/cases` still resolves.
- [ ] `/open-time` shows tabs; the three old URLs land on the right tab.
- [ ] Briefs ACT row → Release Time Mgmt Radar tab, filtered to the block;
      GROW row → Board tab.
- [ ] NHS/OHS: Smoothing/Staffing absent (flags), everything else present —
      no blank groups, no dead links.
- [ ] Demo tenant: full nav as diagrammed.

# Volume Impact — Service Line Breakdown tab

> **Status:** Change spec · amends `VolumeImpact.md`
> **Owner:** Kartheek (product) · 2026-08-28
> **Replaces:** `VolumeImpactMatrix.md` (both revs — delete it)
>
> **What changes.** The specialty × date matrix becomes **its own tab, first in
> the row**, rather than shared context above the tabs. Volume Impact goes from
> four tabs to five:
>
> ```
> Service Line Breakdown · Budget · Inpatient · Staffing · PACU & Ancillary
> ```
>
> The framing gets better for it: **tab 1 is the forecast, tabs 2–5 are what it
> does to you.**
>
> **Explicitly removed from the previous iteration** — do not build these:
> the matrix in the shared header; click-to-filter across tabs; shared filter
> state; the filter indicator line; the collapse toggle and its persistence.
> The shared header returns to what it was: site selector, window selector, and
> the one-line summary with booked and expected-to-book.

---

## The tab

Specialty × date, forecast cases, for the selected window.

```
                 ── Sep 1 ──────────   ── Sep 8 ──────────   ── Sep 15 ─────────
                 M1  T2  W3  T4  F5    M8  T9 W10 T11 F12   M15 T16 W17 T18 F19    Total
Orthopedics       8  11   6  19   7     7  10   5  21   6     9  12   7  18   8      154
Spine             4   3   9   5   2     3   4  11   4   3     5   2  10   6   2       73
General Surgery  12  10  11   9  10    11  12  10  11   9    10  11  12   8  11      157
Urology           6   7   5   6   6     5   6   6   7   5     6   7   4   6   6       88
GYN               5   6   6   5   4     6   5   5   6   4     5   6   6   5   5       79
ENT               4   5   4   4   4     4   4   5   4   3     4   5   4   4   4       62
Plastics          2   2   2   3   2     2   3   2   3   2     3   2   2   3   2       35
                ───────────────────   ───────────────────   ───────────────────
Total            41  44  43  51  35    38  44  44  56  32    42  45  45  50  38      648
```

**Cell = forecast cases for that service line on that date.** No averaging — the
point of the tab is to tell a downstream area what is actually coming on a named
day, and a weekday tendency cannot staff Thursday the 18th.

**Columns** — every operating weekday in the window, grouped into week bands
with a light separator and the week-commencing date above each band. Header
shows weekday initial plus date number.

- Non-operating days omitted, not shown empty.
- Holidays rendered muted with the reason on hover — a quiet column that turns
  out to be Thanksgiving is a support ticket.

**Rows** — all service lines, since a full tab has the room. Sorted by window
total descending.

**Totals** — the **Total row is the most important line on the tab**; daily case
load is what PACU, pre-op and the units plan against. Give it visual weight. Row
totals in a right-hand Total column.

**Shading** — sequential single hue by cell value, value always printed so it
reads in greyscale. Must look distinct from the Budget tab's *diverging*
forecast-vs-budget grid; two grids on one page reading as the same thing is
worse than one of them not existing.

**Scrolling** — the matrix sits in its own `overflow-x: auto` container with the
service labels and Total column pinned, so the page body never scrolls sideways.

The weekday pattern survives without averaging: with week bands aligned Mon–Fri,
a recurring Thursday cluster reads as a vertical stripe down the same position
in every week.

---

## Data

`V4_FORECAST_COMPILE` already carries `Date`, `SurgeonService` and the case
columns at this grain. No new tables, no pipeline work, no aggregation beyond a
sum.

```
cases = SCHEDULED_INPATIENT + SCHEDULED_OUTPATIENT
      + FORECAST_INPATIENT  + FORECAST_OUTPATIENT
grouped by SurgeonService × Date over the window
```

Resolve the service column through `resolveColumn(tenantName, …)` — OHS maps
`SERVICE_LINE` to `ENC_HOSPITALSERVICE`, and this is the class of bug that hid
in `DEST_CATEGORY`.

```
GET /api/impact/breakdown?from&to&sites
      → { dates:    [ { date, dow, holiday? } ],
          services: [ { service, byDate: [n,…], total } ],
          totals:   { byDate: [n,…], window } }
```

Its own endpoint, consistent with one endpoint per tab.

---

## Acceptance

- [ ] Five tabs, Service Line Breakdown first and default.
- [ ] Shared header contains only site, window and the summary line — no matrix,
      no filter controls, no collapse toggle.
- [ ] No cross-tab filtering anywhere; clicking the matrix does nothing.
- [ ] Columns are actual dates in aligned Mon–Fri week bands with
      week-commencing labels; no averaging.
- [ ] Total row visually weighted; Total column present; both correct.
- [ ] Non-operating days omitted; holidays muted with reason on hover.
- [ ] Horizontal scroll contained; labels and Total column pinned; page body
      never scrolls sideways.
- [ ] Shading sequential and distinct from the Budget tab's diverging grid;
      readable in greyscale.
- [ ] Service column resolved through tenant config.
- [ ] Demo: Thursday is the heaviest column in the Total row and recovery-heavy
      volume peaks there, so the PACU tab's Thursday peak has a source the room
      can see for itself.

      > **Corrected against the data — carried over from `VolumeImpactMatrix.md`
      > and still not what the seed does.** This bullet asks for *ortho and
      > spine* clustering on the Thursdays. They cannot: ST-1 makes Ortho A's
      > **Thursday** block deliberately light, and Spine holds Mon/Wed/Fri —
      > Monday is the ortho-and-spine day (70% recovery-heavy against Thursday's
      > 57%). The stripe that is genuinely there is **Vascular**: 41 cases on the
      > Thursdays against 8 across the whole rest of the week, in every band.
      > That is ST-8's wrong-day block seen from this tab, so ST-8 and ST-9
      > reconcile on one screen. Making the spec's version true would mean
      > contradicting ST-1, so the seeder is left alone and
      > `scripts/checks/service_line_breakdown_acceptance.py` asserts what the
      > data actually does.

## Out of scope

Surgeon-level rows; sorting controls; export; budget or variance in cells —
the Budget tab owns comparison, this tab owns what is coming.

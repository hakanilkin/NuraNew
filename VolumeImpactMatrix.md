# Volume Impact — specialty × date matrix

> **Status:** Change spec · amends `VolumeImpact.md` §2 (shared context)
> **Owner:** Kartheek (product) · rev 2, 2026-08-28
>
> **What changes.** The shared header gains a **specialty × date matrix** of
> forecast case volume for the window. It sits above the tabs, so all four
> consequences are read against one visible cause.
>
> **Rev 2 — dates, not weekday averages.** The purpose of this matrix is to give
> downstream areas a concrete sense of what is coming: PACU, pre-op, sterile
> processing and the inpatient units need *"Thursday the 17th brings 58 cases,
> 19 of them ortho."* A weekday average — "Thursdays are usually busy" — cannot
> staff a specific day, which is the only thing those areas actually do with it.
>
> **Decisions locked:** shared context above the tabs · **actual dates** as
> columns · **cases only** in cells.

---

## 1. Why it belongs in the header

The page's premise is "one forecast, four consequences." Until now the forecast
was a single summary line, so each tab had to re-establish what was driving it.
The matrix makes the *cause* permanently visible while you move between effects.

It is also the answer to the question the demo invites. When the PACU tab shows
a Thursday afternoon peak, the first thing a periop director asks is *"why that
day?"* The matrix has already answered it — with the date, not a tendency.

**The weekday pattern is not lost.** With columns grouped into aligned Mon–Fri
week bands, a recurring Thursday cluster reads as a vertical stripe down the
same position in every week. You get the specific dates *and* the pattern, which
is strictly more than averaging would have given.

---

## 2. The matrix

```
                 ── Sep 1 ──────────   ── Sep 8 ──────────   ── Sep 15 ─────────  …
                 M1  T2  W3  T4  F5    M8  T9 W10 T11 F12   M15 T16 W17 T18 F19    Total
Orthopedics       8  11   6  19   7     7  10   5  21   6     9  12   7  18   8      154
Spine             4   3   9   5   2     3   4  11   4   3     5   2  10   6   2       73
General Surgery  12  10  11   9  10    11  12  10  11   9    10  11  12   8  11      157
Urology           6   7   5   6   6     5   6   6   7   5     6   7   4   6   6       88
GYN               5   6   6   5   4     6   5   5   6   4     5   6   6   5   5       79
ENT               4   5   4   4   4     4   4   5   4   3     4   5   4   4   4       62
Other             2   2   2   3   2     2   3   2   3   2     3   2   2   3   2       35
                ───────────────────   ───────────────────   ─────────────────── 
Total            41  44  43  51  35    38  44  44  56  32    42  45  45  50  38      648
```

**Cell = forecast cases for that specialty on that date.** No averaging, no
derived rate — the number a downstream area would plan against.

**Columns:** every operating weekday in the window, grouped into week bands with
a light separator and the week-commencing date above each band. Header shows
weekday initial plus date number (`T18`), two lines if it reads better.

- Weekends and configured non-operating days are omitted, not shown empty.
- A date with a holiday flag is rendered muted with the reason on hover — a
  quiet column that turns out to be Thanksgiving is a support ticket.
- **Cap the matrix at 4 weeks.** If the window is longer, the matrix shows the
  first four and states so; it is context, not the analysis.

**Rows:** top services by volume plus an **Other** row for the tail. Cap named
rows (default 7, `matrix_max_services`) so the header stays compact on every tab.

**The Total row is the most important line on the matrix** — daily case load is
what PACU, pre-op and the units plan against. Give it visual weight.

**Shading:** sequential single-hue by cell value, value always printed so it
reads in greyscale. Must be **visually distinct from the Budget tab's grid**,
which is a diverging forecast-vs-budget scale — two grids on one page reading as
the same thing would be worse than no matrix at all.

---

## 3. Interaction — click to filter

The matrix drives the tabs; it does not decorate them.

- Click a **row label** → filter all tabs to that specialty.
- Click a **column header** → filter all tabs to that date.
- Click a **cell** → filter to both.
- Click again, or **Clear**, to reset.

One filter line beneath the matrix, stated in words: *"Showing: Orthopedics ·
Thu 18 Sep."* Filter state is shared across tabs and survives tab switching —
that persistence is what turns the matrix into a lens rather than a control.

Filtering to a single date is the point: it is how a PACU manager gets from "the
17th looks heavy" to the bay-demand curve for the 17th in one click.

---

## 4. Layout

- Expanded by default; collapsed it cannot do its job. Collapse toggle persists
  per user (`localStorage`); collapsed, the header falls back to the summary line.
- The matrix lives in its own `overflow-x: auto` container so twenty narrow
  columns never make the page body scroll sideways. Row labels and the Total
  column stay pinned while the dates scroll.
- Respects the shared **site** and **window** selection like everything else in
  the header.

---

## 5. Data

`V4_FORECAST_COMPILE` carries `Date`, `SurgeonService` and the scheduled +
forecast case columns at exactly this grain — no new tables, no pipeline work,
and no aggregation beyond a sum.

```
cases = SCHEDULED_INPATIENT + SCHEDULED_OUTPATIENT
      + FORECAST_INPATIENT  + FORECAST_OUTPATIENT
grouped by SurgeonService × Date, over the window
```

Resolve the service column through `resolveColumn(tenantName, …)` rather than
hardcoding — OHS maps `SERVICE_LINE` to `ENC_HOSPITALSERVICE`, and this is
exactly the class of bug that hid in `DEST_CATEGORY`.

**API** — extend the existing summary endpoint rather than adding a route:

```
GET /api/impact/summary?from&to&sites
      → { forecast, booked, expectedAdds, budget, variancePct,
          matrix: { dates: [ { date, dow, holiday? } ],
                    services: [ { service, byDate: [n,…], total } ],
                    totals: { byDate: [n,…], window } } }
```

Filter parameters (`service`, `date`) apply to every `/api/impact/*` endpoint so
the tabs respond to matrix clicks through one mechanism.

---

## 6. Acceptance

- [ ] Columns are actual dates, grouped into aligned Mon–Fri week bands with
      week-commencing labels; no averaging anywhere.
- [ ] Cells show forecast cases for that specialty on that date.
- [ ] Total row present and visually weighted; row totals column present.
- [ ] Non-operating days omitted; holidays muted with the reason on hover.
- [ ] Matrix caps at 4 weeks and says so when the window is longer.
- [ ] Horizontal scroll is contained; row labels and Total column stay pinned;
      the page body never scrolls sideways.
- [ ] Shading sequential and distinct from the Budget tab's diverging grid;
      every value readable in greyscale.
- [ ] Row / column / cell click filters all four tabs; filter stated in words,
      clearable, and surviving tab switches.
- [ ] **Demo:** the matrix makes ST-9's cause visible — ortho and spine
      concentrated on the Thursdays, forming a visible vertical stripe across
      week bands, so the PACU tab's Thursday peak has its source on the same
      screen and on the same date.
- [ ] ST-3's light Fridays read as low columns in the Total row.
- [ ] Service column resolved through tenant config, not hardcoded.

## 7. Out of scope

Surgeon-level rows (specialty only); sorting or reordering; export; budget or
variance in cells — the Budget tab owns comparison, this owns what is coming.

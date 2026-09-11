# Service Line Breakdown — quieter grid

> **Status:** Change spec · amends `ServiceLineBreakdown.md` and
> `ServiceLineBreakdownPatientType.md` (presentation only)
> **Owner:** Kartheek (product) · 2026-09-11
> **Branch:** `feature/or-demo-updates`. Commit separately; same PR.
> **Mockup:** "Breakdown, Calmer" (published artifact) — build to it.

> ## Read this first
>
> **Presentation only. No endpoint change, no query change, no data change.**
> `/api/impact/breakdown` returns exactly what it returns today. This is CSS,
> markup and one default value in `VolumeImpact.jsx`.
>
> - One pass. Do not touch `routes/impact.js`.
> - Do not remove any numbers from the grid.
> - Section 6 is a binding do-not-build list.
> - No new tests. Section 5 says why.

---

## 1. The problem

The tab is dense — ~220 cells before totals — but density is not what makes it
feel crowded. **Magnitude is currently encoded in the type itself**, which the
legend states outright:

```
Fewer 3  6  10  16  23  More cases
```

Every value therefore carries its own weight and darkness. Two hundred numbers
at a dozen competing emphases reads as noise rather than pattern, and no amount
of padding fixes it. The fix is to make the numbers quiet, not to have fewer of
them.

---

## 2. Move magnitude out of the type

**Every number in the grid renders at one weight and one colour** — the muted
body ink. Delete the weight/opacity ramp entirely.

Magnitude moves to a **faint tint behind the cell**, three steps only, scaled
within each service row (a row's own busiest day is its top step):

```
value / rowMax  >= 0.66   ->  step 3
                >= 0.33   ->  step 2
                 > 0      ->  step 1
                   0      ->  no tint, empty cell
```

Steps come from the existing accent ramp at very low intensity — the mockup uses
`#EEF0FE / #DDE1FC / #C5CBFA` on light and `#1E2040 / #272A55 / #343A73` on
dark. Only the top step darkens its text, and only to primary ink.

Cells get a small radius so the tint reads as a soft block rather than a filled
table cell. **Empty cells stay genuinely empty** — no zero, no placeholder.

Replace the legend accordingly: three swatches reading *"Busier day for that
service"*. The five-number ramp goes away with the encoding it described.

---

## 3. Two weeks by default

Default the window to **2 weeks**, not 4. That halves the grid at a stroke, and
the recurring weekday pattern — the whole point of the aligned Mon–Fri bands —
survives two weeks perfectly well.

The existing window control still reaches 4 weeks for anyone who wants it. This
is a change to the default value only.

---

## 4. Structure and rhythm

**A real gutter before the totals block.** `Total` keeps full weight and primary
ink. `OP` / `SDA` / `IP` are set one step smaller and in muted ink, so the right
side reads as one supporting block rather than four more numeric columns. Column
headers for the three are small caps in the faintest ink.

**The type rows sit on a tinted band.** `Outpatient` / `Same-day admit` /
`Inpatient` get a subtle background panel with rounded top-left and bottom-left
corners, their labels indented, and no cell tint of their own. They must read as
a summary *of* the table, not as three more service lines.

**Rules almost entirely removed.** Two horizontal rules survive on the whole
table: one under the sparkline strip, one above the Total row. Everything else
separates with whitespace.

**Row height up** to ~34px for service rows, ~31px for type rows. Week bands keep
the existing gap column; no vertical rules anywhere.

---

## 5. Tests

**None.** This spec changes no data, no endpoint and no arithmetic — the
existing `service_line_breakdown_acceptance.py` already asserts the numbers, and
those assertions must keep passing untouched. Adding tests for spacing and
colour would be testing taste.

Verify by eye against the mockup at 1, 2 and 4 weeks.

---

## 6. Deliberately not built

Binding. Do not add these, and do not ask:

- Removing numbers from cells, or hover-only values.
- Any endpoint, query or aggregation change.
- Sticky/pinned columns.
- Sorting controls, column hiding, or density toggles.
- Per-cell tooltips.
- Changing the tint to a full sequential heatmap, or to more than three steps.
- Touching the Budget, Inpatient, Staffing or PACU tabs.

---

## 7. Open call for Kartheek

The sparkline strip and the Total row now state the same daily figures twice —
bars for shape, numbers for value. The mockup keeps both. **If it still reads
heavy, dropping the bars is the largest remaining cut**; make that call after
seeing it live rather than in advance.

---

## 8. Acceptance

- [ ] Every grid number renders at one weight and one colour; the type ramp and
      its five-number legend are gone.
- [ ] Cell tint is three steps, scaled within each service row; zero-value cells
      are empty and untinted.
- [ ] Window defaults to 2 weeks; 1 and 4 still reachable.
- [ ] Gutter before Total; OP/SDA/IP smaller and muted; Total keeps its weight.
- [ ] Type rows sit on a tinted band and read as a summary of the table.
- [ ] At most two horizontal rules on the table; no vertical rules.
- [ ] Numbers are unchanged — the acceptance script still passes as-is.
- [ ] Legible in both light and dark; tint steps defined for both.
- [ ] Page body never scrolls sideways at 4 weeks.

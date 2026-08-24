# Bright Memorial Health — demo tenant seeder

Builds the fully synthetic third tenant described in [`DemoTenant.md`](../../DemoTenant.md):
a real Azure SQL database, the production schema, and authored data engineered so
the head-to-head demo runs on the real app through the real tenant plumbing.

No row here comes from a client database. Realism comes from fitted distribution
*parameters* — shapes, not records — and every name is machine-generated.

## What's here

| File | What it does |
|---|---|
| `demo_config.py` | The authored world: sites, rooms, units, services, the weekly block grid, the staffing plan, vocabularies, and the numeric target for every storyline. |
| `roster.py` → `roster.json` | Surgeons, block panels, and the storyline cast. Committed, so "Dr. Vance" means the same person across reseeds. |
| `fit_distributions.py` → `demo_distributions.json` | Distribution parameters read from a real tenant (read-only, aggregates only). `--offline` writes hand-authored defaults instead. |
| `extract_schema.py` → `create_demo_schema.sql` | Reads `INFORMATION_SCHEMA` from the source tenant and emits Demo's DDL, so structure cannot drift. Objects the source does not have are derived from the generator instead (see below). Also emits `schema_snapshot.json`. |
| `generate_or.py` / `generate_ip.py` | The generators. Cases first; everything else is derived from them. |
| `verify.py` | Measures the generated data against every storyline target and prints actual vs target. |
| `seed_demo_tenant.py` | CLI that runs the whole thing and either dumps CSV or loads the database. |
| `seed_opentime_store.js` | Seeds the Open Time workflow queue for the demo tenant only. |

## Runbook

Prerequisite (one-time, Hakan): an empty `Demo` database and a `demo_app` login
with `db_owner` on `Demo` only.

```bash
# 0. credentials — add to .env (never committed), see .env.example
#    DEMO_DB_SERVER / DEMO_DB_DATABASE / DEMO_DB_USER / DEMO_DB_PASSWORD

# 1. roster (already committed; only re-run to change the cast)
python scripts/demo/roster.py --seed 42

# 2. distribution parameters
python scripts/demo/fit_distributions.py            # fits from nhs, read-only
python scripts/demo/fit_distributions.py --offline  # or: no DB, authored defaults

# 3. schema — extract, review, then run the SQL against Demo
python scripts/demo/extract_schema.py
#    review scripts/demo/create_demo_schema.sql, then execute it against Demo

# 4. generate and check without touching the database
python scripts/demo/seed_demo_tenant.py --seed 42 --dry-run

# 5. load
python scripts/demo/seed_demo_tenant.py --seed 42 --load --reseed

# 6. models — run every pipeline against the demo tenant, commit the JSON
python ebm_pipeline.py --tenant demo
python turnover_ebm_pipeline.py --tenant demo
python bed_placement_pipeline.py --tenant demo
python do_dc_pipeline.py --tenant demo
python do_los_pipeline.py --tenant demo
python los_segments_pipeline.py --tenant demo
python performance_briefs_pipeline.py --tenant demo

# 7. register the tenant on the Admin page (name: Bright Memorial Health),
#    then seed the Open Time queue with the tenant id the app assigned
node scripts/demo/seed_opentime_store.js --tenant-id <id>
```

Demo-week refresh: repeat steps 4–6 with the same seed. The anchor date defaults
to today, so "next Thursday" is genuinely next Thursday.

## When the source database is missing an object

`V4_FORECAST_COMPILE` and `V4_Inpatient_Forecast_Compile` do not exist in Virtua
— not as tables, views or synonyms. Rather than block, `extract_schema.py`
derives their DDL from the frames the seeder produces for them (dates to `DATE`,
timestamps to `DATETIME2`, whole numbers to `INT`, other numbers to `FLOAT`,
text to `NVARCHAR` sized to the longest value generated, everything nullable so a
demo-week reseed cannot fail the load). Those tables land in a clearly labelled
**Generator-derived tables** section of the SQL, and `schema_snapshot.json`
records which tables came from where. `--no-derive` turns it off.

That makes the generator the authority on those two tables' structure, so a
column the routes select but the generator never emits would be an
`Invalid column name` on a page nobody opened during the build. This guards it:

```bash
python scripts/checks/generated_schema_coverage.py
```

It does four things:

1. Parses the SQL in `routes/*.js` and compares the columns referenced against
   each derived table to what the generator produces. This is how `ACTUAL` and
   `BUDGET` — selected by the Cases-vs-Budget page, absent from the generator —
   were caught.
2. Cross-checks a hand-read list, for the columns its parser deliberately skips
   (`Date` collides with a SQL keyword, `Caseblock` with its own alias).
3. Validates that the rendered derived DDL is well-formed.
4. For the tables that *are* extracted, checks every column the seeder authors
   actually exists in `schema_snapshot.json`. A misnamed column is silently
   skipped by the loader and the page reading it renders empty — this caught
   `CaseID` (really `_ID_CaseID`), `ORGroup` (really `ORLoc`), `SERVICE_LINE*`
   on `DS_CASES` (they live on `DS_Encounters`), `DEST_*` on `DS_Encounters`
   (they live on `DS_Bedplacement`), and `AVAILABLE_BEDS` / `OCC_PCT` on
   `DS_Occupancy` (not columns at all).
5. Checks every value is bindable to its column's declared type, across all
   three sources of declaration — the snapshot, the derived DDL, and the
   Demo-first DDL in `demo_config.py`. A string in a `BIT` column is an ODBC
   `22018` partway through a load, with a message naming neither the table nor
   the column. This caught `DD_Holiday` (a `BIT`, being sent the holiday's
   name), `DM_Complete_MedRec` (a `DATETIME2` milestone, being sent `'Y'`/`'N'`),
   `StaffingPlan.ShiftStart`/`ShiftEnd` (`TIME`, being sent `'07:00'`), and five
   integer ids bound to `varchar` columns.

Note that `create_demo_schema.sql` and `schema_snapshot.json` are gitignored —
they are regenerated by step 3 and the snapshot is a large dump of the source
tenant's schema.

## When a load fails

`load_into_db` coerces every value to a plain Python type before binding —
numpy scalars, pandas timestamps, `NaN` and `NaT` all reach the driver as
objects it cannot bind, and the resulting error names neither the row nor the
column. If an insert still fails, the seeder prints the table, the chunk's row
range, the first row of that chunk with each column's declared SQL type, and
then re-runs the chunk one row at a time with `fast_executemany` off to name the
exact row and value the driver rejected.

Batched binding infers a column's type from the first row of a batch and reuses
it, so a value that only fails in row 400 is invisible until each row is bound
on its own. If the row-by-row retry finds no single bad row, the batch binding
itself is the problem:

```bash
python scripts/demo/seed_demo_tenant.py --seed 42 --load --reseed --no-fast-executemany
```

`--batch N` narrows the reported range further.

## Determinism

`--seed 42` with the same anchor date reproduces the database byte for byte.
`--reseed` deletes existing rows first, so reloading is idempotent — safe because
nothing else writes to `Demo`.

## Verification is the definition of done

`seed_demo_tenant.py` runs `verify.py` unless you pass `--no-verify`. It measures
every storyline in `DemoTenant.md` §4 against its target:

```
[ok  ] ST-1 Ortho A Thu block utilisation (trailing 8wk)   57.7 %  (target 58 ±6.9%)
[ok  ] ST-2 Wednesday census attributable to the OR        28.9 %  (target 28 ±14.3%)
[ok  ] ST-3 rooms running at 15:30 (Tue–Thu)                  3.2  (target 3–4)
```

At the committed constants this reports **30 passed, 0 warnings, 0 failed**.

A failure means the seed constants need tuning. It never means a downstream
output should be edited to match — the storylines are engineered by
construction, and patching a summary table would break the reconciliation that
makes the demo credible.

## Notes and open items

- **ODBC driver.** These scripts pick the newest installed SQL Server ODBC
  driver; set `ODBC_DRIVER` to pin one. The older `*_pipeline.py` files still
  hardcode "ODBC Driver 17".
- **`DEST_CATEGORY` is now tenant-configurable** — `config/tenantColumns.json`
  → `unit_category_map`, read by `utils/tenantColumns.js` and by
  `pipeline_config.py`. Demo's entry maps Bright Memorial's units; NHS keeps its
  own patterns; OHS inherits `default`, which is still the NHS list, so nothing
  changed for it. Guarded by `npm run check:unit-categories` and
  `python scripts/checks/unit_category_regression.py`.
- **Still hardcoded to NHS: `SRC_LOC` / `DST_LOC`** in `routes/ipbedplacement.js`
  and `LOC_EXPR` in `routes/ipdischarges.js`. These group a department into
  Emergency / Surgery / Endoscopy via an exact NHS OR-room list. They degrade
  gracefully (falling back to `*_DEPTLOC`) rather than collapsing to "Other", so
  the seeder populates `SOURCE_DEPTLOC` / `DEST_DEPTLOC` and the demo reads
  correctly without a product change. Worth folding into the same config later.
- **ST-3's Friday idle-hours check is a floor, not a point target** (`DemoTenant.md`
  rev 2026-08-24). Nine staffed rooms against a six-room peak necessarily idle
  far more than the original ~12/week figure; the storyline is the visible gap,
  so the check asserts ≥25 room-hours.
- **Row scale** lands near 13k cases rather than the 30–35k in the spec, because
  thirteen rooms running plausible day lengths over thirteen months do not
  produce more. Realism was kept over the row count; the other tables are dense
  (~50k occupancy, ~44k room-running, ~8k encounters).
- **Names.** Sanity-check `roster.json` against the prospect's market before the
  first live demo (`DemoTenant.md` §2).

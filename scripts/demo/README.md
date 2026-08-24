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
| `extract_schema.py` → `create_demo_schema.sql` | Reads `INFORMATION_SCHEMA` from the source tenant and emits Demo's DDL, so structure cannot drift. Also emits `schema_snapshot.json`. |
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
- **`DEST_CATEGORY` is hardcoded to NHS unit names.** `routes/iplos.js` and
  `routes/ipbedplacement.js` derive the unit bucket from `DEP_LASTDEPT` with
  NHS-specific `LIKE` patterns (`%2E%`, `%ICU%`, `%PCU%`, …). Bright Memorial's
  units fall through to "Other", so the IP LOS and Bed Placement breakdowns will
  under-report until that mapping is made tenant-configurable. Tracked as a
  follow-up; it is not something the seeder can fix.
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

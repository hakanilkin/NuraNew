# CLAUDE.md

Guidance for Claude Code (and humans) working in this repository. This file is
loaded automatically at the start of every session.

## What Nura is

Nura is a multi-tenant healthcare analytics dashboard for surgical (OR) and
inpatient (IP) operations. Each client ("tenant") has its own Azure SQL
database; users sign in once and pick a tenant. The app surfaces case volumes,
block/prime-time utilization, room running, and model-driven insight (FCOT,
turnover, bed placement, discharge-order-to-departure), plus "Ask Nura," a
natural-language query assistant.

## Architecture

- **Backend** — Node/Express (`server.js` + `routes/`). Session auth, per-tenant
  SQL Server connection pools, an Anthropic-powered chat endpoint.
- **Frontend** — React + Vite in `client/` (react-router, recharts,
  lucide-react, marked + DOMPurify). Built to `client/dist`, served by Express
  in production.
- **Databases** — Azure SQL. One **auth DB** (NuraOps; env `AUTH_DB_DATABASE`)
  holds `Users`, `Tenants`, `UserTenants`. Each tenant row points at that
  client's own analytics DB; pools are built on demand from the `Tenants` table.
- **Models** — Python pipelines (`*_pipeline.py`) train Explainable Boosting
  Models and write JSON into `public/data/`. The app reads those JSON files; it
  does not run Python at request time.

### Key files
- `server.js` — middleware, auth/session, tenant pools, static serving, routes.
- `routes/auth.js` — login, TOTP (speakeasy), tenant select/switch, password change.
- `routes/admin.js` — user/tenant CRUD (admin only).
- `routes/analytics.js` — OR analytics queries; `routes/filters.js` shared SQL filters.
- `routes/atlas.js` — serves model JSON from `public/data`.
- `routes/askNura.js` — Anthropic tool-use loop over live data + model JSON.
- `lib/secrets.js` — AES-256-GCM encryption for tenant DB passwords.
- `middleware/rateLimit.js` — in-memory limiter for auth endpoints.
- `client/src/App.jsx` — shell, sidebar, routing; `navConfig.js` is the single
  source of truth for navigation.

## Running it

```bash
npm install            # root (server deps — node_modules is NOT committed)
cd client && npm install && cd ..
npm run dev            # server with nodemon on PORT (default 3000)
cd client && npm run dev   # Vite dev server, proxies /api to :3000
npm run build          # installs client deps and builds client/dist
```

Requires a `.env` (see `.env.example`). The client dev server proxies `/api`
to the backend, so run both for local development.

## Guardrails — do not violate

- **Never commit secrets or PHI.** No real passwords, API keys, bcrypt hashes,
  or patient data in the repo. `.env`, `node_modules/`, and `*.xlsx` are
  gitignored. (Note: `Q1_2026_Discharge_Data.xlsx` still exists in git history
  and should be purged with `git filter-repo` before the repo is shared.)
- **Tenant isolation is sacred.** Always query through
  `getTenantPool(req.session.tenantId)`. Never join or read across tenants, and
  never let one tenant's data reach another.
- **Parameterize all SQL** via `.input(...)`. No string interpolation of user
  input into queries.
- **Don't leak internals to clients.** Return generic error messages; log
  details server-side only.
- **Auth/session invariants** — keep `httpOnly`/`sameSite`/`secure` cookie
  flags, session regeneration on login, rate limiting on auth routes, and the
  `mustChangePwd` enforcement intact.

## Workflow

- **Develop on a feature branch**, never commit directly to `main`.
- **Open a PR and wait for explicit approval before merging.** Do not merge to
  `main` unless the user says so.
- Commit only when asked; use clear, descriptive messages in the existing style.
- I cannot reach production or the SQL Server from the sandbox — anything
  needing a real login or live data must be verified by the user.

## Known limitations / context

- The Atlas/EBM model files in `public/data` are currently a single global
  dataset (OLLH) shown to every tenant; making them per-tenant is a larger,
  separate effort.
- `node_modules` is no longer committed, so every deploy must run `npm install`.
- See `DEPLOYMENT.md` for the deploy sequence and the gotchas already hit
  (stale `public/` files, browser caching, required env vars).

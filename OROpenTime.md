# OR Open Time — Block Release & Reallocation

> **Status:** Phase 1 in progress (Release Radar)
> **Owner:** (fill in)
> **Last updated:** 2026-07-22
>
> **Decisions locked (2026-07-22):**
> - Workflow tables live in the **NuraOps auth DB** with a `TenantID` column on every row,
>   filtered by `req.session.tenantId` (never in client analytics DBs). *(Applies from Phase 2.)*
> - **Email provider deferred** — chosen when Phase 2 (request/response loop) starts.
> - Building **Phase 1 (Release Radar) first** — read-only, computed live from `V4_FORECAST_COMPILE`
>   + `V4_BlockResultsView`; needs no new tables and no email.
> **Related:** `client/src/pages/SchedForecastDaily.jsx`, `routes/analytics.js` (`/api/sf/*`),
> `routes/orserviceline.js` (`/pipeline`), `V4_FORECAST_COMPILE`, `V4_BlockResultsView`

---

## 1. Problem & goal

OR block time is allocated to surgeons/practices weeks in advance. When a block owner
isn't going to fill their block, that time is most valuable **if it is released early**
so it can be re-offered to someone with demand. Today the release conversation is manual,
late, and reactive: schedulers eyeball who "looks light," chase practices by phone/email,
and rarely reallocate the freed time strategically.

**Goal:** a closed-loop workflow that lets an OR scheduler, ~4 weeks out:

1. **See** which block owners are likely to under-utilize their block, ranked by risk,
   **with the reasoning** behind each prediction.
2. **Request release** from those practices with one click — a customized, templated email
   whose recipient can answer **Release / Keep / Need more time**.
3. **Track** responses as they come back into a single board.
4. **Reallocate** released time: for each freed slot, see the ranked list of surgeons/practices
   to offer it to, driven by **case pipeline (demand)** and **strategic growth goals**.
5. **Offer** the open time to those targets with one click, asking them to book it.

This is the standard perioperative "block release + open-time marketplace" pattern
(cf. LeanTaaS iQueue, Qventus), built natively on Nura's existing forecast + block data.

---

## 2. What we build on (already in the repo)

| Need | Existing asset | Notes |
|---|---|---|
| Forward per-day, per-site, per-block fill vs. block time | `V4_FORECAST_COMPILE` via `/api/sf/daily`, `/api/sf/detail`, `/api/sf/detail/calendar` | `% Filled = TotalDurwTurn / BlockTime`. `DaysAhead` isolates the future. This is the **forward** signal for the risk score. |
| Historical block utilization **and actual releases** | `V4_BlockResultsView` (`blockTime`, `Total_Prime_Time`, `ReleasedTime`, `CaseBlock`, `Surgeonservice`/`Group_Service`, `BlockDate`, `dd_WeekofMonth`) | `ReleasedTime` is a real label — how often this block has been released before. This is the **historical** signal and a future training target. |
| Demand / pipeline per service line | `/api/orserviceline/pipeline` | Already computes forward booked cases per ISO week vs. a trailing-4-week baseline. Direct input to the **matching** engine. |
| Explainable model pattern | Atlas EBMs (`*_ebm.json`, `routes/atlas.js`, `routes/askNura.js` EBM feature-attribution code) | We reuse the "score + per-feature contribution" idiom so the risk reasoning matches the rest of the product. |
| LLM drafting / summarizing | `routes/askNura.js` calls `https://api.anthropic.com/v1/messages` (model `claude-haiku-4-5`) via `fetch`, key in `ANTHROPIC_API_KEY` | Reuse to personalize email copy and turn risk drivers into a plain-English sentence. Optional; templates work without it. |
| Tenant isolation | `getTenantPool(req.session.tenantId)`, `requireTenant` | Every new query and every new table is tenant-scoped the same way. |
| Tenant config / params | `getParam(tenantName, key)` (`utils/tenantColumns`), `pipeline_config.py` | Where per-tenant thresholds, auto-release policy, and strategic goals live. |
| Admin CRUD pattern | `routes/admin.js` (Users/Tenants) | Template for the settings/goals editor. |
| Nav / page shell | `client/src/navConfig.js`, page pattern in `SchedForecastDaily.jsx` | New pages follow the same MultiSelect + tab + card table conventions. |

**Net-new infrastructure required:** an email/notification sender (no mail library in
`package.json` today), a set of app-owned workflow tables, tokenized public response pages,
and the risk + matching scoring services.

---

## 3. Personas

- **OR Scheduler / Block Coordinator** (primary Nura user) — runs the radar, sends requests,
  works the board, reallocates.
- **Practice / Surgeon office contact** (external, *not* a Nura user) — receives the email,
  clicks Release / Keep / Need more time. Interacts only through a tokenized public page.
- **Perioperative leadership** (viewer) — sets strategic goals, watches released-hours recovered.
- **Admin** — configures tenant email settings, contacts, thresholds, auto-release policy.

---

## 4. The lifecycle (state machine)

Two linked objects: a **Release Request** (about a specific block instance) and, once released,
an **Open Time Slot** that gets reallocated.

```
                 RELEASE REQUEST                              OPEN TIME SLOT
  ┌─────────────┐
  │ IDENTIFIED  │  model flags block instance (~4 wks out)
  └─────┬───────┘
        │ scheduler reviews
  ┌─────▼───────┐
  │  DRAFTED    │  email drafted from template
  └─────┬───────┘
        │ scheduler confirms send
  ┌─────▼───────┐
  │   SENT      │  email delivered, awaiting response
  └─────┬───────┘
        ├───────────────► KEEP        (practice: "no, don't release") → closed
        ├───────────────► DEFER       (practice: "need more time")     → snooze, re-surface
        │                                (no response by deadline)     → EXPIRED (optional auto-release)
        └──► RELEASED ──────────────────────────────► ┌──────────────┐
             (practice: "yes, release")                │    OPEN      │  slot available
                                                       └──────┬───────┘
                                                              │ matching ranks candidates
                                                       ┌──────▼───────┐
                                                       │  OFFERED     │  offer email(s) sent
                                                       └──────┬───────┘
                                                              ├──► BOOKED   (target books it) → closed/won
                                                              └──► LAPSED   (offer window passed) → re-offer
```

---

## 5. Feature breakdown

### F1 — Release Radar (predict + explain)
A ranked list of upcoming block instances (default window: **14–35 days out**, i.e. the
"~4 weeks" horizon plus buffer) that are at risk of under-utilization.

- Columns: Date, Day, Site, Case Block / owner, Service, forecast **% Filled**, **Release-Risk
  score** (0–100), top 2–3 **drivers**, response status, action button.
- Sort by risk descending; filter by site, service, week, and risk threshold.
- Each row expands to a **reasoning panel**: the per-feature contributions (§6) and a one-line
  plain-English summary.
- Reuses the surgical/endoscopy tab split and table styling from `SchedForecastDaily.jsx`.

### F2 — Release Request (one-click, templated, reviewable)
From a radar row (or multi-select), **Draft request** → opens a compose drawer:

- Recipient resolved from a **Block Contacts** table (practice name, email(s)); editable.
- Body rendered from a **tenant template** with merge fields (block, date, current fill,
  release deadline, response buttons). Optional LLM polish for tone/personalization.
- Scheduler edits, then **Send** (or Schedule send). **Nothing is sent without explicit human
  confirmation** — see §11.
- Email contains three tokenized buttons: **Yes, release** / **No, keep it** / **Need more time**.

### F3 — Response tracking (the Tracker board)
A board of all active requests grouped by status (Sent / Released / Keep / Defer / Expired).

- Live status as responses land via the public response endpoint (§8, §10).
- "Need more time" sets a snooze date and re-surfaces the request on the radar then.
- Configurable **response deadline**; optional tenant policy to auto-mark EXPIRED and
  (only if the tenant opts in) auto-release.
- Metrics header: requests sent, hours offered, hours **released**, response rate, avg. response time.

### F4 — Open Time Board + Matching (who to give it to)
Every RELEASED slot becomes open-time inventory. For each slot, a **ranked candidate list**:

- Candidates = surgeons/practices whose profile fits the slot (site/room capability, service line,
  day-of-week pattern) scored by:
  - **Pipeline demand** — forward booked cases vs. baseline for their service (`/pipeline`), and
    backlog pressure.
  - **Strategic goals** — tenant-configured target service lines / procedure types to grow (§7).
  - **Stewardship** — historical utilization of time they've been given.
- Each candidate shows a **why-ranked** explanation (same driver idiom).

### F5 — Fill Offer (one-click offer to targets)
From an open slot, **Offer time** → compose drawer (like F2) to one or more ranked candidates,
asking them to **book through open time**. Tokenized **Claim / Book** and **Pass** actions.
On claim, slot → BOOKED and the scheduler gets the booking details to finalize in the OR system.

### F6 — Settings & goals (admin)
- Block Contacts (practice ↔ email) CRUD.
- Email templates (release request, fill offer) per tenant.
- Strategic goals: weighted target service lines / procedure types.
- Thresholds: risk cutoff, request window, response deadline, auto-release on/off, sender identity.

---

## 6. Release-Risk score & reasoning

**Output per block instance:** `risk ∈ [0,100]` (higher = more likely to under-utilize /
good release candidate) + an ordered list of `{ feature, contribution, direction, detail }`.

**Phase 1 — transparent weighted model (ship first).** A logistic/weighted blend of
normalized, individually explainable features. No black box; the weight × feature value *is*
the reasoning. Candidate features (all derivable from existing views):

| Feature | Source | Intuition |
|---|---|---|
| Forward fill gap 4 wks out | `V4_FORECAST_COMPILE` `% Filled` for the instance | Low forward fill ⇒ high risk |
| Trailing block utilization trend | `V4_BlockResultsView` `Total_Prime_Time / blockTime` over recent weeks | Chronically light block ⇒ high risk |
| Historical release rate | `V4_BlockResultsView` `ReleasedTime > 0` frequency for this block/owner | Frequently released before ⇒ high risk |
| Add-on / late-fill reliance | scheduled-vs-actual timing in forecast + block views | Fills late but does fill ⇒ *lower* release urgency |
| Day-of-week / week-of-month seasonality | `DOW_LONG`, `dd_WeekofMonth` | Systematically light days ⇒ higher risk |
| Holiday proximity | forecast `DD_Holiday` (per EBM feature list) | Near holiday ⇒ higher risk |

Weights start from tenant defaults in `getParam`/config and are tunable. The API returns the
per-feature contributions so the UI reasoning panel and the LLM one-liner both read from the
same numbers.

**Phase 2 — EBM (optional upgrade).** Train an Explainable Boosting Model on
`V4_BlockResultsView` history with `ReleasedTime > 0` (or realized low utilization) as the label,
emitting `open_time_ebm.json` in the same shape the Atlas EBMs already use — so
`routes/atlas.js` / `askNura.js` attribution code applies unchanged. The UI stays identical;
only the score source improves.

> Design so F1's response schema is model-agnostic: `{ risk, drivers[] }`. Swapping Phase 1 → 2
> is a server-internal change.

---

## 7. Matching / reallocation logic (F4)

For an open slot `(date, site/room, service capability, duration)`:

```
candidate_score =
      w_demand    * pipeline_demand_norm      // /pipeline: booked vs baseline, backlog
    + w_strategic * strategic_goal_weight      // tenant target service lines/procedures
    + w_fit       * capability_fit             // service line + site/room + DOW pattern
    + w_steward   * historical_utilization      // rewards good stewards of granted time
```

- `pipeline_demand_norm` — reuse `/api/orserviceline/pipeline` (`vs_baseline_pct`, `n_cases`)
  per candidate service; higher forward demand ⇒ higher score.
- `strategic_goal_weight` — from tenant **Strategic Goals** config: e.g. "grow Total Joints,
  Spine." Candidates in prioritized lines get a boost. This is the "strategic goals of
  increasing certain types of procedures" requirement, made explicit and tunable.
- `capability_fit` — hard filter + soft score: a candidate must be able to use the slot
  (right service, site, room capability); DOW alignment with their usual pattern adds score.
- `historical_utilization` — good stewards of previously granted open time rank higher.

Output mirrors F1: ranked candidates each with a **why-ranked** driver breakdown.

---

## 8. Data model (app-owned, tenant-scoped)

Workflow state is Nura's, not the client's — so it lives in **app-owned tables**, never mixed
into the client analytics DB. Recommendation: store in the **NuraOps auth DB** (which already
spans tenants) with a `TenantID` column on every row, and **always** filter by
`req.session.tenantId`. (Alternative: a dedicated app DB. Do **not** write these into tenant
analytics DBs.) Decision needed — see §14.

```
BlockContact
  ContactID (PK), TenantID, PracticeName, SurgeonService, CaseBlock (nullable),
  ContactName, Email, Phone, Active, CreatedAt

ReleaseRequest
  RequestID (PK), TenantID, CreatedByUserId,
  BlockDate, Site, CaseBlock, SurgeonService,
  RiskScore, RiskDriversJson,           -- snapshot at send time
  Status ENUM(IDENTIFIED,DRAFTED,SENT,RELEASED,KEEP,DEFER,EXPIRED),
  DeadlineAt, SnoozeUntil,
  SentAt, RespondedAt, ResponseChannel, CreatedAt

ReleaseRequestRecipient
  Id (PK), RequestID (FK), ContactID (FK), Email, ResponseToken (unique, hashed),
  TokenExpiresAt, RespondedAt, Response ENUM(RELEASE,KEEP,DEFER)

OpenTimeSlot
  SlotID (PK), TenantID, SourceRequestID (FK, nullable),
  BlockDate, Site, CaseBlock, SurgeonService, DurationMins,
  Status ENUM(OPEN,OFFERED,BOOKED,LAPSED), OfferDeadlineAt,
  BookedByCandidate, BookedAt, CreatedAt

OpenTimeOffer
  OfferID (PK), SlotID (FK), CandidateName, CandidateService, ContactID (FK),
  Email, MatchScore, MatchDriversJson, ResponseToken (unique, hashed),
  Response ENUM(CLAIM,PASS), SentAt, RespondedAt

StrategicGoal
  GoalID (PK), TenantID, SurgeonService/ProcedureType, Weight, Active, Note

EmailTemplate
  TemplateID (PK), TenantID, Kind ENUM(RELEASE_REQUEST,FILL_OFFER),
  Subject, BodyMarkdown, UpdatedBy, UpdatedAt

EmailLog
  LogID (PK), TenantID, RequestID/SlotID, To, Subject, Kind,
  Status ENUM(QUEUED,SENT,FAILED,BOUNCED), ProviderMessageId, Error, CreatedAt
```

Tokens: store only a **hash** of each response token (`ResponseToken`); the raw token lives
only in the emailed URL. Single-use, expiring, unguessable (≥128 bits).

---

## 9. API surface (new)

All under the tenant-scoped, authenticated router (mirroring `/api/sf/*`), **except** the two
public response endpoints, which are token-gated and unauthenticated.

**Authenticated (scheduler):**
```
GET  /api/opentime/radar?from&to&sites&services&minRisk     → ranked at-risk blocks + drivers
GET  /api/opentime/radar/:id/reasoning                      → full driver breakdown for one block
POST /api/opentime/requests            { blockInstances[] }  → create DRAFTED request(s)
POST /api/opentime/requests/:id/send   { subject, body, recipients[] } → send (human-confirmed)
GET  /api/opentime/requests?status                          → tracker board
POST /api/opentime/requests/:id/snooze { until }
GET  /api/opentime/slots?status                             → open-time inventory
GET  /api/opentime/slots/:id/candidates                     → ranked match list + drivers
POST /api/opentime/slots/:id/offer     { candidates[], subject, body } → send offer(s)
CRUD /api/opentime/contacts | /templates | /goals | /settings
```

**Public (token-gated, no session):**
```
GET  /r/:token   → hosted response page (shows block, date, three choices)
POST /r/:token   { response: RELEASE|KEEP|DEFER }   → records response, single-use
GET  /o/:token   → hosted offer page (claim/pass an open slot)
POST /o/:token   { response: CLAIM|PASS }
```

---

## 10. Email & response mechanics

- **Sender:** add one mail transport. Options: SMTP via `nodemailer`, or an HTTP API
  (SendGrid/SES/Postmark) via `fetch` (consistent with how Anthropic is called). Credentials in
  `.env` + tenant `EmailSettings`; never committed. Recommend a provider HTTP API for
  deliverability + bounce webhooks.
- **Templating:** Markdown body + merge fields, rendered to sanitized HTML (the client already
  uses `marked` + `DOMPurify`; mirror server-side or reuse). LLM polish optional and always
  human-reviewed before send.
- **Response links:** each recipient gets unique tokenized URLs. Clicking lands on a hosted Nura
  page (`/r/:token`) with the three choices — robust to email clients that strip one-click POST
  buttons. One confirmation click records the response; token then invalidated.
- **No PHI in email.** Block/date/utilization framing only — no patient identifiers. Explicit
  design rule and review-checklist item.
- **Idempotency & audit:** every send written to `EmailLog`; resend guarded; all status
  transitions timestamped and attributed.

---

## 11. Security, guardrails & compliance

- **Tenant isolation is sacred.** Every authenticated query filters by `req.session.tenantId`;
  every workflow row carries `TenantID`. Public token endpoints resolve the tenant **from the
  token record**, never from user input.
- **Human-in-the-loop sends.** The application never auto-sends a request or offer without an
  explicit scheduler action. Auto-release-on-expiry is **off by default** and only available as
  an opt-in tenant policy the client consents to in writing. (This also keeps the assistant out
  of "sending on the user's behalf" — the human clicks Send.)
- **Token safety:** hashed at rest, single-use, expiring, rate-limited (reuse
  `middleware/rateLimit.js`), no enumerable IDs. Public pages reveal only the block/date, never
  PHI or other practices' data.
- **Parameterized SQL** everywhere (`.input(...)`), generic client-facing errors, details logged
  server-side only — same rules as the rest of the codebase.
- **Auditability:** who sent what, when, to whom, and every response — for governance of block
  release decisions.

---

## 12. UI & navigation

New OR nav group **"Open Time"** (icon e.g. `CalendarClock`) in `client/src/navConfig.js`:

```
Open Time
  ├─ Release Radar    /open-time/radar     (F1 + F2 launch)
  ├─ Tracker          /open-time/tracker   (F3)
  ├─ Open Time Board  /open-time/board     (F4 + F5)
  └─ Settings         /open-time/settings  (F6, admin)
```

Pages reuse existing conventions: `MultiSelect`, surgical/endoscopy tabs, card tables, the
green/red variance coloring, and the calendar heat-map idiom from `DailyDetail.jsx`. Compose
drawers are the only genuinely new UI primitive.

---

## 13. Phased implementation plan

**Phase 0 — foundations**
- App-owned schema (§8) + migrations; decide DB home (§14).
- Mail transport module + `EmailSettings`/`EmailLog`; tokenized public response scaffolding.

**Phase 1 — Radar + reasoning (read-only value)**
- `/api/opentime/radar` with the Phase-1 transparent score (§6).
- Release Radar page (F1). Shippable on its own — pure insight, no emails.

**Phase 2 — Request + response loop**
- Contacts + templates CRUD; compose drawer; send; public `/r/:token` page; Tracker (F2, F3).

**Phase 3 — Reallocation**
- Matching engine + `/slots/:id/candidates` (F4); Open Time Board; fill offers + `/o/:token` (F5).
- Strategic Goals config (F6).

**Phase 4 — Enhancements**
- EBM upgrade for risk (§6 Phase 2); auto-release policy; bounce/webhook handling; analytics
  (hours recovered, win rate, strategic-goal attainment); Ask Nura integration.

---

## 14. Open questions / decisions needed

1. **DB home for workflow tables** — NuraOps auth DB with `TenantID` (recommended) vs. a new
   dedicated app DB. (Not the client analytics DBs.)
2. **Email provider** — SMTP/`nodemailer` vs. HTTP API (SendGrid/SES/Postmark). Deliverability,
   bounce handling, and per-tenant sender identity/domain.
3. **Contact data source** — is there an existing practice/surgeon contact directory to import,
   or do we build Block Contacts from scratch?
4. **Auto-release policy** — do any tenants want expiry to auto-release, and what governance/
   consent is required?
5. **"Room capability" fit** — is room/site capability metadata available to constrain candidate
   matching, or do we approximate by service line + site only for v1?
6. **Risk horizon & thresholds** — confirm the exact request window (e.g. exactly 28 days vs. a
   14–35 day band) and default risk cutoff per tenant.
7. **Strategic goals ownership** — who sets and signs off on target service lines (leadership
   vs. admin), and how often do they change?
8. **Booking hand-off** — on CLAIM, does Nura just notify the scheduler to book in the source OR
   system, or is there an integration to write the booking back?
```

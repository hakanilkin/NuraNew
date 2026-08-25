# Open Time — Fulfillment Queue + demo polish

> **Status:** Spec — ready to build
> **Owner:** Kartheek (product)
> **Last updated:** 2026-08-24
> **Scope:** four changes to Release Time Mgmt, in priority order —
> (1) a **Fulfillment Queue**: a plain worklist so staff can check off decisions
> once entered in the EMR, (2) **release → fill conversion** metrics, (3) a
> **risk gradient** in the seeded radar so it reads as a real work queue,
> (4) **number formatting** on the Open Time Board.
>
> **Rev 2 (2026-08-24) — scope corrected.** An earlier draft built the queue as a
> governance instrument with task aging, staleness and an "hours in limbo" metric.
> Cut entirely. It measured staff diligence at a task they are already motivated
> to do, and a checklist that scores people gets resented rather than adopted.
> The queue is a **work aid**: what needs entering, tick it off, done. The metric
> that actually matters — **how much time was released and what share of it got
> booked** — is the outcome of the capability, not a staff behaviour measure, and
> now lives in §2.
>
> **Related:** `OROpenTime.md` (§8 data model — production tables),
> `lib/openTimeStore.js` (demo store), `NavRestructure.md` (Release Time Mgmt is
> one page with tabs — this adds a fourth), `DemoTenant.md` (seeder storylines)

---

## 1. Fulfillment Queue — a worklist, nothing more

Nura decides; the EMR transacts. So every release and every booking produces one
piece of manual work for a scheduler: enter it in Epic. Today that work lives in
somebody's head or a sticky note. The queue is simply the list, with a checkbox.

Design stance: **this is a staff aid, not a tracking instrument.** No aging, no
staleness flags, no completion-time metrics, no per-user scoring. If a task sits
there a while, that is not a signal the product should editorialise about.

**Demo beat:** "We don't write to your EMR — deliberately. What we do is hand
your scheduler a clean list of exactly what to enter, so nothing gets lost
between the decision and the system of record."

### Task creation (automatic, on state transition)

| Trigger | Task kind | Action text |
|---|---|---|
| Release request → `RELEASED` | `RELEASE_IN_EMR` | "Release *N* hrs — *CaseBlock*, *Site*, *date*" |
| Open time slot → `BOOKED` | `BOOK_IN_EMR` | "Assign *N* hrs to *candidate* — *CaseBlock*, *Site*, *date*" |

Tasks are created by the same code path that performs the transition, so a
decision can never exist without its action item.

### Data model

Demo: a `tasks[]` array per tenant in `lib/openTimeStore.js`, same shape and
conventions as `requests[]` / `slots[]`. Production: a `FulfillmentTask` table in
NuraOps with `TenantID`, per `OROpenTime.md` §8 (add it to that section's list).

```
FulfillmentTask
  TaskID, TenantID,
  Kind        RELEASE_IN_EMR | BOOK_IN_EMR,
  SourceRequestID | SourceSlotID,
  BlockDate, Site, CaseBlock, Service, DurationMins,
  Counterparty            -- practice released from / candidate booked to
  Status      PENDING | DONE | CANCELLED,
  DecidedAt,              -- when the release/claim happened
  CompletedBy, CompletedAt, Note,
  CreatedAt
```

`CompletedBy` exists so a shared queue shows teammates who already handled a
row — it is not a performance record and is never aggregated per user.

### API

Extend the existing `/api/opentime` router:

```
GET   /api/opentime/tasks?status=PENDING|DONE|ALL
        → { tasks: [...], summary: { pending, done } }
POST  /api/opentime/tasks/:id/complete   { note? }
        → marks DONE, stamps CompletedBy from session user + CompletedAt
POST  /api/opentime/tasks/:id/cancel     { note }   -- decision reversed
```

Tenant-scoped, parameterized, generic errors — same rules as the rest.
`CompletedBy` comes from the session, never from the request body.

### UI — a fourth tab on Release Time Mgmt

`Radar · Tracker · Board · **Fulfillment**` (on-screen label: **"Fulfillment"**;
if it reads better to the room, "EMR Actions" is a one-word swap).

- Two sections: **To enter** (PENDING, oldest first) and **Done** (collapsed by
  default, most recent first). A count on each — no other statistics.
- Each row: plain-language action text, the decision date, counterparty, and a
  **Mark done** button opening a small confirm with an optional note.
- Rows are visually uniform — no severity treatment, no colour by age.
- Completing a task is optimistic in the UI but reconciled from the API response.
- Empty state is a real state, not an error: "Nothing to enter."

---

## 2. Release → fill conversion

The outcome metric for the whole Open Time capability, and the one worth putting
in front of leadership: **how much block time did we recover, and how much of it
got used?**

### The funnel

```
Requests sent  →  Hours released  →  Hours offered  →  Hours booked
                  (response rate)                      (FILL RATE)
```

- **Fill rate = booked hours ÷ released hours.** This is the headline. Released
  hours alone flatter the product; released-and-filled is the honest number, and
  it is the one competitors don't publish.
- **Released but still open** = released hours not yet booked. Frame it as
  *available inventory to work*, not as a failure — it is the Board's queue, and
  it is where a scheduler's next hour of effort pays off.
- Secondary: response rate (requests answered ÷ sent), median days from release
  to booking.

### Where it lives

A compact **summary strip at the top of Release Time Mgmt, visible on every
tab** — the funnel reads left to right in four figures. It is page-level rather
than tab-level because the funnel spans Radar → Tracker → Board, and because a
leader opening the page should see the outcome before the mechanics.

```
GET /api/opentime/summary?from&to
      → { requestsSent, hoursReleased, hoursOffered, hoursBooked,
          fillRatePct, responseRatePct, hoursStillOpen }
```

Computed from the workflow store (demo) / workflow tables (production), scoped
by tenant and an optional date window that defaults to the current quarter.

### Demo seed

Seed enough completed history that the strip shows a real fill rate — target
roughly **65–80%**, high enough to be a good story, short of 100% so
"released but still open" is non-zero and the Board has inventory on screen.

## 3. Risk gradient in the seeded radar

**Problem:** the radar currently shows too few at-risk blocks in the 14–35 day
window, so it reads as a one-row demo rather than a working queue.

**Target distribution** in the default window (new storyline **ST-7**), across
both sites and several services:

| Band | Count | Notes |
|---|---|---|
| High (risk ≥ 70) | 3–4 | ST-1's Ortho A Thursday must remain the **top-ranked** row |
| Medium (40–69) | 5–8 | spread across services and both sites |
| Low (< 40) | remainder | the healthy majority — the gradient needs a floor |

**Constraints — do not break what works:**

- ST-1 stays #1: no injected block may out-rank Ortho A Thursday.
- ST-0 background metrics must stay inside their existing `verify.py` tolerance
  bands (prime-time util 70–75%, in-block 68–78%, etc.). Adding light blocks
  pushes utilization down — **re-check these, and if a band breaks, compensate
  elsewhere in the generator rather than widening the band.**
- ST-6's Tuesday/Thursday headroom asymmetry must survive, or the finale breaks.
- Deterministic under the same seed, as always.

Add a `verify.py` check asserting the band counts, so the gradient is a tested
property rather than an accident of tuning.

---

## 4. Number formatting on the Open Time Board

Candidate match scores (and any derived percentages) currently render with full
float precision.

- **Match score → whole number** (`Math.round`), displayed 0–100.
- Percentages → whole numbers; **hours → one decimal**; minutes → whole numbers.
- Apply at the **render layer**, not in the engine — the API keeps full precision
  so ranking and any future tie-breaks stay exact.
- Sweep the same fix across the Board's driver/"why-ranked" panel, which shares
  the number rendering.

---

## 5. Acceptance

- [ ] Marking a release RELEASED creates a PENDING `RELEASE_IN_EMR` task;
      a claimed slot creates `BOOK_IN_EMR`. Neither can exist without the other.
- [ ] Fulfillment tab lists To enter / Done with counts and nothing else —
      no aging, staleness, colour-by-age, or per-user statistics anywhere.
- [ ] Mark done stamps the session user and timestamp; the row moves to Done.
- [ ] Summary strip appears on all four tabs and shows the funnel; fill rate
      lands in the 65–80% band on the demo seed, with "released but still open"
      non-zero and matching the Board's inventory.
- [ ] Demo seed includes a few pending and a few completed tasks.
- [ ] Radar on Demo shows the ST-7 band distribution with Ortho A ranked #1;
      `verify.py` asserts it and all ST-0 bands still pass.
- [ ] No decimals on the Board's match scores; hours to one decimal.
- [ ] NHS/OHS unaffected — tasks are tenant-scoped, other tenants untouched.

## 6. Out of scope

Writing to any EMR; bulk-complete; assigning tasks to named users beyond the
completer stamp; any per-user or time-to-complete reporting — explicitly not
wanted, see Rev 2.

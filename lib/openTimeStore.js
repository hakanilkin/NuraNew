// lib/openTimeStore.js
//
// DEMO-ONLY persistence for the OR Open Time workflow (release requests,
// responses, open-time slots, fill offers, strategic goals).
//
// Backed by a single JSON file so the whole loop is demoable locally with no
// database and no email provider. In production this is replaced by the
// NuraOps auth-DB tables described in OROpenTime.md §8 (same shapes, scoped by
// TenantID). Kept deliberately small and synchronous — demo scale only.

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, '..', '.opentime-demo.json');

let db = load();

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return { tenants: {}, tokens: {} };
  }
}

function save() {
  try {
    fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error('openTimeStore save error:', e.message);
  }
}

function defaultGoals() {
  // Seed a couple of strategic growth targets so the matching demo has signal.
  return [
    { service: 'Orthopedics',    weight: 3 },
    { service: 'Spine',          weight: 3 },
    { service: 'General Surgery', weight: 1 },
  ];
}

function tenant(tid) {
  const key = String(tid);
  if (!db.tenants[key]) db.tenants[key] = { requests: [], slots: [], tasks: [], goals: defaultGoals() };
  // Tenants created before the fulfillment queue existed have no tasks array.
  if (!db.tenants[key].tasks) db.tenants[key].tasks = [];
  return db.tenants[key];
}

const uuid     = () => crypto.randomUUID();
const newToken = () => crypto.randomBytes(16).toString('hex');

/* ── Fulfillment tasks ────────────────────────────────────────────────────
 *
 * Nura decides; the EMR transacts. Every release and every booking therefore
 * leaves one piece of manual work for a scheduler: enter it in Epic. This is
 * that list, and nothing more.
 *
 * Deliberately not an instrument: no aging, no staleness, no completion times,
 * no per-user statistics. A checklist that scores people gets resented rather
 * than adopted, and staff are already motivated to do this work.
 * `completedBy` exists so a shared queue shows who already handled a row — it
 * is never aggregated.
 */

const TASK_KINDS = { RELEASE_IN_EMR: 'RELEASE_IN_EMR', BOOK_IN_EMR: 'BOOK_IN_EMR' };

function createTask(tid, d) {
  const t = tenant(tid);
  const task = {
    id: uuid(),
    kind: d.kind,
    sourceRequestId: d.sourceRequestId ?? null,
    sourceSlotId: d.sourceSlotId ?? null,
    blockDate: d.blockDate ?? null,
    site: d.site ?? null,
    caseBlock: d.caseBlock ?? null,
    service: d.service ?? null,
    durationMins: d.durationMins ?? null,
    counterparty: d.counterparty ?? null,
    action: d.action ?? '',
    status: 'PENDING',              // PENDING | DONE | CANCELLED
    decidedAt: d.decidedAt ?? new Date().toISOString(),
    completedBy: null,
    completedAt: null,
    note: null,
    createdAt: new Date().toISOString(),
  };
  t.tasks.unshift(task);
  save();
  return task;
}

function listTasks(tid, status = 'ALL') {
  const all = tenant(tid).tasks;
  return status === 'ALL' ? all : all.filter(x => x.status === status);
}

function getTask(tid, id) {
  return tenant(tid).tasks.find(x => x.id === id) || null;
}

// `completedBy` comes from the session at the call site, never from a request
// body.
function completeTask(tid, id, { completedBy, note } = {}) {
  const task = getTask(tid, id);
  if (!task || task.status !== 'PENDING') return null;
  task.status = 'DONE';
  task.completedBy = completedBy || null;
  task.completedAt = new Date().toISOString();
  if (note) task.note = String(note);
  save();
  return task;
}

function cancelTask(tid, id, { completedBy, note } = {}) {
  const task = getTask(tid, id);
  if (!task || task.status !== 'PENDING') return null;
  task.status = 'CANCELLED';
  task.completedBy = completedBy || null;
  task.completedAt = new Date().toISOString();
  task.note = note ? String(note) : null;
  save();
  return task;
}

const fmtHours = mins => (mins == null ? null : Math.round((mins / 60) * 10) / 10);

/* ── Release requests ─────────────────────────────────────────────────── */

function createRequest(tid, d) {
  const t = tenant(tid);
  const token = newToken();
  const req = {
    id: uuid(),
    createdAt: new Date().toISOString(),
    blockDate: d.blockDate, site: d.site, caseBlock: d.caseBlock, service: d.service,
    riskScore: d.riskScore ?? null,
    reason: d.reason || '',
    blockTimeMins: d.blockTimeMins ?? null,
    recipientName: d.recipientName || '',
    recipientEmail: d.recipientEmail || '',
    subject: d.subject || '',
    body: d.body || '',
    status: 'SENT',            // SENT | RELEASED | KEEP | DEFER
    token,
    deadlineAt: d.deadlineAt || null,
    snoozeUntil: null,
    respondedAt: null,
    response: null,            // RELEASE | KEEP | DEFER
  };
  t.requests.unshift(req);
  db.tokens[token] = { tenantId: String(tid), kind: 'request', requestId: req.id };
  save();
  return req;
}

function listRequests(tid) {
  return tenant(tid).requests;
}

function getRequest(tid, id) {
  return tenant(tid).requests.find(r => r.id === id) || null;
}

function snoozeRequest(tid, id, until) {
  const r = getRequest(tid, id);
  if (!r) return null;
  r.snoozeUntil = until || null;
  save();
  return r;
}

/* ── Open-time slots ──────────────────────────────────────────────────── */

function createSlotFromRequest(tid, req) {
  const t = tenant(tid);
  const slot = {
    id: uuid(),
    sourceRequestId: req.id,
    createdAt: new Date().toISOString(),
    blockDate: req.blockDate, site: req.site, caseBlock: req.caseBlock, service: req.service,
    durationMins: req.blockTimeMins ?? null,
    status: 'OPEN',           // OPEN | OFFERED | BOOKED
    offers: [],
    bookedBy: null,
    bookedAt: null,
  };
  t.slots.unshift(slot);
  save();
  return slot;
}

/* ── Which of the Board's three lists a slot belongs in ────────────────────
 *
 * The list a row sits in *is* its status, so this is the single rule the Board
 * groups by — no chip repeating it, and no second implementation on the client.
 *
 * "OFFERED with nothing live" is kept as an explicit case rather than assumed
 * away. reopen() below stops that state being created, but a store written
 * before this existed can still hold it, and a slot that silently vanished from
 * all three lists would be released hours nobody is working.
 */
const SLOT_LISTS = { NEEDS_OFFER: 'NEEDS_OFFER', AWAITING: 'AWAITING', BOOKED: 'BOOKED' };

function slotList(slot) {
  if (!slot) return null;
  if (slot.status === 'BOOKED') return SLOT_LISTS.BOOKED;
  const live = (slot.offers || []).some(o => o.status === 'SENT');
  return live ? SLOT_LISTS.AWAITING : SLOT_LISTS.NEEDS_OFFER;
}

/* A slot whose every offer has been declined or has expired was sitting in
 * "awaiting response" awaiting nothing: nobody was going to reply, and the
 * released hours quietly stopped being worked. Fixed where it happens rather
 * than patched in the view, so the store stops holding a state that cannot
 * progress. */
function reopen(slot) {
  if (slot.status === 'OFFERED' && !(slot.offers || []).some(o => o.status === 'SENT')) {
    slot.status = 'OPEN';
  }
  return slot;
}

function listSlots(tid) {
  // Annotated rather than grouped: the caller keeps one array to update in
  // place, and a row moves between lists the moment its own status changes.
  return tenant(tid).slots.map(s => ({ ...s, list: slotList(s) }));
}

function getSlot(tid, id) {
  return tenant(tid).slots.find(s => s.id === id) || null;
}

function createOffers(tid, slotId, candidates) {
  const slot = getSlot(tid, slotId);
  if (!slot) return null;
  for (const c of candidates) {
    const token = newToken();
    const offer = {
      id: uuid(),
      candidate: c.candidate,
      service: c.service || null,
      matchScore: c.matchScore ?? null,
      recipientEmail: c.recipientEmail || '',
      token,
      status: 'SENT',         // SENT | CLAIMED | PASSED | LAPSED
      response: null,
      sentAt: new Date().toISOString(),
      respondedAt: null,
    };
    slot.offers.push(offer);
    db.tokens[token] = { tenantId: String(tid), kind: 'offer', slotId: slot.id, offerId: offer.id };
  }
  if (slot.status === 'OPEN') slot.status = 'OFFERED';
  save();
  return slot;
}

/* ── Strategic goals ──────────────────────────────────────────────────── */

function getGoals(tid) { return tenant(tid).goals; }

function setGoals(tid, goals) {
  const t = tenant(tid);
  t.goals = Array.isArray(goals)
    ? goals.filter(g => g && g.service).map(g => ({ service: String(g.service), weight: Number(g.weight) || 1 }))
    : t.goals;
  save();
  return t.goals;
}

/* ── Public token resolution + responses ──────────────────────────────── */

function lookupToken(token) {
  const idx = db.tokens[token];
  if (!idx) return null;
  if (idx.kind === 'request') {
    const req = getRequest(idx.tenantId, idx.requestId);
    return req ? { kind: 'request', tenantId: idx.tenantId, request: req } : null;
  }
  if (idx.kind === 'offer') {
    const slot = getSlot(idx.tenantId, idx.slotId);
    const offer = slot?.offers.find(o => o.id === idx.offerId);
    return offer ? { kind: 'offer', tenantId: idx.tenantId, slot, offer } : null;
  }
  return null;
}

// Record a practice's response to a release request. Returns { request, slot? }.
function respondToRequest(token, response) {
  const found = lookupToken(token);
  if (!found || found.kind !== 'request') return null;
  const req = found.request;
  const map = { RELEASE: 'RELEASED', KEEP: 'KEEP', DEFER: 'DEFER' };
  if (!map[response]) return null;

  req.response = response;
  req.status = map[response];
  req.respondedAt = new Date().toISOString();

  let slot = null;
  if (response === 'RELEASE') {
    // Avoid duplicating a slot if the link is clicked twice. Read the live
    // array, not listSlots' annotated copies — the caller gets this object back
    // and mutating a copy would silently do nothing.
    const existing = tenant(found.tenantId).slots.find(s => s.sourceRequestId === req.id);
    slot = existing || createSlotFromRequest(found.tenantId, req);
    // The task is created by the same code path that performs the transition,
    // so a decision can never exist without its action item.
    if (!existing) {
      createTask(found.tenantId, {
        kind: TASK_KINDS.RELEASE_IN_EMR,
        sourceRequestId: req.id,
        blockDate: req.blockDate, site: req.site, caseBlock: req.caseBlock,
        service: req.service, durationMins: req.blockTimeMins,
        counterparty: req.recipientName || null,
        decidedAt: req.respondedAt,
        action: `Release ${fmtHours(req.blockTimeMins) ?? '—'} hrs — `
              + `${req.caseBlock}, ${req.site}, ${req.blockDate}`,
      });
    }
  }
  save();
  return { request: req, slot };
}

// Record a candidate's response to a fill offer. Returns { slot, offer }.
function respondToOffer(token, response) {
  const found = lookupToken(token);
  if (!found || found.kind !== 'offer') return null;
  const { slot, offer } = found;
  if (response === 'CLAIM') {
    offer.response = 'CLAIM';
    offer.status = 'CLAIMED';
    offer.respondedAt = new Date().toISOString();
    slot.status = 'BOOKED';
    slot.bookedBy = offer.candidate;
    slot.bookedAt = new Date().toISOString();
    // Everyone else who hadn't answered loses the race.
    slot.offers.forEach(o => { if (o.id !== offer.id && o.status === 'SENT') o.status = 'LAPSED'; });
    createTask(found.tenantId, {
      kind: TASK_KINDS.BOOK_IN_EMR,
      sourceSlotId: slot.id,
      blockDate: slot.blockDate, site: slot.site, caseBlock: slot.caseBlock,
      service: offer.service || slot.service, durationMins: slot.durationMins,
      counterparty: offer.candidate,
      decidedAt: slot.bookedAt,
      action: `Assign ${fmtHours(slot.durationMins) ?? '—'} hrs to ${offer.candidate} — `
            + `${slot.caseBlock}, ${slot.site}, ${slot.blockDate}`,
    });
  } else if (response === 'PASS') {
    offer.response = 'PASS';
    offer.status = 'PASSED';
    offer.respondedAt = new Date().toISOString();
    // Last live offer gone: this is work again, not a wait.
    reopen(slot);
  } else {
    return null;
  }
  save();
  return { slot, offer };
}

/* ── The funnel ───────────────────────────────────────────────────────────
 *
 * Requests sent -> hours released -> hours offered -> hours booked. Released
 * hours alone flatter the product; released-and-filled is the honest number.
 * "Still open" is inventory to work, not a failure — it is the Board's queue.
 */
function summary(tid, { from, to } = {}) {
  const t = tenant(tid);
  const within = iso => {
    if (!iso) return false;
    const d = String(iso).slice(0, 10);
    return (!from || d >= from) && (!to || d <= to);
  };

  const requests = t.requests.filter(r => within(r.createdAt));
  const answered = requests.filter(r => r.respondedAt);
  const released = requests.filter(r => r.status === 'RELEASED');
  const releasedMins = released.reduce((s, r) => s + (Number(r.blockTimeMins) || 0), 0);

  const slots = t.slots.filter(s => within(s.createdAt));
  const offeredMins = slots.filter(s => s.offers?.length)
    .reduce((s, x) => s + (Number(x.durationMins) || 0), 0);
  const bookedSlots = slots.filter(s => s.status === 'BOOKED');
  const bookedMins = bookedSlots.reduce((s, x) => s + (Number(x.durationMins) || 0), 0);

  const daysToBook = bookedSlots
    .map(s => (new Date(s.bookedAt) - new Date(s.createdAt)) / 86400000)
    .filter(n => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);
  const median = daysToBook.length
    ? daysToBook[Math.floor(daysToBook.length / 2)] : null;

  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
  return {
    from: from ?? null, to: to ?? null,
    requestsSent: requests.length,
    hoursReleased: fmtHours(releasedMins),
    hoursOffered: fmtHours(offeredMins),
    hoursBooked: fmtHours(bookedMins),
    hoursStillOpen: fmtHours(releasedMins - bookedMins),
    fillRatePct: pct(bookedMins, releasedMins),
    responseRatePct: pct(answered.length, requests.length),
    medianDaysToBook: median == null ? null : Math.round(median * 10) / 10,
  };
}

module.exports = {
  createRequest, listRequests, getRequest, snoozeRequest,
  TASK_KINDS, createTask, listTasks, getTask, completeTask, cancelTask, summary,
  listSlots, getSlot, createOffers, slotList, SLOT_LISTS,
  getGoals, setGoals,
  lookupToken, respondToRequest, respondToOffer,
};

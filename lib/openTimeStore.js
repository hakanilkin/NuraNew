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
  if (!db.tenants[key]) db.tenants[key] = { requests: [], slots: [], goals: defaultGoals() };
  return db.tenants[key];
}

const uuid     = () => crypto.randomUUID();
const newToken = () => crypto.randomBytes(16).toString('hex');

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

function listSlots(tid) {
  return tenant(tid).slots;
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
    // Avoid duplicating a slot if the link is clicked twice.
    slot = listSlots(found.tenantId).find(s => s.sourceRequestId === req.id)
        || createSlotFromRequest(found.tenantId, req);
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
  } else if (response === 'PASS') {
    offer.response = 'PASS';
    offer.status = 'PASSED';
    offer.respondedAt = new Date().toISOString();
  } else {
    return null;
  }
  save();
  return { slot, offer };
}

module.exports = {
  createRequest, listRequests, getRequest, snoozeRequest,
  listSlots, getSlot, createOffers,
  getGoals, setGoals,
  lookupToken, respondToRequest, respondToOffer,
};

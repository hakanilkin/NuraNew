#!/usr/bin/env node
//
// Tests for the fulfillment queue and the release-to-fill funnel
// (OpenTimeFulfillment.md §1-2).
//
// Two things are being defended. First, that a decision can never exist without
// its action item — the task is created by the same code path that performs the
// transition, so a release that nobody enters in the EMR is impossible to
// produce. Second, that the queue stays a work aid: the spec is explicit that
// aging, staleness, completion times and per-user scoring are not wanted, and a
// test is the only thing that stops them drifting back in.
//
// Run: node --test scripts/checks/opentime_fulfillment.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..', '..');
const store = require(path.join(ROOT, 'lib', 'openTimeStore'));

// Scratch tenants, removed again at the end so the demo store is untouched.
// The store persists on every write, so cleanup has to run after the last one
// rather than inside the test that created the bucket.
const T = '990990';
const T_EMPTY = '990991';

function seedRelease({ mins = 480, block = 'Ortho A' } = {}) {
  const req = store.createRequest(T, {
    blockDate: '2026-09-10', site: 'Bright Memorial Hospital', caseBlock: block,
    service: 'Orthopedics', blockTimeMins: mins, recipientName: 'Dr Vance',
  });
  const out = store.respondToRequest(req.token, 'RELEASE');
  return { req, slot: out.slot };
}

test.after(() => {
  const fs = require('fs');
  const p = path.join(ROOT, '.opentime-demo.json');
  if (!fs.existsSync(p)) return;
  const db = JSON.parse(fs.readFileSync(p, 'utf8'));
  delete db.tenants[T];
  delete db.tenants[T_EMPTY];
  delete db.tenants['990992'];
  for (const k of Object.keys(db.tokens || {})) {
    if (db.tokens[k].tenantId === T) delete db.tokens[k];
  }
  fs.writeFileSync(p, JSON.stringify(db, null, 2));
});

test('releasing a block creates its EMR entry, once', () => {
  const before = store.listTasks(T, 'ALL').length;
  const { req, slot } = seedRelease();
  const tasks = store.listTasks(T, 'ALL');
  assert.equal(tasks.length, before + 1);
  const task = tasks[0];
  assert.equal(task.kind, 'RELEASE_IN_EMR');
  assert.equal(task.status, 'PENDING');
  assert.equal(task.sourceRequestId, req.id);
  assert.match(task.action, /Release 8 hrs — Ortho A/);

  // Clicking the response link twice must not duplicate the work item.
  store.respondToRequest(req.token, 'RELEASE');
  assert.equal(store.listTasks(T, 'ALL').length, before + 1);
  assert.ok(slot);
});

test('claiming released time creates its own EMR entry', () => {
  const { slot } = seedRelease({ block: 'General B', mins: 360 });
  store.createOffers(T, slot.id, [{ candidate: 'Spine', service: 'Spine', matchScore: 91.7 }]);
  const offer = store.getSlot(T, slot.id).offers[0];
  store.respondToOffer(offer.token, 'CLAIM');

  const task = store.listTasks(T, 'ALL')[0];
  assert.equal(task.kind, 'BOOK_IN_EMR');
  assert.equal(task.sourceSlotId, slot.id);
  assert.match(task.action, /Assign 6 hrs to Spine/);
});

test('a decision cannot exist without its action item', () => {
  const releases = store.listRequests(T).filter(r => r.status === 'RELEASED').length;
  const bookings = store.listSlots(T).filter(s => s.status === 'BOOKED').length;
  const tasks = store.listTasks(T, 'ALL');
  assert.equal(tasks.filter(t => t.kind === 'RELEASE_IN_EMR').length, releases);
  assert.equal(tasks.filter(t => t.kind === 'BOOK_IN_EMR').length, bookings);
});

test('completing a task stamps who and when, and moves it out of the queue', () => {
  const pending = store.listTasks(T, 'PENDING');
  const done = store.completeTask(T, pending[0].id, { completedBy: 'j.alvarez@x', note: 'entered' });
  assert.equal(done.status, 'DONE');
  assert.equal(done.completedBy, 'j.alvarez@x');
  assert.ok(done.completedAt);
  assert.equal(done.note, 'entered');
  assert.ok(!store.listTasks(T, 'PENDING').some(t => t.id === done.id));
});

test('a task cannot be completed twice', () => {
  const done = store.listTasks(T, 'DONE')[0];
  assert.equal(store.completeTask(T, done.id, { completedBy: 'someone' }), null);
});

test('the queue carries no aging, staleness or scoring fields', () => {
  // Explicitly not wanted: the queue measures nothing about the people using it.
  const task = store.listTasks(T, 'ALL')[0];
  for (const banned of ['ageDays', 'age', 'stale', 'staleness', 'overdue', 'dueAt',
                        'slaHours', 'timeToComplete', 'score', 'priority', 'severity']) {
    assert.ok(!(banned in task), `task should not carry a "${banned}" field`);
  }
});

test('the funnel divides booked hours by released hours', () => {
  const s = store.summary(T);
  assert.ok(s.hoursReleased > 0);
  assert.equal(s.fillRatePct, Math.round((s.hoursBooked / s.hoursReleased) * 1000) / 10);
  assert.equal(
    Math.round((s.hoursStillOpen + s.hoursBooked) * 10) / 10,
    Math.round(s.hoursReleased * 10) / 10,
    'still-open plus booked must account for everything released');
});

test('the funnel reports a response rate over requests sent', () => {
  const s = store.summary(T);
  assert.equal(s.requestsSent, store.listRequests(T).length);
  assert.ok(s.responseRatePct >= 0 && s.responseRatePct <= 100);
});

test('an untouched tenant has an empty funnel rather than an error', () => {
  const s = store.summary(T_EMPTY);
  assert.equal(s.requestsSent, 0);
  assert.equal(s.fillRatePct, null, 'no requests means no rate, not zero');
});

// ── Route level ─────────────────────────────────────────────────────────────

async function call(method, url, body, session = {}) {
  const make = require(path.join(ROOT, 'routes', 'opentime'));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantName = 'Bright Memorial Health';
    req.session = { tenantId: T, ...session };
    next();
  });
  app.use('/api', make(async () => ({ request: () => ({ input() { return this }, async query() { return { recordset: [] } } }) }),
    { NVarChar: 'nv', Int: 'int', Date: 'date' }, (_q, _s, n) => n()));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api${url}`,
      body ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
           : { method });
    return { status: res.status, body: await res.json() };
  } finally { server.close() }
}

test('GET /tasks returns the queue with its two counts', async () => {
  const r = await call('GET', '/tasks?status=ALL');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.tasks));
  assert.equal(typeof r.body.summary.pending, 'number');
  assert.equal(typeof r.body.summary.done, 'number');
});

test('who completed a task comes from the session, never the request body', async () => {
  const pending = store.listTasks(T, 'PENDING');
  const r = await call('POST', `/tasks/${pending[0].id}/complete`,
    { completedBy: 'attacker@evil', note: 'x' }, { email: 'real.user@brightmemorial.demo' });
  assert.equal(r.status, 200);
  assert.equal(r.body.completedBy, 'real.user@brightmemorial.demo');
});

test('cancelling requires a reason', async () => {
  const pending = store.listTasks(T, 'PENDING');
  const missing = await call('POST', `/tasks/${pending[0].id}/cancel`, {});
  assert.equal(missing.status, 400);
  const ok = await call('POST', `/tasks/${pending[0].id}/cancel`, { note: 'decision reversed' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'CANCELLED');
});

test('an unknown task is a 404', async () => {
  const r = await call('POST', '/tasks/not-a-task/complete', {});
  assert.equal(r.status, 404);
});

test('GET /summary returns the funnel', async () => {
  const r = await call('GET', '/summary');
  assert.equal(r.status, 200);
  for (const k of ['requestsSent', 'hoursReleased', 'hoursOffered', 'hoursBooked',
                   'fillRatePct', 'responseRatePct', 'hoursStillOpen']) {
    assert.ok(k in r.body, `summary is missing ${k}`);
  }
});

// ── The Board's three lists (OpenTimeBoardLists.md) ────────────────────────
//
// The list a row sits in is its status, so the membership rule is the whole
// feature. The case worth defending is the one the spec found: a slot whose
// every offer has been declined used to sit in "awaiting response" awaiting
// nothing, and its released hours quietly stopped being worked.

const T_LISTS = '990992';

function seedFor(tid, block) {
  const req = store.createRequest(tid, {
    blockDate: '2026-09-17', site: 'Bright Memorial Hospital', caseBlock: block,
    service: 'Orthopedics', blockTimeMins: 480, recipientName: 'Dr Vance',
  });
  return store.respondToRequest(req.token, 'RELEASE').slot;
}

test('a released slot with no offer needs an offer', () => {
  const slot = seedFor(T_LISTS, 'Never offered');
  assert.equal(store.slotList(slot), store.SLOT_LISTS.NEEDS_OFFER);
});

test('a live offer moves it to awaiting response', () => {
  const slot = seedFor(T_LISTS, 'Awaiting');
  store.createOffers(T_LISTS, slot.id, [{ candidate: 'Spine', service: 'Spine' }]);
  assert.equal(store.slotList(store.getSlot(T_LISTS, slot.id)), store.SLOT_LISTS.AWAITING);
});

test('when the last offer is declined the slot is work again, not a wait', () => {
  const slot = seedFor(T_LISTS, 'Declined');
  store.createOffers(T_LISTS, slot.id, [{ candidate: 'Dr Reyes', service: 'Spine' }]);
  const offer = store.getSlot(T_LISTS, slot.id).offers[0];
  store.respondToOffer(offer.token, 'PASS');

  const after = store.getSlot(T_LISTS, slot.id);
  // Fixed in the store, not patched in the view: the status itself goes back.
  assert.equal(after.status, 'OPEN', 'a slot with no live offer must not stay OFFERED');
  assert.equal(store.slotList(after), store.SLOT_LISTS.NEEDS_OFFER);
  // ...and it carries the history that makes it a second attempt, not a repeat.
  assert.equal(after.offers[0].status, 'PASSED');
  assert.equal(after.offers[0].candidate, 'Dr Reyes');
});

test('one declined offer among several live ones is still a wait', () => {
  const slot = seedFor(T_LISTS, 'Partly declined');
  store.createOffers(T_LISTS, slot.id, [
    { candidate: 'Dr Reyes', service: 'Spine' },
    { candidate: 'Dr Okafor', service: 'Robotics-General' },
  ]);
  const [first] = store.getSlot(T_LISTS, slot.id).offers;
  store.respondToOffer(first.token, 'PASS');
  const after = store.getSlot(T_LISTS, slot.id);
  assert.equal(after.status, 'OFFERED');
  assert.equal(store.slotList(after), store.SLOT_LISTS.AWAITING);
});

test('a claim books the slot and lapses the rest without reopening it', () => {
  const slot = seedFor(T_LISTS, 'Booked');
  store.createOffers(T_LISTS, slot.id, [
    { candidate: 'Dr Reyes', service: 'Spine' },
    { candidate: 'Dr Okafor', service: 'Robotics-General' },
  ]);
  const [first] = store.getSlot(T_LISTS, slot.id).offers;
  store.respondToOffer(first.token, 'CLAIM');
  const after = store.getSlot(T_LISTS, slot.id);
  assert.equal(after.status, 'BOOKED');
  assert.equal(after.offers[1].status, 'LAPSED');
  assert.equal(store.slotList(after), store.SLOT_LISTS.BOOKED);
});

test('every slot lands in exactly one list, and listSlots says which', () => {
  const slots = store.listSlots(T_LISTS);
  assert.ok(slots.length >= 5);
  const buckets = { NEEDS_OFFER: 0, AWAITING: 0, BOOKED: 0 };
  for (const s of slots) {
    assert.ok(s.list in buckets, `slot ${s.caseBlock} has no list`);
    buckets[s.list] += 1;
  }
  assert.equal(buckets.NEEDS_OFFER + buckets.AWAITING + buckets.BOOKED, slots.length);
  for (const k of Object.keys(buckets)) assert.ok(buckets[k] > 0, `${k} is empty`);
});

test('booked hours on list 3 reconcile with the funnel', () => {
  const booked = store.listSlots(T_LISTS)
    .filter(s => s.list === store.SLOT_LISTS.BOOKED)
    .reduce((t, s) => t + (Number(s.durationMins) || 0), 0);
  assert.equal(Number(store.summary(T_LISTS).hoursBooked), Math.round((booked / 60) * 10) / 10);
});

#!/usr/bin/env node
//
// RTDC — Right-Time, Not Real-Time. Acceptance criteria from RTDC.md §9,
// exercised on the pure libs and on the router against the demo tenant's
// synthetic source (no SQL needed) plus a stubbed SQL tenant.
//
// Run: node --test scripts/checks/rtdc.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..', '..');
const P = require(path.join(ROOT, 'lib', 'rtdcPredict'));
const R = require(path.join(ROOT, 'lib', 'rtdcRules'));
const Y = require(path.join(ROOT, 'lib', 'moveToYes'));
const M = require(path.join(ROOT, 'lib', 'rtdcMismatch'));
const O = require(path.join(ROOT, 'lib', 'rtdcOutcome'));
const A = require(path.join(ROOT, 'lib', 'rtdcArchetype'));
const S = require(path.join(ROOT, 'lib', 'rtdcSettings'));
const T = require(path.join(ROOT, 'lib', 'rtdcTime'));
const store = require(path.join(ROOT, 'lib', 'rtdcStore'));

const DEMO = 'Bright Memorial Health';
const TODAY = '2026-09-04';                       // a Friday; the synthetic epoch is fixed, so dates are stable
const NOW = `${TODAY}T15:00:00`;
const rules = S.DEFAULT_RULES;

// ── §3.1 prediction modes ───────────────────────────────────────────────────

test('EDD_DATE: EDD today is Y, tomorrow is N, beyond the horizon is off the list', () => {
  const s = { pred_source: 'EDD_DATE', list_horizon_days: 1 };
  assert.equal(P.derivePrediction({ UNIT: '5C', PRED_SOURCE_DATE: TODAY }, s, TODAY).pred, 'Y');
  assert.equal(P.derivePrediction({ UNIT: '5C', PRED_SOURCE_DATE: '2026-09-05' }, s, TODAY).pred, 'N');
  assert.equal(P.derivePrediction({ UNIT: '5C', PRED_SOURCE_DATE: '2026-09-07' }, s, TODAY).pred, null);
});

test('EDD_TIME: EDD today at 16:00 is N; FLAG: the raw flag wins; mode rides along', () => {
  const r = P.derivePrediction({ UNIT: '5C', PRED_SOURCE_DATE: TODAY, PRED_SOURCE_TIME: '16:00' }, { pred_source: 'EDD_TIME', list_horizon_days: 1 }, TODAY);
  assert.deepEqual(r, { pred: 'N', mode: 'EDD_TIME' });
  const f = P.derivePrediction({ UNIT: '5C', PRED_SOURCE_DATE: TODAY, PRED_SOURCE_TIME: '16:00', PRED_FLAG_RAW: 'Y' }, { pred_source: 'FLAG' }, TODAY);
  assert.deepEqual(f, { pred: 'Y', mode: 'FLAG' });
  assert.equal(P.derivePrediction({ UNIT: '5C', PRED_SOURCE_DATE: TODAY, PRED_UNKNOWN: true }, { pred_source: 'EDD_DATE' }, TODAY).pred, null,
    'EDD Unknown is not on the list');
});

// ── §5 rules ────────────────────────────────────────────────────────────────

const CARD = {
  UNIT: '6 East', ROOM_BED: '652', PATIENT_INITIALS: 'JL', ATTENDING: 'Dr. Patel', pred: 'N',
  MRD: true, EXPECTED_DISPOSITION: 'Home w/ HH', LOS_DAYS: 6.2, GMLOS: 4.1, LEVEL_OF_CARE: 'Med-Surg', FLAGS: [],
  PRED_SOURCE_DATE: TODAY, PRED_SOURCE_TIME: '16:00',
  DC_NARRATIVE: 'DC order, HH TPN needs to be arranged, family transportation.',
  PENDING_ITEMS: [{ class: 'referral', name: 'Home health TPN referral', ordered_at: `${TODAY}T08:10:00`, status: 'placed' }],
};

test('the spec\'s example card fires MRD_HOME with its reason text, and EXCLUDE beats every rule', () => {
  const ev = R.evaluateRules(CARD, rules, { today: TODAY, cutoff: '14:00' });
  assert.equal(ev.excluded, null);
  assert.ok(ev.candidates.some(c => c.ruleKey === 'MRD_HOME'));
  assert.ok(ev.candidates.every(c => c.reasonText.length > 20), 'a rule name is not a reason');
  const icu = R.evaluateRules({ ...CARD, LEVEL_OF_CARE: 'ICU' }, rules, { today: TODAY, cutoff: '14:00' });
  assert.equal(icu.excluded, 'ICU level of care');
  assert.equal(icu.candidates.length, 0);
  const y = R.evaluateRules({ ...CARD, pred: 'Y' }, rules, { today: TODAY, cutoff: '14:00' });
  assert.equal(y.candidates.length, 0, 'rules only ever suggest Ns');
});

test('EDD_SLIPPED reports the phrase it matched and never fires with clinical work pending', () => {
  const p = { ...CARD, MRD: false, PENDING_ITEMS: [], DC_NARRATIVE: 'DC order, daughter to pick up after 3.' };
  const ev = R.evaluateRules(p, rules, { today: TODAY, cutoff: '14:00' });
  const hit = ev.candidates.find(c => c.ruleKey === 'EDD_SLIPPED');
  assert.ok(hit && hit.matchedPhrase === 'DC order');
  const lab = R.evaluateRules({ ...p, PENDING_ITEMS: [{ class: 'lab', name: 'CBC', status: 'pending' }] }, rules, { today: TODAY, cutoff: '14:00' });
  assert.ok(!lab.candidates.some(c => c.ruleKey === 'EDD_SLIPPED'));
});

test('a disabled rule does not fire; an edited reason prints', () => {
  const edited = S.mergeRules(rules, [{ rule_key: 'MRD_HOME', enabled: false }, { rule_key: 'LOS_EXCESS', reason_text: 'Custom reason.' }]);
  const ev = R.evaluateRules(CARD, edited, { today: TODAY, cutoff: '14:00' });
  assert.ok(!ev.candidates.some(c => c.ruleKey === 'MRD_HOME'));
  assert.equal(ev.candidates.find(c => c.ruleKey === 'LOS_EXCESS').reasonText, 'Custom reason.');
});

// ── §4 steps and clocks ─────────────────────────────────────────────────────

test('steps to Yes reproduce the spec card: referral 10:30, order 11:00, family transport 13:00', () => {
  const ctx = { date: TODAY, now: T.at(TODAY, '08:30'), cutoff: '14:00',
                medians: { '6 East': { DO_TO_DC: 180, ATTENDING_ORDER_TIME: { 'Dr. Patel': '13:40' } } } };
  const { steps } = Y.stepsToYes(CARD, ctx);
  assert.deepEqual(steps.map(s => [s.kind, s.neededBy]), [['pending', '10:30'], ['order', '11:00'], ['narrative', '13:00']]);
  assert.match(steps[1].detail, /13:40/, 'the attending\'s median order time is on the card');
  assert.ok(steps[2].narrativeOnly);
});

test('without pending items (OHS) steps are narrative-only and nothing throws', () => {
  const { steps, pendingItemsAvailable } = Y.stepsToYes({ ...CARD, PENDING_ITEMS: null }, { date: TODAY, now: T.at(TODAY, '08:30'), cutoff: '14:00', medians: {} });
  assert.equal(pendingItemsAvailable, false);
  assert.ok(steps.every(s => s.kind !== 'pending'));
});

test('Ns sort by rule order then excess LOS; Ys at risk sit apart from the rest', () => {
  const mk = (o) => ({ ...CARD, ...o });
  const pts = [
    { ...mk({ ENCOUNTER_KEY: 'a', pred: 'N', MRD: false, DC_ORDER_AT: null, LOS_DAYS: 9 }), candidates: [{ ruleKey: 'LOS_EXCESS' }] },
    { ...mk({ ENCOUNTER_KEY: 'b', pred: 'N', DC_ORDER_AT: `${TODAY}T07:30:00`, LOS_DAYS: 4 }), candidates: [{ ruleKey: 'ORDER_WRITTEN' }] },
    { ...mk({ ENCOUNTER_KEY: 'c', pred: 'N', LOS_DAYS: 5 }), candidates: [] },
    { ...mk({ ENCOUNTER_KEY: 'd', pred: 'N', LOS_DAYS: 8 }), candidates: [] },
    { ...mk({ ENCOUNTER_KEY: 'y1', pred: 'Y', DC_ORDER_AT: null, EXPECTED_DISPOSITION: 'Home', TRANSPORT_REQUESTED_AT: null, PENDING_ITEMS: [] }), candidates: [] },
    { ...mk({ ENCOUNTER_KEY: 'y2', pred: 'Y', DC_ORDER_AT: `${TODAY}T09:00:00`, PENDING_ITEMS: [], TRANSPORT_REQUESTED_AT: `${TODAY}T11:00:00` }), candidates: [] },
  ];
  const v = Y.buildUnitView(pts, { date: TODAY, now: T.at(TODAY, '12:30'), cutoff: '14:00', rules, medians: {} });
  assert.deepEqual(v.ns.map(p => p.ENCOUNTER_KEY), ['b', 'a', 'd', 'c']);
  assert.deepEqual(v.ysAtRisk.map(p => p.ENCOUNTER_KEY), ['y1']);
  assert.match(v.ysAtRisk[0].riskReasons.join(' '), /No discharge order by 11:00/);
  assert.deepEqual(v.ysRemaining.map(p => p.ENCOUNTER_KEY), ['y2']);
});

test('activity chips read in huddle order and carry their state and clock', () => {
  const ctx = { date: TODAY, now: T.at(TODAY, '08:30'), cutoff: '14:00', transport_by: '12:00',
                medians: { '6 East': { DO_TO_DC: 180, ATTENDING_ORDER_TIME: { 'Dr. Patel': '13:40' } } } };
  const { steps } = Y.stepsToYes(CARD, ctx);
  const chips = Y.activityChips(CARD, steps, ctx);
  // order → readiness → clinical → placement → logistics, never interleaved.
  const seen = chips.map(c => Y.GROUPS.indexOf(c.group));
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b));
  const by = Object.fromEntries(chips.map(c => [c.label, c]));
  assert.equal(by['Medically ready'].state, 'done', 'MRD yes is a fact already achieved');
  assert.equal(by['No discharge order'].state, 'progress');
  assert.equal(by['No discharge order'].neededBy, '11:00', 'a chip keeps its clock');
  assert.equal(by['Home health TPN referral'].state, 'progress');
  assert.equal(by['Home health TPN referral'].neededBy, '10:30');

  // An order already signed is a green chip stamped with its time.
  const signed = Y.activityChips({ ...CARD, DC_ORDER_AT: `${TODAY}T07:47:00` },
    Y.stepsToYes({ ...CARD, DC_ORDER_AT: `${TODAY}T07:47:00` }, ctx).steps, ctx);
  const o = signed.find(c => c.group === 'order');
  assert.equal(o.label, 'Discharge order placed');
  assert.equal(o.state, 'done'); assert.equal(o.at, '07:47');

  // Past its needed-by is blocked, not merely in progress. Lateness belongs to
  // the step, so the same clock has to produce both.
  const lateCtx = { ...ctx, now: T.at(TODAY, '13:00') };
  const late = Y.activityChips(CARD, Y.stepsToYes(CARD, lateCtx).steps, lateCtx);
  assert.equal(late.find(c => c.label === 'Home health TPN referral').state, 'blocked');
});

test('placement and transport become chips even when no order carries them', () => {
  const ctx = { date: TODAY, now: T.at(TODAY, '08:30'), cutoff: '14:00', transport_by: '12:00', medians: {} };
  const snf = { ...CARD, EXPECTED_DISPOSITION: 'SNF', PLACEMENT_STATUS: 'accepted', PENDING_ITEMS: [], DC_NARRATIVE: '' };
  const c1 = Y.activityChips(snf, Y.stepsToYes(snf, ctx).steps, ctx);
  assert.equal(c1.find(c => c.group === 'placement').label, 'Placement accepted');
  const snf2 = { ...snf, PLACEMENT_STATUS: null };
  assert.equal(Y.activityChips(snf2, Y.stepsToYes(snf2, ctx).steps, ctx).find(c => c.group === 'placement').state, 'blocked');

  const home = { ...CARD, EXPECTED_DISPOSITION: 'Home', PENDING_ITEMS: [], DC_NARRATIVE: 'DC order.', TRANSPORT_REQUESTED_AT: null };
  const late = Y.activityChips(home, Y.stepsToYes(home, ctx).steps, { ...ctx, now: T.at(TODAY, '12:30') });
  assert.equal(late.find(c => c.label === 'Transport pending').state, 'blocked');
  const arranged = { ...home, TRANSPORT_REQUESTED_AT: `${TODAY}T09:15:00` };
  assert.equal(Y.activityChips(arranged, Y.stepsToYes(arranged, ctx).steps, ctx).find(c => c.group === 'logistics').label, 'Transport arranged');
});

// ── §3.2 status and effective beds ──────────────────────────────────────────

test('a unit with no entry uses available beds; an entry changes only that unit', () => {
  const snap = { UNIT: '5 Central', STAFFED_BEDS: 32, OCCUPIED_BEDS: 28, BLOCKED_BEDS: 1,
                 PENDING_BED_REQUESTS_IN: [{}, {}, {}], OR_EXPECTED_ADMITS_BY_2PM: 5, DOWNGRADE_REQUESTS_IN: 1,
                 ED_LIKELY_ADMITS: 1, PROCEDURAL_EXPECTED: 0, DOWNGRADES_ANTICIPATED: 0, ED_FORECAST_8_14: 2.4 };
  const a = M.unitStatus(snap, 6, null);
  assert.equal(a.available, 3); assert.equal(a.effective, 3);
  assert.equal(a.capacity, 9); assert.equal(a.firstPass, 9); assert.equal(a.secondPass, 3);
  assert.equal(a.status, -3); assert.equal(a.color, 'red');
  const b = M.unitStatus(snap, 6, { effective_beds: 1, adjustment_reason: 'Staffing', adjusted_by: 'RN' });
  assert.equal(b.status, -5); assert.ok(b.adjusted && b.adjustedBy === 'RN');
});

// ── §6 scoring ──────────────────────────────────────────────────────────────

const settings = { pred_source: 'EDD_TIME', cutoff: '14:00', snapshot_times: { S2: '08:20' } };

test('outcomes: MET / MISSED / UNEXPECTED / NOT_ON_LIST, accuracy carries the mode, conversion counts only candidates', () => {
  const s2 = [
    { ENCOUNTER_KEY: '1', UNIT: 'U', pred: 'Y', candidates: [], PENDING_ITEMS: [] },
    { ENCOUNTER_KEY: '2', UNIT: 'U', pred: 'Y', candidates: [], PENDING_ITEMS: [], EXPECTED_DISPOSITION: 'Home' },
    { ENCOUNTER_KEY: '3', UNIT: 'U', pred: 'N', candidates: [{ ruleKey: 'MRD_HOME' }], PENDING_ITEMS: [] },
    { ENCOUNTER_KEY: '4', UNIT: 'U', pred: 'N', candidates: [{ ruleKey: 'LOS_EXCESS' }], PENDING_ITEMS: [] },
    { ENCOUNTER_KEY: '5', UNIT: 'U', pred: null, candidates: [], PENDING_ITEMS: [] },
  ];
  const s3 = [
    { ENCOUNTER_KEY: '1', UNIT: 'U', DISCHARGED_AT: `${TODAY}T12:00:00`, DC_ORDER_AT: `${TODAY}T09:00:00` },
    { ENCOUNTER_KEY: '2', UNIT: 'U', DISCHARGED_AT: `${TODAY}T15:10:00`, DC_ORDER_AT: `${TODAY}T13:40:00` },
    { ENCOUNTER_KEY: '3', UNIT: 'U', DISCHARGED_AT: `${TODAY}T13:30:00`, DC_ORDER_AT: `${TODAY}T10:00:00` },
    { ENCOUNTER_KEY: '4', UNIT: 'U', DISCHARGED_AT: null },
    { ENCOUNTER_KEY: '5', UNIT: 'U', DISCHARGED_AT: `${TODAY}T11:00:00` },
  ];
  const d = O.scoreDay({ date: TODAY, s2Patients: s2, s3Patients: s3, settings });
  const by = Object.fromEntries(d.rows.map(r => [r.encounterKey, r.outcome]));
  assert.deepEqual(by, { 1: 'MET', 2: 'MISSED', 3: 'UNEXPECTED', 4: null, 5: 'NOT_ON_LIST' });
  assert.equal(d.house.accuracyPct, 50); assert.equal(d.mode, 'EDD_TIME');
  assert.equal(d.house.candidates, 2); assert.equal(d.house.converted, 1);
  const missed = d.rows.find(r => r.encounterKey === '2');
  assert.equal(missed.barrier.code, 'LATE_ORDER'); assert.ok(missed.barrier.inferred);
  assert.match(missed.barrier.facts, /order 13:40 · departed 15:10/);
  assert.equal(d.fidelity.available, false, 'no PRED_EDIT_LOG → fidelity not available');
});

test('avoidable N: discharged by 2 PM anyway, or by 18:00 with an order before noon, or a rule converting ≥ 50% on the unit', () => {
  const s2 = [
    { ENCOUNTER_KEY: 'a', UNIT: 'U', pred: 'N', candidates: [], PENDING_ITEMS: [] },
    { ENCOUNTER_KEY: 'b', UNIT: 'U', pred: 'N', candidates: [], PENDING_ITEMS: [] },
    { ENCOUNTER_KEY: 'c', UNIT: 'U', pred: 'N', candidates: [{ ruleKey: 'MRD_HOME' }], PENDING_ITEMS: [] },
    { ENCOUNTER_KEY: 'd', UNIT: 'U', pred: 'N', candidates: [{ ruleKey: 'LOS_EXCESS' }], PENDING_ITEMS: [] },
  ];
  const s3 = [
    { ENCOUNTER_KEY: 'a', UNIT: 'U', DISCHARGED_AT: `${TODAY}T13:00:00` },
    { ENCOUNTER_KEY: 'b', UNIT: 'U', DISCHARGED_AT: `${TODAY}T16:30:00`, DC_ORDER_AT: `${TODAY}T11:20:00` },
    { ENCOUNTER_KEY: 'c', UNIT: 'U', DISCHARGED_AT: null },
    { ENCOUNTER_KEY: 'd', UNIT: 'U', DISCHARGED_AT: null },
  ];
  const d = O.scoreDay({ date: TODAY, s2Patients: s2, s3Patients: s3, settings, ruleConversion: { 'U|MRD_HOME': 62, 'U|LOS_EXCESS': 18 } });
  const av = Object.fromEntries(d.rows.map(r => [r.encounterKey, r.avoidable]));
  assert.deepEqual(av, { a: true, b: true, c: true, d: false });
  assert.equal(d.rows.find(r => r.encounterKey === 'b').bedHours, 2.5, '14:00 → 16:30');
});

test('rules with fewer than 10 firings show n, not a rate', () => {
  const days = [];
  for (let i = 0; i < 12; i++) {
    days.push({ date: T.addDays(TODAY, -i), rows: [
      { unit: 'U', attending: 'Dr. A', candidates: [{ ruleKey: 'MRD_HOME' }], converted: i % 2 === 0 },
      ...(i < 4 ? [{ unit: 'U', attending: 'Dr. B', candidates: [{ ruleKey: 'SINGLE_STEP' }], converted: true }] : []),
    ] });
  }
  const t = O.conversionTable(days, { minFirings: 10 });
  const mrd = t.rules.find(r => r.ruleKey === 'MRD_HOME'), ss = t.rules.find(r => r.ruleKey === 'SINGLE_STEP');
  assert.equal(mrd.fired, 12); assert.equal(mrd.conversionPct, 50); assert.equal(mrd.belowMin, false);
  assert.equal(ss.fired, 4); assert.equal(ss.conversionPct, null); assert.equal(ss.belowMin, true);
});

test('night/AM fidelity comes from PRED_EDIT_LOG and reads the two windows', () => {
  const s2 = [
    { ENCOUNTER_KEY: '1', UNIT: 'U', pred: 'Y', candidates: [], DC_NARRATIVE: 'x', PRED_EDIT_LOG: [{ at: `2026-09-03T21:00:00` }, { at: `${TODAY}T07:30:00` }] },
    { ENCOUNTER_KEY: '2', UNIT: 'U', pred: 'N', candidates: [], PRED_EDIT_LOG: [{ at: `${TODAY}T07:45:00` }] },
    { ENCOUNTER_KEY: '3', UNIT: 'U', pred: null, candidates: [], PRED_EDIT_LOG: [] },
  ];
  const d = O.scoreDay({ date: TODAY, s2Patients: s2, s3Patients: [], settings });
  assert.deepEqual([d.fidelity.available, d.fidelity.listed, d.fidelity.nightPct, d.fidelity.amPct, d.fidelity.narrativePct], [true, 2, 50, 100, 100]);
});

// ── heatmap ─────────────────────────────────────────────────────────────────

test('heatmap margins: % red, mean gap on red days, streak; weekday view is the mean of the day view', () => {
  const cells = [
    { unit: 'U', date: '2026-08-31', status: -4 }, { unit: 'U', date: '2026-09-01', status: -2 },
    { unit: 'U', date: '2026-09-02', status: 1 }, { unit: 'U', date: '2026-09-03', status: -1 }, { unit: 'U', date: '2026-09-04', status: -3 },
  ];
  const h = M.heatmap(cells, ['U'], { from: '2026-08-31', to: '2026-09-04' });
  const u = h.rows[0];
  assert.equal(u.pctRed, 80); assert.equal(u.meanGapRed, -2.5); assert.equal(u.streak, 2);
  assert.equal(u.weekday.find(w => w.dow === 1).mean, -4);
  assert.deepEqual(u.days.map(d => d.status), [-4, -2, 1, -1, -3]);
});

// ── the router on the demo tenant ───────────────────────────────────────────

const sqlStub = { NVarChar: 'nv', Int: 'int', Date: 'date' };

async function call(tenant, method, url, { body, admin = true, pool } = {}) {
  const make = require(path.join(ROOT, 'routes', 'rtdc.js'));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantName = tenant; req.session = { tenantId: 3, isAdmin: admin, fullName: 'Test User' }; next(); });
  app.use('/api/rtdc', make(async () => pool || (() => { throw new Error('no pool'); })(), sqlStub, (_q, _s, n) => n()));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  try {
    const sep = url.includes('?') ? '&' : '?';
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/rtdc${url}${url.includes('now=') ? '' : `${sep}now=${NOW}`}`,
      body ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { method });
    const text = await res.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = { _html: text.slice(0, 60) }; }
    return { status: res.status, body: parsed };
  } finally { server.close(); }
}

test.before(() => store._resetForTests(store.FILE));
test.after(() => store._resetForTests(store.FILE));

test('the group is gated by the tenant feature flag', async () => {
  assert.equal((await call('OHS', 'GET', '/board')).status, 404);
  assert.equal((await call('NHS', 'GET', '/board')).status, 404);
  assert.equal((await call(DEMO, 'GET', '/meta')).status, 200);
});

test('board: rows in huddle order, red rows are the Ns\' entry point, house totals add up', async () => {
  const { status, body } = await call(DEMO, 'GET', `/board?date=${TODAY}`);
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.units.map(u => u.unit), ['5 Central', '4 East', '3 West', 'Stepdown', 'ICU']);
  for (const u of body.units) {
    assert.equal(u.capacity, u.effective + u.predictedY);
    assert.equal(u.status, u.capacity - u.demand);
    assert.equal(u.color, u.status < 0 ? 'red' : u.status === 0 ? 'even' : 'green');
  }
  assert.equal(body.house.status, body.units.reduce((s, u) => s + u.status, 0));
  assert.ok(body.yesterday.available && body.yesterday.mode === 'EDD_TIME');
});

test('board before the 08:20 snapshot shows yesterday, greyed, and says so', async () => {
  const { body } = await call(DEMO, 'GET', `/board?date=${TODAY}&now=${TODAY}T07:00:00`);
  assert.equal(body.noSnapshot, true);
  assert.equal(body.shownDate, T.addDays(TODAY, -1));
  assert.equal(body.readOnly, true);
});

test('Ns view: every N carries its facts, steps with needed-by, and candidate reasons; Ys at risk below', async () => {
  const { status, body } = await call(DEMO, 'GET', `/unit/${encodeURIComponent('5 Central')}/ns?date=${TODAY}`);
  assert.equal(status, 200, JSON.stringify(body));
  assert.ok(body.ns.length > 0);
  for (const n of body.ns) {
    assert.equal(n.pred, 'N');
    for (const k of ['roomBed', 'initials', 'attending', 'dispo', 'losDays', 'gmlos', 'eddDate', 'narrative']) assert.ok(k in n, k);
    assert.ok('mrd' in n && 'ord' in n && 'dcOrderAt' in n);
    assert.ok(Array.isArray(n.steps) && n.steps.every(s => /^\d{2}:\d{2}$/.test(s.neededBy)));
    for (const c of n.candidates) assert.ok(c.ruleKey && c.reasonText);
  }
  // Sorted: candidates first in rule order, then excess LOS.
  const order = body.rules.map(r => r.rule_key);
  const rank = n => (n.candidates.length ? order.indexOf(n.candidates[0].ruleKey) : 1e6);
  for (let i = 1; i < body.ns.length; i++) {
    const a = body.ns[i - 1], b = body.ns[i];
    assert.ok(rank(a) < rank(b) || (rank(a) === rank(b) && a.excessLos >= b.excessLos), `order at ${i}`);
  }
  assert.ok(Array.isArray(body.ysAtRisk) && Array.isArray(body.ysRemaining));
  assert.ok(body.ysAtRisk.every(y => y.riskReasons.length > 0));
  assert.ok(body.ysRemaining.every(y => y.riskReasons.length === 0));
  assert.ok(body.conversion30 && typeof body.conversion30 === 'object', 'chip hover has the 30-day rate');
});

test('the Ns view never suggests an ICU patient', async () => {
  const { body } = await call(DEMO, 'GET', `/unit/ICU/ns?date=${TODAY}`);
  assert.ok(body.ns.every(n => n.candidates.length === 0 && n.excluded === 'ICU level of care'));
});

test('effective beds: entering one changes only that unit and records who; past days are read-only', async () => {
  const before = (await call(DEMO, 'GET', `/board?date=${TODAY}`)).body;
  const target = before.units[0];
  // Opening two hallway beds (the entry can go either way; the reason is what matters).
  const r = await call(DEMO, 'POST', `/unit/${encodeURIComponent(target.unit)}/effective-beds`,
    { body: { date: TODAY, effective_beds: target.available + 2, reason: 'Other', note: 'hallway beds opened' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.unit.status, target.status + 2);
  assert.equal(r.body.unit.adjustedBy, 'Test User');
  const after = (await call(DEMO, 'GET', `/board?date=${TODAY}`)).body;
  for (const u of after.units.slice(1)) assert.equal(u.status, before.units.find(x => x.unit === u.unit).status);
  const noReason = await call(DEMO, 'POST', `/unit/${encodeURIComponent(target.unit)}/effective-beds`, { body: { date: TODAY, effective_beds: target.available + 5 } });
  assert.equal(noReason.status, 400);
  const past = await call(DEMO, 'POST', `/unit/${encodeURIComponent(target.unit)}/effective-beds`, { body: { date: T.addDays(TODAY, -1), effective_beds: 1, reason: 'Staffing' } });
  assert.equal(past.status, 400);
});

test('the heatmap cell equals the board status for the same unit-day, including after an adjustment', async () => {
  const from = T.addDays(TODAY, -6);
  const hm = (await call(DEMO, 'GET', `/mismatch?from=${from}&to=${TODAY}`)).body;
  assert.equal(hm.rows[0].unit, '5 Central');
  for (const d of [TODAY, T.addDays(TODAY, -3)]) {
    const board = (await call(DEMO, 'GET', `/board?date=${d}`)).body;
    for (const u of board.units) {
      const cell = hm.rows.find(r => r.unit === u.unit).days.find(x => x.date === d);
      assert.equal(cell.status, u.status, `${u.unit} ${d}`);
    }
  }
  // The weekday view is the mean of the day view.
  const row = hm.rows[0];
  for (const w of row.weekday) {
    const vals = row.days.filter(x => x.status != null && T.dow(x.date) === w.dow).map(x => x.status);
    if (!vals.length) { assert.equal(w.mean, null); continue; }
    assert.equal(w.mean, Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10);
  }
});

test('review before 2 PM shows the pending state, not zeros; after, outcomes with inferred barriers', async () => {
  const early = (await call(DEMO, 'GET', `/review?date=${TODAY}&now=${TODAY}T10:00:00`)).body;
  assert.equal(early.scorable, false);
  assert.ok(early.pendingYs > 0 && /after 14:00/.test(early.message));
  const late = (await call(DEMO, 'GET', `/review?date=${TODAY}`)).body;
  assert.equal(late.scorable, true);
  assert.ok(late.byUnit.length && 'accuracyPct' in late.house);
  const missed = late.byUnit.flatMap(u => u.missed);
  assert.ok(missed.length && missed.every(m => m.barrier && m.barrier.code && m.barrier.inferred));
  const enc = missed[0];
  const c = await call(DEMO, 'POST', `/review/${enc.encounterKey}/barrier`, { body: { date: TODAY, code: 'TRANSPORT' } });
  assert.equal(c.status, 200);
  const again = (await call(DEMO, 'GET', `/review?date=${TODAY}`)).body;
  const row = again.byUnit.flatMap(u => u.missed).find(m => m.encounterKey === enc.encounterKey);
  assert.equal(row.barrier.code, 'TRANSPORT'); assert.equal(row.barrier.inferred, false); assert.equal(row.barrier.confirmedBy, 'Test User');
  const rv = await call(DEMO, 'POST', `/review/unit/${encodeURIComponent('4 East')}/reviewed`, { body: { date: TODAY } });
  assert.equal(rv.status, 200);
  const strip = (await call(DEMO, 'GET', `/board?date=${T.addDays(TODAY, 1)}&now=${T.addDays(TODAY, 1)}T09:00:00`)).body.yesterday;
  assert.equal(strip.unitsReviewed, 1, 'the next morning\'s strip counts it');
});

test('scoreboard, escalations, archetypes and barriers respond with the shapes the tabs read', async () => {
  const from = T.addDays(TODAY, -27);
  const sb = await call(DEMO, 'GET', `/scoreboard?from=${from}&to=${TODAY}`);
  assert.equal(sb.status, 200, JSON.stringify(sb.body));
  assert.ok(sb.body.tiles.accuracyPct != null && sb.body.mode === 'EDD_TIME');
  assert.ok(sb.body.accuracyByUnit.length && sb.body.weekly.length && sb.body.conversionByRule.length);
  assert.ok(sb.body.fidelityByUnit.every(f => f.available), 'the demo carries PRED_EDIT_LOG');

  const es = await call(DEMO, 'GET', `/escalations?from=${from}&to=${TODAY}`);
  assert.equal(es.status, 200);
  for (const r of es.body.rules) {
    if (r.fired < es.body.minFirings) assert.equal(r.conversionPct, null, `${r.ruleKey} shows n only`);
    else assert.ok(r.conversionPct != null);
  }
  assert.ok(es.body.rules.find(r => r.ruleKey === 'MRD_HOME').conversionPct > es.body.rules.find(r => r.ruleKey === 'LOS_EXCESS').conversionPct,
    'MRD_HOME converts better than LOS_EXCESS — the huddle learns where to spend its minutes');
  assert.ok(es.body.firings.length && es.body.byUnit.length);

  const ar = await call(DEMO, 'GET', `/learn/archetypes?from=${from}&to=${TODAY}`);
  assert.equal(ar.status, 200);
  assert.ok(ar.body.archetypes.some(a => a.n >= 5 && a.bedHours > 0), 'a segment with n ≥ 5 and a bed-hours figure');
  assert.ok(ar.body.archetypes.every(a => a.encounters.length === a.n && a.sentence && a.suggestedBin));
  assert.match(ar.body.archetypes[0].sentence, /4 East/, 'RT-2: the home-health story on 4 East leads');

  const br = await call(DEMO, 'GET', `/barriers?from=${from}&to=${TODAY}`);
  assert.equal(br.status, 200);
  assert.ok(br.body.rows.length && br.body.rows.every(r => r.unit && r.code && r.status === 'open'));
  const first = br.body.rows[0];
  const up = await call(DEMO, 'POST', `/barriers/${encodeURIComponent(first.unit)}/${first.code}`, { body: { status: 'operational fix', pilot_ref: 'PI-42' } });
  assert.equal(up.status, 200); assert.equal(up.body.status, 'operational fix');
  const imp = await call(DEMO, 'POST', '/improvements', { body: { kind: 'archetype', archetype: ar.body.archetypes[0].key, sentence: ar.body.archetypes[0].sentence, unit: ar.body.archetypes[0].unit } });
  assert.equal(imp.status, 201);
  const ar2 = (await call(DEMO, 'GET', `/learn/archetypes?from=${from}&to=${TODAY}`)).body;
  assert.equal(ar2.archetypes[0].status, 'queued');
});

test('the discharge list groups every unit by status, ranks straight through, and matches the board', async () => {
  const { status, body } = await call(DEMO, 'GET', `/discharges?date=${TODAY}`);
  assert.equal(status, 200, JSON.stringify(body));
  const board = (await call(DEMO, 'GET', `/board?date=${TODAY}`)).body;
  // Every unit on the board is in the list, with the board's own header.
  assert.deepEqual(body.units.map(u => u.unit), board.units.map(u => u.unit));
  for (const g of body.units) {
    const row = board.units.find(u => u.unit === g.unit);
    assert.equal(g.header.status, row.status, `${g.unit} status`);
    assert.equal(g.ns.length, row.ns, `${g.unit} N count matches the board`);
    for (const p of g.ns) {
      assert.equal(p.unit, g.unit);
      assert.equal(p.pred, 'N');
      assert.ok(Array.isArray(p.chips) && p.chips.length, 'every card carries its activities');
      assert.ok(p.chips.every(c => ['done', 'progress', 'blocked'].includes(c.state)));
      assert.ok(p.initials && p.roomBed, 'initials and room are the identifiers');
      assert.ok(!('name' in p) && !('mrn' in p), 'no names, no MRNs');
    }
  }
  // Red units come first in the list the page renders.
  const order = ['red', 'even', 'green'];
  const colors = body.units.map(u => u.header.color).filter((c, i, a) => c !== a[i - 1]);
  assert.ok(body.units.some(u => u.header.color === 'red'), 'the demo has a short unit');
  assert.ok(colors.every(c => order.includes(c)));
});

test('the discharge list filters by unit and by status, and agrees with the single-unit route', async () => {
  const one = (await call(DEMO, 'GET', `/discharges?date=${TODAY}&unit=${encodeURIComponent('5 Central')}`)).body;
  assert.deepEqual(one.units.map(u => u.unit), ['5 Central']);
  const flat = (await call(DEMO, 'GET', `/unit/${encodeURIComponent('5 Central')}/ns?date=${TODAY}`)).body;
  assert.deepEqual(one.units[0].ns.map(p => p.encounterKey), flat.ns.map(p => p.encounterKey),
    'the same unit, opened either way, is the same ranked list');

  const red = (await call(DEMO, 'GET', `/discharges?date=${TODAY}&status=red`)).body;
  assert.ok(red.units.length, 'the demo has red units');
  assert.ok(red.units.every(u => u.header.color === 'red'));

  const bogus = (await call(DEMO, 'GET', `/discharges?date=${TODAY}&status=purple`)).body;
  assert.equal(bogus.status, null, 'an unknown status filters nothing rather than erroring');
});

test('patients with no EDD are listed apart, never counted as predictions', async () => {
  const { body } = await call(DEMO, 'GET', `/discharges?date=${TODAY}`);
  const noEdd = body.units.flatMap(u => u.noEdd);
  for (const p of noEdd) {
    assert.equal(p.pred, null);
    assert.ok(!p.eddDate || p.eddUnknown, 'the field is empty or flagged Unknown — not merely a later date');
    assert.notEqual(p.levelOfCare, 'ICU', 'patients no rule would suggest stay out');
  }
  // A patient whose EDD is simply further out has a date, and is not here.
  const later = body.units.flatMap(u => u.noEdd).filter(p => p.eddDate && !p.eddUnknown);
  assert.equal(later.length, 0);
  // They are not in the ranked population and cannot move accuracy.
  const ranked = body.units.flatMap(u => [...u.ns, ...u.ysAtRisk]).map(p => p.encounterKey);
  assert.ok(noEdd.every(p => !ranked.includes(p.encounterKey)));
});

test('ancillary groups pending items by service and is honest when a tenant has none', async () => {
  const { body } = await call(DEMO, 'GET', `/ancillary?date=${TODAY}`);
  assert.ok(body.available && body.services.length);
  for (const s of body.services) {
    assert.equal(s.count, s.rows.length);
    for (let i = 1; i < s.rows.length; i++) assert.ok(s.rows[i - 1].neededBy <= s.rows[i].neededBy, 'sorted by needed-by');
    assert.ok(s.rows.every(r => ['Y', 'N · escalated'].includes(r.tag)));
  }
});

test('admin: settings and rules are validated, and take effect on the next read', async () => {
  const bad = await call(DEMO, 'PUT', '/settings', { body: { settings: { pred_source: 'GUESS' } } });
  assert.equal(bad.status, 400);
  const notAdmin = await call(DEMO, 'PUT', '/settings', { body: { settings: { pred_source: 'EDD_DATE' } }, admin: false });
  assert.equal(notAdmin.status, 403);
  const ok = await call(DEMO, 'PUT', '/settings', { body: { settings: { pred_source: 'EDD_DATE' } } });
  assert.equal(ok.status, 200);
  const b1 = (await call(DEMO, 'GET', `/board?date=${TODAY}`)).body;
  assert.equal((await call(DEMO, 'GET', '/meta')).body.settings.pred_source, 'EDD_DATE');
  await call(DEMO, 'PUT', '/settings', { body: { settings: { pred_source: 'EDD_TIME' } } });
  const b2 = (await call(DEMO, 'GET', `/board?date=${TODAY}`)).body;
  assert.ok(b1.units.reduce((s, u) => s + u.predictedY, 0) >= b2.units.reduce((s, u) => s + u.predictedY, 0),
    'EDD_DATE cannot express "today, after 2 PM", so it predicts at least as many Ys');
  const rules = await call(DEMO, 'PUT', '/rules', { body: { rules: [{ rule_key: 'LOS_EXCESS', enabled: false }] } });
  assert.equal(rules.status, 200);
  const ns = (await call(DEMO, 'GET', `/unit/${encodeURIComponent('5 Central')}/ns?date=${TODAY}`)).body;
  assert.ok(ns.ns.every(n => !n.candidates.some(c => c.ruleKey === 'LOS_EXCESS')));
  await call(DEMO, 'PUT', '/rules', { body: { rules: [] } });
  const unknown = await call(DEMO, 'PUT', '/rules', { body: { rules: [{ rule_key: 'NOPE' }] } });
  assert.equal(unknown.status, 400);
});

// ── the SQL backend ─────────────────────────────────────────────────────────

test('sql source: snapshot rows from DS_RTDC_Snapshot are normalized and served; OHS-shaped nulls do not 500', async () => {
  const snapshotRows = [
    { SNAPSHOT_DATE: new Date(2026, 8, 4), SNAPSHOT_KIND: 'S2', SNAPSHOT_AT: new Date(2026, 8, 4, 8, 20), ENCOUNTER_KEY: 'E1', HOSPITAL: 'H', UNIT: '5 Central',
      ROOM_BED: '501-A', PATIENT_INITIALS: 'AB', LOS_DAYS: 5, GMLOS: 3, LEVEL_OF_CARE: 'Med-Surg', ATTENDING: 'Dr. Q', EXPECTED_DISPOSITION: 'Home',
      PRED_SOURCE_DATE: new Date(2026, 8, 4), PRED_SOURCE_TIME: new Date(Date.UTC(1970, 0, 1, 16, 0)), MRD: true, DC_NARRATIVE: 'DC order, ride at 3.',
      PENDING_ITEMS: null, FLAGS: '["isolation"]', PRED_EDIT_LOG: null },
    { SNAPSHOT_DATE: new Date(2026, 8, 4), SNAPSHOT_KIND: 'S2', SNAPSHOT_AT: new Date(2026, 8, 4, 8, 20), ENCOUNTER_KEY: 'E2', HOSPITAL: 'H', UNIT: '5 Central',
      PRED_SOURCE_DATE: new Date(2026, 8, 4), PRED_SOURCE_TIME: new Date(Date.UTC(1970, 0, 1, 10, 0)), PENDING_ITEMS: null },
  ];
  const unitRows = [{ SNAPSHOT_DATE: new Date(2026, 8, 4), SNAPSHOT_KIND: 'S2', SNAPSHOT_AT: new Date(2026, 8, 4, 8, 20), HOSPITAL: 'H', UNIT: '5 Central',
    STAFFED_BEDS: 10, OCCUPIED_BEDS: 8, BLOCKED_BEDS: 0, PENDING_BED_REQUESTS_IN: '[{"source_dept":"ED"}]', OR_EXPECTED_ADMITS_BY_2PM: 1 }];
  const pool = { request() { const api = { input() { return api; }, async query(text) {
    if (text.includes('FROM DS_RTDC_Snapshot')) return { recordset: snapshotRows };
    if (text.includes('FROM DS_RTDC_UnitSnapshot')) return { recordset: unitRows };
    throw new Error('unstubbed: ' + text.slice(0, 40));
  } }; return api; } };
  // A tenant on the SQL source with pending items unavailable: 'default' has no
  // rtdc feature, so drive it through settings overrides on the demo tenant.
  await call(DEMO, 'PUT', '/settings', { body: { settings: { pred_source: 'EDD_TIME' } } });
  const S2 = require(path.join(ROOT, 'lib', 'rtdcSource'));
  const ctx = { tenantId: 3, getTenantPool: async () => pool, sql: sqlStub, settings: { source: 'sql' } };
  const days = await S2.loadRange(ctx, TODAY, TODAY);
  const day = days.get(TODAY);
  assert.ok(day && day.S2 && day.S2.patients.length === 2 && day.S2.units.length === 1);
  const e1 = day.S2.patients.find(p => p.ENCOUNTER_KEY === 'E1');
  assert.equal(e1.PRED_SOURCE_DATE, TODAY); assert.equal(e1.PRED_SOURCE_TIME, '16:00');
  assert.deepEqual(e1.FLAGS, ['isolation']);
  const D = require(path.join(ROOT, 'lib', 'rtdcDay'));
  const p = D.annotate(day.S2.patients, { settings: { pred_source: 'EDD_TIME', list_horizon_days: 1, cutoff: '14:00' }, rules }, TODAY);
  assert.equal(p.find(x => x.ENCOUNTER_KEY === 'E1').pred, 'N');
  assert.equal(p.find(x => x.ENCOUNTER_KEY === 'E2').pred, 'Y');
  const view = Y.buildUnitView(p, { date: TODAY, now: T.at(TODAY, '09:00'), cutoff: '14:00', rules, medians: {} });
  assert.equal(view.ns[0].pendingItemsAvailable, false);
  assert.ok(view.ns[0].steps.every(s => s.kind !== 'pending'), 'steps are narrative-only without pending items');
});

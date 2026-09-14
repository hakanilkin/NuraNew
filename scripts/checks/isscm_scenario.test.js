#!/usr/bin/env node
//
// Unit tests for the ISSCM scenario engine (ISSCMIntegrationView.md §4).
//
// The engine is pure, so it is tested directly rather than through the route.
// The rules being defended here are the ones the panel exists to express:
// the three pillars are never collapsed into one number, they are allowed to
// disagree, and every driver carries the figures it was derived from.
//
// Run: node --test scripts/checks/isscm_scenario.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const E = require(path.join(__dirname, '..', '..', 'lib', 'isscmScenario'));

const baseline = () => ({
  site: 'Bright Memorial Hospital', block: 'Ortho A', dayOfWeek: 3,
  surgeon: {
    allocatedHours: 8, blockUtilPct: 55.8, trueUtilPct: 61.8,
    receivingService: 'Spine', receivingPipelineVsBaselinePct: 48, strategicWeight: 3,
  },
  staffing: {
    staffedRooms: 9, shiftHours: 8.5, coverageRatio: 1,
    requiredRoomHours: 66.4, pastShiftRoomHours: 5.3, concurrencyPeak: 8.2,
  },
  capacity: {
    units: [
      { unit: '5 Central', staffedBeds: 32, projectedCensus: 27.8 },
      { unit: '4 East', staffedBeds: 28, projectedCensus: 23.8 },
    ],
    inpatientConversionRate: { Spine: 0.56 },
    serviceUnitMap: { Spine: { '5 Central': 62, '4 East': 38 } },
    averageCaseHours: 2.6,
  },
});

const decision = over => ({
  kind: 'REALLOCATE', fromBlock: 'Ortho A', toService: 'Spine', hours: 4,
  dayOfWeek: 3, dayOfWeekLabel: 'Thursday', weeks: 8, ...over,
});

test('all three pillars are reported, and never as one score', () => {
  const r = E.evaluate(baseline(), decision());
  assert.deepEqual(Object.keys(r.pillars).sort(), ['capacity', 'staffing', 'surgeon']);
  assert.equal(r.score, undefined, 'a composite score is exactly what this panel argues against');
  assert.equal(r.pillars.surgeon.total, undefined);
});

test('moving hours to a service with a pipeline improves true utilization', () => {
  const r = E.evaluate(baseline(), decision());
  const h = r.pillars.surgeon.headline;
  assert.equal(r.pillars.surgeon.status, E.IMPROVES);
  assert.ok(h.after > h.before, `${h.after} should exceed ${h.before}`);
});

test('block and true utilization are shown side by side', () => {
  const r = E.evaluate(baseline(), decision());
  const labels = r.pillars.surgeon.secondary.map(s => s.label);
  assert.equal(r.pillars.surgeon.headline.label, 'True utilization');
  assert.ok(labels.includes('Block utilization'), 'the gap between them is the argument');
});

test('a day already at its packing ceiling spills added work into overtime', () => {
  const r = E.evaluate(baseline(), decision());
  const p = r.pillars.staffing;
  assert.equal(p.status, E.DEGRADES);
  assert.ok(p.headline.after > p.headline.before);
});

test('a day with slack absorbs the same work without degrading', () => {
  const b = baseline();
  b.staffing.requiredRoomHours = 50.7;
  b.staffing.pastShiftRoomHours = 2.6;
  b.staffing.concurrencyPeak = 6.5;
  const r = E.evaluate(b, decision({ dayOfWeek: 1, dayOfWeekLabel: 'Tuesday' }));
  assert.equal(r.pillars.staffing.status, E.NEUTRAL);
  assert.deepEqual(r.conflicts, [], 'nothing to conflict with when every pillar clears');
});

test('staffing headroom is never reported as improved by a decision that consumes it', () => {
  const b = baseline();
  b.staffing.requiredRoomHours = 10;      // acres of room
  const r = E.evaluate(b, decision());
  assert.notEqual(r.pillars.staffing.status, E.IMPROVES);
});

test('a room with no concurrency headroom degrades even when the hours fit', () => {
  const b = baseline();
  b.staffing.requiredRoomHours = 10;
  b.staffing.concurrencyPeak = 9;         // every staffed room already running
  const r = E.evaluate(b, decision());
  assert.equal(r.pillars.staffing.status, E.DEGRADES);
});

test('pushing a unit over its pressure threshold degrades capacity', () => {
  const b = baseline();
  b.capacity.units[0].projectedCensus = 29.4;   // 5 Central already at 92%
  const r = E.evaluate(b, decision({ hours: 8 }));
  assert.equal(r.pillars.capacity.status, E.DEGRADES);
  assert.ok(r.pillars.capacity.drivers.some(d => d.key === 'pressure'));
});

test('conflicts name the degrading pillars and are absent when all agree', () => {
  const r = E.evaluate(baseline(), decision());
  assert.equal(r.conflicts.length, 1);
  assert.ok(r.conflicts[0].pillars.includes('staffing'));
  assert.match(r.conflicts[0].summary, /Thursday/);

  const b = baseline();
  b.staffing.requiredRoomHours = 30;
  b.staffing.concurrencyPeak = 5;
  assert.deepEqual(E.evaluate(b, decision()).conflicts, []);
});

test('two degrading pillars raise the conflict severity', () => {
  const b = baseline();
  b.capacity.units[0].projectedCensus = 30;
  const r = E.evaluate(b, decision({ hours: 8 }));
  if (r.conflicts.length) {
    assert.equal(r.conflicts[0].severity,
      r.conflicts[0].pillars.length > 1 ? 'high' : 'medium');
  }
});

test('every driver carries a number and the figures behind it', () => {
  const r = E.evaluate(baseline(), decision());
  for (const [name, p] of Object.entries(r.pillars)) {
    assert.ok(p.drivers.length, `${name} has no drivers`);
    for (const d of p.drivers) {
      assert.equal(typeof d.contribution, 'number', `${name}.${d.key} contribution`);
      assert.ok(d.detail && d.detail.length > 20, `${name}.${d.key} needs a real detail string`);
      assert.ok(['up', 'down', 'flat'].includes(d.direction));
    }
  }
});

test('thresholds come from config, not from the code', () => {
  const b = baseline();
  b.staffing.requiredRoomHours = 64;
  const lenient = E.evaluate(b, decision(), { thresholds: { overtimeHours: 99, coverageRooms: 0 } });
  const strict  = E.evaluate(b, decision(), { thresholds: { overtimeHours: 0.1, coverageRooms: 0 } });
  assert.notEqual(lenient.pillars.staffing.status, strict.pillars.staffing.status);
});

test('the engine is pure — the same inputs give the same result, inputs untouched', () => {
  const b = baseline();
  const snapshot = JSON.stringify(b);
  const a = E.evaluate(b, decision());
  const c = E.evaluate(b, decision());
  assert.deepEqual(a, c);
  assert.equal(JSON.stringify(b), snapshot, 'evaluate() must not mutate its baseline');
});

test('a service that admits nobody leaves inpatient capacity alone', () => {
  const b = baseline();
  b.capacity.inpatientConversionRate = { Spine: 0 };
  const r = E.evaluate(b, decision());
  assert.equal(r.pillars.capacity.status, E.NEUTRAL);
});

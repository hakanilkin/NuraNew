#!/usr/bin/env node
//
// Tests for lib/demandSignal.js (VolumeOutlook.md §3 and §6).
//
// Three things are being defended:
//   * Both exception thresholds, so a three-to-four case day never appears.
//   * The tier is a data field. RECOMMENDED means the arithmetic is shown;
//     POTENTIAL means we noticed a pattern and are not pretending to quantify
//     it. PACU, pre-op and ancillary are always POTENTIAL.
//   * The room requirement is lib/staffingShape.js's, so this page, Staffing
//     Patterns and Pillar 2 cannot show different rooms for the same day.
//
// Run: node --test scripts/checks/demand_signal.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const D = require(path.join(__dirname, '..', '..', 'lib', 'demandSignal'));
const S = require(path.join(__dirname, '..', '..', 'lib', 'staffingShape'));

const PLAN = { staffedRooms: 9, shiftStart: '07:00', shiftEnd: '15:30' };
const DUR = { Orthopedics: 101, 'General Surgery': 80, ENT: 52 };
const MIX = [{ service: 'Orthopedics', forecast: 14 }, { service: 'ENT', forecast: 6 }];

// ── Exception detection ─────────────────────────────────────────────────────

test('both thresholds must be met', () => {
  const t = { exceptionPct: 15, minCases: 4, onPlanPct: 5 };
  assert.equal(D.isException(D.variance(44, 37), t), true, '+7 cases and +19% is an exception');
  assert.equal(D.isException(D.variance(40, 37), t), false, '+3 cases is under the floor');
  assert.equal(D.isException(D.variance(41, 37), t), false, '+4 cases but only +11%');
});

test('a three-to-four case day is not an exception', () => {
  assert.equal(D.isException(D.variance(4, 3)), false);
});

test('a big miss on a big day is an exception in both directions', () => {
  assert.equal(D.isException(D.variance(23, 30)), true);
  assert.equal(D.isException(D.variance(38, 30)), true);
});

test('the on-plan band is wider than a hairline', () => {
  assert.equal(D.isOnPlan(D.variance(38, 37)), true);
  assert.equal(D.isOnPlan(D.variance(44, 37)), false);
});

test('a day with no budget has no variance rather than an infinite one', () => {
  const v = D.variance(20, 0);
  assert.equal(v.variancePct, null);
  assert.equal(D.isException(v), false);
});

// ── Drivers ─────────────────────────────────────────────────────────────────

test('the primary driver is the largest absolute contribution', () => {
  const d = D.primaryDrivers([
    { service: 'ENT', delta: 1 }, { service: 'Orthopedics', delta: 8 },
    { service: 'Urology', delta: -2 },
  ]);
  assert.equal(d[0].label, 'Orthopedics');
  assert.equal(d[0].contribution, 8);
  assert.match(d[0].detail, /\+8 Orthopedics/);
});

test('a runner-up within reach is kept, a trivial one is not', () => {
  const two = D.primaryDrivers([{ service: 'GI', delta: 4 }, { service: 'ENT', delta: 3 }]);
  assert.equal(two.length, 2, 'a day driven by two services should not read as one');
  const one = D.primaryDrivers([{ service: 'GI', delta: 9 }, { service: 'ENT', delta: 1 }]);
  assert.equal(one.length, 1);
});

test('a day nothing drove reports no driver rather than a fake one', () => {
  assert.deepEqual(D.primaryDrivers([{ service: 'ENT', delta: 0 }]), []);
});

// ── The conversion ──────────────────────────────────────────────────────────

test('average case length is weighted by the forecast mix, not a flat mean', () => {
  const weighted = D.mixWeightedCaseMinutes(MIX, DUR, 33);
  const flat = (101 + 52) / 2 + 33;
  assert.notEqual(weighted, flat);
  assert.ok(weighted > flat, `${weighted} should exceed the flat mean ${flat}`);
});

test('an unknown service makes the average a guess, so none is returned', () => {
  assert.equal(D.mixWeightedCaseMinutes(
    [{ service: 'Robotics', forecast: 5 }], DUR, 33), null);
});

test('case capacity states its own arithmetic', () => {
  const c = D.caseCapacity(PLAN, 120);
  assert.equal(c.cases, Math.round((9 * 510) / 120 * 10) / 10);
  assert.match(c.assumption, /9 staffed rooms x 510 shift minutes \/ 120 min per case/);
});

test('capacity is unknowable without a plan or a duration', () => {
  assert.equal(D.caseCapacity(PLAN, 0), null);
  assert.equal(D.caseCapacity({ staffedRooms: 0, shiftMinutes: 510 }, 120), null);
});

// ── Signals ─────────────────────────────────────────────────────────────────

const signal = (forecast, budget, bookedMinutes, plan = PLAN) => D.buildSignal({
  date: '2026-09-09', site: 'Bright Memorial Hospital',
  v: D.variance(forecast, budget),
  drivers: D.primaryDrivers([{ service: 'Orthopedics', delta: forecast - budget }]),
  plan, mix: MIX, durationsByService: DUR, turnoverMinutes: 33, bookedMinutes,
});

test('a quantified room change is RECOMMENDED and shows the arithmetic', () => {
  const s = signal(23, 30, 510 * 5.4);
  assert.equal(s.tier, D.RECOMMENDED);
  assert.equal(s.flexFlag, 'FLEX_DOWN');
  assert.match(s.implication, /Staffs 9 rooms, needs \d+ — flex \d+ down/);
});

test('a day the plan already fits is POTENTIAL, not a fabricated recommendation', () => {
  const s = signal(38, 31, 510 * 8.2);
  assert.equal(s.tier, D.POTENTIAL);
  assert.equal(s.flexFlag, null);
});

test('without a staffing plan the tier can never be RECOMMENDED', () => {
  const s = signal(44, 30, 510 * 11, null);
  assert.equal(s.tier, D.POTENTIAL);
  assert.equal(s.roomGap, null);
  assert.equal(s.plannedRooms, null);
  assert.ok(s.implication, 'the column is never blank');
});

test('the staffing implication is never blank', () => {
  for (const s of [signal(44, 30, 510 * 11), signal(23, 30, 510 * 5), signal(44, 30, 510 * 11, null)]) {
    assert.ok(s.implication && s.implication.length > 10);
  }
});

test('PACU, pre-op and ancillary are always POTENTIAL considerations', () => {
  const s = signal(23, 30, 510 * 5.4);
  assert.equal(s.tier, D.RECOMMENDED, 'even on a quantified row');
  const text = s.considerations.join(' ').toLowerCase();
  for (const area of ['pacu', 'pre-op', 'ancillary']) {
    assert.ok(text.includes(area), `${area} should be flagged, never quantified`);
  }
});

test('the headline follows the quantified implication, not the case count', () => {
  const s = signal(44, 37, 510 * 5.4);
  assert.equal(s.tier, D.RECOMMENDED);
  assert.equal(s.flexFlag, 'FLEX_DOWN');
  assert.equal(s.headline, 'Flex-down opportunity');
});

test("signal text is templated from the row's own numbers", () => {
  const s = signal(44, 37, 510 * 11);
  assert.match(s.summary, /19% above budget/);
  assert.match(s.summary, /\+7 Orthopedics/);
  assert.ok(!/expected to be elevated/i.test(s.summary), 'no generic commentary');
});

test("the room requirement is staffingShape's, not a second opinion", () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'demandSignal.js'), 'utf8');
  assert.match(src, /require\(['"]\.\/staffingShape['"]\)/);

  const booked = 510 * 5.4;
  const s = signal(23, 30, booked);
  assert.equal(s.impliedRooms, S.impliedRooms(booked, PLAN));
  assert.equal(s.recommendedRooms, S.recommendedRooms(s.impliedRooms, PLAN.staffedRooms));
  assert.equal(s.flexFlag, S.flexFlag(PLAN.staffedRooms, s.impliedRooms));
});

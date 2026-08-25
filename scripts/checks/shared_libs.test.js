#!/usr/bin/env node
//
// Tests for lib/staffingShape.js and lib/censusFootprint.js, and for the hard
// requirement both page specs impose: the ISSCM engine's pillars must compute
// from these same functions.
//
// ORSmoothing.md §2 and StaffingAlignment.md §2 both call this out explicitly.
// A Smoothing page whose census cells disagreed with the panel judging its own
// recommendation, or a Staffing ledger whose overtime column disagreed with
// Pillar 2, would be worse than either surface alone.
//
// Run: node --test scripts/checks/shared_libs.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const S = require(path.join(__dirname, '..', '..', 'lib', 'staffingShape'));
const C = require(path.join(__dirname, '..', '..', 'lib', 'censusFootprint'));
const E = require(path.join(__dirname, '..', '..', 'lib', 'isscmScenario'));

const PLAN = { staffedRooms: 9, shiftStart: '07:00', shiftEnd: '15:30' };
const SLOT = 15;

// A day that runs six rooms all shift and two past the end.
function shape({ during = 6, after = 2 } = {}) {
  const out = [];
  for (let t = 6 * 60; t < 20 * 60; t += SLOT) {
    const inShift = t >= 7 * 60 && t < 15.5 * 60;
    out.push({ minuteOfDay: t, rooms: inShift ? during : (t >= 15.5 * 60 && t < 17 * 60 ? after : 0) });
  }
  return out;
}

// ── staffingShape ───────────────────────────────────────────────────────────

test('idle staffed hours are the rectangle standing above the demand', () => {
  // 3 unused rooms over an 8.5h shift.
  assert.equal(Math.round(S.idleRoomHours(shape(), PLAN, SLOT)), Math.round(3 * 8.5));
});

test('idle counts only inside the staffed window', () => {
  const empty = shape({ during: 9, after: 0 });
  assert.equal(S.idleRoomHours(empty, PLAN, SLOT), 0);
});

test('overtime counts every room still running past shift end', () => {
  // 2 rooms for the 90 minutes after 15:30.
  assert.equal(S.overtimeRoomHours(shape(), PLAN, SLOT), 2 * 1.5);
});

test('a day that ends on time carries no overtime', () => {
  assert.equal(S.overtimeRoomHours(shape({ after: 0 }), PLAN, SLOT), 0);
});

test('alignment is demand inside the rectangle over staffed hours', () => {
  assert.equal(Math.round(S.alignmentPct(shape(), PLAN, SLOT)), Math.round((6 / 9) * 100));
});

test('alignment never exceeds 100% when demand overflows the rectangle', () => {
  const over = shape({ during: 12 });
  assert.ok(S.alignmentPct(over, PLAN, SLOT) <= 100);
});

test('implied rooms round up — you cannot staff four fifths of a room', () => {
  assert.equal(S.impliedRooms(510 * 6, PLAN), 6);
  assert.equal(S.impliedRooms(510 * 6 + 1, PLAN), 7);
});

test('flex flags fire on slack in each direction', () => {
  assert.equal(S.flexFlag(9, 6), 'FLEX_DOWN');
  assert.equal(S.flexFlag(9, 8), null);
  assert.equal(S.flexFlag(9, 11), 'FLEX_UP');
});

test('a day past its packing ceiling spills every added hour', () => {
  const day = { staffedRooms: 9, shiftHours: 8.5, requiredRoomHours: 66.4, concurrencyPeak: 8.2 };
  const r = S.coverageImpact(day, 3, 0.85);
  assert.ok(r.addedSpill > 2.9 && r.addedSpill <= 3.01, `spill was ${r.addedSpill}`);
});

test('a day with slack absorbs the same hours without spilling', () => {
  const day = { staffedRooms: 9, shiftHours: 8.5, requiredRoomHours: 50.7, concurrencyPeak: 6.5 };
  assert.equal(S.coverageImpact(day, 3, 0.85).addedSpill, 0);
});

// ── censusFootprint ─────────────────────────────────────────────────────────

test('the survival curve decays with length of stay', () => {
  const curve = C.survivalCurve([{ days: 3, share: 1 }], 5);
  assert.equal(curve[0], 1);
  assert.equal(curve[2], 1);       // day 3 of a 3-day stay is still occupied
  assert.equal(curve[3], 0);
});

test('a bed shadow spreads admissions across units and days', () => {
  const f = C.bedShadow({
    weeklyCases: 20, conversionRate: 0.5,
    losDays: [{ days: 3, share: 1 }],
    unitShares: { '5 Central': 60, '4 East': 40 },
  }, 5);
  assert.equal(f.admissionsPerWeek, 10);
  assert.equal(f.units[0].unit, '5 Central');
  assert.equal(f.units[0].byOffset[0].beds, 6);
  assert.equal(f.units[0].byOffset[4].beds, 0);
});

test('attribution decomposes a cell and never exceeds the census', () => {
  const c = C.attributeCensus({ census: 30, orAdmitted: 9, edAdmitted: 18, capacity: 32 });
  assert.equal(c.or + c.ed + c.other, 30);
  assert.equal(c.orPct, 30);
  assert.ok(c.crunch, '30 of 32 is over the 92% threshold');
});

test('attribution clamps a source that claims more than the census', () => {
  const c = C.attributeCensus({ census: 10, orAdmitted: 99, edAdmitted: 99, capacity: 32 });
  assert.equal(c.or, 10);
  assert.equal(c.ed, 0);
  assert.equal(c.other, 0);
});

test('the crunch threshold is a parameter, not a constant', () => {
  const cell = { census: 28, orAdmitted: 8, edAdmitted: 15, capacity: 32 };
  assert.equal(C.attributeCensus(cell, 85).crunch, true);
  assert.equal(C.attributeCensus(cell, 95).crunch, false);
});

test('a shift moves beds off one day and onto another', () => {
  const grid = [0, 1, 2, 3, 4, 5, 6].map(dow => ({ unit: '5 Central', dow, census: 28, capacity: 32 }));
  const r = C.shiftPreview({
    grid, unitShares: { '5 Central': 100 }, conversionRate: 0.5,
    casesPerWeek: 4, fromDow: 2, toDow: 4, losDays: [{ days: 1, share: 1 }],
  });
  const wed = r.cells.find(c => c.dow === 2);
  const fri = r.cells.find(c => c.dow === 4);
  assert.ok(wed.delta < 0, 'Wednesday should lose beds');
  assert.ok(fri.delta > 0, 'Friday should gain them');
  assert.equal(Math.round(wed.delta + fri.delta), 0, 'a shift conserves beds');
});

// ── The shared-lib requirement ──────────────────────────────────────────────

test('the engine imports the shared libraries rather than copying them', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'isscmScenario.js'), 'utf8');
  assert.match(src, /require\(['"]\.\/staffingShape['"]\)/,
    'Pillar 2 must compute from lib/staffingShape.js');
  assert.match(src, /require\(['"]\.\/censusFootprint['"]\)/,
    'Pillar 3 must compute from lib/censusFootprint.js');
});

test('Pillar 2 reports exactly what staffingShape computes', () => {
  const baseline = {
    surgeon: { allocatedHours: 8, blockUtilPct: 55, trueUtilPct: 61, receivingPipelineVsBaselinePct: 40 },
    staffing: { staffedRooms: 9, shiftHours: 8.5, requiredRoomHours: 66.4, concurrencyPeak: 8.2, coverageRatio: 1 },
    capacity: { units: [], inpatientConversionRate: {}, serviceUnitMap: {}, averageCaseHours: 2.6 },
  };
  const decision = { kind: 'REALLOCATE', fromBlock: 'Ortho A', toService: 'Spine', hours: 4, dayOfWeek: 3 };
  const r = E.evaluate(baseline, decision);
  const effect = E.deriveEffect(baseline, decision, E.DEFAULT_CFG);
  const direct = S.coverageImpact({ ...baseline.staffing, staffedRoomsDelta: 0 },
    effect.addedRoomHours, E.DEFAULT_CFG.packingCeiling);
  assert.equal(r.pillars.staffing.headline.after, Math.round(direct.overtimeAfter * 10) / 10);
});

test('Pillar 3 reports exactly what censusFootprint computes', () => {
  const baseline = {
    surgeon: { allocatedHours: 8, blockUtilPct: 55, trueUtilPct: 61, receivingPipelineVsBaselinePct: 40 },
    staffing: { staffedRooms: 9, shiftHours: 8.5, requiredRoomHours: 40, concurrencyPeak: 5 },
    capacity: {
      units: [{ unit: '5 Central', staffedBeds: 32, projectedCensus: 28 }],
      inpatientConversionRate: { Spine: 0.56 },
      serviceUnitMap: { Spine: { '5 Central': 100 } },
      averageCaseHours: 2.6,
    },
  };
  const decision = { kind: 'REALLOCATE', fromBlock: 'Ortho A', toService: 'Spine', hours: 8, dayOfWeek: 3 };
  const r = E.evaluate(baseline, decision);
  const effect = E.deriveEffect(baseline, decision, E.DEFAULT_CFG);
  const direct = C.projectUnitImpact(
    { units: baseline.capacity.units, unitShares: { '5 Central': 100 },
      addedAdmissions: effect.addedAdmissions },
    E.DEFAULT_CFG.thresholds.unitPressurePct);
  assert.equal(r.pillars.capacity.headline.after, direct.tightest.headroomAfter);
});

// ── The new decision kinds ──────────────────────────────────────────────────

const flexBaseline = () => ({
  surgeon: { allocatedHours: 8, blockUtilPct: 60, trueUtilPct: 64, receivingPipelineVsBaselinePct: 0 },
  staffing: { staffedRooms: 9, shiftHours: 8.5, requiredRoomHours: 34, concurrencyPeak: 6, coverageRatio: 1 },
  capacity: { units: [{ unit: '5 Central', staffedBeds: 32, projectedCensus: 24 }],
              inpatientConversionRate: { Spine: 0.5 },
              serviceUnitMap: { Spine: { '5 Central': 100 } }, averageCaseHours: 2.6 },
});

test('flexing down an over-staffed day improves staffing and touches nothing else', () => {
  // Nine planned against a six-room peak, flexed to seven: the recommendation
  // keeps a room in hand rather than staffing exactly to the peak.
  const r = E.evaluate(flexBaseline(), {
    kind: E.KINDS.FLEX_STAFFING, rooms: -2, dayOfWeek: 4, dayOfWeekLabel: 'Friday',
  });
  assert.equal(r.pillars.staffing.status, E.IMPROVES);
  assert.equal(r.pillars.surgeon.status, E.NEUTRAL);
  assert.equal(r.pillars.capacity.status, E.NEUTRAL);
  assert.deepEqual(r.conflicts, []);
});

test('flexing down to exactly the peak leaves no room in hand and degrades', () => {
  const r = E.evaluate(flexBaseline(), {
    kind: E.KINDS.FLEX_STAFFING, rooms: -3, dayOfWeek: 4, dayOfWeekLabel: 'Friday',
  });
  assert.equal(r.pillars.staffing.status, E.DEGRADES);
});

test('flexing down past the peak degrades harder still', () => {
  const r = E.evaluate(flexBaseline(), {
    kind: E.KINDS.FLEX_STAFFING, rooms: -6, dayOfWeek: 4, dayOfWeekLabel: 'Friday',
  });
  assert.equal(r.pillars.staffing.status, E.DEGRADES);
});

test('the recommendation keeps a room in hand, in both directions', () => {
  assert.equal(S.recommendedRooms(6, 9), 7, 'flexing down still leaves a room spare');
  // Clamping to the plan here would make a genuine flex-up unquantifiable.
  assert.equal(S.recommendedRooms(11, 9), 12, 'a day needing more rooms says so');
});

test('a day-of-week shift moves beds and room-time without claiming a utilisation gain', () => {
  const b = flexBaseline();
  b.capacity.units[0].projectedCensus = 29.5;   // receiving day already tight
  const r = E.evaluate(b, {
    kind: E.KINDS.SHIFT_DOW, service: 'Spine', casesPerWeek: 6,
    fromDow: 1, dayOfWeek: 2, dayOfWeekLabel: 'Wednesday',
  });
  assert.equal(r.pillars.surgeon.status, E.NEUTRAL,
    'moving volume between days does not change any block\'s allocation');
  assert.equal(r.pillars.capacity.status, E.DEGRADES);
  assert.ok(r.conflicts.length === 0, 'no pillar improves, so there is no tension to report');
});

test('a shift onto a day with room is clean', () => {
  const r = E.evaluate(flexBaseline(), {
    kind: E.KINDS.SHIFT_DOW, service: 'Spine', casesPerWeek: 3,
    fromDow: 2, dayOfWeek: 3, dayOfWeekLabel: 'Thursday',
  });
  assert.equal(r.pillars.capacity.status, E.NEUTRAL);
  assert.equal(r.pillars.staffing.status, E.NEUTRAL);
});

// lib/isscmScenario.js
//
// The ISSCM scenario evaluation engine (ISSCMIntegrationView.md §4).
//
// Every competitor in this category optimises slot occupancy. None of them model
// what an OR capacity decision does to staffing or to downstream inpatient beds,
// because their products are drawn around transactions on the block schedule
// rather than around decisions. This engine is that premise made computable: one
// decision, evaluated against three coupled pillars that are allowed to disagree.
//
// Pillars 2 and 3 delegate their arithmetic to lib/staffingShape.js and
// lib/censusFootprint.js, which the Staffing and OR Smoothing pages compute
// from as well. That sharing is a hard requirement of both page specs: a panel
// that disagreed with the page recommending the move would be worse than
// either alone.
//
// Deliberately mirrors lib/releaseRisk.js — every driver carries its own numeric
// contribution and a human `detail`, so the numbers *are* the explanation and the
// UI renders them directly rather than keeping a second copy of the reasoning.
//
// Two rules this file exists to enforce:
//
//   * The three pillars are never collapsed into one composite score. A single
//     number is exactly the thing this page argues against; disagreement is
//     expressed through `conflicts[]`.
//   * The engine is pure — (baseline, decision, cfg) -> result, no I/O, no DB
//     handle. That keeps it unit-testable, and it means routes/isscm.js can swap
//     mock inputs for live queries without touching the reasoning.

const { coverageImpact } = require('./staffingShape');
const { projectUnitImpact, admissionsFromRoomHours } = require('./censusFootprint');

const IMPROVES = 'improves';
const NEUTRAL  = 'neutral';
const DEGRADES = 'degrades';

// Thresholds belong in tenant config, not in code (§4). These are the fallbacks
// used when a tenant has not configured its own.
const DEFAULT_CFG = {
  thresholds: {
    // Pillar 1 — how many points of true utilization count as a real move.
    utilPts: 2.0,
    // Pillar 2 — rooms of coverage headroom lost before staffing is degraded,
    // and the weekly overtime hours that count as material.
    coverageRooms: 0.5,
    overtimeHours: 2.0,
    // Pillar 3 — beds of headroom lost before capacity is degraded, and the
    // occupancy above which a unit is considered under pressure.
    headroomBeds: 2.0,
    unitPressurePct: 92.0,
  },
  // Minutes of turnover the scheduler assumes when converting cases to
  // room-hours. Matches the seeder and the forecast view.
  turnoverMinutes: 33,
  // Share of staffed room-hours a day can realistically consume. Rooms turn
  // over, cases finish early, first cases start late.
  packingCeiling: 0.85,
};

const num = x => (Number.isFinite(Number(x)) ? Number(x) : 0);
const round1 = x => (x == null ? null : Math.round(x * 10) / 10);
const pct = (a, b) => (b > 0 ? (a / b) * 100 : null);

function statusFor(deltaTowardBetter, threshold) {
  if (deltaTowardBetter >= threshold) return IMPROVES;
  if (deltaTowardBetter <= -threshold) return DEGRADES;
  return NEUTRAL;
}

function driver(key, label, contribution, detail) {
  return {
    key,
    label,
    contribution: round1(contribution),
    direction: contribution > 0 ? 'up' : contribution < 0 ? 'down' : 'flat',
    detail,
  };
}

// ── Decisions ───────────────────────────────────────────────────────────────
//
// Three decision kinds, one evaluation path. Each reduces to the same effect —
// room-hours and admissions added to a day, and rooms added to or removed from
// its plan — so the pillars never learn what kind of decision they are judging.

const KINDS = {
  REALLOCATE: 'REALLOCATE',        // move block hours to another service
  SHIFT_DOW: 'SHIFT_DOW',          // move n cases/week from one weekday to another
  FLEX_STAFFING: 'FLEX_STAFFING',  // change the staffed rooms on a day
};

function deriveEffect(baseline, decision, cfg) {
  const cap = baseline.capacity || {};
  const service = decision.toService || decision.service;
  const conversion = num((cap.inpatientConversionRate || {})[service]);
  const caseHours = num(cap.averageCaseHours) || 2.0;

  if (decision.kind === KINDS.FLEX_STAFFING) {
    // Flexing does not create or remove work; it changes what is staffed to
    // meet it. Everything the decision does lands on Pillar 2.
    return {
      service, conversion, caseHours,
      addedRoomHours: 0,
      addedAdmissions: 0,
      staffedRoomsDelta: num(decision.rooms),
      filledHours: 0,
    };
  }

  if (decision.kind === KINDS.SHIFT_DOW) {
    // Cases move whole, so the receiving day takes their room-time and their
    // beds. The turnover each case brings with it is part of the room-time.
    const cases = num(decision.casesPerWeek);
    const turnoverHours = num(cfg.turnoverMinutes) / 60;
    const addedRoomHours = cases * (caseHours + turnoverHours);
    return {
      service, conversion, caseHours,
      addedRoomHours,
      addedAdmissions: cases * conversion,
      staffedRoomsDelta: 0,
      filledHours: addedRoomHours,
    };
  }

  // REALLOCATE — the receiving service fills what its pipeline can absorb.
  const s = baseline.surgeon || {};
  const movedHours = Math.min(num(decision.hours), num(s.allocatedHours));
  const pipelineLift = num(s.receivingPipelineVsBaselinePct);
  const coverage = Math.max(0, Math.min(1, 0.55 + pipelineLift / 200));
  const filledHours = movedHours * coverage;
  return {
    service, conversion, caseHours, movedHours, coverage,
    addedRoomHours: filledHours,
    addedAdmissions: admissionsFromRoomHours(filledHours, caseHours, conversion),
    staffedRoomsDelta: 0,
    filledHours,
  };
}


// ── Pillar 1 — Surgeon & Anesthesia Relationships ───────────────────────────
// Does this decision put the time where the demand is?
//
// The headline is true utilization, not block utilization, and the panel shows
// both. Competitors report the first; the gap between them is the argument.

function evaluateSurgeon(baseline, decision, effect, cfg) {
  const s = baseline.surgeon || {};
  const allocatedHours = num(s.allocatedHours);
  const blockUtil = num(s.blockUtilPct);
  const trueUtil  = num(s.trueUtilPct);
  const pipelineLift = num(s.receivingPipelineVsBaselinePct);

  // Only a reallocation changes whose time this is. A day-of-week shift moves
  // volume without changing any block's allocation, and flexing staffing does
  // not touch the schedule at all — reporting either as a utilization gain
  // would be inventing a benefit.
  if (decision.kind !== KINDS.REALLOCATE) {
    return {
      status: NEUTRAL,
      headline: { label: 'True utilization', before: round1(trueUtil), after: round1(trueUtil), unit: '%' },
      secondary: [
        { label: 'Block utilization', before: round1(blockUtil), after: round1(blockUtil), unit: '%' },
      ],
      drivers: [
        driver('unchangedAllocation', 'Allocation unchanged', 0,
          decision.kind === KINDS.FLEX_STAFFING
            ? 'Flexing staffing changes what is staffed, not who holds the time.'
            : 'Moving volume between days does not change any block\'s allocation.'),
      ],
    };
  }

  const movedHours = num(effect.movedHours);
  const coverage = num(effect.coverage);
  const filledHours = num(effect.filledHours);

  // The hours that stay with the original block keep performing as they have.
  const retainedHours = allocatedHours - movedHours;
  const retainedUsed = retainedHours * (trueUtil / 100);
  const afterUtil = pct(retainedUsed + filledHours, allocatedHours);

  const drivers = [
    driver('trueVsBlock', 'True vs block utilization', trueUtil - blockUtil,
      `${round1(trueUtil)}% true against ${round1(blockUtil)}% in-block — `
      + `${round1(trueUtil - blockUtil)} points of the practice's work already runs `
      + 'outside its own block.'),
    driver('receivingPipeline', 'Receiving-service pipeline', pipelineLift,
      `${s.receivingService || 'the receiving service'} is booking `
      + `${pipelineLift >= 0 ? '+' : ''}${round1(pipelineLift)}% against its trailing baseline.`),
    driver('pipelineCoverage', 'Pipeline coverage of moved hours', coverage * 100,
      `The pipeline can fill about ${round1(filledHours)} of the ${round1(movedHours)} `
      + `hours moved (${Math.round(coverage * 100)}%).`),
  ];
  if (s.strategicWeight != null) {
    drivers.push(driver('strategicWeight', 'Strategic goal weight', num(s.strategicWeight),
      `${s.receivingService || 'The receiving service'} carries a growth weight of `
      + `${num(s.strategicWeight)} in this tenant's goals.`));
  }

  return {
    status: statusFor(afterUtil - trueUtil, cfg.thresholds.utilPts),
    headline: { label: 'True utilization', before: round1(trueUtil), after: round1(afterUtil), unit: '%' },
    secondary: [
      { label: 'Block utilization', before: round1(blockUtil), after: round1(blockUtil), unit: '%' },
      { label: 'Hours reallocated', before: 0, after: round1(movedHours), unit: 'h' },
      { label: 'Hours the pipeline fills', before: 0, after: round1(filledHours), unit: 'h' },
    ],
    drivers,
  };
}

// ── Pillar 2 — Staffing & Operational Management ────────────────────────────
// Can we actually staff the room we just filled?
//
// The staffing plan is tenant configuration, not a fabricated FTE model: the
// room-hours are derivable from data, the rectangle they are compared against
// is not.

function evaluateStaffing(baseline, decision, effect, cfg) {
  const st = baseline.staffing || {};

  // The arithmetic lives in lib/staffingShape.js, which is also what the
  // Staffing page's ledger computes from. Same function, same numbers.
  const impact = coverageImpact(
    { ...st, staffedRoomsDelta: effect.staffedRoomsDelta },
    effect.addedRoomHours,
    num(cfg.packingCeiling || DEFAULT_CFG.packingCeiling));

  const roomsDelta = impact.staffedRoomsAfter - impact.staffedRooms;
  const overtimeDelta = impact.overtimeAfter - impact.overtimeBefore;
  const idleDelta = impact.idleAfter - impact.idleBefore;

  const drivers = [
    driver('concurrency', 'Concurrency headroom', impact.concurrencyHeadroomAfter,
      impact.concurrencyHeadroomAfter >= 1
        ? `${round1(impact.concurrencyHeadroomAfter)} of ${impact.staffedRoomsAfter} staffed `
          + 'rooms are still free at the peak.'
        : `The site peaks at ${round1(num(st.concurrencyPeak))} of ${impact.staffedRoomsAfter} `
          + 'staffed rooms — there is no room to open.'),
    driver('spill', 'Work past shift end', -impact.addedSpill,
      impact.addedSpill > 0
        ? `The day already draws ${round1(impact.requiredBefore)} of about `
          + `${round1(impact.ceilingBefore)} workable room-hours, so all `
          + `${round1(effect.addedRoomHours)} added hours run past shift end.`
        : `The day draws ${round1(impact.requiredAfter)} of about `
          + `${round1(impact.ceilingAfter)} workable room-hours after the move — `
          + 'the added work still fits inside the shift.'),
    driver('overtime', 'Overtime exposure', -overtimeDelta,
      `Overtime exposure goes from ${round1(impact.overtimeBefore)} to `
      + `${round1(impact.overtimeAfter)} room-hours on this day.`),
    driver('idle', 'Idle staffed hours', -idleDelta,
      `Idle staffed room-hours go from ${round1(impact.idleBefore)} to `
      + `${round1(impact.idleAfter)}.`),
  ];

  // Flexing down is the one way this pillar improves: it retires staffed hours
  // nobody was using. Otherwise headroom is only ever consumed.
  let status = NEUTRAL;
  if (impact.concurrencyHeadroomAfter < cfg.thresholds.coverageRooms
      || impact.addedSpill >= cfg.thresholds.overtimeHours) {
    status = DEGRADES;
  } else if (roomsDelta < 0 && idleDelta <= -cfg.thresholds.overtimeHours
             && impact.addedSpill <= 0) {
    status = IMPROVES;
  }

  return {
    status,
    headline: {
      label: 'Overtime exposure',
      before: round1(impact.overtimeBefore), after: round1(impact.overtimeAfter), unit: 'room-h',
    },
    secondary: [
      { label: 'Idle staffed hours', before: round1(impact.idleBefore), after: round1(impact.idleAfter), unit: 'h' },
      { label: 'Concurrency headroom', before: round1(impact.concurrencyHeadroomBefore),
        after: round1(impact.concurrencyHeadroomAfter), unit: 'rooms' },
      { label: 'Staffed rooms', before: impact.staffedRooms, after: impact.staffedRoomsAfter, unit: '' },
    ],
    drivers,
  };
}


// ── Pillar 3 — Physical Infrastructure & Capital Investment ─────────────────
// Where does this volume land after the case ends?
//
// The one panel no competitor in the category can show, because their OR and
// inpatient products are separate lines.

function evaluateCapacity(baseline, decision, effect, cfg) {
  const cap = baseline.capacity || {};
  const service = effect.service;
  const mix = (cap.serviceUnitMap || {})[service] || {};

  // The projection lives in lib/censusFootprint.js, which is also what the OR
  // Smoothing page's attribution cells and shift preview compute from. Same
  // function, same beds.
  const impact = projectUnitImpact(
    { units: cap.units, unitShares: mix, addedAdmissions: effect.addedAdmissions },
    cfg.thresholds.unitPressurePct);

  const tightest = impact.tightest;
  const drivers = [
    driver('conversion', 'Inpatient conversion', effect.conversion * 100,
      `${Math.round(effect.conversion * 100)}% of ${service} cases admit as inpatients.`),
    driver('admissions', 'Projected admissions added', effect.addedAdmissions,
      `About ${round1(effect.addedAdmissions)} additional admissions on this day each week.`),
  ];
  if (tightest) {
    drivers.push(driver('headroom', `Headroom on ${tightest.unit}`,
      tightest.headroomAfter - tightest.headroomBefore,
      `${tightest.unit} goes from ${tightest.headroomBefore} to ${tightest.headroomAfter} `
      + `beds spare (${tightest.occupancyAfterPct}% occupied).`));
  }
  if (impact.pressured.length) {
    drivers.push(driver('pressure', 'Units under pressure', -impact.pressured.length,
      `${impact.pressured.map(u => u.unit).join(', ')} would sit at or above `
      + `${cfg.thresholds.unitPressurePct}% occupancy.`));
  }

  // Taking admissions off a day relieves it; a shift that moves volume away is
  // the one decision this pillar can call an improvement.
  const relief = tightest ? tightest.headroomAfter - tightest.headroomBefore : 0;
  let status = NEUTRAL;
  if (impact.pressured.length
      || (tightest && tightest.headroomAfter < 0)
      || relief <= -cfg.thresholds.headroomBeds) {
    status = DEGRADES;
  } else if (relief >= cfg.thresholds.headroomBeds) {
    status = IMPROVES;
  }

  return {
    status,
    headline: {
      label: tightest ? `Headroom on ${tightest.unit}` : 'Unit headroom',
      before: tightest ? tightest.headroomBefore : null,
      after: tightest ? tightest.headroomAfter : null,
      unit: 'beds',
    },
    secondary: [
      { label: 'Admissions added', before: 0, after: round1(effect.addedAdmissions), unit: '/wk' },
      { label: 'Units under pressure', before: 0, after: impact.pressured.length, unit: '' },
    ],
    drivers,
    units: impact.units,
  };
}


// ── Conflicts ───────────────────────────────────────────────────────────────
// The point of the panel. One decision, three pillars, and the honest answer is
// often that they disagree.

function findConflicts(pillars, decision) {
  const improving = Object.entries(pillars).filter(([, p]) => p.status === IMPROVES).map(([k]) => k);
  const degrading = Object.entries(pillars).filter(([, p]) => p.status === DEGRADES).map(([k]) => k);
  if (!improving.length || !degrading.length) return [];

  const NAMES = { surgeon: 'utilization', staffing: 'staffing coverage', capacity: 'inpatient capacity' };
  return [{
    pillars: degrading,
    severity: degrading.length > 1 ? 'high' : 'medium',
    summary: `${improving.length} of ${Object.keys(pillars).length} pillars improves. `
           + `${degrading.map(k => NAMES[k]).join(' and ')} `
           + `${degrading.length > 1 ? 'both degrade' : 'degrades'}`
           + `${decision.dayOfWeekLabel ? ` on ${decision.dayOfWeekLabel}` : ''}.`,
  }];
}

// ── Entry point ─────────────────────────────────────────────────────────────

function evaluate(baseline, decision, cfg = DEFAULT_CFG) {
  const merged = {
    ...DEFAULT_CFG,
    ...cfg,
    thresholds: { ...DEFAULT_CFG.thresholds, ...(cfg.thresholds || {}) },
  };

  const effect = deriveEffect(baseline, decision, merged);
  const surgeon  = evaluateSurgeon(baseline, decision, effect, merged);
  const staffing = evaluateStaffing(baseline, decision, effect, merged);
  const capacity = evaluateCapacity(baseline, decision, effect, merged);

  const pillars = { surgeon, staffing, capacity };
  return {
    scenarioId: decision.scenarioId || null,
    decision,
    pillars,
    conflicts: findConflicts(pillars, decision),
    alternatives: [],
  };
}

module.exports = {
  evaluate,
  KINDS,
  DEFAULT_CFG,
  IMPROVES, NEUTRAL, DEGRADES,
  // exported for tests
  evaluateSurgeon, evaluateStaffing, evaluateCapacity, findConflicts, deriveEffect,
};

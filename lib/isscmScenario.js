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

const IMPROVES = 'improves';
const NEUTRAL  = 'neutral';
const DEGRADES = 'degrades';

// Thresholds belong in tenant config, not in code (§4). These are the fallbacks
// used when a tenant has not configured its own.
const DEFAULT_CFG = {
  thresholds: {
    // Pillar 1 — how many points of true utilisation count as a real move.
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

// ── Pillar 1 — Surgeon & Anesthesia Relationships ───────────────────────────
// Does this decision put the time where the demand is?
//
// The headline is true utilisation, not block utilisation, and the panel shows
// both. Competitors report the first; the gap between them is the argument.

function evaluateSurgeon(baseline, decision, cfg) {
  const s = baseline.surgeon || {};
  const allocatedHours = num(s.allocatedHours);
  const movedHours = Math.min(num(decision.hours), allocatedHours);

  const blockUtil = num(s.blockUtilPct);
  const trueUtil  = num(s.trueUtilPct);

  // What the receiving service can actually absorb. A pipeline running above its
  // own baseline can fill more than one running below it; coverage is capped at
  // 1 because a service cannot fill more hours than it was given.
  const pipelineLift = num(s.receivingPipelineVsBaselinePct);
  const coverage = Math.max(0, Math.min(1, 0.55 + pipelineLift / 200));
  const filledHours = movedHours * coverage;

  // The hours that stay with the original block keep performing as they have.
  const retainedHours = allocatedHours - movedHours;
  const retainedUsed = retainedHours * (trueUtil / 100);
  const afterUtil = pct(retainedUsed + filledHours, allocatedHours);

  const drivers = [
    driver('trueVsBlock', 'True vs block utilisation', trueUtil - blockUtil,
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
    _filledHours: filledHours,
  };
}

// ── Pillar 2 — Staffing & Operational Management ────────────────────────────
// Can we actually staff the room we just filled?
//
// The staffing plan is tenant configuration, not a fabricated FTE model: the
// room-hours are derivable from data, the rectangle they are compared against
// is not.

function evaluateStaffing(baseline, decision, filledHours, cfg) {
  const st = baseline.staffing || {};
  const staffedRooms = num(st.staffedRooms);
  const shiftHours = num(st.shiftHours);
  const staffedRoomHours = staffedRooms * shiftHours;

  // No OR packs its staffed hours perfectly: rooms turn over, cases finish
  // early, first cases start late. The practical ceiling is what new work has to
  // fit under, not the arithmetic total.
  const ceiling = staffedRoomHours * num(cfg.packingCeiling || DEFAULT_CFG.packingCeiling);

  const requiredBefore = num(st.requiredRoomHours);
  const requiredAfter = requiredBefore + filledHours;

  // A day already at its ceiling spills everything new past shift end.
  const spillBefore = Math.max(0, requiredBefore - ceiling);
  const spillAfter = Math.max(0, requiredAfter - ceiling);
  const addedSpill = spillAfter - spillBefore;

  const coverageRatio = num(st.coverageRatio) || 1;
  const overtimeBefore = (num(st.pastShiftRoomHours) + spillBefore) * coverageRatio;
  const overtimeAfter = (num(st.pastShiftRoomHours) + spillAfter) * coverageRatio;

  // The binding constraint is simultaneous staffed rooms, not the day's total:
  // a day can sit under its hour budget and still have nowhere to put a case at
  // ten in the morning.
  const peak = num(st.concurrencyPeak);
  const concurrencyHeadroom = staffedRooms - peak;

  const drivers = [
    driver('concurrency', 'Concurrency headroom', concurrencyHeadroom,
      concurrencyHeadroom >= 1
        ? `${round1(concurrencyHeadroom)} of ${staffedRooms} staffed rooms are still free at the peak.`
        : `The site already peaks at ${round1(peak)} of ${staffedRooms} staffed rooms — `
          + 'there is no room to open.'),
    driver('spill', 'Work past shift end', -addedSpill,
      addedSpill > 0
        ? `The day already draws ${round1(requiredBefore)} of about ${round1(ceiling)} `
          + `workable room-hours, so all ${round1(filledHours)} added hours run past shift end.`
        : `The day draws ${round1(requiredAfter)} of about ${round1(ceiling)} workable `
          + 'room-hours after the move — the added work still fits inside the shift.'),
    driver('overtime', 'Overtime exposure', -(overtimeAfter - overtimeBefore),
      `Overtime exposure goes from ${round1(overtimeBefore)} to ${round1(overtimeAfter)} `
      + 'room-hours on this day.'),
  ];

  // Headroom is consumed by a decision, never created by one, so this pillar's
  // best outcome is neutral. It degrades when the day cannot absorb the work.
  let status = NEUTRAL;
  if (addedSpill >= cfg.thresholds.overtimeHours
      || concurrencyHeadroom < cfg.thresholds.coverageRooms) {
    status = DEGRADES;
  }

  return {
    status,
    headline: {
      label: 'Overtime exposure',
      before: round1(overtimeBefore), after: round1(overtimeAfter), unit: 'room-h',
    },
    secondary: [
      { label: 'Concurrency headroom', before: round1(concurrencyHeadroom),
        after: round1(concurrencyHeadroom), unit: 'rooms' },
      { label: 'Required room-hours', before: round1(requiredBefore), after: round1(requiredAfter), unit: 'h' },
      { label: 'Workable room-hours', before: round1(ceiling), after: round1(ceiling), unit: 'h' },
    ],
    drivers,
  };
}


// ── Pillar 3 — Physical Infrastructure & Capital Investment ─────────────────
// Where does this volume land after the case ends?
//
// The one panel no competitor in the category can show, because their OR and
// inpatient products are separate lines.

function evaluateCapacity(baseline, decision, filledHours, cfg) {
  const cap = baseline.capacity || {};
  const service = decision.toService;
  const conversion = num((cap.inpatientConversionRate || {})[service]);
  const caseHours = num(cap.averageCaseHours) || 2.0;

  const addedCases = caseHours > 0 ? filledHours / caseHours : 0;
  const addedAdmissions = addedCases * conversion;

  // Admissions land on units in the receiving service's own mix. The census
  // compared against is the one on the day the block runs — the pressure the OR
  // schedule is deciding into. A full multi-day admission footprint (a Spine
  // stay is three days, so it presses on the days after too) is the more
  // physical model and belongs with Pillar 3's live implementation.
  const mix = (cap.serviceUnitMap || {})[service] || {};
  const units = (cap.units || []).map(u => {
    const share = num(mix[u.unit]) / 100;
    const added = addedAdmissions * share;
    const censusAfter = num(u.projectedCensus) + added;
    return {
      unit: u.unit,
      staffedBeds: num(u.staffedBeds),
      censusBefore: round1(num(u.projectedCensus)),
      censusAfter: round1(censusAfter),
      headroomBefore: round1(num(u.staffedBeds) - num(u.projectedCensus)),
      headroomAfter: round1(num(u.staffedBeds) - censusAfter),
      occupancyAfterPct: round1(pct(censusAfter, num(u.staffedBeds))),
      addedAdmissions: round1(added),
    };
  });

  const tightest = units.reduce(
    (worst, u) => (worst === null || u.headroomAfter < worst.headroomAfter ? u : worst), null);
  const headroomBefore = tightest ? tightest.headroomBefore : null;
  const headroomAfter = tightest ? tightest.headroomAfter : null;

  const pressured = units.filter(u => u.occupancyAfterPct >= cfg.thresholds.unitPressurePct);

  const drivers = [
    driver('conversion', 'Inpatient conversion', conversion * 100,
      `${Math.round(conversion * 100)}% of ${service} cases admit as inpatients.`),
    driver('admissions', 'Projected admissions added', addedAdmissions,
      `About ${round1(addedAdmissions)} additional admissions on this day each week.`),
  ];
  if (tightest) {
    drivers.push(driver('headroom', `Headroom on ${tightest.unit}`,
      tightest.headroomAfter - tightest.headroomBefore,
      `${tightest.unit} goes from ${tightest.headroomBefore} to ${tightest.headroomAfter} `
      + `beds spare (${tightest.occupancyAfterPct}% occupied).`));
  }
  if (pressured.length) {
    drivers.push(driver('pressure', 'Units under pressure', -pressured.length,
      `${pressured.map(u => u.unit).join(', ')} would sit at or above `
      + `${cfg.thresholds.unitPressurePct}% occupancy.`));
  }

  let status = NEUTRAL;
  if (pressured.length
      || (headroomAfter != null && headroomBefore - headroomAfter > cfg.thresholds.headroomBeds)
      || (headroomAfter != null && headroomAfter < 0)) {
    status = DEGRADES;
  }

  return {
    status,
    headline: {
      label: tightest ? `Headroom on ${tightest.unit}` : 'Unit headroom',
      before: headroomBefore, after: headroomAfter, unit: 'beds',
    },
    secondary: [
      { label: 'Admissions added', before: 0, after: round1(addedAdmissions), unit: '/wk' },
      { label: 'Units under pressure', before: 0, after: pressured.length, unit: '' },
    ],
    drivers,
    units,
  };
}

// ── Conflicts ───────────────────────────────────────────────────────────────
// The point of the panel. One decision, three pillars, and the honest answer is
// often that they disagree.

function findConflicts(pillars, decision) {
  const improving = Object.entries(pillars).filter(([, p]) => p.status === IMPROVES).map(([k]) => k);
  const degrading = Object.entries(pillars).filter(([, p]) => p.status === DEGRADES).map(([k]) => k);
  if (!improving.length || !degrading.length) return [];

  const NAMES = { surgeon: 'utilisation', staffing: 'staffing coverage', capacity: 'inpatient capacity' };
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

  const surgeon = evaluateSurgeon(baseline, decision, merged);
  const filledHours = surgeon._filledHours;
  delete surgeon._filledHours;

  const staffing = evaluateStaffing(baseline, decision, filledHours, merged);
  const capacity = evaluateCapacity(baseline, decision, filledHours, merged);

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
  DEFAULT_CFG,
  IMPROVES, NEUTRAL, DEGRADES,
  // exported for tests
  evaluateSurgeon, evaluateStaffing, evaluateCapacity, findConflicts,
};

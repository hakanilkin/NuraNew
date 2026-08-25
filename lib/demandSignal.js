// lib/demandSignal.js
//
// Turning a volume forecast into a staffing implication.
//
// The chain this serves is Forecast -> Demand Signal -> Staffing Implication ->
// Recommended Action, and it has to read in one row: a director asking "is next
// Tuesday staffed for what's coming" should not have to join two pages to find
// out. See VolumeOutlook.md.
//
// Two rules this file exists to hold:
//
//   * The room requirement is lib/staffingShape.js's, not a second opinion.
//     Staffing Patterns, this page and the ScenarioPanel's Pillar 2 all call the
//     same functions, so a room-hour is the same room-hour everywhere.
//   * Signal tier is a data field, never a copy choice. RECOMMENDED means the
//     arithmetic is shown; POTENTIAL means we noticed a pattern and are not
//     pretending to quantify it. PACU, pre-op and ancillary are always
//     POTENTIAL, because we hold no data on how those are staffed.
//
// Pure: no I/O, no DB handle. Callers supply the forecast, the mix and the plan.

const { impliedRooms, recommendedRooms, flexFlag, hhmmToMinutes } = require('./staffingShape');

const POTENTIAL = 'POTENTIAL';
const RECOMMENDED = 'RECOMMENDED';

const DEFAULT_THRESHOLDS = {
  onPlanPct: 5,        // within this of budget is "on plan", not a hairline
  exceptionPct: 15,
  minCases: 4,         // the absolute floor: 3 -> 4 cases is not a +33% story
};

const num = x => (Number.isFinite(Number(x)) ? Number(x) : 0);
const round1 = x => (x == null ? null : Math.round(x * 10) / 10);

/** Forecast against budget, in both the units a director uses. */
function variance(forecast, budget) {
  const f = num(forecast);
  const b = num(budget);
  return {
    forecast: round1(f),
    budget: round1(b),
    variance: round1(f - b),
    variancePct: b > 0 ? round1(((f - b) / b) * 100) : null,
  };
}

/**
 * Both conditions, or it is not an exception. Percentage alone fills the list
 * with noise from low-volume days; case count alone misses a big miss on a
 * big day.
 */
function isException(v, thresholds = DEFAULT_THRESHOLDS) {
  const pct = v.variancePct;
  if (pct == null) return false;
  return Math.abs(pct) >= num(thresholds.exceptionPct)
      && Math.abs(num(v.variance)) >= num(thresholds.minCases);
}

function isOnPlan(v, thresholds = DEFAULT_THRESHOLDS) {
  return v.variancePct != null && Math.abs(v.variancePct) <= num(thresholds.onPlanPct);
}

/**
 * Which service lines moved the day, largest absolute contribution first.
 * Runners-up are kept when they are within reach of the leader, so a day driven
 * by two services does not read as driven by one.
 */
function primaryDrivers(serviceDeltas, { max = 3, reachPct = 40 } = {}) {
  const sorted = (serviceDeltas || [])
    .map(d => ({ service: d.service, delta: round1(num(d.delta)) }))
    .filter(d => d.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  if (!sorted.length) return [];
  const lead = Math.abs(sorted[0].delta);
  return sorted
    .filter((d, i) => i === 0 || Math.abs(d.delta) >= lead * (reachPct / 100))
    .slice(0, max)
    .map(d => ({
      key: d.service,
      label: d.service,
      contribution: d.delta,
      detail: `${d.delta > 0 ? '+' : ''}${d.delta} ${d.service}`,
    }));
}

/**
 * Average case minutes including turnover, weighted by the forecast's own case
 * mix. A joints-heavy day has less case capacity than a cataract-heavy one, and
 * ignoring that makes the gap wrong in exactly the situations it matters.
 */
function mixWeightedCaseMinutes(mix, durationsByService, turnoverMinutes = 0) {
  const rows = (mix || []).filter(m => num(m.forecast) > 0);
  const total = rows.reduce((s, m) => s + num(m.forecast), 0);
  if (!total) return null;
  let weighted = 0;
  for (const m of rows) {
    const mins = num((durationsByService || {})[m.service]);
    if (!mins) return null;                 // an unknown service makes the whole
    weighted += (num(m.forecast) / total) * mins;   // average a guess, not an estimate
  }
  return round1(weighted + num(turnoverMinutes));
}

/**
 * How many cases the staffing plan supports. Stated openly and computed in one
 * place, because a staffing gap whose derivation is hidden is a number nobody
 * will act on — or defend to their CFO.
 */
function caseCapacity({ staffedRooms, shiftStart, shiftEnd, shiftMinutes }, avgCaseMinutesInclTurnover) {
  const mins = shiftMinutes != null
    ? num(shiftMinutes)
    : hhmmToMinutes(shiftEnd) - hhmmToMinutes(shiftStart);
  const per = num(avgCaseMinutesInclTurnover);
  if (!per || mins <= 0 || !num(staffedRooms)) return null;
  return {
    cases: round1((num(staffedRooms) * mins) / per),
    staffedRooms: num(staffedRooms),
    shiftMinutes: mins,
    avgCaseMinutesInclTurnover: round1(per),
    // The sentence the UI shows on hover, in the same words as the arithmetic.
    assumption: `${num(staffedRooms)} staffed rooms x ${mins} shift minutes `
              + `/ ${round1(per)} min per case including turnover`,
  };
}

const ALWAYS_POTENTIAL = [
  'reviewing OR staffing against the expected case mix',
  'increasing PACU coverage',
  'confirming pre-op staffing',
  'reviewing ancillary coverage',
];

/**
 * The whole implication for one day, as one object: what is coming, what is
 * driving it, what it means for rooms, and what tier of claim that is.
 *
 * Templated from the numbers — never generated prose. Generic commentary adds
 * nothing and cannot be audited, and every figure here is the same one the
 * tables render.
 */
function buildSignal({ date, site, v, drivers, plan, mix, durationsByService,
                       bookedMinutes, turnoverMinutes = 0 }) {
  const over = num(v.variance) > 0;
  const driverText = drivers.length
    ? drivers.map(d => d.detail).join(' and ')
    : 'no single service line';

  const avgCaseMins = mixWeightedCaseMinutes(mix, durationsByService, turnoverMinutes);
  const capacity = plan ? caseCapacity(plan, avgCaseMins) : null;

  // The room requirement is staffingShape's, so this row and the flex plan and
  // Pillar 2 cannot disagree.
  const implied = plan && bookedMinutes != null ? impliedRooms(bookedMinutes, plan) : null;
  const recommended = plan && implied != null
    ? recommendedRooms(implied, plan.staffedRooms) : null;
  const flag = plan && implied != null ? flexFlag(plan.staffedRooms, implied) : null;

  const roomGap = flag && recommended != null ? recommended - num(plan.staffedRooms) : null;
  const caseGap = capacity ? round1(num(v.forecast) - capacity.cases) : null;

  // RECOMMENDED only where a plan exists and the arithmetic produced a change.
  const tier = (flag && roomGap) ? RECOMMENDED : POTENTIAL;

  // When the arithmetic produced a room change, the headline follows it. Case
  // count and room-time can genuinely diverge — many short cases are a busy day
  // that needs no extra room — and a row that says "higher staffing need" above
  // "flex two down" is not informative, it is incoherent.
  const headline = tier === RECOMMENDED
    ? (roomGap < 0 ? 'Flex-down opportunity' : 'Higher staffing need likely')
    : (over ? 'Higher staffing need likely' : 'Lighter than planned');

  const summary = v.variancePct == null
    ? `Forecast ${v.forecast} cases; no budget on record for this day.`
    // The figure keeps its precision on the object; the sentence rounds, the
    // same way every other percentage in the product renders.
    : `Forecast volume is ${Math.round(Math.abs(v.variancePct))}% ${over ? 'above' : 'below'} budget, `
      + `driven primarily by ${driverText}.`;

  // Never blank: a blank column reads as "no staffing impact", which is a
  // different claim from "we cannot quantify it".
  let implication;
  if (tier === RECOMMENDED) {
    implication = roomGap < 0
      ? `Staffs ${plan.staffedRooms} rooms, needs ${implied} — flex ${Math.abs(roomGap)} down`
      : `Staffs ${plan.staffedRooms} rooms, needs ${implied} — flex ${roomGap} up`;
  } else if (capacity) {
    implication = `Plan supports about ${capacity.cases} cases`
      + (caseGap != null && Math.abs(caseGap) >= 1
        ? `; forecast is ${caseGap > 0 ? caseGap + ' over' : Math.abs(caseGap) + ' under'} that`
        : '');
  } else {
    implication = 'Review coverage against the expected case mix';
  }

  return {
    date, site,
    ...v,
    drivers,
    tier,
    headline,
    summary,
    implication,
    considerations: ALWAYS_POTENTIAL,
    plannedRooms: plan ? num(plan.staffedRooms) : null,
    impliedRooms: implied,
    recommendedRooms: recommended,
    roomGap,
    flexFlag: flag,
    capacityCases: capacity ? capacity.cases : null,
    caseGap,
    capacityAssumption: capacity ? capacity.assumption : null,
  };
}

module.exports = {
  POTENTIAL, RECOMMENDED, DEFAULT_THRESHOLDS, ALWAYS_POTENTIAL,
  variance, isException, isOnPlan, primaryDrivers,
  mixWeightedCaseMinutes, caseCapacity, buildSignal,
};

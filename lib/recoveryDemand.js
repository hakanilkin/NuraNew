// lib/recoveryDemand.js
//
// Turning a volume forecast into PACU and pre-op bay demand.
//
// This is the part nobody else computes. Epic's staffing analysis stops at
// nursing and anaesthesia; Qventus does pre-op patients rather than pre-op
// staffing. A case does not end when the room turns over — it occupies a phase I
// bay, then a phase II bay, and those bays are a finite resource with their own
// peak, hours after the OR peak that caused it.
//
// Always POTENTIAL. We model bay *demand* from case mix and timing; we do not
// model nurse ratios, and the output must never be dressed as if we did.
//
// Pure: no I/O, no DB handle. Callers supply the day's cases and the profiles.

const PHASE1 = 'PACU';
const PHASE2 = 'PHASE2';

const num = x => (Number.isFinite(Number(x)) ? Number(x) : 0);
const round1 = x => (x == null ? null : Math.round(x * 10) / 10);

const DEFAULT_SLOT_MINUTES = 30;

/**
 * Occupancy intervals a single case creates.
 *
 * Pre-op runs before the room; phase I begins at OR-out; phase II follows it.
 * A service configured PHASE2-only skips phase I — cataracts and most ENT go
 * straight to a recliner — and one configured PACU-only has no phase II bay.
 */
function intervalsForCase({ orInMinutes, orOutMinutes, service }, profiles) {
  const p = (profiles || {})[service];
  if (!p) return [];
  const out = [];
  const preOp = num(p.preOpMins);
  if (preOp > 0 && orInMinutes != null) {
    out.push({ kind: 'PREOP', start: num(orInMinutes) - preOp, end: num(orInMinutes) });
  }
  let cursor = num(orOutMinutes);
  const bay = p.bayType || 'BOTH';
  if (bay !== PHASE2 && num(p.phase1Mins) > 0) {
    out.push({ kind: PHASE1, start: cursor, end: cursor + num(p.phase1Mins) });
    cursor += num(p.phase1Mins);
  }
  if (bay !== PHASE1 && num(p.phase2Mins) > 0) {
    out.push({ kind: PHASE2, start: cursor, end: cursor + num(p.phase2Mins) });
  }
  return out;
}

/**
 * Concurrent bay occupancy by slot across a day, per bay kind.
 *
 * `cases` are one day's, with minute-of-day OR in/out times.
 */
function occupancyByHour(cases, profiles, {
  slotMinutes = DEFAULT_SLOT_MINUTES, fromMinute = 5 * 60, toMinute = 23 * 60,
} = {}) {
  const intervals = [];
  for (const c of cases || []) intervals.push(...intervalsForCase(c, profiles));

  const slots = [];
  for (let t = fromMinute; t < toMinute; t += slotMinutes) {
    const at = kind => intervals.filter(
      i => i.kind === kind && i.start < t + slotMinutes && i.end > t).length;
    slots.push({
      minuteOfDay: t,
      label: `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`,
      preop: at('PREOP'),
      pacu: at(PHASE1),
      phase2: at(PHASE2),
    });
  }
  return slots;
}

/** Where a curve peaks, and for how long it stays over a line. */
function peakOf(slots, key, staffed) {
  let peak = { bays: 0, minuteOfDay: null, label: null };
  for (const s of slots) {
    if (num(s[key]) > peak.bays) peak = { bays: num(s[key]), minuteOfDay: s.minuteOfDay, label: s.label };
  }
  const over = slots.filter(s => staffed != null && num(s[key]) > num(staffed));
  return {
    ...peak,
    staffed: staffed == null ? null : num(staffed),
    overBy: staffed == null ? null : Math.max(0, peak.bays - num(staffed)),
    overFrom: over.length ? over[0].label : null,
    overTo: over.length ? over[over.length - 1].label : null,
    minutesOver: over.length * DEFAULT_SLOT_MINUTES,
  };
}

/**
 * A day's recovery demand: the curves, their peaks, and a plain sentence when a
 * peak exceeds what is staffed.
 *
 * The sentence is templated from the numbers — the same ones the curve draws.
 */
function dayDemand({ date, site, cases, profiles, bays }, opts = {}) {
  const slots = occupancyByHour(cases, profiles, opts);
  const pacu = peakOf(slots, 'pacu', bays?.pacu);
  const phase2 = peakOf(slots, 'phase2', bays?.phase2);
  const preop = peakOf(slots, 'preop', bays?.preop);

  const flagged = [
    ['PACU', pacu], ['Phase II', phase2], ['Pre-op', preop],
  ].filter(([, p]) => p.overBy > 0);

  const implication = flagged.length
    ? flagged.map(([name, p]) =>
        `${name} demand peaks at ${p.bays} bays against ${p.staffed} staffed`
        + (p.overFrom ? ` (${p.overFrom}–${p.overTo})` : '')).join('; ')
    : null;

  return {
    date, site, byHour: slots,
    pacu, phase2, preop,
    // Bay demand, not nurse ratios. The tier says so, and it is a field rather
    // than a turn of phrase so it cannot drift.
    tier: 'POTENTIAL',
    flagged: flagged.length > 0,
    implication,
  };
}

/** Total bay-hours a day draws, for a compact summary figure. */
function bayHours(slots, key, slotMinutes = DEFAULT_SLOT_MINUTES) {
  return round1(slots.reduce((s, x) => s + num(x[key]), 0) * (slotMinutes / 60));
}

module.exports = {
  PHASE1, PHASE2, DEFAULT_SLOT_MINUTES,
  intervalsForCase, occupancyByHour, peakOf, dayDemand, bayHours,
};

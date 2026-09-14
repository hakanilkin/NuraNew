// lib/censusFootprint.js
//
// The bed-shadow an elective schedule casts.
//
// Every elective case is a bed decision days in advance: cases x inpatient
// conversion x length-of-stay spread x unit share = occupied beds, days after
// surgery. Block templates were designed around surgeon preference; nobody
// designed the census they produce. This module computes that census so it can
// be shown, argued with, and changed.
//
// Shared, and that is a hard requirement of ORSmoothing.md §2 and
// ISSCMIntegrationView.md: the Smoothing page's attribution cells and the ISSCM
// engine's Pillar 3 unit-pressure numbers must come from the same function. A
// page that disagrees with the panel judging its own recommendation is worse
// than either alone.
//
// Pure: no I/O, no DB handle. Callers supply volumes, rates and curves.

const num = x => (Number.isFinite(Number(x)) ? Number(x) : 0);
const round1 = x => (x == null ? null : Math.round(x * 10) / 10);

const DEFAULT_HORIZON_DAYS = 7;
const DEFAULT_CRUNCH_PCT = 92;

/**
 * Normalize an empirical LOS distribution into a survival curve: the share of
 * admissions still occupying a bed on each day after surgery.
 *
 * `losDays` is [{ days, share }] — the empirical distribution by service, not a
 * parametric model. A patient with a 3-day stay occupies a bed on offsets 0,1,2.
 */
function survivalCurve(losDays, horizonDays = DEFAULT_HORIZON_DAYS) {
  const total = losDays.reduce((s, d) => s + num(d.share), 0);
  const out = [];
  for (let offset = 0; offset <= horizonDays; offset++) {
    let still = 0;
    for (const d of losDays) {
      // A stay of L days covers offsets 0..L-1; a partial day counts pro rata.
      const remaining = num(d.days) - offset;
      if (remaining >= 1) still += num(d.share);
      else if (remaining > 0) still += num(d.share) * remaining;
    }
    out.push(total > 0 ? still / total : 0);
  }
  return out;
}

/**
 * The bed-shadow of one service's weekly volume: expected occupied beds by day
 * offset, by receiving unit. This is V1's teaching moment — "a Tuesday Ortho A
 * block is still holding N beds on Friday".
 */
function bedShadow({ weeklyCases, conversionRate, losDays, unitShares },
                   horizonDays = DEFAULT_HORIZON_DAYS) {
  const admissions = num(weeklyCases) * num(conversionRate);
  const curve = survivalCurve(losDays || [], horizonDays);
  const units = Object.entries(unitShares || {}).map(([unit, sharePct]) => ({
    unit,
    sharePct: num(sharePct),
    byOffset: curve.map((alive, d) => ({
      d,
      beds: round1(admissions * (num(sharePct) / 100) * alive),
    })),
  }));
  return {
    weeklyCases: round1(num(weeklyCases)),
    conversionPct: round1(num(conversionRate) * 100),
    admissionsPerWeek: round1(admissions),
    units: units.sort((a, b) => b.sharePct - a.sharePct),
  };
}

/**
 * Decompose a unit-day's census into what the surgical schedule chose and what
 * simply arrived. The controllable share is the argument the page exists to
 * make; it is traced from admissions back to cases, never stored.
 */
function attributeCensus({ census, orAdmitted, edAdmitted, capacity },
                         crunchPct = DEFAULT_CRUNCH_PCT) {
  const total = num(census);
  const or = Math.min(total, num(orAdmitted));
  const ed = Math.min(total - or, num(edAdmitted));
  const other = Math.max(0, total - or - ed);
  const cap = num(capacity);
  const occupancyPct = cap > 0 ? (total / cap) * 100 : null;
  return {
    census: round1(total),
    capacity: cap,
    or: round1(or),
    ed: round1(ed),
    other: round1(other),
    orPct: total > 0 ? round1((or / total) * 100) : null,
    occupancyPct: round1(occupancyPct),
    crunch: occupancyPct != null && occupancyPct >= crunchPct,
  };
}

/** Crunch unit-days across a grid of attributed cells. */
function crunchUnitDays(cells) {
  return cells.filter(c => c.crunch).length;
}

/**
 * What a decision does to unit census. Pillar 3 judges with this, and the
 * Smoothing page previews with it, so the panel and the page cannot disagree
 * about the same move.
 *
 * `addedAdmissions` is signed: a shift removes admissions from one day and adds
 * them to another, so the same function serves both halves.
 */
function projectUnitImpact({ units, unitShares, addedAdmissions },
                           crunchPct = DEFAULT_CRUNCH_PCT) {
  const rows = (units || []).map(u => {
    const share = num((unitShares || {})[u.unit]) / 100;
    const added = num(addedAdmissions) * share;
    const before = num(u.projectedCensus);
    const after = before + added;
    const beds = num(u.staffedBeds);
    return {
      unit: u.unit,
      staffedBeds: beds,
      censusBefore: round1(before),
      censusAfter: round1(after),
      headroomBefore: round1(beds - before),
      headroomAfter: round1(beds - after),
      occupancyBeforePct: beds > 0 ? round1((before / beds) * 100) : null,
      occupancyAfterPct: beds > 0 ? round1((after / beds) * 100) : null,
      addedAdmissions: round1(added),
    };
  });
  const tightest = rows.reduce(
    (worst, r) => (worst === null || r.headroomAfter < worst.headroomAfter ? r : worst), null);
  return {
    units: rows,
    tightest,
    pressured: rows.filter(r => r.occupancyAfterPct != null && r.occupancyAfterPct >= crunchPct),
  };
}

/**
 * Convert room-hours of case time into admissions, via average case length and
 * the service's inpatient conversion rate. The one place that conversion
 * happens, so Pillar 3 and the Smoothing preview agree on what "four hours of
 * Spine" means in beds.
 */
function admissionsFromRoomHours(roomHours, averageCaseHours, conversionRate) {
  const hours = num(averageCaseHours);
  if (hours <= 0) return 0;
  return (num(roomHours) / hours) * num(conversionRate);
}

/**
 * Before/after census for a day-of-week shift: n cases per week move off
 * `fromDow` and onto `toDow`. Returns one entry per affected unit-day so the
 * page can redraw both curves.
 */
function shiftPreview({ grid, unitShares, conversionRate, casesPerWeek,
                        fromDow, toDow, losDays },
                      crunchPct = DEFAULT_CRUNCH_PCT) {
  const admissions = num(casesPerWeek) * num(conversionRate);
  const curve = survivalCurve(losDays || [], 6);

  // An admission on day D presses on D, D+1, ... for as long as it stays.
  const delta = new Map();               // `${unit}|${dow}` -> beds moved
  for (const [unit, sharePct] of Object.entries(unitShares || {})) {
    const beds = admissions * (num(sharePct) / 100);
    curve.forEach((alive, offset) => {
      const off = (d) => `${unit}|${(d + offset) % 7}`;
      delta.set(off(fromDow), num(delta.get(off(fromDow))) - beds * alive);
      delta.set(off(toDow), num(delta.get(off(toDow))) + beds * alive);
    });
  }

  const cells = (grid || []).map(cell => {
    const moved = num(delta.get(`${cell.unit}|${cell.dow}`));
    const after = num(cell.census) + moved;
    const cap = num(cell.capacity);
    const occAfter = cap > 0 ? (after / cap) * 100 : null;
    return {
      unit: cell.unit, dow: cell.dow, capacity: cap,
      censusBefore: round1(num(cell.census)),
      censusAfter: round1(after),
      delta: round1(moved),
      crunchBefore: cap > 0 && (num(cell.census) / cap) * 100 >= crunchPct,
      crunchAfter: occAfter != null && occAfter >= crunchPct,
    };
  });

  return {
    cells,
    crunchBefore: cells.filter(c => c.crunchBefore).length,
    crunchAfter: cells.filter(c => c.crunchAfter).length,
    peakBefore: cells.reduce((m, c) => Math.max(m, c.censusBefore), 0),
    peakAfter: cells.reduce((m, c) => Math.max(m, c.censusAfter), 0),
  };
}

module.exports = {
  survivalCurve, bedShadow, attributeCensus, crunchUnitDays,
  projectUnitImpact, admissionsFromRoomHours, shiftPreview,
  DEFAULT_CRUNCH_PCT, DEFAULT_HORIZON_DAYS,
};

// lib/rtdcMismatch.js
//
// Capacity vs demand per unit — RTDC.md §3.2 (Available / Effective /
// Predicted Y / Demand / Status) and §7.2 (the Mismatch Heatmap). The Board
// and the heatmap both call unitStatus(), so a heatmap cell can never disagree
// with what the room saw for that unit-day.

const T = require('./rtdcTime');

const n = v => (Number.isFinite(Number(v)) ? Number(v) : 0);

function parseJson(v, fallback) {
  if (v == null) return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}

// unitSnap: one §2.2 row. predictedY: count of Y on the unit at S2.
// dayEntry: the Nura-entered effective-beds row for the unit-day, if any.
function unitStatus(unitSnap, predictedY, dayEntry) {
  const staffed = n(unitSnap.STAFFED_BEDS), occupied = n(unitSnap.OCCUPIED_BEDS), blocked = n(unitSnap.BLOCKED_BEDS);
  const available = staffed - occupied - blocked;
  const hasEntry = dayEntry && Number.isFinite(Number(dayEntry.effective_beds));
  const effective = hasEntry ? Number(dayEntry.effective_beds) : available;

  const bedReqs = parseJson(unitSnap.PENDING_BED_REQUESTS_IN, []);
  const bedRequests = Array.isArray(bedReqs) ? bedReqs.length : n(bedReqs);
  const orExpected = n(unitSnap.OR_EXPECTED_ADMITS_BY_2PM);
  const downgradeRequests = n(unitSnap.DOWNGRADE_REQUESTS_IN);
  const edLikely = n(unitSnap.ED_LIKELY_ADMITS);
  const procedural = n(unitSnap.PROCEDURAL_EXPECTED);
  const downgradesAnticipated = n(unitSnap.DOWNGRADES_ANTICIPATED);
  const edForecast = Math.round(n(unitSnap.ED_FORECAST_8_14));

  const firstPass = bedRequests + orExpected + downgradeRequests;
  const secondPass = edLikely + procedural + downgradesAnticipated + edForecast;
  const capacity = effective + n(predictedY);
  const demand = firstPass + secondPass;
  const status = capacity - demand;

  return {
    unit: unitSnap.UNIT, hospital: unitSnap.HOSPITAL || null,
    staffed, occupied, blocked, available, effective,
    adjusted: hasEntry && effective !== available,
    adjustment: hasEntry ? effective - available : 0,
    adjustmentReason: hasEntry ? dayEntry.adjustment_reason || null : null,
    adjustmentNote: hasEntry ? dayEntry.note || null : null,
    adjustedBy: hasEntry ? dayEntry.adjusted_by || null : null,
    adjustedAt: hasEntry ? dayEntry.adjusted_at || null : null,
    predictedY: n(predictedY),
    firstPass, secondPass, capacity, demand, status,
    color: status < 0 ? 'red' : status === 0 ? 'even' : 'green',
    sources: {
      bedRequests, orExpected, downgradeRequests, edLikely, procedural, downgradesAnticipated, edForecast,
    },
    bedRequestDetail: Array.isArray(bedReqs) ? bedReqs : [],
  };
}

function houseTotal(rows) {
  const sum = k => rows.reduce((s, r) => s + n(r[k]), 0);
  const status = sum('capacity') - sum('demand');
  return {
    unit: 'House', staffed: sum('staffed'), occupied: sum('occupied'), blocked: sum('blocked'),
    available: sum('available'), effective: sum('effective'), predictedY: sum('predictedY'),
    firstPass: sum('firstPass'), secondPass: sum('secondPass'), capacity: sum('capacity'),
    demand: sum('demand'), status, color: status < 0 ? 'red' : status === 0 ? 'even' : 'green',
    sources: {
      bedRequests: rows.reduce((s, r) => s + r.sources.bedRequests, 0),
      orExpected: rows.reduce((s, r) => s + r.sources.orExpected, 0),
      downgradeRequests: rows.reduce((s, r) => s + r.sources.downgradeRequests, 0),
      edLikely: rows.reduce((s, r) => s + r.sources.edLikely, 0),
      procedural: rows.reduce((s, r) => s + r.sources.procedural, 0),
      downgradesAnticipated: rows.reduce((s, r) => s + r.sources.downgradesAnticipated, 0),
      edForecast: rows.reduce((s, r) => s + r.sources.edForecast, 0),
    },
  };
}

// cells: [{ unit, date, status, adjusted }] — one per unit-day with an S2.
// units: display order. Returns the day matrix, the weekday view and the
// per-unit margin figures (% red · mean gap on red days · current red streak).
function heatmap(cells, units, { from, to } = {}) {
  const dates = from && to ? T.eachDay(from, to) : [...new Set(cells.map(c => c.date))].sort();
  const byKey = new Map(cells.map(c => [`${c.date}|${c.unit}`, c]));
  const rows = units.map(unit => {
    const days = dates.map(d => byKey.get(`${d}|${unit}`) || null);
    const present = days.filter(Boolean);
    const red = present.filter(c => c.status < 0);
    let streak = 0;
    for (let i = days.length - 1; i >= 0; i--) {
      const c = days[i];
      if (!c) { if (streak === 0) continue; break; }
      if (c.status < 0) streak += 1; else break;
    }
    const weekday = [1, 2, 3, 4, 5, 6, 0].map(w => {
      const vals = present.filter(c => T.dow(c.date) === w).map(c => c.status);
      return { dow: w, mean: vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null, n: vals.length };
    });
    return {
      unit,
      days: days.map((c, i) => (c ? { date: dates[i], status: c.status, adjusted: !!c.adjusted } : { date: dates[i], status: null })),
      pctRed: present.length ? Math.round((red.length / present.length) * 100) : null,
      meanGapRed: red.length ? Math.round((red.reduce((s, c) => s + c.status, 0) / red.length) * 10) / 10 : null,
      streak,
      weekday,
      daysWithData: present.length,
    };
  });
  // Hospital total: sum of statuses across units with data that day.
  const total = dates.map(d => {
    const vals = units.map(u => byKey.get(`${d}|${u}`)).filter(Boolean);
    return { date: d, status: vals.length ? vals.reduce((s, c) => s + c.status, 0) : null };
  });
  const totalWeekday = [1, 2, 3, 4, 5, 6, 0].map(w => {
    const vals = total.filter(t => t.status != null && T.dow(t.date) === w).map(t => t.status);
    return { dow: w, mean: vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null, n: vals.length };
  });
  return { dates, rows, total: { days: total, weekday: totalWeekday } };
}

module.exports = { unitStatus, houseTotal, heatmap, parseJson };

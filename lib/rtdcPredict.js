// lib/rtdcPredict.js
//
// The prediction and the outcome — RTDC.md §3.1 and §3.2.
//
// PRED_2PM is never stored by Epic as such. It is derived from whichever
// source the tenant uses (a dedicated flag, EDD date + time, or EDD date
// alone), and every accuracy figure carries the mode it was derived under so
// sites are never compared across modes.

const T = require('./rtdcTime');

const MODES = ['FLAG', 'EDD_TIME', 'EDD_DATE'];

function normFlag(v) {
  if (v == null) return null;
  const s = String(v).trim().toUpperCase();
  if (['Y', 'YES', 'TRUE', '1'].includes(s)) return 'Y';
  if (['N', 'NO', 'FALSE', '0'].includes(s)) return 'N';
  return null;
}

// Returns { pred: 'Y' | 'N' | null, mode }.
function derivePrediction(row, settings, today) {
  const mode = MODES.includes(settings.pred_source) ? settings.pred_source : 'EDD_DATE';
  const horizon = Number.isFinite(settings.list_horizon_days) ? settings.list_horizon_days : 1;
  const cutoff = settings.cutoff || '14:00';

  // Not bedded on an inpatient unit, or the site said "unknown": not on the list.
  if (!row.UNIT || row.PRED_UNKNOWN) return { pred: null, mode };

  const eddDate = row.PRED_SOURCE_DATE ? String(row.PRED_SOURCE_DATE).slice(0, 10) : null;
  const eddTime = row.PRED_SOURCE_TIME ? String(row.PRED_SOURCE_TIME).slice(0, 5) : null;
  const withinHorizon = eddDate && eddDate <= T.addDays(today, horizon);

  if (mode === 'FLAG') {
    return { pred: normFlag(row.PRED_FLAG_RAW), mode };
  }
  if (mode === 'EDD_TIME') {
    if (eddDate === today) {
      // A date-only entry on an EDD_TIME site reads as the EDD_DATE baseline
      // would: today means Y.
      if (!eddTime) return { pred: 'Y', mode };
      return { pred: eddTime <= cutoff ? 'Y' : 'N', mode };
    }
    return { pred: withinHorizon ? 'N' : null, mode };
  }
  // EDD_DATE
  if (eddDate === today) return { pred: 'Y', mode };
  return { pred: withinHorizon ? 'N' : null, mode };
}

// Outcome at S3 (RTDC.md §3.2). `dischargedAt` is the ADT departure; only
// departures on `date` count, and "by 2 PM" is the cutoff.
//   MET:         Y and departed ≤ cutoff
//   MISSED:      Y and not
//   UNEXPECTED:  N and departed ≤ cutoff
//   NOT_ON_LIST: null and departed ≤ cutoff
// Everything else (an N that stayed, a null that stayed) has no outcome.
function classifyOutcome(pred, dischargedAt, date, cutoff = '14:00') {
  const s = T.split(dischargedAt);
  const dischargedToday = !!s && s.date === date;
  const by14 = dischargedToday && s.time <= cutoff;
  let outcome = null;
  if (pred === 'Y') outcome = by14 ? 'MET' : 'MISSED';
  else if (by14) outcome = pred === 'N' ? 'UNEXPECTED' : 'NOT_ON_LIST';
  return { outcome, dischargedToday, by14, dischargedTime: s ? s.time : null };
}

// MET ÷ (MET + MISSED). Null when there were no Ys.
function accuracy(outcomes) {
  const c = { MET: 0, MISSED: 0, UNEXPECTED: 0, NOT_ON_LIST: 0 };
  for (const o of outcomes) if (o && c[o] != null) c[o] += 1;
  const ys = c.MET + c.MISSED;
  return { ...c, ys, accuracyPct: ys ? Math.round((c.MET / ys) * 1000) / 10 : null };
}

module.exports = { MODES, derivePrediction, classifyOutcome, accuracy, normFlag };

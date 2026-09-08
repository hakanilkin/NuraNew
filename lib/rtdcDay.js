// lib/rtdcDay.js
//
// Assembles one huddle day from a snapshot: prediction per patient, the
// rule table on every N, unit statuses with the Nura-entered effective beds,
// and — once the day is scorable — outcomes. Every route reads through here,
// so the Board, the Ns view, the heatmap and the scoreboard cannot disagree
// about a unit-day.

const T = require('./rtdcTime');
const P = require('./rtdcPredict');
const R = require('./rtdcRules');
const M = require('./rtdcMismatch');
const Y = require('./moveToYes');
const O = require('./rtdcOutcome');
const source = require('./rtdcSource');
const store = require('./rtdcStore');
const { getRtdcSettings, huddleSort } = require('./rtdcSettings');

// ── Context ────────────────────────────────────────────────────────────────

function makeContext(req, deps, { now } = {}) {
  const tenantId = req.session.tenantId;
  const tenantName = req.tenantName;
  const overrides = store.getOverrides(tenantId);
  const settings = getRtdcSettings(tenantName, overrides);
  const nowD = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  return {
    tenantId, tenantName, settings, rules: settings.rules,
    getTenantPool: deps.getTenantPool, sql: deps.sql,
    now: nowD, today: T.fmtDate(nowD),
    user: req.session.fullName || req.session.email || null,
  };
}

// ── Patients ───────────────────────────────────────────────────────────────

function annotate(patients, ctx, date) {
  const rctx = { today: date, cutoff: ctx.settings.cutoff };
  return patients.map(p => {
    const { pred, mode } = P.derivePrediction(p, ctx.settings, date);
    const withPred = { ...p, pred, predMode: mode };
    const ev = R.evaluateRules(withPred, ctx.rules, rctx);
    return { ...withPred, excluded: ev.excluded, candidates: ev.candidates };
  });
}

const filterHospital = (rows, hospital) => (hospital ? rows.filter(r => !r.HOSPITAL || r.HOSPITAL === hospital) : rows);

function unitsFor(ctx, unitRows, patients) {
  const set = new Set([...unitRows.map(u => u.UNIT), ...patients.map(p => p.UNIT)].filter(Boolean));
  for (const u of ctx.settings.units) set.add(u.unit);
  return huddleSort([...set], ctx.settings.huddle_order);
}

// Unit statuses for a day from its S2, persisting the status the room saw.
function unitStatuses(ctx, date, s2, { hospital, persist = false } = {}) {
  const unitRows = filterHospital(s2.units || [], hospital);
  const patients = s2.patients;
  const entries = new Map(store.listDayUnits(ctx.tenantId, date).map(e => [e.unit, e]));
  const rows = [];
  for (const unit of unitsFor(ctx, unitRows, patients)) {
    let snap = unitRows.find(u => u.UNIT === unit);
    if (!snap) {
      const cfg = ctx.settings.units.find(u => u.unit === unit);
      if (!cfg) continue;
      snap = { UNIT: unit, HOSPITAL: ctx.settings.hospital, STAFFED_BEDS: cfg.staffed_beds,
               OCCUPIED_BEDS: patients.filter(p => p.UNIT === unit).length, BLOCKED_BEDS: 0 };
    }
    const predictedY = patients.filter(p => p.UNIT === unit && p.pred === 'Y').length;
    const st = M.unitStatus(snap, predictedY, entries.get(unit) || null);
    st.levelOfCare = snap.LEVEL_OF_CARE || (ctx.settings.units.find(u => u.unit === unit) || {}).level_of_care || null;
    st.ns = patients.filter(p => p.UNIT === unit && p.pred === 'N').length;
    st.candidates = patients.filter(p => p.UNIT === unit && p.candidates.length).length;
    if (persist) store.setDayUnitStatus(ctx.tenantId, date, unit, st.status);
    rows.push(st);
  }
  return { rows, house: M.houseTotal(rows) };
}

// ── The day ────────────────────────────────────────────────────────────────

// Whether outcomes may be shown: any past day with an S3, or today after the
// cutoff (the demo's S3 exists for today; a real tenant's arrives nightly).
function scorable(ctx, date, day) {
  if (!day || !day.S3) return false;
  if (date < ctx.today) return true;
  if (date > ctx.today) return false;
  return T.fmtTime(ctx.now) >= (ctx.settings.cutoff || '14:00');
}

async function loadDay(ctx, date) {
  return source.loadDay(ctx, date);
}

// Turnaround medians from the trailing 90 days of S3 (RTDC.md §2.3). Cached
// per tenant-day since they are computed nightly in spirit.
const medianCache = new Map();
async function medians(ctx, asOf) {
  const key = `${ctx.tenantId}|${asOf}`;
  if (medianCache.has(key)) return medianCache.get(key);
  const days = await source.loadRange(ctx, T.addDays(asOf, -90), T.addDays(asOf, -1));
  const s3Days = [...days.entries()].filter(([, d]) => d.S3).map(([date, d]) => ({ date, patients: d.S3.patients }));
  const m = O.computeMedians(s3Days);
  medianCache.set(key, m);
  if (medianCache.size > 50) medianCache.delete(medianCache.keys().next().value);
  return m;
}

// Everything one date needs. `hospital` narrows multi-hospital tenants.
async function buildDay(ctx, date, { hospital = null, persist = false } = {}) {
  const day = await loadDay(ctx, date);
  const s2 = day && day.S2 ? { ...day.S2, patients: annotate(filterHospital(day.S2.patients, hospital), ctx, date) } : null;
  const s1 = day && day.S1 ? { ...day.S1, patients: annotate(filterHospital(day.S1.patients, hospital), ctx, date) } : null;
  const s3 = day && day.S3 ? { ...day.S3, patients: filterHospital(day.S3.patients, hospital) } : null;
  const isToday = date === ctx.today;
  const s2At = s2 && s2.at ? new Date(s2.at) : null;
  const stale = isToday && s2At ? (ctx.now - s2At) / 3600000 > (ctx.settings.stale_hours || 3) : false;
  const statuses = s2 ? unitStatuses(ctx, date, s2, { hospital, persist }) : null;
  const canScore = scorable(ctx, date, day);
  let score = null;
  if (canScore && s2) {
    score = O.scoreDay({ date, s2Patients: s2.patients, s3Patients: s3.patients, settings: ctx.settings,
                         barrierOverrides: store.getBarriers(ctx.tenantId, date) });
  }
  return {
    date, isToday, hasS1: !!s1, hasS2: !!s2, hasS3: !!s3, stale,
    s1At: s1 ? s1.at : null, s2At: s2 ? s2.at : null, s3At: s3 ? s3.at : null,
    s1, s2, s3, statuses, score, scorable: canScore,
    reviewed: store.listReviewed(ctx.tenantId, date),
    pendingYs: s2 ? s2.patients.filter(p => p.pred === 'Y').length : 0,
  };
}

// Yesterday's strip (RTDC.md §7.1): accuracy · unexpected DCs · N→Y
// conversions · units reviewed. Yesterday is always scorable if it has S3.
async function yesterdayStrip(ctx, date, hospital) {
  const y = T.addDays(date, -1);
  const d = await buildDay(ctx, y, { hospital });
  if (!d.score) return { date: y, available: false };
  return {
    date: y, available: true, mode: d.score.mode,
    accuracyPct: d.score.house.accuracyPct, met: d.score.house.MET, missed: d.score.house.MISSED,
    unexpected: d.score.house.UNEXPECTED, notOnList: d.score.house.NOT_ON_LIST,
    candidates: d.score.house.candidates, converted: d.score.house.converted,
    unitsReviewed: d.reviewed.length, unitsTotal: d.statuses ? d.statuses.rows.length : null,
  };
}

// Score a date range twice: the first pass supplies rule conversion by unit
// for the avoidable-N test (c), the second is the report.
async function scoreRange(ctx, from, to, { hospital = null } = {}) {
  const days = await source.loadRange(ctx, T.addDays(from, -30), to);
  const pass = (ruleConversion) => {
    const out = [];
    for (const [date, day] of days) {
      if (!day.S2 || !day.S3) continue;
      if (!scorable(ctx, date, day)) continue;
      const s2 = annotate(filterHospital(day.S2.patients, hospital), ctx, date);
      out.push(O.scoreDay({ date, s2Patients: s2, s3Patients: filterHospital(day.S3.patients, hospital),
        settings: ctx.settings, ruleConversion, barrierOverrides: store.getBarriers(ctx.tenantId, date) }));
    }
    return out;
  };
  const first = pass({});
  const conv = O.ruleConversionByUnit(first.filter(d => d.date < from));
  const all = pass(conv);
  return { inRange: all.filter(d => d.date >= from && d.date <= to), trailing: all, ruleConversion: conv };
}

// Unit-day status cells across a range — the heatmap's input.
async function statusRange(ctx, from, to, { hospital = null } = {}) {
  const days = await source.loadRange(ctx, from, to);
  const persisted = new Map(store.listDayUnitsRange(ctx.tenantId, from, to).map(e => [`${e.date}|${e.unit}`, e]));
  const cells = [];
  let units = [];
  for (const [date, day] of days) {
    if (!day.S2) continue;
    const s2 = { ...day.S2, patients: annotate(filterHospital(day.S2.patients, hospital), ctx, date) };
    const { rows } = unitStatuses(ctx, date, s2, { hospital });
    for (const r of rows) {
      // The same function and the same effective-bed entries the Board used,
      // so a cell equals what the room saw for that unit-day.
      cells.push({ unit: r.unit, date, status: r.status, adjusted: r.adjusted, capacity: r.capacity, demand: r.demand,
                   persisted: persisted.get(`${date}|${r.unit}`)?.status ?? null });
    }
    if (!units.length) units = rows.map(r => r.unit);
  }
  if (!units.length) units = huddleSort(ctx.settings.units.map(u => u.unit), ctx.settings.huddle_order);
  return { cells, units };
}

module.exports = { makeContext, buildDay, yesterdayStrip, scoreRange, statusRange, medians, annotate, unitStatuses, scorable, filterHospital };

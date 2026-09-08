// lib/rtdcOutcome.js
//
// Reconcile and learn — RTDC.md §6. After 2 PM everything is scored against
// ADT: were we right, did escalation work, did the process happen, which Ns
// could have been Ys, what keeps recurring, is Epic getting truer. This is
// the part of the product Epic has no equivalent for.

const T = require('./rtdcTime');
const P = require('./rtdcPredict');
const R = require('./rtdcRules');

const n = v => (Number.isFinite(Number(v)) ? Number(v) : null);
const median = arr => {
  const a = arr.filter(x => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
};
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

// Every item, resulted or not — the medians need the ones that finished.
function rawItems(v) {
  if (v == null) return [];
  let arr = v;
  if (typeof v === 'string') { try { arr = JSON.parse(v); } catch { return []; } }
  return Array.isArray(arr) ? arr.filter(Boolean).map(i => ({ ...i, class: String(i.class || 'other').toLowerCase() })) : [];
}

function editLog(p) {
  const v = p.PRED_EDIT_LOG;
  if (v == null) return null;
  let arr = v;
  if (typeof v === 'string') { try { arr = JSON.parse(v); } catch { return null; } }
  return Array.isArray(arr) ? arr : null;
}

// The barrier a missed Y most likely had, from the timeline alone. Confirmed
// (or corrected) with one click on the Review tab; never typed.
function inferBarrier(p, s3, cutoff) {
  const order = T.split(p.DC_ORDER_AT || (s3 && s3.DC_ORDER_AT));
  const items = R.pendingItems(p) || [];
  const facts = [];
  if (order) facts.push(`order ${order.time}`); else facts.push('no order');
  const dep = T.split(s3 && s3.DISCHARGED_AT);
  if (dep) facts.push(`departed ${dep.time}`);
  const tr = T.split(p.TRANSPORT_REQUESTED_AT || (s3 && s3.TRANSPORT_REQUESTED_AT));
  if (tr) facts.push(`transport requested ${tr.time}`);

  let code;
  if (!order || order.time > '12:00') code = 'LATE_ORDER';
  else if (R.isPlacement(p.EXPECTED_DISPOSITION) && !['accepted', 'authorized'].includes(String(p.PLACEMENT_STATUS || '').toLowerCase())) code = 'PLACEMENT';
  else if (items.some(i => i.class === 'consult')) code = 'PENDING_CONSULT';
  else if (items.some(i => i.class === 'therapy')) code = 'THERAPY_EVAL';
  else if (items.some(i => ['lab', 'imaging'].includes(i.class))) code = 'PENDING_RESULT';
  else if (items.some(i => i.class === 'referral')) code = 'REFERRAL';
  else if (R.isHome(p.EXPECTED_DISPOSITION) && (!tr || tr.time > '12:00')) code = 'TRANSPORT';
  else if (/script|pharmacy|prescription/i.test(p.DC_NARRATIVE || '')) code = 'PHARMACY';
  else if (/family|caregiver|daughter|son\b|wife|husband/i.test(p.DC_NARRATIVE || '')) code = 'FAMILY';
  else code = 'OTHER';
  return { code, facts: facts.join(' · ') };
}

// Night/AM fidelity from PRED_EDIT_LOG: edits in [15:00 prev day, 07:00) and
// edits or reviews in [07:00, S2). Null when no row carries a log.
function fidelity(patients, date, s2Time) {
  const listed = patients.filter(p => p.pred != null);
  const logs = listed.map(p => editLog(p));
  if (!logs.some(l => l !== null)) return { available: false };
  const nightFrom = T.at(T.addDays(date, -1), '15:00').getTime();
  const amFrom = T.at(date, '07:00').getTime();
  const amTo = T.at(date, s2Time || '08:20').getTime();
  let night = 0, am = 0;
  logs.forEach(l => {
    if (!l) return;
    const times = l.map(e => T.split(e.at)).filter(Boolean).map(s => s.ms);
    if (times.some(t => t >= nightFrom && t < amFrom)) night += 1;
    if (times.some(t => t >= amFrom && t < amTo)) am += 1;
  });
  const ys = listed.filter(p => p.pred === 'Y');
  const narrated = ys.filter(p => String(p.DC_NARRATIVE || '').trim().length > 0).length;
  return {
    available: true, listed: listed.length,
    nightPct: pct(night, listed.length), amPct: pct(am, listed.length),
    narrativePct: pct(narrated, ys.length),
  };
}

// Epic fidelity: EDD present and dated today for Ys; discharge event entered
// ≤ 15 min after departure.
function epicFidelity(patients, s3ByKey, date) {
  const ys = patients.filter(p => p.pred === 'Y');
  const eddToday = ys.filter(p => p.PRED_SOURCE_DATE && String(p.PRED_SOURCE_DATE).slice(0, 10) === date).length;
  const departed = [...s3ByKey.values()].filter(r => r.DISCHARGED_AT);
  const withEntry = departed.filter(r => r.DISCHARGE_ENTERED_AT);
  const prompt = withEntry.filter(r => {
    const a = T.split(r.DISCHARGED_AT), b = T.split(r.DISCHARGE_ENTERED_AT);
    return a && b && (b.ms - a.ms) <= 15 * 60000;
  }).length;
  return {
    eddTodayPct: pct(eddToday, ys.length),
    entryLagPct: withEntry.length ? pct(prompt, withEntry.length) : null,
    departed: departed.length,
  };
}

// Score one day. s2Patients carry pred + candidates (+ excluded); s3Patients
// are the same encounters after ADT. ruleConversion: { `${unit}|${rule}`: pct }
// from the trailing window, for avoidable-N test (c).
function scoreDay({ date, s2Patients, s3Patients, settings, ruleConversion = {}, barrierOverrides = {} }) {
  const cutoff = settings.cutoff || '14:00';
  const s3ByKey = new Map((s3Patients || []).map(r => [String(r.ENCOUNTER_KEY), r]));
  const rows = [];
  const seen = new Set();

  for (const p of s2Patients) {
    const key = String(p.ENCOUNTER_KEY);
    seen.add(key);
    const s3 = s3ByKey.get(key) || null;
    const dischargedAt = s3 ? s3.DISCHARGED_AT : null;
    const oc = P.classifyOutcome(p.pred, dischargedAt, date, cutoff);
    const order = T.split((s3 && s3.DC_ORDER_AT) || p.DC_ORDER_AT);
    const candidates = p.candidates || [];
    const converted = candidates.length ? oc.by14 : null;

    // Avoidable N (RTDC.md §3.2): discharged by 2 PM anyway, or by 18:00 with
    // an order before noon, or matched a rule that converts ≥ 50% on this unit.
    let avoidable = false, avoidableWhy = null;
    if (p.pred === 'N') {
      if (oc.by14) { avoidable = true; avoidableWhy = 'discharged before 2 PM anyway'; }
      else if (oc.dischargedToday && oc.dischargedTime <= '18:00' && order && order.time < '12:00') {
        avoidable = true; avoidableWhy = `order at ${order.time}, departed ${oc.dischargedTime}`;
      } else {
        const hit = candidates.find(c => (ruleConversion[`${p.UNIT}|${c.ruleKey}`] ?? 0) >= 50);
        if (hit) { avoidable = true; avoidableWhy = `${hit.ruleKey} converts ${ruleConversion[`${p.UNIT}|${hit.ruleKey}`]}% on ${p.UNIT}`; }
      }
    }
    const depMs = T.split(dischargedAt)?.ms;
    const cutoffMs = T.at(date, cutoff).getTime();
    const bedHours = avoidable && depMs && depMs > cutoffMs ? Math.round(((depMs - cutoffMs) / 3600000) * 10) / 10 : 0;

    let barrier = null;
    if (oc.outcome === 'MISSED') {
      const inferred = inferBarrier(p, s3, cutoff);
      const ov = barrierOverrides[key];
      barrier = ov
        ? { code: ov.code, bin: ov.bin || null, inferred: false, inferredCode: inferred.code, facts: inferred.facts, confirmedBy: ov.confirmed_by, confirmedAt: ov.confirmed_at }
        : { code: inferred.code, bin: null, inferred: true, inferredCode: inferred.code, facts: inferred.facts, confirmedBy: null, confirmedAt: null };
    }

    rows.push({
      encounterKey: key, unit: p.UNIT, hospital: p.HOSPITAL || null, roomBed: p.ROOM_BED, initials: p.PATIENT_INITIALS,
      attending: p.ATTENDING, service: p.HOSPITAL_SERVICE, dispo: p.EXPECTED_DISPOSITION,
      pred: p.pred, mode: p.predMode || settings.pred_source,
      outcome: oc.outcome, dischargedToday: oc.dischargedToday, by14: oc.by14, dischargedTime: oc.dischargedTime,
      orderTime: order ? order.time : null, candidates, converted, avoidable, avoidableWhy, bedHours,
      narrative: p.DC_NARRATIVE || '', pendingItems: R.pendingItems(p) || [], barrier,
      losDays: n(p.LOS_DAYS), gmlos: n(p.GMLOS),
    });
  }
  // Departed before 2 PM without ever being on the list (no S2 row with a
  // prediction covers them, but they were on the unit at S2).
  for (const [key, r] of s3ByKey) {
    if (seen.has(key)) continue;
    const oc = P.classifyOutcome(null, r.DISCHARGED_AT, date, cutoff);
    if (oc.outcome === 'NOT_ON_LIST') {
      rows.push({ encounterKey: key, unit: r.UNIT, hospital: r.HOSPITAL || null, roomBed: r.ROOM_BED, initials: r.PATIENT_INITIALS,
        attending: r.ATTENDING, service: r.HOSPITAL_SERVICE, dispo: r.DISCHARGE_DISPOSITION || r.EXPECTED_DISPOSITION,
        pred: null, mode: settings.pred_source, outcome: 'NOT_ON_LIST', dischargedToday: true, by14: true,
        dischargedTime: oc.dischargedTime, orderTime: null, candidates: [], converted: null, avoidable: false,
        avoidableWhy: null, bedHours: 0, narrative: '', pendingItems: [], barrier: null, losDays: n(r.LOS_DAYS), gmlos: n(r.GMLOS) });
    }
  }

  const units = [...new Set(rows.map(r => r.unit).filter(Boolean))];
  const byUnit = {};
  for (const u of units) {
    const ur = rows.filter(r => r.unit === u);
    byUnit[u] = {
      ...P.accuracy(ur.map(r => r.outcome)),
      candidates: ur.filter(r => r.candidates.length).length,
      converted: ur.filter(r => r.converted === true).length,
      medianDcTime: (() => { const m = median(ur.filter(r => r.dischargedToday).map(r => T.toMinutes(r.dischargedTime))); return m == null ? null : T.fromMinutes(Math.round(m)); })(),
    };
  }
  const house = P.accuracy(rows.map(r => r.outcome));
  const scored = s3Patients != null;
  return {
    date, scored, mode: settings.pred_source, rows, byUnit,
    house: {
      ...house,
      candidates: rows.filter(r => r.candidates.length).length,
      converted: rows.filter(r => r.converted === true).length,
      avoidable: rows.filter(r => r.avoidable).length,
      medianDcTime: (() => { const m = median(rows.filter(r => r.dischargedToday).map(r => T.toMinutes(r.dischargedTime))); return m == null ? null : T.fromMinutes(Math.round(m)); })(),
    },
    fidelity: fidelity(s2Patients, date, settings.snapshot_times && settings.snapshot_times.S2),
    fidelityByUnit: Object.fromEntries(units.map(u => [u, fidelity(s2Patients.filter(p => p.UNIT === u), date, settings.snapshot_times && settings.snapshot_times.S2)])),
    epic: epicFidelity(s2Patients, s3ByKey, date),
  };
}

// Conversion per rule (and per unit / attending within a rule) over many
// scored days. Rules with < minFirings show n only.
function conversionTable(dayScores, { minFirings = 10, unit = null } = {}) {
  const acc = new Map();   // key → { fired, converted }
  const bump = (key, converted) => {
    const a = acc.get(key) || { fired: 0, converted: 0 };
    a.fired += 1; if (converted) a.converted += 1; acc.set(key, a);
  };
  const firings = [];
  for (const d of dayScores) {
    for (const r of d.rows) {
      if (unit && r.unit !== unit) continue;
      for (const c of r.candidates) {
        bump(`rule|${c.ruleKey}`, r.converted);
        bump(`unit|${c.ruleKey}|${r.unit}`, r.converted);
        bump(`att|${c.ruleKey}|${r.attending || '—'}`, r.converted);
        firings.push({ date: d.date, unit: r.unit, roomBed: r.roomBed, initials: r.initials, attending: r.attending, ruleKey: c.ruleKey, outcome: r.outcome, converted: r.converted, dischargedTime: r.dischargedTime });
      }
    }
  }
  const shape = (key, a) => ({ key, fired: a.fired, converted: a.converted,
    conversionPct: a.fired >= minFirings ? pct(a.converted, a.fired) : null, belowMin: a.fired < minFirings });
  const rules = [], byUnit = [], byAttending = [];
  for (const [k, a] of acc) {
    const parts = k.split('|');
    if (parts[0] === 'rule') rules.push({ ...shape(parts[1], a), ruleKey: parts[1] });
    else if (parts[0] === 'unit') byUnit.push({ ...shape(k, a), ruleKey: parts[1], unit: parts[2] });
    else byAttending.push({ ...shape(k, a), ruleKey: parts[1], attending: parts[2] });
  }
  rules.sort((a, b) => b.fired - a.fired);
  return { rules, byUnit, byAttending, firings };
}

// { `${unit}|${rule}`: pct } — the avoidable-N test (c) input. Uses every
// firing regardless of the minimum, since it is a threshold, not a report.
function ruleConversionByUnit(dayScores) {
  const t = conversionTable(dayScores, { minFirings: 1 });
  const out = {};
  for (const r of t.byUnit) out[`${r.unit}|${r.ruleKey}`] = r.conversionPct ?? 0;
  return out;
}

// Turnaround medians from S3 history (RTDC.md §2.3): DO→DC per unit, order→
// result per class, attending median order time per unit.
function computeMedians(s3Days) {
  const doDc = {}, attOrder = {}, orderResult = {};
  for (const day of s3Days) {
    for (const r of day.patients || []) {
      const unit = r.UNIT; if (!unit) continue;
      const order = T.split(r.DC_ORDER_AT), dep = T.split(r.DISCHARGED_AT);
      if (order && dep && dep.date === day.date && dep.ms > order.ms) {
        (doDc[unit] ||= []).push((dep.ms - order.ms) / 60000);
      }
      if (order && r.ATTENDING) {
        ((attOrder[unit] ||= {})[r.ATTENDING] ||= []).push(T.toMinutes(order.time));
      }
      for (const it of rawItems(r.PENDING_ITEMS)) {
        const o = T.split(it.ordered_at), res = T.split(it.resulted_at);
        if (o && res && res.ms > o.ms) ((orderResult[unit] ||= {})[it.class] ||= []).push((res.ms - o.ms) / 60000);
      }
    }
  }
  const out = {};
  for (const unit of new Set([...Object.keys(doDc), ...Object.keys(attOrder), ...Object.keys(orderResult)])) {
    const m = { DO_TO_DC: median(doDc[unit] || []), ORDER_TO_RESULT: {}, ATTENDING_ORDER_TIME: {}, n: (doDc[unit] || []).length };
    if (m.DO_TO_DC != null) m.DO_TO_DC = Math.round(m.DO_TO_DC);
    for (const [cls, arr] of Object.entries(orderResult[unit] || {})) m.ORDER_TO_RESULT[cls] = Math.round(median(arr));
    for (const [att, arr] of Object.entries(attOrder[unit] || {})) if (arr.length >= 3) m.ATTENDING_ORDER_TIME[att] = T.fromMinutes(Math.round(median(arr)));
    out[unit] = m;
  }
  return out;
}

module.exports = { scoreDay, conversionTable, ruleConversionByUnit, computeMedians, inferBarrier, fidelity, epicFidelity, median, pct, editLog };

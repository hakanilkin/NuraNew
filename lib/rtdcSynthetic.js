// lib/rtdcSynthetic.js
//
// A deterministic, fully synthetic RTDC data source for the demo tenant.
//
// Mock data, real plumbing (DemoTenant.md §1): the routes read snapshots
// through lib/rtdcSource.js exactly as they would from DS_RTDC_Snapshot, and
// nothing downstream knows the rows were generated. The simulation runs an
// inpatient census day by day from a fixed epoch, so a calendar date's
// snapshot is the same on every reload and on every machine, and weekday
// structure (5 Central short on Mondays and Tuesdays) is real weekday
// structure. No client data; every name is generated from name parts.
//
// Engineered storylines (the numbers are produced by construction):
//   RT-1  5 Central is short every Mon/Tue — Ortho/Spine OR admissions stack.
//   RT-2  Home-with-HH on 4 East waits on referral acceptance — the top
//         avoidable-N archetype, orders before noon, departures after 3 PM.
//   RT-3  One hospitalist writes orders late (median ~13:40) — a recurring
//         LATE_ORDER barrier and the reason LOS_EXCESS converts poorly.
//   RT-4  MRD_HOME converts well; LOS_EXCESS converts poorly.

const T = require('./rtdcTime');

/* ── Seeded RNG ─────────────────────────────────────────────────────────── */

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash(s) {
  let h = 2166136261;
  for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
const mkRng = seed => {
  const r = mulberry32(seed);
  return {
    f: () => r(),
    int: (lo, hi) => lo + Math.floor(r() * (hi - lo + 1)),
    pick: arr => arr[Math.floor(r() * arr.length)],
    chance: p => r() < p,
    norm: (mu, sd) => { const u = 1 - r(), v = r(); return mu + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); },
    lognorm: (medianV, sigma) => medianV * Math.exp(sigma * (() => { const u = 1 - r(), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); })()),
    weighted: pairs => { let x = r() * pairs.reduce((s, p) => s + p[1], 0); for (const p of pairs) { x -= p[1]; if (x <= 0) return p[0]; } return pairs[pairs.length - 1][0]; },
    poisson: lam => { const L = Math.exp(-lam); let k = 0, p = 1; do { k++; p *= r(); } while (p > L); return k - 1; },
  };
};

/* ── Vocabulary ─────────────────────────────────────────────────────────── */

const FIRST = ['Amara', 'Bennett', 'Calla', 'Dmitri', 'Esme', 'Farid', 'Greta', 'Hollis', 'Imani', 'Jonas', 'Keziah', 'Lior', 'Maren', 'Nikhil', 'Odalys', 'Priya', 'Quentin', 'Rosalind', 'Soren', 'Tamsin'];
const LAST  = ['Okonkwo', 'Lindqvist', 'Ferreira', 'Nakamura', 'Whitlock', 'Abernathy', 'Castellano', 'Devereaux', 'Haugland', 'Iyer', 'Kowalczyk', 'Marchetti', 'Nyström', 'Oyelaran', 'Prakash', 'Rutherford', 'Sallinen', 'Trevino', 'Vasquez', 'Zielinski'];

const SERVICE_MIX = {
  'Med-Surg':  [['Hospitalist Medicine', 42], ['Orthopedics', 20], ['General Surgery', 14], ['Spine', 8], ['Urology', 6], ['Colorectal', 6], ['GYN', 4]],
  'Telemetry': [['Cardiology', 48], ['Hospitalist Medicine', 30], ['Vascular', 12], ['Pulmonology', 10]],
  'PCU':       [['Hospitalist Medicine', 40], ['Cardiology', 25], ['Vascular', 20], ['General Surgery', 15]],
  'ICU':       [['Critical Care', 60], ['Cardiology', 18], ['Neurosurgery', 12], ['General Surgery', 10]],
};
const GMLOS = { 'Hospitalist Medicine': 3.8, Orthopedics: 2.6, 'General Surgery': 3.4, Spine: 3.0, Urology: 2.2, Colorectal: 4.6, GYN: 2.4,
  Cardiology: 3.2, Vascular: 4.1, Pulmonology: 4.0, 'Critical Care': 5.5, Neurosurgery: 5.0 };
const DISPO_MIX = {
  default:   [['Home', 52], ['Home w/ HH', 22], ['SNF', 16], ['Rehab', 5], ['Hospice', 2], ['LTACH', 1], ['Other', 2]],
  surgical:  [['Home', 55], ['Home w/ HH', 28], ['SNF', 9], ['Rehab', 7], ['Other', 1]],
  icu:       [['Home', 20], ['Home w/ HH', 15], ['SNF', 25], ['Rehab', 15], ['LTACH', 12], ['Hospice', 8], ['Other', 5]],
};
const SURGICAL = new Set(['Orthopedics', 'General Surgery', 'Spine', 'Urology', 'Colorectal', 'GYN', 'Vascular', 'Neurosurgery']);
const DOW_ADMIT = { 0: 0.75, 1: 1.18, 2: 1.15, 3: 1.0, 4: 0.95, 5: 0.9, 6: 0.7 };
const isoAt = (date, mins) => T.at(date, T.fromMinutes(Math.max(0, Math.min(23 * 60 + 59, Math.round(mins))))).toISOString();
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function attendings(rng) {
  const out = [];
  const groups = [['Hospitalist Medicine', 5], ['Cardiology', 2], ['Orthopedics', 2], ['General Surgery', 2], ['Critical Care', 1], ['Spine', 1], ['Vascular', 1], ['Pulmonology', 1], ['Neurosurgery', 1], ['Colorectal', 1], ['Urology', 1], ['GYN', 1]];
  for (const [svc, k] of groups) {
    for (let i = 0; i < k; i++) {
      out.push({ name: `Dr. ${rng.pick(LAST)}`, service: svc, orderMedian: 10 * 60 + 20 + rng.int(-40, 40), late: false });
    }
  }
  // RT-3: one hospitalist writes orders late.
  const late = out.find(a => a.service === 'Hospitalist Medicine');
  late.orderMedian = 13 * 60 + 40; late.late = true;
  // Unique names.
  const seen = new Set();
  for (const a of out) { while (seen.has(a.name)) a.name = `Dr. ${rng.pick(LAST)}`; seen.add(a.name); }
  return out;
}

/* ── Unit demand shapes (the §2.2 row) ──────────────────────────────────── */

function unitDemand(u, date, rng) {
  const w = T.dow(date);
  const monTue = w === 1 || w === 2;
  const shape = {
    'Med-Surg':  { ed: monTue ? 2.6 : 1.3, or: monTue ? (u.unit === '5 Central' ? 6.5 : 2.8) : (u.unit === '5 Central' ? 1.9 : 1.6), down: 0.6, edLikely: 0.9, proc: 0.2, downAnt: 0.3, edF: 1.2 },
    'Telemetry': { ed: 1.2, or: 0.7, down: 0.5, edLikely: 0.8, proc: monTue ? 1.2 : 0.8, downAnt: 0.3, edF: 1.0 },
    'PCU':       { ed: 0.7, or: 0.5, down: 0.3, edLikely: 0.4, proc: 0.3, downAnt: 0.1, edF: 0.5 },
    'ICU':       { ed: 0.6, or: 0.8, down: 0, edLikely: 0.4, proc: 0.3, downAnt: 0, edF: 0.4 },
  }[u.level_of_care] || { ed: 1.2, or: 1.2, down: 0.5, edLikely: 0.6, proc: 0.3, downAnt: 0.2, edF: 0.8 };
  if (w === 0 || w === 6) { shape.or = 0.2; shape.ed *= 0.8; shape.proc *= 0.3; }
  const nBed = rng.poisson(shape.ed);
  const reqs = Array.from({ length: nBed }, () => ({
    source_dept: rng.weighted([['ED', 70], ['PACU', 12], ['Transfer Center', 10], ['Cath Lab', 8]]),
    requested_at: isoAt(date, rng.int(2 * 60, 8 * 60)),
    state: rng.weighted([['requested', 55], ['assigned', 30], ['RTM', 15]]),
  }));
  return {
    HOSPITAL: u.hospital, UNIT: u.unit,
    STAFFED_BEDS: u.staffed_beds, BLOCKED_BEDS: rng.weighted([[0, 55], [1, 30], [2, 15]]),
    PENDING_BED_REQUESTS_IN: reqs,
    OR_EXPECTED_ADMITS_BY_2PM: rng.poisson(shape.or),
    DOWNGRADE_REQUESTS_IN: rng.poisson(shape.down),
    ED_LIKELY_ADMITS: rng.poisson(shape.edLikely),
    PROCEDURAL_EXPECTED: rng.poisson(shape.proc),
    DOWNGRADES_ANTICIPATED: rng.poisson(shape.downAnt),
    ED_FORECAST_8_14: Math.round(clamp(rng.norm(shape.edF, 0.6), 0, 8) * 10) / 10,
  };
}

/* ── The simulation ─────────────────────────────────────────────────────── */

const EPOCH = '2026-01-05';   // a Monday
const MAX_DAYS = 420;

function epochFor(anchor) {
  const diff = T.daysBetween(EPOCH, anchor);
  if (diff <= MAX_DAYS) return EPOCH;
  return T.addDays(EPOCH, Math.floor((diff - MAX_DAYS) / 7) * 7);
}

function simulate(settings, anchor) {
  const hospital = settings.hospital || 'Hospital';
  const units = (settings.units || []).map(u => ({ ...u, hospital, level_of_care: u.level_of_care || 'Med-Surg' }));
  const epoch = epochFor(anchor);
  const days = T.eachDay(epoch, anchor);
  const rng0 = mkRng(hash(`rtdc|${hospital}`));
  const docs = attendings(rng0);
  const byService = svc => docs.filter(d => d.service === svc);
  const S2 = T.toMinutes(settings.snapshot_times.S2 || '08:20');
  const S1 = T.toMinutes(settings.snapshot_times.S1 || '06:00');
  const cutoffMin = T.toMinutes(settings.cutoff || '14:00');
  const timeSite = settings.pred_source !== 'EDD_DATE';

  // Per-date results: { S1: {patients, units}, S2, S3 }
  const out = new Map();
  for (const d of days) out.set(d, { S1: { patients: [], units: [] }, S2: { patients: [], units: [] }, S3: { patients: [] } });

  let encSeq = 100000;
  for (const [ui, u] of units.entries()) {
    const rng = mkRng(hash(`rtdc|${hospital}|${u.unit}|${ui}`));
    // Arrival rate that holds the unit near its target occupancy given the
    // realised LOS (planned LOS median ≈ GMLOS, plus slips).
    const meanLos = u.level_of_care === 'ICU' ? 5.2 : 3.3;
    const target = u.level_of_care === 'ICU' ? 0.84 : 0.9;
    const lam = (u.staffed_beds * target) / meanLos;
    const doDcMedian = { 'Med-Surg': 150, Telemetry: 165, PCU: 180, ICU: 220 }[u.level_of_care] || 160;
    const floorNo = { '5 Central': 5, '4 East': 4, '3 West': 3, Stepdown: 2, ICU: 1 }[u.unit] || (ui + 2);
    const rooms = [];
    for (let r = 1; r <= Math.ceil(u.staffed_beds / 2); r++) for (const b of ['A', 'B']) rooms.push(`${floorNo}${String(r).padStart(2, '0')}-${b}`);
    const freeRooms = rooms.slice(0, u.staffed_beds);
    const active = [];   // encounters currently bedded

    const dispoFor = svc => rng.weighted(u.level_of_care === 'ICU' ? DISPO_MIX.icu : SURGICAL.has(svc) ? DISPO_MIX.surgical : DISPO_MIX.default);

    for (const date of days) {
      const dowF = DOW_ADMIT[T.dow(date)];
      // ── Each bedded patient: the day's discharge process ──
      const day = out.get(date);
      const s2Rows = [], s1Rows = [], s3Rows = [];
      for (const enc of [...active]) {
        if (enc.admitDate === date) continue;     // admitted later today; not present at S2
        // Night-before edits (RT: night organizes, AM finalizes).
        const eddToday = enc.eddDate === date;
        const nightP = { '3 West': 0.62 }[u.unit] ?? 0.86;
        const amP = { '3 West': 0.5 }[u.unit] ?? 0.72;
        const prevDay = T.addDays(date, -1);
        if (eddToday || enc.eddDate === T.addDays(date, 1)) {
          if (rng.chance(nightP)) {
            let nu = enc.eddDate;
            if (rng.chance(0.1)) nu = T.addDays(enc.eddDate, 1);
            enc.edits.push({ at: isoAt(prevDay, rng.int(19 * 60, 23 * 60 + 30)), role: rng.weighted([['RN', 60], ['CM', 40]]), old: enc.eddDate, new: nu });
            enc.eddDate = nu;
          }
          if (rng.chance(amP)) {
            enc.edits.push({ at: isoAt(date, rng.int(7 * 60 + 5, 8 * 60 + 5)), role: 'RN', old: enc.eddDate, new: enc.eddDate, review: true });
          }
        }
        const dcDay = enc.eddDate === date;
        const eddAtS2 = enc.eddDate;                 // what the 08:20 row shows; the day's outcome may move it later
        const s2Ms = T.at(date, T.fromMinutes(S2)).getTime();
        // Placement progress.
        if (enc.placement === 'pending' && dcDay && rng.chance(0.55)) enc.placement = rng.weighted([['accepted', 70], ['authorized', 30]]);

        // The nurse's call and the day's timeline.
        let eddTime = null, nurseY = false, orderMin = null, departMin = null, items = [];
        if (dcDay) {
          let pY = 0.66;
          if (enc.hhStory) pY = 0.35;
          if (enc.doc.late) pY = 0.55;
          if (enc.placement) pY = enc.placement === 'pending' ? 0.3 : 0.5;
          if (enc.flags.includes('comfort_care')) pY = 0.2;
          nurseY = rng.chance(pY);
          eddTime = nurseY ? rng.pick(['10:00', '11:00', '11:30', '12:00', '13:00', '13:30']) : rng.pick(['15:00', '15:30', '16:00', '17:00', '18:00']);
          // Pending items.
          const mk = (cls, name, oLo, oHi, tLo, tHi) => ({ class: cls, name, ordered_at: isoAt(date, rng.int(oLo, oHi)), _turn: rng.int(tLo, tHi) });
          if (rng.chance(0.35)) items.push(mk('lab', rng.pick(['AM BMP', 'CBC', 'INR', 'Troponin']), 5 * 60, 7 * 60 + 30, 60, 150));
          if (rng.chance(0.12)) items.push(mk('imaging', rng.pick(['Chest X-ray', 'CT head', 'Echo', 'Renal ultrasound']), 6 * 60, 8 * 60, 120, 300));
          if (rng.chance(0.18)) items.push(mk('therapy', rng.pick(['PT eval', 'OT eval', 'PT/OT clearance']), 6 * 60 + 30, 8 * 60, 90, 240));
          if (rng.chance(0.08)) items.push(mk('consult', rng.pick(['Cardiology consult', 'Nephrology consult', 'Wound care consult']), 6 * 60, 8 * 60, 180, 420));
          if (enc.dispo === 'Home w/ HH' && rng.chance(enc.hhStory ? 0.9 : 0.65)) items.push(mk('referral', rng.pick(['Home health referral', 'Home health TPN referral', 'HH nursing referral']), 5 * 60 + 30, 8 * 60 + 10, enc.hhStory ? 300 : 60, enc.hhStory ? 520 : 240));
          if (enc.placement && rng.chance(0.5)) items.push(mk('referral', `${enc.dispo} referral / auth`, 5 * 60, 8 * 60, 120, 480));
          for (const it of items) it.resulted_at = new Date(new Date(it.ordered_at).getTime() + it._turn * 60000).toISOString();
          // Order time. An order already in by the huddle (8%); otherwise the
          // attending's habit, nudged by the facts the escalation rules read,
          // so each rule's conversion rate is a property of the data:
          //   ORDER_WRITTEN converts most, MRD_HOME well, LOS_EXCESS on the
          //   late-ordering attending poorly (RT-3, RT-4).
          const clinicalPending = items.some(it => ['lab', 'imaging', 'consult', 'therapy'].includes(it.class));
          const earlyOrder = rng.chance(0.08);
          enc.mrd = earlyOrder ? rng.chance(0.95) : rng.chance(nurseY ? 0.7 : 0.58);
          const isHome = enc.dispo === 'Home' || enc.dispo === 'Home w/ HH';
          let base, sd = 70;
          if (earlyOrder) { base = null; }
          else if (enc.doc.late) { base = enc.doc.orderMedian; sd = 55; }
          else if (nurseY) { base = enc.doc.orderMedian - 40; sd = 65; }
          else if (enc.hhStory) { base = enc.doc.orderMedian - 30; sd = 50; }                         // RT-2: the order is not the barrier
          else if (enc.mrd && isHome && !clinicalPending) { base = enc.doc.orderMedian + 5; sd = 70; } // MRD_HOME
          else if (enc.placement && enc.placement !== 'pending') { base = enc.doc.orderMedian + 70; }  // PLACEMENT_SECURED
          else if (items.length === 1 && ['lab', 'imaging', 'therapy'].includes(items[0].class)) { base = enc.doc.orderMedian + 45; } // SINGLE_STEP
          else { base = enc.doc.orderMedian + 150; sd = 90; }
          orderMin = earlyOrder ? rng.int(6 * 60 + 30, 8 * 60 + 10) : clamp(Math.round(rng.norm(base, sd)), 7 * 60 + 30, 19 * 60);
          // Departure: order + DO→DC, gated by whatever results after the order.
          let ready = orderMin;
          for (const it of items) ready = Math.max(ready, T.toMinutes(T.split(it.resulted_at).time) + 20);
          departMin = Math.round(ready + rng.lognorm(doDcMedian, 0.28) + (enc.placement ? rng.int(45, 150) : 0));
          if (departMin > 21 * 60 + 30 || rng.chance(0.06)) {
            // Slips a day: tomorrow's EDD, tonight's edit.
            departMin = null;
            const nu = T.addDays(date, 1);
            enc.edits.push({ at: isoAt(date, rng.int(15 * 60, 19 * 60)), role: rng.pick(['RN', 'CM', 'MD']), old: enc.eddDate, new: nu });
            enc.eddDate = nu;
          }
        } else if (rng.chance(0.15)) {
          items.push({ class: rng.pick(['lab', 'imaging']), name: rng.pick(['CBC', 'BMP', 'Chest X-ray']), ordered_at: isoAt(date, rng.int(5 * 60, 7 * 60 + 30)), _turn: rng.int(60, 200) });
          items[0].resulted_at = new Date(new Date(items[0].ordered_at).getTime() + items[0]._turn * 60000).toISOString();
        }

        // Narrative, owner, MRD.
        const editsAtS2 = enc.edits.filter(e => T.split(e.at).ms <= s2Ms);
        const narrative = dcDay ? buildNarrative(enc, items, nurseY, rng) : (rng.chance(0.4) ? `Anticipate discharge ${eddAtS2 === T.addDays(date, 1) ? 'tomorrow' : eddAtS2}${enc.placement ? ', placement in progress' : ''}.` : '');
        const owner = dcDay ? rng.weighted([['RN', 40], ['CM', 30], ['MD', 20], ['SW', 10]]) : null;
        const mrd = dcDay && enc.mrd;
        const losAtS2 = Math.round(((T.at(date, T.fromMinutes(S2)) - new Date(enc.admitAt)) / 86400000) * 10) / 10;
        const orderAtS2 = orderMin != null && orderMin <= S2 ? isoAt(date, orderMin) : null;
        const itemsAtS2 = items.filter(it => T.toMinutes(T.split(it.ordered_at).time) <= S2)
          .map(it => ({ class: it.class, name: it.name, ordered_at: it.ordered_at, status: rng.weighted([['pending', 60], ['in progress', 30], ['placed', 10]]), resulted_at: null }));
        const base = {
          ENCOUNTER_KEY: enc.key, HOSPITAL: hospital, UNIT: u.unit, ROOM_BED: enc.room, PATIENT_INITIALS: enc.initials,
          ADMIT_AT: enc.admitAt, LOS_DAYS: losAtS2, GMLOS: enc.gm,
          PATIENT_CLASS: 'Inpatient', LEVEL_OF_CARE: u.level_of_care,
          HOSPITAL_SERVICE: enc.svc, ATTENDING: enc.doc.name, EXPECTED_DISPOSITION: enc.dispo,
          PRED_SOURCE_DATE: eddAtS2, PRED_SOURCE_TIME: timeSite ? (dcDay ? eddTime : null) : null,
          PRED_FLAG_RAW: dcDay ? (nurseY ? 'Y' : 'N') : (eddAtS2 <= T.addDays(date, 1) ? 'N' : null),
          PRED_UNKNOWN: enc.unknown,
          DC_NARRATIVE: narrative, NARRATIVE_OWNER_ROLE: owner,
          PRED_LAST_EDIT_AT: editsAtS2[editsAtS2.length - 1].at, PRED_LAST_EDIT_ROLE: editsAtS2[editsAtS2.length - 1].role,
          PRED_EDIT_LOG: editsAtS2.map(e => ({ ...e })),
          MRD: mrd, ORD: mrd && rng.chance(0.7),
          DC_ORDER_AT: orderAtS2, DC_MILESTONES: null, DC_DELAY_REASON: null,
          PENDING_ITEMS: itemsAtS2, PLACEMENT_STATUS: enc.placement,
          TRANSPORT_REQUESTED_AT: null, FLAGS: enc.flags.slice(),
        };
        s2Rows.push({ ...base, SNAPSHOT_AT: isoAt(date, S2) });
        // S1 is the same picture two hours earlier: no AM review yet, only
        // the earliest orders in.
        s1Rows.push({ ...base, SNAPSHOT_AT: isoAt(date, S1),
          PRED_EDIT_LOG: enc.edits.filter(e => T.split(e.at).ms <= T.at(date, T.fromMinutes(S1)).getTime()).map(e => ({ ...e })),
          MRD: false, ORD: false,
          DC_ORDER_AT: orderMin != null && orderMin <= S1 ? isoAt(date, orderMin) : null,
          PENDING_ITEMS: itemsAtS2.filter(it => T.toMinutes(T.split(it.ordered_at).time) <= S1),
          LOS_DAYS: Math.round((losAtS2 - (S2 - S1) / 1440) * 10) / 10 });

        // ── S3: what happened ──
        let dischargedAt = null, enteredAt = null, transportAt = null;
        if (departMin != null) {
          dischargedAt = isoAt(date, departMin);
          enteredAt = isoAt(date, departMin + (rng.chance(0.78) ? rng.int(2, 14) : rng.int(16, 55)));
          if (enc.dispo === 'Home' || enc.dispo === 'Home w/ HH') transportAt = isoAt(date, departMin - rng.int(30, 110));
          else transportAt = isoAt(date, departMin - rng.int(60, 150));
        }
        s3Rows.push({ ...base, SNAPSHOT_AT: isoAt(date, 23 * 60 + 30),
          PRED_SOURCE_DATE: enc.eddDate, PRED_EDIT_LOG: enc.edits.map(e => ({ ...e })),
          PRED_LAST_EDIT_AT: enc.edits[enc.edits.length - 1].at, PRED_LAST_EDIT_ROLE: enc.edits[enc.edits.length - 1].role,
          DC_ORDER_AT: orderMin != null ? isoAt(date, orderMin) : null,
          PENDING_ITEMS: items.map(it => ({ class: it.class, name: it.name, ordered_at: it.ordered_at, status: 'resulted', resulted_at: it.resulted_at })),
          TRANSPORT_REQUESTED_AT: transportAt,
          DISCHARGED_AT: dischargedAt, DISCHARGE_ENTERED_AT: enteredAt,
          DISCHARGE_DISPOSITION: dischargedAt ? enc.dispo : null });

        if (dischargedAt) {
          active.splice(active.indexOf(enc), 1);
          freeRooms.push(enc.room);
        } else if (enc.eddDate < date) {
          // Overdue EDD nobody moved: push it, as a real unit eventually does.
          if (rng.chance(0.5)) { const nu = T.addDays(date, 1); enc.edits.push({ at: isoAt(date, rng.int(15 * 60, 20 * 60)), role: 'CM', old: enc.eddDate, new: nu }); enc.eddDate = nu; }
        }
      }
      // ── Admissions ──
      const nAdm = Math.min(rng.poisson(lam * dowF), freeRooms.length);
      for (let i = 0; i < nAdm; i++) {
        const svc = rng.weighted(SERVICE_MIX[u.level_of_care] || SERVICE_MIX['Med-Surg']);
        const pool = byService(svc).length ? byService(svc) : byService('Hospitalist Medicine');
        const doc = rng.pick(pool);
        const gm = GMLOS[svc] || 3.5;
        const planned = Math.max(1, Math.round(rng.lognorm(gm, 0.38)));
        const admitMin = rng.int(9 * 60, 22 * 60);
        const flags = [];
        if (rng.chance(0.08)) flags.push('isolation');
        if (rng.chance(0.015)) flags.push('isolation_cohort');
        if (rng.chance(0.03)) flags.push('sitter');
        if (rng.chance(0.02)) flags.push('telesitter');
        if (svc === 'Hospitalist Medicine' && rng.chance(0.025)) flags.push('comfort_care');
        if (rng.chance(0.005)) flags.push('in_custody');
        const dispo = dispoFor(svc);
        const enc = {
          key: String(encSeq++), unit: u, svc, doc, gm, dispo, flags,
          admitAt: T.at(date, T.fromMinutes(admitMin)).toISOString(),
          admitDate: date,
          room: freeRooms.splice(rng.int(0, freeRooms.length - 1), 1)[0],
          initials: `${rng.pick('ABCDEFGHJKLMNPRSTVW')}${rng.pick('ABCDEFGHJKLMNPRSTVW')}`,
          eddDate: T.addDays(date, planned + (rng.chance(0.2) ? 1 : 0)),
          plannedDate: T.addDays(date, planned),
          edits: [{ at: isoAt(date, admitMin + rng.int(20, 90)), role: 'MD', old: null, new: null }],
          unknown: rng.chance(0.03),
          placement: null, dischargedAt: null, orderAt: null, transportAt: null, enteredAt: null, items: [], narrative: '', owner: null, mrd: false,
          hhStory: u.unit === '4 East' && dispo === 'Home w/ HH',
        };
        enc.edits[0].new = enc.eddDate;
        if (['SNF', 'Rehab', 'LTACH'].includes(dispo)) enc.placement = 'pending';
        active.push(enc);
      }

      const occupied = s2Rows.length;
      const ud = unitDemand(u, date, rng);
      const unitRow = { ...ud, SNAPSHOT_AT: isoAt(date, S2), OCCUPIED_BEDS: occupied };
      day.S2.patients.push(...s2Rows); day.S2.units.push(unitRow);
      day.S1.patients.push(...s1Rows); day.S1.units.push({ ...unitRow, SNAPSHOT_AT: isoAt(date, S1) });
      day.S3.patients.push(...s3Rows);
    }
  }
  return { epoch, anchor, days: out, units };
}

function buildNarrative(enc, items, nurseY, rng) {
  const parts = [];
  const hasOrder = enc.orderAt;
  if (!hasOrder) parts.push(rng.pick(['DC order', 'DC order on AM rounds', 'Order pending MD rounds']));
  for (const it of items) {
    if (it.class === 'referral' && enc.hhStory) parts.push(rng.pick(['HH referral sent, awaiting acceptance', 'HH agency has not accepted yet', 'waiting on home health acceptance']));
    else if (it.class === 'referral') parts.push(`${it.name} in progress`);
    else if (it.class === 'therapy') parts.push(`${it.name} this AM`);
    else if (it.class === 'lab') parts.push(`${it.name} to result`);
    else if (it.class === 'imaging') parts.push(`${it.name} pending`);
    else if (it.class === 'consult') parts.push(`${it.name} to see`);
  }
  if (enc.placement === 'pending') parts.push(rng.pick(['SNF bed offer pending', 'awaiting placement acceptance', 'auth pending']));
  if (enc.placement && enc.placement !== 'pending') parts.push(rng.pick(['bed accepted, ambulance transport', 'placement accepted, needs transport']));
  if (enc.dispo === 'Home' || enc.dispo === 'Home w/ HH') {
    parts.push(rng.pick(['family transportation', 'daughter to pick up after work', 'ride confirmed', 'family pickup after 3', 'scripts to bedside', 'wife driving']));
  }
  if (!parts.length) parts.push(nurseY ? 'Ready, order in AM' : 'Needs MD to see');
  return parts.slice(0, 4).join(', ') + '.';
}

/* ── Cache + public API ─────────────────────────────────────────────────── */

const cache = new Map();   // key → simulation

function keyFor(tenantName, settings, anchor) {
  return `${tenantName}|${anchor}|${settings.pred_source}|${settings.cutoff}|${(settings.units || []).map(u => `${u.unit}:${u.staffed_beds}`).join(',')}|${settings.snapshot_times.S2}`;
}

function getSim(tenantName, settings, anchor) {
  const key = keyFor(tenantName, settings, anchor);
  if (!cache.has(key)) { cache.clear(); cache.set(key, simulate(settings, anchor)); }
  return cache.get(key);
}

const WARMUP_DAYS = 10;

// { S1, S2, S3 } for a date, or null outside the simulated range. `anchor`
// is today; the demo never has tomorrow's snapshot.
function getDay(tenantName, settings, date, anchor, now) {
  const sim = getSim(tenantName, settings, anchor);
  if (date > anchor || date < T.addDays(sim.epoch, WARMUP_DAYS)) return null;
  const d = sim.days.get(date);
  if (!d) return null;
  const kinds = {};
  for (const k of ['S1', 'S2', 'S3']) {
    kinds[k] = { kind: k, date, at: d[k].patients[0]?.SNAPSHOT_AT || (d[k].units && d[k].units[0]?.SNAPSHOT_AT) || null, patients: d[k].patients, units: d[k].units || [] };
  }
  // Today's snapshots land at their scheduled times: no S2 before 08:20, no
  // S1 before 06:00. Today's S3 is exposed after the cutoff so the demo can
  // review the day; a real tenant's arrives nightly.
  if (date === anchor && now instanceof Date) {
    const t = T.fmtTime(now);
    if (t < (settings.snapshot_times.S2 || '08:20')) kinds.S2 = null;
    if (t < (settings.snapshot_times.S1 || '06:00')) kinds.S1 = null;
    if (t < (settings.cutoff || '14:00')) kinds.S3 = null;
  }
  return kinds;
}

module.exports = { getDay, simulate, epochFor, EPOCH, _cache: cache };

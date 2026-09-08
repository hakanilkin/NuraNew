// lib/moveToYes.js
//
// The Ns view — RTDC.md §4 and §3.2 ("Needed-by", "Steps to Yes", "Y at risk").
// Facts and a clock: every step on a card carries the time it has to happen
// by for the patient to leave before 2 PM, derived from the unit's own
// turnaround medians. Nothing here scores; the room decides.

const T = require('./rtdcTime');
const R = require('./rtdcRules');

const DEFAULT_MEDIANS = {
  DO_TO_DC: 180,                     // signed order → departure, minutes
  ORDER_TO_RESULT: { lab: 90, imaging: 180, consult: 240, therapy: 150, referral: 30, procedure: 180, other: 120 },
  ATTENDING_ORDER_TIME: {},          // attending → 'HH:MM'
};

function unitMedians(medians, unit) {
  const m = (medians && medians[unit]) || {};
  return {
    DO_TO_DC: Number.isFinite(m.DO_TO_DC) ? m.DO_TO_DC : DEFAULT_MEDIANS.DO_TO_DC,
    ORDER_TO_RESULT: { ...DEFAULT_MEDIANS.ORDER_TO_RESULT, ...(m.ORDER_TO_RESULT || {}) },
    ATTENDING_ORDER_TIME: m.ATTENDING_ORDER_TIME || {},
  };
}

// Which narrative phrases are the kind of thing an order never captures.
const NARRATIVE_KINDS = [
  { kind: 'transport', match: ['transport', 'ride', 'ambulance', 'dispatch', 'wheelchair van'] },
  { kind: 'family',    match: ['family', 'daughter', 'son', 'wife', 'husband', 'caregiver', 'spouse'] },
  { kind: 'scripts',   match: ['script', 'prescription', 'pharmacy', 'meds'] },
  { kind: 'order',     match: ['dc order', 'discharge order', 'order'] },
  { kind: 'referral',  match: ['referral', 'accept', 'home health', 'hh ', 'tpn', 'dme', 'oxygen'] },
  { kind: 'placement', match: ['snf', 'rehab', 'ltach', 'bed offer', 'placement', 'auth'] },
];

function narrativeKind(phrase) {
  const p = phrase.toLowerCase();
  for (const k of NARRATIVE_KINDS) if (k.match.some(m => p.includes(m))) return k.kind;
  return 'other';
}

// ctx: { date, now: Date, cutoff, order_by, transport_by, pendingItemsAvailable, medians }
function stepsToYes(p, ctx) {
  const m = unitMedians(ctx.medians, p.UNIT);
  const cutoffMin = T.toMinutes(ctx.cutoff || '14:00');
  const nowMin = ctx.now ? ctx.now.getHours() * 60 + ctx.now.getMinutes() : 24 * 60;
  const nowDate = ctx.now ? T.fmtDate(ctx.now) : ctx.date;
  const isToday = nowDate === ctx.date;
  const clock = mins => ({ neededBy: T.fromMinutes(mins), late: isToday ? mins < nowMin : true, floored: isToday && mins < nowMin ? T.fromMinutes(nowMin) : null });

  const orderNeededMin = cutoffMin - m.DO_TO_DC;
  const steps = [];
  const items = R.pendingItems(p);
  const known = items !== null;

  // Pending items, each needing its result before the order can be written.
  if (known) {
    for (const it of items) {
      const lead = m.ORDER_TO_RESULT[it.class] ?? m.ORDER_TO_RESULT.other;
      const s = clock(orderNeededMin - lead);
      const ordered = T.split(it.ordered_at);
      steps.push({
        kind: 'pending', itemClass: it.class, name: it.name || it.class,
        status: it.status || 'pending', orderedAt: ordered ? ordered.time : null,
        ...s, detail: `${it.name || it.class} — ${it.status || 'pending'}${ordered ? `, ordered ${ordered.time}` : ''}`,
      });
    }
  }

  // The discharge order itself, if not written.
  if (!p.DC_ORDER_AT) {
    const s = clock(orderNeededMin);
    const att = p.ATTENDING && m.ATTENDING_ORDER_TIME[p.ATTENDING];
    steps.push({
      kind: 'order', name: 'Discharge order', ...s,
      attendingMedian: att || null,
      detail: att
        ? `Discharge order — not written; ${p.ATTENDING}'s median order time on this unit is ${att}`
        : 'Discharge order — not written',
    });
  }

  // Narrative items nothing in the orders covers (transport, family, scripts).
  // A phrase is "covered" when a pending item is the same kind of thing or
  // shares a real word with it ("HH TPN needs to be arranged" is the TPN
  // referral already on the list, not a fourth step).
  const STOP = new Set(['needs', 'need', 'to', 'be', 'the', 'for', 'and', 'with', 'is', 'are', 'not', 'yet', 'today', 'pending', 'arranged', 'arrange']);
  const tokens = s => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !STOP.has(w));
  const pendingSteps = steps.filter(s => s.kind === 'pending');
  const coveredBy = ph => {
    const kind = narrativeKind(ph);
    const words = new Set(tokens(ph));
    return pendingSteps.some(s => {
      if ((kind === 'referral' || kind === 'placement') && ['referral', 'placement'].includes(s.itemClass)) return true;
      return tokens(s.name).some(w => words.has(w));
    });
  };
  for (const ph of R.narrativePhrases(p.DC_NARRATIVE)) {
    const kind = narrativeKind(ph);
    if (kind === 'order') continue;                             // the order is its own step, or written
    if (coveredBy(ph)) continue;
    const lead = kind === 'transport' ? 60 : kind === 'placement' || kind === 'referral' ? m.DO_TO_DC + 60 : m.DO_TO_DC;
    const s = clock(cutoffMin - lead);
    steps.push({ kind: 'narrative', narrativeKind: kind, name: ph, ...s, narrativeOnly: true,
                 detail: `${ph} — narrative only${known ? ', no matching order' : ''}` });
  }

  steps.sort((a, b) => T.toMinutes(a.neededBy) - T.toMinutes(b.neededBy));
  return { steps, pendingItemsAvailable: known };
}

// Y with a late-looking step (RTDC.md §3.2 "Y at risk").
function yAtRisk(p, ctx) {
  if (p.pred !== 'Y') return [];
  const reasons = [];
  const now = ctx.now;
  const nowDate = now ? T.fmtDate(now) : ctx.date;
  const isToday = nowDate === ctx.date;
  const nowTime = isToday && now ? T.fmtTime(now) : '23:59';
  if (!p.DC_ORDER_AT && nowTime >= (ctx.order_by || '11:00')) reasons.push(`No discharge order by ${ctx.order_by || '11:00'}`);
  const { steps } = stepsToYes(p, ctx);
  const late = steps.find(s => s.kind === 'pending' && s.late);
  if (late) reasons.push(`${late.name} past its needed-by (${late.neededBy})`);
  if (R.isHome(p.EXPECTED_DISPOSITION) && !p.TRANSPORT_REQUESTED_AT && nowTime >= (ctx.transport_by || '12:00')) {
    reasons.push(`Home disposition, no transport request by ${ctx.transport_by || '12:00'}`);
  }
  return reasons;
}

const excessLos = p => (Number.isFinite(Number(p.LOS_DAYS)) && Number.isFinite(Number(p.GMLOS)))
  ? Number(p.LOS_DAYS) - Number(p.GMLOS) : -Infinity;

/* ── Activity chips ────────────────────────────────────────────────────────
 *
 * The same facts as `steps`, plus the ones that are already done, in the order
 * a huddle reads a patient: the order, then readiness, then clinical work,
 * then placement, then the logistics nobody writes an order for. Each chip is
 * done / in progress / blocked, and carries its clock, so a card answers "what
 * is left and by when" at a glance without being read line by line.
 *
 * Nothing here is new information — it is `steps` and the snapshot's own
 * fields, arranged. The board and the card therefore cannot disagree.
 */

const GROUPS = ['order', 'readiness', 'clinical', 'placement', 'logistics'];
const DONE_STATUSES = ['resulted', 'complete', 'completed', 'done', 'accepted', 'authorized'];

const itemGroup = cls => (cls === 'referral' ? 'placement' : 'clinical');
const narrativeGroup = kind =>
  (['transport', 'family', 'scripts'].includes(kind) ? 'logistics'
    : ['referral', 'placement'].includes(kind) ? 'placement' : 'clinical');

// A phrase long enough to be a sentence is not a chip label.
const short = (s, n = 42) => {
  const t = String(s || '').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`;
};

function activityChips(p, steps, ctx) {
  const out = [];
  const push = (group, label, state, at, neededBy, detail) =>
    out.push({ group, label, state, at: at || null, neededBy: neededBy || null, detail: detail || label });

  // 1. The discharge order.
  const order = T.split(p.DC_ORDER_AT);
  const orderStep = steps.find(s => s.kind === 'order');
  if (order) push('order', 'Discharge order placed', 'done', order.time, null, `Signed ${order.time}`);
  else if (orderStep) push('order', 'No discharge order', orderStep.late ? 'blocked' : 'progress', null, orderStep.neededBy, orderStep.detail);

  // 2. Readiness, as the site records it.
  if (R.truthy(p.MRD)) push('readiness', 'Medically ready', 'done');
  else push('readiness', 'Awaiting medical clearance', 'progress', null, null, 'MRD not recorded');
  if (R.truthy(p.ORD)) push('readiness', 'Overall ready', 'done');

  // 3. Everything still outstanding, from the steps that carry the clocks.
  for (const s of steps) {
    if (s.kind === 'order') continue;
    if (s.kind === 'pending') {
      const done = DONE_STATUSES.includes(String(s.status || '').toLowerCase());
      push(itemGroup(s.itemClass), short(s.name), done ? 'done' : s.late ? 'blocked' : 'progress',
        done ? s.orderedAt : null, done ? null : s.neededBy, s.detail);
    } else {
      push(narrativeGroup(s.narrativeKind), short(s.name), s.late ? 'blocked' : 'progress', null, s.neededBy, s.detail);
    }
  }

  // 4. Facts no step covers: placement acceptance and the transport request.
  if (R.isPlacement(p.EXPECTED_DISPOSITION)) {
    const st = String(p.PLACEMENT_STATUS || '').toLowerCase();
    if (['accepted', 'authorized'].includes(st)) push('placement', 'Placement accepted', 'done', null, null, `Placement ${st}`);
    else if (st === 'pending') push('placement', 'Placement pending', 'progress', null, null, 'Bed offer not accepted yet');
    else push('placement', 'Placement not started', 'blocked', null, null, 'No placement status recorded');
  }
  if (R.isHome(p.EXPECTED_DISPOSITION)) {
    const tr = T.split(p.TRANSPORT_REQUESTED_AT);
    const covered = out.some(c => c.group === 'logistics');
    if (tr) push('logistics', 'Transport arranged', 'done', tr.time, null, `Requested ${tr.time}`);
    else if (!covered) {
      const by = ctx.transport_by || '12:00';
      const late = ctx.now && T.fmtDate(ctx.now) === ctx.date ? T.fmtTime(ctx.now) >= by : true;
      push('logistics', 'Transport pending', late ? 'blocked' : 'progress', null, by, 'No transport request');
    }
  }

  return out.sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group));
}

// One unit's Move-to-Yes lists. `patients` already carry pred + candidates.
function buildUnitView(patients, ctx) {
  const ruleRank = new Map((ctx.rules || []).map((r, i) => [r.rule_key, i]));
  const ns = patients.filter(p => p.pred === 'N').map(p => {
    const { steps, pendingItemsAvailable } = stepsToYes(p, ctx);
    return { ...p, steps, pendingItemsAvailable, chips: activityChips(p, steps, ctx), excessLos: excessLos(p) };
  });
  ns.sort((a, b) => {
    const ra = a.candidates.length ? ruleRank.get(a.candidates[0].ruleKey) ?? 999 : 1000;
    const rb = b.candidates.length ? ruleRank.get(b.candidates[0].ruleKey) ?? 999 : 1000;
    if (ra !== rb) return ra - rb;
    return b.excessLos - a.excessLos;
  });
  const ys = patients.filter(p => p.pred === 'Y').map(p => {
    const { steps, pendingItemsAvailable } = stepsToYes(p, ctx);
    return { ...p, steps, pendingItemsAvailable, chips: activityChips(p, steps, ctx), riskReasons: yAtRisk(p, ctx) };
  });
  // Patients Epic has no usable discharge date for: the EDD field is empty, or
  // it is flagged Unknown. They are not on the list and are never scored — but
  // a huddle still wants to see them, because an inpatient with no expected
  // discharge date is exactly the Epic-fidelity gap RTDC exists to close. A
  // patient whose EDD is simply further out is not on this list; they have a
  // date, and it is not today. Patients no rule would suggest anyway (comfort
  // care, cohort isolation, custody, ICU) stay out — asked of the one
  // definition of exclusion, with the EDD flag itself set aside.
  const noEddCandidate = p => p.pred == null
    && (p.PRED_UNKNOWN || !p.PRED_SOURCE_DATE)
    && !R.excluded({ ...p, PRED_UNKNOWN: false });
  const noEdd = patients.filter(noEddCandidate).map(p => {
    const { steps, pendingItemsAvailable } = stepsToYes(p, ctx);
    return { ...p, steps, pendingItemsAvailable, chips: activityChips(p, steps, ctx), excessLos: excessLos(p) };
  }).sort((a, b) => b.excessLos - a.excessLos);
  return {
    ns,
    ysAtRisk: ys.filter(y => y.riskReasons.length),
    ysRemaining: ys.filter(y => !y.riskReasons.length),
    noEdd,
  };
}

module.exports = { stepsToYes, yAtRisk, buildUnitView, activityChips, unitMedians, narrativeKind, DEFAULT_MEDIANS, excessLos, GROUPS };

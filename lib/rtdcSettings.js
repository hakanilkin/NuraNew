// lib/rtdcSettings.js
//
// RTDC configuration: the defaults, the tenant's overrides from
// config/tenantColumns.json (params.rtdc), and the admin's edits from the
// store, merged in that order. Everything downstream — prediction derivation,
// the rule table, the clocks, the board's unit order — reads from here so a
// setting has exactly one meaning. See RTDC.md §3, §5, §7.3.

const { getParam, getFeatures } = require('../utils/tenantColumns');

// ── The rule table (RTDC.md §5) ──────────────────────────────────────────────
// Order is rule order: the Move-to-Yes list sorts candidates by the first rule
// that fired, and EXCLUDE is evaluated before any of them. Reason text prints
// on the report verbatim, so it is written for the room, not for a log.
const DEFAULT_RULES = [
  { rule_key: 'ORDER_WRITTEN', enabled: true, params: {}, keywords: [],
    reason_text: 'Discharge order already signed — the physician has released this patient; what remains is transport or a narrative-only step.' },
  { rule_key: 'MRD_HOME', enabled: true, params: {}, keywords: [],
    reason_text: 'Medically ready, home disposition, nothing clinical pending — a candidate for "Yes, with plan".' },
  { rule_key: 'EDD_SLIPPED', enabled: true, params: {},
    keywords: ['order', 'transport', 'ride', 'family', 'script', 'prescription', 'pharmacy', 'pick up', 'pickup'],
    reason_text: 'EDD is today but after 2 PM, and the only narrative items are order / transport / family / scripts — convertible to before 2 PM.' },
  { rule_key: 'PLACEMENT_SECURED', enabled: true, params: {}, keywords: [],
    reason_text: 'Placement accepted — the hard part is done; what remains is order and transport timing.' },
  { rule_key: 'LOS_EXCESS', enabled: true, params: { los_delta_days: 1 }, keywords: [],
    reason_text: 'Past GMLOS by a day or more with a home disposition — the highest-value discharge on a short unit.' },
  { rule_key: 'SINGLE_STEP', enabled: true, params: {}, keywords: [],
    reason_text: 'Exactly one pending item and it can be done today — one phone call away from Y.' },
  { rule_key: 'EXCLUDE', enabled: true, params: {}, keywords: [],
    reason_text: 'Never suggested: comfort care, cohort isolation, EDD Unknown, in custody, or ICU level of care.' },
];

// Barrier codes are a fixed list (RTDC.md §6 "confirmed in one click"). The
// bin is the default suggestion for the improvement backlog; a tracker row can
// override it.
const BARRIER_CODES = [
  { code: 'LATE_ORDER',      label: 'Late discharge order',       bin: 'Epic adoption' },
  { code: 'PLACEMENT',       label: 'Placement not secured',      bin: 'process' },
  { code: 'TRANSPORT',       label: 'Transport / ride',           bin: 'process' },
  { code: 'PENDING_RESULT',  label: 'Pending lab / imaging',      bin: 'Epic config' },
  { code: 'PENDING_CONSULT', label: 'Consult not complete',       bin: 'process' },
  { code: 'THERAPY_EVAL',    label: 'Therapy evaluation',         bin: 'process' },
  { code: 'REFERRAL',        label: 'Referral / HH acceptance',   bin: 'process' },
  { code: 'PHARMACY',        label: 'Scripts / meds to bed',      bin: 'Epic config' },
  { code: 'FAMILY',          label: 'Family / caregiver',         bin: 'process' },
  { code: 'OTHER',           label: 'Other',                      bin: 'process' },
];

const EFFECTIVE_BED_REASONS = [
  'Staffing', 'Isolation / cohort', 'Room out of service', '1:1 sitter', 'Equipment', 'Other',
];

// Ancillary view grouping: pending-item class × name keyword → service line.
const ANCILLARY_SERVICES = [
  { service: 'PT/OT',          match: ['pt ', 'ot ', 'physical therapy', 'occupational', 'therapy eval'] },
  { service: 'Echo/Vascular',  match: ['echo', 'vascular', 'duplex', 'carotid'] },
  { service: 'Pharmacy',       match: ['script', 'prescription', 'pharmacy', 'meds to bed'] },
  { service: 'CT/MRI',         match: ['ct ', 'mri', 'ct scan'] },
  { service: 'Ultrasound',     match: ['ultrasound', 'us '] },
  { service: 'IR',             match: ['ir ', 'interventional', 'picc'] },
  { service: 'Lab',            match: ['lab', 'cbc', 'bmp', 'inr', 'troponin', 'culture', 'draw'] },
  { service: 'Respiratory',    match: ['respiratory', 'oxygen', 'o2 ', 'pft'] },
  { service: 'Placement',      match: ['snf', 'rehab', 'ltach', 'placement', 'referral', 'home health', 'hh '] },
  { service: 'Transport',      match: ['transport', 'ride', 'ambulance', 'dispatch'] },
];

const DEFAULT_SETTINGS = {
  source: 'sql',                    // 'sql' (DS_RTDC_Snapshot in the tenant DB) | 'synthetic' (demo)
  pred_source: 'EDD_DATE',          // FLAG | EDD_TIME | EDD_DATE  (RTDC.md §3.1)
  list_horizon_days: 1,             // EDD within this many days of today is an N on the list
  snapshot_times: { S1: '06:00', S2: '08:20', S3: 'nightly' },
  stale_hours: 3,
  cutoff: '14:00',                  // the "by 2 PM" line
  order_by: '11:00',                // Y at risk: no DC order by this time
  transport_by: '12:00',            // Y at risk: home dispo, no transport request by this time
  hospital: null,                   // single-hospital tenants; null shows a selector
  huddle_order: [],                 // flow-coordinator script order; unknown units follow alphabetically
  units: [],                        // [{ unit, level_of_care, staffed_beds }]
  effective_bed_reasons: EFFECTIVE_BED_REASONS,
  barrier_codes: BARRIER_CODES,
  ancillary_services: ANCILLARY_SERVICES,
  recurrence_operational: 3,        // same unit + code ≥ N of last 5 weekdays → operational fix
  recurrence_pi: 6,                 // ≥ N in window → PI initiative
  min_rule_firings: 10,             // below this a rule shows n, never a rate
};

function mergeRules(base, overrides) {
  if (!Array.isArray(overrides) || !overrides.length) return base.map(r => ({ ...r }));
  const byKey = new Map(overrides.map(o => [o.rule_key, o]));
  return base.map(r => {
    const o = byKey.get(r.rule_key);
    if (!o) return { ...r };
    return {
      ...r,
      enabled: o.enabled == null ? r.enabled : !!o.enabled,
      params: { ...r.params, ...(o.params || {}) },
      keywords: Array.isArray(o.keywords) ? o.keywords.map(String) : r.keywords,
      reason_text: o.reason_text ? String(o.reason_text) : r.reason_text,
    };
  });
}

// storeOverrides: { settings?: {...}, rules?: [...] } from lib/rtdcStore.
function getRtdcSettings(tenantName, storeOverrides = {}) {
  const tenantParams = getParam(tenantName, 'rtdc') || {};
  const s = { ...DEFAULT_SETTINGS, ...tenantParams, ...(storeOverrides.settings || {}) };
  s.snapshot_times = { ...DEFAULT_SETTINGS.snapshot_times, ...(tenantParams.snapshot_times || {}),
                       ...((storeOverrides.settings || {}).snapshot_times || {}) };
  s.units = Array.isArray(s.units) ? s.units : [];
  s.huddle_order = Array.isArray(s.huddle_order) ? s.huddle_order : [];
  s.rules = mergeRules(DEFAULT_RULES, storeOverrides.rules);
  const f = getFeatures(tenantName);
  s.features = { rtdc: !!f.rtdc, rtdc_pending_items: !!f.rtdc_pending_items };
  return s;
}

// Board order: the configured huddle order first, then anything else A–Z.
function huddleSort(units, order) {
  const rank = new Map((order || []).map((u, i) => [u, i]));
  return [...units].sort((a, b) => {
    const ra = rank.has(a) ? rank.get(a) : 1e9;
    const rb = rank.has(b) ? rank.get(b) : 1e9;
    return ra - rb || String(a).localeCompare(String(b));
  });
}

module.exports = {
  DEFAULT_RULES, DEFAULT_SETTINGS, BARRIER_CODES, EFFECTIVE_BED_REASONS, ANCILLARY_SERVICES,
  getRtdcSettings, mergeRules, huddleSort,
};

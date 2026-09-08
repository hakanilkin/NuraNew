// lib/rtdcStore.js
//
// DEMO-ONLY persistence for what Nura owns in RTDC: effective-bed entries,
// confirmed barriers, unit-reviewed marks, barrier-tracker status, the
// improvement backlog, and the admin's rule/setting edits.
//
// Same posture as lib/openTimeStore.js: one JSON file, keyed by TenantID, so
// the loop is demoable with no database. In production these are the NuraOps
// tables in RTDC.md §8 (rtdc_day_unit, rtdc_barrier, rtdc_improvement,
// rtdc_rule …), scoped by tenant_id. Encounter keys only — never a name or MRN.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, '..', '.rtdc-demo.json');

let db = load();

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch { return { tenants: {} }; }
}

function save() {
  try { fs.writeFileSync(FILE, JSON.stringify(db, null, 2)); }
  catch (e) { console.error('rtdcStore save error:', e.message); }
}

function tenant(tid) {
  const key = String(tid);
  if (!db.tenants[key]) {
    db.tenants[key] = { dayUnits: {}, barriers: {}, reviewed: {}, trackers: {}, improvements: [], rules: null, settings: {} };
  }
  const t = db.tenants[key];
  t.dayUnits ||= {}; t.barriers ||= {}; t.reviewed ||= {}; t.trackers ||= {}; t.improvements ||= []; t.settings ||= {};
  return t;
}

const k2 = (a, b) => `${a}|${b}`;

/* ── Effective beds (the only meeting-time write) ─────────────────────── */

function getDayUnit(tid, date, unit) { return tenant(tid).dayUnits[k2(date, unit)] || null; }
function listDayUnits(tid, date) {
  const t = tenant(tid);
  return Object.values(t.dayUnits).filter(r => r.date === date);
}
function listDayUnitsRange(tid, from, to) {
  return Object.values(tenant(tid).dayUnits).filter(r => r.date >= from && r.date <= to);
}
function setEffectiveBeds(tid, { date, unit, effective_beds, available, reason, note, by }) {
  const t = tenant(tid);
  const row = {
    date, unit, effective_beds: Number(effective_beds),
    available: Number.isFinite(Number(available)) ? Number(available) : null,
    adjustment: Number.isFinite(Number(available)) ? Number(effective_beds) - Number(available) : null,
    adjustment_reason: reason || null, note: note ? String(note).slice(0, 300) : null,
    adjusted_by: by || null, adjusted_at: new Date().toISOString(),
  };
  t.dayUnits[k2(date, unit)] = row;
  save();
  return row;
}
// Status is persisted per unit-day so the heatmap reads what the room saw.
function setDayUnitStatus(tid, date, unit, status) {
  const t = tenant(tid);
  const key = k2(date, unit);
  const row = t.dayUnits[key] || { date, unit };
  if (row.status !== status) { row.status = status; t.dayUnits[key] = row; save(); }
  return row;
}

/* ── Barrier confirmation (Review tab) ─────────────────────────────────── */

function getBarriers(tid, date) {
  const out = {};
  for (const [key, v] of Object.entries(tenant(tid).barriers)) if (key.startsWith(`${date}|`)) out[key.slice(date.length + 1)] = v;
  return out;
}
function confirmBarrier(tid, { date, encounterKey, code, bin, by }) {
  const t = tenant(tid);
  const row = { date, encounter_key: String(encounterKey), code, bin: bin || null, inferred: false,
                confirmed_by: by || null, confirmed_at: new Date().toISOString() };
  t.barriers[k2(date, encounterKey)] = row;
  save();
  return row;
}

/* ── Units reviewed ────────────────────────────────────────────────────── */

function markReviewed(tid, { date, unit, by }) {
  const t = tenant(tid);
  const row = { date, unit, by: by || null, at: new Date().toISOString() };
  t.reviewed[k2(date, unit)] = row;
  save();
  return row;
}
function listReviewed(tid, date) {
  return Object.values(tenant(tid).reviewed).filter(r => r.date === date);
}

/* ── Barrier tracker status + improvement backlog ──────────────────────── */

const TRACKER_STATUSES = ['open', 'operational fix', 'PI initiative', 'resolved'];

function getTracker(tid, unit, code) { return tenant(tid).trackers[k2(unit, code)] || null; }
function setTracker(tid, { unit, code, status, bin, pilot_ref, by }) {
  const t = tenant(tid);
  const cur = t.trackers[k2(unit, code)] || { unit, code };
  const row = { ...cur,
    status: TRACKER_STATUSES.includes(status) ? status : (cur.status || 'open'),
    bin: bin === undefined ? (cur.bin || null) : bin,
    pilot_ref: pilot_ref === undefined ? (cur.pilot_ref || null) : (pilot_ref ? String(pilot_ref).slice(0, 120) : null),
    updated_by: by || null, updated_at: new Date().toISOString() };
  t.trackers[k2(unit, code)] = row;
  save();
  return row;
}
function listTrackers(tid) { return Object.values(tenant(tid).trackers); }

function addImprovement(tid, d) {
  const t = tenant(tid);
  const row = { id: crypto.randomUUID(), kind: d.kind || 'archetype', unit: d.unit || null, code: d.code || null,
    archetype: d.archetype || null, sentence: d.sentence || null, bin: d.bin || null,
    status: 'queued', created_by: d.by || null, created_at: new Date().toISOString(), pilot_ref: null };
  t.improvements.unshift(row);
  save();
  return row;
}
function listImprovements(tid) { return tenant(tid).improvements; }

/* ── Admin: rules and settings overrides ───────────────────────────────── */

function getOverrides(tid) {
  const t = tenant(tid);
  return { rules: t.rules, settings: t.settings };
}
function setRules(tid, rules) {
  const t = tenant(tid);
  t.rules = Array.isArray(rules) ? rules.map(r => ({
    rule_key: String(r.rule_key), enabled: r.enabled !== false,
    params: r.params && typeof r.params === 'object' ? r.params : {},
    keywords: Array.isArray(r.keywords) ? r.keywords.map(String) : undefined,
    reason_text: r.reason_text ? String(r.reason_text).slice(0, 400) : undefined,
  })) : null;
  save();
  return t.rules;
}
const SETTING_KEYS = ['pred_source', 'list_horizon_days', 'huddle_order', 'effective_bed_reasons', 'snapshot_times', 'cutoff', 'order_by', 'transport_by'];
function setSettings(tid, s) {
  const t = tenant(tid);
  const next = { ...t.settings };
  for (const k of SETTING_KEYS) if (s && s[k] !== undefined) next[k] = s[k];
  t.settings = next;
  save();
  return t.settings;
}

// Tests reset the file between cases.
function _resetForTests(file) {
  db = { tenants: {} };
  if (file) { try { fs.unlinkSync(file); } catch { /* ignore */ } }
}

module.exports = {
  getDayUnit, listDayUnits, listDayUnitsRange, setEffectiveBeds, setDayUnitStatus,
  getBarriers, confirmBarrier, markReviewed, listReviewed,
  TRACKER_STATUSES, getTracker, setTracker, listTrackers, addImprovement, listImprovements,
  getOverrides, setRules, setSettings, SETTING_KEYS, _resetForTests, FILE,
};

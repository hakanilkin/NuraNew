// lib/rtdcSource.js
//
// Where RTDC snapshots come from. Two backends behind one shape:
//
//   sql        DS_RTDC_Snapshot / DS_RTDC_UnitSnapshot in the tenant DB — the
//              Reporting Workbench extract (Phase 1) or the FHIR bulk export
//              (Phase 2) lands there. scripts/rtdc/create_rtdc_snapshot_tables.sql
//              is the DDL; columns are the §2.1 / §2.2 logical names.
//   synthetic  lib/rtdcSynthetic.js — the demo tenant.
//
// Every read is tenant-scoped through the caller's getTenantPool; nothing
// here is shared across tenants. JSON columns are returned as strings by SQL
// and as objects by the generator — consumers parse either.

const T = require('./rtdcTime');
const synthetic = require('./rtdcSynthetic');

const JSON_COLS = ['PRED_EDIT_LOG', 'DC_MILESTONES', 'PENDING_ITEMS', 'FLAGS', 'PENDING_BED_REQUESTS_IN'];
const DATE_COLS = ['PRED_SOURCE_DATE'];
const TIME_COLS = ['PRED_SOURCE_TIME'];

// mssql hands back Date objects for DATE/DATETIME/TIME; the libs want
// 'YYYY-MM-DD' and 'HH:MM' for the two EDD columns and leave the rest alone.
function normalizeRow(r) {
  const o = { ...r };
  for (const c of DATE_COLS) if (o[c] instanceof Date) o[c] = T.fmtDate(o[c]);
  for (const c of TIME_COLS) if (o[c] instanceof Date) o[c] = `${T.pad(o[c].getUTCHours())}:${T.pad(o[c].getUTCMinutes())}`;
  for (const c of JSON_COLS) if (typeof o[c] === 'string') { try { o[c] = JSON.parse(o[c]); } catch { /* leave as string; consumers cope */ } }
  if (o.SNAPSHOT_DATE instanceof Date) o.SNAPSHOT_DATE = T.fmtDate(o.SNAPSHOT_DATE);
  return o;
}

async function sqlRange(ctx, from, to) {
  const db = await ctx.getTenantPool(ctx.tenantId);
  const q = db.request();
  q.input('from', ctx.sql.Date, from);
  q.input('to', ctx.sql.Date, to);
  const pts = await q.query(`
    SELECT * FROM DS_RTDC_Snapshot
    WHERE SNAPSHOT_DATE >= @from AND SNAPSHOT_DATE <= @to
  `);
  const q2 = db.request();
  q2.input('from', ctx.sql.Date, from);
  q2.input('to', ctx.sql.Date, to);
  const units = await q2.query(`
    SELECT * FROM DS_RTDC_UnitSnapshot
    WHERE SNAPSHOT_DATE >= @from AND SNAPSHOT_DATE <= @to
  `);
  const days = new Map();
  const dayFor = date => {
    if (!days.has(date)) days.set(date, { S1: null, S2: null, S3: null });
    return days.get(date);
  };
  const kindFor = (day, date, kind, at) => {
    if (!day[kind]) day[kind] = { kind, date, at: at || null, patients: [], units: [] };
    return day[kind];
  };
  for (const raw of pts.recordset) {
    const r = normalizeRow(raw);
    const kind = String(r.SNAPSHOT_KIND || 'S2').toUpperCase();
    if (!['S1', 'S2', 'S3'].includes(kind)) continue;
    kindFor(dayFor(r.SNAPSHOT_DATE), r.SNAPSHOT_DATE, kind, r.SNAPSHOT_AT).patients.push(r);
  }
  for (const raw of units.recordset) {
    const r = normalizeRow(raw);
    const kind = String(r.SNAPSHOT_KIND || 'S2').toUpperCase();
    if (!['S1', 'S2', 'S3'].includes(kind)) continue;
    kindFor(dayFor(r.SNAPSHOT_DATE), r.SNAPSHOT_DATE, kind, r.SNAPSHOT_AT).units.push(r);
  }
  return days;
}

// ctx: { tenantName, tenantId, settings, getTenantPool, sql, today }
async function loadRange(ctx, from, to) {
  if (ctx.settings.source === 'synthetic') {
    const days = new Map();
    for (const d of T.eachDay(from, to)) {
      const got = synthetic.getDay(ctx.tenantName, ctx.settings, d, ctx.today, ctx.now);
      if (got) days.set(d, got);
    }
    return days;
  }
  return sqlRange(ctx, from, to);
}

async function loadDay(ctx, date) {
  const days = await loadRange(ctx, date, date);
  return days.get(date) || null;
}

module.exports = { loadRange, loadDay, normalizeRow };

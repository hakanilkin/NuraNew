const express = require('express');

const T = require('../lib/rtdcTime');
const D = require('../lib/rtdcDay');
const M = require('../lib/rtdcMismatch');
const Y = require('../lib/moveToYes');
const O = require('../lib/rtdcOutcome');
const A = require('../lib/rtdcArchetype');
const R = require('../lib/rtdcRules');
const store = require('../lib/rtdcStore');
const { huddleSort } = require('../lib/rtdcSettings');

// RTDC — Right-Time, Not Real-Time. See RTDC.md.
//
// Epic captures; Nura reckons. Every read here is a snapshot the tenant's
// pipeline already landed (or, for the demo tenant, the synthetic source);
// the only meeting-time write is a unit's effective beds, and every write goes
// to Nura's own store — never to a tenant table, never to Epic.
module.exports = function rtdcRoutes(getTenantPool, sql, requireTenant, requireAdmin) {
  const router = express.Router();
  router.use(requireTenant);

  const deps = { getTenantPool, sql };
  const isProd = process.env.NODE_ENV === 'production';
  const isAdmin = requireAdmin || ((req, res, next) => (req.session && req.session.isAdmin ? next() : res.status(403).json({ error: 'Forbidden' })));

  // Build the tenant context, honouring a `now` override outside production
  // so "before 2 PM" states can be exercised.
  function ctxFor(req) {
    let now;
    if (!isProd && req.query.now) { const d = new Date(req.query.now); if (!Number.isNaN(d.getTime())) now = d; }
    return D.makeContext(req, deps, { now });
  }

  // The whole group is gated by the tenant feature flag (RTDC.md §7).
  router.use((req, res, next) => {
    const ctx = ctxFor(req);
    if (!ctx.settings.features.rtdc) return res.status(404).json({ error: 'RTDC is not enabled for this client' });
    req.rtdc = ctx;
    next();
  });

  const dateOr = (v, fallback) => (T.isValidDate(v) ? v : fallback);
  const hospitalOf = (req) => {
    const s = req.rtdc.settings;
    if (s.hospital) return s.hospital;                         // single-hospital tenant: fixed
    const h = req.query.hospital;
    return typeof h === 'string' && h.length <= 100 ? h : null;
  };
  const unitOf = v => (typeof v === 'string' && v.length <= 100 ? v : null);
  const rangeOf = (req) => {
    const to = dateOr(req.query.to, req.rtdc.today);
    const from = dateOr(req.query.from, T.addDays(to, -27));
    return from <= to ? { from, to } : { from: to, to: from };
  };
  const fail = (req, res, err) => {
    console.error(`${req.method} ${req.originalUrl} error:`, err.message);
    res.status(500).json({ error: 'Internal server error' });
  };

  // ── Meta ────────────────────────────────────────────────────────────────
  router.get('/meta', (req, res) => {
    const s = req.rtdc.settings;
    res.json({
      today: req.rtdc.today,
      features: s.features,
      settings: {
        source: s.source, pred_source: s.pred_source, list_horizon_days: s.list_horizon_days,
        snapshot_times: s.snapshot_times, cutoff: s.cutoff, order_by: s.order_by, transport_by: s.transport_by,
        hospital: s.hospital, huddle_order: s.huddle_order, units: s.units,
        effective_bed_reasons: s.effective_bed_reasons, barrier_codes: s.barrier_codes,
        min_rule_firings: s.min_rule_firings,
      },
      rules: s.rules.map(r => ({ rule_key: r.rule_key, enabled: r.enabled, reason_text: r.reason_text })),
    });
  });

  // ── Board ───────────────────────────────────────────────────────────────
  // GET /api/rtdc/board?date=&hospital=
  router.get('/board', async (req, res) => {
    const ctx = req.rtdc;
    try {
      const date = dateOr(req.query.date, ctx.today);
      const hospital = hospitalOf(req);
      let day = await D.buildDay(ctx, date, { hospital, persist: true });
      let noSnapshot = false, shownDate = date;
      // Opened before today's S2 landed: show yesterday greyed, say so.
      if (!day.hasS2 && date === ctx.today) {
        noSnapshot = true; shownDate = T.addDays(date, -1);
        day = await D.buildDay(ctx, shownDate, { hospital });
      }
      const yesterday = await D.yesterdayStrip(ctx, date, hospital);
      res.json({
        date, shownDate, isToday: date === ctx.today, noSnapshot, hasS2: day.hasS2, stale: day.stale,
        s2At: day.s2At, s2Time: ctx.settings.snapshot_times.S2, staleHours: ctx.settings.stale_hours,
        readOnly: date < ctx.today || noSnapshot,
        units: day.statuses ? day.statuses.rows : [], house: day.statuses ? day.statuses.house : null,
        reviewed: day.reviewed.map(r => r.unit), yesterday,
        hospitals: day.s2 ? [...new Set(day.s2.units.map(u => u.HOSPITAL).filter(Boolean))] : [],
        reasons: ctx.settings.effective_bed_reasons,
      });
    } catch (err) { fail(req, res, err); }
  });

  // POST /api/rtdc/unit/:unit/effective-beds  { date, effective_beds, reason, note? }
  router.post('/unit/:unit/effective-beds', async (req, res) => {
    const ctx = req.rtdc;
    try {
      const unit = unitOf(req.params.unit);
      const b = req.body || {};
      const date = dateOr(b.date, ctx.today);
      const beds = Number(b.effective_beds);
      if (!unit) return res.status(400).json({ error: 'unit is required' });
      if (!Number.isInteger(beds) || beds < 0 || beds > 500) return res.status(400).json({ error: 'effective_beds must be a whole number' });
      if (date < ctx.today) return res.status(400).json({ error: 'Past days are read-only' });
      const reasons = ctx.settings.effective_bed_reasons;
      const reason = reasons.includes(b.reason) ? b.reason : null;
      const day = await D.buildDay(ctx, date, { hospital: hospitalOf(req) });
      const row = day.statuses && day.statuses.rows.find(r => r.unit === unit);
      if (!row) return res.status(404).json({ error: 'Unit not on today\'s board' });
      if (beds !== row.available && !reason) return res.status(400).json({ error: 'A reason is required when effective beds differ from available' });
      store.setEffectiveBeds(ctx.tenantId, { date, unit, effective_beds: beds, available: row.available, reason, note: b.note, by: ctx.user });
      const after = await D.buildDay(ctx, date, { hospital: hospitalOf(req), persist: true });
      res.json({ unit: after.statuses.rows.find(r => r.unit === unit), house: after.statuses.house });
    } catch (err) { fail(req, res, err); }
  });

  // ── Move to Yes / the discharge priority list ───────────────────────────
  //
  // One builder behind both shapes: a single unit (the Board row's click
  // target) and every unit grouped by status (the huddle's cross-unit list).
  // The two views are the same patients, ranked the same way, so a unit's list
  // cannot say something different depending on how you opened it.

  async function dischargeList(ctx, { date, hospital, units, status }) {
    const day = await D.buildDay(ctx, date, { hospital });
    if (!day.hasS2) return { date, hasS2: false, units: [] };

    const medians = await D.medians(ctx, date);
    // A past date is a replay of that day's S2, so its clocks read as of S2.
    const mctx = {
      date, now: date === ctx.today ? ctx.now : T.at(date, ctx.settings.snapshot_times.S2 || '08:20'),
      cutoff: ctx.settings.cutoff, order_by: ctx.settings.order_by, transport_by: ctx.settings.transport_by,
      medians, rules: ctx.rules, pendingItemsAvailable: ctx.settings.features.rtdc_pending_items,
    };

    // Rule conversion over the last 30 days, per unit — the evidence behind
    // every escalation chip. Computed once for every unit on the board.
    const trailing = await D.scoreRange(ctx, T.addDays(date, -30), T.addDays(date, -1), { hospital });
    const conv = O.conversionTable(trailing.inRange, { minFirings: 1 });
    const conversion30 = {};
    for (const r of conv.byUnit) {
      (conversion30[r.unit] ||= {})[r.ruleKey] = { fired: r.fired, converted: r.converted, pct: r.conversionPct };
    }

    const pendingOk = ctx.settings.features.rtdc_pending_items;
    const card = p => ({
      encounterKey: p.ENCOUNTER_KEY, unit: p.UNIT, roomBed: p.ROOM_BED, initials: p.PATIENT_INITIALS,
      // The masked tail of the encounter key: enough for a nurse to match this
      // row against their own list, and never an identifier on its own.
      csnTail: String(p.ENCOUNTER_KEY || '').slice(-4) || null,
      attending: p.ATTENDING, service: p.HOSPITAL_SERVICE, dispo: p.EXPECTED_DISPOSITION,
      levelOfCare: p.LEVEL_OF_CARE, hospital: p.HOSPITAL || null,
      losDays: p.LOS_DAYS, gmlos: p.GMLOS, excessLos: Number.isFinite(p.excessLos) ? Math.round(p.excessLos * 10) / 10 : null,
      eddDate: p.PRED_SOURCE_DATE || null, eddTime: p.PRED_SOURCE_TIME || null, eddUnknown: !!p.PRED_UNKNOWN,
      pred: p.pred, predMode: p.predMode,
      mrd: R.truthy(p.MRD), ord: R.truthy(p.ORD), dcOrderAt: T.split(p.DC_ORDER_AT)?.time || null,
      narrative: p.DC_NARRATIVE || '', ownerRole: p.NARRATIVE_OWNER_ROLE || null,
      placementStatus: p.PLACEMENT_STATUS || null, transportRequestedAt: T.split(p.TRANSPORT_REQUESTED_AT)?.time || null,
      flags: R.flags(p), excluded: p.excluded, candidates: p.candidates,
      steps: pendingOk ? p.steps : p.steps.filter(s => s.kind !== 'pending'),
      chips: pendingOk ? p.chips : p.chips.filter(c => c.group !== 'clinical'),
      pendingItemsAvailable: pendingOk && p.pendingItemsAvailable,
      riskReasons: p.riskReasons || [],
    });

    const wanted = (units && units.length ? day.statuses.rows.filter(r => units.includes(r.unit))
      : day.statuses.rows).filter(r => !status || r.color === status);

    const groups = wanted.map(header => {
      const view = Y.buildUnitView(day.s2.patients.filter(p => p.UNIT === header.unit), mctx);
      return {
        unit: header.unit, header, medians: Y.unitMedians(medians, header.unit),
        ns: view.ns.map(card), ysAtRisk: view.ysAtRisk.map(card),
        ysRemaining: view.ysRemaining.map(card), noEdd: view.noEdd.map(card),
      };
    });

    return {
      date, hasS2: true, s2At: day.s2At, readOnly: date < ctx.today,
      units: groups, conversion30, pendingItemsAvailable: pendingOk,
      board: day.statuses.rows.map(r => ({ unit: r.unit, status: r.status, color: r.color, ns: r.ns, candidates: r.candidates })),
      rules: ctx.rules.filter(r => r.enabled).map(r => ({ rule_key: r.rule_key, reason_text: r.reason_text })),
    };
  }

  // GET /api/rtdc/unit/:unit/ns?date=&hospital=   — one unit, flat (the §8 route)
  router.get('/unit/:unit/ns', async (req, res) => {
    const ctx = req.rtdc;
    try {
      const unit = unitOf(req.params.unit);
      const date = dateOr(req.query.date, ctx.today);
      if (!unit) return res.status(400).json({ error: 'unit is required' });
      const list = await dischargeList(ctx, { date, hospital: hospitalOf(req), units: [unit] });
      if (!list.hasS2) return res.json({ unit, date, hasS2: false, ns: [], ysAtRisk: [], ysRemaining: [], noEdd: [] });
      const g = list.units[0] || { header: null, ns: [], ysAtRisk: [], ysRemaining: [], noEdd: [], medians: {} };
      res.json({
        unit, date, hasS2: true, s2At: list.s2At, readOnly: list.readOnly, header: g.header,
        units: list.board, ns: g.ns, ysAtRisk: g.ysAtRisk, ysRemaining: g.ysRemaining, noEdd: g.noEdd,
        pendingItemsAvailable: list.pendingItemsAvailable, medians: g.medians,
        conversion30: list.conversion30[unit] || {}, rules: list.rules,
      });
    } catch (err) { fail(req, res, err); }
  });

  // GET /api/rtdc/discharges?date=&hospital=&unit=&status=
  // The huddle's list: every unit the filter allows, grouped, ranked, with the
  // pending activities on each patient.
  router.get('/discharges', async (req, res) => {
    const ctx = req.rtdc;
    try {
      const date = dateOr(req.query.date, ctx.today);
      const unit = unitOf(req.query.unit);
      const status = ['red', 'even', 'green'].includes(req.query.status) ? req.query.status : null;
      const list = await dischargeList(ctx, { date, hospital: hospitalOf(req), units: unit ? [unit] : null, status });
      res.json({ ...list, unit, status, cutoff: ctx.settings.cutoff });
    } catch (err) { fail(req, res, err); }
  });

  // ── Ancillary ───────────────────────────────────────────────────────────
  // GET /api/rtdc/ancillary?date=&hospital=
  router.get('/ancillary', async (req, res) => {
    const ctx = req.rtdc;
    try {
      const date = dateOr(req.query.date, ctx.today);
      const hospital = hospitalOf(req);
      if (!ctx.settings.features.rtdc_pending_items) {
        return res.json({ date, available: false, services: [], message: 'Pending items are unavailable for this tenant.' });
      }
      const day = await D.buildDay(ctx, date, { hospital });
      if (!day.hasS2) return res.json({ date, available: true, hasS2: false, services: [] });
      const medians = await D.medians(ctx, date);
      const mctx = { date, now: date === ctx.today ? ctx.now : T.at(date, ctx.settings.snapshot_times.S2 || '08:20'), cutoff: ctx.settings.cutoff, medians };
      const groups = new Map(ctx.settings.ancillary_services.map(s => [s.service, []]));
      groups.set('Other', []);
      const classify = (name, cls) => {
        const n = ` ${String(name || '').toLowerCase()} `;
        for (const s of ctx.settings.ancillary_services) if (s.match.some(m => n.includes(m))) return s.service;
        if (cls === 'lab') return 'Lab';
        if (cls === 'imaging') return 'CT/MRI';
        if (cls === 'therapy') return 'PT/OT';
        if (cls === 'referral') return 'Placement';
        return 'Other';
      };
      for (const p of day.s2.patients) {
        const escalated = p.pred === 'N' && p.candidates.length > 0;
        if (!(p.pred === 'Y' || escalated)) continue;
        const { steps } = Y.stepsToYes(p, mctx);
        for (const s of steps.filter(x => x.kind === 'pending')) {
          const svc = classify(s.name, s.itemClass);
          groups.get(svc).push({ unit: p.UNIT, roomBed: p.ROOM_BED, initials: p.PATIENT_INITIALS, item: s.name, itemClass: s.itemClass,
            status: s.status, orderedAt: s.orderedAt, neededBy: s.neededBy, late: s.late, tag: p.pred === 'Y' ? 'Y' : 'N · escalated' });
        }
      }
      const services = [...groups.entries()].filter(([, rows]) => rows.length)
        .map(([service, rows]) => ({ service, count: rows.length, rows: rows.sort((a, b) => T.toMinutes(a.neededBy) - T.toMinutes(b.neededBy)) }));
      res.json({ date, available: true, hasS2: true, s2At: day.s2At, services });
    } catch (err) { fail(req, res, err); }
  });

  // ── Review ──────────────────────────────────────────────────────────────
  // GET /api/rtdc/review?date=&hospital=
  router.get('/review', async (req, res) => {
    const ctx = req.rtdc;
    try {
      const date = dateOr(req.query.date, ctx.today);
      const hospital = hospitalOf(req);
      const day = await D.buildDay(ctx, date, { hospital });
      const base = { date, isToday: date === ctx.today, cutoff: ctx.settings.cutoff, hasS2: day.hasS2, hasS3: day.hasS3,
                     barrierCodes: ctx.settings.barrier_codes, reviewed: day.reviewed.map(r => r.unit), readOnly: date < ctx.today };
      if (!day.score) {
        const beforeCutoff = date === ctx.today && T.fmtTime(ctx.now) < (ctx.settings.cutoff || '14:00');
        return res.json({ ...base, scorable: false, pendingYs: day.pendingYs,
          message: date > ctx.today ? 'Not yet.' : beforeCutoff ? `Scores after ${ctx.settings.cutoff}.` : 'Awaiting the nightly scoring run.' });
      }
      const units = huddleSort(Object.keys(day.score.byUnit), ctx.settings.huddle_order);
      const byUnit = units.map(u => ({
        unit: u, ...day.score.byUnit[u],
        missed: day.score.rows.filter(r => r.unit === u && r.outcome === 'MISSED'),
        candidates: day.score.rows.filter(r => r.unit === u && r.candidates.length),
        unexpected: day.score.rows.filter(r => r.unit === u && r.outcome === 'UNEXPECTED'),
        reviewed: day.reviewed.some(r => r.unit === u),
      }));
      res.json({ ...base, scorable: true, mode: day.score.mode, house: day.score.house, byUnit, fidelity: day.score.fidelity, epic: day.score.epic });
    } catch (err) { fail(req, res, err); }
  });

  // POST /api/rtdc/review/:enc/barrier  { date, code, bin? }
  router.post('/review/:enc/barrier', (req, res) => {
    const ctx = req.rtdc;
    try {
      const b = req.body || {};
      const date = dateOr(b.date, ctx.today);
      const enc = String(req.params.enc || '').slice(0, 50);
      const codes = ctx.settings.barrier_codes;
      const def = codes.find(c => c.code === b.code);
      if (!enc || !def) return res.status(400).json({ error: 'A known barrier code is required' });
      const row = store.confirmBarrier(ctx.tenantId, { date, encounterKey: enc, code: def.code, bin: b.bin || def.bin, by: ctx.user });
      res.json(row);
    } catch (err) { fail(req, res, err); }
  });

  // POST /api/rtdc/review/unit/:unit/reviewed  { date }
  router.post('/review/unit/:unit/reviewed', (req, res) => {
    const ctx = req.rtdc;
    try {
      const unit = unitOf(req.params.unit);
      const date = dateOr((req.body || {}).date, ctx.today);
      if (!unit) return res.status(400).json({ error: 'unit is required' });
      res.json(store.markReviewed(ctx.tenantId, { date, unit, by: ctx.user }));
    } catch (err) { fail(req, res, err); }
  });

  // ── Flow Learning ───────────────────────────────────────────────────────
  // GET /api/rtdc/mismatch?from=&to=&hospital=
  router.get('/mismatch', async (req, res) => {
    const ctx = req.rtdc;
    try {
      const { from, to } = rangeOf(req);
      const { cells, units } = await D.statusRange(ctx, from, to, { hospital: hospitalOf(req) });
      const hm = M.heatmap(cells, units, { from, to });
      res.json({ from, to, ...hm });
    } catch (err) { fail(req, res, err); }
  });

  // GET /api/rtdc/scoreboard?from=&to=&unit=&hospital=
  router.get('/scoreboard', async (req, res) => {
    const ctx = req.rtdc;
    try {
      const { from, to } = rangeOf(req);
      const unit = unitOf(req.query.unit);
      const hospital = hospitalOf(req);
      const { inRange } = await D.scoreRange(ctx, from, to, { hospital });
      const rows = inRange.flatMap(d => d.rows.filter(r => !unit || r.unit === unit).map(r => ({ ...r, date: d.date })));
      const acc = require('../lib/rtdcPredict').accuracy(rows.map(r => r.outcome));
      const { cells } = await D.statusRange(ctx, from, to, { hospital });
      const dayStatus = new Map();
      for (const c of cells) { if (unit && c.unit !== unit) continue; dayStatus.set(c.date, (dayStatus.get(c.date) || 0) + c.status); }
      const daysOk = [...dayStatus.values()].filter(v => v >= 0).length;
      const conv = O.conversionTable(inRange, { minFirings: ctx.settings.min_rule_firings, unit });
      const medianDc = O.median(rows.filter(r => r.dischargedToday).map(r => T.toMinutes(r.dischargedTime)));
      // Effective-bed loss by reason (available − effective where the room adjusted down).
      const loss = {};
      for (const e of store.listDayUnitsRange(ctx.tenantId, from, to)) {
        if (unit && e.unit !== unit) continue;
        if (!Number.isFinite(e.adjustment) || e.adjustment >= 0) continue;
        const k = e.adjustment_reason || 'Unspecified';
        loss[k] = (loss[k] || 0) + Math.abs(e.adjustment);
      }
      // Series.
      const units = huddleSort([...new Set(inRange.flatMap(d => Object.keys(d.byUnit)))], ctx.settings.huddle_order);
      // Accuracy over time as a trailing 7-day rate: a unit has three to six
      // Ys a day, so the daily figure is noise and the weekly one is the trend.
      const accuracyByUnit = inRange.map((d, i) => {
        const win = inRange.slice(Math.max(0, i - 6), i + 1);
        const rate = pick => {
          const met = win.reduce((s, x) => s + (pick(x)?.MET || 0), 0), ys = win.reduce((s, x) => s + (pick(x)?.ys || 0), 0);
          return ys ? Math.round((met / ys) * 1000) / 10 : null;
        };
        const o = { date: d.date, House: rate(x => x.house) };
        for (const u of units) o[u] = rate(x => x.byUnit[u]);
        return o;
      });
      const weekly = {};
      for (const d of inRange) {
        const w = T.weekStart(d.date);
        const a = (weekly[w] ||= { week: w, MET: 0, MISSED: 0, UNEXPECTED: 0, NOT_ON_LIST: 0 });
        for (const r of d.rows) if (r.outcome && (!unit || r.unit === unit)) a[r.outcome] += 1;
      }
      const fidelityByUnit = units.map(u => {
        const vals = inRange.map(d => d.fidelityByUnit && d.fidelityByUnit[u]).filter(f => f && f.available);
        const mean = k => (vals.length ? Math.round(vals.reduce((s, f) => s + (f[k] || 0), 0) / vals.length) : null);
        return { unit: u, available: vals.length > 0, nightPct: mean('nightPct'), amPct: mean('amPct'), narrativePct: mean('narrativePct') };
      });
      const epicVals = inRange.map(d => d.epic).filter(Boolean);
      const epic = epicVals.length ? {
        eddTodayPct: Math.round(epicVals.reduce((s, e) => s + (e.eddTodayPct || 0), 0) / epicVals.length),
        entryLagPct: Math.round(epicVals.filter(e => e.entryLagPct != null).reduce((s, e) => s + e.entryLagPct, 0) / Math.max(1, epicVals.filter(e => e.entryLagPct != null).length)),
      } : null;
      const fidelityAvail = inRange.some(d => d.fidelity && d.fidelity.available);
      res.json({
        from, to, unit, mode: ctx.settings.pred_source, days: inRange.length,
        tiles: {
          accuracyPct: acc.accuracyPct, met: acc.MET, missed: acc.MISSED, ys: acc.ys,
          daysCapacityOk: daysOk, daysTotal: dayStatus.size, daysCapacityOkPct: dayStatus.size ? Math.round((daysOk / dayStatus.size) * 100) : null,
          unexpected: acc.UNEXPECTED, notOnList: acc.NOT_ON_LIST,
          candidates: rows.filter(r => r.candidates.length).length, converted: rows.filter(r => r.converted === true).length,
          medianDcTime: medianDc == null ? null : T.fromMinutes(Math.round(medianDc)),
          effectiveBedLoss: Object.values(loss).reduce((s, v) => s + v, 0),
          fidelityAvailable: fidelityAvail,
        },
        accuracyByUnit, units, weekly: Object.values(weekly).sort((a, b) => a.week.localeCompare(b.week)),
        conversionByRule: conv.rules, effectiveBedLossByReason: Object.entries(loss).map(([reason, beds]) => ({ reason, beds })),
        fidelityByUnit, epic,
      });
    } catch (err) { fail(req, res, err); }
  });

  // GET /api/rtdc/escalations?from=&to=&unit=&rule=&hospital=
  router.get('/escalations', async (req, res) => {
    const ctx = req.rtdc;
    try {
      const { from, to } = rangeOf(req);
      const unit = unitOf(req.query.unit);
      const rule = typeof req.query.rule === 'string' ? req.query.rule.slice(0, 40) : null;
      const { inRange } = await D.scoreRange(ctx, from, to, { hospital: hospitalOf(req) });
      const half = T.addDays(from, Math.floor(T.daysBetween(from, to) / 2));
      const conv = O.conversionTable(inRange, { minFirings: ctx.settings.min_rule_firings, unit });
      const early = O.conversionTable(inRange.filter(d => d.date < half), { minFirings: 1, unit });
      const late = O.conversionTable(inRange.filter(d => d.date >= half), { minFirings: 1, unit });
      const trendOf = key => {
        const a = early.rules.find(r => r.ruleKey === key), b = late.rules.find(r => r.ruleKey === key);
        if (!a || !b || a.conversionPct == null || b.conversionPct == null) return null;
        return Math.round((b.conversionPct - a.conversionPct) * 10) / 10;
      };
      const rules = ctx.rules.filter(r => r.rule_key !== 'EXCLUDE').map(r => {
        const c = conv.rules.find(x => x.ruleKey === r.rule_key) || { fired: 0, converted: 0, conversionPct: null, belowMin: true };
        return { ruleKey: r.rule_key, enabled: r.enabled, reasonText: r.reason_text, fired: c.fired, converted: c.converted,
                 conversionPct: c.conversionPct, belowMin: c.belowMin, trend: trendOf(r.rule_key) };
      });
      const sel = rule || (rules.slice().sort((a, b) => b.fired - a.fired)[0] || {}).ruleKey || null;
      res.json({
        from, to, unit, rule: sel, minFirings: ctx.settings.min_rule_firings, rules,
        byUnit: conv.byUnit.filter(r => r.ruleKey === sel).sort((a, b) => b.fired - a.fired),
        byAttending: conv.byAttending.filter(r => r.ruleKey === sel).sort((a, b) => b.fired - a.fired),
        firings: conv.firings.filter(f => f.ruleKey === sel).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 200),
      });
    } catch (err) { fail(req, res, err); }
  });

  // GET /api/rtdc/learn/archetypes?from=&to=&hospital=&unit=
  router.get('/learn/archetypes', async (req, res) => {
    const ctx = req.rtdc;
    try {
      const { from, to } = rangeOf(req);
      const unit = unitOf(req.query.unit);
      const { inRange } = await D.scoreRange(ctx, from, to, { hospital: hospitalOf(req) });
      const days = unit ? inRange.map(d => ({ ...d, rows: d.rows.filter(r => r.unit === unit) })) : inRange;
      const archetypes = A.buildArchetypes(days, { top: 10 });
      const queued = store.listImprovements(ctx.tenantId).filter(i => i.kind === 'archetype');
      res.json({
        from, to, unit,
        avoidable: days.reduce((s, d) => s + d.rows.filter(r => r.avoidable).length, 0),
        archetypes: archetypes.map(a => ({ ...a, status: queued.find(q => q.archetype === a.key) ? 'queued' : 'open' })),
      });
    } catch (err) { fail(req, res, err); }
  });

  // GET /api/rtdc/barriers?from=&to=&hospital=&unit=
  router.get('/barriers', async (req, res) => {
    const ctx = req.rtdc;
    try {
      const { from, to } = rangeOf(req);
      const unit = unitOf(req.query.unit);
      const { inRange } = await D.scoreRange(ctx, from, to, { hospital: hospitalOf(req) });
      const weekdays = T.eachDay(from, to).filter(T.isWeekday);
      const last5 = weekdays.slice(-5), last10 = weekdays.slice(-10);
      const acc = new Map();
      for (const d of inRange) {
        for (const r of d.rows) {
          if (!r.barrier || (unit && r.unit !== unit)) continue;
          const key = `${r.unit}|${r.barrier.code}`;
          const a = acc.get(key) || { unit: r.unit, code: r.barrier.code, timesSeen: 0, days: new Set(), confirmed: 0, encounters: [] };
          a.timesSeen += 1; a.days.add(d.date); if (!r.barrier.inferred) a.confirmed += 1;
          a.encounters.push({ date: d.date, roomBed: r.roomBed, initials: r.initials, facts: r.barrier.facts, confirmed: !r.barrier.inferred });
          acc.set(key, a);
        }
      }
      const codes = Object.fromEntries(ctx.settings.barrier_codes.map(c => [c.code, c]));
      const trackers = Object.fromEntries(store.listTrackers(ctx.tenantId).map(t => [`${t.unit}|${t.code}`, t]));
      const rows = [...acc.values()].map(a => {
        const inLast5 = last5.filter(d => a.days.has(d)).length;
        const inLast10 = last10.filter(d => a.days.has(d)).length;
        const t = trackers[`${a.unit}|${a.code}`] || null;
        // Same unit + code on ≥ 3 of the last 5 weekdays → operational fix;
        // on ≥ 6 of the last 10 → a PI initiative for the workgroup.
        const recurrence = inLast10 >= ctx.settings.recurrence_pi ? 'PI initiative'
          : inLast5 >= ctx.settings.recurrence_operational ? 'operational fix' : null;
        return {
          unit: a.unit, code: a.code, label: codes[a.code]?.label || a.code, timesSeen: a.timesSeen, daysSeen: a.days.size,
          inLast5, inLast10, confirmed: a.confirmed, recurrence, bin: (t && t.bin) || codes[a.code]?.bin || 'process',
          status: (t && t.status) || 'open', pilotRef: (t && t.pilot_ref) || null,
          encounters: a.encounters.sort((x, y) => y.date.localeCompare(x.date)).slice(0, 30),
        };
      }).sort((a, b) => b.timesSeen - a.timesSeen);
      res.json({ from, to, unit, rows, statuses: store.TRACKER_STATUSES, codes: ctx.settings.barrier_codes });
    } catch (err) { fail(req, res, err); }
  });

  // POST /api/rtdc/barriers/:unit/:code  { status?, pilot_ref?, bin? }
  router.post('/barriers/:unit/:code', (req, res) => {
    const ctx = req.rtdc;
    try {
      const unit = unitOf(req.params.unit);
      const code = String(req.params.code || '').slice(0, 40);
      if (!unit || !ctx.settings.barrier_codes.some(c => c.code === code)) return res.status(400).json({ error: 'Unknown unit or barrier code' });
      const b = req.body || {};
      if (b.status !== undefined && !store.TRACKER_STATUSES.includes(b.status)) return res.status(400).json({ error: 'Unknown status' });
      res.json(store.setTracker(ctx.tenantId, { unit, code, status: b.status, bin: b.bin, pilot_ref: b.pilot_ref, by: ctx.user }));
    } catch (err) { fail(req, res, err); }
  });

  // POST /api/rtdc/improvements  { kind: 'archetype'|'barrier', unit?, code?, archetype?, sentence?, bin? }
  router.post('/improvements', (req, res) => {
    const ctx = req.rtdc;
    try {
      const b = req.body || {};
      if (!['archetype', 'barrier'].includes(b.kind)) return res.status(400).json({ error: 'kind must be archetype or barrier' });
      const row = store.addImprovement(ctx.tenantId, { kind: b.kind, unit: unitOf(b.unit), code: b.code ? String(b.code).slice(0, 40) : null,
        archetype: b.archetype ? String(b.archetype).slice(0, 400) : null, sentence: b.sentence ? String(b.sentence).slice(0, 400) : null,
        bin: b.bin ? String(b.bin).slice(0, 40) : null, by: ctx.user });
      if (b.kind === 'barrier' && row.unit && row.code) {
        const cur = store.getTracker(ctx.tenantId, row.unit, row.code);
        if (!cur || cur.status === 'open') store.setTracker(ctx.tenantId, { unit: row.unit, code: row.code, status: 'PI initiative', by: ctx.user });
      }
      res.status(201).json(row);
    } catch (err) { fail(req, res, err); }
  });
  router.get('/improvements', (req, res) => res.json({ improvements: store.listImprovements(req.rtdc.tenantId) }));

  // ── Admin: rules + settings ─────────────────────────────────────────────
  router.get('/rules', (req, res) => res.json({ rules: req.rtdc.rules }));
  router.put('/rules', isAdmin, (req, res) => {
    try {
      const rules = (req.body || {}).rules;
      if (!Array.isArray(rules)) return res.status(400).json({ error: 'rules must be an array' });
      const known = new Set(req.rtdc.rules.map(r => r.rule_key));
      if (!rules.every(r => r && known.has(r.rule_key))) return res.status(400).json({ error: 'Unknown rule key' });
      store.setRules(req.rtdc.tenantId, rules);
      res.json({ rules: ctxFor(req).rules });
    } catch (err) { fail(req, res, err); }
  });
  router.get('/settings', isAdmin, (req, res) => {
    const s = req.rtdc.settings;
    res.json({ settings: Object.fromEntries(store.SETTING_KEYS.map(k => [k, s[k]])), editable: store.SETTING_KEYS, source: s.source });
  });
  router.put('/settings', isAdmin, (req, res) => {
    try {
      const b = (req.body || {}).settings || {};
      if (b.pred_source !== undefined && !['FLAG', 'EDD_TIME', 'EDD_DATE'].includes(b.pred_source)) return res.status(400).json({ error: 'pred_source must be FLAG, EDD_TIME or EDD_DATE' });
      if (b.list_horizon_days !== undefined && !(Number.isInteger(b.list_horizon_days) && b.list_horizon_days >= 0 && b.list_horizon_days <= 7)) return res.status(400).json({ error: 'list_horizon_days must be 0–7' });
      for (const k of ['cutoff', 'order_by', 'transport_by']) if (b[k] !== undefined && !T.isValidTime(b[k])) return res.status(400).json({ error: `${k} must be HH:MM` });
      if (b.huddle_order !== undefined && !(Array.isArray(b.huddle_order) && b.huddle_order.every(u => typeof u === 'string'))) return res.status(400).json({ error: 'huddle_order must be a list of unit names' });
      if (b.effective_bed_reasons !== undefined && !(Array.isArray(b.effective_bed_reasons) && b.effective_bed_reasons.every(u => typeof u === 'string' && u.length <= 60))) return res.status(400).json({ error: 'effective_bed_reasons must be a list of short labels' });
      if (b.snapshot_times !== undefined) {
        const st = b.snapshot_times;
        if (!st || typeof st !== 'object' || !T.isValidTime(st.S1 || '06:00') || !T.isValidTime(st.S2 || '08:20')) return res.status(400).json({ error: 'snapshot_times must be HH:MM' });
      }
      store.setSettings(req.rtdc.tenantId, b);
      const s = ctxFor(req).settings;
      res.json({ settings: Object.fromEntries(store.SETTING_KEYS.map(k => [k, s[k]])) });
    } catch (err) { fail(req, res, err); }
  });

  return router;
};

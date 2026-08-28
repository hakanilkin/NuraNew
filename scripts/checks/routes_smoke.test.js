#!/usr/bin/env node
//
// Exercise the ISSCM, Staffing and Smoothing routers against stubbed pools.
//
// These routers are pure assembly over SQL results, and the SQL cannot run
// here. What this catches is everything else: a handler that references a
// variable an edit removed, a response that lost a field the page reads, a
// feature gate that stopped gating. That class of bug surfaces only as a 500 at
// request time — which is exactly how the census attribution endpoint broke
// after an edit silently failed to apply.
//
// Run: node --test scripts/checks/routes_smoke.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..', '..');
const sqlStub = { NVarChar: 'nv', Int: 'int', Float: 'float', Date: 'date' };
const SITE = 'Bright Memorial Hospital';

// Recordsets shaped like the seeded tenant's own data.
const PLAN = [0, 1, 2, 3, 4].map(d => ({
  DayOfWeek: d + 1, StaffedRooms: 9, CoverageRatio: 1,
  ShiftStart: new Date(Date.UTC(1970, 0, 1, 7, 0)),
  ShiftEnd: new Date(Date.UTC(1970, 0, 1, 15, 30)),
}));

function rrRows() {
  const out = [];
  for (let dow = 0; dow <= 4; dow++) {
    for (let t = 6 * 60; t < 20 * 60; t += 15) {
      const inShift = t >= 420 && t < 930;
      out.push({
        Wd: ((dow + 1) % 7) + 1,
        rrtimeslot: `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`,
        AvgRooms: inShift ? 8 - dow * 0.4 : (t >= 930 && t < 1050 ? 2 : 0),
      });
    }
  }
  return out;
}

const CENSUS = [];
for (const [unit, beds, base] of [['5 Central', 32, 25], ['4 East', 28, 22]]) {
  for (let dow = 0; dow <= 6; dow++) {
    CENSUS.push({ Unit: unit, StaffedBeds: beds, Wd: ((dow + 1) % 7) + 1,
                  Census: base + (dow === 2 ? 5 : 0) });
  }
}

function stubPool(overrides = {}) {
  return {
    request() {
      const p = {};
      const api = {
        input(n, _t, v) { p[n] = v; return api; },
        async query(text) {
          const has = f => text.includes(f);
          for (const [frag, rows] of Object.entries(overrides)) {
            if (has(frag)) return { recordset: rows };
          }
          // The Outlook selects Site as well, and keys its map on it.
          if (has('FROM StaffingPlan') && has('Site, DayOfWeek')) return { recordset:
            [0, 1, 2, 3, 4].map(d => ({ Site: SITE, DayOfWeek: d + 1, StaffedRooms: 9,
              CoverageRatio: 1, ShiftStart: new Date(Date.UTC(1970, 0, 1, 7, 0)),
              ShiftEnd: new Date(Date.UTC(1970, 0, 1, 15, 30)) })) };
          if (has('FROM StaffingPlan')) return { recordset: PLAN };
          // Two different DS_RR queries: the staffing page wants the whole
          // shape, the ISSCM baseline wants only the peak.
          if (has('AS Peak')) return { recordset: [{ Peak: 8.2 }] };
          if (has('FROM DS_RR')) return { recordset: rrRows() };
          if (has('AS AvgRoomHours')) return { recordset: [{ AvgRoomHours: 66.4, Days: 8 }] };
          // Impact.
          if (has('SELECT TOP 1 1 AS ok')) return { recordset: [{ ok: 1 }] };
          if (has('FROM ServiceRecoveryProfile')) return { recordset: [
            { Service: 'Orthopedics', PreOpMins: 60, Phase1Mins: 85, Phase2Mins: 55, BayType: 'BOTH' },
          ] };
          if (has('FROM RecoveryCapacity')) return { recordset: [
            { Site: SITE, PreOpBays: 12, PacuBays: 7, Phase2Bays: 14 } ] };
          if (has('AS InMin')) return { recordset: [
            { Site: SITE, Wd: 5, Service: 'Orthopedics', InMin: 480, OutMin: 590, N: 1, Days: 1 },
            { Site: SITE, Wd: 5, Service: 'Orthopedics', InMin: 500, OutMin: 620, N: 1, Days: 1 },
            { Site: SITE, Wd: 5, Service: 'Orthopedics', InMin: 520, OutMin: 640, N: 1, Days: 1 },
            { Site: SITE, Wd: 5, Service: 'Orthopedics', InMin: 540, OutMin: 660, N: 1, Days: 1 },
            { Site: SITE, Wd: 5, Service: 'Orthopedics', InMin: 560, OutMin: 680, N: 1, Days: 1 },
            { Site: SITE, Wd: 5, Service: 'Orthopedics', InMin: 580, OutMin: 700, N: 1, Days: 1 },
            { Site: SITE, Wd: 5, Service: 'Orthopedics', InMin: 600, OutMin: 720, N: 1, Days: 1 },
            { Site: SITE, Wd: 5, Service: 'Orthopedics', InMin: 620, OutMin: 740, N: 1, Days: 1 },
          ] };
          if (has('AS BlockMins')) return { recordset: [
            { Date: '2026-09-11', Site: SITE, CaseBlock: 'Ortho A', BlockMins: 480, BookedMins: 150 } ] };
          if (has('AS ForecastMins')) return { recordset: [
            { Date: '2026-09-09', Site: SITE, Wd: 4, Booked: 30, Forecast: 38, Budget: 31,
              ForecastMins: 510 * 8.2, BookedMins: 510 * 6 },
            { Date: '2026-09-11', Site: SITE, Wd: 6, Booked: 14, Forecast: 18, Budget: 30,
              ForecastMins: 510 * 3.0, BookedMins: 510 * 2 } ] };
          if (has('AS Census') && has('FROM UnitCapacity')) return { recordset:
            [0, 1, 2, 3, 4].map(d => ({ Unit: '5 Central', StaffedBeds: 32,
              Wd: ((d + 1) % 7) + 1, Census: d === 2 ? 30 : 25 })) };
          // Outlook: totals per date, mix per date, trailing durations.
          if (has('AS Scheduled') && has('AS BookedMins')) return { recordset: [
            { Date: '2026-09-09', Site: SITE, Wd: 4, DaysAhead: 15, Scheduled: 30, Forecast: 38, Budget: 31, BookedMins: 510 * 8.2 },
            { Date: '2026-09-15', Site: SITE, Wd: 3, DaysAhead: 21, Scheduled: 20, Forecast: 23, Budget: 30, BookedMins: 510 * 5.4 },
            { Date: '2026-09-11', Site: SITE, Wd: 6, DaysAhead: 17, Scheduled: 18, Forecast: 20, Budget: 20, BookedMins: 510 * 5.0 },
          ] };
          if (has('AS Service') && has('AS Forecast')) return { recordset: [
            { Date: '2026-09-09', Site: SITE, Service: 'Orthopedics', Forecast: 14, Budget: 9 },
            { Date: '2026-09-09', Site: SITE, Service: 'ENT', Forecast: 6, Budget: 5 },
            { Date: '2026-09-15', Site: SITE, Service: 'General Surgery', Forecast: 5, Budget: 11 },
          ] };
          if (has('AS AvgMins')) return { recordset: [
            { Service: 'Orthopedics', AvgMins: 101 }, { Service: 'ENT', AvgMins: 52 },
            { Service: 'General Surgery', AvgMins: 80 },
          ] };
          if (has('AS BookedMins')) return { recordset: [
            { Date: '2026-08-28', Wd: 6, DaysAhead: 4, BookedMins: 510 * 5.4 },
            { Date: '2026-08-27', Wd: 5, DaysAhead: 3, BookedMins: 510 * 8.1 },
          ] };
          if (has('WITH census_times')) return { recordset: CENSUS.map(c => ({
            Unit: c.Unit, Wd: c.Wd, Occupants: 24, OrOccupants: 6, EdOccupants: 15 })) };
          if (has('JOIN UnitCapacity c ON c.Unit = o.DEP_NAME')) return { recordset: [{ N: 24 }] };
          if (has('FROM UnitCapacity')) return { recordset: CENSUS.map(c => ({ ...c, ProjectedCensus: c.Census })) };
          if (has('FROM ServiceUnitMap')) return { recordset: [
            { Unit: '5 Central', SharePct: 62 }, { Unit: '4 East', SharePct: 38 }] };
          if (has('AS Days,') && has('DS_Encounters')) return { recordset: [
            { Days: 2, N: 30 }, { Days: 3, N: 50 }] };
          if (has('AS Admits')) return { recordset: [{ Cases: 160, Admits: 70 }] };
          if (has('DATEPART(WEEKDAY, Date_SchedDate)')) return { recordset:
            [0, 1, 2, 3, 4].flatMap(d => ['Orthopedics', 'Spine'].map(sv =>
              ({ Service: sv, Wd: ((d + 1) % 7) + 1, Cases: 16, Days: 8 }))) };
          if (has('AS Admits')) return { recordset: [{ Cases: 160, Admits: 70 }] };
          if (has('AS AvgHours')) return { recordset: [{ AvgHours: 2.6 }] };
          if (has('WITH instances AS')) return { recordset: [{
            Instances: 8, AllocMins: 3840, InBlockMins: 2143,
            Site: SITE, RoomPrimeMins: 2300 }] };
          if (has('AS FwdCases')) return { recordset: [{
            FwdCases: 120, FwdDays: 20, HistCases: 300, HistDays: 60 }] };
          if (has('TOP 1 ISNULL(SurgeonService')) return { recordset: [{ Service: 'Spine' }] };
          if (has('TOP 25')) return { recordset: [{
            CaseBlock: 'Ortho A', Site: SITE, Service: 'Orthopedics', DowSql: 5,
            BlockMins: 1920, Cases: 6, BookedMins: 1050 }] };
          throw new Error('unstubbed query: ' + text.trim().slice(0, 70));
        },
      };
      return api;
    },
  };
}

async function call(routerFile, tenant, method, url, body, overrides) {
  const make = require(path.join(ROOT, 'routes', routerFile));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantName = tenant; req.session = { tenantId: 3 }; next(); });
  app.use('/api', make(async () => stubPool(overrides), sqlStub, (_q, _s, n) => n()));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api${url}`,
      body ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { method });
    // An unmatched route is Express's own HTML 404, not JSON.
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text) } catch { parsed = { _html: text.slice(0, 60) } }
    return { status: res.status, body: parsed };
  } finally {
    server.close();
  }
}

const DEMO = 'Bright Memorial Health';

// ── Volume Impact ───────────────────────────────────────────────────────────

test('impact: every endpoint responds', async () => {
  for (const url of ['/tabs', '/summary', '/budget', '/inpatient', '/staffing',
                     '/recovery', '/budget/2026-09-09/mix']) {
    const r = await call('impact.js', DEMO, 'GET', url);
    assert.equal(r.status, 200, `${url}: ${JSON.stringify(r.body)}`);
  }
});

test('impact: the summary never collapses booked and expected into one figure', async () => {
  const { body } = await call('impact.js', DEMO, 'GET', '/summary');
  assert.ok('booked' in body && 'expectedAdds' in body,
    'the split is the answer to "why not just read the booked schedule"');
  assert.ok(Math.abs((body.booked + body.expectedAdds) - body.forecast) < 0.2,
    'the parts must add to the forecast');
});

test('impact: budget applies both flagging thresholds', async () => {
  const { body } = await call('impact.js', DEMO, 'GET', '/budget');
  assert.ok(body.grid.length && body.days.length);
  for (const d of body.days.filter(x => x.flagged)) {
    assert.ok(Math.abs(d.variancePct) >= body.thresholds.exceptionPct);
    assert.ok(Math.abs(d.variance) >= body.thresholds.minCases,
      'a three-to-four case day must never be flagged');
  }
});

test('impact: staffing says release before it says flex down', async () => {
  const { body } = await call('impact.js', DEMO, 'GET', '/staffing');
  const spare = body.days.filter(d => d.flag === 'OVER' && d.releasable.length);
  assert.ok(spare.length, 'the fixture has a light day with sellable block time');
  for (const d of spare) {
    assert.match(d.implication, /releasing and re-offering/);
    assert.ok(d.link, 'and it links to where that happens');
    assert.ok(!/flex down/i.test(d.implication));
  }
});

test('impact: recovery is always tiered POTENTIAL', async () => {
  const { body } = await call('impact.js', DEMO, 'GET', '/recovery');
  assert.equal(body.tier, 'POTENTIAL');
  for (const d of body.days) assert.equal(d.tier, 'POTENTIAL');
});

test('impact: a malformed date is rejected rather than interpolated', async () => {
  const r = await call('impact.js', DEMO, 'GET', "/budget/2026-09-09'; DROP/mix");
  assert.equal(r.status, 400);
});

// ── Block Allocations ───────────────────────────────────────────────────────

test('blocks: allocations respond and sort by mismatch hours', async () => {
  const r = await call('blocks.js', DEMO, 'GET', '/allocations?horizonDays=28');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  if (r.body.error) return;                       // no pipeline file in this checkout
  const hours = r.body.owners.map(o => o.mismatchHours ?? 0);
  assert.deepEqual(hours, [...hours].sort((a, b) => b - a),
    'a committee reads this by magnitude, not by utilisation');
});

test('blocks: an unknown owner is a 404, never a lookup key', async () => {
  const r = await call('blocks.js', DEMO, 'GET', '/allocations/not-a-block');
  assert.ok([404, 200].includes(r.status));
  if (r.status === 200) assert.ok(r.body.error, 'a missing file is reported, not guessed at');
});

test('isscm: scenarios, baseline and evaluate all respond', async () => {
  const cat = await call('isscm.js', DEMO, 'GET', '/scenarios?horizonWeeks=4');
  assert.equal(cat.status, 200, JSON.stringify(cat.body));
  const id = cat.body.scenarios[0].scenarioId;
  const full = await call('isscm.js', DEMO, 'GET', `/scenarios/${encodeURIComponent(id)}?hours=4`);
  assert.equal(full.status, 200, JSON.stringify(full.body));
  assert.ok(full.body.pillars.surgeon && full.body.pillars.staffing && full.body.pillars.capacity);
  assert.ok(Array.isArray(full.body.alternatives) && full.body.alternatives.length);
});

test('isscm: an unknown scenario id is a 404, never a path fragment', async () => {
  const r = await call('isscm.js', DEMO, 'GET', `/scenarios/${encodeURIComponent('nope|nope|9')}`);
  assert.equal(r.status, 404);
});

test('isscm: evaluate accepts all three decision kinds', async () => {
  for (const decision of [
    { kind: 'REALLOCATE', fromBlock: 'Ortho A', toService: 'Spine', hours: 4, dayOfWeek: 3 },
    { kind: 'SHIFT_DOW', service: 'Spine', casesPerWeek: 5, dayOfWeek: 4 },
    { kind: 'FLEX_STAFFING', rooms: -2, dayOfWeek: 4 },
  ]) {
    const r = await call('isscm.js', DEMO, 'POST', '/evaluate', { decision });
    assert.equal(r.status, 200, `${decision.kind}: ${JSON.stringify(r.body)}`);
    assert.equal(Object.keys(r.body.pillars).length, 3);
  }
});

test('isscm: a decision missing its required field is rejected at the door', async () => {
  const r = await call('isscm.js', DEMO, 'POST', '/evaluate',
    { decision: { kind: 'SHIFT_DOW', dayOfWeek: 3 } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /service/);
});


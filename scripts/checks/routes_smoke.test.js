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
          if (has('FROM StaffingPlan')) return { recordset: PLAN };
          // Two different DS_RR queries: the staffing page wants the whole
          // shape, the ISSCM baseline wants only the peak.
          if (has('AS Peak')) return { recordset: [{ Peak: 8.2 }] };
          if (has('FROM DS_RR')) return { recordset: rrRows() };
          if (has('AS AvgRoomHours')) return { recordset: [{ AvgRoomHours: 66.4, Days: 8 }] };
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
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

const DEMO = 'Bright Memorial Health';

test('smoothing: census attribution returns cells and a summary', async () => {
  const r = await call('smoothing.js', DEMO, 'GET', '/census-attribution?weeks=8');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.units.length, 'no units returned');
  assert.ok(r.body.units[0].byDow.length, 'no cells returned');
  assert.ok(r.body.summary.orContributionPct > 0, 'OR contribution should be non-zero');
  assert.ok(r.body.summary.crunchUnitDays != null, 'crunch unit-days missing');
  assert.ok(r.body.summary.peak, 'peak missing');
});

test('smoothing: attribution splits a cell into OR, ED and the rest', async () => {
  const { body } = await call('smoothing.js', DEMO, 'GET', '/census-attribution?weeks=8');
  const cell = body.units[0].byDow[0];
  assert.ok(cell.or > 0 && cell.ed > 0, 'both sources should be attributed');
  // Each part is rounded to a tenth independently, so the sum can drift by up
  // to half a tenth per part.
  assert.ok(Math.abs((cell.or + cell.ed + cell.other) - cell.census) <= 0.15,
    `parts ${cell.or}+${cell.ed}+${cell.other} should sum to census ${cell.census}`);
});

test('smoothing: footprint, scenarios and preview all respond', async () => {
  for (const [method, url, body] of [
    ['GET', '/footprint?service=Spine&weeks=8'],
    ['GET', '/scenarios?weeks=8'],
    ['POST', '/preview', { decision: { service: 'Spine', fromDow: 2, toDow: 4, casesPerWeek: 5 } }],
  ]) {
    const r = await call('smoothing.js', DEMO, method, url, body);
    assert.equal(r.status, 200, `${url}: ${JSON.stringify(r.body)}`);
  }
});

test('staffing: shape, ledger and forward all respond', async () => {
  for (const url of [`/shape?site=${encodeURIComponent(SITE)}`,
                     `/ledger?site=${encodeURIComponent(SITE)}`,
                     `/forward?site=${encodeURIComponent(SITE)}`]) {
    const r = await call('staffing.js', DEMO, 'GET', url);
    assert.equal(r.status, 200, `${url}: ${JSON.stringify(r.body)}`);
  }
});

test('staffing: the ledger reports both directions of the gap', async () => {
  const { body } = await call('staffing.js', DEMO, 'GET', `/ledger?site=${encodeURIComponent(SITE)}`);
  assert.ok(body.byDow.length, 'no ledger rows');
  assert.ok(body.summary.idleWk > 0, 'idle hours should be non-zero');
  assert.ok(body.summary.overtimeWk > 0, 'overtime should be non-zero');
  assert.equal(body.summary.costPerRoomHour, null, 'financials stay dormant until priced');
});

test('staffing: the forward plan flags a day the plan over-staffs', async () => {
  const { body } = await call('staffing.js', DEMO, 'GET', `/forward?site=${encodeURIComponent(SITE)}`);
  const flagged = body.days.filter(d => d.flag);
  assert.ok(flagged.length, 'no day flagged');
  assert.ok(flagged[0].drivers.length, 'a flag must carry its reasoning');
  assert.ok(flagged[0].recommendedRooms > flagged[0].impliedRooms,
    'the recommendation keeps a room in hand');
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

test('the gated routers 404 for tenants without the data', async () => {
  for (const [file, url] of [['smoothing.js', '/scenarios'], ['staffing.js', '/ledger?site=x']]) {
    for (const tenant of ['NHS', 'OHS']) {
      const r = await call(file, tenant, 'GET', url);
      assert.equal(r.status, 404, `${file} should 404 for ${tenant}`);
    }
  }
});

test('an empty result set does not crash a handler', async () => {
  // A tenant with the tables but no rows yet is a real state, not an error.
  const r = await call('smoothing.js', DEMO, 'GET', '/census-attribution?weeks=8',
    null, { 'FROM UnitCapacity': [], 'WITH census_times': [] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.units, []);
});

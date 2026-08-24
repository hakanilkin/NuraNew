// Drive /api/staffing and /api/smoothing with stubbed pools carrying the seeded
// tenant's own numbers. Verifies wiring, feature gating and the response
// contract — not the SQL text.
const express = require('express');
const mkStaffing = require('./routes/staffing');
const mkSmoothing = require('./routes/smoothing');
const sqlStub = { NVarChar: 'nv', Int: 'int' };

const SITE = 'Bright Memorial Hospital';
// Rooms running by weekday, 15-min slots 06:00-20:00, shaped like ST-3.
const DEMAND = { 0: 7.4, 1: 6.5, 2: 7.6, 3: 8.2, 4: 6.0 };
const AFTER  = { 0: 0.6, 1: 1.2, 2: 1.6, 3: 2.4, 4: 0.3 };

function rrRows() {
  const out = [];
  for (let dow = 0; dow <= 4; dow++) {
    const wd = ((dow + 1) % 7) + 1;
    for (let t = 6 * 60; t < 20 * 60; t += 15) {
      const inShift = t >= 7 * 60 && t < 15.5 * 60;
      const late = t >= 15.5 * 60 && t < 17.5 * 60;
      out.push({ Wd: wd, rrtimeslot: `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`,
                 AvgRooms: inShift ? DEMAND[dow] : late ? AFTER[dow] : 0 });
    }
  }
  return out;
}
const PLAN = [0, 1, 2, 3, 4].map(d => ({
  DayOfWeek: d + 1, StaffedRooms: 9, CoverageRatio: 1,
  ShiftStart: new Date(Date.UTC(1970, 0, 1, 7, 0)), ShiftEnd: new Date(Date.UTC(1970, 0, 1, 15, 30)),
}));
const FWD = [
  { Date: '2026-08-28', Wd: 6, DaysAhead: 4, BookedMins: 510 * 5.4 },   // Friday
  { Date: '2026-08-27', Wd: 5, DaysAhead: 3, BookedMins: 510 * 8.1 },   // Thursday
  { Date: '2026-09-01', Wd: 3, DaysAhead: 8, BookedMins: 510 * 6.4 },   // Tuesday
];
const CENSUS = [];
for (const [unit, beds, base] of [['5 Central', 32, 25], ['4 East', 28, 22], ['ICU', 16, 12]]) {
  for (let dow = 0; dow <= 6; dow++) {
    const wd = ((dow + 1) % 7) + 1;
    const bump = dow === 2 ? 5.3 : dow === 3 ? 2.5 : 0;
    CENSUS.push({ Unit: unit, StaffedBeds: beds, Wd: wd, Census: base + bump });
  }
}

function pool(kind) {
  return { request() {
    const p = {};
    const api = { input(n, _t, v) { p[n] = v; return api }, async query(text) {
      const has = f => text.includes(f);
      if (has('FROM StaffingPlan')) return { recordset: PLAN };
      if (has('FROM DS_RR')) return { recordset: rrRows() };
      if (has('AS BookedMins')) return { recordset: FWD };
      if (has('JOIN DS_Occupancy')) return { recordset: CENSUS };
      if (has('AS OrAdmits')) return { recordset: CENSUS.map(c => ({ Unit: c.Unit, Wd: c.Wd, OrAdmits: 2, EdAdmits: 5, Days: 8 })) };
      if (has('AS AvgLos')) return { recordset: [{ AvgLos: 3.1 }] };
      if (has('AS Days,') && has('DS_Encounters')) return { recordset: [{ Days: 2, N: 30 }, { Days: 3, N: 50 }, { Days: 5, N: 20 }] };
      if (has('AS Cases,') && has('DS_CASES')) return { recordset:
        [0,1,2,3,4].flatMap(d => ['Orthopedics','Spine'].map(sv =>
          ({ Service: sv, Wd: ((d+1)%7)+1, Cases: sv === 'Spine' ? 12 : 20, Days: 8 }))) };
      if (has('AS Cases,') || has('AS Admits')) return { recordset: [{ Cases: 160, Admits: 70 }] };
      if (has('FROM ServiceUnitMap')) return { recordset: [{ Unit: '5 Central', SharePct: 62 }, { Unit: '4 East', SharePct: 38 }] };
      throw new Error('unstubbed: ' + text.slice(0, 70));
    } };
    return api;
  } };
}

function app(mk, tenant) {
  const a = express(); a.use(express.json());
  a.use((req, _r, n) => { req.tenantName = tenant; req.session = { tenantId: 3 }; n() });
  a.use('/api', mk(async () => pool(), sqlStub, (_q, _s, n) => n()));
  return a;
}

async function run(label, mk, tenant, calls) {
  const server = app(mk, tenant).listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  console.log(`\n=== ${label} (${tenant}) ===`);
  for (const [path, init] of calls) {
    const res = await fetch(base + path, init);
    const body = await res.json();
    console.log(`  ${res.status} ${path}`);
    if (res.status === 200) console.log('   ', JSON.stringify(body).slice(0, 330));
    else console.log('   ', JSON.stringify(body));
  }
  server.close();
}

(async () => {
  await run('staffing', mkStaffing, 'Bright Memorial Health', [
    [`/ledger?site=${encodeURIComponent(SITE)}&weeks=8`],
    [`/forward?site=${encodeURIComponent(SITE)}&weeks=4`],
  ]);
  await run('smoothing', mkSmoothing, 'Bright Memorial Health', [
    ['/footprint?service=Spine&weeks=8'],
    ['/census-attribution?weeks=8'],
    ['/scenarios?weeks=8'],
    ['/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: { service: 'Spine', fromDow: 2, toDow: 4, casesPerWeek: 5 } }) }],
  ]);
  await run('feature gate', mkStaffing, 'NHS', [[`/ledger?site=x`]]);
  await run('feature gate', mkSmoothing, 'OHS', [['/scenarios']]);
})();

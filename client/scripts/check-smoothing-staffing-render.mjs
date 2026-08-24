// SSR-render the OR Smoothing and Staffing pages against fixture payloads.
//
// `vite build` only proves the JSX parses. This proves the views render what
// the APIs return — the shape chart, the attribution grid with its crunch
// encoding, the ledger's dormant financials column, and the forward flex table.
//
// Run from client/: npm run check:smoothing-staffing
import { createServer } from 'vite'
import { renderToString } from 'react-dom/server'
import React from 'react'

const server = await createServer({
  root: process.cwd(), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error',
})
const checks = []
const ok = (label, cond) => checks.push([label, Boolean(cond)])

try {
  const St = await server.ssrLoadModule('/src/pages/Staffing.jsx')
  const Sm = await server.ssrLoadModule('/src/pages/ORSmoothing.jsx')

  const plan = { staffedRooms: 9, shiftStart: '07:00', shiftEnd: '15:30' }
  const byHour = []
  for (let t = 6 * 60; t < 20 * 60; t += 15) {
    const inShift = t >= 420 && t < 930
    byHour.push({ minuteOfDay: t, avgRooms: inShift ? 8.2 : (t < 1050 && t >= 930 ? 2.4 : 0) })
  }

  const chart = renderToString(React.createElement(St.ShapeChart, {
    day: { dow: 3, label: 'Thursday', byHour, plan }, slotMinutes: 15,
  }))
  ok('shape chart renders the day', chart.includes('Thursday'))
  ok('shape chart draws the staffed rectangle', chart.includes('>9<'))
  ok('shape chart marks shift end', chart.includes('15:30'))

  const ledger = renderToString(React.createElement(St.Ledger, {
    ledger: {
      byDow: [{ dow: 4, label: 'Friday', plan, idleRoomHours: 43.7, overtimeRoomHours: 0.8,
                alignmentPct: 42.9, peakRooms: 6, roomsAtShiftEnd: 0.9 }],
      summary: { idleWk: 157, overtimeWk: 17, staffedWk: 382.5, alignmentPct: 58.9,
                 worstIdleDow: 4, worstOvertimeDow: 2, costPerRoomHour: null },
    },
  }))
  ok('ledger names both directions of the gap',
    ledger.includes('Idle staffed hrs / wk') && ledger.includes('Overtime exposure / wk'))
  ok('financials column is present and dormant',
    ledger.includes('Cost') && ledger.includes('Pricing arrives with Financial Analysis.'))

  const forward = renderToString(React.createElement(St.ForwardPlan, {
    forward: { weeks: 4, days: [{ date: '2026-08-28', dow: 4, label: 'Friday', bookedRoomHours: 45.9,
      impliedRooms: 6, recommendedRooms: 7, plannedRooms: 9, flag: 'FLEX_DOWN',
      drivers: [{ key: 'implied', label: 'Implied rooms', detail: 'Over an 8.5-hour shift that needs 6 rooms; the plan staffs 9.' }] }] },
    onEvaluate: () => {},
  }))
  ok('forward plan flags the day', forward.includes('Flex down'))
  ok('forward plan shows the API reasoning verbatim',
    forward.includes('Over an 8.5-hour shift that needs 6 rooms; the plan staffs 9.'))
  ok('forward plan offers the panel', forward.includes('Evaluate flex'))

  const grid = renderToString(React.createElement(Sm.AttributionGrid, {
    attribution: { crunchOccupancyPct: 92, units: [{ unit: '5 Central', capacity: 32, byDow:
      [0, 1, 2, 3, 4].map(dow => ({ dow, label: 'x', census: dow === 2 ? 30 : 25, capacity: 32,
        or: dow === 2 ? 7.5 : 6, ed: 15, other: 5,
        orPct: dow === 2 ? 24.9 : 24, occupancyPct: dow === 2 ? 93.8 : 78, crunch: dow === 2 })) }] },
  }))
  ok('attribution grid renders the crunch cell', grid.includes('93.8'))
  ok('crunch is shape as well as colour', grid.includes('svg'))
  ok('attribution legend names the controllable part', grid.includes('Scheduled OR'))

  const fp = renderToString(React.createElement(Sm.Footprint, {
    footprint: { service: 'Spine', weeklyCases: 15.8, conversionPct: 46.6, admissionsPerWeek: 7.4,
      units: [{ unit: '5 Central', sharePct: 62, byOffset: [0,1,2,3,4,5,6,7].map(d => ({ d, beds: 4.6 - d * 0.6 })) }] },
  }))
  ok('footprint teaches the mechanism in a sentence', fp.includes('still') && fp.includes('5 Central'))
  ok('footprint shows day offsets', fp.includes('D0') && fp.includes('+3'))

  const scen = renderToString(React.createElement(Sm.ShiftScenarios, {
    scenarios: [{ scenarioId: 'Spine|2|4', service: 'Spine', fromDow: 2, toDow: 4, casesPerWeek: 5,
      label: 'Move 5 Spine cases/week from Wednesday to Friday', rationale: 'Wednesday carries 3 crunch unit-days.' }],
    preview: { crunchBefore: 3, crunchAfter: 1, peakBefore: 30, peakAfter: 27.4,
      cells: [{ unit: '5 Central', dow: 2, censusBefore: 30, censusAfter: 27.4, delta: -2.6 }] },
    onPreview: () => {}, onEvaluate: () => {}, active: null,
  }))
  ok('scenarios show the move and its reason',
    scen.includes('Move 5 Spine cases/week') && scen.includes('crunch unit-days'))
  ok('preview shows before and after', scen.includes('27.4') && scen.includes('Crunch unit-days'))
  ok('scenarios offer the panel', scen.includes('Evaluate move'))
} finally {
  await server.close()
}

let bad = 0
for (const [label, pass] of checks) { if (!pass) bad++; console.log(`  ${pass ? 'ok  ' : 'MISS'} ${label}`) }
if (bad) process.exitCode = 1

// SSR-render Volume Impact's shared header and four tabs.
//
// The rules being defended are the ones a rewrite would quietly lose: the
// booked/expected split is never collapsed, the budget grid prints its values
// so it survives greyscale, a light day with sellable time reads as a release
// rather than a flex-down, and recovery is always labelled POTENTIAL.
//
// Run from client/: npm run check:volume-impact
import { createServer } from 'vite'
import { renderToString } from 'react-dom/server'
import React from 'react'
import { MemoryRouter } from 'react-router-dom'

// The staffing tab links out to Release Time Mgmt, and <Link> needs a router
// context even when rendered on its own.
const inRouter = el => React.createElement(MemoryRouter, null, el)

const server = await createServer({
  root: process.cwd(), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error',
})
const checks = []
const ok = (label, cond) => checks.push([label, Boolean(cond)])
const plain = h => h.replace(/<!--\s*-->/g, '')

try {
  const m = await server.ssrLoadModule('/src/pages/VolumeImpact.jsx')

  const header = plain(renderToString(React.createElement(m.ContextHeader, {
    summary: { forecast: 682, booked: 541, expectedAdds: 141, budget: 631, variancePct: 8 },
    sites: ['Bright Memorial Hospital'], site: '', onSite() {}, weeks: 4, onWeeks() {},
  })))
  ok('summary leads with the forecast', header.includes('682 cases forecast'))
  ok('booked and expected are shown separately, never collapsed',
    header.includes('541 booked') && header.includes('141 expected to book'))
  ok('variance against budget is on the header', header.includes('+8% vs budget'))
  ok('one control sets site and window for every tab',
    header.includes('All sites') && header.includes('Next 4 weeks'))

  const budget = plain(renderToString(React.createElement(m.BudgetTab, {
    data: {
      thresholds: { onPlanPct: 5, exceptionPct: 15, minCases: 4 },
      grid: [{ weekOf: '2026-09-07', days: [
        { date: '2026-09-09', dow: 2, label: 'Wednesday', forecast: 38, budget: 31,
          variancePct: 22.6, onPlan: false, flagged: true },
        { date: '2026-09-08', dow: 1, label: 'Tuesday', forecast: 32, budget: 31,
          variancePct: 3, onPlan: true, flagged: false }] }],
      days: [{ date: '2026-09-09', dow: 2, label: 'Wednesday', site: 'Bright Memorial Hospital',
               booked: 30, expectedAdds: 8, forecast: 38, budget: 31, variance: 7,
               variancePct: 22.6, flagged: true }],
    }, mix: null, onExpand() {},
  })))
  ok('grid prints its values, so greyscale still reads', budget.includes('+23%'))
  ok('grid states the neutral band', budget.includes('within 5%'))
  ok('day row leads with the forecast', budget.includes('>38<'))
  ok('booked + expected is the subtitle', budget.includes('30 booked + ~8'))
  ok('both thresholds are stated', budget.includes('15%') && budget.includes('4 cases'))

  const inpatient = plain(renderToString(React.createElement(m.InpatientTab, {
    data: { crunchOccupancyPct: 92, suggestions: [{ fromDow: 2, toDow: 3,
              text: 'Shifting inpatient-heavy cases from Wednesday to Thursday would relieve 3 of 5 crunch unit-days in this window.' }],
      units: [{ unit: '5 Central', capacity: 32, days: [
        { date: '2026-09-09', dow: 2, label: 'Wednesday', census: 30, capacity: 32,
          or: 8, ed: 18, other: 4, orPct: 27, occupancyPct: 93.8, crunch: true }] }] },
  })))
  ok('one plain suggestion, not a scenario builder',
    inpatient.includes('Shifting inpatient-heavy cases') && !inpatient.includes('Evaluate'))
  ok('crunch is shape as well as colour', inpatient.includes('svg'))
  ok('the controllable share is named', inpatient.includes('27% OR'))

  const staffing = plain(renderToString(inRouter(React.createElement(m.StaffingTab, {
    data: { blockFillTarget: 75, days: [
      { date: '2026-09-11', dow: 4, label: 'Friday', site: 'Bright Memorial Hospital',
        impliedRooms: 4, staffedRooms: 9, bookedRoomHours: 30, lateDayHours: 0,
        flag: 'OVER', releasable: [{ caseBlock: 'Ortho A', fillPct: 31, hours: 8 }],
        implication: '1 block (8h) is booked under 75% — consider releasing and re-offering before reducing rooms.',
        link: { label: 'Open Release Time Mgmt', href: '/open-time/radar' } },
      { date: '2026-09-09', dow: 2, label: 'Wednesday', site: 'Bright Memorial Hospital',
        impliedRooms: 11, staffedRooms: 9, bookedRoomHours: 70, lateDayHours: 6.2,
        flag: 'UNDER', releasable: [],
        implication: 'Booked volume implies 11 rooms against 9 staffed; about 6.2 room-hours would run past shift end.',
        link: null }] },
  }))))
  ok('fill before flex: a sellable light day says release, not flex down',
    staffing.includes('releasing and re-offering') && !/flex down/i.test(staffing))
  ok('and it links to where that happens', staffing.includes('Open Release Time Mgmt'))
  ok('under and over are described as different problems',
    staffing.includes('late finishes') && staffing.includes('idle salary'))
  ok('late-day exposure is one number', staffing.includes('6.2h'))

  const recovery = plain(renderToString(React.createElement(m.RecoveryTab, {
    data: { tier: 'POTENTIAL', days: [{
      date: '2026-09-10', site: 'Bright Memorial Hospital', tier: 'POTENTIAL', flagged: true,
      implication: 'PACU demand peaks at 9 bays against 7 staffed (13:00–17:00)',
      pacu: { bays: 9, staffed: 7, overBy: 2, overFrom: '13:00', overTo: '17:00' },
      phase2: { bays: 4, staffed: 14, overBy: 0 }, preop: { bays: 5, staffed: 12, overBy: 0 },
      byHour: [{ minuteOfDay: 780, label: '13:00', pacu: 9, phase2: 3, preop: 2 }] }] },
  })))
  ok('recovery peak is called out in words', recovery.includes('peaks at 9 bays against 7 staffed'))
  ok('recovery is labelled POTENTIAL', recovery.includes('POTENTIAL'))
  ok('and says why it is only potential', recovery.includes('not nurse ratios'))
} finally {
  await server.close()
}

let bad = 0
for (const [label, pass] of checks) { if (!pass) bad++; console.log(`  ${pass ? 'ok  ' : 'MISS'} ${label}`) }
if (bad) process.exitCode = 1

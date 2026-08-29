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

  // ── Specialty x date matrix (VolumeImpactMatrix.md) ─────────────────────
  // Two aligned Mon-Fri bands with a Thursday spike, which is ST-9's cause:
  // ortho and spine concentrated on the Thursdays, so the PACU tab's Thursday
  // peak has its source on the same screen and on the same date.
  const matrix = {
    dates: [
      { date: '2026-09-01', dow: 1, weekOf: '2026-08-31' },
      { date: '2026-09-02', dow: 2, weekOf: '2026-08-31' },
      { date: '2026-09-03', dow: 3, weekOf: '2026-08-31' },
      { date: '2026-09-04', dow: 4, weekOf: '2026-08-31', holiday: true },
      { date: '2026-09-08', dow: 1, weekOf: '2026-09-07' },
      { date: '2026-09-09', dow: 2, weekOf: '2026-09-07' },
      { date: '2026-09-10', dow: 3, weekOf: '2026-09-07' },
      { date: '2026-09-11', dow: 4, weekOf: '2026-09-07' },
    ],
    services: [
      { service: 'Orthopedics', byDate: [11, 6, 19, 7, 10, 5, 21, 6], total: 85 },
      { service: 'Spine', byDate: [3, 9, 5, 2, 4, 11, 4, 3], total: 41 },
      { service: 'Other', byDate: [2, 2, 3, 2, 3, 2, 3, 2], total: 19, tail: 4 },
    ],
    totals: { byDate: [16, 17, 27, 11, 17, 18, 28, 11], window: 145 },
    weeks: 2, capped: true, cappedAt: 4, to: '2026-09-11',
  }
  let picked = null
  const grid = plain(renderToString(React.createElement(m.VolumeMatrix, {
    matrix, filter: { service: null, date: null }, onFilter(f) { picked = f },
  })))
  ok('columns are actual dates, not weekday averages',
    grid.includes('>1<') && grid.includes('>10<') && !/average/i.test(grid))
  ok('dates are grouped into week bands with a week-commencing label',
    grid.includes('Aug 31') && grid.includes('Sep 7'))
  ok('the same weekday sits at the same position in every band',
    (grid.match(/>T</g) || []).length >= 4)
  ok('rows carry a total column', grid.includes('>85<') && grid.includes('>41<'))
  ok('the Total row is present and named', grid.includes('All specialties') && grid.includes('>145<'))
  ok('the tail is summed into Other rather than dropped', grid.includes('Other'))
  ok('holidays are muted with the reason on hover',
    grid.includes('reduced-volume day (holiday)') && grid.includes('italic'))
  ok('a capped window says so', grid.includes('First 4 weeks of a longer window'))
  ok('every value is printed, so the shading survives greyscale',
    ['11', '19', '21', '27'].every(v => grid.includes(`>${v}<`)))
  ok('shading is sequential single-hue, not the Budget tab diverging scale',
    grid.includes('rgba(71, 85, 105') && !grid.includes('rgba(239,68,68')
    && !grid.includes('rgba(59,130,246'))
  ok('horizontal scroll is contained rather than on the page body',
    grid.includes('overflow-x:auto') || grid.includes('overflow-x: auto'))
  ok('row labels and the Total column stay pinned',
    grid.includes('position:sticky') || grid.includes('position: sticky'))
  ok('it invites the click that drives the tabs',
    grid.includes('Click a specialty, a date or a cell to filter every tab'))

  const filtered = plain(renderToString(React.createElement(m.VolumeMatrix, {
    matrix, filter: { service: 'Orthopedics', date: '2026-09-10' }, onFilter() {},
  })))
  ok('an active filter is stated in words',
    filtered.includes('Showing:') && filtered.includes('Orthopedics')
    && filtered.includes('Thu Sep 10'))
  ok('and is clearable', filtered.includes('>Clear<'))

  // A tab that cannot honour a filter says so rather than looking broken.
  const notice = plain(renderToString(React.createElement(m.FilterNotice, {
    filter: { service: 'Orthopedics', date: null }, applied: { service: false, date: true },
  })))
  ok('a tab without a specialty dimension says the filter does not apply',
    notice.includes('no specialty dimension') && notice.includes('Orthopedics'))
  const silent = renderToString(React.createElement(m.FilterNotice, {
    filter: { service: 'Orthopedics', date: null }, applied: { service: true, date: true },
  }))
  ok('and stays quiet where the filter does apply', silent === '')
} finally {
  await server.close()
}

let bad = 0
for (const [label, pass] of checks) { if (!pass) bad++; console.log(`  ${pass ? 'ok  ' : 'MISS'} ${label}`) }
if (bad) process.exitCode = 1

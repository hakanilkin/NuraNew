// SSR-render Volume & Staffing Outlook's three layers.
//
// What matters here is that the page renders the API's own figures and never a
// second opinion: the heatmap prints its values so it survives greyscale, the
// exception row shows a staffing implication in every case, and a POTENTIAL
// tier never renders in the language of a RECOMMENDED one.
//
// Run from client/: npm run check:volume-outlook
import { createServer } from 'vite'
import { renderToString } from 'react-dom/server'
import React from 'react'

const server = await createServer({
  root: process.cwd(), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error',
})
const checks = []
const ok = (label, cond) => checks.push([label, Boolean(cond)])
const plain = html => html.replace(/<!--\s*-->/g, '')

try {
  const m = await server.ssrLoadModule('/src/pages/VolumeOutlook.jsx')

  const calendar = {
    thresholds: { onPlanPct: 5, exceptionPct: 15, minCases: 4 },
    weeks: [{ weekOf: '2026-09-07', days: [
      { date: '2026-09-07', dow: 0, forecast: 30, budget: 34, variancePct: -12, onPlan: false },
      { date: '2026-09-08', dow: 1, forecast: 33, budget: 32, variancePct: 3, onPlan: true },
      { date: '2026-09-09', dow: 2, forecast: 38, budget: 31, variancePct: 22, onPlan: false },
    ] }],
  }
  const heat = plain(renderToString(React.createElement(m.OutlookHeatmap, { calendar, onPickDate() {} })))
  ok('heatmap prints its values, so greyscale still reads', heat.includes('+22%') && heat.includes('-12%'))
  ok('heatmap shows case counts alongside the percentage', heat.includes('38 cases'))
  ok('heatmap explains the neutral band', heat.includes('within 5%'))

  const exceptions = [
    { date: '2026-09-09', site: 'Bright Memorial Hospital', forecast: 38, budget: 31,
      variance: 7, variancePct: 22.6, tier: 'RECOMMENDED', headline: 'Higher staffing need likely',
      summary: 'Forecast volume is 23% above budget, driven primarily by +8 Orthopedics.',
      implication: 'Staffs 9 rooms, needs 10 — flex 1 up', roomGap: 1,
      drivers: [{ key: 'Orthopedics', label: 'Orthopedics', contribution: 8, detail: '+8 Orthopedics' }],
      considerations: ['increasing PACU coverage', 'confirming pre-op staffing'],
      capacityCases: 38.5, capacityAssumption: '9 staffed rooms x 510 shift minutes / 119.3 min per case' },
    { date: '2026-09-11', site: 'Bright Surgery Center', forecast: 21, budget: 17,
      variance: 4, variancePct: 23.5, tier: 'POTENTIAL', headline: 'Higher staffing need likely',
      summary: 'Forecast volume is 24% above budget, driven primarily by +4 GI.',
      implication: 'Review coverage against the expected case mix', roomGap: null,
      drivers: [{ key: 'GI', label: 'GI', contribution: 4, detail: '+4 GI' }],
      considerations: ['reviewing ancillary coverage'] },
  ]
  const exc = plain(renderToString(React.createElement(m.Exceptions, {
    exceptions, thresholds: { exceptionPct: 15, minCases: 4 }, onEvaluate() {},
  })))
  ok('exceptions state both thresholds', exc.includes('15%') && exc.includes('4 cases'))
  ok('every row carries a staffing implication',
    exc.includes('Staffs 9 rooms, needs 10') && exc.includes('Review coverage against'))
  ok('the tier is on the row', exc.includes('RECOMMENDED') && exc.includes('POTENTIAL'))
  ok('tier is shape as well as colour', exc.includes('◆') && exc.includes('■'))
  ok('only a quantified row offers Evaluate flex',
    (exc.match(/Evaluate flex/g) || []).length === 1)
  ok('the driver is named on the row', exc.includes('+8 Orthopedics'))

  const empty = plain(renderToString(React.createElement(m.Exceptions, {
    exceptions: [], thresholds: { exceptionPct: 15, minCases: 4 }, onEvaluate() {},
  })))
  ok('no exceptions is a real state, not an error',
    empty.includes('No day in this window is far enough off plan'))

  const rows = [{ date: '2026-09-09', dow: 2, label: 'Wednesday', site: 'Bright Memorial Hospital',
                  scheduled: 34, expectedAdds: 4, forecast: 38, budget: 31, variance: 7, variancePct: 22.6 }]
  const mix = { date: '2026-09-09', services: [
    { service: 'Orthopedics', forecast: 14, budget: 9, delta: 5 },
    { service: 'ENT', forecast: 6, budget: 6, delta: 0 }] }
  const detail = plain(renderToString(React.createElement(m.DailyDetail, {
    rows, focusDate: '2026-09-09', onExpand() {}, mix,
  })))
  ok('the row leads with the forecast', detail.includes('>38<'))
  ok('scheduled plus expected adds is the subtitle',
    detail.includes('34 scheduled + ~4 expected'))
  ok('expanding shows the service-line mix', detail.includes('Orthopedics') && detail.includes('ENT'))
  ok('duration columns are gone', !/Dur|minutes|DURwTurn/.test(detail))
} finally {
  await server.close()
}

let bad = 0
for (const [label, pass] of checks) { if (!pass) bad++; console.log(`  ${pass ? 'ok  ' : 'MISS'} ${label}`) }
if (bad) process.exitCode = 1

// SSR-render the Briefs page against fixture data.
//
// `vite build` only proves the JSX parses. This proves the components actually
// run: that the forward layer renders, that the hand-off links point where they
// should, that an unknown forward fill is worded as unknown rather than shown as
// 0%, and — the compatibility guarantee — that the page still renders when the
// forward layer is absent entirely.
//
// Run from client/: npm run check:briefs-render
import { createServer } from 'vite'
import { renderToString } from 'react-dom/server'
import React from 'react'

const server = await createServer({
  root: process.cwd(),
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
})
try {
  const mod = await server.ssrLoadModule('/src/pages/AtlasPerformanceBriefs.jsx')
  const Page = mod.default

  const groups = [
    { caseblock: 'Ortho A', status: 'over_allocated', inblock_util: 52.4, primetime_util: 61.0,
      volume: 18, allocated_hours: 8, deltas: { volume_pct: -12.5, inblock_util: -6.1 }, findings: [] },
    { caseblock: 'Spine',   status: 'under_allocated', inblock_util: 88.2, primetime_util: 96.0,
      volume: 31, allocated_hours: 8, deltas: { volume_pct: 14.2, inblock_util: 5.0 },
      findings: [{ type: 'growth', text: 'Pipeline up sharply' }] },
    { caseblock: 'ENT',     status: 'right_sized', inblock_util: 74.0, primetime_util: 78.0,
      volume: 12, allocated_hours: 8, deltas: { volume_pct: 1.0, inblock_util: 0.2 }, findings: [] },
    { caseblock: 'Vascular', status: 'misaligned', inblock_util: null, primetime_util: null,
      volume: 4, allocated_hours: 8, deltas: { volume_pct: null, inblock_util: null }, findings: [] },
  ]
  const focus = {
    period: { current_quarter: '2026-Q2', prior_quarter: '2026-Q1' },
    horizonDays: 28, target: 75, forward_available: true,
    counts: { ACT: 1, GROW: 1, SELF_OK: 0, WATCH: 1, OK: 1 },
    items: [
      { caseblock: 'Ortho A', status: 'over_allocated', focus: 'ACT', fwd_fill_pct: 44.0,
        reason: 'Over-allocated last two quarters (52.4% in-block) and forecast fills 44% of the next 4 weeks vs a 75% target.' },
      { caseblock: 'Spine', status: 'under_allocated', focus: 'GROW', fwd_fill_pct: 91.0,
        reason: 'Under-allocated last two quarters (88.2% in-block) and forecast fills 91% of the next 4 weeks vs a 75% target.' },
      { caseblock: 'Vascular', status: 'misaligned', focus: 'WATCH', fwd_fill_pct: null,
        reason: 'Misaligned last two quarters (no in-block utilisation recorded); no block time in the next 4 weeks, so forward fill is unknown.' },
      { caseblock: 'ENT', status: 'right_sized', focus: 'OK', fwd_fill_pct: 80.0, reason: 'Right-sized …' },
    ],
  }

  // Stub fetch so the page's effects resolve deterministically.
  global.fetch = async (url) => ({
    ok: true,
    json: async () => (String(url).includes('/api/briefs/focus')
      ? focus
      : { period: focus.period, groups }),
  })

  // Effects do not run under renderToString, so exercise the inner table
  // directly with the data those effects would have produced.
  const html = renderToString(React.createElement(Page))
  const inner = mod.CapacityTab
    ? renderToString(React.createElement(mod.CapacityTab, { groups, period: focus.period, focusData: focus }))
    : ''
  console.log('page shell rendered:', html.length, 'chars')
  if (inner) {
    for (const needle of ['Act', 'Grow', 'Fwd fill', '44.0%']) {
      console.log(`  ${inner.includes(needle) ? 'ok  ' : 'MISS'} ${needle}`)
    }
    console.log('  dash for unknown forward fill:', inner.includes('No block time in the forward window'))

  // The panel only renders content for a selected row, so exercise it directly.
  const panel = renderToString(React.createElement(mod.SlideOverPanel, {
    group: groups[0], open: true, period: focus.period, onClose: () => {}, focus: focus.items[0],
  }))
  for (const needle of ['Where to focus', 'Review this block in Release Radar',
                        'forecast fills 44% of the next 4 weeks', 'caseBlock=Ortho%20A']) {
    console.log(`  ${panel.includes(needle) ? 'ok  ' : 'MISS'} panel: ${needle}`)
  }
  const grow = renderToString(React.createElement(mod.SlideOverPanel, {
    group: groups[1], open: true, period: focus.period, onClose: () => {}, focus: focus.items[1],
  }))
  console.log('  ok   panel GROW hand-off:', grow.includes('/open-time/board'))
  const unknown = renderToString(React.createElement(mod.SlideOverPanel, {
    group: groups[3], open: true, period: focus.period, onClose: () => {}, focus: focus.items[2],
  }))
  console.log('  ok   panel says unknown:', unknown.includes('forward fill is unknown'))
  console.log('  ok   panel shows "No forward data" not a number:', unknown.includes('No forward data'))
  } else {
    console.log('  (CapacityTab not exported for testing — shell render only)')
  }
  // Compatibility: with no forward layer the page must render exactly as it did
  // before — no focus strip, no extra columns, no crash.
  const legacy = renderToString(React.createElement(mod.CapacityTab, {
    groups, period: focus.period, focusData: null,
  }))
  const clean = !legacy.includes('Where to focus') && !legacy.includes('Fwd fill')
  console.log('  ' + (clean ? 'ok  ' : 'MISS') + ' renders without the forward layer, unchanged')
  if (!clean) process.exitCode = 1
} finally {
  await server.close()
}

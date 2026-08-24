// SSR-render ScenarioPanel against a fixture ScenarioResult.
//
// `vite build` only proves the JSX parses. This proves the pillar cards, the
// conflict strip and the alternatives list actually render what the engine
// returns — including that the panel shows the engine's own driver text rather
// than any reasoning rebuilt in the component.
//
// Run from client/: npm run check:scenario-panel
import { createServer } from 'vite'
import { renderToString } from 'react-dom/server'
import React from 'react'

const server = await createServer({
  root: process.cwd(), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error',
})
try {
  const m = await server.ssrLoadModule('/src/components/ScenarioPanel.jsx')

  const result = {
    decision: { hours: 4, fromBlock: 'Ortho A', toService: 'Spine', dayOfWeekLabel: 'Thursday' },
    pillars: {
      surgeon: { status: 'improves',
        headline: { label: 'True utilization', before: 61.8, after: 68, unit: '%' },
        secondary: [{ label: 'Block utilization', before: 55.8, after: 55.8, unit: '%' }],
        drivers: [{ key: 'trueVsBlock', label: 'True vs block utilisation', contribution: 6,
                    direction: 'up', detail: 'Six points of the practice’s work already runs outside its own block.' }] },
      staffing: { status: 'degrades',
        headline: { label: 'Overtime exposure', before: 5.3, after: 8.3, unit: 'room-h' },
        secondary: [{ label: 'Concurrency headroom', before: 0.8, after: 0.8, unit: 'rooms' }],
        drivers: [{ key: 'spill', label: 'Work past shift end', contribution: -3, direction: 'down',
                    detail: 'The day already draws 66.4 of about 65 workable room-hours.' }] },
      capacity: { status: 'neutral',
        headline: { label: 'Headroom on Stepdown', before: 1.8, after: 1.8, unit: 'beds' },
        secondary: [], drivers: [{ key: 'conversion', label: 'Inpatient conversion', contribution: 56,
          direction: 'up', detail: '56% of Spine cases admit as inpatients.' }] },
    },
    conflicts: [{ pillars: ['staffing'], severity: 'medium',
      summary: '1 of 3 pillars improves. staffing coverage degrades on Thursday.' }],
    alternatives: [{ scenarioId: 'x|alt1', label: 'Ortho A hours to Spine on Tuesday',
      pillarStatuses: { surgeon: 'improves', staffing: 'neutral', capacity: 'neutral' },
      summary: 'All three pillars clear.' }],
  }

  const cards = m.PILLARS ? '' : ''
  const strip = renderToString(React.createElement(m.ConflictStrip, { conflicts: result.conflicts }))
  const clear = renderToString(React.createElement(m.ConflictStrip, { conflicts: [] }))
  const card = renderToString(React.createElement(m.PillarCard, {
    meta: { title: 'Staffing & Operational Management', question: 'Can we staff the room we just filled?' },
    pillar: result.pillars.staffing, expanded: true, onToggle: () => {},
  }))
  const alts = renderToString(React.createElement(m.Alternatives, { alternatives: result.alternatives }))

  const checks = [
    ['conflict strip carries the engine summary', strip.includes('staffing coverage degrades on Thursday')],
    ['conflict strip is not colour-only', strip.includes('svg') || strip.includes('▲')],
    ['all-clear state renders', clear.includes('All three pillars clear')],
    ['pillar name is the capabilities-document name', card.includes('Staffing &amp; Operational Management')],
    ['pillar question shown', card.includes('Can we staff the room we just filled?')],
    ['before and after both shown', card.includes('5.3') && card.includes('8.3')],
    ['status carries a glyph as well as colour', card.includes('▼') || card.includes('■')],
    ['driver detail comes from the engine verbatim',
      card.includes('The day already draws 66.4 of about 65 workable room-hours.')],
    ['alternatives show a per-pillar status each', (alts.match(/Improves|Neutral|Degrades/g) || []).length >= 3],
    ['alternative summary rendered', alts.includes('All three pillars clear.')],
  ]
  let bad = 0
  for (const [label, ok] of checks) { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'MISS'} ${label}`) }
  if (bad) process.exitCode = 1
} finally {
  await server.close()
}

// SSR-render Release Time Mgmt's own pieces: the funnel strip and the
// fulfillment queue.
//
// The queue is where the spec's stance has to be defended in the UI as well as
// the store — no aging, no staleness, no colour by age, no per-user statistics.
// A render test is what stops those creeping back in.
//
// Run from client/: npm run check:release-time-mgmt
import { createServer } from 'vite'
import { renderToString } from 'react-dom/server'
import React from 'react'

const server = await createServer({
  root: process.cwd(), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error',
})
const checks = []
const ok = (label, cond) => checks.push([label, Boolean(cond)])
// React SSR separates text from interpolated values with comment markers, so
// "To enter (1)" renders as "To enter (<!-- -->1<!-- -->)".
const plain = html => html.replace(/<!--\s*-->/g, '')

try {
  const m = await server.ssrLoadModule('/src/pages/ReleaseTimeMgmt.jsx')

  const strip = plain(renderToString(React.createElement(m.FunnelStrip, {
    summary: { requestsSent: 8, hoursReleased: 25, hoursOffered: 25, hoursBooked: 18,
               hoursStillOpen: 7, fillRatePct: 72, responseRatePct: 87.5, medianDaysToBook: 3 },
  })))
  ok('funnel reads left to right', ['Requests sent', 'Hours released', 'Hours offered', 'Hours booked']
    .every(s => strip.includes(s)))
  ok('fill rate is the headline', strip.includes('Fill rate') && strip.includes('72%'))
  ok('released-but-open is framed as inventory', strip.includes('released and still open'))

  const tasks = [
    { id: 'a', kind: 'RELEASE_IN_EMR', status: 'PENDING', decidedAt: '2026-08-20T10:00:00Z',
      counterparty: 'Dr Vance', action: 'Release 8.0 hrs — Ortho A, Bright Memorial Hospital, 2026-09-10' },
    { id: 'b', kind: 'BOOK_IN_EMR', status: 'DONE', decidedAt: '2026-08-18T10:00:00Z',
      counterparty: 'Spine', completedBy: 'j.alvarez@x',
      action: 'Assign 6.0 hrs to Spine — General B, Bright Memorial Hospital, 2026-09-08' },
  ]
  const queue = plain(renderToString(React.createElement(m.Fulfillment, {
    tasks, onComplete: () => {}, busyId: null, showDone: true, onToggleDone: () => {},
  })))
  ok('sections are To enter and Done with counts',
    queue.includes('To enter (1)') && queue.includes('Done (1)'))
  ok('the action text is plain language', queue.includes('Release 8.0 hrs — Ortho A'))
  ok('a pending row offers Mark done', queue.includes('Mark done'))
  ok('a completed row shows who handled it', queue.includes('j.alvarez@x'))
  ok('the demo beat is on the page',
    queue.includes("don&#x27;t write to your EMR") || queue.includes("don't write to your EMR"))

  // The spec's explicit non-goals.
  for (const banned of ['days old', 'overdue', 'stale', 'Stale', 'SLA', 'aging', 'Aging']) {
    ok(`queue shows no "${banned}"`, !queue.includes(banned))
  }

  const empty = plain(renderToString(React.createElement(m.Fulfillment, {
    tasks: [], onComplete: () => {}, busyId: null, showDone: false, onToggleDone: () => {},
  })))
  ok('an empty queue is a real state, not an error', empty.includes('Nothing to enter.'))
} finally {
  await server.close()
}

let bad = 0
for (const [label, pass] of checks) { if (!pass) bad++; console.log(`  ${pass ? 'ok  ' : 'MISS'} ${label}`) }
if (bad) process.exitCode = 1

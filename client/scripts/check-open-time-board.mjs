// SSR-render the Open Time Board's three lists.
//
// One flat list with status chips answered no question in particular. Three
// lists each answer one, in the order a scheduler works them: action, in
// flight, done. What this defends is that the list a row sits in *is* its
// status — no chip repeating it — and that the case the spec found stays fixed:
// a slot whose offers were all declined belongs back in "needs an offer",
// carrying who already said no.
//
// Run from client/: npm run check:open-time-board
import { createServer } from 'vite'
import { renderToString } from 'react-dom/server'
import React from 'react'

const server = await createServer({
  root: process.cwd(), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error',
})
const checks = []
const ok = (label, cond) => checks.push([label, Boolean(cond)])
const plain = h => h.replace(/<!--\s*-->/g, '')
const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString()

try {
  const m = await server.ssrLoadModule('/src/pages/OpenTimeBoard.jsx')

  const slots = [
    { id: 'a', list: 'NEEDS_OFFER', status: 'OPEN', caseBlock: 'Uro/Gyn',
      blockDate: '2026-09-15', site: 'Bright Memorial Hospital', service: 'Urology',
      durationMins: 300, offers: [], bookedBy: null, bookedAt: null },
    // The slot the spec is about: everybody declined, so it is work again.
    { id: 'b', list: 'NEEDS_OFFER', status: 'OPEN', caseBlock: 'Colorectal',
      blockDate: '2026-09-18', site: 'Bright Memorial Hospital', service: 'Colorectal',
      durationMins: 360, bookedBy: null, bookedAt: null,
      offers: [{ id: 'o1', candidate: 'Dr Reyes', status: 'PASSED', sentAt: daysAgo(5),
                 respondedAt: daysAgo(3) }] },
    { id: 'c', list: 'AWAITING', status: 'OFFERED', caseBlock: 'ASC Plastics',
      blockDate: '2026-09-11', site: 'Bright Surgery Center', service: 'Plastics',
      durationMins: 420, bookedBy: null, bookedAt: null,
      offers: [{ id: 'o2', candidate: 'Dr Okafor', status: 'SENT', sentAt: daysAgo(1) },
               { id: 'o3', candidate: 'Dr Lin', status: 'SENT', sentAt: daysAgo(1) }] },
    { id: 'd', list: 'BOOKED', status: 'BOOKED', caseBlock: 'General B',
      blockDate: '2026-09-08', site: 'Bright Memorial Hospital', service: 'General Surgery',
      durationMins: 360, bookedBy: 'Dr Vance', bookedAt: daysAgo(2), offers: [] },
    { id: 'e', list: 'BOOKED', status: 'BOOKED', caseBlock: 'ENT',
      blockDate: '2026-09-04', site: 'Bright Memorial Hospital', service: 'ENT',
      durationMins: 240, bookedBy: 'Dr Patel', bookedAt: daysAgo(6), offers: [] },
  ]

  const html = plain(renderToString(React.createElement(m.BoardLists, {
    slots, selId: null, onSelect() {},
  })))

  ok('three lists render', ['Needs an offer', 'Awaiting response', 'Booked']
    .every(t => html.includes(t)))
  ok('in the order action, in flight, done',
    html.indexOf('Needs an offer') < html.indexOf('Awaiting response')
    && html.indexOf('Awaiting response') < html.indexOf('Booked'))
  ok('list 1 has visual primacy over the other two',
    html.indexOf('font-size:15px') > -1
    && html.indexOf('font-size:15px') < html.indexOf('Awaiting response'))

  ok('each header carries a count and total hours',
    html.includes('2 slots · 11.0h') && html.includes('1 slot · 7.0h')
    && html.includes('2 slots · 10.0h'))
  ok('no status chips inside the lists — the list is the status',
    !/>Open<|>Offered<|>Booked by[^<]*<\/span>/.test(html)
    && !html.includes('background:#fef3c7'))

  ok('a second attempt states who already said no, and when',
    html.includes('Offered to Dr Reyes') && html.includes('declined 3 days ago'))
  ok('list 2 names the offeree and when it was sent',
    html.includes('Dr Okafor') && html.includes('sent yesterday'))
  ok('and says how many others were offered alongside',
    html.includes('+1 more'))
  ok('list 3 names who booked and when',
    html.includes('Booked by Dr Vance') && html.includes('2 days ago'))
  ok('the win list reads most recent first',
    html.indexOf('General B') < html.indexOf('>ENT<'))
  ok('every slot appears exactly once',
    slots.every(s => (html.match(new RegExp(`>${s.caseBlock}<`, 'g')) || []).length === 1))

  // Empty lists are real states, phrased as such.
  const empty = plain(renderToString(React.createElement(m.BoardLists, {
    slots: [], selId: null, onSelect() {},
  })))
  ok('an empty list is a plain sentence, not a blank panel or an error',
    empty.includes('Nothing needs an offer.')
    && empty.includes('Nothing awaiting response.')
    && empty.includes('Nothing booked yet.'))
  ok('and an empty list shows no count', !empty.includes('0 slots'))
} finally {
  await server.close()
}

let bad = 0
for (const [label, pass] of checks) { if (!pass) bad++; console.log(`  ${pass ? 'ok  ' : 'MISS'} ${label}`) }
if (bad) process.exitCode = 1

// SSR-render Block Allocations.
//
// The week-shape is the page: outline allocated, fill used in block, hatch
// booked outside. Hatch on a day with no outline is the wrong-day finding, and
// it has to read without colour and without a number. That, and the fact that
// every recommendation is specific rather than "consider adjusting", are what
// this defends.
//
// Run from client/: npm run check:block-allocations
import { createServer } from 'vite'
import { renderToString } from 'react-dom/server'
import React from 'react'
import { MemoryRouter } from 'react-router-dom'

const server = await createServer({
  root: process.cwd(), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error',
})
const checks = []
const ok = (label, cond) => checks.push([label, Boolean(cond)])
const plain = h => h.replace(/<!--\s*-->/g, '')

try {
  const m = await server.ssrLoadModule('/src/pages/BlockAllocations.jsx')

  // A wrong-day week: Tuesday held and nearly empty, Thursday busy and unheld.
  const wrongDayWeek = [
    { dow: 0, alloc: 0, used: 0, outside: 0.4 },
    { dow: 1, alloc: 8, used: 2.4, outside: 0.2 },
    { dow: 2, alloc: 0, used: 0, outside: 0.6 },
    { dow: 3, alloc: 0, used: 0, outside: 6.3 },
    { dow: 4, alloc: 0, used: 0, outside: 0.3 },
  ]
  const shape = plain(renderToString(React.createElement(m.WeekShape, { byDow: wrongDayWeek })))
  ok('week shape draws allocated as an outline', shape.includes('fill="none"'))
  ok('and out-of-block as a hatch, not a colour', shape.includes('url(#ba-hatch)'))
  ok('every weekday is labelled', ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].every(d => shape.includes(d)))
  // The Thursday bar has hatch and no outline — the finding, visible as shape.
  const hatchCount = (shape.match(/ba-hatch/g) || []).length
  ok('hatch appears on days with no allocation', hatchCount > 1)

  const legend = plain(renderToString(React.createElement(m.ShapeLegend)))
  ok('the legend names all three quantities',
    legend.includes('Allocated') && legend.includes('Used in block')
    && legend.includes('Booked outside a block'))

  const owners = [
    { owner: 'Vascular', service: 'Vascular', site: 'Bright Memorial Hospital',
      pattern: 'WRONG_DAY', mismatchHours: 6.3, trend: 'STABLE', trendPct: 2,
      byDow: wrongDayWeek,
      drivers: [{ key: 'held_day', label: 'Tuesday allocation', contribution: 5.6,
                  detail: 'Tuesday: 2.4h used of 8.0h held' }],
      recommendation: { text: 'Move the Tuesday block to Thursday — 6.3h a week is already being booked there.',
                        deltaHours: 0, targetDow: 3 },
      releaseHistory: { count: 0, of: 13 } },
    { owner: 'Ortho A', service: 'Orthopedics', site: 'Bright Memorial Hospital',
      pattern: 'ABANDONED', mismatchHours: 8.0, trend: 'DECLINING', trendPct: -18,
      byDow: [{ dow: 3, alloc: 8, used: 4.8, outside: 0.4 }],
      drivers: [{ key: 'releases', label: 'Release history', contribution: 9,
                  detail: 'Released 9 of 13 instances (69%)' }],
      recommendation: { text: 'Released 9 of the last 13 instances — reallocate rather than re-release.',
                        deltaHours: -8, targetDow: null },
      releaseHistory: { count: 9, of: 13 } },
    { owner: 'Spine', service: 'Spine', site: 'Bright Memorial Hospital',
      pattern: 'UNDER_ALLOCATED', mismatchHours: 9.2, trend: 'GROWING', trendPct: 44,
      byDow: [{ dow: 0, alloc: 8, used: 6.2, outside: 4.6 }],
      drivers: [], recommendation: { text: 'Add about 6.9h a week — the block runs at 75% and 9.2h is already spilling outside it.', deltaHours: 6.9 },
      releaseHistory: { count: 0, of: 26 } },
    { owner: 'Ortho B', service: 'Orthopedics', site: 'Bright Memorial Hospital',
      pattern: 'RIGHT_SIZED', mismatchHours: 0, trend: 'STABLE', trendPct: 1,
      byDow: [{ dow: 1, alloc: 8, used: 6.4, outside: 0.5 }],
      drivers: [], recommendation: { text: 'No change.', deltaHours: 0 },
      releaseHistory: { count: 0, of: 13 } },
    { owner: 'General A', service: 'General Surgery', site: 'Bright Memorial Hospital',
      pattern: 'MISPLACED', mismatchHours: 5.5, trend: 'STABLE', trendPct: 3,
      byDow: [{ dow: 1, alloc: 8, used: 5.6, outside: 6.4 }],
      drivers: [], recommendation: { text: 'Uses 70% of an 8.0h block while booking 6.4h a week outside it.', deltaHours: 0 },
      releaseHistory: { count: 1, of: 26 } },
    // No forward data at all: the cell has to say so rather than imply stability.
    { owner: 'Colorectal', service: 'Colorectal', site: 'Bright Memorial Hospital',
      pattern: 'UNCLASSIFIED', mismatchHours: 0, trend: 'STABLE', trendPct: null,
      byDow: [{ dow: 2, alloc: 8, used: 5.2, outside: 1.1 }],
      drivers: [], recommendation: { text: 'No clear pattern — review with the owner.', deltaHours: 0 },
      releaseHistory: { count: 0, of: 13 } },
  ]
  const table = plain(renderToString(inRouter(React.createElement(m.OwnerTable, {
    owners, onDetails() {},
  }))))
  ok('pattern is a chip with a glyph, not colour alone',
    table.includes('⇄') && table.includes('✕') && table.includes('▲'))
  ok('misplaced and unclassified carry their own glyphs',
    table.includes('◇') && table.includes('?'))
  ok('unmatched blocks are never labelled right-sized',
    table.includes('No clear pattern') && !/UNCLASSIFIED/.test(table))
  ok('mismatch is stated in hours a week', table.includes('h/wk'))
  ok('recommendations are specific, never "consider adjusting"',
    table.includes('Move the Tuesday block to Thursday') && !/consider adjusting/i.test(table))
  ok('the abandoned row states the count', table.includes('Released 9 of the last 13'))

  // BlockAllocationsFixes.md §4: label plus signed whole percentage, so the
  // cell reads without interpretation and without relying on colour.
  ok('the pipeline column is named Pipeline, not Trend',
    table.includes('>Pipeline<') && !table.includes('>Trend<'))
  ok('pipeline reads as a label and a signed whole percentage',
    table.includes('Growing') && table.includes('+44%')
    && table.includes('Declining') && table.includes('\u221218%'))
  ok('a thin forward book says so rather than printing 0%',
    table.includes('No forward data'))

  // §3: the scenario panel is gone from this page; evidence replaces it.
  ok('"Evaluate impact" is gone from this page', !table.includes('Evaluate impact'))
  ok('every row offers See details, including the right-sized one',
    (table.match(/See details/g) || []).length === owners.length)

  // §3a/§3b: the drawer carries the evidence and nothing else.
  const drawer = plain(renderToString(inRouter(React.createElement(m.DetailDrawer, {
    owner: owners[0], open: true, focus: 'shape', onClose() {},
  }))))
  ok('the drawer is a right slide-over dialog',
    drawer.includes('role="dialog"') && drawer.includes('translateX(0)'))
  ok('it carries the week shape at full size',
    drawer.includes('url(#ba-hatch)') && drawer.includes('fill="none"'))
  ok('and the numeric day table, released included',
    ['Allocated', 'Used', 'Outside', 'Released'].every(h => drawer.includes(`>${h}<`)))
  ok('with a week total', drawer.includes('>Week<'))
  ok('it names the pipeline as its second half', drawer.includes('>Pipeline<'))
  ok('and nothing else — no recommendation restated, no scenario controls',
    !drawer.includes('Move the Tuesday block to Thursday')
    && !/Evaluate impact|Apply|Alternatives/.test(drawer))

  const cell = plain(renderToString(React.createElement(m.PipelineCell, {
    trend: 'GROWING', pct: 38.4, onOpen() {},
  })))
  ok('a growing pipeline reads "Growing +38%"',
    cell.includes('Growing') && cell.includes('+38%'))
  ok('and it is clickable through to the evidence', cell.includes('<button'))
} finally {
  await server.close()
}

function inRouter(el) { return React.createElement(MemoryRouter, null, el) }

let bad = 0
for (const [label, pass] of checks) { if (!pass) bad++; console.log(`  ${pass ? 'ok  ' : 'MISS'} ${label}`) }
if (bad) process.exitCode = 1

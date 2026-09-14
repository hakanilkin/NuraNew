import { Fragment, useState, useEffect } from 'react'
import { AlertCircle, ChevronDown, ChevronRight, X, TrendingUp, TrendingDown, Minus } from 'lucide-react'

/* ─── Block Allocations (BlockAllocations.md) ─────────────────────────────────
   A quarterly block committee review. The question is not "which blocks have
   low utilization" — it is "where does the allocated grid disagree with how
   surgeons actually practise, and what should we change?" The action is
   reallocation, not release.

   The week-shape is the whole point: outline is allocated, fill is used inside
   the block, hatch is booked outside any block. Hatch sitting on a day with no
   outline is a wrong-day finding, visible without reading a number.          */

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']
const fmt1 = v => (v == null ? '—' : Number(v).toFixed(1))

/* Pattern carries a glyph as well as a colour — projector rule — and the label
   names the fix, not the symptom. */
/* Group by the decision, not the symptom (BlockAllocationsFiveVerdicts.md). The
   nine internal patterns from block_patterns.py map onto five verdicts for
   display only — the classifier, the recommendation sentence and the drawer are
   untouched, so the specific diagnosis still reads next to the chip. */
const VERDICT = {
  RIGHT_SIZED:     'RIGHT_SIZED',
  OVER_ALLOCATED:  'TOO_MUCH',    ABANDONED:   'TOO_MUCH',
  UNDER_ALLOCATED: 'TOO_LITTLE',
  WRONG_DAY:       'PLACEMENT',   WRONG_SHAPE: 'PLACEMENT',
  MISPLACED:       'PLACEMENT',   FRAGMENTED:  'PLACEMENT',
  NON_PRIME_TIME:  'NON_PRIME_TIME',
}
// Order the verdict chips appear in the summary row.
const VERDICT_ORDER = ['PLACEMENT', 'TOO_MUCH', 'TOO_LITTLE', 'NON_PRIME_TIME', 'RIGHT_SIZED', 'UNCLASSIFIED']

function verdictConfig(v) {
  switch (v) {
    case 'RIGHT_SIZED':    return { label: 'Right-sized',     glyph: '■', color: '#15803d', bg: 'rgba(34,197,94,0.12)' }
    case 'TOO_MUCH':       return { label: 'Too much time',   glyph: '▼', color: '#dc2626', bg: 'rgba(239,68,68,0.11)' }
    case 'TOO_LITTLE':     return { label: 'Too little time', glyph: '▲', color: '#2563eb', bg: 'rgba(59,130,246,0.12)' }
    case 'PLACEMENT':      return { label: 'Wrong placement', glyph: '⇄', color: '#7c3aed', bg: 'rgba(124,58,237,0.13)' }
    case 'NON_PRIME_TIME': return { label: 'Non-prime time',  glyph: '☾', color: '#0891b2', bg: 'rgba(8,145,178,0.12)' }
    // Never an endorsement. A silent fallback that reads as "fine" is the thing
    // a sceptical director catches on a projector.
    default:               return { label: 'No clear pattern', glyph: '?', color: 'var(--color-gray-500)', bg: 'rgba(100,116,139,0.10)' }
  }
}
// The chip for a block: its internal pattern resolved to a verdict.
const patternChip = p => verdictConfig(VERDICT[p] ?? 'UNCLASSIFIED')

// Findings count is keyed on the RAW pattern, so it never moves with the display
// mapping — an UNCLASSIFIED or RIGHT_SIZED block is inert whatever chip it shows.
const INERT = new Set(['RIGHT_SIZED', 'UNCLASSIFIED'])

/* Pipeline: label plus number, so the cell reads without interpretation. The
   label carries the meaning by word and by icon — never by colour alone — and
   a signed whole percentage gives it a magnitude. Where the forward book is
   too thin to divide by, say so rather than printing a confident 0%. */
export function PipelineCell({ trend, pct, onOpen }) {
  const known = pct != null && trend
  const Icon = trend === 'GROWING' ? TrendingUp : trend === 'DECLINING' ? TrendingDown : Minus
  const color = trend === 'GROWING' ? '#15803d' : trend === 'DECLINING' ? '#b91c1c' : 'var(--color-gray-500)'
  const label = trend === 'GROWING' ? 'Growing' : trend === 'DECLINING' ? 'Declining' : 'Stable'
  if (!known) {
    return <span style={{ fontSize: 11, color: 'var(--color-gray-400)' }}>No forward data</span>
  }
  const body = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11,
                   fontWeight: 700, color }}>
      <Icon size={12} aria-hidden="true" />{label}
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>
        {pct > 0 ? '+' : pct < 0 ? '\u2212' : ''}{Math.abs(Math.round(pct))}%
      </span>
    </span>
  )
  if (!onOpen) return body
  return (
    <button type="button" onClick={onOpen}
      title="Show the forward book behind this"
      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer',
               textDecorationLine: 'underline', textDecorationStyle: 'dotted',
               textUnderlineOffset: 3, textDecorationColor: 'var(--color-gray-300)' }}>
      {body}
    </button>
  )
}

/* Five bars, Monday to Friday. Allocated is an outline, used is a solid fill,
   and volume booked outside any block is hatched — so the three quantities are
   distinguishable without colour. */
export function WeekShape({ byDow, height = 46, width = 30 }) {
  const peak = Math.max(1, ...byDow.map(d => Math.max(d.alloc ?? 0, (d.used ?? 0) + (d.outside ?? 0))))
  const h = v => Math.max(0, ((v ?? 0) / peak) * height)
  // Bars scale with the pitch so the drawer's full-size shape is the same
  // drawing, not a second one that could disagree with the row.
  const bw = Math.round(width * 0.4)
  return (
    <svg width={5 * width} height={height + 14} role="img" aria-label="Allocated, used and out-of-block hours by weekday">
      <defs>
        <pattern id="ba-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="5" stroke="#64748b" strokeWidth="2" />
        </pattern>
      </defs>
      {byDow.map((d, i) => {
        const x = i * width + 3
        return (
          <g key={d.dow}>
            {/* Out-of-block first, so it reads as volume that found somewhere else. */}
            {d.outside > 0.05 && (
              <rect x={x + bw + 1} y={height - h(d.outside)} width={bw - 2} height={h(d.outside)}
                    fill="url(#ba-hatch)" opacity="0.75" />
            )}
            {d.alloc > 0.05 && (
              <rect x={x} y={height - h(d.alloc)} width={bw} height={h(d.alloc)}
                    fill="none" stroke="var(--color-blue)" strokeWidth="1.4" />
            )}
            {d.used > 0.05 && (
              <rect x={x} y={height - h(d.used)} width={bw} height={h(d.used)}
                    fill="var(--color-blue)" opacity="0.55" />
            )}
            <line x1={x - 2} x2={x + width - 4} y1={height} y2={height} stroke="var(--surface-border)" />
            <text x={x + bw} y={height + 11} fontSize="9" textAnchor="middle"
                  fill="var(--color-gray-400)">{DOW[i]}</text>
          </g>
        )
      })}
    </svg>
  )
}

/* ─── The caption under the bars (BlockAllocationsNumbers.md) ─────────────────
   The shape shows pattern — which days are held, where the volume actually
   lands. It does not show size, and a committee reading the row cannot tell
   whether a short Tuesday is two hours or twelve. That is the difference
   between a footnote and an agenda item, and the numbers are already on the row.

   Never colour-coded: the pattern chip carries status, and a second status
   signal in the same cell would compete with it. */
export function ShapeCaption({ byDow }) {
  const sum = k => (byDow ?? []).reduce((t, d) => t + (d[k] ?? 0), 0)
  const alloc = sum('alloc')
  const used = sum('used')
  const outside = sum('outside')
  const cases = (byDow ?? []).some(d => d.outsideCases != null) ? sum('outsideCases') : null
  const util = alloc > 0 ? (used / alloc) * 100 : null
  // Share of the outside hours that is daytime (prime). Drops entirely when the
  // split is unavailable for a tenant, so the line degrades to hours and cases.
  const hasSplit = (byDow ?? []).some(d => d.outsidePrime != null)
  const primePct = (hasSplit && outside > 0) ? Math.round(sum('outsidePrime') / outside * 100) : null

  const line = { fontSize: 11, lineHeight: 1.45, color: 'var(--color-gray-500)',
                 fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }
  return (
    <div style={{ marginTop: 3 }}>
      <div style={line}>
        {util == null ? 'No block allocated' : `${Math.round(util)}% of ${fmt1(alloc)}h in block`}
      </div>
      {/* A row reading "0h · 0 cases outside" spends a line saying nothing, and
          the absence is itself informative when scanning the column. */}
      {outside >= 0.5 && (
        <div style={line}>
          {fmt1(outside)}h{cases == null ? '' : ` · ${Math.round(cases)} cases`} outside
          {primePct == null ? '' : ` (${primePct}% prime)`}
        </div>
      )}
    </div>
  )
}

export function ShapeLegend() {
  return (
    <div style={{ display: 'flex', gap: 16, fontSize: 'var(--font-size-xs)',
                  color: 'var(--color-gray-500)', flexWrap: 'wrap' }}>
      <span><span style={{ display: 'inline-block', width: 10, height: 10, border: '1.4px solid var(--color-blue)', marginRight: 5 }} />Allocated</span>
      <span><span style={{ display: 'inline-block', width: 10, height: 10, background: 'var(--color-blue)', opacity: 0.55, marginRight: 5 }} />Used in block</span>
      <span><span style={{ display: 'inline-block', width: 10, height: 10, background: 'repeating-linear-gradient(45deg,#64748b,#64748b 2px,transparent 2px,transparent 4px)', marginRight: 5 }} />Booked outside a block</span>
    </div>
  )
}

const TH_BASE = { padding: '8px 11px', fontSize: 12, fontWeight: 600, textAlign: 'left',
                  color: 'var(--color-text-primary)', borderBottom: '1px solid var(--color-border-secondary)' }
const TD_BASE = { padding: '10px 11px', fontSize: 'var(--font-size-sm)', color: 'var(--color-gray-700)',
                  borderBottom: '1px solid var(--surface-border)', verticalAlign: 'middle' }
const SECTION_LABEL = { fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em',
                        fontWeight: 700, color: 'var(--color-gray-600)', marginBottom: 8 }

/* ─── See details ────────────────────────────────────────────────────────────
   Evidence, not a simulation. A committee reviewing allocations wants to know
   why the number on the row is the number on the row; the scenario panel keeps
   its Release Time Mgmt host, where the question actually is "what if".

   Exactly two things: the evidence behind the utilization figure, and the
   evidence behind the Pipeline column. Nothing restated, nothing linking out. */

/* Forward booked cases a week against the owner's own trailing baseline. The
   baseline is drawn and labelled rather than implied, so "+38%" has a visible
   denominator. */
function PipelineChart({ pipeline }) {
  const weeks = pipeline?.weeks ?? []
  const base = pipeline?.baselinePerWeek
  if (!weeks.length) {
    return (
      <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)', margin: 0 }}>
        No forward bookings in the horizon for this block.
      </p>
    )
  }
  const W = 46, H = 92, pad = 26
  const peak = Math.max(1, ...weeks.map(w => w.cases), base ?? 0)
  const y = v => H - (v / peak) * H
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width={Math.max(200, weeks.length * W + pad)} height={H + 30} role="img"
           aria-label="Forward booked cases by week against the trailing baseline">
        {weeks.map((w, i) => (
          <g key={w.weekAhead}>
            <rect x={pad + i * W + 8} y={y(w.cases)} width={W - 20} height={H - y(w.cases)}
                  fill="var(--color-blue)" opacity="0.55" />
            <text x={pad + i * W + 8 + (W - 20) / 2} y={y(w.cases) - 4} fontSize="10"
                  textAnchor="middle" fill="var(--color-gray-600)"
                  style={{ fontVariantNumeric: 'tabular-nums' }}>{w.cases}</text>
            <text x={pad + i * W + 8 + (W - 20) / 2} y={H + 13} fontSize="9" textAnchor="middle"
                  fill="var(--color-gray-400)">wk {w.weekAhead}</text>
          </g>
        ))}
        {base > 0 && (
          <g>
            <line x1={pad} x2={pad + weeks.length * W} y1={y(base)} y2={y(base)}
                  stroke="var(--color-gray-500)" strokeWidth="1.3" strokeDasharray="4 3" />
            <text x={pad - 4} y={y(base) + 3} fontSize="9" textAnchor="end"
                  fill="var(--color-gray-500)">{Math.round(base)}</text>
          </g>
        )}
        <line x1={pad} x2={pad + weeks.length * W} y1={H} y2={H} stroke="var(--surface-border)" />
      </svg>
    </div>
  )
}

function DayTable({ byDow }) {
  const tot = k => byDow.reduce((t, d) => t + (d[k] ?? 0), 0)
  const cell = { ...TD_BASE, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
  // The Outside column splits into prime (operating-day) and non-prime (after it)
  // where the tenant carries the split; prime + non-prime reconcile to the
  // caption's total. Without it, the single Outside column stands as before.
  const hasSplit = byDow.some(d => d.outsidePrime != null)
  const cols = hasSplit
    ? ['alloc', 'used', 'outsidePrime', 'outsideNonPrime', 'released']
    : ['alloc', 'used', 'outside', 'released']
  const head = hasSplit
    ? ['Allocated', 'Used', 'Outside (prime)', 'Outside (non-prime)', 'Released']
    : ['Allocated', 'Used', 'Outside', 'Released']
  return (
    <table style={{ borderCollapse: 'collapse', width: '100%' }}>
      <thead><tr>
        <th style={{ ...TH_BASE }}>Day</th>
        {head.map(h => <th key={h} style={{ ...TH_BASE, textAlign: 'right' }}>{h}</th>)}
      </tr></thead>
      <tbody>
        {byDow.map(d => (
          <tr key={d.dow}>
            <td style={TD_BASE}>{DOW[d.dow]}</td>
            {cols.map(k => <td key={k} style={cell}>{fmt1(k === 'released' ? (d[k] ?? 0) : d[k])}</td>)}
          </tr>
        ))}
        <tr style={{ fontWeight: 700, color: 'var(--color-gray-900)' }}>
          <td style={{ ...TD_BASE, borderTop: '1px solid var(--color-border-secondary)' }}>Week</td>
          {cols.map(k => (
            <td key={k} style={{ ...cell, borderTop: '1px solid var(--color-border-secondary)' }}>
              {fmt1(tot(k))}
            </td>
          ))}
        </tr>
      </tbody>
    </table>
  )
}

export function DetailDrawer({ owner, open, focus, onClose }) {
  const [detail, setDetail] = useState(null)
  const [detailError, setDetailError] = useState(null)

  useEffect(() => {
    if (!owner) return undefined
    const onKey = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [owner, onClose])

  useEffect(() => {
    if (!owner) { setDetail(null); setDetailError(null); return undefined }
    let live = true
    setDetail(null); setDetailError(null)
    fetch(`/api/blocks/allocations/${encodeURIComponent(owner.owner)}?horizonDays=28`)
      .then(async r => {
        const text = await r.text()
        if (!r.ok || !text) throw new Error('unavailable')
        return JSON.parse(text)
      })
      .then(d => { if (live) setDetail(d) })
      .catch(() => { if (live) setDetailError('The forward book could not be loaded.') })
    return () => { live = false }
  }, [owner])

  // Opened from the Pipeline cell, the drawer should land on the pipeline.
  useEffect(() => {
    if (!open || focus !== 'pipeline') return
    const el = document.getElementById('ba-pipeline')
    if (el) el.scrollIntoView({ block: 'start' })
  }, [open, focus, detail])

  if (!owner) return null
  const pc = patternChip(owner.pattern)

  return (
    <>
      <div onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.35)',
                 opacity: open ? 1 : 0, transition: 'opacity .22s ease', zIndex: 1000 }} />
      <div role="dialog" aria-modal="true" aria-label={`${owner.owner} details`}
        style={{ position: 'fixed', top: 0, right: 0, height: '100vh', width: 'min(520px, 100%)',
                 background: '#fff', boxShadow: '-8px 0 30px rgba(0,0,0,0.18)', zIndex: 1001,
                 transform: open ? 'translateX(0)' : 'translateX(100%)',
                 transition: 'transform .24s ease', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
                      padding: '18px 20px 14px', borderBottom: '1px solid var(--surface-border)' }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-gray-900)' }}>{owner.owner}</div>
            <div style={{ fontSize: 12, color: 'var(--color-gray-500)', marginTop: 2 }}>
              {owner.service} · {owner.site}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 9px',
                           borderRadius: 'var(--radius-full)', fontSize: 11, fontWeight: 700,
                           background: pc.bg, color: pc.color, whiteSpace: 'nowrap' }}>
              <span aria-hidden="true">{pc.glyph}</span>{pc.label}
            </span>
            <button onClick={onClose} aria-label="Close"
              style={{ border: 'none', background: 'none', cursor: 'pointer',
                       color: 'var(--color-gray-400)', padding: 4, borderRadius: 6 }}>
              <X size={20} />
            </button>
          </div>
        </div>

        <div style={{ overflowY: 'auto', flex: 1, padding: '18px 20px 28px' }}>
          <div style={SECTION_LABEL}>The week</div>
          <div style={{ marginBottom: 10 }}>
            <WeekShape byDow={owner.byDow} height={96} width={64} />
          </div>
          <div style={{ marginBottom: 16 }}><ShapeLegend /></div>
          <DayTable byDow={owner.byDow} />

          <div id="ba-pipeline" style={{ ...SECTION_LABEL, marginTop: 26 }}>Pipeline</div>
          {detailError && (
            <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)' }}>{detailError}</p>
          )}
          {!detailError && !detail && (
            <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)' }}>Loading…</p>
          )}
          {detail && (
            <>
              <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-600)',
                          margin: '0 0 10px' }}>
                Forward booked cases a week, against this block&rsquo;s own baseline of{' '}
                <strong>{fmt1(detail.pipeline?.baselinePerWeek)} cases a week</strong>
                {detail.pipeline?.trailingDays
                  ? ` over the prior ${detail.pipeline.trailingDays} days`
                  : ''}.
              </p>
              <PipelineChart pipeline={detail.pipeline} />
              {detail.pipeline?.pct != null && (
                <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-600)',
                            marginTop: 8 }}>
                  {fmt1(detail.pipeline.forwardPerWeek)} booked a week against{' '}
                  {fmt1(detail.pipeline.baselinePerWeek)} —{' '}
                  <strong>{detail.pipeline.pct > 0 ? '+' : detail.pipeline.pct < 0 ? '−' : ''}
                  {Math.abs(Math.round(detail.pipeline.pct))}%</strong>.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </>
  )
}

const TH = TH_BASE
const TD = TD_BASE

export function OwnerTable({ owners, onDetails }) {
  const [open, setOpen] = useState(null)
  if (!owners?.length) {
    return (
      <div style={{ padding: '18px 16px', color: 'var(--color-gray-400)', fontSize: 'var(--font-size-sm)' }}>
        No blocks to review.
      </div>
    )
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>
          <th style={TH}>Block</th>
          <th style={TH}>Week shape</th>
          <th style={TH}>Pattern</th>
          <th style={{ ...TH, textAlign: 'right' }}>Mismatch</th>
          <th style={TH}>Pipeline</th>
          <th style={TH}>Recommendation</th>
          <th style={TH}></th>
        </tr></thead>
        <tbody>
          {owners.map(o => {
            const pc = patternChip(o.pattern)
            const expanded = open === o.owner
            return (
              <Fragment key={o.owner}>
                <tr style={{ background: expanded ? '#EEF0FD' : 'transparent' }}>
                  <td style={TD}>
                    <button type="button" onClick={() => setOpen(expanded ? null : o.owner)}
                      style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'none',
                               border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }}>
                      {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                      <span>
                        <span style={{ fontWeight: 600, color: 'var(--color-gray-900)' }}>{o.owner}</span>
                        <div style={{ fontSize: 11, color: 'var(--color-gray-400)' }}>{o.service}</div>
                      </span>
                    </button>
                  </td>
                  <td style={TD}>
                    <WeekShape byDow={o.byDow} />
                    <ShapeCaption byDow={o.byDow} />
                  </td>
                  <td style={TD}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 9px',
                                   borderRadius: 'var(--radius-full)', fontSize: 11, fontWeight: 700,
                                   background: pc.bg, color: pc.color, whiteSpace: 'nowrap' }}>
                      <span aria-hidden="true">{pc.glyph}</span>{pc.label}
                    </span>
                  </td>
                  <td style={{ ...TD, textAlign: 'right', fontWeight: 700 }}>
                    {fmt1(o.mismatchHours)}<span style={{ fontWeight: 400, color: 'var(--color-gray-400)' }}> h/wk</span>
                  </td>
                  <td style={TD}>
                    <PipelineCell trend={o.trend} pct={o.trendPct}
                                  onOpen={onDetails ? () => onDetails(o, 'pipeline') : null} />
                  </td>
                  <td style={{ ...TD, fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-600)', maxWidth: 340 }}>
                    {o.recommendation?.text}
                  </td>
                  <td style={TD}>
                    {onDetails && (
                      <button type="button" onClick={() => onDetails(o, 'shape')}
                        style={{ cursor: 'pointer', border: '1px solid var(--color-border-secondary)',
                                 background: 'var(--surface-bg)', color: 'var(--color-gray-700)',
                                 borderRadius: 'var(--radius-md)', padding: '5px 10px',
                                 fontSize: 'var(--font-size-xs)', fontWeight: 700, whiteSpace: 'nowrap' }}>
                        See details
                      </button>
                    )}
                  </td>
                </tr>
                {expanded && (
                  <tr><td colSpan={7} style={{ ...TD, background: 'var(--surface-bg)' }}>
                    <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
                      <table style={{ borderCollapse: 'collapse' }}>
                        <thead><tr>
                          <th style={{ ...TH, borderBottom: 'none' }}>Day</th>
                          <th style={{ ...TH, borderBottom: 'none', textAlign: 'right' }}>Allocated</th>
                          <th style={{ ...TH, borderBottom: 'none', textAlign: 'right' }}>Used</th>
                          <th style={{ ...TH, borderBottom: 'none', textAlign: 'right' }}>Outside</th>
                        </tr></thead>
                        <tbody>
                          {o.byDow.map(d => (
                            <tr key={d.dow}>
                              <td style={{ ...TD, borderBottom: 'none' }}>{DOW[d.dow]}</td>
                              <td style={{ ...TD, borderBottom: 'none', textAlign: 'right' }}>{fmt1(d.alloc)}</td>
                              <td style={{ ...TD, borderBottom: 'none', textAlign: 'right' }}>{fmt1(d.used)}</td>
                              <td style={{ ...TD, borderBottom: 'none', textAlign: 'right' }}>{fmt1(d.outside)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <div style={{ flex: 1, minWidth: 260 }}>
                        <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em',
                                      fontWeight: 700, color: 'var(--color-gray-600)', marginBottom: 6 }}>
                          Why
                        </div>
                        <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                          {(o.drivers ?? []).map(d => (
                            <li key={d.key} style={{ fontSize: 'var(--font-size-xs)',
                                                     color: 'var(--color-gray-600)', padding: '3px 0' }}>
                              <strong style={{ color: 'var(--color-gray-800)' }}>{d.label}.</strong> {d.detail}
                            </li>
                          ))}
                        </ul>
                        {o.releaseHistory?.count > 0 && (
                          <div style={{ fontSize: 'var(--font-size-xs)', marginTop: 8 }}>
                            Released {o.releaseHistory.count} of {o.releaseHistory.of} instances ·{' '}
                            <a href="/open-time/tracker" style={{ color: 'var(--color-blue)', fontWeight: 600 }}>
                              release history
                            </a>
                          </div>
                        )}
                      </div>
                    </div>
                  </td></tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export default function BlockAllocations() {
  const [data, setData] = useState(null)
  const [detail, setDetail] = useState(null)      // { owner, focus }
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/blocks/allocations?horizonDays=28')
      .then(async r => {
        const text = await r.text()
        if (!text) throw new Error('The server returned an empty response.')
        try { return JSON.parse(text) } catch {
          throw new Error(text.trimStart().startsWith('<')
            ? 'The server returned a page instead of data — restart the server if it is running older code.'
            : 'The server returned something unreadable.')
        }
      })
      .then(d => { if (d?.error) setData({ empty: true, message: d.message }); else setData(d) })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  const counts = data?.counts ?? {}
  // Roll the raw pattern counts up to the five verdicts for the summary row.
  const verdictCounts = {}
  for (const [p, n] of Object.entries(counts)) {
    const v = VERDICT[p] ?? 'UNCLASSIFIED'
    verdictCounts[v] = (verdictCounts[v] || 0) + n
  }
  const findings = (data?.owners ?? []).filter(o => !INERT.has(o.pattern))

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Block Allocations</h1>
        <p className="page-subtitle">
          Where the allocated grid disagrees with how surgeons actually practise — and
          what to change. Sorted by the hours a week each mismatch moves.
        </p>
      </div>

      {error && (
        <div style={{ display: 'flex', gap: 8, padding: 'var(--space-5)', borderRadius: 'var(--radius-lg)',
                      background: 'rgba(239,68,68,0.06)', border: '1px solid #fecaca', color: '#b91c1c' }}>
          <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
          <div><strong>Could not load block allocations.</strong><div>{error}</div></div>
        </div>
      )}
      {!error && loading && <p style={{ color: 'var(--color-gray-400)' }}>Loading…</p>}

      {!error && !loading && data?.empty && (
        <div style={{ padding: 'var(--space-8)', textAlign: 'center', color: 'var(--color-gray-500)' }}>
          {data.message}
        </div>
      )}

      {!error && !loading && !data?.empty && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                        marginBottom: 'var(--space-4)' }}>
            {VERDICT_ORDER
              .filter(v => verdictCounts[v])
              .map(v => {
                const pc = verdictConfig(v)
                return (
                  <span key={v} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 13px',
                                         borderRadius: 'var(--radius-full)', background: pc.bg,
                                         border: `1px solid ${pc.color}33`, color: pc.color,
                                         fontSize: 'var(--font-size-sm)', fontWeight: 600 }}>
                    <span aria-hidden="true">{pc.glyph}</span>{pc.label}
                    <strong style={{ fontSize: 'var(--font-size-base)' }}>{verdictCounts[v]}</strong>
                  </span>
                )
              })}
            <span style={{ marginLeft: 'auto', fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)' }}>
              {data?.period ? `${data.period.prior_quarter} → ${data.period.current_quarter}` : ''}
            </span>
          </div>

          <div className="card">
            <div className="card-header">
              <div>
                <div className="card-title">Findings ({findings.length})</div>
                <div className="card-subtitle">
                  Hatch on a day with no outline is volume booking where no block is held.
                </div>
              </div>
            </div>
            <div style={{ padding: '0 16px 10px' }}><ShapeLegend /></div>
            <OwnerTable
              owners={data?.owners ?? []}
              onDetails={(o, focus) => setDetail({ owner: o, focus })}
            />
          </div>
        </>
      )}

      <DetailDrawer owner={detail?.owner ?? null} focus={detail?.focus} open={detail !== null}
                    onClose={() => setDetail(null)} />
    </div>
  )
}

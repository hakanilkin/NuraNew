import { Fragment, useState, useEffect } from 'react'
import { AlertCircle, ChevronDown, ChevronRight, Scale, TrendingUp, TrendingDown, Minus } from 'lucide-react'
import ScenarioPanel from '../components/ScenarioPanel'

/* ─── Block Allocations (BlockAllocations.md) ─────────────────────────────────
   A quarterly block committee review. The question is not "which blocks have
   low utilisation" — it is "where does the allocated grid disagree with how
   surgeons actually practise, and what should we change?" The action is
   reallocation, not release.

   The week-shape is the whole point: outline is allocated, fill is used inside
   the block, hatch is booked outside any block. Hatch sitting on a day with no
   outline is a wrong-day finding, visible without reading a number.          */

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']
const fmt1 = v => (v == null ? '—' : Number(v).toFixed(1))

/* Pattern carries a glyph as well as a colour — projector rule — and the label
   names the fix, not the symptom. */
function patternConfig(p) {
  switch (p) {
    case 'WRONG_DAY':       return { label: 'Wrong day',       glyph: '⇄', color: '#7c3aed', bg: 'rgba(124,58,237,0.13)' }
    case 'WRONG_SHAPE':     return { label: 'Wrong shape',     glyph: '⊏', color: '#b45309', bg: 'rgba(234,179,8,0.15)' }
    case 'ABANDONED':       return { label: 'Abandoned',       glyph: '✕', color: '#b91c1c', bg: 'rgba(239,68,68,0.13)' }
    case 'FRAGMENTED':      return { label: 'Fragmented',      glyph: '⋯', color: '#0e7490', bg: 'rgba(14,116,144,0.13)' }
    case 'OVER_ALLOCATED':  return { label: 'Over-allocated',  glyph: '▼', color: '#dc2626', bg: 'rgba(239,68,68,0.11)' }
    case 'UNDER_ALLOCATED': return { label: 'Under-allocated', glyph: '▲', color: '#2563eb', bg: 'rgba(59,130,246,0.12)' }
    default:                return { label: 'Right-sized',     glyph: '■', color: '#15803d', bg: 'rgba(34,197,94,0.12)' }
  }
}

function TrendChip({ trend, pct }) {
  const Icon = trend === 'GROWING' ? TrendingUp : trend === 'DECLINING' ? TrendingDown : Minus
  const color = trend === 'GROWING' ? '#15803d' : trend === 'DECLINING' ? '#b91c1c' : 'var(--color-gray-500)'
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11,
                   fontWeight: 600, color }}>
      <Icon size={12} />{trend === 'STABLE' ? 'Stable' : trend === 'GROWING' ? 'Growing' : 'Declining'}
      {pct != null && <span style={{ color: 'var(--color-gray-400)' }}>{pct > 0 ? '+' : ''}{Math.round(pct)}%</span>}
    </span>
  )
}

/* Five bars, Monday to Friday. Allocated is an outline, used is a solid fill,
   and volume booked outside any block is hatched — so the three quantities are
   distinguishable without colour. */
export function WeekShape({ byDow, height = 46 }) {
  const peak = Math.max(1, ...byDow.map(d => Math.max(d.alloc ?? 0, (d.used ?? 0) + (d.outside ?? 0))))
  const h = v => Math.max(0, ((v ?? 0) / peak) * height)
  return (
    <svg width={5 * 30} height={height + 14} role="img" aria-label="Allocated, used and out-of-block hours by weekday">
      <defs>
        <pattern id="ba-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="5" stroke="#64748b" strokeWidth="2" />
        </pattern>
      </defs>
      {byDow.map((d, i) => {
        const x = i * 30 + 3
        return (
          <g key={d.dow}>
            {/* Out-of-block first, so it reads as volume that found somewhere else. */}
            {d.outside > 0.05 && (
              <rect x={x + 13} y={height - h(d.outside)} width={10} height={h(d.outside)}
                    fill="url(#ba-hatch)" opacity="0.75" />
            )}
            {d.alloc > 0.05 && (
              <rect x={x} y={height - h(d.alloc)} width={12} height={h(d.alloc)}
                    fill="none" stroke="var(--color-blue)" strokeWidth="1.4" />
            )}
            {d.used > 0.05 && (
              <rect x={x} y={height - h(d.used)} width={12} height={h(d.used)}
                    fill="var(--color-blue)" opacity="0.55" />
            )}
            <line x1={x - 2} x2={x + 26} y1={height} y2={height} stroke="var(--surface-border)" />
            <text x={x + 11} y={height + 11} fontSize="9" textAnchor="middle"
                  fill="var(--color-gray-400)">{DOW[i]}</text>
          </g>
        )
      })}
    </svg>
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

const TH = { padding: '8px 11px', fontSize: 12, fontWeight: 600, textAlign: 'left',
             color: 'var(--color-text-primary)', borderBottom: '1px solid var(--color-border-secondary)' }
const TD = { padding: '10px 11px', fontSize: 'var(--font-size-sm)', color: 'var(--color-gray-700)',
             borderBottom: '1px solid var(--surface-border)', verticalAlign: 'middle' }

export function OwnerTable({ owners, onEvaluate }) {
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
          <th style={TH}>Trend</th>
          <th style={TH}>Recommendation</th>
          <th style={TH}></th>
        </tr></thead>
        <tbody>
          {owners.map(o => {
            const pc = patternConfig(o.pattern)
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
                  <td style={TD}><WeekShape byDow={o.byDow} /></td>
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
                  <td style={TD}><TrendChip trend={o.trend} pct={o.trendPct} /></td>
                  <td style={{ ...TD, fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-600)', maxWidth: 340 }}>
                    {o.recommendation?.text}
                  </td>
                  <td style={TD}>
                    {o.pattern !== 'RIGHT_SIZED' && onEvaluate && (
                      <button type="button" onClick={() => onEvaluate(o)}
                        style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer',
                                 border: '1px solid var(--color-blue)', background: 'var(--color-blue)',
                                 color: '#fff', borderRadius: 'var(--radius-md)', padding: '5px 10px',
                                 fontSize: 'var(--font-size-xs)', fontWeight: 700, whiteSpace: 'nowrap' }}>
                        <Scale size={12} /> Evaluate impact
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
  const [decision, setDecision] = useState(null)
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
  const findings = (data?.owners ?? []).filter(o => o.pattern !== 'RIGHT_SIZED')

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
            {['WRONG_DAY', 'WRONG_SHAPE', 'ABANDONED', 'FRAGMENTED',
              'OVER_ALLOCATED', 'UNDER_ALLOCATED', 'RIGHT_SIZED']
              .filter(p => counts[p])
              .map(p => {
                const pc = patternConfig(p)
                return (
                  <span key={p} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 13px',
                                         borderRadius: 'var(--radius-full)', background: pc.bg,
                                         border: `1px solid ${pc.color}33`, color: pc.color,
                                         fontSize: 'var(--font-size-sm)', fontWeight: 600 }}>
                    <span aria-hidden="true">{pc.glyph}</span>{pc.label}
                    <strong style={{ fontSize: 'var(--font-size-base)' }}>{counts[p]}</strong>
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
              onEvaluate={o => setDecision({
                kind: 'REALLOCATE',
                fromBlock: o.owner,
                toService: o.service,
                hours: Math.abs(o.recommendation?.deltaHours || 4) || 4,
                dayOfWeek: o.recommendation?.targetDow ?? o.byDow.reduce(
                  (best, d) => (d.alloc > (best?.alloc ?? -1) ? d : best), null)?.dow ?? 0,
                dayOfWeekLabel: DOW[o.recommendation?.targetDow ?? 0],
              })}
            />
          </div>
        </>
      )}

      <ScenarioPanel open={decision !== null} decision={decision} onClose={() => setDecision(null)} />
    </div>
  )
}

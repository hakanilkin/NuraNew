import { useState, useEffect } from 'react'
import { X, AlertTriangle, ChevronDown, ChevronRight, ArrowRight } from 'lucide-react'

/* ─── ISSCM scenario evaluation panel ─────────────────────────────────────────
   Summoned in context from the ISSCM group's pages — there is no /isscm route.
   Integration is a property of every decision, not a destination.

   The panel renders what the engine returned and nothing more. Every status,
   every delta and every line of reasoning arrives from /api/isscm; none of it is
   re-derived here. Two views of the same number would eventually disagree, and
   the one thing this panel cannot afford is to argue with itself.
   See ISSCMIntegrationView.md §8.                                            */

const PILLARS = [
  { key: 'surgeon',  title: 'Surgeon & Anesthesia Relationships',
    question: 'Does this put the time where the demand is?' },
  { key: 'staffing', title: 'Staffing & Operational Management',
    question: 'Can we staff the room we just filled?' },
  { key: 'capacity', title: 'Physical Infrastructure & Capital Investment',
    question: 'Where does this volume land after the case ends?' },
]

/* Status is carried by glyph as well as colour — these get read off a projector. */
function statusConfig(status) {
  switch (status) {
    case 'improves': return { label: 'Improves', glyph: '▲', color: '#16a34a', bg: 'rgba(34,197,94,0.12)' }
    case 'degrades': return { label: 'Degrades', glyph: '▼', color: '#dc2626', bg: 'rgba(239,68,68,0.12)' }
    default:         return { label: 'Neutral',  glyph: '■', color: '#64748b', bg: 'rgba(148,163,184,0.14)' }
  }
}

function fmt(v, unit) {
  if (v === null || v === undefined) return '—'
  const n = typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(1)) : v
  return unit ? `${n}${unit === '%' ? '%' : ` ${unit}`}` : `${n}`
}

function StatusChip({ status }) {
  const sc = statusConfig(status)
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 9px',
      borderRadius: 'var(--radius-full)', background: sc.bg, color: sc.color,
      fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap',
    }}>
      <span aria-hidden="true" style={{ fontSize: 9 }}>{sc.glyph}</span>{sc.label}
    </span>
  )
}

function BeforeAfter({ headline }) {
  if (!headline) return null
  const { before, after, unit, label } = headline
  const moved = before !== after
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em',
                    color: 'var(--color-gray-500)', fontWeight: 600 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 3 }}>
        <span style={{ fontSize: 'var(--font-size-lg)', fontWeight: 700,
                       color: moved ? 'var(--color-gray-400)' : 'var(--color-gray-900)' }}>
          {fmt(before, unit)}
        </span>
        {moved && <>
          <ArrowRight size={13} style={{ color: 'var(--color-gray-400)' }} />
          <span style={{ fontSize: 'var(--font-size-xl)', fontWeight: 800, color: 'var(--color-gray-900)' }}>
            {fmt(after, unit)}
          </span>
        </>}
      </div>
    </div>
  )
}

export function PillarCard({ pillar, meta, expanded, onToggle }) {
  if (!pillar) return null
  const sc = statusConfig(pillar.status)
  return (
    <div style={{
      border: `1px solid ${sc.color}33`, borderLeft: `3px solid ${sc.color}`,
      borderRadius: 'var(--radius-md)', background: 'var(--surface-card)',
      padding: '12px 14px', marginBottom: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          {/* Pillar names come from the capabilities document and are not renamed here. */}
          <div style={{ fontWeight: 700, fontSize: 'var(--font-size-sm)', color: 'var(--color-gray-900)' }}>
            {meta.title}
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-gray-500)', marginTop: 2, fontStyle: 'italic' }}>
            {meta.question}
          </div>
        </div>
        <StatusChip status={pillar.status} />
      </div>

      <BeforeAfter headline={pillar.headline} />

      {pillar.secondary?.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 10 }}>
          {pillar.secondary.map(s => (
            <span key={s.label} style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-500)' }}>
              {s.label}:{' '}
              <strong style={{ color: 'var(--color-gray-800)' }}>
                {s.before === s.after ? fmt(s.after, s.unit) : `${fmt(s.before, s.unit)} → ${fmt(s.after, s.unit)}`}
              </strong>
            </span>
          ))}
        </div>
      )}

      <button
        type="button" onClick={onToggle}
        style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 10,
                 background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                 color: 'var(--color-blue)', fontSize: 'var(--font-size-xs)', fontWeight: 600 }}
      >
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {expanded ? 'Hide' : 'Why'} ({pillar.drivers?.length ?? 0})
      </button>

      {expanded && (
        <ul style={{ margin: '8px 0 0', padding: 0, listStyle: 'none' }}>
          {(pillar.drivers ?? []).map(d => (
            <li key={d.key} style={{
              display: 'flex', gap: 8, padding: '6px 0',
              borderTop: '1px solid var(--surface-border)',
              fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-600)', lineHeight: 1.5,
            }}>
              <span aria-hidden="true" style={{
                color: d.direction === 'up' ? '#16a34a' : d.direction === 'down' ? '#dc2626' : '#94a3b8',
                fontWeight: 700, flexShrink: 0,
              }}>
                {d.direction === 'up' ? '▲' : d.direction === 'down' ? '▼' : '■'}
              </span>
              {/* The engine's detail string is the reasoning. Rendered, not rebuilt. */}
              <span><strong style={{ color: 'var(--color-gray-800)' }}>{d.label}.</strong> {d.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function ConflictStrip({ conflicts }) {
  if (!conflicts?.length) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px',
        borderRadius: 'var(--radius-md)', background: 'rgba(34,197,94,0.10)',
        border: '1px solid rgba(34,197,94,0.30)', color: '#15803d',
        fontSize: 'var(--font-size-sm)', fontWeight: 600, marginBottom: 14,
      }}>
        <span aria-hidden="true">▲</span> All three pillars clear.
      </div>
    )
  }
  const c = conflicts[0]
  const high = c.severity === 'high'
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 14px',
      borderRadius: 'var(--radius-md)',
      background: high ? 'rgba(239,68,68,0.10)' : 'rgba(234,179,8,0.12)',
      border: `1px solid ${high ? 'rgba(239,68,68,0.35)' : 'rgba(234,179,8,0.4)'}`,
      color: high ? '#b91c1c' : '#92400e',
      fontSize: 'var(--font-size-sm)', fontWeight: 600, marginBottom: 14, lineHeight: 1.5,
    }}>
      <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
      <span>{c.summary}</span>
    </div>
  )
}

export function Alternatives({ alternatives, onSelect }) {
  if (!alternatives?.length) return null
  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em',
                    fontWeight: 700, color: 'var(--color-gray-600)', marginBottom: 8 }}>
        Alternatives — same decision, other days
      </div>
      {alternatives.map(a => (
        <button
          key={a.scenarioId} type="button" onClick={() => onSelect?.(a)}
          style={{
            display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
            border: '1px solid var(--surface-border)', borderRadius: 'var(--radius-md)',
            background: 'var(--surface-card)', padding: '9px 12px', marginBottom: 6,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600,
                           color: 'var(--color-gray-900)', flex: 1, minWidth: 140 }}>
              {a.label}
            </span>
            {PILLARS.map(p => <StatusChip key={p.key} status={a.pillarStatuses?.[p.key]} />)}
          </div>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-500)', marginTop: 4 }}>
            {a.summary}
          </div>
        </button>
      ))}
    </div>
  )
}

/**
 * Opens either on a curated scenario (`scenarioId`, from the Release Radar) or
 * on an ad-hoc decision (`decision`, from the Smoothing and Staffing pages).
 * Both go to the same engine; only the endpoint differs.
 */
export default function ScenarioPanel({ open, scenarioId, decision, hours = 4, onClose }) {
  const [state, setState] = useState({ loading: false, error: null, result: null })
  const [expanded, setExpanded] = useState(null)
  const [activeId, setActiveId] = useState(scenarioId)

  useEffect(() => { setActiveId(scenarioId) }, [scenarioId])

  const decisionKey = decision ? JSON.stringify(decision) : null

  useEffect(() => {
    if (!open || (!activeId && !decisionKey)) return
    let cancelled = false
    setState({ loading: true, error: null, result: null })

    const req = decisionKey && !activeId
      ? fetch('/api/isscm/evaluate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision: JSON.parse(decisionKey) }),
        })
      : fetch(`/api/isscm/scenarios/${encodeURIComponent(activeId)}?hours=${hours}`)

    req
      .then(r => (r.ok ? r.json() : r.json().then(d => Promise.reject(new Error(d.error || `HTTP ${r.status}`)))))
      .then(d => { if (!cancelled) setState({ loading: false, error: null, result: d }) })
      .catch(e => { if (!cancelled) setState({ loading: false, error: e.message, result: null }) })
    return () => { cancelled = true }
  }, [open, activeId, decisionKey, hours])

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose?.() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const r = state.result
  const d = r?.decision

  return (
    <>
      {open && <div onClick={onClose}
        style={{ position: 'fixed', inset: 0, zIndex: 399, background: 'rgba(15,23,42,0.18)' }} />}
      <div
        role="dialog" aria-modal="true" aria-label="Scenario evaluation"
        style={{
          position: 'fixed', right: 0, top: 0, height: '100vh', width: 560, maxWidth: '100%',
          background: 'var(--surface-bg, #fff)', borderLeft: '1px solid var(--color-border-secondary)',
          boxShadow: '-4px 0 20px rgba(0,0,0,0.10)', zIndex: 400, overflowY: 'auto',
          padding: '1.25rem 1.5rem', boxSizing: 'border-box',
          transform: open ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 200ms ease-out',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 17, color: 'var(--color-gray-900)' }}>
              Evaluate impact
            </div>
            {d && (
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-gray-600)', marginTop: 3 }}>
                {d.kind === 'SHIFT_DOW'
                  ? <>Move {d.casesPerWeek} <strong>{d.service}</strong> case{d.casesPerWeek === 1 ? '' : 's'}/week to <strong>{d.dayOfWeekLabel}</strong></>
                  : d.kind === 'FLEX_STAFFING'
                    ? <>Flex {d.rooms > 0 ? 'up' : 'down'} {Math.abs(d.rooms)} room{Math.abs(d.rooms) === 1 ? '' : 's'} on <strong>{d.dayOfWeekLabel}</strong></>
                    : <>Move {d.hours}h of <strong>{d.fromBlock}</strong> to <strong>{d.toService}</strong> on {d.dayOfWeekLabel}</>}
              </div>
            )}
          </div>
          <button type="button" onClick={onClose} aria-label="Close"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-gray-400)' }}>
            <X size={18} />
          </button>
        </div>

        <div style={{ height: 1, background: 'var(--surface-border)', margin: '14px 0 16px' }} />

        {state.loading && <p style={{ color: 'var(--color-gray-400)', fontSize: 'var(--font-size-sm)' }}>Evaluating…</p>}

        {state.error && (
          <div style={{ display: 'flex', gap: 8, padding: 'var(--space-4)', borderRadius: 'var(--radius-md)',
                        background: 'rgba(239,68,68,0.07)', border: '1px solid #fecaca', color: '#b91c1c',
                        fontSize: 'var(--font-size-sm)' }}>
            <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
            <div><strong>Could not evaluate this scenario.</strong><div>{state.error}</div></div>
          </div>
        )}

        {r && (
          <>
            <ConflictStrip conflicts={r.conflicts} />
            {PILLARS.map(meta => (
              <PillarCard
                key={meta.key} meta={meta} pillar={r.pillars?.[meta.key]}
                expanded={expanded === meta.key}
                onToggle={() => setExpanded(expanded === meta.key ? null : meta.key)}
              />
            ))}
            <Alternatives
              alternatives={r.alternatives}
              onSelect={a => setActiveId(a.scenarioId.replace(/\|alt\d$/, ''))}
            />
          </>
        )}
      </div>
    </>
  )
}

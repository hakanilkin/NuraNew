import { useState, useEffect } from 'react'
import { AlertCircle, X, Search } from 'lucide-react'

/* ─── Status config — keys match real API values ────────────────────────────── */

function statusConfig(status) {
  switch (status) {
    case 'misaligned':      return { label: 'Misaligned',      bg: 'rgba(234,179,8,0.12)',   color: '#b45309' }
    case 'under_allocated': return { label: 'Under-allocated', bg: 'rgba(59,130,246,0.12)',  color: '#2563eb' }
    case 'right_sized':     return { label: 'Right-sized',     bg: 'rgba(34,197,94,0.12)',   color: '#16a34a' }
    case 'over_allocated':  return { label: 'Over-allocated',  bg: 'rgba(239,68,68,0.12)',   color: '#dc2626' }
    default:                return { label: 'Watch',           bg: 'rgba(148,163,184,0.12)', color: '#64748b' }
  }
}

/* ─── Helpers ────────────────────────────────────────────────────────────────── */

function fmt1(v) { return v == null ? '—' : Number(v).toFixed(1) }
function fmtPct(v) { return v == null ? '—' : `${Number(v).toFixed(1)}%` }

function utilColor(v) {
  if (v == null)  return 'var(--color-gray-400)'
  if (v >= 80)    return '#16a34a'
  if (v >= 65)    return '#d97706'
  return '#dc2626'
}

function deltaSign(v) {
  if (v == null) return '—'
  return v > 0 ? `+${Number(v).toFixed(1)}` : Number(v).toFixed(1)
}

function deltaColor(v, invertGood = false) {
  if (v == null) return 'var(--color-gray-400)'
  const positive = v > 0
  const good = invertGood ? !positive : positive
  return good ? '#16a34a' : '#dc2626'
}

/* ─── Shared table styles ────────────────────────────────────────────────────── */

const TH = {
  padding: '8px 12px', fontSize: 12,
  color: 'var(--color-text-primary)', fontWeight: 600,
  textAlign: 'left', borderBottom: '1px solid var(--color-border-secondary)',
  whiteSpace: 'nowrap',
}
const TD = {
  padding: '10px 12px', fontSize: 'var(--font-size-sm)',
  color: 'var(--color-gray-700)', borderBottom: '1px solid var(--surface-border)',
  verticalAlign: 'middle',
}

/* ─── Status badge ───────────────────────────────────────────────────────────── */

function StatusBadge({ status }) {
  const sc = statusConfig(status)
  return (
    <span style={{
      display: 'inline-block', padding: '2px 9px',
      borderRadius: 'var(--radius-full)',
      background: sc.bg, color: sc.color,
      fontSize: 11, fontWeight: 600,
    }}>
      {sc.label}
    </span>
  )
}

/* ─── Stat card ──────────────────────────────────────────────────────────────── */

function StatCard({ label, value, sub, accent }) {
  return (
    <div style={{
      background: 'var(--surface-card)', border: '1px solid var(--surface-border)',
      borderRadius: 'var(--radius-lg)', padding: 'var(--space-4)',
    }}>
      <div style={{ fontSize: 12, color: 'var(--color-text-primary)', marginBottom: 'var(--space-2)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>
        {label}
      </div>
      <div style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: accent || 'var(--color-gray-900)', lineHeight: 1.2 }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)', marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

/* ─── Finding type label ─────────────────────────────────────────────────────── */

const FINDING_LABELS = {
  inblock_util_qoq:  'In-block util QoQ',
  primetime_util_qoq: 'Primetime util QoQ',
  volume_qoq:        'Volume QoQ',
  outofblock_high:   'Out-of-block',
  released_high:     'Released time',
}

function FindingRow({ f }) {
  const color = f.severity >= 3 ? '#dc2626' : f.severity === 2 ? '#d97706' : '#64748b'
  return (
    <div style={{ display: 'flex', gap: 8, padding: '5px 0', borderBottom: '1px solid var(--surface-border)', alignItems: 'flex-start' }}>
      <span style={{ fontSize: 10, fontWeight: 700, color, flexShrink: 0, marginTop: 3, textTransform: 'uppercase' }}>
        {FINDING_LABELS[f.type] ?? f.type}
      </span>
      <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-600)', lineHeight: 1.5 }}>{f.text}</span>
    </div>
  )
}

/* ─── Slide-over detail panel ────────────────────────────────────────────────── */

function SlideOverPanel({ group, open, period, onClose }) {
  const pipelineCtx = group?.context?.pipeline ?? null
  const periodLabel = period
    ? `${period.current_quarter} vs ${period.prior_quarter}`
    : ''

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed', right: 0, top: 0,
        height: '100vh', width: 440, maxWidth: '100%',
        background: '#fff',
        borderLeft: '1px solid var(--color-border-secondary)',
        boxShadow: '-4px 0 16px rgba(0,0,0,0.08)',
        zIndex: 300,
        overflowY: 'auto',
        padding: '1.25rem 1.5rem',
        boxSizing: 'border-box',
        transform: open ? 'translateX(0)' : 'translateX(100%)',
        transition: 'transform 200ms ease-out',
      }}
    >
      {group && (
        <>
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 700, fontSize: 16, color: 'var(--color-gray-900)', lineHeight: 1.3 }}>
                  {group.caseblock}
                </span>
                <StatusBadge status={group.status} />
              </div>
              {periodLabel && (
                <div style={{ fontSize: 11, color: 'var(--color-gray-400)', marginTop: 5 }}>{periodLabel}</div>
              )}
            </div>
            <button
              type="button" onClick={onClose}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-gray-400)', padding: 4, flexShrink: 0, display: 'flex', alignItems: 'center', marginTop: 2 }}
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </div>

          <div style={{ height: 1, background: 'var(--surface-border)', margin: '14px 0 20px' }} />

          {/* Section 1 — Key metrics */}
          <SectionLabel>Key metrics</SectionLabel>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 22 }}>
            <MetricBlock label="In-block util"   value={fmtPct(group.inblock_util)}   accent={utilColor(group.inblock_util)} />
            <MetricBlock label="Prime-time util" value={fmtPct(group.primetime_util)} accent={utilColor(group.primetime_util)} />
            <MetricBlock label="Volume"          value={group.volume ?? '—'} />
            <MetricBlock
              label="Vol Δ"
              value={group.deltas?.volume_pct != null ? `${deltaSign(group.deltas.volume_pct)}%` : '—'}
              accent={group.deltas?.volume_pct != null ? deltaColor(group.deltas.volume_pct) : undefined}
            />
            <MetricBlock label="Allocated hrs" value={group.allocated_hours != null ? `${group.allocated_hours} hrs` : '—'} />
            <MetricBlock
              label="In-block Δ"
              value={group.deltas?.inblock_util != null ? `${deltaSign(group.deltas.inblock_util)} pts` : '—'}
              accent={group.deltas?.inblock_util != null ? deltaColor(group.deltas.inblock_util) : undefined}
            />
          </div>

          {/* Section 2 — Findings */}
          <SectionLabel>Findings ({group.findings?.length ?? 0})</SectionLabel>
          <div style={{ marginBottom: 22 }}>
            {(group.findings?.length ?? 0) === 0
              ? <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)', margin: 0, fontStyle: 'italic' }}>No flagged findings this quarter.</p>
              : (group.findings ?? []).map((f, i) => <FindingRow key={i} f={f} />)
            }
          </div>

          {/* Section 3 — Pipeline */}
          <SectionLabel>Pipeline</SectionLabel>
          <div style={{ marginBottom: 22 }}>
            {pipelineCtx ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {pipelineCtx.scheduled  != null && <MetricBlock label="Scheduled cases" value={pipelineCtx.scheduled} />}
                {pipelineCtx.forecasted != null && <MetricBlock label="Forecasted 6mo"  value={pipelineCtx.forecasted} accent="var(--color-blue)" />}
                {pipelineCtx.trend      != null && <MetricBlock label="Trend"           value={pipelineCtx.trend} />}
                {pipelineCtx.change     != null && <MetricBlock label="Change"          value={pipelineCtx.change} />}
              </div>
            ) : (
              <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)', margin: 0, fontStyle: 'italic' }}>No pipeline notes yet.</p>
            )}
          </div>

          {/* Section 4 — Budget */}
          <SectionLabel>Relative to budget</SectionLabel>
          <div style={{ background: 'var(--surface-bg)', border: '1px solid var(--surface-border)', borderRadius: 'var(--radius-md)', padding: '10px 14px' }}>
            <KVRow label="Relative to budget" value="— (budget data not loaded)" />
          </div>
        </>
      )}
    </div>
  )
}

function SectionLabel({ children }) {
  return (
    <div style={{
      fontSize: 11, color: 'var(--color-text-primary)', textTransform: 'uppercase',
      letterSpacing: '0.05em', fontWeight: 700,
      paddingBottom: 'var(--space-2)', marginBottom: 'var(--space-3)',
      borderBottom: '1px solid var(--color-border-secondary)',
    }}>
      {children}
    </div>
  )
}

function MetricBlock({ label, value, accent }) {
  return (
    <div style={{
      background: 'var(--surface-bg)', border: '1px solid var(--surface-border)',
      borderRadius: 'var(--radius-md)', padding: '10px 14px',
    }}>
      <div style={{ fontSize: 11, color: 'var(--color-text-primary)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 'var(--font-size-base)', fontWeight: 700, color: accent || 'var(--color-gray-900)' }}>
        {value}
      </div>
    </div>
  )
}

function KVRow({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0' }}>
      <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-500)' }}>{label}</span>
      <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 500, color: 'var(--color-gray-500)', fontStyle: 'italic' }}>{value}</span>
    </div>
  )
}

/* ─── Capacity matrix table ──────────────────────────────────────────────────── */

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'misaligned',      label: 'Misaligned' },
  { value: 'under_allocated', label: 'Under-allocated' },
  { value: 'right_sized',     label: 'Right-sized' },
  { value: 'over_allocated',  label: 'Over-allocated' },
  { value: 'watch',           label: 'Watch' },
]

function CapacityTab({ groups, period }) {
  const [expanded,     setExpanded]     = useState(null)   // selected caseblock id
  const [panelGroup,   setPanelGroup]   = useState(null)   // content kept during slide-out
  const [search,       setSearch]       = useState('')
  const [statusFilter, setStatusFilter] = useState('')

  function toggleRow(caseblock) {
    if (expanded === caseblock) {
      setExpanded(null)                                                   // same row → close
    } else {
      setPanelGroup(groups.find(g => g.caseblock === caseblock) ?? null) // swap content immediately
      setExpanded(caseblock)
    }
  }

  function closePanel() { setExpanded(null) }

  // Esc key closes the panel
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') closePanel() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const counts = {
    misaligned:      groups.filter(g => g.status === 'misaligned').length,
    under_allocated: groups.filter(g => g.status === 'under_allocated').length,
    right_sized:     groups.filter(g => g.status === 'right_sized').length,
    over_allocated:  groups.filter(g => g.status === 'over_allocated').length,
    watch:           groups.filter(g => g.status === 'watch').length,
  }

  const filtered = groups.filter(g => {
    const matchName   = !search || g.caseblock.toLowerCase().includes(search.toLowerCase())
    const matchStatus = !statusFilter || g.status === statusFilter
    return matchName && matchStatus
  })

  const periodLabel = period
    ? `${period.prior_quarter} → ${period.current_quarter}`
    : ''

  const inputStyle = {
    padding: '7px 12px', borderRadius: 'var(--radius-md)',
    border: '1px solid var(--surface-border)',
    background: 'var(--surface-card)', color: 'var(--color-gray-700)',
    fontSize: 'var(--font-size-sm)', outline: 'none',
  }

  return (
    <>
      {/* Backdrop — captures outside clicks to close the panel */}
      {expanded && (
        <div
          onClick={closePanel}
          style={{ position: 'fixed', inset: 0, zIndex: 299, background: 'transparent' }}
        />
      )}

      {/* Slide-over detail panel — always rendered, transitions in/out */}
      <SlideOverPanel
        open={expanded !== null}
        group={panelGroup}
        period={period}
        onClose={closePanel}
      />

      {/* Five status summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 'var(--space-3)', marginBottom: 'var(--space-5)' }}>
        <StatCard label="Misaligned"      value={counts.misaligned}      sub="Block vs. volume mismatch" accent="#b45309" />
        <StatCard label="Under-allocated" value={counts.under_allocated} sub="Insufficient block time"   accent="#2563eb" />
        <StatCard label="Right-sized"     value={counts.right_sized}     sub="Block matches demand"      accent="#16a34a" />
        <StatCard label="Over-allocated"  value={counts.over_allocated}  sub="Excess block time"         accent="#dc2626" />
        <StatCard label="Watch"           value={counts.watch}           sub="Monitor for changes"       accent="#64748b" />
      </div>

      {/* Filter bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-4)' }}>
        <div style={{ position: 'relative', flex: '0 0 280px' }}>
          <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--color-gray-400)', pointerEvents: 'none' }} />
          <input
            type="text"
            placeholder="Search block / surgeon…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ ...inputStyle, paddingLeft: 30, width: '100%', boxSizing: 'border-box' }}
          />
        </div>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={inputStyle}>
          {STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <span style={{ marginLeft: 'auto', fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)' }}>
          {filtered.length} of {groups.length} groups
        </span>
      </div>

      {/* Matrix table */}
      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title">Demand-capacity alignment{periodLabel ? ` — ${periodLabel}` : ''}</div>
            <div className="card-subtitle">Click any row to see the full utilization brief and findings.</div>
          </div>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={TH}>Block / Surgeon</th>
                <th style={TH}>Status</th>
                <th style={{ ...TH, textAlign: 'right' }}>In-block</th>
                <th style={{ ...TH, textAlign: 'right' }}>Primetime</th>
                <th style={{ ...TH, textAlign: 'right' }}>Volume</th>
                <th style={{ ...TH, textAlign: 'right' }}>Vol Δ</th>
                <th style={{ ...TH, textAlign: 'right' }}>Alloc hrs</th>
                <th style={{ ...TH, textAlign: 'center' }}>Findings</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8} style={{ ...TD, textAlign: 'center', color: 'var(--color-gray-400)', padding: 'var(--space-8)' }}>
                    No groups match the current filter.
                  </td>
                </tr>
              )}
              {filtered.map(g => {
                const isSelected = expanded === g.caseblock
                return (
                  <tr
                    key={g.caseblock}
                    onClick={() => toggleRow(g.caseblock)}
                    style={{ cursor: 'pointer', background: isSelected ? '#EEF0FD' : 'transparent', transition: 'background 120ms' }}
                    onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'var(--color-gray-50)' }}
                    onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent' }}
                  >
                    <td style={TD}>
                      <div style={{ fontWeight: 500, color: 'var(--color-gray-900)', fontSize: 'var(--font-size-sm)' }}>{g.caseblock}</div>
                    </td>
                    <td style={TD}><StatusBadge status={g.status} /></td>
                    <td style={{ ...TD, textAlign: 'right' }}>
                      <span style={{ fontWeight: 600, color: utilColor(g.inblock_util) }}>{fmtPct(g.inblock_util)}</span>
                    </td>
                    <td style={{ ...TD, textAlign: 'right' }}>
                      <span style={{ fontWeight: 600, color: utilColor(g.primetime_util) }}>{fmtPct(g.primetime_util)}</span>
                    </td>
                    <td style={{ ...TD, textAlign: 'right', fontWeight: 500 }}>{g.volume}</td>
                    <td style={{ ...TD, textAlign: 'right' }}>
                      {g.deltas.volume_pct != null
                        ? <span style={{ fontWeight: 500, color: deltaColor(g.deltas.volume_pct) }}>{deltaSign(g.deltas.volume_pct)}%</span>
                        : <span style={{ color: 'var(--color-gray-400)' }}>—</span>
                      }
                    </td>
                    <td style={{ ...TD, textAlign: 'right', color: 'var(--color-gray-500)' }}>
                      {g.allocated_hours != null ? g.allocated_hours : '—'}
                    </td>
                    <td style={{ ...TD, textAlign: 'center' }}>
                      {g.findings.length > 0
                        ? <span style={{ display: 'inline-block', minWidth: 20, padding: '1px 7px', borderRadius: 'var(--radius-full)', background: 'rgba(234,179,8,0.15)', color: '#b45309', fontSize: 11, fontWeight: 700 }}>
                            {g.findings.length}
                          </span>
                        : <span style={{ color: 'var(--color-gray-300)' }}>—</span>
                      }
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

    </>
  )
}

/* ─── Page ───────────────────────────────────────────────────────────────────── */

export default function AtlasPerformanceBriefs() {
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')

  useEffect(() => {
    fetch('/api/atlas/performance-briefs')
      .then(r => {
        if (!r.ok) return r.json().then(d => Promise.reject(new Error(d.error || `HTTP ${r.status}`)))
        return r.json()
      })
      .then(d => {
        if (d?.error === 'no_atlas_data') {
          setData({ noData: true, message: d.message })
        } else {
          setData(d)
        }
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="page" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 320 }}>
        <div style={{ textAlign: 'center', color: 'var(--color-gray-400)' }}>
          <div style={{ width: 36, height: 36, borderRadius: '50%', border: '3px solid var(--color-blue)', borderTopColor: 'transparent', animation: 'spin 0.7s linear infinite', margin: '0 auto var(--space-4)' }} />
          <p style={{ fontSize: 'var(--font-size-sm)' }}>Loading…</p>
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    )
  }

  if (error) {
    return (
      <div className="page">
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--space-3)', padding: 'var(--space-5)', background: 'rgba(239,68,68,0.06)', border: '1px solid #fecaca', borderRadius: 'var(--radius-lg)', color: '#b91c1c', fontSize: 'var(--font-size-sm)' }}>
          <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
          <div>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>Could not load performance briefs</div>
            <div>{error}</div>
          </div>
        </div>
      </div>
    )
  }

  if (!data || data.noData) {
    return (
      <div className="page">
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 280, textAlign: 'center', color: 'var(--color-gray-400)' }}>
          <div style={{ fontSize: 40, marginBottom: 'var(--space-4)' }}>📊</div>
          <div style={{ fontWeight: 600, fontSize: 'var(--font-size-base)', color: 'var(--color-gray-600)', marginBottom: 'var(--space-2)' }}>
            No performance briefs yet
          </div>
          <div style={{ fontSize: 'var(--font-size-sm)', maxWidth: 420 }}>
            {data?.message ?? 'Atlas data has not been generated for this organization yet. Run the performance_briefs_pipeline.py to populate this view.'}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <CapacityTab groups={data.groups ?? []} period={data.period ?? null} />
    </div>
  )
}

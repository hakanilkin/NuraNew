import React, { useState, useEffect } from 'react'
import { AlertCircle, X } from 'lucide-react'

/* ─── Hardcoded hospital list ────────────────────────────────────────────── */

const HOSPITALS = [
  'Our Lady of Lourdes Hospital',
  'Marlton',
  'Memorial',
  'Voorhees',
]

/* ─── Helpers ────────────────────────────────────────────────────────────── */

function statusConfig(status) {
  switch (status) {
    case 'misaligned': return { label: 'Misaligned',      bg: 'rgba(234,179,8,0.12)',  color: '#b45309' }
    case 'under':      return { label: 'Under-allocated', bg: 'rgba(239,68,68,0.12)',  color: '#dc2626' }
    case 'over':       return { label: 'Over-allocated',  bg: 'rgba(34,197,94,0.12)', color: '#16a34a' }
    case 'right':      return { label: 'Right-sized',     bg: 'rgba(59,130,246,0.12)', color: '#2563eb' }
    default:           return { label: status,             bg: 'rgba(148,163,184,0.12)', color: '#64748b' }
  }
}

function pctColor(v) {
  if (v >= 85) return '#2563eb'
  if (v >= 70) return '#16a34a'
  if (v >= 55) return '#d97706'
  return '#dc2626'
}

function TrendArrow({ trend, change }) {
  if (trend === 'up')   return <span style={{ color: '#16a34a', fontWeight: 600, whiteSpace: 'nowrap' }}>▲ {change}</span>
  if (trend === 'down') return <span style={{ color: '#dc2626', fontWeight: 600, whiteSpace: 'nowrap' }}>▼ {change}</span>
  return <span style={{ color: '#64748b', whiteSpace: 'nowrap' }}>— {change}</span>
}

/* ─── Shared sub-components ──────────────────────────────────────────────── */

function StatCard({ label, value, sub, accent }) {
  return (
    <div style={{
      background: 'var(--surface-card)',
      border: '1px solid var(--surface-border)',
      borderRadius: 'var(--radius-lg)',
      padding: 'var(--space-4)',
    }}>
      <div style={{ fontSize: 12, color: 'var(--color-text-primary)', marginBottom: 'var(--space-2)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 'var(--font-weight-medium)' }}>
        {label}
      </div>
      <div style={{ fontSize: 'var(--font-size-xl)', fontWeight: 'var(--font-weight-semibold)', color: accent || 'var(--color-gray-900)', lineHeight: 1.2 }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)', marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

function MiniStat({ label, value, accent }) {
  return (
    <div style={{
      background: 'var(--surface-bg)',
      border: '1px solid var(--surface-border)',
      borderRadius: 'var(--radius-md)',
      padding: '10px 14px',
      flex: 1,
    }}>
      <div style={{ fontSize: 12, color: 'var(--color-text-primary)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 'var(--font-size-lg)', fontWeight: 'var(--font-weight-semibold)', color: accent || 'var(--color-gray-900)' }}>
        {value}
      </div>
    </div>
  )
}

function KVRow({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderBottom: '1px solid var(--surface-border)' }}>
      <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-500)' }}>{label}</span>
      <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-medium)', color: 'var(--color-gray-800)' }}>{value}</span>
    </div>
  )
}

const TH_STYLE = {
  padding: '8px 12px',
  fontSize: 12,
  color: 'var(--color-text-primary)',
  fontWeight: 'var(--font-weight-semibold)',
  textAlign: 'left',
  borderBottom: '1px solid var(--color-border-secondary)',
  whiteSpace: 'nowrap',
}
const TD_STYLE = {
  padding: '10px 12px',
  fontSize: 'var(--font-size-sm)',
  color: 'var(--color-gray-700)',
  borderBottom: '1px solid var(--surface-border)',
  verticalAlign: 'middle',
}

/* ─── Detail Panel ───────────────────────────────────────────────────────── */

function DetailPanel({ group, onClose }) {
  const m = group.metrics

  function metricCellStyle(type, value) {
    if (type === 'inblockUtil') {
      if (value >= 75) return { background: 'rgba(34,197,94,0.15)',  color: '#15803d', fontWeight: 700 }
      if (value >= 65) return { background: 'rgba(234,179,8,0.15)',  color: '#b45309', fontWeight: 700 }
      return                  { background: 'rgba(239,68,68,0.15)',  color: '#dc2626', fontWeight: 700 }
    }
    if (type === 'nonPrimePct') {
      if (value < 10)  return { background: 'rgba(34,197,94,0.15)',  color: '#15803d', fontWeight: 700 }
      if (value <= 20) return { background: 'rgba(234,179,8,0.15)',  color: '#b45309', fontWeight: 700 }
      return                  { background: 'rgba(239,68,68,0.15)',  color: '#dc2626', fontWeight: 700 }
    }
    if (type === 'primetimeUtil') {
      if (value >= 75 && value <= 90) return { background: 'rgba(34,197,94,0.15)',  color: '#15803d', fontWeight: 700 }
      if (value > 90 || value >= 65)  return { background: 'rgba(234,179,8,0.15)',  color: '#b45309', fontWeight: 700 }
      return                                  { background: 'rgba(239,68,68,0.15)',  color: '#dc2626', fontWeight: 700 }
    }
    return {}
  }

  const sc = statusConfig(group.status)

  const pipelineSentence = (() => {
    const { trend } = group.pipeline
    const pt = m.primetimeUtil
    if (trend === 'up' && pt > 90)  return 'Pipeline is growing with primetime near capacity — block expansion is likely needed within two quarters.'
    if (trend === 'up' && pt >= 75) return 'Pipeline is growing with room remaining in primetime — monitor for continued tightening.'
    if (trend === 'up')             return 'Pipeline is growing — utilization trends should be monitored closely.'
    if (trend === 'flat')           return 'Pipeline volume is stable — current block allocation can be maintained.'
    return 'Pipeline is contracting — review block allocation for potential reduction.'
  })()

  const MTH = { padding: '7px 10px', fontSize: 11, color: 'white', fontWeight: 600, whiteSpace: 'nowrap', textAlign: 'right', borderRight: '1px solid rgba(255,255,255,0.1)' }
  const MTD = { padding: '8px 10px', fontSize: 13, textAlign: 'right', borderRight: '1px solid var(--surface-border)', color: 'var(--color-gray-700)' }

  return (
    <div style={{ border: '1px solid var(--surface-border)', borderRadius: 'var(--radius-lg)', background: 'var(--surface-card)', marginTop: 'var(--space-4)', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 'var(--space-4)', borderBottom: '1px solid var(--surface-border)' }}>
        <div>
          <div style={{ fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-gray-900)', fontSize: 'var(--font-size-base)' }}>{group.name}</div>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)', marginTop: 2 }}>{group.service}</div>
        </div>
        <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-gray-400)', padding: 4, display: 'flex', alignItems: 'center' }}>
          <X size={16} />
        </button>
      </div>

      <div style={{ padding: 'var(--space-5)' }}>

        {/* ── Layer 1: Metrics table ── */}
        <div style={{ fontSize: 12, color: 'var(--color-text-primary)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, paddingBottom: 'var(--space-2)', marginBottom: 'var(--space-3)', borderBottom: '1px solid var(--color-border-secondary)' }}>
          Utilization metrics
        </div>
        <div style={{ borderRadius: 'var(--radius-md)', border: '1px solid var(--surface-border)', overflow: 'hidden', marginBottom: 'var(--space-3)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#141533' }}>
                <th style={{ ...MTH, textAlign: 'left' }}>Cases</th>
                <th style={MTH}>In Block (min)</th>
                <th style={MTH}>Out of Block (min)</th>
                <th style={MTH}>Non-Prime (min)</th>
                <th style={MTH}>Non-Prime %</th>
                <th style={MTH}>Released (min)</th>
                <th style={MTH}>Released %</th>
                <th style={MTH}>Block Time (min)</th>
                <th style={MTH}>Inblock Util %</th>
                <th style={{ ...MTH, borderRight: 'none' }}>Primetime Util %</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={{ ...MTD, textAlign: 'left', fontWeight: 600, color: 'var(--color-gray-800)' }}>{m.cases}</td>
                <td style={MTD}>{m.inBlockMin.toLocaleString()}</td>
                <td style={MTD}>{m.outOfBlockMin.toLocaleString()}</td>
                <td style={MTD}>{m.totalNonPrime.toLocaleString()}</td>
                <td style={{ ...MTD, ...metricCellStyle('nonPrimePct', m.nonPrimePct) }}>{m.nonPrimePct}%</td>
                <td style={MTD}>{m.releasedTime.toLocaleString()}</td>
                <td style={MTD}>{m.releasedTimePct}%</td>
                <td style={MTD}>{m.blockTime.toLocaleString()}</td>
                <td style={{ ...MTD, ...metricCellStyle('inblockUtil', m.inblockUtil) }}>{m.inblockUtil}%</td>
                <td style={{ ...MTD, borderRight: 'none', ...metricCellStyle('primetimeUtil', m.primetimeUtil) }}>{m.primetimeUtil}%</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div style={{ background: sc.bg, borderRadius: 'var(--radius-md)', padding: '8px 12px', marginBottom: 'var(--space-5)' }}>
          <span style={{ fontWeight: 700, color: sc.color, fontSize: 13 }}>{sc.label}: </span>
          <span style={{ fontSize: 13, color: 'var(--color-text-primary)' }}>{group.finding}</span>
        </div>

        {/* ── Layer 2: Week × Day table ── */}
        <div style={{ fontSize: 12, color: 'var(--color-text-primary)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, paddingBottom: 'var(--space-2)', marginBottom: 'var(--space-3)', borderBottom: '1px solid var(--color-border-secondary)' }}>
          Day of week utilization
        </div>
        {group.dowTable && (() => {
          const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']
          const DTH  = { padding: '4px 6px', fontSize: 11, fontWeight: 600, textAlign: 'center', background: '#141533', color: 'white', borderRight: '1px solid rgba(255,255,255,0.12)', whiteSpace: 'nowrap' }
          const DSTH = { padding: '4px 6px', fontSize: 10, fontWeight: 600, textAlign: 'center', background: '#f8fafc', color: 'var(--color-gray-500)', borderRight: '1px solid var(--surface-border)', borderBottom: '2px solid var(--surface-border)', whiteSpace: 'nowrap' }
          const DTC  = { padding: '4px 6px', fontSize: 11, textAlign: 'center', borderRight: '1px solid var(--surface-border)', borderBottom: '1px solid var(--surface-border)' }

          function ptStyle(ptUtil, hasBlock) {
            if (!hasBlock) return { background: 'rgba(59,130,246,0.10)', color: '#2563eb' }
            if (ptUtil < 70)  return { background: 'rgba(239,68,68,0.12)',  color: '#dc2626' }
            if (ptUtil <= 90) return { background: 'rgba(34,197,94,0.12)',  color: '#15803d' }
            return { background: 'rgba(234,179,8,0.15)', color: '#b45309' }
          }
          function npStyle(np) {
            if (np > 50) return { background: 'rgba(239,68,68,0.12)', color: '#dc2626' }
            if (np > 30) return { background: 'rgba(234,179,8,0.15)', color: '#b45309' }
            return { color: 'var(--color-gray-700)' }
          }

          const bullets = []
          for (const row of group.dowTable) {
            for (const d of DAYS) {
              const c = row.days[d]
              if (!c) continue
              if (c.hasBlock && c.ptUtil < 70)
                bullets.push(`${d} week ${row.week} utilization at ${c.ptUtil}% — below target`)
              if (c.ptUtil > 100)
                bullets.push(`${d} week ${row.week} primetime utilization at ${c.ptUtil}% — cases performed outside allocated block time`)
              if (!c.hasBlock && c.cases > 0)
                bullets.push(`${d} week ${row.week} — ${c.cases} cases performed despite no block allocation, with ${c.nonPrime}% non-primetime`)
              if (c.nonPrime > 30)
                bullets.push(`${d} week ${row.week} — ${c.nonPrime}% non-primetime spillover`)
            }
          }

          return (
            <>
              <div style={{ borderRadius: 'var(--radius-md)', border: '1px solid var(--surface-border)', overflow: 'hidden', marginBottom: 'var(--space-3)' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#141533' }}>
                      <th style={{ ...DTH, textAlign: 'left', borderRight: '1px solid rgba(255,255,255,0.12)' }}>Week</th>
                      {DAYS.map(d => (
                        <th key={d} colSpan={3} style={{ ...DTH, borderRight: '1px solid rgba(255,255,255,0.25)' }}>{d}</th>
                      ))}
                    </tr>
                    <tr>
                      <th style={{ ...DSTH, textAlign: 'left' }}> </th>
                      {DAYS.map(d => (
                        ['Cases', 'NP%', 'PT%'].map(sub => (
                          <th key={`${d}-${sub}`} style={{ ...DSTH, borderRight: sub === 'PT%' ? '2px solid var(--surface-border)' : '1px solid var(--surface-border)' }}>{sub}</th>
                        ))
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {group.dowTable.map(row => (
                      <tr key={row.week}>
                        <td style={{ ...DTC, fontWeight: 600, color: 'var(--color-gray-600)', textAlign: 'left', background: '#f8fafc', borderRight: '2px solid var(--surface-border)' }}>
                          W{row.week}
                        </td>
                        {DAYS.map(d => {
                          const c = row.days[d] ?? { cases: 0, nonPrime: 0, ptUtil: 0, hasBlock: false }
                          return (
                            <React.Fragment key={d}>
                              <td style={{ ...DTC, color: 'var(--color-gray-700)' }}>{c.cases}</td>
                              <td style={{ ...DTC, ...npStyle(c.nonPrime) }}>{c.nonPrime}%</td>
                              <td style={{ ...DTC, borderRight: '2px solid var(--surface-border)', ...ptStyle(c.ptUtil, c.hasBlock) }}>
                                {c.hasBlock ? `${c.ptUtil}%` : '—'}
                              </td>
                            </React.Fragment>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {bullets.length > 0 && (
                <div style={{ marginBottom: 'var(--space-5)' }}>
                  <div style={{ fontSize: 11, color: 'var(--color-text-primary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                    Interpretation — Feb to Apr 2026
                  </div>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {bullets.map((b, i) => (
                      <li key={i} style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.7 }}>{b}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )
        })()}

        {/* ── Layer 3: Pipeline ── */}
        <div style={{ fontSize: 12, color: 'var(--color-text-primary)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, paddingBottom: 'var(--space-2)', marginBottom: 'var(--space-3)', borderBottom: '1px solid var(--color-border-secondary)' }}>
          Pipeline context
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
          <div style={{ flex: 1, background: 'var(--surface-bg)', border: '1px solid var(--surface-border)', borderRadius: 'var(--radius-md)', padding: '10px 14px' }}>
            <div style={{ fontSize: 12, color: 'var(--color-text-primary)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, marginBottom: 4 }}>Scheduled Cases</div>
            <div style={{ fontSize: 'var(--font-size-lg)', fontWeight: 700, color: 'var(--color-gray-900)' }}>{group.pipeline.scheduled}</div>
          </div>
          <div style={{ flex: 1, background: 'var(--surface-bg)', border: '1px solid var(--surface-border)', borderRadius: 'var(--radius-md)', padding: '10px 14px' }}>
            <div style={{ fontSize: 12, color: 'var(--color-text-primary)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, marginBottom: 4 }}>Forecasted 6mo</div>
            <div style={{ fontSize: 'var(--font-size-lg)', fontWeight: 700, color: 'var(--color-blue)' }}>{group.pipeline.forecasted}</div>
          </div>
          <div style={{ flex: 1, background: 'var(--surface-bg)', border: '1px solid var(--surface-border)', borderRadius: 'var(--radius-md)', padding: '10px 14px' }}>
            <div style={{ fontSize: 12, color: 'var(--color-text-primary)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, marginBottom: 4 }}>Pipeline Trend</div>
            <div style={{ fontSize: 'var(--font-size-sm)' }}>
              <TrendArrow trend={group.pipeline.trend} change={group.pipeline.change} />
            </div>
          </div>
        </div>
        <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-gray-500)', lineHeight: 1.6, margin: 0 }}>
          {pipelineSentence}
        </p>

      </div>
    </div>
  )
}

/* ─── Capacity Alignment tab ─────────────────────────────────────────────── */

function CapacityTab({ groups }) {
  const [expanded, setExpanded] = useState(null)

  const misaligned    = groups.filter(g => g.status === 'misaligned').length
  const underAlloc    = groups.filter(g => g.status === 'under').length
  const overAlloc     = groups.filter(g => g.status === 'over').length
  const rightSized    = groups.filter(g => g.status === 'right').length
  const expandedGroup = groups.find(g => g.name === expanded) ?? null

  function toggleRow(name) {
    setExpanded(prev => prev === name ? null : name)
  }

  return (
    <>
      {/* Stat cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--space-4)', marginBottom: 'var(--space-5)' }}>
        <StatCard label="Misaligned"      value={misaligned} sub="Block days vs. actual volume" accent="#b45309" />
        <StatCard label="Under-allocated" value={underAlloc} sub="Insufficient block time"      accent="#dc2626" />
        <StatCard label="Over-allocated"  value={overAlloc}  sub="Excess block time"            accent="#16a34a" />
        <StatCard label="Right-sized"     value={rightSized} sub="Block matches demand"         accent="#2563eb" />
      </div>

      {/* Groups table */}
      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title">Demand-capacity alignment — Feb to Apr 2026</div>
            <div className="card-subtitle">Click any row to see utilization brief and pipeline context.</div>
          </div>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={TH_STYLE}>Group</th>
                <th style={TH_STYLE}>Status</th>
                <th style={{ ...TH_STYLE, textAlign: 'center' }}>Inblock</th>
                <th style={{ ...TH_STYLE, textAlign: 'center' }}>Primetime</th>
                <th style={{ ...TH_STYLE, textAlign: 'center' }}>Pipeline</th>
                <th style={TH_STYLE}>Key finding</th>
              </tr>
            </thead>
            <tbody>
              {groups.map(g => {
                const sc = statusConfig(g.status)
                const isSelected = expanded === g.name
                return (
                  <tr
                    key={g.name}
                    onClick={() => toggleRow(g.name)}
                    style={{
                      cursor: 'pointer',
                      background: isSelected ? 'rgba(59,130,246,0.04)' : 'transparent',
                      transition: 'background 120ms',
                    }}
                    onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'var(--color-gray-50)' }}
                    onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent' }}
                  >
                    <td style={TD_STYLE}>
                      <div style={{ fontWeight: 'var(--font-weight-medium)', color: 'var(--color-gray-900)' }}>{g.name}</div>
                      <div style={{ fontSize: 11, color: 'var(--color-gray-400)', marginTop: 2 }}>{g.service}</div>
                    </td>
                    <td style={TD_STYLE}>
                      <span style={{ display: 'inline-block', padding: '2px 9px', borderRadius: 'var(--radius-full)', background: sc.bg, color: sc.color, fontSize: 11, fontWeight: 600 }}>
                        {sc.label}
                      </span>
                    </td>
                    <td style={{ ...TD_STYLE, textAlign: 'center' }}>
                      <span style={{ fontWeight: 600, color: pctColor(g.inblock) }}>{g.inblock}%</span>
                    </td>
                    <td style={{ ...TD_STYLE, textAlign: 'center' }}>
                      <span style={{ fontWeight: 600, color: pctColor(g.primetime) }}>{g.primetime}%</span>
                    </td>
                    <td style={{ ...TD_STYLE, textAlign: 'center' }}>
                      <TrendArrow trend={g.pipeline.trend} change={g.pipeline.change} />
                    </td>
                    <td style={{ ...TD_STYLE, maxWidth: 300, fontSize: 12, color: 'var(--color-gray-500)' }}>
                      {g.finding}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {expandedGroup && (
        <DetailPanel group={expandedGroup} onClose={() => setExpanded(null)} />
      )}
    </>
  )
}

/* ─── Page ───────────────────────────────────────────────────────────────── */

export default function AtlasPerformanceBriefs() {
  const [data,     setData]     = useState(null)
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState('')
  const [hospital, setHospital] = useState(HOSPITALS[0])

  useEffect(() => {
    fetch('/api/atlas/performance-briefs-mock')
      .then(r => {
        if (!r.ok) return r.json().then(d => Promise.reject(new Error(d.error || `HTTP ${r.status}`)))
        return r.json()
      })
      .then(setData)
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

  if (error || !data) {
    return (
      <div className="page">
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--space-3)', padding: 'var(--space-5)', background: 'var(--color-danger-light)', border: '1px solid #fecaca', borderRadius: 'var(--radius-lg)', color: '#b91c1c', fontSize: 'var(--font-size-sm)' }}>
          <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
          <div>
            <div style={{ fontWeight: 'var(--font-weight-semibold)', marginBottom: 2 }}>Could not load performance briefs</div>
            <div>{error || 'Unknown error'}</div>
          </div>
        </div>
      </div>
    )
  }

  const selectStyle = {
    padding: '7px 12px',
    borderRadius: 'var(--radius-md)',
    border: '1px solid var(--surface-border)',
    background: 'var(--surface-card)',
    color: 'var(--color-gray-700)',
    fontSize: 'var(--font-size-sm)',
    cursor: 'pointer',
    minWidth: 220,
  }

  return (
    <div className="page">
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-6)' }}>
        <label style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-gray-500)', fontWeight: 500 }}>Hospital</label>
        <select value={hospital} onChange={e => setHospital(e.target.value)} style={selectStyle}>
          {HOSPITALS.map(h => <option key={h} value={h}>{h}</option>)}
        </select>
        <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-gray-400)' }}>
          {hospital} · Feb–Apr 2026
        </span>
      </div>

      <CapacityTab groups={data.groups} />
    </div>
  )
}

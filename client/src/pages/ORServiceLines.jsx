import { useState, useEffect, useRef } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ComposedChart, ReferenceLine, Line, Cell,
} from 'recharts'
import { AlertCircle, RotateCcw, X } from 'lucide-react'

/* ─── Constants ──────────────────────────────────────────────────────────────── */

const FCOT_TARGET     = 60
const TURNOVER_TARGET = 45
const TOP_N           = 8

const SVC_COLORS = [
  '#2563eb', '#16a34a', '#d97706', '#dc2626',
  '#7c3aed', '#0891b2', '#be185d', '#65a30d', '#6b7280',
]

/* ─── Date helpers ───────────────────────────────────────────────────────────── */

function isoToday() {
  return new Date().toISOString().slice(0, 10)
}
function isoMonthsAgo(n) {
  const d = new Date()
  d.setMonth(d.getMonth() - n)
  d.setDate(1)
  return d.toISOString().slice(0, 10)
}

/* ─── Format helpers ─────────────────────────────────────────────────────────── */

function fmtPct(v)  { return v == null ? '—' : `${Number(v).toFixed(1)}%` }
function fmt1(v)    { return v == null ? '—' : Number(v).toFixed(1) }
function fmtDelta(v) {
  if (v == null) return '—'
  return (v >= 0 ? '+' : '') + Number(v).toFixed(1) + '%'
}

function fcotColor(v) {
  if (v == null) return '#94a3b8'
  if (v >= FCOT_TARGET)     return '#16a34a'
  if (v >= 45)              return '#d97706'
  return '#dc2626'
}

function buildQS(f) {
  const p = new URLSearchParams()
  if (f.from)     p.set('from',      f.from)
  if (f.to)       p.set('to',        f.to)
  if (f.location) p.set('location',  f.location)
  if (f.caseType) p.set('case_type', f.caseType)
  return p.toString()
}

/* ─── Generic fetch hook ─────────────────────────────────────────────────────── */

function useFetch(url) {
  const [state, setState] = useState({ data: null, loading: false, error: '' })

  useEffect(() => {
    if (!url) { setState({ data: null, loading: false, error: '' }); return }
    let live = true
    setState(s => ({ ...s, loading: true, error: '' }))
    fetch(url)
      .then(r => r.ok ? r.json() : r.json().then(d => Promise.reject(new Error(d.error || `HTTP ${r.status}`))))
      .then(data => { if (live) setState({ data, loading: false, error: '' }) })
      .catch(e   => { if (live) setState({ data: null, loading: false, error: e.message }) })
    return () => { live = false }
  }, [url])

  return state
}

/* ─── Shared UI primitives ───────────────────────────────────────────────────── */

const INPUT_STYLE = {
  padding: '6px 10px', borderRadius: 'var(--radius-md)',
  border: '1px solid var(--surface-border)',
  background: 'var(--surface-card)', color: 'var(--color-gray-700)',
  fontSize: 'var(--font-size-sm)', outline: 'none',
}

function LoadingBlock({ height = 220 }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height }}>
      <div style={{ width: 28, height: 28, borderRadius: '50%', border: '2.5px solid var(--color-blue)', borderTopColor: 'transparent', animation: 'spin 0.7s linear infinite' }} />
    </div>
  )
}

function ErrorBlock({ msg }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 'var(--space-4)', background: 'rgba(239,68,68,0.06)', border: '1px solid #fecaca', borderRadius: 'var(--radius-lg)', color: '#b91c1c', fontSize: 'var(--font-size-sm)' }}>
      <AlertCircle size={14} style={{ flexShrink: 0 }} />
      {msg}
    </div>
  )
}

function StatCard({ label, value, sub, accent }) {
  return (
    <div style={{ background: 'var(--surface-card)', border: '1px solid var(--surface-border)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-4)' }}>
      <div style={{ fontSize: 11, color: 'var(--color-text-primary)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, marginBottom: 'var(--space-2)' }}>{label}</div>
      <div style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: accent || 'var(--color-gray-900)', lineHeight: 1.2 }}>{value}</div>
      {sub && <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)', marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

/* ─── Filter bar ─────────────────────────────────────────────────────────────── */

function FilterBar({ filters, setFilters, filterOptions }) {
  const [localFrom, setLocalFrom] = useState(filters.from)
  const [localTo,   setLocalTo]   = useState(filters.to)
  const debounceRef = useRef(null)

  function scheduleApply(from, to) {
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => setFilters(f => ({ ...f, from, to })), 400)
  }

  function handleReset() {
    clearTimeout(debounceRef.current)
    const from = isoMonthsAgo(6)
    const to   = isoToday()
    setLocalFrom(from)
    setLocalTo(to)
    setFilters({ from, to, location: '', caseType: '' })
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap', marginBottom: 'var(--space-5)', padding: 'var(--space-4)', background: 'var(--surface-card)', border: '1px solid var(--surface-border)', borderRadius: 'var(--radius-lg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <label style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-500)', fontWeight: 500 }}>From</label>
        <input type="date" value={localFrom} style={INPUT_STYLE}
          onChange={e => { setLocalFrom(e.target.value); scheduleApply(e.target.value, localTo) }} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <label style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-500)', fontWeight: 500 }}>To</label>
        <input type="date" value={localTo} style={INPUT_STYLE}
          onChange={e => { setLocalTo(e.target.value); scheduleApply(localFrom, e.target.value) }} />
      </div>
      <select value={filters.location} style={INPUT_STYLE}
        onChange={e => setFilters(f => ({ ...f, location: e.target.value }))}>
        <option value="">All locations</option>
        {(filterOptions?.locations ?? []).map(l => <option key={l} value={l}>{l}</option>)}
      </select>
      <select value={filters.caseType} style={INPUT_STYLE}
        onChange={e => setFilters(f => ({ ...f, caseType: e.target.value }))}>
        <option value="">All case types</option>
        {(filterOptions?.case_types ?? []).map(c => <option key={c} value={c}>{c}</option>)}
      </select>
      <button type="button" onClick={handleReset} style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-blue)', fontSize: 'var(--font-size-sm)', padding: '6px 4px', marginLeft: 'auto' }}>
        <RotateCcw size={13} /> Reset
      </button>
    </div>
  )
}

/* ─── Slide-over drill panel (service line overview) ─────────────────────────── */

function ServiceDrillPanel({ group, open, qs, onClose, onOpenDetail }) {
  const svcEnc = group ? encodeURIComponent(group.service) : ''
  const blocks = useFetch(svcEnc ? `/api/orserviceline/service-blocks?service=${svcEnc}&${qs}` : '')
  const trend  = useFetch(svcEnc ? `/api/orserviceline/trend?service=${svcEnc}&${qs}` : '')

  const totalCases = (blocks.data ?? []).reduce((s, b) => s + b.n_cases, 0)

  const METRIC_ROWS = group ? [
    { label: 'Cases',             value: group.n_cases != null ? Number(group.n_cases).toLocaleString() : '—' },
    { label: 'Vol Δ',             value: group.vol_delta_pct != null ? fmtDelta(group.vol_delta_pct) : '—',
      color: group.vol_delta_pct != null ? (group.vol_delta_pct >= 0 ? '#16a34a' : '#dc2626') : undefined },
    { label: 'FCOT %',            value: fmtPct(group.fcot_pct), color: fcotColor(group.fcot_pct) },
    { label: 'Avg turnover',      value: group.avg_turnover != null ? `${fmt1(group.avg_turnover)} min` : '—',
      color: group.avg_turnover != null && group.avg_turnover > TURNOVER_TARGET ? '#d97706' : undefined },
    { label: 'Sched vs actual Δ', value: group.avg_dur_delta != null ? `${group.avg_dur_delta >= 0 ? '+' : ''}${fmt1(group.avg_dur_delta)} min` : '—',
      color: group.avg_dur_delta != null ? (Math.abs(group.avg_dur_delta) <= 15 ? '#16a34a' : '#d97706') : undefined },
    { label: 'Add-on %',          value: fmtPct(group.addon_pct) },
    { label: 'Days sched ahead',  value: fmt1(group.avg_days_sched_ahead) },
  ] : []

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
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '1rem' }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--color-gray-900)', lineHeight: 1.3 }}>{group.service}</div>
              <div style={{ fontSize: 11, color: 'var(--color-gray-400)', marginTop: 3 }}>Service line overview</div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-gray-400)', padding: 4, marginTop: -2, flexShrink: 0 }}
            >
              <X size={18} />
            </button>
          </div>

          <hr style={{ border: 'none', borderTop: '1px solid var(--color-border-secondary)', margin: '0 0 1rem' }} />

          {/* Section 1: Key metrics */}
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-primary)', marginBottom: 10 }}>
            Key metrics
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 12px', marginBottom: '1.25rem' }}>
            {METRIC_ROWS.map(({ label, value, color }) => (
              <div key={label} style={{ background: 'var(--color-gray-50)', borderRadius: 6, padding: '8px 10px' }}>
                <div style={{ fontSize: 10, color: 'var(--color-gray-400)', fontWeight: 500, marginBottom: 3 }}>{label}</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: color || 'var(--color-gray-900)' }}>{value}</div>
              </div>
            ))}
          </div>

          <hr style={{ border: 'none', borderTop: '1px solid var(--color-border-secondary)', margin: '0 0 1rem' }} />

          {/* Section 2: Associated case blocks */}
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-primary)', marginBottom: 10 }}>
            Associated case blocks
          </div>
          {blocks.loading && <LoadingBlock height={80} />}
          {blocks.error   && <ErrorBlock msg={blocks.error} />}
          {!blocks.loading && !blocks.error && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: '1.25rem' }}>
              {(blocks.data ?? []).length === 0
                ? <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)' }}>No block data for this service.</span>
                : (blocks.data ?? []).slice(0, 10).map(b => {
                    const pct = totalCases > 0 ? (b.n_cases / totalCases) * 100 : 0
                    return (
                      <div key={b.caseblock}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                          <span style={{ fontSize: 12, color: 'var(--color-gray-700)', fontWeight: 500 }}>{b.caseblock}</span>
                          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-gray-500)' }}>{b.n_cases.toLocaleString()}</span>
                        </div>
                        <div style={{ height: 5, background: 'var(--color-gray-100)', borderRadius: 3, overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${pct.toFixed(1)}%`, background: 'var(--color-blue)', borderRadius: 3 }} />
                        </div>
                      </div>
                    )
                  })
              }
            </div>
          )}

          <hr style={{ border: 'none', borderTop: '1px solid var(--color-border-secondary)', margin: '0 0 1rem' }} />

          {/* Section 3: Monthly trend */}
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-primary)', marginBottom: 10 }}>
            Monthly trend
          </div>
          {trend.loading && <LoadingBlock height={130} />}
          {trend.error   && <ErrorBlock msg={trend.error} />}
          {!trend.loading && !trend.error && (trend.data ?? []).length === 0 && (
            <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)' }}>No trend data.</span>
          )}
          {!trend.loading && !trend.error && (trend.data ?? []).length > 0 && (
            <ResponsiveContainer width="100%" height={140}>
              <ComposedChart data={trend.data} margin={{ top: 4, right: 8, bottom: 0, left: -24 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-gray-100)" />
                <XAxis dataKey="month" tick={{ fontSize: 9 }} tickLine={false} />
                <YAxis yAxisId="l" tick={{ fontSize: 9 }} tickLine={false} axisLine={false} />
                <YAxis yAxisId="r" orientation="right" domain={[0, 100]} tick={{ fontSize: 9 }} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={{ fontSize: 10 }} />
                <Bar  yAxisId="l" dataKey="n_cases"  name="Cases"  fill="#2563eb" opacity={0.75} radius={[2, 2, 0, 0]} />
                <Line yAxisId="r" type="monotone" dataKey="fcot_pct" name="FCOT %" stroke="#16a34a" dot={false} strokeWidth={1.5} />
              </ComposedChart>
            </ResponsiveContainer>
          )}

          {/* Section 4: Open full detail */}
          <div style={{ marginTop: '1.5rem', paddingTop: '1rem', borderTop: '1px solid var(--color-border-secondary)' }}>
            <button
              type="button"
              onClick={() => { onClose(); onOpenDetail(group.service) }}
              style={{
                width: '100%',
                padding: '10px 16px',
                background: 'var(--color-blue)',
                color: '#fff',
                border: 'none',
                borderRadius: 'var(--radius-md)',
                fontSize: 'var(--font-size-sm)',
                fontWeight: 600,
                cursor: 'pointer',
                textAlign: 'center',
              }}
            >
              Open full detail →
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/* ─── Tab 1: Overview ────────────────────────────────────────────────────────── */

const TH = { padding: '8px 12px', fontSize: 11, fontWeight: 600, textAlign: 'left', borderBottom: '1px solid var(--color-border-secondary)', whiteSpace: 'nowrap', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-primary)' }
const TD = { padding: '9px 12px', fontSize: 'var(--font-size-sm)', color: 'var(--color-gray-700)', borderBottom: '1px solid var(--surface-border)', verticalAlign: 'middle' }

function OverviewTab({ summary, services, qs, onOpenDetail }) {
  const [expanded,   setExpanded]   = useState(null)
  const [panelGroup, setPanelGroup] = useState(null)

  function closePanel() { setExpanded(null) }

  function toggleRow(row) {
    if (expanded === row.service) {
      closePanel()
    } else {
      setPanelGroup(row)
      setExpanded(row.service)
    }
  }

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') closePanel() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const s = summary.data ?? {}

  return (
    <>
      {/* 5 stat cards from /summary */}
      {summary.loading
        ? <div style={{ height: 96, marginBottom: 'var(--space-5)' }}><LoadingBlock height={96} /></div>
        : summary.error
          ? <ErrorBlock msg={summary.error} />
          : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 'var(--space-4)', marginBottom: 'var(--space-5)' }}>
              <StatCard label="Total cases"    value={s.total_cases != null ? Number(s.total_cases).toLocaleString() : '—'} />
              <StatCard label="Service lines"  value={s.distinct_service_lines ?? '—'} sub="≥ 20 cases" />
              <StatCard label="System FCOT"    value={fmtPct(s.system_fcot_pct)} accent={fcotColor(s.system_fcot_pct)} sub="First-case on time" />
              <StatCard label="Avg turnover"   value={s.avg_turnover != null ? `${fmt1(s.avg_turnover)} min` : '—'} sub="0–240 min range" accent={s.avg_turnover != null && s.avg_turnover <= TURNOVER_TARGET ? '#16a34a' : '#d97706'} />
              <StatCard label="Sched accuracy" value={s.avg_dur_delta != null ? `${s.avg_dur_delta >= 0 ? '+' : ''}${fmt1(s.avg_dur_delta)} min` : '—'} sub="Actual vs scheduled dur" accent={s.avg_dur_delta != null && Math.abs(s.avg_dur_delta) <= 15 ? '#16a34a' : '#d97706'} />
            </div>
          )
      }

      {/* Backdrop */}
      {expanded && (
        <div onClick={closePanel} style={{ position: 'fixed', inset: 0, zIndex: 299 }} />
      )}

      {/* Slide-over panel */}
      <ServiceDrillPanel
        group={panelGroup}
        open={expanded !== null}
        qs={qs}
        onClose={closePanel}
        onOpenDetail={onOpenDetail}
      />

      {/* By-service table */}
      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title">Service line breakdown</div>
            <div className="card-subtitle">Click a row to view details. Minimum 20 cases.</div>
          </div>
        </div>

        {services.loading && <LoadingBlock />}
        {services.error   && <div style={{ padding: 'var(--space-4)' }}><ErrorBlock msg={services.error} /></div>}

        {!services.loading && !services.error && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={TH}>Service line</th>
                  <th style={{ ...TH, textAlign: 'right' }}>Cases</th>
                  <th style={{ ...TH, textAlign: 'right' }}>Vol Δ</th>
                  <th style={{ ...TH, textAlign: 'right' }}>FCOT %</th>
                  <th style={{ ...TH, textAlign: 'right' }}>Avg turnover</th>
                  <th style={{ ...TH, textAlign: 'right' }}>Sched vs actual Δ</th>
                  <th style={{ ...TH, textAlign: 'right' }}>Add-on %</th>
                  <th style={{ ...TH, textAlign: 'right' }}>Days sched ahead</th>
                </tr>
              </thead>
              <tbody>
                {(services.data ?? []).length === 0 && (
                  <tr>
                    <td colSpan={8} style={{ ...TD, textAlign: 'center', color: 'var(--color-gray-400)', padding: 'var(--space-8)' }}>
                      No data for the selected filters.
                    </td>
                  </tr>
                )}
                {(services.data ?? []).map(row => {
                  const isSelected = expanded === row.service
                  return (
                    <tr
                      key={row.service}
                      onClick={() => toggleRow(row)}
                      style={{ cursor: 'pointer', background: isSelected ? '#EEF0FD' : 'transparent', transition: 'background 100ms' }}
                      onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'var(--color-gray-50)' }}
                      onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent' }}
                    >
                      <td style={TD}>
                        <span style={{ fontWeight: 500, color: 'var(--color-gray-900)' }}>{row.service}</span>
                      </td>
                      <td style={{ ...TD, textAlign: 'right', fontWeight: 500 }}>{row.n_cases.toLocaleString()}</td>
                      <td style={{ ...TD, textAlign: 'right' }}>
                        {row.vol_delta_pct != null
                          ? <span style={{ fontWeight: 500, color: row.vol_delta_pct >= 0 ? '#16a34a' : '#dc2626' }}>{fmtDelta(row.vol_delta_pct)}</span>
                          : <span style={{ color: 'var(--color-gray-400)' }}>—</span>
                        }
                      </td>
                      <td style={{ ...TD, textAlign: 'right' }}>
                        <span style={{ fontWeight: 600, color: fcotColor(row.fcot_pct) }}>{fmtPct(row.fcot_pct)}</span>
                      </td>
                      <td style={{ ...TD, textAlign: 'right', color: row.avg_turnover != null && row.avg_turnover > TURNOVER_TARGET ? '#d97706' : 'inherit' }}>
                        {row.avg_turnover != null ? `${fmt1(row.avg_turnover)} min` : '—'}
                      </td>
                      <td style={{ ...TD, textAlign: 'right' }}>
                        {row.avg_dur_delta != null
                          ? <span style={{ color: Math.abs(row.avg_dur_delta) <= 15 ? '#16a34a' : '#d97706' }}>
                              {row.avg_dur_delta >= 0 ? '+' : ''}{fmt1(row.avg_dur_delta)} min
                            </span>
                          : '—'
                        }
                      </td>
                      <td style={{ ...TD, textAlign: 'right' }}>{fmtPct(row.addon_pct)}</td>
                      <td style={{ ...TD, textAlign: 'right' }}>{fmt1(row.avg_days_sched_ahead)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}

/* ─── Quarter range helper (Service Line Detail) ─────────────────────────── */

function twoQtrRange() {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth()
  const q = Math.floor(m / 3)
  let cq, cy, pq, py
  if (q === 0)      { cq = 3; cy = y - 1; pq = 2; py = y - 1 }
  else if (q === 1) { cq = 0; cy = y;     pq = 3; py = y - 1 }
  else              { cq = q - 1; cy = y; pq = q - 2; py = y }
  function qb(yr, q0) {
    const sm = q0 * 3 + 1
    const em = sm + 2
    const leap = yr % 4 === 0 && (yr % 100 !== 0 || yr % 400 === 0)
    const dom = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    const p = n => String(n).padStart(2, '0')
    return { from: `${yr}-${p(sm)}-01`, to: `${yr}-${p(em)}-${p(dom[em])}` }
  }
  const curr = qb(cy, cq)
  const prior = qb(py, pq)
  return { currFrom: curr.from, currTo: curr.to, priorFrom: prior.from, priorTo: prior.to }
}

const STATUS_CFG = {
  misaligned:      { label: 'Misaligned',      bg: 'rgba(245,158,11,0.12)',  color: '#f59e0b' },
  under_allocated: { label: 'Under-allocated', bg: 'rgba(62,83,227,0.12)',   color: '#3E53E3' },
  right_sized:     { label: 'Right-sized',     bg: 'rgba(34,197,94,0.12)',   color: '#22c55e' },
  over_allocated:  { label: 'Over-allocated',  bg: 'rgba(226,75,74,0.12)',   color: '#E24B4A' },
  watch:           { label: 'Watch',           bg: 'rgba(148,163,184,0.12)', color: '#94a3b8' },
}

/* ─── Tab 2: Service Line Detail ─────────────────────────────────────────── */

function DeltaPill({ curr, prior, higherIsBetter, unit = '' }) {
  if (curr == null || prior == null) return null
  const d = Number(curr) - Number(prior)
  let color = '#94a3b8'
  if (higherIsBetter != null && d !== 0) {
    color = (higherIsBetter ? d > 0 : d < 0) ? '#16a34a' : '#dc2626'
  }
  const sign = d >= 0 ? '+' : ''
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, marginLeft: 6, padding: '1px 5px',
      borderRadius: 3, background: color + '20', color, whiteSpace: 'nowrap',
    }}>
      {sign}{Number(d).toFixed(1)}{unit}
    </span>
  )
}

function ServiceLineDetailTab({ services, filterOptions, selectedService }) {
  const svcLines   = [...(filterOptions?.service_lines ?? [])].sort()
  const topService = (services.data ?? [])[0]?.service ?? ''

  const [sel,    setSel]    = useState(selectedService || '')
  const [debSel, setDebSel] = useState(selectedService || '')
  const debRef = useRef(null)

  useEffect(() => {
    if (sel === '' && topService) { setSel(topService); setDebSel(topService) }
  }, [topService])

  useEffect(() => {
    clearTimeout(debRef.current)
    debRef.current = setTimeout(() => setDebSel(sel), 300)
    return () => clearTimeout(debRef.current)
  }, [sel])

  const { currFrom, currTo, priorFrom, priorTo } = twoQtrRange()
  const enc = debSel ? encodeURIComponent(debSel) : ''

  const operational = useFetch(enc ? `/api/orserviceline/operational?service=${enc}` : '')
  const utilization = useFetch(enc ? `/api/orserviceline/utilization?service=${enc}` : '')
  const blocks      = useFetch(enc ? `/api/orserviceline/service-blocks?service=${enc}&from=${currFrom}&to=${currTo}` : '')
  const trend       = useFetch(enc ? `/api/orserviceline/trend?service=${enc}&from=${priorFrom}&to=${currTo}` : '')
  const utilTrend   = useFetch(enc ? `/api/orserviceline/utilization-trend?service=${enc}&from=${priorFrom}&to=${currTo}` : '')
  const pipeline    = useFetch(enc ? `/api/orserviceline/pipeline?service=${enc}&weeks_ahead=8` : '')

  const currOp  = operational.data?.current ?? {}
  const priorOp = operational.data?.prior   ?? {}
  const currUt  = utilization.data?.current ?? {}
  const priorUt = utilization.data?.prior   ?? {}
  const status  = utilization.data?.status  ?? 'watch'
  const stCfg   = STATUS_CFG[status] ?? STATUS_CFG.watch

  const blockTotal = (blocks.data ?? []).reduce((s, b) => s + b.n_cases, 0)
  const weeks      = pipeline.data?.weeks ?? []
  const baseLine   = pipeline.data?.baseline_per_week ?? 0
  const wkTotal    = weeks.reduce((s, w) => s + w.n_cases, 0)

  const OP_ROWS = [
    { label: 'Volume (cases)',               cKey: 'n_cases',              hib: null,  unit: '' },
    { label: 'FCOT %',                       cKey: 'fcot_pct',             hib: true,  unit: '%' },
    { label: 'Avg turnover (min)',            cKey: 'avg_turnover',         hib: false, unit: '' },
    { label: 'Avg scheduled duration (min)', cKey: 'avg_sched_dur',        hib: null,  unit: '' },
    { label: 'Avg actual duration (min)',    cKey: 'avg_actual_dur',       hib: false, unit: '' },
    { label: 'Duration Δ (min)',             cKey: 'dur_delta',            hib: false, unit: '' },
    { label: 'Add-on %',                     cKey: 'addon_pct',            hib: false, unit: '%' },
    { label: 'Days scheduled ahead',         cKey: 'avg_days_sched_ahead', hib: null,  unit: '' },
    { label: 'Distinct surgeons',            cKey: 'distinct_surgeons',    hib: null,  unit: '' },
    { label: 'Distinct rooms',               cKey: 'distinct_rooms',       hib: null,  unit: '' },
  ]

  const SEC = {
    fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
    letterSpacing: '0.05em', color: 'var(--color-text-primary)',
    margin: '24px 0 12px',
  }

  return (
    <div>
      {/* Service selector */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <label style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-500)', fontWeight: 500, whiteSpace: 'nowrap' }}>
          Service line
        </label>
        <select value={sel} onChange={e => setSel(e.target.value)} style={INPUT_STYLE}>
          {svcLines.length === 0 && <option value="">Loading…</option>}
          {svcLines.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      {sel && (
        <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--color-gray-900)', marginBottom: 16 }}>{sel}</div>
      )}

      {/* 4-stat strip */}
      {operational.loading
        ? <LoadingBlock height={96} />
        : operational.error
          ? <div style={{ color: '#b91c1c', fontSize: 'var(--font-size-sm)', marginBottom: 12 }}>Unable to load operational data.</div>
          : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--space-4)' }}>
              <StatCard label="Volume" value={currOp.n_cases != null ? Number(currOp.n_cases).toLocaleString() : '—'} sub={currOp.quarter_label} />
              <StatCard label="FCOT %" value={fmtPct(currOp.fcot_pct)} accent={fcotColor(currOp.fcot_pct)} sub="First-case on time" />
              <StatCard label="Avg turnover" value={currOp.avg_turnover != null ? `${fmt1(currOp.avg_turnover)} min` : '—'} sub="0–240 min range" />
              <StatCard
                label="Duration Δ"
                value={currOp.dur_delta != null ? `${currOp.dur_delta >= 0 ? '+' : ''}${fmt1(currOp.dur_delta)} min` : '—'}
                sub="Actual vs scheduled"
              />
            </div>
          )
      }

      {/* Section A — Operational metrics */}
      <div style={SEC}>Operational metrics</div>
      <div className="card" style={{ overflowX: 'auto' }}>
        {operational.loading && <LoadingBlock />}
        {operational.error && <div style={{ padding: 'var(--space-4)' }}><ErrorBlock msg="Unable to load operational metrics." /></div>}
        {!operational.loading && !operational.error && (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...TH, width: '36%' }}>Metric</th>
                <th style={{ ...TH, textAlign: 'right' }}>{currOp.quarter_label ?? 'Current'}</th>
                <th style={{ ...TH, textAlign: 'right', color: 'var(--color-gray-400)' }}>{priorOp.quarter_label ?? 'Prior'}</th>
              </tr>
            </thead>
            <tbody>
              {OP_ROWS.map(row => {
                const cv = currOp[row.cKey]
                const pv = priorOp[row.cKey]
                const fmt = v => v == null ? '—' : row.unit === '%' ? fmtPct(v) : fmt1(v)
                return (
                  <tr key={row.label}>
                    <td style={{ ...TD, fontWeight: 500 }}>{row.label}</td>
                    <td style={{ ...TD, textAlign: 'right' }}>
                      {fmt(cv)}
                      <DeltaPill curr={cv} prior={pv} higherIsBetter={row.hib} unit={row.unit} />
                    </td>
                    <td style={{ ...TD, textAlign: 'right', color: 'var(--color-gray-400)' }}>{fmt(pv)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Section B — Utilization & allocation */}
      <div style={SEC}>Utilization &amp; allocation</div>
      {utilization.loading && <LoadingBlock />}
      {utilization.error && <ErrorBlock msg="Unable to load utilization data." />}
      {!utilization.loading && !utilization.error && (
        <>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--space-4)', flexWrap: 'wrap', marginBottom: 'var(--space-4)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--space-4)', flex: 1, minWidth: 0 }}>
              <StatCard
                label="Allocated hours"
                value={currUt.allocated_hours != null ? fmt1(currUt.allocated_hours) : '—'}
                sub={priorUt.allocated_hours != null ? `Prior: ${fmt1(priorUt.allocated_hours)} h` : undefined}
              />
              <StatCard
                label="In-block util"
                value={fmtPct(currUt.inblock_util)}
                sub={priorUt.inblock_util != null ? `Prior: ${fmtPct(priorUt.inblock_util)}` : undefined}
              />
              <StatCard
                label="Prime-time util"
                value={fmtPct(currUt.primetime_util)}
                sub={priorUt.primetime_util != null ? `Prior: ${fmtPct(priorUt.primetime_util)}` : undefined}
              />
              <StatCard
                label="Released %"
                value={fmtPct(currUt.released_pct)}
                sub={priorUt.released_pct != null ? `Prior: ${fmtPct(priorUt.released_pct)}` : undefined}
              />
            </div>
            <div style={{ alignSelf: 'center', paddingTop: 4 }}>
              <span style={{
                padding: '5px 14px', borderRadius: 20, fontSize: 12, fontWeight: 700,
                background: stCfg.bg, color: stCfg.color,
                border: `1px solid ${stCfg.color}40`, whiteSpace: 'nowrap',
              }}>
                {stCfg.label}
              </span>
            </div>
          </div>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-primary)', marginBottom: 8 }}>
            Associated case blocks
          </div>
          {blocks.loading && <LoadingBlock height={80} />}
          {blocks.error   && <ErrorBlock msg="Unable to load block data." />}
          {!blocks.loading && !blocks.error && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7, maxWidth: 500 }}>
              {(blocks.data ?? []).length === 0
                ? <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)' }}>No block data for this service.</span>
                : (blocks.data ?? []).slice(0, 12).map(b => {
                    const pct = blockTotal > 0 ? (b.n_cases / blockTotal) * 100 : 0
                    return (
                      <div key={b.caseblock}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                          <span style={{ fontSize: 12, color: 'var(--color-gray-700)', fontWeight: 500 }}>{b.caseblock}</span>
                          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-gray-500)' }}>{b.n_cases.toLocaleString()}</span>
                        </div>
                        <div style={{ height: 5, background: 'var(--color-gray-100)', borderRadius: 3, overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${pct.toFixed(1)}%`, background: 'var(--color-blue)', borderRadius: 3 }} />
                        </div>
                      </div>
                    )
                  })
              }
            </div>
          )}
        </>
      )}

      {/* Section C — Trends */}
      <div style={SEC}>Trends — last two complete quarters</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--space-4)' }}>

        <div className="card">
          <div className="card-header"><div className="card-title" style={{ fontSize: 'var(--font-size-sm)' }}>Monthly volume</div></div>
          <div style={{ padding: '0 12px 12px' }}>
            {trend.loading && <LoadingBlock height={180} />}
            {trend.error && <div style={{ padding: 8, fontSize: 12, color: '#b91c1c' }}>Unable to load trend data.</div>}
            {!trend.loading && !trend.error && (
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={trend.data ?? []} margin={{ top: 4, right: 4, bottom: 0, left: -28 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-gray-100)" vertical={false} />
                  <XAxis dataKey="month" tick={{ fontSize: 9 }} tickLine={false} />
                  <YAxis tick={{ fontSize: 9 }} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ fontSize: 10 }} />
                  <Bar dataKey="n_cases" name="Cases" fill="#2563eb" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-header"><div className="card-title" style={{ fontSize: 'var(--font-size-sm)' }}>FCOT %</div></div>
          <div style={{ padding: '0 12px 12px' }}>
            {trend.loading && <LoadingBlock height={180} />}
            {trend.error && <div style={{ padding: 8, fontSize: 12, color: '#b91c1c' }}>Unable to load trend data.</div>}
            {!trend.loading && !trend.error && (
              <ResponsiveContainer width="100%" height={180}>
                <ComposedChart data={trend.data ?? []} margin={{ top: 4, right: 4, bottom: 0, left: -28 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-gray-100)" vertical={false} />
                  <XAxis dataKey="month" tick={{ fontSize: 9 }} tickLine={false} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 9 }} tickLine={false} axisLine={false} />
                  <Tooltip formatter={v => [fmtPct(v), 'FCOT %']} contentStyle={{ fontSize: 10 }} />
                  <ReferenceLine y={FCOT_TARGET} stroke="#16a34a" strokeDasharray="4 3"
                    label={{ value: '60%', position: 'insideTopRight', fontSize: 9, fill: '#16a34a' }} />
                  <Line type="monotone" dataKey="fcot_pct" name="FCOT %" stroke="#16a34a" dot={{ r: 2 }} strokeWidth={2} />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-header"><div className="card-title" style={{ fontSize: 'var(--font-size-sm)' }}>Utilization</div></div>
          <div style={{ padding: '0 12px 12px' }}>
            {utilTrend.loading && <LoadingBlock height={180} />}
            {utilTrend.error && <div style={{ padding: 8, fontSize: 12, color: '#b91c1c' }}>Unable to load utilization trend.</div>}
            {!utilTrend.loading && !utilTrend.error && (
              <ResponsiveContainer width="100%" height={180}>
                <ComposedChart data={utilTrend.data ?? []} margin={{ top: 4, right: 4, bottom: 0, left: -28 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-gray-100)" vertical={false} />
                  <XAxis dataKey="month" tick={{ fontSize: 9 }} tickLine={false} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 9 }} tickLine={false} axisLine={false} />
                  <Tooltip formatter={(v, n) => [fmtPct(v), n]} contentStyle={{ fontSize: 10 }} />
                  <Legend wrapperStyle={{ fontSize: 9 }} />
                  <Line type="monotone" dataKey="inblock_util" name="In-block %" stroke="#2563eb" dot={{ r: 2 }} strokeWidth={2} />
                  <Line type="monotone" dataKey="primetime_util" name="Prime-time %" stroke="#7c3aed" strokeDasharray="4 2" dot={{ r: 2 }} strokeWidth={2} />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>

      {/* Section D — Pipeline */}
      <div style={SEC}>Forecasted pipeline (scheduled cases ahead)</div>
      <div className="card">
        {pipeline.loading && <LoadingBlock />}
        {pipeline.error && <div style={{ padding: 'var(--space-4)' }}><ErrorBlock msg="Unable to load pipeline data." /></div>}
        {!pipeline.loading && !pipeline.error && (
          <div style={{ padding: '0 var(--space-4) var(--space-4)' }}>
            <ResponsiveContainer width="100%" height={Math.max(180, weeks.length * 36)}>
              <BarChart data={weeks} layout="vertical" margin={{ top: 4, right: 80, bottom: 4, left: 72 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--color-gray-100)" />
                <XAxis type="number" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                <YAxis dataKey="week_label" type="category" width={68} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                <Tooltip formatter={(v, n) => [v, n]} contentStyle={{ fontSize: 10 }} />
                {baseLine > 0 && (
                  <ReferenceLine x={baseLine} stroke="#d97706" strokeDasharray="4 3"
                    label={{ value: `${Number(baseLine).toFixed(1)}/wk`, position: 'insideTopRight', fontSize: 9, fill: '#d97706' }} />
                )}
                <Bar dataKey="n_cases" name="Scheduled cases" radius={[0, 3, 3, 0]}>
                  {weeks.map((w, i) => (
                    <Cell key={i} fill={w.n_cases >= baseLine ? '#22c55e' : '#f59e0b'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-gray-600)', margin: '12px 0 4px' }}>
              Next 8 weeks: <strong>{wkTotal.toLocaleString()}</strong> scheduled cases
              {baseLine > 0 && <> (baseline: {Number(baseLine).toFixed(1)}/week over prior 4 weeks)</>}.
            </p>
            <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)', margin: 0, fontStyle: 'italic' }}>
              Pipeline forecasts will incorporate model-based projections once available.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

/* ─── Tab 3: Efficiency ──────────────────────────────────────────────────────── */

function EfficiencyTab({ services }) {
  const rows = (services.data ?? []).slice(0, 20)

  if (services.loading) return <LoadingBlock />
  if (services.error)   return <ErrorBlock msg={services.error} />
  if (rows.length === 0) return (
    <div style={{ textAlign: 'center', color: 'var(--color-gray-400)', padding: 'var(--space-8)' }}>No data for the selected filters.</div>
  )

  const h    = Math.max(200, rows.length * 34)
  const yW   = 155

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>

      {/* FCOT % horizontal bars */}
      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title">FCOT % by service line</div>
            <div className="card-subtitle">First-case on-time start. Green ≥ 60%, amber 45–60%, red &lt; 45%.</div>
          </div>
        </div>
        <div style={{ padding: '0 var(--space-4) var(--space-4)' }}>
          <ResponsiveContainer width="100%" height={h}>
            <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 60, bottom: 4, left: yW }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--color-gray-100)" />
              <XAxis type="number" domain={[0, 100]} tickFormatter={v => `${v}%`} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
              <YAxis dataKey="service" type="category" width={yW} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
              <Tooltip formatter={v => [fmtPct(v), 'FCOT %']} contentStyle={{ fontSize: 11 }} />
              <ReferenceLine x={FCOT_TARGET} stroke="#16a34a" strokeDasharray="4 3"
                label={{ value: `${FCOT_TARGET}% target`, position: 'insideTopRight', fontSize: 10, fill: '#16a34a', dy: -4 }} />
              <Bar dataKey="fcot_pct" name="FCOT %" radius={[0, 3, 3, 0]}>
                {rows.map((r, i) => <Cell key={i} fill={fcotColor(r.fcot_pct)} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Avg turnover */}
      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title">Average turnover time (min)</div>
            <div className="card-subtitle">Includes only turnovers between 0–240 min. Reference line at {TURNOVER_TARGET} min.</div>
          </div>
        </div>
        <div style={{ padding: '0 var(--space-4) var(--space-4)' }}>
          <ResponsiveContainer width="100%" height={h}>
            <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 60, bottom: 4, left: yW }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--color-gray-100)" />
              <XAxis type="number" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
              <YAxis dataKey="service" type="category" width={yW} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
              <Tooltip formatter={v => [v != null ? `${fmt1(v)} min` : '—', 'Avg turnover']} contentStyle={{ fontSize: 11 }} />
              <ReferenceLine x={TURNOVER_TARGET} stroke="#d97706" strokeDasharray="4 3"
                label={{ value: `${TURNOVER_TARGET} min`, position: 'insideTopRight', fontSize: 10, fill: '#d97706', dy: -4 }} />
              <Bar dataKey="avg_turnover" name="Avg turnover (min)" fill="#2563eb" radius={[0, 3, 3, 0]}>
                {rows.map((r, i) => (
                  <Cell key={i} fill={r.avg_turnover != null && r.avg_turnover > TURNOVER_TARGET ? '#d97706' : '#2563eb'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Duration accuracy */}
      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title">Scheduling accuracy — actual vs scheduled duration</div>
            <div className="card-subtitle">Average of Dur_Act_vs_SchedDur in minutes. Positive = over scheduled, negative = under.</div>
          </div>
        </div>
        <div style={{ padding: '0 var(--space-4) var(--space-4)' }}>
          <ResponsiveContainer width="100%" height={h}>
            <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 60, bottom: 4, left: yW }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--color-gray-100)" />
              <XAxis type="number" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
              <YAxis dataKey="service" type="category" width={yW} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
              <Tooltip formatter={v => [v != null ? `${v >= 0 ? '+' : ''}${fmt1(v)} min` : '—', 'Dur delta']} contentStyle={{ fontSize: 11 }} />
              <ReferenceLine x={0} stroke="var(--color-gray-400)" />
              <Bar dataKey="avg_dur_delta" name="Dur Δ (min)" radius={[0, 3, 3, 0]}>
                {rows.map((r, i) => (
                  <Cell key={i} fill={r.avg_dur_delta == null ? '#94a3b8' : r.avg_dur_delta > 0 ? '#dc2626' : '#16a34a'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

    </div>
  )
}

/* ─── Page ───────────────────────────────────────────────────────────────────── */

const TABS = ['Overview', 'Service Line Detail', 'Efficiency']

export default function ORServiceLines() {
  const [activeTab,             setActiveTab]             = useState('Overview')
  const [selectedDetailService, setSelectedDetailService] = useState('')
  const [filters,               setFilters]               = useState({
    from:     isoMonthsAgo(6),
    to:       isoToday(),
    location: '',
    caseType: '',
  })

  const qs = buildQS(filters)

  const filterOptions = useFetch(`/api/orserviceline/filter-options?${qs}`)
  const summary       = useFetch(`/api/orserviceline/summary?${qs}`)
  const services      = useFetch(`/api/orserviceline/by-service?${qs}`)

  return (
    <div className="page">
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      <FilterBar filters={filters} setFilters={setFilters} filterOptions={filterOptions.data} />

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 2, marginBottom: 'var(--space-5)', borderBottom: '1px solid var(--surface-border)' }}>
        {TABS.map(tab => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              padding: '9px 18px',
              fontSize: 'var(--font-size-sm)',
              fontWeight: activeTab === tab ? 700 : 400,
              color: activeTab === tab ? 'var(--color-blue)' : 'var(--color-gray-500)',
              borderBottom: activeTab === tab ? '2px solid var(--color-blue)' : '2px solid transparent',
              marginBottom: -1,
              transition: 'color 120ms',
            }}
          >
            {tab}
          </button>
        ))}
      </div>

      {activeTab === 'Overview'            && <OverviewTab          summary={summary} services={services} qs={qs} onOpenDetail={svc => { setSelectedDetailService(svc); setActiveTab('Service Line Detail') }} />}
      {activeTab === 'Service Line Detail' && <ServiceLineDetailTab services={services} filterOptions={filterOptions.data} selectedService={selectedDetailService} />}
      {activeTab === 'Efficiency'          && <EfficiencyTab        services={services} />}
    </div>
  )
}

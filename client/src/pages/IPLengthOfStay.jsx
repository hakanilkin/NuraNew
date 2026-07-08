import { useState, useEffect, useMemo, useRef } from 'react'
import { ChevronRight, ChevronDown, AlertCircle, BarChart3 } from 'lucide-react'
import { LineChart, Line, ComposedChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'

/* ─── Constants ─────────────────────────────────────────────────────────────── */

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'focus',    label: 'Where to focus' },
  { id: 'trend',    label: 'Trend' },
]

const PANEL_DIMS = ['service_line', 'unit', 'disposition', 'payer', 'admission_hour', 'admitting_physician', 'discharging_physician']

const PANEL_LABELS = {
  service_line:          'Service line',
  unit:                  'Discharging unit',
  disposition:           'Disposition',
  payer:                 'Payer',
  admission_hour:        'Admission hour',
  admitting_physician:   'Physician (admitting)',
  discharging_physician: 'Physician (discharging)',
}


/* ─── Helpers ───────────────────────────────────────────────────────────────── */

function fmtD(v) {
  if (v == null || isNaN(parseFloat(v))) return '—'
  return `${parseFloat(v).toFixed(1)}d`
}

function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

function defaultFrom() {
  const d = new Date()
  d.setMonth(d.getMonth() - 6)
  return d.toISOString().slice(0, 10)
}

function useDebounced(value, delay = 600) {
  const [dv, setDv] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDv(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return dv
}

function apiFetch(url, signal) {
  return fetch(url, { signal })
    .then(r => r.ok ? r.json() : r.json().then(d => Promise.reject(new Error(d.error || `HTTP ${r.status}`))))
}

/* ─── Shared sub-components ─────────────────────────────────────────────────── */

function Spinner({ label = 'Loading…' }) {
  return (
    <div style={{ textAlign: 'center', padding: 'var(--space-8) 0', color: 'var(--color-gray-400)' }}>
      <div style={{
        width: 28, height: 28, borderRadius: '50%',
        border: '3px solid var(--color-blue)', borderTopColor: 'transparent',
        animation: 'spin 0.7s linear infinite',
        margin: '0 auto var(--space-2)',
      }} />
      <p style={{ fontSize: 'var(--font-size-sm)' }}>{label}</p>
    </div>
  )
}

function ErrorMsg({ message }) {
  if (!message) return null
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 'var(--space-2)',
      padding: 'var(--space-4)', fontSize: 'var(--font-size-sm)',
      background: 'var(--color-danger-light)', border: '1px solid #fecaca',
      borderRadius: 'var(--radius-lg)', color: '#b91c1c',
    }}>
      <AlertCircle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
      <span>{message}</span>
    </div>
  )
}

function StatCard({ label, value, sub, accent }) {
  return (
    <div style={{
      background: 'var(--surface-card)',
      border: '1px solid var(--surface-border)',
      borderRadius: 'var(--radius-lg)',
      padding: 'var(--space-4)',
    }}>
      <div style={{
        fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)',
        marginBottom: 'var(--space-2)', textTransform: 'uppercase',
        letterSpacing: '0.05em', fontWeight: 'var(--font-weight-medium)',
      }}>
        {label}
      </div>
      <div style={{
        fontSize: 'var(--font-size-xl)', fontWeight: 'var(--font-weight-semibold)',
        color: accent || 'var(--color-gray-900)', lineHeight: 1.2,
      }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)', marginTop: 4 }}>
          {sub}
        </div>
      )}
    </div>
  )
}

/* ─── Breakdown panel: Excess mode ─────────────────────────────────────────── */

function ExcessRow({ row, maxTotal, indented, expandable, expanded, onToggle }) {
  const barPct = maxTotal > 0 ? Math.min((row.total_excess_days ?? 0) / maxTotal * 100, 100) : 0
  return (
    <div>
      <div
        onClick={expandable ? onToggle : undefined}
        style={{
          display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
          padding: `6px ${indented ? 'var(--space-6)' : 'var(--space-4)'}`,
          cursor: expandable ? 'pointer' : 'default',
          background: indented ? 'var(--color-gray-50)' : 'none',
        }}
      >
        {/* Expand icon */}
        <div style={{ width: 16, flexShrink: 0, color: 'var(--color-gray-400)', display: 'flex', alignItems: 'center' }}>
          {expandable && (expanded
            ? <ChevronDown size={14} />
            : <ChevronRight size={14} />
          )}
        </div>

        {/* Label */}
        <div style={{
          flex: 1, minWidth: 0,
          fontSize: 'var(--font-size-sm)',
          color: indented ? 'var(--color-gray-600)' : 'var(--color-gray-800)',
          fontWeight: indented ? 400 : 'var(--font-weight-medium)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {row.group_name}
        </div>

        {/* Bar + total */}
        <div style={{ width: 240, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1, height: 8, background: 'var(--color-gray-100)', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${barPct}%`, background: 'rgba(229,83,83,0.8)', borderRadius: 4 }} />
          </div>
          <div style={{
            width: 64, flexShrink: 0, textAlign: 'right',
            fontSize: 12, fontWeight: 600, color: '#c62828',
            fontVariantNumeric: 'tabular-nums',
          }}>
            {Math.round(row.total_excess_days ?? 0).toLocaleString()}d
          </div>
        </div>

        {/* Avg */}
        <div style={{ width: 56, flexShrink: 0, textAlign: 'right', fontSize: 12, color: 'var(--color-gray-600)', fontVariantNumeric: 'tabular-nums' }}>
          {fmtD(row.avg_excess)}
        </div>

        {/* Cases */}
        <div style={{ width: 60, flexShrink: 0, textAlign: 'right', fontSize: 12, color: 'var(--color-gray-500)', fontVariantNumeric: 'tabular-nums' }}>
          {Math.round(row.n_cases ?? 0).toLocaleString()}
        </div>
      </div>
    </div>
  )
}

function ExcessBreakdownPanel({ title, data, loading, error, isServiceLine, expandedSL, slDrilldown, onToggleSL, headerRight, maxRows = 12 }) {
  const sorted = useMemo(() => {
    if (!data) return []
    return [...data].sort((a, b) => (b.total_excess_days ?? 0) - (a.total_excess_days ?? 0)).slice(0, maxRows)
  }, [data, maxRows])

  const maxTotal = useMemo(() => Math.max(...sorted.map(r => r.total_excess_days ?? 0), 1), [sorted])

  return (
    <div className="card" style={{ marginBottom: 'var(--space-4)' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: 'var(--space-3) var(--space-4)',
        borderBottom: '1px solid var(--surface-border)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-gray-800)' }}>
            {title}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)' }}>
          {/* Column labels */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', fontSize: 11, color: 'var(--color-gray-400)', fontWeight: 600 }}>
            <div style={{ width: 240 }}>Total excess / Avg</div>
            <div style={{ width: 56, textAlign: 'right' }}>Avg</div>
            <div style={{ width: 60, textAlign: 'right' }}>Cases</div>
          </div>
          {headerRight}
        </div>
      </div>

      {/* Body */}
      {loading ? <Spinner /> : error ? <div style={{ padding: 'var(--space-4)' }}><ErrorMsg message={error} /></div> : (
        <div>
          {sorted.length === 0 && (
            <div style={{ padding: 'var(--space-6)', textAlign: 'center', fontSize: 'var(--font-size-sm)', color: 'var(--color-gray-400)' }}>
              No data for this period
            </div>
          )}
          {sorted.map((row, i) => {
            const isExpanded = isServiceLine && expandedSL.has(row.group_name)
            const sub = isServiceLine ? slDrilldown[row.group_name] : null
            return (
              <div key={row.group_name} style={{ borderBottom: i < sorted.length - 1 ? '1px solid var(--surface-border)' : 'none' }}>
                <ExcessRow
                  row={row} maxTotal={maxTotal}
                  expandable={isServiceLine} expanded={isExpanded}
                  onToggle={() => onToggleSL(row.group_name)}
                />
                {isExpanded && (
                  <div style={{ borderTop: '1px solid var(--surface-border)' }}>
                    {sub?.loading && <Spinner label="Loading sub-services…" />}
                    {sub?.error && <div style={{ padding: 'var(--space-3) var(--space-6)' }}><ErrorMsg message={sub.error} /></div>}
                    {sub?.data?.map(sr => (
                      <ExcessRow key={sr.group_name} row={sr} maxTotal={maxTotal} indented />
                    ))}
                    {sub?.data?.length === 0 && (
                      <div style={{ padding: '6px var(--space-6)', fontSize: 12, color: 'var(--color-gray-400)' }}>
                        No sub-service data (minimum 10 cases)
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* ─── Breakdown panel: LOS mode ─────────────────────────────────────────────── */

function LOSRow({ row, maxLOS, indented, expandable, expanded, onToggle }) {
  const scale   = maxLOS > 0 ? maxLOS : 1
  const losPct  = Math.min((row.avg_los  ?? 0) / scale * 100, 100)
  const gmlosPct = Math.min((row.avg_gmlos ?? 0) / scale * 100, 100)
  return (
    <div>
      <div
        onClick={expandable ? onToggle : undefined}
        style={{
          display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
          padding: `6px ${indented ? 'var(--space-6)' : 'var(--space-4)'}`,
          cursor: expandable ? 'pointer' : 'default',
          background: indented ? 'var(--color-gray-50)' : 'none',
        }}
      >
        <div style={{ width: 16, flexShrink: 0, color: 'var(--color-gray-400)', display: 'flex', alignItems: 'center' }}>
          {expandable && (expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
        </div>

        <div style={{
          flex: 1, minWidth: 0,
          fontSize: 'var(--font-size-sm)',
          color: indented ? 'var(--color-gray-600)' : 'var(--color-gray-800)',
          fontWeight: indented ? 400 : 'var(--font-weight-medium)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {row.group_name}
        </div>

        {/* Paired bar */}
        <div style={{ width: 180, flexShrink: 0, position: 'relative', height: 14 }}>
          {/* Track */}
          <div style={{ position: 'absolute', inset: 0, background: 'var(--color-gray-100)', borderRadius: 4, overflow: 'hidden' }}>
            {/* Blue observed bar */}
            <div style={{ height: '100%', width: `${losPct}%`, background: '#3E53E3', borderRadius: 4 }} />
          </div>
          {/* GMLOS tick */}
          <div style={{
            position: 'absolute', top: -2, bottom: -2,
            left: `${gmlosPct}%`,
            width: 2, background: '#e55353', borderRadius: 1,
          }} />
        </div>

        {/* Values */}
        <div style={{ width: 140, flexShrink: 0, fontSize: 12, color: 'var(--color-gray-600)', fontVariantNumeric: 'tabular-nums' }}>
          <span style={{ color: '#3E53E3', fontWeight: 600 }}>{fmtD(row.avg_los)}</span>
          <span style={{ color: 'var(--color-gray-400)' }}> vs {fmtD(row.avg_gmlos)} exp</span>
        </div>

        {/* O:E */}
        <div style={{
          width: 56, flexShrink: 0, textAlign: 'right', fontSize: 12,
          fontWeight: 600, fontVariantNumeric: 'tabular-nums',
          color: (row.oe_ratio ?? 1) > 1.1 ? '#c62828' : (row.oe_ratio ?? 1) < 0.9 ? '#1565c0' : 'var(--color-gray-600)',
        }}>
          {row.oe_ratio != null ? parseFloat(row.oe_ratio).toFixed(2) : '—'}
        </div>

        <div style={{ width: 60, flexShrink: 0, textAlign: 'right', fontSize: 12, color: 'var(--color-gray-500)', fontVariantNumeric: 'tabular-nums' }}>
          {Math.round(row.n_cases ?? 0).toLocaleString()}
        </div>
      </div>
    </div>
  )
}

function LOSBreakdownPanel({ title, data, loading, error, isServiceLine, expandedSL, slDrilldown, onToggleSL, headerRight, maxRows = 12 }) {
  const sorted = useMemo(() => {
    if (!data) return []
    return [...data].sort((a, b) => (b.avg_los ?? 0) - (a.avg_los ?? 0)).slice(0, maxRows)
  }, [data, maxRows])

  const maxLOS = useMemo(() => Math.max(...sorted.map(r => r.avg_los ?? 0), 1), [sorted])

  return (
    <div className="card" style={{ marginBottom: 'var(--space-4)' }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: 'var(--space-3) var(--space-4)',
        borderBottom: '1px solid var(--surface-border)',
      }}>
        <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-gray-800)' }}>
          {title}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', fontSize: 11, color: 'var(--color-gray-400)', fontWeight: 600 }}>
            <div style={{ width: 180 }}>Scale</div>
            <div style={{ width: 140 }}>Obs vs Expected</div>
            <div style={{ width: 56, textAlign: 'right' }}>O:E</div>
            <div style={{ width: 60, textAlign: 'right' }}>Cases</div>
          </div>
          {headerRight}
        </div>
      </div>

      {loading ? <Spinner /> : error ? <div style={{ padding: 'var(--space-4)' }}><ErrorMsg message={error} /></div> : (
        <div>
          {sorted.length === 0 && (
            <div style={{ padding: 'var(--space-6)', textAlign: 'center', fontSize: 'var(--font-size-sm)', color: 'var(--color-gray-400)' }}>
              No data for this period
            </div>
          )}
          {sorted.map((row, i) => {
            const isExpanded = isServiceLine && expandedSL.has(row.group_name)
            const sub = isServiceLine ? slDrilldown[row.group_name] : null
            return (
              <div key={row.group_name} style={{ borderBottom: i < sorted.length - 1 ? '1px solid var(--surface-border)' : 'none' }}>
                <LOSRow
                  row={row} maxLOS={maxLOS}
                  expandable={isServiceLine} expanded={isExpanded}
                  onToggle={() => onToggleSL(row.group_name)}
                />
                {isExpanded && (
                  <div style={{ borderTop: '1px solid var(--surface-border)' }}>
                    {sub?.loading && <Spinner label="Loading sub-services…" />}
                    {sub?.error && <div style={{ padding: 'var(--space-3) var(--space-6)' }}><ErrorMsg message={sub.error} /></div>}
                    {sub?.data?.map(sr => (
                      <LOSRow key={sr.group_name} row={sr} maxLOS={maxLOS} indented />
                    ))}
                    {sub?.data?.length === 0 && (
                      <div style={{ padding: '6px var(--space-6)', fontSize: 12, color: 'var(--color-gray-400)' }}>
                        No sub-service data (minimum 10 cases)
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* ─── PhysicianToggle ────────────────────────────────────────────────────────── */

function PhysicianToggle({ mode, onChange }) {
  const pill = (id, label) => (
    <button
      type="button"
      onClick={() => onChange(id)}
      style={{
        padding: '3px 12px', border: 'none', borderRadius: 12, cursor: 'pointer',
        fontSize: 11, fontWeight: 600,
        background: mode === id ? 'var(--color-blue)' : 'transparent',
        color: mode === id ? 'white' : 'var(--color-gray-500)',
        transition: 'background 150ms',
      }}
    >
      {label}
    </button>
  )
  return (
    <div style={{ display: 'flex', background: 'var(--color-gray-100)', borderRadius: 14, padding: 2 }}>
      {pill('admitting',   'Admitting')}
      {pill('discharging', 'Discharging')}
    </div>
  )
}

/* ─── Excess Days Tab ────────────────────────────────────────────────────────── */

function ExcessDaysTab({ summary, sumLoading, sumError, breakdowns, bLoading, bErrors, expandedSL, slDrilldown, onToggleSL, physicianMode, onPhysicianToggle, sl2Enabled = true }) {
  const s = summary

  const cards = sumLoading ? null : sumError ? null : [
    { label: 'Discharges',      value: Math.round(s?.total_discharges ?? 0).toLocaleString() },
    { label: 'Total excess days', value: `${Math.round(s?.total_excess_days ?? 0).toLocaleString()}d` },
    { label: 'Avg excess / case', value: fmtD(s?.avg_excess) },
    { label: '% with excess',   value: s?.pct_with_excess != null ? `${parseFloat(s.pct_with_excess).toFixed(1)}%` : '—' },
  ]

  const physicianDim = physicianMode === 'admitting' ? 'admitting_physician' : 'discharging_physician'

  const panels = [
    { dim: 'service_line',  title: 'Service line',     isServiceLine: sl2Enabled },
    { dim: 'unit',          title: 'Discharging unit', isServiceLine: false },
    { dim: 'disposition',   title: 'Disposition',      isServiceLine: false },
    { dim: 'payer',         title: 'Payer',             isServiceLine: false },
    { dim: 'admission_hour', title: 'Admission hour',   isServiceLine: false },
  ]

  return (
    <>
      {/* Stat cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--space-4)', marginBottom: 'var(--space-5)' }}>
        {sumLoading
          ? Array.from({ length: 4 }, (_, i) => <StatCard key={i} label="…" value="—" />)
          : sumError
            ? <div style={{ gridColumn: '1/-1' }}><ErrorMsg message={sumError} /></div>
            : cards.map((c, i) => <StatCard key={i} {...c} />)
        }
      </div>

      {/* Panels */}
      {panels.map(p => (
        <ExcessBreakdownPanel
          key={p.dim}
          title={p.title}
          data={breakdowns[p.dim]}
          loading={bLoading[p.dim]}
          error={bErrors[p.dim]}
          isServiceLine={p.isServiceLine}
          expandedSL={expandedSL}
          slDrilldown={slDrilldown}
          onToggleSL={onToggleSL}
        />
      ))}

      {/* Physician panel */}
      <ExcessBreakdownPanel
        title="Physician"
        data={breakdowns[physicianDim]}
        loading={bLoading[physicianDim]}
        error={bErrors[physicianDim]}
        isServiceLine={false}
        expandedSL={expandedSL}
        slDrilldown={slDrilldown}
        onToggleSL={onToggleSL}
        headerRight={<PhysicianToggle mode={physicianMode} onChange={onPhysicianToggle} />}
      />
    </>
  )
}

/* ─── LOS Tab ────────────────────────────────────────────────────────────────── */

function LOSTab({ summary, sumLoading, sumError, breakdowns, bLoading, bErrors, expandedSL, slDrilldown, onToggleSL, physicianMode, onPhysicianToggle, sl2Enabled = true }) {
  const s = summary

  const cards = sumLoading ? null : sumError ? null : [
    { label: 'Discharges',    value: Math.round(s?.total_discharges ?? 0).toLocaleString() },
    { label: 'Avg LOS',       value: fmtD(s?.avg_los) },
    { label: 'Avg expected',  value: fmtD(s?.avg_gmlos), sub: 'DRG GMLOS' },
    { label: 'O:E ratio',     value: s?.oe_ratio != null ? parseFloat(s.oe_ratio).toFixed(2) : '—',
      accent: (parseFloat(s?.oe_ratio) || 1) > 1.1 ? '#c62828' : (parseFloat(s?.oe_ratio) || 1) < 0.9 ? '#1565c0' : undefined },
  ]

  const physicianDim = physicianMode === 'admitting' ? 'admitting_physician' : 'discharging_physician'

  const panels = [
    { dim: 'service_line',  title: 'Service line',     isServiceLine: sl2Enabled },
    { dim: 'unit',          title: 'Discharging unit', isServiceLine: false },
    { dim: 'disposition',   title: 'Disposition',      isServiceLine: false },
    { dim: 'payer',         title: 'Payer',             isServiceLine: false },
    { dim: 'admission_hour', title: 'Admission hour',   isServiceLine: false },
  ]

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--space-4)', marginBottom: 'var(--space-5)' }}>
        {sumLoading
          ? Array.from({ length: 4 }, (_, i) => <StatCard key={i} label="…" value="—" />)
          : sumError
            ? <div style={{ gridColumn: '1/-1' }}><ErrorMsg message={sumError} /></div>
            : cards.map((c, i) => <StatCard key={i} {...c} />)
        }
      </div>

      {panels.map(p => (
        <LOSBreakdownPanel
          key={p.dim}
          title={p.title}
          data={breakdowns[p.dim]}
          loading={bLoading[p.dim]}
          error={bErrors[p.dim]}
          isServiceLine={p.isServiceLine}
          expandedSL={expandedSL}
          slDrilldown={slDrilldown}
          onToggleSL={onToggleSL}
        />
      ))}

      <LOSBreakdownPanel
        title="Physician"
        data={breakdowns[physicianDim]}
        loading={bLoading[physicianDim]}
        error={bErrors[physicianDim]}
        isServiceLine={false}
        expandedSL={expandedSL}
        slDrilldown={slDrilldown}
        onToggleSL={onToggleSL}
        headerRight={<PhysicianToggle mode={physicianMode} onChange={onPhysicianToggle} />}
      />
    </>
  )
}

/* ─── Overview Tab ──────────────────────────────────────────────────────────── */

function OverviewTab(props) {
  const [metric, setMetric] = useState('excess')

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-5)' }}>
        <label style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-500)', fontWeight: 'var(--font-weight-medium)' }}>
          View
        </label>
        <select
          value={metric}
          onChange={e => setMetric(e.target.value)}
          style={{
            padding: '5px 10px', fontSize: 13,
            border: '1px solid var(--surface-border)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--surface-card)', color: 'var(--color-gray-700)',
            cursor: 'pointer',
          }}
        >
          <option value="excess">Excess days</option>
          <option value="los">Length of stay</option>
        </select>
      </div>
      {metric === 'excess'
        ? <ExcessDaysTab {...props} />
        : <LOSTab        {...props} />
      }
    </>
  )
}

/* ─── Trend Tab ─────────────────────────────────────────────────────────────── */

function fmtMonth(m) {
  if (!m) return ''
  const [yr, mo] = m.split('-')
  const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${names[parseInt(mo, 10) - 1]} '${yr.slice(2)}`
}

function TrendTab({ from, to }) {
  const [filterSL,   setFilterSL]   = useState('')
  const [filterSL2,  setFilterSL2]  = useState('')
  const [filterUnit, setFilterUnit] = useState('')
  const [filterDisp, setFilterDisp] = useState('')
  const [filterPay,  setFilterPay]  = useState('')
  const [filterAMD,  setFilterAMD]  = useState('')
  const [filterDMD,  setFilterDMD]  = useState('')
  const [opts,       setOpts]       = useState({})
  const [data,       setData]       = useState(null)
  const [loading,    setLoading]    = useState(false)
  const [error,      setError]      = useState('')
  const [cumulative, setCumulative] = useState(false)

  useEffect(() => {
    const ctrl = new AbortController()
    apiFetch(`/api/iplos/filter-options?from=${from}&to=${to}`, ctrl.signal)
      .then(d => setOpts(d))
      .catch(() => {})
    return () => ctrl.abort()
  }, [from, to])

  useEffect(() => {
    const ctrl   = new AbortController()
    const params = new URLSearchParams({ from, to })
    if (filterSL)   params.set('filter_service_line',          filterSL)
    if (filterSL2)  params.set('filter_service_line_2',        filterSL2)
    if (filterUnit) params.set('filter_unit',                  filterUnit)
    if (filterDisp) params.set('filter_disposition',           filterDisp)
    if (filterPay)  params.set('filter_payer',                 filterPay)
    if (filterAMD)  params.set('filter_admitting_physician',   filterAMD)
    if (filterDMD)  params.set('filter_discharging_physician', filterDMD)
    setLoading(true)
    apiFetch(`/api/iplos/trend?${params}`, ctrl.signal)
      .then(d  => { setData(d); setError('') })
      .catch(e => { if (e.name !== 'AbortError') setError(e.message) })
      .finally(() => setLoading(false))
    return () => ctrl.abort()
  }, [from, to, filterSL, filterSL2, filterUnit, filterDisp, filterPay, filterAMD, filterDMD])

  const monthly = data?.monthly ?? []
  const priorYr = data?.prior_year_monthly ?? []
  const kpis    = data?.kpis ?? null

  const chartData = useMemo(() => monthly.map(r => ({
    label:              fmtMonth(r.month),
    avg_los:            parseFloat((r.avg_los            ?? 0).toFixed(2)),
    avg_gmlos:          parseFloat((r.avg_gmlos          ?? 0).toFixed(2)),
    avg_excess:         parseFloat((r.avg_excess         ?? 0).toFixed(2)),
    oe_ratio:           parseFloat((r.oe_ratio           ?? 0).toFixed(2)),
    total_excess_days:  r.total_excess_days ?? 0,
  })), [monthly])

  const excessData = useMemo(() => {
    let cum = 0
    return chartData.map(r => { cum += r.total_excess_days; return { ...r, cumulative_excess: cum } })
  }, [chartData])

  const overlayData = useMemo(() => {
    const len = Math.max(monthly.length, priorYr.length)
    return Array.from({ length: len }, (_, i) => ({
      label:   fmtMonth(monthly[i]?.month ?? ''),
      current: monthly[i]  != null ? parseFloat((monthly[i].avg_los  ?? 0).toFixed(2)) : null,
      prior:   priorYr[i]  != null ? parseFloat((priorYr[i].avg_los  ?? 0).toFixed(2)) : null,
    }))
  }, [monthly, priorYr])

  const selectStyle = {
    width: '100%', padding: '5px 8px', fontSize: 12,
    border: '1px solid var(--surface-border)',
    borderRadius: 'var(--radius-md)',
    background: 'var(--surface-card)',
    color: 'var(--color-gray-700)',
  }

  function FilterSelect({ label, value, onChange, options }) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <label style={{ fontSize: 10, color: 'var(--color-gray-400)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          {label}
        </label>
        <select value={value} onChange={e => onChange(e.target.value)} style={selectStyle}>
          <option value="">All</option>
          {(options ?? []).map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      </div>
    )
  }

  const axisStyle  = { fontSize: 11, fill: 'var(--color-gray-500)' }
  const gridStroke = 'var(--color-gray-100)'

  return (
    <div style={{ display: 'flex', gap: 'var(--space-5)', alignItems: 'flex-start' }}>

      {/* ── Filter rail ── */}
      <div style={{
        width: 192, flexShrink: 0,
        display: 'flex', flexDirection: 'column', gap: 'var(--space-3)',
        position: 'sticky', top: 20,
      }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-gray-500)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          Filters
        </div>
        <FilterSelect label="Service line"     value={filterSL}   onChange={setFilterSL}   options={opts.service_line} />
        {opts.service_line_2 !== undefined && (
          <FilterSelect label="Sub-service"      value={filterSL2}  onChange={setFilterSL2}  options={opts.service_line_2} />
        )}
        <FilterSelect label="Unit"             value={filterUnit} onChange={setFilterUnit} options={opts.unit} />
        <FilterSelect label="Disposition"      value={filterDisp} onChange={setFilterDisp} options={opts.disposition} />
        <FilterSelect label="Payer"            value={filterPay}  onChange={setFilterPay}  options={opts.payer} />
        <FilterSelect label="Adm. physician"   value={filterAMD}  onChange={setFilterAMD}  options={opts.admitting_physician} />
        <FilterSelect label="Disch. physician" value={filterDMD}  onChange={setFilterDMD}  options={opts.discharging_physician} />
      </div>

      {/* ── Main content ── */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
        {loading && <Spinner label="Loading trend data…" />}
        {!loading && error && <ErrorMsg message={error} />}
        {!loading && !error && kpis && (
          <>
            {/* KPI cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--space-3)' }}>
              <StatCard label="Discharges"        value={(kpis.n_cases ?? 0).toLocaleString()} />
              <StatCard label="Avg LOS"            value={fmtD(kpis.avg_los)}   sub={`Expected ${fmtD(kpis.avg_gmlos)}`} />
              <StatCard
                label="O:E Ratio"
                value={(kpis.oe_ratio ?? 0).toFixed(2)}
                accent={(kpis.oe_ratio ?? 1) > 1.05 ? '#c62828' : (kpis.oe_ratio ?? 1) < 0.95 ? '#1565c0' : undefined}
              />
              <StatCard label="Total Excess Days"  value={`${Math.round(kpis.total_excess_days ?? 0).toLocaleString()}d`} accent="#E55353" />
            </div>

            {/* Chart 1: LOS vs Expected */}
            <div className="card">
              <div style={{ padding: 'var(--space-3) var(--space-4)', borderBottom: '1px solid var(--surface-border)', fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-gray-800)' }}>
                LOS vs Expected (GMLOS) by month
              </div>
              <div style={{ padding: 'var(--space-4)', height: 248 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chartData} margin={{ top: 4, right: 12, bottom: 4, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
                    <XAxis dataKey="label" tick={axisStyle} />
                    <YAxis tick={axisStyle} unit="d" width={42} />
                    <Tooltip formatter={(v, name) => [`${parseFloat(v).toFixed(1)}d`, name]} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="avg_excess" name="Excess" fill="rgba(229,83,83,0.22)" radius={[2,2,0,0]} />
                    <Line type="monotone" dataKey="avg_los"   name="Avg LOS"  stroke="#3E53E3" dot={false} strokeWidth={2} />
                    <Line type="monotone" dataKey="avg_gmlos" name="Expected" stroke="#9CA3AF" dot={false} strokeWidth={2} strokeDasharray="5 3" />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Chart 2: Current vs Prior Year */}
            <div className="card">
              <div style={{ padding: 'var(--space-3) var(--space-4)', borderBottom: '1px solid var(--surface-border)', fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-gray-800)' }}>
                Avg LOS — current vs prior year
              </div>
              <div style={{ padding: 'var(--space-4)', height: 224 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={overlayData} margin={{ top: 4, right: 12, bottom: 4, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
                    <XAxis dataKey="label" tick={axisStyle} />
                    <YAxis tick={axisStyle} unit="d" width={42} />
                    <Tooltip formatter={(v, name) => v != null ? [`${parseFloat(v).toFixed(1)}d`, name] : ['—', name]} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Line type="monotone" dataKey="current" name="Current period" stroke="#3E53E3" dot={false} strokeWidth={2} connectNulls />
                    <Line type="monotone" dataKey="prior"   name="Prior year"     stroke="#9CA3AF" dot={false} strokeWidth={2} strokeDasharray="5 3" connectNulls />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Chart 3: Excess Days */}
            <div className="card">
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: 'var(--space-3) var(--space-4)', borderBottom: '1px solid var(--surface-border)',
              }}>
                <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-gray-800)' }}>
                  {cumulative ? 'Cumulative excess days' : 'Monthly excess days'}
                </div>
                <button
                  type="button"
                  onClick={() => setCumulative(c => !c)}
                  style={{
                    fontSize: 11, padding: '3px 10px',
                    border: '1px solid var(--surface-border)',
                    borderRadius: 'var(--radius-md)',
                    background: cumulative ? 'var(--color-blue)' : 'var(--surface-card)',
                    color:      cumulative ? '#fff' : 'var(--color-gray-600)',
                    cursor: 'pointer',
                  }}
                >
                  Cumulative
                </button>
              </div>
              <div style={{ padding: 'var(--space-4)', height: 224 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={excessData} margin={{ top: 4, right: 12, bottom: 4, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
                    <XAxis dataKey="label" tick={axisStyle} />
                    <YAxis tick={axisStyle} unit="d" width={50} />
                    <Tooltip formatter={(v, name) => [`${Math.round(v).toLocaleString()}d`, name]} />
                    {cumulative
                      ? <Line type="monotone" dataKey="cumulative_excess"  name="Cumulative excess" stroke="#E55353" dot={false} strokeWidth={2} />
                      : <Bar                  dataKey="total_excess_days"  name="Excess days"       fill="#E55353" radius={[2,2,0,0]} fillOpacity={0.8} />
                    }
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>
          </>
        )}
        {!loading && !error && !kpis && (
          <div style={{ textAlign: 'center', padding: 'var(--space-10) 0', color: 'var(--color-gray-400)', fontSize: 'var(--font-size-sm)' }}>
            No data for this date range
          </div>
        )}
      </div>
    </div>
  )
}

/* ─── Where to Focus Tab ────────────────────────────────────────────────────── */

const COLOR_FAC  = '#E24B4A'
const COLOR_HOME = '#378ADD'

function fmtExcess(v) {
  const n = parseFloat(v)
  if (isNaN(n)) return '—'
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}d`
}

function DrillTable({ title, rows, color }) {
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{
        fontSize: 10, fontWeight: 600, color: 'var(--color-gray-400)',
        textTransform: 'uppercase', letterSpacing: '0.04em',
        paddingBottom: 4, marginBottom: 2,
        borderBottom: '1px solid var(--surface-border)',
      }}>
        {title}
      </div>
      {(!rows || rows.length === 0) ? (
        <div style={{ fontSize: 11, color: 'var(--color-gray-400)', padding: '5px 0' }}>
          No data (min 20 cases)
        </div>
      ) : rows.map((r, i) => (
        <div key={i} style={{
          display: 'flex', alignItems: 'baseline', gap: 6, padding: '3px 0',
          borderBottom: i < rows.length - 1 ? '1px solid var(--surface-border)' : 'none',
        }}>
          <div style={{ flex: 1, minWidth: 0, fontSize: 11, color: 'var(--color-gray-700)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {r.label}
          </div>
          <div style={{ fontSize: 11, fontWeight: 600, color, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
            {Math.round(r.total_excess_days).toLocaleString()}d
          </div>
          <div style={{ fontSize: 10, color: 'var(--color-gray-400)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
            {fmtExcess(r.avg_excess)}
          </div>
          <div style={{ fontSize: 10, color: 'var(--color-gray-400)', flexShrink: 0 }}>
            n={r.n.toLocaleString()}
          </div>
        </div>
      ))}
    </div>
  )
}

function SegmentCard({ title, subtitle, segments, color, keyFn, labelFn, drillFn, expanded, onToggle }) {
  return (
    <div className="card">
      <div style={{ padding: 'var(--space-3) var(--space-4)', borderBottom: '1px solid var(--surface-border)' }}>
        <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-gray-800)' }}>
          {title}
        </div>
        <div style={{ fontSize: 11, color: 'var(--color-gray-400)', marginTop: 2 }}>{subtitle}</div>
      </div>

      {segments.length === 0 && (
        <div style={{ padding: 'var(--space-6)', textAlign: 'center', fontSize: 'var(--font-size-sm)', color: 'var(--color-gray-400)' }}>
          No data
        </div>
      )}

      {segments.map((seg, i) => {
        const key        = keyFn(seg)
        const isExp      = expanded.has(key)
        const { left, right } = drillFn(seg)
        return (
          <div key={key} style={{ borderBottom: i < segments.length - 1 ? '1px solid var(--surface-border)' : 'none' }}>
            <div
              onClick={() => onToggle(key)}
              style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', padding: 'var(--space-3) var(--space-5)', cursor: 'pointer' }}
            >
              <div style={{ color: 'var(--color-gray-400)', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                {isExp ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-medium)', color: 'var(--color-gray-800)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {labelFn(seg)}
                </div>
                <div style={{ fontSize: 11, color: 'var(--color-gray-400)', marginTop: 1 }}>
                  {seg.n.toLocaleString()} cases · avg {fmtExcess(seg.avg_excess)}
                </div>
              </div>
              <div style={{ fontSize: 13, fontWeight: 700, color, fontVariantNumeric: 'tabular-nums', flexShrink: 0, paddingLeft: 12 }}>
                {Math.round(seg.total_excess_days).toLocaleString()}d
              </div>
            </div>

            {isExp && (
              <div style={{ background: 'var(--color-gray-50)', borderTop: '1px solid var(--surface-border)', padding: 'var(--space-3) var(--space-5)' }}>
                <div style={{ display: 'flex', gap: 'var(--space-5)' }}>
                  <DrillTable title={left.title}  rows={left.rows}  color={color} />
                  <DrillTable title={right.title} rows={right.rows} color={color} />
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function FocusTab() {
  const [segs,        setSegs]        = useState(null)
  const [loading,     setLoading]     = useState(true)
  const [error,       setError]       = useState('')
  const [noAtlasData, setNoAtlasData] = useState(false)
  const [expanded,    setExpanded]    = useState(() => new Set())

  useEffect(() => {
    apiFetch('/api/atlas/los-segments')
      .then(d => {
        if (d.error === 'no_atlas_data') { setNoAtlasData(true); return; }
        setSegs(d)
        setError('')
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <Spinner label="Loading segment data…" />
  if (noAtlasData) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 280 }}>
        <div style={{ textAlign: 'center', color: 'var(--color-gray-400)', maxWidth: 420 }}>
          <BarChart3 size={36} style={{ margin: '0 auto 12px', opacity: 0.25 }} />
          <p style={{ fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-gray-600)', marginBottom: 6, fontSize: 'var(--font-size-base)' }}>
            No Atlas data for this organization
          </p>
          <p style={{ fontSize: 'var(--font-size-sm)', lineHeight: 1.6 }}>
            Atlas model data has not been generated yet. Run the pipeline for this organization to generate insights.
          </p>
        </div>
      </div>
    )
  }
  if (error)   return <ErrorMsg message={error} />
  if (!segs)   return null

  const { headline, facility_segments, home_segments } = segs

  const top10rows = headline.rows.slice(0, 10)
  const tenth     = headline.rows[Math.min(9, headline.rows.length - 1)]
  const top10pct  = tenth?.cumulative_pct ?? 100
  const chartMax  = Math.max(...top10rows.map(r => Math.max(r.total_excess_days, 0)), 1)

  function toggle(key) {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  return (
    <>
      {/* ── Stat cards ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--space-4)', marginBottom: 'var(--space-5)' }}>
        <StatCard
          label="Total excess days"
          value={`${Math.round(headline.total_excess_days).toLocaleString()}d`}
          sub="Sum of positive excess across all discharges"
        />
        <StatCard
          label="Effective beds consumed"
          value={headline.effective_beds.toFixed(1)}
          sub="every day"
          accent={COLOR_FAC}
        />
        <StatCard
          label={`Top ${top10rows.length} segments`}
          value={`${top10pct.toFixed(0)}%`}
          sub="of system excess days"
        />
      </div>

      {/* ── Framing line ── */}
      <div style={{
        background: '#EEF0FD', borderRadius: 'var(--radius-lg)',
        padding: 'var(--space-3) var(--space-4)', marginBottom: 'var(--space-5)',
        fontSize: 'var(--font-size-sm)', color: '#3730a3', lineHeight: 1.6,
      }}>
        <span style={{ fontWeight: 'var(--font-weight-semibold)' }}>Two types of opportunity.</span>{' '}
        <span style={{ color: COLOR_FAC, fontWeight: 600 }}>Facility-bound</span>{' '}
        discharges reflect service lines where patients wait longer for a skilled bed, rehab, or LTACH
        placement — operational excess that accrues before placement is secured.{' '}
        <span style={{ color: COLOR_HOME, fontWeight: 600 }}>Home-bound</span>{' '}
        discharges (self-care and home-health) reflect service lines where excess days vary across
        sub-specialties, payers, and admission-hour patterns.
      </div>

      {/* ── Pareto chart ── */}
      <div className="card" style={{ marginBottom: 'var(--space-6)' }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: 'var(--space-3) var(--space-4)',
          borderBottom: '1px solid var(--surface-border)',
        }}>
          <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-gray-800)' }}>
            Top {top10rows.length} segments by total excess days
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)', fontSize: 11, color: 'var(--color-gray-500)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <div style={{ width: 10, height: 10, borderRadius: 2, background: COLOR_FAC, flexShrink: 0 }} />
              Facility-bound
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <div style={{ width: 10, height: 10, borderRadius: 2, background: COLOR_HOME, flexShrink: 0 }} />
              Home-bound
            </div>
          </div>
        </div>
        <div style={{ padding: 'var(--space-4) var(--space-5)', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {top10rows.map((row, i) => {
            const isFac = row.disposition === 'Facility-bound'
            const color = isFac ? COLOR_FAC : COLOR_HOME
            const pct   = (Math.max(row.total_excess_days, 0) / chartMax) * 100
            const label = `${row.disposition} · ${row.service_line}`
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                <div style={{
                  width: 196, flexShrink: 0, fontSize: 12,
                  color: 'var(--color-gray-600)', textAlign: 'right',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {label}
                </div>
                <div style={{ flex: 1, height: 18, background: 'var(--color-gray-100)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 3 }} />
                </div>
                <div style={{ width: 88, flexShrink: 0, fontSize: 11, fontWeight: 700, color, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {Math.round(row.total_excess_days).toLocaleString()}d
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Two cards ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-5)', alignItems: 'start' }}>
        <SegmentCard
          title="Facility-bound"
          subtitle="Facility-bound discharges — excess days by service line"
          segments={facility_segments}
          color={COLOR_FAC}
          keyFn={seg => seg.service_line}
          labelFn={seg => seg.service_line}
          drillFn={seg => ({
            left:  { title: 'By sub-specialty', rows: seg.drill.by_subspecialty },
            right: { title: 'By payer',         rows: seg.drill.by_payer },
          })}
          expanded={expanded}
          onToggle={toggle}
        />
        <SegmentCard
          title="Home-bound"
          subtitle="Home-bound discharges — excess days by service line"
          segments={home_segments}
          color={COLOR_HOME}
          keyFn={seg => `${seg.disposition}·${seg.service_line}`}
          labelFn={seg => `${seg.disposition} · ${seg.service_line}`}
          drillFn={seg => ({
            left:  { title: 'By sub-specialty',  rows: seg.drill.by_subspecialty },
            right: { title: 'By admission hour', rows: seg.drill.by_admission_hour },
          })}
          expanded={expanded}
          onToggle={toggle}
        />
      </div>
    </>
  )
}

/* ─── Main page ─────────────────────────────────────────────────────────────── */

export default function IPLengthOfStay() {
  const [from, setFrom] = useState(defaultFrom)
  const [to,   setTo]   = useState(todayStr)
  const dFrom = useDebounced(from)
  const dTo   = useDebounced(to)

  const [activeTab,      setActiveTab]      = useState('overview')
  const [physicianMode,  setPhysicianMode]  = useState('admitting')
  const [expandedSL,     setExpandedSL]     = useState(() => new Set())
  const [slDrilldown,    setSlDrilldown]    = useState({})
  const [tenantFeatures, setTenantFeatures] = useState({})

  useEffect(() => {
    fetch('/api/tenant-config', { credentials: 'include' })
      .then(r => r.ok ? r.json() : {})
      .then(d => setTenantFeatures(d.features ?? {}))
      .catch(() => {})
  }, [])

  // Summary
  const [summary,    setSummary]    = useState(null)
  const [sumLoading, setSumLoading] = useState(true)
  const [sumError,   setSumError]   = useState('')

  // Breakdowns
  const initState = () => Object.fromEntries(PANEL_DIMS.map(d => [d, undefined]))
  const initBool  = (v) => Object.fromEntries(PANEL_DIMS.map(d => [d, v]))
  const [breakdowns, setBreakdowns] = useState(initState)
  const [bLoading,   setBLoading]   = useState(() => initBool(true))
  const [bErrors,    setBErrors]    = useState(() => initBool(''))

  useEffect(() => {
    const ctrl = new AbortController()
    const { signal } = ctrl

    setSumLoading(true)
    apiFetch(`/api/iplos/summary?from=${dFrom}&to=${dTo}`, signal)
      .then(d => { setSummary(d); setSumError('') })
      .catch(e => { if (e.name !== 'AbortError') setSumError(e.message) })
      .finally(() => setSumLoading(false))

    PANEL_DIMS.forEach(dim => {
      setBLoading(p => ({ ...p, [dim]: true }))
      apiFetch(`/api/iplos/breakdown?dim=${dim}&from=${dFrom}&to=${dTo}`, signal)
        .then(d => { setBreakdowns(p => ({ ...p, [dim]: d })); setBErrors(p => ({ ...p, [dim]: '' })) })
        .catch(e => { if (e.name !== 'AbortError') setBErrors(p => ({ ...p, [dim]: e.message })) })
        .finally(() => setBLoading(p => ({ ...p, [dim]: false })))
    })

    // Clear drilldowns on date change
    setSlDrilldown({})
    setExpandedSL(new Set())

    return () => ctrl.abort()
  }, [dFrom, dTo])

  function handleToggleSL(name) {
    setExpandedSL(prev => {
      const next = new Set(prev)
      if (next.has(name)) {
        next.delete(name)
        return next
      }
      next.add(name)
      // Fetch if not already loaded
      if (!slDrilldown[name]) {
        setSlDrilldown(p => ({ ...p, [name]: { data: null, loading: true, error: '' } }))
        const url = `/api/iplos/breakdown?dim=service_line_2&parent=${encodeURIComponent(name)}&from=${dFrom}&to=${dTo}`
        apiFetch(url)
          .then(d => setSlDrilldown(p => ({ ...p, [name]: { data: d, loading: false, error: '' } })))
          .catch(e => setSlDrilldown(p => ({ ...p, [name]: { data: null, loading: false, error: e.message } })))
      }
      return next
    })
  }

  const sl2Enabled = tenantFeatures.service_line_drill !== false

  const sharedProps = {
    summary, sumLoading, sumError,
    breakdowns, bLoading, bErrors,
    expandedSL, slDrilldown,
    onToggleSL: handleToggleSL,
    physicianMode, onPhysicianToggle: setPhysicianMode,
    sl2Enabled,
  }

  return (
    <div className="page">
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* Page header */}
      <div style={{ marginBottom: 'var(--space-5)' }}>
        <h1 style={{ fontSize: 'var(--font-size-2xl)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-gray-900)', marginBottom: 2 }}>
          Length of Stay
        </h1>
      </div>

      {/* Date filter bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
        marginBottom: 'var(--space-2)',
      }}>
        <label style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-500)', fontWeight: 'var(--font-weight-medium)' }}>
          Discharge date
        </label>
        <input
          type="date" value={from} onChange={e => setFrom(e.target.value)}
          style={{
            padding: '5px 10px', fontSize: 13,
            border: '1px solid var(--surface-border)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--surface-card)', color: 'var(--color-gray-700)',
          }}
        />
        <span style={{ fontSize: 13, color: 'var(--color-gray-400)' }}>to</span>
        <input
          type="date" value={to} onChange={e => setTo(e.target.value)}
          style={{
            padding: '5px 10px', fontSize: 13,
            border: '1px solid var(--surface-border)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--surface-card)', color: 'var(--color-gray-700)',
          }}
        />
      </div>
      <p style={{ fontSize: 11, color: 'var(--color-gray-400)', marginBottom: 'var(--space-5)' }}>
        Excludes W&amp;C, behavioral health, expired, AMA, and acute transfers.
        Excess = observed LOS minus DRG-expected (GMLOS); totals count positive excess only.
      </p>

      {/* Tab bar */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--surface-border)', marginBottom: 'var(--space-5)' }}>
        {TABS.map(tab => (
          <button
            key={tab.id} type="button"
            onClick={() => setActiveTab(tab.id)}
            style={{
              background: 'none', border: 'none',
              borderBottom: activeTab === tab.id ? '2px solid var(--color-blue)' : '2px solid transparent',
              cursor: 'pointer', padding: 'var(--space-3) var(--space-4)',
              fontSize: 'var(--font-size-sm)',
              fontWeight: activeTab === tab.id ? 'var(--font-weight-semibold)' : 'var(--font-weight-medium)',
              color: activeTab === tab.id ? 'var(--color-blue)' : 'var(--color-gray-500)',
              marginBottom: -1, transition: 'color 150ms',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'overview' && <OverviewTab     {...sharedProps} />}
      {activeTab === 'focus'    && <FocusTab />}
      {activeTab === 'trend'    && <TrendTab        from={dFrom} to={dTo} />}
    </div>
  )
}

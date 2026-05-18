import { useState, useEffect, useRef, useCallback } from 'react'
import { Zap, Moon, ChevronDown, Check, AlertCircle } from 'lucide-react'
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  LabelList,
} from 'recharts'

/* ─── Constants ──────────────────────────────────────────────────────────── */

const DEFAULT_START    = '2025-01-01'
const DEFAULT_END      = '2025-12-31'
const PRIME_TARGET     = 80
const NON_PRIME_TARGET = 15

// DATEPART(WEEKDAY): 1=Sun, 2=Mon, 3=Tue, 4=Wed, 5=Thu, 6=Fri, 7=Sat
const DOW_OPTIONS = [
  { label: 'All Days',            value: '' },
  { label: 'Weekdays (Mon–Fri)', value: '2,3,4,5,6' },
  { label: 'Monday',              value: '2' },
  { label: 'Tuesday',             value: '3' },
  { label: 'Wednesday',           value: '4' },
  { label: 'Thursday',            value: '5' },
  { label: 'Friday',              value: '6' },
]

/* ─── Helpers ────────────────────────────────────────────────────────────── */

function fmtPct(val) {
  return `${(+val).toFixed(1)}%`
}

function fmtMin(val) {
  return `${Math.round(val).toLocaleString()} min`
}

function buildQS({ startDate, endDate, locations, dow }) {
  const p = new URLSearchParams({ startDate, endDate })
  if (locations.length) p.set('locations', locations.join(','))
  if (dow) p.set('dow', dow)
  return p.toString()
}

/* ─── Skeleton ───────────────────────────────────────────────────────────── */

function Skeleton({ height = 20, width = '100%', style = {} }) {
  return (
    <div style={{
      height,
      width,
      borderRadius: 'var(--radius-sm)',
      background: 'linear-gradient(90deg, var(--color-gray-100) 25%, var(--color-gray-200) 50%, var(--color-gray-100) 75%)',
      backgroundSize: '200% 100%',
      animation: 'shimmer 1.4s infinite',
      ...style,
    }} />
  )
}

/* ─── Multi-select dropdown ──────────────────────────────────────────────── */

function MultiSelect({ items, selected, onChange, loading, placeholder = 'All' }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    function handler(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  function toggle(item) {
    onChange(selected.includes(item) ? selected.filter(s => s !== item) : [...selected, item])
  }

  const allSelected  = items.length > 0 && selected.length === items.length
  const label = selected.length === 0       ? placeholder
              : selected.length === 1       ? selected[0]
              : `${selected.length} selected`

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        disabled={loading}
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--space-2)',
          width: '100%',
          height: 38,
          padding: '0 var(--space-3)',
          border: '1px solid var(--surface-border)',
          borderRadius: 'var(--radius-md)',
          background: 'var(--color-white)',
          color: selected.length ? 'var(--color-gray-900)' : 'var(--color-gray-400)',
          fontSize: 'var(--font-size-base)',
          cursor: loading ? 'not-allowed' : 'pointer',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {loading ? 'Loading…' : label}
        </span>
        <ChevronDown
          size={14}
          style={{
            color: 'var(--color-gray-400)',
            flexShrink: 0,
            transition: 'transform var(--transition-base)',
            transform: open ? 'rotate(180deg)' : 'none',
          }}
        />
      </button>

      {open && items.length > 0 && (
        <div style={{
          position: 'absolute',
          top: 'calc(100% + 4px)',
          left: 0,
          minWidth: '100%',
          zIndex: 'var(--z-dropdown)',
          background: 'var(--color-white)',
          border: '1px solid var(--surface-border)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-lg)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}>
          <div style={{ padding: 'var(--space-2)', borderBottom: '1px solid var(--surface-border)' }}>
            <button
              type="button"
              onClick={() => onChange(allSelected ? [] : [...items])}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                width: '100%',
                padding: 'var(--space-2) var(--space-3)',
                border: 'none',
                borderRadius: 'var(--radius-md)',
                background: 'transparent',
                cursor: 'pointer',
                fontSize: 'var(--font-size-sm)',
                fontWeight: 'var(--font-weight-semibold)',
                color: 'var(--color-gray-600)',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-gray-100)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
            >
              {allSelected ? 'Clear All' : 'Select All'}
              {allSelected && <Check size={13} style={{ color: 'var(--color-blue)' }} />}
            </button>
          </div>
          <div style={{ overflowY: 'auto', maxHeight: 220, padding: 'var(--space-1)' }}>
            {items.map(item => {
              const checked = selected.includes(item)
              return (
                <button
                  key={item}
                  type="button"
                  onClick={() => toggle(item)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    width: '100%',
                    padding: 'var(--space-2) var(--space-3)',
                    border: 'none',
                    borderRadius: 'var(--radius-md)',
                    background: checked ? 'var(--color-blue-muted)' : 'transparent',
                    cursor: 'pointer',
                    fontSize: 'var(--font-size-sm)',
                    fontWeight: checked ? 'var(--font-weight-medium)' : 'var(--font-weight-regular)',
                    color: checked ? 'var(--color-blue)' : 'var(--color-gray-700)',
                    textAlign: 'left',
                    gap: 'var(--space-2)',
                  }}
                  onMouseEnter={e => { if (!checked) e.currentTarget.style.background = 'var(--color-gray-100)' }}
                  onMouseLeave={e => { if (!checked) e.currentTarget.style.background = checked ? 'var(--color-blue-muted)' : 'transparent' }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item}</span>
                  {checked && <Check size={13} style={{ flexShrink: 0 }} />}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

/* ─── Tooltips ───────────────────────────────────────────────────────────── */

const TOOLTIP_STYLE = {
  background:   'var(--color-white)',
  border:       '1px solid var(--surface-border)',
  borderRadius: 'var(--radius-md)',
  padding:      'var(--space-3) var(--space-4)',
  boxShadow:    'var(--shadow-lg)',
  minWidth:     180,
}

const TOOLTIP_TITLE = {
  fontSize:     'var(--font-size-sm)',
  fontWeight:   'var(--font-weight-semibold)',
  color:        'var(--color-gray-900)',
  marginBottom: 'var(--space-2)',
}

const TOOLTIP_ROW = {
  display:        'flex',
  justifyContent: 'space-between',
  gap:            'var(--space-4)',
  fontSize:       'var(--font-size-xs)',
  color:          'var(--color-gray-600)',
  marginBottom:   2,
}

function PrimeTooltip({ active, payload }) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  const atTarget = d.PrimeTimeUtil >= PRIME_TARGET
  return (
    <div style={TOOLTIP_STYLE}>
      <p style={TOOLTIP_TITLE}>{d.LocationGroup}</p>
      <div style={{ ...TOOLTIP_ROW, color: atTarget ? 'var(--color-success)' : 'var(--color-warning)', fontWeight: 'var(--font-weight-semibold)' }}>
        <span>Prime Time Util</span>
        <span>{fmtPct(d.PrimeTimeUtil)}</span>
      </div>
      <div style={TOOLTIP_ROW}>
        <span>Prime Time Used</span>
        <span>{fmtMin(d.SumPrimeTime)}</span>
      </div>
      <div style={TOOLTIP_ROW}>
        <span>Block Time</span>
        <span>{fmtMin(d.SumBlockTime)}</span>
      </div>
      <div style={{ ...TOOLTIP_ROW, marginBottom: 0, color: 'var(--color-gray-400)' }}>
        <span>Target</span>
        <span>{PRIME_TARGET}%</span>
      </div>
    </div>
  )
}

function NonPrimeTooltip({ active, payload }) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  return (
    <div style={TOOLTIP_STYLE}>
      <p style={TOOLTIP_TITLE}>{d.LocationGroup}</p>
      <div style={{ ...TOOLTIP_ROW, color: 'var(--color-blue)', fontWeight: 'var(--font-weight-semibold)' }}>
        <span>Non-Prime Util</span>
        <span>{fmtPct(d.NonPrimeTimeUtil)}</span>
      </div>
      <div style={TOOLTIP_ROW}>
        <span>Non-Prime Time</span>
        <span>{fmtMin(d.SumNonPrimeTime)}</span>
      </div>
      <div style={{ ...TOOLTIP_ROW, marginBottom: 0 }}>
        <span>Total Time</span>
        <span>{fmtMin(d.SumTotalTime)}</span>
      </div>
      <div style={{ ...TOOLTIP_ROW, marginBottom: 0, color: 'var(--color-gray-400)' }}>
        <span>Target</span>
        <span>{NON_PRIME_TARGET}%</span>
      </div>
    </div>
  )
}

/* ─── Reference line label ───────────────────────────────────────────────── */

function RefLabel({ viewBox, label, color }) {
  const { x, y } = viewBox
  return (
    <text
      x={x + 4}
      y={y - 6}
      fill={color}
      fontSize={10}
      fontFamily="var(--font-family)"
      fontWeight={600}
    >
      {label}
    </text>
  )
}

/* ─── Horizontal bar chart ───────────────────────────────────────────────── */

function HorizontalBars({ data, dataKey, colorFn, target, TooltipComponent, loading, emptyMessage }) {
  const chartHeight = Math.max(240, data.length * 48 + 20)

  // Sort descending by value so highest performers sit at top
  const sorted = [...data].sort((a, b) => b[dataKey] - a[dataKey])

  if (loading) {
    return (
      <div style={{ padding: 'var(--space-2)', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        {[...Array(5)].map((_, i) => (
          <div key={i} style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
            <Skeleton height={14} width={120} />
            <Skeleton height={28} style={{ flex: 1 }} />
          </div>
        ))}
      </div>
    )
  }

  if (!data.length) {
    return (
      <div style={{
        minHeight: 200,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--color-gray-400)',
        gap: 'var(--space-3)',
      }}>
        <BarChartIcon size={36} strokeWidth={1.25} />
        <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-gray-500)', fontWeight: 'var(--font-weight-medium)' }}>
          {emptyMessage}
        </p>
      </div>
    )
  }

  return (
    <ResponsiveContainer width="100%" height={chartHeight}>
      <BarChart
        layout="vertical"
        data={sorted}
        margin={{ top: 16, right: 60, bottom: 4, left: 8 }}
        barCategoryGap="28%"
      >
        <CartesianGrid strokeDasharray="4 4" stroke="var(--color-gray-200)" horizontal={false} />
        <XAxis
          type="number"
          domain={[0, 100]}
          tickFormatter={v => `${v}%`}
          tick={{ fontSize: 11, fill: 'var(--color-gray-500)', fontFamily: 'var(--font-family)' }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          type="category"
          dataKey="LocationGroup"
          width={148}
          tick={{ fontSize: 12, fill: 'var(--color-gray-600)', fontFamily: 'var(--font-family)' }}
          axisLine={false}
          tickLine={false}
        />
        <Tooltip content={<TooltipComponent />} cursor={{ fill: 'var(--color-gray-100)' }} />
        <ReferenceLine
          x={target}
          stroke={target === PRIME_TARGET ? '#ef4444' : '#94a3b8'}
          strokeDasharray="5 4"
          strokeWidth={1.5}
          label={
            <RefLabel
              label={`${target}% target`}
              color={target === PRIME_TARGET ? '#ef4444' : '#94a3b8'}
            />
          }
        />
        <Bar dataKey={dataKey} radius={[0, 4, 4, 0]} maxBarSize={32}>
          {sorted.map((entry, i) => (
            <Cell key={i} fill={colorFn(entry[dataKey])} />
          ))}
          <LabelList
            dataKey={dataKey}
            position="right"
            formatter={v => fmtPct(v)}
            style={{
              fontSize: 11,
              fontWeight: 600,
              fontFamily: 'var(--font-family)',
              fill: 'var(--color-gray-600)',
            }}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

// Fallback icon for empty state (avoids importing BarChart3 name collision)
function BarChartIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" {...props} width={props.size} height={props.size}>
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
    </svg>
  )
}

/* ─── KPI card ───────────────────────────────────────────────────────────── */

function KpiCard({ label, value, target, targetLabel, icon: Icon, iconClass, loading, atTargetGood = true }) {
  const numeric  = parseFloat(value)
  const atTarget = atTargetGood ? numeric >= target : numeric <= target
  const delta    = (numeric - target).toFixed(1)
  const absDelta = Math.abs(delta)

  return (
    <div className="stat-card">
      <div className="stat-card-header">
        <span className="stat-label">{label}</span>
        <div className={`stat-icon ${iconClass}`}>
          <Icon size={16} />
        </div>
      </div>

      {loading
        ? <Skeleton height={40} width={110} />
        : (
          <div style={{ fontSize: 'var(--font-size-4xl)', fontWeight: 'var(--font-weight-bold)', color: 'var(--color-gray-900)', letterSpacing: 'var(--letter-spacing-tight)', lineHeight: 1 }}>
            {isNaN(numeric) ? '—' : fmtPct(numeric)}
          </div>
        )
      }

      {loading ? (
        <Skeleton height={16} width={140} />
      ) : isNaN(numeric) ? null : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <span
            className={`badge ${atTarget ? 'badge-green' : 'badge-yellow'}`}
            style={{ fontSize: 'var(--font-size-xs)' }}
          >
            {atTarget ? '▲' : '▼'} {absDelta}% {atTarget ? 'above' : 'below'} target
          </span>
          <span className="text-xs text-faint">{targetLabel}</span>
        </div>
      )}
    </div>
  )
}

/* ─── Page ───────────────────────────────────────────────────────────────── */

export default function Capacity() {
  const [startDate,        setStartDate]        = useState(DEFAULT_START)
  const [endDate,          setEndDate]          = useState(DEFAULT_END)
  const [locationGroups,   setLocationGroups]   = useState([])
  const [selectedLocs,     setSelectedLocs]     = useState([])
  const [dow,              setDow]              = useState('')
  const [locsLoading,      setLocsLoading]      = useState(true)
  const [primeData,        setPrimeData]        = useState([])
  const [nonPrimeData,     setNonPrimeData]     = useState([])
  const [loading,          setLoading]          = useState(true)
  const [error,            setError]            = useState(null)

  /* ── Weighted KPI averages ── */
  const totalPrimeTime  = primeData.reduce((s, r)    => s + (r.SumPrimeTime   ?? 0), 0)
  const totalBlockTime  = primeData.reduce((s, r)    => s + (r.SumBlockTime   ?? 0), 0)
  const totalNonPrime   = nonPrimeData.reduce((s, r) => s + (r.SumNonPrimeTime ?? 0), 0)
  const totalAllTime    = nonPrimeData.reduce((s, r) => s + (r.SumTotalTime   ?? 0), 0)
  const avgPrime        = totalBlockTime  > 0 ? (totalPrimeTime / totalBlockTime)  * 100 : NaN
  const avgNonPrime     = totalAllTime    > 0 ? (totalNonPrime  / totalAllTime)    * 100 : NaN

  /* ── Fetch location groups on mount ── */
  useEffect(() => {
    fetch('/api/capacity/location-groups')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(data => setLocationGroups(Array.isArray(data) ? data : []))
      .catch(() => {})
      .finally(() => setLocsLoading(false))
  }, [])

  /* ── Fetch chart data ── */
  const fetchData = useCallback(async (filters) => {
    setLoading(true)
    setError(null)
    const qs = buildQS(filters)
    try {
      const [primeRes, nonPrimeRes] = await Promise.all([
        fetch(`/api/capacity/prime-time?${qs}`),
        fetch(`/api/capacity/non-prime-time?${qs}`),
      ])
      if (!primeRes.ok)    throw new Error(`Prime-time request failed (${primeRes.status})`)
      if (!nonPrimeRes.ok) throw new Error(`Non-prime-time request failed (${nonPrimeRes.status})`)
      const [prime, nonPrime] = await Promise.all([primeRes.json(), nonPrimeRes.json()])
      setPrimeData(Array.isArray(prime)    ? prime    : [])
      setNonPrimeData(Array.isArray(nonPrime) ? nonPrime : [])
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData({ startDate: DEFAULT_START, endDate: DEFAULT_END, locations: [], dow: '' })
  }, [fetchData])

  function handleApply() {
    fetchData({ startDate, endDate, locations: selectedLocs, dow })
  }

  /* ─────────────────────────────────────────────────────────────── */

  return (
    <div className="page">
      <style>{`
        @keyframes shimmer {
          0%   { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>

      <div className="page-header">
        <h1 className="page-title">Capacity</h1>
        <p className="page-subtitle">Prime time and non-prime time OR utilization by location group</p>
      </div>

      {/* ── Filter Bar ───────────────────────────────────────────── */}
      <div className="card card-padded mb-6" style={{ overflow: 'visible' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--space-4)', flexWrap: 'wrap' }}>

          <div className="form-group" style={{ flex: '1 1 150px', minWidth: 140 }}>
            <label className="form-label">Start Date</label>
            <input
              type="date"
              className="form-input"
              value={startDate}
              onChange={e => setStartDate(e.target.value)}
            />
          </div>

          <div className="form-group" style={{ flex: '1 1 150px', minWidth: 140 }}>
            <label className="form-label">End Date</label>
            <input
              type="date"
              className="form-input"
              value={endDate}
              onChange={e => setEndDate(e.target.value)}
            />
          </div>

          <div className="form-group" style={{ flex: '2 1 210px', minWidth: 190 }}>
            <label className="form-label">Location Groups</label>
            <MultiSelect
              items={locationGroups}
              selected={selectedLocs}
              onChange={setSelectedLocs}
              loading={locsLoading}
              placeholder="All Locations"
            />
          </div>

          <div className="form-group" style={{ flex: '1 1 170px', minWidth: 160 }}>
            <label className="form-label">Day of Week</label>
            <select
              className="form-input"
              value={dow}
              onChange={e => setDow(e.target.value)}
              style={{ cursor: 'pointer', appearance: 'auto' }}
            >
              {DOW_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

          <button
            type="button"
            className="btn btn-primary"
            onClick={handleApply}
            disabled={loading}
            style={{ flexShrink: 0, height: 38 }}
          >
            {loading ? 'Loading…' : 'Apply Filters'}
          </button>
        </div>
      </div>

      {/* ── Error Banner ─────────────────────────────────────────── */}
      {error && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
          padding: 'var(--space-4)',
          background: 'var(--color-danger-light)',
          border: '1px solid #fecaca',
          borderRadius: 'var(--radius-lg)',
          marginBottom: 'var(--space-6)',
          color: 'var(--color-danger)',
          fontSize: 'var(--font-size-sm)',
          fontWeight: 'var(--font-weight-medium)',
        }}>
          <AlertCircle size={16} style={{ flexShrink: 0 }} />
          {error}
        </div>
      )}

      {/* ── KPI Cards ────────────────────────────────────────────── */}
      <div className="grid-2 mb-6">
        <KpiCard
          label="Avg Prime Time Utilization"
          value={avgPrime}
          target={PRIME_TARGET}
          targetLabel={`${PRIME_TARGET}% target`}
          icon={Zap}
          iconClass="stat-icon-green"
          loading={loading}
          atTargetGood={true}
        />
        <KpiCard
          label="Avg Non-Prime Time Utilization"
          value={avgNonPrime}
          target={NON_PRIME_TARGET}
          targetLabel={`${NON_PRIME_TARGET}% target`}
          icon={Moon}
          iconClass="stat-icon-blue"
          loading={loading}
          atTargetGood={false}
        />
      </div>

      {/* ── Charts ───────────────────────────────────────────────── */}
      <div className="grid-2">

        {/* Prime Time */}
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">Prime Time Utilization</div>
              <div className="card-subtitle">% of block time used during prime hours — target {PRIME_TARGET}%</div>
            </div>
            {!loading && primeData.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 'var(--space-1)' }}>
                <span className="badge badge-green badge-dot">
                  {primeData.filter(d => d.PrimeTimeUtil >= PRIME_TARGET).length} at target
                </span>
                <span className="badge badge-yellow badge-dot">
                  {primeData.filter(d => d.PrimeTimeUtil < PRIME_TARGET).length} below
                </span>
              </div>
            )}
          </div>
          <div className="card-body" style={{ paddingTop: 'var(--space-4)' }}>
            <HorizontalBars
              data={primeData}
              dataKey="PrimeTimeUtil"
              colorFn={v => v >= PRIME_TARGET ? '#22c55e' : '#f59e0b'}
              target={PRIME_TARGET}
              TooltipComponent={PrimeTooltip}
              loading={loading}
              emptyMessage="No prime-time data for the selected filters"
            />
          </div>
        </div>

        {/* Non-Prime Time */}
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">Non-Prime Time Utilization</div>
              <div className="card-subtitle">% of total time used outside prime hours — target {NON_PRIME_TARGET}%</div>
            </div>
            {!loading && nonPrimeData.length > 0 && (
              <span className="badge badge-blue">
                {nonPrimeData.length} location{nonPrimeData.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          <div className="card-body" style={{ paddingTop: 'var(--space-4)' }}>
            <HorizontalBars
              data={nonPrimeData}
              dataKey="NonPrimeTimeUtil"
              colorFn={() => '#3E53E3'}
              target={NON_PRIME_TARGET}
              TooltipComponent={NonPrimeTooltip}
              loading={loading}
              emptyMessage="No non-prime-time data for the selected filters"
            />
          </div>
        </div>

      </div>
    </div>
  )
}

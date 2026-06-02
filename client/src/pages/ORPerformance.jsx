import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Activity,
  Clock,
  Timer,
  ChevronDown,
  Check,
  AlertCircle,
  TrendingUp,
} from 'lucide-react'
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts'

/* ─── Constants ──────────────────────────────────────────────────────────── */

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const DEFAULT_START = '2025-01-01'
const DEFAULT_END   = '2025-12-31'

/* ─── Formatters ─────────────────────────────────────────────────────────── */

function fmtHours(mins) {
  const h = mins / 60
  return (h >= 10000 ? Math.round(h) : +h.toFixed(1)).toLocaleString() + ' hrs'
}

function fmtMins(mins) {
  return Math.round(mins).toLocaleString() + ' min'
}

function buildQS({ startDate, endDate, sites }) {
  const p = new URLSearchParams({ startDate, endDate })
  if (sites.length) p.set('sites', sites.join(','))
  return p.toString()
}

/* ─── Sites multi-select dropdown ────────────────────────────────────────── */

function SitesDropdown({ sites, selected, onChange, loading }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    function onOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [])

  function toggle(site) {
    onChange(selected.includes(site) ? selected.filter(s => s !== site) : [...selected, site])
  }

  function toggleAll() {
    onChange(selected.length === sites.length ? [] : [...sites])
  }

  const allSelected  = sites.length > 0 && selected.length === sites.length
  const noneSelected = selected.length === 0
  const label = noneSelected       ? 'All Sites'
              : selected.length === 1 ? selected[0]
              : `${selected.length} sites selected`

  return (
    <div ref={ref} style={{ position: 'relative', minWidth: 200 }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        disabled={loading}
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
          color: noneSelected ? 'var(--color-gray-400)' : 'var(--color-gray-900)',
          fontSize: 'var(--font-size-base)',
          cursor: loading ? 'not-allowed' : 'pointer',
          transition: 'border-color var(--transition-base)',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {loading ? 'Loading sites…' : label}
        </span>
        <ChevronDown
          size={14}
          style={{
            color: 'var(--color-gray-400)',
            flexShrink: 0,
            transition: 'transform var(--transition-base)',
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
          }}
        />
      </button>

      {open && sites.length > 0 && (
        <div
          style={{
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
          }}
        >
          {/* Select all row */}
          <div style={{ padding: 'var(--space-2)', borderBottom: '1px solid var(--surface-border)' }}>
            <button
              type="button"
              onClick={toggleAll}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                width: '100%',
                padding: 'var(--space-2) var(--space-3)',
                borderRadius: 'var(--radius-md)',
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                fontSize: 'var(--font-size-sm)',
                fontWeight: 'var(--font-weight-semibold)',
                color: 'var(--color-gray-600)',
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--color-gray-100)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              {allSelected ? 'Clear All' : 'Select All'}
              {allSelected && <Check size={13} style={{ color: 'var(--color-blue)' }} />}
            </button>
          </div>

          {/* Site list */}
          <div style={{ overflowY: 'auto', maxHeight: 220, padding: 'var(--space-1)' }}>
            {sites.map(site => {
              const checked = selected.includes(site)
              return (
                <button
                  key={site}
                  type="button"
                  onClick={() => toggle(site)}
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
                    transition: 'background var(--transition-fast)',
                  }}
                  onMouseEnter={e => { if (!checked) e.currentTarget.style.background = 'var(--color-gray-100)' }}
                  onMouseLeave={e => { if (!checked) e.currentTarget.style.background = 'transparent' }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{site}</span>
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

/* ─── Chart tooltip ──────────────────────────────────────────────────────── */

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div style={{
      background: 'var(--color-white)',
      border: '1px solid var(--surface-border)',
      borderRadius: 'var(--radius-md)',
      padding: 'var(--space-3) var(--space-4)',
      boxShadow: 'var(--shadow-lg)',
    }}>
      <p style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-gray-900)', marginBottom: 4 }}>
        {label}
      </p>
      <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-blue)', fontWeight: 'var(--font-weight-medium)' }}>
        {payload[0].value.toLocaleString()} cases
      </p>
    </div>
  )
}

/* ─── Loading skeleton ───────────────────────────────────────────────────── */

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

/* ─── Main page ──────────────────────────────────────────────────────────── */

export default function ORPerformance() {
  const [startDate,      setStartDate]      = useState(DEFAULT_START)
  const [endDate,        setEndDate]        = useState(DEFAULT_END)
  const [availableSites, setAvailableSites] = useState([])
  const [selectedSites,  setSelectedSites]  = useState([])
  const [sitesLoading,   setSitesLoading]   = useState(true)
  const [summary,        setSummary]        = useState([])
  const [trend,          setTrend]          = useState([])
  const [loading,        setLoading]        = useState(true)
  const [error,          setError]          = useState(null)
  const [chartSite,      setChartSite]      = useState(null)   // site clicked in table
  const [chartTrend,     setChartTrend]     = useState([])     // trend for clicked site
  const [chartLoading,   setChartLoading]   = useState(false)
  const [activeDates,    setActiveDates]    = useState({ startDate: DEFAULT_START, endDate: DEFAULT_END })

  /* ── Derived KPIs ── */
  const totalCases   = summary.reduce((s, r) => s + (r.TotalCases       ?? 0), 0)
  const totalMinutes = summary.reduce((s, r) => s + (r.TotalORDuration   ?? 0), 0)
  const avgMinutes   = totalCases > 0 ? totalMinutes / totalCases : 0

  /* ── Chart data — use site-specific trend when a row is clicked ── */
  const activeTrend = chartSite ? chartTrend : trend
  const multiYear   = new Set(activeTrend.map(r => r.Year)).size > 1
  const chartData   = activeTrend.map(r => ({
    label: MONTHS[r.Month - 1] + (multiYear ? ` '${String(r.Year).slice(2)}` : ''),
    cases: r.TotalCases,
  }))

  /* ── Click a site row → fetch its trend ── */
  async function handleSiteClick(site) {
    if (chartSite === site) {
      setChartSite(null)
      setChartTrend([])
      return
    }
    setChartSite(site)
    setChartLoading(true)
    try {
      const qs = buildQS({ startDate: activeDates.startDate, endDate: activeDates.endDate, sites: [site] })
      const res = await fetch(`/api/monthly-trend?${qs}`)
      const data = await res.json()
      setChartTrend(Array.isArray(data) ? data : [])
    } catch (_) {
      setChartTrend([])
    } finally {
      setChartLoading(false)
    }
  }

  /* ── Fetch sites (once on mount) ── */
  useEffect(() => {
    fetch('/api/sites')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(data => setAvailableSites(Array.isArray(data) ? data : []))
      .catch(() => {})
      .finally(() => setSitesLoading(false))
  }, [])

  /* ── Fetch summary + trend ── */
  const fetchData = useCallback(async (filters) => {
    setLoading(true)
    setError(null)
    setChartSite(null)
    setChartTrend([])
    setActiveDates({ startDate: filters.startDate, endDate: filters.endDate })
    const qs = buildQS(filters)
    try {
      const [sumRes, trendRes] = await Promise.all([
        fetch(`/api/summary?${qs}`),
        fetch(`/api/monthly-trend?${qs}`),
      ])
      if (!sumRes.ok)   throw new Error(`Summary failed: ${sumRes.status}`)
      if (!trendRes.ok) throw new Error(`Trend failed: ${trendRes.status}`)
      const [sumData, trendData] = await Promise.all([sumRes.json(), trendRes.json()])
      setSummary(Array.isArray(sumData)   ? sumData   : [])
      setTrend(Array.isArray(trendData)   ? trendData : [])
    } catch (e) {
      setError(e.message || 'Failed to load data. Check your connection and try again.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData({ startDate: DEFAULT_START, endDate: DEFAULT_END, sites: [] })
  }, [fetchData])

  function handleApply() {
    fetchData({ startDate, endDate, sites: selectedSites })
  }

  /* ─────────────────────────────────────────────────────────────── */

  return (
    <div className="page">
      {/* Shimmer keyframe */}
      <style>{`
        @keyframes shimmer {
          0%   { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>

      <div className="page-header">
        <h1 className="page-title">OR Performance</h1>
        <p className="page-subtitle">Operating room case volume and duration analytics</p>
      </div>

      {/* ── Filter Bar ───────────────────────────────────────────── */}
      <div className="card card-padded mb-6" style={{ overflow: 'visible' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
          <div className="form-group" style={{ flex: '1 1 160px', minWidth: 140 }}>
            <label className="form-label">Start Date</label>
            <input
              type="date"
              className="form-input"
              value={startDate}
              onChange={e => setStartDate(e.target.value)}
            />
          </div>

          <div className="form-group" style={{ flex: '1 1 160px', minWidth: 140 }}>
            <label className="form-label">End Date</label>
            <input
              type="date"
              className="form-input"
              value={endDate}
              onChange={e => setEndDate(e.target.value)}
            />
          </div>

          <div className="form-group" style={{ flex: '2 1 220px', minWidth: 200 }}>
            <label className="form-label">Sites</label>
            <SitesDropdown
              sites={availableSites}
              selected={selectedSites}
              onChange={setSelectedSites}
              loading={sitesLoading}
            />
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
      <div className="stat-grid">
        {/* Total Cases */}
        <div className="stat-card">
          <div className="stat-card-header">
            <span className="stat-label">Total Cases</span>
            <div className="stat-icon stat-icon-blue">
              <Activity size={16} />
            </div>
          </div>
          {loading
            ? <Skeleton height={36} width={100} />
            : <div className="stat-value">{totalCases.toLocaleString()}</div>
          }
          <div className="stat-change">
            <span className="stat-change-note">
              {loading ? '' : `Across ${summary.length} site${summary.length !== 1 ? 's' : ''}`}
            </span>
          </div>
        </div>

        {/* Total OR Duration */}
        <div className="stat-card">
          <div className="stat-card-header">
            <span className="stat-label">Total OR Duration</span>
            <div className="stat-icon stat-icon-cyan">
              <Clock size={16} />
            </div>
          </div>
          {loading
            ? <Skeleton height={36} width={120} />
            : <div className="stat-value">{fmtHours(totalMinutes)}</div>
          }
          <div className="stat-change">
            <span className="stat-change-note">
              {loading ? '' : `${Math.round(totalMinutes).toLocaleString()} total minutes`}
            </span>
          </div>
        </div>

        {/* Avg OR Duration */}
        <div className="stat-card">
          <div className="stat-card-header">
            <span className="stat-label">Avg OR Duration</span>
            <div className="stat-icon stat-icon-green">
              <Timer size={16} />
            </div>
          </div>
          {loading
            ? <Skeleton height={36} width={90} />
            : <div className="stat-value">{fmtMins(avgMinutes)}</div>
          }
          <div className="stat-change">
            <span className="stat-change-note">
              {loading ? '' : 'Per case average'}
            </span>
          </div>
        </div>
      </div>

      {/* ── Cases Summary Table ───────────────────────────────────── */}
      <div className="card mb-6">
        <div className="card-header">
          <div>
            <div className="card-title">Cases Summary by Site</div>
            <div className="card-subtitle">Total cases, OR duration, and averages per location</div>
          </div>
        </div>

        <div className="table-wrap">
          {loading ? (
            <div style={{ padding: 'var(--space-8)', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
              {[...Array(5)].map((_, i) => <Skeleton key={i} height={20} />)}
            </div>
          ) : summary.length === 0 ? (
            <div style={{
              padding: 'var(--space-12)',
              textAlign: 'center',
              color: 'var(--color-gray-400)',
            }}>
              <Activity size={32} strokeWidth={1.25} style={{ margin: '0 auto var(--space-3)' }} />
              <p style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-medium)', color: 'var(--color-gray-500)' }}>
                No data found
              </p>
              <p style={{ fontSize: 'var(--font-size-xs)', marginTop: 'var(--space-1)' }}>
                Try adjusting the date range or site filters
              </p>
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Site</th>
                  <th style={{ textAlign: 'right' }}>Total Cases</th>
                  <th style={{ textAlign: 'right' }}>Total OR Duration</th>
                  <th style={{ textAlign: 'right' }}>Avg OR Duration</th>
                </tr>
              </thead>
              <tbody>
                {summary.map(row => {
                  const avg       = row.TotalCases > 0 ? row.TotalORDuration / row.TotalCases : 0
                  const isActive  = chartSite === row.Site
                  return (
                    <tr
                      key={row.Site}
                      onClick={() => handleSiteClick(row.Site)}
                      style={{
                        cursor: 'pointer',
                        background: isActive ? 'var(--color-blue-light, #eff6ff)' : undefined,
                        outline: isActive ? '2px solid var(--color-blue)' : undefined,
                        outlineOffset: -2,
                      }}
                    >
                      <td className="table-cell-primary" style={{ color: isActive ? 'var(--color-blue)' : undefined, fontWeight: isActive ? 700 : undefined }}>
                        {row.Site}
                      </td>
                      <td style={{ textAlign: 'right' }}>{(row.TotalCases ?? 0).toLocaleString()}</td>
                      <td style={{ textAlign: 'right' }}>{fmtHours(row.TotalORDuration ?? 0)}</td>
                      <td style={{ textAlign: 'right' }}>{fmtMins(avg)}</td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr style={{
                  borderTop: '2px solid var(--surface-border)',
                  background: 'var(--color-gray-50)',
                }}>
                  <td style={{
                    padding: 'var(--space-4)',
                    fontWeight: 'var(--font-weight-semibold)',
                    color: 'var(--color-gray-900)',
                    fontSize: 'var(--font-size-sm)',
                  }}>
                    Grand Total
                  </td>
                  <td style={{
                    textAlign: 'right',
                    padding: 'var(--space-4)',
                    fontWeight: 'var(--font-weight-semibold)',
                    color: 'var(--color-gray-900)',
                    fontSize: 'var(--font-size-sm)',
                  }}>
                    {totalCases.toLocaleString()}
                  </td>
                  <td style={{
                    textAlign: 'right',
                    padding: 'var(--space-4)',
                    fontWeight: 'var(--font-weight-semibold)',
                    color: 'var(--color-gray-900)',
                    fontSize: 'var(--font-size-sm)',
                  }}>
                    {fmtHours(totalMinutes)}
                  </td>
                  <td style={{
                    textAlign: 'right',
                    padding: 'var(--space-4)',
                    fontWeight: 'var(--font-weight-semibold)',
                    color: 'var(--color-gray-900)',
                    fontSize: 'var(--font-size-sm)',
                  }}>
                    {fmtMins(avgMinutes)}
                  </td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      </div>

      {/* ── Monthly Case Volume Chart ─────────────────────────────── */}
      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title">
              Monthly Case Volume{chartSite ? ` — ${chartSite}` : ''}
            </div>
            <div className="card-subtitle">
              {chartSite ? `Click the row again to deselect` : 'Click a site row to filter the chart'}
            </div>
          </div>
          {!loading && chartData.length > 0 && (
            <div className="badge badge-blue">
              <TrendingUp size={11} />
              {chartData.length} months
            </div>
          )}
        </div>

        <div className="card-body">
          {loading || chartLoading ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
              <Skeleton height={200} />
            </div>
          ) : chartData.length === 0 ? (
            <div style={{
              height: 220,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--color-gray-400)',
            }}>
              <TrendingUp size={36} strokeWidth={1.25} style={{ marginBottom: 'var(--space-3)' }} />
              <p style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-medium)', color: 'var(--color-gray-500)' }}>
                No trend data available
              </p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <LineChart
                data={chartData}
                margin={{ top: 8, right: 16, bottom: 0, left: 0 }}
              >
                <CartesianGrid
                  strokeDasharray="4 4"
                  stroke="var(--color-gray-200)"
                  vertical={false}
                />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 12, fill: 'var(--color-gray-500)', fontFamily: 'var(--font-family)' }}
                  axisLine={false}
                  tickLine={false}
                  dy={8}
                />
                <YAxis
                  tick={{ fontSize: 12, fill: 'var(--color-gray-500)', fontFamily: 'var(--font-family)' }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={v => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v}
                  width={48}
                />
                <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'var(--color-gray-200)', strokeWidth: 1 }} />
                <Line
                  type="monotone"
                  dataKey="cases"
                  stroke="var(--color-blue)"
                  strokeWidth={2.5}
                  dot={{ r: 4, fill: 'var(--color-blue)', strokeWidth: 0 }}
                  activeDot={{ r: 6, fill: 'var(--color-blue)', stroke: 'var(--color-white)', strokeWidth: 2 }}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  )
}

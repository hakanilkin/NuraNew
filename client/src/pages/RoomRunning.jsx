import { useState, useEffect, useCallback } from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import { Activity } from 'lucide-react'

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function fmt(n) {
  return n == null ? '—' : Number(n).toFixed(2)
}

function buildQS({ startDate, endDate, orGroups }) {
  const p = new URLSearchParams({ startDate, endDate })
  if (orGroups.length) p.set('orGroups', orGroups.join(','))
  return p.toString()
}

function subtractMonths(dateStr, months) {
  const d = new Date(dateStr)
  d.setMonth(d.getMonth() - months)
  return d.toISOString().slice(0, 10)
}

/* ── Multi-select dropdown (same pattern as other pages) ─────────────────── */

function MultiSelect({ label, items, selected, onChange, loading }) {
  const [open, setOpen] = useState(false)

  function toggle(item) {
    onChange(selected.includes(item) ? selected.filter(s => s !== item) : [...selected, item])
  }

  function toggleAll() {
    onChange(selected.length === items.length ? [] : [...items])
  }

  const allSelected  = items.length > 0 && selected.length === items.length
  const noneSelected = selected.length === 0
  const displayLabel = loading       ? 'Loading…'
                     : noneSelected  ? `All ${label}`
                     : allSelected   ? `All ${label}`
                     : `${selected.length} selected`

  return (
    <div style={{ position: 'relative' }} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false) }} tabIndex={-1}>
      <button
        type="button"
        className="form-input"
        onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, cursor: 'pointer', minWidth: 180, textAlign: 'left', background: '#fff' }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 'var(--font-size-sm)' }}>{displayLabel}</span>
        <span style={{ fontSize: 10, opacity: 0.5, flexShrink: 0 }}>▼</span>
      </button>
      {open && items.length > 0 && (
        <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 50, background: '#fff', border: '1px solid var(--surface-border)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-md)', minWidth: 200, maxHeight: 260, overflowY: 'auto', padding: '6px 0' }}>
          <div onClick={toggleAll} style={{ padding: '7px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-sm)', fontWeight: 600, borderBottom: '1px solid var(--color-gray-100)' }}>
            <input type="checkbox" readOnly checked={allSelected} style={{ accentColor: 'var(--color-blue)' }} />
            All
          </div>
          {items.map(item => (
            <div key={item} onClick={() => toggle(item)} style={{ padding: '7px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-sm)' }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--color-gray-50)'}
              onMouseLeave={e => e.currentTarget.style.background = ''}
            >
              <input type="checkbox" readOnly checked={selected.includes(item)} style={{ accentColor: 'var(--color-blue)' }} />
              {item}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* ── Custom tooltip ───────────────────────────────────────────────────────── */

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: '#fff', border: '1px solid var(--surface-border)', borderRadius: 'var(--radius-md)', padding: '10px 14px', boxShadow: 'var(--shadow-sm)', fontSize: 'var(--font-size-sm)' }}>
      <p style={{ fontWeight: 700, marginBottom: 6, color: 'var(--color-gray-900)' }}>{label}</p>
      {payload.map(p => (
        <p key={p.name} style={{ color: p.color, margin: '2px 0' }}>
          {p.name}: <strong>{fmt(p.value)}</strong>
        </p>
      ))}
    </div>
  )
}

/* ── Main page ────────────────────────────────────────────────────────────── */

export default function RoomRunning() {
  const [orGroups,    setOrGroups]    = useState([])
  const [selGroups,   setSelGroups]   = useState([])
  const [metaLoading, setMetaLoading] = useState(true)

  const [startDate, setStartDate] = useState('')
  const [endDate,   setEndDate]   = useState('')

  const [chartData, setChartData] = useState([])
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState(null)

  // ── Load meta (max date + OR groups) on mount ──────────────────────
  useEffect(() => {
    fetch('/api/rr/meta')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(({ maxDate, orGroups: groups }) => {
        const end   = maxDate ? maxDate.slice(0, 10) : new Date().toISOString().slice(0, 10)
        const start = subtractMonths(end, 6)
        setEndDate(end)
        setStartDate(start)
        setOrGroups(groups)
        return { start, end }
      })
      .then(({ start, end }) => fetchData({ startDate: start, endDate: end, orGroups: [] }))
      .catch(() => setError('Failed to load filter options'))
      .finally(() => setMetaLoading(false))
  }, [])                // eslint-disable-line react-hooks/exhaustive-deps

  const fetchData = useCallback(async (filters) => {
    setLoading(true)
    setError(null)
    try {
      const res  = await fetch(`/api/rr/data?${buildQS(filters)}`)
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      const rows = await res.json()

      setChartData(rows.map(r => ({
        timeslot:    r.rrtimeslot,
        avgRooms:    r.AvgOccupied,
        idealRooms:  r.AvgOccupied + r.StdevOccupied,
        maxRooms:    r.AvgOccupied + 2 * r.StdevOccupied,
      })))
    } catch (e) {
      setError(e.message || 'Failed to load data')
    } finally {
      setLoading(false)
    }
  }, [])

  function handleApply() {
    fetchData({ startDate, endDate, orGroups: selGroups })
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Room Running</h1>
        <p className="page-subtitle">Average occupied rooms by time slot</p>
      </div>

      {/* ── Filter bar ── */}
      <div className="card filter-bar">
        <div className="filter-row" style={{ display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
          <div className="form-group">
            <label className="form-label">From</label>
            <input className="form-input" type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">To</label>
            <input className="form-input" type="date" value={endDate} onChange={e => setEndDate(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">OR Group</label>
            <MultiSelect
              label="Groups"
              items={orGroups}
              selected={selGroups}
              onChange={setSelGroups}
              loading={metaLoading}
            />
          </div>
          <button
            className="btn btn-primary"
            onClick={handleApply}
            disabled={loading || !startDate || !endDate}
          >
            {loading ? 'Loading…' : 'Apply'}
          </button>
        </div>
      </div>

      {/* ── Chart ── */}
      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title">Rooms Running by Time Slot</div>
            <div className="card-subtitle">
              {startDate && endDate ? `${startDate} – ${endDate}` : ''}
              {selGroups.length > 0 ? ` · ${selGroups.join(', ')}` : ''}
            </div>
          </div>
        </div>

        <div className="card-body">
          {loading && (
            <div style={{ height: 320, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-gray-400)', fontSize: 'var(--font-size-sm)' }}>
              Loading…
            </div>
          )}

          {error && !loading && (
            <div style={{ height: 320, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#b91c1c', fontSize: 'var(--font-size-sm)' }}>
              {error}
            </div>
          )}

          {!loading && !error && chartData.length === 0 && (
            <div style={{ height: 320, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--color-gray-400)' }}>
              <Activity size={36} strokeWidth={1.25} style={{ marginBottom: 12 }} />
              <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-gray-500)' }}>No data for selected filters</p>
            </div>
          )}

          {!loading && !error && chartData.length > 0 && (
            <ResponsiveContainer width="100%" height={360}>
              <LineChart data={chartData} margin={{ top: 8, right: 24, bottom: 40, left: 8 }}>
                <CartesianGrid strokeDasharray="4 4" stroke="var(--color-gray-200)" vertical={false} />
                <XAxis
                  dataKey="timeslot"
                  tick={{ fontSize: 11, fill: 'var(--color-gray-500)' }}
                  axisLine={false}
                  tickLine={false}
                  angle={-45}
                  textAnchor="end"
                  dy={8}
                  interval="preserveStartEnd"
                />
                <YAxis
                  label={{ value: 'Num of Rooms', angle: -90, position: 'insideLeft', offset: 10, style: { fontSize: 11, fill: 'var(--color-gray-500)' } }}
                  tick={{ fontSize: 11, fill: 'var(--color-gray-500)' }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip content={<ChartTooltip />} />
                <Legend
                  wrapperStyle={{ fontSize: 12, paddingTop: 16 }}
                  iconType="line"
                />
                <Line
                  type="monotone"
                  dataKey="avgRooms"
                  name="Avg Rooms Running"
                  stroke="#3E53E3"
                  strokeWidth={2.5}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
                <Line
                  type="monotone"
                  dataKey="idealRooms"
                  name="Ideal Rooms Running"
                  stroke="#10b981"
                  strokeWidth={2}
                  strokeDasharray="6 3"
                  dot={false}
                  activeDot={{ r: 4 }}
                />
                <Line
                  type="monotone"
                  dataKey="maxRooms"
                  name="Max Rooms Running"
                  stroke="#f59e0b"
                  strokeWidth={2}
                  strokeDasharray="3 3"
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  )
}

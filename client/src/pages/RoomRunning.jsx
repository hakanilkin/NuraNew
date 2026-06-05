import { useState, useEffect, useCallback } from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ReferenceLine,
} from 'recharts'
import { Activity } from 'lucide-react'

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function fmt(n) {
  return n == null ? '—' : Number(n).toFixed(2)
}

const DAYS = [
  { label: 'Sun', value: 1 },
  { label: 'Mon', value: 2 },
  { label: 'Tue', value: 3 },
  { label: 'Wed', value: 4 },
  { label: 'Thu', value: 5 },
  { label: 'Fri', value: 6 },
  { label: 'Sat', value: 7 },
]

function buildQS({ startDate, endDate, orGroup, dow }) {
  const p = new URLSearchParams({ startDate, endDate })
  if (orGroup) p.set('orGroups', orGroup)
  if (dow && dow.length) p.set('dow', dow.join(','))
  return p.toString()
}

/* ── DOW multi-select ─────────────────────────────────────────────────────── */

function DowSelect({ selected, onChange }) {
  const [open, setOpen] = useState(false)

  function toggle(val) {
    onChange(selected.includes(val) ? selected.filter(v => v !== val) : [...selected, val])
  }

  function toggleAll() {
    onChange(selected.length === DAYS.length ? [] : DAYS.map(d => d.value))
  }

  const allSelected  = selected.length === DAYS.length
  const noneSelected = selected.length === 0
  const label = noneSelected || allSelected
    ? 'All Days'
    : DAYS.filter(d => selected.includes(d.value)).map(d => d.label).join(', ')

  return (
    <div style={{ position: 'relative' }} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false) }} tabIndex={-1}>
      <button
        type="button"
        className="form-input"
        onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, cursor: 'pointer', minWidth: 160, textAlign: 'left', background: '#fff', overflow: 'hidden' }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 'var(--font-size-sm)' }}>{label}</span>
        <span style={{ fontSize: 10, opacity: 0.5, flexShrink: 0 }}>▼</span>
      </button>
      {open && (
        <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 9999, background: '#fff', border: '1px solid var(--surface-border)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-md)', minWidth: 140, padding: '6px 0' }}>
          <div onClick={toggleAll} style={{ padding: '7px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-sm)', fontWeight: 600, borderBottom: '1px solid var(--color-gray-100)' }}>
            <input type="checkbox" readOnly checked={allSelected} style={{ accentColor: 'var(--color-blue)' }} />
            All Days
          </div>
          {DAYS.map(d => (
            <div key={d.value} onClick={() => toggle(d.value)} style={{ padding: '7px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-sm)' }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--color-gray-50)'}
              onMouseLeave={e => e.currentTarget.style.background = ''}
            >
              <input type="checkbox" readOnly checked={selected.includes(d.value)} style={{ accentColor: 'var(--color-blue)' }} />
              {d.label}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function subtractMonths(dateStr, months) {
  const d = new Date(dateStr)
  d.setMonth(d.getMonth() - months)
  return d.toISOString().slice(0, 10)
}

/* ── Custom tooltip ───────────────────────────────────────────────────────── */

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: '#fff', border: '1px solid var(--surface-border)', borderRadius: 'var(--radius-md)', padding: '10px 14px', boxShadow: 'var(--shadow-sm)', fontSize: 'var(--font-size-sm)' }}>
      <p style={{ fontWeight: 700, marginBottom: 6, color: 'var(--color-gray-900)' }}>{String(label).replace(/^t/i, '')}</p>
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
  const [selGroup,    setSelGroup]    = useState('')
  const [selDow,      setSelDow]      = useState([])      // empty = all days
  const [metaLoading, setMetaLoading] = useState(true)

  const [startDate, setStartDate] = useState('')
  const [endDate,   setEndDate]   = useState('')

  const [chartData, setChartData] = useState([])
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState(null)

  // ── Load meta (max date + OR groups) on mount ──────────────────────
  useEffect(() => {
    fetch('/api/rr/meta')
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`Status ${r.status}`)))
      .then(({ maxDate, orGroups: groups }) => {
        const end   = maxDate ? maxDate.slice(0, 10) : new Date().toISOString().slice(0, 10)
        const start = subtractMonths(end, 6)
        setEndDate(end)
        setStartDate(start)
        setOrGroups(groups || [])
        return { start, end }
      })
      .then(({ start, end }) => fetchData({ startDate: start, endDate: end, orGroup: '', dow: [] }))
      .catch(err => setError(`Failed to load filters: ${err.message}`))
      .finally(() => setMetaLoading(false))
  }, [])                // eslint-disable-line react-hooks/exhaustive-deps

  const fetchData = useCallback(async (filters) => {
    setLoading(true)
    setError(null)
    const qs = buildQS(filters)
    console.log('[RoomRunning] fetch:', qs)
    try {
      const res = await fetch(`/api/rr/data?${qs}`)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `Server error ${res.status}`)
      }
      const rows = await res.json()
      console.log('[RoomRunning] rows:', rows.length, 'sample:', rows[0])
      setChartData(rows.map(r => ({
        timeslot:   r.rrtimeslot,
        avgRooms:   r.AvgOccupied,
        idealRooms: r.AvgOccupied + r.StdevOccupied,
        maxRooms:   r.AvgOccupied + 2 * r.StdevOccupied,
      })))
    } catch (e) {
      setError(e.message || 'Failed to load data')
    } finally {
      setLoading(false)
    }
  }, [])

  function handleApply() {
    fetchData({ startDate, endDate, orGroup: selGroup, dow: selDow })
  }

  function handleDowChange(newDow) {
    setSelDow(newDow)
    fetchData({ startDate, endDate, orGroup: selGroup, dow: newDow })
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Room Running</h1>
        <p className="page-subtitle">Average occupied rooms by time slot</p>
      </div>

      {/* ── Filter bar ── */}
      <div className="card" style={{ padding: '16px 24px 16px 32px', overflow: 'visible' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 24, flexWrap: 'nowrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <label className="form-label" style={{ whiteSpace: 'nowrap' }}>From</label>
            <input className="form-input" type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={{ minWidth: 150 }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <label className="form-label" style={{ whiteSpace: 'nowrap' }}>To</label>
            <input className="form-input" type="date" value={endDate} onChange={e => setEndDate(e.target.value)} style={{ minWidth: 150 }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <label className="form-label" style={{ whiteSpace: 'nowrap' }}>Day of Week</label>
            <DowSelect selected={selDow} onChange={handleDowChange} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <label className="form-label" style={{ whiteSpace: 'nowrap' }}>OR Group</label>
            <select
              className="form-input"
              value={selGroup}
              onChange={e => setSelGroup(e.target.value)}
              disabled={metaLoading}
              style={{ minWidth: 200, cursor: 'pointer' }}
            >
              <option value="">All Groups</option>
              {orGroups.map(g => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>
          </div>
          <button
            className="btn btn-primary"
            onClick={handleApply}
            disabled={loading || !startDate || !endDate}
            style={{ marginBottom: 1 }}
          >
            {loading ? 'Loading…' : 'Apply'}
          </button>
        </div>
      </div>

      {/* ── Chart ── */}
      <div className="card">

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
            <ResponsiveContainer width="100%" height={483}>
              <LineChart data={chartData} margin={{ top: 32, right: 24, bottom: 40, left: 8 }}>
                <CartesianGrid strokeDasharray="4 4" stroke="var(--color-gray-200)" vertical={false} />
                <XAxis
                  dataKey="timeslot"
                  tickFormatter={v => String(v).replace(/^t/i, '')}
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
                <Legend wrapperStyle={{ fontSize: 12, paddingTop: 16 }} iconType="line" />
                <Line type="monotone" dataKey="avgRooms"   name="Avg Rooms Running"   stroke="#3E53E3" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} />
                <Line type="monotone" dataKey="idealRooms" name="Ideal Rooms Running" stroke="#10b981" strokeWidth={2} strokeDasharray="6 3" dot={false} activeDot={{ r: 4 }} />
                <Line type="monotone" dataKey="maxRooms"   name="Max Rooms Running"   stroke="#f59e0b" strokeWidth={2} strokeDasharray="3 3" dot={false} activeDot={{ r: 4 }} />
                {['t0730','t1530','t1730','t1930'].map(slot => (
                  <ReferenceLine
                    key={slot}
                    x={slot}
                    stroke="#6b7280"
                    strokeDasharray="4 3"
                    strokeWidth={1.5}
                    label={{ value: slot.replace(/^t/i,''), position: 'top', fontSize: 10, fill: '#6b7280' }}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  )
}

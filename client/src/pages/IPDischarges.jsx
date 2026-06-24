import { useState, useEffect } from 'react'
import {
  ComposedChart, BarChart, LineChart, Bar, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine,
} from 'recharts'

// ── Constants ─────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'discharge', label: 'Discharge Execution' },
  { id: 'tdc',       label: 'TDC Process' },
  { id: 'lost',      label: 'Lost Hours' },
  { id: 'ed',        label: 'ED Throughput' },
  { id: 'trends',    label: 'Trends' },
]

// 'hierarchy' is the sentinel for the drill-down view; all other values are
// flat dimension keys that map to DIM_MAP on the backend.
const DIMENSIONS = [
  { value: 'hierarchy',      label: 'Hospital (hierarchy)' },
  { value: 'dept',           label: 'Last Dept' },
  { value: 'loc',            label: 'Level of Care' },
  { value: 'patclass',       label: 'Patient Class' },
  { value: 'provider',       label: 'Last Provider' },
  { value: 'specialty',      label: 'Provider Specialty' },
  { value: 'service',        label: 'Hospital Service' },
  { value: 'financial_class',label: 'Financial Class' },
  { value: 'disposition',    label: 'Discharge Disposition' },
]
const DIM_LABEL = Object.fromEntries(DIMENSIONS.map(d => [d.value, d.label]))

// ── Helpers ───────────────────────────────────────────────────────────────────

function useDebounced(value, delay = 300) {
  const [d, setD] = useState(value)
  useEffect(() => { const t = setTimeout(() => setD(value), delay); return () => clearTimeout(t) }, [value, delay])
  return d
}

function defaultDates() {
  const today  = new Date()
  const sixAgo = new Date(today.getFullYear(), today.getMonth() - 5, 1)
  return { from: sixAgo.toISOString().slice(0, 10), to: today.toISOString().slice(0, 10) }
}

async function apiFetch(url, signal) {
  const r = await fetch(url, { signal })
  if (!r.ok) throw new Error(`${r.status}`)
  return r.json()
}

function qs(params) {
  return '?' + new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== ''))
  ).toString()
}

function padHours(rows) {
  const map = {}
  for (const r of rows) map[r.hour] = r
  return Array.from({ length: 24 }, (_, h) => map[h] ?? { hour: h, n: 0 })
}

const fmtNum  = v => v == null ? '—' : Number(v).toLocaleString()
const fmtMin  = v => v == null ? '—' : `${Math.round(v)} min`
const fmtPct  = v => v == null ? '—' : `${v.toFixed(1)}%`
const fmtDec  = (v, d = 2) => v == null ? '—' : Number(v).toFixed(d)

function fmtHour(h) {
  if (h == null) return '—'
  const hrs  = Math.floor(h)
  const mins = Math.round((h - hrs) * 60)
  const ampm = hrs < 12 ? 'AM' : 'PM'
  const h12  = hrs === 0 ? 12 : hrs > 12 ? hrs - 12 : hrs
  return `${h12}:${String(mins).padStart(2, '0')} ${ampm}`
}

function hourLabel(h) {
  if (h === 0) return '12a'
  if (h < 12)  return `${h}a`
  if (h === 12) return '12p'
  return `${h - 12}p`
}

// ── Color helpers ─────────────────────────────────────────────────────────────

const pct2pmBg = v => {
  if (v == null) return {}
  if (v >= 60) return { background: '#E8F5E9' }
  if (v >= 40) return { background: '#FFF8E1' }
  return { background: '#FFEBEE' }
}
const pct2pmColor = v => {
  if (v == null) return 'var(--color-gray-700)'
  if (v >= 60) return '#2E7D32'
  if (v >= 40) return '#E65100'
  return '#C62828'
}

const pctLostBg = v => {
  if (v == null) return {}
  if (v >= 30) return { background: '#FFEBEE' }
  if (v >= 15) return { background: '#FFF8E1' }
  return { background: '#E8F5E9' }
}
const pctLostColor = v => {
  if (v == null) return 'var(--color-gray-700)'
  if (v >= 30) return '#C62828'
  if (v >= 15) return '#E65100'
  return '#2E7D32'
}

// Highlight the longest TDC phase in a row (red + bold)
function tdcPhaseHi(row, key) {
  const vals = [
    row.avg_dc_order_to_engaged   ?? 0,
    row.avg_engaged_to_complete   ?? 0,
    row.avg_complete_to_discharge ?? 0,
  ]
  const max = Math.max(...vals)
  return max > 0 && (row[key] ?? 0) === max ? { color: '#D32F2F', fontWeight: 700 } : {}
}

// ── Hierarchy aggregation ─────────────────────────────────────────────────────

// Accurately aggregate dept-level rows into a parent row using raw count columns.
function aggDeptRows(rows) {
  if (!rows.length) return {}
  const n       = rows.reduce((s, r) => s + (r.n   ?? 0), 0)
  const nB2     = rows.reduce((s, r) => s + (r.n_before_2pm   ?? 0), 0)
  const nDC     = rows.reduce((s, r) => s + (r.n_dc_with_order ?? 0), 0)
  const nDC10   = rows.reduce((s, r) => s + (r.n_dc_before_10am ?? 0), 0)
  const nC      = rows.reduce((s, r) => s + (r.n_complete      ?? 0), 0)
  const nLH     = rows.reduce((s, r) => s + (r.n_lh            ?? 0), 0)
  const nLHAbv  = rows.reduce((s, r) => s + (r.n_lh_above_target ?? 0), 0)
  const nED     = rows.reduce((s, r) => s + (r.n_ed            ?? 0), 0)

  // Weighted avg helper (weight key may be 0 → return null, not NaN)
  const wa = (key, wKey) => {
    const tot = rows.reduce((s, r) => s + (r[wKey] ?? 0), 0)
    if (!tot) return null
    return rows.reduce((s, r) => s + (r[key] ?? 0) * (r[wKey] ?? 0), 0) / tot
  }

  return {
    n, n_before_2pm: nB2, n_dc_with_order: nDC, n_dc_before_10am: nDC10,
    n_complete: nC, n_lh: nLH, n_lh_above_target: nLHAbv, n_ed: nED,
    // Discharge — pcts use raw counts, not avg of child pcts
    pct_before_2pm:           n   ? (nB2   / n   * 100) : null,
    pct_dc_order_before_10am: nDC ? (nDC10 / nDC * 100) : null,
    // avg duration — weighted by encounter count
    avg_do_dc_mins:           wa('avg_do_dc_mins', 'n'),
    // TDC — pct uses raw counts; phase avgs weighted by n_complete
    pct_tdc_complete:         n   ? (nC    / n   * 100) : null,
    avg_dc_order_to_engaged:  wa('avg_dc_order_to_engaged',   'n_complete'),
    avg_engaged_to_complete:  wa('avg_engaged_to_complete',   'n_complete'),
    avg_complete_to_discharge:wa('avg_complete_to_discharge', 'n_complete'),
    avg_engaged_to_avs:       wa('avg_engaged_to_avs',        'n_complete'),
    // Lost Hours — pct uses raw counts; avg weighted by n_lh
    pct_above_target:         nLH ? (nLHAbv / nLH * 100) : null,
    avg_lost_mins:            wa('avg_lost_mins', 'n_lh'),
    total_lost_hours:         rows.reduce((s, r) => s + (r.total_lost_hours ?? 0), 0),
    // ED — avgs weighted by n_ed
    avg_arrival_to_admit_order: wa('avg_arrival_to_admit_order', 'n_ed'),
    avg_arrival_to_dispo:       wa('avg_arrival_to_dispo',       'n_ed'),
  }
}

// Add the derived avg_tdc_total field; null when all three phases are null/zero.
function enrichRow(r) {
  const tot = (r.avg_dc_order_to_engaged ?? 0) +
              (r.avg_engaged_to_complete ?? 0) +
              (r.avg_complete_to_discharge ?? 0)
  return { ...r, avg_tdc_total: tot || null }
}

// ── DrillTable column configs ─────────────────────────────────────────────────

const DRILL_COLS = {
  discharge: [
    { key: 'n',                        label: 'Discharges',       fmt: fmtNum,
      style: ()  => ({ textAlign: 'right' }) },
    { key: 'pct_before_2pm',           label: '% Before 2pm',     fmt: fmtPct,
      style: r  => ({ textAlign: 'right', ...pct2pmBg(r.pct_before_2pm) }) },
    { key: 'pct_dc_order_before_10am', label: '% DC Order <10am', fmt: fmtPct,
      style: r  => ({ textAlign: 'right', ...pct2pmBg(r.pct_dc_order_before_10am) }) },
    { key: 'avg_do_dc_mins',           label: 'Avg DO→DC',        fmt: fmtMin,
      style: ()  => ({ textAlign: 'right' }) },
  ],
  tdc: [
    { key: 'n_complete',               label: 'n (Complete)',        fmt: fmtNum,
      style: ()  => ({ textAlign: 'right' }) },
    { key: 'avg_dc_order_to_engaged',  label: 'DC Order→Engaged',   fmt: fmtMin,
      style: r  => ({ textAlign: 'right', ...tdcPhaseHi(r, 'avg_dc_order_to_engaged') }) },
    { key: 'avg_engaged_to_complete',  label: 'Engaged→Complete',   fmt: fmtMin,
      style: r  => ({ textAlign: 'right', ...tdcPhaseHi(r, 'avg_engaged_to_complete') }) },
    { key: 'avg_complete_to_discharge',label: 'Complete→Discharge', fmt: fmtMin,
      style: r  => ({ textAlign: 'right', ...tdcPhaseHi(r, 'avg_complete_to_discharge') }) },
    { key: 'avg_tdc_total',            label: 'Avg Total',          fmt: fmtMin,
      style: ()  => ({ textAlign: 'right' }) },
  ],
  lost: [
    { key: 'n_lh',           label: 'n',               fmt: fmtNum,
      style: ()  => ({ textAlign: 'right' }) },
    { key: 'pct_above_target',label: '% Above Target', fmt: fmtPct,
      style: r  => ({ textAlign: 'right', ...pctLostBg(r.pct_above_target) }) },
    { key: 'avg_lost_mins',  label: 'Avg Lost Mins',   fmt: fmtMin,
      style: ()  => ({ textAlign: 'right' }) },
    { key: 'total_lost_hours',label: 'Total Lost Hours', fmt: v => fmtDec(v, 1),
      style: ()  => ({ textAlign: 'right' }) },
  ],
  ed: [
    { key: 'n_ed',                       label: 'ED Admissions',           fmt: fmtNum,
      style: ()  => ({ textAlign: 'right' }) },
    { key: 'avg_arrival_to_admit_order', label: 'Avg Arrival→Admit Order', fmt: fmtMin,
      style: ()  => ({ textAlign: 'right' }) },
    { key: 'avg_arrival_to_dispo',       label: 'Avg Arrival→Dispo',       fmt: fmtMin,
      style: ()  => ({ textAlign: 'right' }) },
  ],
}

// ── Shared atoms ──────────────────────────────────────────────────────────────

const Spinner = () => (
  <div style={{ display: 'flex', justifyContent: 'center', padding: 24, color: 'var(--color-gray-400)', fontSize: 13 }}>Loading…</div>
)
const ErrMsg = ({ msg }) => (
  <div style={{ padding: '10px 14px', background: '#FFEBEE', color: '#C62828', borderRadius: 6, fontSize: 13 }}>{msg}</div>
)

function StatCard({ label, value, sub, valueColor }) {
  return (
    <div style={{ background: 'var(--surface-card)', border: '1px solid var(--surface-border)', borderRadius: 'var(--radius-lg)', padding: '0.75rem 1rem', minWidth: 0 }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-gray-500)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: valueColor ?? 'var(--color-gray-900)', lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--color-gray-500)', marginTop: 3 }}>{sub}</div>}
    </div>
  )
}

const TH = ({ children, right }) => (
  <th style={{ padding: '4px 8px', fontSize: 11, fontWeight: 600, textAlign: right ? 'right' : 'left', background: '#F5F7FA', borderBottom: '1px solid #E0E0E0', whiteSpace: 'nowrap' }}>{children}</th>
)
const TD = ({ children, style }) => (
  <td style={{ padding: '4px 8px', fontSize: 12, borderBottom: '1px solid #F5F5F5', ...style }}>{children}</td>
)

const CARD = { background: 'var(--surface-card)', border: '1px solid var(--surface-border)', borderRadius: 'var(--radius-lg)', padding: '0.75rem 1rem' }

// ── DrillTable ────────────────────────────────────────────────────────────────

function DrillTable({ flatRows, tabKey, loading, title }) {
  const [expHosp, setExpHosp] = useState(new Set())
  const [expLoc,  setExpLoc]  = useState(new Set())

  const cols = DRILL_COLS[tabKey]

  if (loading) return (
    <div style={CARD}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{title}</div>
      <Spinner />
    </div>
  )

  if (!flatRows?.length) return (
    <div style={CARD}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{title}</div>
      <div style={{ color: 'var(--color-gray-400)', fontSize: 12, padding: '8px 0' }}>No data available</div>
    </div>
  )

  // Build hospital → loc → dept hierarchy
  const hospMap = {}
  for (const r of flatRows) {
    const h = r.hospital ?? 'Unknown'
    const l = r.loc      ?? 'Unknown'
    if (!hospMap[h]) hospMap[h] = {}
    if (!hospMap[h][l]) hospMap[h][l] = []
    hospMap[h][l].push(r)
  }

  const hospitals  = Object.keys(hospMap).sort()
  const grandTotal = enrichRow(aggDeptRows(flatRows))

  // Precompute aggregations at hospital and LOC levels
  const hospAgg = {}
  const locAgg  = {}
  for (const h of hospitals) {
    hospAgg[h] = enrichRow(aggDeptRows(Object.values(hospMap[h]).flat()))
    for (const [l, depts] of Object.entries(hospMap[h])) {
      locAgg[`${h}||${l}`] = enrichRow(aggDeptRows(depts))
    }
  }

  function toggleHosp(h) {
    setExpHosp(prev => { const s = new Set(prev); s.has(h) ? s.delete(h) : s.add(h); return s })
  }
  function toggleLoc(k) {
    setExpLoc(prev => { const s = new Set(prev); s.has(k) ? s.delete(k) : s.add(k); return s })
  }

  // Flatten rows for rendering
  const renderRows = []
  renderRows.push({ type: 'grand', key: '__grand__', row: grandTotal })
  for (const h of hospitals) {
    const hOpen = expHosp.has(h)
    renderRows.push({ type: 'hosp', key: `h:${h}`, label: h, row: hospAgg[h], open: hOpen })
    if (!hOpen) continue
    const locs = Object.keys(hospMap[h]).sort()
    for (const l of locs) {
      const lKey  = `${h}||${l}`
      const lOpen = expLoc.has(lKey)
      renderRows.push({ type: 'loc', key: `l:${lKey}`, label: l, lKey, h, row: locAgg[lKey], open: lOpen })
      if (!lOpen) continue
      hospMap[h][l].forEach((dr, i) => {
        renderRows.push({ type: 'dept', key: `d:${lKey}:${i}`, label: dr.dept, row: enrichRow(dr) })
      })
    }
  }

  const cellStyle = (row, col) => col.style(row)

  return (
    <div style={CARD}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{title}</div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <TH>Location</TH>
              {cols.map(c => <TH key={c.key} right>{c.label}</TH>)}
            </tr>
          </thead>
          <tbody>
            {renderRows.map(item => {
              if (item.type === 'grand') {
                return (
                  <tr key={item.key} style={{ background: '#F5F7FA' }}>
                    <TD style={{ fontWeight: 700 }}>Grand Total</TD>
                    {cols.map(c => <TD key={c.key} style={{ fontWeight: 700, ...cellStyle(item.row, c) }}>{c.fmt(item.row[c.key])}</TD>)}
                  </tr>
                )
              }
              if (item.type === 'hosp') {
                return (
                  <tr key={item.key} onClick={() => toggleHosp(item.label)}
                    style={{ cursor: 'pointer', background: item.open ? '#EEF0FD' : undefined }}>
                    <TD style={{ fontWeight: 600 }}>
                      <span style={{ display: 'inline-block', width: 14, fontSize: 9, color: '#3E53E3', userSelect: 'none' }}>
                        {item.open ? '▼' : '▶'}
                      </span>
                      {item.label}
                    </TD>
                    {cols.map(c => <TD key={c.key} style={{ fontWeight: 600, ...cellStyle(item.row, c) }}>{c.fmt(item.row[c.key])}</TD>)}
                  </tr>
                )
              }
              if (item.type === 'loc') {
                return (
                  <tr key={item.key}
                    onClick={e => { e.stopPropagation(); toggleLoc(item.lKey) }}
                    style={{ cursor: 'pointer', background: item.open ? '#F5F5FF' : undefined }}>
                    <TD style={{ paddingLeft: 28 }}>
                      <span style={{ display: 'inline-block', width: 14, fontSize: 9, color: 'var(--color-gray-500)', userSelect: 'none' }}>
                        {item.open ? '▼' : '▶'}
                      </span>
                      {item.label}
                    </TD>
                    {cols.map(c => <TD key={c.key} style={cellStyle(item.row, c)}>{c.fmt(item.row[c.key])}</TD>)}
                  </tr>
                )
              }
              if (item.type === 'dept') {
                return (
                  <tr key={item.key}>
                    <TD style={{ paddingLeft: 48, color: 'var(--color-gray-600)' }}>{item.label}</TD>
                    {cols.map(c => <TD key={c.key} style={cellStyle(item.row, c)}>{c.fmt(item.row[c.key])}</TD>)}
                  </tr>
                )
              }
              return null
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Distribution chart ────────────────────────────────────────────────────────

function HistChart({ data, title, targetX, loading }) {
  if (loading) return <Spinner />
  if (!data?.length) return null
  const targetRow   = targetX != null ? data.find(r => r.bin_start <= targetX && r.bin_start + 30 > targetX) : null
  const targetLabel = targetRow?.bin_label
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-gray-700)', marginBottom: 6 }}>{title}</div>
      <ResponsiveContainer width="100%" height={200}>
        <ComposedChart data={data} margin={{ top: 4, right: 32, bottom: 36, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#F0F0F0" />
          <XAxis dataKey="bin_label" tick={{ fontSize: 9 }} angle={-40} textAnchor="end" interval={0} />
          <YAxis yAxisId="l" tick={{ fontSize: 10 }} width={34} />
          <YAxis yAxisId="r" orientation="right" domain={[0, 100]} tick={{ fontSize: 10 }} width={28} tickFormatter={v => `${v}%`} />
          <Tooltip formatter={(v, n) => n === 'cumulative_pct' ? `${v?.toFixed(1)}%` : v} contentStyle={{ fontSize: 11 }} />
          <Bar yAxisId="l" dataKey="n" fill="#378ADD" name="Count" radius={[2, 2, 0, 0]} />
          <Line yAxisId="r" type="monotone" dataKey="cumulative_pct" stroke="#E24B4A" dot={false} name="Cumulative %" strokeWidth={2} />
          {targetLabel && <ReferenceLine yAxisId="l" x={targetLabel} stroke="#E24B4A" strokeDasharray="5 4" strokeWidth={2} />}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

// ── TAB 1: Discharge Execution ────────────────────────────────────────────────

function DischargeTab({ baseQS, hierRows, hierLoading, isHier, dimQS, dimLabel }) {
  const [summary, setSummary] = useState(null)
  const [byDim,   setByDim]   = useState([])
  const [hrDisch, setHrDisch] = useState([])
  const [hrDO,    setHrDO]    = useState([])
  const [dist,    setDist]    = useState([])
  const [ldSum,   setLdSum]   = useState(true)
  const [ldDim,   setLdDim]   = useState(false)
  const [ldHr,    setLdHr]    = useState(true)
  const [ldDist,  setLdDist]  = useState(true)
  const [err,     setErr]     = useState(null)

  useEffect(() => {
    const ac = new AbortController()
    setLdSum(true); setErr(null)
    apiFetch(`/api/ipdischarges/summary${baseQS}`, ac.signal)
      .then(d => { setSummary(d); setLdSum(false) })
      .catch(e => { if (e.name !== 'AbortError') { setErr(e.message); setLdSum(false) } })
    return () => ac.abort()
  }, [baseQS])

  // Only fetch flat by-dimension when NOT in hierarchy mode
  useEffect(() => {
    if (isHier) { setByDim([]); setLdDim(false); return }
    const ac = new AbortController()
    setLdDim(true)
    apiFetch(`/api/ipdischarges/by-dimension${dimQS}`, ac.signal)
      .then(d => { setByDim(d); setLdDim(false) })
      .catch(e => { if (e.name !== 'AbortError') setLdDim(false) })
    return () => ac.abort()
  }, [dimQS, isHier])

  useEffect(() => {
    const ac = new AbortController()
    setLdHr(true)
    Promise.all([
      apiFetch(`/api/ipdischarges/by-hour${baseQS}&metric=discharge`, ac.signal),
      apiFetch(`/api/ipdischarges/by-hour${baseQS}&metric=dc_order`, ac.signal),
    ]).then(([d, dc]) => { setHrDisch(padHours(d)); setHrDO(padHours(dc)); setLdHr(false) })
      .catch(e => { if (e.name !== 'AbortError') setLdHr(false) })
    return () => ac.abort()
  }, [baseQS])

  useEffect(() => {
    const ac = new AbortController()
    setLdDist(true)
    apiFetch(`/api/ipdischarges/do-dc-distribution${baseQS}`, ac.signal)
      .then(d => { setDist(d); setLdDist(false) })
      .catch(e => { if (e.name !== 'AbortError') setLdDist(false) })
    return () => ac.abort()
  }, [baseQS])

  const s = summary ?? {}
  const hourBarProps = { margin: { top: 4, right: 16, bottom: 8, left: 0 } }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {/* Stat cards */}
      {ldSum ? <Spinner /> : err ? <ErrMsg msg={err} /> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '0.75rem' }}>
          <StatCard label="Total Discharges"        value={fmtNum(s.total_discharges)} />
          <StatCard label="% Before 2pm"            value={fmtPct(s.pct_disch_before_2pm)}     valueColor={pct2pmColor(s.pct_disch_before_2pm)} />
          <StatCard label="% DC Order Before 10am"  value={fmtPct(s.pct_dc_order_before_10am)} valueColor={pct2pmColor(s.pct_dc_order_before_10am)} />
          <StatCard label="Avg DO→DC"               value={fmtMin(s.avg_do_dc_mins)} />
          <StatCard label="CMI"                     value={fmtDec(s.cmi)} />
          <StatCard label="Avg Discharge Hour"      value={fmtHour(s.avg_disch_hour)} />
          <StatCard label="Avg DC Order Hour"       value={fmtHour(s.avg_dc_order_hour)} />
        </div>
      )}

      {/* Breakdown table — hierarchy or flat */}
      {isHier
        ? <DrillTable flatRows={hierRows} tabKey="discharge" loading={hierLoading}
            title="Discharge Execution by Hospital / LOC / Dept" />
        : (
          <div style={CARD}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Discharges by {dimLabel}</div>
            {ldDim ? <Spinner /> : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr>
                    <TH>{dimLabel}</TH>
                    <TH right>Discharges</TH>
                    <TH right>% Before 2pm</TH>
                    <TH right>% DC Order Before 10am</TH>
                    <TH right>Avg DO→DC (min)</TH>
                  </tr></thead>
                  <tbody>
                    {byDim.map(r => (
                      <tr key={r.label}>
                        <TD>{r.label}</TD>
                        <TD style={{ textAlign: 'right' }}>{fmtNum(r.n)}</TD>
                        <TD style={{ textAlign: 'right', ...pct2pmBg(r.pct_before_2pm) }}>{fmtPct(r.pct_before_2pm)}</TD>
                        <TD style={{ textAlign: 'right', ...pct2pmBg(r.pct_dc_order_before_10am) }}>{fmtPct(r.pct_dc_order_before_10am)}</TD>
                        <TD style={{ textAlign: 'right' }}>{fmtMin(r.avg_do_dc_mins)}</TD>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )
      }

      {/* Three charts */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.75rem' }}>
        <div style={CARD}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Discharges by Hour of Day</div>
          {ldHr ? <Spinner /> : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={hrDisch} {...hourBarProps}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#F0F0F0" />
                <XAxis dataKey="hour" tickFormatter={hourLabel} tick={{ fontSize: 9 }} />
                <YAxis tick={{ fontSize: 10 }} width={34} />
                <Tooltip labelFormatter={hourLabel} contentStyle={{ fontSize: 11 }} />
                <Bar dataKey="n" fill="#378ADD" name="Discharges" />
                <ReferenceLine x={14} stroke="#E24B4A" strokeDasharray="5 4" label={{ value: '2pm', position: 'top', fontSize: 9, fill: '#E24B4A' }} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
        <div style={CARD}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>DC Orders by Hour of Day</div>
          {ldHr ? <Spinner /> : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={hrDO} {...hourBarProps}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#F0F0F0" />
                <XAxis dataKey="hour" tickFormatter={hourLabel} tick={{ fontSize: 9 }} />
                <YAxis tick={{ fontSize: 10 }} width={34} />
                <Tooltip labelFormatter={hourLabel} contentStyle={{ fontSize: 11 }} />
                <Bar dataKey="n" fill="#4CAF50" name="DC Orders" />
                <ReferenceLine x={10} stroke="#E24B4A" strokeDasharray="5 4" label={{ value: '10am', position: 'top', fontSize: 9, fill: '#E24B4A' }} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
        <div style={CARD}>
          <HistChart data={dist} title="DO→DC Distribution" loading={ldDist} />
        </div>
      </div>
    </div>
  )
}

// ── TAB 2: TDC Process ────────────────────────────────────────────────────────

function TDCWaterfall({ phases }) {
  const p1 = phases.avg_dc_order_to_engaged    ?? 0
  const p2 = phases.avg_engaged_to_complete    ?? 0
  const p3 = phases.avg_complete_to_discharge  ?? 0
  const total = p1 + p2 + p3 || 1
  const boxes = [
    { label: 'DC Order → TDC Engaged', value: p1, color: '#3E53E3', bg: '#EEF0FD' },
    { label: 'Engaged → Complete',     value: p2, color: '#E65100', bg: '#FFF3E0' },
    { label: 'Complete → Discharge',   value: p3, color: '#2E7D32', bg: '#E8F5E9' },
  ]
  return (
    <div>
      <div style={{ display: 'flex', height: 88, alignItems: 'stretch', borderRadius: 8, overflow: 'hidden' }}>
        {boxes.map((b, i) => (
          <div key={i} style={{ flex: Math.max(b.value / total, 0.05), background: b.bg, borderLeft: i > 0 ? '2px solid #fff' : undefined, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '6px 4px', overflow: 'hidden' }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: b.color, lineHeight: 1 }}>{Math.round(b.value)} min</div>
            <div style={{ fontSize: 9, color: b.color, textAlign: 'center', marginTop: 3, lineHeight: 1.3 }}>{b.label}</div>
          </div>
        ))}
      </div>
      {phases.avg_engaged_to_avs != null && (
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--color-gray-600)' }}>
          DC Order → AVS Printed (avg): <strong>{Math.round(phases.avg_engaged_to_avs)} min</strong>
        </div>
      )}
    </div>
  )
}

function TDCTab({ baseQS, hierRows, hierLoading, isHier, dimQS, dimLabel }) {
  const [tdc,     setTdc]     = useState(null)
  const [loading, setLoading] = useState(true)
  const [err,     setErr]     = useState(null)

  useEffect(() => {
    const ac = new AbortController()
    setLoading(true); setErr(null)
    // dimQS has no dimension when isHier — returns summary+phases with empty by_dimension
    apiFetch(`/api/ipdischarges/tdc${dimQS}`, ac.signal)
      .then(d => { setTdc(d); setLoading(false) })
      .catch(e => { if (e.name !== 'AbortError') { setErr(e.message); setLoading(false) } })
    return () => ac.abort()
  }, [dimQS])

  if (loading) return <Spinner />
  if (err)     return <ErrMsg msg={err} />

  const ts = tdc?.tdc_summary  ?? {}
  const tp = tdc?.tdc_phases   ?? {}
  const bd = tdc?.by_dimension ?? []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {/* Stat cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.75rem' }}>
        <StatCard label="% TDC Complete"           value={fmtPct(ts.pct_complete)}             valueColor={ts.pct_complete != null ? (ts.pct_complete >= 50 ? '#2E7D32' : '#C62828') : undefined} />
        <StatCard label="% Engaged Not Complete"   value={fmtPct(ts.pct_engaged_not_complete)} />
        <StatCard label="% Delayed / Canceled"     value={fmtPct(ts.pct_delayed)}              valueColor={ts.pct_delayed != null && ts.pct_delayed > 10 ? '#C62828' : undefined} />
        <StatCard label="% Not Engaged"            value={fmtPct(ts.pct_not_engaged)} />
      </div>

      {/* Phase waterfall */}
      <div style={CARD}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>TDC Phase Breakdown (Completed Encounters — n={fmtNum(tp.n_complete)})</div>
        <TDCWaterfall phases={tp} />
      </div>

      {/* Breakdown — hierarchy or flat */}
      {isHier
        ? <DrillTable flatRows={hierRows} tabKey="tdc" loading={hierLoading}
            title="TDC Phase Breakdown by Hospital / LOC / Dept" />
        : bd.length > 0 && (
          <div style={CARD}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>TDC Phases by {dimLabel}</div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <TH>{dimLabel}</TH>
                  <TH right>n (Complete)</TH>
                  <TH right>Avg DC Order→Engaged</TH>
                  <TH right>Avg Engaged→Complete</TH>
                  <TH right>Avg Complete→Discharge</TH>
                  <TH right>Avg Total</TH>
                </tr></thead>
                <tbody>
                  {bd.map(r => {
                    const vals   = [r.avg_dc_order_to_engaged, r.avg_engaged_to_complete, r.avg_complete_to_discharge]
                    const maxVal = Math.max(...vals.filter(v => v != null))
                    const bold   = v => v != null && v === maxVal ? { color: '#D32F2F', fontWeight: 700 } : {}
                    const total  = (r.avg_dc_order_to_engaged ?? 0) + (r.avg_engaged_to_complete ?? 0) + (r.avg_complete_to_discharge ?? 0)
                    return (
                      <tr key={r.label}>
                        <TD>{r.label}</TD>
                        <TD style={{ textAlign: 'right' }}>{fmtNum(r.n_complete)}</TD>
                        <TD style={{ textAlign: 'right', ...bold(r.avg_dc_order_to_engaged) }}>{fmtMin(r.avg_dc_order_to_engaged)}</TD>
                        <TD style={{ textAlign: 'right', ...bold(r.avg_engaged_to_complete) }}>{fmtMin(r.avg_engaged_to_complete)}</TD>
                        <TD style={{ textAlign: 'right', ...bold(r.avg_complete_to_discharge) }}>{fmtMin(r.avg_complete_to_discharge)}</TD>
                        <TD style={{ textAlign: 'right' }}>{fmtMin(total || null)}</TD>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )
      }
    </div>
  )
}

// ── TAB 3: Lost Hours ─────────────────────────────────────────────────────────

function LostHoursTab({ baseQS, hierRows, hierLoading, isHier, dimQS, dimLabel }) {
  const [lh,      setLh]      = useState(null)
  const [loading, setLoading] = useState(true)
  const [err,     setErr]     = useState(null)

  useEffect(() => {
    const ac = new AbortController()
    setLoading(true); setErr(null)
    // dimQS has no dimension when isHier — returns summary+dist with empty by_dimension
    apiFetch(`/api/ipdischarges/lost-hours${dimQS}`, ac.signal)
      .then(d => { setLh(d); setLoading(false) })
      .catch(e => { if (e.name !== 'AbortError') { setErr(e.message); setLoading(false) } })
    return () => ac.abort()
  }, [dimQS])

  if (loading) return <Spinner />
  if (err)     return <ErrMsg msg={err} />

  const s    = lh?.summary      ?? {}
  const bd   = lh?.by_dimension ?? []
  const dist = lh?.distribution ?? []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {/* Stat cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.75rem' }}>
        <StatCard label="Encounters w/ Entry"   value={fmtNum(s.total_encounters_with_entry)} />
        <StatCard label="% Above 30-min Target" value={fmtPct(s.pct_above_target)} valueColor={pctLostColor(s.pct_above_target)} />
        <StatCard label="Total Lost Hours"      value={fmtDec(s.total_lost_hours, 1)} />
        <StatCard label="Avg Lost Minutes"      value={fmtMin(s.avg_lost_mins)} />
      </div>

      {/* Breakdown — hierarchy or flat */}
      {isHier
        ? <DrillTable flatRows={hierRows} tabKey="lost" loading={hierLoading}
            title="Lost Hours by Hospital / LOC / Dept" />
        : bd.length > 0 && (
          <div style={CARD}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Lost Hours by {dimLabel}</div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <TH>{dimLabel}</TH>
                  <TH right>n</TH>
                  <TH right>% Above Target</TH>
                  <TH right>Avg Lost Mins</TH>
                  <TH right>Total Lost Hours</TH>
                </tr></thead>
                <tbody>
                  {bd.map(r => (
                    <tr key={r.label}>
                      <TD>{r.label}</TD>
                      <TD style={{ textAlign: 'right' }}>{fmtNum(r.n)}</TD>
                      <TD style={{ textAlign: 'right', ...pctLostBg(r.pct_above_target) }}>{fmtPct(r.pct_above_target)}</TD>
                      <TD style={{ textAlign: 'right' }}>{fmtMin(r.avg_lost_mins)}</TD>
                      <TD style={{ textAlign: 'right' }}>{fmtDec(r.total_lost_hours, 1)}</TD>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      }

      {/* Distribution histogram */}
      <div style={CARD}>
        <HistChart data={dist} title="Lost Minutes Distribution (15-min bins)" targetX={30} loading={false} />
      </div>
    </div>
  )
}

// ── TAB 4: ED Throughput ──────────────────────────────────────────────────────

function EDTab({ baseQS, hierRows, hierLoading, isHier }) {
  const [ed,      setEd]      = useState(null)
  const [loading, setLoading] = useState(true)
  const [err,     setErr]     = useState(null)

  useEffect(() => {
    const ac = new AbortController()
    setLoading(true); setErr(null)
    apiFetch(`/api/ipdischarges/ed${baseQS}`, ac.signal)
      .then(d => { setEd(d); setLoading(false) })
      .catch(e => { if (e.name !== 'AbortError') { setErr(e.message); setLoading(false) } })
    return () => ac.abort()
  }, [baseQS])

  if (loading) return <Spinner />
  if (err)     return <ErrMsg msg={err} />

  const s      = ed?.summary ?? {}
  const hourly = padHours(ed?.hourly ?? [])
  const dow    = ed?.by_dow ?? []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {/* Stat cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.75rem' }}>
        <StatCard label="ED Admissions"            value={fmtNum(s.ed_admissions)} />
        <StatCard label="Avg Arrival→Admit Order"  value={fmtMin(s.avg_arrival_to_admit_order)} />
        <StatCard label="Avg Arrival→Disposition"  value={fmtMin(s.avg_arrival_to_dispo)} />
      </div>

      {/* Charts */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
        <div style={CARD}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>ED Admissions by Hour of Day</div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={hourly} margin={{ top: 4, right: 16, bottom: 8, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#F0F0F0" />
              <XAxis dataKey="hour" tickFormatter={hourLabel} tick={{ fontSize: 9 }} />
              <YAxis tick={{ fontSize: 10 }} width={34} />
              <Tooltip labelFormatter={hourLabel} contentStyle={{ fontSize: 11 }} />
              <Bar dataKey="n" fill="#9C27B0" name="ED Admissions" />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div style={CARD}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>ED Admissions by Day of Week</div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={dow} margin={{ top: 4, right: 16, bottom: 8, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#F0F0F0" />
              <XAxis dataKey="dow" tick={{ fontSize: 9 }} />
              <YAxis tick={{ fontSize: 10 }} width={34} />
              <Tooltip contentStyle={{ fontSize: 11 }} />
              <Bar dataKey="n" fill="#FF9800" name="ED Admissions" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Hierarchy drill-down (new) */}
      {isHier && (
        <DrillTable flatRows={hierRows} tabKey="ed" loading={hierLoading}
          title="ED Throughput by Hospital / LOC / Dept" />
      )}

      <div style={{ fontSize: 11, color: 'var(--color-gray-500)', padding: '0 4px' }}>
        ED metrics include only encounters flagged as ED arrivals (EDENCOUNTER = Y) with valid timestamps.
      </div>
    </div>
  )
}

// ── TAB 5: Trends ─────────────────────────────────────────────────────────────

function TrendsTab({ baseQS }) {
  const [trend,   setTrend]   = useState([])
  const [loading, setLoading] = useState(true)
  const [err,     setErr]     = useState(null)

  useEffect(() => {
    const ac = new AbortController()
    setLoading(true); setErr(null)
    apiFetch(`/api/ipdischarges/trend${baseQS}`, ac.signal)
      .then(d => { setTrend(d); setLoading(false) })
      .catch(e => { if (e.name !== 'AbortError') { setErr(e.message); setLoading(false) } })
    return () => ac.abort()
  }, [baseQS])

  if (loading) return <Spinner />
  if (err)     return <ErrMsg msg={err} />

  const cm = { top: 4, right: 48, bottom: 8, left: 0 }
  const axisProps = { tick: { fontSize: 10 } }
  const gridProps = { strokeDasharray: '3 3', vertical: false, stroke: '#F0F0F0' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div style={CARD}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Discharge Volume &amp; Timing</div>
        <ResponsiveContainer width="100%" height={220}>
          <ComposedChart data={trend} margin={cm}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="month" {...axisProps} />
            <YAxis yAxisId="l" {...axisProps} width={38} />
            <YAxis yAxisId="r" orientation="right" domain={[0, 100]} {...axisProps} width={32} tickFormatter={v => `${v}%`} />
            <Tooltip contentStyle={{ fontSize: 11 }} formatter={(v, n) => n.includes('%') ? fmtPct(v) : fmtNum(v)} />
            <Legend wrapperStyle={{ fontSize: 10 }} />
            <Bar yAxisId="l" dataKey="n" fill="#E8EEF8" name="Volume" />
            <Line yAxisId="r" type="monotone" dataKey="pct_before_2pm" stroke="#378ADD" strokeWidth={2} dot={false} name="% Before 2pm" />
            <Line yAxisId="r" type="monotone" dataKey="pct_dc_order_before_10am" stroke="#4CAF50" strokeWidth={2} dot={false} name="% DC Order Before 10am" />
            <ReferenceLine yAxisId="r" y={60} stroke="#9E9E9E" strokeDasharray="4 3" strokeOpacity={0.5} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div style={CARD}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>DO→DC Duration (avg minutes)</div>
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={trend} margin={cm}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="month" {...axisProps} />
            <YAxis {...axisProps} width={38} tickFormatter={v => `${v}m`} />
            <Tooltip contentStyle={{ fontSize: 11 }} formatter={v => fmtMin(v)} />
            <Line type="monotone" dataKey="avg_do_dc_mins" stroke="#E24B4A" strokeWidth={2} dot={false} name="Avg DO→DC (min)" />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div style={CARD}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Lost Hours</div>
        <ResponsiveContainer width="100%" height={180}>
          <ComposedChart data={trend} margin={cm}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="month" {...axisProps} />
            <YAxis yAxisId="l" {...axisProps} width={38} tickFormatter={v => `${v}m`} />
            <YAxis yAxisId="r" orientation="right" domain={[0, 100]} {...axisProps} width={32} tickFormatter={v => `${v}%`} />
            <Tooltip contentStyle={{ fontSize: 11 }} formatter={(v, n) => n.includes('%') ? fmtPct(v) : fmtMin(v)} />
            <Legend wrapperStyle={{ fontSize: 10 }} />
            <Line yAxisId="l" type="monotone" dataKey="avg_lost_mins" stroke="#9C27B0" strokeWidth={2} dot={false} name="Avg Lost Mins" />
            <Line yAxisId="r" type="monotone" dataKey="pct_lost_above_target" stroke="#E24B4A" strokeWidth={2} dot={false} strokeDasharray="5 4" name="% Above 30-min Target" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div style={CARD}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>TDC &amp; ED Process Efficiency</div>
        <ResponsiveContainer width="100%" height={180}>
          <ComposedChart data={trend} margin={cm}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="month" {...axisProps} />
            <YAxis yAxisId="l" domain={[0, 100]} {...axisProps} width={38} tickFormatter={v => `${v}%`} />
            <YAxis yAxisId="r" orientation="right" {...axisProps} width={38} tickFormatter={v => `${v}m`} />
            <Tooltip contentStyle={{ fontSize: 11 }} formatter={(v, n) => n.includes('%') ? fmtPct(v) : fmtMin(v)} />
            <Legend wrapperStyle={{ fontSize: 10 }} />
            <Line yAxisId="l" type="monotone" dataKey="tdc_pct_complete" stroke="#4CAF50" strokeWidth={2} dot={false} name="% TDC Complete" />
            <Line yAxisId="r" type="monotone" dataKey="avg_arrival_to_admit_order" stroke="#FF9800" strokeWidth={2} dot={false} name="Avg ED Arrival→Admit Order (min)" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function IPDischarges() {
  const { from: defFrom, to: defTo } = defaultDates()
  const [from,      setFrom]      = useState(defFrom)
  const [to,        setTo]        = useState(defTo)
  const [hospital,  setHospital]  = useState('')
  const [dimension, setDimension] = useState('hierarchy')
  const [activeTab, setActiveTab] = useState('discharge')
  const [opts,      setOpts]      = useState({ hospitals: [] })

  // Shared hierarchy data — fetched once, passed to all tabs
  const [hierRows,    setHierRows]    = useState([])
  const [hierLoading, setHierLoading] = useState(false)

  const dFrom = useDebounced(from)
  const dTo   = useDebounced(to)

  const isHier = dimension === 'hierarchy'

  // baseQS — date + optional hospital filter, no dimension
  const baseQS = qs({ from: dFrom, to: dTo, hospital: hospital || undefined })
  // hierQS — same as baseQS but adds hierarchy=true for the combined endpoint
  const hierQS = qs({ from: dFrom, to: dTo, hospital: hospital || undefined, hierarchy: 'true' })
  // dimQS — includes dimension when a flat dimension is active; equals baseQS when hierarchy
  const dimQS  = qs({ from: dFrom, to: dTo, hospital: hospital || undefined,
                      dimension: (!isHier && dimension) ? dimension : undefined })

  // Load filter-options
  useEffect(() => {
    if (!dFrom || !dTo) return
    const ac = new AbortController()
    apiFetch(`/api/ipdischarges/filter-options?from=${dFrom}&to=${dTo}`, ac.signal)
      .then(d => setOpts(d)).catch(() => {})
    return () => ac.abort()
  }, [dFrom, dTo])

  // Load hierarchy data whenever date/hospital/isHier changes
  useEffect(() => {
    if (!isHier) return
    const ac = new AbortController()
    setHierLoading(true)
    apiFetch(`/api/ipdischarges/by-dimension${hierQS}`, ac.signal)
      .then(d => { setHierRows(d); setHierLoading(false) })
      .catch(e => { if (e.name !== 'AbortError') setHierLoading(false) })
    return () => ac.abort()
  }, [hierQS, isHier])

  const reset = () => {
    setHospital(''); setDimension('hierarchy'); setFrom(defFrom); setTo(defTo)
  }

  const sel = { padding: '5px 10px', fontSize: 12, border: '1px solid var(--surface-border)', borderRadius: 'var(--radius-md)', background: 'var(--surface-card)', color: 'var(--color-gray-700)', cursor: 'pointer' }

  return (
    <div style={{ padding: 'var(--space-5) var(--space-6)' }}>
      <h1 style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: 'var(--color-gray-900)', marginBottom: 2 }}>Discharges</h1>
      <p style={{ fontSize: 11, color: 'var(--color-gray-500)', marginBottom: 12 }}>
        Discharge-date anchored · Before 2pm target · DC Order before 10am target · 30-min Lost Hours threshold
      </p>

      {/* Filter bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <label style={{ fontSize: 11, color: 'var(--color-gray-500)' }}>From</label>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={sel} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <label style={{ fontSize: 11, color: 'var(--color-gray-500)' }}>To</label>
          <input type="date" value={to} onChange={e => setTo(e.target.value)} style={sel} />
        </div>
        <select value={hospital} onChange={e => setHospital(e.target.value)} style={sel}>
          <option value="">All Hospitals</option>
          {(opts.hospitals ?? []).map(h => <option key={h} value={h}>{h}</option>)}
        </select>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <label style={{ fontSize: 11, color: 'var(--color-gray-500)' }}>Breakdown by</label>
          <select value={dimension} onChange={e => setDimension(e.target.value)} style={sel}>
            {DIMENSIONS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
          </select>
        </div>
        <button onClick={reset} style={{ fontSize: 11, color: 'var(--color-gray-500)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>
          Reset Filters
        </button>
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 2, borderBottom: '2px solid var(--surface-border)', marginBottom: 16 }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setActiveTab(t.id)}
            style={{ padding: '7px 16px', fontSize: 13, fontWeight: 500, border: 'none', background: 'none', cursor: 'pointer', borderBottom: activeTab === t.id ? '2px solid #3E53E3' : '2px solid transparent', color: activeTab === t.id ? '#3E53E3' : 'var(--color-gray-600)', marginBottom: -2 }}>
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'discharge' && (
        <DischargeTab baseQS={baseQS} hierRows={hierRows} hierLoading={hierLoading}
          isHier={isHier} dimQS={dimQS} dimLabel={DIM_LABEL[dimension]} />
      )}
      {activeTab === 'tdc' && (
        <TDCTab baseQS={baseQS} hierRows={hierRows} hierLoading={hierLoading}
          isHier={isHier} dimQS={dimQS} dimLabel={DIM_LABEL[dimension]} />
      )}
      {activeTab === 'lost' && (
        <LostHoursTab baseQS={baseQS} hierRows={hierRows} hierLoading={hierLoading}
          isHier={isHier} dimQS={dimQS} dimLabel={DIM_LABEL[dimension]} />
      )}
      {activeTab === 'ed' && (
        <EDTab baseQS={baseQS} hierRows={hierRows} hierLoading={hierLoading} isHier={isHier} />
      )}
      {activeTab === 'trends' && <TrendsTab baseQS={baseQS} />}
    </div>
  )
}

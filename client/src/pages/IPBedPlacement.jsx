import { useState, useEffect } from 'react'
import {
  ComposedChart, BarChart, LineChart, Bar, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine,
} from 'recharts'

// ── Constants ─────────────────────────────────────────────────────────────────

const TARGET_COMPLETE = 120
const TARGET_ASSIGNED = 30
const TARGET_EVS      = 60

const TABS = [
  { id: 'summary',     label: 'Summary' },
  { id: 'detail',      label: 'Detail' },
  { id: 'trend',       label: 'Trends' },
  { id: 'time_of_day', label: 'Time of Day' },
  { id: 'evs',         label: 'EVS' },
]

const LOC_COLORS = [
  '#378ADD','#E24B4A','#4CAF50','#FF9800','#9C27B0',
  '#00BCD4','#FF5722','#607D8B','#795548','#E91E63',
]

// ── Hooks & fetch helpers ─────────────────────────────────────────────────────

function useDebounced(value, delay = 300) {
  const [d, setD] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setD(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
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

// ── Format helpers ────────────────────────────────────────────────────────────

const fmtMin  = v => v == null ? '—' : `${Math.round(v)} min`
const fmtPct  = v => v == null ? '—' : `${v.toFixed(1)}%`
const fmtNum  = v => v == null ? '—' : Number(v).toLocaleString()

function hourLabel(h) {
  if (h === 0)  return '12a'
  if (h < 12)   return `${h}a`
  if (h === 12) return '12p'
  return `${h - 12}p`
}

// ── Color coding ──────────────────────────────────────────────────────────────

const pctBg = v => {
  if (v == null) return {}
  if (v >= 75)   return { background: '#E8F5E9' }
  if (v >= 50)   return { background: '#FFF8E1' }
  return { background: '#FFEBEE' }
}

const pctCardColor = v => {
  if (v == null) return 'var(--color-gray-700)'
  if (v >= 75)   return '#2E7D32'
  if (v >= 50)   return '#E65100'
  return '#C62828'
}

const durCardColor = (v, tgt) => v == null ? 'var(--color-gray-700)' : (v <= tgt ? '#2E7D32' : '#C62828')
const durTxt       = (v, tgt) => v != null && v > tgt ? { color: '#D32F2F', fontWeight: 500 } : {}

const heatStyle = v => {
  if (v == null) return { background: '#F5F5F5', color: '#9E9E9E' }
  if (v <= 60)   return { background: '#1B5E20', color: '#fff' }
  if (v <= 90)   return { background: '#388E3C', color: '#fff' }
  if (v <= 120)  return { background: '#FF9800', color: '#fff' }
  if (v <= 180)  return { background: '#FF5722', color: '#fff' }
  return { background: '#C62828', color: '#fff' }
}

// ── Aggregation helpers ───────────────────────────────────────────────────────

function aggSources(rows) {
  const map = {}
  for (const r of rows) {
    const k = `${r.event_type}||${r.source_hospital}||${r.source_loc}||${r.source_dept}`
    if (!map[k]) map[k] = { event_type: r.event_type, source_hospital: r.source_hospital, source_loc: r.source_loc, source_dept: r.source_dept, movements: 0, ha: 0, hc: 0, wa: 0, wc: 0 }
    const g = map[k]
    g.movements += r.movements
    g.ha += (r.pct_target_assigned / 100) * r.movements
    g.hc += (r.pct_target_complete / 100) * r.movements
    g.wa += (r.avg_req_to_assigned ?? 0) * r.movements
    g.wc += (r.avg_req_to_complete ?? 0) * r.movements
  }
  return Object.values(map).map(g => ({
    ...g,
    pct_target_assigned: g.movements ? g.ha / g.movements * 100 : null,
    pct_target_complete: g.movements ? g.hc / g.movements * 100 : null,
    avg_req_to_assigned: g.movements ? g.wa / g.movements : null,
    avg_req_to_complete: g.movements ? g.wc / g.movements : null,
  })).sort((a, b) => b.movements - a.movements)
}

function aggDests(rows) {
  const map = {}
  for (const r of rows) {
    const k = `${r.dest_hospital}||${r.dest_loc}||${r.dest_dept}`
    if (!map[k]) map[k] = { dest_hospital: r.dest_hospital, dest_loc: r.dest_loc, dest_dept: r.dest_dept, movements: 0, ha: 0, hc: 0, wa: 0, wc: 0 }
    const g = map[k]
    g.movements += r.movements
    g.ha += (r.pct_target_assigned / 100) * r.movements
    g.hc += (r.pct_target_complete / 100) * r.movements
    g.wa += (r.avg_req_to_assigned ?? 0) * r.movements
    g.wc += (r.avg_req_to_complete ?? 0) * r.movements
  }
  return Object.values(map).map(g => ({
    ...g,
    pct_target_assigned: g.movements ? g.ha / g.movements * 100 : null,
    pct_target_complete: g.movements ? g.hc / g.movements * 100 : null,
    avg_req_to_assigned: g.movements ? g.wa / g.movements : null,
    avg_req_to_complete: g.movements ? g.wc / g.movements : null,
  })).sort((a, b) => b.movements - a.movements)
}

function pivotHours(rows) {
  const groupSet = new Set()
  const hourMap  = {}
  for (const r of rows) {
    if (!hourMap[r.hour]) hourMap[r.hour] = { hour: r.hour }
    const grp = r.color_group ?? 'Count'
    groupSet.add(grp)
    hourMap[r.hour][grp] = (hourMap[r.hour][grp] ?? 0) + r.n
  }
  for (let h = 0; h < 24; h++) if (!hourMap[h]) hourMap[h] = { hour: h }
  return {
    data:   Array.from({ length: 24 }, (_, h) => hourMap[h] ?? { hour: h }),
    groups: [...groupSet].sort(),
  }
}

// ── Shared UI atoms ───────────────────────────────────────────────────────────

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
  <th style={{ padding: '4px 8px', fontSize: 11, fontWeight: 600, textAlign: right ? 'right' : 'left', background: '#F5F7FA', borderBottom: '1px solid #E0E0E0', whiteSpace: 'nowrap' }}>
    {children}
  </th>
)
const TD = ({ children, style }) => (
  <td style={{ padding: '4px 8px', fontSize: 12, borderBottom: '1px solid #F5F5F5', ...style }}>{children}</td>
)

const CARD = { background: 'var(--surface-card)', border: '1px solid var(--surface-border)', borderRadius: 'var(--radius-lg)', padding: '0.75rem 1rem' }

// ── Distribution chart ────────────────────────────────────────────────────────

function RefLabel({ viewBox, label }) {
  if (!viewBox) return null
  const lx = viewBox.x + 40
  const ly = viewBox.y + 12
  const w  = label.length * 6.5 + 8
  return (
    <g>
      <rect x={lx - 4} y={ly - 13} width={w} height={17} rx={3} fill="rgba(255,255,255,0.85)" />
      <text x={lx} y={ly} fill="#E24B4A" fontSize={11} fontWeight={600}>{label}</text>
    </g>
  )
}

function DistChart({ data, title, target, loading }) {
  if (loading) return <Spinner />
  if (!data?.length) return null
  const targetRow   = data.find(r => r.bin_start !== 301 && r.bin_start <= target && r.bin_start + 60 > target)
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
          {targetLabel && <ReferenceLine yAxisId="l" x={targetLabel} stroke="#E24B4A" strokeDasharray="5 4" strokeWidth={2} label={<RefLabel label={`${target}m target`} />} />}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

// ── TAB 1: Summary ────────────────────────────────────────────────────────────

function SummaryTab({ qs: q, baseQS }) {
  const [summary, setSummary] = useState(null)
  const [hosp,    setHosp]    = useState(null)
  const [distC,   setDistC]   = useState([])
  const [distA,   setDistA]   = useState([])
  const [ldSum,   setLdSum]   = useState(true)
  const [ldHosp,  setLdHosp]  = useState(true)
  const [ldDistC, setLdDistC] = useState(true)
  const [ldDistA, setLdDistA] = useState(true)
  const [err,     setErr]     = useState(null)

  // Drilldown state for hospital table
  const [expHosp, setExpHosp] = useState(new Set())
  const [expLoc,  setExpLoc]  = useState(new Set())

  useEffect(() => {
    const ac = new AbortController()
    setLdSum(true); setErr(null)
    apiFetch(`/api/ipbedplacement/summary${q}`, ac.signal)
      .then(d => { setSummary(d); setLdSum(false) })
      .catch(e => { if (e.name !== 'AbortError') { setErr(e.message); setLdSum(false) } })
    return () => ac.abort()
  }, [q])

  useEffect(() => {
    const ac = new AbortController()
    setLdHosp(true)
    apiFetch(`/api/ipbedplacement/by-hospital${baseQS}`, ac.signal)
      .then(d => { setHosp(d); setLdHosp(false) })
      .catch(e => { if (e.name !== 'AbortError') setLdHosp(false) })
    return () => ac.abort()
  }, [baseQS])

  useEffect(() => {
    const ac = new AbortController()
    setLdDistC(true)
    apiFetch(`/api/ipbedplacement/distribution${baseQS}&metric=req_to_complete`, ac.signal)
      .then(d => { setDistC(d); setLdDistC(false) })
      .catch(e => { if (e.name !== 'AbortError') setLdDistC(false) })
    return () => ac.abort()
  }, [baseQS])

  useEffect(() => {
    const ac = new AbortController()
    setLdDistA(true)
    apiFetch(`/api/ipbedplacement/distribution${baseQS}&metric=req_to_assigned`, ac.signal)
      .then(d => { setDistA(d); setLdDistA(false) })
      .catch(e => { if (e.name !== 'AbortError') setLdDistA(false) })
    return () => ac.abort()
  }, [baseQS])

  // Weighted aggregate helper for hospital table drilldown
  function aggRows(rows) {
    const n  = rows.reduce((s, r) => s + r.movements, 0)
    const wa = rows.reduce((s, r) => s + (r.pct_target_assigned / 100) * r.movements, 0)
    const wc = rows.reduce((s, r) => s + (r.pct_target_complete / 100) * r.movements, 0)
    const ra = rows.reduce((s, r) => s + (r.avg_req_to_assigned ?? 0) * r.movements, 0)
    const ac = rows.reduce((s, r) => s + (r.avg_assigned_to_complete ?? 0) * r.movements, 0)
    const rc = rows.reduce((s, r) => s + (r.avg_req_to_complete ?? 0) * r.movements, 0)
    return {
      movements:                n,
      pct_target_assigned:      n ? wa / n * 100 : null,
      pct_target_complete:      n ? wc / n * 100 : null,
      avg_req_to_assigned:      n ? ra / n : null,
      avg_assigned_to_complete: n ? ac / n : null,
      avg_req_to_complete:      n ? rc / n : null,
    }
  }

  const s  = summary ?? {}
  const gt = hosp?.grand_total ?? {}

  // Build hospital → loc → dept hierarchy from flat rows
  const flatRows = hosp?.hospitals ?? []
  const hospMap  = {}
  for (const r of flatRows) {
    if (!hospMap[r.hospital]) hospMap[r.hospital] = {}
    const loc = r.dest_loc ?? 'Unknown'
    if (!hospMap[r.hospital][loc]) hospMap[r.hospital][loc] = []
    hospMap[r.hospital][loc].push(r)
  }

  const toggleHosp = hosp => {
    setExpHosp(s => { const n = new Set(s); n.has(hosp) ? n.delete(hosp) : n.add(hosp); return n })
  }
  const toggleLoc = (e, key) => {
    e.stopPropagation()
    setExpLoc(s => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>

      {/* Stat cards */}
      {ldSum ? <Spinner /> : err ? <ErrMsg msg={err} /> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: '0.75rem' }}>
          <StatCard label="Total Movements"        value={fmtNum(s.total_movements)} />
          <StatCard label="Median Req→Assigned"    value={fmtMin(s.median_req_to_assigned)}   valueColor={durCardColor(s.median_req_to_assigned, TARGET_ASSIGNED)} />
          <StatCard label="% Within Target (30m)"  value={fmtPct(s.pct_within_target_assigned)} valueColor={pctCardColor(s.pct_within_target_assigned)} sub={`Avg: ${fmtMin(s.avg_req_to_assigned)}`} />
          <StatCard label="Median Req→Complete"    value={fmtMin(s.median_req_to_complete)}   valueColor={durCardColor(s.median_req_to_complete, TARGET_COMPLETE)} />
          <StatCard label="% Within Target (120m)" value={fmtPct(s.pct_within_target_complete)} valueColor={pctCardColor(s.pct_within_target_complete)} sub={`Avg: ${fmtMin(s.avg_req_to_complete)}`} />
          <StatCard label="Median EVS"             value={fmtMin(s.median_evs)}               valueColor={durCardColor(s.median_evs, TARGET_EVS)} />
        </div>
      )}

      {/* Hospital summary table — drillable */}
      <div style={CARD}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Movement Summary by Hospital</div>
        {ldHosp ? <Spinner /> : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <TH>Destination Hospital / LOC / Dept</TH>
                  <TH right>Movements</TH>
                  <TH right>% Within Target Req→Assigned</TH>
                  <TH right>% Within Target Req→Complete</TH>
                  <TH right>Avg Req→Assigned</TH>
                  <TH right>Avg Assigned→Complete</TH>
                  <TH right>Avg Req→Complete</TH>
                </tr>
              </thead>
              <tbody>
                {/* Grand Total */}
                <tr style={{ fontWeight: 700, background: '#F5F7FA' }}>
                  <TD>Grand Total</TD>
                  <TD style={{ textAlign: 'right' }}>{fmtNum(gt.movements)}</TD>
                  <TD style={{ textAlign: 'right', ...pctBg(gt.pct_target_assigned) }}>{fmtPct(gt.pct_target_assigned)}</TD>
                  <TD style={{ textAlign: 'right', ...pctBg(gt.pct_target_complete) }}>{fmtPct(gt.pct_target_complete)}</TD>
                  <TD style={{ textAlign: 'right', ...durTxt(gt.avg_req_to_assigned, TARGET_ASSIGNED) }}>{fmtMin(gt.avg_req_to_assigned)}</TD>
                  <TD style={{ textAlign: 'right' }}>{fmtMin(gt.avg_assigned_to_complete)}</TD>
                  <TD style={{ textAlign: 'right', ...durTxt(gt.avg_req_to_complete, TARGET_COMPLETE) }}>{fmtMin(gt.avg_req_to_complete)}</TD>
                </tr>

                {/* Hospital rows */}
                {Object.entries(hospMap).map(([hospName, locMap]) => {
                  const allRows    = Object.values(locMap).flat()
                  const hospAgg    = aggRows(allRows)
                  const isExpH     = expHosp.has(hospName)
                  return [
                    <tr key={hospName} onClick={() => toggleHosp(hospName)}
                      style={{ cursor: 'pointer', background: '#F0F4FF', fontWeight: 600 }}>
                      <TD>
                        <span style={{ fontSize: 10, marginRight: 6, display: 'inline-block', width: 10 }}>{isExpH ? '▼' : '▶'}</span>
                        {hospName}
                      </TD>
                      <TD style={{ textAlign: 'right' }}>{fmtNum(hospAgg.movements)}</TD>
                      <TD style={{ textAlign: 'right', ...pctBg(hospAgg.pct_target_assigned) }}>{fmtPct(hospAgg.pct_target_assigned)}</TD>
                      <TD style={{ textAlign: 'right', ...pctBg(hospAgg.pct_target_complete) }}>{fmtPct(hospAgg.pct_target_complete)}</TD>
                      <TD style={{ textAlign: 'right', ...durTxt(hospAgg.avg_req_to_assigned, TARGET_ASSIGNED) }}>{fmtMin(hospAgg.avg_req_to_assigned)}</TD>
                      <TD style={{ textAlign: 'right' }}>{fmtMin(hospAgg.avg_assigned_to_complete)}</TD>
                      <TD style={{ textAlign: 'right', ...durTxt(hospAgg.avg_req_to_complete, TARGET_COMPLETE) }}>{fmtMin(hospAgg.avg_req_to_complete)}</TD>
                    </tr>,
                    ...(!isExpH ? [] : Object.entries(locMap).map(([loc, deptRows]) => {
                      const locAgg  = aggRows(deptRows)
                      const locKey  = `${hospName}||${loc}`
                      const isExpL  = expLoc.has(locKey)
                      return [
                        <tr key={locKey} onClick={e => toggleLoc(e, locKey)}
                          style={{ cursor: 'pointer', background: '#F8F9FE' }}>
                          <TD style={{ paddingLeft: 20 }}>
                            <span style={{ fontSize: 10, marginRight: 6, display: 'inline-block', width: 10 }}>{isExpL ? '▼' : '▶'}</span>
                            {loc}
                          </TD>
                          <TD style={{ textAlign: 'right' }}>{fmtNum(locAgg.movements)}</TD>
                          <TD style={{ textAlign: 'right', ...pctBg(locAgg.pct_target_assigned) }}>{fmtPct(locAgg.pct_target_assigned)}</TD>
                          <TD style={{ textAlign: 'right', ...pctBg(locAgg.pct_target_complete) }}>{fmtPct(locAgg.pct_target_complete)}</TD>
                          <TD style={{ textAlign: 'right', ...durTxt(locAgg.avg_req_to_assigned, TARGET_ASSIGNED) }}>{fmtMin(locAgg.avg_req_to_assigned)}</TD>
                          <TD style={{ textAlign: 'right' }}>{fmtMin(locAgg.avg_assigned_to_complete)}</TD>
                          <TD style={{ textAlign: 'right', ...durTxt(locAgg.avg_req_to_complete, TARGET_COMPLETE) }}>{fmtMin(locAgg.avg_req_to_complete)}</TD>
                        </tr>,
                        ...(!isExpL ? [] : deptRows.map(r => (
                          <tr key={`${hospName}||${loc}||${r.dest_dept}`}>
                            <TD style={{ paddingLeft: 40 }}>{r.dest_dept}</TD>
                            <TD style={{ textAlign: 'right' }}>{fmtNum(r.movements)}</TD>
                            <TD style={{ textAlign: 'right', ...pctBg(r.pct_target_assigned) }}>{fmtPct(r.pct_target_assigned)}</TD>
                            <TD style={{ textAlign: 'right', ...pctBg(r.pct_target_complete) }}>{fmtPct(r.pct_target_complete)}</TD>
                            <TD style={{ textAlign: 'right', ...durTxt(r.avg_req_to_assigned, TARGET_ASSIGNED) }}>{fmtMin(r.avg_req_to_assigned)}</TD>
                            <TD style={{ textAlign: 'right' }}>{fmtMin(r.avg_assigned_to_complete)}</TD>
                            <TD style={{ textAlign: 'right', ...durTxt(r.avg_req_to_complete, TARGET_COMPLETE) }}>{fmtMin(r.avg_req_to_complete)}</TD>
                          </tr>
                        ))),
                      ]
                    })),
                  ]
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Distribution charts */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
        <div style={CARD}><DistChart data={distA} title="Request to Assigned Distribution" target={TARGET_ASSIGNED} loading={ldDistA} /></div>
        <div style={CARD}><DistChart data={distC} title="Request to Complete Distribution" target={TARGET_COMPLETE} loading={ldDistC} /></div>
      </div>
    </div>
  )
}

// ── TAB 2: Detail ─────────────────────────────────────────────────────────────

function DetailTab({ qs: q, hospital }) {
  const [matrix,  setMatrix]  = useState([])
  const [loading, setLoading] = useState(true)
  const [err,     setErr]     = useState(null)
  const [selSrc,  setSelSrc]  = useState(null)
  const [selDst,  setSelDst]  = useState(null)

  useEffect(() => {
    const ac = new AbortController()
    setLoading(true); setErr(null); setSelSrc(null); setSelDst(null)
    apiFetch(`/api/ipbedplacement/flow-matrix${q}`, ac.signal)
      .then(d => { setMatrix(d); setLoading(false) })
      .catch(e => { if (e.name !== 'AbortError') { setErr(e.message); setLoading(false) } })
    return () => ac.abort()
  }, [q])

  const srcKey = r => `${r.event_type}||${r.source_hospital}||${r.source_loc}||${r.source_dept}`
  const dstKey = r => `${r.dest_hospital}||${r.dest_loc}||${r.dest_dept}`

  const filteredForDest = selSrc ? matrix.filter(r => srcKey(r) === selSrc) : matrix
  const filteredForSrc  = selDst ? matrix.filter(r => dstKey(r) === selDst) : matrix

  const srcRows  = aggSources(filteredForSrc)
  const destRows = aggDests(filteredForDest)
  const totalMov = matrix.reduce((s, r) => s + r.movements, 0)

  const toggleSrc = k => { setSelSrc(p => p === k ? null : k); setSelDst(null) }
  const toggleDst = k => { setSelDst(p => p === k ? null : k); setSelSrc(null) }

  const cs = { padding: '4px 8px', fontSize: 12, borderBottom: '1px solid #F5F5F5' }
  const hs = { padding: '4px 8px', fontSize: 11, fontWeight: 600, background: '#F5F7FA', borderBottom: '1px solid #E0E0E0', whiteSpace: 'nowrap' }

  if (loading) return <Spinner />
  if (err)     return <ErrMsg msg={err} />

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 13 }}>
          <strong>Placement Activity</strong>
          <span style={{ color: 'var(--color-gray-500)', marginLeft: 6 }}>
            {hospital || 'All Hospitals'} · Assign: {TARGET_ASSIGNED}m · Complete: {TARGET_COMPLETE}m
          </span>
        </span>
        {(selSrc || selDst) && (
          <button onClick={() => { setSelSrc(null); setSelDst(null) }}
            style={{ fontSize: 12, padding: '3px 10px', borderRadius: 4, border: '1px solid #ddd', cursor: 'pointer', background: '#fff' }}>
            Reset Selection
          </button>
        )}
      </div>
      <div style={{ display: 'flex', gap: 0, maxHeight: 560 }}>

        {/* Source card */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, border: '1px solid var(--surface-border)', borderLeft: '3px solid #3E53E3', borderRadius: 6, overflow: 'hidden' }}>
          <div style={{ background: '#EEF0FD', color: '#3E53E3', padding: '5px 10px', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', flexShrink: 0 }}>Source</div>
          <div style={{ overflowX: 'auto', overflowY: 'auto', flex: 1 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={hs}>Event Type</th><th style={hs}>Hospital</th><th style={hs}>Source LOC</th><th style={hs}>Source Dept</th>
                <th style={{ ...hs, textAlign: 'right' }}>Moves</th>
                <th style={{ ...hs, textAlign: 'right' }}>%Asn</th><th style={{ ...hs, textAlign: 'right' }}>%Cmp</th>
                <th style={{ ...hs, textAlign: 'right' }}>Avg Asn</th><th style={{ ...hs, textAlign: 'right' }}>Avg Cmp</th>
              </tr></thead>
              <tbody>
                {srcRows.map(r => {
                  const k = srcKey(r)
                  return (
                    <tr key={k} onClick={() => toggleSrc(k)}
                      style={{ cursor: 'pointer', opacity: selSrc && selSrc !== k ? 0.3 : 1, background: selSrc === k ? '#EEF2FF' : undefined }}>
                      <td style={cs}>{r.event_type}</td><td style={cs}>{r.source_hospital}</td>
                      <td style={cs}>{r.source_loc}</td><td style={cs}>{r.source_dept}</td>
                      <td style={{ ...cs, textAlign: 'right' }}>{fmtNum(r.movements)}</td>
                      <td style={{ ...cs, textAlign: 'right', ...pctBg(r.pct_target_assigned) }}>{fmtPct(r.pct_target_assigned)}</td>
                      <td style={{ ...cs, textAlign: 'right', ...pctBg(r.pct_target_complete) }}>{fmtPct(r.pct_target_complete)}</td>
                      <td style={{ ...cs, textAlign: 'right', ...durTxt(r.avg_req_to_assigned, TARGET_ASSIGNED) }}>{fmtMin(r.avg_req_to_assigned)}</td>
                      <td style={{ ...cs, textAlign: 'right', ...durTxt(r.avg_req_to_complete, TARGET_COMPLETE) }}>{fmtMin(r.avg_req_to_complete)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Arrow column */}
        <div style={{ width: 48, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3, padding: '0 4px' }}>
          <span style={{ fontSize: 9, fontWeight: 700, color: '#3E53E3', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Source</span>
          <span style={{ fontSize: 22, color: 'var(--color-gray-400)', lineHeight: 1 }}>→</span>
          <span style={{ fontSize: 9, fontWeight: 700, color: '#E24B4A', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Dest</span>
        </div>

        {/* Destination card */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, border: '1px solid var(--surface-border)', borderLeft: '3px solid #E24B4A', borderRadius: 6, overflow: 'hidden' }}>
          <div style={{ background: '#FDECEC', color: '#E24B4A', padding: '5px 10px', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', flexShrink: 0 }}>Destination</div>
          <div style={{ overflowX: 'auto', overflowY: 'auto', flex: 1 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={hs}>Hospital</th><th style={hs}>Dest LOC</th><th style={hs}>Dest Dept</th>
                <th style={{ ...hs, textAlign: 'right' }}>Moves</th>
                <th style={{ ...hs, textAlign: 'right' }}>%Asn</th><th style={{ ...hs, textAlign: 'right' }}>%Cmp</th>
                <th style={{ ...hs, textAlign: 'right' }}>Avg Asn</th><th style={{ ...hs, textAlign: 'right' }}>Avg Cmp</th>
              </tr></thead>
              <tbody>
                <tr style={{ fontWeight: 700, background: '#F5F7FA' }}>
                  <td style={cs} colSpan={3}>Grand Total</td>
                  <td style={{ ...cs, textAlign: 'right' }}>{fmtNum(totalMov)}</td>
                  <td style={cs} colSpan={4} />
                </tr>
                {destRows.map(r => {
                  const k = dstKey(r)
                  return (
                    <tr key={k} onClick={() => toggleDst(k)}
                      style={{ cursor: 'pointer', opacity: selDst && selDst !== k ? 0.3 : 1, background: selDst === k ? '#EEF2FF' : undefined }}>
                      <td style={cs}>{r.dest_hospital}</td><td style={cs}>{r.dest_loc}</td><td style={cs}>{r.dest_dept}</td>
                      <td style={{ ...cs, textAlign: 'right' }}>{fmtNum(r.movements)}</td>
                      <td style={{ ...cs, textAlign: 'right', ...pctBg(r.pct_target_assigned) }}>{fmtPct(r.pct_target_assigned)}</td>
                      <td style={{ ...cs, textAlign: 'right', ...pctBg(r.pct_target_complete) }}>{fmtPct(r.pct_target_complete)}</td>
                      <td style={{ ...cs, textAlign: 'right', ...durTxt(r.avg_req_to_assigned, TARGET_ASSIGNED) }}>{fmtMin(r.avg_req_to_assigned)}</td>
                      <td style={{ ...cs, textAlign: 'right', ...durTxt(r.avg_req_to_complete, TARGET_COMPLETE) }}>{fmtMin(r.avg_req_to_complete)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>

      </div>
    </div>
  )
}

// ── TAB 3: Trends ─────────────────────────────────────────────────────────────

function TrendsTab({ qs: q, baseQS }) {
  const [trend,   setTrend]   = useState([])
  const [byDept,  setByDept]  = useState([])
  const [ldTrend, setLdTrend] = useState(true)
  const [ldDept,  setLdDept]  = useState(true)
  const [err,     setErr]     = useState(null)

  useEffect(() => {
    const ac = new AbortController()
    setLdTrend(true); setErr(null)
    apiFetch(`/api/ipbedplacement/trend${q}`, ac.signal)
      .then(d => { setTrend(d); setLdTrend(false) })
      .catch(e => { if (e.name !== 'AbortError') { setErr(e.message); setLdTrend(false) } })
    return () => ac.abort()
  }, [q])

  useEffect(() => {
    const ac = new AbortController()
    setLdDept(true)
    apiFetch(`/api/ipbedplacement/trend${baseQS}&group_by=source_dept`, ac.signal)
      .then(d => { setByDept(d); setLdDept(false) })
      .catch(e => { if (e.name !== 'AbortError') setLdDept(false) })
    return () => ac.abort()
  }, [baseQS])

  const months = [...new Set(byDept.map(r => r.month))].sort()
  const deptVol = {}
  for (const r of byDept) deptVol[r.group_col] = (deptVol[r.group_col] ?? 0) + (r.n ?? 0)
  const topDepts = Object.entries(deptVol).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([d]) => d)
  const heatMap = {}
  for (const r of byDept) {
    if (!heatMap[r.group_col]) heatMap[r.group_col] = {}
    heatMap[r.group_col][r.month] = r.avg_req_to_complete
  }

  if (ldTrend) return <Spinner />
  if (err)     return <ErrMsg msg={err} />

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div style={CARD}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Monthly Trend</div>
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={trend} margin={{ top: 4, right: 48, bottom: 8, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#F0F0F0" />
            <XAxis dataKey="month" tick={{ fontSize: 10 }} />
            <YAxis yAxisId="l" tick={{ fontSize: 10 }} width={38} label={{ value: 'Minutes', angle: -90, position: 'insideLeft', fontSize: 10 }} />
            <YAxis yAxisId="r" orientation="right" domain={[0, 100]} tick={{ fontSize: 10 }} width={32} tickFormatter={v => `${v}%`} />
            <Tooltip contentStyle={{ fontSize: 11 }} formatter={(v, n) => n.includes('%') ? fmtPct(v) : `${Math.round(v ?? 0)} min`} />
            <Legend wrapperStyle={{ fontSize: 10 }} />
            <Bar yAxisId="l" dataKey="n" fill="#E8EEF8" name="Volume" />
            <Line yAxisId="l" type="monotone" dataKey="median_req_to_complete" stroke="#378ADD" strokeWidth={2} dot={false} name="Median Req→Complete" />
            <Line yAxisId="l" type="monotone" dataKey="median_req_to_assigned" stroke="#4CAF50" strokeWidth={2} dot={false} name="Median Req→Assigned" />
            <Line yAxisId="r" type="monotone" dataKey="pct_within_target_complete" stroke="#E24B4A" strokeWidth={2} strokeDasharray="5 4" dot={false} name="% Within Target Complete" />
            <ReferenceLine yAxisId="l" y={TARGET_COMPLETE} stroke="#378ADD" strokeDasharray="4 3" strokeOpacity={0.4} label={{ value: '120m', fontSize: 9, fill: '#378ADD' }} />
            <ReferenceLine yAxisId="l" y={TARGET_ASSIGNED} stroke="#4CAF50" strokeDasharray="4 3" strokeOpacity={0.4} label={{ value: '30m', fontSize: 9, fill: '#4CAF50' }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div style={{ ...CARD, overflowX: 'auto' }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2 }}>Source Dept — Avg Req→Complete by Month</div>
        <div style={{ fontSize: 10, color: 'var(--color-gray-500)', marginBottom: 8 }}>≤60 dark green · 61–90 green · 91–120 amber · 121–180 orange · &gt;180 red</div>
        {ldDept ? <Spinner /> : (
          <table style={{ borderCollapse: 'collapse', fontSize: 11, whiteSpace: 'nowrap' }}>
            <thead>
              <tr>
                <th style={{ padding: '3px 8px', textAlign: 'left', background: '#F5F7FA', borderBottom: '1px solid #E0E0E0', fontWeight: 600 }}>Source Dept</th>
                {months.map(m => <th key={m} style={{ padding: '3px 8px', textAlign: 'center', background: '#F5F7FA', borderBottom: '1px solid #E0E0E0', fontWeight: 600 }}>{m}</th>)}
              </tr>
            </thead>
            <tbody>
              {topDepts.map(dept => (
                <tr key={dept}>
                  <td style={{ padding: '3px 8px', borderBottom: '1px solid #F0F0F0', fontWeight: 500, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }}>{dept}</td>
                  {months.map(m => {
                    const v = heatMap[dept]?.[m]
                    return <td key={m} style={{ padding: '3px 10px', textAlign: 'center', borderBottom: '1px solid #F0F0F0', ...heatStyle(v) }}>{v != null ? Math.round(v) : '—'}</td>
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ── TAB 4: Time of Day ────────────────────────────────────────────────────────

function HourChart({ data, title, loading }) {
  if (loading) return <Spinner />
  const { data: cd, groups } = pivotHours(data)
  return (
    <div style={CARD}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>{title}</div>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={cd} margin={{ top: 4, right: 16, bottom: 8, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#F0F0F0" />
          <XAxis dataKey="hour" tickFormatter={hourLabel} tick={{ fontSize: 10 }} />
          <YAxis tick={{ fontSize: 10 }} width={34} />
          <Tooltip labelFormatter={hourLabel} contentStyle={{ fontSize: 11 }} />
          <Legend wrapperStyle={{ fontSize: 10 }} />
          {groups.length
            ? groups.map((g, i) => <Bar key={g} dataKey={g} stackId="a" fill={LOC_COLORS[i % LOC_COLORS.length]} />)
            : <Bar dataKey="n" fill="#378ADD" />
          }
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function TimeOfDayTab({ qs: q }) {
  const [hourReq, setHourReq] = useState([])
  const [hourCmp, setHourCmp] = useState([])
  const [ldReq,   setLdReq]   = useState(true)
  const [ldCmp,   setLdCmp]   = useState(true)

  useEffect(() => {
    const ac = new AbortController()
    setLdReq(true)
    apiFetch(`/api/ipbedplacement/by-hour${q}&time_field=request&color_by=dest_loc`, ac.signal)
      .then(d => { setHourReq(d); setLdReq(false) })
      .catch(e => { if (e.name !== 'AbortError') setLdReq(false) })
    return () => ac.abort()
  }, [q])

  useEffect(() => {
    const ac = new AbortController()
    setLdCmp(true)
    apiFetch(`/api/ipbedplacement/by-hour${q}&time_field=complete&color_by=source_loc`, ac.signal)
      .then(d => { setHourCmp(d); setLdCmp(false) })
      .catch(e => { if (e.name !== 'AbortError') setLdCmp(false) })
    return () => ac.abort()
  }, [q])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <HourChart data={hourReq} title="Bed Requests by Hour of Day (stacked by Destination LOC)" loading={ldReq} />
      <HourChart data={hourCmp} title="Placements Completed by Hour of Day (stacked by Source LOC)" loading={ldCmp} />
    </div>
  )
}

// ── TAB 5: EVS ────────────────────────────────────────────────────────────────

function EVSTab({ qs: q, baseQS }) {
  const [evs,    setEvs]    = useState(null)
  const [distEvs, setDistEvs] = useState([])
  const [ldEvs,  setLdEvs]  = useState(true)
  const [ldDist, setLdDist] = useState(true)
  const [err,    setErr]    = useState(null)

  // Collapsible hierarchy: expanded hospitals set, expanded locs set
  const [expHosp, setExpHosp] = useState(new Set())
  const [expLoc,  setExpLoc]  = useState(new Set())

  useEffect(() => {
    const ac = new AbortController()
    setLdEvs(true); setErr(null)
    apiFetch(`/api/ipbedplacement/evs${q}`, ac.signal)
      .then(d => { setEvs(d); setLdEvs(false) })
      .catch(e => { if (e.name !== 'AbortError') { setErr(e.message); setLdEvs(false) } })
    return () => ac.abort()
  }, [q])

  useEffect(() => {
    const ac = new AbortController()
    setLdDist(true)
    apiFetch(`/api/ipbedplacement/distribution${baseQS}&metric=evs`, ac.signal)
      .then(d => { setDistEvs(d); setLdDist(false) })
      .catch(e => { if (e.name !== 'AbortError') setLdDist(false) })
    return () => ac.abort()
  }, [baseQS])

  if (ldEvs) return <Spinner />
  if (err)   return <ErrMsg msg={err} />

  const sys    = evs?.system  ?? {}
  const byDest = evs?.by_dest ?? []
  const hourly = evs?.hourly  ?? []

  // Build hospital → loc → dept hierarchy
  const hospMap = {}
  for (const r of byDest) {
    if (!hospMap[r.dest_hospital]) hospMap[r.dest_hospital] = {}
    if (!hospMap[r.dest_hospital][r.dest_loc]) hospMap[r.dest_hospital][r.dest_loc] = []
    hospMap[r.dest_hospital][r.dest_loc].push(r)
  }

  // Aggregate a list of rows into summary
  function agg(rows) {
    const n   = rows.reduce((s, r) => s + r.evs_requests, 0)
    const wt  = rows.reduce((s, r) => s + r.evs_within_target, 0)
    const sRc = rows.reduce((s, r) => s + (r.avg_evs_req_to_complete ?? 0) * r.evs_requests, 0)
    const sRa = rows.reduce((s, r) => s + (r.avg_evs_req_to_assigned ?? 0) * r.evs_requests, 0)
    const sAi = rows.reduce((s, r) => s + (r.avg_evs_assigned_to_inprogress ?? 0) * r.evs_requests, 0)
    const sIc = rows.reduce((s, r) => s + (r.avg_evs_inprogress_to_completed ?? 0) * r.evs_requests, 0)
    return {
      evs_requests: n,
      evs_within_target: wt,
      pct_within_target: n ? wt / n * 100 : null,
      avg_evs_req_to_complete:          n ? sRc / n : null,
      avg_evs_req_to_assigned:          n ? sRa / n : null,
      avg_evs_assigned_to_inprogress:   n ? sAi / n : null,
      avg_evs_inprogress_to_completed:  n ? sIc / n : null,
    }
  }

  const hs = { padding: '4px 8px', fontSize: 11, fontWeight: 600, background: '#F5F7FA', borderBottom: '1px solid #E0E0E0', whiteSpace: 'nowrap' }
  const cs = (extra = {}) => ({ padding: '4px 8px', fontSize: 12, borderBottom: '1px solid #F5F5F5', ...extra })

  function PctCell({ v }) {
    return <td style={cs({ textAlign: 'right', ...pctBg(v) })}>{fmtPct(v)}</td>
  }
  function DurCell({ v }) {
    return <td style={cs({ textAlign: 'right', ...durTxt(v, TARGET_EVS) })}>{fmtMin(v)}</td>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {/* Stat cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.75rem' }}>
        <StatCard label="Total EVS Requests"      value={fmtNum(sys.total_evs_requests)} />
        <StatCard label="Median EVS Req→Complete"  value={fmtMin(sys.median_evs)} valueColor={durCardColor(sys.median_evs, TARGET_EVS)} />
        <StatCard label="% Within Target (60m)"    value={fmtPct(sys.pct_within_target_evs)} valueColor={pctCardColor(sys.pct_within_target_evs)} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: '0.75rem' }}>
        {/* EVS hierarchical table */}
        <div style={{ ...CARD, overflowX: 'auto' }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>EVS by Destination</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...hs, width: 24 }} />
                <th style={hs}>Dest Hospital / LOC / Dept</th>
                <th style={{ ...hs, textAlign: 'right' }}>EVS Req</th>
                <th style={{ ...hs, textAlign: 'right' }}># Target</th>
                <th style={{ ...hs, textAlign: 'right' }}>% Target</th>
                <th style={{ ...hs, textAlign: 'right' }}>Req→Cmp</th>
                <th style={{ ...hs, textAlign: 'right' }}>Req→Asn</th>
                <th style={{ ...hs, textAlign: 'right' }}>Asn→InPrg</th>
                <th style={{ ...hs, textAlign: 'right' }}>InPrg→Cmp</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(hospMap).map(([hosp, locMap]) => {
                const hospRows   = Object.values(locMap).flat()
                const hospAgg    = agg(hospRows)
                const hospExpand = expHosp.has(hosp)
                return [
                  <tr key={hosp} onClick={() => setExpHosp(s => { const n = new Set(s); n.has(hosp) ? n.delete(hosp) : n.add(hosp); return n })}
                    style={{ cursor: 'pointer', background: '#F0F4FF', fontWeight: 600 }}>
                    <td style={cs({ textAlign: 'center', fontSize: 10 })}>{hospExpand ? '▼' : '▶'}</td>
                    <td style={cs()}>{hosp}</td>
                    <td style={cs({ textAlign: 'right' })}>{fmtNum(hospAgg.evs_requests)}</td>
                    <td style={cs({ textAlign: 'right' })}>{fmtNum(hospAgg.evs_within_target)}</td>
                    <PctCell v={hospAgg.pct_within_target} />
                    <DurCell v={hospAgg.avg_evs_req_to_complete} />
                    <DurCell v={hospAgg.avg_evs_req_to_assigned} />
                    <DurCell v={hospAgg.avg_evs_assigned_to_inprogress} />
                    <DurCell v={hospAgg.avg_evs_inprogress_to_completed} />
                  </tr>,
                  ...(!hospExpand ? [] : Object.entries(locMap).map(([loc, deptRows]) => {
                    const locAgg    = agg(deptRows)
                    const locKey    = `${hosp}||${loc}`
                    const locExpand = expLoc.has(locKey)
                    return [
                      <tr key={locKey} onClick={e => { e.stopPropagation(); setExpLoc(s => { const n = new Set(s); n.has(locKey) ? n.delete(locKey) : n.add(locKey); return n }) }}
                        style={{ cursor: 'pointer', background: '#F8F9FE' }}>
                        <td style={cs({ textAlign: 'center', fontSize: 10 })}>{locExpand ? '▼' : '▶'}</td>
                        <td style={cs({ paddingLeft: 20 })}>{loc}</td>
                        <td style={cs({ textAlign: 'right' })}>{fmtNum(locAgg.evs_requests)}</td>
                        <td style={cs({ textAlign: 'right' })}>{fmtNum(locAgg.evs_within_target)}</td>
                        <PctCell v={locAgg.pct_within_target} />
                        <DurCell v={locAgg.avg_evs_req_to_complete} />
                        <DurCell v={locAgg.avg_evs_req_to_assigned} />
                        <DurCell v={locAgg.avg_evs_assigned_to_inprogress} />
                        <DurCell v={locAgg.avg_evs_inprogress_to_completed} />
                      </tr>,
                      ...(!locExpand ? [] : deptRows.map(r => (
                        <tr key={r.dest_dept}>
                          <td style={cs()} />
                          <td style={cs({ paddingLeft: 36 })}>{r.dest_dept}</td>
                          <td style={cs({ textAlign: 'right' })}>{fmtNum(r.evs_requests)}</td>
                          <td style={cs({ textAlign: 'right' })}>{fmtNum(r.evs_within_target)}</td>
                          <PctCell v={r.pct_within_target} />
                          <DurCell v={r.avg_evs_req_to_complete} />
                          <DurCell v={r.avg_evs_req_to_assigned} />
                          <DurCell v={r.avg_evs_assigned_to_inprogress} />
                          <DurCell v={r.avg_evs_inprogress_to_completed} />
                        </tr>
                      ))),
                    ]
                  })),
                ]
              })}
            </tbody>
          </table>
        </div>

        {/* EVS % within target by hour — line chart */}
        <div style={CARD}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>
            EVS Request to Complete by Time of Day | % Within Target
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={hourly} margin={{ top: 4, right: 16, bottom: 8, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#F0F0F0" />
              <XAxis dataKey="hour" tickFormatter={hourLabel} tick={{ fontSize: 10 }} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} width={34} tickFormatter={v => `${v}%`} />
              <Tooltip labelFormatter={hourLabel} formatter={v => fmtPct(v)} contentStyle={{ fontSize: 11 }} />
              <ReferenceLine y={75} stroke="#9E9E9E" strokeDasharray="4 3" strokeOpacity={0.5} label={{ value: '75%', fontSize: 9, fill: '#9E9E9E' }} />
              <Line type="monotone" dataKey="pct_within_target" stroke="#FF9800" strokeWidth={2} dot={{ r: 3 }} name="% Within Target (60m)" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* EVS distribution */}
      <div style={CARD}>
        <DistChart data={distEvs} title="EVS Request to Complete Distribution" target={TARGET_EVS} loading={ldDist} />
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function IPBedPlacement() {
  const { from: defFrom, to: defTo } = defaultDates()
  const [from,       setFrom]       = useState(defFrom)
  const [to,         setTo]         = useState(defTo)
  const [hospital,   setHospital]   = useState('')
  const [eventType,  setEventType]  = useState('')
  const [activeTab,  setActiveTab]  = useState('summary')
  const [filterOpts, setFilterOpts] = useState({ hospitals: [], event_types: [] })

  const dFrom = useDebounced(from)
  const dTo   = useDebounced(to)

  // Base QS: date + hospital only (no event_type) — used for by-hospital, distribution, trend-by-dept
  const baseQS = qs({ from: dFrom, to: dTo, hospital: hospital || undefined })
  // Full QS with all filters
  const fullQS = qs({ from: dFrom, to: dTo, hospital: hospital || undefined, event_type: eventType || undefined })

  useEffect(() => {
    if (!dFrom || !dTo) return
    const ac = new AbortController()
    apiFetch(`/api/ipbedplacement/filter-options?from=${dFrom}&to=${dTo}`, ac.signal)
      .then(d => setFilterOpts(d))
      .catch(() => {})
    return () => ac.abort()
  }, [dFrom, dTo])

  const reset = () => { setHospital(''); setEventType(''); setFrom(defFrom); setTo(defTo) }

  const sel = {
    padding: '5px 10px', fontSize: 12,
    border: '1px solid var(--surface-border)',
    borderRadius: 'var(--radius-md)',
    background: 'var(--surface-card)',
    color: 'var(--color-gray-700)',
    cursor: 'pointer',
  }

  return (
    <div style={{ padding: 'var(--space-5) var(--space-6)' }}>
      {/* Header */}
      <h1 style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: 'var(--color-gray-900)', marginBottom: 2 }}>
        Bed Placement
      </h1>
      <p style={{ fontSize: 11, color: 'var(--color-gray-500)', marginBottom: 12 }}>
        Req to Assign Target: {TARGET_ASSIGNED} Min. — Req to Complete Target: {TARGET_COMPLETE} Min.
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
          {filterOpts.hospitals.map(h => <option key={h} value={h}>{h}</option>)}
        </select>
        <select value={eventType} onChange={e => setEventType(e.target.value)} style={sel}>
          <option value="">All Event Types</option>
          {filterOpts.event_types.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <button onClick={reset} style={{ fontSize: 11, color: 'var(--color-gray-500)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>
          Reset Filters
        </button>
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 2, borderBottom: '2px solid var(--surface-border)', marginBottom: 16 }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setActiveTab(t.id)}
            style={{
              padding: '7px 16px', fontSize: 13, fontWeight: 500,
              border: 'none', background: 'none', cursor: 'pointer',
              borderBottom: activeTab === t.id ? '2px solid #3E53E3' : '2px solid transparent',
              color: activeTab === t.id ? '#3E53E3' : 'var(--color-gray-600)',
              marginBottom: -2,
            }}>
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'summary'     && <SummaryTab   qs={fullQS}  baseQS={baseQS} />}
      {activeTab === 'detail'      && <DetailTab     qs={fullQS}  hospital={hospital} />}
      {activeTab === 'trend'       && <TrendsTab     qs={fullQS}  baseQS={baseQS} />}
      {activeTab === 'time_of_day' && <TimeOfDayTab  qs={fullQS} />}
      {activeTab === 'evs'         && <EVSTab        qs={fullQS}  baseQS={baseQS} />}
    </div>
  )
}

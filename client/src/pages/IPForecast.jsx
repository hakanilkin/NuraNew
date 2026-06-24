import { useState, useEffect, useRef } from 'react'

// ── Constants ──────────────────────────────────────────────────────────────────

const DEMAND_KEYS   = ['ed', 'or', 'step_down', 'transfer']
const DEMAND_LABELS = { ed: 'ED', or: 'OR', step_down: 'Step-down', transfer: 'Xfer' }

const TYPE_STYLE = {
  'Critical Care': { bg: '#FFEBEE', color: '#C62828' },
  'Acute':         { bg: '#EEF0FD', color: '#3E53E3' },
  'Observation':   { bg: '#F3E5F5', color: '#7B1FA2' },
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function compute(unit) {
  const open_beds         = unit.staffed_beds - unit.midnight_census
  const total_demand      = DEMAND_KEYS.reduce((s, k) => s + unit.demand[k], 0)
  const discharges_needed = Math.max(0, total_demand - open_beds)
  const staffed_beds_needed = Math.max(0, total_demand - unit.staffed_beds)
  const occ_pct           = unit.staffed_beds > 0 ? (unit.midnight_census / unit.staffed_beds) * 100 : 0
  return { open_beds, total_demand, discharges_needed, staffed_beds_needed, occ_pct }
}

function occColor(pct) {
  if (pct >= 95) return '#D32F2F'
  if (pct >= 85) return '#E65100'
  return '#2E7D32'
}

function openColor(n) {
  if (n <= 2) return '#D32F2F'
  if (n <= 4) return '#E65100'
  return 'var(--color-gray-900)'
}

function dischBadge(n) {
  if (n === 0) return { bg: '#E8F5E9', color: '#2E7D32' }
  if (n <= 3)  return { bg: '#FFF8E1', color: '#E65100' }
  return { bg: '#FFEBEE', color: '#C62828' }
}

// ── Popover ────────────────────────────────────────────────────────────────────

function DetailContent({ unit, field }) {
  const detail = unit.demand.detail
  const keys   = field === 'total' ? DEMAND_KEYS : [field]

  return (
    <>
      {keys.map((key, i) => {
        const d = detail[key]
        if (!d) return null
        return (
          <div key={key} style={{ marginBottom: i < keys.length - 1 ? 10 : 0 }}>
            {field === 'total' && (
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-gray-500)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>
                {DEMAND_LABELS[key]}
              </div>
            )}
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-gray-800)', marginBottom: 3 }}>
              Source: {d.source}
            </div>
            {d.note && (
              <div style={{ fontSize: 11, color: 'var(--color-gray-600)', lineHeight: 1.4 }}>{d.note}</div>
            )}
            {d.cases && (
              <ul style={{ margin: '3px 0 0', paddingLeft: 16 }}>
                {d.cases.map((c, ci) => (
                  <li key={ci} style={{ fontSize: 11, color: 'var(--color-gray-600)', marginBottom: 2, lineHeight: 1.4 }}>{c}</li>
                ))}
              </ul>
            )}
          </div>
        )
      })}
    </>
  )
}

function Popover({ unit, field, anchorRect, onClose }) {
  const ref = useRef(null)
  const PW  = 320

  const rawLeft  = anchorRect.left + anchorRect.width / 2 - PW / 2
  const left     = Math.max(8, Math.min(rawLeft, (typeof window !== 'undefined' ? window.innerWidth : 1200) - PW - 8))
  const top      = anchorRect.bottom + 8
  const arrowOff = Math.max(10, Math.min(anchorRect.left + anchorRect.width / 2 - left, PW - 10))

  useEffect(() => {
    function handler(e) {
      if (ref.current && !ref.current.contains(e.target)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  return (
    <div
      ref={ref}
      onClick={e => e.stopPropagation()}
      style={{
        position: 'fixed', top, left, width: PW, zIndex: 1000,
        background: '#fff',
        border: '0.5px solid rgba(0,0,0,0.15)',
        borderRadius: 8,
        padding: '10px 14px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
      }}
    >
      {/* Caret — outline layer */}
      <div style={{
        position: 'absolute', top: -6, left: arrowOff,
        transform: 'translateX(-50%)',
        width: 0, height: 0,
        borderLeft: '6px solid transparent',
        borderRight: '6px solid transparent',
        borderBottom: '6px solid rgba(0,0,0,0.12)',
      }} />
      {/* Caret — fill layer */}
      <div style={{
        position: 'absolute', top: -5, left: arrowOff,
        transform: 'translateX(-50%)',
        width: 0, height: 0,
        borderLeft: '6px solid transparent',
        borderRight: '6px solid transparent',
        borderBottom: '6px solid #fff',
      }} />

      {/* Header */}
      <div style={{ fontSize: 11, fontWeight: 700, color: '#3E53E3', marginBottom: 7, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {field === 'total' ? 'All demand sources' : DEMAND_LABELS[field]}
        <span style={{ marginLeft: 6, color: 'var(--color-gray-400)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
          · {unit.name}
        </span>
      </div>
      <DetailContent unit={unit} field={field} />
    </div>
  )
}

// ── Stat card ──────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, valueColor, accent }) {
  return (
    <div style={{
      background: 'var(--surface-card)',
      border: '1px solid var(--surface-border)',
      borderLeft: accent ? `3px solid ${accent}` : undefined,
      borderRadius: 'var(--radius-lg)',
      padding: '0.75rem 1rem',
    }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-gray-500)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.1, color: valueColor ?? 'var(--color-gray-900)' }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 11, color: 'var(--color-gray-500)', marginTop: 3 }}>{sub}</div>}
    </div>
  )
}

// ── Badge ──────────────────────────────────────────────────────────────────────

function Badge({ n, style: extra }) {
  return (
    <span style={{
      display: 'inline-block', padding: '2px 10px', borderRadius: 12,
      fontSize: 13, fontWeight: 700, ...extra,
    }}>{n}</span>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function IPForecast() {
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(true)
  const [err,     setErr]     = useState(null)
  const [popover, setPopover] = useState(null) // { unit, field, anchorRect }

  useEffect(() => {
    fetch('/api/atlas/forecast/morning-huddle')
      .then(r => { if (!r.ok) throw new Error(r.status); return r.json() })
      .then(d => { setData(d); setLoading(false) })
      .catch(e => { setErr(e.message); setLoading(false) })
  }, [])

  function handleCellClick(e, unit, field) {
    e.stopPropagation()
    const rect = e.currentTarget.getBoundingClientRect()
    setPopover(prev =>
      prev?.unit.name === unit.name && prev?.field === field
        ? null
        : { unit, field, anchorRect: rect }
    )
  }

  if (loading) return <div style={{ padding: '2rem', color: 'var(--color-gray-500)', fontSize: 13 }}>Loading…</div>
  if (err)     return <div style={{ padding: '2rem', color: '#C62828', fontSize: 13 }}>Error loading forecast data: {err}</div>
  if (!data)   return null

  // Enrich units with computed fields and sort by discharges_needed desc
  const units = data.units
    .map(u => ({ ...u, ...compute(u) }))
    .sort((a, b) => b.discharges_needed - a.discharges_needed)

  // System totals
  const totStaffed = units.reduce((s, u) => s + u.staffed_beds, 0)
  const totCensus  = units.reduce((s, u) => s + u.midnight_census, 0)
  const totOpen    = units.reduce((s, u) => s + u.open_beds, 0)
  const totED      = units.reduce((s, u) => s + u.demand.ed, 0)
  const totOR      = units.reduce((s, u) => s + u.demand.or, 0)
  const totSD      = units.reduce((s, u) => s + u.demand.step_down, 0)
  const totXfer    = units.reduce((s, u) => s + u.demand.transfer, 0)
  const totDemand  = units.reduce((s, u) => s + u.total_demand, 0)
  const totDisch   = units.reduce((s, u) => s + u.discharges_needed, 0)
  const totBeds    = units.reduce((s, u) => s + u.staffed_beds_needed, 0)
  const sysOccPct  = totStaffed > 0 ? (totCensus / totStaffed) * 100 : 0

  // Style helpers
  const TH = (extra = {}) => ({
    padding: '6px 10px', fontSize: 10, fontWeight: 600,
    color: 'var(--color-gray-600)', textAlign: 'center',
    whiteSpace: 'nowrap', borderBottom: '1px solid var(--surface-border)',
    background: 'var(--surface-card)',
    ...extra,
  })
  const TD = (extra = {}) => ({
    padding: '8px 10px', fontSize: 12, textAlign: 'center',
    borderBottom: '1px solid #F5F5F5', verticalAlign: 'middle',
    ...extra,
  })
  const DEMAND_BG  = '#F0F2FC'
  const ACTION_BG  = '#FFF8F8'
  const DEMAND_HDR = '#E8EBFA'
  const ACTION_HDR = '#FFE8E8'

  return (
    <div style={{ padding: 'var(--space-5) var(--space-6)' }} onClick={() => setPopover(null)}>
      <h1 style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: 'var(--color-gray-900)', marginBottom: 2 }}>
        Morning huddle — 8am to 2pm demand
      </h1>
      <p style={{ fontSize: 11, color: 'var(--color-gray-500)', marginBottom: 16 }}>
        {data.hospital} · {data.date} · Based on {data.data_as_of}
      </p>

      {/* ── Stat cards ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.75rem', marginBottom: 12 }}>
        <StatCard
          label="Staffed beds"
          value={totStaffed}
          sub={`${units.length} units`}
        />
        <StatCard
          label="Midnight census"
          value={`${totCensus} / ${totStaffed}`}
          sub={`${sysOccPct.toFixed(0)}% occupied · ${totOpen} open`}
          valueColor={occColor(sysOccPct)}
        />
        <StatCard
          label="Total demand 8a–2p"
          value={totDemand}
          sub={`ED ${totED} · OR ${totOR} · Step-down ${totSD} · Xfer ${totXfer}`}
          accent="#3E53E3"
        />
        <StatCard
          label="Discharges needed"
          value={totDisch}
          sub="to absorb projected demand"
          valueColor={totDisch > 0 ? '#C62828' : '#2E7D32'}
          accent={totDisch > 0 ? '#C62828' : '#2E7D32'}
        />
      </div>

      {/* ── Info note ── */}
      <div style={{
        background: '#EEF0FD', border: '1px solid #C5CAF5', borderRadius: 6,
        padding: '8px 12px', marginBottom: 16, fontSize: 11, color: '#3E53E3', lineHeight: 1.5,
      }}>
        Projected demand based on midnight data: OR from scheduled cases, ED from historical patterns + overnight census,
        step-downs from current ICU/PCU status, transfers from pending requests.{' '}
        <strong>Discharges needed = demand that exceeds currently available beds.</strong>
        {' '}Click any demand cell for source detail.
      </div>

      {/* ── Table ── */}
      <div style={{ background: 'var(--surface-card)', border: '1px solid var(--surface-border)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th rowSpan={2} style={{ ...TH(), textAlign: 'left', width: 160, borderRight: '1px solid var(--surface-border)' }}>Unit</th>
                <th rowSpan={2} style={TH()}>Midnight census</th>
                <th rowSpan={2} style={{ ...TH(), borderRight: '1px solid #C5CAF5' }}>Open beds</th>
                <th colSpan={5} style={{ ...TH(), background: DEMAND_HDR, borderBottom: '1px solid #C5CAF5', color: '#3E53E3' }}>
                  Projected demand · 8am–2pm
                </th>
                <th colSpan={2} style={{ ...TH(), background: ACTION_HDR, borderBottom: '1px solid #F5C5C5', color: '#C62828' }}>
                  Action required
                </th>
              </tr>
              <tr>
                {['ED', 'OR', 'Step-down', 'Xfer', 'Total demand'].map((col, i) => (
                  <th key={col} style={{ ...TH(), background: DEMAND_HDR, borderRight: i === 4 ? '1px solid #C5CAF5' : undefined }}>
                    {col}
                  </th>
                ))}
                <th style={{ ...TH(), background: ACTION_HDR }}>Discharges needed</th>
                <th style={{ ...TH(), background: ACTION_HDR }}>Staffed beds needed</th>
              </tr>
            </thead>
            <tbody>
              {units.map(unit => {
                const db = dischBadge(unit.discharges_needed)

                return (
                  <tr key={unit.name} style={{ transition: 'background 120ms' }}
                    onMouseEnter={e => e.currentTarget.style.background = '#FAFAFA'}
                    onMouseLeave={e => e.currentTarget.style.background = ''}
                  >
                    {/* Unit cell */}
                    <td style={{ ...TD(), textAlign: 'left', borderRight: '1px solid var(--surface-border)' }}>
                      <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--color-gray-900)' }}>{unit.name}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 3 }}>
                        <span style={{
                          fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3,
                          background: TYPE_STYLE[unit.type]?.bg ?? '#F5F5F5',
                          color: TYPE_STYLE[unit.type]?.color ?? '#555',
                          textTransform: 'uppercase', letterSpacing: '0.05em',
                        }}>{unit.type}</span>
                        <span style={{ fontSize: 10, color: 'var(--color-gray-500)' }}>{unit.staffed_beds} beds</span>
                      </div>
                    </td>

                    {/* Midnight census */}
                    <td style={TD()}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>
                        {unit.midnight_census}
                        <span style={{ fontWeight: 400, color: 'var(--color-gray-400)', fontSize: 11 }}> / {unit.staffed_beds}</span>
                      </div>
                      <div style={{ width: 64, height: 4, background: '#E0E0E0', borderRadius: 2, margin: '4px auto' }}>
                        <div style={{ height: '100%', width: `${Math.min(unit.occ_pct, 100)}%`, background: occColor(unit.occ_pct), borderRadius: 2 }} />
                      </div>
                      <div style={{ fontSize: 10, color: occColor(unit.occ_pct), fontWeight: 600 }}>
                        {unit.occ_pct.toFixed(0)}%
                      </div>
                    </td>

                    {/* Open beds */}
                    <td style={{ ...TD(), borderRight: '1px solid #C5CAF5' }}>
                      <span style={{ fontSize: 20, fontWeight: 700, color: openColor(unit.open_beds) }}>
                        {unit.open_beds}
                      </span>
                    </td>

                    {/* Individual demand cells — clickable */}
                    {DEMAND_KEYS.map(key => {
                      const val      = unit.demand[key]
                      const isActive = popover?.unit.name === unit.name && popover?.field === key
                      return (
                        <td
                          key={key}
                          onClick={e => handleCellClick(e, unit, key)}
                          style={{
                            ...TD(),
                            background: isActive ? '#DDE2F8' : DEMAND_BG,
                            cursor: 'pointer',
                            fontWeight: val > 0 ? 600 : 400,
                            color: val > 0 ? 'var(--color-gray-900)' : 'var(--color-gray-400)',
                            outline: isActive ? '2px solid #3E53E3' : undefined,
                            outlineOffset: -2,
                            userSelect: 'none',
                          }}
                        >
                          {val}
                        </td>
                      )
                    })}

                    {/* Total demand — clickable */}
                    {(() => {
                      const isActive = popover?.unit.name === unit.name && popover?.field === 'total'
                      return (
                        <td
                          onClick={e => handleCellClick(e, unit, 'total')}
                          style={{
                            ...TD(),
                            background: isActive ? '#DDE2F8' : DEMAND_BG,
                            borderRight: '1px solid #C5CAF5',
                            cursor: 'pointer', fontWeight: 700,
                            outline: isActive ? '2px solid #3E53E3' : undefined,
                            outlineOffset: -2,
                            userSelect: 'none',
                          }}
                        >
                          {unit.total_demand}
                        </td>
                      )
                    })()}

                    {/* Discharges needed */}
                    <td style={{ ...TD(), background: ACTION_BG }}>
                      <Badge n={unit.discharges_needed} style={{ background: db.bg, color: db.color }} />
                    </td>

                    {/* Staffed beds needed */}
                    <td style={{ ...TD(), background: ACTION_BG }}>
                      <Badge n={unit.staffed_beds_needed} style={{ background: '#E8F0FD', color: '#3E53E3' }} />
                    </td>
                  </tr>
                )
              })}

              {/* Totals row */}
              <tr style={{ background: '#F5F7FA', fontWeight: 700 }}>
                <td style={{ ...TD(), textAlign: 'left', fontWeight: 700, borderRight: '1px solid var(--surface-border)', fontSize: 13 }}>
                  System total
                </td>
                <td style={TD()}>
                  <div style={{ fontWeight: 700 }}>
                    {totCensus}
                    <span style={{ fontWeight: 400, color: 'var(--color-gray-400)', fontSize: 11 }}> / {totStaffed}</span>
                  </div>
                  <div style={{ fontSize: 10, color: occColor(sysOccPct), fontWeight: 600, marginTop: 2 }}>
                    {sysOccPct.toFixed(0)}%
                  </div>
                </td>
                <td style={{ ...TD(), fontWeight: 700, borderRight: '1px solid #C5CAF5' }}>{totOpen}</td>
                <td style={{ ...TD(), background: DEMAND_HDR, fontWeight: 600 }}>{totED}</td>
                <td style={{ ...TD(), background: DEMAND_HDR, fontWeight: 600 }}>{totOR}</td>
                <td style={{ ...TD(), background: DEMAND_HDR, fontWeight: 600 }}>{totSD}</td>
                <td style={{ ...TD(), background: DEMAND_HDR, fontWeight: 600 }}>{totXfer}</td>
                <td style={{ ...TD(), background: DEMAND_HDR, fontWeight: 700, borderRight: '1px solid #C5CAF5' }}>{totDemand}</td>
                <td style={{ ...TD(), background: ACTION_HDR }}>
                  <Badge n={totDisch} style={dischBadge(totDisch)} />
                </td>
                <td style={{ ...TD(), background: ACTION_HDR }}>
                  <Badge n={totBeds} style={{ background: '#E8F0FD', color: '#3E53E3' }} />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Popover */}
      {popover && (
        <Popover
          unit={popover.unit}
          field={popover.field}
          anchorRect={popover.anchorRect}
          onClose={() => setPopover(null)}
        />
      )}
    </div>
  )
}

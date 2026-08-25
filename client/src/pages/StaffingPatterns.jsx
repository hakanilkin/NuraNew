import { useState, useEffect, useMemo } from 'react'
import { AlertCircle } from 'lucide-react'

/* ─── Staffing Patterns (StaffingAlignment.md rev 2) ──────────────────────────
   The structural half: over a trailing quarter, does the staffing template fit
   the demand pattern at all? Staffing is planned as a static rectangle — all
   rooms, one shift, five days — and demand has a shape by hour and day. The gap
   leaks money in both directions at once, and the two names for it are the
   product: idle staffed hours, and overtime exposure.

   No forward view here. Flexing a specific Tuesday is a weekly decision for a
   charge nurse and lives on Volume & Staffing Outlook; this page is the
   quarterly one — stop staffing Fridays that way.

   The numbers come from /api/staffing, which computes them through
   lib/staffingShape.js — the same module the ISSCM panel's Pillar 2 uses. This
   page never re-derives them.                                               */

const DOW = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const fmt1 = v => (v == null ? '—' : Number(v).toFixed(1))
const hhmm = m => (m == null ? '' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`)

function minutesOf(v) {
  if (v == null) return 0
  const m = /(\d{1,2}):(\d{2})/.exec(String(v))
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0
}

/* V1 — the shape against the rectangle. This chart is the page's identity:
   the two misalignment regions are shaded and named on it, because the
   vocabulary is what the viewer takes away. */
export function ShapeChart({ day, slotMinutes = 15 }) {
  const plan = day.plan
  const slots = day.byHour ?? []
  if (!plan || slots.length === 0) return null

  const W = 260, H = 96, PAD_L = 22, PAD_B = 16
  const start = 6 * 60, end = 20 * 60
  const maxRooms = Math.max(plan.staffedRooms, ...slots.map(s => s.avgRooms ?? 0)) || 1
  const x = m => PAD_L + ((m - start) / (end - start)) * (W - PAD_L - 4)
  const y = r => (H - PAD_B) - (r / maxRooms) * (H - PAD_B - 6)

  const shiftStart = minutesOf(plan.shiftStart)
  const shiftEnd = minutesOf(plan.shiftEnd)

  const area = slots.map(s => `${x(s.minuteOfDay)},${y(s.avgRooms ?? 0)}`).join(' ')
  const baseline = `${x(slots[slots.length - 1].minuteOfDay)},${y(0)} ${x(slots[0].minuteOfDay)},${y(0)}`

  return (
    <div style={{ minWidth: W }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-gray-800)', marginBottom: 2 }}>
        {day.label}
      </div>
      <svg width={W} height={H} role="img"
           aria-label={`${day.label}: rooms running against ${plan.staffedRooms} staffed`}>
        {/* Idle staffed hours — rectangle standing above the demand */}
        <rect x={x(shiftStart)} y={y(plan.staffedRooms)}
              width={Math.max(0, x(shiftEnd) - x(shiftStart))}
              height={Math.max(0, y(0) - y(plan.staffedRooms))}
              fill="rgba(59,130,246,0.07)" />
        {/* Demand */}
        <polygon points={`${area} ${baseline}`} fill="rgba(99,102,241,0.35)" />
        {/* The rectangle itself */}
        <line x1={x(shiftStart)} x2={x(shiftEnd)} y1={y(plan.staffedRooms)} y2={y(plan.staffedRooms)}
              stroke="var(--color-blue)" strokeWidth="1.5" />
        <line x1={x(shiftStart)} x2={x(shiftStart)} y1={y(plan.staffedRooms)} y2={y(0)}
              stroke="var(--color-blue)" strokeWidth="1" strokeDasharray="2 2" />
        {/* Shift end — the cliff */}
        <line x1={x(shiftEnd)} x2={x(shiftEnd)} y1={6} y2={y(0)}
              stroke="#dc2626" strokeWidth="1" strokeDasharray="3 2" />
        <line x1={PAD_L} x2={W - 4} y1={y(0)} y2={y(0)} stroke="var(--surface-border)" />
        <text x={2} y={y(plan.staffedRooms) + 3} fontSize="9" fill="var(--color-blue)">{plan.staffedRooms}</text>
        <text x={2} y={y(0)} fontSize="9" fill="var(--color-gray-400)">0</text>
        <text x={x(shiftEnd) + 2} y={12} fontSize="9" fill="#dc2626">{hhmm(shiftEnd)}</text>
      </svg>
    </div>
  )
}

function Stat({ label, value, sub, accent }) {
  return (
    <div style={{ background: 'var(--surface-card)', border: '1px solid var(--surface-border)',
                  borderRadius: 'var(--radius-lg)', padding: 'var(--space-4)' }}>
      <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em',
                    fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: accent || 'var(--color-gray-900)' }}>{value}</div>
      {sub && <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)', marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

const TH = { padding: '8px 12px', fontSize: 12, fontWeight: 600, textAlign: 'left',
             color: 'var(--color-text-primary)', borderBottom: '1px solid var(--color-border-secondary)', whiteSpace: 'nowrap' }
const TD = { padding: '9px 12px', fontSize: 'var(--font-size-sm)', color: 'var(--color-gray-700)',
             borderBottom: '1px solid var(--surface-border)' }

export function Ledger({ ledger }) {
  if (!ledger) return null
  const s = ledger.summary
  const hasCost = s.costPerRoomHour != null
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--space-3)', marginBottom: 'var(--space-4)' }}>
        <Stat label="Idle staffed hrs / wk" value={fmt1(s.idleWk)} accent="#2563eb"
              sub={s.worstIdleDow != null ? `Worst: ${DOW[s.worstIdleDow]}` : null} />
        <Stat label="Overtime exposure / wk" value={fmt1(s.overtimeWk)} accent="#dc2626"
              sub={s.worstOvertimeDow != null ? `Worst: ${DOW[s.worstOvertimeDow]}` : null} />
        <Stat label="Alignment" value={s.alignmentPct == null ? '—' : `${fmt1(s.alignmentPct)}%`}
              sub="Demand inside the rectangle" />
        <Stat label="Staffed room-hrs / wk" value={fmt1(s.staffedWk)} />
      </div>
      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title">Misalignment ledger</div>
            <div className="card-subtitle">Both directions of the gap, by day.</div>
          </div>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={TH}>Day</th>
              <th style={{ ...TH, textAlign: 'right' }}>Staffed rooms</th>
              <th style={{ ...TH, textAlign: 'right' }}>Peak running</th>
              <th style={{ ...TH, textAlign: 'right' }}>At shift end</th>
              <th style={{ ...TH, textAlign: 'right' }}>Idle rm-hrs</th>
              <th style={{ ...TH, textAlign: 'right' }}>Overtime rm-hrs</th>
              <th style={{ ...TH, textAlign: 'right' }}>Alignment</th>
              <th style={{ ...TH, textAlign: 'right' }}>Cost</th>
            </tr></thead>
            <tbody>
              {ledger.byDow.map(r => (
                <tr key={r.dow}>
                  <td style={{ ...TD, fontWeight: 600, color: 'var(--color-gray-900)' }}>{r.label}</td>
                  <td style={{ ...TD, textAlign: 'right' }}>{r.plan.staffedRooms}</td>
                  <td style={{ ...TD, textAlign: 'right' }}>{fmt1(r.peakRooms)}</td>
                  <td style={{ ...TD, textAlign: 'right' }}>{fmt1(r.roomsAtShiftEnd)}</td>
                  <td style={{ ...TD, textAlign: 'right', color: '#2563eb', fontWeight: 600 }}>{fmt1(r.idleRoomHours)}</td>
                  <td style={{ ...TD, textAlign: 'right', color: '#dc2626', fontWeight: 600 }}>{fmt1(r.overtimeRoomHours)}</td>
                  <td style={{ ...TD, textAlign: 'right' }}>{fmt1(r.alignmentPct)}%</td>
                  {/* The financials hook is deliberately visible and dormant. */}
                  <td style={{ ...TD, textAlign: 'right', color: 'var(--color-gray-300)' }}
                      title={hasCost ? undefined : 'Pricing arrives with Financial Analysis.'}>
                    {hasCost ? `$${Math.round((r.idleRoomHours + r.overtimeRoomHours) * s.costPerRoomHour)}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}

export default function StaffingPatterns() {
  const [sites, setSites] = useState([])
  const [site, setSite] = useState('')
  const [data, setData] = useState({ shape: null, ledger: null })
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/sites').then(r => r.json())
      .then(list => { setSites(list); setSite(list[0] || '') })
      .catch(() => setError('Could not load sites'))
  }, [])

  useEffect(() => {
    if (!site) return
    setLoading(true); setError(null)
    const q = `site=${encodeURIComponent(site)}`
    Promise.all([
      fetch(`/api/staffing/shape?${q}&weeks=8`).then(r => r.json()),
      fetch(`/api/staffing/ledger?${q}&weeks=8`).then(r => r.json()),
    ])
      .then(([shape, ledger]) => {
        if (shape?.error || ledger?.error) throw new Error(ledger?.error || shape.error)
        setData({ shape, ledger })
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [site])

  const weekdays = useMemo(
    () => (data.shape?.days ?? []).filter(d => d.dow < 5 && d.plan), [data.shape])

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Staffing Patterns</h1>
        <p className="page-subtitle">
          Staffing is a rectangle; demand has a shape. Over a trailing quarter, the
          gap costs money in both directions — idle staffed hours where the rectangle
          is too big, overtime exposure where demand runs past its edge.
        </p>
      </div>

      {sites.length > 1 && (
        <div style={{ marginBottom: 'var(--space-4)' }}>
          <select className="form-input" value={site} onChange={e => setSite(e.target.value)}>
            {sites.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      )}

      {error && (
        <div style={{ display: 'flex', gap: 8, padding: 'var(--space-5)', borderRadius: 'var(--radius-lg)',
                      background: 'rgba(239,68,68,0.06)', border: '1px solid #fecaca', color: '#b91c1c' }}>
          <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
          <div><strong>Could not load staffing alignment.</strong><div>{error}</div></div>
        </div>
      )}

      {!error && loading && <p style={{ color: 'var(--color-gray-400)' }}>Loading…</p>}

      {!error && !loading && (
        <>
          <div className="card" style={{ marginBottom: 'var(--space-5)' }}>
            <div className="card-header">
              <div>
                <div className="card-title">The shape against the rectangle</div>
                <div className="card-subtitle">
                  Average rooms running by time of day. The outlined box is what the plan staffs;
                  the dashed red line is shift end.
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', padding: '4px 16px 16px' }}>
              {weekdays.map(d => (
                <ShapeChart key={d.dow} day={d} slotMinutes={data.shape?.slotMinutes} />
              ))}
            </div>
            <div style={{ display: 'flex', gap: 18, padding: '0 16px 14px', fontSize: 'var(--font-size-xs)',
                          color: 'var(--color-gray-500)', flexWrap: 'wrap' }}>
              <span><span style={{ display: 'inline-block', width: 10, height: 10, background: 'rgba(59,130,246,0.18)', marginRight: 5 }} />Idle staffed hours</span>
              <span><span style={{ display: 'inline-block', width: 10, height: 10, background: 'rgba(99,102,241,0.35)', marginRight: 5 }} />Rooms running</span>
              <span><span style={{ display: 'inline-block', width: 10, height: 2, background: '#dc2626', marginRight: 5, verticalAlign: 'middle' }} />Shift end — anything past it is overtime exposure</span>
            </div>
          </div>

          <Ledger ledger={data.ledger} />

        </>
      )}

    </div>
  )
}

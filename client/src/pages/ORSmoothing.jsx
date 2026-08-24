import { useState, useEffect } from 'react'
import { AlertCircle, Scale, AlertTriangle } from 'lucide-react'
import ScenarioPanel from '../components/ScenarioPanel'

/* ─── OR Smoothing — Census Footprint (ORSmoothing.md) ────────────────────────
   How much of your inpatient congestion is a choice your surgical schedule is
   making? Every elective case casts a bed-shadow: cases x conversion x length
   of stay = occupied beds, days after surgery. Block templates were designed
   around surgeon preference; nobody designed the census they produce.

   The numbers come from /api/smoothing, which computes them through
   lib/censusFootprint.js — the same module the ISSCM panel's Pillar 3 uses, so
   the page proposing a move and the panel judging it cannot disagree.        */

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const DOW_FULL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const fmt1 = v => (v == null ? '—' : Number(v).toFixed(1))

const TH = { padding: '8px 10px', fontSize: 12, fontWeight: 600, textAlign: 'left',
             color: 'var(--color-text-primary)', borderBottom: '1px solid var(--color-border-secondary)' }
const TD = { padding: '8px 10px', fontSize: 'var(--font-size-sm)', color: 'var(--color-gray-700)',
             borderBottom: '1px solid var(--surface-border)' }

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

/* V1 — the teaching moment. One service's bed-shadow, day by day after surgery. */
export function Footprint({ footprint }) {
  if (!footprint || !footprint.units?.length) return null
  const peak = Math.max(1, ...footprint.units.flatMap(u => u.byOffset.map(o => o.beds ?? 0)))
  const top = footprint.units[0]
  const held = top.byOffset[3]?.beds ?? 0
  return (
    <div className="card" style={{ marginBottom: 'var(--space-5)' }}>
      <div className="card-header">
        <div>
          <div className="card-title">Bed shadow — {footprint.service}</div>
          <div className="card-subtitle">
            {fmt1(footprint.weeklyCases)} cases a week, {fmt1(footprint.conversionPct)}% admitting
            ({fmt1(footprint.admissionsPerWeek)} admissions). A day of {footprint.service} is still
            holding about {fmt1(held)} beds on {top.unit} three days later.
          </div>
        </div>
      </div>
      <div style={{ padding: '4px 16px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {footprint.units.map(u => (
          <div key={u.unit} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 96, fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-600)', fontWeight: 600 }}>
              {u.unit}
            </div>
            <div style={{ display: 'flex', gap: 3, alignItems: 'flex-end', height: 46 }}>
              {u.byOffset.map(o => (
                <div key={o.d} style={{ textAlign: 'center', width: 30 }}>
                  <div title={`Day +${o.d}: ${fmt1(o.beds)} beds`}
                       style={{ height: Math.max(2, (o.beds / peak) * 38),
                                background: 'var(--color-blue)', opacity: 0.28 + 0.72 * (o.beds / peak),
                                borderRadius: '2px 2px 0 0' }} />
                  <div style={{ fontSize: 9, color: 'var(--color-gray-400)', marginTop: 2 }}>
                    {o.d === 0 ? 'D0' : `+${o.d}`}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/* V2 — the argument. Census by unit and weekday, each cell decomposed into the
   part the schedule chose and the part that simply arrived. */
export function AttributionGrid({ attribution }) {
  if (!attribution?.units?.length) return null
  return (
    <div className="card" style={{ marginBottom: 'var(--space-5)' }}>
      <div className="card-header">
        <div>
          <div className="card-title">Census attribution</div>
          <div className="card-subtitle">
            Projected census over capacity. The bar under each cell splits it into
            scheduled-OR — the controllable part — against ED and everything else.
          </div>
        </div>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>
            <th style={TH}>Unit</th>
            {DOW.slice(0, 5).map(d => <th key={d} style={{ ...TH, textAlign: 'center' }}>{d}</th>)}
          </tr></thead>
          <tbody>
            {attribution.units.map(u => (
              <tr key={u.unit}>
                <td style={{ ...TD, fontWeight: 600, color: 'var(--color-gray-900)', whiteSpace: 'nowrap' }}>
                  {u.unit}<span style={{ color: 'var(--color-gray-400)', fontWeight: 400 }}> / {u.capacity}</span>
                </td>
                {u.byDow.filter(c => c.dow < 5).map(c => {
                  const orPct = c.orPct ?? 0
                  const edPct = c.census > 0 ? (c.ed / c.census) * 100 : 0
                  return (
                    <td key={c.dow} style={{ ...TD, textAlign: 'center', minWidth: 92,
                        background: c.crunch ? 'rgba(239,68,68,0.10)' : 'transparent' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                        {/* Crunch is shape as well as colour. */}
                        {c.crunch && <AlertTriangle size={11} style={{ color: '#dc2626' }} />}
                        <span style={{ fontWeight: 700, color: c.crunch ? '#b91c1c' : 'var(--color-gray-800)' }}>
                          {fmt1(c.census)}
                        </span>
                        <span style={{ fontSize: 10, color: 'var(--color-gray-400)' }}>{fmt1(c.occupancyPct)}%</span>
                      </div>
                      <div style={{ display: 'flex', height: 4, borderRadius: 2, overflow: 'hidden', marginTop: 4 }}
                           title={`OR ${fmt1(c.or)} · ED ${fmt1(c.ed)} · other ${fmt1(c.other)}`}>
                        <div style={{ width: `${orPct}%`, background: '#6366f1' }} />
                        <div style={{ width: `${edPct}%`, background: '#94a3b8' }} />
                        <div style={{ flex: 1, background: 'var(--color-gray-200, #e2e8f0)' }} />
                      </div>
                      <div style={{ fontSize: 9, color: 'var(--color-gray-400)', marginTop: 2 }}>
                        {fmt1(orPct)}% OR
                      </div>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', gap: 16, padding: '10px 16px 14px', fontSize: 'var(--font-size-xs)',
                    color: 'var(--color-gray-500)' }}>
        <span><span style={{ display: 'inline-block', width: 10, height: 4, background: '#6366f1', marginRight: 5 }} />Scheduled OR</span>
        <span><span style={{ display: 'inline-block', width: 10, height: 4, background: '#94a3b8', marginRight: 5 }} />ED</span>
        <span><span style={{ display: 'inline-block', width: 10, height: 4, background: '#e2e8f0', marginRight: 5 }} />Other / transfers</span>
      </div>
    </div>
  )
}

/* V3 — the action. The page owns the census picture; the panel owns the verdict. */
export function ShiftScenarios({ scenarios, preview, onPreview, onEvaluate, active }) {
  if (!scenarios?.length) return null
  return (
    <div className="card">
      <div className="card-header">
        <div>
          <div className="card-title">Smoothing scenarios</div>
          <div className="card-subtitle">
            Ranked by how much controllable volume sits on a crunch day. Preview redraws
            the census here; Evaluate move opens the three-pillar verdict.
          </div>
        </div>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>
            <th style={TH}>Move</th><th style={TH}>Why</th><th style={TH}></th><th style={TH}></th>
          </tr></thead>
          <tbody>
            {scenarios.map(s => (
              <tr key={s.scenarioId} style={{ background: active === s.scenarioId ? '#EEF0FD' : 'transparent' }}>
                <td style={{ ...TD, fontWeight: 600, color: 'var(--color-gray-900)' }}>{s.label}</td>
                <td style={{ ...TD, fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-500)', maxWidth: 380 }}>
                  {s.rationale}
                </td>
                <td style={TD}>
                  <button type="button" onClick={() => onPreview(s)}
                    style={{ cursor: 'pointer', border: '1px solid var(--surface-border)', background: 'var(--surface-card)',
                             borderRadius: 'var(--radius-md)', padding: '5px 10px', fontSize: 'var(--font-size-xs)', fontWeight: 600 }}>
                    Preview
                  </button>
                </td>
                <td style={TD}>
                  <button type="button" onClick={() => onEvaluate(s)}
                    style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer',
                             border: '1px solid var(--color-blue)', background: 'var(--color-blue)', color: '#fff',
                             borderRadius: 'var(--radius-md)', padding: '5px 10px', fontSize: 'var(--font-size-xs)', fontWeight: 700 }}>
                    <Scale size={12} /> Evaluate move
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {preview && (
        <div style={{ borderTop: '1px solid var(--surface-border)', padding: '14px 16px' }}>
          <div style={{ display: 'flex', gap: 22, marginBottom: 10, fontSize: 'var(--font-size-sm)' }}>
            <span>Crunch unit-days <strong>{preview.crunchBefore}</strong> →{' '}
              <strong style={{ color: preview.crunchAfter < preview.crunchBefore ? '#16a34a' : '#dc2626' }}>
                {preview.crunchAfter}</strong></span>
            <span>Peak census <strong>{fmt1(preview.peakBefore)}</strong> →{' '}
              <strong style={{ color: preview.peakAfter < preview.peakBefore ? '#16a34a' : '#dc2626' }}>
                {fmt1(preview.peakAfter)}</strong></span>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={TH}>Unit</th><th style={TH}>Day</th>
              <th style={{ ...TH, textAlign: 'right' }}>Before</th>
              <th style={{ ...TH, textAlign: 'right' }}>After</th>
              <th style={{ ...TH, textAlign: 'right' }}>Δ</th>
            </tr></thead>
            <tbody>
              {preview.cells.filter(c => Math.abs(c.delta) >= 0.05).slice(0, 12).map(c => (
                <tr key={`${c.unit}|${c.dow}`}>
                  <td style={TD}>{c.unit}</td>
                  <td style={TD}>{DOW_FULL[c.dow]}</td>
                  <td style={{ ...TD, textAlign: 'right' }}>{fmt1(c.censusBefore)}</td>
                  <td style={{ ...TD, textAlign: 'right', fontWeight: 600 }}>{fmt1(c.censusAfter)}</td>
                  <td style={{ ...TD, textAlign: 'right', color: c.delta < 0 ? '#16a34a' : '#dc2626', fontWeight: 600 }}>
                    {c.delta > 0 ? '+' : ''}{fmt1(c.delta)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export default function ORSmoothing() {
  const [attribution, setAttribution] = useState(null)
  const [scenarios, setScenarios] = useState([])
  const [services, setServices] = useState([])
  const [service, setService] = useState('')
  const [footprint, setFootprint] = useState(null)
  const [preview, setPreview] = useState(null)
  const [activeId, setActiveId] = useState(null)
  const [decision, setDecision] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      fetch('/api/smoothing/census-attribution?weeks=8').then(r => r.json()),
      fetch('/api/smoothing/scenarios?weeks=8').then(r => r.json()),
      // /api/sf/meta already lists the tenant's services; no new endpoint for this.
      fetch('/api/sf/meta').then(r => (r.ok ? r.json() : null)).catch(() => null),
    ])
      .then(([attr, scen, svc]) => {
        if (attr?.error) throw new Error(attr.error)
        setAttribution(attr)
        setScenarios(scen?.scenarios ?? [])
        const list = svc?.services ?? []
        setServices(list)
        setService(list.find(s => /spine/i.test(s)) || list[0] || '')
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!service) return
    fetch(`/api/smoothing/footprint?service=${encodeURIComponent(service)}&weeks=8`)
      .then(r => r.json()).then(d => setFootprint(d?.error ? null : d)).catch(() => setFootprint(null))
  }, [service])

  function runPreview(s) {
    setActiveId(s.scenarioId)
    fetch('/api/smoothing/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: { service: s.service, fromDow: s.fromDow, toDow: s.toDow, casesPerWeek: s.casesPerWeek } }),
    }).then(r => r.json()).then(d => setPreview(d?.error ? null : d)).catch(() => setPreview(null))
  }

  const summary = attribution?.summary

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">OR Smoothing — Census Footprint</h1>
        <p className="page-subtitle">
          Every elective case is a bed decision days in advance. This is how much of the
          inpatient peak the surgical schedule is choosing.
        </p>
      </div>

      {error && (
        <div style={{ display: 'flex', gap: 8, padding: 'var(--space-5)', borderRadius: 'var(--radius-lg)',
                      background: 'rgba(239,68,68,0.06)', border: '1px solid #fecaca', color: '#b91c1c' }}>
          <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
          <div><strong>Could not load the census footprint.</strong><div>{error}</div></div>
        </div>
      )}

      {!error && loading && <p style={{ color: 'var(--color-gray-400)' }}>Loading…</p>}

      {!error && !loading && (
        <>
          {summary && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--space-3)',
                          marginBottom: 'var(--space-5)' }}>
              <Stat label="Schedule-driven census" value={`${fmt1(summary.orContributionPct)}%`} accent="#6366f1"
                    sub="The controllable share" />
              <Stat label="Crunch unit-days / wk" value={fmt1(summary.crunchUnitDays)} accent="#dc2626"
                    sub={`At or above ${attribution.crunchOccupancyPct}% occupancy`} />
              <Stat label="Peak" value={summary.peak ? fmt1(summary.peak.census) : '—'}
                    sub={summary.peak ? `${summary.peak.unit}, ${DOW_FULL[summary.peak.dow]}` : null} />
            </div>
          )}

          <AttributionGrid attribution={attribution} />

          {services.length > 0 && (
            <div style={{ marginBottom: 'var(--space-3)' }}>
              <select className="form-input" value={service} onChange={e => setService(e.target.value)}>
                {services.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          )}
          <Footprint footprint={footprint} />

          <ShiftScenarios
            scenarios={scenarios} preview={preview} active={activeId}
            onPreview={runPreview}
            onEvaluate={s => setDecision({
              kind: 'SHIFT_DOW', service: s.service, casesPerWeek: s.casesPerWeek,
              fromDow: s.fromDow, dayOfWeek: s.toDow, dayOfWeekLabel: DOW_FULL[s.toDow],
              fromBlock: s.service, toService: s.service,
            })}
          />
        </>
      )}

      <ScenarioPanel open={decision !== null} decision={decision} onClose={() => setDecision(null)} />
    </div>
  )
}

import { Fragment, useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { AlertCircle, ChevronDown, ChevronRight, Scale, Info } from 'lucide-react'

import SchedForecastCases from './SchedForecastCases'
import ScenarioPanel from '../components/ScenarioPanel'

/* ─── Volume & Staffing Outlook (VolumeOutlook.md) ────────────────────────────
   Not "what are all the forecast numbers" — "over the next two to four weeks,
   where is volume above or below plan, what kind of volume is driving it, and
   is that day staffed for it?"

   The whole chain reads in one exception row, which is why the forward staffing
   view lives here rather than on Staffing Patterns. Every figure comes from
   /api/outlook, which computes it in lib/demandSignal.js and
   lib/staffingShape.js — nothing on this page is re-derived, and no signal text
   is generated prose.                                                        */

const TABS = [
  { id: 'planning', label: 'Planning' },
  { id: 'detail',   label: 'Daily Detail' },
  { id: 'budget',   label: 'Actual vs Budget' },
]
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']

const fmt0 = v => (v == null ? '—' : Math.round(Number(v)))
const fmt1 = v => (v == null ? '—' : Number(v).toFixed(1))
const signed = v => (v == null ? '—' : `${v > 0 ? '+' : ''}${Math.round(v)}`)
const signedPct = v => (v == null ? '—' : `${v > 0 ? '+' : ''}${Math.round(v)}%`)

/**
 * Read a response without assuming it is JSON.
 *
 * `r.json()` on an empty body throws "Unexpected end of JSON input", and on an
 * HTML error page throws "Unexpected token '<'" — both of which hide what
 * actually happened. An empty body usually means the request never completed:
 * the tenant's database is a serverless instance and a cold start can outlast
 * the proxy's patience.
 */
async function readJson(res) {
  const text = await res.text()
  if (!text) {
    throw new Error(res.ok
      ? 'The server returned an empty response. If the database was idle it may still be waking — try again in a moment.'
      : `The server returned an empty response (HTTP ${res.status}).`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(text.trimStart().startsWith('<')
      ? 'The server returned a page instead of data — the API route is not responding. Restart the server if it is running older code.'
      : `The server returned something unreadable (HTTP ${res.status}).`)
  }
}

const TH = { padding: '8px 11px', fontSize: 12, fontWeight: 600, textAlign: 'left',
             color: 'var(--color-text-primary)', borderBottom: '1px solid var(--color-border-secondary)' }
const TD = { padding: '9px 11px', fontSize: 'var(--font-size-sm)', color: 'var(--color-gray-700)',
             borderBottom: '1px solid var(--surface-border)' }

/* Diverging scale centred on zero. The number is always printed, so the cell is
   readable in greyscale and on a projector — colour carries magnitude only. */
function cellStyle(variancePct, onPlan) {
  if (variancePct == null) return { background: 'transparent', color: 'var(--color-gray-400)' }
  if (onPlan) return { background: 'var(--color-gray-100, #f1f5f9)', color: 'var(--color-gray-600)' }
  const mag = Math.min(1, Math.abs(variancePct) / 30)
  return variancePct > 0
    ? { background: `rgba(239,68,68,${0.10 + mag * 0.42})`, color: '#7f1d1d' }
    : { background: `rgba(59,130,246,${0.10 + mag * 0.42})`, color: '#1e3a8a' }
}

export function OutlookHeatmap({ calendar, onPickDate }) {
  if (!calendar?.weeks?.length) return null
  return (
    <div className="card" style={{ marginBottom: 'var(--space-4)' }}>
      <div className="card-header">
        <div>
          <div className="card-title">Four-week outlook</div>
          <div className="card-subtitle">
            Forecast against budget, by day. Blue is under plan, red is over; grey is
            within {calendar.thresholds?.onPlanPct ?? 5}%. Click a day for its detail.
          </div>
        </div>
      </div>
      <div style={{ overflowX: 'auto', padding: '4px 16px 16px' }}>
        <table style={{ borderCollapse: 'separate', borderSpacing: 4 }}>
          <thead>
            <tr>
              <th style={{ ...TH, borderBottom: 'none' }}>Week of</th>
              {DOW.map(d => <th key={d} style={{ ...TH, borderBottom: 'none', textAlign: 'center', minWidth: 76 }}>{d}</th>)}
            </tr>
          </thead>
          <tbody>
            {calendar.weeks.map(w => (
              <tr key={w.weekOf}>
                <td style={{ ...TD, borderBottom: 'none', fontWeight: 600, whiteSpace: 'nowrap' }}>{w.weekOf}</td>
                {[0, 1, 2, 3, 4].map(dow => {
                  const day = w.days.find(d => d.dow === dow)
                  if (!day) return <td key={dow} style={{ ...TD, borderBottom: 'none' }} />
                  const st = cellStyle(day.variancePct, day.onPlan)
                  return (
                    <td key={dow} style={{ ...TD, borderBottom: 'none', padding: 0 }}>
                      <button
                        type="button" onClick={() => onPickDate?.(day.date)}
                        title={`${day.date}: ${fmt0(day.forecast)} forecast vs ${fmt0(day.budget)} budget`}
                        style={{ width: '100%', border: 'none', cursor: 'pointer', borderRadius: 'var(--radius-md)',
                                 padding: '10px 6px', fontWeight: 700, fontSize: 'var(--font-size-sm)', ...st }}
                      >
                        {signedPct(day.variancePct)}
                        <div style={{ fontSize: 10, fontWeight: 500, opacity: 0.8 }}>
                          {fmt0(day.forecast)} cases
                        </div>
                      </button>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* Tier is a data field, never a copy choice: RECOMMENDED means the arithmetic is
   shown, POTENTIAL means we noticed a pattern and are not pretending to
   quantify it. Rendering one in the other's language would spend the
   credibility the distinction buys. */
function TierChip({ tier }) {
  const rec = tier === 'RECOMMENDED'
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px',
                   borderRadius: 'var(--radius-full)', fontSize: 10, fontWeight: 700,
                   letterSpacing: '0.04em',
                   background: rec ? 'rgba(34,197,94,0.14)' : 'rgba(148,163,184,0.18)',
                   color: rec ? '#15803d' : '#475569' }}>
      <span aria-hidden="true">{rec ? '◆' : '■'}</span>{tier}
    </span>
  )
}

export function Exceptions({ exceptions, thresholds, onEvaluate }) {
  const [open, setOpen] = useState(null)
  if (!exceptions) return null
  return (
    <div className="card">
      <div className="card-header">
        <div>
          <div className="card-title">Exceptions ({exceptions.length})</div>
          <div className="card-subtitle">
            Days at least {thresholds?.exceptionPct ?? 15}% and {thresholds?.minCases ?? 4} cases
            off plan. Both, so a three-to-four case day is not an exception.
          </div>
        </div>
      </div>
      {exceptions.length === 0 && (
        <div style={{ padding: '18px 16px', color: 'var(--color-gray-400)', fontSize: 'var(--font-size-sm)' }}>
          No day in this window is far enough off plan to flag.
        </div>
      )}
      {exceptions.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={TH}>Date</th><th style={TH}>Site</th>
              <th style={{ ...TH, textAlign: 'right' }}>Forecast</th>
              <th style={{ ...TH, textAlign: 'right' }}>vs Budget</th>
              <th style={TH}>Primary driver</th>
              <th style={TH}>Staffing implication</th>
              <th style={TH}>Tier</th><th style={TH}></th>
            </tr></thead>
            <tbody>
              {exceptions.map(e => {
                const key = `${e.date}|${e.site}`
                const expanded = open === key
                return (
                  <Fragment key={key}>
                    <tr style={{ background: expanded ? '#EEF0FD' : 'transparent' }}>
                      <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                        <button type="button" onClick={() => setOpen(expanded ? null : key)}
                          style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'none',
                                   border: 'none', padding: 0, cursor: 'pointer', fontWeight: 600,
                                   color: 'var(--color-gray-900)', fontSize: 'var(--font-size-sm)' }}>
                          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                          {e.date}
                        </button>
                      </td>
                      <td style={TD}>{e.site}</td>
                      <td style={{ ...TD, textAlign: 'right', fontWeight: 700 }}>{fmt0(e.forecast)}</td>
                      <td style={{ ...TD, textAlign: 'right', fontWeight: 600,
                                   color: e.variance > 0 ? '#b91c1c' : '#1d4ed8' }}>
                        {signed(e.variance)} · {signedPct(e.variancePct)}
                      </td>
                      <td style={TD}>{e.drivers?.map(d => d.detail).join(', ') || '—'}</td>
                      {/* Never blank: a blank reads as "no staffing impact", which is a
                          different claim from "we cannot quantify it". */}
                      <td style={TD}>{e.implication}</td>
                      <td style={TD}><TierChip tier={e.tier} /></td>
                      <td style={TD}>
                        {e.tier === 'RECOMMENDED' && onEvaluate && (
                          <button type="button" onClick={() => onEvaluate(e)}
                            style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer',
                                     border: '1px solid var(--color-blue)', background: 'var(--color-blue)',
                                     color: '#fff', borderRadius: 'var(--radius-md)', padding: '5px 10px',
                                     fontSize: 'var(--font-size-xs)', fontWeight: 700, whiteSpace: 'nowrap' }}>
                            <Scale size={12} /> Evaluate flex
                          </button>
                        )}
                      </td>
                    </tr>
                    {expanded && (
                      <tr>
                        <td colSpan={8} style={{ ...TD, background: 'var(--surface-bg)' }}>
                          <div style={{ fontWeight: 700, fontSize: 'var(--font-size-sm)',
                                        color: 'var(--color-gray-900)', marginBottom: 4 }}>
                            {e.headline}
                          </div>
                          {/* Templated from the numbers — the same ones the row shows. */}
                          <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-gray-600)' }}>
                            {e.summary}
                          </div>
                          <div style={{ marginTop: 8, fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-600)' }}>
                            Consider:
                            <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
                              {(e.considerations ?? []).map(c => <li key={c}>{c}</li>)}
                            </ul>
                          </div>
                          {e.capacityAssumption && (
                            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 5, marginTop: 8,
                                          fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-500)' }}>
                              <Info size={12} style={{ flexShrink: 0, marginTop: 2 }} />
                              {/* A staffing gap whose derivation is hidden is a number nobody
                                  will act on, or defend to their CFO. */}
                              <span>Plan supports about {fmt1(e.capacityCases)} cases — {e.capacityAssumption}.</span>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export function DailyDetail({ rows, focusDate, onExpand, mix }) {
  const [open, setOpen] = useState(focusDate ?? null)
  useEffect(() => { if (focusDate) setOpen(focusDate) }, [focusDate])
  if (!rows) return null
  return (
    <div className="card">
      <div className="card-header">
        <div>
          <div className="card-title">Daily detail</div>
          <div className="card-subtitle">
            Forecast leads; scheduled plus expected additions is how it was built.
            Expand a day for its case mix.
          </div>
        </div>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>
            <th style={TH}>Date</th><th style={TH}>Site</th>
            <th style={{ ...TH, textAlign: 'right' }}>Forecast</th>
            <th style={{ ...TH, textAlign: 'right' }}>Budget</th>
            <th style={{ ...TH, textAlign: 'right' }}>Variance</th>
          </tr></thead>
          <tbody>
            {rows.map(r => {
              const key = `${r.date}|${r.site}`
              const expanded = open === r.date
              return (
                <Fragment key={key}>
                  <tr style={{ background: expanded ? '#EEF0FD' : 'transparent' }}>
                    <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                      <button type="button"
                        onClick={() => { const next = expanded ? null : r.date; setOpen(next); if (next) onExpand?.(r) }}
                        style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'none', border: 'none',
                                 padding: 0, cursor: 'pointer', fontWeight: 600, color: 'var(--color-gray-900)',
                                 fontSize: 'var(--font-size-sm)' }}>
                        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        {r.label?.slice(0, 3)} {r.date}
                      </button>
                    </td>
                    <td style={TD}>{r.site}</td>
                    <td style={{ ...TD, textAlign: 'right' }}>
                      <div style={{ fontWeight: 700, fontSize: 'var(--font-size-base)' }}>{fmt0(r.forecast)}</div>
                      {/* The mechanics, as the subtitle they are. */}
                      <div style={{ fontSize: 10, color: 'var(--color-gray-400)' }}>
                        {fmt0(r.scheduled)} scheduled + ~{fmt0(r.expectedAdds)} expected
                      </div>
                    </td>
                    <td style={{ ...TD, textAlign: 'right' }}>{fmt0(r.budget)}</td>
                    <td style={{ ...TD, textAlign: 'right', fontWeight: 600,
                                 color: r.variance > 0 ? '#b91c1c' : r.variance < 0 ? '#1d4ed8' : 'var(--color-gray-500)' }}>
                      {signed(r.variance)} · {signedPct(r.variancePct)}
                    </td>
                  </tr>
                  {expanded && (
                    <tr>
                      <td colSpan={5} style={{ ...TD, background: 'var(--surface-bg)' }}>
                        {!mix ? <span style={{ color: 'var(--color-gray-400)' }}>Loading case mix…</span> : (
                          <table style={{ borderCollapse: 'collapse' }}>
                            <thead><tr>
                              <th style={{ ...TH, borderBottom: 'none' }}>Service</th>
                              <th style={{ ...TH, borderBottom: 'none', textAlign: 'right' }}>Forecast</th>
                              <th style={{ ...TH, borderBottom: 'none', textAlign: 'right' }}>Budget</th>
                              <th style={{ ...TH, borderBottom: 'none', textAlign: 'right' }}>Δ</th>
                            </tr></thead>
                            <tbody>
                              {mix.services.map(sv => (
                                <tr key={sv.service}>
                                  <td style={{ ...TD, borderBottom: 'none' }}>{sv.service}</td>
                                  <td style={{ ...TD, borderBottom: 'none', textAlign: 'right' }}>{fmt0(sv.forecast)}</td>
                                  <td style={{ ...TD, borderBottom: 'none', textAlign: 'right' }}>{fmt0(sv.budget)}</td>
                                  <td style={{ ...TD, borderBottom: 'none', textAlign: 'right',
                                               color: sv.delta > 0 ? '#b91c1c' : sv.delta < 0 ? '#1d4ed8' : 'var(--color-gray-400)' }}>
                                    {sv.delta === 0 ? '—' : signed(sv.delta)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default function VolumeOutlook() {
  const { tab: tabParam } = useParams()
  const navigate = useNavigate()
  const active = TABS.some(t => t.id === tabParam) ? tabParam : 'planning'

  const [calendar, setCalendar] = useState(null)
  const [exceptions, setExceptions] = useState(null)
  const [thresholds, setThresholds] = useState(null)
  const [daily, setDaily] = useState(null)
  const [mix, setMix] = useState(null)
  const [focusDate, setFocusDate] = useState(null)
  const [decision, setDecision] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      fetch('/api/outlook/calendar?weeks=4').then(readJson),
      fetch('/api/outlook/exceptions?weeks=4').then(readJson),
      fetch('/api/outlook/daily?weeks=4').then(readJson),
    ])
      .then(([cal, exc, day]) => {
        if (cal?.error) throw new Error(cal.error)
        setCalendar(cal)
        setExceptions(exc?.exceptions ?? [])
        setThresholds(exc?.thresholds ?? cal?.thresholds ?? null)
        setDaily(day?.rows ?? [])
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  const loadMix = useCallback(row => {
    setMix(null)
    fetch(`/api/outlook/daily/${encodeURIComponent(row.date)}/mix?site=${encodeURIComponent(row.site)}`)
      .then(readJson).then(d => setMix(d?.error ? null : d)).catch(() => setMix(null))
  }, [])

  function drillTo(date) {
    setFocusDate(date)
    const row = (daily ?? []).find(r => r.date === date)
    if (row) loadMix(row)
    navigate('/outlook/detail')
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Volume &amp; Staffing Outlook</h1>
        <p className="page-subtitle">
          Where volume is heading over the next four weeks, what kind of volume is
          driving it, and whether those days are staffed for it.
        </p>
      </div>

      <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '2px solid var(--surface-border)' }}>
        {TABS.map(t => {
          const isActive = active === t.id
          return (
            <button key={t.id} type="button" onClick={() => navigate(`/outlook/${t.id}`)}
              style={{ padding: '9px 16px', cursor: 'pointer', border: 'none', background: 'none',
                       borderBottom: `2px solid ${isActive ? 'var(--color-blue)' : 'transparent'}`,
                       marginBottom: -2, fontWeight: isActive ? 700 : 500,
                       color: isActive ? 'var(--color-blue)' : 'var(--color-gray-500)',
                       fontSize: 'var(--font-size-sm)' }}>
              {t.label}
            </button>
          )
        })}
      </div>

      {error && (
        <div style={{ display: 'flex', gap: 8, padding: 'var(--space-5)', borderRadius: 'var(--radius-lg)',
                      background: 'rgba(239,68,68,0.06)', border: '1px solid #fecaca', color: '#b91c1c' }}>
          <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
          <div><strong>Could not load the outlook.</strong><div>{error}</div></div>
        </div>
      )}

      {!error && loading && active !== 'budget' && <p style={{ color: 'var(--color-gray-400)' }}>Loading…</p>}

      {!error && !loading && active === 'planning' && (
        <>
          <OutlookHeatmap calendar={calendar} onPickDate={drillTo} />
          <Exceptions
            exceptions={exceptions} thresholds={thresholds}
            onEvaluate={e => setDecision({
              kind: 'FLEX_STAFFING', rooms: e.roomGap,
              dayOfWeek: new Date(`${e.date}T00:00:00`).getDay() === 0 ? 6
                : new Date(`${e.date}T00:00:00`).getDay() - 1,
              dayOfWeekLabel: e.date, fromBlock: e.site, toService: null,
            })}
          />
        </>
      )}

      {!error && !loading && active === 'detail' && (
        <DailyDetail rows={daily} focusDate={focusDate} onExpand={loadMix} mix={mix} />
      )}

      {active === 'budget' && <SchedForecastCases embedded />}

      <ScenarioPanel open={decision !== null} decision={decision} onClose={() => setDecision(null)} />
    </div>
  )
}

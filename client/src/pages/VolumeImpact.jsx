import { Fragment, useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { AlertCircle, AlertTriangle, ChevronDown, ChevronRight, ArrowRight, Info } from 'lucide-react'

/* ─── Volume Impact (VolumeImpact.md) ─────────────────────────────────────────
   Everything downstream of the surgical schedule is a consequence of forecasted
   volume, so this is one page — "what does the volume coming at us do to the
   rest of the operation?" — across four tabs.

   Design rule above all others: simplicity. Each tab shows an impact, flags the
   days that matter, and states the implication in one line. No triage state
   machine, no recommendation engine, no ScenarioPanel — the panel stays on
   decisions, and this page's subject is what the forecast already implies.

   Every figure comes from /api/impact, which computes it in the shared libs.
   Nothing here is re-derived.                                                */

const TABS = [
  { id: 'budget',    label: 'Budget',        key: 'budget' },
  { id: 'inpatient', label: 'Inpatient',     key: 'inpatient' },
  { id: 'staffing',  label: 'Staffing',      key: 'staffing' },
  { id: 'recovery',  label: 'PACU & Ancillary', key: 'recovery' },
]
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']

const fmt0 = v => (v == null ? '—' : Math.round(Number(v)))
const fmt1 = v => (v == null ? '—' : Number(v).toFixed(1))
const signed = v => (v == null ? '—' : `${v > 0 ? '+' : ''}${Math.round(v)}`)
const signedPct = v => (v == null ? '—' : `${v > 0 ? '+' : ''}${Math.round(v)}%`)

async function readJson(res) {
  const text = await res.text()
  if (!text) {
    throw new Error(res.ok
      ? 'The server returned an empty response. If the database was idle it may still be waking — try again in a moment.'
      : `The server returned an empty response (HTTP ${res.status}).`)
  }
  try { return JSON.parse(text) } catch {
    throw new Error(text.trimStart().startsWith('<')
      ? 'The server returned a page instead of data — restart the server if it is running older code.'
      : `The server returned something unreadable (HTTP ${res.status}).`)
  }
}

const TH = { padding: '8px 11px', fontSize: 12, fontWeight: 600, textAlign: 'left',
             color: 'var(--color-text-primary)', borderBottom: '1px solid var(--color-border-secondary)' }
const TD = { padding: '9px 11px', fontSize: 'var(--font-size-sm)', color: 'var(--color-gray-700)',
             borderBottom: '1px solid var(--surface-border)' }

/* Diverging scale centred on zero; the number is always printed so the cell
   survives greyscale and a projector. */
function cellStyle(pct, onPlan) {
  if (pct == null) return { background: 'transparent', color: 'var(--color-gray-400)' }
  if (onPlan) return { background: 'var(--color-gray-100, #f1f5f9)', color: 'var(--color-gray-600)' }
  const mag = Math.min(1, Math.abs(pct) / 30)
  return pct > 0
    ? { background: `rgba(239,68,68,${0.10 + mag * 0.42})`, color: '#7f1d1d' }
    : { background: `rgba(59,130,246,${0.10 + mag * 0.42})`, color: '#1e3a8a' }
}

/* ─── Specialty x date matrix (VolumeImpactMatrix.md) ─────────────────────────
   The page's premise is one forecast, four consequences, and the cause used to
   be a single summary line. This makes it permanently visible while you move
   between effects.

   Dates, not weekday averages. PACU, pre-op, sterile processing and the units
   need "Thursday the 17th brings 58 cases, 19 of them ortho"; "Thursdays are
   usually busy" cannot staff a specific day, which is the only thing those
   areas do with this. The weekday pattern survives anyway — with columns in
   aligned Mon-Fri bands, a recurring Thursday cluster reads as a vertical
   stripe down the same position in every week.                              */

const DOW_INITIAL = ['M', 'T', 'W', 'T', 'F']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/* Parsed as parts rather than through Date, so a column header cannot shift by
   a day in a browser behind UTC. */
function dateParts(iso) {
  const [y, m, d] = String(iso).split('-').map(Number)
  return { y, m, d, month: MONTHS[(m || 1) - 1] }
}
const dayNum = iso => dateParts(iso).d
const shortDate = iso => { const p = dateParts(iso); return `${p.month} ${p.d}` }
const longDate = (iso, dow) => `${['Mon', 'Tue', 'Wed', 'Thu', 'Fri'][dow] ?? ''} ${shortDate(iso)}`

/* Sequential single-hue, deliberately neutral. The Budget tab's grid is a
   diverging forecast-vs-budget scale, and two grids on one page reading as the
   same thing would be worse than no matrix at all — so this one carries no
   good/bad valence, and the value is always printed so it survives greyscale. */
function matrixCellStyle(value, peak) {
  if (!value) return { background: 'transparent', color: 'var(--color-gray-300)' }
  const mag = peak > 0 ? Math.min(1, value / peak) : 0
  return {
    background: `rgba(71, 85, 105, ${0.06 + mag * 0.40})`,
    color: mag > 0.62 ? '#f8fafc' : 'var(--color-gray-800)',
  }
}

const MTH = { padding: '4px 6px', fontSize: 11, fontWeight: 600, textAlign: 'center',
              color: 'var(--color-gray-500)', whiteSpace: 'nowrap' }
const MTD = { padding: '4px 6px', fontSize: 12, textAlign: 'center',
              fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }
const STICKY_L = { position: 'sticky', left: 0, zIndex: 2, background: 'var(--surface-card)' }
const STICKY_R = { position: 'sticky', right: 0, zIndex: 2, background: 'var(--surface-card)' }

export function VolumeMatrix({ matrix, filter, onFilter }) {
  if (!matrix?.dates?.length) {
    return (
      <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)', margin: 0 }}>
        No forecast volume in this window.
      </p>
    )
  }
  const { dates, services, totals } = matrix

  // Week bands, so the same weekday sits at the same position in every band.
  const bands = []
  for (const [i, d] of dates.entries()) {
    const last = bands[bands.length - 1]
    if (last && last.weekOf === d.weekOf) last.count += 1
    else bands.push({ weekOf: d.weekOf, count: 1, first: i })
  }

  const peak = Math.max(1, ...services.flatMap(s => s.byDate))
  const totalPeak = Math.max(1, ...totals.byDate)
  const selService = filter?.service ?? null
  const selDate = filter?.date ?? null
  const isSel = (svc, date) =>
    (selService && selService === svc) || (selDate && selDate === date)

  return (
    <div>
      <div style={{ overflowX: 'auto', border: '1px solid var(--surface-border)',
                    borderRadius: 'var(--radius-md)' }}>
        <table style={{ borderCollapse: 'separate', borderSpacing: 0, width: '100%' }}>
          <thead>
            <tr>
              <th style={{ ...MTH, ...STICKY_L, textAlign: 'left' }} />
              {bands.map((b, i) => (
                <th key={b.weekOf} colSpan={b.count}
                    style={{ ...MTH, borderLeft: i ? '2px solid var(--surface-border)' : 'none',
                             borderBottom: '1px solid var(--surface-border)' }}>
                  {shortDate(b.weekOf)}
                </th>
              ))}
              <th style={{ ...MTH, ...STICKY_R }} />
            </tr>
            <tr>
              <th style={{ ...MTH, ...STICKY_L, textAlign: 'left', paddingRight: 14 }}>Specialty</th>
              {dates.map((d, i) => {
                const bandStart = bands.some(b => b.first === i && b.first !== 0)
                return (
                  <th key={d.date} style={{ ...MTH, padding: 0,
                        borderLeft: bandStart ? '2px solid var(--surface-border)' : 'none' }}>
                    <button type="button"
                      onClick={() => onFilter({ service: selService, date: selDate === d.date ? null : d.date })}
                      title={d.holiday
                        ? `${longDate(d.date, d.dow)} — reduced-volume day (holiday)`
                        : `Filter every tab to ${longDate(d.date, d.dow)}`}
                      style={{ width: '100%', border: 'none', cursor: 'pointer', padding: '4px 6px',
                               background: selDate === d.date ? 'var(--color-blue)' : 'transparent',
                               color: selDate === d.date ? '#fff'
                                 : d.holiday ? 'var(--color-gray-300)' : 'var(--color-gray-500)',
                               fontSize: 11, fontWeight: 600, lineHeight: 1.15,
                               fontStyle: d.holiday ? 'italic' : 'normal' }}>
                      <div>{DOW_INITIAL[d.dow]}</div>
                      <div style={{ fontVariantNumeric: 'tabular-nums' }}>{dayNum(d.date)}</div>
                    </button>
                  </th>
                )
              })}
              <th style={{ ...MTH, ...STICKY_R, textAlign: 'right', paddingLeft: 12 }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {services.map(s => (
              <tr key={s.service}>
                <th scope="row" style={{ ...MTD, ...STICKY_L, textAlign: 'left', padding: 0 }}>
                  <button type="button"
                    onClick={() => onFilter({ service: selService === s.service ? null : s.service, date: selDate })}
                    title={s.tail
                      ? `${s.tail} smaller services`
                      : `Filter every tab to ${s.service}`}
                    disabled={Boolean(s.tail)}
                    style={{ width: '100%', textAlign: 'left', border: 'none', padding: '4px 14px 4px 6px',
                             background: selService === s.service ? 'var(--color-blue)' : 'transparent',
                             color: selService === s.service ? '#fff' : 'var(--color-gray-700)',
                             cursor: s.tail ? 'default' : 'pointer',
                             fontSize: 12, fontWeight: selService === s.service ? 700 : 500,
                             whiteSpace: 'nowrap' }}>
                    {s.service}
                  </button>
                </th>
                {s.byDate.map((v, i) => {
                  const d = dates[i]
                  const bandStart = bands.some(b => b.first === i && b.first !== 0)
                  return (
                    <td key={d.date} style={{ ...MTD, padding: 0,
                          borderLeft: bandStart ? '2px solid var(--surface-border)' : 'none' }}>
                      <button type="button"
                        onClick={() => onFilter({ service: s.tail ? null : s.service, date: d.date })}
                        title={`${s.service} · ${longDate(d.date, d.dow)}: ${v} cases`}
                        style={{ width: '100%', border: 'none', cursor: 'pointer', padding: '4px 6px',
                                 fontSize: 12, fontVariantNumeric: 'tabular-nums',
                                 outline: isSel(s.service, d.date) ? '2px solid var(--color-blue)' : 'none',
                                 outlineOffset: -2,
                                 opacity: d.holiday ? 0.55 : 1,
                                 ...matrixCellStyle(v, peak) }}>
                        {v || '·'}
                      </button>
                    </td>
                  )
                })}
                <td style={{ ...MTD, ...STICKY_R, textAlign: 'right', fontWeight: 600,
                             paddingLeft: 12 }}>{s.total}</td>
              </tr>
            ))}
            {/* Daily case load is what PACU, pre-op and the units plan against,
                so the Total row carries the weight on this grid. */}
            <tr>
              <th scope="row" style={{ ...MTD, ...STICKY_L, textAlign: 'left', fontWeight: 700,
                        color: 'var(--color-gray-900)', padding: '6px',
                        borderTop: '2px solid var(--color-border-secondary)' }}>
                All specialties
              </th>
              {totals.byDate.map((v, i) => {
                const d = dates[i]
                const bandStart = bands.some(b => b.first === i && b.first !== 0)
                return (
                  <td key={d.date}
                      title={`${longDate(d.date, d.dow)}: ${v} cases`}
                      style={{ ...MTD, fontWeight: 700, padding: '6px',
                               borderTop: '2px solid var(--color-border-secondary)',
                               borderLeft: bandStart ? '2px solid var(--surface-border)' : 'none',
                               opacity: d.holiday ? 0.55 : 1,
                               ...matrixCellStyle(v, totalPeak) }}>
                    {v}
                  </td>
                )
              })}
              <td style={{ ...MTD, ...STICKY_R, textAlign: 'right', fontWeight: 800,
                           color: 'var(--color-gray-900)', paddingLeft: 12,
                           borderTop: '2px solid var(--color-border-secondary)' }}>
                {totals.window}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                    marginTop: 8, fontSize: 'var(--font-size-xs)' }}>
        {(selService || selDate) ? (
          <>
            <span style={{ color: 'var(--color-gray-700)' }}>
              <strong>Showing:</strong>{' '}
              {[selService, selDate && longDate(selDate,
                dates.find(d => d.date === selDate)?.dow ?? 0)].filter(Boolean).join(' · ')}
            </span>
            <button type="button" onClick={() => onFilter({ service: null, date: null })}
              style={{ border: '1px solid var(--color-border-secondary)', background: 'none',
                       borderRadius: 'var(--radius-md)', padding: '2px 9px', cursor: 'pointer',
                       fontSize: 'var(--font-size-xs)', fontWeight: 600,
                       color: 'var(--color-gray-600)' }}>
              Clear
            </button>
          </>
        ) : (
          <span style={{ color: 'var(--color-gray-400)' }}>
            Click a specialty, a date or a cell to filter every tab.
          </span>
        )}
        {matrix.capped && (
          <span style={{ marginLeft: 'auto', color: 'var(--color-gray-400)' }}>
            First {matrix.cappedAt} weeks of a longer window.
          </span>
        )}
      </div>
    </div>
  )
}

/* The two-component split is never collapsed: four weeks out an elective
   schedule is only partly filled, and a tool reading the booked schedule alone
   systematically under-counts. Showing both is the answer to "why isn't this
   the EMR's own report?" */
export function ContextHeader({ summary, sites, site, onSite, weeks, onWeeks,
                               filter, onFilter, expanded, onToggle }) {
  const matrix = summary?.matrix
  return (
    <div style={{ border: '1px solid var(--surface-border)', borderRadius: 'var(--radius-lg)',
                  background: 'var(--surface-card)', padding: '12px 16px', marginBottom: 'var(--space-4)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
        <select className="form-input" value={site} onChange={e => onSite(e.target.value)}>
          <option value="">All sites</option>
          {sites.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="form-input" value={weeks} onChange={e => onWeeks(Number(e.target.value))}>
          {[2, 4, 6].map(w => <option key={w} value={w}>Next {w} weeks</option>)}
        </select>
        {matrix && onToggle && (
          <button type="button" onClick={onToggle} aria-expanded={expanded}
            style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4,
                     border: 'none', background: 'none', cursor: 'pointer',
                     fontSize: 'var(--font-size-xs)', fontWeight: 600,
                     color: 'var(--color-gray-500)' }}>
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {expanded ? 'Hide the volume matrix' : 'Show the volume matrix'}
          </button>
        )}
      </div>
      {summary && (
        <div style={{ fontSize: 'var(--font-size-base)', color: 'var(--color-gray-800)' }}>
          <strong style={{ fontSize: 'var(--font-size-lg)' }}>{fmt0(summary.forecast)} cases forecast</strong>
          <span style={{ color: 'var(--color-gray-500)' }}>
            {' '}— {fmt0(summary.booked)} booked + ~{fmt0(summary.expectedAdds)} expected to book
          </span>
          {summary.variancePct != null && (
            <span style={{ marginLeft: 10, fontWeight: 700,
                           color: summary.variancePct > 0 ? '#b91c1c' : '#1d4ed8' }}>
              {signedPct(summary.variancePct)} vs budget
            </span>
          )}
        </div>
      )}
      {/* Collapsed the matrix cannot do its job, so it is expanded by default
          and the header falls back to the summary line above when it is not. */}
      {matrix && expanded && (
        <div style={{ marginTop: 12 }}>
          <VolumeMatrix matrix={matrix} filter={filter} onFilter={onFilter} />
        </div>
      )}
    </div>
  )
}

export function BudgetTab({ data, mix, onExpand }) {
  const [open, setOpen] = useState(null)
  if (!data) return null
  return (
    <>
      <div className="card" style={{ marginBottom: 'var(--space-4)' }}>
        <div className="card-header">
          <div>
            <div className="card-title">Forecast against budget</div>
            <div className="card-subtitle">
              Blue is under plan, red is over, grey is within {data.thresholds?.onPlanPct ?? 5}%.
            </div>
          </div>
        </div>
        <div style={{ overflowX: 'auto', padding: '4px 16px 16px' }}>
          <table style={{ borderCollapse: 'separate', borderSpacing: 4 }}>
            <thead><tr>
              <th style={{ ...TH, borderBottom: 'none' }}>Week of</th>
              {DOW.map(d => <th key={d} style={{ ...TH, borderBottom: 'none', textAlign: 'center', minWidth: 76 }}>{d}</th>)}
            </tr></thead>
            <tbody>
              {data.grid.map(w => (
                <tr key={w.weekOf}>
                  <td style={{ ...TD, borderBottom: 'none', fontWeight: 600, whiteSpace: 'nowrap' }}>{w.weekOf}</td>
                  {[0, 1, 2, 3, 4].map(dow => {
                    const day = w.days.find(d => d.dow === dow)
                    if (!day) return <td key={dow} style={{ ...TD, borderBottom: 'none' }} />
                    return (
                      <td key={dow} style={{ ...TD, borderBottom: 'none', padding: 0 }}>
                        <div style={{ borderRadius: 'var(--radius-md)', padding: '10px 6px',
                                      fontWeight: 700, fontSize: 'var(--font-size-sm)', textAlign: 'center',
                                      ...cellStyle(day.variancePct, day.onPlan) }}>
                          {signedPct(day.variancePct)}
                          <div style={{ fontSize: 10, fontWeight: 500, opacity: 0.8 }}>{fmt0(day.forecast)} cases</div>
                        </div>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title">By day</div>
            <div className="card-subtitle">
              Flagged at {data.thresholds?.exceptionPct ?? 15}% and {data.thresholds?.minCases ?? 4} cases —
              both, so a three-to-four case day is not an exception.
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
              {data.days.map(r => {
                const key = `${r.date}|${r.site}`
                const expanded = open === key
                return (
                  <Fragment key={key}>
                    <tr style={{ background: expanded ? '#EEF0FD' : r.flagged ? 'rgba(239,68,68,0.05)' : 'transparent' }}>
                      <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                        <button type="button"
                          onClick={() => { const next = expanded ? null : key; setOpen(next); if (next) onExpand(r) }}
                          style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'none', border: 'none',
                                   padding: 0, cursor: 'pointer', fontWeight: 600, color: 'var(--color-gray-900)',
                                   fontSize: 'var(--font-size-sm)' }}>
                          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                          {r.label.slice(0, 3)} {r.date}
                          {r.flagged && <AlertTriangle size={12} style={{ color: '#b91c1c' }} />}
                        </button>
                      </td>
                      <td style={TD}>{r.site}</td>
                      <td style={{ ...TD, textAlign: 'right' }}>
                        <div style={{ fontWeight: 700, fontSize: 'var(--font-size-base)' }}>{fmt0(r.forecast)}</div>
                        <div style={{ fontSize: 10, color: 'var(--color-gray-400)' }}>
                          {fmt0(r.booked)} booked + ~{fmt0(r.expectedAdds)}
                        </div>
                      </td>
                      <td style={{ ...TD, textAlign: 'right' }}>{fmt0(r.budget)}</td>
                      <td style={{ ...TD, textAlign: 'right', fontWeight: 600,
                                   color: r.variance > 0 ? '#b91c1c' : r.variance < 0 ? '#1d4ed8' : 'var(--color-gray-500)' }}>
                        {signed(r.variance)} · {signedPct(r.variancePct)}
                      </td>
                    </tr>
                    {expanded && (
                      <tr><td colSpan={5} style={{ ...TD, background: 'var(--surface-bg)' }}>
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
                      </td></tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}

/* Some filters a tab genuinely cannot honour. Saying so beats rendering an
   unchanged tab, which reads as a broken filter. */
export function FilterNotice({ filter, applied }) {
  if (!filter?.service || applied?.service !== false) return null
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 'var(--space-3)',
                  padding: '8px 12px', borderRadius: 'var(--radius-md)',
                  background: 'var(--surface-bg)', border: '1px solid var(--surface-border)',
                  fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-600)' }}>
      <Info size={14} style={{ flexShrink: 0, marginTop: 1 }} />
      <span>
        Projected census is attributed by unit and weekday from trailing occupancy,
        which carries no specialty dimension — so the <strong>{filter.service}</strong>{' '}
        filter does not apply here. The date filter does.
      </span>
    </div>
  )
}

export function InpatientTab({ data, filter }) {
  if (!data) return null
  const dates = data.units[0]?.days ?? []
  return (
    <>
      <FilterNotice filter={filter} applied={data.appliedFilters} />
      {data.suggestions?.length > 0 && (
        <div style={{ display: 'flex', gap: 8, padding: '12px 16px', marginBottom: 'var(--space-4)',
                      borderRadius: 'var(--radius-lg)', background: 'rgba(99,102,241,0.08)',
                      border: '1px solid rgba(99,102,241,0.28)', fontSize: 'var(--font-size-sm)' }}>
          <Info size={15} style={{ flexShrink: 0, marginTop: 2, color: '#4338ca' }} />
          {/* One suggestion, stated plainly. Not a scenario builder. */}
          <span>{data.suggestions[0].text}</span>
        </div>
      )}
      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title">Projected census by unit</div>
            <div className="card-subtitle">
              Cells at or above {data.crunchOccupancyPct}% of capacity are flagged. The bar splits
              each day into scheduled-OR — the controllable part — against ED and the rest.
            </div>
          </div>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={TH}>Unit</th>
              {dates.map(d => <th key={d.date} style={{ ...TH, textAlign: 'center', minWidth: 74 }}>
                {d.label.slice(0, 3)}<div style={{ fontWeight: 400, fontSize: 10, color: 'var(--color-gray-400)' }}>{d.date.slice(5)}</div>
              </th>)}
            </tr></thead>
            <tbody>
              {data.units.map(u => (
                <tr key={u.unit}>
                  <td style={{ ...TD, fontWeight: 600, whiteSpace: 'nowrap' }}>
                    {u.unit}<span style={{ color: 'var(--color-gray-400)', fontWeight: 400 }}> / {u.capacity}</span>
                  </td>
                  {u.days.map(c => {
                    const orPct = c.orPct ?? 0
                    const edPct = c.census > 0 ? (c.ed / c.census) * 100 : 0
                    return (
                      <td key={c.date} style={{ ...TD, textAlign: 'center',
                          background: c.crunch ? 'rgba(239,68,68,0.10)' : 'transparent' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3 }}>
                          {c.crunch && <AlertTriangle size={11} style={{ color: '#dc2626' }} />}
                          <span style={{ fontWeight: 700, color: c.crunch ? '#b91c1c' : 'var(--color-gray-800)' }}>
                            {fmt0(c.census)}
                          </span>
                        </div>
                        <div style={{ display: 'flex', height: 4, borderRadius: 2, overflow: 'hidden', marginTop: 3 }}
                             title={`OR ${fmt1(c.or)} · ED ${fmt1(c.ed)} · other ${fmt1(c.other)}`}>
                          <div style={{ width: `${orPct}%`, background: '#6366f1' }} />
                          <div style={{ width: `${edPct}%`, background: '#94a3b8' }} />
                          <div style={{ flex: 1, background: '#e2e8f0' }} />
                        </div>
                        {c.crunch && (
                          <div style={{ fontSize: 9, color: 'var(--color-gray-500)', marginTop: 2 }}>
                            {fmt0(orPct)}% OR
                          </div>
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}

function FlagChip({ flag }) {
  if (!flag) return <span style={{ color: 'var(--color-gray-300)' }}>—</span>
  const under = flag === 'UNDER'
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 9px',
                   borderRadius: 'var(--radius-full)', fontSize: 11, fontWeight: 700,
                   background: under ? 'rgba(239,68,68,0.13)' : 'rgba(59,130,246,0.12)',
                   color: under ? '#b91c1c' : '#2563eb' }}>
      <span aria-hidden="true">{under ? '▲' : '▼'}</span>
      {under ? 'Short' : 'Spare'}
    </span>
  )
}

export function StaffingTab({ data }) {
  if (!data) return null
  return (
    <div className="card">
      <div className="card-header">
        <div>
          <div className="card-title">Rooms needed against rooms staffed</div>
          <div className="card-subtitle">
            A room short costs late finishes and overtime; a room over costs idle salary.
            They are not the same size of problem, and the thresholds reflect that.
          </div>
        </div>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>
            <th style={TH}>Date</th><th style={TH}>Site</th>
            <th style={{ ...TH, textAlign: 'right' }}>Needed</th>
            <th style={{ ...TH, textAlign: 'right' }}>Staffed</th>
            <th style={{ ...TH, textAlign: 'right' }}>Past shift end</th>
            <th style={TH}>Flag</th><th style={TH}>Implication</th>
          </tr></thead>
          <tbody>
            {data.days.map(d => (
              <tr key={`${d.date}|${d.site}`}
                  style={{ background: d.flag ? 'rgba(59,130,246,0.04)' : 'transparent' }}>
                <td style={{ ...TD, whiteSpace: 'nowrap' }}>{d.label.slice(0, 3)} {d.date}</td>
                <td style={TD}>{d.site}</td>
                <td style={{ ...TD, textAlign: 'right', fontWeight: 700 }}>{d.impliedRooms}</td>
                <td style={{ ...TD, textAlign: 'right' }}>{d.staffedRooms}</td>
                <td style={{ ...TD, textAlign: 'right' }}>{fmt1(d.lateDayHours)}h</td>
                <td style={TD}><FlagChip flag={d.flag} /></td>
                <td style={{ ...TD, fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-600)', maxWidth: 420 }}>
                  {d.implication}
                  {d.link && (
                    <> <Link to={d.link.href} style={{ color: 'var(--color-blue)', fontWeight: 600,
                                                       display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                      {d.link.label} <ArrowRight size={11} />
                    </Link></>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function RecoveryTab({ data }) {
  const [open, setOpen] = useState(null)
  if (!data) return null
  const flagged = data.days.filter(d => d.flagged)
  return (
    <div className="card">
      <div className="card-header">
        <div>
          <div className="card-title">Recovery bay demand</div>
          <div className="card-subtitle">
            Bay demand modelled from case mix and timing — not nurse ratios, which is why
            every row here is <strong>POTENTIAL</strong>. {flagged.length} day
            {flagged.length === 1 ? '' : 's'} peak above the bays staffed.
          </div>
        </div>
      </div>
      {flagged.length === 0 && (
        <div style={{ padding: '18px 16px', color: 'var(--color-gray-400)', fontSize: 'var(--font-size-sm)' }}>
          No day in this window peaks above its staffed bays.
        </div>
      )}
      {flagged.map(d => {
        const key = `${d.date}|${d.site}`
        const expanded = open === key
        const peak = Math.max(1, ...d.byHour.map(h => Math.max(h.pacu, h.phase2, h.preop)))
        return (
          <div key={key} style={{ borderBottom: '1px solid var(--surface-border)', padding: '10px 16px' }}>
            <button type="button" onClick={() => setOpen(expanded ? null : key)}
              style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none',
                       padding: 0, cursor: 'pointer', textAlign: 'left', width: '100%' }}>
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <span style={{ fontWeight: 600, color: 'var(--color-gray-900)', fontSize: 'var(--font-size-sm)' }}>
                {d.date} · {d.site}
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 8px',
                             borderRadius: 999, fontSize: 10, fontWeight: 700,
                             background: 'rgba(148,163,184,0.18)', color: '#475569' }}>
                <span aria-hidden="true">■</span>POTENTIAL
              </span>
              <span style={{ marginLeft: 'auto', fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-600)' }}>
                {d.implication}
              </span>
            </button>
            {expanded && (
              <div style={{ display: 'flex', gap: 2, alignItems: 'flex-end', height: 64, marginTop: 10 }}>
                {d.byHour.map(h => (
                  <div key={h.minuteOfDay} style={{ textAlign: 'center', width: 15 }}
                       title={`${h.label} — PACU ${h.pacu}, phase II ${h.phase2}, pre-op ${h.preop}`}>
                    <div style={{ height: (h.pacu / peak) * 46,
                                  background: d.pacu.staffed != null && h.pacu > d.pacu.staffed ? '#dc2626' : '#6366f1',
                                  borderRadius: '2px 2px 0 0' }} />
                    {h.minuteOfDay % 120 === 0 && (
                      <div style={{ fontSize: 8, color: 'var(--color-gray-400)' }}>{h.label.slice(0, 2)}</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default function VolumeImpact() {
  const { tab: tabParam } = useParams()
  const navigate = useNavigate()

  const [available, setAvailable] = useState(null)
  const [sites, setSites] = useState([])
  const [site, setSite] = useState('')
  const [weeks, setWeeks] = useState(4)
  const [summary, setSummary] = useState(null)
  const [budget, setBudget] = useState(null)
  const [inpatient, setInpatient] = useState(null)
  const [staffing, setStaffing] = useState(null)
  const [recovery, setRecovery] = useState(null)
  const [mix, setMix] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  // The matrix drives the tabs, so the filter lives here rather than inside it:
  // one selection, four consequences, and it survives switching between them.
  const [filter, setFilter] = useState({ service: null, date: null })
  const [matrixOpen, setMatrixOpen] = useState(() => {
    try { return window.localStorage.getItem('impact.matrix') !== 'closed' } catch { return true }
  })

  const toggleMatrix = useCallback(() => {
    setMatrixOpen(v => {
      try { window.localStorage.setItem('impact.matrix', v ? 'closed' : 'open') } catch { /* private mode */ }
      return !v
    })
  }, [])

  const shown = TABS.filter(t => !available || available[t.key])
  const active = shown.some(t => t.id === tabParam) ? tabParam : (shown[0]?.id ?? 'budget')

  useEffect(() => {
    fetch('/api/impact/tabs').then(readJson).then(setAvailable).catch(() => setAvailable(null))
    fetch('/api/sites').then(readJson).then(setSites).catch(() => setSites([]))
  }, [])

  const range = useCallback(() => {
    const today = new Date()
    const from = new Date(today.getTime() + 86400000).toISOString().slice(0, 10)
    const to = new Date(today.getTime() + weeks * 7 * 86400000).toISOString().slice(0, 10)
    const s = site ? `&sites=${encodeURIComponent(site)}` : ''
    const f = (filter.service ? `&service=${encodeURIComponent(filter.service)}` : '')
            + (filter.date ? `&date=${encodeURIComponent(filter.date)}` : '')
    return `from=${from}&to=${to}${s}${f}`
  }, [weeks, site, filter])

  // One selection, four consequences: the tabs never disagree about which
  // forecast they are describing.
  useEffect(() => {
    setLoading(true); setError(null)
    const q = range()
    Promise.all([
      fetch(`/api/impact/summary?${q}`).then(readJson),
      fetch(`/api/impact/budget?${q}&bySite=true`).then(readJson),
      fetch(`/api/impact/inpatient?${q}`).then(readJson).catch(() => null),
      fetch(`/api/impact/staffing?${q}`).then(readJson).catch(() => null),
      fetch(`/api/impact/recovery?${q}`).then(readJson).catch(() => null),
    ])
      .then(([s, b, i, st, r]) => {
        if (s?.error) throw new Error(s.error)
        setSummary(s); setBudget(b); setInpatient(i); setStaffing(st); setRecovery(r)
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [range])

  const loadMix = useCallback(row => {
    setMix(null)
    fetch(`/api/impact/budget/${encodeURIComponent(row.date)}/mix?site=${encodeURIComponent(row.site)}`)
      .then(readJson).then(d => setMix(d?.error ? null : d)).catch(() => setMix(null))
  }, [])

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Volume Impact</h1>
        <p className="page-subtitle">
          What the volume coming at us does to the rest of the operation — plan, beds,
          rooms and recovery, all off the same forecast.
        </p>
      </div>

      <ContextHeader
        summary={summary} sites={sites} site={site} onSite={setSite}
        weeks={weeks} onWeeks={setWeeks}
        filter={filter} onFilter={setFilter}
        expanded={matrixOpen} onToggle={toggleMatrix}
      />

      <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '2px solid var(--surface-border)' }}>
        {shown.map(t => {
          const isActive = active === t.id
          return (
            <button key={t.id} type="button" onClick={() => navigate(`/impact/${t.id}`)}
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
          <div><strong>Could not load the impact view.</strong><div>{error}</div></div>
        </div>
      )}
      {!error && loading && <p style={{ color: 'var(--color-gray-400)' }}>Loading…</p>}

      {!error && !loading && (
        <>
          {active === 'budget'    && <BudgetTab data={budget} mix={mix} onExpand={loadMix} />}
          {active === 'inpatient' && <InpatientTab data={inpatient} filter={filter} />}
          {active === 'staffing'  && <StaffingTab data={staffing} />}
          {active === 'recovery'  && <RecoveryTab data={recovery} />}
        </>
      )}
    </div>
  )
}

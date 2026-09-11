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

// Tab 1 is the forecast; tabs 2-5 are what it does to you.
const TABS = [
  { id: 'breakdown', label: 'Service Line Breakdown', key: 'breakdown' },
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

/* ─── Tab 1 — Service Line Breakdown (ServiceLineBreakdown.md) ────────────────
   Tab 1 is the forecast; tabs 2-5 are what it does to you.

   Dates, not weekday averages. PACU, pre-op, sterile processing and the units
   need "Thursday the 17th brings 58 cases, 19 of them ortho"; "Thursdays are
   usually busy" cannot staff Thursday the 18th, which is the only thing those
   areas do with this. The weekday pattern survives anyway — with columns in
   aligned Mon-Fri bands, a recurring Thursday cluster reads as a vertical
   stripe down the same position in every week.

   The grid is read-only on purpose: it reports what is coming, and nothing on
   it filters another tab.                                                   */

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
/* Magnitude rides the numeral, not a fill behind it. Two hundred shaded boxes
   competing with two hundred numbers is a grid you decode rather than read; five
   steps of ink depth carry the same ordering quietly, and leave the cells free.

   Thresholds are fractions of the window's peak rather than absolutes, so the
   ramp spans whatever scale a tenant's data happens to have. The fractions are
   the mock's own (3/6/10/15 against a peak of 22). */
const INK_STEPS = [
  { at: 0.14, color: 'var(--color-gray-400)', weight: 400 },
  { at: 0.27, color: 'var(--color-gray-500)', weight: 400 },
  { at: 0.45, color: 'var(--color-gray-700)', weight: 500 },
  { at: 0.68, color: 'var(--color-gray-900)', weight: 600 },
  { at: Infinity, color: 'var(--color-gray-900)', weight: 700 },
]

/* A zero is not information worth ink. Kept in the DOM so the column keeps its
   width and a screen reader still reads the cell, but invisible, so the
   occupied cells are what form the pattern. */
function inkStep(value, peak) {
  if (!value) return { color: 'transparent', fontWeight: 400 }
  const s = INK_STEPS.find(x => value <= x.at * peak) ?? INK_STEPS[INK_STEPS.length - 1]
  return { color: s.color, fontWeight: s.weight }
}

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
const MTH = { padding: '0 0 8px', fontSize: 11, fontWeight: 500, textAlign: 'center',
              fontFamily: MONO, color: 'var(--color-gray-500)', whiteSpace: 'nowrap',
              lineHeight: 1.25 }
const MTD = { padding: 0, height: 29, textAlign: 'center', fontFamily: MONO,
              fontSize: 12.5, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }
const STICKY_L = { position: 'sticky', left: 0, zIndex: 2, background: 'var(--surface-card)' }
const STICKY_R = { position: 'sticky', right: 0, zIndex: 2, background: 'var(--surface-card)' }
const BAND_LABEL = { fontFamily: MONO, fontSize: 10, fontWeight: 600, letterSpacing: '.11em',
                     textTransform: 'uppercase', color: 'var(--color-gray-400)',
                     textAlign: 'left', padding: '0 0 5px 4px' }
const GAP = { width: 14 }

export function ServiceLineBreakdownTab({ data }) {
  if (!data) return null
  if (!data.dates?.length) {
    return (
      <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-gray-400)' }}>
        No forecast volume in this window.
      </p>
    )
  }
  const { dates, services, totals, types } = data

  // Patient-type split (ServiceLineBreakdownPatientType.md), demo only. When the
  // flag is off the endpoint omits these and the tab is exactly what it was.
  const hasTypes = !!(data.hasTypes && types?.length)
  const RULE = '1px solid var(--color-border-secondary)'
  const TYPE_LABEL = { outpatient: 'Outpatient', sda: 'Same-day admit', inpatient: 'Inpatient' }
  const typeTotal = t => types?.find(x => x.type === t)?.total ?? 0

  // Weeks are grouped by air rather than by rules: a gap column between bands
  // instead of a vertical line, so the Thursday stripe reads down the page
  // without four more marks competing with it.
  const bands = []
  for (const [i, d] of dates.entries()) {
    const last = bands[bands.length - 1]
    if (last && last.weekOf === d.weekOf) last.days.push(i)
    else bands.push({ weekOf: d.weekOf, days: [i] })
  }

  const peak = Math.max(1, ...services.flatMap(s => s.byDate))
  const maxTotal = Math.max(1, ...totals.byDate)
  const peakDay = totals.byDate.indexOf(maxTotal)
  const cols = 2 + dates.length + (bands.length - 1) + 1 + (hasTypes ? 3 : 0)

  return (
    <div className="card" style={{ padding: '22px 26px 26px' }}>
      <style>{`.slb tbody tr:hover td, .slb tbody tr:hover th {
        background: var(--color-gray-100, #f1f5f9);
      }`}</style>
      <div style={{ overflowX: 'auto' }}>
        <table className="slb" style={{ borderCollapse: 'collapse', fontVariantNumeric: 'tabular-nums' }}>
          <thead>
            {/* Week bands */}
            <tr>
              <th style={{ ...STICKY_L, padding: 0 }} />
              <th style={GAP} />
              {bands.map((b, i) => (
                <Fragment key={b.weekOf}>
                  <th colSpan={b.days.length} style={BAND_LABEL}>{shortDate(b.weekOf)}</th>
                  {i < bands.length - 1 && <th style={GAP} />}
                </Fragment>
              ))}
              <th style={{ ...STICKY_R, padding: 0 }} />
            </tr>
            {/* Dates */}
            <tr>
              <th style={{ ...STICKY_L, padding: 0 }} />
              <th style={GAP} />
              {bands.map((b, i) => (
                <Fragment key={b.weekOf}>
                  {b.days.map(j => {
                    const d = dates[j]
                    return (
                      <th key={d.date} scope="col"
                          title={d.holiday
                            ? `${longDate(d.date, d.dow)} — reduced-volume day (holiday)`
                            : longDate(d.date, d.dow)}
                          style={{ ...MTH, width: 40,
                                   color: d.holiday ? 'var(--color-gray-400)' : 'var(--color-gray-500)' }}>
                        {DOW_INITIAL[d.dow]}
                        <span style={{ display: 'block', fontSize: 12.5,
                                       fontWeight: d.holiday ? 500 : 600,
                                       color: d.holiday ? 'var(--color-gray-400)' : 'var(--color-gray-700)' }}>
                          {dayNum(d.date)}
                        </span>
                      </th>
                    )
                  })}
                  {i < bands.length - 1 && <th style={GAP} />}
                </Fragment>
              ))}
              <th style={{ ...STICKY_R, ...BAND_LABEL, textAlign: 'right',
                           paddingLeft: 20, paddingBottom: 8 }}>Total</th>
              {hasTypes && (
                <>
                  <th style={{ ...BAND_LABEL, textAlign: 'right', paddingBottom: 8, paddingLeft: 18, borderLeft: RULE }}>OP</th>
                  <th style={{ ...BAND_LABEL, textAlign: 'right', paddingBottom: 8, paddingLeft: 12 }}>SDA</th>
                  <th style={{ ...BAND_LABEL, textAlign: 'right', paddingBottom: 8, paddingLeft: 12 }}>IP</th>
                </>
              )}
            </tr>
            {/* Daily totals as a bar strip. This was a row of numbers at the
                bottom of the grid; as the shape of the month at the top it is
                read first, which is what "most important line" should mean. */}
            <tr>
              <th scope="row" style={{ ...STICKY_L, ...BAND_LABEL, textAlign: 'right',
                        color: 'var(--color-gray-500)', verticalAlign: 'bottom',
                        padding: '0 14px 22px 0', whiteSpace: 'nowrap' }}>
                Cases<br />per day
              </th>
              <td style={GAP} />
              {bands.map((b, i) => (
                <Fragment key={b.weekOf}>
                  {b.days.map(j => {
                    const v = totals.byDate[j]
                    const hol = dates[j].holiday
                    const hi = j === peakDay
                    return (
                      <td key={dates[j].date}
                          title={`${longDate(dates[j].date, dates[j].dow)}: ${v} cases`}
                          style={{ verticalAlign: 'bottom', height: 56, paddingBottom: 3 }}>
                        <div style={{ margin: '0 auto', width: 17, borderRadius: '3px 3px 0 0',
                                      height: Math.round((v / maxTotal) * 44),
                                      background: hol ? 'var(--color-gray-300)' : 'var(--color-blue)',
                                      opacity: hol ? 1 : (hi ? 1 : 0.55) }} />
                        <span style={{ display: 'block', textAlign: 'center', fontFamily: MONO,
                                       fontSize: 11.5, paddingTop: 4,
                                       fontWeight: hol ? 400 : 600,
                                       color: hol ? 'var(--color-gray-400)'
                                         : hi ? 'var(--color-blue)' : 'var(--color-gray-700)' }}>
                          {v}
                        </span>
                      </td>
                    )
                  })}
                  {i < bands.length - 1 && <td style={GAP} />}
                </Fragment>
              ))}
              <td style={{ ...STICKY_R, textAlign: 'right', fontFamily: MONO, fontSize: 12.5,
                           fontWeight: 700, color: 'var(--color-gray-900)', paddingLeft: 20,
                           verticalAlign: 'bottom', paddingBottom: 22 }}>
                {totals.window}
              </td>
              {hasTypes && (['outpatient', 'sda', 'inpatient']).map((t, k) => (
                <td key={t} style={{ textAlign: 'right', fontFamily: MONO, fontSize: 12.5,
                             fontWeight: 700, color: 'var(--color-gray-700)',
                             paddingLeft: k === 0 ? 18 : 12, verticalAlign: 'bottom',
                             paddingBottom: 22, borderLeft: k === 0 ? RULE : undefined }}>
                  {typeTotal(t)}
                </td>
              ))}
            </tr>
            <tr><td colSpan={cols} style={{ padding: 0, height: 1,
                    borderBottom: '1px solid var(--color-border-secondary)' }} /></tr>
          </thead>
          <tbody>
            {services.map(s => (
              <tr key={s.service}>
                <th scope="row" style={{ ...STICKY_L, textAlign: 'left', fontSize: 13.5,
                          fontWeight: 500, color: 'var(--color-gray-700)', height: 29,
                          whiteSpace: 'nowrap', padding: '0 14px 0 0' }}>
                  {s.service}
                </th>
                <td style={GAP} />
                {bands.map((b, i) => (
                  <Fragment key={b.weekOf}>
                    {b.days.map(j => {
                      const v = s.byDate[j]
                      return (
                        <td key={dates[j].date}
                            title={`${s.service} · ${longDate(dates[j].date, dates[j].dow)}: ${v} cases`}
                            style={{ ...MTD, opacity: dates[j].holiday ? 0.42 : 1,
                                     ...inkStep(v, peak) }}>
                          {v}
                        </td>
                      )
                    })}
                    {i < bands.length - 1 && <td style={GAP} />}
                  </Fragment>
                ))}
                <td style={{ ...STICKY_R, textAlign: 'right', fontFamily: MONO, fontSize: 12.5,
                             fontWeight: 600, color: 'var(--color-gray-900)', paddingLeft: 20,
                             width: 52 }}>
                  {s.total}
                </td>
                {hasTypes && (['outpatient', 'sda', 'inpatient']).map((t, k) => (
                  // No shading in the new block: the sequential scale stays on
                  // the date cells; these read as plain magnitudes.
                  <td key={t} style={{ textAlign: 'right', fontFamily: MONO, fontSize: 12.5,
                               color: 'var(--color-gray-700)', paddingLeft: k === 0 ? 18 : 12,
                               width: 46, borderLeft: k === 0 ? RULE : undefined }}>
                    {s.byType?.[t] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
            {hasTypes && types.map((t, ti) => {
              // Type × date, indented under Total and muted so the three rows
              // read as its decomposition. A rule above separates them from the
              // service rows; no shading, per section 4.
              const top = ti === 0 ? RULE : undefined
              return (
                <tr key={`type-${t.type}`}>
                  <th scope="row" style={{ ...STICKY_L, textAlign: 'left', fontSize: 12.5,
                            fontWeight: 400, color: 'var(--color-gray-500)', height: 26,
                            whiteSpace: 'nowrap', padding: '0 14px 0 18px', borderTop: top }}>
                    {TYPE_LABEL[t.type] || t.type}
                  </th>
                  <td style={{ ...GAP, borderTop: top }} />
                  {bands.map((b, i) => (
                    <Fragment key={b.weekOf}>
                      {b.days.map(j => (
                        <td key={dates[j].date} style={{ ...MTD, color: 'var(--color-gray-500)',
                                     opacity: dates[j].holiday ? 0.42 : 1, borderTop: top }}>
                          {t.byDate[j]}
                        </td>
                      ))}
                      {i < bands.length - 1 && <td style={{ ...GAP, borderTop: top }} />}
                    </Fragment>
                  ))}
                  <td style={{ ...STICKY_R, textAlign: 'right', fontFamily: MONO, fontSize: 12,
                               color: 'var(--color-gray-600)', paddingLeft: 20, borderTop: top }}>
                    {t.total}
                  </td>
                  <td colSpan={3} style={{ borderTop: top, borderLeft: RULE }} />
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 16, display: 'flex', gap: 20, alignItems: 'center',
                    flexWrap: 'wrap', fontSize: 12, color: 'var(--color-gray-500)' }}>
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontFamily: MONO }}>
          Fewer
          {INK_STEPS.map((s, i) => {
            const v = Math.max(1, Math.round((i === INK_STEPS.length - 1 ? 1 : s.at) * peak))
            return <span key={s.at} style={{ fontSize: 12, ...inkStep(v, peak) }}>{v}</span>
          })}
          More cases
        </span>
        <span>Bars: total cases that day</span>
        <span style={{ opacity: 0.5 }}>Muted column: holiday</span>
      </div>

      {hasTypes && (
        <p style={{ marginTop: 10, fontSize: 12, color: 'var(--color-gray-500)' }}>
          Same-day admit arrives from home and is admitted after surgery; inpatient
          was already admitted before it.
        </p>
      )}
    </div>
  )
}

/* The two-component split is never collapsed: four weeks out an elective
   schedule is only partly filled, and a tool reading the booked schedule alone
   systematically under-counts. Showing both is the answer to "why isn't this
   the EMR's own report?" */
/* One header, not two stacked bars. The page title carries the selectors on its
   own row and the summary sits directly beneath, so the chrome above the tabs is
   about half what it was and the grid starts higher up the page.

   The two-component split is never collapsed: four weeks out an elective
   schedule is only partly filled, and a tool reading the booked schedule alone
   systematically under-counts. Showing both is the answer to "why isn't this
   the EMR's own report?" */
export function ContextHeader({ summary, sites, site, onSite, weeks, onWeeks }) {
  return (
    <div style={{ marginBottom: 'var(--space-4)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 className="page-title" style={{ margin: 0 }}>Volume Impact</h1>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <select className="form-input" value={site} onChange={e => onSite(e.target.value)}>
            <option value="">All sites</option>
            {sites.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <select className="form-input" value={weeks} onChange={e => onWeeks(Number(e.target.value))}>
            {[2, 4, 6].map(w => <option key={w} value={w}>Next {w} weeks</option>)}
          </select>
        </div>
      </div>
      {summary && (
        <div style={{ marginTop: 12, display: 'flex', alignItems: 'baseline', gap: 10,
                      flexWrap: 'wrap', fontSize: 'var(--font-size-sm)',
                      color: 'var(--color-gray-500)' }}>
          <span style={{ color: 'var(--color-gray-800)' }}>
            <strong style={{ fontSize: 'var(--font-size-lg)' }}>{fmt0(summary.forecast)} cases</strong>
            {' '}forecast
          </span>
          <span>·</span>
          <span>{fmt0(summary.booked)} booked + ~{fmt0(summary.expectedAdds)} expected to book</span>
          {summary.variancePct != null && (
            <>
              <span>·</span>
              <span style={{ fontWeight: 700,
                             color: summary.variancePct > 0 ? '#b91c1c' : '#1d4ed8' }}>
                {signedPct(summary.variancePct)} vs budget
              </span>
            </>
          )}
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

export function InpatientTab({ data }) {
  if (!data) return null
  const dates = data.units[0]?.days ?? []
  return (
    <>
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

/* ─── Tab 4 — Rooms to Target (StaffingRoomsToTarget.md) ──────────────────────
   Utilisation is demand / staffed, so the rooms you open is the lever. Each day
   shows demand against staffed rooms, the rooms that hit target (notch), the
   feasibility floor (muted marker), and a half-room stepper that recomputes the
   row and the summary live. Same outline/fill idiom as the Block Allocations
   week shape. */

const halfRoom = n => Math.round(n * 2) / 2
const ceilHalf = n => Math.ceil(n * 2) / 2
const fmtRoom = n => (n % 1 ? n.toFixed(1) : String(n))
const TIGHT = '#b45309'

export function StaffingTab({ data }) {
  const [target, setTarget] = useState(0.75)
  const [roomsOv, setRoomsOv] = useState({})   // date|site -> what-if rooms
  const [sel, setSel] = useState(0)
  // A new window or site is a fresh dataset: reset the what-if and selection,
  // and adopt the tenant's configured target.
  useEffect(() => {
    if (data?.target) setTarget(data.target)
    setRoomsOv({}); setSel(0)
  }, [data])

  if (!data) return null
  const days = (data.days || [])
  if (!days.length) {
    return <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-gray-400)' }}>
      No staffing plan or forecast volume in this window.
    </p>
  }

  const keyOf = d => `${d.date}|${d.site}`
  const roomsOf = d => roomsOv[keyOf(d)] ?? d.plannedRooms
  const multiSite = new Set(days.map(d => d.site)).size > 1

  function calc(d) {
    const shift = d.shiftHours
    const r = roomsOf(d)
    const util = r > 0 ? d.demandRoomHours / (r * shift) : 0
    const need = halfRoom(d.demandRoomHours / (target * shift))   // roomsForTarget at chosen target
    const floorBinds = need < d.floorRooms - 1e-9
    const rec = floorBinds ? d.floorRooms : need
    const delta = +(rec - r).toFixed(1)
    const atTarget = rec > 0 ? d.demandRoomHours / (rec * shift) : 0
    return { shift, r, util, need, rec, floorBinds, delta, atTarget,
             demandRooms: shift > 0 ? d.demandRoomHours / shift : 0 }
  }

  function step(d, s) {
    setRoomsOv(o => ({ ...o, [keyOf(d)]: Math.max(1, Math.min(20, roomsOf(d) + s)) }))
  }

  // Summary: utilisation now, at the recommended plan, and the net room-day move.
  let dem = 0, capNow = 0, capRec = 0, net = 0
  const byDow = {}
  days.forEach(d => {
    const c = calc(d)
    dem += d.demandRoomHours; capNow += c.r * c.shift; capRec += c.rec * c.shift
    net += c.rec - d.plannedRooms
    byDow[d.label] = (byDow[d.label] || 0) + (c.rec - d.plannedRooms)
  })
  const projUtil = capNow > 0 ? dem / capNow : 0
  const recUtil = capRec > 0 ? dem / capRec : 0
  // Lead with redistribution, not reduction: name the day giving up the most and
  // the day needing the most.
  const dows = Object.entries(byDow)
  const giver = dows.filter(([, v]) => v < -0.5).sort((a, b) => a[1] - b[1])[0]
  const needer = dows.filter(([, v]) => v > 0.5).sort((a, b) => b[1] - a[1])[0]
  let insight
  if (giver && needer) {
    insight = <>{giver[0]}s give up <strong>{fmtRoom(-giver[1])}</strong> room-days over this window
      while {needer[0]}s need <strong>{fmtRoom(needer[1])}</strong> more — a case for moving capacity
      across the week, not cutting it.</>
  } else if (giver) {
    insight = <>The window frees <strong>{fmtRoom(-net)}</strong> room-days, concentrated on {giver[0]}s.
      Redeploy before reducing.</>
  } else if (needer) {
    insight = <>The window needs <strong>{fmtRoom(net)}</strong> more room-days, concentrated on {needer[0]}s.</>
  } else {
    insight = <>Staffing holds at target across the window; no material redistribution.</>
  }

  const stat = (k, v, n) => (
    <div style={{ minWidth: 150 }}>
      <div style={{ fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-gray-500)', fontWeight: 600 }}>{k}</div>
      <div style={{ fontSize: 24, fontWeight: 700, marginTop: 2 }}>{v}</div>
      {n && <div style={{ fontSize: 12, color: 'var(--color-gray-500)', marginTop: 1 }}>{n}</div>}
    </div>
  )

  return (
    <div>
      {/* Summary strip */}
      <div className="card" style={{ padding: '18px 20px', marginBottom: 14 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '20px 40px', alignItems: 'flex-start' }}>
          {stat('Projected utilisation', `${Math.round(projUtil * 100)}%`,
                `${Math.round(dem)} of ${Math.round(capNow)} staffed room-hours`)}
          {stat('At the recommended plan', `${Math.round(recUtil * 100)}%`,
                `target ${Math.round(target * 100)}%`)}
          {stat('Net change', <>{net > 0 ? '+' : ''}{fmtRoom(net)} <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--color-gray-500)' }}>room-days</span></>,
                `across ${days.length} operating days`)}
        </div>
        <p style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--surface-border)',
                    fontSize: 13, color: 'var(--color-gray-600)', maxWidth: '80ch' }}>{insight}</p>
      </div>

      {/* Target control */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--color-gray-600)', fontWeight: 600 }}>Target prime-time utilisation</span>
        <div style={{ display: 'inline-flex', border: '1px solid var(--surface-border)', borderRadius: 7, overflow: 'hidden' }}>
          {[0.70, 0.75, 0.80].map(t => {
            const on = Math.abs(target - t) < 1e-9
            return (
              <button key={t} type="button" onClick={() => setTarget(t)}
                      style={{ border: 'none', borderRight: '1px solid var(--surface-border)', padding: '5px 13px',
                               fontSize: 12.5, cursor: 'pointer', font: 'inherit',
                               background: on ? 'var(--color-blue)' : '#fff',
                               color: on ? '#fff' : 'var(--color-gray-600)', fontWeight: on ? 700 : 500 }}>
                {Math.round(t * 100)}%
              </button>
            )
          })}
        </div>
        <span style={{ fontSize: 12, color: 'var(--color-gray-400)' }}>Rooms shown to the half-day. Per-room type (robot, hybrid) not modelled.</span>
      </div>

      {/* Day list */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '128px minmax(160px,1fr) 130px 190px 92px',
                      gap: 14, padding: '9px 18px', fontSize: 11, letterSpacing: '0.05em',
                      textTransform: 'uppercase', color: 'var(--color-gray-500)', fontWeight: 600,
                      borderBottom: '2px solid var(--surface-border)', background: '#f8f9fb' }}>
          <div>Day</div><div>Demand against staffed rooms</div><div>Utilisation</div>
          <div>To reach target</div><div style={{ textAlign: 'right' }}>Rooms</div>
        </div>
        {days.map((d, i) => {
          const c = calc(d)
          const max = Math.max(c.r, c.need, c.demandRooms, d.floorRooms) * 1.06 || 1
          const pct = v => `${(v / max) * 100}%`
          const over = c.demandRooms > c.r
          const active = i === sel
          let act, col
          if (c.floorBinds)            { act = `Floor is ${fmtRoom(d.floorRooms)} rooms (peak demand)`; col = 'var(--color-gray-500)' }
          else if (Math.abs(c.delta) < 0.5) { act = 'Holds at target'; col = 'var(--color-gray-400)' }
          else if (c.delta > 0)        { act = `Needs ${fmtRoom(c.delta)} more rooms`; col = TIGHT }
          else                         { act = `Close ${fmtRoom(-c.delta)} rooms`; col = 'var(--color-gray-600)' }
          return (
            <div key={keyOf(d)} onClick={() => setSel(i)}
                 style={{ display: 'grid', gridTemplateColumns: '128px minmax(160px,1fr) 130px 190px 92px',
                          gap: 14, padding: '10px 18px', alignItems: 'center', cursor: 'pointer',
                          borderBottom: i < days.length - 1 ? '1px solid #f0f1f3' : 'none',
                          background: active ? 'rgba(59,130,246,0.06)' : 'transparent',
                          boxShadow: active ? 'inset 3px 0 0 var(--color-blue)' : 'none' }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>
                {d.label.slice(0, 3)} <span style={{ fontWeight: 400, color: 'var(--color-gray-400)' }}>{d.date}</span>
                {multiSite && <span style={{ display: 'block', fontWeight: 400, fontSize: 11, color: 'var(--color-gray-400)' }}>{d.site}</span>}
              </div>
              {/* Ladder: track = staffed, fill = demand, overflow = tight, notch = target, floor = muted */}
              <div style={{ position: 'relative', height: 24 }}>
                <div style={{ position: 'absolute', top: 5, bottom: 5, left: 0, right: pct(max - c.r),
                              background: 'var(--color-gray-100)', border: '1px solid var(--surface-border)', borderRadius: 4 }} />
                <div style={{ position: 'absolute', top: 5, bottom: 5, left: 0, width: pct(Math.min(c.demandRooms, c.r)),
                              background: 'var(--color-blue)', borderRadius: '4px 2px 2px 4px' }} />
                {over && <div style={{ position: 'absolute', top: 5, bottom: 5, left: pct(c.r), width: pct(c.demandRooms - c.r),
                              background: TIGHT, borderRadius: '2px 4px 4px 2px', borderLeft: '2px solid #fff' }} />}
                <div title="Feasibility floor" style={{ position: 'absolute', top: 2, bottom: 2, left: pct(d.floorRooms),
                              width: 0, borderLeft: '2px dashed var(--color-gray-400)' }} />
                <div title="Rooms that hit target" style={{ position: 'absolute', top: 1, bottom: 1, left: pct(c.need),
                              width: 2, background: 'var(--color-gray-900)', borderRadius: 1 }} />
              </div>
              <div style={{ fontVariantNumeric: 'tabular-nums', fontSize: 13 }}>
                <strong>{Math.round(c.util * 100)}%</strong>
                <span style={{ color: 'var(--color-gray-500)' }}> → {Math.round(c.atTarget * 100)}%</span>
              </div>
              <div style={{ fontSize: 12.5, color: col, fontWeight: col === TIGHT ? 600 : 400 }}>{act}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, justifyContent: 'flex-end' }}
                   onClick={e => e.stopPropagation()}>
                <button type="button" onClick={() => step(d, -0.5)} aria-label="Close half a room"
                        style={stepBtn}>−</button>
                <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 13, fontWeight: 600, minWidth: 28, textAlign: 'center' }}>{fmtRoom(c.r)}</span>
                <button type="button" onClick={() => step(d, 0.5)} aria-label="Open half a room"
                        style={stepBtn}>+</button>
              </div>
            </div>
          )
        })}
      </div>

      <StaffingDetail day={days[sel]} calc={calc(days[sel])} />

      <p style={{ marginTop: 18, fontSize: 12, color: 'var(--color-gray-400)' }}>
        The stepper is a what-if; it does not write back to the staffing plan. Figures are demo data.
      </p>
    </div>
  )
}

const stepBtn = {
  width: 24, height: 24, border: '1px solid var(--surface-border)', background: '#fff',
  color: 'var(--color-gray-600)', borderRadius: 5, font: 'inherit', fontSize: 14, lineHeight: 1,
  cursor: 'pointer', padding: 0,
}

/* Detail: rooms-in-use by hour (bars), the flat staffed plan (dashed), and the
   two-block stepped plan (solid). One sentence states the finding. When the hour
   shape is unavailable the stepped plan is suppressed and the flat plan stands. */
function StaffingDetail({ day, calc }) {
  if (!day) return null
  const shape = day.hourShape || []
  const start = day.shiftStartHour ?? 7
  const r = calc.r
  const splitIdx = Math.max(0, Math.min(shape.length, 13 - start))   // 13:00
  const morning = shape.slice(0, splitIdx)
  const afternoon = shape.slice(splitIdx)
  const half1 = ceilHalf(Math.max(0, ...morning))
  const half2 = ceilHalf(Math.max(0, ...afternoon))
  const steppedCap = half1 * morning.length + half2 * afternoon.length
  const stepUtil = steppedCap > 0 ? Math.round(day.demandRoomHours / steppedCap * 100) : null
  const peakIdx = shape.indexOf(Math.max(...shape))
  const peakHour = String(start + (peakIdx < 0 ? 0 : peakIdx)).padStart(2, '0')

  // SVG geometry
  const W = 640, H = 210, PL = 40, PR = 14, PT = 16, PB = 30
  const iw = W - PL - PR, ih = H - PT - PB
  const maxR = Math.max(r, day.floorRooms, ...shape, 1) + 1
  const n = shape.length || 1
  const bw = iw / n
  const xs = h => PL + h * bw
  const ys = v => PT + ih - (v / maxR) * ih

  const bars = shape.map((v, h) =>
    `<rect x="${xs(h) + 1.5}" y="${ys(v)}" width="${Math.max(0, bw - 3)}" height="${ih - (ys(v) - PT)}" rx="3" fill="var(--color-blue)" opacity="0.9"/>`).join('')
  const grid = []
  const gstep = maxR > 10 ? 3 : 2
  for (let g = 0; g <= maxR; g += gstep) {
    grid.push(`<line x1="${PL}" x2="${W - PR}" y1="${ys(g)}" y2="${ys(g)}" stroke="var(--surface-border)"/>`
      + `<text x="${PL - 7}" y="${ys(g) + 4}" text-anchor="end" font-size="10" fill="var(--color-gray-400)">${g}</text>`)
  }
  const ticks = shape.map((_, h) =>
    `<text x="${xs(h) + bw / 2}" y="${H - 12}" text-anchor="middle" font-size="10" fill="var(--color-gray-400)">${String(start + h).padStart(2, '0')}</text>`).join('')
  const flat = `<line x1="${PL}" x2="${W - PR}" y1="${ys(r)}" y2="${ys(r)}" stroke="var(--color-gray-400)" stroke-width="2" stroke-dasharray="5 4"/>`
    + `<text x="${W - PR}" y="${ys(r) - 6}" text-anchor="end" font-size="10" font-weight="600" fill="var(--color-gray-500)">${fmtRoom(r)} staffed</text>`
  const stepped = day.hasShape
    ? `<path d="M${xs(0)} ${ys(half1)} H${xs(splitIdx)} V${ys(half2)} H${xs(n)}" fill="none" stroke="${TIGHT}" stroke-width="2.5" stroke-linejoin="round"/>`
    : ''

  const finding = day.hasShape
    ? `A flat plan of ${fmtRoom(r)} rooms runs at ${Math.round(calc.util * 100)}%. Peak demand is `
      + `${fmtRoom(day.peakRooms)} rooms, so utilisation cannot be fixed by a smaller `
      + `rectangle — the floor is set by the busiest hour. Staffing ${fmtRoom(half1)} rooms to 13:00 and `
      + `${fmtRoom(half2)} after reaches ${stepUtil}% without moving a case.`
    : `Hour-level shape is unavailable for this day, so only the flat recommendation is shown: `
      + `${fmtRoom(calc.rec)} rooms reaches ${Math.round(calc.atTarget * 100)}%.`

  return (
    <div className="card" style={{ marginTop: 18, padding: '16px 20px 18px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 16, flexWrap: 'wrap' }}>
        <div className="card-title" style={{ fontSize: 15 }}>{day.label.slice(0, 3)} {day.date} — demand by hour</div>
        <div style={{ fontSize: 12.5, color: 'var(--color-gray-500)', fontVariantNumeric: 'tabular-nums' }}>
          {fmt1(day.demandRoomHours)} room-hours · peak {fmtRoom(day.peakRooms)} rooms at {peakHour}:00
        </div>
      </div>
      <p style={{ fontSize: 13, color: 'var(--color-gray-600)', margin: '4px 0 12px', maxWidth: '78ch' }}>{finding}</p>
      <div style={{ overflowX: 'auto' }}>
        <div style={{ minWidth: 520 }} dangerouslySetInnerHTML={{ __html:
          `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Rooms in use by hour" style="display:block;width:100%;height:auto">`
          + grid.join('') + bars + flat + stepped + ticks + `</svg>` }} />
      </div>
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 10, fontSize: 12, color: 'var(--color-gray-500)' }}>
        <span><i style={{ display: 'inline-block', width: 16, height: 9, background: 'var(--color-blue)', borderRadius: 2, marginRight: 6, verticalAlign: 'middle' }} />Rooms in use</span>
        <span><i style={{ display: 'inline-block', width: 16, height: 0, borderTop: '2px dashed var(--color-gray-400)', marginRight: 6, verticalAlign: 'middle' }} />Staffed now (flat)</span>
        {day.hasShape && <span><i style={{ display: 'inline-block', width: 16, height: 0, borderTop: `2px solid ${TIGHT}`, marginRight: 6, verticalAlign: 'middle' }} />Stepped plan</span>}
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
  const [breakdown, setBreakdown] = useState(null)
  const [budget, setBudget] = useState(null)
  const [inpatient, setInpatient] = useState(null)
  const [staffing, setStaffing] = useState(null)
  const [recovery, setRecovery] = useState(null)
  const [mix, setMix] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

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
    return `from=${from}&to=${to}${s}`
  }, [weeks, site])

  // One selection, four consequences: the tabs never disagree about which
  // forecast they are describing.
  useEffect(() => {
    setLoading(true); setError(null)
    const q = range()
    Promise.all([
      fetch(`/api/impact/summary?${q}`).then(readJson),
      fetch(`/api/impact/breakdown?${q}`).then(readJson).catch(() => null),
      fetch(`/api/impact/budget?${q}&bySite=true`).then(readJson),
      fetch(`/api/impact/inpatient?${q}`).then(readJson).catch(() => null),
      fetch(`/api/impact/staffing?${q}`).then(readJson).catch(() => null),
      fetch(`/api/impact/recovery?${q}`).then(readJson).catch(() => null),
    ])
      .then(([s, bd, b, i, st, r]) => {
        if (s?.error) throw new Error(s.error)
        setSummary(s); setBreakdown(bd?.error ? null : bd)
        setBudget(b); setInpatient(i); setStaffing(st); setRecovery(r)
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
      <ContextHeader
        summary={summary} sites={sites} site={site} onSite={setSite}
        weeks={weeks} onWeeks={setWeeks}
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
          {active === 'breakdown' && <ServiceLineBreakdownTab data={breakdown} />}
          {active === 'budget'    && <BudgetTab data={budget} mix={mix} onExpand={loadMix} />}
          {active === 'inpatient' && <InpatientTab data={inpatient} />}
          {active === 'staffing'  && <StaffingTab data={staffing} />}
          {active === 'recovery'  && <RecoveryTab data={recovery} />}
        </>
      )}
    </div>
  )
}

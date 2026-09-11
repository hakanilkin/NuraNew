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

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
const MTH = { padding: '0 0 8px', fontSize: 11, fontWeight: 500, textAlign: 'center',
              fontFamily: MONO, color: 'var(--color-gray-500)', whiteSpace: 'nowrap',
              lineHeight: 1.25 }
const MTD = { padding: 0, height: 29, textAlign: 'center', fontFamily: MONO,
              fontSize: 12.5, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }
const BAND_LABEL = { fontFamily: MONO, fontSize: 10, fontWeight: 600, letterSpacing: '.11em',
                     textTransform: 'uppercase', color: 'var(--color-gray-400)',
                     textAlign: 'left', padding: '0 0 5px 4px' }
const GAP = { width: 14 }

const ACCENT = '62,83,227'   // subtle tints; saturated blue is reserved for focus + emphasis

/* Typical = the trailing weekday baseline from the endpoint; when a tenant has
   no history we fall back to the window's own weekday mean so the "unusual day"
   read still works. */
function typicalArr(data) {
  const { totals, dates } = data
  if (totals.typical && totals.typical.some(v => v > 0)) return totals.typical
  const byDow = {}
  dates.forEach((d, i) => { (byDow[d.dow] ||= []).push(totals.byDate[i]) })
  return dates.map(d => { const a = byDow[d.dow]; return a.reduce((s, v) => s + v, 0) / a.length })
}
function svcTypicalArr(s, data) {
  if (s.typical && s.typical.some(v => v > 0)) return s.typical
  const { dates } = data
  const byDow = {}
  dates.forEach((d, i) => { (byDow[d.dow] ||= []).push(s.byDate[i]) })
  return dates.map(d => { const a = byDow[d.dow]; return a.reduce((x, v) => x + v, 0) / a.length })
}
const dayLevel = (v, typ) => {
  if (!typ) return 'normal'
  const r = v / typ
  return r >= 1.10 ? 'heavy' : r <= 0.90 ? 'light' : 'normal'
}

/* Two or three operational insights an OR director can act on: which day is
   unusual, what is driving it, what to do. Each carries the day + driver
   services so a click can highlight them in the matrix. */
function buildInsights(data) {
  if (!data?.dates?.length) return []
  const typ = typicalArr(data)
  const svcTyp = data.services.map(s => svcTypicalArr(s, data))
  const items = data.dates.map((d, i) => {
    const cases = data.totals.byDate[i]
    const t = typ[i] || 0
    const pct = t > 0 ? Math.round((cases / t - 1) * 100) : 0
    const drivers = data.services
      .map((s, si) => ({ service: s.service, dev: s.byDate[i] - (svcTyp[si][i] || 0) }))
      .filter(x => x.dev > 0.5).sort((a, b) => b.dev - a.dev).slice(0, 2)
    return { date: d.date, dow: d.dow, cases, t, pct, drivers }
  })
  const heavy = items.filter(x => x.pct >= 12 && x.t > 0).sort((a, b) => b.pct - a.pct)
  const light = items.filter(x => x.pct <= -18 && x.t > 0).sort((a, b) => a.pct - b.pct)
  const chosen = heavy.slice(0, 2)
  if (light.length && chosen.length < 3) chosen.push(light[0])
  return chosen.slice(0, 3).map(x => {
    const dl = `${['Mon', 'Tue', 'Wed', 'Thu', 'Fri'][x.dow]} ${shortDate(x.date)}`
    const names = x.drivers.map(d => d.service)
    if (x.pct >= 12) {
      const drv = names.length ? `${names.join(' and ')} drive the increase — ` : ''
      return { date: x.date, services: names, tone: 'heavy',
        headline: `${dl}: ${x.cases} cases, ${x.pct}% above typical`,
        detail: `${drv}review staffing and PACU capacity.` }
    }
    return { date: x.date, services: [], tone: 'light',
      headline: `${dl}: ${x.cases} cases, ${Math.abs(x.pct)}% below typical`,
      detail: 'A light day — consolidate rooms or offer the open time out.' }
  })
}

/* ── Executive KPI strip (point 1) ─────────────────────────────────────────── */
export function KpiCards({ summary }) {
  if (!summary) return null
  const { forecast: f, booked: b, expectedAdds: e, budget, variancePct } = summary
  const bookedPct = f ? Math.round(b / f * 100) : null
  const remPct = f ? Math.round(e / f * 100) : null
  const over = variancePct > 0
  const cards = [
    { k: 'Forecast cases', v: fmt0(f), sub: `${fmt0(b)} booked · ~${fmt0(e)} to book` },
    { k: 'Booked', v: fmt0(b), sub: bookedPct != null ? `${bookedPct}% of forecast` : '' },
    { k: 'Expected to book', v: `~${fmt0(e)}`, sub: remPct != null ? `${remPct}% still to come` : '' },
    { k: 'Variance vs budget', v: signedPct(variancePct),
      sub: `${fmt0(f)} vs ${fmt0(budget)} budget`, accent: variancePct == null ? null : (over ? '#b45309' : '#15803d') },
  ]
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12, marginBottom: 14 }}>
      {cards.map(c => (
        <div key={c.k} className="card" style={{ padding: '13px 16px' }}>
          <div style={{ fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--color-gray-500)', fontWeight: 600 }}>{c.k}</div>
          <div style={{ fontSize: 28, fontWeight: 700, lineHeight: 1.1, marginTop: 4, color: c.accent || 'var(--color-gray-900)' }}>{c.v}</div>
          <div style={{ fontSize: 12, color: 'var(--color-gray-500)', marginTop: 3 }}>{c.sub}</div>
        </div>
      ))}
    </div>
  )
}

/* ── Attention / recommended actions (point 2) ─────────────────────────────── */
export function AttentionPanel({ insights, focus, onFocus }) {
  if (!insights?.length) return null
  return (
    <div className="card" style={{ padding: '14px 16px', marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10 }}>
        <AlertTriangle size={15} style={{ color: '#b45309' }} />
        <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--color-gray-600)' }}>
          Attention · recommended actions
        </span>
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        {insights.map((it, k) => {
          const on = focus?.date === it.date
          return (
            <button key={k} type="button" onClick={() => onFocus(on ? null : { date: it.date, services: it.services })}
              style={{ textAlign: 'left', font: 'inherit', cursor: 'pointer', display: 'flex', gap: 10, alignItems: 'baseline',
                       border: `1px solid ${on ? 'var(--color-blue)' : 'var(--surface-border)'}`, borderRadius: 'var(--radius-lg)',
                       background: on ? 'rgba(59,130,246,0.06)' : '#fff', padding: '10px 12px' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, marginTop: 5,
                             background: it.tone === 'heavy' ? '#b45309' : 'var(--color-gray-400)' }} />
              <span style={{ fontSize: 13 }}>
                <strong style={{ color: 'var(--color-gray-900)' }}>{it.headline}.</strong>{' '}
                <span style={{ color: 'var(--color-gray-600)' }}>{it.detail}</span>
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

const MODES = [
  { id: 'volume', label: 'Volume' },
  { id: 'typical', label: 'vs Typical' },
  { id: 'budget', label: 'vs Budget' },
]

function caseMix(s) {
  const b = s.byType
  if (!b) return null
  const tot = b.outpatient + b.sda + b.inpatient
  if (!tot) return { text: '—', title: '' }
  const p = n => Math.round(n / tot * 100)
  return { text: `${p(b.outpatient)}% OP · ${p(b.sda)}% SDA · ${p(b.inpatient)}% IP`,
           title: `Outpatient ${b.outpatient} · Same-day admit ${b.sda} · Inpatient ${b.inpatient}` }
}

export function ServiceLineBreakdownTab({ data, focus, onFocus }) {
  const [mode, setMode] = useState('volume')
  useEffect(() => { setMode('volume') }, [data])
  if (!data) return null
  if (!data.dates?.length) {
    return <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-gray-400)' }}>No forecast volume in this window.</p>
  }
  const { dates, services, totals } = data
  const hasContext = !!data.hasContext
  const hasMix = services.some(s => s.byType)
  const activeMode = hasContext ? mode : 'volume'

  const bands = []
  for (const [i, d] of dates.entries()) {
    const last = bands[bands.length - 1]
    if (last && last.weekOf === d.weekOf) last.days.push(i)
    else bands.push({ weekOf: d.weekOf, days: [i] })
  }
  const typ = typicalArr(data)
  const maxTotal = Math.max(1, ...totals.byDate)
  const cols = 1 + dates.length + (bands.length - 1) + 1 + 1 + (hasMix ? 1 : 0)

  const MUTED = 'var(--color-gray-600)'
  const PRIMARY = 'var(--color-gray-900)'
  const GUTTER = { width: 24 }

  const renderDays = fn => bands.map((b, bi) => (
    <Fragment key={b.weekOf}>
      {b.days.map(fn)}
      {bi < bands.length - 1 && <td className="wkdiv" />}
    </Fragment>
  ))

  // Cell background + optional variance mark for the active mode.
  function cellFx(s, i) {
    const v = s.byDate[i]
    if (activeMode === 'volume') {
      if (!v) return { bg: '#fff' }
      const rowMax = Math.max(1, ...s.byDate)
      const a = 0.05 + 0.32 * Math.min(1, v / rowMax)
      return { bg: `rgba(${ACCENT},${a.toFixed(3)})`, color: MUTED }
    }
    const base = activeMode === 'typical' ? (s.typical?.[i] ?? 0) : (s.budget?.[i] ?? 0)
    if (!v && !base) return { bg: '#fff' }
    const rel = base ? (v - base) / base : 0
    if (Math.abs(rel) < 0.08) return { bg: '#fff', color: MUTED }
    const a = (0.08 + 0.32 * Math.min(1, Math.abs(rel) / 0.5)).toFixed(3)
    return rel > 0
      ? { bg: `rgba(180,83,9,${a})`, color: '#7c3a0a', arrow: '↑' }
      : { bg: `rgba(37,99,235,${a})`, color: '#1e40af', arrow: '↓' }
  }
  const cellTitle = (s, i) => {
    const f = s.byDate[i]
    const L = [`${s.service} · ${longDate(dates[i].date, dates[i].dow)}`, `Forecast ${f} cases`]
    if (s.booked) L.push(`Booked ${s.booked[i]} · +${f - s.booked[i]} expected`)
    if (s.typical) L.push(`Typical ${s.typical[i]}`)
    if (s.budget) L.push(`Budget ${s.budget[i]} (${signedPct(s.budget[i] ? (f / s.budget[i] - 1) * 100 : 0)})`)
    return L.join('\n')
  }

  const cellBase = { height: 33, textAlign: 'center', fontFamily: MONO, fontSize: 13,
                     fontVariantNumeric: 'tabular-nums' }
  const dayHdr = { padding: '0 0 8px', fontSize: 11, textAlign: 'center', width: 44, lineHeight: 1.25 }
  const totHead = { ...BAND_LABEL, textAlign: 'right', padding: '0 0 8px 10px', color: 'var(--color-gray-500)' }

  return (
    <div className="card" style={{ padding: '18px 20px 16px' }}>
      <style>{`
        .slb2 { border-collapse: separate; border-spacing: 0; }
        .slb2 td.wkdiv, .slb2 th.wkdiv { width: 13px; border-right: 1px solid var(--surface-border); }
        .slb2 td.cell { transition: box-shadow .1s; }
        .slb2 td.colfocus { box-shadow: inset 0 0 0 9999px rgba(59,130,246,0.06); }
        .slb2 td.cellfocus { outline: 2px solid var(--color-blue); outline-offset: -2px; border-radius: 3px; }
      `}</style>

      {/* Mode control + clear (point 5) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        {hasContext && (
          <div style={{ display: 'inline-flex', border: '1px solid var(--surface-border)', borderRadius: 7, overflow: 'hidden' }}>
            {MODES.map(m => {
              const on = activeMode === m.id
              return (
                <button key={m.id} type="button" onClick={() => setMode(m.id)}
                  style={{ border: 'none', borderRight: '1px solid var(--surface-border)', padding: '5px 12px',
                           fontSize: 12.5, cursor: 'pointer', font: 'inherit',
                           background: on ? 'var(--color-blue)' : '#fff', color: on ? '#fff' : 'var(--color-gray-600)',
                           fontWeight: on ? 700 : 500 }}>{m.label}</button>
              )
            })}
          </div>
        )}
        <span style={{ fontSize: 12, color: 'var(--color-gray-400)' }}>
          {activeMode === 'volume' ? 'Forecast cases; darker = busier for that service line.'
            : activeMode === 'typical' ? 'Shaded where the day runs above (↑) or below (↓) the trailing weekday typical.'
            : 'Shaded where the day runs above (↑) or below (↓) budget.'}
        </span>
        {focus && (
          <button type="button" onClick={() => onFocus(null)}
            style={{ marginLeft: 'auto', border: 'none', background: 'none', cursor: 'pointer',
                     fontSize: 12, color: 'var(--color-blue)', fontWeight: 600 }}>Clear highlight</button>
        )}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table className="slb2" style={{ width: '100%', fontVariantNumeric: 'tabular-nums' }}>
          <thead>
            <tr>
              <th />
              {bands.map((b, i) => (
                <Fragment key={b.weekOf}>
                  <th colSpan={b.days.length} style={BAND_LABEL}>{shortDate(b.weekOf)}</th>
                  {i < bands.length - 1 && <th className="wkdiv" />}
                </Fragment>
              ))}
              <th style={GUTTER} />
              <th style={totHead}>Total</th>
              {hasMix && <th style={{ ...totHead, textAlign: 'left', paddingLeft: 16, width: 150 }}>Case mix</th>}
            </tr>
            <tr>
              <th />
              {renderDays(j => {
                const d = dates[j]
                return (
                  <th key={d.date} scope="col" onClick={() => onFocus(focus?.date === d.date ? null : { date: d.date, services: [] })}
                      title={d.holiday ? `${longDate(d.date, d.dow)} — holiday` : longDate(d.date, d.dow)}
                      style={{ ...dayHdr, cursor: 'pointer',
                               color: d.holiday ? 'var(--color-gray-400)' : 'var(--color-gray-500)' }}>
                    {DOW_INITIAL[d.dow]}
                    <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600,
                                   color: d.holiday ? 'var(--color-gray-400)' : 'var(--color-gray-600)' }}>{dayNum(d.date)}</span>
                  </th>
                )
              })}
              <th style={GUTTER} />
              <th />{hasMix && <th />}
            </tr>
            {/* Daily volume — prominence for the busiest-day read (point 3) */}
            <tr>
              <th scope="row" style={{ ...BAND_LABEL, textAlign: 'left', color: 'var(--color-gray-400)',
                        verticalAlign: 'bottom', padding: '0 0 8px' }}>Forecast / day</th>
              {renderDays(j => {
                const v = totals.byDate[j]
                const lvl = dayLevel(v, typ[j])
                const col = lvl === 'heavy' ? '#b45309' : lvl === 'light' ? 'var(--color-gray-400)' : 'var(--color-gray-800)'
                const foc = focus?.date === dates[j].date
                return (
                  <td key={dates[j].date}
                      title={`${longDate(dates[j].date, dates[j].dow)}: ${v} cases · typical ${Math.round(typ[j])} (${lvl})`}
                      style={{ textAlign: 'center', verticalAlign: 'bottom', padding: '0 0 8px' }}>
                    <div style={{ fontFamily: MONO, fontSize: 18, fontWeight: lvl === 'heavy' ? 700 : 600,
                                  color: foc ? 'var(--color-blue)' : col, lineHeight: 1 }}>{v}</div>
                    <div style={{ margin: '4px auto 0', width: 18, height: 3, borderRadius: 2,
                                  background: lvl === 'heavy' ? '#b45309' : lvl === 'light' ? 'var(--color-gray-200)' : 'var(--color-gray-300)',
                                  opacity: 0.5 + 0.5 * (v / maxTotal) }} />
                    <div style={{ fontSize: 9.5, letterSpacing: '.04em', textTransform: 'uppercase', marginTop: 3,
                                  color: lvl === 'heavy' ? '#b45309' : 'transparent', fontWeight: 600 }}>
                      {lvl === 'heavy' ? 'Heavy' : lvl === 'light' ? 'Light' : '·'}
                    </div>
                  </td>
                )
              })}
              <td style={GUTTER} />
              <td style={{ textAlign: 'right', fontFamily: MONO, fontSize: 18, fontWeight: 700, color: PRIMARY,
                           verticalAlign: 'bottom', padding: '0 0 8px 10px' }}>{totals.window}</td>
              {hasMix && <td />}
            </tr>
            <tr><td colSpan={cols} style={{ padding: 0, height: 1, borderBottom: '1px solid var(--surface-border)' }} /></tr>
          </thead>
          <tbody>
            {services.map(s => {
              const mix = hasMix ? caseMix(s) : null
              return (
                <tr key={s.service}>
                  <th scope="row" style={{ textAlign: 'left', fontSize: 13, fontWeight: 400, color: 'var(--color-gray-800)',
                            whiteSpace: 'nowrap', paddingRight: 14, height: 33 }}>{s.service}</th>
                  {renderDays(j => {
                    const v = s.byDate[j]
                    const fx = cellFx(s, j)
                    const colFoc = focus?.date === dates[j].date
                    const cellFoc = colFoc && focus?.services?.includes(s.service)
                    return (
                      <td key={dates[j].date} title={cellTitle(s, j)}
                          className={'cell' + (colFoc ? ' colfocus' : '') + (cellFoc ? ' cellfocus' : '')}
                          style={{ ...cellBase, background: fx.bg,
                                   color: v ? (fx.color || MUTED) : 'transparent' }}>
                        {v ? <>{v}{fx.arrow && <span style={{ fontSize: 10, opacity: 0.7 }}> {fx.arrow}</span>}</> : ''}
                      </td>
                    )
                  })}
                  <td style={GUTTER} />
                  <td style={{ textAlign: 'right', fontFamily: MONO, fontSize: 13, fontWeight: 640, color: PRIMARY, paddingLeft: 10, width: 52 }}>{s.total}</td>
                  {hasMix && (
                    <td title={mix?.title} style={{ textAlign: 'left', fontSize: 11.5, color: 'var(--color-gray-500)',
                                 paddingLeft: 16, whiteSpace: 'nowrap' }}>{mix?.text}</td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 14, display: 'flex', gap: 22, alignItems: 'center', flexWrap: 'wrap',
                    fontSize: 12, color: 'var(--color-gray-500)' }}>
        {activeMode === 'volume'
          ? <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ display: 'inline-flex', border: '1px solid var(--surface-border)' }}>
                {[0.1, 0.3, 0.55, 0.85].map(a => <i key={a} style={{ width: 15, height: 13, background: `rgba(${ACCENT},${a})` }} />)}
              </span> Busier day for that service
            </span>
          : <>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}><i style={{ width: 15, height: 13, background: 'rgba(180,83,9,0.3)', display: 'inline-block' }} /> Above {activeMode === 'typical' ? 'typical' : 'budget'} ↑</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}><i style={{ width: 15, height: 13, background: 'rgba(37,99,235,0.3)', display: 'inline-block' }} /> Below ↓</span>
            </>}
        <span>Click a day or an insight to highlight it. Hover a cell for booked, expected, typical and budget.</span>
      </div>
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
  const [weeks, setWeeks] = useState(2)   // ServiceLineBreakdownQuieterGrid.md §3: default 2 weeks; control still reaches 4
  const [summary, setSummary] = useState(null)
  const [breakdown, setBreakdown] = useState(null)
  const [budget, setBudget] = useState(null)
  const [inpatient, setInpatient] = useState(null)
  const [staffing, setStaffing] = useState(null)
  const [recovery, setRecovery] = useState(null)
  const [mix, setMix] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [focus, setFocus] = useState(null)   // { date, services } highlighted in the matrix

  const shown = TABS.filter(t => !available || available[t.key])
  const active = shown.some(t => t.id === tabParam) ? tabParam : (shown[0]?.id ?? 'budget')

  // An insight (or a day header) highlights the matrix; jump to it if elsewhere.
  const goFocus = f => { setFocus(f); if (f && active !== 'breakdown') navigate('/impact/breakdown') }

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
    setLoading(true); setError(null); setFocus(null)
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

      {/* Executive summary + attention: the five-second read (points 1, 2). */}
      {!error && summary && <KpiCards summary={summary} />}
      {!error && breakdown && (
        <AttentionPanel insights={buildInsights(breakdown)} focus={focus} onFocus={goFocus} />
      )}

      {/* Lighter tab bar (point 8): a single hairline, quiet inactive labels. */}
      <div style={{ display: 'flex', gap: 2, marginBottom: 18, borderBottom: '1px solid var(--surface-border)' }}>
        {shown.map(t => {
          const isActive = active === t.id
          return (
            <button key={t.id} type="button" onClick={() => navigate(`/impact/${t.id}`)}
              style={{ padding: '8px 14px', cursor: 'pointer', border: 'none', background: 'none',
                       borderBottom: `2px solid ${isActive ? 'var(--color-blue)' : 'transparent'}`,
                       marginBottom: -1, fontWeight: isActive ? 600 : 500,
                       color: isActive ? 'var(--color-blue)' : 'var(--color-gray-400)',
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
          {active === 'breakdown' && <ServiceLineBreakdownTab data={breakdown} focus={focus} onFocus={goFocus} />}
          {active === 'budget'    && <BudgetTab data={budget} mix={mix} onExpand={loadMix} />}
          {active === 'inpatient' && <InpatientTab data={inpatient} />}
          {active === 'staffing'  && <StaffingTab data={staffing} />}
          {active === 'recovery'  && <RecoveryTab data={recovery} />}
        </>
      )}
    </div>
  )
}

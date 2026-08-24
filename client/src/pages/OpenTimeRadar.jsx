import { useState, useEffect, useCallback } from 'react'
import { CalendarClock, Mail, Send, ExternalLink, Check, X, Scale } from 'lucide-react'
import ScenarioPanel from '../components/ScenarioPanel'

/* ── Multi-select dropdown (shared pattern across pages) ─────────────────── */

function MultiSelect({ label, options, selected, onChange }) {
  const [open, setOpen] = useState(false)
  const allSel  = selected.length === options.length && options.length > 0
  const noneSel = selected.length === 0

  function toggle(val) {
    onChange(selected.includes(val) ? selected.filter(v => v !== val) : [...selected, val])
  }
  function toggleAll() {
    onChange(allSel ? [] : [...options])
  }

  const displayLabel = noneSel || allSel
    ? `All ${label}`
    : selected.length === 1 ? selected[0] : `${selected.length} selected`

  return (
    <div
      style={{ position: 'relative' }}
      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false) }}
      tabIndex={-1}
    >
      <button
        type="button"
        className="form-input"
        onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, cursor: 'pointer', minWidth: 190, textAlign: 'left', background: '#fff' }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 'var(--font-size-sm)' }}>{displayLabel}</span>
        <span style={{ fontSize: 10, opacity: 0.5, flexShrink: 0 }}>▼</span>
      </button>
      {open && (
        <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 9999, background: '#fff', border: '1px solid var(--surface-border)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-md)', minWidth: 220, maxHeight: 300, overflowY: 'auto', padding: '6px 0' }}>
          <div
            onClick={toggleAll}
            style={{ padding: '7px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-sm)', fontWeight: 600, borderBottom: '1px solid var(--color-gray-100)' }}
          >
            <input type="checkbox" readOnly checked={allSel} style={{ accentColor: 'var(--color-blue)' }} />
            All {label}
          </div>
          {options.map(opt => (
            <div
              key={opt}
              onClick={() => toggle(opt)}
              style={{ padding: '7px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-sm)' }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--color-gray-50)'}
              onMouseLeave={e => e.currentTarget.style.background = ''}
            >
              <input type="checkbox" readOnly checked={selected.includes(opt)} style={{ accentColor: 'var(--color-blue)' }} />
              {opt}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* ── Helpers ──────────────────────────────────────────────────────────── */

function fmt1(n)  { return n == null ? '—' : Number(n).toFixed(1) }
function fmtPct(n) { return (n == null || isNaN(n)) ? '—' : `${Number(n).toFixed(0)}%` }
function fmtHrs(mins) {
  if (mins == null || mins === 0) return '—'
  return (Number(mins) / 60).toFixed(1) + 'h'
}

const isEndoscopy = site => /endoscop/i.test(site || '')

function fmtDisplayDate(iso) {
  if (!iso) return ''
  const [, mm, dd] = iso.split('-')
  return `${mm}/${dd}`
}
function fmtLongDate(iso) {
  if (!iso) return ''
  const d = new Date(iso + 'T00:00:00')
  return d.toLocaleDateString('default', { weekday: 'long', month: 'long', day: 'numeric' })
}

function addDays(dateStr, n) {
  const d = new Date(dateStr)
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

// Risk band → colors. Higher risk = more likely to under-utilize.
function riskBand(risk) {
  if (risk == null)  return { label: '—',    bg: 'var(--color-gray-100)', fg: 'var(--color-gray-500)', bar: 'var(--color-gray-300)' }
  if (risk >= 67)    return { label: 'High',   bg: '#fee2e2', fg: '#b91c1c', bar: '#ef4444' }
  if (risk >= 34)    return { label: 'Medium', bg: '#fef3c7', fg: '#b45309', bar: '#f59e0b' }
  return { label: 'Low', bg: '#dcfce7', fg: '#15803d', bar: '#22c55e' }
}

// Forecast-fill color: low fill = high risk = red.
function fillColor(pct) {
  if (pct == null) return 'var(--color-gray-500)'
  if (pct < 50) return '#b91c1c'
  if (pct < 75) return '#b45309'
  return '#15803d'
}

/* ── Risk badge ───────────────────────────────────────────────────────── */

function RiskBadge({ risk, size = 'md' }) {
  const b = riskBand(risk)
  const pad = size === 'lg' ? '5px 14px' : '3px 10px'
  const fs  = size === 'lg' ? 16 : 13
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6, padding: pad, borderRadius: 999, background: b.bg, color: b.fg, fontWeight: 700, fontSize: fs, justifyContent: 'center' }}>
      {risk == null ? '—' : risk}
      <span style={{ fontSize: size === 'lg' ? 10 : 9, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', opacity: 0.85 }}>{b.label}</span>
    </span>
  )
}

/* ── Radar card (grid cell) ───────────────────────────────────────────── */

function CardMetric({ label, value, color }) {
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--color-gray-400)', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, color: color || 'var(--color-gray-900)', lineHeight: 1.1 }}>{value}</div>
    </div>
  )
}

function RadarCard({ row, active, onClick }) {
  const b = riskBand(row.risk)
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        textAlign: 'left', cursor: 'pointer', font: 'inherit',
        border: active ? '1px solid var(--color-blue)' : '1px solid var(--surface-border)',
        borderRadius: 'var(--radius-lg)', background: '#fff', padding: 0, overflow: 'hidden',
        boxShadow: active ? '0 0 0 2px rgba(37,99,235,0.15)' : 'var(--shadow-sm)',
        transition: 'box-shadow .12s, border-color .12s', display: 'flex', flexDirection: 'column',
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.boxShadow = 'var(--shadow-md)' }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.boxShadow = 'var(--shadow-sm)' }}
    >
      {/* Risk bar accent */}
      <div style={{ height: 4, background: b.bar }} />
      <div style={{ padding: '13px 15px 14px', display: 'flex', flexDirection: 'column', gap: 11 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
          <RiskBadge risk={row.risk} />
          <span style={{ fontSize: 11, color: 'var(--color-gray-400)', whiteSpace: 'nowrap', paddingTop: 3 }}>
            {row.DaysAhead == null ? '' : `${row.DaysAhead} days out`}
          </span>
        </div>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-gray-900)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.CaseBlock}</div>
          <div style={{ fontSize: 12, color: 'var(--color-gray-500)', marginTop: 1 }}>{row.Service}</div>
        </div>
        <div style={{ fontSize: 12, color: 'var(--color-gray-600)' }}>
          {fmtDisplayDate(row.Date)} · {row.DayOfWeek} · {row.Site}
        </div>
        <div style={{ display: 'flex', gap: 10, borderTop: '1px solid var(--color-gray-100)', paddingTop: 11 }}>
          <CardMetric label="Fcst Fill" value={fmtPct(row.ForecastFillPct)} color={fillColor(row.ForecastFillPct)} />
          <CardMetric label="Block" value={fmtHrs(row.BlockTimeMins)} />
          <CardMetric label="Fcst Cases" value={fmt1(row.TotalForecastCases)} />
        </div>
      </div>
    </button>
  )
}

/* ── Drill-down drawer content: reasoning + release-request composer ──── */

function slugEmail(s) {
  const base = (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 28)
  return `${base || 'practice'}@practice.demo`
}

function DrawerBody({ row, onSent }) {
  // Risk is driven partly by the Fcst Fill shown on the card, so we surface only
  // the *additional* (history-based) factors here to avoid repeating the card.
  const extra = row.drivers.filter(d => d.key !== 'forwardFill' && d.contribution > 0)

  const [recipient, setRecipient] = useState(slugEmail(row.CaseBlock))
  const [subject,   setSubject]   = useState(`OR block release — ${row.CaseBlock} on ${fmtDisplayDate(row.Date)}`)
  const [body,      setBody]      = useState(
    `Hi team,\n\n` +
    `Our forecast shows your OR block on ${fmtDisplayDate(row.Date)} (${row.CaseBlock}, ${row.Site}) is likely to be under-utilized — currently projected to fill about ${row.ForecastFillPct == null ? '—' : Math.round(row.ForecastFillPct)}% of the allocated time.\n\n` +
    `If you won't be using this block, releasing it early lets us offer the time to another team. Please choose an option in this message: release it, keep it, or ask us to check back later.\n\n` +
    `Thank you,\nOR Scheduling`
  )
  const [state, setState] = useState({ sending: false, sent: false, token: null, error: null })

  const responseUrl = state.token ? `${window.location.origin}/r/${state.token}` : null

  async function send() {
    setState(s => ({ ...s, sending: true, error: null }))
    try {
      const res = await fetch('/api/opentime/requests', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          blockDate: row.Date, site: row.Site, caseBlock: row.CaseBlock, service: row.Service,
          riskScore: row.risk, reason: row.summary, blockTimeMins: row.BlockTimeMins,
          recipientEmail: recipient, subject, body,
        }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Error ${res.status}`)
      const created = await res.json()
      setState({ sending: false, sent: true, token: created.token, error: null })
      onSent?.()
    } catch (e) {
      setState(s => ({ ...s, sending: false, error: e.message }))
    }
  }

  const field = { width: '100%', fontSize: 13, padding: '7px 10px', border: '1px solid var(--surface-border)', borderRadius: 8, fontFamily: 'inherit' }

  return (
    <div style={{ padding: '18px 20px 24px' }}>
      {/* Risk summary */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <RiskBadge risk={row.risk} size="lg" />
        <div style={{ fontSize: 12, color: 'var(--color-gray-500)' }}>release-risk score</div>
      </div>

      {/* Metrics recap */}
      <div style={{ display: 'flex', gap: 14, padding: '12px 14px', border: '1px solid var(--surface-border)', borderRadius: 'var(--radius-lg)', background: '#fafbfe', marginBottom: 14 }}>
        <CardMetric label="Fcst Fill" value={fmtPct(row.ForecastFillPct)} color={fillColor(row.ForecastFillPct)} />
        <CardMetric label="Block Time" value={fmtHrs(row.BlockTimeMins)} />
        <CardMetric label="Hist Util" value={fmtPct(row.HistUtilPct)} />
        <CardMetric label="Released" value={fmtPct(row.ReleaseRatePct)} />
      </div>

      {/* Reasoning — only what's not already on the card */}
      {extra.length > 0 ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-gray-500)', textTransform: 'uppercase', letterSpacing: '0.04em', alignSelf: 'center' }}>Also weighing:</span>
          {extra.map(d => (
            <span key={d.key} title={d.detail} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '4px 10px', borderRadius: 999, background: '#fff7ed', color: '#b45309', border: '1px solid #fed7aa' }}>
              {d.label} <span style={{ fontWeight: 700 }}>+{d.contribution}</span>
            </span>
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 12, color: 'var(--color-gray-500)', marginBottom: 16 }}>
          Flagged on forecast fill alone (see <strong>Fcst Fill</strong> above) — no historical risk factors on record for this block.
        </div>
      )}

      {/* Release-request composer */}
      {state.sent ? (
        <div style={{ border: '1px solid #bbf7d0', background: '#f0fdf4', borderRadius: 'var(--radius-lg)', padding: '14px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, color: '#166534', marginBottom: 8 }}>
            <Check size={16} /> Release request sent
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-gray-600)', marginBottom: 10 }}>
            No email is sent in this demo. Open the practice's response page to act as the recipient — their answer flows to the <strong>Tracker</strong>.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <a className="btn btn-primary" href={responseUrl} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, textDecoration: 'none', alignSelf: 'flex-start' }}>
              <ExternalLink size={14} /> Open response page (as practice)
            </a>
            <code style={{ fontSize: 11, color: 'var(--color-gray-500)', background: '#fff', padding: '5px 8px', borderRadius: 6, border: '1px solid var(--surface-border)', wordBreak: 'break-all' }}>{responseUrl}</code>
          </div>
        </div>
      ) : (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontWeight: 700, fontSize: 13, color: 'var(--color-gray-800)', marginBottom: 12 }}>
            <Mail size={15} /> Request release from this practice
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div>
              <label className="form-label" style={{ display: 'block', marginBottom: 4 }}>To</label>
              <input style={field} value={recipient} onChange={e => setRecipient(e.target.value)} />
            </div>
            <div>
              <label className="form-label" style={{ display: 'block', marginBottom: 4 }}>Subject</label>
              <input style={field} value={subject} onChange={e => setSubject(e.target.value)} />
            </div>
            <div>
              <label className="form-label" style={{ display: 'block', marginBottom: 4 }}>Message</label>
              <textarea style={{ ...field, minHeight: 170, resize: 'vertical', lineHeight: 1.5 }} value={body} onChange={e => setBody(e.target.value)} />
            </div>
            {state.error && <div style={{ fontSize: 12, color: '#b91c1c' }}>{state.error}</div>}
            <button className="btn btn-primary" onClick={send} disabled={state.sending || !recipient} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, alignSelf: 'flex-start' }}>
              <Send size={14} /> {state.sending ? 'Sending…' : 'Send request'}
            </button>
            <span style={{ fontSize: 11, color: 'var(--color-gray-400)' }}>Recipient answers Release / Keep / Need more time.</span>
          </div>
        </div>
      )}
    </div>
  )
}

/* ── Right slide-in drawer ────────────────────────────────────────────── */

function Drawer({ row, open, onClose, onSent, onEvaluate }) {
  useEffect(() => {
    if (!row) return
    const onKey = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [row, onClose])

  if (!row) return null

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.35)', opacity: open ? 1 : 0, transition: 'opacity .22s ease', zIndex: 1000 }}
      />
      {/* Panel */}
      <div
        role="dialog"
        aria-modal="true"
        style={{
          position: 'fixed', top: 0, right: 0, height: '100vh', width: 'min(480px, 100%)',
          background: '#fff', boxShadow: '-8px 0 30px rgba(0,0,0,0.18)', zIndex: 1001,
          transform: open ? 'translateX(0)' : 'translateX(100%)', transition: 'transform .24s ease',
          display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '18px 20px 14px', borderBottom: '1px solid var(--surface-border)' }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-gray-900)' }}>{row.CaseBlock}</div>
            <div style={{ fontSize: 12, color: 'var(--color-gray-500)', marginTop: 2 }}>{fmtLongDate(row.Date)} · {row.Site}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {onEvaluate && (
              <button
                type="button"
                onClick={() => onEvaluate(row)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer',
                  border: '1px solid var(--color-blue)', background: 'var(--color-blue)',
                  color: '#fff', borderRadius: 'var(--radius-md)', padding: '6px 11px',
                  fontSize: 'var(--font-size-xs)', fontWeight: 700, whiteSpace: 'nowrap',
                }}
              >
                <Scale size={13} /> Evaluate impact
              </button>
            )}
            <button onClick={onClose} aria-label="Close" style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--color-gray-400)', padding: 4, borderRadius: 6 }}>
              <X size={20} />
            </button>
          </div>
        </div>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          <DrawerBody row={row} onSent={onSent} />
        </div>
      </div>
    </>
  )
}

/* ── Main page ────────────────────────────────────────────────────────── */

export default function OpenTimeRadar() {
  const [sites,       setSites]       = useState([])
  const [services,    setServices]    = useState([])
  const [selSites,    setSelSites]    = useState([])
  const [selServices, setSelServices] = useState([])
  const [metaLoading, setMetaLoading] = useState(true)

  const today = new Date().toISOString().slice(0, 10)
  const [startDate, setStartDate] = useState(addDays(today, 14))
  const [endDate,   setEndDate]   = useState(addDays(today, 35))
  const [minRisk,   setMinRisk]   = useState(34)

  const [rows,     setRows]     = useState([])
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState(null)
  const [tab,      setTab]      = useState('surgical')  // 'surgical' | 'endoscopy'

  // Briefs hands a block over here with ?caseBlock=…; the chip below makes the
  // narrowed view obvious and clearable, so it never looks like missing data.
  // The scenario panel is summoned from this page rather than living on one of
  // its own; it only appears where the tenant has the ISSCM tables behind it.
  const [isscmEnabled, setIsscmEnabled] = useState(false)
  const [scenarioId,   setScenarioId]   = useState(null)
  useEffect(() => {
    fetch('/api/tenant-config')
      .then(r => (r.ok ? r.json() : null))
      .then(d => setIsscmEnabled(Boolean(d?.features?.isscm)))
      .catch(() => setIsscmEnabled(false))
  }, [])

  const [blockFilter, setBlockFilter] = useState(
    () => new URLSearchParams(window.location.search).get('caseBlock') || ''
  )
  function clearBlockFilter() {
    setBlockFilter('')
    const url = new URL(window.location.href)
    url.searchParams.delete('caseBlock')
    window.history.replaceState({}, '', url)
  }

  // Drawer state — a single selected row that slides in from the right.
  const [selected, setSelected] = useState(null)
  const [drawerOpen, setDrawerOpen] = useState(false)

  function openDrawer(row) {
    setSelected(row)
    requestAnimationFrame(() => setDrawerOpen(true))
  }
  function closeDrawer() {
    setDrawerOpen(false)
    setTimeout(() => setSelected(null), 240)  // clear after slide-out
  }

  useEffect(() => {
    fetch('/api/sf/meta')
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`Status ${r.status}`)))
      .then(({ sites: s, services: sv }) => { setSites(s || []); setServices(sv || []) })
      .catch(e => setError(`Failed to load filters: ${e.message}`))
      .finally(() => setMetaLoading(false))
    fetchData({ start: addDays(today, 14), end: addDays(today, 35), sites: [], services: [], minRisk: 34 })
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  const fetchData = useCallback(async ({ start, end, sites: s, services: sv, minRisk: mr }) => {
    setLoading(true)
    setError(null)
    const p = new URLSearchParams({ from: start, to: end, minRisk: String(mr) })
    if (s.length)  p.set('sites',    s.join(','))
    if (sv.length) p.set('services', sv.join(','))
    try {
      const res = await fetch(`/api/opentime/radar?${p}`)
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Error ${res.status}`)
      const data = await res.json()
      setRows(data.rows || [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  function handleApply() {
    fetchData({ start: startDate, end: endDate, sites: selSites, services: selServices, minRisk })
  }

  const scopedRows = blockFilter
    ? rows.filter(r => String(r.CaseBlock || '').toLowerCase() === blockFilter.toLowerCase())
    : rows
  const endoCount = new Set(scopedRows.filter(r => isEndoscopy(r.Site)).map(r => r.Site)).size
  const surgCount = new Set(scopedRows.filter(r => !isEndoscopy(r.Site)).map(r => r.Site)).size
  const tabRows = scopedRows.filter(r => tab === 'endoscopy' ? isEndoscopy(r.Site) : !isEndoscopy(r.Site))
  const atRiskHrs = tabRows.reduce((s, r) => s + (r.BlockTimeMins || 0), 0) / 60

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Release Radar</h1>
        <p className="page-subtitle">Upcoming OR blocks most likely to under-utilize — ranked by release-risk, with the reasoning behind each score. Default: 2–5 weeks out.</p>
      </div>

      {/* Filters */}
      <div className="card" style={{ padding: '16px 24px', overflow: 'visible', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 20, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <label className="form-label" style={{ whiteSpace: 'nowrap' }}>From</label>
            <input className="form-input" type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={{ minWidth: 145 }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <label className="form-label" style={{ whiteSpace: 'nowrap' }}>To</label>
            <input className="form-input" type="date" value={endDate} onChange={e => setEndDate(e.target.value)} style={{ minWidth: 145 }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <label className="form-label" style={{ whiteSpace: 'nowrap' }}>Site</label>
            <MultiSelect label="Sites" options={sites} selected={selSites} onChange={setSelSites} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <label className="form-label" style={{ whiteSpace: 'nowrap' }}>Surgeon Service</label>
            <MultiSelect label="Services" options={services} selected={selServices} onChange={setSelServices} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <label className="form-label" style={{ whiteSpace: 'nowrap' }}>Min risk</label>
            <select className="form-input" value={minRisk} onChange={e => setMinRisk(Number(e.target.value))} style={{ minWidth: 110, cursor: 'pointer' }}>
              <option value={0}>All</option>
              <option value={34}>Medium+</option>
              <option value={67}>High only</option>
            </select>
          </div>
          <button
            className="btn btn-primary"
            onClick={handleApply}
            disabled={loading || metaLoading || !startDate || !endDate}
            style={{ marginBottom: 1 }}
          >
            {loading ? 'Loading…' : 'Apply'}
          </button>
        </div>
      </div>

      {/* Narrowed to one block, handed over from Briefs */}
      {blockFilter && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16,
          padding: '8px 14px', borderRadius: 'var(--radius-md)',
          background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.28)',
          fontSize: 'var(--font-size-sm)', color: 'var(--color-gray-700)',
        }}>
          <span>Showing one block: <strong>{blockFilter}</strong>
            {scopedRows.length === 0 && ' — no upcoming instances in this window'}</span>
          <button
            type="button"
            onClick={clearBlockFilter}
            style={{
              marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4,
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--color-blue)', fontSize: 'var(--font-size-sm)', fontWeight: 600,
            }}
          >
            <X size={13} /> Show all blocks
          </button>
        </div>
      )}

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '2px solid var(--surface-border)' }}>
        {[
          { id: 'surgical',  label: 'Surgical Sites',  count: surgCount },
          { id: 'endoscopy', label: 'Endoscopy Sites', count: endoCount },
        ].map(t => {
          const active = tab === t.id
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              style={{
                padding: '9px 18px', border: 'none', background: 'none', cursor: 'pointer',
                fontSize: 14, fontWeight: active ? 700 : 500,
                color: active ? 'var(--color-blue)' : 'var(--color-gray-500)',
                borderBottom: active ? '2px solid var(--color-blue)' : '2px solid transparent',
                marginBottom: -2,
              }}
            >
              {t.label}
              <span style={{ marginLeft: 7, fontSize: 12, fontWeight: 600, color: 'var(--color-gray-400)' }}>{t.count}</span>
            </button>
          )
        })}
      </div>

      {/* Summary strip */}
      {!loading && !error && tabRows.length > 0 && (
        <div style={{ display: 'flex', gap: 24, marginBottom: 16, padding: '10px 18px', background: '#fff', border: '1px solid var(--surface-border)', borderRadius: 'var(--radius-lg)' }}>
          <div><span style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-gray-900)' }}>{tabRows.length}</span> <span style={{ fontSize: 12, color: 'var(--color-gray-500)' }}>flagged blocks</span></div>
          <div><span style={{ fontSize: 20, fontWeight: 700, color: '#b45309' }}>{tabRows.filter(r => r.risk >= 67).length}</span> <span style={{ fontSize: 12, color: 'var(--color-gray-500)' }}>high risk</span></div>
          <div><span style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-gray-900)' }}>{atRiskHrs.toFixed(0)}h</span> <span style={{ fontSize: 12, color: 'var(--color-gray-500)' }}>block time in view</span></div>
        </div>
      )}

      {/* States */}
      {loading && (
        <div className="card"><div style={{ padding: 48, textAlign: 'center', color: 'var(--color-gray-400)', fontSize: 13 }}>Loading…</div></div>
      )}
      {error && !loading && (
        <div className="card"><div style={{ padding: 48, textAlign: 'center', color: '#b91c1c', fontSize: 13 }}>{error}</div></div>
      )}
      {!loading && !error && tabRows.length === 0 && (
        <div className="card"><div style={{ padding: 56, display: 'flex', flexDirection: 'column', alignItems: 'center', color: 'var(--color-gray-400)' }}>
          <CalendarClock size={36} strokeWidth={1.25} style={{ marginBottom: 12 }} />
          <p style={{ fontSize: 13, color: 'var(--color-gray-500)' }}>
            {rows.length === 0
              ? 'No blocks meet the current risk threshold in this window'
              : `No ${tab === 'endoscopy' ? 'endoscopy' : 'surgical'} blocks in the current results`}
          </p>
        </div></div>
      )}

      {/* Grid */}
      {!loading && !error && tabRows.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))', gap: 14 }}>
          {tabRows.map(r => (
            <RadarCard key={r.id} row={r} active={selected?.id === r.id} onClick={() => openDrawer(r)} />
          ))}
        </div>
      )}

      <Drawer
        row={selected} open={drawerOpen} onClose={closeDrawer}
        onEvaluate={isscmEnabled ? (r => {
          // The scenario id is the tenant's own, built the same way
          // routes/isscm.js builds its catalogue: site, block, weekday.
          const weekday = (new Date(`${r.Date}T00:00:00`).getDay() + 6) % 7
          setScenarioId(`${r.Site}|${r.CaseBlock}|${weekday}`)
        }) : null}
      />
      <ScenarioPanel
        open={scenarioId !== null}
        scenarioId={scenarioId}
        hours={4}
        onClose={() => setScenarioId(null)}
      />
    </div>
  )
}

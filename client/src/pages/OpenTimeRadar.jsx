import { useState, useEffect, useCallback } from 'react'
import { CalendarClock, ChevronDown, ChevronRight, Mail } from 'lucide-react'

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

function addDays(dateStr, n) {
  const d = new Date(dateStr)
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

// Risk band → colors. Higher risk = more likely to under-utilize.
function riskBand(risk) {
  if (risk == null)  return { label: '—',    bg: 'var(--color-gray-100)', fg: 'var(--color-gray-500)' }
  if (risk >= 67)    return { label: 'High',   bg: '#fee2e2', fg: '#b91c1c' }
  if (risk >= 34)    return { label: 'Medium', bg: '#fef3c7', fg: '#b45309' }
  return { label: 'Low', bg: '#dcfce7', fg: '#15803d' }
}

/* ── Risk badge ───────────────────────────────────────────────────────── */

function RiskBadge({ risk }) {
  const b = riskBand(risk)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6, padding: '3px 10px', borderRadius: 999, background: b.bg, color: b.fg, fontWeight: 700, fontSize: 13, minWidth: 62, justifyContent: 'center' }}>
      {risk == null ? '—' : risk}
      <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', opacity: 0.85 }}>{b.label}</span>
    </span>
  )
}

/* ── Reasoning panel (expanded row) ───────────────────────────────────── */

function ReasoningPanel({ row }) {
  return (
    <div style={{ padding: '14px 18px 16px', background: '#fafbfe', borderTop: '1px solid #eef0f5' }}>
      <div style={{ fontSize: 12, color: 'var(--color-gray-600)', marginBottom: 12 }}>{row.summary}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
        {row.drivers.map(d => (
          <div key={d.key} style={{ flex: '1 1 260px', minWidth: 240, border: '1px solid var(--surface-border)', borderRadius: 'var(--radius-lg)', background: '#fff', padding: '10px 12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-gray-800)' }}>{d.label}</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: d.contribution > 0 ? '#b45309' : 'var(--color-gray-400)' }}>+{d.contribution}</span>
            </div>
            <div style={{ height: 6, borderRadius: 3, background: 'var(--color-gray-100)', overflow: 'hidden', marginBottom: 7 }}>
              <div style={{ width: `${d.contribution}%`, height: '100%', background: '#f59e0b' }} />
            </div>
            <div style={{ fontSize: 11, color: 'var(--color-gray-500)', lineHeight: 1.4 }}>{d.detail}</div>
          </div>
        ))}
      </div>
      <button
        className="btn"
        disabled
        title="Release requests arrive in Phase 2"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 7, opacity: 0.55, cursor: 'not-allowed' }}
      >
        <Mail size={14} /> Request release <span style={{ fontSize: 11, fontWeight: 600 }}>(coming soon)</span>
      </button>
    </div>
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
  const [expanded, setExpanded] = useState(() => new Set())

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
      setExpanded(new Set())
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  function handleApply() {
    fetchData({ start: startDate, end: endDate, sites: selSites, services: selServices, minRisk })
  }

  function toggleExpand(id) {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const endoCount = new Set(rows.filter(r => isEndoscopy(r.Site)).map(r => r.Site)).size
  const surgCount = new Set(rows.filter(r => !isEndoscopy(r.Site)).map(r => r.Site)).size
  const tabRows = rows.filter(r => tab === 'endoscopy' ? isEndoscopy(r.Site) : !isEndoscopy(r.Site))

  // Header metric: at-risk block-hours in view
  const atRiskHrs = tabRows.reduce((s, r) => s + (r.BlockTimeMins || 0), 0) / 60

  const TH = (extra = {}) => ({
    padding: '6px 10px', fontSize: 10, fontWeight: 600,
    color: 'var(--color-gray-600)', textAlign: 'right',
    whiteSpace: 'nowrap', borderBottom: '2px solid var(--surface-border)',
    background: '#f8f9fb', ...extra,
  })
  const TD = (extra = {}) => ({
    padding: '7px 10px', fontSize: 12, textAlign: 'right',
    borderBottom: '1px solid #f0f1f3', verticalAlign: 'middle', ...extra,
  })

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
        <div style={{ display: 'flex', gap: 24, marginBottom: 14, padding: '10px 18px', background: '#fff', border: '1px solid var(--surface-border)', borderRadius: 'var(--radius-lg)' }}>
          <div><span style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-gray-900)' }}>{tabRows.length}</span> <span style={{ fontSize: 12, color: 'var(--color-gray-500)' }}>flagged blocks</span></div>
          <div><span style={{ fontSize: 20, fontWeight: 700, color: '#b45309' }}>{tabRows.filter(r => r.risk >= 67).length}</span> <span style={{ fontSize: 12, color: 'var(--color-gray-500)' }}>high risk</span></div>
          <div><span style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-gray-900)' }}>{atRiskHrs.toFixed(0)}h</span> <span style={{ fontSize: 12, color: 'var(--color-gray-500)' }}>block time in view</span></div>
        </div>
      )}

      {/* Table */}
      <div className="card">
        <div className="card-body" style={{ padding: 0 }}>
          {loading && (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-gray-400)', fontSize: 13 }}>Loading…</div>
          )}
          {error && !loading && (
            <div style={{ padding: 40, textAlign: 'center', color: '#b91c1c', fontSize: 13 }}>{error}</div>
          )}
          {!loading && !error && tabRows.length === 0 && (
            <div style={{ padding: 56, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--color-gray-400)' }}>
              <CalendarClock size={36} strokeWidth={1.25} style={{ marginBottom: 12 }} />
              <p style={{ fontSize: 13, color: 'var(--color-gray-500)' }}>
                {rows.length === 0
                  ? 'No blocks meet the current risk threshold in this window'
                  : `No ${tab === 'endoscopy' ? 'endoscopy' : 'surgical'} blocks in the current results`}
              </p>
            </div>
          )}
          {!loading && !error && tabRows.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{ ...TH(), width: 34 }} />
                    <th style={{ ...TH(), textAlign: 'center', minWidth: 96 }}>Risk</th>
                    <th style={{ ...TH(), textAlign: 'left', minWidth: 64 }}>Date</th>
                    <th style={{ ...TH(), textAlign: 'left', minWidth: 84 }}>Day</th>
                    <th style={{ ...TH(), textAlign: 'left', minWidth: 170 }}>Case Block</th>
                    <th style={{ ...TH(), textAlign: 'left', minWidth: 140 }}>Site</th>
                    <th style={{ ...TH(), textAlign: 'left', minWidth: 150 }}>Service</th>
                    <th style={TH()}>Days Out</th>
                    <th style={TH()}>Fcst Fill</th>
                    <th style={TH()}>Block Time</th>
                    <th style={TH()}>Hist Util</th>
                    <th style={TH()}>Released</th>
                  </tr>
                </thead>
                <tbody>
                  {tabRows.map(r => {
                    const isOpen = expanded.has(r.id)
                    return [
                      <tr
                        key={r.id}
                        onClick={() => toggleExpand(r.id)}
                        style={{ cursor: 'pointer', background: isOpen ? '#fafbfe' : undefined }}
                        onMouseEnter={e => { if (!isOpen) e.currentTarget.style.background = '#fafbfe' }}
                        onMouseLeave={e => { if (!isOpen) e.currentTarget.style.background = '' }}
                      >
                        <td style={{ ...TD(), textAlign: 'center', color: 'var(--color-gray-400)' }}>
                          {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                        </td>
                        <td style={{ ...TD(), textAlign: 'center' }}><RiskBadge risk={r.risk} /></td>
                        <td style={{ ...TD(), textAlign: 'left', fontWeight: 600 }}>{fmtDisplayDate(r.Date)}</td>
                        <td style={{ ...TD(), textAlign: 'left', color: 'var(--color-gray-600)' }}>{r.DayOfWeek}</td>
                        <td style={{ ...TD(), textAlign: 'left', color: 'var(--color-gray-800)' }}>{r.CaseBlock}</td>
                        <td style={{ ...TD(), textAlign: 'left', color: 'var(--color-gray-700)' }}>{r.Site}</td>
                        <td style={{ ...TD(), textAlign: 'left', color: 'var(--color-gray-700)' }}>{r.Service}</td>
                        <td style={TD()}>{r.DaysAhead == null ? '—' : r.DaysAhead}</td>
                        <td style={{ ...TD(), fontWeight: 600 }}>{fmtPct(r.ForecastFillPct)}</td>
                        <td style={TD()}>{fmtHrs(r.BlockTimeMins)}</td>
                        <td style={TD()}>{fmtPct(r.HistUtilPct)}</td>
                        <td style={TD()}>{fmtPct(r.ReleaseRatePct)}</td>
                      </tr>,
                      isOpen && (
                        <tr key={`${r.id}__panel`}>
                          <td colSpan={12} style={{ padding: 0 }}><ReasoningPanel row={r} /></td>
                        </tr>
                      ),
                    ]
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

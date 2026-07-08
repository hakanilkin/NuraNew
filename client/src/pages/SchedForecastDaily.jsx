import { useState, useEffect, useCallback } from 'react'
import { Calendar } from 'lucide-react'

/* ── Multi-select dropdown ──────────────────────────────────────────────── */

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
    : selected.length === 1
      ? selected[0]
      : `${selected.length} selected`

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

function fmt1(n) { return n == null ? '—' : Number(n).toFixed(1) }

function fmtHrs(mins) {
  if (mins == null || mins === 0) return '—'
  return (Number(mins) / 60).toFixed(1) + 'h'
}

function fmtPct(n) {
  if (n == null || isNaN(n) || !isFinite(n)) return '—'
  return `${Number(n).toFixed(1)}%`
}

function gapColor(gap) {
  if (gap >  0.5) return '#15803d'
  if (gap < -0.5) return '#b91c1c'
  return 'var(--color-gray-700)'
}

// A site is an Endoscopy site when its name contains "endoscop"
const isEndoscopy = site => /endoscop/i.test(site || '')

// % Filled: <70% red, ≥70% green, >100% green + bold
function pctColor(pct) {
  if (pct == null) return 'var(--color-gray-700)'
  return pct < 70 ? '#b91c1c' : '#15803d'
}
function pctBold(pct) {
  return pct != null && pct > 100
}

function addDays(dateStr, n) {
  const d = new Date(dateStr)
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

function fmtDisplayDate(iso) {
  if (!iso) return ''
  const [, mm, dd] = iso.split('-')
  return `${mm}/${dd}`
}

/* ── Main page ────────────────────────────────────────────────────────── */

export default function SchedForecastDaily() {
  const [sites,    setSites]    = useState([])
  const [selSites, setSelSites] = useState([])
  const [metaLoading, setMetaLoading] = useState(true)

  const today = new Date().toISOString().slice(0, 10)
  const [startDate, setStartDate] = useState(today)
  const [endDate,   setEndDate]   = useState(addDays(today, 28))

  const [rows,    setRows]    = useState([])
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState(null)
  const [tab,     setTab]     = useState('surgical')  // 'surgical' | 'endoscopy'

  useEffect(() => {
    fetch('/api/sf/meta')
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`Status ${r.status}`)))
      .then(({ sites: s }) => setSites(s))
      .catch(e => setError(`Failed to load filters: ${e.message}`))
      .finally(() => setMetaLoading(false))
    // Auto-load the default range (today + 4 weeks) so data shows without a manual Apply
    fetchData({ start: startDate, end: endDate, sites: [] })
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  const fetchData = useCallback(async ({ start, end, sites: s }) => {
    setLoading(true)
    setError(null)
    const p = new URLSearchParams({ startDate: start, endDate: end })
    if (s.length) p.set('sites', s.join(','))
    try {
      const res = await fetch(`/api/sf/daily?${p}`)
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Error ${res.status}`)
      setRows(await res.json())
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  function handleApply() {
    fetchData({ start: startDate, end: endDate, sites: selSites })
  }

  /* ── Split by tab, then group by date ── */
  const endoCount = new Set(rows.filter(r => isEndoscopy(r.Site)).map(r => r.Site)).size
  const surgCount = new Set(rows.filter(r => !isEndoscopy(r.Site)).map(r => r.Site)).size
  const tabRows = rows.filter(r => tab === 'endoscopy' ? isEndoscopy(r.Site) : !isEndoscopy(r.Site))

  const byDate = {}
  for (const r of tabRows) {
    const key = r.Date
    if (!byDate[key]) byDate[key] = []
    byDate[key].push(r)
  }

  const CASE_BG     = '#eef0fd'
  const CASE_BG2    = '#f4f5fd'
  const CASE_BORDER = '#c5caf5'
  const DUR_BG      = '#f0fdf4'
  const DUR_BG2     = '#f6fef8'
  const DUR_BORDER  = '#86efac'

  const TH = (extra = {}) => ({
    padding: '5px 9px', fontSize: 10, fontWeight: 600,
    color: 'var(--color-gray-600)', textAlign: 'right',
    whiteSpace: 'nowrap', borderBottom: '2px solid var(--surface-border)',
    background: '#f8f9fb',
    ...extra,
  })
  const TD = (extra = {}) => ({
    padding: '3px 9px', fontSize: 12, textAlign: 'right',
    borderBottom: '1px solid #f0f1f3', verticalAlign: 'middle',
    ...extra,
  })

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Daily Site Summary</h1>
        <p className="page-subtitle">Forecasted cases and OR duration by site and day — default: today + 4 weeks</p>
      </div>

      {/* Filters */}
      <div className="card" style={{ padding: '16px 24px', overflow: 'visible', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 20, flexWrap: 'nowrap' }}>
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
              <Calendar size={36} strokeWidth={1.25} style={{ marginBottom: 12 }} />
              <p style={{ fontSize: 13, color: 'var(--color-gray-500)' }}>
                {rows.length === 0
                  ? 'Select filters and click Apply to load data'
                  : `No ${tab === 'endoscopy' ? 'endoscopy' : 'surgical'} sites in the current results`}
              </p>
            </div>
          )}

          {!loading && !error && tabRows.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    {/* Fixed columns */}
                    <th rowSpan={2} style={{ ...TH(), textAlign: 'left', minWidth: 72,  borderRight: '1px solid var(--surface-border)' }}>Date</th>
                    <th rowSpan={2} style={{ ...TH(), textAlign: 'left', minWidth: 88  }}>Day</th>
                    <th rowSpan={2} style={{ ...TH(), textAlign: 'left', minWidth: 190, borderRight: '1px solid var(--surface-border)' }}>Site</th>
                    {/* Case group header */}
                    <th colSpan={5} style={{ ...TH(), textAlign: 'center', background: CASE_BG, color: '#3730a3', borderBottom: '1px solid ' + CASE_BORDER }}>
                      Cases
                    </th>
                    {/* Duration group header */}
                    <th colSpan={5} style={{ ...TH(), textAlign: 'center', background: DUR_BG, color: '#166534', borderBottom: '1px solid ' + DUR_BORDER }}>
                      Duration (hrs)
                    </th>
                  </tr>
                  <tr>
                    <th style={{ ...TH(), background: CASE_BG }}>Scheduled</th>
                    <th style={{ ...TH(), background: CASE_BG }}>Fcst Addition</th>
                    <th style={{ ...TH(), background: CASE_BG, color: '#1e40af', fontWeight: 700 }}>Total Fcst</th>
                    <th style={{ ...TH(), background: CASE_BG }}>Budget</th>
                    <th style={{ ...TH(), background: CASE_BG, borderRight: '1px solid ' + CASE_BORDER }}>Budget Gap</th>
                    <th style={{ ...TH(), background: DUR_BG }}>Sched w/Turn</th>
                    <th style={{ ...TH(), background: DUR_BG }}>Fcst w/Turn</th>
                    <th style={{ ...TH(), background: DUR_BG, color: '#15803d', fontWeight: 700 }}>Total w/Turn</th>
                    <th style={{ ...TH(), background: DUR_BG }}>Block Time</th>
                    <th style={{ ...TH(), background: DUR_BG }}>% Filled</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(byDate).map(([date, dateRows]) => {
                    /* Date-level totals */
                    const dt = {
                      sched:  dateRows.reduce((s, r) => s + (r.ScheduledTotal    || 0), 0),
                      fcst:   dateRows.reduce((s, r) => s + (r.ForecastedAddition|| 0), 0),
                      total:  dateRows.reduce((s, r) => s + (r.TotalForecasted   || 0), 0),
                      budget: dateRows.reduce((s, r) => s + (r.TotalBudget       || 0), 0),
                      sdur:   dateRows.reduce((s, r) => s + (r.SchedDurwTurn     || 0), 0),
                      fdur:   dateRows.reduce((s, r) => s + (r.FcstDurwTurn      || 0), 0),
                      tdur:   dateRows.reduce((s, r) => s + (r.TotalDurwTurn     || 0), 0),
                      block:  dateRows.reduce((s, r) => s + (r.BlockTime         || 0), 0),
                    }
                    dt.gap = dt.total - dt.budget
                    dt.pct = dt.block > 0 ? (dt.tdur / dt.block * 100) : null
                    const dow = dateRows[0]?.DayOfWeek ?? ''

                    return [
                      /* Date header row */
                      <tr key={`${date}__hdr`} style={{ background: '#eef2fb' }}>
                        <td style={{ ...TD(), textAlign: 'left', fontWeight: 700, fontSize: 13, color: 'var(--color-gray-900)', borderRight: '1px solid var(--surface-border)', borderBottom: '1px solid #d8dff0', paddingTop: 6, paddingBottom: 6 }}>
                          {fmtDisplayDate(date)}
                        </td>
                        <td style={{ ...TD(), textAlign: 'left', fontWeight: 600, fontSize: 11, color: 'var(--color-gray-700)', borderBottom: '1px solid #d8dff0' }}>
                          {dow}
                        </td>
                        <td style={{ ...TD(), textAlign: 'left', color: 'var(--color-gray-400)', fontStyle: 'italic', fontSize: 11, borderRight: '1px solid var(--surface-border)', borderBottom: '1px solid #d8dff0' }}>
                          All sites
                        </td>
                        <td style={{ ...TD(), fontWeight: 700, background: CASE_BG, borderBottom: '1px solid #d8dff0' }}>{fmt1(dt.sched)}</td>
                        <td style={{ ...TD(), fontWeight: 700, background: CASE_BG, borderBottom: '1px solid #d8dff0' }}>{fmt1(dt.fcst)}</td>
                        <td style={{ ...TD(), fontWeight: 700, color: '#1e40af', background: CASE_BG, borderBottom: '1px solid #d8dff0' }}>{fmt1(dt.total)}</td>
                        <td style={{ ...TD(), fontWeight: 700, background: CASE_BG, borderBottom: '1px solid #d8dff0' }}>{fmt1(dt.budget)}</td>
                        <td style={{ ...TD(), fontWeight: 700, color: gapColor(dt.gap), background: CASE_BG, borderRight: '1px solid ' + CASE_BORDER, borderBottom: '1px solid #d8dff0' }}>{fmt1(dt.gap)}</td>
                        <td style={{ ...TD(), fontWeight: 700, background: DUR_BG, borderBottom: '1px solid #d8dff0' }}>{fmtHrs(dt.sdur)}</td>
                        <td style={{ ...TD(), fontWeight: 700, background: DUR_BG, borderBottom: '1px solid #d8dff0' }}>{fmtHrs(dt.fdur)}</td>
                        <td style={{ ...TD(), fontWeight: 700, color: '#15803d', background: DUR_BG, borderBottom: '1px solid #d8dff0' }}>{fmtHrs(dt.tdur)}</td>
                        <td style={{ ...TD(), fontWeight: 700, background: DUR_BG, borderBottom: '1px solid #d8dff0' }}>{fmtHrs(dt.block)}</td>
                        <td style={{ ...TD(), fontWeight: 700, color: pctColor(dt.pct), background: DUR_BG, borderBottom: '1px solid #d8dff0' }}>{fmtPct(dt.pct)}</td>
                      </tr>,

                      /* Site detail rows */
                      ...dateRows.map(r => {
                        const gap = (r.TotalForecasted || 0) - (r.TotalBudget || 0)
                        const pct = r.BlockTime > 0 ? (r.TotalDurwTurn / r.BlockTime * 100) : null
                        return (
                          <tr
                            key={`${date}__${r.Site}`}
                            onMouseEnter={e => e.currentTarget.style.background = '#fafbfe'}
                            onMouseLeave={e => e.currentTarget.style.background = ''}
                          >
                            <td style={{ ...TD(), borderRight: '1px solid var(--surface-border)' }} />
                            <td style={TD()} />
                            <td style={{ ...TD(), textAlign: 'left', paddingLeft: 22, borderRight: '1px solid var(--surface-border)', color: 'var(--color-gray-700)' }}>{r.Site}</td>
                            <td style={{ ...TD(), background: CASE_BG2 }}>{fmt1(r.ScheduledTotal)}</td>
                            <td style={{ ...TD(), background: CASE_BG2 }}>{fmt1(r.ForecastedAddition)}</td>
                            <td style={{ ...TD(), fontWeight: 600, background: CASE_BG2 }}>{fmt1(r.TotalForecasted)}</td>
                            <td style={{ ...TD(), background: CASE_BG2 }}>{fmt1(r.TotalBudget)}</td>
                            <td style={{ ...TD(), color: gapColor(gap), background: CASE_BG2, borderRight: '1px solid ' + CASE_BORDER }}>{fmt1(gap)}</td>
                            <td style={{ ...TD(), background: DUR_BG2 }}>{fmtHrs(r.SchedDurwTurn)}</td>
                            <td style={{ ...TD(), background: DUR_BG2 }}>{fmtHrs(r.FcstDurwTurn)}</td>
                            <td style={{ ...TD(), fontWeight: 600, background: DUR_BG2 }}>{fmtHrs(r.TotalDurwTurn)}</td>
                            <td style={{ ...TD(), background: DUR_BG2 }}>{fmtHrs(r.BlockTime)}</td>
                            <td style={{ ...TD(), color: pctColor(pct), fontWeight: pctBold(pct) ? 700 : 400, background: DUR_BG2 }}>{fmtPct(pct)}</td>
                          </tr>
                        )
                      }),
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

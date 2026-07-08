import { useState, useEffect, useCallback } from 'react'
import { BarChart2 } from 'lucide-react'

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
function fmt0(n) { return n == null ? '—' : Math.round(Number(n)).toLocaleString() }

function fmtSigned(n) {
  if (n == null) return '—'
  const v = Number(n)
  return (v > 0 ? '+' : '') + v.toFixed(1)
}

function fmtPct(n) {
  if (n == null || !isFinite(n)) return '—'
  return (n > 0 ? '+' : '') + n.toFixed(1) + '%'
}

// Variance = Actual − Budget. Positive is good (green), negative is bad (red).
function varColor(v) {
  if (v >  0.5) return '#15803d'
  if (v < -0.5) return '#b91c1c'
  return 'var(--color-gray-700)'
}

// A site is an Endoscopy site when its name contains "endoscop"
const isEndoscopy = site => /endoscop/i.test(site || '')

/* ── Per-site KPI box ─────────────────────────────────────────────────── */

function KpiCard({ site, actual, budget, diff, pct, emphasis = false }) {
  const TOT_BG     = emphasis ? '#166534' : '#f0fdf4'
  const TOT_BORDER = emphasis ? '#166534' : '#86efac'
  const headColor  = emphasis ? '#fff'    : '#166534'
  const color      = varColor(diff)

  const metric = (label, value, valColor) => (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--color-gray-500)', marginBottom: 3, whiteSpace: 'nowrap' }}>{label}</div>
      <div style={{ fontSize: 17, fontWeight: 700, color: valColor || 'var(--color-gray-900)', lineHeight: 1.1 }}>{value}</div>
    </div>
  )

  return (
    <div style={{
      flex: '1 1 260px', minWidth: 240, maxWidth: 360,
      border: '1px solid ' + TOT_BORDER, borderRadius: 'var(--radius-lg)',
      overflow: 'hidden', background: '#fff',
      boxShadow: emphasis ? '0 2px 8px rgba(22,101,52,0.18)' : 'var(--shadow-sm)',
    }}>
      <div style={{ padding: '9px 14px', background: TOT_BG, borderBottom: '1px solid ' + TOT_BORDER, fontSize: 13, fontWeight: 700, color: headColor, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {site}
      </div>
      <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', gap: 12 }}>
          {metric('Total Budget', fmt1(budget))}
          {metric('Total Actual', fmt0(actual))}
        </div>
        <div style={{ display: 'flex', gap: 12, borderTop: '1px solid var(--color-gray-100)', paddingTop: 10 }}>
          {metric('Difference', fmtSigned(diff), color)}
          {metric('% Difference', fmtPct(pct), color)}
        </div>
      </div>
    </div>
  )
}

/* ── Main page ────────────────────────────────────────────────────────── */

export default function SchedForecastCases() {
  const [sites,       setSites]       = useState([])
  const [services,    setServices]    = useState([])
  const [selSites,    setSelSites]    = useState([])
  const [selServices, setSelServices] = useState([])
  const [metaLoading, setMetaLoading] = useState(true)

  // Actual-vs-budget is retrospective: actuals only exist for past dates,
  // so default to a trailing 4-week window ending today.
  const today = new Date().toISOString().slice(0, 10)
  const priorMonth = (() => {
    const d = new Date()
    d.setDate(d.getDate() - 28)
    return d.toISOString().slice(0, 10)
  })()
  const [startDate, setStartDate] = useState(priorMonth)
  const [endDate,   setEndDate]   = useState(today)

  const [rows,    setRows]    = useState([])
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState(null)
  const [tab,     setTab]     = useState('surgical')  // 'surgical' | 'endoscopy'

  useEffect(() => {
    fetch('/api/sf/meta')
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`Status ${r.status}`)))
      .then(({ sites: s, services: sv }) => { setSites(s); setServices(sv) })
      .catch(e => setError(`Failed to load filters: ${e.message}`))
      .finally(() => setMetaLoading(false))
    // Auto-load the default (trailing 4-week) range so actuals show without a manual Apply
    fetchData({ start: priorMonth, end: today, sites: [], services: [] })
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  const fetchData = useCallback(async ({ start, end, sites: s, services: sv }) => {
    setLoading(true)
    setError(null)
    const p = new URLSearchParams({ startDate: start, endDate: end })
    if (s.length)  p.set('sites',    s.join(','))
    if (sv.length) p.set('services', sv.join(','))
    try {
      const res = await fetch(`/api/sf/cases?${p}`)
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Error ${res.status}`)
      setRows(await res.json())
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  function handleApply() {
    fetchData({ start: startDate, end: endDate, sites: selSites, services: selServices })
  }

  /* ── Group rows by site ── */
  const bySite = {}
  for (const r of rows) {
    if (!bySite[r.Site]) bySite[r.Site] = []
    bySite[r.Site].push(r)
  }

  // Split sites into the two tabs, preserving row order
  const allSiteEntries = Object.entries(bySite)
  const endoEntries    = allSiteEntries.filter(([site]) => isEndoscopy(site))
  const surgEntries    = allSiteEntries.filter(([site]) => !isEndoscopy(site))
  const activeEntries  = tab === 'endoscopy' ? endoEntries : surgEntries

  // Per-site KPI totals for the active tab
  const siteKpis = activeEntries.map(([site, siteRows]) => {
    const actual = siteRows.reduce((s, r) => s + (r.TotalActual || 0), 0)
    const budget = siteRows.reduce((s, r) => s + (r.TotalBudget || 0), 0)
    const diff   = actual - budget
    const pct    = budget ? (diff / budget) * 100 : null
    return { site, actual, budget, diff, pct }
  })

  // Tab-wide total across all sites in the active tab
  const tabTotal = siteKpis.reduce(
    (a, k) => ({ actual: a.actual + k.actual, budget: a.budget + k.budget }),
    { actual: 0, budget: 0 },
  )
  tabTotal.diff = tabTotal.actual - tabTotal.budget
  tabTotal.pct  = tabTotal.budget ? (tabTotal.diff / tabTotal.budget) * 100 : null
  tabTotal.site = tab === 'endoscopy' ? 'All Endoscopy Sites' : 'All Surgical Sites'

  // Grand total row for the table (inpatient / outpatient / total breakdown)
  const gt = { ai: 0, bi: 0, ao: 0, bo: 0, at: 0, bt: 0 }
  activeEntries.forEach(([, siteRows]) => siteRows.forEach(r => {
    gt.ai += r.ActualInpatient   || 0
    gt.bi += r.BudgetInpatient   || 0
    gt.ao += r.ActualOutpatient  || 0
    gt.bo += r.BudgetOutpatient  || 0
    gt.at += r.TotalActual       || 0
    gt.bt += r.TotalBudget       || 0
  }))

  const IP_BG     = '#eef0fd'
  const IP_BG2    = '#f4f5fd'
  const IP_BORDER = '#c5caf5'
  const OP_BG     = '#fef6ee'
  const OP_BG2    = '#fefaf5'
  const OP_BORDER = '#f5d5b5'
  const TOT_BG    = '#f0fdf4'
  const TOT_BG2   = '#f6fef8'
  const TOT_BORDER= '#86efac'

  const TH = (extra = {}) => ({
    padding: '5px 10px', fontSize: 10, fontWeight: 600,
    color: 'var(--color-gray-600)', textAlign: 'right',
    whiteSpace: 'nowrap', borderBottom: '2px solid var(--surface-border)',
    background: '#f8f9fb',
    ...extra,
  })
  const TD = (extra = {}) => ({
    padding: '3px 10px', fontSize: 12, textAlign: 'right',
    borderBottom: '1px solid #f0f1f3', verticalAlign: 'middle',
    ...extra,
  })

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Actual vs Budget</h1>
        <p className="page-subtitle">Actual cases compared to budget by site and surgeon service — variance above zero (green) beats budget</p>
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <label className="form-label" style={{ whiteSpace: 'nowrap' }}>Surgeon Service</label>
            <MultiSelect label="Services" options={services} selected={selServices} onChange={setSelServices} />
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
          { id: 'surgical',  label: 'Surgical Sites',   count: surgEntries.length },
          { id: 'endoscopy', label: 'Endoscopy Sites',  count: endoEntries.length },
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

      {/* Per-site KPI boxes (Total first) */}
      {!loading && !error && siteKpis.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginBottom: 18 }}>
          <KpiCard {...tabTotal} emphasis />
          {siteKpis.map(k => <KpiCard key={k.site} {...k} />)}
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

          {!loading && !error && activeEntries.length === 0 && (
            <div style={{ padding: 56, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--color-gray-400)' }}>
              <BarChart2 size={36} strokeWidth={1.25} style={{ marginBottom: 12 }} />
              <p style={{ fontSize: 13, color: 'var(--color-gray-500)' }}>
                {rows.length === 0
                  ? 'Select filters and click Apply to load data'
                  : `No ${tab === 'endoscopy' ? 'endoscopy' : 'surgical'} sites in the current results`}
              </p>
            </div>
          )}

          {!loading && !error && activeEntries.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th rowSpan={2} style={{ ...TH(), textAlign: 'left', minWidth: 180, borderRight: '1px solid var(--surface-border)' }}>Site</th>
                    <th rowSpan={2} style={{ ...TH(), textAlign: 'left', minWidth: 190, borderRight: '1px solid var(--surface-border)' }}>Surgeon Service</th>
                    <th colSpan={3} style={{ ...TH(), textAlign: 'center', background: IP_BG,  color: '#3730a3', borderBottom: '1px solid ' + IP_BORDER }}>Inpatient</th>
                    <th colSpan={3} style={{ ...TH(), textAlign: 'center', background: OP_BG,  color: '#9a3412', borderBottom: '1px solid ' + OP_BORDER }}>Outpatient</th>
                    <th colSpan={3} style={{ ...TH(), textAlign: 'center', background: TOT_BG, color: '#166534', borderBottom: '1px solid ' + TOT_BORDER }}>Total</th>
                  </tr>
                  <tr>
                    <th style={{ ...TH(), background: IP_BG }}>Actual</th>
                    <th style={{ ...TH(), background: IP_BG }}>Budget</th>
                    <th style={{ ...TH(), background: IP_BG, borderRight: '1px solid ' + IP_BORDER }}>Variance</th>
                    <th style={{ ...TH(), background: OP_BG }}>Actual</th>
                    <th style={{ ...TH(), background: OP_BG }}>Budget</th>
                    <th style={{ ...TH(), background: OP_BG, borderRight: '1px solid ' + OP_BORDER }}>Variance</th>
                    <th style={{ ...TH(), background: TOT_BG, fontWeight: 700 }}>Actual</th>
                    <th style={{ ...TH(), background: TOT_BG }}>Budget</th>
                    <th style={{ ...TH(), background: TOT_BG }}>Variance</th>
                  </tr>
                </thead>
                <tbody>
                  {activeEntries.map(([site, siteRows]) => {
                    const t = {
                      ai: siteRows.reduce((s, r) => s + (r.ActualInpatient   || 0), 0),
                      bi: siteRows.reduce((s, r) => s + (r.BudgetInpatient   || 0), 0),
                      ao: siteRows.reduce((s, r) => s + (r.ActualOutpatient  || 0), 0),
                      bo: siteRows.reduce((s, r) => s + (r.BudgetOutpatient  || 0), 0),
                      at: siteRows.reduce((s, r) => s + (r.TotalActual       || 0), 0),
                      bt: siteRows.reduce((s, r) => s + (r.TotalBudget       || 0), 0),
                    }

                    return [
                      /* Site header row */
                      <tr key={`${site}__hdr`} style={{ background: '#eef2fb' }}>
                        <td style={{ ...TD(), textAlign: 'left', fontWeight: 700, fontSize: 13, color: 'var(--color-gray-900)', borderRight: '1px solid var(--surface-border)', borderBottom: '1px solid #d8dff0', paddingTop: 6, paddingBottom: 6 }}>
                          {site}
                        </td>
                        <td style={{ ...TD(), textAlign: 'left', color: 'var(--color-gray-400)', fontStyle: 'italic', fontSize: 11, borderRight: '1px solid var(--surface-border)', borderBottom: '1px solid #d8dff0' }}>All services</td>
                        <td style={{ ...TD(), fontWeight: 700, background: IP_BG,  borderBottom: '1px solid #d8dff0' }}>{fmt0(t.ai)}</td>
                        <td style={{ ...TD(), fontWeight: 700, background: IP_BG,  borderBottom: '1px solid #d8dff0' }}>{fmt1(t.bi)}</td>
                        <td style={{ ...TD(), fontWeight: 700, color: varColor(t.ai - t.bi), background: IP_BG,  borderRight: '1px solid ' + IP_BORDER, borderBottom: '1px solid #d8dff0' }}>{fmt1(t.ai - t.bi)}</td>
                        <td style={{ ...TD(), fontWeight: 700, background: OP_BG,  borderBottom: '1px solid #d8dff0' }}>{fmt0(t.ao)}</td>
                        <td style={{ ...TD(), fontWeight: 700, background: OP_BG,  borderBottom: '1px solid #d8dff0' }}>{fmt1(t.bo)}</td>
                        <td style={{ ...TD(), fontWeight: 700, color: varColor(t.ao - t.bo), background: OP_BG,  borderRight: '1px solid ' + OP_BORDER, borderBottom: '1px solid #d8dff0' }}>{fmt1(t.ao - t.bo)}</td>
                        <td style={{ ...TD(), fontWeight: 700, background: TOT_BG, borderBottom: '1px solid #d8dff0' }}>{fmt0(t.at)}</td>
                        <td style={{ ...TD(), fontWeight: 700, background: TOT_BG, borderBottom: '1px solid #d8dff0' }}>{fmt1(t.bt)}</td>
                        <td style={{ ...TD(), fontWeight: 700, color: varColor(t.at - t.bt), background: TOT_BG, borderBottom: '1px solid #d8dff0' }}>{fmt1(t.at - t.bt)}</td>
                      </tr>,

                      /* Service detail rows */
                      ...siteRows.map(r => {
                        const vi = (r.ActualInpatient  || 0) - (r.BudgetInpatient  || 0)
                        const vo = (r.ActualOutpatient || 0) - (r.BudgetOutpatient || 0)
                        const vt = (r.TotalActual      || 0) - (r.TotalBudget      || 0)
                        return (
                          <tr
                            key={`${site}__${r.Service}`}
                            onMouseEnter={e => e.currentTarget.style.background = '#fafbfe'}
                            onMouseLeave={e => e.currentTarget.style.background = ''}
                          >
                            <td style={{ ...TD(), textAlign: 'left', borderRight: '1px solid var(--surface-border)' }} />
                            <td style={{ ...TD(), textAlign: 'left', paddingLeft: 24, borderRight: '1px solid var(--surface-border)', color: 'var(--color-gray-700)' }}>{r.Service}</td>
                            <td style={{ ...TD(), background: IP_BG2 }}>{fmt0(r.ActualInpatient)}</td>
                            <td style={{ ...TD(), background: IP_BG2 }}>{fmt1(r.BudgetInpatient)}</td>
                            <td style={{ ...TD(), color: varColor(vi), background: IP_BG2, borderRight: '1px solid ' + IP_BORDER }}>{fmt1(vi)}</td>
                            <td style={{ ...TD(), background: OP_BG2 }}>{fmt0(r.ActualOutpatient)}</td>
                            <td style={{ ...TD(), background: OP_BG2 }}>{fmt1(r.BudgetOutpatient)}</td>
                            <td style={{ ...TD(), color: varColor(vo), background: OP_BG2, borderRight: '1px solid ' + OP_BORDER }}>{fmt1(vo)}</td>
                            <td style={{ ...TD(), fontWeight: 600, background: TOT_BG2 }}>{fmt0(r.TotalActual)}</td>
                            <td style={{ ...TD(), background: TOT_BG2 }}>{fmt1(r.TotalBudget)}</td>
                            <td style={{ ...TD(), color: varColor(vt), background: TOT_BG2 }}>{fmt1(vt)}</td>
                          </tr>
                        )
                      }),
                    ]
                  })}

                  {/* Grand total */}
                  <tr style={{ background: '#166534' }}>
                    <td style={{ ...TD(), textAlign: 'left', fontWeight: 700, fontSize: 13, color: '#fff', borderRight: '1px solid rgba(255,255,255,0.2)', borderBottom: 'none', paddingTop: 7, paddingBottom: 7 }}>Grand Total</td>
                    <td style={{ ...TD(), textAlign: 'left', color: 'rgba(255,255,255,0.6)', fontStyle: 'italic', fontSize: 11, borderRight: '1px solid rgba(255,255,255,0.2)', borderBottom: 'none' }}>{tab === 'endoscopy' ? 'Endoscopy' : 'Surgical'} sites</td>
                    <td style={{ ...TD(), fontWeight: 700, color: '#fff', borderBottom: 'none' }}>{fmt0(gt.ai)}</td>
                    <td style={{ ...TD(), fontWeight: 700, color: '#fff', borderBottom: 'none' }}>{fmt1(gt.bi)}</td>
                    <td style={{ ...TD(), fontWeight: 700, color: gt.ai - gt.bi >= 0 ? '#86efac' : '#fca5a5', borderRight: '1px solid rgba(255,255,255,0.2)', borderBottom: 'none' }}>{fmt1(gt.ai - gt.bi)}</td>
                    <td style={{ ...TD(), fontWeight: 700, color: '#fff', borderBottom: 'none' }}>{fmt0(gt.ao)}</td>
                    <td style={{ ...TD(), fontWeight: 700, color: '#fff', borderBottom: 'none' }}>{fmt1(gt.bo)}</td>
                    <td style={{ ...TD(), fontWeight: 700, color: gt.ao - gt.bo >= 0 ? '#86efac' : '#fca5a5', borderRight: '1px solid rgba(255,255,255,0.2)', borderBottom: 'none' }}>{fmt1(gt.ao - gt.bo)}</td>
                    <td style={{ ...TD(), fontWeight: 700, color: '#fff', borderBottom: 'none' }}>{fmt0(gt.at)}</td>
                    <td style={{ ...TD(), fontWeight: 700, color: '#fff', borderBottom: 'none' }}>{fmt1(gt.bt)}</td>
                    <td style={{ ...TD(), fontWeight: 700, color: gt.at - gt.bt >= 0 ? '#86efac' : '#fca5a5', borderBottom: 'none' }}>{fmt1(gt.at - gt.bt)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

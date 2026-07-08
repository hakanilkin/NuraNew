import { useState, useEffect, useMemo } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'

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

// % Filled: <80% red, ≥80% green, >100% bold
function pctColor(pct) {
  if (pct == null) return 'var(--color-gray-700)'
  return pct < 80 ? '#b91c1c' : '#15803d'
}
function pctBold(pct) { return pct != null && pct > 100 }

// A site is an Endoscopy site when its name contains "endoscop"
const isEndoscopy = site => /endoscop/i.test(site || '')

function fmtLongDate(iso) {
  if (!iso) return ''
  const d = new Date(iso + 'T00:00:00')
  return d.toLocaleDateString('default', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

/* ── Calendar ─────────────────────────────────────────────────────────── */

function MiniCalendar({ value, onChange, pctMap, selectable }) {
  const [view, setView] = useState(() => {
    const d = value ? new Date(value + 'T00:00:00') : new Date()
    return { y: d.getFullYear(), m: d.getMonth() }
  })

  // Jump the visible month whenever the selected date changes (e.g. site switch)
  useEffect(() => {
    if (!value) return
    const d = new Date(value + 'T00:00:00')
    setView({ y: d.getFullYear(), m: d.getMonth() })
  }, [value])

  const first        = new Date(view.y, view.m, 1)
  const startDow     = first.getDay()
  const daysInMonth  = new Date(view.y, view.m + 1, 0).getDate()
  const monthName    = first.toLocaleString('default', { month: 'long', year: 'numeric' })

  const iso = d => `${view.y}-${String(view.m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`

  const cells = []
  for (let i = 0; i < startDow; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(d)

  function shiftMonth(delta) {
    setView(v => {
      const nm = v.m + delta
      return { y: v.y + Math.floor(nm / 12), m: ((nm % 12) + 12) % 12 }
    })
  }

  const navBtn = {
    background: 'none', border: 'none', cursor: 'pointer', padding: 4,
    display: 'flex', alignItems: 'center', color: 'var(--color-gray-500)', borderRadius: 6,
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <button type="button" style={navBtn} onClick={() => shiftMonth(-1)} aria-label="Previous month"><ChevronLeft size={18} /></button>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-gray-800)' }}>{monthName}</span>
        <button type="button" style={navBtn} onClick={() => shiftMonth(1)} aria-label="Next month"><ChevronRight size={18} /></button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 3 }}>
        {WEEKDAYS.map(w => (
          <div key={w} style={{ textAlign: 'center', fontSize: 10, fontWeight: 600, color: 'var(--color-gray-400)', paddingBottom: 2 }}>{w}</div>
        ))}
        {cells.map((d, i) => {
          if (d == null) return <div key={`e${i}`} />
          const ds       = iso(d)
          const canPick  = selectable.has(ds)
          const pct      = pctMap[ds]
          const isSel    = ds === value

          let bg = 'transparent', color = 'var(--color-gray-300)'
          if (canPick) {
            color = 'var(--color-gray-700)'
            if (pct != null) {
              if (pct >= 80) { bg = '#dcfce7'; color = '#15803d' }
              else           { bg = '#fee2e2'; color = '#b91c1c' }
            } else {
              bg = 'var(--color-gray-100)'
            }
          }

          return (
            <button
              key={ds}
              type="button"
              disabled={!canPick}
              onClick={() => onChange(ds)}
              title={canPick && pct != null ? `${pct.toFixed(0)}% filled` : undefined}
              style={{
                aspectRatio: '1 / 1', minHeight: 34, borderRadius: 7,
                border: isSel ? '2px solid var(--color-blue)' : '1px solid transparent',
                background: bg, color,
                fontSize: 12, fontWeight: isSel ? 700 : 500,
                cursor: canPick ? 'pointer' : 'default',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: isSel ? '0 0 0 1px var(--color-blue)' : 'none',
              }}
            >
              {d}
            </button>
          )
        })}
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 14, marginTop: 12, fontSize: 11, color: 'var(--color-gray-500)' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 11, height: 11, borderRadius: 3, background: '#dcfce7', border: '1px solid #86efac' }} /> ≥ 80%
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 11, height: 11, borderRadius: 3, background: '#fee2e2', border: '1px solid #fca5a5' }} /> &lt; 80%
        </span>
      </div>
    </div>
  )
}

/* ── Main page ────────────────────────────────────────────────────────── */

export default function DailyDetail() {
  const [allSites, setAllSites] = useState([])
  const [tab,      setTab]      = useState('surgical')  // 'surgical' | 'endoscopy'
  const [site,     setSite]     = useState('')
  const [calDays,  setCalDays]  = useState([])          // [{ date, pct }]
  const [selDate,  setSelDate]  = useState('')

  const [rows,       setRows]       = useState([])
  const [loading,    setLoading]    = useState(false)
  const [loadingCal, setLoadingCal] = useState(false)
  const [error,      setError]      = useState(null)

  // Meta: site list
  useEffect(() => {
    fetch('/api/sf/meta')
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`Status ${r.status}`)))
      .then(({ sites: s }) => setAllSites(s || []))
      .catch(e => setError(`Failed to load sites: ${e.message}`))
  }, [])

  const surgSites   = useMemo(() => allSites.filter(s => !isEndoscopy(s)), [allSites])
  const endoSites   = useMemo(() => allSites.filter(s =>  isEndoscopy(s)), [allSites])
  const sitesForTab = tab === 'endoscopy' ? endoSites : surgSites

  // Keep the selected site valid for the active tab
  useEffect(() => {
    if (!sitesForTab.length) { setSite(''); return }
    if (!sitesForTab.includes(site)) setSite(sitesForTab[0])
  }, [tab, allSites])  // eslint-disable-line react-hooks/exhaustive-deps

  // Load the calendar whenever the site changes
  useEffect(() => {
    if (!site) { setCalDays([]); setSelDate(''); return }
    setLoadingCal(true)
    setError(null)
    fetch(`/api/sf/detail/calendar?site=${encodeURIComponent(site)}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`Status ${r.status}`)))
      .then(({ days }) => {
        const list = days || []
        setCalDays(list)
        setSelDate(prev => (prev && list.some(d => d.date === prev)) ? prev : (list[0]?.date || ''))
      })
      .catch(e => setError(`Failed to load calendar: ${e.message}`))
      .finally(() => setLoadingCal(false))
  }, [site])

  // Load the case-block detail whenever site + date are set
  useEffect(() => {
    if (!site || !selDate) { setRows([]); return }
    setLoading(true)
    setError(null)
    fetch(`/api/sf/detail?date=${selDate}&site=${encodeURIComponent(site)}`)
      .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(new Error(e.error || `Status ${r.status}`))))
      .then(setRows)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [site, selDate])

  const pctMap        = useMemo(() => Object.fromEntries(calDays.map(d => [d.date, d.pct])), [calDays])
  const selectableSet = useMemo(() => new Set(calDays.map(d => d.date)), [calDays])

  /* ── Table styles ── */
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

  // Table totals
  const tot = rows.reduce((a, r) => ({
    sched:  a.sched  + (r.ScheduledTotal     || 0),
    fcst:   a.fcst   + (r.ForecastedAddition || 0),
    total:  a.total  + (r.TotalForecasted    || 0),
    sdur:   a.sdur   + (r.SchedDurwTurn       || 0),
    fdur:   a.fdur   + (r.FcstDurwTurn        || 0),
    tdur:   a.tdur   + (r.TotalDurwTurn       || 0),
    block:  a.block  + (r.BlockTime           || 0),
  }), { sched: 0, fcst: 0, total: 0, sdur: 0, fdur: 0, tdur: 0, block: 0 })
  const totPct = tot.block > 0 ? (tot.tdur / tot.block * 100) : null

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Daily Detail</h1>
        <p className="page-subtitle">Scheduled and forecasted case-block detail for an upcoming day</p>
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '2px solid var(--surface-border)' }}>
        {[
          { id: 'surgical',  label: 'Surgical Sites',  count: surgSites.length },
          { id: 'endoscopy', label: 'Endoscopy Sites', count: endoSites.length },
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

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>

        {/* Left: site picker + calendar */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, width: 300, flexShrink: 0 }}>
          <div className="card" style={{ padding: '14px 16px' }}>
            <label className="form-label" style={{ display: 'block', marginBottom: 6 }}>Site</label>
            <select
              className="form-input"
              value={site}
              onChange={e => setSite(e.target.value)}
              disabled={!sitesForTab.length}
              style={{ width: '100%', cursor: 'pointer' }}
            >
              {sitesForTab.length === 0 && <option value="">No sites</option>}
              {sitesForTab.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          <div className="card" style={{ padding: '14px 16px' }}>
            {loadingCal ? (
              <div style={{ padding: 30, textAlign: 'center', color: 'var(--color-gray-400)', fontSize: 13 }}>Loading…</div>
            ) : (
              <MiniCalendar value={selDate} onChange={setSelDate} pctMap={pctMap} selectable={selectableSet} />
            )}
          </div>
        </div>

        {/* Right: detail table */}
        <div style={{ flex: '1 1 520px', minWidth: 360 }}>
          <div className="card">
            <div className="card-header" style={{ padding: '12px 18px' }}>
              <div>
                <div className="card-title" style={{ fontSize: 14 }}>{site || 'Select a site'}</div>
                <div className="card-subtitle" style={{ fontSize: 12 }}>{selDate ? fmtLongDate(selDate) : 'Select a day'}</div>
              </div>
            </div>
            <div className="card-body" style={{ padding: 0 }}>

              {loading && (
                <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-gray-400)', fontSize: 13 }}>Loading…</div>
              )}

              {error && !loading && (
                <div style={{ padding: 40, textAlign: 'center', color: '#b91c1c', fontSize: 13 }}>{error}</div>
              )}

              {!loading && !error && rows.length === 0 && (
                <div style={{ padding: 48, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--color-gray-400)' }}>
                  <CalendarDays size={34} strokeWidth={1.25} style={{ marginBottom: 12 }} />
                  <p style={{ fontSize: 13, color: 'var(--color-gray-500)' }}>
                    {selDate ? 'No case blocks for this day' : 'Pick a day on the calendar'}
                  </p>
                </div>
              )}

              {!loading && !error && rows.length > 0 && (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th rowSpan={2} style={{ ...TH(), textAlign: 'left', minWidth: 170, borderRight: '1px solid var(--surface-border)' }}>Case Block</th>
                        <th colSpan={3} style={{ ...TH(), textAlign: 'center', background: CASE_BG, color: '#3730a3', borderBottom: '1px solid ' + CASE_BORDER }}>Cases</th>
                        <th colSpan={5} style={{ ...TH(), textAlign: 'center', background: DUR_BG, color: '#166534', borderBottom: '1px solid ' + DUR_BORDER }}>Duration (hrs)</th>
                      </tr>
                      <tr>
                        <th style={{ ...TH(), background: CASE_BG }}>Total Sched</th>
                        <th style={{ ...TH(), background: CASE_BG }}>Fcst Addition</th>
                        <th style={{ ...TH(), background: CASE_BG, color: '#1e40af', fontWeight: 700, borderRight: '1px solid ' + CASE_BORDER }}>Total Fcst</th>
                        <th style={{ ...TH(), background: DUR_BG }}>Sched w/Turn</th>
                        <th style={{ ...TH(), background: DUR_BG }}>Fcst w/Turn</th>
                        <th style={{ ...TH(), background: DUR_BG, color: '#15803d', fontWeight: 700 }}>Total w/Turn</th>
                        <th style={{ ...TH(), background: DUR_BG }}>Block Time</th>
                        <th style={{ ...TH(), background: DUR_BG }}>% Filled</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(r => {
                        const pct = r.BlockTime > 0 ? (r.TotalDurwTurn / r.BlockTime * 100) : null
                        return (
                          <tr
                            key={r.CaseBlock}
                            onMouseEnter={e => e.currentTarget.style.background = '#fafbfe'}
                            onMouseLeave={e => e.currentTarget.style.background = ''}
                          >
                            <td style={{ ...TD(), textAlign: 'left', borderRight: '1px solid var(--surface-border)', color: 'var(--color-gray-800)' }}>{r.CaseBlock}</td>
                            <td style={{ ...TD(), background: CASE_BG2 }}>{fmt1(r.ScheduledTotal)}</td>
                            <td style={{ ...TD(), background: CASE_BG2 }}>{fmt1(r.ForecastedAddition)}</td>
                            <td style={{ ...TD(), fontWeight: 600, color: '#1e40af', background: CASE_BG2, borderRight: '1px solid ' + CASE_BORDER }}>{fmt1(r.TotalForecasted)}</td>
                            <td style={{ ...TD(), background: DUR_BG2 }}>{fmtHrs(r.SchedDurwTurn)}</td>
                            <td style={{ ...TD(), background: DUR_BG2 }}>{fmtHrs(r.FcstDurwTurn)}</td>
                            <td style={{ ...TD(), fontWeight: 600, background: DUR_BG2 }}>{fmtHrs(r.TotalDurwTurn)}</td>
                            <td style={{ ...TD(), background: DUR_BG2 }}>{fmtHrs(r.BlockTime)}</td>
                            <td style={{ ...TD(), color: pctColor(pct), fontWeight: pctBold(pct) ? 700 : 400, background: DUR_BG2 }}>{fmtPct(pct)}</td>
                          </tr>
                        )
                      })}

                      {/* Total */}
                      <tr style={{ background: '#166534' }}>
                        <td style={{ ...TD(), textAlign: 'left', fontWeight: 700, color: '#fff', borderRight: '1px solid rgba(255,255,255,0.2)', borderBottom: 'none', paddingTop: 6, paddingBottom: 6 }}>Total</td>
                        <td style={{ ...TD(), fontWeight: 700, color: '#fff', borderBottom: 'none' }}>{fmt1(tot.sched)}</td>
                        <td style={{ ...TD(), fontWeight: 700, color: '#fff', borderBottom: 'none' }}>{fmt1(tot.fcst)}</td>
                        <td style={{ ...TD(), fontWeight: 700, color: '#fff', borderRight: '1px solid rgba(255,255,255,0.2)', borderBottom: 'none' }}>{fmt1(tot.total)}</td>
                        <td style={{ ...TD(), fontWeight: 700, color: '#fff', borderBottom: 'none' }}>{fmtHrs(tot.sdur)}</td>
                        <td style={{ ...TD(), fontWeight: 700, color: '#fff', borderBottom: 'none' }}>{fmtHrs(tot.fdur)}</td>
                        <td style={{ ...TD(), fontWeight: 700, color: '#fff', borderBottom: 'none' }}>{fmtHrs(tot.tdur)}</td>
                        <td style={{ ...TD(), fontWeight: 700, color: '#fff', borderBottom: 'none' }}>{fmtHrs(tot.block)}</td>
                        <td style={{ ...TD(), fontWeight: 700, color: totPct != null && totPct >= 80 ? '#86efac' : '#fca5a5', borderBottom: 'none' }}>{fmtPct(totPct)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

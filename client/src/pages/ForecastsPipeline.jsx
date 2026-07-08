import { useState, useEffect } from 'react'
import { AlertCircle } from 'lucide-react'

/* ─── Helpers ────────────────────────────────────────────────────────────── */

function TrendArrow({ trend, change }) {
  if (trend === 'up')   return <span style={{ color: '#16a34a', fontWeight: 600, whiteSpace: 'nowrap' }}>▲ {change}</span>
  if (trend === 'down') return <span style={{ color: '#dc2626', fontWeight: 600, whiteSpace: 'nowrap' }}>▼ {change}</span>
  return <span style={{ color: '#64748b', whiteSpace: 'nowrap' }}>— {change}</span>
}

function StatCard({ label, value, sub, accent }) {
  return (
    <div style={{ background: 'var(--surface-card)', border: '1px solid var(--surface-border)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-4)' }}>
      <div style={{ fontSize: 12, color: 'var(--color-text-primary)', marginBottom: 'var(--space-2)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 'var(--font-weight-medium)' }}>
        {label}
      </div>
      <div style={{ fontSize: 'var(--font-size-xl)', fontWeight: 'var(--font-weight-semibold)', color: accent || 'var(--color-gray-900)', lineHeight: 1.2 }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)', marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

function MiniStat({ label, value, accent }) {
  return (
    <div style={{ background: 'var(--surface-bg)', border: '1px solid var(--surface-border)', borderRadius: 'var(--radius-md)', padding: '10px 14px', flex: 1 }}>
      <div style={{ fontSize: 12, color: 'var(--color-text-primary)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 'var(--font-size-lg)', fontWeight: 'var(--font-weight-semibold)', color: accent || 'var(--color-gray-900)' }}>
        {value}
      </div>
    </div>
  )
}

function KVRow({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderBottom: '1px solid var(--surface-border)' }}>
      <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-500)' }}>{label}</span>
      <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-medium)', color: 'var(--color-gray-800)' }}>{value}</span>
    </div>
  )
}

function PillTabs({ options, value, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 6, marginBottom: 'var(--space-4)' }}>
      {options.map(o => {
        const active = value === o.value
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            style={{
              padding: '5px 14px',
              borderRadius: 'var(--radius-full)',
              border: '1px solid',
              cursor: 'pointer',
              fontSize: 'var(--font-size-xs)',
              fontWeight: 'var(--font-weight-medium)',
              transition: 'all 150ms',
              background: active ? 'var(--color-blue)' : 'transparent',
              borderColor: active ? 'var(--color-blue)' : 'var(--surface-border)',
              color: active ? 'white' : 'var(--color-gray-600)',
            }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

const TH_STYLE = {
  padding: '8px 12px',
  fontSize: 12,
  color: 'var(--color-text-primary)',
  fontWeight: 'var(--font-weight-semibold)',
  textAlign: 'left',
  borderBottom: '1px solid var(--color-border-secondary)',
  whiteSpace: 'nowrap',
}
const TD_STYLE = {
  padding: '10px 12px',
  fontSize: 'var(--font-size-sm)',
  color: 'var(--color-gray-700)',
  borderBottom: '1px solid var(--surface-border)',
  verticalAlign: 'middle',
}
const TD_TOTAL = {
  ...TD_STYLE,
  fontWeight: 'var(--font-weight-semibold)',
  color: 'var(--color-gray-900)',
  background: 'var(--color-gray-50)',
}

/* ─── System View ────────────────────────────────────────────────────────── */

function SystemView({ data }) {
  const [period, setPeriod] = useState('past')

  if (!data || !data.past || !data.next || !data.forecast) {
    return (
      <div style={{ padding: 'var(--space-8)', textAlign: 'center', color: 'var(--color-gray-400)', fontSize: 'var(--font-size-sm)' }}>
        Room Running forecasts are not available for this organization yet.
      </div>
    )
  }

  const PERIODS = [
    { value: 'past',     label: 'Past 4 weeks' },
    { value: 'next',     label: 'Next 4 weeks' },
    { value: 'forecast', label: '6-month forecast' },
  ]

  const past     = data.past
  const next     = data.next
  const forecast = data.forecast

  return (
    <>
      <PillTabs options={PERIODS} value={period} onChange={setPeriod} />

      {period === 'past' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--space-4)', marginBottom: 'var(--space-5)' }}>
            <StatCard label="Cases Performed" value={past.stats.cases.toLocaleString()} sub={past.stats.period} />
            <StatCard label="Clinic Visits"   value={past.stats.visits.toLocaleString()} sub="Across service lines" />
            <StatCard label="Avg Conversion"  value={past.stats.conversion} sub="Clinic → OR" accent="var(--color-blue)" />
            <StatCard label="New Patient Mix" value={past.stats.newPct} sub="Of all visits" />
          </div>
          <div className="card" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={TH_STYLE}>Service line</th>
                  <th style={{ ...TH_STYLE, textAlign: 'right' }}>Cases performed</th>
                  <th style={{ ...TH_STYLE, textAlign: 'right' }}>Clinic visits</th>
                  <th style={{ ...TH_STYLE, textAlign: 'right' }}>New pt %</th>
                  <th style={{ ...TH_STYLE, textAlign: 'right' }}>Conversion %</th>
                  <th style={{ ...TH_STYLE, textAlign: 'center' }}>vs prior 4wk</th>
                </tr>
              </thead>
              <tbody>
                {past.rows.map(r => (
                  <tr key={r.sl}>
                    <td style={TD_STYLE}>{r.sl}</td>
                    <td style={{ ...TD_STYLE, textAlign: 'right' }}>{r.cases}</td>
                    <td style={{ ...TD_STYLE, textAlign: 'right' }}>{r.visits.toLocaleString()}</td>
                    <td style={{ ...TD_STYLE, textAlign: 'right' }}>{r.newPct}</td>
                    <td style={{ ...TD_STYLE, textAlign: 'right' }}>{r.conversion}</td>
                    <td style={{ ...TD_STYLE, textAlign: 'center' }}><TrendArrow trend={r.trend} change={r.change} /></td>
                  </tr>
                ))}
                <tr>
                  <td style={TD_TOTAL}>Total</td>
                  <td style={{ ...TD_TOTAL, textAlign: 'right' }}>{past.stats.cases}</td>
                  <td style={{ ...TD_TOTAL, textAlign: 'right' }}>{past.stats.visits.toLocaleString()}</td>
                  <td style={{ ...TD_TOTAL, textAlign: 'right' }}>{past.stats.newPct}</td>
                  <td style={{ ...TD_TOTAL, textAlign: 'right' }}>{past.stats.conversion}</td>
                  <td style={TD_TOTAL} />
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}

      {period === 'next' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--space-4)', marginBottom: 'var(--space-5)' }}>
            <StatCard label="Scheduled Cases" value={next.stats.scheduled} sub={next.stats.period} />
            <StatCard label="Clinic Gen'd"    value={next.stats.clinicGen} sub="From clinic pipeline" />
            <StatCard label="OR Days"         value={next.stats.orDays}    sub="Operating days in window" accent="var(--color-blue)" />
            <StatCard label="Avg Cases / Day" value={next.stats.avgPerDay} sub="Across scheduled days" />
          </div>
          <div className="card" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={TH_STYLE}>Service line</th>
                  <th style={{ ...TH_STYLE, textAlign: 'right' }}>Scheduled</th>
                  <th style={{ ...TH_STYLE, textAlign: 'right' }}>Clinic gen'd</th>
                  <th style={{ ...TH_STYLE, textAlign: 'right' }}>Sched visits</th>
                  <th style={{ ...TH_STYLE, textAlign: 'right' }}>New visits</th>
                  <th style={{ ...TH_STYLE, textAlign: 'right' }}>EST visits</th>
                </tr>
              </thead>
              <tbody>
                {next.rows.map(r => (
                  <tr key={r.sl}>
                    <td style={TD_STYLE}>{r.sl}</td>
                    <td style={{ ...TD_STYLE, textAlign: 'right' }}>{r.scheduled}</td>
                    <td style={{ ...TD_STYLE, textAlign: 'right' }}>{r.clinicGen}</td>
                    <td style={{ ...TD_STYLE, textAlign: 'right' }}>{r.schedVisits}</td>
                    <td style={{ ...TD_STYLE, textAlign: 'right' }}>{r.newVisits}</td>
                    <td style={{ ...TD_STYLE, textAlign: 'right' }}>{r.estVisits}</td>
                  </tr>
                ))}
                <tr>
                  <td style={TD_TOTAL}>Total</td>
                  <td style={{ ...TD_TOTAL, textAlign: 'right' }}>{next.stats.scheduled}</td>
                  <td style={{ ...TD_TOTAL, textAlign: 'right' }}>{next.stats.clinicGen}</td>
                  <td style={{ ...TD_TOTAL, textAlign: 'right' }}>{next.rows.reduce((s, r) => s + r.schedVisits, 0).toLocaleString()}</td>
                  <td style={{ ...TD_TOTAL, textAlign: 'right' }}>{next.rows.reduce((s, r) => s + r.newVisits, 0)}</td>
                  <td style={{ ...TD_TOTAL, textAlign: 'right' }}>{next.rows.reduce((s, r) => s + r.estVisits, 0)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}

      {period === 'forecast' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--space-4)', marginBottom: 'var(--space-5)' }}>
            <StatCard label="Forecasted Cases" value={forecast.stats.forecasted.toLocaleString()} sub="6-month projection" accent="var(--color-blue)" />
            <StatCard label="From Completed"   value={forecast.stats.fromCompleted.toLocaleString()} sub="Based on completion rate" />
            <StatCard label="From Scheduled"   value={forecast.stats.fromScheduled.toLocaleString()} sub="Already on the books" />
            <StatCard label="Clinic Visits"    value={forecast.stats.clinicVisits.toLocaleString()} sub="Driving surgical demand" />
          </div>
          <div className="card" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={TH_STYLE}>Service line</th>
                  <th style={{ ...TH_STYLE, textAlign: 'right' }}>Scheduled</th>
                  <th style={{ ...TH_STYLE, textAlign: 'right' }}>Forecasted total</th>
                  <th style={{ ...TH_STYLE, textAlign: 'right' }}>From completed</th>
                  <th style={{ ...TH_STYLE, textAlign: 'right' }}>From scheduled</th>
                  <th style={{ ...TH_STYLE, textAlign: 'right' }}>Clinic visits</th>
                </tr>
              </thead>
              <tbody>
                {forecast.rows.map(r => (
                  <tr key={r.sl}>
                    <td style={TD_STYLE}>{r.sl}</td>
                    <td style={{ ...TD_STYLE, textAlign: 'right' }}>{r.scheduled}</td>
                    <td style={{ ...TD_STYLE, textAlign: 'right', fontWeight: 600, color: 'var(--color-blue)' }}>{r.forecasted}</td>
                    <td style={{ ...TD_STYLE, textAlign: 'right' }}>{r.fromCompleted}</td>
                    <td style={{ ...TD_STYLE, textAlign: 'right' }}>{r.fromScheduled}</td>
                    <td style={{ ...TD_STYLE, textAlign: 'right' }}>{r.visits.toLocaleString()}</td>
                  </tr>
                ))}
                <tr>
                  <td style={TD_TOTAL}>Total</td>
                  <td style={{ ...TD_TOTAL, textAlign: 'right' }}>{forecast.rows.reduce((s, r) => s + r.scheduled, 0)}</td>
                  <td style={{ ...TD_TOTAL, textAlign: 'right', color: 'var(--color-blue)' }}>{forecast.stats.forecasted.toLocaleString()}</td>
                  <td style={{ ...TD_TOTAL, textAlign: 'right' }}>{forecast.stats.fromCompleted.toLocaleString()}</td>
                  <td style={{ ...TD_TOTAL, textAlign: 'right' }}>{forecast.stats.fromScheduled.toLocaleString()}</td>
                  <td style={{ ...TD_TOTAL, textAlign: 'right' }}>{forecast.stats.clinicVisits.toLocaleString()}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  )
}

/* ─── Surgeon View ───────────────────────────────────────────────────────── */

function SurgeonView({ surgeons }) {
  if (!surgeons) {
    return (
      <div style={{ padding: 'var(--space-8)', textAlign: 'center', color: 'var(--color-gray-400)', fontSize: 'var(--font-size-sm)' }}>
        Room Running forecasts are not available for this organization yet.
      </div>
    )
  }

  const serviceLines = Object.keys(surgeons)
  const [sl, setSl]  = useState(serviceLines[0] ?? '')
  const surgeonList  = surgeons[sl] ?? []
  const [surgeonName, setSurgeonName] = useState(surgeonList[0]?.name ?? '')

  function handleSlChange(e) {
    const newSl = e.target.value
    setSl(newSl)
    setSurgeonName((surgeons[newSl] ?? [])[0]?.name ?? '')
  }

  const surgeon = surgeonList.find(s => s.name === surgeonName) ?? surgeonList[0] ?? null

  const selectStyle = {
    padding: '7px 12px',
    borderRadius: 'var(--radius-md)',
    border: '1px solid var(--surface-border)',
    background: 'var(--surface-card)',
    color: 'var(--color-gray-700)',
    fontSize: 'var(--font-size-sm)',
    cursor: 'pointer',
  }

  return (
    <>
      <div style={{ display: 'flex', gap: 'var(--space-3)', marginBottom: 'var(--space-5)', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-gray-500)', fontWeight: 500 }}>Service line</label>
          <select value={sl} onChange={handleSlChange} style={selectStyle}>
            {serviceLines.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-gray-500)', fontWeight: 500 }}>Surgeon</label>
          <select value={surgeonName} onChange={e => setSurgeonName(e.target.value)} style={selectStyle}>
            {surgeonList.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
          </select>
        </div>
      </div>

      {surgeon && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--space-4)' }}>

          <div className="card">
            <div className="card-header">
              <div>
                <div className="card-title" style={{ fontSize: 'var(--font-size-sm)' }}>Past 4 weeks</div>
                <div className="card-subtitle" style={{ fontSize: 11 }}>Jan 31 – Feb 28, 2026</div>
              </div>
            </div>
            <div className="card-body">
              <div style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-4)' }}>
                <MiniStat label="Scheduled" value={surgeon.past.sched} />
                <MiniStat label="Clinic Gen'd" value={surgeon.past.clGen} accent="var(--color-blue)" />
              </div>
              <div>
                <KVRow label="Clinic visits" value={surgeon.past.visits.toLocaleString()} />
                <KVRow label="New visits"    value={surgeon.past.visNew} />
                <KVRow label="New %"         value={`${surgeon.past.visPct}%`} />
                <KVRow label="EST visits"    value={surgeon.past.visEST} />
                <KVRow label="Other"         value={surgeon.past.visOth} />
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <div>
                <div className="card-title" style={{ fontSize: 'var(--font-size-sm)' }}>Next 4 weeks</div>
                <div className="card-subtitle" style={{ fontSize: 11 }}>Mar 7 – Apr 4, 2026</div>
              </div>
            </div>
            <div className="card-body">
              <div style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-4)' }}>
                <MiniStat label="Scheduled" value={surgeon.next.sched} />
                <MiniStat label="Clinic visits" value={surgeon.next.visits.toLocaleString()} accent="var(--color-blue)" />
              </div>
              <div>
                <KVRow label="New visits" value={surgeon.next.visNew} />
                <KVRow label="New %"      value={`${surgeon.next.visPct}%`} />
                <KVRow label="EST visits" value={surgeon.next.visEST} />
                <KVRow label="Other"      value={surgeon.next.visOth} />
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <div>
                <div className="card-title" style={{ fontSize: 'var(--font-size-sm)' }}>6-month forecast</div>
                <div className="card-subtitle" style={{ fontSize: 11 }}>Feb – Jul 2026</div>
              </div>
            </div>
            <div className="card-body">
              <div style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-4)' }}>
                <MiniStat label="Forecasted" value={surgeon.forecast} accent="var(--color-blue)" />
                <MiniStat label="Clinic visits" value={surgeon.visits.toLocaleString()} />
              </div>
              <div>
                <KVRow label="From completed" value={surgeon.fromCompleted} />
                <KVRow label="From scheduled" value={surgeon.fromScheduled} />
                <KVRow label="New visits"     value={surgeon.visNew} />
                <KVRow label="New %"          value={`${surgeon.visPct}%`} />
                <KVRow label="EST visits"     value={surgeon.visEST} />
              </div>
            </div>
          </div>

        </div>
      )}
    </>
  )
}

/* ─── Page ───────────────────────────────────────────────────────────────── */

export default function ForecastsPipeline() {
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [subTab,  setSubTab]  = useState('system')

  useEffect(() => {
    fetch('/api/atlas/performance-briefs-mock')
      .then(r => {
        if (!r.ok) return r.json().then(d => Promise.reject(new Error(d.error || `HTTP ${r.status}`)))
        return r.json()
      })
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  const SUB_TABS = [
    { value: 'system',  label: 'System view' },
    { value: 'surgeon', label: 'Surgeon view' },
  ]

  if (loading) {
    return (
      <div className="page" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 320 }}>
        <div style={{ textAlign: 'center', color: 'var(--color-gray-400)' }}>
          <div style={{ width: 36, height: 36, borderRadius: '50%', border: '3px solid var(--color-blue)', borderTopColor: 'transparent', animation: 'spin 0.7s linear infinite', margin: '0 auto var(--space-4)' }} />
          <p style={{ fontSize: 'var(--font-size-sm)' }}>Loading…</p>
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="page">
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--space-3)', padding: 'var(--space-5)', background: 'var(--color-danger-light)', border: '1px solid #fecaca', borderRadius: 'var(--radius-lg)', color: '#b91c1c', fontSize: 'var(--font-size-sm)' }}>
          <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
          <div>
            <div style={{ fontWeight: 'var(--font-weight-semibold)', marginBottom: 2 }}>Could not load pipeline data</div>
            <div>{error || 'Unknown error'}</div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* Disclaimer */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 16px', background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.3)', borderRadius: 'var(--radius-md)', marginBottom: 'var(--space-5)' }}>
        <AlertCircle size={15} style={{ color: '#b45309', flexShrink: 0, marginTop: 1 }} />
        <span style={{ fontSize: 'var(--font-size-xs)', color: '#92400e', lineHeight: 1.5 }}>
          Pipeline data shown is illustrative. Live data requires connection to Epic scheduling and clinic visit tables.
        </span>
      </div>

      {/* Sub-tab bar */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--surface-border)', marginBottom: 'var(--space-5)' }}>
        {SUB_TABS.map(t => (
          <button
            key={t.value}
            type="button"
            onClick={() => setSubTab(t.value)}
            style={{
              background: 'none', border: 'none',
              borderBottom: subTab === t.value ? '2px solid var(--color-blue)' : '2px solid transparent',
              cursor: 'pointer',
              padding: 'var(--space-2) var(--space-4)',
              fontSize: 'var(--font-size-sm)',
              fontWeight: subTab === t.value ? 'var(--font-weight-semibold)' : 'var(--font-weight-medium)',
              color: subTab === t.value ? 'var(--color-blue)' : 'var(--color-gray-500)',
              marginBottom: -1,
              transition: 'color 150ms',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {subTab === 'system'  && <SystemView  data={data.pipelineSystem} />}
      {subTab === 'surgeon' && <SurgeonView surgeons={data.surgeons} />}
    </div>
  )
}

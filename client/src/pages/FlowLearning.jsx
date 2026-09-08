import { useState, useEffect } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'

import '../components/rtdc/rtdc.css'
import Tabs from '../components/rtdc/Tabs'
import { get, today, addDays } from '../components/rtdc/api'
import MismatchHeatmapTab from './flowlearning/MismatchHeatmapTab'
import ScoreboardTab from './flowlearning/ScoreboardTab'
import EscalationsTab from './flowlearning/EscalationsTab'
import AvoidableTab from './flowlearning/AvoidableTab'
import BarriersTab from './flowlearning/BarriersTab'

/* ─── Flow Learning ───────────────────────────────────────────────────────────
   The analytics: are we getting better, which units are always mismatched,
   which escalation reasons are worth the room's minutes, which Ns could have
   been Ys, and what keeps recurring. The heatmap is first because it answers
   the question a flow leader asks before any other.                          */

const TABS = [
  { id: 'mismatch',    label: 'Mismatch Heatmap' },
  { id: 'scoreboard',  label: 'Scoreboard' },
  { id: 'escalations', label: 'Escalations' },
  { id: 'avoidable',   label: 'Avoidable Ns' },
  { id: 'barriers',    label: 'Barriers' },
]

export default function FlowLearning() {
  const { tab: tabParam } = useParams()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const active = TABS.some(t => t.id === tabParam) ? tabParam : 'mismatch'

  const to = params.get('to') || today()
  const from = params.get('from') || addDays(to, -27)
  const unit = params.get('unit') || ''
  const hospital = params.get('hospital') || ''
  const [meta, setMeta] = useState(null)
  useEffect(() => { get('/meta').then(r => setMeta(r.ok ? r.data : null)) }, [])

  function setQuery(next) {
    const p = new URLSearchParams(params)
    for (const [k, v] of Object.entries(next)) { if (v) p.set(k, v); else p.delete(k) }
    setParams(p, { replace: true })
  }
  function go(tab) { const q = params.toString(); navigate(`/ip/flow-learning/${tab}${q ? `?${q}` : ''}`) }

  const units = meta?.settings?.units?.map(u => u.unit) ?? []
  const range = { from, to, hospital: hospital || undefined }

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Flow Learning</h1>
        <p className="page-subtitle">
          What Epic has no equivalent for: prediction accuracy by unit, which escalation reasons convert,
          which kinds of N keep turning out to be avoidable — the improvement agenda.
        </p>
      </div>

      <div className="rtdc-chrome">
        <input type="date" className="form-input" value={from} max={to} onChange={e => setQuery({ from: e.target.value })} aria-label="From" />
        <span style={{ color: 'var(--color-gray-400)' }}>to</span>
        <input type="date" className="form-input" value={to} max={meta?.today ?? today()} onChange={e => setQuery({ to: e.target.value })} aria-label="To" />
        <select className="form-input" value={unit} onChange={e => setQuery({ unit: e.target.value })} aria-label="Unit">
          <option value="">All units</option>
          {units.map(u => <option key={u} value={u}>{u}</option>)}
        </select>
        {unit && <button type="button" className="rtdc-btn secondary" onClick={() => setQuery({ unit: '' })}>Clear unit</button>}
      </div>

      <Tabs tabs={TABS} active={active} onSelect={go} />

      {active === 'mismatch'    && <MismatchHeatmapTab range={range} unit={unit} onUnit={u => setQuery({ unit: u === unit ? '' : u })} />}
      {active === 'scoreboard'  && <ScoreboardTab range={range} unit={unit} onUnit={u => setQuery({ unit: u })} />}
      {active === 'escalations' && <EscalationsTab range={range} unit={unit} />}
      {active === 'avoidable'   && <AvoidableTab range={range} unit={unit} />}
      {active === 'barriers'    && <BarriersTab range={range} unit={unit} />}
    </div>
  )
}

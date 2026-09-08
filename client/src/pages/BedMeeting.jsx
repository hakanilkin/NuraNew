import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { RefreshCw } from 'lucide-react'

import '../components/rtdc/rtdc.css'
import Tabs from '../components/rtdc/Tabs'
import { get, today, fmtPct, fmtTime } from '../components/rtdc/api'
import BoardTab from './bedmeeting/BoardTab'
import MoveToYesTab from './bedmeeting/MoveToYesTab'
import AncillaryTab from './bedmeeting/AncillaryTab'
import ReviewTab from './bedmeeting/ReviewTab'

/* ─── Bed Meeting ─────────────────────────────────────────────────────────────
   The daily operation, one page, four tabs in the order the morning runs:
   the Board, the Ns on a red unit (Move to Yes), the ancillary worksheet,
   and after 2 PM the review. Everything on it is read from the 08:20
   snapshot; nothing is typed into Nura except a unit's effective beds and,
   after 2 PM, a one-click barrier confirmation.                              */

const TABS = [
  { id: 'board',       label: 'Board' },
  { id: 'move-to-yes', label: 'Move to Yes' },
  { id: 'ancillary',   label: 'Ancillary' },
  { id: 'review',      label: 'Review' },
]

/* Yesterday, in the FunnelStrip idiom: the outcome before the mechanics. */
function YesterdayStrip({ y }) {
  if (!y) return null
  const cell = (label, value, sub) => (
    <div key={label} style={{ flex: '1 1 130px', padding: '10px 16px', borderRight: '1px solid var(--surface-border)' }}>
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, color: 'var(--color-text-primary)' }}>{label}</div>
      <div style={{ fontSize: 'var(--font-size-lg)', fontWeight: 700, marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--color-gray-500)' }}>{sub}</div>}
    </div>
  )
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', flexWrap: 'wrap', border: '1px solid var(--surface-border)', borderRadius: 'var(--radius-lg)',
                  background: 'var(--surface-card)', marginBottom: 'var(--space-4)', overflow: 'hidden' }}>
      <div style={{ flex: '0 0 auto', padding: '10px 16px', background: 'var(--color-gray-50)', borderRight: '1px solid var(--surface-border)', alignSelf: 'stretch' }}>
        <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700, color: 'var(--color-gray-500)' }}>Yesterday</div>
        <div style={{ fontSize: 12, color: 'var(--color-gray-500)' }}>{y.date}</div>
      </div>
      {!y.available
        ? <div className="rtdc-note">Not scored yet.</div>
        : [
          cell('Accuracy', fmtPct(y.accuracyPct), `${y.met} of ${y.met + y.missed} Ys left by 2 PM · ${y.mode}`),
          cell('Unexpected DCs', y.unexpected, y.notOnList ? `+ ${y.notOnList} not on the list` : 'Ns that left by 2 PM'),
          cell('N→Y conversions', `${y.converted} / ${y.candidates}`, 'escalation candidates that left by 2 PM'),
          cell('Units reviewed', `${y.unitsReviewed} / ${y.unitsTotal ?? '—'}`, 'marked on the Review tab'),
        ]}
    </div>
  )
}

export default function BedMeeting() {
  const { tab: tabParam } = useParams()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const active = TABS.some(t => t.id === tabParam) ? tabParam : 'board'

  const date = params.get('date') || today()
  const unit = params.get('unit') || ''
  const status = params.get('status') || ''
  const hospital = params.get('hospital') || ''

  const [meta, setMeta] = useState(null)
  const [board, setBoard] = useState(null)
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)

  useEffect(() => { get('/meta').then(r => setMeta(r.ok ? r.data : null)) }, [])

  // The board is the shared header for every tab (unit list, stamp, strip).
  const refresh = useCallback(() => setTick(t => t + 1), [])
  useEffect(() => {
    let alive = true
    get('/board', { date, hospital: hospital || undefined }).then(r => {
      if (!alive) return
      if (r.ok) { setBoard(r.data); setError('') } else { setBoard(null); setError(r.data?.error || 'Could not load the board') }
    })
    return () => { alive = false }
  }, [date, hospital, tick])

  function setQuery(next) {
    const p = new URLSearchParams(params)
    for (const [k, v] of Object.entries(next)) { if (v) p.set(k, v); else p.delete(k) }
    setParams(p, { replace: true })
  }
  function go(tab, extra = {}) {
    const p = new URLSearchParams(params)
    for (const [k, v] of Object.entries(extra)) { if (v) p.set(k, v); else p.delete(k) }
    const q = p.toString()
    navigate(`/ip/bed-meeting/${tab}${q ? `?${q}` : ''}`)
  }

  const hospitals = board?.hospitals ?? []
  const showHospital = meta && !meta.settings.hospital && hospitals.length > 1
  const isToday = date === (meta?.today ?? today())
  const stampClass = board?.stale ? 'rtdc-stamp amber' : 'rtdc-stamp'

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Bed Meeting</h1>
        <p className="page-subtitle">
          Epic captures. Nura reckons. The 08:20 snapshot, the Ns on a red unit with their facts and clocks,
          who to escalate and why — and after 2 PM, who was right.
        </p>
      </div>

      <div className="rtdc-chrome">
        <input type="date" className="form-input" value={date} max={meta?.today ?? today()} onChange={e => setQuery({ date: e.target.value })} aria-label="Date" />
        {showHospital && (
          <select className="form-input" value={hospital} onChange={e => setQuery({ hospital: e.target.value })} aria-label="Hospital">
            <option value="">All hospitals</option>
            {hospitals.map(h => <option key={h} value={h}>{h}</option>)}
          </select>
        )}
        {board && (
          <span className={stampClass}>
            {board.hasS2
              ? <>as of {fmtTime(board.s2At)}{board.stale ? ' · stale' : ''}{!isToday ? ' · replay' : ''}</>
              : 'no snapshot'}
            <button type="button" onClick={refresh} title="Refresh"><RefreshCw size={12} /></button>
          </span>
        )}
      </div>

      {board?.noSnapshot && (
        <div className="rtdc-banner">Today's {board.s2Time} snapshot not received — showing yesterday ({board.shownDate}), read-only.</div>
      )}
      {error && <div className="rtdc-banner">{error}</div>}

      <YesterdayStrip y={board?.yesterday} />

      <Tabs tabs={TABS} active={active} onSelect={id => go(id)} />

      {active === 'board' && (
        <BoardTab
          board={board} meta={meta} onChanged={refresh}
          onUnit={u => go('move-to-yes', { unit: u, status: '' })}
          onStatus={s => go('move-to-yes', { unit: '', status: s })}
        />
      )}
      {active === 'move-to-yes' && (
        <MoveToYesTab
          date={board?.shownDate ?? date} unit={unit} status={status} board={board} hospital={hospital}
          onUnit={u => setQuery({ unit: u, status: '' })}
          onStatus={s => setQuery({ status: s, unit: '' })}
        />
      )}
      {active === 'ancillary' && <AncillaryTab date={board?.shownDate ?? date} hospital={hospital} />}
      {active === 'review' && <ReviewTab date={date} hospital={hospital} onChanged={refresh} />}
    </div>
  )
}

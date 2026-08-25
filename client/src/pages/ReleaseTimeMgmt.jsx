import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { CheckCircle2, ChevronDown, ChevronRight, ClipboardList } from 'lucide-react'

import OpenTimeRadar from './OpenTimeRadar'
import OpenTimeTracker from './OpenTimeTracker'
import OpenTimeBoard from './OpenTimeBoard'

/* ─── Release Time Mgmt ───────────────────────────────────────────────────────
   One page, four tabs. The Radar finds time worth asking for, the Tracker
   follows the asks, the Board fills what comes back, and Fulfillment is the
   list of entries a scheduler still has to make in the EMR.

   The funnel strip sits above the tabs rather than inside one, because the
   funnel spans all of them and because a leader opening this page should see
   the outcome before the mechanics.                                          */

const TABS = [
  { id: 'radar',       label: 'Release Radar' },
  { id: 'tracker',     label: 'Release Tracker' },
  { id: 'board',       label: 'Open Time Board' },
  { id: 'fulfillment', label: 'Fulfillment' },
]

const fmtHrs = v => (v == null ? '—' : Number(v).toFixed(1))
const fmtPct = v => (v == null ? '—' : `${Math.round(v)}%`)

/* The funnel, left to right. Released hours alone flatter the product; the
   share of them that got booked is the honest number. */
export function FunnelStrip({ summary }) {
  if (!summary) return null
  const steps = [
    { label: 'Requests sent', value: summary.requestsSent, unit: '' },
    { label: 'Hours released', value: fmtHrs(summary.hoursReleased), unit: 'h' },
    { label: 'Hours offered', value: fmtHrs(summary.hoursOffered), unit: 'h' },
    { label: 'Hours booked', value: fmtHrs(summary.hoursBooked), unit: 'h' },
  ]
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', gap: 0, flexWrap: 'wrap',
                  border: '1px solid var(--surface-border)', borderRadius: 'var(--radius-lg)',
                  background: 'var(--surface-card)', marginBottom: 'var(--space-4)', overflow: 'hidden' }}>
      {steps.map((s, i) => (
        <div key={s.label} style={{ flex: '1 1 130px', padding: '12px 16px',
                                    borderRight: '1px solid var(--surface-border)' }}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em',
                        fontWeight: 600, color: 'var(--color-text-primary)' }}>{s.label}</div>
          <div style={{ fontSize: 'var(--font-size-lg)', fontWeight: 700, marginTop: 3 }}>
            {s.value}{s.unit}
          </div>
          {i === 0 && summary.responseRatePct != null && (
            <div style={{ fontSize: 11, color: 'var(--color-gray-400)' }}>
              {fmtPct(summary.responseRatePct)} answered
            </div>
          )}
        </div>
      ))}
      <div style={{ flex: '1 1 150px', padding: '12px 16px', background: 'rgba(34,197,94,0.07)' }}>
        <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em',
                      fontWeight: 600, color: '#15803d' }}>Fill rate</div>
        <div style={{ fontSize: 'var(--font-size-xl)', fontWeight: 800, color: '#15803d', marginTop: 2 }}>
          {fmtPct(summary.fillRatePct)}
        </div>
        <div style={{ fontSize: 11, color: 'var(--color-gray-500)' }}>
          {/* Inventory to work, not a failure — it is the Board's queue. */}
          {fmtHrs(summary.hoursStillOpen)}h released and still open
        </div>
      </div>
    </div>
  )
}

function TaskRow({ task, onComplete, busy }) {
  const [note, setNote] = useState('')
  const [confirming, setConfirming] = useState(false)
  const done = task.status !== 'PENDING'
  return (
    <div style={{ borderBottom: '1px solid var(--surface-border)', padding: '10px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600, color: 'var(--color-gray-900)' }}>
            {task.action}
          </div>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-500)', marginTop: 2 }}>
            Decided {String(task.decidedAt ?? '').slice(0, 10)}
            {task.counterparty ? ` · ${task.counterparty}` : ''}
            {done && task.completedBy ? ` · done by ${task.completedBy}` : ''}
            {task.note ? ` · ${task.note}` : ''}
          </div>
        </div>
        {!done && !confirming && (
          <button type="button" onClick={() => setConfirming(true)}
            style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer',
                     border: '1px solid var(--color-blue)', background: 'var(--color-blue)', color: '#fff',
                     borderRadius: 'var(--radius-md)', padding: '5px 11px',
                     fontSize: 'var(--font-size-xs)', fontWeight: 700, whiteSpace: 'nowrap' }}>
            <CheckCircle2 size={13} /> Mark done
          </button>
        )}
        {done && <CheckCircle2 size={16} style={{ color: '#16a34a', marginTop: 2 }} />}
      </div>
      {confirming && (
        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          <input className="form-input" placeholder="Note (optional)" value={note}
                 onChange={e => setNote(e.target.value)} style={{ flex: '1 1 220px' }} />
          <button type="button" disabled={busy} onClick={() => onComplete(task, note)}
            style={{ cursor: 'pointer', border: 'none', background: 'var(--color-blue)', color: '#fff',
                     borderRadius: 'var(--radius-md)', padding: '6px 12px', fontWeight: 700,
                     fontSize: 'var(--font-size-xs)' }}>
            {busy ? 'Saving…' : 'Confirm'}
          </button>
          <button type="button" onClick={() => { setConfirming(false); setNote('') }}
            style={{ cursor: 'pointer', border: '1px solid var(--surface-border)',
                     background: 'var(--surface-card)', borderRadius: 'var(--radius-md)',
                     padding: '6px 12px', fontSize: 'var(--font-size-xs)' }}>
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}

/* A worklist, not a tracking instrument. No aging, no staleness, no colour by
   age, no per-user statistics — see OpenTimeFulfillment.md §1. */
export function Fulfillment({ tasks, onComplete, busyId, showDone, onToggleDone }) {
  const pending = tasks.filter(t => t.status === 'PENDING')
  const done = tasks.filter(t => t.status !== 'PENDING')
  return (
    <>
      <div className="card" style={{ marginBottom: 'var(--space-4)' }}>
        <div className="card-header">
          <div>
            <div className="card-title">To enter ({pending.length})</div>
            <div className="card-subtitle">
              We don't write to your EMR. This is the list of what to enter, so nothing
              gets lost between the decision and the system of record.
            </div>
          </div>
        </div>
        {pending.length === 0
          ? <div style={{ padding: '18px 14px', color: 'var(--color-gray-400)', fontSize: 'var(--font-size-sm)' }}>
              Nothing to enter.
            </div>
          : pending.slice().reverse().map(t => (
              <TaskRow key={t.id} task={t} onComplete={onComplete} busy={busyId === t.id} />
            ))}
      </div>

      <div className="card">
        <button type="button" onClick={onToggleDone}
          style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
                   background: 'none', border: 'none', cursor: 'pointer', padding: '12px 16px',
                   fontWeight: 700, fontSize: 'var(--font-size-sm)', color: 'var(--color-gray-800)' }}>
          {showDone ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          Done ({done.length})
        </button>
        {showDone && (done.length === 0
          ? <div style={{ padding: '0 16px 16px', color: 'var(--color-gray-400)', fontSize: 'var(--font-size-sm)' }}>
              Nothing completed yet.
            </div>
          : done.map(t => <TaskRow key={t.id} task={t} onComplete={onComplete} />))}
      </div>
    </>
  )
}

export default function ReleaseTimeMgmt() {
  const { tab: tabParam } = useParams()
  const navigate = useNavigate()
  const active = TABS.some(t => t.id === tabParam) ? tabParam : 'radar'

  const [summary, setSummary] = useState(null)
  const [tasks, setTasks] = useState([])
  const [busyId, setBusyId] = useState(null)
  const [showDone, setShowDone] = useState(false)

  const refresh = useCallback(() => {
    fetch('/api/opentime/summary').then(r => (r.ok ? r.json() : null))
      .then(d => setSummary(d && !d.error ? d : null)).catch(() => setSummary(null))
    fetch('/api/opentime/tasks?status=ALL').then(r => (r.ok ? r.json() : null))
      .then(d => setTasks(d?.tasks ?? [])).catch(() => setTasks([]))
  }, [])

  useEffect(() => { refresh() }, [refresh, active])

  async function completeTask(task, note) {
    setBusyId(task.id)
    try {
      const res = await fetch(`/api/opentime/tasks/${encodeURIComponent(task.id)}/complete`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: note || undefined }),
      })
      // Optimistic in feel, reconciled from the response.
      if (res.ok) {
        const updated = await res.json()
        setTasks(prev => prev.map(t => (t.id === updated.id ? updated : t)))
      }
    } finally {
      setBusyId(null)
    }
  }

  const pendingCount = tasks.filter(t => t.status === 'PENDING').length

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Release Time Mgmt</h1>
        <p className="page-subtitle">
          Find block time unlikely to be used, ask for it back, offer it to someone who
          needs it — and hand your scheduler exactly what to enter.
        </p>
      </div>

      <FunnelStrip summary={summary} />

      <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '2px solid var(--surface-border)' }}>
        {TABS.map(t => {
          const isActive = active === t.id
          return (
            <button
              key={t.id} type="button"
              onClick={() => navigate(`/open-time/${t.id}`)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '9px 16px', cursor: 'pointer', border: 'none', background: 'none',
                borderBottom: `2px solid ${isActive ? 'var(--color-blue)' : 'transparent'}`,
                marginBottom: -2, fontWeight: isActive ? 700 : 500,
                color: isActive ? 'var(--color-blue)' : 'var(--color-gray-500)',
                fontSize: 'var(--font-size-sm)',
              }}
            >
              {t.id === 'fulfillment' && <ClipboardList size={14} />}
              {t.label}
              {t.id === 'fulfillment' && pendingCount > 0 && (
                <span style={{ background: 'var(--color-blue)', color: '#fff', borderRadius: 999,
                               fontSize: 10, fontWeight: 700, padding: '1px 6px' }}>{pendingCount}</span>
              )}
            </button>
          )
        })}
      </div>

      {active === 'radar'   && <OpenTimeRadar embedded />}
      {active === 'tracker' && <OpenTimeTracker embedded />}
      {active === 'board'   && <OpenTimeBoard embedded />}
      {active === 'fulfillment' && (
        <Fulfillment
          tasks={tasks} onComplete={completeTask} busyId={busyId}
          showDone={showDone} onToggleDone={() => setShowDone(v => !v)}
        />
      )}
    </div>
  )
}

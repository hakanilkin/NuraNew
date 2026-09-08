import { useState, useEffect, useCallback } from 'react'
import BarrierChips from '../../components/rtdc/BarrierChips'
import { get, send, fmtPct } from '../../components/rtdc/api'

/* After 2 PM: who was right, per unit, with the MISSED list and its inferred
   barrier pre-selected. One click confirms; "Mark unit reviewed" feeds the
   next morning's strip. */
export default function ReviewTab({ date, hospital, onChanged }) {
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState('')

  const load = useCallback(() => {
    get('/review', { date, hospital: hospital || undefined }).then(r => setData(r.ok ? r.data : null))
  }, [date, hospital])
  useEffect(() => { load() }, [load])

  async function confirm(enc, code) {
    setBusy(enc)
    await send('POST', `/review/${encodeURIComponent(enc)}/barrier`, { date, code })
    setBusy(''); load()
  }
  async function reviewed(unit) {
    setBusy(unit)
    await send('POST', `/review/unit/${encodeURIComponent(unit)}/reviewed`, { date })
    setBusy(''); load(); onChanged?.()
  }

  if (!data) return <div className="rtdc-note">Loading…</div>
  if (!data.scorable) {
    return (
      <div className="card" style={{ padding: 24, textAlign: 'center' }}>
        <div style={{ fontSize: 'var(--font-size-lg)', fontWeight: 700 }}>{data.message}</div>
        {data.pendingYs > 0 && <div style={{ color: 'var(--color-gray-500)', marginTop: 6 }}>{data.pendingYs} predicted Y{data.pendingYs === 1 ? '' : 's'} still pending.</div>}
      </div>
    )
  }
  const h = data.house
  const codes = data.barrierCodes || []
  return (
    <>
      <div className="rtdc-tiles">
        <div className="rtdc-tile"><div className="label">House accuracy</div><div className="value">{fmtPct(h.accuracyPct)}</div><div className="sub">{h.MET} met · {h.MISSED} missed · {data.mode}</div></div>
        <div className="rtdc-tile"><div className="label">Unexpected</div><div className="value">{h.UNEXPECTED}</div><div className="sub">Ns that left by {data.cutoff}{h.NOT_ON_LIST ? ` · ${h.NOT_ON_LIST} not on list` : ''}</div></div>
        <div className="rtdc-tile"><div className="label">N→Y conversions</div><div className="value">{h.converted} / {h.candidates}</div><div className="sub">escalation candidates that left</div></div>
        <div className="rtdc-tile"><div className="label">Median DC time</div><div className="value">{h.medianDcTime || '—'}</div><div className="sub">all departures today</div></div>
        <div className="rtdc-tile"><div className="label">Night / AM fidelity</div>
          <div className="value">{data.fidelity?.available ? `${fmtPct(data.fidelity.nightPct)} / ${fmtPct(data.fidelity.amPct)}` : 'n/a'}</div>
          <div className="sub">{data.fidelity?.available ? 'EDD touched overnight / reviewed before huddle' : 'not available for this tenant'}</div></div>
      </div>

      {data.byUnit.map(u => (
        <div className="card" key={u.unit} style={{ padding: 0, overflow: 'hidden', marginBottom: 12 }}>
          <div className="card-header" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
            <div>
              <div className="card-title">{u.unit} <span style={{ fontWeight: 400, color: 'var(--color-gray-500)' }}>· accuracy {fmtPct(u.accuracyPct)}</span></div>
              <div className="card-subtitle">MET {u.MET} · MISSED {u.MISSED} · UNEXPECTED {u.UNEXPECTED} · NOT ON LIST {u.NOT_ON_LIST} · candidates {u.candidates.length}, converted {u.converted}</div>
            </div>
            <div style={{ marginLeft: 'auto' }}>
              {u.reviewed
                ? <span className="badge badge-green">Reviewed</span>
                : <button type="button" className="rtdc-btn" disabled={busy === u.unit || data.readOnly} onClick={() => reviewed(u.unit)}>Mark unit reviewed</button>}
            </div>
          </div>
          {u.missed.length > 0 && (
            <div style={{ padding: '8px 14px' }}>
              <div className="rtdc-divider" style={{ margin: '4px 0 8px' }}>Missed Ys ({u.missed.length}) — confirm the barrier</div>
              {u.missed.map(m => (
                <div key={m.encounterKey} style={{ padding: '8px 0', borderBottom: '1px solid var(--surface-border)', fontSize: 'var(--font-size-sm)' }}>
                  <div><strong>Rm {m.roomBed} · {m.initials}</strong> <span style={{ color: 'var(--color-gray-600)' }}>· {m.attending} · {m.dispo} · {m.barrier.facts}</span>
                    {!m.barrier.inferred && <span style={{ color: 'var(--color-gray-500)', fontSize: 12 }}> · confirmed by {m.barrier.confirmedBy}</span>}</div>
                  {m.narrative && <div style={{ color: 'var(--color-gray-600)', fontSize: 12, marginTop: 2 }}>“{m.narrative}”</div>}
                  <BarrierChips barrier={m.barrier} codes={codes} disabled={busy === m.encounterKey || data.readOnly} onPick={code => confirm(m.encounterKey, code)} />
                </div>
              ))}
            </div>
          )}
          {u.candidates.length > 0 && (
            <div style={{ padding: '4px 14px 10px' }}>
              <div className="rtdc-divider" style={{ margin: '4px 0 6px' }}>Escalation candidates ({u.candidates.length})</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {u.candidates.map(c => (
                  <span key={c.encounterKey} className={`badge ${c.converted ? 'badge-green' : 'badge-gray'}`} title={c.candidates.map(x => x.ruleKey).join(', ')}>
                    Rm {c.roomBed} · {c.candidates[0].ruleKey.replace(/_/g, ' ')} · {c.converted ? `converted ${c.dischargedTime}` : c.dischargedToday ? `left ${c.dischargedTime}` : 'not converted'}
                  </span>
                ))}
              </div>
            </div>
          )}
          {u.unexpected.length > 0 && (
            <div style={{ padding: '0 14px 10px', fontSize: 12, color: 'var(--color-gray-600)' }}>
              Unexpected: {u.unexpected.map(x => `Rm ${x.roomBed} (${x.dischargedTime})`).join(', ')}
            </div>
          )}
        </div>
      ))}
    </>
  )
}

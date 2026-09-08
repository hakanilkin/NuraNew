import { useState, useEffect, useCallback, Fragment } from 'react'
import { get, send } from '../../components/rtdc/api'

/* Weekly archetypes: the plain sentence Nura writes for each, n, bed-hours,
   the suggested bin, and the encounters behind it. "Send to workgroup" queues
   an improvement row. */
export default function AvoidableTab({ range, unit }) {
  const [data, setData] = useState(null)
  const [open, setOpen] = useState(null)
  const [busy, setBusy] = useState('')
  const load = useCallback(() => {
    get('/learn/archetypes', { ...range, unit: unit || undefined }).then(r => setData(r.ok ? r.data : null))
  }, [range.from, range.to, range.hospital, unit]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [load])

  async function queue(a) {
    setBusy(a.key)
    await send('POST', '/improvements', { kind: 'archetype', archetype: a.key, sentence: a.sentence, unit: a.unit, bin: a.suggestedBin })
    setBusy(''); load()
  }

  if (!data) return <div className="rtdc-note">Loading…</div>
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div className="card-header">
        <div>
          <div className="card-title">Top archetypes by bed-hours</div>
          <div className="card-subtitle">{data.avoidable} avoidable Ns in the range: Ns that left by 2 PM anyway, left by 6 PM with an order before noon, or matched a rule that converts ≥ 50% on their unit.</div>
        </div>
      </div>
      <div className="table-wrap">
        <table className="rtdc-table">
          <thead><tr><th>Archetype</th><th className="num">n</th><th className="num">Bed-hours</th><th>Suggested bin</th><th>Weeks</th><th>Status</th><th /></tr></thead>
          <tbody>
            {data.archetypes.length === 0 && <tr><td colSpan={7} className="rtdc-note">No avoidable Ns in this range.</td></tr>}
            {data.archetypes.map(a => (
              <Fragment key={a.key}>
                <tr key={a.key} className="clickable" onClick={() => setOpen(open === a.key ? null : a.key)}>
                  <td className="wide">
                    <strong>{a.sentence}</strong>
                    <div style={{ color: 'var(--color-gray-500)', fontSize: 12, marginTop: 2 }}>
                      {a.services.map(s => `${s.name} ${s.n}`).join(' · ')} — {a.attendings.map(s => `${s.name} ${s.n}`).join(' · ')}
                    </div>
                  </td>
                  <td className="num">{a.n}</td>
                  <td className="num">{a.bedHours}</td>
                  <td><span className="badge badge-gray">{a.suggestedBin}</span></td>
                  <td style={{ whiteSpace: 'nowrap' }}>{a.weeks.length}</td>
                  <td>{a.status === 'queued' ? <span className="badge badge-blue">queued</span> : <span className="badge badge-gray">open</span>}</td>
                  <td onClick={e => e.stopPropagation()}>
                    {a.status !== 'queued' && <button type="button" className="rtdc-btn" disabled={busy === a.key} onClick={() => queue(a)}>Send to workgroup</button>}
                  </td>
                </tr>
                {open === a.key && (
                  <tr key={`${a.key}-enc`}>
                    <td colSpan={7} style={{ background: 'var(--color-gray-50)' }}>
                      <table className="rtdc-table" style={{ fontSize: 12 }}>
                        <thead><tr><th>Date</th><th>Room</th><th>Service · attending</th><th>What happened</th><th>Order</th><th>Departed</th></tr></thead>
                        <tbody>{a.encounters.map((e, i) => (
                          <tr key={i}><td>{e.date}</td><td>{e.roomBed} · {e.initials}</td><td>{e.service} · {e.attending}</td><td>{e.why}</td><td>{e.orderTime || '—'}</td><td>{e.dischargedTime || '—'}</td></tr>
                        ))}</tbody>
                      </table>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

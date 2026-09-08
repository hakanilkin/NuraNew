import { useState, useEffect } from 'react'
import { get } from '../../components/rtdc/api'

/* The client worksheet's "Ancillary Prioritization" tab, generated: pending
   items across units for Y and escalated-N patients, by service, by needed-by. */
export default function AncillaryTab({ date, hospital }) {
  const [data, setData] = useState(null)
  const [service, setService] = useState('')
  useEffect(() => {
    let alive = true
    get('/ancillary', { date, hospital: hospital || undefined }).then(r => { if (alive) setData(r.ok ? r.data : null) })
    return () => { alive = false }
  }, [date, hospital])

  if (!data) return <div className="rtdc-note">Loading…</div>
  if (!data.available) return <div className="rtdc-note">{data.message || 'Pending items unavailable for this tenant.'}</div>
  if (data.hasS2 === false) return <div className="rtdc-note">No snapshot for {date}.</div>
  const services = data.services.filter(s => !service || s.service === service)
  return (
    <>
      <div className="rtdc-chrome">
        <select className="form-input" value={service} onChange={e => setService(e.target.value)} aria-label="Service">
          <option value="">All services</option>
          {data.services.map(s => <option key={s.service} value={s.service}>{s.service} ({s.count})</option>)}
        </select>
        <span className="rtdc-stamp">{data.services.reduce((n, s) => n + s.count, 0)} pending items for Y and escalated-N patients</span>
      </div>
      {services.length === 0 && <div className="rtdc-note">Nothing pending.</div>}
      {services.map(s => (
        <div className="card" key={s.service} style={{ padding: 0, overflow: 'hidden', marginBottom: 12 }}>
          <div className="card-header"><div className="card-title">{s.service} <span style={{ color: 'var(--color-gray-500)', fontWeight: 400 }}>· {s.count}</span></div></div>
          <div className="table-wrap">
            <table className="rtdc-table">
              <thead><tr><th>Unit</th><th>Room</th><th>Item</th><th>Ordered</th><th>Needed by</th><th>Patient</th></tr></thead>
              <tbody>
                {s.rows.map((r, i) => (
                  <tr key={i}>
                    <td>{r.unit}</td><td>{r.roomBed} · {r.initials}</td>
                    <td>{r.item}<span style={{ color: 'var(--color-gray-500)' }}> · {r.status}</span></td>
                    <td>{r.orderedAt || '—'}</td>
                    <td style={{ color: r.late ? '#b91c1c' : undefined, fontWeight: r.late ? 700 : 400 }}>{r.neededBy}{r.late ? ' · late' : ''}</td>
                    <td><span className={`badge ${r.tag === 'Y' ? 'badge-green' : 'badge-blue'}`}>{r.tag}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </>
  )
}

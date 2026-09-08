import { useState, useEffect, useCallback, Fragment } from 'react'
import { get, send } from '../../components/rtdc/api'

/* The barrier tracker: unit × code with times seen, the recurrence flag, bin,
   status, pilot reference. This is the list the bi-weekly workgroup opens with. */
export default function BarriersTab({ range, unit }) {
  const [data, setData] = useState(null)
  const [open, setOpen] = useState(null)
  const [pilot, setPilot] = useState({})
  const load = useCallback(() => {
    get('/barriers', { ...range, unit: unit || undefined }).then(r => setData(r.ok ? r.data : null))
  }, [range.from, range.to, range.hospital, unit]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [load])

  async function update(row, body) {
    await send('POST', `/barriers/${encodeURIComponent(row.unit)}/${encodeURIComponent(row.code)}`, body)
    load()
  }
  async function toWorkgroup(row) {
    await send('POST', '/improvements', { kind: 'barrier', unit: row.unit, code: row.code, bin: row.bin, sentence: `${row.label} on ${row.unit} — ${row.timesSeen} missed Ys in the window` })
    load()
  }

  if (!data) return <div className="rtdc-note">Loading…</div>
  const key = r => `${r.unit}|${r.code}`
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div className="card-header">
        <div>
          <div className="card-title">Barrier tracker</div>
          <div className="card-subtitle">Inferred barrier per missed Y (confirmed on the Review tab). Same unit + code on ≥ 3 of the last 5 weekdays → operational fix; ≥ 6 of the last 10 → PI initiative.</div>
        </div>
      </div>
      <div className="table-wrap">
        <table className="rtdc-table">
          <thead><tr><th>Unit</th><th>Barrier</th><th className="num">Seen</th><th className="num">Last 5 wd</th><th>Recurrence</th><th>Bin</th><th>Status</th><th>Pilot</th><th /></tr></thead>
          <tbody>
            {data.rows.length === 0 && <tr><td colSpan={9} className="rtdc-note">No missed Ys in this range.</td></tr>}
            {data.rows.map(r => (
              <Fragment key={key(r)}>
                <tr key={key(r)} className="clickable" onClick={() => setOpen(open === key(r) ? null : key(r))}>
                  <td>{r.unit}</td>
                  <td><strong>{r.label}</strong><div style={{ fontSize: 12, color: 'var(--color-gray-500)' }}>{r.confirmed} of {r.timesSeen} confirmed</div></td>
                  <td className="num">{r.timesSeen}</td>
                  <td className="num">{r.inLast5}</td>
                  <td>{r.recurrence ? <span className={`badge ${r.recurrence === 'PI initiative' ? 'badge-red' : 'badge-yellow'}`}>{r.recurrence}</span> : '—'}</td>
                  <td onClick={e => e.stopPropagation()}>
                    <select className="form-input" style={{ height: 30, fontSize: 12 }} value={r.bin} onChange={e => update(r, { bin: e.target.value })}>
                      {['Epic config', 'Epic adoption', 'process'].map(b => <option key={b} value={b}>{b}</option>)}
                    </select>
                  </td>
                  <td onClick={e => e.stopPropagation()}>
                    <select className="form-input" style={{ height: 30, fontSize: 12 }} value={r.status} onChange={e => update(r, { status: e.target.value })}>
                      {data.statuses.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </td>
                  <td onClick={e => e.stopPropagation()}>
                    <input className="form-input" style={{ height: 30, fontSize: 12, width: 110 }} placeholder="PI-…" value={pilot[key(r)] ?? r.pilotRef ?? ''}
                           onChange={e => setPilot(p => ({ ...p, [key(r)]: e.target.value }))}
                           onBlur={e => { if ((e.target.value || '') !== (r.pilotRef || '')) update(r, { pilot_ref: e.target.value }) }} />
                  </td>
                  <td onClick={e => e.stopPropagation()}>
                    {r.status === 'open' && <button type="button" className="rtdc-btn" onClick={() => toWorkgroup(r)}>Send to workgroup</button>}
                  </td>
                </tr>
                {open === key(r) && (
                  <tr key={`${key(r)}-enc`}>
                    <td colSpan={9} style={{ background: 'var(--color-gray-50)' }}>
                      <table className="rtdc-table" style={{ fontSize: 12 }}>
                        <thead><tr><th>Date</th><th>Room</th><th>Facts</th><th>Confirmed</th></tr></thead>
                        <tbody>{r.encounters.map((e, i) => <tr key={i}><td>{e.date}</td><td>{e.roomBed} · {e.initials}</td><td>{e.facts}</td><td>{e.confirmed ? 'yes' : 'inferred'}</td></tr>)}</tbody>
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

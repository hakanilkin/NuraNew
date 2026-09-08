import { useState, useEffect } from 'react'
import { get, fmtPct, fmtSigned } from '../../components/rtdc/api'

/* Rule × fired × converted × rate × trend. Rules with too few firings show n
   only. Enable/disable lives on /admin, not here. */
export default function EscalationsTab({ range, unit }) {
  const [data, setData] = useState(null)
  const [rule, setRule] = useState('')
  useEffect(() => {
    let alive = true
    get('/escalations', { ...range, unit: unit || undefined, rule: rule || undefined }).then(r => { if (alive) setData(r.ok ? r.data : null) })
    return () => { alive = false }
  }, [range.from, range.to, range.hospital, unit, rule]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return <div className="rtdc-note">Loading…</div>
  const sel = data.rule
  return (
    <>
      <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 12 }}>
        <div className="table-wrap">
          <table className="rtdc-table">
            <thead><tr><th>Rule</th><th>Reason on the report</th><th className="num">Fired</th><th className="num">Converted</th><th className="num">Conversion</th><th className="num">Trend</th></tr></thead>
            <tbody>
              {data.rules.map(r => (
                <tr key={r.ruleKey} className={`clickable${sel === r.ruleKey ? ' selected' : ''}`} onClick={() => setRule(r.ruleKey)}>
                  <td><strong>{r.ruleKey.replace(/_/g, ' ')}</strong>{!r.enabled && <span className="badge badge-gray" style={{ marginLeft: 6 }}>off</span>}</td>
                  <td className="wide" style={{ color: 'var(--color-gray-600)', maxWidth: 420 }}>{r.reasonText}</td>
                  <td className="num">{r.fired}</td>
                  <td className="num">{r.converted}</td>
                  <td className="num">{r.belowMin ? <span style={{ color: 'var(--color-gray-500)' }}>n={r.fired}</span> : <strong>{fmtPct(r.conversionPct)}</strong>}</td>
                  <td className="num">{r.trend == null ? '—' : `${fmtSigned(r.trend)} pts`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="rtdc-note" style={{ padding: '8px 14px' }}>Rules with fewer than {data.minFirings} firings show n only. Trend compares the second half of the range with the first.</div>
      </div>

      {sel && (
        <div className="grid-2" style={{ gap: 12 }}>
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div className="card-header"><div className="card-title">{sel.replace(/_/g, ' ')} by unit</div></div>
            <table className="rtdc-table"><thead><tr><th>Unit</th><th className="num">Fired</th><th className="num">Converted</th><th className="num">Rate</th></tr></thead>
              <tbody>{data.byUnit.map(r => <tr key={r.unit}><td>{r.unit}</td><td className="num">{r.fired}</td><td className="num">{r.converted}</td><td className="num">{r.belowMin ? `n=${r.fired}` : fmtPct(r.conversionPct)}</td></tr>)}</tbody></table>
          </div>
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div className="card-header"><div className="card-title">{sel.replace(/_/g, ' ')} by attending</div></div>
            <table className="rtdc-table"><thead><tr><th>Attending</th><th className="num">Fired</th><th className="num">Converted</th><th className="num">Rate</th></tr></thead>
              <tbody>{data.byAttending.slice(0, 12).map(r => <tr key={r.attending}><td>{r.attending}</td><td className="num">{r.fired}</td><td className="num">{r.converted}</td><td className="num">{r.belowMin ? `n=${r.fired}` : fmtPct(r.conversionPct)}</td></tr>)}</tbody></table>
          </div>
          <div className="card col-span-2" style={{ padding: 0, overflow: 'hidden' }}>
            <div className="card-header"><div className="card-title">Firings ({data.firings.length})</div></div>
            <div className="table-wrap" style={{ maxHeight: 360, overflowY: 'auto' }}>
              <table className="rtdc-table"><thead><tr><th>Date</th><th>Unit</th><th>Room</th><th>Attending</th><th>Outcome</th></tr></thead>
                <tbody>{data.firings.map((f, i) => (
                  <tr key={i}><td>{f.date}</td><td>{f.unit}</td><td>{f.roomBed} · {f.initials}</td><td>{f.attending}</td>
                    <td>{f.converted ? <span className="badge badge-green">converted {f.dischargedTime}</span> : f.dischargedTime ? <span className="badge badge-gray">left {f.dischargedTime}</span> : <span className="badge badge-gray">stayed</span>}</td></tr>
                ))}</tbody></table>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

import { useState } from 'react'
import { useAuth } from '../../AuthContext'
import StatusPill from '../../components/rtdc/StatusPill'
import EffectiveBedsEditor from '../../components/rtdc/EffectiveBedsEditor'
import { send, fmtSigned, fmtTime } from '../../components/rtdc/api'

/* ─── Board — demand & capacity, the morning huddle view ──────────────────────
   One row per unit in huddle order (the flow coordinator's script, so no
   column sorting). Everything is read from the 08:20 snapshot except a unit's
   effective open beds. A red row, or its gap, is the way into that unit's
   discharge list.                                                            */

// Demand by source, in the order the room asks about it. First pass is always
// printed in full — including its zeros, because "we checked" is the point.
const FIRST = [['Bed req', 'bedRequests'], ['OR', 'orExpected'], ['Step-down', 'downgradeRequests']]
const SECOND = [['ED likely', 'edLikely'], ['ED fcst', 'edForecast'], ['Proc', 'procedural'], ['Step-down ant.', 'downgradesAnticipated']]

const occColor = pct => (pct >= 0.95 ? '#dc2626' : pct >= 0.88 ? '#ea580c' : pct >= 0.75 ? '#d9a406' : '#16a34a')

function Occupancy({ occupied, staffed }) {
  const pct = staffed > 0 ? Math.min(1, occupied / staffed) : 0
  return (
    <div className="rtdc-occ">
      <span className="track"><span className="fill" style={{ width: `${Math.round(pct * 100)}%`, background: occColor(pct) }} /></span>
      <span>{occupied}</span>
    </div>
  )
}

function SummaryCard({ label, value, sub, tone, onClick }) {
  const inner = <><div className="label">{label}</div><div className="value">{value}</div><div className="sub">{sub}</div></>
  if (!onClick) return <div className={`rtdc-sum-card ${tone}`}>{inner}</div>
  return <button type="button" className={`rtdc-sum-card ${tone}`} onClick={onClick} title="Open the discharge list for these units">{inner}</button>
}

export default function BoardTab({ board, meta, onUnit, onStatus, onChanged }) {
  const [editing, setEditing] = useState(null)
  const { user } = useAuth()
  if (!board) return <div className="rtdc-note">Loading…</div>
  if (!board.hasS2) return <div className="rtdc-note">No snapshot for {board.shownDate}.</div>

  const readOnly = board.readOnly
  const reasons = board.reasons || meta?.settings?.effective_bed_reasons || []
  const house = board.house
  const counts = { red: 0, even: 0, green: 0 }
  for (const u of board.units) counts[u.color] += 1
  const snapshot = readOnly ? 'Replay' : board.stale ? 'Stale' : 'Live'
  // The hospital only earns a place in the unit line when there is more than one.
  const manyHospitals = new Set(board.units.map(u => u.hospital).filter(Boolean)).size > 1
  const window = `${board.s2Time ?? meta?.settings?.snapshot_times?.S2 ?? '08:20'} – ${meta?.settings?.cutoff ?? '14:00'}`
  const occPct = house && house.staffed > 0 ? Math.round((house.occupied / house.staffed) * 100) : null

  async function save(unit, body) {
    const r = await send('POST', `/unit/${encodeURIComponent(unit)}/effective-beds`, { date: board.date, ...body })
    if (r.ok) { setEditing(null); onChanged() }
    return r
  }

  const sources = (s, pairs, all) => pairs
    .filter(([, k]) => all || s[k])
    .map(([label, k]) => `${label} ${s[k]}`).join(' · ')

  return (
    <>
      <div className="rtdc-huddle">
        <div className="rtdc-huddle-head">
          <span className="title">Demand &amp; capacity — morning huddle view</span>
          <span className="when">{board.shownDate}{board.isToday && !readOnly ? ' · today' : ''} · {user?.tenantName ?? ''}</span>
        </div>
        <div className="rtdc-huddle-meta">
          <span><span className="k">Window</span><span className="v">{window}</span></span>
          <span><span className="k">Snapshot</span><span className="v">{snapshot}</span></span>
          <span><span className="k">System beds staffed</span><span className="v">{house?.staffed ?? '—'}</span></span>
          <span><span className="k">Current occupancy</span><span className="v">{occPct == null ? '—' : `${occPct}%`}</span></span>
          <span><span className="k">Snapshot taken</span><span className="v">{fmtTime(board.s2At)}</span></span>
        </div>
      </div>

      <div className="rtdc-summary">
        <SummaryCard label="Red units" value={counts.red} sub="Demand > capacity" tone="red"
          onClick={counts.red ? () => onStatus('red') : undefined} />
        <SummaryCard label="Even units" value={counts.even} sub="Demand = capacity" tone="even"
          onClick={counts.even ? () => onStatus('even') : undefined} />
        <SummaryCard label="Green units" value={counts.green} sub="Capacity available" tone="green"
          onClick={counts.green ? () => onStatus('green') : undefined} />
        <SummaryCard label={`Projected discharges by ${meta?.settings?.cutoff ?? '14:00'}`} value={house?.predictedY ?? '—'}
          sub="Across all units" tone="navy" />
      </div>

      <div className="rtdc-section-label">Unit-level demand / capacity — {window} window</div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="table-wrap">
          <table className={`rtdc-board${readOnly ? ' readonly' : ''}`}>
            <thead>
              <tr>
                <th>Unit</th><th className="num">Staffed beds</th><th className="num">Occ. @ {board.s2Time ?? '08:20'}</th>
                <th className="num">Open beds</th><th>Forecasted demand</th><th className="num">Proj. discharges</th>
                <th className="num">Net gap</th><th className="num">Status</th>
              </tr>
            </thead>
            <tbody>
              {board.units.map(u => (
                <tr key={u.unit} className={`clickable ${u.color}`} onClick={() => onUnit(u.unit)} title="Open the discharge list for this unit">
                  <td>
                    <strong>{u.unit}</strong>
                    <span className="sub">{[u.levelOfCare, manyHospitals ? u.hospital : null].filter(Boolean).join(' · ')}</span>
                  </td>
                  <td className="num">{u.staffed}{u.blocked ? <span className="sub">{u.blocked} blocked</span> : null}</td>
                  <td className="num"><Occupancy occupied={u.occupied} staffed={u.staffed} /></td>
                  <td className="num" onClick={e => { e.stopPropagation(); if (!readOnly) setEditing(u.unit) }}>
                    {editing === u.unit
                      ? <EffectiveBedsEditor row={u} reasons={reasons} onSave={b => save(u.unit, b)} onCancel={() => setEditing(null)} />
                      : <>
                          <span className="eff" title={readOnly ? undefined : 'Enter effective open beds'}><strong>{u.effective}</strong></span>
                          {u.adjusted && <span className="reason">{fmtSigned(u.adjustment)} on {u.available} available · {u.adjustmentReason || 'no reason'}{u.adjustedBy ? ` · ${u.adjustedBy}` : ''}</span>}
                        </>}
                  </td>
                  <td className="rtdc-dem">
                    <div className="total">{u.demand}</div>
                    <div className="line">1st {u.firstPass} · {sources(u.sources, FIRST, true)}</div>
                    <div className="line">2nd {u.secondPass}{u.secondPass ? ` · ${sources(u.sources, SECOND, false)}` : ''}</div>
                  </td>
                  <td className="num">
                    {u.predictedY}
                    <span className="sub">{u.ns} N{u.candidates ? ` · ${u.candidates} to escalate` : ''}</span>
                  </td>
                  <td className="num">
                    <button type="button" className={`rtdc-gap ${u.color}`} onClick={e => { e.stopPropagation(); onUnit(u.unit) }}
                            title={`capacity ${u.capacity} − demand ${u.demand}`}>
                      {fmtSigned(u.status)}
                    </button>
                  </td>
                  <td className="num"><StatusPill color={u.color} status={u.status} variant="word" /></td>
                </tr>
              ))}
            </tbody>
            {house && (
              <tfoot>
                <tr>
                  <td>House</td>
                  <td className="num">{house.staffed}</td>
                  <td className="num"><Occupancy occupied={house.occupied} staffed={house.staffed} /></td>
                  <td className="num">{house.effective}</td>
                  <td className="rtdc-dem"><div className="total">{house.demand}</div><div className="line">1st {house.firstPass} · 2nd {house.secondPass}</div></td>
                  <td className="num">{house.predictedY}</td>
                  <td className="num">{fmtSigned(house.status)}</td>
                  <td className="num"><StatusPill color={house.color} status={house.status} variant="word" /></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </>
  )
}

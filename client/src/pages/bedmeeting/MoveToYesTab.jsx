import { useState, useEffect, Fragment } from 'react'
import DischargeCard from '../../components/rtdc/DischargeCard'
import StatusPill from '../../components/rtdc/StatusPill'
import { get, fmtTime } from '../../components/rtdc/api'

/* ─── Move to Yes — the discharge priority list ───────────────────────────────
   The Ns the room can still act on, ranked: escalation candidates first in
   rule order, then by excess LOS, grouped by whether their unit is short.
   Each patient carries what is done, what is left, and by when. Read-only —
   the room decides; nobody types a plan into Nura.                           */

const GROUPS = [
  { color: 'red',   label: 'Red units — demand > capacity' },
  { color: 'even',  label: 'Even units — demand = capacity' },
  { color: 'green', label: 'Green units — capacity available' },
]

export default function MoveToYesTab({ date, unit, status, board, onUnit, onStatus, hospital }) {
  const [data, setData] = useState(null)
  const [showRest, setShowRest] = useState(false)
  const [showNoEdd, setShowNoEdd] = useState(false)
  const key = `${date}|${unit}|${status}|${hospital}`
  const loading = data?.key !== key

  useEffect(() => {
    let alive = true
    get('/discharges', { date, unit: unit || undefined, status: status || undefined, hospital: hospital || undefined })
      .then(r => {
        if (!alive) return
        setData({ key, ...(r.ok ? r.data : { hasS2: false, units: [] }) })
        setShowRest(false); setShowNoEdd(false)
      })
    return () => { alive = false }
  }, [key, date, unit, status, hospital])

  const units = board?.units ?? []
  const single = unit ? units.find(u => u.unit === unit) : null
  // The hospital only earns a place on a card when there is more than one.
  const showHospital = new Set(units.map(u => u.hospital).filter(Boolean)).size > 1

  // The prioritised sequence: the Ns on the units that are short, then the Ys
  // whose own morning is slipping, then — behind a toggle when nothing is
  // filtered — the units that have room. Numbered straight through, because
  // that is the order the room works them, and the collapsible group sits last
  // so opening it never renumbers the work above it.
  const [showGreen, setShowGreen] = useState(false)
  const nsFor = color => (data?.units ?? []).filter(u => u.header?.color === color).flatMap(u => u.ns)
  const filtered = !!(unit || status)
  const groups = []
  if (data && !loading && data.hasS2) {
    for (const g of GROUPS.filter(g => g.color !== 'green')) {
      const rows = nsFor(g.color)
      if (rows.length) groups.push({ ...g, rows })
    }
    const risk = data.units.flatMap(u => u.ysAtRisk)
    if (risk.length) groups.push({ color: 'plain', label: 'Predicted Y — at risk of slipping past 2 PM', rows: risk })
    const green = nsFor('green')
    if (green.length && (filtered || showGreen)) groups.push({ ...GROUPS[2], rows: green })
  }
  let rank = 0
  for (const g of groups) g.rows = g.rows.map(p => ({ p, rank: ++rank }))
  const greenHidden = !filtered && !showGreen ? nsFor('green').length : 0
  const onTrack = data?.units?.flatMap(u => u.ysRemaining) ?? []
  const noEdd = data?.units?.flatMap(u => u.noEdd) ?? []

  return (
    <>
      <div className="rtdc-units">
        <button type="button" className={!unit && !status ? 'active' : ''} onClick={() => { onUnit(''); onStatus('') }}>All units</button>
        {GROUPS.map(g => {
          const n = units.filter(u => u.color === g.color).length
          if (!n) return null
          return (
            <button key={g.color} type="button" className={status === g.color ? 'active' : ''} onClick={() => onStatus(g.color)}>
              <span className={`dot ${g.color}`} />{g.color === 'red' ? 'Red' : g.color === 'even' ? 'Even' : 'Green'} units · {n}
            </button>
          )
        })}
        {units.map(u => (
          <button key={u.unit} type="button" className={u.unit === unit ? 'active' : ''} onClick={() => onUnit(u.unit)}>
            <span className={`dot ${u.color}`} />{u.unit}{u.color === 'red' ? ` (${u.status})` : ''}{u.candidates ? ` · ${u.candidates} to escalate` : ''}
          </button>
        ))}
      </div>

      {single && (
        <div className="card" style={{ padding: '10px 14px', marginBottom: 12, display: 'flex', flexWrap: 'wrap', gap: '6px 18px', alignItems: 'center', fontSize: 'var(--font-size-sm)' }}>
          <strong style={{ fontSize: 'var(--font-size-md)' }}>{single.unit}</strong>
          <span>Capacity <strong>{single.capacity}</strong> <span style={{ color: 'var(--color-gray-500)' }}>({single.effective} open + {single.predictedY} projected discharges)</span></span>
          <span>Demand <strong>{single.demand}</strong> <span style={{ color: 'var(--color-gray-500)' }}>({single.firstPass} + {single.secondPass})</span></span>
          <StatusPill status={single.status} color={single.color} />
          {single.status < 0 && <span style={{ color: '#b91c1c', fontWeight: 600 }}>Gap {Math.abs(single.status)} — {single.candidates} candidates among {single.ns} Ns</span>}
          {data?.units?.[0]?.medians?.DO_TO_DC != null && <span style={{ color: 'var(--color-gray-500)', fontSize: 12 }}>DO→DC median {data.units[0].medians.DO_TO_DC} min</span>}
        </div>
      )}

      {loading && <div className="rtdc-note">Loading…</div>}
      {!loading && data && !data.hasS2 && <div className="rtdc-note">No snapshot for {date}.</div>}

      {!loading && data?.hasS2 && (
        <div className="rtdc-dc">
          <div className="rtdc-dc-head">
            <span className="title">Discharge priority list — pending activities</span>
            <span className="count">
              {fmtTime(data.s2At)} · {rank} patient{rank === 1 ? '' : 's'} shown
              {data.readOnly ? ' · replay' : ''}
            </span>
          </div>
          <div className="rtdc-dc-body">
            {groups.length === 0 && greenHidden === 0 && (
              <div className="rtdc-note">Nothing to work: no N and no Y at risk on these units.</div>
            )}
            {groups.map(g => (
              <Fragment key={g.label}>
                <div className={`rtdc-dc-group ${g.color}`}>{g.label} · {g.rows.length}</div>
                {g.rows.map(({ p, rank: n }) => (
                  <DischargeCard key={p.encounterKey} p={p} rank={n} date={date} showHospital={showHospital} conversion={data.conversion30?.[p.unit]} />
                ))}
              </Fragment>
            ))}

            {greenHidden > 0 && (
              <button type="button" className="dc-toggle" onClick={() => setShowGreen(true)}>
                Show {greenHidden} N on units with capacity available
              </button>
            )}

            {onTrack.length > 0 && (
              <>
                <button type="button" className="dc-toggle" onClick={() => setShowRest(v => !v)}>
                  {showRest ? 'Hide' : 'Show'} {onTrack.length} predicted Y on track
                </button>
                {showRest && onTrack.map(p => (
                  <DischargeCard key={p.encounterKey} p={p} date={date} defaultOpen={false} showHospital={showHospital} conversion={data.conversion30?.[p.unit]} />
                ))}
              </>
            )}

            {noEdd.length > 0 && (
              <>
                <button type="button" className="dc-toggle" onClick={() => setShowNoEdd(v => !v)}>
                  {showNoEdd ? 'Hide' : 'Show'} {noEdd.length} inpatient{noEdd.length === 1 ? '' : 's'} with no expected discharge date
                </button>
                {showNoEdd && (
                  <>
                    <div className="rtdc-dc-group plain">Not on the list — Epic has no expected discharge date for these patients</div>
                    {noEdd.map(p => (
                      <DischargeCard key={p.encounterKey} p={p} date={date} defaultOpen={false} showHospital={showHospital} conversion={data.conversion30?.[p.unit]} />
                    ))}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </>
  )
}

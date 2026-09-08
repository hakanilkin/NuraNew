import { useState, useEffect } from 'react'
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, CartesianGrid, ResponsiveContainer } from 'recharts'
import { get, fmtPct, fmtShort } from '../../components/rtdc/api'

const NEUTRAL = ['#111827', '#3E53E3', '#0e7490', '#7c3aed', '#b45309', '#64748b', '#9333ea']
const OUTCOME = { MET: '#16a34a', MISSED: '#dc2626', UNEXPECTED: '#0e7490', NOT_ON_LIST: '#9ca3af' }

function Tile({ label, value, sub }) {
  return <div className="rtdc-tile"><div className="label">{label}</div><div className="value">{value}</div>{sub && <div className="sub">{sub}</div>}</div>
}

export default function ScoreboardTab({ range, unit, onUnit }) {
  const [data, setData] = useState(null)
  useEffect(() => {
    let alive = true
    get('/scoreboard', { ...range, unit: unit || undefined }).then(r => { if (alive) setData(r.ok ? r.data : null) })
    return () => { alive = false }
  }, [range.from, range.to, range.hospital, unit]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return <div className="rtdc-note">Loading…</div>
  const t = data.tiles
  const series = unit ? [unit] : ['House', ...data.units]
  return (
    <>
      <div className="rtdc-tiles">
        <Tile label={`Accuracy · ${data.mode}`} value={fmtPct(t.accuracyPct)} sub={`${t.met} of ${t.ys} Ys by 2 PM · ${data.days} days`} />
        <Tile label="Days capacity ≥ demand" value={fmtPct(t.daysCapacityOkPct)} sub={`${t.daysCapacityOk} of ${t.daysTotal}`} />
        <Tile label="Unexpected DCs" value={t.unexpected} sub={t.notOnList ? `+ ${t.notOnList} not on the list` : 'Ns that left by 2 PM'} />
        <Tile label="N→Y conversions" value={`${t.converted} / ${t.candidates}`} sub={t.candidates ? fmtPct((t.converted / t.candidates) * 100) : '—'} />
        <Tile label="Median DC time" value={t.medianDcTime || '—'} sub="all departures" />
        <Tile label="Effective-bed loss" value={t.effectiveBedLoss} sub="bed-days entered below available" />
      </div>

      <div className="grid-2" style={{ gap: 12 }}>
        <div className="card" style={{ padding: 14 }}>
          <div className="card-title" style={{ marginBottom: 8 }}>Accuracy by unit over time <span style={{ fontWeight: 400, color: 'var(--color-gray-500)', fontSize: 12 }}>· trailing 7 days</span></div>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={data.accuracyByUnit} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
              <CartesianGrid stroke="#eee" vertical={false} />
              <XAxis dataKey="date" tickFormatter={fmtShort} fontSize={11} />
              <YAxis domain={[0, 100]} fontSize={11} tickFormatter={v => `${v}%`} />
              <Tooltip formatter={v => (v == null ? '—' : `${v}%`)} />
              <Legend onClick={e => onUnit(e.value === 'House' ? '' : e.value)} wrapperStyle={{ fontSize: 11, cursor: 'pointer' }} />
              {series.map((s, i) => (
                <Line key={s} type="monotone" dataKey={s} stroke={s === 'House' ? '#111827' : NEUTRAL[(i % (NEUTRAL.length - 1)) + 1]}
                      strokeWidth={s === 'House' ? 3 : 1.5} dot={false} connectNulls />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="card" style={{ padding: 14 }}>
          <div className="card-title" style={{ marginBottom: 8 }}>Outcomes by week</div>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={data.weekly} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
              <CartesianGrid stroke="#eee" vertical={false} />
              <XAxis dataKey="week" tickFormatter={fmtShort} fontSize={11} />
              <YAxis fontSize={11} />
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {['MET', 'MISSED', 'UNEXPECTED', 'NOT_ON_LIST'].map(k => <Bar key={k} dataKey={k} stackId="a" fill={OUTCOME[k]} />)}
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="card" style={{ padding: 14 }}>
          <div className="card-title" style={{ marginBottom: 8 }}>Night / AM fidelity by unit</div>
          {!t.fidelityAvailable
            ? <div className="rtdc-note">Not available for this tenant (no EDD edit history).</div>
            : <table className="rtdc-table">
                <thead><tr><th>Unit</th><th className="num">Set overnight</th><th className="num">Reviewed before huddle</th><th className="num">Ys with narrative</th></tr></thead>
                <tbody>{data.fidelityByUnit.map(f => (
                  <tr key={f.unit}><td>{f.unit}</td><td className="num">{fmtPct(f.nightPct)}</td><td className="num">{fmtPct(f.amPct)}</td><td className="num">{fmtPct(f.narrativePct)}</td></tr>
                ))}</tbody>
              </table>}
        </div>
        <div className="card" style={{ padding: 14 }}>
          <div className="card-title" style={{ marginBottom: 8 }}>Epic fidelity · effective-bed loss</div>
          <table className="rtdc-table">
            <tbody>
              <tr><td>EDD present and dated today for Y patients</td><td className="num">{fmtPct(data.epic?.eddTodayPct)}</td></tr>
              <tr><td>Discharge event entered ≤ 15 min after departure</td><td className="num">{fmtPct(data.epic?.entryLagPct)}</td></tr>
              {data.effectiveBedLossByReason.length === 0
                ? <tr><td colSpan={2} style={{ color: 'var(--color-gray-500)' }}>No effective-bed reductions entered in this range.</td></tr>
                : data.effectiveBedLossByReason.map(r => <tr key={r.reason}><td>Effective-bed loss · {r.reason}</td><td className="num">{r.beds} bed-days</td></tr>)}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}

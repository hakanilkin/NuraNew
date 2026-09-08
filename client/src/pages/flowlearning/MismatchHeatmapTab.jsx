import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { get, fmtDow, fmtShort, fmtSigned } from '../../components/rtdc/api'

/* Diverging scale centred at 0: red short → grey even → green surplus. */
function cellStyle(v, max) {
  if (v == null) return {}
  const t = Math.min(1, Math.abs(v) / Math.max(1, max))
  const a = 0.12 + 0.68 * t
  if (v < 0) return { background: `rgba(220,38,38,${a})`, color: t > 0.55 ? '#fff' : '#7f1d1d' }
  if (v > 0) return { background: `rgba(22,163,74,${a})`, color: t > 0.55 ? '#fff' : '#14532d' }
  return { background: '#e5e7eb', color: '#374151' }
}

const DOWS = [1, 2, 3, 4, 5, 6, 0]

export default function MismatchHeatmapTab({ range, unit, onUnit }) {
  const [data, setData] = useState(null)
  const [view, setView] = useState('day')
  const [overlay, setOverlay] = useState(true)
  const navigate = useNavigate()

  useEffect(() => {
    let alive = true
    get('/mismatch', range).then(r => { if (alive) setData(r.ok ? r.data : null) })
    return () => { alive = false }
  }, [range.from, range.to, range.hospital]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return <div className="rtdc-note">Loading…</div>
  const rows = data.rows
  const all = rows.flatMap(r => r.days.map(d => d.status)).filter(v => v != null)
  const max = Math.max(4, ...all.map(Math.abs))
  const wdMax = Math.max(3, ...rows.flatMap(r => r.weekday.map(w => Math.abs(w.mean ?? 0))))

  return (
    <div className="card" style={{ padding: 14 }}>
      <div className="rtdc-chrome" style={{ marginBottom: 10 }}>
        <div className="tabs-pill" style={{ margin: 0, width: 'auto' }}>
          <button type="button" className={`tab-pill${view === 'day' ? ' active' : ''}`} style={{ border: 'none', background: view === 'day' ? '#fff' : 'transparent' }} onClick={() => setView('day')}>Day</button>
          <button type="button" className={`tab-pill${view === 'weekday' ? ' active' : ''}`} style={{ border: 'none', background: view === 'weekday' ? '#fff' : 'transparent' }} onClick={() => setView('weekday')}>Weekday</button>
        </div>
        <label className="rtdc-stamp" style={{ cursor: 'pointer' }}>
          <input type="checkbox" checked={overlay} onChange={e => setOverlay(e.target.checked)} /> mark days where effective ≠ available
        </label>
        <span className="rtdc-stamp">cell = capacity − demand at 08:20 · click a cell to replay that day's board · click a unit to filter every tab</span>
      </div>
      <div className="table-wrap">
        <table className="rtdc-heat">
          <thead>
            <tr>
              <th />
              {view === 'day'
                ? data.dates.map(d => <th key={d} title={d}>{fmtDow(d)[0]}<br />{fmtShort(d)}</th>)
                : DOWS.map(w => <th key={w}>{['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][w]}</th>)}
              <th>% red</th><th>gap on red</th><th>streak</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.unit}>
                <th className={`unit${unit === r.unit ? ' active' : ''}`} onClick={() => onUnit(r.unit)}>{r.unit}</th>
                {view === 'day'
                  ? r.days.map(d => d.status == null
                    ? <td key={d.date} className="empty">·</td>
                    : <td key={d.date} className="cell" style={cellStyle(d.status, max)} title={`${r.unit} ${d.date}: ${fmtSigned(d.status)}${d.adjusted ? ' (effective beds adjusted)' : ''}`}
                          onClick={() => navigate(`/ip/bed-meeting/board?date=${d.date}&unit=${encodeURIComponent(r.unit)}`)}>
                        {fmtSigned(d.status)}{overlay && d.adjusted && <span className="adj" />}
                      </td>)
                  : r.weekday.map(w => w.mean == null
                    ? <td key={w.dow} className="empty">·</td>
                    : <td key={w.dow} style={cellStyle(w.mean, wdMax)} title={`mean of ${w.n} days`}>{w.mean > 0 ? `+${w.mean}` : w.mean}</td>)}
                <td className="margin">{r.pctRed == null ? '—' : `${r.pctRed}%`}</td>
                <td className="margin">{r.meanGapRed == null ? '—' : r.meanGapRed}</td>
                <td className="margin">{r.streak ? `${r.streak} d` : '—'}</td>
              </tr>
            ))}
            <tr className="total">
              <th className="unit" style={{ cursor: 'default' }}>Hospital</th>
              {view === 'day'
                ? data.total.days.map(d => d.status == null
                  ? <td key={d.date} className="empty">·</td>
                  : <td key={d.date} style={cellStyle(d.status, max * rows.length / 2)}>{fmtSigned(d.status)}</td>)
                : data.total.weekday.map(w => w.mean == null
                  ? <td key={w.dow} className="empty">·</td>
                  : <td key={w.dow} style={cellStyle(w.mean, wdMax * rows.length / 2)}>{w.mean > 0 ? `+${w.mean}` : w.mean}</td>)}
              <td className="margin" colSpan={3} />
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

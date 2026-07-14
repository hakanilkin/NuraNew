import { useState, useEffect, useMemo } from 'react'
import { BedDouble } from 'lucide-react'

/* ── Level-of-care multi-select ──────────────────────────────────────── */

function LocSelect({ options, selected, onChange }) {
  const [open, setOpen] = useState(false)
  const allSel = options.length > 0 && selected.length === options.length

  function toggle(val) {
    onChange(selected.includes(val) ? selected.filter(v => v !== val) : [...selected, val])
  }
  function toggleAll() {
    onChange(allSel ? [] : [...options])
  }

  const label = allSel ? 'All Levels of Care'
    : selected.length === 0 ? 'None selected'
    : selected.length === 1 ? selected[0]
    : `${selected.length} selected`

  return (
    <div
      style={{ position: 'relative' }}
      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false) }}
      tabIndex={-1}
    >
      <button
        type="button"
        className="form-input"
        onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, cursor: 'pointer', minWidth: 220, textAlign: 'left', background: '#fff' }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 'var(--font-size-sm)' }}>{label}</span>
        <span style={{ fontSize: 10, opacity: 0.5, flexShrink: 0 }}>▼</span>
      </button>
      {open && (
        <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 9999, background: '#fff', border: '1px solid var(--surface-border)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-md)', minWidth: 240, maxHeight: 320, overflowY: 'auto', padding: '6px 0' }}>
          <div
            onClick={toggleAll}
            style={{ padding: '7px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-sm)', fontWeight: 600, borderBottom: '1px solid var(--color-gray-100)' }}
          >
            <input type="checkbox" readOnly checked={allSel} style={{ accentColor: 'var(--color-blue)' }} />
            All Levels of Care
          </div>
          {options.map(opt => (
            <div
              key={opt}
              onClick={() => toggle(opt)}
              style={{ padding: '7px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-sm)' }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--color-gray-50)'}
              onMouseLeave={e => e.currentTarget.style.background = ''}
            >
              <input type="checkbox" readOnly checked={selected.includes(opt)} style={{ accentColor: 'var(--color-blue)' }} />
              {opt}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* ── Colors ───────────────────────────────────────────────────────────────
   Actual   = values already observed (orders, dispositions, scheduled OR)
   Forecast = model-projected values                                        */
const ACTUAL   = '#111827'   // near-black — observed / scheduled values
const FORECAST = '#7c3aed'   // purple, italic — model projections
const NEGATIVE = '#b91c1c'   // red — transfers out of unit

const ED_BG   = '#eef0fd'
const ED_BG2  = '#f4f5fd'
const ED_BDR  = '#c5caf5'
const OR_BG   = '#fef6ee'
const OR_BG2  = '#fefaf5'
const OR_BDR  = '#f5d5b5'
const TR_BG   = '#f0fdfa'
const TR_BG2  = '#f7fefc'
const TR_BDR  = '#99f6e4'
const PJ_BG   = '#f1f5f9'
const PJ_BG2  = '#f8fafc'
const PJ_BDR  = '#cbd5e1'

/* ── Formatters ──────────────────────────────────────────────────────── */

function fmtA(n) {                       // actual — whole number
  if (n == null) return '—'
  return Math.round(Number(n)).toLocaleString()
}
function fmtF(n) {                       // forecast — one decimal
  if (n == null) return '—'
  return Number(n).toFixed(1)
}

// ED 6a–12p forecast remainder: total morning forecast minus what has already
// materialized (orders available + dispo set), floored at zero.
function edMorningRemainder(r) {
  return Math.max(0,
    (r.EDFcst0006 || 0) + (r.EDFcst0612 || 0)
    - ((r.EDOrderAvailable || 0) + (r.EDDispoSet || 0)))
}

// Projected unit status at 12pm: census + morning ED admissions (actual +
// forecast remainder) + morning OR admissions + half the net daily transfers.
function status12pm(r, remainder) {
  const netTransfers = (r.TransferCenter || 0) + (r.OtherTransferIn || 0)
                     + (r.TransferIn || 0) - (r.TransferOut || 0)
  return (r.Census || 0)
    + (r.EDOrderAvailable || 0) + (r.EDDispoSet || 0) + remainder
    + (r.ORFcst0006 || 0) + (r.ORFcst0612 || 0)
    + 0.5 * netTransfers
}

// Projected unit status at end of day: census + all expected ED and OR
// admissions + full net transfers.
function endOfDay(r, remainder) {
  const netTransfers = (r.TransferCenter || 0) + (r.OtherTransferIn || 0)
                     + (r.TransferIn || 0) - (r.TransferOut || 0)
  return (r.Census || 0)
    + (r.EDOrderAvailable || 0) + (r.EDDispoSet || 0) + remainder
    + (r.EDFcst1218 || 0) + (r.EDFcst1823 || 0)
    + (r.ORFcst0006 || 0) + (r.ORFcst0612 || 0)
    + (r.ORFcst1218 || 0) + (r.ORFcst1823 || 0)
    + netTransfers
}

/* ── Cell content: actual value + optional forecast add-on ───────────── */

function ActualPlusForecast({ actual, forecast }) {
  return (
    <span style={{ whiteSpace: 'nowrap' }}>
      <span style={{ color: ACTUAL, fontWeight: 600 }}>{fmtA(actual)}</span>
      {forecast > 0.05 && (
        <span style={{ color: FORECAST, fontWeight: 600, fontStyle: 'italic' }}> +{fmtF(forecast)}</span>
      )}
    </span>
  )
}

/* ── Main page ───────────────────────────────────────────────────────── */

export default function IPForecast() {
  const [rows,    setRows]    = useState([])
  const [selLocs, setSelLocs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)

  useEffect(() => {
    fetch('/api/ip/forecast/units')
      .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(new Error(e.error || `Status ${r.status}`))))
      .then(d => {
        const data = Array.isArray(d) ? d : []
        setRows(data)
        // Default: every level of care except CDU
        const locs = [...new Set(data.map(r => r.LevelOfCare))]
        setSelLocs(locs.filter(l => l !== 'CDU'))
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  const allLocs = useMemo(() => [...new Set(rows.map(r => r.LevelOfCare))], [rows])

  /* ── Filter to selected levels of care, then group ── */
  const visibleRows = rows.filter(r => selLocs.includes(r.LevelOfCare))
  const byLoc = {}
  for (const r of visibleRows) {
    if (!byLoc[r.LevelOfCare]) byLoc[r.LevelOfCare] = []
    byLoc[r.LevelOfCare].push(r)
  }

  // Sum a set of rows into the same shape as a data row
  function sumRows(list) {
    const keys = ['Census', 'StaffedBeds', 'EDOrderAvailable', 'EDDispoSet',
      'EDFcst0006', 'EDFcst0612', 'EDFcst1218', 'EDFcst1823',
      'ORFcst0006', 'ORFcst0612', 'ORFcst1218', 'ORFcst1823',
      'TransferCenter', 'OtherTransferIn', 'TransferOut', 'TransferIn']
    const out = Object.fromEntries(keys.map(k => [k, list.reduce((s, r) => s + (r[k] || 0), 0)]))
    // Remainder must be summed per unit (each row floors at zero independently)
    out._remainder = list.reduce((s, r) => s + edMorningRemainder(r), 0)
    return out
  }
  const grand = sumRows(visibleRows)

  /* ── Table styles ── */
  const TH = (extra = {}) => ({
    padding: '5px 9px', fontSize: 10, fontWeight: 600,
    color: 'var(--color-gray-600)', textAlign: 'right',
    whiteSpace: 'nowrap', borderBottom: '2px solid var(--surface-border)',
    background: '#f8f9fb',
    ...extra,
  })
  const TD = (extra = {}) => ({
    padding: '3px 9px', fontSize: 12, textAlign: 'right',
    borderBottom: '1px solid #f0f1f3', verticalAlign: 'middle',
    ...extra,
  })

  /* ── One set of value cells (used by unit rows, subtotals, grand total) ── */
  function valueCells(r, { bold = false, bg = null, borderBottom } = {}) {
    const remainder = r._remainder != null ? r._remainder : edMorningRemainder(r)
    const w = bold ? 700 : 400
    const cell = (content, sectionBg, extra = {}) => (
      <td style={{ ...TD(), fontWeight: w, background: bg ?? sectionBg, ...(borderBottom ? { borderBottom } : {}), ...extra }}>{content}</td>
    )
    const edBg = bg ?? (bold ? ED_BG : ED_BG2)
    const orBg = bg ?? (bold ? OR_BG : OR_BG2)
    const trBg = bg ?? (bold ? TR_BG : TR_BG2)
    const pjBg = bg ?? (bold ? PJ_BG : PJ_BG2)
    const status = status12pm(r, remainder)
    const gap    = (r.StaffedBeds || 0) - status
    // OR forecasts: blank when there is no scheduled volume
    const orVal = v => (v || 0) > 0.05
      ? <span style={{ color: ACTUAL, fontWeight: 600 }}>{fmtF(v)}</span>
      : ''
    return [
      /* Census / staffed beds */
      cell(<span>{fmtA(r.Census)}</span>, bg ?? 'transparent'),
      cell(<span>{fmtA(r.StaffedBeds)}</span>, bg ?? 'transparent', { borderRight: '1px solid var(--surface-border)' }),
      /* Projections — 12pm pair, then end-of-day pair */
      cell(<span style={{ fontWeight: 600 }}>{fmtF(status)}</span>, pjBg),
      cell(<span style={{ color: gap < 0 ? '#b91c1c' : '#15803d', fontWeight: 600 }}>{fmtF(gap)}</span>, pjBg, { borderRight: '1px solid ' + PJ_BDR }),
      (() => {
        const eod    = endOfDay(r, remainder)
        const eodGap = (r.StaffedBeds || 0) - eod
        return [
          cell(<span style={{ fontWeight: 600 }}>{fmtF(eod)}</span>, pjBg),
          cell(<span style={{ color: eodGap < 0 ? '#b91c1c' : '#15803d', fontWeight: 600 }}>{fmtF(eodGap)}</span>, pjBg, { borderRight: '1px solid ' + PJ_BDR }),
        ]
      })(),
      /* ED admissions */
      cell(<span style={{ color: ACTUAL, fontWeight: 600 }}>{fmtA(r.EDOrderAvailable)}</span>, edBg),
      cell(<ActualPlusForecast actual={r.EDDispoSet} forecast={remainder} />, edBg),
      cell(<span style={{ color: FORECAST, fontWeight: 600, fontStyle: 'italic' }}>{fmtF(r.EDFcst1218)}</span>, edBg),
      cell(<span style={{ color: FORECAST, fontWeight: 600, fontStyle: 'italic' }}>{fmtF(r.EDFcst1823)}</span>, edBg, { borderRight: '1px solid ' + ED_BDR }),
      /* OR admissions — scheduled, treated as actual; blank when zero */
      cell(orVal(r.ORFcst0006), orBg),
      cell(orVal(r.ORFcst0612), orBg),
      cell(orVal(r.ORFcst1218), orBg),
      cell(orVal(r.ORFcst1823), orBg, { borderRight: '1px solid ' + OR_BDR }),
      /* Transfers */
      cell(<span style={{ color: FORECAST, fontWeight: 600, fontStyle: 'italic' }}>{fmtF(r.TransferCenter)}</span>, trBg),
      cell(<span style={{ color: FORECAST, fontWeight: 600, fontStyle: 'italic' }}>{fmtF(r.OtherTransferIn)}</span>, trBg),
      cell(<span style={{ color: NEGATIVE, fontWeight: 600 }}>{fmtF((r.TransferOut || 0) * -1)}</span>, trBg),
      cell(<span style={{ color: FORECAST, fontWeight: 600, fontStyle: 'italic' }}>{fmtF(r.TransferIn)}</span>, trBg),
    ]
  }

  const legendChip = (color, label) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--color-gray-600)' }}>
      <span style={{ width: 11, height: 11, borderRadius: 3, background: color }} />
      {label}
    </span>
  )

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Inpatient Forecast</h1>
        <p className="page-subtitle">Expected admissions and transfers by level of care and unit</p>
      </div>

      {/* Filter + legend */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label className="form-label" style={{ whiteSpace: 'nowrap', margin: 0 }}>Level of Care</label>
          <LocSelect options={allLocs} selected={selLocs} onChange={setSelLocs} />
        </div>
        <div style={{ display: 'flex', gap: 18, marginLeft: 'auto' }}>
          {legendChip(ACTUAL,   'Actual (observed / scheduled)')}
          {legendChip(FORECAST, <em>Forecast (projected)</em>)}
          {legendChip(NEGATIVE, 'Transfers out of unit (negative)')}
        </div>
      </div>

      <div className="card">
        <div className="card-body" style={{ padding: 0 }}>

          {loading && (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-gray-400)', fontSize: 13 }}>Loading…</div>
          )}

          {error && !loading && (
            <div style={{ padding: 40, textAlign: 'center', color: '#b91c1c', fontSize: 13 }}>{error}</div>
          )}

          {!loading && !error && visibleRows.length === 0 && (
            <div style={{ padding: 56, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--color-gray-400)' }}>
              <BedDouble size={36} strokeWidth={1.25} style={{ marginBottom: 12 }} />
              <p style={{ fontSize: 13, color: 'var(--color-gray-500)' }}>
                {rows.length === 0 ? 'No forecast data available' : 'No levels of care selected'}
              </p>
            </div>
          )}

          {!loading && !error && visibleRows.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th rowSpan={2} style={{ ...TH(), textAlign: 'left', minWidth: 190, borderRight: '1px solid var(--surface-border)' }}>Level of Care / Unit</th>
                    <th rowSpan={2} style={TH()}>Census</th>
                    <th rowSpan={2} style={{ ...TH(), borderRight: '1px solid var(--surface-border)' }}>Staffed Beds</th>
                    <th colSpan={2} style={{ ...TH(), textAlign: 'center', background: PJ_BG, color: '#334155', borderBottom: '1px solid ' + PJ_BDR, borderRight: '1px solid ' + PJ_BDR }}>12pm Projection</th>
                    <th colSpan={2} style={{ ...TH(), textAlign: 'center', background: PJ_BG, color: '#334155', borderBottom: '1px solid ' + PJ_BDR }}>End of Day Projection</th>
                    <th colSpan={4} style={{ ...TH(), textAlign: 'center', background: ED_BG, color: '#3730a3', borderBottom: '1px solid ' + ED_BDR }}>Expected ED Admissions</th>
                    <th colSpan={4} style={{ ...TH(), textAlign: 'center', background: OR_BG, color: '#9a3412', borderBottom: '1px solid ' + OR_BDR }}>Expected OR Admissions</th>
                    <th colSpan={4} style={{ ...TH(), textAlign: 'center', background: TR_BG, color: '#0f766e', borderBottom: '1px solid ' + TR_BDR }}>Transfers</th>
                  </tr>
                  <tr>
                    <th style={{ ...TH(), background: PJ_BG }}>Status as of 12pm</th>
                    <th style={{ ...TH(), background: PJ_BG, borderRight: '1px solid ' + PJ_BDR }}>Staffed vs 12pm Fcst</th>
                    <th style={{ ...TH(), background: PJ_BG }}>End of Day</th>
                    <th style={{ ...TH(), background: PJ_BG, borderRight: '1px solid ' + PJ_BDR }}>Staffed vs EOD Fcst</th>
                    <th style={{ ...TH(), background: ED_BG }}>Mid–6a</th>
                    <th style={{ ...TH(), background: ED_BG }}>6a–12p</th>
                    <th style={{ ...TH(), background: ED_BG }}>12p–6p</th>
                    <th style={{ ...TH(), background: ED_BG, borderRight: '1px solid ' + ED_BDR }}>6p–11p</th>
                    <th style={{ ...TH(), background: OR_BG }}>Mid–6a</th>
                    <th style={{ ...TH(), background: OR_BG }}>6a–12p</th>
                    <th style={{ ...TH(), background: OR_BG }}>12p–6p</th>
                    <th style={{ ...TH(), background: OR_BG, borderRight: '1px solid ' + OR_BDR }}>6p–11p</th>
                    <th style={{ ...TH(), background: TR_BG }}>Transfer Center</th>
                    <th style={{ ...TH(), background: TR_BG }}>Other In</th>
                    <th style={{ ...TH(), background: TR_BG }}>Out of Unit</th>
                    <th style={{ ...TH(), background: TR_BG }}>Into Unit</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(byLoc).map(([loc, locRows]) => {
                    const sub = sumRows(locRows)
                    return [
                      /* Level-of-care subtotal row */
                      <tr key={`${loc}__hdr`} style={{ background: '#eef2fb' }}>
                        <td style={{ ...TD(), textAlign: 'left', fontWeight: 700, fontSize: 13, color: 'var(--color-gray-900)', borderRight: '1px solid var(--surface-border)', borderBottom: '1px solid #d8dff0', paddingTop: 6, paddingBottom: 6 }}>
                          {loc}
                        </td>
                        {valueCells(sub, { bold: true, bg: '#e6ebf7', borderBottom: '1px solid #d8dff0' })}
                      </tr>,

                      /* Unit rows */
                      ...locRows.map(r => (
                        <tr
                          key={`${loc}__${r.Unit}`}
                          onMouseEnter={e => e.currentTarget.style.background = '#fafbfe'}
                          onMouseLeave={e => e.currentTarget.style.background = ''}
                        >
                          <td style={{ ...TD(), textAlign: 'left', paddingLeft: 24, borderRight: '1px solid var(--surface-border)', color: 'var(--color-gray-700)' }}>{r.Unit}</td>
                          {valueCells(r)}
                        </tr>
                      )),
                    ]
                  })}

                  {/* Grand total */}
                  <tr style={{ background: '#166534' }}>
                    <td style={{ ...TD(), textAlign: 'left', fontWeight: 700, fontSize: 13, color: '#fff', borderRight: '1px solid rgba(255,255,255,0.2)', borderBottom: 'none', paddingTop: 7, paddingBottom: 7 }}>
                      Grand Total
                    </td>
                    <td style={{ ...TD(), fontWeight: 700, color: '#fff', borderBottom: 'none' }}>{fmtA(grand.Census)}</td>
                    <td style={{ ...TD(), fontWeight: 700, color: '#fff', borderBottom: 'none', borderRight: '1px solid rgba(255,255,255,0.2)' }}>{fmtA(grand.StaffedBeds)}</td>
                    {(() => {
                      const status = status12pm(grand, grand._remainder)
                      const gap    = (grand.StaffedBeds || 0) - status
                      const eod    = endOfDay(grand, grand._remainder)
                      const eodGap = (grand.StaffedBeds || 0) - eod
                      return (
                        <>
                          <td style={{ ...TD(), fontWeight: 700, color: '#fff', borderBottom: 'none' }}>{fmtF(status)}</td>
                          <td style={{ ...TD(), fontWeight: 700, color: gap < 0 ? '#fca5a5' : '#86efac', borderBottom: 'none', borderRight: '1px solid rgba(255,255,255,0.2)' }}>{fmtF(gap)}</td>
                          <td style={{ ...TD(), fontWeight: 700, color: '#fff', borderBottom: 'none' }}>{fmtF(eod)}</td>
                          <td style={{ ...TD(), fontWeight: 700, color: eodGap < 0 ? '#fca5a5' : '#86efac', borderBottom: 'none', borderRight: '1px solid rgba(255,255,255,0.2)' }}>{fmtF(eodGap)}</td>
                        </>
                      )
                    })()}
                    <td style={{ ...TD(), fontWeight: 700, color: '#fff', borderBottom: 'none' }}>{fmtA(grand.EDOrderAvailable)}</td>
                    <td style={{ ...TD(), fontWeight: 700, color: '#fff', borderBottom: 'none', whiteSpace: 'nowrap' }}>
                      {fmtA(grand.EDDispoSet)}{grand._remainder > 0.05 ? ` +${fmtF(grand._remainder)}` : ''}
                    </td>
                    <td style={{ ...TD(), fontWeight: 700, color: '#fff', borderBottom: 'none' }}>{fmtF(grand.EDFcst1218)}</td>
                    <td style={{ ...TD(), fontWeight: 700, color: '#fff', borderBottom: 'none', borderRight: '1px solid rgba(255,255,255,0.2)' }}>{fmtF(grand.EDFcst1823)}</td>
                    <td style={{ ...TD(), fontWeight: 700, color: '#fff', borderBottom: 'none' }}>{(grand.ORFcst0006 || 0) > 0.05 ? fmtF(grand.ORFcst0006) : ''}</td>
                    <td style={{ ...TD(), fontWeight: 700, color: '#fff', borderBottom: 'none' }}>{(grand.ORFcst0612 || 0) > 0.05 ? fmtF(grand.ORFcst0612) : ''}</td>
                    <td style={{ ...TD(), fontWeight: 700, color: '#fff', borderBottom: 'none' }}>{(grand.ORFcst1218 || 0) > 0.05 ? fmtF(grand.ORFcst1218) : ''}</td>
                    <td style={{ ...TD(), fontWeight: 700, color: '#fff', borderBottom: 'none', borderRight: '1px solid rgba(255,255,255,0.2)' }}>{(grand.ORFcst1823 || 0) > 0.05 ? fmtF(grand.ORFcst1823) : ''}</td>
                    <td style={{ ...TD(), fontWeight: 700, color: '#fff', borderBottom: 'none' }}>{fmtF(grand.TransferCenter)}</td>
                    <td style={{ ...TD(), fontWeight: 700, color: '#fff', borderBottom: 'none' }}>{fmtF(grand.OtherTransferIn)}</td>
                    <td style={{ ...TD(), fontWeight: 700, color: '#fca5a5', borderBottom: 'none' }}>{fmtF((grand.TransferOut || 0) * -1)}</td>
                    <td style={{ ...TD(), fontWeight: 700, color: '#fff', borderBottom: 'none' }}>{fmtF(grand.TransferIn)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

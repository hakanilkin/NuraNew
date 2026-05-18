import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { ChevronDown, Check, AlertCircle, LayoutGrid } from 'lucide-react'

/* ─── Constants ──────────────────────────────────────────────────────────── */

const DEFAULT_START = '2025-01-01'
const DEFAULT_END   = '2025-12-31'
const MONTHS_SHORT  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

const WEEKS    = [1, 2, 3, 4, 5]
const DAY_COLS = [
  { dow: 2, label: 'Mon' },
  { dow: 3, label: 'Tue' },
  { dow: 4, label: 'Wed' },
  { dow: 5, label: 'Thu' },
  { dow: 6, label: 'Fri' },
]
const TOTAL_COLS = 8 // Block/Service | Week | Mon | Tue | Wed | Thu | Fri | Total

/* ─── Colour helpers ─────────────────────────────────────────────────────── */

function ptColors(pct) {
  if (pct == null) return null
  if (pct >= 70) return { bg: '#dcfce7', text: '#15803d' }
  if (pct >= 35) return { bg: '#fef9c3', text: '#92400e' }
  return { bg: '#fee2e2', text: '#b91c1c' }
}

/* ─── Data helpers ───────────────────────────────────────────────────────── */

function buildQS({ startDate, endDate, location, caseblocks }) {
  const p = new URLSearchParams({ startDate, endDate })
  if (location)           p.set('locations',  location)
  if (caseblocks?.length) p.set('caseblocks', caseblocks.join(','))
  return p.toString()
}

// { [CaseBlock]: { [Service]: { "wk_dow": cellData } } }
function groupData(rows) {
  const g = {}
  rows.forEach(({ CaseBlock, Service, WeekOfMonth: wk, DayOfWeek: dow,
                  CaseCount, SumPrimeTime, SumBlockTime }) => {
    g[CaseBlock] ??= {}
    g[CaseBlock][Service] ??= {}
    g[CaseBlock][Service][`${wk}_${dow}`] = {
      CaseCount, SumPrimeTime, SumBlockTime,
      ptPct: SumBlockTime > 0 ? (SumPrimeTime / SumBlockTime) * 100 : null,
    }
  })
  return g
}

// { "CaseBlock|Service|wk|dow": [ monthRow, … ] }
function indexMonthly(detail) {
  const idx = {}
  detail.forEach(row => {
    const key = `${row.CaseBlock}|${row.Service}|${row.WeekOfMonth}|${row.DayOfWeek}`;
    (idx[key] ??= []).push(row)
  })
  Object.values(idx).forEach(arr => arr.sort((a, b) => a.Month - b.Month))
  return idx
}

// Aggregate an array of cells (nulls ignored) → single cell or null if no data
function aggCells(cellList) {
  const acc = { CaseCount: 0, SumPrimeTime: 0, SumBlockTime: 0 }
  let hasAny = false
  cellList.forEach(c => {
    if (!c) return
    acc.CaseCount    += c.CaseCount
    acc.SumPrimeTime += c.SumPrimeTime
    acc.SumBlockTime += c.SumBlockTime
    hasAny = true
  })
  if (!hasAny) return null
  return { ...acc, ptPct: acc.SumBlockTime > 0 ? (acc.SumPrimeTime / acc.SumBlockTime) * 100 : null }
}

/* ─── Skeleton ───────────────────────────────────────────────────────────── */

function Skeleton({ height = 20, width = '100%', style = {} }) {
  return (
    <div style={{
      height, width, borderRadius: 'var(--radius-sm)',
      background: 'linear-gradient(90deg,var(--color-gray-100) 25%,var(--color-gray-200) 50%,var(--color-gray-100) 75%)',
      backgroundSize: '200% 100%', animation: 'shimmer 1.4s infinite', ...style,
    }} />
  )
}

/* ─── Multi-select dropdown ──────────────────────────────────────────────── */

function MultiSelect({ items, selected, onChange, loading, placeholder = 'All' }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    function h(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  const allSel = items.length > 0 && selected.length === items.length
  const label  = !selected.length ? placeholder
               : selected.length === 1 ? selected[0]
               : `${selected.length} selected`

  function toggle(item) {
    onChange(selected.includes(item) ? selected.filter(s => s !== item) : [...selected, item])
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button" disabled={loading}
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 'var(--space-2)', width: '100%', height: 38,
          padding: '0 var(--space-3)', border: '1px solid var(--surface-border)',
          borderRadius: 'var(--radius-md)', background: 'var(--color-white)',
          color: selected.length ? 'var(--color-gray-900)' : 'var(--color-gray-400)',
          fontSize: 'var(--font-size-base)', cursor: loading ? 'not-allowed' : 'pointer',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {loading ? 'Loading…' : label}
        </span>
        <ChevronDown size={14} style={{ color: 'var(--color-gray-400)', flexShrink: 0,
          transition: 'transform var(--transition-base)', transform: open ? 'rotate(180deg)' : 'none' }} />
      </button>

      {open && items.length > 0 && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, minWidth: '100%',
          zIndex: 'var(--z-dropdown)', background: 'var(--color-white)',
          border: '1px solid var(--surface-border)', borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-lg)', overflow: 'hidden', display: 'flex', flexDirection: 'column',
        }}>
          <div style={{ padding: 'var(--space-2)', borderBottom: '1px solid var(--surface-border)' }}>
            <button type="button" onClick={() => onChange(allSel ? [] : [...items])}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                width: '100%', padding: 'var(--space-2) var(--space-3)', border: 'none',
                borderRadius: 'var(--radius-md)', background: 'transparent', cursor: 'pointer',
                fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-semibold)',
                color: 'var(--color-gray-600)',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-gray-100)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
            >
              {allSel ? 'Clear All' : 'Select All'}
              {allSel && <Check size={13} style={{ color: 'var(--color-blue)' }} />}
            </button>
          </div>
          <div style={{ overflowY: 'auto', maxHeight: 220, padding: 'var(--space-1)' }}>
            {items.map(item => {
              const checked = selected.includes(item)
              return (
                <button key={item} type="button" onClick={() => toggle(item)}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    width: '100%', padding: 'var(--space-2) var(--space-3)', border: 'none',
                    borderRadius: 'var(--radius-md)',
                    background: checked ? 'var(--color-blue-muted)' : 'transparent',
                    cursor: 'pointer', fontSize: 'var(--font-size-sm)', textAlign: 'left',
                    fontWeight: checked ? 'var(--font-weight-medium)' : 'var(--font-weight-regular)',
                    color: checked ? 'var(--color-blue)' : 'var(--color-gray-700)',
                    gap: 'var(--space-2)',
                  }}
                  onMouseEnter={e => { if (!checked) e.currentTarget.style.background = 'var(--color-gray-100)' }}
                  onMouseLeave={e => { if (!checked) e.currentTarget.style.background = checked ? 'var(--color-blue-muted)' : 'transparent' }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item}</span>
                  {checked && <Check size={13} style={{ flexShrink: 0 }} />}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

/* ─── Hover tooltip (fixed-position monthly breakdown) ───────────────────── */

function CellTooltip({ tip }) {
  if (!tip) return null
  return (
    <div style={{
      position: 'fixed', top: tip.y, left: tip.x, zIndex: 500,
      background: 'var(--color-white)', border: '1px solid var(--surface-border)',
      borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-xl)',
      padding: 'var(--space-4)', minWidth: 220, pointerEvents: 'none',
    }}>
      <p style={{ fontSize: 'var(--font-size-xs)', fontWeight: 'var(--font-weight-semibold)',
        color: 'var(--color-gray-500)', letterSpacing: 'var(--letter-spacing-wide)',
        textTransform: 'uppercase', marginBottom: 'var(--space-3)' }}>
        Monthly Breakdown
      </p>
      <p style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-semibold)',
        color: 'var(--color-gray-900)', marginBottom: 'var(--space-3)', lineHeight: 1.3 }}>
        {tip.label}
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '2.5rem 1fr 1fr',
        columnGap: 8, rowGap: 4, fontSize: 'var(--font-size-xs)' }}>
        {['Mo.','Cases','PT%'].map(h => (
          <span key={h} style={{ color: 'var(--color-gray-400)',
            fontWeight: 'var(--font-weight-semibold)',
            textAlign: h !== 'Mo.' ? 'right' : 'left',
            borderBottom: '1px solid var(--surface-border)', paddingBottom: 4, marginBottom: 2 }}>
            {h}
          </span>
        ))}
        {tip.rows.map(r => {
          const pt     = r.SumBlockTime > 0 ? (r.SumPrimeTime / r.SumBlockTime) * 100 : null
          const colors = ptColors(pt)
          return [
            <span key={`m${r.Month}`} style={{ color: 'var(--color-gray-700)' }}>
              {MONTHS_SHORT[r.Month - 1]}
            </span>,
            <span key={`c${r.Month}`} style={{ textAlign: 'right',
              color: 'var(--color-gray-900)', fontWeight: 'var(--font-weight-medium)' }}>
              {r.CaseCount}
            </span>,
            <span key={`p${r.Month}`} style={{ textAlign: 'right',
              fontWeight: 'var(--font-weight-bold)',
              color: colors?.text ?? 'var(--color-gray-400)' }}>
              {pt != null ? `${pt.toFixed(0)}%` : '—'}
            </span>,
          ]
        })}
      </div>
    </div>
  )
}

/* ─── Table cell ─────────────────────────────────────────────────────────── */

function DataCell({ cell, isTotalRow, thick, isTotal, onEnter, onLeave }) {
  const base = {
    padding: '5px 3px', textAlign: 'center', verticalAlign: 'middle',
    minWidth: 68, width: 68,
    borderBottom: thick ? '2px solid var(--color-gray-300)' : '1px solid var(--color-gray-200)',
    borderRight: '1px solid var(--color-gray-200)',
    borderLeft: isTotal ? '2px solid var(--color-gray-300)' : undefined,
    transition: 'filter 80ms',
  }

  if (!cell) {
    return (
      <td style={{ ...base, background: isTotal ? 'var(--color-gray-100)' : 'var(--color-gray-50)' }}>
        <span style={{ color: 'var(--color-gray-300)', fontSize: 11 }}>—</span>
      </td>
    )
  }

  const { CaseCount, ptPct } = cell
  const colors = ptColors(ptPct)

  return (
    <td
      style={{
        ...base,
        background: isTotal
          ? (colors?.bg ? colors.bg : 'var(--color-gray-100)')
          : (colors?.bg ?? 'var(--color-white)'),
        cursor: onEnter ? 'help' : 'default',
      }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
        <span style={{ fontSize: 13, fontWeight: isTotalRow ? 700 : 600,
          color: 'var(--color-gray-900)', lineHeight: 1 }}>
          {CaseCount}
        </span>
        {ptPct != null && (
          <span style={{ fontSize: 10, fontWeight: 700,
            color: colors?.text ?? 'var(--color-gray-500)', lineHeight: 1 }}>
            {ptPct.toFixed(0)}%
          </span>
        )}
      </div>
    </td>
  )
}

/* ─── Rows for one CaseBlock ─────────────────────────────────────────────── */

function BlockRows({ caseBlock, serviceMap, monthlyIndex, onCellEnter, onCellLeave }) {
  const serviceNames = Object.keys(serviceMap)

  // Per-DOW block totals (all services × all weeks) + grand total
  const blockDayTotals = useMemo(() => {
    const result = {}
    DAY_COLS.forEach(({ dow }) => {
      result[dow] = aggCells(
        Object.values(serviceMap).flatMap(cells =>
          WEEKS.map(wk => cells[`${wk}_${dow}`])
        )
      )
    })
    result.total = aggCells(
      Object.values(serviceMap).flatMap(cells =>
        WEEKS.flatMap(wk => DAY_COLS.map(({ dow }) => cells[`${wk}_${dow}`]))
      )
    )
    return result
  }, [serviceMap])

  const LABEL_STICKY = {
    padding: '5px 10px', fontSize: 'var(--font-size-sm)', whiteSpace: 'nowrap',
    maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis',
    borderRight: '2px solid var(--color-gray-300)',
    position: 'sticky', left: 0, zIndex: 1,
  }

  return (
    <>
      {/* ── Block header row ── */}
      <tr>
        <td colSpan={TOTAL_COLS} style={{
          padding: '7px 12px',
          background: 'var(--color-navy)',
          color: 'var(--color-white)',
          fontSize: 'var(--font-size-sm)',
          fontWeight: 'var(--font-weight-semibold)',
          letterSpacing: 'var(--letter-spacing-tight)',
          borderBottom: '1px solid #2a2d5a',
          position: 'sticky', left: 0,
        }}>
          {caseBlock}
        </td>
      </tr>

      {/* ── Service rows — 5 week sub-rows each ── */}
      {serviceNames.map(service => {
        const cells = serviceMap[service]
        return WEEKS.map((wk, wkIdx) => {
          const isLastWeek = wkIdx === WEEKS.length - 1
          const weekAgg    = aggCells(DAY_COLS.map(({ dow }) => cells[`${wk}_${dow}`]))

          return (
            <tr key={`${service}_${wk}`}>

              {/* Service name — only first week row, spans all 5 */}
              {wkIdx === 0 && (
                <td
                  rowSpan={WEEKS.length}
                  style={{
                    ...LABEL_STICKY,
                    fontWeight: 'var(--font-weight-medium)',
                    color: 'var(--color-gray-700)',
                    background: 'var(--color-white)',
                    verticalAlign: 'top',
                    paddingTop: 9,
                    borderBottom: '2px solid var(--color-gray-300)',
                  }}
                  title={service}
                >
                  {service}
                </td>
              )}

              {/* Week label */}
              <td style={{
                padding: '5px 8px', textAlign: 'center', whiteSpace: 'nowrap',
                fontSize: 11, fontWeight: 600, color: 'var(--color-gray-500)',
                background: 'var(--color-gray-50)',
                borderBottom: isLastWeek ? '2px solid var(--color-gray-300)' : '1px solid var(--color-gray-200)',
                borderRight: '1px solid var(--color-gray-200)',
              }}>
                Wk{wk}
              </td>

              {/* Day cells */}
              {DAY_COLS.map(({ dow, label }) => {
                const cell  = cells[`${wk}_${dow}`]
                const mRows = monthlyIndex[`${caseBlock}|${service}|${wk}|${dow}`]
                return (
                  <DataCell
                    key={dow}
                    cell={cell}
                    thick={isLastWeek}
                    isTotalRow={false}
                    onEnter={mRows?.length
                      ? e => onCellEnter(e, `${caseBlock} / ${service} · Wk${wk} ${label}`, mRows)
                      : null}
                    onLeave={mRows?.length ? onCellLeave : null}
                  />
                )
              })}

              {/* Week total */}
              <DataCell
                cell={weekAgg}
                thick={isLastWeek}
                isTotal
                isTotalRow={false}
                onEnter={null}
                onLeave={null}
              />
            </tr>
          )
        })
      })}

      {/* ── Block Total row ── */}
      <tr>
        <td colSpan={2} style={{
          ...LABEL_STICKY,
          background: 'var(--color-gray-100)',
          fontWeight: 'var(--font-weight-bold)',
          color: 'var(--color-gray-800)',
          fontSize: 11,
          letterSpacing: 'var(--letter-spacing-wide)',
          textTransform: 'uppercase',
          borderTop: '2px solid var(--color-gray-300)',
          borderBottom: '2px solid var(--color-gray-300)',
          borderRight: '1px solid var(--color-gray-200)',
        }}>
          Block Total
        </td>
        {DAY_COLS.map(({ dow }) => (
          <DataCell
            key={dow} cell={blockDayTotals[dow]}
            isTotalRow thick onEnter={null} onLeave={null}
          />
        ))}
        <DataCell
          cell={blockDayTotals.total}
          isTotalRow isTotal thick
          onEnter={null} onLeave={null}
        />
      </tr>
    </>
  )
}

/* ─── Page ───────────────────────────────────────────────────────────────── */

export default function BlockUtilization() {
  const [startDate,      setStartDate]      = useState(DEFAULT_START)
  const [endDate,        setEndDate]        = useState(DEFAULT_END)
  const [locationGroups, setLocationGroups] = useState([])
  const [selectedLoc,    setSelectedLoc]    = useState('')
  const [caseblocks,     setCaseblocks]     = useState([])
  const [selectedBlocks, setSelectedBlocks] = useState([])
  const [locsLoading,    setLocsLoading]    = useState(true)
  const [blocksLoading,  setBlocksLoading]  = useState(true)
  const [rawData,        setRawData]        = useState([])
  const [monthlyDetail,  setMonthlyDetail]  = useState([])
  const [loading,        setLoading]        = useState(true)
  const [error,          setError]          = useState(null)
  const [tip,            setTip]            = useState(null)

  /* Track latest date inputs without re-triggering the caseblocks effect */
  const latestDates = useRef({ startDate: DEFAULT_START, endDate: DEFAULT_END })
  useEffect(() => { latestDates.current = { startDate, endDate } }, [startDate, endDate])

  /* ── Derived ── */
  const grouped      = useMemo(() => groupData(rawData),          [rawData])
  const monthlyIndex = useMemo(() => indexMonthly(monthlyDetail), [monthlyDetail])
  const blockNames   = Object.keys(grouped)

  /* ── Fetch location groups once, default to first ── */
  useEffect(() => {
    fetch('/api/capacity/location-groups')
      .then(r => r.ok ? r.json() : [])
      .then(d => {
        const groups = Array.isArray(d) ? d : []
        setLocationGroups(groups)
        const defaultLoc = groups[0] ?? ''
        setSelectedLoc(defaultLoc)
        fetchData({ startDate: DEFAULT_START, endDate: DEFAULT_END, location: defaultLoc, caseblocks: [] })
      })
      .catch(() => {
        fetchData({ startDate: DEFAULT_START, endDate: DEFAULT_END, location: '', caseblocks: [] })
      })
      .finally(() => setLocsLoading(false))
  }, []) // fetchData is stable (useCallback []) so omitting it is safe; dep array is evaluated before fetchData is declared

  /* ── Fetch case blocks when location changes ── */
  useEffect(() => {
    setSelectedBlocks([])
    setBlocksLoading(true)
    const { startDate: sd, endDate: ed } = latestDates.current
    const p = new URLSearchParams({ startDate: sd, endDate: ed })
    if (selectedLoc) p.set('locations', selectedLoc)
    fetch(`/api/blockutil/caseblocks?${p}`)
      .then(r => r.ok ? r.json() : [])
      .then(d => setCaseblocks(Array.isArray(d) ? d : []))
      .catch(() => setCaseblocks([]))
      .finally(() => setBlocksLoading(false))
  }, [selectedLoc]) // intentionally excludes dates — Apply drives date-based refreshes

  /* ── Fetch table data ── */
  const fetchData = useCallback(async (filters) => {
    setLoading(true)
    setError(null)
    const qs = buildQS(filters)
    try {
      const [dataRes, detailRes] = await Promise.all([
        fetch(`/api/blockutil/data?${qs}`),
        fetch(`/api/blockutil/monthly-detail?${qs}`),
      ])
      if (!dataRes.ok)   throw new Error(`Block data failed (${dataRes.status})`)
      if (!detailRes.ok) throw new Error(`Monthly detail failed (${detailRes.status})`)
      const [data, detail] = await Promise.all([dataRes.json(), detailRes.json()])
      setRawData(Array.isArray(data)   ? data   : [])
      setMonthlyDetail(Array.isArray(detail) ? detail : [])
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  function handleApply() {
    fetchData({ startDate, endDate, location: selectedLoc, caseblocks: selectedBlocks })
  }

  /* ── Cell tooltip handlers ── */
  function handleCellEnter(e, label, rows) {
    const rect = e.currentTarget.getBoundingClientRect()
    const TW   = 230
    const x    = rect.right + 10 + TW > window.innerWidth ? rect.left - TW - 10 : rect.right + 10
    const y    = Math.max(8, Math.min(rect.top, window.innerHeight - 280))
    setTip({ x, y, label, rows })
  }
  const handleCellLeave = useCallback(() => setTip(null), [])

  /* ─── Render ─────────────────────────────────────────────────────────── */

  const TH_COMMON = {
    position: 'sticky', top: 0, zIndex: 3,
    padding: '6px 4px', textAlign: 'center', whiteSpace: 'nowrap',
    fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase',
    color: 'var(--color-gray-600)',
  }

  return (
    <div className="page">
      <style>{`
        @keyframes shimmer {
          0%   { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>

      <div className="page-header">
        <h1 className="page-title">Block Utilization</h1>
        <p className="page-subtitle">Prime time utilization by case block, service, week, and day of week</p>
      </div>

      {/* ── Filter bar ── */}
      <div className="card card-padded mb-5" style={{ overflow: 'visible' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--space-4)', flexWrap: 'wrap' }}>

          <div className="form-group" style={{ flex: '1 1 140px', minWidth: 130 }}>
            <label className="form-label">Start Date</label>
            <input type="date" className="form-input" value={startDate}
              onChange={e => setStartDate(e.target.value)} />
          </div>

          <div className="form-group" style={{ flex: '1 1 140px', minWidth: 130 }}>
            <label className="form-label">End Date</label>
            <input type="date" className="form-input" value={endDate}
              onChange={e => setEndDate(e.target.value)} />
          </div>

          <div className="form-group" style={{ flex: '1 1 170px', minWidth: 155 }}>
            <label className="form-label">Location Group</label>
            <select
              className="form-input"
              value={selectedLoc}
              onChange={e => setSelectedLoc(e.target.value)}
              disabled={locsLoading}
              style={{ cursor: 'pointer', appearance: 'auto' }}
            >
              {locationGroups.length === 0 && <option value="">All Locations</option>}
              {locationGroups.map(lg => <option key={lg} value={lg}>{lg}</option>)}
            </select>
          </div>

          <div className="form-group" style={{ flex: '2 1 210px', minWidth: 190 }}>
            <label className="form-label">Case Blocks</label>
            <MultiSelect
              items={caseblocks}
              selected={selectedBlocks}
              onChange={setSelectedBlocks}
              loading={blocksLoading}
              placeholder="All Case Blocks"
            />
          </div>

          <button
            type="button" className="btn btn-primary"
            onClick={handleApply} disabled={loading}
            style={{ flexShrink: 0, height: 38 }}
          >
            {loading ? 'Loading…' : 'Apply Filters'}
          </button>
        </div>
      </div>

      {/* ── Legend ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 'var(--space-5)', flexWrap: 'wrap',
        marginTop: 'var(--space-4)', marginBottom: 'var(--space-5)',
        padding: 'var(--space-3) var(--space-4)',
        background: 'var(--color-gray-50)',
        border: '1px solid var(--surface-border)',
        borderRadius: 'var(--radius-lg)',
      }}>
        <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600,
          color: 'var(--color-gray-500)', letterSpacing: '0.07em', textTransform: 'uppercase' }}>
          PT% Legend
        </span>
        {[
          { label: '≥ 70% — At target', bg: '#dcfce7', text: '#15803d' },
          { label: '35–69% — Low',      bg: '#fef9c3', text: '#92400e' },
          { label: '< 35% — Critical',  bg: '#fee2e2', text: '#b91c1c' },
        ].map(({ label, bg, text }) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <div style={{ width: 26, height: 16, borderRadius: 3, background: bg,
              border: `1px solid ${text}33`, flexShrink: 0 }} />
            <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-600)',
              fontWeight: 500 }}>
              {label}
            </span>
          </div>
        ))}
        <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)' }}>
          Cell: <strong style={{ color: 'var(--color-gray-600)' }}>cases</strong> / PT% · hover for monthly breakdown
        </span>
      </div>

      {/* ── Error ── */}
      {error && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
          padding: 'var(--space-4)', background: 'var(--color-danger-light)',
          border: '1px solid #fecaca', borderRadius: 'var(--radius-lg)',
          marginBottom: 'var(--space-5)', color: 'var(--color-danger)',
          fontSize: 'var(--font-size-sm)', fontWeight: 500,
        }}>
          <AlertCircle size={16} style={{ flexShrink: 0 }} />
          {error}
        </div>
      )}

      {/* ── Table card ── */}
      <div className="card">
        {loading ? (
          <div style={{ padding: 'var(--space-8)', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            {[...Array(9)].map((_, i) => <Skeleton key={i} height={i % 3 === 0 ? 32 : 46} />)}
          </div>
        ) : blockNames.length === 0 ? (
          <div style={{ padding: 'var(--space-12)', textAlign: 'center', color: 'var(--color-gray-400)' }}>
            <LayoutGrid size={36} strokeWidth={1.25}
              style={{ margin: '0 auto var(--space-3)', color: 'var(--color-gray-300)' }} />
            <p style={{ fontSize: 'var(--font-size-sm)', fontWeight: 500, color: 'var(--color-gray-500)' }}>
              No block utilization data found
            </p>
            <p style={{ fontSize: 'var(--font-size-xs)', marginTop: 'var(--space-1)' }}>
              Adjust the filters and click Apply
            </p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{
              borderCollapse: 'collapse', width: '100%',
              fontFamily: 'var(--font-family)',
            }}>
              <thead>
                <tr style={{ background: 'var(--color-gray-100)', borderBottom: '2px solid var(--color-gray-300)' }}>
                  <th style={{
                    ...TH_COMMON, left: 0, zIndex: 4, textAlign: 'left',
                    background: 'var(--color-gray-100)', padding: '8px 10px',
                    minWidth: 180, width: 180,
                    borderRight: '2px solid var(--color-gray-300)',
                  }}>
                    Block / Service
                  </th>
                  <th style={{
                    ...TH_COMMON, background: 'var(--color-gray-100)',
                    minWidth: 48, width: 48,
                    borderRight: '1px solid var(--color-gray-200)',
                  }}>
                    Week
                  </th>
                  {DAY_COLS.map(({ label }) => (
                    <th key={label} style={{
                      ...TH_COMMON, background: 'var(--color-gray-100)',
                      minWidth: 68, width: 68,
                      borderRight: '1px solid var(--color-gray-200)',
                    }}>
                      {label}
                    </th>
                  ))}
                  <th style={{
                    ...TH_COMMON, background: 'var(--color-gray-100)',
                    minWidth: 68, width: 68,
                    borderLeft: '2px solid var(--color-gray-300)',
                  }}>
                    Total
                  </th>
                </tr>
              </thead>

              <tbody>
                {blockNames.map(cb => (
                  <BlockRows
                    key={cb}
                    caseBlock={cb}
                    serviceMap={grouped[cb]}
                    monthlyIndex={monthlyIndex}
                    onCellEnter={handleCellEnter}
                    onCellLeave={handleCellLeave}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Hover tooltip ── */}
      <CellTooltip tip={tip} />
    </div>
  )
}

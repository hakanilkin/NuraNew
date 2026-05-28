import { useState, useEffect, useMemo } from 'react'
import { BarChart3, AlertCircle } from 'lucide-react'
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts'

/* ─── Constants ──────────────────────────────────────────────────────────────── */

const BADGE_THRESHOLD = { HIGH: 3, MED: 6 }
const SF_LABEL_FILTER = new Set(['-0.75', '-1.0', '-1'])

const FEAT_NAMES = {
  SOURCE_CATEGORY:     'Source Type',
  DEST_CATEGORY:       'Destination Unit',
  HOUR_OF_DAY:         'Hour of Day',
  DAY_OF_WEEK:         'Day of Week',
  ACCOUNT_FINANCIALCLASS: 'Financial Class',
  DRG_FINALDRGWEIGHT:  'DRG Weight',
  DRG_FINALDRGMDC:     'Diagnostic Category',
  OCC_PCT:             'Unit Occupancy %',
  CONSTRAINED_PCT:     'Constrained Bed %',
  AVAILABLE_BEDS:      'Available Beds',
  BEDREQUEST_ED:       'ED Requests',
  BEDREQUEST_OR:       'OR Requests',
  DISCH:               'Active DC Orders',
  PCT_DC_ORDERS_BY_11: '% DC Orders by 11am',
  PCT_DC_BY_2PM:       '% DCs by 2pm',
  HOSPITAL_OCC_7AM:    'Hospital Occupancy 7am',
  HOSPITAL_CENSUS_7AM: 'Hospital Census 7am',
}

const TABS = [
  { id: 'drivers',      label: 'Drivers' },
  { id: 'combinations', label: 'Combinations' },
  { id: 'explorer',     label: 'Explorer' },
]

const TYPE_MAP = {
  source_dest:   'Source × Destination',
  source_dow:    'Source × Day of Week',
  source_tod:    'Source × Time of Day',
  dest_dow:      'Destination × Day of Week',
  dest_tod:      'Destination × Time of Day',
  census_source: 'Census × Source',
  census_dest:   'Census × Destination',
}

const FILTER_PILLS = [
  { label: 'All combinations',          type: null },
  { label: 'Source × Destination',      type: 'source_dest' },
  { label: 'Source × Day of Week',      type: 'source_dow' },
  { label: 'Source × Time of Day',      type: 'source_tod' },
  { label: 'Destination × Day of Week', type: 'dest_dow' },
  { label: 'Destination × Time of Day', type: 'dest_tod' },
  { label: 'Census × Source',           type: 'census_source' },
  { label: 'Census × Destination',      type: 'census_dest' },
]

const CENSUS_DATA = [
  { bucket: '<180',    avg: 66,  above: false },
  { bucket: '180–190', avg: 68,  above: false },
  { bucket: '191–200', avg: 65,  above: false },
  { bucket: '201–210', avg: 71,  above: false },
  { bucket: '211–220', avg: 81,  above: true  },
  { bucket: '221–230', avg: 95,  above: true  },
  { bucket: '>230',    avg: 112, above: true  },
]

/* ─── Helpers ────────────────────────────────────────────────────────────────── */

function featName(f) {
  return FEAT_NAMES[f] ?? f.replace(/_/g, ' ')
}

function badge(rank) {
  if (rank <= BADGE_THRESHOLD.HIGH) return { label: 'High',   bg: 'rgba(239,68,68,0.12)',   color: '#dc2626' }
  if (rank <= BADGE_THRESHOLD.MED)  return { label: 'Medium', bg: 'rgba(234,179,8,0.12)',   color: '#b45309' }
  return                                   { label: 'Low',    bg: 'rgba(148,163,184,0.12)', color: '#64748b' }
}

function isBadLabel(l) {
  const s = String(l).trim()
  return SF_LABEL_FILTER.has(s) || /^-\d+(\.\d+)?$/.test(s)
}

function formatShapeLabel(feature, rawValue) {
  const v = parseFloat(rawValue)
  if (isNaN(v)) return String(rawValue)
  if (feature === 'HOUR_OF_DAY') {
    const h = Math.round(v) % 24
    if (h === 0)  return '12am'
    if (h < 12)   return `${h}am`
    if (h === 12) return '12pm'
    return `${h - 12}pm`
  }
  const PCT_FEATS = new Set([
    'OCC_PCT', 'CONSTRAINED_PCT', 'HOSPITAL_OCC_7AM',
    'PCT_DC_ORDERS_BY_11', 'PCT_DC_BY_2PM',
  ])
  if (PCT_FEATS.has(feature)) return `${Math.round(v * 100)}%`
  if (feature === 'HOSPITAL_CENSUS_7AM' || feature === 'AVAILABLE_BEDS') return String(Math.round(v))
  if (feature === 'DRG_FINALDRGWEIGHT') return v.toFixed(1)
  return v.toFixed(1)
}

/* ─── Shared sub-components ──────────────────────────────────────────────────── */

function Spinner({ size = 32, label = 'Loading…' }) {
  return (
    <div style={{ textAlign: 'center', color: 'var(--color-gray-400)' }}>
      <div style={{
        width: size, height: size, borderRadius: '50%',
        border: '3px solid var(--color-blue)',
        borderTopColor: 'transparent',
        animation: 'spin 0.7s linear infinite',
        margin: '0 auto var(--space-3)',
      }} />
      <p style={{ fontSize: 'var(--font-size-sm)' }}>{label}</p>
    </div>
  )
}

function ErrorBanner({ message, hint }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 'var(--space-3)',
      padding: 'var(--space-5)',
      background: 'var(--color-danger-light)',
      border: '1px solid #fecaca',
      borderRadius: 'var(--radius-lg)',
      color: '#b91c1c',
      fontSize: 'var(--font-size-sm)',
    }}>
      <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
      <div>
        <div style={{ fontWeight: 'var(--font-weight-semibold)', marginBottom: 2 }}>Could not load model</div>
        <div>{message}</div>
        {hint && <div style={{ marginTop: 6, color: '#ef4444' }}>{hint}</div>}
      </div>
    </div>
  )
}

function StatCard({ label, value, sub, accent }) {
  return (
    <div style={{
      background: 'var(--surface-card)',
      border: '1px solid var(--surface-border)',
      borderRadius: 'var(--radius-lg)',
      padding: 'var(--space-4)',
    }}>
      <div style={{
        fontSize: 'var(--font-size-xs)',
        color: 'var(--color-gray-400)',
        marginBottom: 'var(--space-2)',
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        fontWeight: 'var(--font-weight-medium)',
      }}>
        {label}
      </div>
      <div style={{
        fontSize: 'var(--font-size-xl)',
        fontWeight: 'var(--font-weight-semibold)',
        color: accent || 'var(--color-gray-900)',
        lineHeight: 1.2,
      }}>
        {value}
      </div>
      {sub && (
        <div style={{
          fontSize: 'var(--font-size-xs)',
          color: 'var(--color-gray-400)',
          marginTop: 4,
          lineHeight: 1.4,
        }}>
          {sub}
        </div>
      )}
    </div>
  )
}

function ImportanceBar({ pct }) {
  return (
    <div style={{
      flex: 1, height: 6,
      background: 'var(--color-gray-100)',
      borderRadius: 3, overflow: 'hidden',
    }}>
      <div style={{
        height: '100%', width: `${pct}%`,
        background: 'var(--color-blue)',
        borderRadius: 3, transition: 'width 200ms ease',
      }} />
    </div>
  )
}

function ShapeBar({ label, score, maxAbs }) {
  const isPos    = score >= 0
  const color    = isPos ? '#ef4444' : '#3b82f6'
  const frac     = maxAbs > 0 ? Math.min(Math.abs(score) / maxAbs, 1) : 0
  const barW     = Math.max(frac * 200, 2)
  const valLabel = `${isPos ? '+' : '−'}${Math.abs(score).toFixed(2)}`

  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '2px 0' }}>
      {/* Zone 1 — category label: 180px content + 12px right-padding = 192px total */}
      <div style={{
        width: 180, flexShrink: 0, paddingRight: 12, boxSizing: 'content-box',
        fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-600)',
        textAlign: 'right', lineHeight: 1.35,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {label}
      </div>
      {/* Zone 2 — track: 400px, zero at left 200px */}
      <div style={{ width: 400, flexShrink: 0, height: 20, position: 'relative' }}>
        <div style={{
          position: 'absolute', top: 3, height: 14,
          left: isPos ? 200 : 200 - barW,
          width: barW,
          background: color,
          borderRadius: isPos ? '0 3px 3px 0' : '3px 0 0 3px',
          zIndex: 1,
        }} />
      </div>
      {/* Zone 3 — value label: always outside track to the right */}
      <div style={{
        minWidth: 70, flexShrink: 0, paddingLeft: 8,
        fontSize: 11, fontWeight: 500, color,
        fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
      }}>
        {valLabel}
      </div>
    </div>
  )
}

/* ─── Census Threshold Insight ───────────────────────────────────────────────── */

function CensusInsightCard() {
  return (
    <div className="card" style={{ marginTop: 'var(--space-5)' }}>
      <div className="card-header">
        <div>
          <div className="card-title">The 210-patient threshold</div>
          <div className="card-subtitle">
            When OLLH census exceeds 210 patients at 7am, assignment performance degrades sharply.
            Below this threshold the system absorbs demand. Above it, delays compound.
          </div>
        </div>
      </div>
      <div className="card-body">
        <div style={{ height: 220 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              layout="vertical"
              data={CENSUS_DATA}
              margin={{ top: 4, right: 48, bottom: 24, left: 8 }}
            >
              <CartesianGrid horizontal={false} stroke="var(--color-gray-100)" />
              <XAxis
                type="number"
                domain={[0, 130]}
                tick={{ fontSize: 11, fill: 'var(--color-gray-400)' }}
                label={{
                  value: 'Avg assignment time (min)',
                  position: 'insideBottom',
                  offset: -16,
                  fontSize: 11,
                  fill: 'var(--color-gray-400)',
                }}
              />
              <YAxis
                type="category"
                dataKey="bucket"
                width={68}
                tick={{ fontSize: 11, fill: 'var(--color-gray-500)' }}
              />
              <Tooltip
                cursor={{ fill: 'rgba(0,0,0,0.04)' }}
                formatter={v => [`${v} min`, 'Avg assignment time']}
              />
              <Bar dataKey="avg" radius={[0, 3, 3, 0]} maxBarSize={18}>
                {CENSUS_DATA.map((entry, i) => (
                  <Cell key={i} fill={entry.above ? '#ef4444' : '#22c55e'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Inline stat callouts */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 'var(--space-4)',
          marginTop: 'var(--space-4)',
        }}>
          <div style={{
            padding: 'var(--space-4)',
            background: 'rgba(34,197,94,0.06)',
            border: '1px solid rgba(34,197,94,0.2)',
            borderRadius: 'var(--radius-md)',
          }}>
            <div style={{
              fontSize: 'var(--font-size-xs)',
              color: '#15803d',
              fontWeight: 'var(--font-weight-semibold)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              marginBottom: 'var(--space-1)',
            }}>
              Below 210 patients
            </div>
            <div style={{
              fontSize: 'var(--font-size-xl)',
              fontWeight: 'var(--font-weight-semibold)',
              color: '#15803d',
            }}>
              44%
            </div>
            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-500)', marginTop: 2 }}>
              of assignments exceed target
            </div>
          </div>

          <div style={{
            padding: 'var(--space-4)',
            background: 'rgba(239,68,68,0.06)',
            border: '1px solid rgba(239,68,68,0.2)',
            borderRadius: 'var(--radius-md)',
          }}>
            <div style={{
              fontSize: 'var(--font-size-xs)',
              color: '#b91c1c',
              fontWeight: 'var(--font-weight-semibold)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              marginBottom: 'var(--space-1)',
            }}>
              Above 210 patients
            </div>
            <div style={{
              fontSize: 'var(--font-size-xl)',
              fontWeight: 'var(--font-weight-semibold)',
              color: '#b91c1c',
            }}>
              58%
            </div>
            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-500)', marginTop: 2 }}>
              of assignments exceed target
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ─── Combinations Tab ───────────────────────────────────────────────────────── */

function CombinationsTab({ combos, systemMean, totalCases, loading, error, filter, onFilterChange }) {
  const worstCombo = combos[0] ?? null
  const displayed  = filter ? combos.filter(c => c.type === TYPE_MAP[filter]) : combos
  const maxAboveMean = combos.length > 0
    ? Math.max(...combos.map(c => c.above_mean ?? 0), 1)
    : 1

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 280 }}>
        <Spinner label="Loading combinations…" />
      </div>
    )
  }

  if (error) {
    return (
      <div style={{
        display: 'flex', alignItems: 'flex-start', gap: 'var(--space-3)',
        padding: 'var(--space-5)',
        background: 'var(--color-danger-light)',
        border: '1px solid #fecaca',
        borderRadius: 'var(--radius-lg)',
        color: '#b91c1c', fontSize: 'var(--font-size-sm)',
      }}>
        <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
        <div>
          <div style={{ fontWeight: 'var(--font-weight-semibold)', marginBottom: 2 }}>Could not load combinations</div>
          <div>{error}</div>
          <div style={{ marginTop: 6, color: '#ef4444' }}>
            Run <code>python bed_placement_pipeline.py</code> to generate the combinations file.
          </div>
        </div>
      </div>
    )
  }

  return (
    <>
      {/* ── Stat cards ── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 'var(--space-4)',
        marginBottom: 'var(--space-5)',
      }}>
        <StatCard
          label="System Mean"
          value={systemMean != null ? `${systemMean} min` : '—'}
          sub="Average assignment time"
        />
        <StatCard
          label="Target"
          value="30 min"
          sub="30-min assignment target"
          accent="var(--color-blue)"
        />
        <StatCard
          label="Cases Analyzed"
          value={totalCases ? totalCases.toLocaleString() : '—'}
          sub="Total bed assignments"
        />
        <StatCard
          label="Worst Combination"
          value={worstCombo ? `+${worstCombo.above_mean} min` : '—'}
          sub={worstCombo?.label ?? 'No data'}
          accent="#ef4444"
        />
      </div>

      {/* ── Filter pills ── */}
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 'var(--space-2)',
        marginBottom: 'var(--space-4)',
      }}>
        {FILTER_PILLS.map(p => {
          const active = filter === p.type
          return (
            <button
              key={p.label}
              type="button"
              onClick={() => onFilterChange(p.type)}
              style={{
                padding: '5px var(--space-3)',
                borderRadius: 'var(--radius-full)',
                border: '1px solid',
                cursor: 'pointer',
                fontSize: 'var(--font-size-xs)',
                fontWeight: 'var(--font-weight-medium)',
                transition: 'all 150ms',
                background: active ? 'var(--color-blue)' : 'transparent',
                borderColor: active ? 'var(--color-blue)' : 'var(--surface-border)',
                color: active ? 'white' : 'var(--color-gray-600)',
              }}
            >
              {p.label}
            </button>
          )
        })}
      </div>

      {/* ── Table card ── */}
      <div className="card">
        {/* Column headers */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
          padding: 'var(--space-2) var(--space-4)',
          borderBottom: '1px solid var(--surface-border)',
        }}>
          <div style={{ width: 28, flexShrink: 0 }} />
          <div style={{ flex: 1, fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)', fontWeight: 'var(--font-weight-semibold)' }}>
            Combination
          </div>
          <div style={{ width: 220, flexShrink: 0, fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)', fontWeight: 'var(--font-weight-semibold)' }}>
            Above mean
          </div>
          <div style={{ width: 120, flexShrink: 0, fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)', fontWeight: 'var(--font-weight-semibold)', textAlign: 'right' }}>
            Avg assignment time
          </div>
          <div style={{ width: 72, flexShrink: 0, fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)', fontWeight: 'var(--font-weight-semibold)', textAlign: 'right' }}>
            Cases
          </div>
        </div>

        {displayed.length === 0 ? (
          <div style={{
            padding: 'var(--space-10)',
            textAlign: 'center',
            color: 'var(--color-gray-400)',
            fontSize: 'var(--font-size-sm)',
          }}>
            No combinations data available.
          </div>
        ) : displayed.map((combo, i) => {
          const barPct = maxAboveMean > 0 ? ((combo.above_mean ?? 0) / maxAboveMean) * 100 : 0
          return (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-3)',
                padding: 'var(--space-3) var(--space-4)',
                borderBottom: i < displayed.length - 1 ? '1px solid var(--surface-border)' : 'none',
              }}
            >
              {/* Rank */}
              <div style={{
                width: 28, flexShrink: 0,
                fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)',
                fontVariantNumeric: 'tabular-nums', textAlign: 'right',
              }}>
                {i + 1}
              </div>

              {/* Label + sub */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 'var(--font-size-sm)', color: 'var(--color-gray-800)',
                  fontWeight: 'var(--font-weight-medium)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {combo.label}
                </div>
                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)', marginTop: 2 }}>
                  {combo.sub}
                </div>
              </div>

              {/* Bar + above_mean value */}
              <div style={{
                width: 220, flexShrink: 0,
                display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
              }}>
                <div style={{
                  flex: 1, height: 8,
                  background: 'var(--color-gray-100)',
                  borderRadius: 4, overflow: 'hidden',
                }}>
                  <div style={{
                    height: '100%',
                    width: `${barPct}%`,
                    background: '#ef4444',
                    borderRadius: 4,
                  }} />
                </div>
                <div style={{
                  width: 56, flexShrink: 0,
                  fontSize: 'var(--font-size-xs)', fontWeight: 'var(--font-weight-semibold)',
                  color: '#ef4444', textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                }}>
                  +{combo.above_mean} min
                </div>
              </div>

              {/* Avg assignment time */}
              <div style={{
                width: 120, flexShrink: 0,
                fontSize: 'var(--font-size-sm)', color: 'var(--color-gray-700)',
                textAlign: 'right', fontVariantNumeric: 'tabular-nums',
              }}>
                {combo.avg_assignment_min} min
              </div>

              {/* Cases */}
              <div style={{
                width: 72, flexShrink: 0,
                fontSize: 'var(--font-size-sm)', color: 'var(--color-gray-700)',
                textAlign: 'right', fontVariantNumeric: 'tabular-nums',
              }}>
                {combo.cnt?.toLocaleString() ?? '—'}
              </div>
            </div>
          )
        })}
      </div>
    </>
  )
}

/* ─── Atlas Bed Placement Page ───────────────────────────────────────────────── */

export default function AtlasBedPlacement() {
  const [model,         setModel]         = useState(null)
  const [loading,       setLoading]       = useState(true)
  const [error,         setError]         = useState('')
  const [selectedFeat,  setSelectedFeat]  = useState(null)
  const [activeTab,     setActiveTab]     = useState('drivers')
  const [combos,        setCombos]        = useState([])
  const [combosMeta,    setCombosMeta]    = useState({ system_mean: null, total_cases: 0 })
  const [combosLoading, setCombosLoading] = useState(true)
  const [combosError,   setCombosError]   = useState('')
  const [comboFilter,   setComboFilter]   = useState(null)

  /* ── Fetch model + combinations in parallel ── */
  useEffect(() => {
    setLoading(true)
    setError('')

    fetch('/api/atlas/bed-placement-model')
      .then(r => {
        if (!r.ok) return r.json().then(d => Promise.reject(new Error(d.error || `HTTP ${r.status}`)))
        return r.json()
      })
      .then(data => {
        setModel(data)
        const firstMain = data.feature_importance?.find(f => !f.feature.includes(' & '))
        if (firstMain) setSelectedFeat(firstMain.feature)
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))

    fetch('/api/atlas/bed-placement-combinations')
      .then(r => {
        if (!r.ok) return r.json().then(d => Promise.reject(new Error(d.error || `HTTP ${r.status}`)))
        return r.json()
      })
      .then(data => {
        setCombos(data.combinations ?? [])
        setCombosMeta({ system_mean: data.system_mean ?? null, total_cases: data.total_cases ?? 0 })
      })
      .catch(err => setCombosError(err.message))
      .finally(() => setCombosLoading(false))
  }, [])

  /* ── Derived ── */
  const mainEffects = useMemo(() => {
    if (!model?.feature_importance) return []
    return model.feature_importance.filter(f => !f.feature.includes(' & '))
  }, [model])

  const totalImp = useMemo(
    () => mainEffects.reduce((s, f) => s + (f.importance_score ?? 0), 0),
    [mainEffects],
  )
  const maxImp = useMemo(
    () => Math.max(...mainEffects.map(f => f.importance_score ?? 0), 0.001),
    [mainEffects],
  )

  const selectedSF = useMemo(() => {
    if (!model?.shape_functions || !selectedFeat) return null
    return model.shape_functions.find(sf => sf.feature === selectedFeat) ?? null
  }, [model, selectedFeat])

  const sfEntries = useMemo(() => {
    if (!selectedSF) return []
    const isCat  = selectedSF.type === 'categorical' || selectedSF.x_labels?.length > 0
    const scores = selectedSF.y_scores ?? []
    const n      = scores.length

    let indices
    if (isCat || n <= 20) {
      indices = Array.from({ length: n }, (_, i) => i)
    } else {
      const step = (n - 1) / 19
      indices = Array.from({ length: 20 }, (_, k) => Math.round(k * step))
    }

    return indices
      .map(i => ({
        label: isCat
          ? (selectedSF.x_labels?.[i] ?? String(selectedSF.x_values?.[i] ?? i))
          : (selectedSF.x_values?.[i] != null ? formatShapeLabel(selectedSF.feature, selectedSF.x_values[i]) : String(i)),
        score: scores[i],
      }))
      .filter(e => !isBadLabel(e.label))
  }, [selectedSF])

  const sfMaxAbs = useMemo(
    () => Math.max(...sfEntries.map(e => Math.abs(e.score)), 0.001),
    [sfEntries],
  )

  /* ── Loading / Error states ── */
  if (loading) {
    return (
      <div className="page" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 320 }}>
        <div style={{ textAlign: 'center', color: 'var(--color-gray-400)' }}>
          <div style={{
            width: 36, height: 36, borderRadius: '50%',
            border: '3px solid var(--color-blue)',
            borderTopColor: 'transparent',
            animation: 'spin 0.7s linear infinite',
            margin: '0 auto var(--space-4)',
          }} />
          <p style={{ fontSize: 'var(--font-size-sm)' }}>Loading model…</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="page">
        <ErrorBanner
          message={error}
          hint="Run python bed_placement_pipeline.py to generate the model file."
        />
      </div>
    )
  }

  if (!model) return null

  const total   = (model.n_above_threshold ?? 0) + (model.n_below_threshold ?? 0)
  const exceedPct = total > 0
    ? `${Math.round((model.n_above_threshold / total) * 100)}%`
    : '—'
  const auc     = model.model_stats?.auc != null ? model.model_stats.auc.toFixed(3) : '—'
  const topFeat = mainEffects[0]?.feature

  return (
    <div className="page">
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* ─── Tab bar ──────────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex',
        borderBottom: '1px solid var(--surface-border)',
        marginBottom: 'var(--space-6)',
      }}>
        {TABS.map(tab => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            style={{
              background: 'none',
              border: 'none',
              borderBottom: activeTab === tab.id
                ? '2px solid var(--color-blue)'
                : '2px solid transparent',
              cursor: 'pointer',
              padding: 'var(--space-3) var(--space-4)',
              fontSize: 'var(--font-size-sm)',
              fontWeight: activeTab === tab.id
                ? 'var(--font-weight-semibold)'
                : 'var(--font-weight-medium)',
              color: activeTab === tab.id ? 'var(--color-blue)' : 'var(--color-gray-500)',
              marginBottom: -1,
              transition: 'color 150ms',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ─── Drivers tab ──────────────────────────────────────────────────────── */}
      {activeTab === 'drivers' && (
        <>
          {/* Section 1: Stat cards */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 'var(--space-4)',
            marginBottom: 'var(--space-6)',
          }}>
            <StatCard
              label="Cases Analyzed"
              value={total > 0 ? total.toLocaleString() : '—'}
              sub="Bed assignment requests"
            />
            <StatCard
              label="% Exceeding Target"
              value={exceedPct}
              sub="Assignments beyond 30-min target"
              accent="#ef4444"
            />
            <StatCard
              label="Model AUC"
              value={auc}
              sub="Classifier discrimination"
              accent="var(--color-blue)"
            />
            <StatCard
              label="Top Driver"
              value={topFeat ? featName(topFeat) : '—'}
              sub="Highest importance factor"
            />
          </div>

          {/* Section 2: Feature driver list + shape panel */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '340px 1fr',
            gap: 'var(--space-5)',
            marginBottom: 'var(--space-5)',
            alignItems: 'start',
          }}>
            {/* Left: feature driver list */}
            <div className="card" style={{
              position: 'sticky',
              top: 'calc(var(--topbar-h, 56px) + var(--space-4))',
              maxHeight: 'calc(100vh - 120px)',
              display: 'flex', flexDirection: 'column',
            }}>
              <div className="card-header" style={{ flexShrink: 0 }}>
                <div>
                  <div className="card-title">What drives assignment delay</div>
                  <div className="card-subtitle">Click a feature to see its shape function</div>
                </div>
              </div>
              <div style={{ overflowY: 'auto', flex: 1, padding: 'var(--space-1) 0' }}>
                {mainEffects.map(f => {
                  const b          = badge(f.rank)
                  const pct        = maxImp > 0 ? (f.importance_score / maxImp) * 100 : 0
                  const share      = totalImp > 0 ? ((f.importance_score / totalImp) * 100).toFixed(1) : '0'
                  const isSelected = selectedFeat === f.feature
                  return (
                    <button
                      key={f.feature}
                      type="button"
                      onClick={() => setSelectedFeat(f.feature)}
                      style={{
                        width: '100%',
                        background: isSelected ? 'rgba(59,130,246,0.06)' : 'none',
                        border: 'none',
                        borderLeft: isSelected ? '3px solid var(--color-blue)' : '3px solid transparent',
                        cursor: 'pointer', textAlign: 'left',
                        padding: 'var(--space-3) var(--space-4)',
                        transition: 'background 150ms',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' }}>
                        <span style={{
                          flex: 1,
                          fontSize: 'var(--font-size-sm)',
                          fontWeight: isSelected ? 'var(--font-weight-semibold)' : 'var(--font-weight-medium)',
                          color: isSelected ? 'var(--color-blue)' : 'var(--color-gray-700)',
                          overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
                        }}>
                          {featName(f.feature)}
                        </span>
                        <span style={{
                          fontSize: 'var(--font-size-xs)', fontWeight: 'var(--font-weight-semibold)',
                          color: b.color, background: b.bg,
                          padding: '1px 6px', borderRadius: 'var(--radius-full)', flexShrink: 0,
                        }}>
                          {b.label}
                        </span>
                        <span style={{
                          fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)',
                          flexShrink: 0, fontVariantNumeric: 'tabular-nums',
                        }}>
                          {share}%
                        </span>
                      </div>
                      <ImportanceBar pct={pct} />
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Right: shape function panel */}
            <div className="card">
              {!selectedSF ? (
                <div className="card-body" style={{ minHeight: 240, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <div style={{ textAlign: 'center', color: 'var(--color-gray-400)' }}>
                    <BarChart3 size={36} strokeWidth={1.25} style={{ margin: '0 auto var(--space-3)' }} />
                    <p style={{ fontSize: 'var(--font-size-sm)' }}>Select a feature to see its shape function</p>
                  </div>
                </div>
              ) : (
                <>
                  <div className="card-header">
                    <div>
                      <div className="card-title">
                        How <em>{featName(selectedSF.feature)}</em> affects assignment delay probability
                      </div>
                      <div className="card-subtitle">
                        Values show contribution to delay probability above (red) or below (blue) the average
                        {model.system_mean != null ? ` — system mean ${model.system_mean} min` : ''}
                      </div>
                    </div>
                  </div>
                  <div className="card-body">
                    {sfEntries.length === 0 ? (
                      <div style={{ textAlign: 'center', color: 'var(--color-gray-400)', padding: 'var(--space-8) 0' }}>
                        No shape data available
                      </div>
                    ) : (
                      <div style={{ position: 'relative', padding: '16px 0' }}>
                        {/* Full-height zero line */}
                        <div style={{
                          position: 'absolute', left: 392, top: 0, bottom: 0,
                          width: 1, background: 'var(--color-gray-200)',
                          zIndex: 0, pointerEvents: 'none',
                        }} />
                        {/* Center line label */}
                        <div style={{
                          position: 'absolute', left: 392, top: 0,
                          transform: 'translateX(-50%)',
                          fontSize: 9, color: 'var(--color-gray-400)',
                          whiteSpace: 'nowrap', fontWeight: 600, lineHeight: 1,
                        }}>
                          {model.system_mean != null ? `avg ${model.system_mean} min` : 'avg'}
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          {sfEntries.map((e, i) => (
                            <ShapeBar key={i} label={e.label} score={e.score} maxAbs={sfMaxAbs} />
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Section 3: Census threshold insight */}
          <CensusInsightCard />
        </>
      )}

      {/* ─── Combinations tab ─────────────────────────────────────────────────── */}
      {activeTab === 'combinations' && (
        <CombinationsTab
          combos={combos}
          systemMean={combosMeta.system_mean}
          totalCases={combosMeta.total_cases}
          loading={combosLoading}
          error={combosError}
          filter={comboFilter}
          onFilterChange={setComboFilter}
        />
      )}

      {/* ─── Explorer tab (placeholder) ───────────────────────────────────────── */}
      {activeTab === 'explorer' && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 320 }}>
          <div style={{ textAlign: 'center', color: 'var(--color-gray-400)' }}>
            <BarChart3 size={40} strokeWidth={1.25} style={{ margin: '0 auto var(--space-3)' }} />
            <p style={{
              fontSize: 'var(--font-size-sm)',
              fontWeight: 'var(--font-weight-medium)',
              color: 'var(--color-gray-500)',
            }}>
              Explorer
            </p>
            <p style={{ fontSize: 'var(--font-size-xs)', marginTop: 4 }}>Coming soon</p>
          </div>
        </div>
      )}
    </div>
  )
}

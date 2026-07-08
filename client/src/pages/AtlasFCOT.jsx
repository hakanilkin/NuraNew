import { useState, useEffect, useMemo } from 'react'
import { BarChart3, AlertCircle } from 'lucide-react'

/* ─── Constants ─────────────────────────────────────────────────────────────── */

const BADGE_THRESHOLD = { HIGH: 5, MED: 8 }

const FEAT_NAMES = {
  Case_AddOnCode:          'Add-on Case',
  Sched_SchedDur:          'Scheduled Duration',
  Case_SurgeonService:     'Surgeon Service',
  Loc_ORGrp2:              'Location Group',
  DD_DOW_Long:             'Day of Week',
  Case_DaysScheduledAhead: 'Days Scheduled Ahead',
  Case_CaseType:           'Case Type',
  Case_ASACode:            'ASA Acuity',
  DD_WeekOfMonth:          'Week of Month',
  DD_Holiday:              'Holiday',
  DD_Month_Int:            'Month',
  Anes_Anestype:           'Anesthesia Type',
}

const SF_LABEL_FILTER = new Set(['-0.75', '-1.0', '-1'])

function isBadLabel(l) {
  const s = String(l).trim()
  return SF_LABEL_FILTER.has(s) || /^-\d+(\.\d+)?$/.test(s)
}

const FILTER_PILLS = [
  { label: 'All combinations',       type: null },
  { label: 'Service × Surgeon',      type: 'service_surgeon' },
  { label: 'Location × Service',     type: 'location_service' },
  { label: 'Day × Service',          type: 'day_service' },
  { label: 'Case Type × Service',    type: 'casetype_service' },
  { label: 'Duration × Surgeon',     type: 'duration_surgeon' },
]

const TABS = [
  { id: 'drivers',      label: 'Drivers' },
  { id: 'combinations', label: 'Combinations' },
  { id: 'explorer',     label: 'Explorer' },
]

/* ─── Helpers ───────────────────────────────────────────────────────────────── */

function featName(f) {
  return FEAT_NAMES[f] ?? f.replace(/_/g, ' ')
}

function badge(rank) {
  if (rank <= BADGE_THRESHOLD.HIGH) return { label: 'High',   bg: 'rgba(239,68,68,0.12)',   color: '#dc2626' }
  if (rank <= BADGE_THRESHOLD.MED)  return { label: 'Medium', bg: 'rgba(234,179,8,0.12)',   color: '#b45309' }
  return                                   { label: 'Low',    bg: 'rgba(148,163,184,0.12)', color: '#64748b' }
}

/* ─── Shape Bar ─────────────────────────────────────────────────────────────── */

function ShapeBar({ label, score, maxAbs }) {
  const isPos    = score >= 0
  const color    = isPos ? '#ef4444' : '#3b82f6'
  const frac     = maxAbs > 0 ? Math.min(Math.abs(score) / maxAbs, 1) : 0
  const barW     = Math.max(frac * 200, 2)
  const valLabel = `${isPos ? '+' : '−'}${Math.abs(score).toFixed(1)} min`

  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '2px 0' }}>
      <div style={{
        width: 180, flexShrink: 0, paddingRight: 12, boxSizing: 'content-box',
        fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-600)',
        textAlign: 'right', lineHeight: 1.35,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {label}
      </div>
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

/* ─── Importance Bar ────────────────────────────────────────────────────────── */

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

/* ─── Stat Card ─────────────────────────────────────────────────────────────── */

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

/* ─── High-impact combinations (Drivers tab) ────────────────────────────────── */

function FCOTCombinationsSection({ combinations, systemMean }) {
  if (!combinations?.length) {
    return (
      <div style={{
        marginTop: 'var(--space-6)',
        padding: 'var(--space-5)',
        background: 'var(--color-gray-50)',
        border: '1px solid var(--surface-border)',
        borderRadius: 'var(--radius-lg)',
        color: 'var(--color-gray-400)',
        fontSize: 'var(--font-size-sm)',
      }}>
        Combinations data not yet computed.
      </div>
    )
  }

  const maxAbove = Math.max(...combinations.map(c => c.above_mean), 1)
  const maxAvg   = Math.max(...combinations.map(c => c.avg_fcot), 1)
  const meanPct  = systemMean != null ? (systemMean / maxAvg) * 100 : null

  return (
    <div style={{ marginTop: 'var(--space-6)' }}>
      <div style={{ marginBottom: 'var(--space-4)' }}>
        <h2 style={{
          fontSize: 'var(--font-size-lg)',
          fontWeight: 'var(--font-weight-semibold)',
          color: 'var(--color-gray-900)',
          marginBottom: 'var(--space-1)',
        }}>
          High-impact combinations
        </h2>
        <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-gray-500)' }}>
          Combinations of factors associated with the longest first-case start delays.
        </p>
      </div>

      <div className="card">
        <div style={{
          display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
          padding: 'var(--space-2) var(--space-4)',
          borderBottom: '1px solid var(--surface-border)',
        }}>
          <div style={{ width: 28, flexShrink: 0 }} />
          <div style={{ flex: 1, fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)', fontWeight: 'var(--font-weight-semibold)' }}>Combination</div>
          <div style={{ width: 240, flexShrink: 0, fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)', fontWeight: 'var(--font-weight-semibold)' }}>Above mean</div>
          <div style={{ width: 100, flexShrink: 0, fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)', fontWeight: 'var(--font-weight-semibold)', textAlign: 'right' }}>Avg FCOT delay</div>
          <div style={{ width: 72, flexShrink: 0, fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)', fontWeight: 'var(--font-weight-semibold)', textAlign: 'right' }}>Cases</div>
        </div>

        {combinations.map((combo, i) => {
          const barPct = maxAbove > 0 ? (combo.above_mean / maxAbove) * 100 : 0
          return (
            <div
              key={i}
              style={{
                display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
                padding: 'var(--space-3) var(--space-4)',
                borderBottom: i < combinations.length - 1 ? '1px solid var(--surface-border)' : 'none',
              }}
            >
              <div style={{ width: 28, flexShrink: 0, fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)', fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>{i + 1}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-gray-800)', fontWeight: 'var(--font-weight-medium)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{combo.label}</div>
                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)', marginTop: 2 }}>{combo.sub}</div>
              </div>
              <div style={{ width: 240, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <div style={{ flex: 1, height: 8, background: 'var(--color-gray-100)', borderRadius: 4, overflow: 'hidden', position: 'relative' }}>
                  <div style={{ height: '100%', width: `${barPct}%`, background: '#ef4444', borderRadius: 4 }} />
                  {meanPct != null && (
                    <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${meanPct}%`, width: 2, background: '#94a3b8' }} />
                  )}
                </div>
                <div style={{ width: 60, flexShrink: 0, fontSize: 'var(--font-size-xs)', fontWeight: 'var(--font-weight-semibold)', color: '#ef4444', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  +{combo.above_mean} min
                </div>
              </div>
              <div style={{ width: 100, flexShrink: 0, fontSize: 'var(--font-size-sm)', color: 'var(--color-gray-700)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{combo.avg_fcot} min</div>
              <div style={{ width: 72, flexShrink: 0, fontSize: 'var(--font-size-sm)', color: 'var(--color-gray-700)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{combo.cnt.toLocaleString()}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ─── Combinations Tab ──────────────────────────────────────────────────────── */

function CombinationsTab({ combos, combosLoading, combosError, combosMean, model, filter, onFilterChange }) {
  const worstCombo = combos[0] ?? null
  const maxAbove   = combos.length > 0 ? combos[0].above_mean : 1
  const displayed  = filter ? combos.filter(c => c.type === filter) : combos

  if (combosLoading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 280 }}>
        <div style={{ textAlign: 'center', color: 'var(--color-gray-400)' }}>
          <div style={{
            width: 32, height: 32, borderRadius: '50%',
            border: '3px solid var(--color-blue)',
            borderTopColor: 'transparent',
            animation: 'spin 0.7s linear infinite',
            margin: '0 auto var(--space-3)',
          }} />
          <p style={{ fontSize: 'var(--font-size-sm)' }}>Loading combinations…</p>
        </div>
      </div>
    )
  }

  if (combosError) {
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
          <div>{combosError}</div>
          <div style={{ marginTop: 6, color: '#ef4444' }}>
            Run <code>python fcot_ebm_pipeline.py</code> to generate the combinations file.
          </div>
        </div>
      </div>
    )
  }

  return (
    <>
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 'var(--space-4)', marginBottom: 'var(--space-5)',
      }}>
        <StatCard
          label="System Mean"
          value={combosMean != null ? `${combosMean} min` : (model?.system_mean != null ? `${model.system_mean} min` : '—')}
          sub="Average FCOT delay"
        />
        <StatCard
          label="Cases Analyzed"
          value={model?.n_training_samples?.toLocaleString() ?? '—'}
          sub="OR cases analyzed"
        />
        <StatCard
          label="Worst Combination"
          value={worstCombo ? `+${worstCombo.above_mean} min` : '—'}
          sub={worstCombo?.label ?? 'No data'}
          accent="#ef4444"
        />
        <StatCard
          label="Model MAE"
          value={model?.mae != null ? `${model.mae} min` : '—'}
          sub="Mean absolute error"
        />
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', marginBottom: 'var(--space-4)' }}>
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

      <div className="card">
        <div style={{
          display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
          padding: 'var(--space-2) var(--space-4)',
          borderBottom: '1px solid var(--surface-border)',
        }}>
          <div style={{ width: 28, flexShrink: 0 }} />
          <div style={{ flex: 1, fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)', fontWeight: 'var(--font-weight-semibold)' }}>Combination</div>
          <div style={{ width: 220, flexShrink: 0, fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)', fontWeight: 'var(--font-weight-semibold)' }}>Above mean</div>
          <div style={{ width: 96, flexShrink: 0, fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)', fontWeight: 'var(--font-weight-semibold)', textAlign: 'right' }}>Avg FCOT delay</div>
          <div style={{ width: 72, flexShrink: 0, fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)', fontWeight: 'var(--font-weight-semibold)', textAlign: 'right' }}>Cases/yr</div>
        </div>

        {displayed.length === 0 ? (
          <div style={{ padding: 'var(--space-10)', textAlign: 'center', color: 'var(--color-gray-400)', fontSize: 'var(--font-size-sm)' }}>
            No combinations above the system mean for this filter.
          </div>
        ) : displayed.map((combo, i) => {
          const barPct = maxAbove > 0 ? (combo.above_mean / maxAbove) * 100 : 0
          return (
            <div
              key={i}
              style={{
                display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
                padding: 'var(--space-3) var(--space-4)',
                borderBottom: i < displayed.length - 1 ? '1px solid var(--surface-border)' : 'none',
              }}
            >
              <div style={{ width: 28, flexShrink: 0, fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)', fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>{i + 1}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-gray-800)', fontWeight: 'var(--font-weight-medium)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{combo.label}</div>
                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)', marginTop: 2 }}>{combo.sub}</div>
              </div>
              <div style={{ width: 220, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <div style={{ flex: 1, height: 8, background: 'var(--color-gray-100)', borderRadius: 4, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${barPct}%`, background: '#ef4444', borderRadius: 4 }} />
                </div>
                <div style={{ width: 56, flexShrink: 0, fontSize: 'var(--font-size-xs)', fontWeight: 'var(--font-weight-semibold)', color: '#ef4444', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  +{combo.above_mean} min
                </div>
              </div>
              <div style={{ width: 96, flexShrink: 0, fontSize: 'var(--font-size-sm)', color: 'var(--color-gray-700)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{combo.avg_fcot} min</div>
              <div style={{ width: 72, flexShrink: 0, fontSize: 'var(--font-size-sm)', color: 'var(--color-gray-700)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{combo.cnt.toLocaleString()}</div>
            </div>
          )
        })}
      </div>
    </>
  )
}

/* ─── Waterfall Chart ───────────────────────────────────────────────────────── */

function WaterfallChart({ baseline, baselineLabel, contributions, benchmark, projected }) {
  const BAR_H   = 28
  const LABEL_W = 190
  const CHART_W = 340
  const VALUE_W = 80
  const ROW_H   = 46
  const SVG_W   = LABEL_W + CHART_W + VALUE_W

  const rows = []
  let running = baseline

  rows.push({
    label: baselineLabel ?? `Baseline (${Math.round(baseline)} min)`,
    barStart: 0, barEnd: baseline, delta: null, running: baseline, isTotal: false, isBase: true,
  })

  for (const c of contributions) {
    const start = running
    const end   = running + c.score
    rows.push({
      label: `${c.label}: ${c.optionLabel}`,
      barStart: Math.min(start, end), barEnd: Math.max(start, end),
      delta: c.score, running: end, isTotal: false, isBase: false,
    })
    running = end
  }

  rows.push({
    label: 'Projected',
    barStart: 0, barEnd: projected, delta: null, running: projected, isTotal: true, isBase: false,
  })

  const SVG_H  = rows.length * ROW_H + 24
  const maxVal = Math.max(projected, baseline, benchmark) * 1.12
  const xs     = v => LABEL_W + (v / maxVal) * CHART_W
  const bx     = xs(benchmark)

  let totalColor
  if (projected <= benchmark)            totalColor = '#22c55e'
  else if (projected <= benchmark * 1.5) totalColor = '#f59e0b'
  else if (projected <= benchmark * 2.0) totalColor = '#f97316'
  else                                   totalColor = '#ef4444'

  return (
    <svg width={SVG_W} height={SVG_H} style={{ display: 'block', overflow: 'visible' }}>
      <line x1={bx} y1={0} x2={bx} y2={SVG_H - 20} stroke="#f59e0b" strokeWidth={1.5} strokeDasharray="4,3" />
      <text x={bx} y={SVG_H - 4} textAnchor="middle" fontSize={9} fill="#f59e0b" fontWeight={600}>
        Benchmark ({benchmark} min)
      </text>

      {rows.map((row, i) => {
        const y  = i * ROW_H
        const x1 = xs(row.barStart)
        const x2 = xs(row.barEnd)
        const bw = Math.max(x2 - x1, 3)

        let fill
        if (row.isTotal)      fill = totalColor
        else if (row.isBase)  fill = '#94a3b8'
        else                  fill = (row.delta ?? 0) >= 0 ? '#ef4444' : '#3b82f6'

        const valLabel = row.delta === null
          ? `${Math.round(row.barEnd)} min`
          : `${row.delta >= 0 ? '+' : ''}${Math.round(row.delta)} min`

        return (
          <g key={i}>
            <text
              x={LABEL_W - 8} y={y + BAR_H / 2 + 4}
              textAnchor="end" fontSize={11}
              fill={row.isTotal ? '#1e293b' : '#64748b'}
              fontWeight={row.isTotal ? 600 : 400}
            >
              {row.label}
            </text>
            <rect x={x1} y={y} width={bw} height={BAR_H} fill={fill} rx={3} opacity={row.isTotal ? 1 : 0.85} />
            {i < rows.length - 1 && !row.isBase && !row.isTotal && (
              <line
                x1={xs(row.running)} y1={y + BAR_H}
                x2={xs(row.running)} y2={(i + 1) * ROW_H}
                stroke="#cbd5e1" strokeWidth={1}
              />
            )}
            <text
              x={Math.max(x1, x2) + 6} y={y + BAR_H / 2 + 4}
              fontSize={11} fontWeight={row.isTotal ? 700 : 600}
              fill={fill}
            >
              {valLabel}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

/* ─── Explorer Tab ──────────────────────────────────────────────────────────── */

function ExplorerTab({ model, metric, benchmark, benchmarkLabel }) {
  const catFeatures = useMemo(() => {
    if (!model?.shape_functions) return []
    return model.shape_functions
      .filter(sf => {
        const labels = sf.x_labels ?? []
        return labels.length > 0 && labels.some(l => isNaN(parseFloat(String(l))))
      })
      .map(sf => ({ key: sf.feature, label: featName(sf.feature), sf }))
  }, [model])

  const [selections, setSelections] = useState({})

  const baseline = model?.system_mean ?? benchmark

  const contributions = catFeatures
    .filter(f => selections[f.key] != null)
    .map(f => {
      const sel = selections[f.key]
      return { label: f.label, optionLabel: sel.label, score: sel.score }
    })

  const projected = baseline + contributions.reduce((s, c) => s + c.score, 0)

  let risk, riskColor
  if (projected <= benchmark)            { risk = 'Within target'; riskColor = '#22c55e' }
  else if (projected <= benchmark * 1.5) { risk = 'Moderate';     riskColor = '#f59e0b' }
  else if (projected <= benchmark * 2.0) { risk = 'High';         riskColor = '#f97316' }
  else                                   { risk = 'Severe';       riskColor = '#ef4444' }

  if (!catFeatures.length) return (
    <div style={{ textAlign: 'center', padding: 'var(--space-10)', color: 'var(--color-gray-400)', fontSize: 'var(--font-size-sm)' }}>
      No categorical features found in model data.
    </div>
  )

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 'var(--space-5)', alignItems: 'start' }}>

      {/* Left: dropdowns */}
      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title">Configure Scenario</div>
            <div className="card-subtitle">Select factors to see their combined effect on {metric}</div>
          </div>
        </div>
        <div style={{ padding: '0 var(--space-4) var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          {catFeatures.map(f => {
            const options = (f.sf.x_labels ?? [])
              .map((label, i) => ({ label, score: f.sf.y_scores?.[i] ?? 0 }))
              .filter(o => !isBadLabel(o.label))
            return (
              <div key={f.key}>
                <label style={{
                  fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-500)',
                  display: 'block', marginBottom: 4, fontWeight: 'var(--font-weight-medium)',
                }}>
                  {f.label}
                </label>
                <select
                  value={selections[f.key]?.label ?? ''}
                  onChange={e => {
                    const opt = options.find(o => o.label === e.target.value) ?? null
                    setSelections(prev => ({ ...prev, [f.key]: opt }))
                  }}
                  style={{
                    width: '100%', padding: '8px var(--space-3)',
                    fontSize: 'var(--font-size-sm)',
                    border: '1px solid var(--surface-border)',
                    borderRadius: 'var(--radius-md)',
                    background: 'var(--surface-card)',
                    color: 'var(--color-gray-700)',
                    cursor: 'pointer', appearance: 'auto',
                  }}
                >
                  <option value="">— Any —</option>
                  {options.map(o => (
                    <option key={o.label} value={o.label}>
                      {o.label}{'  '}({o.score >= 0 ? '+' : ''}{Math.round(o.score)} min)
                    </option>
                  ))}
                </select>
              </div>
            )
          })}
          {contributions.length > 0 && (
            <button
              type="button"
              onClick={() => setSelections({})}
              style={{
                background: 'none', border: '1px solid var(--surface-border)',
                borderRadius: 'var(--radius-md)', cursor: 'pointer',
                padding: '6px var(--space-3)',
                fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-500)',
              }}
            >
              Clear all
            </button>
          )}
        </div>
      </div>

      {/* Right: waterfall + summary */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">Projected {metric}</div>
              <div className="card-subtitle">Each bar shows the average effect of that factor. Dashed line = {benchmarkLabel}.</div>
            </div>
          </div>
          <div style={{ padding: 'var(--space-4)', overflowX: 'auto' }}>
            {contributions.length === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--color-gray-400)', padding: 'var(--space-8) 0' }}>
                <BarChart3 size={32} strokeWidth={1.25} style={{ margin: '0 auto var(--space-3)' }} />
                <p style={{ fontSize: 'var(--font-size-sm)' }}>Select factors on the left to build a scenario</p>
              </div>
            ) : (
              <WaterfallChart
                baseline={baseline}
                baselineLabel={`System mean (${Math.round(baseline)} min)`}
                contributions={contributions}
                benchmark={benchmark}
                projected={projected}
              />
            )}
          </div>
        </div>

        <div className="card">
          <div style={{ padding: 'var(--space-5)', display: 'flex', alignItems: 'center', gap: 'var(--space-5)' }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)', marginBottom: 4 }}>Projected {metric}</div>
              <div style={{ fontSize: 32, fontWeight: 700, color: riskColor, lineHeight: 1 }}>{Math.round(projected)} min</div>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)', marginTop: 6 }}>
                Baseline: {Math.round(baseline)} min · {benchmarkLabel}
              </div>
            </div>
            <div style={{
              padding: '8px 20px', borderRadius: 'var(--radius-full)',
              background: `${riskColor}1a`, color: riskColor,
              fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-semibold)',
              flexShrink: 0,
            }}>
              {risk}
            </div>
          </div>
          <div style={{
            padding: 'var(--space-3) var(--space-5)',
            borderTop: '1px solid var(--surface-border)',
            background: 'var(--color-gray-50)',
          }}>
            <p style={{ fontSize: 11, color: 'var(--color-gray-400)', margin: 0 }}>
              Values shown are average effects from the EBM model. Actual outcomes vary by individual case.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ─── Atlas Page ────────────────────────────────────────────────────────────── */

export default function AtlasFCOT() {
  const [model,         setModel]         = useState(null)
  const [loading,       setLoading]       = useState(true)
  const [error,         setError]         = useState('')
  const [noAtlasData,   setNoAtlasData]   = useState(false)
  const [selectedFeat,  setSelectedFeat]  = useState(null)
  const [activeTab,     setActiveTab]     = useState('drivers')
  const [combos,        setCombos]        = useState([])
  const [combosLoading, setCombosLoading] = useState(true)
  const [combosError,   setCombosError]   = useState('')
  const [combosMean,    setCombosMean]    = useState(null)
  const [comboFilter,   setComboFilter]   = useState(null)

  useEffect(() => {
    setLoading(true)
    setError('')
    fetch('/api/atlas/fcot-model')
      .then(r => {
        if (!r.ok) return r.json().then(d => Promise.reject(new Error(d.error || `HTTP ${r.status}`)))
        return r.json()
      })
      .then(data => {
        if (data.error === 'no_atlas_data') { setNoAtlasData(true); return; }
        setModel(data)
        const first = data.feature_importance?.[0]?.feature
        if (first) setSelectedFeat(first)
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))

    fetch('/api/atlas/fcot-combinations')
      .then(r => {
        if (!r.ok) return r.json().then(d => Promise.reject(new Error(d.error || `HTTP ${r.status}`)))
        return r.json()
      })
      .then(data => {
        setCombos(data.combinations ?? [])
        setCombosMean(data.system_mean ?? null)
      })
      .catch(err => setCombosError(err.message))
      .finally(() => setCombosLoading(false))
  }, [])

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
          : (selectedSF.x_values?.[i] != null ? Number(selectedSF.x_values[i]).toFixed(1) : String(i)),
        score: scores[i],
      }))
      .filter(e => !SF_LABEL_FILTER.has(e.label))
  }, [selectedSF])

  const sfMaxAbs = useMemo(
    () => Math.max(...sfEntries.map(e => Math.abs(e.score)), 0.001),
    [sfEntries],
  )

  if (noAtlasData) {
    return (
      <div className="page" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 320 }}>
        <div style={{ textAlign: 'center', color: 'var(--color-gray-400)', maxWidth: 420 }}>
          <BarChart3 size={40} style={{ margin: '0 auto var(--space-4)', opacity: 0.25 }} />
          <p style={{ fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-gray-600)', marginBottom: 8, fontSize: 'var(--font-size-base)' }}>
            No Atlas data for this organization
          </p>
          <p style={{ fontSize: 'var(--font-size-sm)', lineHeight: 1.6 }}>
            Atlas model data has not been generated yet. Run the pipeline for this organization to generate insights.
          </p>
        </div>
      </div>
    )
  }

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
            <div style={{ fontWeight: 'var(--font-weight-semibold)', marginBottom: 2 }}>Could not load model</div>
            <div>{error}</div>
            <div style={{ marginTop: 6, color: '#ef4444' }}>
              Run <code>python ebm_pipeline.py</code> to generate the model file.
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (!model) return null

  return (
    <div className="page">
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* ─── Tab bar ──────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--surface-border)', marginBottom: 'var(--space-6)' }}>
        {TABS.map(tab => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            style={{
              background: 'none', border: 'none',
              borderBottom: activeTab === tab.id ? '2px solid var(--color-blue)' : '2px solid transparent',
              cursor: 'pointer',
              padding: 'var(--space-3) var(--space-4)',
              fontSize: 'var(--font-size-sm)',
              fontWeight: activeTab === tab.id ? 'var(--font-weight-semibold)' : 'var(--font-weight-medium)',
              color: activeTab === tab.id ? 'var(--color-blue)' : 'var(--color-gray-500)',
              marginBottom: -1, transition: 'color 150ms',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ─── Drivers tab ──────────────────────────────────────────────────────── */}
      {activeTab === 'drivers' && (
        <>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 'var(--space-4)', marginBottom: 'var(--space-6)',
          }}>
            <StatCard label="Cases Analyzed"   value={model.n_training_samples?.toLocaleString() ?? '—'} sub="OR cases analyzed" />
            <StatCard label="Median FCOT Delay" value={model.system_median != null ? `${model.system_median} min` : '—'} sub="Midpoint across all cases" />
            <StatCard label="Mean FCOT Delay"   value={model.system_mean != null ? `${model.system_mean} min` : '—'} sub="Average across all cases" />
            <StatCard label="Top Driver"        value={model.feature_importance?.[0]?.feature ? featName(model.feature_importance[0].feature) : '—'} sub="Highest importance factor" />
          </div>

          <div style={{
            display: 'grid', gridTemplateColumns: '340px 1fr',
            gap: 'var(--space-5)', marginBottom: 'var(--space-6)', alignItems: 'start',
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
                  <div className="card-title">What drives FCOT variance</div>
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
                          flex: 1, fontSize: 'var(--font-size-sm)',
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
                      <div className="card-title">How <em>{featName(selectedSF.feature)}</em> affects start time</div>
                      <div className="card-subtitle">
                        Values show minutes above (red) or below (blue) the system average{model.system_mean != null ? ` of ${model.system_mean} min` : ''}
                      </div>
                    </div>
                  </div>
                  <div className="card-body">
                    {sfEntries.length === 0 ? (
                      <div style={{ textAlign: 'center', color: 'var(--color-gray-400)', padding: 'var(--space-8) 0' }}>No shape data available</div>
                    ) : (
                      <div style={{ position: 'relative', padding: '16px 0' }}>
                        <div style={{
                          position: 'absolute', left: 392, top: 0, bottom: 0,
                          width: 1, background: 'var(--color-gray-200)',
                          zIndex: 0, pointerEvents: 'none',
                        }} />
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

          {/* High-impact combinations */}
          <FCOTCombinationsSection
            combinations={model.combinations}
            systemMean={model.system_mean}
          />
        </>
      )}

      {/* ─── Combinations tab ─────────────────────────────────────────────────── */}
      {activeTab === 'combinations' && (
        <CombinationsTab
          combos={combos}
          combosLoading={combosLoading}
          combosError={combosError}
          combosMean={combosMean}
          model={model}
          filter={comboFilter}
          onFilterChange={setComboFilter}
        />
      )}

      {/* ─── Explorer tab ─────────────────────────────────────────────────────── */}
      {activeTab === 'explorer' && (
        <ExplorerTab
          model={model}
          metric="FCOT Delay"
          benchmark={15}
          benchmarkLabel="15 min aspirational target"
        />
      )}
    </div>
  )
}

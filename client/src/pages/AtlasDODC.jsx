import { useState, useEffect, useMemo } from 'react'
import { Brain, BarChart3, Database, AlertCircle } from 'lucide-react'

/* ─── Constants ──────────────────────────────────────────────────────────────── */

const BADGE_THRESHOLD = { HIGH: 3, MED: 6 }
const SF_LABEL_FILTER = new Set(['-0.75', '-1.0', '-1'])

const FEAT_NAMES = {
  DEST_CATEGORY:          'Discharging Unit',
  DAY_OF_WEEK:            'Day of Week',
  ACCOUNT_FINANCIALCLASS: 'Financial Class',
  DRG_FINALDRGMDC:        'Diagnostic Category',
  ENC_PATCLASSBASE:       'Patient Class',
  QUARTER:                'Quarter',
  HOSPITAL_CENSUS_7AM:    'Hospital Census 7am',
  ENC_DISCHDISPO:         'Disposition',
}

const TABS = [
  { id: 'overall',  label: 'Overall' },
  { id: 'home',     label: 'Home' },
  { id: 'snf',      label: 'SNF' },
  { id: 'hh',       label: 'Home Health' },
  { id: 'scenario', label: 'Scenario Builder' },
]

const MODEL_KEYS = ['overall', 'home', 'snf', 'hh']
const ENDPOINTS = {
  overall: '/api/atlas/do-dc-overall',
  home:    '/api/atlas/do-dc-home',
  snf:     '/api/atlas/do-dc-snf',
  hh:      '/api/atlas/do-dc-hh',
}
const BENCHMARKS = { overall: 400, home: 180, snf: 400, hh: 240 }

const SCENARIO_FEATURES = [
  { key: 'ACCOUNT_FINANCIALCLASS', label: 'Financial Class' },
  { key: 'DAY_OF_WEEK',            label: 'Day of Week' },
  { key: 'DEST_CATEGORY',          label: 'Discharging Unit' },
  { key: 'QUARTER',                label: 'Quarter' },
  { key: 'ENC_PATCLASSBASE',       label: 'Patient Class' },
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
  const valLabel = `${isPos ? '+' : '−'}${Math.abs(score).toFixed(1)} min`

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

/* ─── Stat card configs per tab ──────────────────────────────────────────────── */

function getStatCards(tabKey, model) {
  const n      = model ? Math.round((model.n_training_samples ?? 0) / 0.8).toLocaleString() : '—'
  const mean   = model?.system_mean   != null ? `${model.system_mean} min`   : '—'
  const median = model?.system_median != null ? `${model.system_median} min` : '—'
  const top    = model?.feature_importance?.[0]?.feature

  switch (tabKey) {
    case 'overall': return [
      { label: 'Cases Analyzed', value: n,                          sub: 'All dispositions' },
      { label: 'Median DO→DC',   value: median,                     sub: 'Median across all cases' },
      { label: 'Mean DO→DC',     value: mean,                       sub: 'Average across all cases' },
      { label: 'Top Driver',     value: top ? featName(top) : '—', sub: 'Highest importance factor' },
    ]
    case 'home': return [
      { label: 'Cases Analyzed',      value: n,         sub: 'Home discharge' },
      { label: 'Median DO→DC',        value: median,    sub: 'Home patients' },
      { label: 'Benchmark',           value: '180 min', sub: 'Target DO→DC time', accent: 'var(--color-blue)' },
      { label: '% Meeting Benchmark', value: '58%',     sub: 'Departures within 180 min' },
    ]
    case 'snf': return [
      { label: 'Cases Analyzed',      value: n,         sub: 'SNF discharge' },
      { label: 'Median DO→DC',        value: median,    sub: 'SNF patients' },
      { label: 'Benchmark',           value: '400 min', sub: 'Target DO→DC time', accent: 'var(--color-blue)' },
      { label: '% Meeting Benchmark', value: '35%',     sub: 'Departures within 400 min' },
    ]
    case 'hh': return [
      { label: 'Cases Analyzed',      value: n,         sub: 'Home health discharge' },
      { label: 'Median DO→DC',        value: median,    sub: 'Home health patients' },
      { label: 'Benchmark',           value: '240 min', sub: 'Target DO→DC time', accent: 'var(--color-blue)' },
      { label: '% Meeting Benchmark', value: '50%',     sub: 'Departures within 240 min' },
    ]
    default: return []
  }
}

/* ─── Combinations table ─────────────────────────────────────────────────────── */

function CombinationsSection({ combinations, systemMean }) {
  if (!combinations?.length) return null

  const maxAvg = Math.max(...combinations.map(c => c.avg_do_to_dc), 1)
  const meanPct = systemMean != null ? (systemMean / maxAvg) * 100 : null

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
          Combinations of factors associated with the longest DO→DC times. Minimum 250 cases.
        </p>
      </div>

      <div className="card">
        {/* Column headers */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
          padding: 'var(--space-2) var(--space-4)',
          borderBottom: '1px solid var(--surface-border)',
        }}>
          <div style={{ width: 28, flexShrink: 0 }} />
          <div style={{ flex: 1, fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)', fontWeight: 'var(--font-weight-semibold)' }}>
            Combination
          </div>
          <div style={{ width: 240, flexShrink: 0, fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)', fontWeight: 'var(--font-weight-semibold)' }}>
            Above mean
          </div>
          <div style={{ width: 100, flexShrink: 0, fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)', fontWeight: 'var(--font-weight-semibold)', textAlign: 'right' }}>
            Avg DO→DC
          </div>
          <div style={{ width: 72, flexShrink: 0, fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)', fontWeight: 'var(--font-weight-semibold)', textAlign: 'right' }}>
            Cases
          </div>
        </div>

        {combinations.map((combo, i) => {
          const barPct    = (combo.avg_do_to_dc / maxAvg) * 100
          const aboveMean = combo.avg_do_to_dc - (systemMean ?? 0)

          return (
            <div
              key={i}
              style={{
                display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
                padding: 'var(--space-3) var(--space-4)',
                borderBottom: i < combinations.length - 1 ? '1px solid var(--surface-border)' : 'none',
              }}
            >
              <div style={{
                width: 28, flexShrink: 0,
                fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)',
                fontVariantNumeric: 'tabular-nums', textAlign: 'right',
              }}>
                {i + 1}
              </div>

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

              {/* Bar + above-mean label */}
              <div style={{ width: 240, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <div style={{
                  flex: 1, height: 8,
                  background: 'var(--color-gray-100)',
                  borderRadius: 4, overflow: 'hidden', position: 'relative',
                }}>
                  <div style={{
                    height: '100%', width: `${barPct}%`,
                    background: '#ef4444', borderRadius: 4,
                  }} />
                  {/* System mean reference line */}
                  {meanPct != null && (
                    <div style={{
                      position: 'absolute', top: 0, bottom: 0,
                      left: `${meanPct}%`,
                      width: 2, background: '#94a3b8',
                    }} />
                  )}
                </div>
                <div style={{
                  width: 60, flexShrink: 0,
                  fontSize: 'var(--font-size-xs)', fontWeight: 'var(--font-weight-semibold)',
                  color: '#ef4444', textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                }}>
                  +{Math.round(aboveMean)} min
                </div>
              </div>

              <div style={{
                width: 100, flexShrink: 0,
                fontSize: 'var(--font-size-sm)', color: 'var(--color-gray-700)',
                textAlign: 'right', fontVariantNumeric: 'tabular-nums',
              }}>
                {combo.avg_do_to_dc} min
              </div>

              <div style={{
                width: 72, flexShrink: 0,
                fontSize: 'var(--font-size-sm)', color: 'var(--color-gray-700)',
                textAlign: 'right', fontVariantNumeric: 'tabular-nums',
              }}>
                {combo.cnt.toLocaleString()}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ─── Model tab content (tabs 1–4) ───────────────────────────────────────────── */

function ModelTabContent({ tabKey, model, loading, error, selectedFeat, onSelectFeat }) {
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
      .filter(e => !isBadLabel(e.label))
  }, [selectedSF])

  const sfMaxAbs = useMemo(
    () => Math.max(...sfEntries.map(e => Math.abs(e.score)), 0.001),
    [sfEntries],
  )

  const statCards = getStatCards(tabKey, model)

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 280 }}>
        <Spinner label="Loading model…" />
      </div>
    )
  }

  if (error) {
    return (
      <ErrorBanner
        message={error}
        hint={`Run python do_dc_pipeline.py to generate the ${tabKey} model file.`}
      />
    )
  }

  if (!model) return null

  return (
    <>
      {/* Section 1: stat cards */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 'var(--space-4)',
        marginBottom: 'var(--space-6)',
      }}>
        {statCards.map((card, i) => (
          <StatCard key={i} {...card} />
        ))}
      </div>

      {/* Section 2: driver list + shape panel */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '340px 1fr',
        gap: 'var(--space-5)',
        marginBottom: 'var(--space-6)',
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
              <div className="card-title">What drives DO→DC time</div>
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
                  onClick={() => onSelectFeat(f.feature)}
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
                    How <em>{featName(selectedSF.feature)}</em> affects DO→DC time
                  </div>
                  <div className="card-subtitle">
                    Values show minutes above (red) or below (blue) the system average{model.system_mean != null ? ` of ${model.system_mean} min` : ''}
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
                    {/* Full-height zero line spanning all rows */}
                    <div style={{
                      position: 'absolute', left: 392, top: 0, bottom: 0,
                      width: 1, background: 'var(--color-gray-200)',
                      zIndex: 0, pointerEvents: 'none',
                    }} />
                    {/* Avg label at top of zero line */}
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

      {/* Section 3: combinations */}
      <CombinationsSection
        combinations={model.combinations}
        systemMean={model.system_mean}
      />
    </>
  )
}

/* ─── Waterfall chart ────────────────────────────────────────────────────────── */

function WaterfallChart({ baseline, contributions, benchmark, projected }) {
  const BAR_H    = 28
  const LABEL_W  = 190
  const CHART_W  = 340
  const VALUE_W  = 80
  const ROW_H    = 46
  const SVG_W    = LABEL_W + CHART_W + VALUE_W

  // Build waterfall rows
  const rows = []
  let running = baseline

  rows.push({
    label:    'Baseline (SNF mean)',
    barStart: 0,
    barEnd:   baseline,
    delta:    null,
    running:  baseline,
    isTotal:  false,
    isBase:   true,
  })

  for (const c of contributions) {
    const start = running
    const end   = running + c.score
    rows.push({
      label:    `${c.label}: ${c.optionLabel}`,
      barStart: Math.min(start, end),
      barEnd:   Math.max(start, end),
      delta:    c.score,
      running:  end,
      isTotal:  false,
      isBase:   false,
    })
    running = end
  }

  rows.push({
    label:    'Projected',
    barStart: 0,
    barEnd:   projected,
    delta:    null,
    running:  projected,
    isTotal:  true,
    isBase:   false,
  })

  const SVG_H  = rows.length * ROW_H + 24
  const maxVal = Math.max(projected, baseline, benchmark) * 1.12
  const xs     = v => LABEL_W + (v / maxVal) * CHART_W
  const bx     = xs(benchmark)

  let totalColor
  if (projected <= benchmark)             totalColor = '#22c55e'
  else if (projected <= benchmark * 1.5)  totalColor = '#f59e0b'
  else if (projected <= benchmark * 2.0)  totalColor = '#f97316'
  else                                    totalColor = '#ef4444'

  return (
    <svg width={SVG_W} height={SVG_H} style={{ display: 'block', overflow: 'visible' }}>
      {/* Benchmark dashed line */}
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
            {/* Connector line to next row (for delta bars only) */}
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

/* ─── Scenario Builder (Tab 5) ───────────────────────────────────────────────── */

function ScenarioBuilder({ snfModel, snfLoading, snfError }) {
  const [selections, setSelections] = useState(
    Object.fromEntries(SCENARIO_FEATURES.map(f => [f.key, null]))
  )

  if (snfLoading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 280 }}>
        <Spinner label="Loading SNF model…" />
      </div>
    )
  }

  if (snfError) {
    return <ErrorBanner message={snfError} hint="Run python do_dc_pipeline.py to generate the SNF model file." />
  }

  if (!snfModel) return null

  const baseline = snfModel.system_mean ?? 400
  const sfMap    = Object.fromEntries(
    (snfModel.shape_functions ?? []).map(sf => [sf.feature, sf])
  )

  const contributions = SCENARIO_FEATURES
    .filter(f => selections[f.key] !== null)
    .map(f => ({ ...f, ...selections[f.key] }))

  const projected = baseline + contributions.reduce((s, c) => s + c.score, 0)

  let risk, riskColor
  if (projected <= 400)       { risk = 'Within target'; riskColor = '#22c55e' }
  else if (projected <= 600)  { risk = 'Moderate';      riskColor = '#f59e0b' }
  else if (projected <= 800)  { risk = 'High';           riskColor = '#f97316' }
  else                        { risk = 'Severe';          riskColor = '#ef4444' }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 'var(--space-5)', alignItems: 'start' }}>

      {/* Left: dropdowns */}
      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title">Configure Scenario</div>
            <div className="card-subtitle">SNF model · Select factors to see their combined effect</div>
          </div>
        </div>
        <div style={{ padding: '0 var(--space-4) var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          {SCENARIO_FEATURES.map(f => {
            const sf = sfMap[f.key]
            if (!sf) return null
            const options = (sf.x_labels ?? [])
              .map((label, i) => ({ label, score: sf.y_scores?.[i] ?? 0 }))
              .filter(o => o.label && !isBadLabel(o.label))

            return (
              <div key={f.key}>
                <label style={{
                  fontSize: 'var(--font-size-xs)',
                  color: 'var(--color-gray-500)',
                  display: 'block',
                  marginBottom: 4,
                  fontWeight: 'var(--font-weight-medium)',
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
                    width: '100%',
                    padding: '8px var(--space-3)',
                    fontSize: 'var(--font-size-sm)',
                    border: '1px solid var(--surface-border)',
                    borderRadius: 'var(--radius-md)',
                    background: 'var(--surface-card)',
                    color: 'var(--color-gray-700)',
                    cursor: 'pointer',
                    appearance: 'auto',
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
              onClick={() => setSelections(Object.fromEntries(SCENARIO_FEATURES.map(f => [f.key, null])))}
              style={{
                background: 'none', border: '1px solid var(--surface-border)',
                borderRadius: 'var(--radius-md)', cursor: 'pointer',
                padding: '6px var(--space-3)',
                fontSize: 'var(--font-size-xs)',
                color: 'var(--color-gray-500)',
              }}
            >
              Clear all
            </button>
          )}
        </div>
      </div>

      {/* Right: waterfall + result */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">Projected DO→DC Time</div>
              <div className="card-subtitle">Each bar shows the average effect of that factor. Dashed line = 400 min benchmark.</div>
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
                contributions={contributions}
                benchmark={400}
                projected={projected}
              />
            )}
          </div>
        </div>

        {/* Result summary */}
        <div className="card">
          <div style={{ padding: 'var(--space-5)', display: 'flex', alignItems: 'center', gap: 'var(--space-5)' }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)', marginBottom: 4 }}>
                Projected DO→DC
              </div>
              <div style={{ fontSize: 32, fontWeight: 700, color: riskColor, lineHeight: 1 }}>
                {Math.round(projected)} min
              </div>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)', marginTop: 6 }}>
                Baseline: {Math.round(baseline)} min · Benchmark: 400 min
              </div>
            </div>
            <div style={{
              padding: '8px 20px',
              borderRadius: 'var(--radius-full)',
              background: `${riskColor}1a`,
              color: riskColor,
              fontSize: 'var(--font-size-sm)',
              fontWeight: 'var(--font-weight-semibold)',
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
              Values shown are average effects from the EBM model. Actual outcomes vary by individual patient.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ─── Main page component ────────────────────────────────────────────────────── */

export default function AtlasDODC() {
  const [models,   setModels]   = useState({ overall: null, home: null, snf: null, hh: null })
  const [loadings, setLoadings] = useState({ overall: true, home: true, snf: true, hh: true })
  const [errors,   setErrors]   = useState({ overall: '', home: '', snf: '', hh: '' })
  const [activeTab, setActiveTab] = useState('overall')
  const [selectedFeats, setSelectedFeats] = useState({ overall: null, home: null, snf: null, hh: null })

  useEffect(() => {
    MODEL_KEYS.forEach(key => {
      fetch(ENDPOINTS[key])
        .then(r => r.ok ? r.json() : r.json().then(d => Promise.reject(new Error(d.error || `HTTP ${r.status}`))))
        .then(data => {
          setModels(prev => ({ ...prev, [key]: data }))
          const first = data.feature_importance?.[0]?.feature
          if (first) setSelectedFeats(prev => ({ ...prev, [key]: first }))
        })
        .catch(err => setErrors(prev => ({ ...prev, [key]: err.message })))
        .finally(() => setLoadings(prev => ({ ...prev, [key]: false })))
    })
  }, [])

  function setSelectedFeat(tabKey, feat) {
    setSelectedFeats(prev => ({ ...prev, [tabKey]: feat }))
  }

  return (
    <div className="page">
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* ── Tab bar ── */}
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

      {/* ── Model tabs (Overall / Home / SNF / Home Health) ── */}
      {MODEL_KEYS.includes(activeTab) && (
        <ModelTabContent
          tabKey={activeTab}
          model={models[activeTab]}
          loading={loadings[activeTab]}
          error={errors[activeTab]}
          selectedFeat={selectedFeats[activeTab]}
          onSelectFeat={feat => setSelectedFeat(activeTab, feat)}
        />
      )}

      {/* ── Scenario Builder ── */}
      {activeTab === 'scenario' && (
        <ScenarioBuilder
          snfModel={models.snf}
          snfLoading={loadings.snf}
          snfError={errors.snf}
        />
      )}
    </div>
  )
}

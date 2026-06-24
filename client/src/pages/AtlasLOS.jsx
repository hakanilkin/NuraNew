import { useState, useEffect, useMemo } from 'react'
import { BarChart3, AlertCircle, Info } from 'lucide-react'

/* ─── Constants ────────────────────────────────────────────────────────────── */

const BADGE_THRESHOLD = { HIGH: 3, MED: 6 }
const SF_LABEL_FILTER = new Set(['-0.75', '-1.0', '-1'])

const FEAT_NAMES = {
  SERVICE_LINE:           'Service line',
  DEST_CATEGORY:          'Discharging unit',
  ACCOUNT_FINANCIALCLASS: 'Financial class',
  ENC_DISCHDISPO:         'Discharge disposition',
  ENC_ADMISSIONTYPE:      'Admission type',
  DAY_OF_WEEK:            'Admission day of week',
  QUARTER:                'Quarter',
  ADMISSION_HOUR_BUCKET:  'Admission hour',
  HOSPITAL_CENSUS_7AM:    'Hospital census at 7am',
  DRG_FINALDRGMDC:        'MDC category',
  DRG_FINALDRGWEIGHT:     'DRG weight',
}

const TABS = [
  { id: 'overall',     label: 'Overall' },
  { id: 'facility',    label: 'Facility-bound' },
  { id: 'selfcare',    label: 'Self-care Home' },
  { id: 'homehealth',  label: 'Home Health' },
  { id: 'explorer',    label: 'Explorer' },
]

const MODEL_KEYS = ['overall', 'facility', 'selfcare', 'homehealth']
const ENDPOINTS  = {
  overall:    '/api/atlas/do-los-overall',
  facility:   '/api/atlas/do-los-facility',
  selfcare:   '/api/atlas/do-los-selfcare',
  homehealth: '/api/atlas/do-los-homehealth',
}

const TAB_CONTEXT_NOTE = {
  selfcare:   'Self-care discharges typically leave at or before expected LOS — excess here is minimal.',
  homehealth: 'Home-health discharges average nearly a day over expected. Drivers are diffuse across structured factors, consistent with discharge-coordination overhead (DME, home nursing setup) rather than clinical or payer mix.',
}

/* ─── Helpers ──────────────────────────────────────────────────────────────── */

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

function fmtDays(v, signed = false) {
  if (v == null || isNaN(parseFloat(v))) return '—'
  const n   = parseFloat(v)
  const abs = Math.abs(n).toFixed(1)
  if (!signed) return `${n < 0 ? '-' : ''}${abs}d`
  return `${n >= 0 ? '+' : '-'}${abs}d`
}

function formatShapeLabel(feature, rawValue) {
  const v = parseFloat(rawValue)
  if (isNaN(v)) return String(rawValue)
  if (feature === 'HOSPITAL_CENSUS_7AM') return String(Math.round(v))
  if (feature === 'DRG_FINALDRGWEIGHT')  return v.toFixed(1)
  return v.toFixed(1)
}

/* ─── Shared sub-components ────────────────────────────────────────────────── */

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
  const valLabel = `${isPos ? '+' : '−'}${Math.abs(score).toFixed(1)}d`

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

/* ─── Stat card configs per tab ────────────────────────────────────────────── */

function getStatCards(tabKey, model) {
  if (!model) return []
  const n      = Math.round((model.n_training_samples ?? 0) / 0.8).toLocaleString()
  const median = model.system_median != null ? fmtDays(model.system_median) : '—'
  const mean   = model.system_mean   != null ? fmtDays(model.system_mean)   : '—'
  const total  = model.total_excess_days != null
    ? `${Math.round(model.total_excess_days).toLocaleString()}d`
    : '—'
  const beds   = model.effective_beds != null ? String(model.effective_beds) : '—'

  const subLabels = {
    overall:    'All acute discharges',
    facility:   'Facility-bound discharges',
    selfcare:   'Self-care home discharges',
    homehealth: 'Home health discharges',
  }

  return [
    { label: 'Cases',             value: n,      sub: subLabels[tabKey] ?? '' },
    { label: 'Median excess',     value: median, sub: 'Median vs DRG expectation' },
    { label: 'Mean excess',       value: mean,   sub: 'Average vs DRG expectation' },
    { label: 'Total excess days', value: total,  sub: 'Aggregate across all cases' },
    { label: 'Effective beds',    value: beds,   sub: 'beds consumed every day' },
  ]
}

/* ─── Rehab info banner (Overall tab only) ──────────────────────────────────── */

function RehabBanner({ rehab }) {
  if (!rehab || !rehab.n_cases) return null
  const beds = rehab.total_excess_days != null
    ? (rehab.total_excess_days / 365).toFixed(1)
    : '—'
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 'var(--space-3)',
      padding: 'var(--space-3) var(--space-4)',
      background: '#EEF0FD',
      borderRadius: 'var(--radius-lg)',
      marginBottom: 'var(--space-5)',
      fontSize: 12,
      color: '#3730a3',
      lineHeight: 1.5,
    }}>
      <Info size={14} style={{ flexShrink: 0, marginTop: 2, color: '#4f46e5' }} />
      <span>
        Rehab-unit discharges are reported separately:{' '}
        <strong>{(rehab.n_cases).toLocaleString()}</strong> cases averaging{' '}
        <strong>{fmtDays(rehab.mean_excess)}</strong> excess days (
        <strong>
          {rehab.total_excess_days != null
            ? Math.round(rehab.total_excess_days).toLocaleString()
            : '—'}
        </strong>{' '}
        total days ≈ <strong>{beds}</strong> beds). Their stays include inpatient rehab days the
        DRG expectation does not price in — structural, not operational, excess.
      </span>
    </div>
  )
}

/* ─── Combinations table ────────────────────────────────────────────────────── */

function CombinationsSection({ combinations }) {
  if (!combinations?.length) return null

  const maxTotal = Math.max(...combinations.map(c => c.total_excess_days ?? 0), 1)

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
          Ranked by total excess days (average × volume) — a prioritization guide, not a severity ranking. Minimum 150 cases.
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
          <div style={{ width: 220, flexShrink: 0, fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)', fontWeight: 'var(--font-weight-semibold)' }}>
            Total excess days
          </div>
          <div style={{ width: 96, flexShrink: 0, fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)', fontWeight: 'var(--font-weight-semibold)', textAlign: 'right' }}>
            Avg excess
          </div>
          <div style={{ width: 96, flexShrink: 0, fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)', fontWeight: 'var(--font-weight-semibold)', textAlign: 'right' }}>
            Above mean
          </div>
          <div style={{ width: 72, flexShrink: 0, fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)', fontWeight: 'var(--font-weight-semibold)', textAlign: 'right' }}>
            Cases
          </div>
        </div>

        {combinations.map((combo, i) => {
          const barPct = ((combo.total_excess_days ?? 0) / maxTotal) * 100
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

              {/* Bar scaled to max total_excess_days */}
              <div style={{ width: 220, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <div style={{
                  flex: 1, height: 8,
                  background: 'var(--color-gray-100)',
                  borderRadius: 4, overflow: 'hidden',
                }}>
                  <div style={{ height: '100%', width: `${barPct}%`, background: '#ef4444', borderRadius: 4 }} />
                </div>
                <div style={{
                  width: 64, flexShrink: 0,
                  fontSize: 'var(--font-size-xs)', fontWeight: 'var(--font-weight-semibold)',
                  color: '#ef4444', textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                }}>
                  {combo.total_excess_days != null
                    ? `${Math.round(combo.total_excess_days).toLocaleString()}d`
                    : '—'}
                </div>
              </div>

              <div style={{
                width: 96, flexShrink: 0,
                fontSize: 'var(--font-size-sm)', color: 'var(--color-gray-700)',
                textAlign: 'right', fontVariantNumeric: 'tabular-nums',
              }}>
                {fmtDays(combo.avg_excess)}
              </div>

              <div style={{
                width: 96, flexShrink: 0,
                fontSize: 'var(--font-size-sm)', color: '#ef4444',
                textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                fontWeight: 'var(--font-weight-medium)',
              }}>
                {combo.above_mean != null ? `+${combo.above_mean.toFixed(1)}d` : '—'}
              </div>

              <div style={{
                width: 72, flexShrink: 0,
                fontSize: 'var(--font-size-sm)', color: 'var(--color-gray-700)',
                textAlign: 'right', fontVariantNumeric: 'tabular-nums',
              }}>
                {(combo.n_cases ?? 0).toLocaleString()}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ─── Model tab content ─────────────────────────────────────────────────────── */

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
          : (selectedSF.x_values?.[i] != null
              ? formatShapeLabel(selectedSF.feature, selectedSF.x_values[i])
              : String(i)),
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
        hint="Run python do_los_pipeline.py to generate the model file."
      />
    )
  }

  if (!model) return null

  return (
    <>
      {/* Stat cards — 5 columns */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(5, 1fr)',
        gap: 'var(--space-4)',
        marginBottom: 'var(--space-5)',
      }}>
        {statCards.map((card, i) => (
          <StatCard key={i} {...card} />
        ))}
      </div>

      {/* Context note (selfcare / homehealth tabs) */}
      {TAB_CONTEXT_NOTE[tabKey] && (
        <p style={{
          fontSize: 'var(--font-size-sm)',
          color: 'var(--color-gray-400)',
          marginBottom: 'var(--space-5)',
          lineHeight: 1.5,
        }}>
          {TAB_CONTEXT_NOTE[tabKey]}
        </p>
      )}

      {/* Rehab banner (overall only) */}
      {tabKey === 'overall' && model.rehab_unit_summary && (
        <RehabBanner rehab={model.rehab_unit_summary} />
      )}

      {/* Driver list + shape panel */}
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
              <div className="card-title">What drives excess LOS</div>
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
                    How <em>{featName(selectedSF.feature)}</em> affects excess LOS
                  </div>
                  <div className="card-subtitle">
                    Days above (red) or below (blue) the system average
                    {model.system_mean != null ? ` of ${fmtDays(model.system_mean)}` : ''}
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
                    <div style={{
                      position: 'absolute', left: 392, top: 0,
                      transform: 'translateX(-50%)',
                      fontSize: 9, color: 'var(--color-gray-400)',
                      whiteSpace: 'nowrap', fontWeight: 600, lineHeight: 1,
                    }}>
                      {model.system_mean != null ? `avg ${fmtDays(model.system_mean)}` : 'avg'}
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

      {/* Combinations */}
      <CombinationsSection combinations={model.combinations} />
    </>
  )
}

/* ─── Waterfall chart ───────────────────────────────────────────────────────── */

function WaterfallChart({ baseline, contributions, projected }) {
  const BAR_H   = 28
  const LABEL_W = 200
  const CHART_W = 340
  const VALUE_W = 80
  const ROW_H   = 46
  const SVG_W   = LABEL_W + CHART_W + VALUE_W

  const rows = []
  let running = baseline

  rows.push({
    label:    `System mean (${fmtDays(baseline)})`,
    barStart: 0,
    barEnd:   baseline,
    delta:    null,
    running:  baseline,
    isBase:   true,
    isTotal:  false,
  })

  for (const c of contributions) {
    const start = running
    const end   = running + c.score
    rows.push({
      label:    `${c.featureLabel}: ${c.optionLabel}`,
      barStart: Math.min(start, end),
      barEnd:   Math.max(start, end),
      delta:    c.score,
      running:  end,
      isBase:   false,
      isTotal:  false,
    })
    running = end
  }

  rows.push({
    label:    'Projected',
    barStart: Math.min(0, projected),
    barEnd:   Math.max(0, projected),
    delta:    null,
    running:  projected,
    isBase:   false,
    isTotal:  true,
  })

  const SVG_H = rows.length * ROW_H + 24

  // Scale that handles negative projected values
  const minV  = Math.min(0, projected, ...rows.map(r => r.barStart)) * 1.05
  const maxV  = Math.max(0.01, projected, baseline, ...rows.map(r => r.barEnd)) * 1.15
  const range = maxV - minV || 0.1
  const xScale = v => LABEL_W + ((v - minV) / range) * CHART_W
  const zeroX  = xScale(0)

  let totalColor
  if (projected < 0)        totalColor = '#22c55e'
  else if (projected <= 2)  totalColor = '#3b82f6'
  else if (projected <= 5)  totalColor = '#f59e0b'
  else                      totalColor = '#ef4444'

  return (
    <svg width={SVG_W} height={SVG_H} style={{ display: 'block', overflow: 'visible' }}>
      {/* Zero reference line */}
      <line x1={zeroX} y1={0} x2={zeroX} y2={SVG_H - 20} stroke="#cbd5e1" strokeWidth={1} />
      <text x={zeroX} y={SVG_H - 6} textAnchor="middle" fontSize={9} fill="#94a3b8" fontWeight={600}>
        0d
      </text>

      {rows.map((row, i) => {
        const y   = i * ROW_H
        const x1  = xScale(row.barStart)
        const x2  = xScale(row.barEnd)
        const bx  = Math.min(x1, x2)
        const bw  = Math.max(Math.abs(x2 - x1), 3)

        let fill
        if (row.isTotal)     fill = totalColor
        else if (row.isBase) fill = '#94a3b8'
        else                 fill = (row.delta ?? 0) >= 0 ? '#ef4444' : '#3b82f6'

        const valLabel = row.delta === null
          ? fmtDays(row.running)
          : fmtDays(row.delta, true)

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
            <rect x={bx} y={y} width={bw} height={BAR_H} fill={fill} rx={3} opacity={row.isTotal ? 1 : 0.85} />
            {/* Connector to next row for delta bars */}
            {i < rows.length - 1 && !row.isBase && !row.isTotal && (
              <line
                x1={xScale(row.running)} y1={y + BAR_H}
                x2={xScale(row.running)} y2={(i + 1) * ROW_H}
                stroke="#cbd5e1" strokeWidth={1}
              />
            )}
            <text
              x={bx + bw + 6} y={y + BAR_H / 2 + 4}
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

/* ─── Explorer tab ──────────────────────────────────────────────────────────── */

function ExplorerTab({ model, loading, error }) {
  const [selections, setSelections] = useState({})

  const catFeatures = useMemo(() => {
    if (!model?.shape_functions) return []
    return model.shape_functions
      .filter(sf => {
        const labels = sf.x_labels ?? []
        return labels.length > 0 && labels.some(l => isNaN(parseFloat(String(l))))
      })
      .map(sf => ({ key: sf.feature, label: featName(sf.feature), sf }))
  }, [model])

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 280 }}>
        <Spinner label="Loading overall model…" />
      </div>
    )
  }

  if (error) {
    return (
      <ErrorBanner
        message={error}
        hint="Run python do_los_pipeline.py to generate the overall model file."
      />
    )
  }

  if (!model) return null

  const baseline      = model.system_mean ?? 0
  const contributions = catFeatures
    .filter(f => selections[f.key])
    .map(f => ({
      featureLabel: f.label,
      optionLabel:  selections[f.key].label,
      score:        selections[f.key].score,
    }))

  const projected = baseline + contributions.reduce((s, c) => s + c.score, 0)

  let risk, riskColor
  if (projected < 0)        { risk = 'Faster than expected'; riskColor = '#22c55e' }
  else if (projected <= 2)  { risk = 'Near expectation';     riskColor = '#3b82f6' }
  else if (projected <= 5)  { risk = 'Elevated';             riskColor = '#f59e0b' }
  else                      { risk = 'High excess risk';      riskColor = '#ef4444' }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 'var(--space-5)', alignItems: 'start' }}>

      {/* Left: dropdowns */}
      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title">Configure Scenario</div>
            <div className="card-subtitle">Overall model · Select factors to see combined effect on excess LOS</div>
          </div>
        </div>
        <div style={{ padding: '0 var(--space-4) var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          {catFeatures.map(f => {
            const options = (f.sf.x_labels ?? [])
              .map((label, i) => ({ label, score: f.sf.y_scores?.[i] ?? 0 }))
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
                      {o.label}{'  '}({o.score >= 0 ? '+' : ''}{o.score.toFixed(2)}d)
                    </option>
                  ))}
                </select>
              </div>
            )
          })}

          {Object.values(selections).some(Boolean) && (
            <button
              type="button"
              onClick={() => setSelections({})}
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
              <div className="card-title">Projected Excess LOS</div>
              <div className="card-subtitle">Each bar shows the average effect of that factor on days beyond the DRG expectation.</div>
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
                Projected excess LOS
              </div>
              <div style={{ fontSize: 32, fontWeight: 700, color: riskColor, lineHeight: 1 }}>
                {projected.toFixed(1)} excess days
              </div>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)', marginTop: 6 }}>
                Baseline: {fmtDays(baseline)} system mean
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

/* ─── Main page component ───────────────────────────────────────────────────── */

export default function AtlasLOS() {
  const [models,       setModels]       = useState({ overall: null, facility: null, selfcare: null, homehealth: null })
  const [loadings,     setLoadings]     = useState({ overall: true,  facility: true,  selfcare: true,  homehealth: true })
  const [errors,       setErrors]       = useState({ overall: '',    facility: '',    selfcare: '',    homehealth: '' })
  const [activeTab,    setActiveTab]    = useState('overall')
  const [selectedFeats, setSelectedFeats] = useState({ overall: null, facility: null, selfcare: null, homehealth: null })

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

  return (
    <div className="page">
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* Page header */}
      <div style={{ marginBottom: 'var(--space-6)' }}>
        <h1 style={{
          fontSize: 'var(--font-size-2xl)',
          fontWeight: 'var(--font-weight-semibold)',
          color: 'var(--color-gray-900)',
          marginBottom: 'var(--space-1)',
        }}>
          Excess Length of Stay
        </h1>
        <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-gray-500)', maxWidth: 680 }}>
          Days beyond DRG-expected stay (observed LOS minus GMLOS) — clinical complexity is already priced into the expectation, so what remains is operational signal.
        </p>
      </div>

      {/* Tab bar */}
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

      {/* Model tabs */}
      {MODEL_KEYS.includes(activeTab) && (
        <ModelTabContent
          tabKey={activeTab}
          model={models[activeTab]}
          loading={loadings[activeTab]}
          error={errors[activeTab]}
          selectedFeat={selectedFeats[activeTab]}
          onSelectFeat={feat => setSelectedFeats(prev => ({ ...prev, [activeTab]: feat }))}
        />
      )}

      {/* Explorer tab */}
      {activeTab === 'explorer' && (
        <ExplorerTab
          model={models.overall}
          loading={loadings.overall}
          error={errors.overall}
        />
      )}
    </div>
  )
}

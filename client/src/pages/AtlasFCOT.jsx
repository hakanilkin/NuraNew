import { useState, useEffect, useMemo } from 'react'
import {
  Brain, Zap, BarChart3, GitMerge, Calendar, Database,
  AlertCircle, ChevronDown, RefreshCw, Mail,
} from 'lucide-react'

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

// EBM encoding artifacts — hide these x_labels from shape function and interaction displays
const SF_LABEL_FILTER = new Set(['-0.75', '-1.0', '-1'])

// Returns true for EBM artifact labels: exact-match entries above, or any raw negative number string
function isBadLabel(l) {
  const s = String(l).trim()
  return SF_LABEL_FILTER.has(s) || /^-\d+(\.\d+)?$/.test(s)
}

// Grouped-bar palette: [first binary value, second binary value]
const IX_COLORS = ['#93A8F4', '#E55353']

/* ─── Helpers ───────────────────────────────────────────────────────────────── */

function featName(f) {
  return FEAT_NAMES[f] ?? f.replace(/_/g, ' ')
}

function badge(rank) {
  if (rank <= BADGE_THRESHOLD.HIGH) return { label: 'High',   bg: 'rgba(239,68,68,0.12)',   color: '#dc2626' }
  if (rank <= BADGE_THRESHOLD.MED)  return { label: 'Medium', bg: 'rgba(234,179,8,0.12)',   color: '#b45309' }
  return                                   { label: 'Low',    bg: 'rgba(148,163,184,0.12)', color: '#64748b' }
}

function fmtDate(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  } catch { return iso }
}

function fmtMAE(v) {
  if (v == null) return '—'
  return `${Number(v).toFixed(1)} min`
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)) }

// Resolve axis labels from labels array (preferred) or values array (fallback)
function axisLabels(labels, values) {
  if (labels?.length) return labels.map(String)
  if (values?.length) return values.map(v => typeof v === 'number' ? v.toFixed(1) : String(v))
  return []
}

// Determine viz type: 'grouped' when either feature has exactly 2 values, else 'ranked'
function ixVizType(ix) {
  const n1 = ix.scores_matrix?.length ?? 0
  const n2 = ix.scores_matrix?.[0]?.length ?? 0
  return (n1 === 2 || n2 === 2) ? 'grouped' : 'ranked'
}

function ixSubtitle(f1, f2) {
  return `Does ${featName(f1)} affect start time differently by ${featName(f2)}?`
}

/* ─── Grouped Bars ──────────────────────────────────────────────────────────── */

function GroupedBars({ ix, preview }) {
  const { scores_matrix, x_labels_1, x_labels_2, x_values_1, x_values_2 } = ix
  const n1 = scores_matrix?.length ?? 0
  const f1Binary = n1 === 2

  // The "binary" axis has 2 values and becomes the bar legend
  const binaryLabels = axisLabels(
    f1Binary ? x_labels_1 : x_labels_2,
    f1Binary ? x_values_1 : x_values_2,
  )
  // The "group" axis provides one group per category
  const groupLabels = axisLabels(
    f1Binary ? x_labels_2 : x_labels_1,
    f1Binary ? x_values_2 : x_values_1,
  )

  const allGroups = groupLabels
    .map((label, i) => ({
      label,
      values: f1Binary
        ? [scores_matrix[0]?.[i] ?? 0, scores_matrix[1]?.[i] ?? 0]
        : [scores_matrix[i]?.[0] ?? 0, scores_matrix[i]?.[1] ?? 0],
    }))
    .filter(g => !isBadLabel(g.label))

  const displayGroups = preview ? allGroups.slice(0, 4) : allGroups
  const moreCount     = allGroups.length - 4

  const maxAbs = Math.max(...allGroups.flatMap(g => g.values.map(Math.abs)), 0.001)

  const BAR_H = 72
  const BAR_W = 18
  const BAR_GAP = 2

  return (
    <div>
      {/* Legend */}
      <div style={{ display: 'flex', gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
        {binaryLabels.slice(0, 2).map((l, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
            <div style={{
              width: 10, height: 10, borderRadius: 2,
              background: IX_COLORS[i], flexShrink: 0,
            }} />
            <span style={{ color: 'var(--color-gray-500)' }}>{l}</span>
          </div>
        ))}
      </div>

      {/* Bar groups */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, overflowX: 'auto', paddingBottom: 2 }}>
        {displayGroups.map((g, gi) => (
          <div key={gi} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, flexShrink: 0 }}>
            {/* Bars */}
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: BAR_GAP, height: BAR_H + 18 }}>
              {g.values.map((v, vi) => {
                const h   = Math.max(2, Math.round((Math.abs(v) / maxAbs) * BAR_H))
                const col = IX_COLORS[vi]
                return (
                  <div
                    key={vi}
                    style={{
                      display: 'flex', flexDirection: 'column',
                      alignItems: 'center', justifyContent: 'flex-end', height: '100%',
                    }}
                  >
                    <div style={{ fontSize: 8, color: col, fontWeight: 700, marginBottom: 2, whiteSpace: 'nowrap' }}>
                      {v >= 0 ? '+' : ''}{v.toFixed(1)}
                    </div>
                    <div style={{
                      width: BAR_W, height: h,
                      background: col,
                      borderRadius: '3px 3px 0 0',
                      flexShrink: 0,
                    }} />
                  </div>
                )
              })}
            </div>
            {/* Group label */}
            <div style={{
              fontSize: 9,
              color: 'var(--color-gray-400)',
              textAlign: 'center',
              maxWidth: BAR_W * 2 + BAR_GAP + 8,
              overflow: 'hidden',
              whiteSpace: 'nowrap',
              textOverflow: 'ellipsis',
            }}>
              {g.label}
            </div>
          </div>
        ))}

        {preview && moreCount > 0 && (
          <div style={{
            fontSize: 11, color: 'var(--color-gray-400)',
            alignSelf: 'center', flexShrink: 0, paddingBottom: 20,
          }}>
            +{moreCount} more
          </div>
        )}
      </div>
    </div>
  )
}

/* ─── Ranked List ───────────────────────────────────────────────────────────── */

function RankedList({ ix, preview }) {
  const { scores_matrix, x_labels_1, x_labels_2, x_values_1, x_values_2 } = ix

  const rowLabels = axisLabels(x_labels_1, x_values_1)
  const colLabels = axisLabels(x_labels_2, x_values_2)

  const cells = []
  for (let r = 0; r < (scores_matrix?.length ?? 0); r++) {
    if (isBadLabel(rowLabels[r] ?? r)) continue
    for (let c = 0; c < (scores_matrix[r]?.length ?? 0); c++) {
      if (isBadLabel(colLabels[c] ?? c)) continue
      cells.push({ part1: rowLabels[r] ?? String(r), part2: colLabels[c] ?? String(c), score: scores_matrix[r][c] })
    }
  }
  cells.sort((a, b) => Math.abs(b.score) - Math.abs(a.score))

  const display = cells.slice(0, preview ? 3 : 8)
  const maxAbs  = Math.max(...display.map(c => Math.abs(c.score)), 0.001)

  if (!display.length) return (
    <div style={{ color: 'var(--color-gray-400)', fontSize: 'var(--font-size-xs)' }}>No data</div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      {display.map((c, i) => {
        const isPos = c.score >= 0
        const color = isPos ? '#ef4444' : '#3b82f6'
        const pct   = (Math.abs(c.score) / maxAbs) * 100
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 170, flexShrink: 0, lineHeight: 1.35 }}>
              <div style={{ fontSize: 11, color: 'var(--color-gray-700)', fontWeight: 500 }}>{c.part1}</div>
              <div style={{ fontSize: 10, color: 'var(--color-gray-400)' }}>{c.part2}</div>
            </div>
            <div style={{
              flex: 1, height: 14,
              background: 'var(--color-gray-100)',
              borderRadius: 3, overflow: 'hidden',
            }}>
              <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 3 }} />
            </div>
            <div style={{
              width: 48, fontSize: 11, fontWeight: 600,
              color, textAlign: 'right', flexShrink: 0,
              fontVariantNumeric: 'tabular-nums',
            }}>
              {isPos ? '+' : ''}{c.score.toFixed(1)}m
            </div>
            <div style={{ width: 110, fontSize: 10, color: 'var(--color-gray-400)', flexShrink: 0 }}>
              {isPos ? 'later than expected' : 'earlier than expected'}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/* ─── Interaction Tile ──────────────────────────────────────────────────────── */

function InteractionTile({ ix, expanded, onToggle, narrative, narrativeLoading }) {
  const { feature_1, feature_2 } = ix
  const vizType = ixVizType(ix)
  const Viz     = vizType === 'grouped' ? GroupedBars : RankedList

  return (
    <div style={{
      background: 'var(--surface-card)',
      border: '1px solid var(--surface-border)',
      borderRadius: 'var(--radius-lg)',
      overflow: 'hidden',
    }}>
      {/* Header — click to toggle */}
      <button
        type="button"
        onClick={onToggle}
        style={{
          width: '100%', background: 'none', border: 'none',
          cursor: 'pointer', textAlign: 'left',
          padding: 'var(--space-4) var(--space-4) var(--space-2)',
          display: 'flex', alignItems: 'flex-start', gap: 'var(--space-3)',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 'var(--font-size-sm)',
            fontWeight: 'var(--font-weight-semibold)',
            color: 'var(--color-gray-900)',
            marginBottom: 2,
          }}>
            {featName(feature_1)}
            {' '}<span style={{ color: 'var(--color-blue)', fontWeight: 700 }}>×</span>{' '}
            {featName(feature_2)}
          </div>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)' }}>
            {ixSubtitle(feature_1, feature_2)}
          </div>
        </div>
        <div style={{
          flexShrink: 0,
          color: 'var(--color-gray-400)',
          transform: expanded ? 'rotate(180deg)' : 'none',
          transition: 'transform 200ms ease',
          marginTop: 3,
        }}>
          <ChevronDown size={14} />
        </div>
      </button>

      {/* Visualization: preview when collapsed, full when expanded */}
      <div style={{ padding: '0 var(--space-4) var(--space-4)' }}>
        <Viz ix={ix} preview={!expanded} />
      </div>

      {/* Narrative — only when expanded */}
      {expanded && (
        <div style={{ borderTop: '1px solid var(--surface-border)', padding: 'var(--space-4)' }}>
          {narrativeLoading ? (
            <div style={{
              display: 'flex', alignItems: 'center',
              gap: 'var(--space-2)',
              color: 'var(--color-gray-400)',
              fontSize: 'var(--font-size-sm)',
            }}>
              <div style={{
                width: 14, height: 14, borderRadius: '50%',
                border: '2px solid var(--color-blue)',
                borderTopColor: 'transparent',
                animation: 'spin 0.7s linear infinite',
                flexShrink: 0,
              }} />
              Generating insight…
            </div>
          ) : narrative ? (
            <p style={{
              fontSize: 'var(--font-size-sm)',
              color: 'var(--color-gray-600)',
              lineHeight: 'var(--line-height-relaxed)',
              margin: 0,
              padding: 'var(--space-3) var(--space-4)',
              background: 'var(--color-gray-50)',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--surface-border)',
            }}>
              {narrative}
            </p>
          ) : (
            <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-400)', margin: 0 }}>
              Insight could not be generated.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/* ─── Shape Bar ─────────────────────────────────────────────────────────────── */

function ShapeBar({ label, score, maxAbs }) {
  const pct   = maxAbs > 0 ? clamp(Math.abs(score) / maxAbs, 0, 1) * 100 : 0
  const isPos = score >= 0
  const color = isPos ? '#ef4444' : '#3b82f6'

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', padding: '3px 0' }}>
      <div style={{
        width: 120, fontSize: 'var(--font-size-xs)',
        color: 'var(--color-gray-600)',
        overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
        flexShrink: 0, textAlign: 'right',
      }}>
        {label}
      </div>
      <div style={{
        flex: 1, height: 16,
        background: 'var(--color-gray-100)',
        borderRadius: 3, overflow: 'hidden', position: 'relative',
      }}>
        <div style={{
          position: 'absolute', left: 0, top: 0,
          height: '100%', width: `${pct}%`,
          background: color, borderRadius: 3,
          transition: 'width 200ms ease',
        }} />
      </div>
      <div style={{
        width: 52, fontSize: 'var(--font-size-xs)',
        fontWeight: 'var(--font-weight-semibold)',
        color, textAlign: 'right', flexShrink: 0,
        fontVariantNumeric: 'tabular-nums',
      }}>
        {isPos ? '+' : ''}{score.toFixed(1)}m
      </div>
    </div>
  )
}

/* ─── Meta Pill ─────────────────────────────────────────────────────────────── */

function MetaPill({ icon: Icon, label, value }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
      padding: 'var(--space-2) var(--space-3)',
      background: 'var(--color-gray-50)',
      border: '1px solid var(--surface-border)',
      borderRadius: 'var(--radius-full)',
      fontSize: 'var(--font-size-xs)',
      color: 'var(--color-gray-600)',
      whiteSpace: 'nowrap',
    }}>
      {Icon && <Icon size={13} style={{ color: 'var(--color-blue)', flexShrink: 0 }} />}
      <span style={{ color: 'var(--color-gray-400)' }}>{label}</span>
      <span style={{ fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-gray-700)' }}>{value}</span>
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

/* ─── Atlas Page ────────────────────────────────────────────────────────────── */

export default function AtlasFCOT() {
  const [model,        setModel]        = useState(null)
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState('')
  const [selectedFeat, setSelectedFeat] = useState(null)
  const [expandedIx,   setExpandedIx]   = useState(null)
  const [ixNarratives, setIxNarratives] = useState({})
  const [ixLoadings,   setIxLoadings]   = useState({})

  /* ── Fetch model ── */
  useEffect(() => {
    setLoading(true)
    setError('')
    fetch('/api/atlas/fcot-model')
      .then(r => {
        if (!r.ok) return r.json().then(d => Promise.reject(new Error(d.error || `HTTP ${r.status}`)))
        return r.json()
      })
      .then(data => {
        setModel(data)
        const first = data.feature_importance?.[0]?.feature
        if (first) setSelectedFeat(first)
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
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

    // For continuous features, downsample to at most 20 evenly-spaced points
    let indices
    if (isCat || n <= 20) {
      indices = Array.from({ length: n }, (_, i) => i)
    } else {
      // First, last, and 18 evenly spaced in between (step across full range)
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

  /* ── Interaction toggle + narrative fetch ── */
  function toggleInteraction(key, ix) {
    if (expandedIx === key) { setExpandedIx(null); return }
    setExpandedIx(key)
    if (ixNarratives[key] !== undefined) return

    setIxLoadings(prev => ({ ...prev, [key]: true }))
    fetch('/api/atlas/explain-interaction', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        feature_1:     ix.feature_1,
        feature_2:     ix.feature_2,
        x_labels_1:    ix.x_labels_1,
        x_labels_2:    ix.x_labels_2,
        scores_matrix: ix.scores_matrix,
      }),
    })
      .then(r => r.json())
      .then(d => setIxNarratives(prev => ({ ...prev, [key]: d.narrative ?? '' })))
      .catch(() => setIxNarratives(prev => ({ ...prev, [key]: '' })))
      .finally(() => setIxLoadings(prev => ({ ...prev, [key]: false })))
  }

  function sendPrompt() {
    console.log('Regenerate narrative — endpoint not yet wired')
  }

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

  const interactions = model.interactions ?? []

  return (
    <div className="page">
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* ─── Section 1: Model Header ───────────────────────────────────────── */}
      <div className="card" style={{ marginBottom: 'var(--space-6)' }}>
        <div className="card-header" style={{ alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-2)' }}>
              <div style={{
                width: 36, height: 36, borderRadius: 'var(--radius-md)',
                background: 'var(--color-blue)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0, boxShadow: 'var(--shadow-blue)',
              }}>
                <Brain size={18} style={{ color: 'white' }} />
              </div>
              <div>
                <div className="card-title" style={{ marginBottom: 0 }}>First Case On-Time Start</div>
                <div className="card-subtitle" style={{ marginTop: 2 }}>
                  Explainable Boosting Regressor · Predicts minutes early/late vs scheduled start
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', marginTop: 'var(--space-4)' }}>
              <MetaPill icon={Database} label="Training samples" value={model.n_training_samples?.toLocaleString() ?? '—'} />
              <MetaPill icon={BarChart3} label="MAE"             value={fmtMAE(model.model_stats?.mae)} />
              <MetaPill icon={Zap}       label="Features"        value={mainEffects.length} />
              <MetaPill icon={GitMerge}  label="Interactions"    value={interactions.length} />
              <MetaPill icon={Calendar}  label="Trained"         value={fmtDate(model.trained_at)} />
            </div>

            <p style={{
              marginTop: 'var(--space-5)',
              fontSize: 'var(--font-size-sm)',
              color: 'var(--color-gray-600)',
              lineHeight: 'var(--line-height-relaxed)',
              maxWidth: 720,
            }}>
              This analysis identifies factors associated with first case start time variance — it shows
              statistical relationships in your data, not causal explanations. Red indicates association with
              later starts; blue with earlier starts.
            </p>
          </div>

          <div style={{ display: 'flex', gap: 'var(--space-2)', flexShrink: 0 }}>
            <button
              className="btn btn-ghost"
              onClick={sendPrompt}
              style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--font-size-sm)' }}
            >
              <RefreshCw size={14} />
              Regenerate
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => {}}
              style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--font-size-sm)' }}
            >
              <Mail size={14} />
              Email briefing
            </button>
          </div>
        </div>
      </div>

      {/* ─── Key Findings ──────────────────────────────────────────────────── */}
      <div style={{
        background: 'var(--color-background-secondary, var(--color-gray-50))',
        border: '1px solid var(--surface-border)',
        borderRadius: 'var(--radius-lg)',
        padding: 'var(--space-5)',
        marginBottom: 'var(--space-6)',
      }}>
        <div style={{
          fontSize: 'var(--font-size-sm)',
          fontWeight: 'var(--font-weight-semibold)',
          color: 'var(--color-gray-800)',
          marginBottom: 'var(--space-4)',
          letterSpacing: 'var(--letter-spacing-tight)',
        }}>
          Key Findings
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          {[
            { color: '#ef4444', text: 'Add-on cases are associated with starts averaging 10+ minutes later than scheduled cases.' },
            { color: '#ef4444', text: 'Weekend cases (Saturday and Sunday) show the strongest day-of-week association, running 18–20 minutes later on average.' },
            { color: '#ef4444', text: 'Neurosurgery and Spine Surgery are the most consistently late service lines, associated with 10–12 minute delays.' },
            { color: '#ef4444', text: 'Cases scheduled same-day run 9 minutes later on average than cases planned 2+ weeks ahead.' },
          ].map((f, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--space-3)' }}>
              <div style={{
                width: 7, height: 7,
                borderRadius: '50%',
                background: f.color,
                flexShrink: 0,
                marginTop: 5,
              }} />
              <span style={{
                fontSize: 'var(--font-size-sm)',
                color: 'var(--color-gray-700)',
                lineHeight: 'var(--line-height-relaxed)',
              }}>
                {f.text}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* ─── Section 2: Feature Drivers + Shape Functions ──────────────────── */}
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
                      flex: 1,
                      fontSize: 'var(--font-size-sm)',
                      fontWeight: isSelected ? 'var(--font-weight-semibold)' : 'var(--font-weight-medium)',
                      color: isSelected ? 'var(--color-blue)' : 'var(--color-gray-700)',
                      overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
                    }}>
                      {featName(f.feature)}
                    </span>
                    <span style={{
                      fontSize: 'var(--font-size-xs)',
                      fontWeight: 'var(--font-weight-semibold)',
                      color: b.color, background: b.bg,
                      padding: '1px 6px', borderRadius: 'var(--radius-full)', flexShrink: 0,
                    }}>
                      {b.label}
                    </span>
                    <span style={{
                      fontSize: 'var(--font-size-xs)',
                      color: 'var(--color-gray-400)',
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
                    How <em>{featName(selectedSF.feature)}</em> affects start time
                  </div>
                  <div className="card-subtitle">
                    Positive values (red) = later start · Negative values (blue) = earlier start · Units: minutes
                  </div>
                </div>
              </div>
              <div className="card-body">
                {sfEntries.length === 0 ? (
                  <div style={{ textAlign: 'center', color: 'var(--color-gray-400)', padding: 'var(--space-8) 0' }}>
                    No shape data available
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {sfEntries.map((e, i) => (
                      <ShapeBar key={i} label={e.label} score={e.score} maxAbs={sfMaxAbs} />
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ─── Section 3: Interaction Effects ────────────────────────────────── */}
      {interactions.length > 0 && (
        <div>
          <div style={{ marginBottom: 'var(--space-4)' }}>
            <h2 style={{
              fontSize: 'var(--font-size-lg)',
              fontWeight: 'var(--font-weight-semibold)',
              color: 'var(--color-gray-900)',
              marginBottom: 'var(--space-1)',
            }}>
              Interaction Effects
            </h2>
            <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-gray-500)' }}>
              How pairs of features combine to jointly influence start time. Click a tile to expand.
            </p>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 'var(--space-4)' }}>
            {interactions.map(ix => {
              const key = `${ix.feature_1}__${ix.feature_2}`
              return (
                <InteractionTile
                  key={key}
                  ix={ix}
                  expanded={expandedIx === key}
                  onToggle={() => toggleInteraction(key, ix)}
                  narrative={ixNarratives[key]}
                  narrativeLoading={!!ixLoadings[key]}
                />
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

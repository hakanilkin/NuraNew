import { useState, useEffect, useCallback } from 'react'
import { get, send } from './api'

/* Admin-only RTDC configuration (RTDC.md §7.3): prediction source and horizon,
   huddle order, effective-bed reasons, the clocks, and the rule table. Renders
   nothing for a tenant without RTDC. Changes take effect at the next read. */
export default function RtdcSettings() {
  const [settings, setSettings] = useState(null)
  const [rules, setRules] = useState(null)
  const [source, setSource] = useState('')
  const [msg, setMsg] = useState('')
  const [enabled, setEnabled] = useState(true)

  const load = useCallback(() => get('/settings').then(s => {
    if (s.status === 404) { setEnabled(false); return }
    if (!s.ok) return
    setSettings(s.data.settings); setSource(s.data.source)
    return get('/rules').then(r => { if (r.ok) setRules(r.data.rules) })
  }), [])
  useEffect(() => { load() }, [load])

  if (!enabled || !settings) return null

  const set = (k, v) => setSettings(s => ({ ...s, [k]: v }))
  const setRule = (key, patch) => setRules(rs => rs.map(r => (r.rule_key === key ? { ...r, ...patch } : r)))

  async function saveSettings() {
    setMsg('')
    const body = { ...settings,
      huddle_order: String(settings.huddle_order_text ?? settings.huddle_order.join(', ')).split(',').map(s => s.trim()).filter(Boolean),
      effective_bed_reasons: String(settings.reasons_text ?? settings.effective_bed_reasons.join(', ')).split(',').map(s => s.trim()).filter(Boolean),
      list_horizon_days: Number(settings.list_horizon_days) }
    delete body.huddle_order_text; delete body.reasons_text
    const r = await send('PUT', '/settings', { settings: body })
    setMsg(r.ok ? 'Settings saved. They apply at the next snapshot read.' : (r.data?.error || 'Could not save'))
    if (r.ok) load()
  }
  async function saveRules() {
    setMsg('')
    const r = await send('PUT', '/rules', { rules: rules.map(x => ({ rule_key: x.rule_key, enabled: x.enabled, params: x.params, keywords: x.keywords, reason_text: x.reason_text })) })
    setMsg(r.ok ? 'Rules saved.' : (r.data?.error || 'Could not save'))
  }

  const field = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }
  const label = { fontSize: 11, fontWeight: 600, color: 'var(--color-gray-500)', textTransform: 'uppercase', letterSpacing: '0.04em' }

  return (
    <div className="card" style={{ marginTop: 24 }}>
      <div className="card-header">
        <div>
          <div className="card-title">RTDC</div>
          <div className="card-subtitle">Right-time, not real-time. Snapshot source: <strong>{source}</strong>. Changes take effect at the next snapshot, never mid-meeting.</div>
        </div>
      </div>
      <div className="card-body" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
        <label style={field}><span style={label}>Prediction source</span>
          <select className="form-input" value={settings.pred_source} onChange={e => set('pred_source', e.target.value)}>
            <option value="EDD_DATE">EDD_DATE — EDD today = Y</option>
            <option value="EDD_TIME">EDD_TIME — EDD today and time ≤ cutoff = Y</option>
            <option value="FLAG">FLAG — dedicated Y/N field</option>
          </select></label>
        <label style={field}><span style={label}>List horizon (days)</span>
          <input className="form-input" type="number" min="0" max="7" value={settings.list_horizon_days} onChange={e => set('list_horizon_days', e.target.value)} /></label>
        <label style={field}><span style={label}>Cutoff ("by 2 PM")</span>
          <input className="form-input" value={settings.cutoff} onChange={e => set('cutoff', e.target.value)} placeholder="14:00" /></label>
        <label style={field}><span style={label}>Y at risk: order by</span>
          <input className="form-input" value={settings.order_by} onChange={e => set('order_by', e.target.value)} placeholder="11:00" /></label>
        <label style={field}><span style={label}>Y at risk: transport by</span>
          <input className="form-input" value={settings.transport_by} onChange={e => set('transport_by', e.target.value)} placeholder="12:00" /></label>
        <label style={field}><span style={label}>Snapshot times (S1 / S2)</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <input className="form-input" value={settings.snapshot_times?.S1 ?? ''} onChange={e => set('snapshot_times', { ...settings.snapshot_times, S1: e.target.value })} placeholder="06:00" />
            <input className="form-input" value={settings.snapshot_times?.S2 ?? ''} onChange={e => set('snapshot_times', { ...settings.snapshot_times, S2: e.target.value })} placeholder="08:20" />
          </div></label>
        <label style={{ ...field, gridColumn: '1 / -1' }}><span style={label}>Huddle order (comma-separated units)</span>
          <input className="form-input" value={settings.huddle_order_text ?? settings.huddle_order.join(', ')} onChange={e => set('huddle_order_text', e.target.value)} /></label>
        <label style={{ ...field, gridColumn: '1 / -1' }}><span style={label}>Effective-bed reason codes (comma-separated)</span>
          <input className="form-input" value={settings.reasons_text ?? settings.effective_bed_reasons.join(', ')} onChange={e => set('reasons_text', e.target.value)} /></label>
        <div style={{ gridColumn: '1 / -1' }}><button type="button" className="rtdc-btn" onClick={saveSettings}>Save settings</button></div>
      </div>

      {rules && (
        <div className="card-body" style={{ borderTop: '1px solid var(--surface-border)' }}>
          <div style={{ ...label, marginBottom: 8 }}>Escalation rules</div>
          <div className="table-wrap">
            <table className="table" style={{ fontSize: 13 }}>
              <thead><tr><th>Rule</th><th>On</th><th>Parameters</th><th>Reason text (prints on the report)</th></tr></thead>
              <tbody>
                {rules.map(r => (
                  <tr key={r.rule_key}>
                    <td><strong>{r.rule_key}</strong></td>
                    <td><input type="checkbox" checked={r.enabled} onChange={e => setRule(r.rule_key, { enabled: e.target.checked })} disabled={r.rule_key === 'EXCLUDE'} /></td>
                    <td>
                      {r.rule_key === 'LOS_EXCESS' && (
                        <label style={{ fontSize: 12 }}>LOS ≥ GMLOS + <input type="number" step="0.5" min="0" style={{ width: 60 }} className="form-input"
                          value={r.params?.los_delta_days ?? 1} onChange={e => setRule(r.rule_key, { params: { ...r.params, los_delta_days: Number(e.target.value) } })} /> d</label>
                      )}
                      {r.rule_key === 'EDD_SLIPPED' && (
                        <input className="form-input" style={{ minWidth: 220 }} value={(r.keywords || []).join(', ')} title="Narrative keywords"
                          onChange={e => setRule(r.rule_key, { keywords: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} />
                      )}
                    </td>
                    <td><textarea className="form-input" rows={2} style={{ width: '100%', minWidth: 260, height: 'auto' }} value={r.reason_text}
                          onChange={e => setRule(r.rule_key, { reason_text: e.target.value })} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 10 }}><button type="button" className="rtdc-btn" onClick={saveRules}>Save rules</button></div>
        </div>
      )}
      {msg && <div className="rtdc-note">{msg}</div>}
    </div>
  )
}

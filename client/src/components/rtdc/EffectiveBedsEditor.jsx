import { useState } from 'react'

/* The only meeting-time write: a unit's effective beds, with a reason.
   Defaults to available; saving records who/when. */
export default function EffectiveBedsEditor({ row, reasons, onSave, onCancel }) {
  const [beds, setBeds] = useState(row.effective)
  const [reason, setReason] = useState(row.adjustmentReason || '')
  const [note, setNote] = useState(row.adjustmentNote || '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const needsReason = Number(beds) !== row.available

  async function save() {
    setBusy(true); setErr('')
    const r = await onSave({ effective_beds: Number(beds), reason: needsReason ? reason : null, note })
    setBusy(false)
    if (!r.ok) setErr(r.data?.error || 'Could not save')
  }

  return (
    <div className="rtdc-editor" onClick={e => e.stopPropagation()}>
      <input type="number" min="0" value={beds} onChange={e => setBeds(e.target.value)} aria-label="Effective beds" />
      <select value={reason} onChange={e => setReason(e.target.value)} aria-label="Reason" disabled={!needsReason}>
        <option value="">{needsReason ? 'Reason…' : 'Same as available'}</option>
        {reasons.map(r => <option key={r} value={r}>{r}</option>)}
      </select>
      <input placeholder="Note (optional)" value={note} onChange={e => setNote(e.target.value)} style={{ minWidth: 140 }} />
      <button type="button" className="rtdc-btn" disabled={busy || (needsReason && !reason)} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
      <button type="button" className="rtdc-btn secondary" onClick={onCancel}>Cancel</button>
      {err && <span style={{ color: '#b91c1c', fontSize: 12 }}>{err}</span>}
    </div>
  )
}

import { useState, useEffect, useCallback } from 'react'
import { LayoutGrid, ExternalLink, RefreshCw, Send, Target, Plus, X, Check } from 'lucide-react'

/* ── Helpers ──────────────────────────────────────────────────────────── */

function fmtDate(iso) {
  if (!iso) return '—'
  const [, mm, dd] = String(iso).split('-')
  return mm && dd ? `${mm}/${dd}` : iso
}
function fmtHrs(mins) { return mins == null ? '—' : (mins / 60).toFixed(1) + 'h' }
function slugEmail(s) {
  const base = (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 28)
  return `${base || 'practice'}@practice.demo`
}

const SLOT_STATUS = {
  OPEN:    { label: 'Open',    bg: '#dcfce7', fg: '#15803d' },
  OFFERED: { label: 'Offered', bg: '#fef3c7', fg: '#b45309' },
  BOOKED:  { label: 'Booked',  bg: '#eef2fb', fg: '#3730a3' },
}
const OFFER_STATUS = {
  SENT:    { label: 'Sent',    fg: '#b45309' },
  CLAIMED: { label: 'Claimed', fg: '#15803d' },
  PASSED:  { label: 'Passed',  fg: '#b91c1c' },
  LAPSED:  { label: 'Lapsed',  fg: 'var(--color-gray-400)' },
}

/* ── Strategic goals editor ───────────────────────────────────────────── */

function GoalsEditor({ goals, onSave }) {
  const [rows, setRows]   = useState(goals)
  const [dirty, setDirty] = useState(false)
  useEffect(() => { setRows(goals); setDirty(false) }, [goals])

  function update(i, patch) { setRows(r => r.map((g, j) => j === i ? { ...g, ...patch } : g)); setDirty(true) }
  function remove(i)        { setRows(r => r.filter((_, j) => j !== i)); setDirty(true) }
  function add()            { setRows(r => [...r, { service: '', weight: 1 }]); setDirty(true) }

  return (
    <div className="card" style={{ padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontWeight: 700, fontSize: 13, color: 'var(--color-gray-800)', marginBottom: 10 }}>
        <Target size={15} /> Strategic growth goals
      </div>
      <p style={{ fontSize: 11, color: 'var(--color-gray-500)', margin: '0 0 12px' }}>Service lines you want to grow. Higher weight boosts a practice's match score for open time.</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {rows.map((g, i) => (
          <div key={i} style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
            <input className="form-input" value={g.service} placeholder="Service line" onChange={e => update(i, { service: e.target.value })} style={{ flex: 1, fontSize: 12, padding: '5px 8px' }} />
            <input className="form-input" type="number" min="1" max="5" value={g.weight} onChange={e => update(i, { weight: Number(e.target.value) })} style={{ width: 56, fontSize: 12, padding: '5px 8px' }} />
            <button onClick={() => remove(i)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--color-gray-400)', padding: 4 }}><X size={15} /></button>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="btn" onClick={add} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12 }}><Plus size={13} /> Add</button>
        <button className="btn btn-primary" disabled={!dirty} onClick={() => onSave(rows.filter(g => g.service.trim()))} style={{ fontSize: 12 }}>Save goals</button>
      </div>
    </div>
  )
}

/* ── Main page ────────────────────────────────────────────────────────── */

export default function OpenTimeBoard() {
  const [slots,      setSlots]      = useState([])
  const [selId,      setSelId]      = useState(null)
  const [candidates, setCandidates] = useState([])
  const [selCands,   setSelCands]   = useState(() => new Set())
  const [goals,      setGoals]      = useState([])
  const [loading,    setLoading]    = useState(true)
  const [loadingCand, setLoadingCand] = useState(false)
  const [sending,    setSending]    = useState(false)
  const [error,      setError]      = useState(null)

  const loadSlots = useCallback(async (keepSel) => {
    setLoading(true); setError(null)
    try {
      const res = await fetch('/api/opentime/slots')
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Error ${res.status}`)
      const { slots } = await res.json()
      setSlots(slots || [])
      if (!keepSel && slots?.length && !selId) setSelId(slots[0].id)
    } catch (e) { setError(e.message) } finally { setLoading(false) }
  }, [selId])

  const loadGoals = useCallback(async () => {
    const res = await fetch('/api/opentime/goals')
    if (res.ok) setGoals((await res.json()).goals || [])
  }, [])

  useEffect(() => { loadSlots(); loadGoals() }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  const selSlot = slots.find(s => s.id === selId) || null

  // Load candidates whenever the selected slot changes (and isn't booked)
  useEffect(() => {
    if (!selSlot || selSlot.status === 'BOOKED') { setCandidates([]); setSelCands(new Set()); return }
    setLoadingCand(true); setSelCands(new Set())
    fetch(`/api/opentime/slots/${selSlot.id}/candidates`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`Error ${r.status}`)))
      .then(({ candidates }) => setCandidates(candidates || []))
      .catch(e => setError(e.message))
      .finally(() => setLoadingCand(false))
  }, [selId])  // eslint-disable-line react-hooks/exhaustive-deps

  async function saveGoals(rows) {
    const res = await fetch('/api/opentime/goals', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goals: rows }),
    })
    if (res.ok) {
      setGoals((await res.json()).goals || [])
      if (selSlot && selSlot.status !== 'BOOKED') {  // re-rank with new weights
        setLoadingCand(true)
        const cr = await fetch(`/api/opentime/slots/${selSlot.id}/candidates`)
        if (cr.ok) setCandidates((await cr.json()).candidates || [])
        setLoadingCand(false)
      }
    }
  }

  function toggleCand(name) {
    setSelCands(prev => { const n = new Set(prev); n.has(name) ? n.delete(name) : n.add(name); return n })
  }

  async function sendOffers() {
    if (!selSlot || selCands.size === 0) return
    setSending(true); setError(null)
    try {
      const chosen = candidates.filter(c => selCands.has(c.candidate)).map(c => ({
        candidate: c.candidate, service: c.service, matchScore: c.matchScore, recipientEmail: slugEmail(c.candidate),
      }))
      const res = await fetch(`/api/opentime/slots/${selSlot.id}/offer`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ candidates: chosen }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Error ${res.status}`)
      await loadSlots(true)
      setSelCands(new Set())
    } catch (e) { setError(e.message) } finally { setSending(false) }
  }

  const alreadyOffered = new Set((selSlot?.offers || []).map(o => o.candidate))
  const TH = { padding: '6px 10px', fontSize: 10, fontWeight: 600, color: 'var(--color-gray-600)', textAlign: 'left', borderBottom: '2px solid var(--surface-border)', background: '#f8f9fb' }
  const TD = { padding: '8px 10px', fontSize: 12, textAlign: 'left', borderBottom: '1px solid #f0f1f3', verticalAlign: 'middle' }

  return (
    <div className="page">
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Open Time Board</h1>
          <p className="page-subtitle">Released blocks and who to offer them to — ranked by forward demand and your strategic growth goals.</p>
        </div>
        <button className="btn" onClick={() => loadSlots(true)} disabled={loading} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {error && <div style={{ padding: 12, marginBottom: 12, background: '#fef2f2', color: '#b91c1c', borderRadius: 8, fontSize: 13 }}>{error}</div>}

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* Left: slot inventory + goals */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, width: 320, flexShrink: 0 }}>
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div className="card-header" style={{ padding: '12px 16px' }}>
              <div className="card-title" style={{ fontSize: 14 }}>Released time</div>
              <div className="card-subtitle" style={{ fontSize: 12 }}>{slots.length} slot{slots.length === 1 ? '' : 's'}</div>
            </div>
            {loading ? (
              <div style={{ padding: 30, textAlign: 'center', color: 'var(--color-gray-400)', fontSize: 13 }}>Loading…</div>
            ) : slots.length === 0 ? (
              <div style={{ padding: 36, textAlign: 'center', color: 'var(--color-gray-400)' }}>
                <LayoutGrid size={30} strokeWidth={1.25} style={{ marginBottom: 10 }} />
                <p style={{ fontSize: 12, color: 'var(--color-gray-500)' }}>No released time yet. When a practice releases a block in the Tracker, it lands here.</p>
              </div>
            ) : (
              <div style={{ maxHeight: 420, overflowY: 'auto' }}>
                {slots.map(s => {
                  const st = SLOT_STATUS[s.status] || SLOT_STATUS.OPEN
                  const active = s.id === selId
                  return (
                    <div key={s.id} onClick={() => setSelId(s.id)} style={{ padding: '11px 16px', cursor: 'pointer', borderBottom: '1px solid #f0f1f3', borderLeft: active ? '3px solid var(--color-blue)' : '3px solid transparent', background: active ? '#f5f8ff' : '#fff' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }}>
                        <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--color-gray-800)' }}>{s.caseBlock}</span>
                        <span style={{ padding: '2px 8px', borderRadius: 999, background: st.bg, color: st.fg, fontWeight: 700, fontSize: 11 }}>{st.label}</span>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--color-gray-500)' }}>{fmtDate(s.blockDate)} · {s.site} · {fmtHrs(s.durationMins)}</div>
                      {s.status === 'BOOKED' && <div style={{ fontSize: 11, color: '#15803d', fontWeight: 600, marginTop: 3 }}>Booked by {s.bookedBy}</div>}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          <GoalsEditor goals={goals} onSave={saveGoals} />
        </div>

        {/* Right: candidates + offers for selected slot */}
        <div style={{ flex: '1 1 520px', minWidth: 380 }}>
          {!selSlot ? (
            <div className="card"><div className="card-body" style={{ padding: 48, textAlign: 'center', color: 'var(--color-gray-400)', fontSize: 13 }}>Select a released slot to see who to offer it to.</div></div>
          ) : (
            <>
              <div className="card" style={{ marginBottom: 16 }}>
                <div className="card-header" style={{ padding: '12px 18px' }}>
                  <div>
                    <div className="card-title" style={{ fontSize: 14 }}>{selSlot.caseBlock}</div>
                    <div className="card-subtitle" style={{ fontSize: 12 }}>{fmtDate(selSlot.blockDate)} · {selSlot.site} · {fmtHrs(selSlot.durationMins)} · released from {selSlot.service}</div>
                  </div>
                </div>

                {/* Existing offers */}
                {selSlot.offers.length > 0 && (
                  <div style={{ padding: '0 18px 8px' }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-gray-500)', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '12px 0 8px' }}>Offers sent</div>
                    {selSlot.offers.map(o => {
                      const os = OFFER_STATUS[o.status] || OFFER_STATUS.SENT
                      return (
                        <div key={o.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid #f4f5f7' }}>
                          <div>
                            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-gray-800)' }}>{o.candidate}</span>
                            <span style={{ fontSize: 12, color: os.fg, fontWeight: 600, marginLeft: 10 }}>{os.label}</span>
                          </div>
                          {o.status === 'SENT'
                            ? <a href={`${window.location.origin}/o/${o.token}`} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--color-blue)', textDecoration: 'none' }}><ExternalLink size={13} /> Respond as practice</a>
                            : o.status === 'CLAIMED' ? <Check size={15} color="#15803d" /> : null}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              {selSlot.status === 'BOOKED' ? (
                <div className="card"><div className="card-body" style={{ padding: 32, textAlign: 'center' }}>
                  <Check size={30} color="#15803d" style={{ marginBottom: 8 }} />
                  <div style={{ fontWeight: 700, color: '#166534' }}>Booked by {selSlot.bookedBy}</div>
                  <div style={{ fontSize: 12, color: 'var(--color-gray-500)', marginTop: 4 }}>This open time has been filled.</div>
                </div></div>
              ) : (
                <div className="card">
                  <div className="card-header" style={{ padding: '12px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div className="card-title" style={{ fontSize: 14 }}>Suggested practices</div>
                    <button className="btn btn-primary" disabled={sending || selCands.size === 0} onClick={sendOffers} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13 }}>
                      <Send size={14} /> {sending ? 'Sending…' : `Offer to ${selCands.size || ''}`.trim()}
                    </button>
                  </div>
                  <div className="card-body" style={{ padding: 0 }}>
                    {loadingCand ? (
                      <div style={{ padding: 36, textAlign: 'center', color: 'var(--color-gray-400)', fontSize: 13 }}>Ranking practices…</div>
                    ) : candidates.length === 0 ? (
                      <div style={{ padding: 36, textAlign: 'center', color: 'var(--color-gray-400)', fontSize: 13 }}>No candidate practices with forward demand at this site.</div>
                    ) : (
                      <div style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                          <thead>
                            <tr>
                              <th style={{ ...TH, width: 34 }}></th>
                              <th style={{ ...TH, textAlign: 'right', width: 64 }}>Match</th>
                              <th style={TH}>Practice / service</th>
                              <th style={TH}>Why ranked</th>
                            </tr>
                          </thead>
                          <tbody>
                            {candidates.map(c => {
                              const offered = alreadyOffered.has(c.candidate)
                              const checked = selCands.has(c.candidate)
                              return (
                                <tr key={c.candidate} style={{ opacity: offered ? 0.5 : 1 }}>
                                  <td style={{ ...TD, textAlign: 'center' }}>
                                    <input type="checkbox" checked={checked} disabled={offered} onChange={() => toggleCand(c.candidate)} style={{ accentColor: 'var(--color-blue)', cursor: offered ? 'default' : 'pointer' }} />
                                  </td>
                                  <td style={{ ...TD, textAlign: 'right' }}>
                                    <span style={{ fontWeight: 700, fontSize: 14, color: c.matchScore >= 60 ? '#15803d' : c.matchScore >= 30 ? '#b45309' : 'var(--color-gray-500)' }}>{c.matchScore}</span>
                                  </td>
                                  <td style={{ ...TD }}>
                                    <span style={{ fontWeight: 600, color: 'var(--color-gray-800)' }}>{c.candidate}</span>
                                    {c.isStrategic && <span style={{ marginLeft: 7, fontSize: 10, fontWeight: 700, color: '#15803d', background: '#dcfce7', padding: '1px 7px', borderRadius: 999 }}>STRATEGIC</span>}
                                    {offered && <span style={{ marginLeft: 7, fontSize: 11, color: 'var(--color-gray-400)' }}>offered</span>}
                                  </td>
                                  <td style={{ ...TD }}>
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                                      {c.drivers.map(d => (
                                        <span key={d.key} title={d.detail} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, background: d.key === 'strategic' ? '#dcfce7' : '#eef0fd', color: d.key === 'strategic' ? '#15803d' : '#3730a3' }}>{d.detail}</span>
                                      ))}
                                    </div>
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <p style={{ fontSize: 11, color: 'var(--color-gray-400)', marginTop: 12 }}>
        Demo: no email is sent. "Respond as practice" opens the page a surgeon's office would see, where they claim or pass the open time.
      </p>
    </div>
  )
}

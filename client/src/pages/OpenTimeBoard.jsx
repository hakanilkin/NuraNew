import { useState, useEffect, useCallback } from 'react'
import { LayoutGrid, ExternalLink, RefreshCw, Send, Target, Plus, X, Check } from 'lucide-react'

/* ── Helpers ──────────────────────────────────────────────────────────── */

function fmtDate(iso) {
  if (!iso) return '—'
  const [, mm, dd] = String(iso).split('-')
  return mm && dd ? `${mm}/${dd}` : iso
}
function fmtHrs(mins) { return mins == null ? '—' : (mins / 60).toFixed(1) + 'h' }
// Scores and percentages arrive at full precision so the API's ranking stays
// exact; they are whole numbers on screen.
function fmtScore(v) { return v == null ? '—' : Math.round(Number(v)) }
function slugEmail(s) {
  const base = (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 28)
  return `${base || 'practice'}@practice.demo`
}

/* ── The three lists (OpenTimeBoardLists.md) ───────────────────────────────
   Action -> in flight -> done. One flat list with status chips answered no
   question in particular; these three each answer one, and the order is the
   order a scheduler works in. List 1 has primacy because it is the only one
   with anything to do.

   No status chips inside the lists: the list a row sits in *is* its status, and
   a chip repeating it is a second signal doing the heading's job. */
const LISTS = [
  { key: 'NEEDS_OFFER', title: 'Needs an offer',
    blurb: 'Released time with nobody lined up.',
    empty: 'Nothing needs an offer.', primary: true },
  { key: 'AWAITING', title: 'Awaiting response',
    blurb: 'Offered, no reply yet.',
    empty: 'Nothing awaiting response.' },
  { key: 'BOOKED', title: 'Booked',
    blurb: 'Recovered time.',
    empty: 'Nothing booked yet.' },
]

/* Membership is the server's (lib/openTimeStore.slotList) so there is one rule,
   not two. This only falls back for a store written before it existed. */
function listOf(slot) {
  if (slot.list) return slot.list
  if (slot.status === 'BOOKED') return 'BOOKED'
  return (slot.offers || []).some(o => o.status === 'SENT') ? 'AWAITING' : 'NEEDS_OFFER'
}

function fmtWhen(iso) {
  if (!iso) return ''
  const days = Math.floor((Date.now() - new Date(iso)) / 86400000)
  if (!Number.isFinite(days)) return ''
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`
}

/* The history that makes a second attempt useful rather than a dead end handed
   back: who already said no, and when. */
function priorOfferLine(slot) {
  const done = (slot.offers || []).filter(o => o.status === 'PASSED' || o.status === 'LAPSED')
  if (!done.length) return null
  const last = done[done.length - 1]
  const verb = last.status === 'PASSED' ? 'declined' : 'expired'
  const when = fmtWhen(last.respondedAt || last.sentAt)
  const more = done.length > 1 ? ` · ${done.length} offers so far` : ''
  return `Offered to ${last.candidate} · ${verb}${when ? ` ${when}` : ''}${more}`
}

function liveOfferLine(slot) {
  const live = (slot.offers || []).filter(o => o.status === 'SENT')
  if (!live.length) return null
  const when = fmtWhen(live[0].sentAt)
  return live.length === 1
    ? `Offered to ${live[0].candidate}${when ? ` · sent ${when}` : ''}`
    : `Offered to ${live[0].candidate} +${live.length - 1} more${when ? ` · sent ${when}` : ''}`
}

const OFFER_STATUS = {
  SENT:    { label: 'Sent',    fg: '#b45309' },
  CLAIMED: { label: 'Claimed', fg: '#15803d' },
  PASSED:  { label: 'Passed',  fg: '#b91c1c' },
  LAPSED:  { label: 'Lapsed',  fg: 'var(--color-gray-400)' },
}

/* One list. The header carries a count and total hours, because "4 slots ·
   22.5h" is the figure that reconciles with the funnel strip above. */
export function BoardList({ list, slots, selId, onSelect }) {
  const mins = slots.reduce((t, s) => t + (Number(s.durationMins) || 0), 0)
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div className="card-header" style={{ padding: list.primary ? '13px 16px' : '11px 16px' }}>
        <div>
          <div className="card-title" style={{ fontSize: list.primary ? 15 : 13 }}>{list.title}</div>
          <div className="card-subtitle" style={{ fontSize: 11 }}>
            {slots.length ? `${slots.length} slot${slots.length === 1 ? '' : 's'} · ${fmtHrs(mins)}` : list.blurb}
          </div>
        </div>
      </div>
      {slots.length === 0 ? (
        // An empty list is a real state, phrased as one.
        <div style={{ padding: '16px', fontSize: 12, color: 'var(--color-gray-400)' }}>{list.empty}</div>
      ) : (
        <div style={{ maxHeight: list.primary ? 300 : 200, overflowY: 'auto' }}>
          {slots.map(s => {
            const active = s.id === selId
            const prior = priorOfferLine(s)
            const live = liveOfferLine(s)
            return (
              <div key={s.id} onClick={() => onSelect(s.id)} role="button" tabIndex={0}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onSelect(s.id) }}
                style={{ padding: '10px 16px', cursor: 'pointer', borderBottom: '1px solid #f0f1f3',
                         borderLeft: active ? '3px solid var(--color-blue)' : '3px solid transparent',
                         background: active ? '#f5f8ff' : '#fff' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--color-gray-800)' }}>{s.caseBlock}</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-gray-600)' }}>{fmtHrs(s.durationMins)}</span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--color-gray-500)', marginTop: 2 }}>
                  {fmtDate(s.blockDate)} · {s.site}
                  {list.key === 'NEEDS_OFFER' && s.service ? ` · ${s.service}` : ''}
                </div>
                {list.key === 'NEEDS_OFFER' && prior && (
                  <div style={{ fontSize: 11, color: '#b45309', marginTop: 3 }}>{prior}</div>
                )}
                {list.key === 'AWAITING' && live && (
                  <div style={{ fontSize: 11, color: 'var(--color-gray-600)', marginTop: 3 }}>{live}</div>
                )}
                {list.key === 'BOOKED' && s.bookedBy && (
                  <div style={{ fontSize: 11, color: '#15803d', fontWeight: 600, marginTop: 3 }}>
                    Booked by {s.bookedBy}{fmtWhen(s.bookedAt) ? ` · ${fmtWhen(s.bookedAt)}` : ''}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* All three, in the order a scheduler works them. Grouped from one annotated
   array, so a slot that changes status moves list on the next load without the
   page being rebuilt around it. */
export function BoardLists({ slots, selId, onSelect }) {
  const byList = { NEEDS_OFFER: [], AWAITING: [], BOOKED: [] }
  for (const s of slots) (byList[listOf(s)] ?? byList.NEEDS_OFFER).push(s)
  // The win list reads most recent first; it is the number the whole
  // capability exists to produce.
  byList.BOOKED.sort((a, b) => String(b.bookedAt || '').localeCompare(String(a.bookedAt || '')))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {LISTS.map(l => (
        <BoardList key={l.key} list={l} slots={byList[l.key]} selId={selId} onSelect={onSelect} />
      ))}
    </div>
  )
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

/* Rendered standalone at its own route, or as a tab body inside Release Time
   Mgmt. Embedded, the tabbed host owns the page frame and the heading. */
function Shell({ embedded, children }) {
  return embedded ? <>{children}</> : <div className="page">{children}</div>
}

export default function OpenTimeBoard({ embedded = false }) {
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
    if (!selSlot || listOf(selSlot) !== 'NEEDS_OFFER') { setCandidates([]); setSelCands(new Set()); return }
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
      if (selSlot && listOf(selSlot) === 'NEEDS_OFFER') {  // re-rank with new weights
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
    <Shell embedded={embedded}>
      <div className="page-header" style={{ display: embedded ? 'none' : 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
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
          {loading ? (
            <div className="card"><div style={{ padding: 30, textAlign: 'center', color: 'var(--color-gray-400)', fontSize: 13 }}>Loading…</div></div>
          ) : slots.length === 0 ? (
            <div className="card">
              <div style={{ padding: 36, textAlign: 'center', color: 'var(--color-gray-400)' }}>
                <LayoutGrid size={30} strokeWidth={1.25} style={{ marginBottom: 10 }} />
                <p style={{ fontSize: 12, color: 'var(--color-gray-500)' }}>No released time yet. When a practice releases a block in the Tracker, it lands here.</p>
              </div>
            </div>
          ) : (
            <BoardLists slots={slots} selId={selId} onSelect={setSelId} />
          )}

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

              {/* The panel stays in context: ranking for list 1, offer detail
                  for list 2, booking detail for list 3. */}
              {listOf(selSlot) === 'BOOKED' ? (
                <div className="card"><div className="card-body" style={{ padding: 32, textAlign: 'center' }}>
                  <Check size={30} color="#15803d" style={{ marginBottom: 8 }} />
                  <div style={{ fontWeight: 700, color: '#166534' }}>Booked by {selSlot.bookedBy}</div>
                  <div style={{ fontSize: 12, color: 'var(--color-gray-500)', marginTop: 4 }}>
                    {fmtHrs(selSlot.durationMins)} recovered{fmtWhen(selSlot.bookedAt) ? ` · ${fmtWhen(selSlot.bookedAt)}` : ''}.
                  </div>
                </div></div>
              ) : listOf(selSlot) === 'AWAITING' ? (
                <div className="card"><div className="card-body" style={{ padding: 28, textAlign: 'center' }}>
                  <Send size={26} color="var(--color-gray-400)" style={{ marginBottom: 8 }} />
                  <div style={{ fontWeight: 700, color: 'var(--color-gray-700)' }}>{liveOfferLine(selSlot)}</div>
                  <div style={{ fontSize: 12, color: 'var(--color-gray-500)', marginTop: 4 }}>
                    Nothing to rank while an offer is live. Use the respond links above to see what the practice sees.
                  </div>
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
                                    <span style={{ fontWeight: 700, fontSize: 14, color: c.matchScore >= 60 ? '#15803d' : c.matchScore >= 30 ? '#b45309' : 'var(--color-gray-500)' }}>{fmtScore(c.matchScore)}</span>
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
    </Shell>
  )
}

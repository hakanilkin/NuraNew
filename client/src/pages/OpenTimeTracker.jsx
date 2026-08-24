import { useState, useEffect, useCallback } from 'react'
import { Inbox, ExternalLink, RefreshCw } from 'lucide-react'

/* ── Helpers ──────────────────────────────────────────────────────────── */

function fmtDate(iso) {
  if (!iso) return '—'
  const [, mm, dd] = String(iso).split('-')
  return mm && dd ? `${mm}/${dd}` : iso
}
function fmtWhen(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  return d.toLocaleString('default', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
function fmtHrs(mins) { return mins == null ? '—' : (mins / 60).toFixed(1) + 'h' }

const STATUS = {
  SENT:     { label: 'Awaiting',  bg: '#eef2fb', fg: '#3730a3' },
  RELEASED: { label: 'Released',  bg: '#dcfce7', fg: '#15803d' },
  KEEP:     { label: 'Keeping',   bg: '#fee2e2', fg: '#b91c1c' },
  DEFER:    { label: 'Check back', bg: '#fef3c7', fg: '#b45309' },
}

function StatusBadge({ status }) {
  const s = STATUS[status] || STATUS.SENT
  return <span style={{ padding: '3px 10px', borderRadius: 999, background: s.bg, color: s.fg, fontWeight: 700, fontSize: 12 }}>{s.label}</span>
}

function Metric({ value, label, color }) {
  return (
    <div>
      <span style={{ fontSize: 22, fontWeight: 700, color: color || 'var(--color-gray-900)' }}>{value}</span>{' '}
      <span style={{ fontSize: 12, color: 'var(--color-gray-500)' }}>{label}</span>
    </div>
  )
}

/* ── Main page ────────────────────────────────────────────────────────── */

export default function OpenTimeTracker() {
  const [requests, setRequests] = useState([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await fetch('/api/opentime/requests')
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Error ${res.status}`)
      const { requests } = await res.json()
      setRequests(requests || [])
    } catch (e) { setError(e.message) } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const m = requests.reduce((a, r) => {
    a[r.status] = (a[r.status] || 0) + 1
    if (r.status === 'RELEASED') a.releasedMins += (r.blockTimeMins || 0)
    return a
  }, { releasedMins: 0 })
  const responded  = requests.filter(r => r.status !== 'SENT').length
  const responseRate = requests.length ? Math.round(responded / requests.length * 100) : 0

  const TH = { padding: '6px 10px', fontSize: 10, fontWeight: 600, color: 'var(--color-gray-600)', textAlign: 'left', whiteSpace: 'nowrap', borderBottom: '2px solid var(--surface-border)', background: '#f8f9fb' }
  const TD = { padding: '8px 10px', fontSize: 12, textAlign: 'left', borderBottom: '1px solid #f0f1f3', verticalAlign: 'middle' }

  return (
    <div className="page">
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Release Tracker</h1>
          <p className="page-subtitle">Release requests you've sent and how each practice responded. Responses update here as they come in.</p>
        </div>
        <button className="btn" onClick={load} disabled={loading} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {/* Metrics */}
      {!loading && requests.length > 0 && (
        <div style={{ display: 'flex', gap: 26, marginBottom: 16, padding: '12px 20px', background: '#fff', border: '1px solid var(--surface-border)', borderRadius: 'var(--radius-lg)', flexWrap: 'wrap' }}>
          <Metric value={requests.length} label="requests sent" />
          <Metric value={m.RELEASED || 0} label="released" color="#15803d" />
          <Metric value={fmtHrs(m.releasedMins)} label="block time freed" color="#15803d" />
          <Metric value={m.SENT || 0} label="awaiting" color="#3730a3" />
          <Metric value={`${responseRate}%`} label="response rate" />
        </div>
      )}

      <div className="card">
        <div className="card-body" style={{ padding: 0 }}>
          {loading && <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-gray-400)', fontSize: 13 }}>Loading…</div>}
          {error && !loading && <div style={{ padding: 40, textAlign: 'center', color: '#b91c1c', fontSize: 13 }}>{error}</div>}
          {!loading && !error && requests.length === 0 && (
            <div style={{ padding: 56, display: 'flex', flexDirection: 'column', alignItems: 'center', color: 'var(--color-gray-400)' }}>
              <Inbox size={36} strokeWidth={1.25} style={{ marginBottom: 12 }} />
              <p style={{ fontSize: 13, color: 'var(--color-gray-500)' }}>No release requests yet — send one from the Release Radar.</p>
            </div>
          )}
          {!loading && !error && requests.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={TH}>Status</th>
                    <th style={TH}>Date</th>
                    <th style={TH}>Case Block</th>
                    <th style={TH}>Site</th>
                    <th style={TH}>Service</th>
                    <th style={{ ...TH, textAlign: 'right' }}>Block</th>
                    <th style={TH}>Recipient</th>
                    <th style={TH}>Sent</th>
                    <th style={TH}>Responded</th>
                    <th style={TH}></th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map(r => (
                    <tr key={r.id} onMouseEnter={e => e.currentTarget.style.background = '#fafbfe'} onMouseLeave={e => e.currentTarget.style.background = ''}>
                      <td style={TD}><StatusBadge status={r.status} /></td>
                      <td style={{ ...TD, fontWeight: 600 }}>{fmtDate(r.blockDate)}</td>
                      <td style={{ ...TD, color: 'var(--color-gray-800)' }}>{r.caseBlock}</td>
                      <td style={{ ...TD, color: 'var(--color-gray-600)' }}>{r.site}</td>
                      <td style={{ ...TD, color: 'var(--color-gray-600)' }}>{r.service}</td>
                      <td style={{ ...TD, textAlign: 'right' }}>{fmtHrs(r.blockTimeMins)}</td>
                      <td style={{ ...TD, color: 'var(--color-gray-600)' }}>{r.recipientEmail}</td>
                      <td style={{ ...TD, color: 'var(--color-gray-500)', whiteSpace: 'nowrap' }}>{fmtWhen(r.createdAt)}</td>
                      <td style={{ ...TD, color: 'var(--color-gray-500)', whiteSpace: 'nowrap' }}>{fmtWhen(r.respondedAt)}</td>
                      <td style={{ ...TD, textAlign: 'right' }}>
                        {r.status === 'SENT'
                          ? <a href={`${window.location.origin}/r/${r.token}`} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--color-blue)', textDecoration: 'none', whiteSpace: 'nowrap' }}><ExternalLink size={13} /> Respond as practice</a>
                          : r.status === 'RELEASED'
                            ? <span style={{ fontSize: 11, color: '#15803d', fontWeight: 600 }}>→ Open Time Board</span>
                            : <span style={{ fontSize: 11, color: 'var(--color-gray-400)' }}>—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <p style={{ fontSize: 11, color: 'var(--color-gray-400)', marginTop: 12 }}>
        Demo: no email is sent. "Respond as practice" opens the exact page a recipient would see from the email link.
      </p>
    </div>
  )
}

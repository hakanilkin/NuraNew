// Fetch helpers for /api/rtdc. Every call resolves to { ok, status, data }.

export function qs(params) {
  const p = Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== null && v !== '')
  return p.length ? '?' + p.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&') : ''
}

export async function get(path, params) {
  try {
    const res = await fetch(`/api/rtdc${path}${qs(params)}`)
    const data = await res.json().catch(() => null)
    return { ok: res.ok, status: res.status, data }
  } catch (e) {
    return { ok: false, status: 0, data: { error: e.message } }
  }
}

export async function send(method, path, body) {
  try {
    const res = await fetch(`/api/rtdc${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
    })
    const data = await res.json().catch(() => null)
    return { ok: res.ok, status: res.status, data }
  } catch (e) {
    return { ok: false, status: 0, data: { error: e.message } }
  }
}

export const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
export const addDays = (s, n) => {
  const [y, m, d] = s.split('-').map(Number)
  const dt = new Date(y, m - 1, d + n)
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
}
export const fmtPct = v => (v == null ? '—' : `${Math.round(v)}%`)
export const fmtNum = v => (v == null ? '—' : v)
export const fmtSigned = v => (v == null ? '—' : v > 0 ? `+${v}` : `${v}`)
export const fmtDow = s => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(s + 'T00:00:00').getDay()]
export const fmtShort = s => { const [, m, d] = s.split('-'); return `${Number(m)}/${Number(d)}` }
export const fmtTime = iso => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—')

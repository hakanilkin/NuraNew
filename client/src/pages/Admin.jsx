import { useState, useEffect, useCallback } from 'react'
import { Plus, Pencil, Trash2, Building2 } from 'lucide-react'

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function Badge({ active, label }) {
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: 999,
      fontSize: 11,
      fontWeight: 600,
      background: active ? '#dcfce7' : '#f3f4f6',
      color:      active ? '#166534' : '#6b7280',
    }}>
      {active ? label : 'No'}
    </span>
  )
}

function MfaBadge({ enabled }) {
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: 999,
      fontSize: 11,
      fontWeight: 600,
      background: enabled ? '#dbeafe' : '#f3f4f6',
      color:      enabled ? '#1d4ed8' : '#6b7280',
    }}>
      {enabled ? 'Enrolled' : 'Not set'}
    </span>
  )
}

function fmtDate(dt) {
  if (!dt) return '—'
  return new Date(dt).toLocaleString()
}

/* ── Field ────────────────────────────────────────────────────────────────── */

function Field({ label, children, hint }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--color-gray-700)', marginBottom: 4 }}>
        {label}
      </label>
      {children}
      {hint && <div style={{ fontSize: 11, color: 'var(--color-gray-400)', marginTop: 3 }}>{hint}</div>}
    </div>
  )
}

function Input({ value, onChange, type = 'text', placeholder, disabled, required }) {
  return (
    <input
      type={type}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      required={required}
      style={{
        width: '100%',
        padding: '8px 10px',
        border: '1px solid var(--color-gray-200)',
        borderRadius: 'var(--radius-md)',
        fontSize: 13,
        color: 'var(--color-gray-900)',
        background: disabled ? 'var(--color-gray-50)' : '#fff',
        outline: 'none',
        boxSizing: 'border-box',
      }}
    />
  )
}

function Checkbox({ checked, onChange, label }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--color-gray-700)', cursor: 'pointer' }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        style={{ width: 15, height: 15, accentColor: 'var(--color-blue)', cursor: 'pointer' }}
      />
      {label}
    </label>
  )
}

/* ── Modal ────────────────────────────────────────────────────────────────── */

const EMPTY_FORM = { username: '', fullName: '', email: '', password: '', isAdmin: false, isActive: true, resetTotp: false }

function UserModal({ user, onClose, onSave }) {
  const isEdit = !!user
  const [form,    setForm]    = useState(isEdit
    ? { username: user.Username, fullName: user.FullName || '', email: user.Email || '', password: '', isAdmin: !!user.IsAdmin, isActive: !!user.IsActive, resetTotp: false }
    : EMPTY_FORM
  )
  const [error,   setError]   = useState('')
  const [saving,  setSaving]  = useState(false)

  function set(key) { return v => setForm(f => ({ ...f, [key]: v })) }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setSaving(true)
    try {
      const payload = {
        fullName: form.fullName || null,
        email:    form.email    || null,
        isAdmin:  form.isAdmin,
        isActive: form.isActive,
      }
      let res
      if (isEdit) {
        if (form.password)  payload.resetPassword = form.password
        if (form.resetTotp) payload.resetTotp = true
        res = await fetch(`/api/admin/users/${user.UserID}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
      } else {
        payload.username = form.username
        payload.password = form.password
        res = await fetch('/api/admin/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
      }
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Save failed'); setSaving(false); return }
      onSave()
    } catch (err) {
      setError('Network error')
      setSaving(false)
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'rgba(0,0,0,0.4)',
      zIndex: 200,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: '#fff',
        borderRadius: 'var(--radius-xl)',
        boxShadow: '0 8px 40px rgba(0,0,0,0.18)',
        width: '100%', maxWidth: 460,
        padding: '28px 32px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 22 }}>
          <h3 style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-gray-900)', margin: 0 }}>
            {isEdit ? 'Edit User' : 'New User'}
          </h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: 'var(--color-gray-400)', lineHeight: 1 }}>&times;</button>
        </div>

        {error && (
          <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', color: '#b91c1c', borderRadius: 6, padding: '8px 12px', fontSize: 12, marginBottom: 14 }}>
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <Field label="Username">
            <Input value={form.username} onChange={set('username')} disabled={isEdit} required={!isEdit} placeholder="username" />
          </Field>
          <Field label="Full Name">
            <Input value={form.fullName} onChange={set('fullName')} placeholder="Full name" />
          </Field>
          <Field label="Email">
            <Input value={form.email} onChange={set('email')} type="email" placeholder="email@hospital.org" />
          </Field>
          <Field
            label={isEdit ? 'New Password' : 'Password'}
            hint={isEdit ? 'Leave blank to keep current password' : undefined}
          >
            <Input value={form.password} onChange={set('password')} type="password" required={!isEdit} placeholder="••••••••" />
          </Field>

          <div style={{ display: 'flex', gap: 24, marginBottom: 14 }}>
            <Checkbox checked={form.isAdmin}  onChange={set('isAdmin')}  label="Administrator" />
            <Checkbox checked={form.isActive} onChange={set('isActive')} label="Active" />
          </div>

          {isEdit && (
            <div style={{ marginBottom: 14 }}>
              <Checkbox checked={form.resetTotp} onChange={set('resetTotp')} label="Reset MFA (force re-enroll on next login)" />
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 22 }}>
            <button type="button" onClick={onClose} style={{
              background: 'var(--color-gray-100)', border: 'none', borderRadius: 'var(--radius-md)',
              padding: '8px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer', color: 'var(--color-gray-700)',
            }}>
              Cancel
            </button>
            <button type="submit" disabled={saving} style={{
              background: 'var(--color-blue)', border: 'none', borderRadius: 'var(--radius-md)',
              padding: '8px 18px', fontSize: 13, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer',
              color: '#fff', opacity: saving ? 0.7 : 1,
            }}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

/* ── Tenant assignment modal ──────────────────────────────────────────────── */

function TenantModal({ user, onClose, onSave }) {
  const [allTenants,      setAllTenants]      = useState([])
  const [assignedIds,     setAssignedIds]     = useState(new Set())
  const [loading,         setLoading]         = useState(true)
  const [saving,          setSaving]          = useState(false)
  const [error,           setError]           = useState('')

  useEffect(() => {
    Promise.all([
      fetch('/api/admin/tenants').then(r => r.json()),
      fetch(`/api/admin/users/${user.UserID}/tenants`).then(r => r.json()),
    ]).then(([tenants, assigned]) => {
      setAllTenants(tenants)
      setAssignedIds(new Set(assigned.map(t => t.TenantID)))
    }).catch(() => setError('Failed to load clients'))
      .finally(() => setLoading(false))
  }, [user.UserID])

  function toggle(id) {
    setAssignedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  async function handleSave() {
    setSaving(true)
    setError('')
    try {
      const res = await fetch(`/api/admin/users/${user.UserID}/tenants`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ tenantIds: [...assignedIds] }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Save failed'); setSaving(false); return }
      onSave()
    } catch { setError('Network error'); setSaving(false) }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{ background: '#fff', borderRadius: 'var(--radius-xl)', boxShadow: '0 8px 40px rgba(0,0,0,0.18)', width: '100%', maxWidth: 400, padding: '28px 32px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div>
            <h3 style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-gray-900)', margin: 0 }}>Client Access</h3>
            <p style={{ fontSize: 12, color: 'var(--color-gray-500)', marginTop: 2 }}>{user.Username}</p>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: 'var(--color-gray-400)', lineHeight: 1 }}>&times;</button>
        </div>

        {error && <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', color: '#b91c1c', borderRadius: 6, padding: '8px 12px', fontSize: 12, marginBottom: 14 }}>{error}</div>}

        {loading ? (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--color-gray-400)', fontSize: 13 }}>Loading…</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
            {allTenants.map(t => {
              const checked = assignedIds.has(t.TenantID)
              return (
                <label key={t.TenantID} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', border: `1px solid ${checked ? 'var(--color-blue)' : 'var(--color-gray-200)'}`, borderRadius: 'var(--radius-md)', cursor: 'pointer', background: checked ? '#eff6ff' : '#fff', transition: 'all 0.12s' }}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(t.TenantID)}
                    style={{ width: 15, height: 15, accentColor: 'var(--color-blue)', cursor: 'pointer', flexShrink: 0 }}
                  />
                  <span style={{ fontSize: 13, fontWeight: checked ? 600 : 400, color: checked ? 'var(--color-blue)' : 'var(--color-gray-800)' }}>
                    {t.TenantName}
                  </span>
                  {!t.IsActive && <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--color-gray-400)' }}>Inactive</span>}
                </label>
              )
            })}
            {allTenants.length === 0 && <p style={{ fontSize: 13, color: 'var(--color-gray-400)', textAlign: 'center' }}>No clients configured yet.</p>}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button onClick={onClose} style={{ background: 'var(--color-gray-100)', border: 'none', borderRadius: 'var(--radius-md)', padding: '8px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer', color: 'var(--color-gray-700)' }}>Cancel</button>
          <button onClick={handleSave} disabled={saving || loading} style={{ background: 'var(--color-blue)', border: 'none', borderRadius: 'var(--radius-md)', padding: '8px 18px', fontSize: 13, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer', color: '#fff', opacity: saving ? 0.7 : 1 }}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ── Main page ────────────────────────────────────────────────────────────── */

export default function Admin() {
  const [users,   setUsers]   = useState([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [modal,        setModal]        = useState(null)   // null | 'new' | user object
  const [tenantModal,  setTenantModal]  = useState(null)   // null | user object

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/admin/users')
      if (res.status === 403) { setError('Admin access required.'); setLoading(false); return }
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      setUsers(await res.json())
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function deleteUser(user) {
    if (!confirm(`Delete "${user.Username}"? This cannot be undone.`)) return
    const res = await fetch(`/api/admin/users/${user.UserID}`, { method: 'DELETE' })
    const data = await res.json()
    if (!res.ok) { alert(data.error || 'Delete failed'); return }
    load()
  }

  function handleSave() {
    setModal(null)
    load()
  }

  const thStyle = {
    padding: '10px 14px',
    textAlign: 'left',
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--color-gray-500)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    borderBottom: '1px solid var(--color-gray-200)',
    whiteSpace: 'nowrap',
    background: 'var(--color-gray-50)',
  }

  const tdStyle = {
    padding: '10px 14px',
    fontSize: 13,
    color: 'var(--color-gray-700)',
    borderBottom: '1px solid var(--color-gray-100)',
    verticalAlign: 'middle',
  }

  return (
    <div className="page">
      <div className="page-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h1 className="page-title">User Management</h1>
          <p className="page-subtitle">Manage dashboard access and MFA enrollment</p>
        </div>
        <button
          onClick={() => setModal('new')}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            background: 'var(--color-blue)', color: '#fff',
            border: 'none', borderRadius: 'var(--radius-md)',
            padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}
        >
          <Plus size={15} /> New User
        </button>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading && (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-gray-400)', fontSize: 13 }}>Loading…</div>
        )}
        {error && (
          <div style={{ padding: 24, color: '#b91c1c', fontSize: 13 }}>{error}</div>
        )}
        {!loading && !error && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['Username', 'Full Name', 'Email', 'Admin', 'Active', 'MFA', 'Clients', 'Last Login', 'Actions'].map(h => (
                    <th key={h} style={thStyle}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.UserID}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--color-gray-50)'}
                    onMouseLeave={e => e.currentTarget.style.background = ''}
                  >
                    <td style={tdStyle}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{
                          width: 28, height: 28, borderRadius: '50%',
                          background: 'var(--color-blue)', color: '#fff',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 11, fontWeight: 700, flexShrink: 0,
                        }}>
                          {(u.FullName || u.Username || '?').split(' ').map(n => n[0]).join('').slice(0,2).toUpperCase()}
                        </div>
                        <strong style={{ color: 'var(--color-gray-900)' }}>{u.Username}</strong>
                      </div>
                    </td>
                    <td style={tdStyle}>{u.FullName || '—'}</td>
                    <td style={tdStyle}>{u.Email || '—'}</td>
                    <td style={tdStyle}><Badge active={u.IsAdmin}  label="Admin" /></td>
                    <td style={tdStyle}><Badge active={u.IsActive} label="Active" /></td>
                    <td style={tdStyle}><MfaBadge enabled={u.TOTPEnabled} /></td>
                    <td style={tdStyle}>
                      <button
                        title="Manage client access"
                        onClick={() => setTenantModal(u)}
                        style={{ background: '#f0fdf4', border: 'none', borderRadius: 6, padding: '5px 8px', cursor: 'pointer', color: '#166534', display: 'flex', alignItems: 'center' }}
                      >
                        <Building2 size={13} />
                      </button>
                    </td>
                    <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>{fmtDate(u.LastLogin)}</td>
                    <td style={tdStyle}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          title="Edit"
                          onClick={() => setModal(u)}
                          style={{ background: '#e0f0ff', border: 'none', borderRadius: 6, padding: '5px 8px', cursor: 'pointer', color: '#1a3a5c', display: 'flex', alignItems: 'center' }}
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          title="Delete"
                          onClick={() => deleteUser(u)}
                          style={{ background: '#fee2e2', border: 'none', borderRadius: 6, padding: '5px 8px', cursor: 'pointer', color: '#b91c1c', display: 'flex', alignItems: 'center' }}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {users.length === 0 && (
                  <tr>
                    <td colSpan={8} style={{ ...tdStyle, textAlign: 'center', color: 'var(--color-gray-400)', padding: 40 }}>
                      No users found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modal && (
        <UserModal
          user={modal === 'new' ? null : modal}
          onClose={() => setModal(null)}
          onSave={handleSave}
        />
      )}

      {tenantModal && (
        <TenantModal
          user={tenantModal}
          onClose={() => setTenantModal(null)}
          onSave={() => setTenantModal(null)}
        />
      )}
    </div>
  )
}

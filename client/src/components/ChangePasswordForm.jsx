import { useState } from 'react'
import { AlertCircle } from 'lucide-react'

function ErrorBanner({ message }) {
  if (!message) return null
  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-start',
      gap: 'var(--space-2)',
      padding: 'var(--space-3) var(--space-4)',
      background: 'var(--color-danger-light)',
      border: '1px solid #fecaca',
      borderRadius: 'var(--radius-md)',
      marginBottom: 'var(--space-5)',
      fontSize: 'var(--font-size-sm)',
      color: '#b91c1c',
      fontWeight: 'var(--font-weight-medium)',
      lineHeight: 'var(--line-height-snug)',
    }}>
      <AlertCircle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
      {message}
    </div>
  )
}

export default function ChangePasswordForm({ onSuccess, submitLabel = 'Update Password' }) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword,     setNewPassword]     = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading,         setLoading]         = useState(false)
  const [error,           setError]           = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    if (newPassword.length < 8) {
      setError('New password must be at least 8 characters')
      return
    }
    if (newPassword !== confirmPassword) {
      setError('New passwords do not match')
      return
    }
    if (newPassword === currentPassword) {
      setError('New password must be different from the current password')
      return
    }
    setLoading(true)
    try {
      const res  = await fetch('/api/auth/change-password', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ currentPassword, newPassword }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not change password')
      onSuccess()
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <ErrorBanner message={error} />

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <div className="form-group">
          <label className="form-label">Current Password</label>
          <input
            className="form-input"
            type="password"
            placeholder="Enter your current password"
            value={currentPassword}
            onChange={e => setCurrentPassword(e.target.value)}
            autoComplete="current-password"
            autoFocus
            required
          />
        </div>

        <div className="form-group">
          <label className="form-label">New Password</label>
          <input
            className="form-input"
            type="password"
            placeholder="At least 8 characters"
            value={newPassword}
            onChange={e => setNewPassword(e.target.value)}
            autoComplete="new-password"
            required
          />
        </div>

        <div className="form-group">
          <label className="form-label">Confirm New Password</label>
          <input
            className="form-input"
            type="password"
            placeholder="Re-enter your new password"
            value={confirmPassword}
            onChange={e => setConfirmPassword(e.target.value)}
            autoComplete="new-password"
            required
          />
        </div>

        <button
          type="submit"
          className="btn btn-primary btn-lg w-full"
          disabled={loading}
          style={{ marginTop: 'var(--space-2)' }}
        >
          {loading ? 'Updating…' : submitLabel}
        </button>
      </form>
    </>
  )
}

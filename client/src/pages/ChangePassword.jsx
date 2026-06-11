import { useNavigate } from 'react-router-dom'
import { ArrowLeft, KeyRound } from 'lucide-react'
import { useAuth } from '../AuthContext'
import ChangePasswordForm from '../components/ChangePasswordForm'

export default function ChangePassword() {
  const { user, setUser } = useAuth()
  const navigate = useNavigate()

  const forced = !!user?.mustChangePwd

  function handleSuccess() {
    setUser(prev => ({ ...prev, mustChangePwd: false }))
    navigate('/', { replace: true })
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: 'var(--color-navy)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 'var(--space-6)',
    }}>
      <div style={{
        width: '100%',
        maxWidth: 420,
        background: 'var(--color-white)',
        borderRadius: 'var(--radius-2xl)',
        boxShadow: '0 32px 64px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.04)',
        padding: 'var(--space-8)',
      }}>
        {!forced && (
          <button
            type="button"
            onClick={() => navigate(-1)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'var(--space-1)',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--color-gray-500)',
              fontSize: 'var(--font-size-sm)',
              fontWeight: 'var(--font-weight-medium)',
              padding: 0,
              marginBottom: 'var(--space-6)',
            }}
          >
            <ArrowLeft size={14} />
            Back
          </button>
        )}

        <div style={{ textAlign: 'center', marginBottom: 'var(--space-6)' }}>
          <div style={{
            width: 52,
            height: 52,
            borderRadius: 'var(--radius-full)',
            background: 'var(--color-blue-muted)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto var(--space-4)',
          }}>
            <KeyRound size={24} style={{ color: 'var(--color-blue)' }} />
          </div>
          <h2 style={{
            fontSize: 'var(--font-size-xl)',
            fontWeight: 'var(--font-weight-bold)',
            color: 'var(--color-gray-900)',
            letterSpacing: 'var(--letter-spacing-tight)',
            marginBottom: 'var(--space-2)',
          }}>
            {forced ? 'Update your password' : 'Change password'}
          </h2>
          <p style={{
            fontSize: 'var(--font-size-sm)',
            color: 'var(--color-gray-500)',
            lineHeight: 'var(--line-height-relaxed)',
          }}>
            {forced
              ? 'Your password must be changed before you can continue.'
              : 'Choose a new password for your account.'}
          </p>
        </div>

        <ChangePasswordForm onSuccess={handleSuccess} />
      </div>
    </div>
  )
}

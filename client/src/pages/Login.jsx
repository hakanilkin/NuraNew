import { useState } from 'react'
import { useNavigate, Navigate } from 'react-router-dom'
import { Eye, EyeOff, Shield, ArrowLeft, AlertCircle } from 'lucide-react'
import { useAuth } from '../AuthContext'

const LOGO_PATH = 'M3 14.5V3.5L9 9L15 3.5V14.5'

/* ─── Sub-components ─────────────────────────────────────────────────────── */

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

/* ─── Step: credentials ──────────────────────────────────────────────────── */

function CredentialsStep({ onSuccess }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPwd,  setShowPwd]  = useState(false)
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    if (!username.trim() || !password) return
    setLoading(true)
    setError('')
    try {
      const res  = await fetch('/api/auth/login', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ username: username.trim(), password }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Login failed')
      onSuccess(data)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <div style={{ marginBottom: 'var(--space-6)' }}>
        <h2 style={{
          fontSize: 'var(--font-size-xl)',
          fontWeight: 'var(--font-weight-bold)',
          color: 'var(--color-gray-900)',
          letterSpacing: 'var(--letter-spacing-tight)',
          marginBottom: 'var(--space-1)',
        }}>
          Welcome back
        </h2>
        <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-gray-500)' }}>
          Sign in to your Nura account
        </p>
      </div>

      <ErrorBanner message={error} />

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <div className="form-group">
          <label className="form-label">Username</label>
          <input
            className="form-input"
            type="text"
            placeholder="Enter your username"
            value={username}
            onChange={e => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
        </div>

        <div className="form-group">
          <label className="form-label">Password</label>
          <div style={{ position: 'relative' }}>
            <input
              className="form-input"
              type={showPwd ? 'text' : 'password'}
              placeholder="Enter your password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              style={{ paddingRight: 40 }}
            />
            <button
              type="button"
              tabIndex={-1}
              onClick={() => setShowPwd(v => !v)}
              style={{
                position: 'absolute',
                right: 10,
                top: '50%',
                transform: 'translateY(-50%)',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--color-gray-400)',
                display: 'flex',
                alignItems: 'center',
                padding: 2,
              }}
            >
              {showPwd ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>

        <button
          type="submit"
          className="btn btn-primary btn-lg w-full"
          disabled={loading}
          style={{ marginTop: 'var(--space-2)' }}
        >
          {loading ? 'Signing in…' : 'Sign In'}
        </button>
      </form>
    </>
  )
}

/* ─── Step: verify / confirm TOTP ────────────────────────────────────────── */

function TotpStep({ mode, qrData, onSuccess, onBack }) {
  const [code,    setCode]    = useState('')
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')

  const endpoint = mode === 'verify' ? '/api/auth/verify-totp' : '/api/auth/confirm-totp'

  async function submit(digits) {
    if (digits.length !== 6) return
    setLoading(true)
    setError('')
    try {
      const res  = await fetch(endpoint, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ code: digits }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Invalid code — try again')
      onSuccess(data)
    } catch (err) {
      setError(err.message)
      setCode('')
    } finally {
      setLoading(false)
    }
  }

  function handleChange(val) {
    const digits = val.replace(/\D/g, '').slice(0, 6)
    setCode(digits)
    if (digits.length === 6) submit(digits)
  }

  return (
    <>
      {/* Back */}
      <button
        type="button"
        onClick={onBack}
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

      {/* Icon + heading */}
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
          <Shield size={24} style={{ color: 'var(--color-blue)' }} />
        </div>
        <h2 style={{
          fontSize: 'var(--font-size-xl)',
          fontWeight: 'var(--font-weight-bold)',
          color: 'var(--color-gray-900)',
          letterSpacing: 'var(--letter-spacing-tight)',
          marginBottom: 'var(--space-2)',
        }}>
          {mode === 'setup' ? 'Set up two-factor auth' : 'Two-factor authentication'}
        </h2>
        <p style={{
          fontSize: 'var(--font-size-sm)',
          color: 'var(--color-gray-500)',
          lineHeight: 'var(--line-height-relaxed)',
        }}>
          {mode === 'setup'
            ? 'Scan the QR code with your authenticator app, then enter the 6-digit code to confirm setup.'
            : 'Enter the 6-digit code from your authenticator app.'}
        </p>
      </div>

      {/* QR + secret for first-time setup */}
      {mode === 'setup' && qrData && (
        <div style={{ marginBottom: 'var(--space-6)' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 'var(--space-4)' }}>
            <img
              src={qrData.qr}
              alt="Authenticator QR code"
              style={{
                width: 176,
                height: 176,
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--surface-border)',
              }}
            />
          </div>
          <div style={{
            background: 'var(--color-gray-50)',
            border: '1px solid var(--surface-border)',
            borderRadius: 'var(--radius-md)',
            padding: 'var(--space-3) var(--space-4)',
          }}>
            <p style={{
              fontSize: 'var(--font-size-xs)',
              fontWeight: 'var(--font-weight-semibold)',
              color: 'var(--color-gray-500)',
              letterSpacing: 'var(--letter-spacing-wide)',
              textTransform: 'uppercase',
              marginBottom: 'var(--space-1)',
            }}>
              Manual entry key
            </p>
            <p style={{
              fontSize: 'var(--font-size-sm)',
              fontFamily: 'monospace',
              color: 'var(--color-gray-900)',
              wordBreak: 'break-all',
              letterSpacing: '0.05em',
            }}>
              {qrData.secret}
            </p>
          </div>
        </div>
      )}

      <ErrorBanner message={error} />

      <form
        onSubmit={e => { e.preventDefault(); submit(code) }}
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
      >
        <div className="form-group">
          <label className="form-label" style={{ textAlign: 'center', display: 'block' }}>
            Verification Code
          </label>
          <input
            className="form-input"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            placeholder="000000"
            maxLength={6}
            value={code}
            onChange={e => handleChange(e.target.value)}
            autoFocus
            style={{
              textAlign: 'center',
              fontSize: 'var(--font-size-2xl)',
              fontWeight: 'var(--font-weight-bold)',
              letterSpacing: '0.35em',
              fontFamily: 'monospace',
              height: 58,
            }}
          />
        </div>

        <button
          type="submit"
          className="btn btn-primary btn-lg w-full"
          disabled={loading || code.length !== 6}
        >
          {loading ? 'Verifying…' : 'Verify Code'}
        </button>
      </form>
    </>
  )
}

/* ─── Page ───────────────────────────────────────────────────────────────── */

export default function Login() {
  const { user, setUser } = useAuth()
  const navigate = useNavigate()

  // step: 'login' | 'verify-totp' | 'setup-totp'
  const [step,   setStep]   = useState('login')
  const [qrData, setQrData] = useState(null)

  // Already authenticated — send to dashboard
  if (user) return <Navigate to="/" replace />

  function handleLoginSuccess(data) {
    if (data.nextStep === 'verify-totp') {
      setStep('verify-totp')
    } else if (data.nextStep === 'setup-totp') {
      setQrData({ qr: data.qr, secret: data.secret })
      setStep('setup-totp')
    }
  }

  function handleTotpSuccess(data) {
    setUser({ isAdmin: data.isAdmin, mustChangePwd: data.mustChangePwd })
    navigate('/', { replace: true })
  }

  function handleBack() {
    setStep('login')
    setQrData(null)
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
      <style>{`
        @keyframes loginFadeUp {
          from { opacity: 0; transform: translateY(18px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .login-card {
          animation: loginFadeUp 0.28s cubic-bezier(0.22, 1, 0.36, 1) both;
        }
      `}</style>

      <div
        className="login-card"
        style={{
          width: '100%',
          maxWidth: 420,
          background: 'var(--color-white)',
          borderRadius: 'var(--radius-2xl)',
          boxShadow: '0 32px 64px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.04)',
          overflow: 'hidden',
        }}
      >
        {/* Wordmark header */}
        <div style={{
          padding: 'var(--space-7) var(--space-8) var(--space-6)',
          borderBottom: '1px solid var(--surface-border)',
          textAlign: 'center',
        }}>
          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--space-3)',
            marginBottom: 'var(--space-3)',
          }}>
            <div style={{
              width: 36,
              height: 36,
              background: 'var(--color-blue)',
              borderRadius: 'var(--radius-md)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: 'var(--shadow-blue)',
              flexShrink: 0,
            }}>
              <svg width="20" height="20" viewBox="0 0 18 18" fill="none">
                <path
                  d={LOGO_PATH}
                  stroke="white"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <span style={{
              fontSize: 'var(--font-size-xl)',
              fontWeight: 'var(--font-weight-bold)',
              color: 'var(--color-gray-900)',
              letterSpacing: 'var(--letter-spacing-tight)',
            }}>
              Nura
            </span>
          </div>
          <p style={{
            fontSize: 'var(--font-size-xs)',
            fontWeight: 'var(--font-weight-semibold)',
            letterSpacing: 'var(--letter-spacing-widest)',
            textTransform: 'uppercase',
            color: 'var(--color-gray-400)',
          }}>
            Healthcare Analytics
          </p>
        </div>

        {/* Form area */}
        <div style={{ padding: 'var(--space-8)' }}>
          {step === 'login' && (
            <CredentialsStep onSuccess={handleLoginSuccess} />
          )}
          {(step === 'verify-totp' || step === 'setup-totp') && (
            <TotpStep
              mode={step === 'verify-totp' ? 'verify' : 'setup'}
              qrData={qrData}
              onSuccess={handleTotpSuccess}
              onBack={handleBack}
            />
          )}
        </div>
      </div>

      <p style={{
        marginTop: 'var(--space-6)',
        fontSize: 'var(--font-size-xs)',
        color: 'rgba(255,255,255,0.25)',
      }}>
        © {new Date().getFullYear()} Nura Health. All rights reserved.
      </p>
    </div>
  )
}

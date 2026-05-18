import { createContext, useContext, useState, useEffect } from 'react'

export const AuthContext = createContext(null)

export function useAuth() {
  return useContext(AuthContext)
}

export function AuthProvider({ children }) {
  const [user,     setUser]     = useState(null)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => r.ok ? r.json() : null)
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setChecking(false))
  }, [])

  return (
    <AuthContext.Provider value={{ user, setUser, checking }}>
      {children}
    </AuthContext.Provider>
  )
}

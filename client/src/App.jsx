import { useState, Fragment, useRef, useEffect, useCallback } from 'react'
import { NavLink, Navigate, Route, Routes, useLocation, BrowserRouter, useNavigate } from 'react-router-dom'
import {
  Activity,
  LayoutGrid,
  BarChart3,
  Map,
  MessageSquareText,
  TrendingUp,
  ChevronRight,
  LogOut,
  ShieldCheck,
  KeyRound,
  Menu,
} from 'lucide-react'
import { AuthProvider, useAuth } from './AuthContext'
import navConfig, { OR_NAV, IP_NAV } from './navConfig'
import Login            from './pages/Login'
import ORPerformance    from './pages/ORPerformance'
import Capacity         from './pages/Capacity'
import BlockUtilization from './pages/BlockUtilization'
import AtlasFCOT        from './pages/AtlasFCOT'
import AtlasTurnover    from './pages/AtlasTurnover'
import AtlasDODC          from './pages/AtlasDODC'
import AtlasBedPlacement        from './pages/AtlasBedPlacement'
import AtlasPerformanceBriefs  from './pages/AtlasPerformanceBriefs'
import AskNura          from './pages/AskNura'
import Admin            from './pages/Admin'
import RoomRunning        from './pages/RoomRunning'
import ForecastsPipeline  from './pages/ForecastsPipeline'
import ChangePassword     from './pages/ChangePassword'

/* ─── Nav config ─────────────────────────────────────────────────────────── */

const ICON_MAP = { Activity, LayoutGrid, BarChart3, Map, MessageSquareText, TrendingUp }

function collectLeafPaths(items) {
  return items.flatMap(item =>
    item.type === 'link' ? [item.path] : collectLeafPaths(item.children ?? [])
  )
}

function buildChildPaths(items, acc = {}) {
  for (const item of items) {
    if (item.type === 'expander') {
      acc[item.id] = collectLeafPaths(item.children ?? [])
      buildChildPaths(item.children ?? [], acc)
    }
  }
  return acc
}

function collectTitles(items, acc = {}) {
  for (const item of items) {
    if (item.type === 'link') acc[item.path] = item.pageTitle ?? item.label
    if (item.children) collectTitles(item.children, acc)
  }
  return acc
}

function collectExpanderIds(items) {
  return items.flatMap(item =>
    item.type === 'expander'
      ? [item.id, ...collectExpanderIds(item.children ?? [])]
      : []
  )
}

const CHILD_PATHS = buildChildPaths(navConfig)
const PAGE_TITLES = collectTitles(navConfig)

/* ─── Auth guard ─────────────────────────────────────────────────────────── */

function RequireAuth({ children }) {
  const { user, checking } = useAuth()
  const { pathname }       = useLocation()
  if (checking) return <AppLoadingScreen />
  if (!user)    return <Navigate to="/login" replace />
  if (user.mustChangePwd && pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />
  }
  return children
}

function RequireAdmin({ children }) {
  const { user } = useAuth()
  if (!user?.isAdmin) return <Navigate to="/" replace />
  return children
}

function AppLoadingScreen() {
  return (
    <div style={{
      minHeight: '100vh',
      background: 'var(--color-navy)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{
          width: 48,
          height: 48,
          background: 'var(--color-blue)',
          borderRadius: 'var(--radius-lg)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          margin: '0 auto var(--space-4)',
          boxShadow: 'var(--shadow-blue)',
        }}>
          <svg width="26" height="26" viewBox="0 0 18 18" fill="none">
            <path
              d="M3 14.5V3.5L9 9L15 3.5V14.5"
              stroke="white"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <p style={{ color: 'rgba(255,255,255,0.35)', fontSize: 'var(--font-size-sm)' }}>
          Loading…
        </p>
      </div>
    </div>
  )
}

/* ─── Placeholder pages ──────────────────────────────────────────────────── */

function PlaceholderPage({ title }) {
  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">{title}</h1>
        <p className="page-subtitle">This section is under construction.</p>
      </div>
      <div className="stat-grid">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="stat-card">
            <div className="stat-card-header">
              <span className="stat-label">Metric {i + 1}</span>
              <div className="stat-icon stat-icon-blue"><Activity size={16} /></div>
            </div>
            <div className="stat-value">—</div>
            <div className="stat-change">
              <span className="stat-change-note">No data yet</span>
            </div>
          </div>
        ))}
      </div>
      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title">{title} Overview</div>
            <div className="card-subtitle">Data will appear here once connected</div>
          </div>
        </div>
        <div className="card-body" style={{ minHeight: 240, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center', color: 'var(--color-gray-400)' }}>
            <BarChart3 size={40} strokeWidth={1.25} style={{ margin: '0 auto var(--space-3)' }} />
            <p className="text-sm font-medium" style={{ color: 'var(--color-gray-500)' }}>No data to display</p>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ─── Nav renderer ───────────────────────────────────────────────────────── */

function renderNavItems(items, level, { isOpen, toggle }) {
  return items.map(item => {
    if (item.type === 'link') {
      if (level === 0) {
        const Icon = ICON_MAP[item.icon]
        return (
          <NavLink
            key={item.id}
            to={item.path}
            end={item.end}
            className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
          >
            <Icon size={18} className="nav-icon" />
            {item.label}
          </NavLink>
        )
      }
      return (
        <LeafLink key={item.id} to={item.path} end={item.end}>
          {item.label}
        </LeafLink>
      )
    }

    if (item.type === 'expander') {
      const Icon     = ICON_MAP[item.icon]
      const iconSize = level === 0 ? 18 : 16
      const chevSize = level === 0 ? 13 : 12
      const opacity  = level === 0 ? 0.09 : 0.06
      const children = item.children ?? []
      return (
        <Fragment key={item.id}>
          <button
            type="button"
            onClick={() => toggle(item.id)}
            className="nav-item"
            style={BTN_RESET}
          >
            <Icon size={iconSize} className="nav-icon" />
            <span style={{ flex: 1 }}>{item.label}</span>
            <Chevron open={isOpen(item.id)} size={chevSize} />
          </button>
          {isOpen(item.id) && (
            <NavGroup opacity={opacity}>
              {children.length
                ? renderNavItems(children, level + 1, { isOpen, toggle })
                : <div style={{
                    padding: '7px 14px',
                    fontSize: 11,
                    color: 'rgba(255,255,255,0.3)',
                    fontStyle: 'italic',
                  }}>
                    Coming soon
                  </div>}
            </NavGroup>
          )}
        </Fragment>
      )
    }

    return null
  })
}

/* ─── Sidebar helpers ────────────────────────────────────────────────────── */

function initials(fullName) {
  if (!fullName) return '?'
  return fullName
    .split(' ')
    .filter(Boolean)
    .map(n => n[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

// Leaf NavLink — no icon, small dot indicator, standard nav-item active styling
function LeafLink({ to, end, children }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
    >
      <span style={{
        width: 5, height: 5, borderRadius: '50%', flexShrink: 0,
        background: 'currentColor', opacity: 0.4, display: 'inline-block',
        marginLeft: 1,
      }} />
      {children}
    </NavLink>
  )
}

// Rotating chevron used by expanders
function Chevron({ open, size = 13 }) {
  return (
    <ChevronRight
      size={size}
      style={{
        flexShrink: 0,
        color: 'var(--sidebar-icon-muted)',
        transform: open ? 'rotate(90deg)' : 'none',
        transition: 'transform 200ms ease',
      }}
    />
  )
}

/* ─── Sidebar ────────────────────────────────────────────────────────────── */

// Shared style override to normalize <button> to look like a nav item
const BTN_RESET = {
  width: '100%', background: 'none', border: 'none',
  cursor: 'pointer', textAlign: 'left',
}

// Container for a group of nested items with a subtle vertical guide line
function NavGroup({ children, opacity = 0.08 }) {
  return (
    <div style={{
      marginLeft: 11,
      paddingLeft: 11,
      borderLeft: `1px solid rgba(255,255,255,${opacity})`,
    }}>
      {children}
    </div>
  )
}

function UserMenu({ user }) {
  const [menuOpen, setMenuOpen]   = useState(false)
  const menuRef                   = useRef(null)
  const navigate                  = useNavigate()
  const { setUser }               = useAuth()

  useEffect(() => {
    if (!menuOpen) return
    function handle(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [menuOpen])

  async function handleSignOut() {
    await fetch('/api/auth/logout', { method: 'POST' })
    setUser(null)
    navigate('/login', { replace: true })
  }

  async function handleSwitchTenant(tenant) {
    setMenuOpen(false)
    const res = await fetch('/api/auth/switch-tenant', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ tenantId: tenant.TenantID }),
    })
    if (res.ok) {
      // Full reload so every page refetches against the new tenant
      window.location.assign('/')
    }
  }

  const multiTenant = (user?.tenants?.length ?? 0) > 1

  const menuBtnStyle = {
    width: '100%', background: 'none', border: 'none',
    color: 'var(--sidebar-text)', padding: '10px 14px',
    display: 'flex', alignItems: 'center', gap: 10,
    fontSize: 'var(--font-size-sm)', cursor: 'pointer',
    textAlign: 'left',
  }

  return (
    <div ref={menuRef} style={{ position: 'relative' }}>
      {menuOpen && (
        <div style={{
          position: 'absolute',
          bottom: 'calc(100% + 8px)',
          left: 0, right: 0,
          background: '#1e2d42',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 'var(--radius-lg)',
          overflow: 'hidden',
          boxShadow: '0 -4px 16px rgba(0,0,0,0.3)',
          zIndex: 100,
        }}>
          {/* Tenant switcher */}
          {multiTenant && (
            <>
              <div style={{ padding: '7px 14px 4px', fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Switch client
              </div>
              {user.tenants.map(t => (
                <button
                  key={t.TenantID}
                  onClick={() => handleSwitchTenant(t)}
                  style={{
                    ...menuBtnStyle,
                    fontWeight: t.TenantID === user.tenantId ? 700 : 400,
                    color: t.TenantID === user.tenantId ? '#fff' : 'var(--sidebar-text)',
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.07)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'none'}
                >
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: t.TenantID === user.tenantId ? 'var(--color-blue)' : 'transparent', border: '1px solid rgba(255,255,255,0.3)', flexShrink: 0 }} />
                  {t.TenantName}
                </button>
              ))}
              <div style={{ height: 1, background: 'rgba(255,255,255,0.08)', margin: '4px 0' }} />
            </>
          )}

          {user?.isAdmin && (
            <button
              onClick={() => { setMenuOpen(false); navigate('/admin') }}
              style={menuBtnStyle}
              onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.07)'}
              onMouseLeave={e => e.currentTarget.style.background = 'none'}
            >
              <ShieldCheck size={15} style={{ opacity: 0.7 }} />
              Admin
            </button>
          )}
          <button
            onClick={() => { setMenuOpen(false); navigate('/change-password') }}
            style={menuBtnStyle}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.07)'}
            onMouseLeave={e => e.currentTarget.style.background = 'none'}
          >
            <KeyRound size={15} style={{ opacity: 0.7 }} />
            Change password
          </button>
          <button
            onClick={handleSignOut}
            style={menuBtnStyle}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.07)'}
            onMouseLeave={e => e.currentTarget.style.background = 'none'}
          >
            <LogOut size={15} style={{ opacity: 0.7 }} />
            Sign out
          </button>
        </div>
      )}

      {/* User row */}
      <div className="sidebar-user" onClick={() => setMenuOpen(o => !o)} style={{ cursor: 'pointer' }}>
        <div className="avatar">{initials(user?.fullName)}</div>
        <div className="sidebar-user-info">
          <div className="sidebar-user-name">{user?.fullName ?? 'User'}</div>
          <div className="sidebar-user-role" style={{ fontSize: 11 }}>
            {user?.tenantName ?? (user?.isAdmin ? 'Administrator' : 'Analyst')}
          </div>
        </div>
        <ChevronRight size={14} style={{ color: 'var(--sidebar-icon-muted)', flexShrink: 0, transform: menuOpen ? 'rotate(90deg)' : 'none', transition: 'transform 200ms ease' }} />
      </div>
    </div>
  )
}

function Sidebar({ drawerOpen, onDrawerClose }) {
  const { user }     = useAuth()
  const { pathname } = useLocation()
  const [open,   setOpen]   = useState({ analytics: false, atlas: false })
  const [domain, setDomain] = useState(() => localStorage.getItem('nura_domain') ?? 'OR')

  // Close the mobile drawer whenever navigation happens
  useEffect(() => {
    onDrawerClose()
  }, [pathname, onDrawerClose])

  function isOpen(id) {
    return !!open[id] || (CHILD_PATHS[id] ?? []).includes(pathname)
  }

  function toggle(id) {
    if ((CHILD_PATHS[id] ?? []).includes(pathname)) return
    setOpen(prev => ({ ...prev, [id]: !prev[id] }))
  }

  function switchDomain(d) {
    localStorage.setItem('nura_domain', d)
    setDomain(d)
    setOpen({ analytics: false, atlas: false })
  }

  const isOR = domain === 'OR'

  return (
    <>
    {drawerOpen && <div className="sidebar-backdrop" onClick={onDrawerClose} />}
    <aside className={`sidebar${drawerOpen ? ' open' : ''}`}>

      {/* ── Logo ── */}
      <div className="sidebar-logo">
        <NavLink to="/ask-nura" style={{ display: 'inline-flex' }}>
          <img src="/nura-logo.svg" alt="Nura" style={{ height: 28, width: 'auto', cursor: 'pointer' }} />
        </NavLink>
      </div>

      {/* ── Domain toggle ── */}
      <div style={{
        display: 'flex',
        margin: '0 12px 12px',
        background: 'rgba(255,255,255,0.08)',
        borderRadius: 8,
        padding: 3,
        gap: 3,
      }}>
        {['OR', 'IP'].map(d => (
          <button
            key={d}
            type="button"
            onClick={() => switchDomain(d)}
            style={{
              flex: 1,
              padding: '5px 0',
              borderRadius: 6,
              border: 'none',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: '0.04em',
              transition: 'background 150ms, color 150ms',
              background: domain === d ? '#3E53E3' : 'transparent',
              color: domain === d ? 'white' : 'rgba(255,255,255,0.45)',
            }}
          >
            {d}
          </button>
        ))}
      </div>

      {/* ── Nav ── */}
      <nav className="sidebar-nav">
        {renderNavItems(isOR ? OR_NAV : IP_NAV, 0, { isOpen, toggle })}
      </nav>

      {/* ── User footer ── */}
      <div className="sidebar-footer">
        <UserMenu user={user} />
      </div>

    </aside>
    </>
  )
}

/* ─── Topbar ─────────────────────────────────────────────────────────────── */

function Topbar({ onMenuClick }) {
  const { pathname } = useLocation()
  const { user }     = useAuth()
  const title        = PAGE_TITLES[pathname] ?? 'Nura'

  return (
    <header className="topbar">
      <button
        className="topbar-menu-btn btn btn-ghost btn-icon"
        aria-label="Open menu"
        onClick={onMenuClick}
      >
        <Menu size={20} />
      </button>
      <span className="topbar-title">{title}</span>
      <div className="topbar-spacer" />
      <div className="topbar-actions">
        <div className="avatar" title={user?.fullName} style={{ cursor: 'default' }}>
          {initials(user?.fullName)}
        </div>
      </div>
    </header>
  )
}

/* ─── Shell ──────────────────────────────────────────────────────────────── */

function Shell() {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const closeDrawer = useCallback(() => setDrawerOpen(false), [])

  return (
    <>
      <Sidebar drawerOpen={drawerOpen} onDrawerClose={closeDrawer} />
      <div className="main-layout">
        <Topbar onMenuClick={() => setDrawerOpen(true)} />
        <Routes>
          <Route path="/"                  element={<ORPerformance />} />
          <Route path="/capacity"          element={<Capacity />} />
          <Route path="/block-utilization" element={<BlockUtilization />} />
          <Route path="/room-running"     element={<RoomRunning />} />
          <Route path="/ip-flow"           element={<PlaceholderPage title="IP Flow" />} />
          <Route path="/atlas"             element={<Navigate to="/atlas/fcot" replace />} />
          <Route path="/atlas/performance-briefs" element={<AtlasPerformanceBriefs />} />
          <Route path="/atlas/fcot"        element={<AtlasFCOT />} />
          <Route path="/atlas/turnover"    element={<AtlasTurnover />} />
          <Route path="/atlas/do-dc"            element={<AtlasDODC />} />
          <Route path="/atlas/bed-placement"    element={<AtlasBedPlacement />} />
          <Route path="/ask-nura"          element={<AskNura />} />
          <Route path="/forecasts"         element={<ForecastsPipeline />} />
          <Route path="/admin"             element={<RequireAdmin><Admin /></RequireAdmin>} />
        </Routes>
      </div>
    </>
  )
}

/* ─── App ────────────────────────────────────────────────────────────────── */

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/change-password"
            element={
              <RequireAuth>
                <ChangePassword />
              </RequireAuth>
            }
          />
          <Route
            path="/*"
            element={
              <RequireAuth>
                <Shell />
              </RequireAuth>
            }
          />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  )
}

import { useState, Fragment } from 'react'
import { NavLink, Navigate, Route, Routes, useLocation, BrowserRouter } from 'react-router-dom'
import {
  Activity,
  LayoutGrid,
  BarChart3,
  Map,
  MessageSquareText,
  TrendingUp,
  ChevronRight,
  Bell,
  Settings,
} from 'lucide-react'
import { AuthProvider, useAuth } from './AuthContext'
import navConfig from './navConfig'
import NuraLogo from './assets/nura-logo.svg'
import Login            from './pages/Login'
import ORPerformance    from './pages/ORPerformance'
import Capacity         from './pages/Capacity'
import BlockUtilization from './pages/BlockUtilization'
import AtlasFCOT        from './pages/AtlasFCOT'
import AtlasTurnover    from './pages/AtlasTurnover'
import AskNura          from './pages/AskNura'

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
  if (checking) return <AppLoadingScreen />
  if (!user)    return <Navigate to="/login" replace />
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
              {renderNavItems(item.children ?? [], level + 1, { isOpen, toggle })}
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

function Sidebar() {
  const { user }     = useAuth()
  const { pathname } = useLocation()
  const [open, setOpen] = useState({ analytics: false, or: false, ip: false, atlas: false })

  // A section is open if manually toggled OR any of its child paths is currently active
  function isOpen(id) {
    return !!open[id] || CHILD_PATHS[id].includes(pathname)
  }

  // Clicking an expander whose child is active is a no-op (active item must stay visible)
  function toggle(id) {
    if (CHILD_PATHS[id].includes(pathname)) return
    setOpen(prev => ({ ...prev, [id]: !prev[id] }))
  }

  return (
    <aside className="sidebar">

      {/* ── Logo ── */}
      <div className="sidebar-logo">
        <img src={NuraLogo} alt="Nura" style={{ height: 32, width: 'auto' }} />
      </div>

      {/* ── Nav ── */}
      <nav className="sidebar-nav">

        {/* Analytics — L1 expander */}
        <button
          type="button"
          onClick={() => toggle('analytics')}
          className="nav-item"
          style={BTN_RESET}
        >
          <BarChart3 size={18} className="nav-icon" />
          <span style={{ flex: 1 }}>Analytics</span>
          <Chevron open={isOpen('analytics')} />
        </button>

        {isOpen('analytics') && (
          <NavGroup opacity={0.09}>

            {/* OR — L2 expander */}
            <button
              type="button"
              onClick={() => toggle('or')}
              className="nav-item"
              style={BTN_RESET}
            >
              <Activity size={16} className="nav-icon" />
              <span style={{ flex: 1 }}>OR</span>
              <Chevron open={isOpen('or')} size={12} />
            </button>

            {isOpen('or') && (
              <NavGroup opacity={0.06}>
                <LeafLink to="/" end>Performance</LeafLink>
                <LeafLink to="/capacity">Capacity</LeafLink>
                <LeafLink to="/block-utilization">Block Utilization</LeafLink>
              </NavGroup>
            )}

            {/* IP — L2 expander */}
            <button
              type="button"
              onClick={() => toggle('ip')}
              className="nav-item"
              style={BTN_RESET}
            >
              <LayoutGrid size={16} className="nav-icon" />
              <span style={{ flex: 1 }}>IP</span>
              <Chevron open={isOpen('ip')} size={12} />
            </button>

            {isOpen('ip') && (
              <NavGroup opacity={0.06}>
                <LeafLink to="/ip-flow">IP Flow</LeafLink>
              </NavGroup>
            )}

          </NavGroup>
        )}

        {/* Atlas — L1 expander */}
        <button
          type="button"
          onClick={() => toggle('atlas')}
          className="nav-item"
          style={BTN_RESET}
        >
          <Map size={18} className="nav-icon" />
          <span style={{ flex: 1 }}>Atlas</span>
          <Chevron open={isOpen('atlas')} />
        </button>

        {isOpen('atlas') && (
          <NavGroup opacity={0.09}>
            <LeafLink to="/atlas/fcot">FCOT Drivers</LeafLink>
            <LeafLink to="/atlas/turnover">Turnover Time</LeafLink>
          </NavGroup>
        )}
        <NavLink to="/ask-nura" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
          <MessageSquareText size={18} className="nav-icon" />
          Ask Nura
        </NavLink>
        <NavLink to="/forecasts" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
          <TrendingUp size={18} className="nav-icon" />
          Forecasts
        </NavLink>

      </nav>

      {/* ── User footer ── */}
      <div className="sidebar-footer">
        <div className="sidebar-user">
          <div className="avatar">{initials(user?.fullName)}</div>
          <div className="sidebar-user-info">
            <div className="sidebar-user-name">{user?.fullName ?? 'User'}</div>
            <div className="sidebar-user-role">{user?.isAdmin ? 'Administrator' : 'Analyst'}</div>
          </div>
          <ChevronRight size={14} style={{ color: 'var(--sidebar-icon-muted)', flexShrink: 0 }} />
        </div>
      </div>

    </aside>
  )
}

/* ─── Topbar ─────────────────────────────────────────────────────────────── */

function Topbar() {
  const { pathname } = useLocation()
  const { user }     = useAuth()
  const title        = PAGE_TITLES[pathname] ?? 'Nura'

  return (
    <header className="topbar">
      <span className="topbar-title">{title}</span>
      <div className="topbar-spacer" />
      <div className="topbar-actions">
        <button className="btn btn-ghost btn-icon" aria-label="Notifications">
          <Bell size={18} />
        </button>
        <button className="btn btn-ghost btn-icon" aria-label="Settings">
          <Settings size={18} />
        </button>
        <div className="avatar" title={user?.fullName} style={{ cursor: 'default' }}>
          {initials(user?.fullName)}
        </div>
      </div>
    </header>
  )
}

/* ─── Shell ──────────────────────────────────────────────────────────────── */

function Shell() {
  return (
    <>
      <Sidebar />
      <div className="main-layout">
        <Topbar />
        <Routes>
          <Route path="/"                  element={<ORPerformance />} />
          <Route path="/capacity"          element={<Capacity />} />
          <Route path="/block-utilization" element={<BlockUtilization />} />
          <Route path="/ip-flow"           element={<PlaceholderPage title="IP Flow" />} />
          <Route path="/atlas"             element={<Navigate to="/atlas/fcot" replace />} />
          <Route path="/atlas/fcot"        element={<AtlasFCOT />} />
          <Route path="/atlas/turnover"    element={<AtlasTurnover />} />
          <Route path="/ask-nura"          element={<AskNura />} />
          <Route path="/forecasts"         element={<PlaceholderPage title="Forecasts" />} />
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

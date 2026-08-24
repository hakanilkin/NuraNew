export const OR_NAV = [
  {
    id: 'analytics', label: 'Analytics', icon: 'BarChart3', type: 'expander',
    children: [
      { id: 'or-performance',    label: 'Case Volumes',          pageTitle: 'Case Volumes',          type: 'link', path: '/',                  end: true },
      { id: 'capacity',          label: 'Prime Time Utilization', pageTitle: 'Prime Time Utilization', type: 'link', path: '/capacity' },
      { id: 'block-utilization', label: 'Block Utilization',      type: 'link', path: '/block-utilization' },
      { id: 'room-running',      label: 'Room Running',            type: 'link', path: '/room-running' },
      { id: 'sf-cases',          label: 'Actual vs Budget',       type: 'link', path: '/schedule-forecast/cases' },
    ],
  },
  {
    id: 'atlas', label: 'Atlas', icon: 'Map', type: 'expander',
    children: [
      { id: 'atlas-fcot',               label: 'FCOT Drivers',       type: 'link', path: '/atlas/fcot' },
      { id: 'atlas-turnover',           label: 'Turnover Time',      type: 'link', path: '/atlas/turnover' },
      { id: 'atlas-performance-briefs', label: 'Performance Briefs', type: 'link', path: '/atlas/performance-briefs' },
    ],
  },
  { id: 'ask-nura',    label: 'Ask Nura',    icon: 'MessageSquareText', type: 'link', path: '/ask-nura' },
  {
    id: 'forecasts', label: 'Forecasts', icon: 'TrendingUp', type: 'expander',
    children: [
      { id: 'sf-daily',  label: 'Daily Summary', type: 'link', path: '/schedule-forecast/daily' },
      { id: 'sf-detail', label: 'Daily Detail',  type: 'link', path: '/schedule-forecast/detail' },
    ],
  },
  {
    // Gated by tenant features — see App.jsx. The pages only exist where the
    // tenant has the data behind them.
    id: 'isscm', label: 'Capacity Decisions', icon: 'Scale', type: 'expander',
    feature: 'isscm',
    children: [
      { id: 'or-smoothing', label: 'OR Smoothing', type: 'link', path: '/or-smoothing', feature: 'smoothing' },
      { id: 'staffing',     label: 'Staffing',     type: 'link', path: '/staffing',     feature: 'staffing' },
    ],
  },
  {
    id: 'open-time', label: 'Open Time', icon: 'CalendarClock', type: 'expander',
    children: [
      { id: 'ot-radar',   label: 'Release Radar',  type: 'link', path: '/open-time/radar' },
      { id: 'ot-tracker', label: 'Release Tracker', type: 'link', path: '/open-time/tracker' },
      { id: 'ot-board',   label: 'Open Time Board', type: 'link', path: '/open-time/board' },
    ],
  },
]

export const IP_NAV = [
  {
    id: 'analytics', label: 'Analytics', icon: 'BarChart3', type: 'expander',
    children: [
      { id: 'ip-los',           label: 'Length of Stay', type: 'link', path: '/ip/los' },
      { id: 'ip-bed-placement', label: 'Bed Placement',   type: 'link', path: '/ip/bed-placement' },
      { id: 'ip-discharges',    label: 'Discharges',      type: 'link', path: '/ip/discharges' },
    ],
  },
  {
    id: 'atlas', label: 'Atlas', icon: 'Map', type: 'expander',
    children: [
      { id: 'atlas-bed-placement', label: 'Bed Placement', type: 'link', path: '/atlas/bed-placement' },
      { id: 'atlas-dodc',          label: 'DO→DC Time',    type: 'link', path: '/atlas/do-dc' },
      { id: 'atlas-los',           label: 'Excess LOS',    type: 'link', path: '/atlas/los' },
    ],
  },
  { id: 'ask-nura',    label: 'Ask Nura',    icon: 'MessageSquareText', type: 'link', path: '/ask-nura' },
  { id: 'forecasts',   label: 'Forecasts',   icon: 'TrendingUp',        type: 'link', path: '/ip/forecast' },
]

// Combined for CHILD_PATHS / PAGE_TITLES — union of both domain trees
const navConfig = [
  {
    id: 'analytics', type: 'expander',
    children: [...OR_NAV[0].children, ...IP_NAV[0].children],
  },
  {
    id: 'atlas', type: 'expander',
    children: [...OR_NAV[1].children, ...IP_NAV[1].children],
  },
  { id: 'ask-nura', type: 'link', path: '/ask-nura' },
  {
    id: 'forecasts', type: 'expander',
    children: OR_NAV[3].children,
  },
  {
    id: 'open-time', type: 'expander',
    children: OR_NAV[4].children,
  },
  { id: 'ip-forecast', type: 'link', path: '/ip/forecast', label: 'Forecasts' },
]

export default navConfig

export const OR_NAV = [
  {
    id: 'analytics', label: 'Analytics', icon: 'BarChart3', type: 'expander',
    children: [
      { id: 'or-performance',    label: 'Case Volumes',          pageTitle: 'Case Volumes',          type: 'link', path: '/',                  end: true },
      { id: 'capacity',          label: 'Prime Time Utilization', pageTitle: 'Prime Time Utilization', type: 'link', path: '/capacity' },
      { id: 'block-utilization', label: 'Block Utilization',      type: 'link', path: '/block-utilization' },
      { id: 'room-running',      label: 'Room Running',            type: 'link', path: '/room-running' },
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
  { id: 'ask-nura',  label: 'Ask Nura',  icon: 'MessageSquareText', type: 'link', path: '/ask-nura' },
  { id: 'forecasts', label: 'Forecasts', icon: 'TrendingUp',        type: 'link', path: '/forecasts' },
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
  { id: 'ask-nura',  label: 'Ask Nura',  icon: 'MessageSquareText', type: 'link', path: '/ask-nura' },
  { id: 'forecasts', label: 'Forecasts', icon: 'TrendingUp',        type: 'link', path: '/ip/forecast' },
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
  { id: 'ask-nura',    type: 'link', path: '/ask-nura' },
  { id: 'forecasts',   type: 'link', path: '/forecasts' },
  { id: 'ip-forecast', type: 'link', path: '/ip/forecast', label: 'Forecasts' },
]

export default navConfig

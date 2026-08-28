export const OR_NAV = [
  {
    // what happened
    id: 'analytics', label: 'Analytics', icon: 'BarChart3', type: 'expander',
    children: [
      { id: 'or-performance',    label: 'Case Volumes',           pageTitle: 'Case Volumes',           type: 'link', path: '/',                  end: true },
      { id: 'capacity',          label: 'Prime Time Utilization', pageTitle: 'Prime Time Utilization', type: 'link', path: '/capacity' },
      { id: 'block-utilization', label: 'Block Utilization',      type: 'link', path: '/block-utilization' },
      { id: 'room-running',      label: 'Room Running',           type: 'link', path: '/room-running' },
    ],
  },
  {
    // why
    id: 'atlas', label: 'Atlas', icon: 'Map', type: 'expander',
    children: [
      { id: 'atlas-fcot',     label: 'FCOT Drivers',  type: 'link', path: '/atlas/fcot' },
      { id: 'atlas-turnover', label: 'Turnover Time', type: 'link', path: '/atlas/turnover' },
    ],
  },
  { id: 'ask-nura', label: 'Ask Nura', icon: 'MessageSquareText', type: 'link', path: '/ask-nura' },
  {
    // what to do about it. The Forecasts group is gone: once a page's centre of
    // gravity is "where should I adjust staffing", it is a decision surface, and
    // every item in this group is forward-looking — so the group advertises the
    // claim rather than one label. "ISSCM" stays the methodology name in
    // positioning material and never appears on screen.
    id: 'capacity-decisions', label: 'Capacity Decisions', icon: 'Scale', type: 'expander',
    children: [
      // A work queue now, not a model page — which is why it left Atlas.
      { id: 'atlas-performance-briefs', label: 'Block Allocations', type: 'link', path: '/atlas/performance-briefs' },
      { id: 'outlook',      label: 'Volume & Staffing Outlook', type: 'link', path: '/outlook' },
      { id: 'open-time',    label: 'Release Time Mgmt', type: 'link', path: '/open-time' },
      { id: 'or-smoothing', label: 'OR Smoothing',      type: 'link', path: '/or-smoothing',      feature: 'smoothing' },
      // The structural half: quarterly, VP-facing. Its forward sibling is the
      // Outlook above.
      { id: 'staffing',     label: 'Staffing Patterns', type: 'link', path: '/staffing-patterns', feature: 'staffing' },
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

// Combined for CHILD_PATHS / PAGE_TITLES — the union of both domain trees.
// Looked up by id rather than by position: indexing groups by their place in
// the array meant any reordering silently dropped a group's page titles.
const byId = (tree, id) => tree.find(g => g.id === id)
const childrenOf = (tree, id) => byId(tree, id)?.children ?? []

const navConfig = [
  { id: 'analytics', type: 'expander',
    children: [...childrenOf(OR_NAV, 'analytics'), ...childrenOf(IP_NAV, 'analytics')] },
  { id: 'atlas', type: 'expander',
    children: [...childrenOf(OR_NAV, 'atlas'), ...childrenOf(IP_NAV, 'atlas')] },
  { id: 'ask-nura', type: 'link', path: '/ask-nura' },
  { id: 'capacity-decisions', type: 'expander', children: childrenOf(OR_NAV, 'capacity-decisions') },
  { id: 'ip-forecast', type: 'link', path: '/ip/forecast', label: 'Forecasts' },
]

export default navConfig

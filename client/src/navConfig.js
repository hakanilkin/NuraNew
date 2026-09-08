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
      // Three questions, three cadences: is the grid right (quarterly), what is
      // coming and what does it do to us (forward), and how do we use the grid
      // we have (continuous).
      { id: 'block-allocations', label: 'Block Allocations', type: 'link', path: '/block-allocations' },
      { id: 'impact',    label: 'Volume Impact',     type: 'link', path: '/impact' },
      { id: 'open-time', label: 'Release Time Mgmt', type: 'link', path: '/open-time' },
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
  {
    // what to do about it today, and what we're learning. The methodology's
    // own name, in the position the OR domain gives Capacity Decisions, so the
    // two domains read the same way. Gated by the tenant feature flag so a
    // tenant without snapshots never sees an entry it cannot load.
    id: 'rtdc', label: 'RTDC', icon: 'Scale', type: 'expander', feature: 'rtdc',
    children: [
      // Today: the meeting and its aftermath — the board and the red-unit Ns are one page, four tabs, in the order the morning runs.
      { id: 'bed-meeting',   label: 'Bed Meeting',   type: 'link', path: '/ip/bed-meeting' },
      // Over time: are we getting better, which units are always mismatched, and what keeps getting in the way.
      { id: 'flow-learning', label: 'Flow Learning', type: 'link', path: '/ip/flow-learning' },
    ],
  },
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
  { id: 'rtdc', type: 'expander', children: childrenOf(IP_NAV, 'rtdc') },
  { id: 'ip-forecast', type: 'link', path: '/ip/forecast', label: 'Forecasts' },
]

export default navConfig

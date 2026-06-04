const navConfig = [
  {
    id:    'analytics',
    label: 'Analytics',
    icon:  'BarChart3',
    type:  'expander',
    children: [
      {
        id:    'or',
        label: 'OR',
        icon:  'Activity',
        type:  'expander',
        children: [
          { id: 'performance',      label: 'Performance',      pageTitle: 'OR Performance', type: 'link', path: '/',                  end: true },
          { id: 'capacity',         label: 'Capacity',                                       type: 'link', path: '/capacity' },
          { id: 'block-utilization',label: 'Block Utilization',                              type: 'link', path: '/block-utilization' },
          { id: 'room-running',     label: 'Room Running',                                   type: 'link', path: '/room-running' },
        ],
      },
      {
        id:    'ip',
        label: 'IP',
        icon:  'LayoutGrid',
        type:  'expander',
        children: [
          { id: 'ip-flow', label: 'IP Flow', type: 'link', path: '/ip-flow' },
        ],
      },
    ],
  },
  {
    id:    'atlas',
    label: 'Atlas',
    icon:  'Map',
    type:  'expander',
    children: [
      { id: 'atlas-fcot',     label: 'FCOT Drivers',  type: 'link', path: '/atlas/fcot' },
      { id: 'atlas-turnover', label: 'Turnover Time',  type: 'link', path: '/atlas/turnover' },
      { id: 'atlas-dodc',          label: 'DO→DC Time',    type: 'link', path: '/atlas/do-dc' },
      { id: 'atlas-bed-placement', label: 'Bed Placement',  type: 'link', path: '/atlas/bed-placement' },
    ],
  },
  {
    id:    'ask-nura',
    label: 'Ask Nura',
    icon:  'MessageSquareText',
    type:  'link',
    path:  '/ask-nura',
  },
  {
    id:    'forecasts',
    label: 'Forecasts',
    icon:  'TrendingUp',
    type:  'link',
    path:  '/forecasts',
  },
]

export default navConfig

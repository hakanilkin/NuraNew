/* The tab bar every RTDC page uses — the same shape as Release Time Mgmt. */
export default function Tabs({ tabs, active, onSelect }) {
  return (
    <div className="rtdc-tabs">
      {tabs.map(t => (
        <button key={t.id} type="button" className={`rtdc-tab${active === t.id ? ' active' : ''}`} onClick={() => onSelect(t.id)}>
          {t.label}{t.badge != null && t.badge > 0 && (
            <span style={{ background: 'var(--color-blue)', color: '#fff', borderRadius: 999, fontSize: 10, fontWeight: 700, padding: '1px 6px' }}>{t.badge}</span>
          )}
        </button>
      ))}
    </div>
  )
}

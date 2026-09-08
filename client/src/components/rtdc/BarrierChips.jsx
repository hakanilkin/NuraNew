/* One-click confirmation of an inferred barrier. The inferred code is
   pre-selected (dashed); confirming makes it solid and records who/when. */
export default function BarrierChips({ barrier, codes, onPick, disabled }) {
  return (
    <div className="rtdc-barrier-chips">
      {codes.map(c => {
        const selected = barrier?.code === c.code
        const cls = ['', selected ? 'selected' : '', selected && barrier?.inferred ? 'inferred' : ''].join(' ')
        return (
          <button key={c.code} type="button" className={cls} disabled={disabled} onClick={() => onPick(c.code)}
                  title={selected && barrier?.inferred ? 'Inferred — click to confirm' : c.label}>
            {c.label}{selected && !barrier?.inferred ? ' ✓' : ''}
          </button>
        )
      })}
    </div>
  )
}

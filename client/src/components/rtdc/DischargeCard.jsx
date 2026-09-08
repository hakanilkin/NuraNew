import { useState } from 'react'

const fmt1 = v => (v == null ? '—' : Number(v).toFixed(1))
const shortDate = d => { const [, m, day] = String(d).split('-'); return `${Number(m)}/${Number(day)}` }

/* The EDD as the huddle reads it: today, a date, or the gap itself. */
function EddPill({ eddDate, eddTime, eddUnknown, date }) {
  if (eddUnknown) return <span className="dc-edd none">EDD: Unknown</span>
  if (!eddDate) return <span className="dc-edd none">No EDD set</span>
  if (eddDate === date) return <span className="dc-edd today">EDD: Today{eddTime ? ` ${eddTime}` : ''}</span>
  return <span className="dc-edd later">EDD: {shortDate(eddDate)}{eddTime ? ` ${eddTime}` : ''}</span>
}

/* One escalation reason, with the evidence: how often this rule converted on
   this unit over the last 30 days. Printed inline — never hover-only, because
   this has to read on a wall display. */
function EscalationRow({ candidate, conversion }) {
  const c = conversion?.[candidate.ruleKey]
  const rate = c
    ? (c.fired >= 10 && c.pct != null ? `${Math.round(c.pct)}% converted on this unit (n=${c.fired}, 30 d)` : `n=${c.fired} on this unit (30 d)`)
    : null
  return (
    <div className="dc-esc-row">
      <span className="key">Escalate · {candidate.ruleKey.replace(/_/g, ' ')}</span>{' — '}
      {candidate.reasonText}
      {candidate.matchedPhrase ? ` Matched: “${candidate.matchedPhrase}”.` : ''}
      {rate && <> <span className="conv">· {rate}</span></>}
    </div>
  )
}

/* A patient in the discharge priority list: who and where, what is done, what
   is left and by when, and — if the rules flagged them — why they are worth
   the room's minutes. PHI posture is unchanged: initials, room, and the masked
   tail of the encounter number are the only identifiers. */
export default function DischargeCard({ p, rank, date, conversion, defaultOpen = true, showHospital = false }) {
  const [open, setOpen] = useState(defaultOpen)
  const meta = [
    p.unit, p.roomBed ? `Bed ${p.roomBed}` : null, p.service, showHospital ? p.hospital : null,
    `LOS ${fmt1(p.losDays)}d vs GMLOS ${fmt1(p.gmlos)}`, p.attending, p.dispo,
  ].filter(Boolean).join(' · ')

  return (
    <article className={`dc-card${p.riskReasons?.length ? ' risk' : ''}`}>
      {rank != null && <div className="dc-rank">{rank}</div>}
      <div className="dc-body">
        <div className="dc-head">
          <span className="dc-id">{p.initials || '—'} · Rm {p.roomBed || '—'}</span>
          {p.csnTail && <span className="dc-csn">CSN ••••{p.csnTail}</span>}
          <EddPill eddDate={p.eddDate} eddTime={p.eddTime} eddUnknown={p.eddUnknown} date={date} />
        </div>
        <div className="dc-meta">{meta}</div>

        {p.riskReasons?.length > 0 && <div className="dc-risk">At risk: {p.riskReasons.join('; ')}</div>}

        <div className="dc-chips">
          {p.chips?.map((c, i) => (
            <span key={i} className={`dc-chip ${c.state}`} title={c.detail}>
              {c.label}
              {(c.at || c.neededBy) && <span className="t">{c.at ? c.at : `by ${c.neededBy}`}</span>}
            </span>
          ))}
          {p.chips?.length === 0 && <span className="dc-chip progress">Nothing recorded</span>}
        </div>

        {open && (
          <>
            {p.narrative
              ? <div className="dc-narr">“{p.narrative}”{p.ownerRole && <span className="who">{p.ownerRole}</span>}</div>
              : <div className="dc-narr" style={{ color: 'var(--color-gray-400)' }}>No narrative.</div>}
            {!p.pendingItemsAvailable && <div className="dc-narr" style={{ color: 'var(--color-gray-400)' }}>Pending items unavailable for this tenant — narrative only.</div>}
            {(p.candidates?.length > 0 || p.excluded) && (
              <div className="dc-esc">
                {p.candidates.map(c => <EscalationRow key={c.ruleKey} candidate={c} conversion={conversion} />)}
                {p.excluded && <div className="dc-esc-row exclude"><span className="key">Not suggested</span> — {p.excluded}</div>}
              </div>
            )}
          </>
        )}
        <button type="button" className="toggle" onClick={() => setOpen(o => !o)}>{open ? 'Hide detail' : 'Show detail'}</button>
      </div>
    </article>
  )
}

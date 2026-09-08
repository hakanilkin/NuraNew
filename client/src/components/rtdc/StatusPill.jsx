import { fmtSigned } from './api'

const WORD = { red: 'Red', even: 'Even', green: 'Green' }

/* Capacity − demand for a unit-day. < 0 red, = 0 even, > 0 green. Semantic
   colour only here; everything else on the board is neutral. `variant="word"`
   prints the status name, for use beside a column that already shows the gap. */
export default function StatusPill({ status, color, title, variant = 'number' }) {
  const c = color ?? (status < 0 ? 'red' : status === 0 ? 'even' : 'green')
  return <span className={`rtdc-pill ${c}`} title={title}>{variant === 'word' ? WORD[c] : fmtSigned(status)}</span>
}

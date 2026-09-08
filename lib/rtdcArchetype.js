// lib/rtdcArchetype.js
//
// Avoidable-N archetypes — RTDC.md §3.2 and §6 "Which Ns could have been Ys?".
// The avoidable population is segmented by disposition × service × attending ×
// pending-item class × narrative phrase, and each archetype gets one plain
// sentence and a suggested bin. This is the improvement backlog.

const T = require('./rtdcTime');
const { narrativeKind } = require('./moveToYes');
const R = require('./rtdcRules');

// Narrative phrase → the bucket that reads on a report, and the bin a fix
// usually lands in.
const PHRASE_BUCKETS = {
  referral:  { label: 'waiting on referral acceptance', bin: 'process' },
  placement: { label: 'waiting on placement',           bin: 'process' },
  transport: { label: 'waiting on transport',           bin: 'process' },
  family:    { label: 'waiting on family',              bin: 'process' },
  scripts:   { label: 'waiting on scripts',             bin: 'Epic config' },
  order:     { label: 'waiting on the discharge order', bin: 'Epic adoption' },
  other:     { label: 'no clear narrative barrier',     bin: 'Epic adoption' },
};

const CLASS_BINS = { lab: 'Epic config', imaging: 'Epic config', consult: 'process', therapy: 'process', referral: 'process', procedure: 'process' };

// Which pending-item class a segment is named after: the one that binds.
const CLASS_PRIORITY = ['referral', 'placement', 'consult', 'therapy', 'procedure', 'imaging', 'lab'];
function bindingClass(items) {
  const classes = (items || []).map(i => String(i.class || 'other').toLowerCase());
  for (const c of CLASS_PRIORITY) if (classes.includes(c)) return c;
  return classes.length ? classes[0] : 'none';
}

function phraseBucket(narrative) {
  const phrases = R.narrativePhrases(narrative);
  // The first recognised phrase that is not the order itself names the
  // barrier; an order-only narrative is "waiting on the order".
  const kinds = phrases.map(narrativeKind);
  const named = kinds.find(k => k !== 'order' && k !== 'other');
  if (named) return named;
  return kinds.includes('order') ? 'order' : 'other';
}

function dispoLabel(d) {
  const u = String(d || '').toUpperCase();
  if (u.includes('HH') || u.includes('HOME HEALTH')) return 'Home-with-HH';
  if (u === 'HOME') return 'Home';
  return d || 'Unknown dispo';
}

function sentence(a) {
  const where = a.unit ? ` on ${a.unit}` : '';
  return `${dispoLabel(a.dispo)}${where} ${PHRASE_BUCKETS[a.phrase].label}` +
    `${a.itemClass !== 'none' ? ` (${a.itemClass} pending)` : ''} — ${a.n} patients, ${a.bedHours} bed-hours.`;
}

// rows: avoidable rows from scoreDay (with date, unit). Returns archetypes
// grouped over the range with the weeks they occurred in.
function buildArchetypes(scoredDays, { top = 10, minN = 1 } = {}) {
  const groups = new Map();
  for (const d of scoredDays) {
    for (const r of d.rows) {
      if (!r.avoidable) continue;
      const itemClass = bindingClass(r.pendingItems);
      const phrase = phraseBucket(r.narrative);
      // The segment is what a process fix can act on: where, who is going
      // where, what they were waiting on. Service and attending are reported
      // inside the segment (they name the conversation), not split out of it.
      const key = [r.unit || '', r.dispo || '', phrase, itemClass].join('|');
      const g = groups.get(key) || {
        key, dispo: r.dispo, itemClass, phrase, unit: r.unit,
        n: 0, bedHours: 0, weeks: new Set(), encounters: [], services: {}, attendings: {},
      };
      g.n += 1; g.bedHours += r.bedHours || 0; g.weeks.add(T.weekStart(d.date));
      g.services[r.service || '—'] = (g.services[r.service || '—'] || 0) + 1;
      g.attendings[r.attending || '—'] = (g.attendings[r.attending || '—'] || 0) + 1;
      g.encounters.push({ date: d.date, roomBed: r.roomBed, initials: r.initials, service: r.service, attending: r.attending,
                          why: r.avoidableWhy, dischargedTime: r.dischargedTime, orderTime: r.orderTime, encounterKey: r.encounterKey });
      groups.set(key, g);
    }
  }
  const topOf = obj => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, n]) => ({ name, n }));
  const out = [...groups.values()].filter(g => g.n >= minN).map(g => {
    const bin = g.itemClass !== 'none' && CLASS_BINS[g.itemClass] ? CLASS_BINS[g.itemClass] : PHRASE_BUCKETS[g.phrase].bin;
    const a = { ...g, bedHours: Math.round(g.bedHours * 10) / 10, weeks: [...g.weeks].sort(), suggestedBin: bin,
                services: topOf(g.services), attendings: topOf(g.attendings) };
    a.sentence = sentence(a);
    return a;
  });
  out.sort((a, b) => b.bedHours - a.bedHours || b.n - a.n);
  return out.slice(0, top);
}

module.exports = { buildArchetypes, phraseBucket, bindingClass, PHRASE_BUCKETS, dispoLabel };

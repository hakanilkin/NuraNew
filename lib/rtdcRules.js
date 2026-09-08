// lib/rtdcRules.js
//
// Escalation candidates — RTDC.md §5. A short rule table evaluated on every N
// at the huddle snapshot. No weights, no model, no ranking beyond rule order
// and excess LOS. Each rule reads Epic state only; the one text-derived rule
// (EDD_SLIPPED) uses a tenant-editable keyword list and reports the phrase it
// matched, so nothing on the report is unexplained.

const HOME_DISPOS      = ['HOME', 'HOME W/ HH', 'HOME WITH HH', 'HOME HEALTH', 'HOME W/ HOME HEALTH'];
const PLACEMENT_DISPOS = ['SNF', 'REHAB', 'LTACH', 'IRF', 'ACUTE REHAB'];
const CLINICAL_CLASSES = ['lab', 'imaging', 'consult', 'therapy', 'procedure'];
const ORDERABLE_TODAY  = ['lab', 'imaging', 'therapy'];

const up = v => (v == null ? '' : String(v).trim().toUpperCase());
const isHome = d => HOME_DISPOS.includes(up(d));
const isPlacement = d => PLACEMENT_DISPOS.includes(up(d));

function flags(p) {
  const f = p.FLAGS;
  if (!f) return [];
  if (Array.isArray(f)) return f.map(x => String(x).toLowerCase());
  try { const j = JSON.parse(f); return Array.isArray(j) ? j.map(x => String(x).toLowerCase()) : []; }
  catch { return String(f).split(/[,;]/).map(x => x.trim().toLowerCase()).filter(Boolean); }
}

// Active, unresulted orders. Null when the tenant does not supply them
// (feature flag off), which every rule treats as "unknown", not "none".
function pendingItems(p) {
  const v = p.PENDING_ITEMS;
  if (v == null) return null;
  let arr = v;
  if (typeof v === 'string') { try { arr = JSON.parse(v); } catch { return null; } }
  if (!Array.isArray(arr)) return null;
  return arr
    .filter(i => i && !['resulted', 'complete', 'completed', 'cancelled', 'done'].includes(String(i.status || '').toLowerCase()))
    .map(i => ({ ...i, class: String(i.class || 'other').toLowerCase() }));
}

// The narrative, as phrases. "DC order, HH TPN needs to be arranged, family
// transportation." → three phrases. Kept deliberately naive — no NLP.
function narrativePhrases(text) {
  if (!text) return [];
  return String(text)
    .split(/[,;.\n]+|\band\b/i)
    .map(s => s.trim())
    .filter(s => s.length > 1);
}

function excluded(p) {
  const f = flags(p);
  if (f.includes('comfort_care') || f.includes('comfort care')) return 'comfort care';
  if (f.includes('isolation_cohort') || f.includes('cohort')) return 'isolation with cohort constraint';
  if (f.includes('in_custody') || f.includes('custody')) return 'in custody';
  if (p.PRED_UNKNOWN) return 'EDD unknown';
  if (up(p.LEVEL_OF_CARE) === 'ICU') return 'ICU level of care';
  return null;
}

const truthy = v => v === true || v === 1 || ['Y', 'YES', 'TRUE', '1'].includes(up(v));

// ctx: { today, cutoff, pendingItemsAvailable }
// Returns { excluded: reason|null, candidates: [{ ruleKey, reasonText, matchedPhrase }] }.
function evaluateRules(p, rules, ctx) {
  const ex = excluded(p);
  const enabled = (rules || []).filter(r => r.enabled && r.rule_key !== 'EXCLUDE');
  if (ex) return { excluded: ex, candidates: [] };
  if (p.pred !== 'N') return { excluded: null, candidates: [] };

  const items = pendingItems(p);
  const known = items !== null;
  const clinicalPending = known ? items.filter(i => CLINICAL_CLASSES.includes(i.class)) : null;
  const eddDate = p.PRED_SOURCE_DATE ? String(p.PRED_SOURCE_DATE).slice(0, 10) : null;
  const eddTime = p.PRED_SOURCE_TIME ? String(p.PRED_SOURCE_TIME).slice(0, 5) : null;
  const dispo = p.EXPECTED_DISPOSITION;
  const f = flags(p);

  const out = [];
  for (const r of enabled) {
    const params = r.params || {};
    let fired = false; let matchedPhrase = null;
    switch (r.rule_key) {
      case 'ORDER_WRITTEN':
        fired = !!p.DC_ORDER_AT;
        break;
      case 'MRD_HOME': {
        const noLabImg = !known || !items.some(i => ['lab', 'imaging'].includes(i.class));
        const noConsult = !known || !items.some(i => i.class === 'consult');
        fired = truthy(p.MRD) && isHome(dispo) && noLabImg && noConsult;
        break;
      }
      case 'EDD_SLIPPED': {
        const slipped = eddDate === ctx.today && !!eddTime && eddTime > (ctx.cutoff || '14:00');
        if (slipped) {
          const kws = (r.keywords || []).map(k => String(k).toLowerCase()).filter(Boolean);
          const phrases = narrativePhrases(p.DC_NARRATIVE);
          const matches = phrases.map(ph => ({ ph, kw: kws.find(k => ph.toLowerCase().includes(k)) }));
          const allMatch = phrases.length > 0 && matches.every(m => m.kw);
          const noClinical = !known || clinicalPending.length === 0;
          if (allMatch && noClinical) { fired = true; matchedPhrase = matches[0].ph; }
        }
        break;
      }
      case 'PLACEMENT_SECURED':
        fired = isPlacement(dispo) && ['accepted', 'authorized'].includes(String(p.PLACEMENT_STATUS || '').toLowerCase());
        break;
      case 'LOS_EXCESS': {
        const delta = Number.isFinite(Number(params.los_delta_days)) ? Number(params.los_delta_days) : 1;
        const los = Number(p.LOS_DAYS), gm = Number(p.GMLOS);
        fired = Number.isFinite(los) && Number.isFinite(gm) && los >= gm + delta
          && isHome(dispo) && !['ICU', 'PCU'].includes(up(p.LEVEL_OF_CARE))
          && !f.some(x => x.startsWith('isolation'));
        break;
      }
      case 'SINGLE_STEP':
        fired = known && items.length === 1 && ORDERABLE_TODAY.includes(items[0].class);
        break;
      default:
        fired = false;
    }
    if (fired) out.push({ ruleKey: r.rule_key, reasonText: r.reason_text, matchedPhrase });
  }
  return { excluded: null, candidates: out };
}

module.exports = {
  evaluateRules, excluded, pendingItems, narrativePhrases, flags,
  isHome, isPlacement, truthy, HOME_DISPOS, PLACEMENT_DISPOS, CLINICAL_CLASSES,
};

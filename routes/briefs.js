const express = require('express');
const path    = require('path');

const { tenantDataDir, readJsonFile } = require('../lib/tenantData');
const { getParam } = require('../utils/tenantColumns');

// Performance Briefs — forward layer ("where to focus").
//
// The briefs pipeline classifies every CaseBlock over the two most recent
// complete quarters. That is retrospective and quarterly, so it stays in the
// JSON it already writes. Forward booked volume changes daily, so it is queried
// live and joined here, at request time. Crossing the two axes turns the page
// from a report card into a work queue.
//
// The merge and the focus classification happen server-side on purpose: the
// frontend renders `focus` and `reason` verbatim rather than re-deriving them
// from two sources that could disagree. See BriefsForwardLayer.md.

const DEFAULT_HORIZON_DAYS = 28;
const DEFAULT_FILL_TARGET  = 75;

// Retrospective statuses the pipeline emits.
const OVERSUPPLIED = new Set(['over_allocated', 'misaligned']);

// Order the queue is served in — the whole point of the layer is that ACT
// comes first.
const FOCUS_ORDER = ['ACT', 'GROW', 'SELF_OK', 'WATCH', 'OK'];

const pct = n => (n === null || n === undefined || Number.isNaN(n) ? null : Math.round(n * 10) / 10);

/**
 * Cross a block's retrospective status with its forward fill.
 *
 * `fwdFillPct` is null when the block has no forward block time at all — a
 * legitimate "we don't know" that must never be shown as 0%, because 0% and
 * unknown call for opposite actions. Unknown falls back to the status alone.
 *
 * Pure and exported so it can be tested without a database or a data file.
 */
function classifyFocus(status, fwdFillPct, target) {
  const known = fwdFillPct !== null && fwdFillPct !== undefined;
  const below = known && fwdFillPct < target;
  const atOrAbove = known && fwdFillPct >= target;

  if (OVERSUPPLIED.has(status)) {
    if (below)     return 'ACT';       // chronic underuse and nothing coming
    if (atOrAbove) return 'SELF_OK';   // ran light, but the book is filling
    return 'WATCH';                    // forward unknown — do not call it ACT
  }
  if (status === 'under_allocated') {
    if (atOrAbove) return 'GROW';      // bursting and still booking
    return 'WATCH';                    // hot historically, cooling forward
  }
  if (status === 'watch') return 'WATCH';
  return 'OK';
}

/** The house driver idiom: say what was measured, then what it implies. */
function buildReason(status, inblockUtil, fwdFillPct, target, horizonDays) {
  const weeks = Math.round(horizonDays / 7);
  const window = weeks >= 1 ? `next ${weeks} week${weeks === 1 ? '' : 's'}` : `next ${horizonDays} days`;
  const ran = inblockUtil === null || inblockUtil === undefined
    ? 'no in-block utilisation recorded'
    : `${pct(inblockUtil)}% in-block`;

  const label = {
    over_allocated:  'Over-allocated last two quarters',
    misaligned:      'Misaligned last two quarters',
    under_allocated: 'Under-allocated last two quarters',
    right_sized:     'Right-sized last two quarters',
    watch:           'Flagged to watch last two quarters',
  }[status] ?? 'Classified last two quarters';

  if (fwdFillPct === null || fwdFillPct === undefined) {
    return `${label} (${ran}); no block time in the ${window}, so forward fill is unknown.`;
  }
  return `${label} (${ran}) and forecast fills ${pct(fwdFillPct)}% of the ${window} `
       + `vs a ${target}% target.`;
}

module.exports = function briefsRoutes(getTenantPool, sql, requireTenant) {
  const router = express.Router();
  router.use(requireTenant);

  // ── GET /api/briefs/focus ──────────────────────────────────────────────────
  router.get('/focus', async (req, res) => {
    try {
      const tenant = req.tenantName || 'default';
      const horizonDays = Math.min(Math.max(parseInt(req.query.horizonDays, 10) || DEFAULT_HORIZON_DAYS, 7), 120);
      const target = Number(getParam(tenant, 'block_fill_target') ?? DEFAULT_FILL_TARGET);

      // ── Retrospective layer: the pipeline's own output, untouched ─────────
      let briefs;
      try {
        briefs = readJsonFile(path.join(tenantDataDir(tenant), 'performance_briefs.json'));
      } catch (err) {
        if (err.message === 'not_found') {
          return res.json({
            error: 'no_atlas_data',
            message: 'Performance briefs have not been generated for this organization yet.',
          });
        }
        throw err;
      }
      const groups = Array.isArray(briefs.groups) ? briefs.groups : [];

      // ── Forward layer: same view, same math as the Release Radar, so the
      //    two surfaces cannot quote different numbers for the same block. ──
      const fwd = new Map();
      try {
        const dbReq = (await getTenantPool(req.session.tenantId)).request();
        dbReq.input('horizonDays', sql.Int, horizonDays);
        const result = await dbReq.query(`
          SELECT
            ISNULL(Caseblock, 'Unknown')          AS CaseBlock,
            SUM(ISNULL(BLOCKTIME, 0))             AS FwdBlockMins,
            -- Booked so far, matching the Radar. "How much of the next four
            -- weeks is on the books" is a different question from "how much
            -- will this day eventually run".
            SUM(ISNULL(SCHEDULED_INPATIENT_DURwTurn, 0) + ISNULL(SCHEDULED_OUTPATIENT_DURwTurn, 0))
                                                  AS FwdBookedMins
          FROM V4_FORECAST_COMPILE
          WHERE DaysAhead BETWEEN 1 AND @horizonDays
          GROUP BY Caseblock
        `);
        for (const r of result.recordset) {
          fwd.set(r.CaseBlock, {
            blockMins:  Number(r.FwdBlockMins)  || 0,
            bookedMins: Number(r.FwdBookedMins) || 0,
          });
        }
      } catch (err) {
        // A missing or empty forward view is a degraded state, not a failure:
        // every item then carries fwd_fill_pct null and focus falls back to
        // status alone.
        console.error('/api/briefs/focus forward query failed:', err.message);
      }

      const items = groups.map(g => {
        const f = fwd.get(g.caseblock);
        const fwdFill = f && f.blockMins > 0 ? (f.bookedMins / f.blockMins) * 100 : null;
        const focus = classifyFocus(g.status, fwdFill, target);
        return {
          caseblock:      g.caseblock,
          status:         g.status,
          inblock_util:   pct(g.inblock_util),
          primetime_util: pct(g.primetime_util),
          volume:         g.volume ?? null,
          fwd_fill_pct:   pct(fwdFill),
          fwd_block_mins: f ? f.blockMins : null,
          focus,
          reason:         buildReason(g.status, g.inblock_util, fwdFill, target, horizonDays),
        };
      });

      // ACT first, then GROW, and within a bucket the blocks furthest from
      // target — the ones where the gap is widest — come first. Blocks with no
      // forward signal sort last within their bucket.
      items.sort((a, b) => {
        const byFocus = FOCUS_ORDER.indexOf(a.focus) - FOCUS_ORDER.indexOf(b.focus);
        if (byFocus !== 0) return byFocus;
        const da = a.fwd_fill_pct === null ? -1 : Math.abs(a.fwd_fill_pct - target);
        const db = b.fwd_fill_pct === null ? -1 : Math.abs(b.fwd_fill_pct - target);
        if (db !== da) return db - da;
        return String(a.caseblock).localeCompare(String(b.caseblock));
      });

      const counts = FOCUS_ORDER.reduce((acc, k) => ({ ...acc, [k]: 0 }), {});
      for (const it of items) counts[it.focus] += 1;

      res.json({
        period: briefs.period ?? null,
        horizonDays,
        target,
        forward_available: fwd.size > 0,
        items,
        counts,
      });
    } catch (err) {
      console.error('/api/briefs/focus error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
};

// Exported for the classifier tests; not part of the HTTP surface.
module.exports.classifyFocus = classifyFocus;
module.exports.buildReason   = buildReason;
module.exports.FOCUS_ORDER   = FOCUS_ORDER;

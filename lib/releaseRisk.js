// lib/releaseRisk.js
//
// Release-Risk scoring for the OR Open Time "Release Radar" (Phase 1).
//
// This is the transparent, explainable model described in OROpenTime.md §6.
// It blends a small set of individually-meaningful features into a 0–100 score
// where higher = the block is more likely to under-utilize (i.e. a better
// candidate to ask the owner to release). Every feature carries its own weight
// and contribution, so the score *is* its own explanation — the `drivers` array
// returned per block is exactly what the UI reasoning panel renders.
//
// The output schema is intentionally model-agnostic: `{ risk, drivers[] }`.
// A future EBM (Phase 2) can replace the internals of scoreBlock() without the
// API or UI changing.

const DEFAULT_CFG = {
  // "Healthy" thresholds — a block filling at/above these contributes no risk.
  fillTarget: 75, // forecast % of block time filled (duration incl. turnover)
  utilTarget: 75, // trailing prime-time utilization %
  // Relative importance of each feature (need not sum to 1 — we normalize by the
  // weights of the features actually present for a given block).
  weights: {
    forwardFill:    0.50, // strongest signal: how full the forecast says it will be
    chronicUtil:    0.30, // does this block chronically run light?
    releaseHistory: 0.20, // has this block historically been released?
  },
};

function clamp01(x) {
  if (x == null || Number.isNaN(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function round1(x) {
  return x == null ? null : Math.round(x * 10) / 10;
}

// Score a single forward block instance against its historical stats.
//   fwd  — one aggregated row from V4_FORECAST_COMPILE (see routes/opentime.js)
//   hist — matching aggregated row from V4_BlockResultsView, or undefined
// Returns a display-ready radar row.
function scoreBlock(fwd, hist, cfg = DEFAULT_CFG) {
  const w = cfg.weights;

  const blockTime = num(fwd.BlockTime);
  const totalDur  = num(fwd.TotalDurwTurn);
  const forwardFillPct = blockTime > 0 ? (totalDur / blockTime) * 100 : null;

  const histBlock = hist ? num(hist.SumBlock)    : 0;
  const histPrime = hist ? num(hist.SumPrime)    : 0;
  const histRel   = hist ? num(hist.SumReleased) : 0;
  const histUtilPct   = histBlock > 0 ? (histPrime / histBlock) * 100 : null;
  const releaseRatePct = histBlock > 0 ? clamp01(histRel / histBlock) * 100 : null;

  const drivers = [];
  let num_ = 0; // Σ weight·contribution
  let den_ = 0; // Σ weight (of present features)

  // Feature 1 — low forward fill (the block looks light on the current forecast)
  if (forwardFillPct != null) {
    const c = clamp01((cfg.fillTarget - forwardFillPct) / cfg.fillTarget);
    num_ += w.forwardFill * c;
    den_ += w.forwardFill;
    drivers.push({
      key: 'forwardFill',
      label: 'Low forecast fill',
      contribution: Math.round(c * 100),
      weight: w.forwardFill,
      detail: `Forecast fills ${round1(forwardFillPct)}% of block time vs a ${cfg.fillTarget}% target`,
    });
  }

  // Feature 2 — chronically light utilization historically
  if (histUtilPct != null) {
    const c = clamp01((cfg.utilTarget - histUtilPct) / cfg.utilTarget);
    num_ += w.chronicUtil * c;
    den_ += w.chronicUtil;
    drivers.push({
      key: 'chronicUtil',
      label: 'Runs light historically',
      contribution: Math.round(c * 100),
      weight: w.chronicUtil,
      detail: `Trailing prime-time utilization ${round1(histUtilPct)}% vs a ${cfg.utilTarget}% target`,
    });
  }

  // Feature 3 — this block has a history of being released
  if (releaseRatePct != null) {
    const c = clamp01(releaseRatePct / 100);
    num_ += w.releaseHistory * c;
    den_ += w.releaseHistory;
    drivers.push({
      key: 'releaseHistory',
      label: 'Released before',
      contribution: Math.round(c * 100),
      weight: w.releaseHistory,
      detail: `${round1(releaseRatePct)}% of recent block time was released`,
    });
  }

  const risk = den_ > 0 ? Math.round((num_ / den_) * 100) : null;

  // Rank drivers by actual influence (weight · contribution), strongest first.
  drivers.sort((a, b) => (b.weight * b.contribution) - (a.weight * a.contribution));

  return {
    id: `${fwd.Date}__${fwd.Site}__${fwd.CaseBlock}`,
    Date:        fwd.Date,
    DayOfWeek:   fwd.DayOfWeek,
    Site:        fwd.Site,
    CaseBlock:   fwd.CaseBlock,
    Service:     fwd.Service,
    DaysAhead:   fwd.DaysAhead == null ? null : num(fwd.DaysAhead),

    ScheduledCases:  round1(num(fwd.ScheduledCases)),
    ForecastAddition: round1(num(fwd.ForecastAddition)),
    TotalForecastCases: round1(num(fwd.ScheduledCases) + num(fwd.ForecastAddition)),
    BlockTimeMins:   blockTime,
    ForecastFillPct: round1(forwardFillPct),

    HistBlockDays:   hist ? num(hist.BlockDays) : 0,
    HistUtilPct:     round1(histUtilPct),
    ReleaseRatePct:  round1(releaseRatePct),

    risk,
    drivers,
    summary: buildSummary(drivers, risk),
  };
}

// Turn the ranked drivers into one plain-English sentence for the row.
function buildSummary(drivers, risk) {
  if (!drivers.length || risk == null) return 'Not enough data to score this block.';
  const top = drivers.filter(d => d.contribution > 0).slice(0, 2);
  if (!top.length) return 'Forecast and history both look healthy for this block.';
  const phrases = top.map(d => d.detail.charAt(0).toLowerCase() + d.detail.slice(1));
  return `${phrases.join('; ')}.`;
}

// Score a list of forward rows against a Map<CaseBlock, histRow>.
function scoreBlocks(fwdRows, histMap, cfg = DEFAULT_CFG) {
  return fwdRows.map(f => scoreBlock(f, histMap.get(f.CaseBlock), cfg));
}

module.exports = { scoreBlock, scoreBlocks, DEFAULT_CFG };

const express = require('express');
const path    = require('path');
const fs      = require('fs');

const router = express.Router();

// Root of all tenant data directories
const DATA_DIR = path.join(__dirname, '..', 'public', 'data');

// Resolve a per-tenant data directory, sanitizing the tenant name to prevent
// path traversal.  Only lowercase alphanumeric chars are kept.
function tenantDataDir(tenantName) {
  const safe = (tenantName || 'nhs').toLowerCase().replace(/[^a-z0-9]/g, '') || 'nhs';
  return path.join(DATA_DIR, safe);
}

// Read a JSON file at an absolute filePath.
function readJsonFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      const e = new Error('not_found');
      e.filePath = filePath;
      throw e;
    }
    throw err;
  }
  return JSON.parse(raw);
}

// Respond with JSON from filePath.
// opts.noAtlasData  — when file missing, return 200 { error: 'no_atlas_data' }
//                     instead of 404.  Use for model files — gives the frontend
//                     a clean "not generated yet" signal without a scary error.
// opts.emptyFallback — return this value on 404 (lower priority than noAtlasData)
// opts.notFoundMsg   — 404 error message (used when neither opt above is set)
function sendJsonFile(res, route, filePath, { notFoundMsg, emptyFallback, noAtlasData } = {}) {
  try {
    res.json(readJsonFile(filePath));
  } catch (err) {
    if (err.message === 'not_found') {
      if (noAtlasData) {
        return res.json({
          error:   'no_atlas_data',
          message: 'Atlas data has not been generated for this organization yet.',
        });
      }
      if (emptyFallback) return res.json(emptyFallback);
      return res.status(404).json({ error: notFoundMsg ?? 'Data file not found' });
    }
    if (err instanceof SyntaxError) {
      console.error(`${route} parse error:`, err.message);
      return res.status(500).json({ error: 'Data file is corrupted or not valid JSON' });
    }
    console.error(`${route} read error:`, err.message);
    res.status(500).json({ error: 'Could not read data file' });
  }
}

// GET /api/atlas/fcot-model
router.get('/fcot-model', (req, res) => {
  const filePath = path.join(tenantDataDir(req.tenantName), 'fcot_ebm.json');
  sendJsonFile(res, '/api/atlas/fcot-model', filePath, { noAtlasData: true });
});

// GET /api/atlas/turnover-model
router.get('/turnover-model', (req, res) => {
  const filePath = path.join(tenantDataDir(req.tenantName), 'turnover_ebm.json');
  sendJsonFile(res, '/api/atlas/turnover-model', filePath, { noAtlasData: true });
});

// POST /api/atlas/explain-interaction
router.post('/explain-interaction', async (req, res) => {
  const { feature_1, feature_2, x_labels_1, x_labels_2, scores_matrix } = req.body;
  if (!feature_1 || !feature_2 || !scores_matrix) {
    return res.status(400).json({ error: 'feature_1, feature_2, and scores_matrix are required' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const cells = [];
  for (let r = 0; r < scores_matrix.length; r++) {
    for (let c = 0; c < (scores_matrix[r]?.length ?? 0); c++) {
      const v  = scores_matrix[r][c];
      const l1 = x_labels_1?.[r] ?? `bin${r}`;
      const l2 = x_labels_2?.[c] ?? `bin${c}`;
      cells.push({ l1, l2, v });
    }
  }
  cells.sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
  const topRows = cells.slice(0, 6)
    .map(c => `  ${c.l1} × ${c.l2}: ${c.v >= 0 ? '+' : ''}${c.v.toFixed(1)} min`)
    .join('\n');

  const systemPrompt = `Write exactly 2 sentences about what this data means for a hospital operations leader. No headers, no bullet points, no markdown, no technical terms. Plain conversational English only. First sentence states the key finding. Second sentence states what action to take.`;

  const prompt = `Feature interaction: ${feature_1.replace(/_/g, ' ')} × ${feature_2.replace(/_/g, ' ')}

Effect on first-case start time (positive = later, negative = earlier, in minutes):
${topRows}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type':      'application/json',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system:     systemPrompt,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('/api/atlas/explain-interaction Anthropic error:', data);
      return res.status(502).json({ error: data?.error?.message ?? 'Anthropic API error' });
    }

    const narrative = data.content?.find(b => b.type === 'text')?.text ?? '';
    res.json({ narrative });
  } catch (err) {
    console.error('/api/atlas/explain-interaction error:', err.message);
    res.status(500).json({ error: 'Could not reach Anthropic API' });
  }
});

// GET /api/atlas/do-dc-{overall,home,snf,hh}
const DODC_FILES = {
  'do-dc-overall': 'do_dc_overall_ebm.json',
  'do-dc-home':    'do_dc_home_ebm.json',
  'do-dc-snf':     'do_dc_snf_ebm.json',
  'do-dc-hh':      'do_dc_hh_ebm.json',
};
for (const [route, filename] of Object.entries(DODC_FILES)) {
  router.get(`/${route}`, (req, res) => {
    const filePath = path.join(tenantDataDir(req.tenantName), filename);
    sendJsonFile(res, `/api/atlas/${route}`, filePath, { noAtlasData: true });
  });
}

// GET /api/atlas/los-segments
router.get('/los-segments', (req, res) => {
  const filePath = path.join(tenantDataDir(req.tenantName), 'los_segments.json');
  sendJsonFile(res, '/api/atlas/los-segments', filePath, { noAtlasData: true });
});

// GET /api/atlas/do-los-{overall,facility,selfcare,homehealth}
const DOLOS_FILES = {
  'do-los-overall':    'do_los_overall_ebm.json',
  'do-los-facility':   'do_los_facility_ebm.json',
  'do-los-selfcare':   'do_los_selfcare_ebm.json',
  'do-los-homehealth': 'do_los_homehealth_ebm.json',
};
for (const [route, filename] of Object.entries(DOLOS_FILES)) {
  router.get(`/${route}`, (req, res) => {
    const filePath = path.join(tenantDataDir(req.tenantName), filename);
    sendJsonFile(res, `/api/atlas/${route}`, filePath, { noAtlasData: true });
  });
}

// GET /api/atlas/bed-placement-model
router.get('/bed-placement-model', (req, res) => {
  const filePath = path.join(tenantDataDir(req.tenantName), 'bed_placement_ebm.json');
  sendJsonFile(res, '/api/atlas/bed-placement-model', filePath, { noAtlasData: true });
});

// GET /api/atlas/bed-placement-combinations
router.get('/bed-placement-combinations', (req, res) => {
  const filePath = path.join(tenantDataDir(req.tenantName), 'bed_placement_combinations.json');
  sendJsonFile(res, '/api/atlas/bed-placement-combinations', filePath, {
    emptyFallback: { combinations: [], system_mean: 0 },
  });
});

// GET /api/atlas/turnover-combinations
router.get('/turnover-combinations', (req, res) => {
  const filePath = path.join(tenantDataDir(req.tenantName), 'turnover_combinations.json');
  sendJsonFile(res, '/api/atlas/turnover-combinations', filePath, {
    emptyFallback: { combinations: [], system_mean: 0 },
  });
});

// GET /api/atlas/fcot-combinations
router.get('/fcot-combinations', (req, res) => {
  const filePath = path.join(tenantDataDir(req.tenantName), 'fcot_combinations.json');
  sendJsonFile(res, '/api/atlas/fcot-combinations', filePath, {
    emptyFallback: { combinations: [], system_mean: 0 },
  });
});

// GET /api/atlas/performance-briefs — tenant-aware; alias kept for backward compat
function servePerformanceBriefs(req, res) {
  const tDir      = tenantDataDir(req.tenantName);
  const briefPath = path.join(tDir, 'performance_briefs.json');
  const ctxPath   = path.join(tDir, 'performance_briefs_context.json');

  let briefs;
  try {
    briefs = readJsonFile(briefPath);
  } catch (err) {
    if (err.message === 'not_found') {
      return res.json({
        error:   'no_atlas_data',
        message: 'Performance briefs have not been generated for this organization yet.',
      });
    }
    console.error('/api/atlas/performance-briefs read error:', err.message);
    return res.status(500).json({ error: 'Could not read performance briefs' });
  }

  // Merge per-group context by caseblock (best-effort; missing file is fine)
  let ctx = {};
  try { ctx = readJsonFile(ctxPath); } catch (_) { /* no context file */ }

  if (ctx && typeof ctx === 'object' && Array.isArray(briefs.groups)) {
    briefs.groups = briefs.groups.map(g => {
      const entry = ctx[g.caseblock];
      return entry ? { ...g, context: entry } : g;
    });
  }

  res.json(briefs);
}

router.get('/performance-briefs',      servePerformanceBriefs);
router.get('/performance-briefs-mock', servePerformanceBriefs); // backward-compat alias

router.get('/forecast/morning-huddle', (_req, res) => {
  const filePath = path.join(DATA_DIR, 'forecast_mock.json');
  sendJsonFile(res, '/api/atlas/forecast/morning-huddle', filePath, { notFoundMsg: 'Forecast mock data file not found' });
});

module.exports = router;

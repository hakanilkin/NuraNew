const express = require('express');
const path    = require('path');
const fs      = require('fs');

const router = express.Router();

// Resolve public/data from the project root (one level above routes/)
const DATA_DIR = path.join(__dirname, '..', 'public', 'data');

function readJsonFile(filename) {
  const filePath = path.join(DATA_DIR, filename);
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

// Standard JSON-file responder: 404 (or an empty fallback) when the file is
// missing, 500 with a clean message when it's unreadable or corrupted.
function sendJsonFile(res, route, filename, { notFoundMsg, emptyFallback } = {}) {
  try {
    res.json(readJsonFile(filename));
  } catch (err) {
    if (err.message === 'not_found') {
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
router.get('/fcot-model', (_req, res) => {
  sendJsonFile(res, '/api/atlas/fcot-model', 'fcot_ebm.json', { notFoundMsg: 'Model file not found — run ebm_pipeline.py first' });
});

// GET /api/atlas/turnover-model
router.get('/turnover-model', (_req, res) => {
  sendJsonFile(res, '/api/atlas/turnover-model', 'turnover_ebm.json', { notFoundMsg: 'Model file not found — run turnover_ebm_pipeline.py first' });
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
  router.get(`/${route}`, (_req, res) => {
    sendJsonFile(res, `/api/atlas/${route}`, filename, {
      notFoundMsg: 'Model file not found — run do_dc_pipeline.py first',
    });
  });
}

// GET /api/atlas/bed-placement-model
router.get('/bed-placement-model', (_req, res) => {
  sendJsonFile(res, '/api/atlas/bed-placement-model', 'bed_placement_ebm.json', { notFoundMsg: 'Model file not found — run bed_placement_pipeline.py first' });
});

// GET /api/atlas/bed-placement-combinations
router.get('/bed-placement-combinations', (_req, res) => {
  sendJsonFile(res, '/api/atlas/bed-placement-combinations', 'bed_placement_combinations.json', { emptyFallback: { combinations: [], system_mean: 0 } });
});

// GET /api/atlas/turnover-combinations
router.get('/turnover-combinations', (_req, res) => {
  sendJsonFile(res, '/api/atlas/turnover-combinations', 'turnover_combinations.json', { notFoundMsg: 'Combinations file not found — run turnover_ebm_pipeline.py first' });
});

// GET /api/atlas/fcot-combinations
router.get('/fcot-combinations', (_req, res) => {
  sendJsonFile(res, '/api/atlas/fcot-combinations', 'fcot_combinations.json', { emptyFallback: { combinations: [], system_mean: 0 } });
});

// GET /api/atlas/performance-briefs-mock
router.get('/performance-briefs-mock', (_req, res) => {
  sendJsonFile(res, '/api/atlas/performance-briefs-mock', 'performance_briefs_mock.json', { notFoundMsg: 'Mock data file not found' });
});

module.exports = router;

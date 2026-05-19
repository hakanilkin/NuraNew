const express = require('express');
const path    = require('path');
const fs      = require('fs');

// Resolve public/data from the project root (one level above routes/)
const DATA_DIR = path.join(__dirname, '..', 'public', 'data');

module.exports = function askNuraRoutes(getPool, sql) {
  const router = express.Router();

  // ── EBM helpers ─────────────────────────────────────────────────────────────

  const EBM_FEAT_NAMES = {
    Case_AddOnCode:               'Add-on Case',
    Sched_SchedDur:               'Scheduled Duration',
    Case_SurgeonService:          'Surgeon Service',
    Loc_ORGrp2:                   'Location Group',
    DD_DOW_Long:                  'Day of Week',
    Case_DaysScheduledAhead:      'Days Scheduled Ahead',
    Case_CaseType:                'Case Type',
    Case_ASACode:                 'ASA Acuity',
    DD_WeekOfMonth:               'Week of Month',
    DD_Holiday:                   'Holiday',
    DD_Month_Int:                 'Month',
    Anes_Anestype:                'Anesthesia Type',
    Turnover_NextCaseSameSurgeon: 'Same Surgeon Next Case',
    Turnover_Maxnumofcasesinroom: 'Cases in Room That Day',
    Turnover_Orderofcaseinroom:   'Case Position in Room',
  };

  function ebmFeatName(f) {
    return EBM_FEAT_NAMES[f] ?? f.replace(/_/g, ' ');
  }

  function readEbmJson(modelName) {
    const file = modelName === 'turnover' ? 'turnover_ebm.json' : 'fcot_ebm.json';
    const raw  = fs.readFileSync(path.join(DATA_DIR, file), 'utf8');
    return JSON.parse(raw);
  }

  // ── Tool functions ───────────────────────────────────────────────────────────

  async function tool_getORSummary(startDate, endDate, sites) {
    const db  = await getPool();
    const req = db.request();
    req.input('startDate', sql.Date, startDate);
    req.input('endDate',   sql.Date, endDate);
    let siteFilter = '';
    if (sites?.length) {
      const placeholders = sites.map((s, i) => { req.input(`ts${i}`, sql.NVarChar, s); return `@ts${i}`; });
      siteFilter = ` AND ISNULL(Loc_ORGrp2, 'Unknown') IN (${placeholders.join(', ')})`;
    }
    const result = await req.query(`
      SELECT
        ISNULL(Loc_ORGrp2, 'Unknown')          AS Site,
        COUNT(*)                                AS TotalCases,
        SUM(ISNULL(Dur_ORIn_OROut, 0))         AS TotalORMinutes,
        ROUND(AVG(NULLIF(Dur_ORIn_OROut, 0)), 1) AS AvgORDuration
      FROM DS_CASES
      WHERE CaseLogStatus = 'Posted'
        AND Date_Scheddate >= @startDate
        AND Date_Scheddate <= @endDate
        ${siteFilter}
      GROUP BY Loc_ORGrp2
      ORDER BY Loc_ORGrp2
    `);
    const rows        = result.recordset;
    const totalCases  = rows.reduce((s, r) => s + r.TotalCases, 0);
    const totalORMins = rows.reduce((s, r) => s + r.TotalORMinutes, 0);
    return {
      totalCases,
      totalORMinutes: Math.round(totalORMins),
      avgORDuration:  totalCases > 0 ? Math.round(totalORMins / totalCases) : 0,
      bySite: rows.map(r => ({
        site:           r.Site,
        cases:          r.TotalCases,
        totalORMinutes: Math.round(r.TotalORMinutes),
        avgORDuration:  r.AvgORDuration,
      })),
    };
  }

  async function tool_getCapacity(startDate, endDate, locations, dow) {
    const db  = await getPool();
    const req = db.request();
    req.input('startDate', sql.Date, startDate);
    req.input('endDate',   sql.Date, endDate);
    let locFilter = '';
    if (locations?.length) {
      const placeholders = locations.map((l, i) => { req.input(`tl${i}`, sql.NVarChar, l); return `@tl${i}`; });
      locFilter = ` AND ISNULL(LocationGroup, 'Unknown') IN (${placeholders.join(', ')})`;
    }
    const dowFilter = dow?.length
      ? ` AND DATEPART(WEEKDAY, BlockDate) IN (${dow.map(d => parseInt(d)).filter(n => !isNaN(n)).join(', ')})`
      : '';
    const result = await req.query(`
      SELECT
        ISNULL(LocationGroup, 'Unknown')     AS LocationGroup,
        SUM(ISNULL(Total_Prime_Time, 0))     AS SumPrimeTime,
        SUM(ISNULL(blockTime, 0))            AS SumBlockTime,
        CASE WHEN SUM(ISNULL(blockTime, 0)) = 0 THEN 0
             ELSE ROUND(100.0 * SUM(ISNULL(Total_Prime_Time, 0)) / SUM(ISNULL(blockTime, 0)), 1)
        END AS PrimeTimeUtil
      FROM V4_BlockResultsView
      WHERE BlockDate >= @startDate
        AND BlockDate <= @endDate
        ${locFilter}
        ${dowFilter}
      GROUP BY LocationGroup
      ORDER BY LocationGroup
    `);
    return result.recordset.map(r => ({
      location:         r.LocationGroup,
      primeTimeUtilPct: r.PrimeTimeUtil,
      sumPrimeTime:     Math.round(r.SumPrimeTime),
      sumBlockTime:     Math.round(r.SumBlockTime),
    }));
  }

  async function tool_getBlockUtilization(startDate, endDate, location) {
    const db  = await getPool();
    const req = db.request();
    req.input('startDate', sql.Date, startDate);
    req.input('endDate',   sql.Date, endDate);
    let locFilter = '';
    if (location) {
      req.input('tloc', sql.NVarChar, location);
      locFilter = ` AND ISNULL(LocationGroup, 'Unknown') = @tloc`;
    }
    const result = await req.query(`
      SELECT
        ISNULL(CaseBlock, 'Unknown')        AS CaseBlock,
        COUNT(DISTINCT CaseID)              AS TotalCases,
        SUM(ISNULL(Total_Prime_Time, 0))    AS SumPrimeTime,
        SUM(ISNULL(blockTime, 0))           AS SumBlockTime,
        CASE WHEN SUM(ISNULL(blockTime, 0)) = 0 THEN 0
             ELSE ROUND(100.0 * SUM(ISNULL(Total_Prime_Time, 0)) / SUM(ISNULL(blockTime, 0)), 1)
        END AS PrimeTimeUtil
      FROM V4_BlockResultsView
      WHERE BlockDate >= @startDate
        AND BlockDate <= @endDate
        ${locFilter}
        AND DATEPART(WEEKDAY, BlockDate) IN (2, 3, 4, 5, 6)
      GROUP BY CaseBlock
      ORDER BY PrimeTimeUtil DESC
    `);
    return result.recordset.map(r => ({
      block:            r.CaseBlock,
      cases:            r.TotalCases,
      primeTimeUtilPct: r.PrimeTimeUtil,
      sumPrimeTime:     Math.round(r.SumPrimeTime),
      sumBlockTime:     Math.round(r.SumBlockTime),
    }));
  }

  function tool_getFCOTDrivers() {
    try {
      const model = readEbmJson('fcot');
      const importance = model.feature_importance
        .filter(f => !f.feature.includes(' & '))
        .slice(0, 10)
        .map(f => ({ feature: ebmFeatName(f.feature), importanceScore: Math.round(f.importance_score * 100) / 100, rank: f.rank }));
      const highlights = model.shape_functions.slice(0, 8).map(sf => {
        const scores = sf.y_scores ?? [];
        if (!scores.length) return null;
        const labels  = sf.x_labels?.length ? sf.x_labels : (sf.x_values?.map(v => String(v)) ?? []);
        const maxIdx  = scores.indexOf(Math.max(...scores));
        const minIdx  = scores.indexOf(Math.min(...scores));
        return {
          feature:    ebmFeatName(sf.feature),
          mostDelay:  { label: labels[maxIdx] ?? String(maxIdx), minutes: Math.round(scores[maxIdx] * 10) / 10 },
          leastDelay: { label: labels[minIdx] ?? String(minIdx), minutes: Math.round(scores[minIdx] * 10) / 10 },
        };
      }).filter(Boolean);
      return { importance, highlights };
    } catch (e) {
      return { error: 'FCOT model file not found. Run ebm_pipeline.py first.' };
    }
  }

  function tool_getTurnoverDrivers() {
    try {
      const model = readEbmJson('turnover');
      const importance = model.feature_importance
        .filter(f => !f.feature.includes(' & '))
        .slice(0, 10)
        .map(f => ({ feature: ebmFeatName(f.feature), importanceScore: Math.round(f.importance_score * 100) / 100, rank: f.rank }));
      const highlights = model.shape_functions.slice(0, 8).map(sf => {
        const scores = sf.y_scores ?? [];
        if (!scores.length) return null;
        const labels = sf.x_labels?.length ? sf.x_labels : (sf.x_values?.map(v => String(v)) ?? []);
        const maxIdx = scores.indexOf(Math.max(...scores));
        const minIdx = scores.indexOf(Math.min(...scores));
        return {
          feature:          ebmFeatName(sf.feature),
          longestTurnover:  { label: labels[maxIdx] ?? String(maxIdx), minutes: Math.round(scores[maxIdx] * 10) / 10 },
          shortestTurnover: { label: labels[minIdx] ?? String(minIdx), minutes: Math.round(scores[minIdx] * 10) / 10 },
        };
      }).filter(Boolean);
      return { importance, highlights };
    } catch (e) {
      return { error: 'Turnover model file not found. Run turnover_ebm_pipeline.py first.' };
    }
  }

  function tool_getShapeFunction(modelName, featureName) {
    try {
      const model = readEbmJson(modelName);
      const sf = model.shape_functions.find(s =>
        s.feature === featureName || ebmFeatName(s.feature) === featureName
      );
      if (!sf) return { error: `Feature '${featureName}' not found in ${modelName} model` };
      const labels = sf.x_labels?.length
        ? sf.x_labels
        : (sf.x_values?.map(v => typeof v === 'number' ? v.toFixed(1) : String(v)) ?? []);
      return {
        feature: ebmFeatName(sf.feature),
        type:    sf.type,
        entries: (sf.y_scores ?? []).map((score, i) => ({
          label:         labels[i] ?? String(i),
          effectMinutes: Math.round(score * 10) / 10,
          direction:     score >= 0 ? 'later/longer' : 'earlier/shorter',
        })),
      };
    } catch (e) {
      return { error: `Could not read ${modelName} model file.` };
    }
  }

  function tool_getInteractionFinding(modelName, feature1, feature2) {
    try {
      const model = readEbmJson(modelName);
      const ix = (model.interactions ?? []).find(i =>
        (i.feature_1 === feature1 || ebmFeatName(i.feature_1) === feature1) &&
        (i.feature_2 === feature2 || ebmFeatName(i.feature_2) === feature2)
      ) ?? (model.interactions ?? []).find(i =>
        (i.feature_1 === feature2 || ebmFeatName(i.feature_1) === feature2) &&
        (i.feature_2 === feature1 || ebmFeatName(i.feature_2) === feature1)
      );
      if (!ix) return { error: `Interaction between '${feature1}' and '${feature2}' not found in ${modelName} model` };
      const rowLabels = ix.x_labels_1?.length ? ix.x_labels_1 : (ix.x_values_1?.map(v => String(v)) ?? []);
      const colLabels = ix.x_labels_2?.length ? ix.x_labels_2 : (ix.x_values_2?.map(v => String(v)) ?? []);
      const cells = [];
      (ix.scores_matrix ?? []).forEach((row, r) => {
        row.forEach((v, c) => {
          cells.push({ label1: rowLabels[r] ?? String(r), label2: colLabels[c] ?? String(c), effectMinutes: Math.round(v * 10) / 10 });
        });
      });
      cells.sort((a, b) => Math.abs(b.effectMinutes) - Math.abs(a.effectMinutes));
      return {
        feature1: ebmFeatName(ix.feature_1),
        feature2: ebmFeatName(ix.feature_2),
        topCombinations: cells.slice(0, 5).map(c => ({
          ...c,
          direction: c.effectMinutes >= 0 ? 'later/longer' : 'earlier/shorter',
        })),
      };
    } catch (e) {
      return { error: `Could not read ${modelName} model file.` };
    }
  }

  async function tool_getSurgeonPerformance(surgeonName, metric, startDate, endDate) {
    const db        = await getPool();
    const isFcot    = metric === 'fcot';
    const metricCol = isFcot ? 'Dur_Act_vs_SchedStart' : 'Turnover_Turnover';
    const metricFilter = isFcot
      ? `AND Turnover_Orderofcaseinroom = 1 AND Dur_Act_vs_SchedStart IS NOT NULL`
      : `AND Turnover_Orderofcaseinroom > 1 AND Turnover_Turnover > 0 AND Turnover_Turnover <= 120`;
    const metricLabel = isFcot
      ? 'First Case On-Time Start (minutes vs scheduled)'
      : 'Turnover Time (minutes)';

    const req1 = db.request();
    req1.input('startDate', sql.Date, startDate);
    req1.input('endDate',   sql.Date, endDate);
    let surgeonFilter = '';
    if (surgeonName) {
      req1.input('svc', sql.NVarChar, surgeonName);
      surgeonFilter = `AND ISNULL(Case_SurgeonService, 'Unknown') = @svc`;
    }
    const res1 = await req1.query(`
      SELECT
        ISNULL(Case_SurgeonService, 'Unknown')     AS SurgeonService,
        COUNT(*)                                    AS CaseCount,
        ROUND(AVG(CAST(${metricCol} AS FLOAT)), 1) AS AvgMetric
      FROM DS_CASES
      WHERE CaseLogStatus = 'Posted'
        AND Date_Scheddate >= @startDate
        AND Date_Scheddate <= @endDate
        ${metricFilter}
        ${surgeonFilter}
      GROUP BY Case_SurgeonService
      ORDER BY CaseCount DESC
    `);

    const rows = res1.recordset;

    if (!surgeonName) {
      return { metric: metricLabel, byService: rows.map(r => ({ service: r.SurgeonService, cases: r.CaseCount, avgMinutes: r.AvgMetric })) };
    }

    const totalCases  = rows.reduce((s, r) => s + r.CaseCount, 0);
    const weightedAvg = totalCases > 0
      ? rows.reduce((s, r) => s + r.AvgMetric * r.CaseCount, 0) / totalCases
      : 0;

    const req2 = db.request();
    req2.input('startDate2', sql.Date, startDate);
    req2.input('endDate2',   sql.Date, endDate);
    const res2 = await req2.query(`
      SELECT ROUND(AVG(CAST(${metricCol} AS FLOAT)), 1) AS OverallAvg
      FROM DS_CASES
      WHERE CaseLogStatus = 'Posted'
        AND Date_Scheddate >= @startDate2
        AND Date_Scheddate <= @endDate2
        ${metricFilter}
    `);
    const overallAvg = res2.recordset[0]?.OverallAvg ?? null;

    return {
      service:          surgeonName,
      metric:           metricLabel,
      caseCount:        totalCases,
      avgMinutes:       Math.round(weightedAvg * 10) / 10,
      overallAvg,
      deltaFromOverall: overallAvg != null ? Math.round((weightedAvg - overallAvg) * 10) / 10 : null,
      interpretation:   overallAvg != null
        ? (weightedAvg > overallAvg
            ? `${surgeonName} averages ${(weightedAvg - overallAvg).toFixed(1)} min above the overall average`
            : `${surgeonName} averages ${(overallAvg - weightedAvg).toFixed(1)} min below the overall average`)
        : 'No overall average available for comparison',
    };
  }

  // ── Tool registry ────────────────────────────────────────────────────────────

  const NURA_TOOLS = [
    {
      name: 'tool_getORSummary',
      description: 'Get total OR case volume, total OR minutes, and average case duration for a date range. Optionally filter by site. Use for questions about case volume, overall OR activity, or general throughput.',
      input_schema: {
        type: 'object',
        properties: {
          startDate: { type: 'string', description: 'Start date YYYY-MM-DD' },
          endDate:   { type: 'string', description: 'End date YYYY-MM-DD' },
          sites:     { type: 'array', items: { type: 'string' }, description: 'Optional site/location names to filter by' },
        },
        required: ['startDate', 'endDate'],
      },
    },
    {
      name: 'tool_getCapacity',
      description: 'Get prime time block utilization percentage by location for a date range. Use for questions about how well OR block time is being used, room utilization rates, or capacity efficiency.',
      input_schema: {
        type: 'object',
        properties: {
          startDate: { type: 'string', description: 'Start date YYYY-MM-DD' },
          endDate:   { type: 'string', description: 'End date YYYY-MM-DD' },
          locations: { type: 'array', items: { type: 'string' }, description: 'Optional location group names to filter by' },
          dow:       { type: 'array', items: { type: 'integer' }, description: 'Optional day-of-week numbers to filter (1=Sun 2=Mon … 7=Sat)' },
        },
        required: ['startDate', 'endDate'],
      },
    },
    {
      name: 'tool_getBlockUtilization',
      description: 'Get OR block utilization by case block (surgeon/service block schedule). Use for questions about specific block holders, block efficiency, or which blocks are underutilized.',
      input_schema: {
        type: 'object',
        properties: {
          startDate: { type: 'string', description: 'Start date YYYY-MM-DD' },
          endDate:   { type: 'string', description: 'End date YYYY-MM-DD' },
          location:  { type: 'string', description: 'Optional single location/OR group to filter by' },
        },
        required: ['startDate', 'endDate'],
      },
    },
    {
      name: 'tool_getFCOTDrivers',
      description: 'Get the key factors that drive first case on-time start (FCOT) variance, ranked by model importance. Use for questions about what causes first cases to start late or what the biggest FCOT drivers are.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'tool_getTurnoverDrivers',
      description: 'Get the key factors that drive OR room turnover time between consecutive cases, ranked by model importance. Use for questions about what causes long turnovers or what the biggest turnover drivers are.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'tool_getShapeFunction',
      description: 'Get the detailed effect of a specific feature on the outcome — shows how each value of that factor is associated with minutes of change. Use when you need specific numbers for a particular factor.',
      input_schema: {
        type: 'object',
        properties: {
          modelName:   { type: 'string', enum: ['fcot', 'turnover'], description: 'fcot = first case on-time start, turnover = room turnover time' },
          featureName: { type: 'string', description: 'Feature to look up, e.g. "Case_SurgeonService" or "Surgeon Service"' },
        },
        required: ['modelName', 'featureName'],
      },
    },
    {
      name: 'tool_getInteractionFinding',
      description: 'Get the combined effect of two features on the outcome — shows how the combination of two factors jointly influences the result. Use for questions about whether X affects Y differently depending on Z.',
      input_schema: {
        type: 'object',
        properties: {
          modelName: { type: 'string', enum: ['fcot', 'turnover'], description: 'Which model to query' },
          feature1:  { type: 'string', description: 'First feature name (raw or display name)' },
          feature2:  { type: 'string', description: 'Second feature name (raw or display name)' },
        },
        required: ['modelName', 'feature1', 'feature2'],
      },
    },
    {
      name: 'tool_getSurgeonPerformance',
      description: 'Get FCOT or turnover time performance for a specific surgeon service or all service lines. Compares to overall average. Use for questions about individual service line or surgeon performance and peer comparison.',
      input_schema: {
        type: 'object',
        properties: {
          surgeonName: { type: 'string', description: 'Surgeon service name to filter to. If omitted, returns all service lines.' },
          metric:      { type: 'string', enum: ['fcot', 'turnover'], description: 'fcot = first case start time, turnover = room turnover time' },
          startDate:   { type: 'string', description: 'Start date YYYY-MM-DD' },
          endDate:     { type: 'string', description: 'End date YYYY-MM-DD' },
        },
        required: ['metric', 'startDate', 'endDate'],
      },
    },
  ];

  const TOOL_SOURCE_TYPE = {
    tool_getORSummary:          'live_data',
    tool_getCapacity:           'live_data',
    tool_getBlockUtilization:   'live_data',
    tool_getFCOTDrivers:        'model_insight',
    tool_getTurnoverDrivers:    'model_insight',
    tool_getShapeFunction:      'model_insight',
    tool_getInteractionFinding: 'model_insight',
    tool_getSurgeonPerformance: 'live_data',
  };

  const NURA_SYSTEM = `You are Ask Nura, an operational analytics assistant for hospital surgical services and OR operations. You ONLY answer questions by calling the tools provided — never use general knowledge or make up numbers. Every answer must be grounded in tool results. If no tool can answer the question, say so clearly and suggest what you can help with. Never make clinical recommendations, staffing decisions, or financial projections. Never cite external benchmarks unless they come from a tool result. Scope is strictly OR operations, surgical services performance, and patient flow analytics.

Format your responses in clean markdown. Use **bold** for key numbers and findings. Use tables (| syntax) when comparing multiple items side by side. Use bullet points for lists of 3 or more items. Use paragraph breaks between distinct points. Maximum 200 words.

When citing importance scores from the model, translate them to plain English magnitude — never say "importance score of 3.2". Instead say things like "accounts for roughly 19% of explained variance" or "about 3× more influential than day of week". Always include units (minutes, %, cases) when presenting operational numbers.`;

  async function dispatchTool(name, input) {
    switch (name) {
      case 'tool_getORSummary':          return tool_getORSummary(input.startDate, input.endDate, input.sites);
      case 'tool_getCapacity':           return tool_getCapacity(input.startDate, input.endDate, input.locations, input.dow);
      case 'tool_getBlockUtilization':   return tool_getBlockUtilization(input.startDate, input.endDate, input.location);
      case 'tool_getFCOTDrivers':        return tool_getFCOTDrivers();
      case 'tool_getTurnoverDrivers':    return tool_getTurnoverDrivers();
      case 'tool_getShapeFunction':      return tool_getShapeFunction(input.modelName, input.featureName);
      case 'tool_getInteractionFinding': return tool_getInteractionFinding(input.modelName, input.feature1, input.feature2);
      case 'tool_getSurgeonPerformance': return tool_getSurgeonPerformance(input.surgeonName, input.metric, input.startDate, input.endDate);
      default:                           return { error: `Unknown tool: ${name}` };
    }
  }

  // ── POST /api/ask-nura ───────────────────────────────────────────────────────

  router.post('/ask-nura', async (req, res) => {
    const { message, conversationHistory = [] } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });

    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

    const messages   = [...conversationHistory, { role: 'user', content: message }];
    const toolsUsed  = [];
    const sourceTypes = new Set();
    const MAX_ITER   = 8;

    try {
      for (let iter = 0; iter < MAX_ITER; iter++) {
        const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key':         apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type':      'application/json',
          },
          body: JSON.stringify({
            model:      'claude-haiku-4-5-20251001',
            max_tokens: 1024,
            system:     NURA_SYSTEM,
            tools:      NURA_TOOLS,
            messages,
          }),
        });

        const data = await anthropicRes.json();
        if (!anthropicRes.ok) {
          console.error('/api/ask-nura Anthropic error:', data);
          return res.status(502).json({ error: data?.error?.message ?? 'Anthropic API error' });
        }

        const toolBlocks = (data.content ?? []).filter(b => b.type === 'tool_use');

        if (!toolBlocks.length || data.stop_reason === 'end_turn') {
          const text = (data.content ?? []).find(b => b.type === 'text')?.text ?? '';
          return res.json({ response: text, sources: [...sourceTypes], toolsUsed });
        }

        messages.push({ role: 'assistant', content: data.content });

        const toolResults = await Promise.all(
          toolBlocks.map(async block => {
            toolsUsed.push(block.name);
            sourceTypes.add(TOOL_SOURCE_TYPE[block.name] ?? 'live_data');
            let result;
            try {
              result = await dispatchTool(block.name, block.input ?? {});
            } catch (toolErr) {
              console.error(`Tool ${block.name} error:`, toolErr.message);
              result = { error: toolErr.message };
            }
            return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) };
          })
        );

        messages.push({ role: 'user', content: toolResults });
      }

      return res.json({
        response:  'I reached the maximum number of reasoning steps. Please try rephrasing or breaking your question into smaller parts.',
        sources:   [...sourceTypes],
        toolsUsed,
      });
    } catch (err) {
      console.error('/api/ask-nura error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
};

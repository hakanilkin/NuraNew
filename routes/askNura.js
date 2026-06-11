const express     = require('express');
const path        = require('path');
const fs          = require('fs');
const makeFilters = require('./filters');

// Resolve public/data from the project root (one level above routes/)
const DATA_DIR = path.join(__dirname, '..', 'public', 'data');

module.exports = function askNuraRoutes(getTenantPool, sql, requireTenant) {
  const router = express.Router();
  const { addSitesFilter, addLocationsFilter, addDowFilter } = makeFilters(sql);

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

  async function tool_getORSummary(db, startDate, endDate, sites) {
    const request = db.request();
    request.input('startDate', sql.Date, startDate);
    request.input('endDate',   sql.Date, endDate);
    const siteFilter = addSitesFilter(request, sites);
    const result = await request.query(`
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

  async function tool_getCapacity(db, startDate, endDate, locations, dow) {
    const request = db.request();
    request.input('startDate', sql.Date, startDate);
    request.input('endDate',   sql.Date, endDate);
    const locFilter = addLocationsFilter(request, locations);
    const dowFilter = addDowFilter(dow);
    const result = await request.query(`
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

  async function tool_getBlockUtilization(db, startDate, endDate, location) {
    const request = db.request();
    request.input('startDate', sql.Date, startDate);
    request.input('endDate',   sql.Date, endDate);
    let locFilter = '';
    if (location) {
      request.input('tloc', sql.NVarChar, location);
      locFilter = ` AND ISNULL(LocationGroup, 'Unknown') = @tloc`;
    }
    const result = await request.query(`
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

  function tool_getBedPlacementSummary() {
    try {
      const raw   = fs.readFileSync(path.join(DATA_DIR, 'bed_placement_ebm.json'), 'utf8');
      const model = JSON.parse(raw);
      const nAbove = model.n_above_threshold ?? 0;
      const nBelow = model.n_below_threshold ?? 0;
      const total  = nAbove + nBelow;
      return {
        total_cases:        total,
        pct_above_target:   total > 0 ? Math.round((nAbove / total) * 1000) / 10 : 0,
        avg_assignment_min: Math.round((model.system_mean ?? 0) * 10) / 10,
        threshold_minutes:  30,
        model_auc:          Math.round((model.model_stats?.auc ?? 0) * 1000) / 1000,
      };
    } catch (e) {
      return { error: 'Bed placement model file not found. Run bed_placement_pipeline.py first.' };
    }
  }

  function tool_getAssignmentDrivers() {
    try {
      const raw    = fs.readFileSync(path.join(DATA_DIR, 'bed_placement_ebm.json'), 'utf8');
      const model  = JSON.parse(raw);
      const drivers = (model.feature_importance ?? [])
        .filter(f => !f.feature.includes(' & '))
        .slice(0, 8)
        .map(f => ({
          feature:          f.feature.replace(/_/g, ' '),
          importance_score: Math.round(f.importance_score * 10000) / 10000,
          rank:             f.rank,
        }));
      return { drivers };
    } catch (e) {
      return { error: 'Bed placement model file not found. Run bed_placement_pipeline.py first.' };
    }
  }

  function tool_getAssignmentCombinations() {
    try {
      const raw  = fs.readFileSync(path.join(DATA_DIR, 'bed_placement_combinations.json'), 'utf8');
      const data = JSON.parse(raw);
      const top5 = (data.combinations ?? []).slice(0, 5).map(c => ({
        label:              c.label,
        sub:                c.sub,
        avg_assignment_min: Math.round((c.avg_assignment_min ?? 0) * 10) / 10,
        pct_above_target:   Math.round((c.pct_above_target ?? 0) * 10) / 10,
        cnt:                c.cnt,
      }));
      return { combinations: top5 };
    } catch (e) {
      return { error: 'Bed placement combinations file not found. Run bed_placement_pipeline.py first.' };
    }
  }

  const DODC_FILES = {
    home:    'do_dc_home_ebm.json',
    snf:     'do_dc_snf_ebm.json',
    hh:      'do_dc_hh_ebm.json',
    overall: 'do_dc_overall_ebm.json',
  };
  const DODC_BENCHMARKS = { home: 180, snf: 400, hh: 240 };

  function tool_getDODCSummary() {
    try {
      return ['home', 'snf', 'hh'].map(disp => {
        const raw   = fs.readFileSync(path.join(DATA_DIR, DODC_FILES[disp]), 'utf8');
        const model = JSON.parse(raw);
        return {
          name:              disp,
          system_mean:       Math.round((model.system_mean   ?? 0) * 10) / 10,
          system_median:     Math.round((model.system_median ?? 0) * 10) / 10,
          benchmark_minutes: DODC_BENCHMARKS[disp],
          total_cases:       model.n_training_samples ?? 0,
        };
      });
    } catch (e) {
      return { error: 'DO→DC model files not found. Run do_dc_pipeline.py first.' };
    }
  }

  function tool_getDODCDrivers(disposition) {
    const file = DODC_FILES[disposition];
    if (!file) return { error: `Invalid disposition '${disposition}'. Use home, snf, or hh.` };
    try {
      const raw    = fs.readFileSync(path.join(DATA_DIR, file), 'utf8');
      const model  = JSON.parse(raw);
      const drivers = (model.feature_importance ?? [])
        .filter(f => !f.feature.includes(' & '))
        .slice(0, 6)
        .map(f => ({
          feature:          f.feature.replace(/_/g, ' '),
          importance_score: Math.round(f.importance_score * 10000) / 10000,
        }));
      return { disposition, drivers };
    } catch (e) {
      return { error: `DO→DC ${disposition} model file not found.` };
    }
  }

  function tool_getDODCCombinations(disposition) {
    const file = DODC_FILES[disposition];
    if (!file) return { error: `Invalid disposition '${disposition}'. Use home, snf, hh, or overall.` };
    try {
      const raw    = fs.readFileSync(path.join(DATA_DIR, file), 'utf8');
      const model  = JSON.parse(raw);
      const combos = (model.combinations ?? []).slice(0, 5).map(c => ({
        label:               c.label,
        sub:                 c.sub ?? '',
        avg_do_to_dc:        Math.round((c.avg_do_to_dc ?? c.avg_minutes ?? 0) * 10) / 10,
        pct_above_benchmark: Math.round((c.pct_above_benchmark ?? c.pct_above_target ?? 0) * 10) / 10,
        cnt:                 c.cnt,
      }));
      return { disposition, combinations: combos };
    } catch (e) {
      return { error: `DO→DC ${disposition} model file not found.` };
    }
  }

  async function tool_getSurgeonPerformance(db, surgeonName, metric, startDate, endDate) {
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
      name: 'tool_getBedPlacementSummary',
      description: 'Get overall bed assignment performance at OLLH: total cases, percentage exceeding 30-minute target, average assignment time, and model AUC. Use for questions about bed assignment delay rates or overall placement performance.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'tool_getAssignmentDrivers',
      description: 'Get the top 8 factors that drive bed assignment delays at OLLH, ranked by model importance. Use for questions about what causes assignment delays or what the biggest drivers are.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'tool_getAssignmentCombinations',
      description: 'Get the top 5 worst-performing combinations of factors for bed assignment time (e.g. source type × destination unit). Use for questions about which specific combinations of conditions lead to the longest assignment delays.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'tool_getDODCSummary',
      description: 'Get discharge order to departure (DO→DC) time summary for all three disposition types: home, SNF, and home health. Returns mean, median, benchmark, and case count for each. Use for questions about how long it takes patients to leave after a discharge order.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'tool_getDODCDrivers',
      description: 'Get the top 6 factors that drive DO→DC time for a specific patient disposition. Use when asked what causes long discharge times for a specific disposition type.',
      input_schema: {
        type: 'object',
        properties: {
          disposition: { type: 'string', enum: ['home', 'snf', 'hh'], description: 'home = discharge to home, snf = skilled nursing facility, hh = home health' },
        },
        required: ['disposition'],
      },
    },
    {
      name: 'tool_getDODCCombinations',
      description: 'Get the top 5 worst-performing combinations of factors for DO→DC time for a given disposition. Use for questions about which specific combinations lead to the longest discharge times.',
      input_schema: {
        type: 'object',
        properties: {
          disposition: { type: 'string', enum: ['home', 'snf', 'hh', 'overall'], description: 'home, snf, hh, or overall' },
        },
        required: ['disposition'],
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
    tool_getORSummary:             'live_data',
    tool_getCapacity:              'live_data',
    tool_getBlockUtilization:      'live_data',
    tool_getFCOTDrivers:           'model_insight',
    tool_getTurnoverDrivers:       'model_insight',
    tool_getShapeFunction:         'model_insight',
    tool_getInteractionFinding:    'model_insight',
    tool_getSurgeonPerformance:    'live_data',
    tool_getBedPlacementSummary:   'model_insight',
    tool_getAssignmentDrivers:     'model_insight',
    tool_getAssignmentCombinations:'model_insight',
    tool_getDODCSummary:           'model_insight',
    tool_getDODCDrivers:           'model_insight',
    tool_getDODCCombinations:      'model_insight',
  };

  const NURA_SYSTEM = `You are Ask Nura, an analytical assistant for OLLH operational data. Answer questions using only the tools available to you. Never make recommendations or suggest interventions. Describe and explain what the data shows. Respond in plain English with no markdown formatting. Keep responses under 150 words. If a question cannot be answered with available tools say so directly.`;

  async function dispatchTool(name, input, tenantId) {
    // Live-data tools query the selected tenant's database
    const db = TOOL_SOURCE_TYPE[name] === 'live_data' ? await getTenantPool(tenantId) : null;
    switch (name) {
      case 'tool_getORSummary':          return tool_getORSummary(db, input.startDate, input.endDate, input.sites);
      case 'tool_getCapacity':           return tool_getCapacity(db, input.startDate, input.endDate, input.locations, input.dow);
      case 'tool_getBlockUtilization':   return tool_getBlockUtilization(db, input.startDate, input.endDate, input.location);
      case 'tool_getFCOTDrivers':        return tool_getFCOTDrivers();
      case 'tool_getTurnoverDrivers':    return tool_getTurnoverDrivers();
      case 'tool_getShapeFunction':      return tool_getShapeFunction(input.modelName, input.featureName);
      case 'tool_getInteractionFinding': return tool_getInteractionFinding(input.modelName, input.feature1, input.feature2);
      case 'tool_getSurgeonPerformance':    return tool_getSurgeonPerformance(db, input.surgeonName, input.metric, input.startDate, input.endDate);
      case 'tool_getBedPlacementSummary':   return tool_getBedPlacementSummary();
      case 'tool_getAssignmentDrivers':     return tool_getAssignmentDrivers();
      case 'tool_getAssignmentCombinations':return tool_getAssignmentCombinations();
      case 'tool_getDODCSummary':           return tool_getDODCSummary();
      case 'tool_getDODCDrivers':           return tool_getDODCDrivers(input.disposition);
      case 'tool_getDODCCombinations':      return tool_getDODCCombinations(input.disposition);
      default:                              return { error: `Unknown tool: ${name}` };
    }
  }

  // ── POST /api/ask-nura ───────────────────────────────────────────────────────

  const MAX_HISTORY_MESSAGES = 20;
  const MAX_MESSAGE_CHARS    = 4000;

  router.post('/ask-nura', requireTenant, async (req, res) => {
    const { message, conversationHistory = [] } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message is required' });
    }
    if (message.length > MAX_MESSAGE_CHARS) {
      return res.status(400).json({ error: `Message too long (max ${MAX_MESSAGE_CHARS} characters)` });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

    // Accept only well-formed, bounded history from the client
    const history = (Array.isArray(conversationHistory) ? conversationHistory : [])
      .filter(m => m
        && (m.role === 'user' || m.role === 'assistant')
        && typeof m.content === 'string'
        && m.content.length <= MAX_MESSAGE_CHARS)
      .slice(-MAX_HISTORY_MESSAGES)
      .map(m => ({ role: m.role, content: m.content }));

    const messages   = [...history, { role: 'user', content: message }];
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
              result = await dispatchTool(block.name, block.input ?? {}, req.session.tenantId);
            } catch (toolErr) {
              console.error(`Tool ${block.name} error:`, toolErr.message);
              result = { error: 'The tool could not be executed — the data may be temporarily unavailable.' };
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

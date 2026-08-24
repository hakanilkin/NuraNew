const express = require('express');

const F = require('../lib/censusFootprint');
const { getFeatures, getParam, resolveColumn } = require('../utils/tenantColumns');

// OR Smoothing — Census Footprint (ORSmoothing.md).
//
// Every elective case is a bed decision days in advance. Block templates were
// designed around surgeon preference; nobody designed the census they produce.
// This router supplies the volumes and curves; lib/censusFootprint.js does the
// arithmetic, and the ISSCM engine's Pillar 3 computes from that same module —
// so the panel judging a move and the page proposing it cannot disagree.

const DOW_LABEL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday',
                   'Saturday', 'Sunday'];
const sqlDowToJs = wd => (Number(wd) + 5) % 7;
const num = x => (Number.isFinite(Number(x)) ? Number(x) : 0);
const round1 = x => (x == null ? null : Math.round(x * 10) / 10);

module.exports = function smoothingRoutes(getTenantPool, sql, requireTenant) {
  const router = express.Router();
  router.use(requireTenant);

  router.use((req, res, next) => {
    if (!getFeatures(req.tenantName)?.smoothing) {
      return res.status(404).json({ error: 'not_available' });
    }
    next();
  });

  const crunchPct = t => num(getParam(t, 'crunch_occupancy_pct')) || F.DEFAULT_CRUNCH_PCT;

  // Empirical length of stay by service, bucketed — no parametric model.
  async function losFor(db, service, tenantName, weeks) {
    const slCol = resolveColumn(tenantName, 'SERVICE_LINE');
    const r = await db.request()
      .input('svc', sql.NVarChar, service)
      .input('weeks', sql.Int, weeks)
      .query(`
        SELECT CAST(ROUND(CAST(ACCOUNT_IPLOS AS FLOAT), 0) AS INT) AS Days,
               COUNT(*) AS N
        FROM DS_Encounters
        WHERE ISNULL(${slCol}, 'Unknown') = @svc AND BEDDED = 'Y'
          AND ACCOUNT_IPLOS IS NOT NULL
          AND TIME_HOSPDISCHARGE >= DATEADD(week, -@weeks, CAST(GETDATE() AS DATE))
        GROUP BY CAST(ROUND(CAST(ACCOUNT_IPLOS AS FLOAT), 0) AS INT)
      `);
    return r.recordset
      .filter(x => num(x.Days) > 0 && num(x.Days) < 60)
      .map(x => ({ days: num(x.Days), share: num(x.N) }));
  }

  async function volumeAndConversion(db, service, tenantName, weeks) {
    const slCol = resolveColumn(tenantName, 'SERVICE_LINE');
    const r = await db.request()
      .input('svc', sql.NVarChar, service)
      .input('weeks', sql.Int, weeks)
      .query(`
        SELECT
          (SELECT COUNT(*) FROM DS_CASES
            WHERE ISNULL(Case_SurgeonService, 'Unknown') = @svc AND Case_CanCode IS NULL
              AND Date_SchedDate >= DATEADD(week, -@weeks, CAST(GETDATE() AS DATE))
              AND Date_SchedDate <  CAST(GETDATE() AS DATE))                       AS Cases,
          (SELECT COUNT(*) FROM DS_Encounters
            WHERE ISNULL(${slCol}, 'Unknown') = @svc AND BEDDED = 'Y'
              AND TIME_HOSPADMISSION >= DATEADD(week, -@weeks, CAST(GETDATE() AS DATE))) AS Admits
      `);
    const row = r.recordset[0] || {};
    const cases = num(row.Cases);
    return {
      weeklyCases: weeks > 0 ? cases / weeks : 0,
      // The same Phase-1 approximation the ISSCM engine uses; upgrading both to
      // a true case -> admission join is one change in lib/censusFootprint.js.
      conversionRate: cases > 0 ? Math.min(1, num(row.Admits) / cases) : 0,
    };
  }

  async function unitSharesFor(db, service) {
    const r = await db.request()
      .input('svc', sql.NVarChar, service)
      .query('SELECT Unit, SharePct FROM ServiceUnitMap WHERE Service = @svc');
    return Object.fromEntries(r.recordset.map(m => [m.Unit, num(m.SharePct)]));
  }

  // ── GET /api/smoothing/footprint ──────────────────────────────────────────
  router.get('/footprint', async (req, res) => {
    try {
      const tenant = req.tenantName || 'default';
      const service = String(req.query.service || '');
      if (!service) return res.status(400).json({ error: 'service is required' });
      const weeks = Math.min(Math.max(parseInt(req.query.weeks, 10) || 8, 1), 52);
      const db = await getTenantPool(req.session.tenantId);

      const [vol, losDays, unitShares] = await Promise.all([
        volumeAndConversion(db, service, tenant, weeks),
        losFor(db, service, tenant, weeks),
        unitSharesFor(db, service),
      ]);
      res.json({ service, weeks, ...F.bedShadow({ ...vol, losDays, unitShares }) });
    } catch (err) {
      console.error('/api/smoothing/footprint error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/smoothing/census-attribution ─────────────────────────────────
  // OR attribution is traced from admissions back to cases, not read from a
  // stored figure — the same derived-not-asserted rule as everything else.
  router.get('/census-attribution', async (req, res) => {
    try {
      const tenant = req.tenantName || 'default';
      const weeks = Math.min(Math.max(parseInt(req.query.weeks, 10) || 8, 1), 52);
      const db = await getTenantPool(req.session.tenantId);
      const threshold = crunchPct(tenant);

      // Census by unit and weekday at the 07:00 count.
      const census = await db.request().input('weeks', sql.Int, weeks).query(`
        SELECT c.Unit, c.StaffedBeds,
               DATEPART(WEEKDAY, o.Datehour) AS Wd,
               AVG(CAST(o.Occupancy AS FLOAT)) AS Census
        FROM UnitCapacity c
        JOIN DS_Occupancy o ON o.DEP_NAME = c.Unit
        WHERE DATEPART(HOUR, o.Datehour) = 7
          AND o.Datehour >= DATEADD(week, -@weeks, CAST(GETDATE() AS DATE))
        GROUP BY c.Unit, c.StaffedBeds, DATEPART(WEEKDAY, o.Datehour)
      `);

      // Who is occupying a bed at the census count, traced back to how they
      // got there: DS_Bedplacement -> DS_Encounters. A stock measure, because
      // that is what a census is. Multiplying a day's admissions by an average
      // stay counts patients who have not arrived and keeps ones already gone.
      const occupants = await db.request().input('weeks', sql.Int, weeks).query(`
        WITH census_times AS (
          SELECT DISTINCT DEP_NAME AS Unit, Datehour
          FROM DS_Occupancy
          WHERE DATEPART(HOUR, Datehour) = 7
            AND Datehour >= DATEADD(week, -@weeks, CAST(GETDATE() AS DATE))
        )
        SELECT ct.Unit,
               DATEPART(WEEKDAY, ct.Datehour) AS Wd,
               COUNT(*)                       AS Occupants,
               SUM(CASE WHEN b.SOURCE_DEPTLOC = 'Surgery'
                          OR b.SOURCE_DEPTNAME LIKE '%PACU%'      THEN 1 ELSE 0 END) AS OrOccupants,
               SUM(CASE WHEN b.SOURCE_DEPTNAME LIKE '%EMERGENCY%' THEN 1 ELSE 0 END) AS EdOccupants
        FROM census_times ct
        JOIN DS_Encounters e
          ON e.DEP_LASTDEPTLOC = ct.Unit
         AND e.TIME_HOSPADMISSION <= ct.Datehour
         AND e.TIME_HOSPDISCHARGE >  ct.Datehour
        LEFT JOIN DS_Bedplacement b
          ON b.EPICCSN = e.EPICCSN AND b.EVENT_TYPE_MOD = 'Admission'
        GROUP BY ct.Unit, DATEPART(WEEKDAY, ct.Datehour)
      `);

      const admitMap = new Map();
      for (const a of admits.recordset) {
        const days = Math.max(1, num(a.Days));
        admitMap.set(`${a.Unit}|${sqlDowToJs(a.Wd)}`, {
          or: (num(a.OrAdmits) / days) * avgLos,
          ed: (num(a.EdAdmits) / days) * avgLos,
        });
      }

      const byUnit = new Map();
      const cells = [];
      for (const row of census.recordset) {
        const dow = sqlDowToJs(row.Wd);
        const share = shareMap.get(`${row.Unit}|${dow}`) || { or: 0, ed: 0 };
        const cell = {
          dow, label: DOW_LABEL[dow],
          ...F.attributeCensus({
            census: num(row.Census), capacity: num(row.StaffedBeds),
            orAdmitted: num(row.Census) * share.or,
            edAdmitted: num(row.Census) * share.ed,
          }, threshold),
        };
        cells.push({ ...cell, unit: row.Unit });
        if (!byUnit.has(row.Unit)) {
          byUnit.set(row.Unit, { unit: row.Unit, capacity: num(row.StaffedBeds), byDow: [] });
        }
        byUnit.get(row.Unit).byDow.push(cell);
      }
      for (const u of byUnit.values()) u.byDow.sort((a, b) => a.dow - b.dow);

      const weekdayCells = cells.filter(c => c.dow < 5);
      const totalCensus = weekdayCells.reduce((s, c) => s + num(c.census), 0);
      const totalOr = weekdayCells.reduce((s, c) => s + num(c.or), 0);
      const peak = cells.reduce((p, c) => (p === null || c.census > p.census ? c : p), null);

      res.json({
        weeks, crunchOccupancyPct: threshold,
        units: [...byUnit.values()].sort((a, b) => a.unit.localeCompare(b.unit)),
        summary: {
          orContributionPct: totalCensus > 0 ? round1((totalOr / totalCensus) * 100) : null,
          // Per week, from actual days — the heat map's cells are weekday
          // averages and would under-count.
          crunchUnitDays: round1(num(crunchDays.recordset[0]?.N) / weeks),
          crunchCells: F.crunchUnitDays(cells),
          peak: peak && { unit: peak.unit, dow: peak.dow, label: peak.label, census: peak.census },
        },
      });
    } catch (err) {
      console.error('/api/smoothing/census-attribution error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/smoothing/scenarios ──────────────────────────────────────────
  // Ranked shift candidates: the services contributing most volume into a
  // crunch cell, paired with the lightest weekday to move it to. Seeding the
  // picker this way means the demo needs no free-form input.
  router.get('/scenarios', async (req, res) => {
    try {
      const tenant = req.tenantName || 'default';
      const weeks = Math.min(Math.max(parseInt(req.query.weeks, 10) || 8, 1), 52);
      const db = await getTenantPool(req.session.tenantId);

      const r = await db.request().input('weeks', sql.Int, weeks).query(`
        SELECT ISNULL(Case_SurgeonService, 'Unknown') AS Service,
               DATEPART(WEEKDAY, Date_SchedDate)      AS Wd,
               COUNT(*)                               AS Cases,
               COUNT(DISTINCT CAST(Date_SchedDate AS DATE)) AS Days
        FROM DS_CASES
        WHERE Case_CanCode IS NULL
          AND Date_SchedDate >= DATEADD(week, -@weeks, CAST(GETDATE() AS DATE))
          AND Date_SchedDate <  CAST(GETDATE() AS DATE)
        GROUP BY Case_SurgeonService, DATEPART(WEEKDAY, Date_SchedDate)
      `);

      const volume = new Map();          // service -> dow -> cases/week
      for (const row of r.recordset) {
        const dow = sqlDowToJs(row.Wd);
        if (dow > 4) continue;
        const per = num(row.Cases) / Math.max(1, weeks);
        if (!volume.has(row.Service)) volume.set(row.Service, new Map());
        volume.get(row.Service).set(dow, per);
      }

      // Which weekdays are tight, and which have room, from the same
      // attribution the heat map renders.
      const attribution = await fetchAttribution(db, tenant, weeks);
      const pressureByDow = new Map();
      for (const u of attribution.units) {
        for (const cell of u.byDow) {
          const prev = num(pressureByDow.get(cell.dow));
          pressureByDow.set(cell.dow, prev + (cell.crunch ? 1 : 0));
        }
      }
      const weekdays = [0, 1, 2, 3, 4];
      const tightest = weekdays.slice().sort((a, b) => num(pressureByDow.get(b)) - num(pressureByDow.get(a)));
      const loosest = tightest.slice().reverse();

      const scenarios = [];
      for (const fromDow of tightest.slice(0, 2)) {
        if (!num(pressureByDow.get(fromDow))) continue;
        for (const [service, byDow] of volume) {
          const cases = num(byDow.get(fromDow));
          if (cases < 1) continue;
          const toDow = loosest.find(d => d !== fromDow);
          const move = Math.max(1, Math.round(cases * 0.4));
          scenarios.push({
            scenarioId: `${service}|${fromDow}|${toDow}`,
            service, fromDow, toDow, casesPerWeek: move,
            label: `Move ${move} ${service} case${move === 1 ? '' : 's'}/week from `
                 + `${DOW_LABEL[fromDow]} to ${DOW_LABEL[toDow]}`,
            rationale: `${DOW_LABEL[fromDow]} carries ${num(pressureByDow.get(fromDow))} `
                     + `crunch unit-day${num(pressureByDow.get(fromDow)) === 1 ? '' : 's'}; `
                     + `${DOW_LABEL[toDow]} carries ${num(pressureByDow.get(toDow))}. `
                     + `${service} runs ${round1(cases)} cases there each week.`,
            _weight: cases * (num(pressureByDow.get(fromDow)) + 1),
          });
        }
      }
      scenarios.sort((a, b) => b._weight - a._weight);
      res.json({ weeks, scenarios: scenarios.slice(0, 8).map(({ _weight, ...s }) => s) });
    } catch (err) {
      console.error('/api/smoothing/scenarios error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── POST /api/smoothing/preview ───────────────────────────────────────────
  // The page owns the census picture; the panel owns the judgment. This returns
  // only the before/after curves — pillar verdicts stay with /api/isscm.
  router.post('/preview', async (req, res) => {
    try {
      const tenant = req.tenantName || 'default';
      const d = req.body?.decision || {};
      if (!d.service || d.fromDow == null || d.toDow == null) {
        return res.status(400).json({ error: 'decision.service, decision.fromDow and decision.toDow are required' });
      }
      const weeks = 8;
      const db = await getTenantPool(req.session.tenantId);

      const [attribution, losDays, vol, unitShares] = await Promise.all([
        fetchAttribution(db, tenant, weeks),
        losFor(db, String(d.service), tenant, weeks),
        volumeAndConversion(db, String(d.service), tenant, weeks),
        unitSharesFor(db, String(d.service)),
      ]);

      const grid = [];
      for (const u of attribution.units) {
        for (const cell of u.byDow) {
          grid.push({ unit: u.unit, dow: cell.dow, census: cell.census, capacity: u.capacity });
        }
      }

      res.json({
        decision: { kind: 'SHIFT_DOW', ...d },
        ...F.shiftPreview({
          grid, unitShares, conversionRate: vol.conversionRate,
          casesPerWeek: num(d.casesPerWeek) || 1,
          fromDow: num(d.fromDow), toDow: num(d.toDow), losDays,
        }, crunchPct(tenant)),
      });
    } catch (err) {
      console.error('/api/smoothing/preview error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Shared by /scenarios and /preview so both read one census picture.
  async function fetchAttribution(db, tenant, weeks) {
    const census = await db.request().input('weeks', sql.Int, weeks).query(`
      SELECT c.Unit, c.StaffedBeds,
             DATEPART(WEEKDAY, o.Datehour) AS Wd,
             AVG(CAST(o.Occupancy AS FLOAT)) AS Census
      FROM UnitCapacity c
      JOIN DS_Occupancy o ON o.DEP_NAME = c.Unit
      WHERE DATEPART(HOUR, o.Datehour) = 7
        AND o.Datehour >= DATEADD(week, -@weeks, CAST(GETDATE() AS DATE))
      GROUP BY c.Unit, c.StaffedBeds, DATEPART(WEEKDAY, o.Datehour)
    `);
    const threshold = crunchPct(tenant);
    const byUnit = new Map();
    for (const row of census.recordset) {
      const dow = sqlDowToJs(row.Wd);
      if (!byUnit.has(row.Unit)) {
        byUnit.set(row.Unit, { unit: row.Unit, capacity: num(row.StaffedBeds), byDow: [] });
      }
      byUnit.get(row.Unit).byDow.push({
        dow, label: DOW_LABEL[dow],
        ...F.attributeCensus({ census: num(row.Census), capacity: num(row.StaffedBeds) }, threshold),
      });
    }
    for (const u of byUnit.values()) u.byDow.sort((a, b) => a.dow - b.dow);
    return { units: [...byUnit.values()] };
  }

  return router;
};

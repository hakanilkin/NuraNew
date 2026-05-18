require('dotenv').config();
const express  = require('express');
const sql      = require('mssql');
const path     = require('path');
const fs       = require('fs');
const bcrypt   = require('bcryptjs');
const speakeasy = require('speakeasy');
const QRCode   = require('qrcode');
const session  = require('express-session');

const app = express();
app.use(express.json());

// ── SQL Server connection ───────────────────────────────────────────
const dbConfig = {
  server: process.env.DB_SERVER,
  database: process.env.DB_DATABASE,
  port: parseInt(process.env.DB_PORT) || 1433,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: {
    encrypt: true,
    trustServerCertificate: true,
    enableArithAbort: true,
  },
};

let pool;
async function getPool() {
  if (!pool) pool = await sql.connect(dbConfig);
  return pool;
}

// ── Session ────────────────────────────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET || 'nura-change-me-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 8 * 60 * 60 * 1000   // 8 hours
  }
}));

// ── Auth middleware ────────────────────────────────────────────────
const PUBLIC_PATHS = [
  '/login.html', '/auth.css',
  '/api/auth/login', '/api/auth/verify-totp',
  '/api/auth/setup-totp', '/api/auth/confirm-totp',
  '/favicon.ico'
];

function requireAuth(req, res, next) {
  if (PUBLIC_PATHS.includes(req.path)) return next();
  if (req.session && req.session.userId && req.session.totpVerified) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  // Redirect HTML page requests to login
  return res.redirect('/login.html');
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.isAdmin) return res.status(403).json({ error: 'Forbidden' });
  next();
}

app.use(requireAuth);
app.use(express.static(path.join(__dirname, 'public')));

// =================================================================
// AUTH ENDPOINTS
// =================================================================

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  try {
    const db = await getPool();
    const result = await db.request()
      .input('username', sql.NVarChar, username)
      .query(`SELECT UserID, Username, Email, FullName, PasswordHash, TOTPSecret, TOTPEnabled,
                     IsAdmin, IsActive, MustChangePwd
              FROM Users WHERE Username = @username`);

    const user = result.recordset[0];
    if (!user || !user.IsActive) return res.status(401).json({ error: 'Invalid credentials' });

    const match = await bcrypt.compare(password, user.PasswordHash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    // Store pending auth in session (not yet fully authenticated)
    req.session.pendingUserId  = user.UserID;
    req.session.pendingIsAdmin = user.IsAdmin === true || user.IsAdmin === 1;
    req.session.pendingName    = user.FullName || user.Username;
    req.session.pendingEmail   = user.Email || null;
    req.session.mustChangePwd  = user.MustChangePwd === true || user.MustChangePwd === 1;

    if (user.TOTPEnabled && user.TOTPSecret) {
      return res.json({ nextStep: 'verify-totp' });
    } else {
      // Generate a new TOTP secret for setup
      const secret = speakeasy.generateSecret({ name: `Nura (${username})`, length: 20 });
      req.session.pendingTOTPSecret = secret.base32;
      const qr = await QRCode.toDataURL(secret.otpauth_url);
      return res.json({ nextStep: 'setup-totp', qr, secret: secret.base32 });
    }
  } catch (err) {
    console.error('/api/auth/login error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/verify-totp  (existing TOTP users)
app.post('/api/auth/verify-totp', async (req, res) => {
  const { code } = req.body;
  if (!req.session.pendingUserId) return res.status(401).json({ error: 'No pending authentication' });
  try {
    const db = await getPool();
    const result = await db.request()
      .input('uid', sql.Int, req.session.pendingUserId)
      .query(`SELECT TOTPSecret FROM Users WHERE UserID = @uid`);
    const secret = result.recordset[0]?.TOTPSecret;
    if (!secret) return res.status(401).json({ error: 'MFA not configured' });

    const valid = speakeasy.totp.verify({ secret, encoding: 'base32', token: code, window: 1 });
    if (!valid) return res.status(401).json({ error: 'Invalid code' });

    await _finalizeLogin(req, db);
    res.json({ ok: true, isAdmin: req.session.isAdmin, mustChangePwd: req.session.mustChangePwd });
  } catch (err) {
    console.error('/api/auth/verify-totp error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/confirm-totp  (first-time TOTP enrollment)
app.post('/api/auth/confirm-totp', async (req, res) => {
  const { code } = req.body;
  if (!req.session.pendingUserId || !req.session.pendingTOTPSecret) {
    return res.status(401).json({ error: 'No pending setup' });
  }
  const secret = req.session.pendingTOTPSecret;
  const valid  = speakeasy.totp.verify({ secret, encoding: 'base32', token: code, window: 1 });
  if (!valid) return res.status(401).json({ error: 'Invalid code — try again' });

  try {
    const db = await getPool();
    await db.request()
      .input('secret', sql.NVarChar, secret)
      .input('uid',    sql.Int,      req.session.pendingUserId)
      .query(`UPDATE Users SET TOTPSecret = @secret, TOTPEnabled = 1 WHERE UserID = @uid`);

    await _finalizeLogin(req, db);
    res.json({ ok: true, isAdmin: req.session.isAdmin, mustChangePwd: req.session.mustChangePwd });
  } catch (err) {
    console.error('/api/auth/confirm-totp error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

async function _finalizeLogin(req, db) {
  const uid = req.session.pendingUserId;
  await db.request()
    .input('uid', sql.Int, uid)
    .query(`UPDATE Users SET LastLogin = GETDATE() WHERE UserID = @uid`);
  req.session.userId        = uid;
  req.session.isAdmin       = req.session.pendingIsAdmin;
  req.session.fullName      = req.session.pendingName;
  req.session.email         = req.session.pendingEmail;
  req.session.totpVerified  = true;
  req.session.mustChangePwd = req.session.mustChangePwd;
  delete req.session.pendingUserId;
  delete req.session.pendingIsAdmin;
  delete req.session.pendingName;
  delete req.session.pendingEmail;
  delete req.session.pendingTOTPSecret;
}

// POST /api/auth/change-password
app.post('/api/auth/change-password', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  const { currentPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  try {
    const db = await getPool();
    const result = await db.request()
      .input('uid', sql.Int, req.session.userId)
      .query(`SELECT PasswordHash FROM Users WHERE UserID = @uid`);
    const hash = result.recordset[0]?.PasswordHash;
    const match = await bcrypt.compare(currentPassword, hash);
    if (!match) return res.status(401).json({ error: 'Current password incorrect' });
    const newHash = await bcrypt.hash(newPassword, 10);
    await db.request()
      .input('hash', sql.NVarChar, newHash)
      .input('uid',  sql.Int,      req.session.userId)
      .query(`UPDATE Users SET PasswordHash = @hash, MustChangePwd = 0 WHERE UserID = @uid`);
    req.session.mustChangePwd = false;
    res.json({ ok: true });
  } catch (err) {
    console.error('/api/auth/change-password error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/auth/me
app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  res.json({
    userId:       req.session.userId,
    fullName:     req.session.fullName,
    isAdmin:      req.session.isAdmin,
    mustChangePwd: req.session.mustChangePwd
  });
});

// POST /api/auth/logout
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// =================================================================
// ADMIN ENDPOINTS  (requires isAdmin)
// =================================================================

// GET /api/admin/users
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const db = await getPool();
    const result = await db.request().query(`
      SELECT UserID, Username, Email, FullName, IsAdmin, IsActive,
             TOTPEnabled, MustChangePwd, CreatedAt, LastLogin
      FROM Users ORDER BY Username
    `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/users  – create user
app.post('/api/admin/users', requireAdmin, async (req, res) => {
  const { username, email, fullName, password, isAdmin } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const db   = await getPool();
    await db.request()
      .input('username', sql.NVarChar, username)
      .input('email',    sql.NVarChar, email    || null)
      .input('fullName', sql.NVarChar, fullName || null)
      .input('hash',     sql.NVarChar, hash)
      .input('isAdmin',  sql.Bit,      isAdmin ? 1 : 0)
      .query(`INSERT INTO Users (Username, Email, FullName, PasswordHash, IsAdmin, MustChangePwd)
              VALUES (@username, @email, @fullName, @hash, @isAdmin, 1)`);
    res.json({ ok: true });
  } catch (err) {
    if (err.message.includes('UQ_Users_Username')) return res.status(409).json({ error: 'Username already exists' });
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/users/:id  – update user
app.put('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const { email, fullName, isAdmin, isActive, resetPassword, resetTotp } = req.body;
  try {
    const db = await getPool();
    const r  = db.request().input('uid', sql.Int, id);
    let sets = [];
    if (email    !== undefined) { r.input('email',    sql.NVarChar, email    || null); sets.push('Email = @email'); }
    if (fullName !== undefined) { r.input('fullName', sql.NVarChar, fullName || null); sets.push('FullName = @fullName'); }
    if (isAdmin  !== undefined) { r.input('isAdmin',  sql.Bit,      isAdmin ? 1 : 0); sets.push('IsAdmin = @isAdmin'); }
    if (isActive !== undefined) { r.input('isActive', sql.Bit,      isActive ? 1 : 0); sets.push('IsActive = @isActive'); }
    if (resetPassword) {
      const hash = await bcrypt.hash(resetPassword, 10);
      r.input('hash', sql.NVarChar, hash);
      sets.push('PasswordHash = @hash', 'MustChangePwd = 1');
    }
    if (resetTotp) sets.push('TOTPSecret = NULL', 'TOTPEnabled = 0');
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    await r.query(`UPDATE Users SET ${sets.join(', ')} WHERE UserID = @uid`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/users/:id
app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.session.userId) return res.status(400).json({ error: 'Cannot delete your own account' });
  try {
    const db = await getPool();
    await db.request().input('uid', sql.Int, id).query(`DELETE FROM Users WHERE UserID = @uid`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper – builds a parameterised IN clause for the sites CSV param
function addSitesFilter(request, sitesParam) {
  if (!sitesParam) return '';
  const sites = sitesParam.split(',').map(s => s.trim()).filter(Boolean);
  if (!sites.length) return '';
  const placeholders = sites.map((s, i) => {
    request.input(`site${i}`, sql.NVarChar, s);
    return `@site${i}`;
  });
  return ` AND ISNULL(Loc_ORGrp2, 'Unknown') IN (${placeholders.join(', ')})`;
}

// -----------------------------------------------------------------
// GET /api/sites
// Returns distinct site names for the filter dropdown
// -----------------------------------------------------------------
app.get('/api/sites', async (req, res) => {
  try {
    const db = await getPool();
    const result = await db.request().query(`
      SELECT DISTINCT ISNULL(Loc_ORGrp2, 'Unknown') AS Site
      FROM DS_CASES
      ORDER BY Site
    `);
    res.json(result.recordset.map(r => r.Site));
  } catch (err) {
    console.error('/api/sites error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------
// GET /api/summary?startDate=&endDate=&sites=
// Returns total cases and OR duration per site for the given range
// -----------------------------------------------------------------
app.get('/api/summary', async (req, res) => {
  try {
    const db      = await getPool();
    const request = db.request();
    const startDate = req.query.startDate || '2025-01-01';
    const endDate   = req.query.endDate   || '2025-12-31';
    request.input('startDate', sql.Date, startDate);
    request.input('endDate',   sql.Date, endDate);
    const siteFilter = addSitesFilter(request, req.query.sites);

    const result = await request.query(`
      SELECT
        ISNULL(Loc_ORGrp2, 'Unknown') AS Site,
        COUNT(*)                       AS TotalCases,
        SUM(ISNULL(Dur_ORIn_OROut, 0)) AS TotalORDuration
      FROM DS_CASES
      WHERE Date_SchedDate >= @startDate
        AND Date_SchedDate <= @endDate
        ${siteFilter}
      GROUP BY Loc_ORGrp2
      ORDER BY Loc_ORGrp2
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error('/api/summary error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------
// GET /api/monthly-trend?startDate=&endDate=&sites=
// Returns monthly case count for the given date range / sites
// -----------------------------------------------------------------
app.get('/api/monthly-trend', async (req, res) => {
  try {
    const db      = await getPool();
    const request = db.request();
    const startDate = req.query.startDate || '2025-01-01';
    const endDate   = req.query.endDate   || '2025-12-31';
    request.input('startDate', sql.Date, startDate);
    request.input('endDate',   sql.Date, endDate);
    const siteFilter = addSitesFilter(request, req.query.sites);

    const result = await request.query(`
      SELECT
        YEAR(Date_SchedDate)  AS Year,
        MONTH(Date_SchedDate) AS Month,
        COUNT(*)              AS TotalCases
      FROM DS_CASES
      WHERE Date_SchedDate >= @startDate
        AND Date_SchedDate <= @endDate
        ${siteFilter}
      GROUP BY YEAR(Date_SchedDate), MONTH(Date_SchedDate)
      ORDER BY Year, Month
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error('/api/monthly-trend error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =================================================================
// CAPACITY ENDPOINTS  (source: V4_BlockResultsView)
// Note: column names assume BlockDate, LocationGroup,
//       Total_Prime_Time, blockTime, Total_Non_Prime_time, total_Time
// =================================================================

// Helper – builds parameterised IN clause for locations CSV param
function addLocationsFilter(request, locParam) {
  if (!locParam) return '';
  const locs = locParam.split(',').map(s => s.trim()).filter(Boolean);
  if (!locs.length) return '';
  const placeholders = locs.map((l, i) => {
    request.input(`loc${i}`, sql.NVarChar, l);
    return `@loc${i}`;
  });
  return ` AND ISNULL(LocationGroup, 'Unknown') IN (${placeholders.join(', ')})`;
}

// Helper – builds parameterised IN clause for caseblocks CSV param
function addCaseBlocksFilter(request, cbParam) {
  if (!cbParam) return '';
  const blocks = cbParam.split(',').map(s => s.trim()).filter(Boolean);
  if (!blocks.length) return '';
  const placeholders = blocks.map((b, i) => {
    request.input(`cb${i}`, sql.NVarChar, b);
    return `@cb${i}`;
  });
  return ` AND ISNULL(CaseBlock, 'Unknown') IN (${placeholders.join(', ')})`;
}

// Helper – builds DATEPART(WEEKDAY) IN clause from CSV of day numbers
function addDowFilter(dowParam) {
  if (!dowParam) return '';
  const days = dowParam.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
  if (!days.length) return '';
  return ` AND DATEPART(WEEKDAY, BlockDate) IN (${days.join(', ')})`;
}

// -----------------------------------------------------------------
// GET /api/capacity/location-groups
// Distinct LocationGroup values for the filter dropdown
// -----------------------------------------------------------------
app.get('/api/capacity/location-groups', async (req, res) => {
  try {
    const db = await getPool();
    const result = await db.request().query(`
      SELECT DISTINCT ISNULL(LocationGroup, 'Unknown') AS LocationGroup
      FROM V4_BlockResultsView
      ORDER BY LocationGroup
    `);
    res.json(result.recordset.map(r => r.LocationGroup));
  } catch (err) {
    console.error('/api/capacity/location-groups error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------
// GET /api/capacity/prime-time?startDate=&endDate=&locations=&dow=
// Prime Time Utilization = SUM(Total_Prime_Time) / SUM(blockTime)
// -----------------------------------------------------------------
app.get('/api/capacity/prime-time', async (req, res) => {
  try {
    const db      = await getPool();
    const request = db.request();
    const startDate = req.query.startDate || '2025-01-01';
    const endDate   = req.query.endDate   || '2025-12-31';
    request.input('startDate', sql.Date, startDate);
    request.input('endDate',   sql.Date, endDate);
    const locFilter = addLocationsFilter(request, req.query.locations);
    const dowFilter = addDowFilter(req.query.dow);

    const result = await request.query(`
      SELECT
        ISNULL(LocationGroup, 'Unknown')     AS LocationGroup,
        SUM(ISNULL(Total_Prime_Time, 0))     AS SumPrimeTime,
        SUM(ISNULL(blockTime, 0))            AS SumBlockTime,
        CASE WHEN SUM(ISNULL(blockTime, 0)) = 0 THEN 0
             ELSE ROUND(
               100.0 * SUM(ISNULL(Total_Prime_Time, 0))
                     / SUM(ISNULL(blockTime, 0)), 2)
        END AS PrimeTimeUtil
      FROM V4_BlockResultsView
      WHERE BlockDate >= @startDate
        AND BlockDate <= @endDate
        ${locFilter}
        ${dowFilter}
      GROUP BY LocationGroup
      ORDER BY LocationGroup
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error('/api/capacity/prime-time error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------
// GET /api/capacity/non-prime-time?startDate=&endDate=&locations=&dow=
// Non-Prime Time Use = SUM(Total_Non_Prime_time) / SUM(total_Time)
// -----------------------------------------------------------------
app.get('/api/capacity/non-prime-time', async (req, res) => {
  try {
    const db      = await getPool();
    const request = db.request();
    const startDate = req.query.startDate || '2025-01-01';
    const endDate   = req.query.endDate   || '2025-12-31';
    request.input('startDate', sql.Date, startDate);
    request.input('endDate',   sql.Date, endDate);
    const locFilter = addLocationsFilter(request, req.query.locations);
    const dowFilter = addDowFilter(req.query.dow);

    const result = await request.query(`
      SELECT
        ISNULL(LocationGroup, 'Unknown')         AS LocationGroup,
        SUM(ISNULL(Total_Non_Prime_time, 0))     AS SumNonPrimeTime,
        SUM(ISNULL(totalTime, 0))               AS SumTotalTime,
        CASE WHEN SUM(ISNULL(totalTime, 0)) = 0 THEN 0
             ELSE ROUND(
               100.0 * SUM(ISNULL(Total_Non_Prime_time, 0))
                     / SUM(ISNULL(totalTime, 0)), 2)
        END AS NonPrimeTimeUtil
      FROM V4_BlockResultsView
      WHERE BlockDate >= @startDate
        AND BlockDate <= @endDate
        ${locFilter}
        ${dowFilter}
      GROUP BY LocationGroup
      ORDER BY LocationGroup
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error('/api/capacity/non-prime-time error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =================================================================
// BLOCK UTILIZATION ENDPOINTS  (source: V4_BlockResultsView)
// =================================================================

// -----------------------------------------------------------------
// GET /api/blockutil/caseblocks?startDate=&endDate=&locations=
// Distinct CaseBlock values for the filter dropdown
// -----------------------------------------------------------------
app.get('/api/blockutil/caseblocks', async (req, res) => {
  try {
    const db      = await getPool();
    const request = db.request();
    const startDate = req.query.startDate || '2025-01-01';
    const endDate   = req.query.endDate   || '2025-12-31';
    request.input('startDate', sql.Date, startDate);
    request.input('endDate',   sql.Date, endDate);
    const locFilter = addLocationsFilter(request, req.query.locations);

    const result = await request.query(`
      SELECT DISTINCT ISNULL(CaseBlock, 'Unknown') AS CaseBlock
      FROM V4_BlockResultsView
      WHERE BlockDate >= @startDate
        AND BlockDate <= @endDate
        ${locFilter}
        AND DATEPART(WEEKDAY, BlockDate) IN (2, 3, 4, 5, 6)
      ORDER BY CaseBlock
    `);
    res.json(result.recordset.map(r => r.CaseBlock));
  } catch (err) {
    console.error('/api/blockutil/caseblocks error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------
// GET /api/blockutil/data?startDate=&endDate=&locations=
// Returns block utilization by CaseBlock, WeekOfMonth, DayOfWeek
// Restricted to weekdays (Mon–Fri) only
// -----------------------------------------------------------------
app.get('/api/blockutil/data', async (req, res) => {
  try {
    const db      = await getPool();
    const request = db.request();
    const startDate = req.query.startDate || '2025-01-01';
    const endDate   = req.query.endDate   || '2025-12-31';
    request.input('startDate', sql.Date, startDate);
    request.input('endDate',   sql.Date, endDate);
    const locFilter = addLocationsFilter(request, req.query.locations);
    const cbFilter  = addCaseBlocksFilter(request, req.query.caseblocks);

    const result = await request.query(`
      SELECT
        ISNULL(CaseBlock, 'Unknown')              AS CaseBlock,
        COALESCE(Group_Service, Surgeonservice)    AS Service,
        dd_WeekofMonth                             AS WeekOfMonth,
        DATEPART(WEEKDAY, BlockDate)               AS DayOfWeek,
        COUNT(DISTINCT CaseID)                     AS CaseCount,
        SUM(ISNULL(Total_Prime_Time, 0))           AS SumPrimeTime,
        SUM(ISNULL(blockTime, 0))                  AS SumBlockTime,
        SUM(ISNULL(Total_Non_Prime_time, 0))       AS SumNonPrimeTime,
        SUM(ISNULL(totalTime, 0))                  AS SumTotalTime,
        SUM(ISNULL(ReleasedTime, 0))               AS SumReleasedTime
      FROM V4_BlockResultsView
      WHERE BlockDate >= @startDate
        AND BlockDate <= @endDate
        ${locFilter}
        ${cbFilter}
        AND DATEPART(WEEKDAY, BlockDate) IN (2, 3, 4, 5, 6)
      GROUP BY CaseBlock,COALESCE(Group_Service, Surgeonservice), DD_WeekOfMonth, DATEPART(WEEKDAY, BlockDate)
      ORDER BY CaseBlock, 2, 3
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error('/api/blockutil/data error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------
// GET /api/blockutil/monthly-detail?startDate=&endDate=&locations=
// Same as /data but also groups by Month — used for cell hover tooltips
// -----------------------------------------------------------------
app.get('/api/blockutil/monthly-detail', async (req, res) => {
  try {
    const db      = await getPool();
    const request = db.request();
    const startDate = req.query.startDate || '2025-01-01';
    const endDate   = req.query.endDate   || '2025-12-31';
    request.input('startDate', sql.Date, startDate);
    request.input('endDate',   sql.Date, endDate);
    const locFilter = addLocationsFilter(request, req.query.locations);
    const cbFilter  = addCaseBlocksFilter(request, req.query.caseblocks);

    const result = await request.query(`
      SELECT
        ISNULL(CaseBlock, 'Unknown')               AS CaseBlock,
        COALESCE(Group_Service, Surgeonservice)    AS Service,        
        dd_WeekofMonth                             AS WeekOfMonth,
        DATEPART(WEEKDAY, BlockDate)               AS DayOfWeek,
        MONTH(BlockDate)                           AS Month,
        COUNT(DISTINCT CaseID)                     AS CaseCount,
        SUM(ISNULL(Total_Prime_Time, 0))           AS SumPrimeTime,
        SUM(ISNULL(blockTime, 0))                  AS SumBlockTime,
        SUM(ISNULL(Total_Non_Prime_time, 0))       AS SumNonPrimeTime,
        SUM(ISNULL(totalTime, 0))                  AS SumTotalTime,
        SUM(ISNULL(ReleasedTime, 0))               AS SumReleasedTime
      FROM V4_BlockResultsView
      WHERE BlockDate >= @startDate
        AND BlockDate <= @endDate
        ${locFilter}
        ${cbFilter}
        AND DATEPART(WEEKDAY, BlockDate) IN (2, 3, 4, 5, 6)
      GROUP BY CaseBlock,
              COALESCE(Group_Service, Surgeonservice) ,
               dd_WeekofMonth,
               DATEPART(WEEKDAY, BlockDate),
               MONTH(BlockDate)
      ORDER BY CaseBlock, 2, 3, Month
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error('/api/blockutil/monthly-detail error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =================================================================
// ATLAS ENDPOINTS
// =================================================================

// GET /api/atlas/fcot-model
// Returns the pre-trained EBM model JSON generated by ebm_pipeline.py
app.get('/api/atlas/fcot-model', (_req, res) => {
  const filePath = path.join(__dirname, 'public', 'data', 'fcot_ebm.json');
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: 'Model file not found — run ebm_pipeline.py first' });
    }
    console.error('/api/atlas/fcot-model read error:', err.message);
    return res.status(500).json({ error: 'Could not read model file' });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (parseErr) {
    console.error('/api/atlas/fcot-model parse error:', parseErr.message);
    return res.status(500).json({ error: 'Model file is corrupted or not valid JSON' });
  }
  res.json(parsed);
});

// POST /api/atlas/explain-interaction
// Calls Claude to generate a plain-English narrative for an EBM interaction effect
app.post('/api/atlas/explain-interaction', async (req, res) => {
  const { feature_1, feature_2, x_labels_1, x_labels_2, scores_matrix } = req.body;
  if (!feature_1 || !feature_2 || !scores_matrix) {
    return res.status(400).json({ error: 'feature_1, feature_2, and scores_matrix are required' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  // Extract the most extreme cells (by absolute value) to keep the prompt compact
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

// =================================================================
// BLAZESQL EMBED
// =================================================================

// GET /api/blazesql/url  — returns a signed BlazeSql session URL for the current user
app.get('/api/blazesql/url', requireAuth, async (req, res) => {
  const apiKey = process.env.BLAZESQL_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'BLAZESQL_API_KEY not configured' });

  try {
    const db     = await getPool();
    const result = await db.request()
      .input('uid', sql.Int, req.session.userId)
      .query(`SELECT Email FROM Users WHERE UserID = @uid`);
    const email  = result.recordset[0]?.Email;
    if (!email) return res.status(400).json({ error: 'No email on your account — ask an admin to add one.' });

    const response = await fetch('https://api.blazesql.com/user_authentication_api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, user_email: email, hide_sidebar: false })
    });
    const text = await response.text();
    if (!response.ok || !text.startsWith('http')) {
      return res.status(502).json({ error: text || 'BlazeSql auth failed' });
    }
    res.json({ url: text });
  } catch (err) {
    console.error('/api/blazesql/url error:', err.message, err.cause?.message);
    res.status(500).json({ error: 'Could not reach BlazeSql' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Surgical Dashboard running at http://localhost:${PORT}`);
});

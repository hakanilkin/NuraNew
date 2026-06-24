require('dotenv').config();
const express    = require('express');
const sql        = require('mssql');
const path       = require('path');
const crypto     = require('crypto');
const session    = require('express-session');
const MSSQLStore = require('connect-mssql-v2');

const { decryptSecret } = require('./lib/secrets');

const app = express();
app.use(express.json());

// ── Security headers ───────────────────────────────────────────────
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'same-origin');
  if (process.env.NODE_ENV === 'production') {
    res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
});

// ── SQL Server connections ─────────────────────────────────────────
// Only trust self-signed DB certificates when explicitly opted in (local dev)
const trustServerCertificate = process.env.DB_TRUST_SERVER_CERT === 'true';

const baseConfig = {
  server:   process.env.DB_SERVER,
  port:     parseInt(process.env.DB_PORT) || 1433,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: { encrypt: true, trustServerCertificate, enableArithAbort: true },
};

const authConfig = { ...baseConfig, database: process.env.AUTH_DB_DATABASE };  // NuraOps — users/auth/tenants

let authPool;
async function getAuthPool() {
  if (!authPool) authPool = await new sql.ConnectionPool(authConfig).connect();
  return authPool;
}

// ── Per-tenant connection pools ────────────────────────────────────
const tenantPools = {};

async function getTenantPool(tenantId) {
  if (tenantPools[tenantId]) return tenantPools[tenantId];
  const authDb = await getAuthPool();
  const result = await authDb.request()
    .input('tid', sql.Int, tenantId)
    .query(`SELECT DBServer, DBName, DBUser, DBPassword FROM Tenants WHERE TenantID = @tid AND IsActive = 1`);
  const t = result.recordset[0];
  if (!t) throw new Error(`Tenant ${tenantId} not found or inactive`);
  const pool = await new sql.ConnectionPool({
    server:   t.DBServer,
    database: t.DBName,
    user:     t.DBUser,
    password: decryptSecret(t.DBPassword),
    port:     parseInt(process.env.DB_PORT) || 1433,
    options:  { encrypt: true, trustServerCertificate, enableArithAbort: true },
  }).connect();
  tenantPools[tenantId] = pool;
  return pool;
}

// Drop a cached pool when a tenant's connection details change or the
// tenant is deactivated/deleted, so stale credentials aren't reused.
async function invalidateTenantPool(tenantId) {
  const pool = tenantPools[tenantId];
  if (!pool) return;
  delete tenantPools[tenantId];
  try { await pool.close(); } catch (err) {
    console.error(`Error closing pool for tenant ${tenantId}:`, err.message);
  }
}

const isProd = process.env.NODE_ENV === 'production';

// ── Session ────────────────────────────────────────────────────────
if (!process.env.SESSION_SECRET && isProd) {
  console.error('FATAL: SESSION_SECRET environment variable must be set in production.');
  process.exit(1);
}
if (!process.env.SESSION_SECRET) {
  console.warn('WARNING: SESSION_SECRET not set — using a random secret (sessions reset on restart).');
}

if (isProd) {
  app.set('trust proxy', 1); // needed for secure cookies behind a reverse proxy
}

const sessionOptions = {
  secret:            process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave:            false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure:   isProd,
    maxAge:   8 * 60 * 60 * 1000,
  },
};
if (isProd) {
  sessionOptions.store = new MSSQLStore(authConfig, session);
}
app.use(session(sessionOptions));

// ── Auth middleware ────────────────────────────────────────────────
const PUBLIC_API_PATHS = [
  '/api/auth/login', '/api/auth/verify-totp',
  '/api/auth/confirm-totp', '/api/auth/select-tenant',
];

// Paths still usable while a password change is pending
const PWD_CHANGE_ALLOWED_PATHS = [
  '/api/auth/change-password', '/api/auth/logout', '/api/auth/me',
];

// Periodically re-check the user against the auth DB so that deactivating
// a user, removing a tenant assignment, or revoking admin takes effect on
// live sessions instead of waiting for the cookie to expire.
const SESSION_REVALIDATE_MS = 60 * 1000;

async function revalidateSession(req) {
  const now = Date.now();
  if (req.session.lastValidated && now - req.session.lastValidated < SESSION_REVALIDATE_MS) {
    return true;
  }
  try {
    const db = await getAuthPool();
    const uRes = await db.request()
      .input('uid', sql.Int, req.session.userId)
      .query(`SELECT IsActive, IsAdmin, MustChangePwd FROM Users WHERE UserID = @uid`);
    const u = uRes.recordset[0];
    if (!u || !(u.IsActive === true || u.IsActive === 1)) return false;
    req.session.isAdmin       = u.IsAdmin === true || u.IsAdmin === 1;
    req.session.mustChangePwd = u.MustChangePwd === true || u.MustChangePwd === 1;

    const tRes = await db.request()
      .input('uid', sql.Int, req.session.userId)
      .query(`SELECT t.TenantID, t.TenantName
              FROM Tenants t
              JOIN UserTenants ut ON t.TenantID = ut.TenantID
              WHERE ut.UserID = @uid AND t.IsActive = 1
              ORDER BY t.TenantName`);
    req.session.tenants = tRes.recordset;
    if (req.session.tenantId && !tRes.recordset.some(t => t.TenantID === req.session.tenantId)) {
      delete req.session.tenantId;
      delete req.session.tenantName;
    }
    req.session.lastValidated = now;
    return true;
  } catch (err) {
    // Fail open on transient auth-DB errors — data routes will surface
    // their own failures, and we re-check on the next request.
    console.error('Session revalidation error:', err.message);
    return true;
  }
}

async function requireAuth(req, res, next) {
  if (PUBLIC_API_PATHS.includes(req.path)) return next();
  if (req.session && req.session.userId && req.session.totpVerified) {
    if (!(await revalidateSession(req))) {
      return req.session.destroy(() => res.status(401).json({ error: 'Unauthorized' }));
    }
    if (req.session.mustChangePwd
        && req.path.startsWith('/api/')
        && !PWD_CHANGE_ALLOWED_PATHS.includes(req.path)) {
      return res.status(403).json({ error: 'Password change required', code: 'PWD_CHANGE_REQUIRED' });
    }
    return next();
  }
  // Block API calls and data files — React Router handles page-level redirects
  if (req.path.startsWith('/api/') || req.path.startsWith('/data/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.isAdmin) return res.status(403).json({ error: 'Forbidden' });
  next();
}

function requireTenant(req, res, next) {
  if (!req.session || !req.session.tenantId) return res.status(400).json({ error: 'No client selected' });
  next();
}

app.use(requireAuth);

// ── Static files ───────────────────────────────────────────────────
// Model/data JSON only, mounted at /data — nothing else in public/ is
// reachable, so leftover files from old deployments can't shadow the app
app.use('/data', express.static(path.join(__dirname, 'public', 'data')));

if (isProd) {
  // React build. Hashed assets are immutable and cacheable forever;
  // index.html is served by the catch-all below with no-cache so
  // browsers always pick up new deployments.
  app.use(express.static(path.join(__dirname, 'client', 'dist'), {
    index: false,
    setHeaders(res, filePath) {
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.set('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  }));
}

// ── Route modules ──────────────────────────────────────────────────
const authRouter      = require('./routes/auth')(getAuthPool, sql);
const adminRouter     = require('./routes/admin')(getAuthPool, sql, requireAdmin, invalidateTenantPool);
const analyticsRouter = require('./routes/analytics')(getTenantPool, sql, requireTenant);
const atlasRouter     = require('./routes/atlas');
const askNuraRouter   = require('./routes/askNura')(getTenantPool, sql, requireTenant);
const iplosRouter          = require('./routes/iplos')(getTenantPool, sql, requireTenant);
const ipbedplacementRouter = require('./routes/ipbedplacement')(getTenantPool, sql, requireTenant);
const ipdischargesRouter   = require('./routes/ipdischarges')(getTenantPool, sql, requireTenant);

app.use('/api/auth',           authRouter);
app.use('/api/admin',          adminRouter);
app.use('/api/atlas',          atlasRouter);
app.use('/api/iplos',          iplosRouter);
app.use('/api/ipbedplacement', ipbedplacementRouter);
app.use('/api/ipdischarges',   ipdischargesRouter);
app.use('/api',        analyticsRouter);
app.use('/api',        askNuraRouter);

// ── API error handler (returns JSON instead of HTML) ───────────────
// Must be registered after the routes to catch their errors.
app.use((err, req, res, next) => {
  console.error('Express error:', err.message);
  if (req.path.startsWith('/api/')) return res.status(500).json({ error: 'Internal server error' });
  next(err);
});

// ── React Router catch-all (production only) ──────────────────────
if (isProd) {
  app.get('*', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(__dirname, 'client', 'dist', 'index.html'));
  });
}

// ── Start ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Surgical Dashboard running at http://localhost:${PORT}`);
});

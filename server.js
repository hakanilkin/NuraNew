require('dotenv').config();
const express    = require('express');
const sql        = require('mssql');
const path       = require('path');
const session    = require('express-session');
const MSSQLStore = require('connect-mssql-v2');

const app = express();
app.use(express.json());

// ── SQL Server connections ─────────────────────────────────────────
const baseConfig = {
  server:   process.env.DB_SERVER,
  port:     parseInt(process.env.DB_PORT) || 1433,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: { encrypt: true, trustServerCertificate: true, enableArithAbort: true },
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
    password: t.DBPassword,
    port:     parseInt(process.env.DB_PORT) || 1433,
    options:  { encrypt: true, trustServerCertificate: true, enableArithAbort: true },
  }).connect();
  tenantPools[tenantId] = pool;
  return pool;
}

// ── Session ────────────────────────────────────────────────────────
app.use(session({
  store:             new MSSQLStore(authConfig),
  secret:            process.env.SESSION_SECRET || 'nura-change-me-in-production',
  resave:            false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 8 * 60 * 60 * 1000 },
}));

const isProd = process.env.NODE_ENV === 'production';

// ── Auth middleware ────────────────────────────────────────────────
const PUBLIC_API_PATHS = [
  '/api/auth/login', '/api/auth/verify-totp',
  '/api/auth/confirm-totp', '/api/auth/select-tenant',
];

function requireAuth(req, res, next) {
  if (PUBLIC_API_PATHS.includes(req.path)) return next();
  if (req.session && req.session.userId && req.session.totpVerified) return next();
  // Only block API calls — React Router handles page-level redirects
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
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
app.use(express.static(path.join(__dirname, 'public')));              // data files (EBM JSON etc.)
if (isProd) {
  app.use(express.static(path.join(__dirname, 'client', 'dist')));    // React build
}

// ── Route modules ──────────────────────────────────────────────────
const authRouter      = require('./routes/auth')(getAuthPool, sql);
const adminRouter     = require('./routes/admin')(getAuthPool, sql, requireAdmin);
const analyticsRouter = require('./routes/analytics')(getTenantPool, sql, requireTenant);
const atlasRouter     = require('./routes/atlas');
const askNuraRouter   = require('./routes/askNura')(getTenantPool, sql);

app.use('/api/auth',  authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/atlas', atlasRouter);
app.use('/api',       analyticsRouter);
app.use('/api',       askNuraRouter);

// ── React Router catch-all (production only) ──────────────────────
if (isProd) {
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'client', 'dist', 'index.html'));
  });
}

// ── Start ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Surgical Dashboard running at http://localhost:${PORT}`);
});

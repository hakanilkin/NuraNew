require('dotenv').config();
const express = require('express');
const sql     = require('mssql');
const path    = require('path');
const session = require('express-session');

const app = express();
app.use(express.json());

// ── SQL Server connection ───────────────────────────────────────────
const dbConfig = {
  server:   process.env.DB_SERVER,
  database: process.env.DB_DATABASE,
  port:     parseInt(process.env.DB_PORT) || 1433,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: {
    encrypt:               true,
    trustServerCertificate: true,
    enableArithAbort:      true,
  },
};

let pool;
async function getPool() {
  if (!pool) pool = await sql.connect(dbConfig);
  return pool;
}

// ── Session ────────────────────────────────────────────────────────
app.use(session({
  secret:            process.env.SESSION_SECRET || 'nura-change-me-in-production',
  resave:            false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge:   8 * 60 * 60 * 1000,   // 8 hours
  },
}));

// ── Auth middleware ────────────────────────────────────────────────
const PUBLIC_PATHS = [
  '/login.html', '/auth.css',
  '/api/auth/login', '/api/auth/verify-totp',
  '/api/auth/setup-totp', '/api/auth/confirm-totp',
  '/favicon.ico',
];

function requireAuth(req, res, next) {
  if (PUBLIC_PATHS.includes(req.path)) return next();
  if (req.session && req.session.userId && req.session.totpVerified) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  return res.redirect('/login.html');
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.isAdmin) return res.status(403).json({ error: 'Forbidden' });
  next();
}

app.use(requireAuth);
app.use(express.static(path.join(__dirname, 'public')));

// ── Route modules ──────────────────────────────────────────────────
const authRouter      = require('./routes/auth')(getPool, sql);
const adminRouter     = require('./routes/admin')(getPool, sql, requireAdmin);
const analyticsRouter = require('./routes/analytics')(getPool, sql);
const atlasRouter     = require('./routes/atlas');
const askNuraRouter   = require('./routes/askNura')(getPool, sql);

app.use('/api/auth',  authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/atlas', atlasRouter);
app.use('/api',       analyticsRouter);
app.use('/api',       askNuraRouter);

// ── Start ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Surgical Dashboard running at http://localhost:${PORT}`);
});

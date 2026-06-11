const express           = require('express');
const bcrypt            = require('bcryptjs');
const speakeasy         = require('speakeasy');
const QRCode            = require('qrcode');
const createRateLimiter = require('../middleware/rateLimit');

module.exports = function authRoutes(getAuthPool, sql) {
  const router = express.Router();

  const loginLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max:      10,
    message:  'Too many login attempts — please try again in a few minutes',
  });
  const totpLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max:      10,
    message:  'Too many verification attempts — please try again in a few minutes',
  });

  // ── Finalize login: regenerate session, set identity, fetch tenants ─
  async function _finalizeLogin(req, db) {
    const uid           = req.session.pendingUserId;
    const isAdmin       = req.session.pendingIsAdmin;
    const fullName      = req.session.pendingName;
    const email         = req.session.pendingEmail;
    const mustChangePwd = req.session.mustChangePwd;

    await db.request()
      .input('uid', sql.Int, uid)
      .query(`UPDATE Users SET LastLogin = GETDATE() WHERE UserID = @uid`);

    const tResult = await db.request()
      .input('uid', sql.Int, uid)
      .query(`SELECT t.TenantID, t.TenantName
              FROM Tenants t
              JOIN UserTenants ut ON t.TenantID = ut.TenantID
              WHERE ut.UserID = @uid AND t.IsActive = 1
              ORDER BY t.TenantName`);
    const tenants = tResult.recordset;

    // New session ID on privilege change — prevents session fixation.
    // This also discards all pending* fields from the pre-login session.
    await new Promise((resolve, reject) =>
      req.session.regenerate(err => (err ? reject(err) : resolve()))
    );

    req.session.userId        = uid;
    req.session.isAdmin       = isAdmin;
    req.session.fullName      = fullName;
    req.session.email         = email;
    req.session.totpVerified  = true;
    req.session.mustChangePwd = mustChangePwd;
    req.session.tenants       = tenants;
    req.session.lastValidated = Date.now();

    // Auto-select if only one tenant
    if (tenants.length === 1) {
      req.session.tenantId   = tenants[0].TenantID;
      req.session.tenantName = tenants[0].TenantName;
    }
  }

  // POST /api/auth/login
  router.post('/login', loginLimiter, async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    try {
      const db     = await getAuthPool();
      const result = await db.request()
        .input('username', sql.NVarChar, username)
        .query(`SELECT UserID, Username, Email, FullName, PasswordHash, TOTPSecret, TOTPEnabled,
                       IsAdmin, IsActive, MustChangePwd
                FROM Users WHERE Username = @username`);

      const user = result.recordset[0];
      if (!user || !user.IsActive) return res.status(401).json({ error: 'Invalid credentials' });

      const match = await bcrypt.compare(password, user.PasswordHash);
      if (!match) return res.status(401).json({ error: 'Invalid credentials' });

      req.session.pendingUserId  = user.UserID;
      req.session.pendingIsAdmin = user.IsAdmin === true || user.IsAdmin === 1;
      req.session.pendingName    = user.FullName || user.Username;
      req.session.pendingEmail   = user.Email || null;
      req.session.mustChangePwd  = user.MustChangePwd === true || user.MustChangePwd === 1;

      if (user.TOTPEnabled && user.TOTPSecret) {
        return res.json({ nextStep: 'verify-totp' });
      } else {
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

  // POST /api/auth/verify-totp
  router.post('/verify-totp', totpLimiter, async (req, res) => {
    const { code } = req.body;
    if (!req.session.pendingUserId) return res.status(401).json({ error: 'No pending authentication' });
    try {
      const db     = await getAuthPool();
      const result = await db.request()
        .input('uid', sql.Int, req.session.pendingUserId)
        .query(`SELECT TOTPSecret FROM Users WHERE UserID = @uid`);
      const secret = result.recordset[0]?.TOTPSecret;
      if (!secret) return res.status(401).json({ error: 'MFA not configured' });

      const valid = speakeasy.totp.verify({ secret, encoding: 'base32', token: code, window: 1 });
      if (!valid) return res.status(401).json({ error: 'Invalid code' });

      await _finalizeLogin(req, db);
      res.json({
        ok:             true,
        userId:         req.session.userId,
        fullName:       req.session.fullName,
        isAdmin:        req.session.isAdmin,
        mustChangePwd:  req.session.mustChangePwd,
        tenants:        req.session.tenants,
        tenantSelected: !!req.session.tenantId,
        tenantId:       req.session.tenantId   || null,
        tenantName:     req.session.tenantName || null,
      });
    } catch (err) {
      console.error('/api/auth/verify-totp error:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // POST /api/auth/confirm-totp  (first-time TOTP enrollment)
  router.post('/confirm-totp', totpLimiter, async (req, res) => {
    const { code } = req.body;
    if (!req.session.pendingUserId || !req.session.pendingTOTPSecret) {
      return res.status(401).json({ error: 'No pending setup' });
    }
    const secret = req.session.pendingTOTPSecret;
    const valid  = speakeasy.totp.verify({ secret, encoding: 'base32', token: code, window: 1 });
    if (!valid) return res.status(401).json({ error: 'Invalid code — try again' });

    try {
      const db = await getAuthPool();
      await db.request()
        .input('secret', sql.NVarChar, secret)
        .input('uid',    sql.Int,      req.session.pendingUserId)
        .query(`UPDATE Users SET TOTPSecret = @secret, TOTPEnabled = 1 WHERE UserID = @uid`);

      await _finalizeLogin(req, db);
      res.json({
        ok:             true,
        userId:         req.session.userId,
        fullName:       req.session.fullName,
        isAdmin:        req.session.isAdmin,
        mustChangePwd:  req.session.mustChangePwd,
        tenants:        req.session.tenants,
        tenantSelected: !!req.session.tenantId,
        tenantId:       req.session.tenantId   || null,
        tenantName:     req.session.tenantName || null,
      });
    } catch (err) {
      console.error('/api/auth/confirm-totp error:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // POST /api/auth/select-tenant  (tenant picker after login)
  // POST /api/auth/switch-tenant  (sidebar while already in app)
  function handleTenantSelection(req, res) {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    const { tenantId } = req.body;
    const allowed = (req.session.tenants || []).find(t => t.TenantID === tenantId);
    if (!allowed) return res.status(403).json({ error: 'Access denied to this client' });
    req.session.tenantId   = allowed.TenantID;
    req.session.tenantName = allowed.TenantName;
    res.json({ ok: true, tenantId: allowed.TenantID, tenantName: allowed.TenantName });
  }
  router.post('/select-tenant', handleTenantSelection);
  router.post('/switch-tenant', handleTenantSelection);

  // POST /api/auth/change-password
  router.post('/change-password', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword) {
      return res.status(400).json({ error: 'Current password is required' });
    }
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (newPassword === currentPassword) {
      return res.status(400).json({ error: 'New password must be different from the current password' });
    }
    try {
      const db     = await getAuthPool();
      const result = await db.request()
        .input('uid', sql.Int, req.session.userId)
        .query(`SELECT PasswordHash FROM Users WHERE UserID = @uid`);
      const hash  = result.recordset[0]?.PasswordHash;
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
  router.get('/me', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    res.json({
      userId:        req.session.userId,
      fullName:      req.session.fullName,
      isAdmin:       req.session.isAdmin,
      mustChangePwd: req.session.mustChangePwd,
      tenants:       req.session.tenants    || [],
      tenantId:      req.session.tenantId   || null,
      tenantName:    req.session.tenantName || null,
    });
  });

  // POST /api/auth/logout
  router.post('/logout', (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  return router;
};

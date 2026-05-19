const express   = require('express');
const bcrypt    = require('bcryptjs');
const speakeasy = require('speakeasy');
const QRCode    = require('qrcode');

module.exports = function authRoutes(getPool, sql) {
  const router = express.Router();

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

  // POST /api/auth/login
  router.post('/login', async (req, res) => {
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

  // POST /api/auth/verify-totp  (existing TOTP users)
  router.post('/verify-totp', async (req, res) => {
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
  router.post('/confirm-totp', async (req, res) => {
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

  // POST /api/auth/change-password
  router.post('/change-password', async (req, res) => {
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
  router.get('/me', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    res.json({
      userId:        req.session.userId,
      fullName:      req.session.fullName,
      isAdmin:       req.session.isAdmin,
      mustChangePwd: req.session.mustChangePwd,
    });
  });

  // POST /api/auth/logout
  router.post('/logout', (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  return router;
};

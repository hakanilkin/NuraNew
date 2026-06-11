const express = require('express');
const bcrypt  = require('bcryptjs');
const { encryptSecret } = require('../lib/secrets');

module.exports = function adminRoutes(getAuthPool, sql, requireAdmin, invalidateTenantPool) {
  const router = express.Router();
  router.use(requireAdmin);

  // =================================================================
  // USERS
  // =================================================================

  router.get('/users', async (req, res) => {
    try {
      const db = await getAuthPool();
      const result = await db.request().query(`
        SELECT UserID, Username, Email, FullName, IsAdmin, IsActive,
               TOTPEnabled, MustChangePwd, CreatedAt, LastLogin
        FROM Users ORDER BY Username
      `);
      res.json(result.recordset);
    } catch (err) {
      console.error(req.method + ' ' + req.originalUrl + ' error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/users', async (req, res) => {
    const { username, email, fullName, password, isAdmin } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    try {
      const hash = await bcrypt.hash(password, 10);
      const db   = await getAuthPool();
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
      console.error(req.method + ' ' + req.originalUrl + ' error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.put('/users/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    const { email, fullName, isAdmin, isActive, resetPassword, resetTotp } = req.body;
    // Don't let an admin lock themselves (and possibly everyone) out
    if (id === req.session.userId && (isAdmin === false || isActive === false)) {
      return res.status(400).json({ error: 'You cannot demote or deactivate your own account' });
    }
    if (resetPassword && resetPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    try {
      const db   = await getAuthPool();
      const r    = db.request().input('uid', sql.Int, id);
      const sets = [];
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
      console.error(req.method + ' ' + req.originalUrl + ' error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/users/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    if (id === req.session.userId) return res.status(400).json({ error: 'Cannot delete your own account' });
    try {
      const db = await getAuthPool();
      await db.request().input('uid', sql.Int, id).query(`DELETE FROM Users WHERE UserID = @uid`);
      res.json({ ok: true });
    } catch (err) {
      console.error(req.method + ' ' + req.originalUrl + ' error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/admin/users/:id/tenants
  router.get('/users/:id/tenants', async (req, res) => {
    try {
      const db = await getAuthPool();
      const result = await db.request()
        .input('uid', sql.Int, parseInt(req.params.id))
        .query(`SELECT t.TenantID, t.TenantName
                FROM Tenants t
                JOIN UserTenants ut ON t.TenantID = ut.TenantID
                WHERE ut.UserID = @uid AND t.IsActive = 1
                ORDER BY t.TenantName`);
      res.json(result.recordset);
    } catch (err) {
      console.error(req.method + ' ' + req.originalUrl + ' error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // PUT /api/admin/users/:id/tenants  — replace user's tenant list
  router.put('/users/:id/tenants', async (req, res) => {
    const uid       = parseInt(req.params.id);
    const tenantIds = req.body.tenantIds || [];   // array of TenantID ints
    const db = await getAuthPool().catch(() => null);
    if (!db) return res.status(500).json({ error: 'Internal server error' });
    const tx = new sql.Transaction(db);
    try {
      await tx.begin();
      await new sql.Request(tx).input('uid', sql.Int, uid)
        .query(`DELETE FROM UserTenants WHERE UserID = @uid`);
      for (const tid of tenantIds) {
        await new sql.Request(tx)
          .input('uid', sql.Int, uid)
          .input('tid', sql.Int, tid)
          .query(`INSERT INTO UserTenants (UserID, TenantID) VALUES (@uid, @tid)`);
      }
      await tx.commit();
      res.json({ ok: true });
    } catch (err) {
      try { await tx.rollback(); } catch (_) { /* not begun or already rolled back */ }
      console.error(req.method + ' ' + req.originalUrl + ' error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =================================================================
  // TENANTS
  // =================================================================

  router.get('/tenants', async (req, res) => {
    try {
      const db = await getAuthPool();
      const result = await db.request().query(`
        SELECT TenantID, TenantName, DBServer, DBName, DBUser, IsActive, CreatedAt
        FROM Tenants ORDER BY TenantName
      `);
      res.json(result.recordset);
    } catch (err) {
      console.error(req.method + ' ' + req.originalUrl + ' error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/tenants', async (req, res) => {
    const { tenantName, dbServer, dbName, dbUser, dbPassword } = req.body;
    if (!tenantName || !dbServer || !dbName || !dbUser || !dbPassword) {
      return res.status(400).json({ error: 'All fields required' });
    }
    try {
      const db = await getAuthPool();
      await db.request()
        .input('name',     sql.NVarChar, tenantName)
        .input('server',   sql.NVarChar, dbServer)
        .input('dbname',   sql.NVarChar, dbName)
        .input('user',     sql.NVarChar, dbUser)
        .input('password', sql.NVarChar, encryptSecret(dbPassword))
        .query(`INSERT INTO Tenants (TenantName, DBServer, DBName, DBUser, DBPassword)
                VALUES (@name, @server, @dbname, @user, @password)`);
      res.json({ ok: true });
    } catch (err) {
      console.error(req.method + ' ' + req.originalUrl + ' error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.put('/tenants/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    const { tenantName, dbServer, dbName, dbUser, dbPassword, isActive } = req.body;
    try {
      const db   = await getAuthPool();
      const r    = db.request().input('tid', sql.Int, id);
      const sets = [];
      if (tenantName !== undefined) { r.input('name',     sql.NVarChar, tenantName); sets.push('TenantName = @name'); }
      if (dbServer   !== undefined) { r.input('server',   sql.NVarChar, dbServer);   sets.push('DBServer = @server'); }
      if (dbName     !== undefined) { r.input('dbname',   sql.NVarChar, dbName);     sets.push('DBName = @dbname'); }
      if (dbUser     !== undefined) { r.input('user',     sql.NVarChar, dbUser);     sets.push('DBUser = @user'); }
      if (dbPassword !== undefined) { r.input('password', sql.NVarChar, encryptSecret(dbPassword)); sets.push('DBPassword = @password'); }
      if (isActive   !== undefined) { r.input('isActive', sql.Bit, isActive ? 1 : 0); sets.push('IsActive = @isActive'); }
      if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
      await r.query(`UPDATE Tenants SET ${sets.join(', ')} WHERE TenantID = @tid`);
      await invalidateTenantPool(id);  // drop any cached connection using old details
      res.json({ ok: true });
    } catch (err) {
      console.error(req.method + ' ' + req.originalUrl + ' error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/tenants/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
      const db = await getAuthPool();
      await db.request()
        .input('tid', sql.Int, id)
        .query(`DELETE FROM Tenants WHERE TenantID = @tid`);
      await invalidateTenantPool(id);
      res.json({ ok: true });
    } catch (err) {
      console.error(req.method + ' ' + req.originalUrl + ' error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
};

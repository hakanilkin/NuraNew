const express = require('express');
const bcrypt  = require('bcryptjs');

module.exports = function adminRoutes(getPool, sql, requireAdmin) {
  const router = express.Router();

  // All admin routes require admin role
  router.use(requireAdmin);

  // GET /api/admin/users
  router.get('/users', async (req, res) => {
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

  // POST /api/admin/users  — create user
  router.post('/users', async (req, res) => {
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

  // PUT /api/admin/users/:id  — update user
  router.put('/users/:id', async (req, res) => {
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
  router.delete('/users/:id', async (req, res) => {
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

  return router;
};

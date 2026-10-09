const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/validate');
const { backupToSupabase } = require('../utils/supabase');

const router = express.Router();

// Only admins can trigger a backup
router.post('/backup', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const users = await pool.query(
      'SELECT id, username, email, role, created_at, last_login FROM users'
    );

    const payload = {
      exported_at: new Date().toISOString(),
      exported_by: req.session.user.username,
      row_count: users.rowCount,
      rows: users.rows,
    };

    const data = await backupToSupabase(payload);
    res.json({ ok: true, backup: data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Backup failed.' });
  }
});

module.exports = router;
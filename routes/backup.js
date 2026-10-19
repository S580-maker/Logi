const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/validate');
const {
  getSystemConfig,
  saveSystemConfig,
  updateSystemConfigCache,
  validateConfig,
} = require('../utils/system-config');

const router = express.Router();
const requireAdmin = [requireAuth, requireRole('admin')];

async function readSystemState(db = pool) {
  const result = await db.query(
    `SELECT
       (SELECT COUNT(*)::integer FROM users WHERE deleted_at IS NULL) AS users,
       (SELECT COUNT(*)::integer FROM deleted_users) AS deleted_users,
       (SELECT COUNT(*)::integer FROM courses) AS courses,
       (SELECT COUNT(*)::integer FROM course_slides) AS slides,
       COALESCE(
         (SELECT jsonb_object_agg(role, role_count)
          FROM (
            SELECT role, COUNT(*)::integer AS role_count
            FROM users
            WHERE deleted_at IS NULL
            GROUP BY role
          ) role_summary),
         '{}'::jsonb
       ) AS roles`
  );
  const { roles, ...counts } = result.rows[0];
  return {
    ...Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, Number(value)])),
    roles,
  };
}

router.get('/system/status', ...requireAdmin, async (req, res) => {
  try {
    const [systemState, backups] = await Promise.all([
      readSystemState(),
      pool.query(
        `SELECT b.id, b.config, b.system_state, b.created_at, u.username AS created_by
         FROM system_backups b
         LEFT JOIN users u ON u.id = b.created_by
         ORDER BY b.created_at DESC
         LIMIT 50`
      ),
    ]);
    res.json({
      config: getSystemConfig(),
      state: systemState,
      backups: backups.rows,
    });
  } catch (error) {
    console.error('Could not load system status:', error.message);
    res.status(500).json({ error: 'Could not load system status.' });
  }
});

router.put('/system/config', ...requireAdmin, async (req, res) => {
  let config;
  try {
    config = validateConfig(req.body);
  } catch (error) {
    res.status(400).json({ error: error.message });
    return;
  }
  try {
    await saveSystemConfig(pool, config);
    res.json({ config });
  } catch (error) {
    console.error('Could not save system configuration:', error.message);
    res.status(500).json({ error: 'Could not save system configuration.' });
  }
});

router.post('/backup', ...requireAdmin, async (req, res) => {
  try {
    const systemState = await readSystemState();
    const result = await pool.query(
      `INSERT INTO system_backups (config, system_state, created_by)
       VALUES ($1::jsonb, $2::jsonb, $3)
       RETURNING id, config, system_state, created_at`,
      [JSON.stringify(getSystemConfig()), JSON.stringify(systemState), req.session.user.id]
    );
    res.status(201).json({ ok: true, backup: result.rows[0] });
  } catch (error) {
    console.error('Could not create configuration restore point:', error.message);
    res.status(500).json({ error: 'Could not create a restore point.' });
  }
});

router.post('/backup/:id/restore', ...requireAdmin, async (req, res) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.id)) {
    return res.status(400).json({ error: 'Invalid restore point ID.' });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const backup = await client.query(
      'SELECT config FROM system_backups WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    if (!backup.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Restore point not found.' });
    }

    const config = validateConfig(backup.rows[0].config);
    await client.query(
      `UPDATE system_settings
       SET config = $1::jsonb, updated_at = NOW()
       WHERE id = 1`,
      [JSON.stringify(config)]
    );
    await client.query('COMMIT');
    updateSystemConfigCache(config);
    res.json({
      ok: true,
      config,
      dataRestored: false,
      message: 'Configuration restored. User accounts, roles, courses, and records were not changed.',
    });
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('Could not roll back restore transaction:', rollbackError.message);
      }
    }
    console.error('Could not restore configuration:', error.message);
    res.status(500).json({ error: 'Could not restore this configuration.' });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;

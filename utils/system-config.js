const validator = require('validator');

const DEFAULT_CONFIG = Object.freeze({
  registration_enabled: true,
  session_ttl_minutes: 60,
  support_email: '',
});

let currentConfig = { ...DEFAULT_CONFIG };

function validateConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('System configuration must be an object.');
  }

  const { registration_enabled, session_ttl_minutes, support_email } = value;
  if (typeof registration_enabled !== 'boolean') {
    throw new Error('Registration setting must be true or false.');
  }
  if (!Number.isInteger(session_ttl_minutes) || session_ttl_minutes < 5 || session_ttl_minutes > 1440) {
    throw new Error('Session duration must be between 5 and 1,440 minutes.');
  }
  if (typeof support_email !== 'string' || support_email.length > 120) {
    throw new Error('Support email must be a string no longer than 120 characters.');
  }
  if (support_email.trim() && !validator.isEmail(support_email.trim())) {
    throw new Error('Enter a valid support email address.');
  }

  return { registration_enabled, session_ttl_minutes, support_email: support_email.trim() };
}

async function loadSystemConfig(pool) {
  const result = await pool.query('SELECT config FROM system_settings WHERE id = 1');
  if (!result.rows[0]) {
    throw new Error('System settings are missing. Run npm run db:init before starting the app.');
  }
  currentConfig = validateConfig(result.rows[0].config);
  return getSystemConfig();
}

function getSystemConfig() {
  return { ...currentConfig };
}

function updateSystemConfigCache(config) {
  currentConfig = validateConfig(config);
  return getSystemConfig();
}

function isRegistrationEnabled() {
  return currentConfig.registration_enabled;
}

async function saveSystemConfig(pool, config) {
  const validated = validateConfig(config);
  await pool.query(
    `INSERT INTO system_settings (id, config, updated_at)
     VALUES (1, $1::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE
     SET config = EXCLUDED.config, updated_at = NOW()`,
    [JSON.stringify(validated)]
  );
  currentConfig = validated;
  return getSystemConfig();
}

module.exports = {
  loadSystemConfig,
  getSystemConfig,
  updateSystemConfigCache,
  isRegistrationEnabled,
  saveSystemConfig,
  validateConfig,
};

const REQUIRED_PRODUCTION_VALUES = [
  'DATABASE_URL',
  'GMAIL_USER',
  'GMAIL_APP_PASSWORD',
  'PEPPER',
  'REDIS_URL',
  'SESSION_SECRET',
];

function validateProductionEnv(env = process.env) {
  if (env.NODE_ENV !== 'production') return;

  const missing = REQUIRED_PRODUCTION_VALUES.filter((name) => !env[name]?.trim());
  const weak = ['PEPPER', 'SESSION_SECRET'].filter(
    (name) => env[name] && Buffer.byteLength(env[name], 'utf8') < 32
  );
  const invalidUrls = [];

  if (env.DATABASE_URL) {
    try {
      const { protocol } = new URL(env.DATABASE_URL);
      if (!['postgres:', 'postgresql:'].includes(protocol)) invalidUrls.push('DATABASE_URL');
    } catch {
      invalidUrls.push('DATABASE_URL');
    }
  }
  if (env.REDIS_URL) {
    try {
      const { protocol, hostname } = new URL(env.REDIS_URL);
      if (!['redis:', 'rediss:'].includes(protocol) || !hostname) invalidUrls.push('REDIS_URL');
    } catch {
      invalidUrls.push('REDIS_URL');
    }
  }

  const problems = [
    ...(missing.length ? [`missing: ${missing.join(', ')}`] : []),
    ...(weak.length ? [`must be at least 32 bytes: ${weak.join(', ')}`] : []),
    ...(invalidUrls.length ? [`invalid URL: ${[...new Set(invalidUrls)].join(', ')}`] : []),
  ];

  if (problems.length) {
    throw new Error(`Production environment configuration is invalid (${problems.join('; ')}).`);
  }
}

module.exports = { validateProductionEnv };

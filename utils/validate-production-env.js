const REQUIRED_PRODUCTION_VALUES = [
  'GMAIL_USER',
  'GMAIL_APP_PASSWORD',
  'PEPPER',
  'REDIS_URL',
  'SESSION_SECRET',
  'SUPABASE_URL',
  'DATABASE_CA_CERT_BASE64',
];

function validateProductionEnv(env = process.env) {
  if (env.NODE_ENV !== 'production') return;

  const databaseUrl = env.DATABASE_URL || env.POSTGRES_PRISMA_URL || env.POSTGRES_URL;
  const supabaseServiceKey = env.SUPABASE_SERVICE_KEY ||
    env.SUPABASE_SERVICE_ROLE_KEY ||
    env.SUPABASE_SECRET_KEY;
  const missing = [
    ...REQUIRED_PRODUCTION_VALUES.filter((name) => !env[name]?.trim()),
    ...(!databaseUrl?.trim()
      ? ['DATABASE_URL, POSTGRES_PRISMA_URL, or POSTGRES_URL']
      : []),
    ...(!supabaseServiceKey?.trim()
      ? ['SUPABASE_SERVICE_KEY, SUPABASE_SERVICE_ROLE_KEY, or SUPABASE_SECRET_KEY']
      : []),
  ];
  const weak = ['PEPPER', 'SESSION_SECRET'].filter(
    (name) => env[name] && Buffer.byteLength(env[name], 'utf8') < 32
  );
  const invalidUrls = [];
  const invalidCertificates = [];

  if (databaseUrl) {
    try {
      const { protocol } = new URL(databaseUrl);
      if (!['postgres:', 'postgresql:'].includes(protocol)) invalidUrls.push('DATABASE_URL/POSTGRES_URL');
    } catch {
      invalidUrls.push('DATABASE_URL/POSTGRES_URL');
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
  if (env.DATABASE_CA_CERT_BASE64) {
    const caCert = Buffer.from(env.DATABASE_CA_CERT_BASE64, 'base64').toString('utf8');
    if (!caCert.startsWith('-----BEGIN CERTIFICATE-----') ||
        !caCert.includes('-----END CERTIFICATE-----')) {
      invalidCertificates.push('DATABASE_CA_CERT_BASE64');
    }
  }

  const problems = [
    ...(missing.length ? [`missing: ${missing.join(', ')}`] : []),
    ...(weak.length ? [`must be at least 32 bytes: ${weak.join(', ')}`] : []),
    ...(invalidUrls.length ? [`invalid URL: ${[...new Set(invalidUrls)].join(', ')}`] : []),
    ...(invalidCertificates.length ? [`invalid certificate: ${invalidCertificates.join(', ')}`] : []),
  ];

  if (problems.length) {
    throw new Error(`Production environment configuration is invalid (${problems.join('; ')}).`);
  }
}

module.exports = { validateProductionEnv };

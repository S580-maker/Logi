const { Pool } = require('pg');
require('dotenv').config();

const databaseCaCert = process.env.DATABASE_CA_CERT_BASE64
  ? Buffer.from(process.env.DATABASE_CA_CERT_BASE64, 'base64').toString('utf8')
  : undefined;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL,
  ssl: {
    rejectUnauthorized: true,
    ...(databaseCaCert ? { ca: databaseCaCert } : {}),
  },
});

module.exports = pool;
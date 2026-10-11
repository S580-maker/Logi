require('dotenv').config();

const fs = require('fs');
const path = require('path');
const pool = require('./pool');

async function main() {
  const connectionString = process.env.DATABASE_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL;
  if (!connectionString || connectionString.includes('[YOUR-PASSWORD]')) {
    throw new Error('Set a valid DATABASE_URL, POSTGRES_PRISMA_URL, or POSTGRES_URL before initializing the database.');
  }

  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  console.log('Database schema initialized successfully.');
}

main()
  .catch((error) => {
    console.error(`Database initialization failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

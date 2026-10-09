require('dotenv').config();

const fs = require('fs');
const path = require('path');
const pool = require('./pool');

async function main() {
  if (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes('[YOUR-PASSWORD]')) {
    throw new Error('Set a valid DATABASE_URL in .env before initializing the database.');
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

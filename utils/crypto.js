const bcrypt = require('bcrypt');
const crypto = require('crypto');
const speakeasy = require('speakeasy');
require('dotenv').config();

const SALT_ROUNDS = 12;

/**
 * Layer 1 of SQLi/DB protection: never send raw password to DB.
 * Layer 2: bcrypt with per-user salt.
 * Layer 3: prepend global pepper (kept outside DB in .env).
 */
async function hashPassword(plainPassword) {
  const salt = await bcrypt.genSalt(SALT_ROUNDS);
  const withPepper = plainPassword + process.env.PEPPER;
  const hash = await bcrypt.hash(withPepper, salt);
  return { hash, salt };
}

async function verifyPassword(plainPassword, storedHash) {
  const withPepper = plainPassword + process.env.PEPPER;
  return bcrypt.compare(withPepper, storedHash);
}

function generateTwoFASecret(username) {
  return speakeasy.generateSecret({
    name: `LogiAuth (${username})`,
    length: 20,
  });
}

function verifyTwoFAToken(secret, token) {
  return speakeasy.totp.verify({
    secret,
    encoding: 'base32',
    token,
    window: 1, // allow ±30s clock drift
  });
}

module.exports = {
  hashPassword,
  verifyPassword,
  generateTwoFASecret,
  verifyTwoFAToken,
};
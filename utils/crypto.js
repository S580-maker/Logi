const bcrypt = require('bcrypt');
const crypto = require('crypto');
const speakeasy = require('speakeasy');
require('dotenv').config();

const SALT_ROUNDS = 12;
const HASH_VERSION = 'bcrypt-hmac-sha256$';

function pepperedPassword(plainPassword) {
  if (!process.env.PEPPER) {
    throw new Error('PEPPER must be configured before hashing or verifying passwords.');
  }
  return crypto
    .createHmac('sha256', process.env.PEPPER)
    .update(`logiauth:password:v1:${plainPassword}`)
    .digest('hex');
}

/**
 * HMAC-SHA-256 applies the server-side pepper before bcrypt; bcrypt supplies a
 * unique per-password salt and stores that salt in the encoded hash.
 */
async function hashPassword(plainPassword) {
  const salt = await bcrypt.genSalt(SALT_ROUNDS);
  const hash = HASH_VERSION + await bcrypt.hash(pepperedPassword(plainPassword), salt);
  return { hash, salt };
}

async function verifyPassword(plainPassword, storedHash) {
  const withPepper = pepperedPassword(plainPassword);
  if (storedHash.startsWith(HASH_VERSION)) {
    return bcrypt.compare(withPepper, storedHash.slice(HASH_VERSION.length));
  }
  // Existing accounts used bcrypt(password + pepper); keep them valid until
  // they change their password and are re-hashed with the versioned format.
  return bcrypt.compare(plainPassword + process.env.PEPPER, storedHash);
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
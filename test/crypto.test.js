const assert = require('node:assert/strict');
const test = require('node:test');
const bcrypt = require('bcrypt');
const { hashPassword, verifyPassword } = require('../utils/crypto');

test('password hashes use unique salts and the configured pepper', async () => {
  const previousPepper = process.env.PEPPER;
  process.env.PEPPER = 'test-pepper-secret-that-is-long-enough';
  try {
    const first = await hashPassword('correct horse battery staple');
    const second = await hashPassword('correct horse battery staple');

    assert.match(first.hash, /^bcrypt-hmac-sha256\$/);
    assert.notEqual(first.salt, second.salt);
    assert.notEqual(first.hash, second.hash);
    assert.equal(await verifyPassword('correct horse battery staple', first.hash), true);
    assert.equal(await verifyPassword('incorrect password', first.hash), false);
    const longPassword = `${'a'.repeat(90)}first`;
    const longHash = await hashPassword(longPassword);
    assert.equal(await verifyPassword(`${'a'.repeat(90)}second`, longHash.hash), false);

    const legacyHash = await bcrypt.hash(
      `legacy password${process.env.PEPPER}`,
      await bcrypt.genSalt(12)
    );
    assert.equal(await verifyPassword('legacy password', legacyHash), true);

    delete process.env.PEPPER;
    await assert.rejects(hashPassword('correct horse battery staple'), /PEPPER must be configured/);
    await assert.rejects(
      verifyPassword('correct horse battery staple', first.hash),
      /PEPPER must be configured/
    );
  } finally {
    if (previousPepper === undefined) delete process.env.PEPPER;
    else process.env.PEPPER = previousPepper;
  }
});

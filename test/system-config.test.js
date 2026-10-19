const assert = require('node:assert/strict');
const test = require('node:test');
const { validateConfig } = require('../utils/system-config');

test('system configuration accepts only bounded, supported settings', () => {
  assert.deepEqual(
    validateConfig({
      registration_enabled: false,
      session_ttl_minutes: 30,
      support_email: 'support@example.com',
    }),
    {
      registration_enabled: false,
      session_ttl_minutes: 30,
      support_email: 'support@example.com',
    }
  );
  assert.throws(() => validateConfig({
    registration_enabled: 'false',
    session_ttl_minutes: 30,
    support_email: '',
  }), /must be true or false/);
  assert.throws(() => validateConfig({
    registration_enabled: true,
    session_ttl_minutes: 4,
    support_email: '',
  }), /between 5 and 1,440/);
  assert.throws(() => validateConfig({
    registration_enabled: true,
    session_ttl_minutes: 60,
    support_email: 'not-an-email',
  }), /valid support email/);
});

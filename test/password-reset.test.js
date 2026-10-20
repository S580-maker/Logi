const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

const originalEnv = process.env.SESSION_SECRET;
process.env.SESSION_SECRET = 'password-reset-test-secret';

const loadedModules = new Map();
const emailedCodes = [];
const sessions = new Map();
const resetQueries = [];
let allowPasswordReset = false;
const user = { id: 42, username: 'reset_test', email: 'reset@example.com' };

function stubModule(relativePath, exports) {
  const id = require.resolve(relativePath);
  loadedModules.set(id, require.cache[id]);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

stubModule('../db/pool', {
  query: async (query, values) => ({
    rows: query.includes('FROM users WHERE email') && values[0] === user.email
      ? [{ ...user }]
      : [],
  }),
  connect: async () => {
    if (!allowPasswordReset) {
      throw new Error('A reset must not reach the database before OTP verification.');
    }
    return {
      query: async (query) => {
        resetQueries.push(query);
        if (query.includes('SELECT id FROM users')) {
          return { rows: [{ id: user.id }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      },
      release: () => {},
    };
  },
});
stubModule('../utils/email', {
  sendLoginCode: async () => {},
  sendRegistrationCode: async () => {},
  sendPasswordResetCode: async (email, username, code) => {
    emailedCodes.push({ email, username, code });
  },
  sendPasswordResetNotification: async () => {},
  sendPasskeyAddedNotification: async () => {},
  sendRecoveryCodesChangedNotification: async () => {},
  sendWelcomeEmail: async () => {},
});
stubModule('../utils/crypto', {
  hashPassword: async () => ({ hash: 'hash', salt: 'salt' }),
  verifyPassword: async () => true,
  generateTwoFASecret: () => 'secret',
});
stubModule('../middleware/validate', {
  validateLoginInput: (req, res, next) => next(),
  validateRegistrationInput: (req, res, next) => next(),
  requireAuth: (req, res, next) => next(),
  requireRole: () => (req, res, next) => next(),
});
stubModule('../middleware/rateLimit', {
  loginLimiter: [],
  registrationLimiter: [],
  passwordResetLimiter: [],
  passwordResetStartLimiter: [],
  passwordResetVerificationLimiter: [],
  emailCodeResendLimiter: [],
  passkeyVerificationLimiter: [],
});
stubModule('../utils/system-config', { isRegistrationEnabled: () => true });

const authRoutes = require('../routes/auth');
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  const sessionId = req.get('x-test-session') || 'default';
  if (!sessions.has(sessionId)) sessions.set(sessionId, {});
  req.session = sessions.get(sessionId);
  next();
});
app.use('/api/auth', authRoutes);

let server;
let baseUrl;

test.before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/auth`;
});

test.after(async () => {
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  for (const [id, module] of loadedModules) {
    if (module) require.cache[id] = module;
    else delete require.cache[id];
  }
  if (originalEnv === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = originalEnv;
});

async function post(path, body, sessionId) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-test-session': sessionId,
    },
    body: JSON.stringify(body),
  });
}

test('password reset requires server-verified email code before reset', async () => {
  const sessionId = 'reset-gate';
  emailedCodes.length = 0;

  const start = await post('/forgot-password', { email: user.email }, sessionId);
  assert.equal(start.status, 200);
  assert.match((await start.json()).message, /If an account uses that email/);
  assert.equal(emailedCodes.length, 1);

  const reset = await post('/reset-password', {
    token: emailedCodes[0].code,
    password: 'new-password',
  }, sessionId);
  assert.equal(reset.status, 403);

  const verified = await post('/verify-password-reset-code', {
    token: emailedCodes[0].code,
  }, sessionId);
  assert.equal(verified.status, 200);
  assert.deepEqual(await verified.json(), { verified: true });
  assert.equal(sessions.get(sessionId).pendingPasswordReset.otpVerified, true);
});

test('verified email code resets password without a recovery code', async () => {
  const sessionId = 'reset-email-only';
  emailedCodes.length = 0;
  resetQueries.length = 0;
  await post('/forgot-password', { email: user.email }, sessionId);
  const token = emailedCodes[0].code;

  const verified = await post('/verify-password-reset-code', { token }, sessionId);
  assert.equal(verified.status, 200);

  allowPasswordReset = true;
  try {
    const reset = await post('/reset-password', {
      token,
      password: 'new-password',
    }, sessionId);
    assert.equal(reset.status, 200);
    const result = await reset.json();
    assert.match(result.message, /Your password has been reset/);
    assert.ok(resetQueries.some((query) => query.includes('DELETE FROM user_recovery_codes')));
    assert.ok(resetQueries.some((query) => query.includes('DELETE FROM passkey_credentials')));
    assert.equal(sessions.get(sessionId).pendingPasswordReset, undefined);
  } finally {
    allowPasswordReset = false;
  }
});

test('invalid OTP attempts are counted and capped, and valid OTP verifies', async () => {
  const sessionId = 'reset-otp';
  emailedCodes.length = 0;
  await post('/forgot-password', { email: user.email }, sessionId);
  const correctCode = emailedCodes[0].code;
  const wrongCode = `${correctCode[0] === '0' ? '1' : '0'}${correctCode.slice(1)}`;

  const wrong = await post('/verify-password-reset-code', { token: wrongCode }, sessionId);
  assert.equal(wrong.status, 401);
  assert.equal(sessions.get(sessionId).pendingPasswordReset.otpVerified, false);

  const verified = await post('/verify-password-reset-code', { token: correctCode }, sessionId);
  assert.equal(verified.status, 200);
  assert.equal(sessions.get(sessionId).pendingPasswordReset.otpVerified, true);
});

test('reset submission rechecks its OTP and returns to code verification on mismatch', async () => {
  const sessionId = 'reset-final-code-check';
  emailedCodes.length = 0;
  await post('/forgot-password', { email: user.email }, sessionId);
  const correctCode = emailedCodes[0].code;
  const verified = await post('/verify-password-reset-code', { token: correctCode }, sessionId);
  assert.equal(verified.status, 200);

  const wrongCode = `${correctCode[0] === '0' ? '1' : '0'}${correctCode.slice(1)}`;
  const reset = await post('/reset-password', {
    token: wrongCode,
    password: 'new-password',
  }, sessionId);
  assert.equal(reset.status, 401);
  assert.equal((await reset.json()).code, 'invalid_code');
  assert.equal(sessions.get(sessionId).pendingPasswordReset.otpVerified, false);
});

test('reaching the OTP attempt limit permits a resend but blocks further checks', async () => {
  const sessionId = 'reset-attempt-limit';
  emailedCodes.length = 0;
  await post('/forgot-password', { email: user.email }, sessionId);
  const pending = sessions.get(sessionId).pendingPasswordReset;
  const originalCode = emailedCodes[0].code;
  pending.otpAttempts = 4;
  pending.otpLastSentAt = 0;
  const wrongCode = `${originalCode[0] === '0' ? '1' : '0'}${originalCode.slice(1)}`;

  const limited = await post('/verify-password-reset-code', { token: wrongCode }, sessionId);
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).code, 'attempt_limit');

  const stillLimited = await post('/verify-password-reset-code', { token: originalCode }, sessionId);
  assert.equal(stillLimited.status, 429);

  const resent = await post('/resend-code', {}, sessionId);
  assert.equal(resent.status, 200);
  const resentPending = sessions.get(sessionId).pendingPasswordReset;
  assert.equal(resentPending.otpAttempts, 0);
  assert.equal(resentPending.otpVerified, false);
  assert.notEqual(emailedCodes[1].code, originalCode);

  const verified = await post('/verify-password-reset-code', {
    token: emailedCodes[1].code,
  }, sessionId);
  assert.equal(verified.status, 200);
});

test('expired codes can be resent and resend invalidates prior verification', async () => {
  const sessionId = 'reset-resend';
  emailedCodes.length = 0;
  await post('/forgot-password', { email: user.email }, sessionId);
  const pending = sessions.get(sessionId).pendingPasswordReset;
  pending.otpExpiresAt = Date.now() - 1;
  pending.otpLastSentAt = 0;
  pending.otpVerified = true;

  const expired = await post('/verify-password-reset-code', {
    token: emailedCodes[0].code,
  }, sessionId);
  assert.equal(expired.status, 401);
  assert.equal((await expired.json()).code, 'expired');
  assert.ok(sessions.get(sessionId).pendingPasswordReset);

  const resent = await post('/resend-code', {}, sessionId);
  assert.equal(resent.status, 200);
  assert.equal(sessions.get(sessionId).pendingPasswordReset.otpVerified, false);
  assert.equal(sessions.get(sessionId).pendingPasswordReset.otpAttempts, 0);
  assert.notEqual(emailedCodes[1].code, emailedCodes[0].code);
});

test('dummy reset requests never verify or send an email during resend', async () => {
  const sessionId = 'reset-dummy';
  emailedCodes.length = 0;
  await post('/forgot-password', { email: 'missing@example.com' }, sessionId);
  const pending = sessions.get(sessionId).pendingPasswordReset;
  pending.otpLastSentAt = 0;

  const resent = await post('/resend-code', {}, sessionId);
  assert.equal(resent.status, 200);
  assert.equal(emailedCodes.length, 0);
  assert.equal(sessions.get(sessionId).pendingPasswordReset.isDummy, true);

  const verified = await post('/verify-password-reset-code', {
    token: '123456',
  }, sessionId);
  assert.equal(verified.status, 401);
  assert.equal(sessions.get(sessionId).pendingPasswordReset.otpVerified, false);
});

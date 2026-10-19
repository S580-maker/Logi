const express = require('express');
const crypto = require('crypto');
const dns = require('node:dns').promises;
const validator = require('validator');
const pool = require('../db/pool');
const { isRegistrationEnabled } = require('../utils/system-config');
const {
  sendLoginCode,
  sendRegistrationCode,
  sendPasswordResetCode,
  sendPasswordResetNotification,
  sendPasskeyAddedNotification,
  sendRecoveryCodesChangedNotification,
  sendWelcomeEmail,
} = require('../utils/email');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const {
  hashPassword,
  verifyPassword,
  generateTwoFASecret,
} = require('../utils/crypto');
const {
  validateLoginInput,
  validateRegistrationInput,
  requireAuth,
  requireRole,
} = require('../middleware/validate');
const {
  loginLimiter,
  registrationLimiter,
  passwordResetLimiter,
  passkeyVerificationLimiter,
} = require('../middleware/rateLimit');

const router = express.Router();
const USER_ROLES = [
  'admin',
  'manager',
  'editor',
  'instructor',
  'student',
  'viewer',
  'auditor',
  'support',
  'content_manager',
];
const OTP_TTL_MS = 5 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 10 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;

function createOtp() {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

function hashOtp(code) {
  return crypto
    .createHmac('sha256', process.env.SESSION_SECRET)
    .update(code)
    .digest('hex');
}

function maskEmail(email) {
  const [name, domain] = email.split('@');
  return `${name.slice(0, 1)}${'*'.repeat(Math.max(name.length - 1, 2))}@${domain}`;
}

function getPasskeyContext(req) {
  const origin = req.get('origin') || `${req.protocol}://${req.get('host')}`;
  const parsedOrigin = new URL(origin);
  if (!['https:', 'http:'].includes(parsedOrigin.protocol) ||
      (process.env.NODE_ENV === 'production' && parsedOrigin.protocol !== 'https:')) {
    throw new Error('Passkeys require a secure website connection.');
  }
  const rpID = process.env.PASSKEY_RP_ID?.trim().toLowerCase() || parsedOrigin.hostname;
  if (parsedOrigin.hostname !== rpID && !parsedOrigin.hostname.endsWith(`.${rpID}`)) {
    throw new Error('The passkey domain does not match this website.');
  }
  return { origin: parsedOrigin.origin, rpID };
}

async function createPasskeyEnrollmentOptions(user, req) {
  const safeUser = {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    authVersion: Number(user.authVersion ?? 0),
  };
  const { origin, rpID } = getPasskeyContext(req);
  const existing = await pool.query(
    'SELECT credential_id, transports FROM passkey_credentials WHERE user_id = $1',
    [user.id]
  );
  const options = await generateRegistrationOptions({
    rpName: 'LogiAuth',
    rpID,
    userID: Buffer.from(String(safeUser.id)),
    userName: safeUser.username,
    userDisplayName: safeUser.username,
    attestationType: 'none',
    excludeCredentials: existing.rows.map((credential) => ({
      id: credential.credential_id,
      transports: credential.transports,
    })),
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'required',
    },
  });
  return {
    options,
    user: safeUser,
    challenge: options.challenge,
    origin,
    rpID,
    expiresAt: Date.now() + OTP_TTL_MS,
  };
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function otpMatches(expectedHash, code) {
  const actual = Buffer.from(hashOtp(code), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function normalizeRecoveryCode(code) {
  return typeof code === 'string' ? code.replace(/[\s-]/g, '').toUpperCase() : '';
}

function hashRecoveryCode(code) {
  return crypto
    .createHmac('sha256', process.env.PEPPER || process.env.SESSION_SECRET)
    .update(`logiauth-recovery:${normalizeRecoveryCode(code)}`)
    .digest('hex');
}

function hashesMatch(actualHash, expectedHash) {
  const actual = Buffer.from(actualHash, 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function createRecoveryCodes() {
  return Array.from({ length: 10 }, () => {
    const value = crypto.randomBytes(10).toString('hex').toUpperCase();
    return value.match(/.{1,4}/g).join('-');
  });
}

async function sendSecurityNotification(sendNotification, email, username, eventName) {
  try {
    await sendNotification(email, username);
    return true;
  } catch (error) {
    console.error(`${eventName} security email failed:`, error.code || error.message);
    return false;
  }
}

async function emailDomainCanReceiveMail(domain) {
  try {
    const mxRecords = await dns.resolveMx(domain);
    if (mxRecords.length) return true;
  } catch (error) {
    if (error.code === 'ENOTFOUND') return false;
    if (error.code !== 'ENODATA') throw error;
  }

  const addressResults = await Promise.allSettled([
    dns.resolve4(domain),
    dns.resolve6(domain),
  ]);
  if (addressResults.some((result) => result.status === 'fulfilled' && result.value.length)) {
    return true;
  }

  const errors = addressResults
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason);
  if (errors.length && errors.every((error) => ['ENODATA', 'ENOTFOUND'].includes(error.code))) {
    return false;
  }
  throw errors.find((error) => !['ENODATA', 'ENOTFOUND'].includes(error.code)) ||
    new Error('Could not confirm the email domain.');
}

/* ---------- Account registration ---------- */
router.post('/register', registrationLimiter, validateRegistrationInput, async (req, res) => {
  if (!isRegistrationEnabled()) {
    return res.status(403).json({ error: 'New account registration is currently disabled.' });
  }
  const username = req.body.username.trim();
  const email = req.body.email.trim().toLowerCase();
  const { password } = req.body;

  try {
    let domainCanReceiveMail;
    try {
      domainCanReceiveMail = await emailDomainCanReceiveMail(email.slice(email.lastIndexOf('@') + 1));
    } catch (error) {
      console.error('Email domain lookup failed:', error.code || error.message);
      return res.status(503).json({
        error: 'Could not check whether this email domain can receive mail. Please try again shortly.',
      });
    }
    if (!domainCanReceiveMail) {
      return res.status(400).json({
        error: 'This email domain does not appear to receive email. Check the address for a typo and try again.',
      });
    }

    const existing = await pool.query(
      'SELECT 1 FROM users WHERE username = $1 OR email = $2 LIMIT 1',
      [username, email]
    );
    if (existing.rowCount) {
      return res.status(409).json({ error: 'That username or email is already registered.' });
    }

    const { hash, salt } = await hashPassword(password);
    const code = createOtp();
    try {
      await sendRegistrationCode(email, username, code);
    } catch (mailError) {
      console.error('Registration verification email failed:', mailError.code || mailError.message);
      return res.status(503).json({
        error: mailError.code === 'ERECIPIENTREJECTED'
          ? 'Gmail rejected that recipient address. Check for typos or try another email address.'
          : 'Could not send an email verification code. Check the email server configuration and try again.',
      });
    }

    req.session.pendingRegistration = {
      username,
      email,
      passwordHash: hash,
      salt,
      otpHash: hashOtp(code),
      otpExpiresAt: Date.now() + OTP_TTL_MS,
      otpAttempts: 0,
      otpLastSentAt: Date.now(),
    };
    return res.json({
      step: 'email-verification',
      email: maskEmail(email),
      deliveryAddress: email,
      expiresIn: OTP_TTL_MS / 1000,
      delivery: 'accepted',
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'That username or email is already registered.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Could not create account.' });
  }
});

router.post('/verify-registration', async (req, res) => {
  const { token } = req.body || {};
  const pending = req.session.pendingRegistration;

  if (!pending) {
    return res.status(400).json({ error: 'No registration is waiting for email verification.' });
  }
  if (!token || !/^\d{6}$/.test(token)) {
    return res.status(400).json({ error: 'Invalid code format.' });
  }
  if (Date.now() > pending.otpExpiresAt) {
    delete req.session.pendingRegistration;
    return res.status(401).json({ error: 'Code expired. Start account creation again to receive a new code.' });
  }
  if (pending.otpAttempts >= OTP_MAX_ATTEMPTS) {
    delete req.session.pendingRegistration;
    return res.status(429).json({ error: 'Too many incorrect codes. Start account creation again to receive a new code.' });
  }
  if (!otpMatches(pending.otpHash, token)) {
    pending.otpAttempts += 1;
    return res.status(401).json({ error: 'Invalid verification code.' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO users (username, email, password_hash, salt, role, email_verified_at)
       VALUES ($1, $2, $3, $4, 'student', NOW())
       RETURNING id, username, email, role`,
      [pending.username, pending.email, pending.passwordHash, pending.salt]
    );
    const user = result.rows[0];
    delete req.session.pendingRegistration;
    const enrollment = await createPasskeyEnrollmentOptions(user, req);
    req.session.pendingPasskeyEnrollment = enrollment;

    return res.status(201).json({
      step: 'passkey-enrollment',
      options: enrollment.options,
    });
  } catch (err) {
    if (err.code === '23505') {
      delete req.session.pendingRegistration;
      return res.status(409).json({
        error: 'That username or email was registered while you were verifying. Try signing in.',
      });
    }
    console.error('Could not finish verified registration:', err.message);
    return res.status(500).json({ error: 'Could not create the account. Please try again.' });
  }
});

/* ---------- Password + passkey sign-in ---------- */
router.post('/login', loginLimiter, validateLoginInput, async (req, res) => {
  const { username, password } = req.body;

  try {
    const result = await pool.query(
      `SELECT id, username, email, password_hash, role, passkey_email_grace_until, auth_version
       FROM users
       WHERE username = $1 AND deleted_at IS NULL`,
      [username]
    );
    const user = result.rows[0];

    if (!user) {
      await pool.query(
        'INSERT INTO login_attempts (username, ip_address, success) VALUES ($1, $2, FALSE)',
        [username, req.ip]
      );
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      await pool.query(
        'INSERT INTO login_attempts (username, ip_address, success) VALUES ($1, $2, FALSE)',
        [username, req.ip]
      );
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const account = {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      authVersion: Number(user.auth_version),
    };
    delete req.session.pendingRegistration;
    delete req.session.pendingPasswordReset;
    delete req.session.pendingPasskeyEmailVerification;

    if (req.cookies?.['logi.trusted']) {
      res.clearCookie('logi.trusted', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/',
      });
    }

    const credentials = await pool.query(
      'SELECT credential_id, public_key, counter, transports FROM passkey_credentials WHERE user_id = $1',
      [user.id]
    );

    if (!credentials.rowCount) {
      const enrollment = await createPasskeyEnrollmentOptions(account, req);
      req.session.pendingPasskeyEnrollment = enrollment;
      return res.json({ step: 'passkey-enrollment', options: enrollment.options });
    }

    if (user.passkey_email_grace_until && new Date(user.passkey_email_grace_until).getTime() > Date.now()) {
      const code = createOtp();
      try {
        await sendLoginCode(user.email, user.username, code);
      } catch (mailError) {
        console.error('Login verification email failed:', mailError.code || mailError.message);
        return res.status(503).json({
          error: 'Could not send a sign-in code. Check your email configuration and try again.',
        });
      }
      req.session.pendingPasskeyEmailVerification = {
        user: account,
        otpHash: hashOtp(code),
        otpExpiresAt: Date.now() + OTP_TTL_MS,
        otpAttempts: 0,
        otpLastSentAt: Date.now(),
      };
      return res.json({
        step: 'passkey-email-verification',
        email: maskEmail(user.email),
      });
    }

    const { origin, rpID } = getPasskeyContext(req);
    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials: credentials.rows.map((credential) => ({
        id: credential.credential_id,
        transports: credential.transports,
      })),
      userVerification: 'required',
    });
    req.session.pendingPasskeyAuthentication = {
      user: account,
      challenge: options.challenge,
      origin,
      rpID,
      expiresAt: Date.now() + OTP_TTL_MS,
    };
    return res.json({ step: 'passkey-authentication', options });
  } catch (err) {
    console.error('Could not start passkey sign-in:', err.code || err.message);
    res.status(500).json({ error: 'Could not start sign-in. Please try again.' });
  }
});

router.post('/verify-login-email-code', passkeyVerificationLimiter, async (req, res) => {
  const pending = req.session.pendingPasskeyEmailVerification;
  const { token } = req.body || {};
  if (!pending) return res.status(400).json({ error: 'No sign-in code is waiting to be verified.' });
  if (Date.now() > pending.otpExpiresAt) {
    delete req.session.pendingPasskeyEmailVerification;
    return res.status(401).json({ error: 'That sign-in code has expired. Enter your password to request a new one.' });
  }
  if (pending.otpAttempts >= OTP_MAX_ATTEMPTS) {
    delete req.session.pendingPasskeyEmailVerification;
    return res.status(429).json({ error: 'Too many incorrect codes. Enter your password to request a new one.' });
  }
  if (typeof token !== 'string' || !/^\d{6}$/.test(token) || !otpMatches(pending.otpHash, token)) {
    pending.otpAttempts += 1;
    return res.status(401).json({ error: 'Invalid sign-in code.' });
  }

  try {
    const activeWindow = await pool.query(
      `SELECT auth_version
       FROM users
       WHERE id = $1 AND passkey_email_grace_until > NOW()
         AND EXISTS (
           SELECT 1 FROM passkey_credentials WHERE user_id = users.id
         )`,
      [pending.user.id]
    );
    if (!activeWindow.rowCount) {
      delete req.session.pendingPasskeyEmailVerification;
      return res.status(401).json({
        error: 'The 7-day email sign-in period has ended. Sign in again to verify your passkey.',
      });
    }
    await pool.query(
      'UPDATE users SET last_login = NOW(), last_activity_at = NOW() WHERE id = $1',
      [pending.user.id]
    );
    await pool.query(
      'INSERT INTO login_attempts (username, ip_address, success) VALUES ($1, $2, TRUE)',
      [pending.user.username, req.ip]
    );
    await regenerateSession(req);
    req.session.user = {
      id: pending.user.id,
      username: pending.user.username,
      role: pending.user.role,
    };
    req.session.authVersion = Number(activeWindow.rows[0].auth_version);
    delete req.session.pendingPasskeyEmailVerification;
    return res.json({ user: req.session.user });
  } catch (error) {
    console.error('Email-code sign-in failed:', error.message);
    return res.status(500).json({ error: 'Could not finish sign-in. Please try again.' });
  }
});

/* ---------- Passkey enrollment and second-factor sign-in ---------- */
router.post('/passkey/add/options', requireAuth, passkeyVerificationLimiter, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, email, role, password_hash FROM users WHERE id = $1',
      [req.session.user.id]
    );
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Sign in again before adding a passkey.' });
    if (typeof req.body?.password !== 'string' ||
        !(await verifyPassword(req.body.password, user.password_hash))) {
      return res.status(401).json({ error: 'The password is incorrect. No passkey was added.' });
    }
    const enrollment = await createPasskeyEnrollmentOptions(user, req);
    delete req.session.pendingPasskeyEnrollment;
    req.session.pendingPasskeyAddition = enrollment;
    return res.json({ options: enrollment.options });
  } catch (error) {
    console.error('Could not start passkey addition:', error.message);
    return res.status(500).json({ error: 'Could not start adding a passkey. Please try again.' });
  }
});

router.post('/passkey/register/verify', passkeyVerificationLimiter, async (req, res) => {
  const isAddition = Boolean(req.session.pendingPasskeyAddition);
  const pending = req.session.pendingPasskeyAddition || req.session.pendingPasskeyEnrollment;
  const response = req.body?.credential;
  if (!pending) return res.status(400).json({ error: 'No passkey setup is waiting.' });
  if (isAddition && req.session.user?.id !== pending.user.id) {
    delete req.session.pendingPasskeyAddition;
    return res.status(401).json({ error: 'Sign in again before adding a passkey.' });
  }
  if (Date.now() > pending.expiresAt) {
    delete req.session.pendingPasskeyEnrollment;
    delete req.session.pendingPasskeyAddition;
    return res.status(401).json({ error: 'Passkey setup expired. Please sign in again.' });
  }
  if (!response || typeof response.id !== 'string') {
    return res.status(400).json({ error: 'The passkey response is incomplete. Please try again.' });
  }
  if (isAddition) delete req.session.pendingPasskeyAddition;
  else delete req.session.pendingPasskeyEnrollment;

  try {
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: pending.origin,
      expectedRPID: pending.rpID,
      requireUserVerification: true,
    });
    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'The passkey could not be verified. Please try again.' });
    }

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    await pool.query(
      `INSERT INTO passkey_credentials
         (user_id, credential_id, public_key, counter, transports, device_type, backed_up)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        pending.user.id,
        credential.id,
        Buffer.from(credential.publicKey),
        credential.counter,
        credential.transports || response.response.transports || [],
        credentialDeviceType,
        credentialBackedUp,
      ]
    );

    if (isAddition) {
      await pool.query(
        'INSERT INTO login_attempts (username, ip_address, success) VALUES ($1, $2, TRUE)',
        [pending.user.username, req.ip]
      );
    } else {
      await regenerateSession(req);
      req.session.user = {
        id: pending.user.id,
        username: pending.user.username,
        role: pending.user.role,
      };
      req.session.authVersion = Number(pending.user.authVersion ?? 0);
      delete req.session.pendingRegistration;
      await pool.query(
        `UPDATE users
         SET last_login = NOW(), last_activity_at = NOW(),
             passkey_email_grace_until = NOW() + INTERVAL '7 days'
         WHERE id = $1`,
        [pending.user.id]
      );
      await pool.query(
        'INSERT INTO login_attempts (username, ip_address, success) VALUES ($1, $2, TRUE)',
        [pending.user.username, req.ip]
      );
    }

    const securityNotificationSent = pending.user.email
      ? await sendSecurityNotification(
        sendPasskeyAddedNotification,
        pending.user.email,
        pending.user.username,
        'Passkey-added'
      )
      : false;

    let welcomeEmailSent = true;
    if (!isAddition && pending.user.email) {
      try {
        await sendWelcomeEmail(pending.user.email, pending.user.username);
      } catch (mailError) {
        welcomeEmailSent = false;
        console.error('Welcome email failed:', mailError.code || mailError.message);
      }
    }
    return res.json({
      user: req.session.user,
      welcomeEmailSent,
      securityNotificationSent,
      passkeyAdded: isAddition,
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'This passkey is already linked to an account.' });
    }
    console.error('Passkey registration verification failed:', err.message);
    res.status(err.code ? 500 : 400).json({
      error: err.code
        ? 'Could not save your passkey. Please try again shortly.'
        : 'Could not verify that passkey. Please try again.',
    });
  }
});

router.post('/passkey/authenticate/verify', passkeyVerificationLimiter, async (req, res) => {
  const pending = req.session.pendingPasskeyAuthentication;
  const response = req.body?.credential;
  if (!pending) return res.status(400).json({ error: 'Your sign-in has expired. Please try again.' });
  if (Date.now() > pending.expiresAt) {
    delete req.session.pendingPasskeyAuthentication;
    return res.status(401).json({ error: 'Your sign-in has expired. Please enter your password again.' });
  }
  if (!response || typeof response.id !== 'string') {
    return res.status(400).json({ error: 'The passkey response is incomplete. Please try again.' });
  }
  delete req.session.pendingPasskeyAuthentication;

  try {
    const result = await pool.query(
      `SELECT id, credential_id, public_key, counter, transports
       FROM passkey_credentials
       WHERE user_id = $1 AND credential_id = $2`,
      [pending.user.id, response.id]
    );
    const stored = result.rows[0];
    if (!stored) return res.status(401).json({ error: 'That passkey is not linked to this account.' });

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: pending.origin,
      expectedRPID: pending.rpID,
      requireUserVerification: true,
      credential: {
        id: stored.credential_id,
        publicKey: new Uint8Array(stored.public_key),
        counter: Number(stored.counter),
        transports: stored.transports,
      },
    });
    if (!verification.verified) {
      return res.status(401).json({ error: 'Passkey verification failed. Please try again.' });
    }

    await pool.query(
      `UPDATE passkey_credentials
       SET counter = $1, backed_up = $2, device_type = $3
       WHERE id = $4 AND user_id = $5`,
      [
        verification.authenticationInfo.newCounter,
        verification.authenticationInfo.credentialBackedUp,
        verification.authenticationInfo.credentialDeviceType,
        stored.id,
        pending.user.id,
      ]
    );
    await pool.query(
      `UPDATE users
       SET last_login = NOW(), last_activity_at = NOW(),
           passkey_email_grace_until = NOW() + INTERVAL '7 days'
       WHERE id = $1`,
      [pending.user.id]
    );
    await pool.query(
      'INSERT INTO login_attempts (username, ip_address, success) VALUES ($1, $2, TRUE)',
      [pending.user.username, req.ip]
    );

    await regenerateSession(req);
    req.session.user = {
      id: pending.user.id,
      username: pending.user.username,
      role: pending.user.role,
    };
    req.session.authVersion = Number(pending.user.authVersion ?? 0);
    delete req.session.pendingPasskeyEnrollment;
    return res.json({ user: req.session.user });
  } catch (err) {
    console.error('Passkey sign-in verification failed:', err.message);
    res.status(err.code ? 500 : 401).json({
      error: err.code
        ? 'Could not finish sign-in. Please try again shortly.'
        : 'Passkey verification failed. Please try again.',
    });
  }
});

router.post('/recovery-codes', requireAuth, passwordResetLimiter, async (req, res) => {
  const password = req.body?.password;
  if (typeof password !== 'string' || password.length < 6 || password.length > 128) {
    return res.status(400).json({ error: 'Enter your account password to generate recovery codes.' });
  }

  let client;
  try {
    const userResult = await pool.query(
      'SELECT username, email, password_hash FROM users WHERE id = $1',
      [req.session.user.id]
    );
    const user = userResult.rows[0];
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return res.status(401).json({ error: 'The password is incorrect. Recovery codes were not changed.' });
    }

    client = await pool.connect();
    await client.query('BEGIN');
    await client.query(
      'SELECT id FROM users WHERE id = $1 FOR UPDATE',
      [req.session.user.id]
    );
    const codes = createRecoveryCodes();
    await client.query('DELETE FROM user_recovery_codes WHERE user_id = $1', [req.session.user.id]);
    for (const code of codes) {
      await client.query(
        'INSERT INTO user_recovery_codes (user_id, code_hash) VALUES ($1, $2)',
        [req.session.user.id, hashRecoveryCode(code)]
      );
    }
    await client.query('COMMIT');

    const notificationSent = await sendSecurityNotification(
      sendRecoveryCodesChangedNotification,
      user.email,
      user.username,
      'Recovery-code-change'
    );
    return res.json({
      codes,
      notificationSent,
      message: 'Save these codes somewhere private and secure. Each can be used once. This is the only time they will be shown.',
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK').catch((rollbackError) => {
        console.error('Could not roll back recovery-code replacement:', rollbackError.message);
      });
    }
    console.error('Could not generate recovery codes:', error.message);
    return res.status(500).json({ error: 'Could not generate recovery codes. Please try again.' });
  } finally {
    if (client) client.release();
  }
});

/* ---------- Password recovery ---------- */
router.post('/forgot-password', passwordResetLimiter, async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const genericResponse = {
    message: 'If an account uses that email, a password reset code is on its way.',
    step: 'password-reset',
  };
  if (!email || email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.json(genericResponse);
  }

  try {
    const result = await pool.query(
      'SELECT id, username, email FROM users WHERE email = $1',
      [email]
    );
    const user = result.rows[0];
    if (!user) {
      req.session.pendingPasswordReset = {
        userId: null,
        username: '',
        email,
        otpHash: hashOtp(createOtp()),
        otpExpiresAt: Date.now() + PASSWORD_RESET_TTL_MS,
        otpAttempts: 0,
        otpLastSentAt: Date.now(),
        isDummy: true,
      };
      return res.json(genericResponse);
    }

    const code = createOtp();
    await sendPasswordResetCode(user.email, user.username, code);
    req.session.pendingPasswordReset = {
      userId: user.id,
      username: user.username,
      email: user.email,
      otpHash: hashOtp(code),
      otpExpiresAt: Date.now() + PASSWORD_RESET_TTL_MS,
      otpAttempts: 0,
      otpLastSentAt: Date.now(),
    };
    return res.json(genericResponse);
  } catch (error) {
    console.error('Password reset email could not be sent:', error.code || error.message);
    return res.status(503).json({
      error: 'We could not send a reset code right now. Please try again shortly.',
    });
  }
});

router.post('/reset-password', passwordResetLimiter, async (req, res) => {
  const pending = req.session.pendingPasswordReset;
  const { token, recoveryCode, password } = req.body || {};
  if (!pending) return res.status(400).json({ error: 'Request a new password reset code first.' });
  if (Date.now() > pending.otpExpiresAt) {
    delete req.session.pendingPasswordReset;
    return res.status(401).json({ error: 'That reset code has expired. Request a new one.' });
  }
  if (pending.otpAttempts >= OTP_MAX_ATTEMPTS) {
    delete req.session.pendingPasswordReset;
    return res.status(429).json({ error: 'Too many incorrect codes. Request a new one.' });
  }
  if (typeof token !== 'string' || !/^\d{6}$/.test(token) ||
      typeof recoveryCode !== 'string' || !/^[\da-fA-F\s-]{20,40}$/.test(recoveryCode) ||
      typeof password !== 'string' || password.length < 6 || password.length > 128) {
    return res.status(400).json({
      error: 'Enter the email code, one unused recovery code, and a password of 6-128 characters.',
    });
  }
  if (pending.isDummy) {
    pending.otpAttempts += 1;
    return res.status(401).json({ error: 'That reset code is incorrect.' });
  }
  if (!otpMatches(pending.otpHash, token)) {
    pending.otpAttempts += 1;
    return res.status(401).json({ error: 'That reset code is incorrect.' });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [pending.userId]);
    const codesResult = await client.query(
      `SELECT id, code_hash
       FROM user_recovery_codes
       WHERE user_id = $1 AND used_at IS NULL
       FOR UPDATE`,
      [pending.userId]
    );
    const candidateHash = hashRecoveryCode(recoveryCode);
    const matchingRecoveryCode = codesResult.rows.find((row) => (
      hashesMatch(candidateHash, row.code_hash)
    ));
    if (!matchingRecoveryCode) {
      await client.query('ROLLBACK');
      pending.otpAttempts += 1;
      return res.status(401).json({
        error: 'The email code or recovery code is incorrect. Check both and try again.',
      });
    }

    await client.query(
      'DELETE FROM user_recovery_codes WHERE user_id = $1',
      [pending.userId]
    );
    const { hash, salt } = await hashPassword(password);
    await client.query(
      `UPDATE users
       SET password_hash = $1, salt = $2, passkey_email_grace_until = NULL,
           auth_version = auth_version + 1
       WHERE id = $3`,
      [hash, salt, pending.userId]
    );
    await client.query('DELETE FROM passkey_credentials WHERE user_id = $1', [pending.userId]);
    await client.query('COMMIT');
    delete req.session.pendingPasswordReset;
    const notificationSent = await sendSecurityNotification(
      sendPasswordResetNotification,
      pending.email,
      pending.username,
      'Password-reset'
    );
    return res.json({
      notificationSent,
      message: 'Your password has been reset. All passkeys and recovery codes were removed. Sign in with your new password, set up a passkey, and generate new recovery codes.',
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK').catch((rollbackError) => {
        console.error('Could not roll back password reset:', rollbackError.message);
      });
    }
    console.error('Password reset failed:', error.message);
    return res.status(500).json({ error: 'Could not reset your password. Please try again.' });
  } finally {
    if (client) client.release();
  }
});

/* ---------- Resend registration or password reset code ---------- */
router.post('/resend-code', passwordResetLimiter, async (req, res) => {
  const pending = req.session.pendingRegistration ||
    req.session.pendingPasswordReset ||
    req.session.pendingPasskeyEmailVerification;
  if (!pending) return res.status(400).json({ error: 'No verification code is waiting to be resent.' });
  const isRegistration = Boolean(req.session.pendingRegistration);
  const isLoginVerification = Boolean(req.session.pendingPasskeyEmailVerification);

  const remainingMs = pending.otpLastSentAt + OTP_RESEND_COOLDOWN_MS - Date.now();
  if (remainingMs > 0) {
    return res.status(429).json({
      error: `Please wait ${Math.ceil(remainingMs / 1000)} seconds before requesting another code.`,
    });
  }

  try {
    if (isLoginVerification) {
      const code = createOtp();
      await sendLoginCode(pending.user.email, pending.user.username, code);
      req.session.pendingPasskeyEmailVerification = {
        ...pending,
        otpHash: hashOtp(code),
        otpExpiresAt: Date.now() + OTP_TTL_MS,
        otpAttempts: 0,
        otpLastSentAt: Date.now(),
      };
    } else if (req.session.pendingRegistration) {
      const code = createOtp();
      await sendRegistrationCode(pending.email, pending.username, code);
      req.session.pendingRegistration = {
        ...pending,
        otpHash: hashOtp(code),
        otpExpiresAt: Date.now() + OTP_TTL_MS,
        otpAttempts: 0,
        otpLastSentAt: Date.now(),
      };
    } else {
      const code = createOtp();
      if (!pending.isDummy) {
        await sendPasswordResetCode(pending.email, pending.username, code);
      }
      req.session.pendingPasswordReset = {
        ...pending,
        otpHash: hashOtp(code),
        otpExpiresAt: Date.now() + PASSWORD_RESET_TTL_MS,
        otpAttempts: 0,
        otpLastSentAt: Date.now(),
      };
    }
    res.json({
      message: isLoginVerification
        ? `A new sign-in code was sent to ${maskEmail(pending.user.email)}. Use only the newest code.`
        : isRegistration
        ? `Gmail accepted a new code email for ${pending.email}. Search Gmail for in:anywhere subject:"Your LogiAuth verification code" and use only the newest code.`
        : 'If the email matches an account, a new password reset code is on its way.',
      delivery: 'accepted',
      deliveryAddress: isRegistration ? pending.email : undefined,
    });
  } catch (mailError) {
    console.error('Verification code resend failed:', mailError.code || mailError.message);
    res.status(503).json({
      error: mailError.code === 'ERECIPIENTREJECTED'
        ? 'Gmail rejected that recipient address. Check for typos or try another email address.'
        : 'Could not send a new code. Check the email server configuration and try again.',
    });
  }
});

/* ---------- 2FA setup (returns QR) ---------- */
router.post('/setup-2fa', requireAuth, async (req, res) => {
  const user = req.session.user;
  const secret = generateTwoFASecret(user.username);

  await pool.query(
    'UPDATE users SET twofa_secret = $1, twofa_enabled = TRUE WHERE id = $2',
    [secret.base32, user.id]
  );

  const qrcode = require('qrcode');
  const qrDataUrl = await qrcode.toDataURL(secret.otpauth_url);

  res.json({ qr: qrDataUrl, secret: secret.base32 });
});

/* ---------- Who am I ---------- */
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.session.user });
});

router.post('/activity', requireAuth, async (req, res) => {
  try {
    await pool.query('UPDATE users SET last_activity_at = NOW() WHERE id = $1', [req.session.user.id]);
    res.json({ ok: true });
  } catch (error) {
    console.error('Could not update user activity:', error.message);
    res.status(500).json({ error: 'Could not update activity.' });
  }
});

router.post('/admin/users', requireAuth, requireRole('admin'), async (req, res) => {
  const { username, email, password, role } = req.body || {};
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (typeof username !== 'string' || !/^[a-zA-Z0-9_]{3,50}$/.test(username.trim())) {
    return res.status(400).json({ error: 'Username must be 3-50 letters, numbers, or underscores.' });
  }
  if (!validator.isEmail(normalizedEmail) || normalizedEmail.length > 120) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  if (typeof password !== 'string' || password.length < 6 || password.length > 128) {
    return res.status(400).json({ error: 'Password must be 6-128 characters.' });
  }
  if (!USER_ROLES.includes(role)) {
    return res.status(400).json({ error: 'Choose a valid account role.' });
  }

  try {
    const { hash, salt } = await hashPassword(password);
    const result = await pool.query(
      `INSERT INTO users (username, email, password_hash, salt, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING username, email, role, created_at`,
      [username.trim(), normalizedEmail, hash, salt, role]
    );
    res.status(201).json({ user: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'That username or email is already registered.' });
    }
    console.error('Could not create admin-managed account:', error.message);
    res.status(500).json({ error: 'Could not create the account.' });
  }
});

router.patch('/admin/users/:id/role', requireAuth, requireRole('admin'), async (req, res) => {
  const userId = Number(req.params.id);
  const { role } = req.body || {};
  if (!Number.isSafeInteger(userId) || userId < 1 || !USER_ROLES.includes(role)) {
    return res.status(400).json({ error: 'Choose a valid account and role.' });
  }
  if (userId === Number(req.session.user.id)) {
    return res.status(400).json({ error: 'You cannot change your own administrator role.' });
  }

  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const account = await client.query(
        'SELECT id, role FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
        [userId]
      );
      if (!account.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Account not found.' });
      }
      if (account.rows[0].role === 'admin' && role !== 'admin') {
        const count = await client.query(
          `SELECT COUNT(*)::integer AS count
           FROM users WHERE role = 'admin' AND deleted_at IS NULL`
        );
        if (Number(count.rows[0].count) <= 1) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'The system must retain at least one active administrator.' });
        }
      }
      await client.query(
        'UPDATE users SET role = $1, auth_version = auth_version + 1 WHERE id = $2',
        [role, userId]
      );
      await client.query('COMMIT');
      res.json({ ok: true, role });
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('Could not roll back role change:', rollbackError.message);
      }
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Could not update account role:', error.message);
    res.status(500).json({ error: 'Could not update the account role.' });
  }
});

router.delete('/admin/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isSafeInteger(userId) || userId < 1) {
    return res.status(400).json({ error: 'Invalid account ID.' });
  }
  if (userId === Number(req.session.user.id)) {
    return res.status(400).json({ error: 'You cannot delete your own administrator account.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const account = await client.query(
      `SELECT id, username, email, role, created_at
       FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [userId]
    );
    if (!account.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Account not found.' });
    }
    if (account.rows[0].role === 'admin') {
      const count = await client.query(
        `SELECT COUNT(*)::integer AS count
         FROM users WHERE role = 'admin' AND deleted_at IS NULL`
      );
      if (Number(count.rows[0].count) <= 1) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'The system must retain at least one active administrator.' });
      }
    }

    const user = account.rows[0];
    await client.query(
      `INSERT INTO deleted_users (user_id, username, email, role, created_at, deleted_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [user.id, user.username, user.email, user.role, user.created_at, req.session.user.id]
    );
    await client.query(
      `UPDATE users
       SET deleted_at = NOW(), auth_version = auth_version + 1,
           password_hash = 'revoked', salt = '', twofa_secret = NULL,
           twofa_enabled = FALSE
       WHERE id = $1`,
      [user.id]
    );
    await client.query('DELETE FROM passkey_credentials WHERE user_id = $1', [user.id]);
    await client.query('DELETE FROM user_recovery_codes WHERE user_id = $1', [user.id]);
    await client.query('COMMIT');
    res.json({ ok: true, message: 'Account deactivated and archived. Its learning records were preserved.' });
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Could not roll back account archive:', rollbackError.message);
    }
    console.error('Could not archive account:', error.message);
    res.status(500).json({ error: 'Could not archive the account.' });
  } finally {
    client.release();
  }
});

router.get('/admin/deleted-users', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT username, email, role, created_at, deleted_at
       FROM deleted_users ORDER BY deleted_at DESC LIMIT 100`
    );
    res.json({ users: result.rows });
  } catch (error) {
    console.error('Could not load archived accounts:', error.message);
    res.status(500).json({ error: 'Could not load archived accounts.' });
  }
});

router.get('/admin/users', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, username, email, role, created_at, last_login, last_activity_at,
              CASE
                WHEN password_hash LIKE 'bcrypt-hmac-sha256$%' THEN 'HMAC-SHA-256 + bcrypt'
                ELSE 'Legacy bcrypt + pepper'
              END AS password_scheme,
              (length(salt) > 0) AS has_user_salt
       FROM users WHERE deleted_at IS NULL
       ORDER BY created_at DESC, id DESC`
    );
    res.json({ users: result.rows });
  } catch (error) {
    console.error('Could not load admin user list:', error.message);
    res.status(500).json({ error: 'Could not load users.' });
  }
});

router.get('/admin/overview', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const [
      metricsResult,
      registrationsResult,
      uploadsResult,
      rolesResult,
      coursesResult,
      recentLoginsResult,
    ] = await Promise.all([
      pool.query(
        `SELECT
           (SELECT COUNT(*)::integer FROM users WHERE deleted_at IS NULL) AS user_count,
           (SELECT COUNT(*)::integer FROM users WHERE role = 'student' AND deleted_at IS NULL) AS student_count,
           (SELECT COUNT(*)::integer FROM users WHERE role = 'editor' AND deleted_at IS NULL) AS editor_count,
           (SELECT COUNT(*)::integer FROM users WHERE role = 'admin' AND deleted_at IS NULL) AS admin_count,
           (SELECT COUNT(*)::integer FROM users WHERE last_activity_at >= NOW() - INTERVAL '5 minutes' AND deleted_at IS NULL) AS active_users,
           (SELECT COUNT(*)::integer FROM users WHERE created_at >= NOW() - INTERVAL '24 hours' AND deleted_at IS NULL) AS new_users_24h,
           (SELECT COUNT(*)::integer FROM deleted_users) AS archived_user_count,
           (SELECT COUNT(*)::integer FROM courses) AS course_count,
           (SELECT COUNT(*)::integer FROM course_slides) AS slide_count,
           (SELECT COALESCE(SUM(size_bytes), 0)::bigint FROM course_slides) AS storage_bytes,
           (SELECT COUNT(*)::integer FROM login_attempts WHERE success IS TRUE AND attempted_at >= NOW() - INTERVAL '24 hours') AS successful_logins_24h`
      ),
      pool.query(
        `WITH days AS (
           SELECT generate_series(
             CURRENT_DATE - INTERVAL '6 days',
             CURRENT_DATE,
             INTERVAL '1 day'
           )::date AS day
         )
         SELECT TO_CHAR(days.day, 'YYYY-MM-DD') AS day,
                COUNT(users.id)::integer AS count
         FROM days
         LEFT JOIN users ON users.created_at::date = days.day AND users.deleted_at IS NULL
         GROUP BY days.day
         ORDER BY days.day`
      ),
      pool.query(
        `WITH days AS (
           SELECT generate_series(
             CURRENT_DATE - INTERVAL '6 days',
             CURRENT_DATE,
             INTERVAL '1 day'
           )::date AS day
         )
         SELECT TO_CHAR(days.day, 'YYYY-MM-DD') AS day,
                COUNT(course_slides.id)::integer AS count
         FROM days
         LEFT JOIN course_slides ON course_slides.created_at::date = days.day
         GROUP BY days.day
         ORDER BY days.day`
      ),
      pool.query(
        `SELECT role, COUNT(*)::integer AS count
         FROM users WHERE deleted_at IS NULL
         GROUP BY role
         ORDER BY role`
      ),
      pool.query(
        `SELECT c.title, COUNT(s.id)::integer AS slide_count,
                COALESCE(SUM(s.size_bytes), 0)::bigint AS storage_bytes
         FROM courses c
         LEFT JOIN course_slides s ON s.course_id = c.id
         GROUP BY c.id
         ORDER BY COUNT(s.id) DESC, c.title
         LIMIT 6`
      ),
      pool.query(
        `SELECT username, role, last_login, last_activity_at
         FROM users
         WHERE deleted_at IS NULL AND last_login IS NOT NULL
         ORDER BY last_login DESC
         LIMIT 6`
      ),
    ]);
    const metrics = Object.fromEntries(
      Object.entries(metricsResult.rows[0]).map(([key, value]) => [key, Number(value)])
    );
    res.json({
      metrics,
      registrations: registrationsResult.rows.map((row) => ({ day: row.day, count: Number(row.count) })),
      uploads: uploadsResult.rows.map((row) => ({ day: row.day, count: Number(row.count) })),
      roles: rolesResult.rows.map((row) => ({ role: row.role, count: Number(row.count) })),
      courses: coursesResult.rows.map((row) => ({
        title: row.title,
        slideCount: Number(row.slide_count),
        storageBytes: Number(row.storage_bytes),
      })),
      recentLogins: recentLoginsResult.rows,
    });
  } catch (error) {
    console.error('Could not load admin monitoring overview:', error.message);
    res.status(500).json({ error: 'Could not load system monitoring data.' });
  }
});

router.get('/manager/overview', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         (SELECT COUNT(*)::integer FROM users WHERE deleted_at IS NULL) AS user_count,
         (SELECT COUNT(*)::integer FROM users WHERE role = 'student' AND deleted_at IS NULL) AS student_count,
         (SELECT COUNT(*)::integer FROM courses) AS course_count,
         (SELECT COUNT(*)::integer FROM course_slides) AS slide_count`
    );
    res.json({
      metrics: Object.fromEntries(
        Object.entries(result.rows[0]).map(([key, value]) => [key, Number(value)])
      ),
    });
  } catch (error) {
    console.error('Could not load manager dashboard:', error.message);
    res.status(500).json({ error: 'Could not load manager dashboard data.' });
  }
});

/* ---------- Logout ---------- */
router.post('/logout', (req, res) => {
  if (!req.session) return res.json({ ok: true });
  req.session.destroy((error) => {
    if (error) {
      console.error('Could not destroy login session:', error.message);
      return res.status(500).json({ error: 'Could not log out. Please try again.' });
    }
    res.clearCookie('logi.sid', { path: '/' });
    res.json({ ok: true });
  });
});

module.exports = router;
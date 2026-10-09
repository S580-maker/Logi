const express = require('express');
const crypto = require('crypto');
const dns = require('node:dns').promises;
const pool = require('../db/pool');
const { sendLoginCode, sendRegistrationCode, sendWelcomeEmail } = require('../utils/email');
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
const { loginLimiter, registrationLimiter } = require('../middleware/rateLimit');

const router = express.Router();
const OTP_TTL_MS = 5 * 60 * 1000;
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

async function issueLoginCode(user) {
  const code = createOtp();
  await sendLoginCode(user.email, user.username, code);
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    email: user.email,
    otpHash: hashOtp(code),
    otpExpiresAt: Date.now() + OTP_TTL_MS,
    otpAttempts: 0,
    otpLastSentAt: Date.now(),
  };
}

function otpMatches(expectedHash, code) {
  const actual = Buffer.from(hashOtp(code), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
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
    delete req.session.pendingUser;
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
      `INSERT INTO users (username, email, password_hash, salt, role, email_verified_at, last_login, last_activity_at)
       VALUES ($1, $2, $3, $4, 'student', NOW(), NOW(), NOW())
       RETURNING id, username, role`,
      [pending.username, pending.email, pending.passwordHash, pending.salt]
    );
    const user = result.rows[0];
    req.session.user = { id: user.id, username: user.username, role: user.role };
    delete req.session.pendingRegistration;

    let welcomeEmailSent = true;
    try {
      await sendWelcomeEmail(pending.email, pending.username);
    } catch (mailError) {
      welcomeEmailSent = false;
      console.error('Welcome email failed:', mailError.message);
    }

    return res.status(201).json({
      step: 'done',
      user: req.session.user,
      welcomeEmailSent,
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

/* ---------- STEP 1: username + password ---------- */
router.post('/login', loginLimiter, validateLoginInput, async (req, res) => {
  const { username, password } = req.body;
  const ip = req.ip;

  try {
    // SQLi Layer 2: parameterized query — NEVER concatenate strings
    const result = await pool.query(
      'SELECT id, username, email, password_hash, role FROM users WHERE username = $1',
      [username]
    );

    const user = result.rows[0];

    // Log attempt (audit trail)
    await pool.query(
      'INSERT INTO login_attempts (username, ip_address, success) VALUES ($1, $2, $3)',
      [username, ip, !!user]
    );

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    try {
      req.session.pendingUser = await issueLoginCode(user);
      delete req.session.pendingRegistration;
    } catch (mailError) {
      console.error('Login code email failed:', mailError.code || mailError.message);
      const rejected = mailError.code === 'ERECIPIENTREJECTED';
      return res.status(503).json({
          error: rejected
            ? 'Gmail rejected that recipient address. Check for typos or contact support.'
            : 'Could not send a verification code. Check the email server configuration and try again.',
      });
    }

    return res.json({
      step: '2fa',
      email: maskEmail(user.email),
      expiresIn: OTP_TTL_MS / 1000,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error.' });
  }
});

/* ---------- STEP 2: 2FA verification ---------- */
router.post('/verify-2fa', async (req, res) => {
  const { token } = req.body;
  const pending = req.session.pendingUser;

  if (!pending) {
    return res.status(400).json({ error: 'No pending login.' });
  }
  if (!token || !/^\d{6}$/.test(token)) {
    return res.status(400).json({ error: 'Invalid code format.' });
  }

  try {
    if (Date.now() > pending.otpExpiresAt) {
      delete req.session.pendingUser;
      return res.status(401).json({ error: 'Code expired. Log in again to receive a new code.' });
    }
    if (pending.otpAttempts >= OTP_MAX_ATTEMPTS) {
      delete req.session.pendingUser;
      return res.status(429).json({ error: 'Too many incorrect codes. Log in again to receive a new code.' });
    }
    if (!otpMatches(pending.otpHash, token)) {
      pending.otpAttempts += 1;
      return res.status(401).json({ error: 'Invalid 2FA code.' });
    }

    req.session.user = {
      id: pending.id,
      username: pending.username,
      role: pending.role,
    };
    delete req.session.pendingUser;
    delete req.session.pendingRegistration;

    await pool.query(
      'UPDATE users SET last_login = NOW(), last_activity_at = NOW() WHERE id = $1',
      [pending.id]
    );

    res.json({ step: 'done', user: req.session.user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error.' });
  }
});

/* ---------- Resend email verification code ---------- */
router.post('/resend-2fa', async (req, res) => {
  const pending = req.session.pendingRegistration || req.session.pendingUser;
  if (!pending) return res.status(400).json({ error: 'No pending login.' });
  const isRegistration = Boolean(req.session.pendingRegistration);

  const remainingMs = pending.otpLastSentAt + OTP_RESEND_COOLDOWN_MS - Date.now();
  if (remainingMs > 0) {
    return res.status(429).json({
      error: `Please wait ${Math.ceil(remainingMs / 1000)} seconds before requesting another code.`,
    });
  }

  try {
    if (req.session.pendingRegistration) {
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
      const freshPending = await issueLoginCode(pending);
      req.session.pendingUser = freshPending;
    }
    res.json({
      message: isRegistration
        ? `Gmail accepted the new code email for ${pending.email}. Check Inbox, Spam, and All Mail.`
        : 'Gmail accepted the new code email. Check Inbox, Spam, and All Mail.',
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

router.get('/admin/users', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT username, email, role, created_at, last_login, last_activity_at
       FROM users
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
    const [metricsResult, registrationsResult, uploadsResult, rolesResult, coursesResult] = await Promise.all([
      pool.query(
        `SELECT
           (SELECT COUNT(*)::integer FROM users) AS user_count,
           (SELECT COUNT(*)::integer FROM users WHERE role = 'student') AS student_count,
           (SELECT COUNT(*)::integer FROM users WHERE role = 'editor') AS editor_count,
           (SELECT COUNT(*)::integer FROM users WHERE role = 'admin') AS admin_count,
           (SELECT COUNT(*)::integer FROM users WHERE last_activity_at >= NOW() - INTERVAL '5 minutes') AS active_users,
           (SELECT COUNT(*)::integer FROM users WHERE created_at >= NOW() - INTERVAL '24 hours') AS new_users_24h,
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
         LEFT JOIN users ON users.created_at::date = days.day
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
         FROM users
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
    });
  } catch (error) {
    console.error('Could not load admin monitoring overview:', error.message);
    res.status(500).json({ error: 'Could not load system monitoring data.' });
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
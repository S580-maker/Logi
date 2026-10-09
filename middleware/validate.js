const validator = require('validator');

/**
 * SQLi Layer 1: strict whitelist validation before touching DB.
 * SQLi Layer 2 (parameterized queries) happens in routes.
 * SQLi Layer 3: least-privilege DB user (see README).
 */
function validateLoginInput(req, res, next) {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: 'Missing credentials.' });
  }

  // Allow only alphanumeric + underscore, 3–50 chars
  if (!/^[a-zA-Z0-9_]{3,50}$/.test(username)) {
    return res.status(400).json({ error: 'Invalid username format.' });
  }

  if (typeof password !== 'string' || password.length < 6 || password.length > 128) {
    return res.status(400).json({ error: 'Invalid password.' });
  }

  next();
}

function validateRegistrationInput(req, res, next) {
  const { username, email, password } = req.body || {};

  if (typeof username !== 'string' || !/^[a-zA-Z0-9_]{3,50}$/.test(username.trim())) {
    return res.status(400).json({
      error: 'Username must be 3-50 letters, numbers, or underscores.',
    });
  }
  if (
    typeof email !== 'string' ||
    email.trim().length > 120 ||
    !validator.isEmail(email.trim())
  ) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  if (typeof password !== 'string' || password.length < 6 || password.length > 128) {
    return res.status(400).json({ error: 'Password must be 6-128 characters.' });
  }

  next();
}

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user || !roles.includes(req.session.user.role)) {
      return res.status(403).json({ error: 'Forbidden.' });
    }
    next();
  };
}

module.exports = {
  validateLoginInput,
  validateRegistrationInput,
  requireAuth,
  requireRole,
};
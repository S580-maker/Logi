const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const { getRedisClient } = require('../utils/redis');

const redisClient = getRedisClient();

function createStore(prefix) {
  if (!redisClient) return undefined;
  return new RedisStore({
    prefix,
    sendCommand: (...args) => redisClient.sendCommand(args),
  });
}

function createLimiters(prefix, max, message) {
  const options = {
    windowMs: 15 * 60 * 1000,
    max,
    message: { error: message },
    standardHeaders: true,
    legacyHeaders: false,
  };
  if (!redisClient) return [rateLimit(options)];

  return [
    rateLimit(options),
    rateLimit({
      ...options,
      store: createStore(prefix),
      passOnStoreError: true,
    }),
  ];
}

const loginLimiter = createLimiters('logiauth:limit:login:', 5, 'Too many login attempts. Try again later.');
const registrationLimiter = createLimiters(
  'logiauth:limit:registration:',
  5,
  'Too many account creation attempts. Try again later.'
);
const passwordResetLimiter = createLimiters(
  'logiauth:limit:password-reset:',
  5,
  'Too many password reset attempts. Try again later.'
);
const passwordResetStartLimiter = createLimiters(
  'logiauth:limit:password-reset:start:',
  5,
  'Too many password reset requests. Try again later.'
);
const passwordResetVerificationLimiter = createLimiters(
  'logiauth:limit:password-reset:verify:',
  10,
  'Too many password reset attempts. Try again later.'
);
const emailCodeResendLimiter = createLimiters(
  'logiauth:limit:email-code:resend:',
  5,
  'Too many code resend requests. Try again later.'
);
const passkeyVerificationLimiter = createLimiters(
  'logiauth:limit:passkey:',
  10,
  'Too many passkey attempts. Please wait and try again.'
);

module.exports = {
  loginLimiter,
  registrationLimiter,
  passwordResetLimiter,
  passwordResetStartLimiter,
  passwordResetVerificationLimiter,
  emailCodeResendLimiter,
  passkeyVerificationLimiter,
};
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

// 5 login attempts per 15 minutes per IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  ...(redisClient ? { store: createStore('logiauth:limit:login:') } : {}),
  message: { error: 'Too many login attempts. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const registrationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  ...(redisClient ? { store: createStore('logiauth:limit:registration:') } : {}),
  message: { error: 'Too many account creation attempts. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  ...(redisClient ? { store: createStore('logiauth:limit:password-reset:') } : {}),
  message: { error: 'Too many password reset attempts. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const passkeyVerificationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  ...(redisClient ? { store: createStore('logiauth:limit:passkey:') } : {}),
  message: { error: 'Too many passkey attempts. Please wait and try again.' },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = {
  loginLimiter,
  registrationLimiter,
  passwordResetLimiter,
  passkeyVerificationLimiter,
};
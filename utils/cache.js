const { createClient } = require('redis');

const memoryCache = new Map();
const CACHE_PREFIX = 'logiauth:';
const CACHE_TTL_SECONDS = 30;
let redisClient;
let redisReady = false;
let redisWarningLogged = false;

if (process.env.REDIS_URL) {
  redisClient = createClient({
    url: process.env.REDIS_URL,
    socket: {
      connectTimeout: 1200,
      reconnectStrategy: false,
    },
  });
  redisClient.on('error', (error) => {
    redisReady = false;
    if (!redisWarningLogged) {
      console.warn(`Redis cache unavailable; using in-process cache: ${error.message}`);
      redisWarningLogged = true;
    }
  });
  redisClient.connect()
    .then(() => {
      redisReady = true;
      console.log('Redis cache connected.');
    })
    .catch((error) => {
      redisReady = false;
      if (!redisWarningLogged) {
        console.warn(`Redis cache unavailable; using in-process cache: ${error.message}`);
        redisWarningLogged = true;
      }
    });
}

async function get(key) {
  const memoryEntry = memoryCache.get(key);
  if (memoryEntry) {
    if (memoryEntry.expiresAt > Date.now()) return memoryEntry.value;
    memoryCache.delete(key);
  }

  if (redisReady) {
    try {
      const value = await redisClient.get(CACHE_PREFIX + key);
      if (value !== null) {
        const parsed = JSON.parse(value);
        memoryCache.set(key, { value: parsed, expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000 });
        return parsed;
      }
    } catch (error) {
      redisReady = false;
      console.warn(`Redis cache read failed; using in-process cache: ${error.message}`);
    }
  }
  return null;
}

async function set(key, value, ttlSeconds = CACHE_TTL_SECONDS) {
  memoryCache.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  if (memoryCache.size > 500) {
    const now = Date.now();
    for (const [cachedKey, entry] of memoryCache) {
      if (entry.expiresAt <= now) memoryCache.delete(cachedKey);
    }
  }

  if (redisReady) {
    try {
      await redisClient.set(CACHE_PREFIX + key, JSON.stringify(value), { EX: ttlSeconds });
    } catch (error) {
      redisReady = false;
      console.warn(`Redis cache write failed; using in-process cache: ${error.message}`);
    }
  }
}

async function deletePrefix(prefix) {
  for (const key of memoryCache.keys()) {
    if (key.startsWith(prefix)) memoryCache.delete(key);
  }

  if (redisReady) {
    try {
      let cursor = '0';
      do {
        const result = await redisClient.scan(cursor, {
          MATCH: `${CACHE_PREFIX}${prefix}*`,
          COUNT: 100,
        });
        cursor = result.cursor;
        if (result.keys.length) await redisClient.del(result.keys);
      } while (cursor !== '0');
    } catch (error) {
      redisReady = false;
      console.warn(`Redis cache invalidation failed: ${error.message}`);
    }
  }
}

async function close() {
  if (redisClient?.isOpen) await redisClient.quit();
}

module.exports = { get, set, deletePrefix, close };

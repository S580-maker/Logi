const { getRedisClient } = require('./redis');

const memoryCache = new Map();
const CACHE_PREFIX = 'logiauth:';
const CACHE_TTL_SECONDS = 30;
const redisClient = getRedisClient();
let redisWarningLogged = false;

async function get(key) {
  const memoryEntry = memoryCache.get(key);
  if (memoryEntry) {
    if (memoryEntry.expiresAt > Date.now()) return memoryEntry.value;
    memoryCache.delete(key);
  }

  if (redisClient?.isReady) {
    try {
      const value = await redisClient.get(CACHE_PREFIX + key);
      if (value !== null) {
        const parsed = JSON.parse(value);
        memoryCache.set(key, { value: parsed, expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000 });
        return parsed;
      }
    } catch (error) {
      logRedisFallback('read', error);
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

  if (redisClient?.isReady) {
    try {
      await redisClient.set(CACHE_PREFIX + key, JSON.stringify(value), { EX: ttlSeconds });
    } catch (error) {
      logRedisFallback('write', error);
    }
  }
}

async function deletePrefix(prefix) {
  for (const key of memoryCache.keys()) {
    if (key.startsWith(prefix)) memoryCache.delete(key);
  }

  if (redisClient?.isReady) {
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
      logRedisFallback('invalidation', error);
    }
  }
}

async function close() {
  if (redisClient?.isOpen) await redisClient.quit();
}

function logRedisFallback(operation, error) {
  if (redisWarningLogged) return;
  redisWarningLogged = true;
  console.warn(
    `Redis cache ${operation} failed; using in-process cache: ${error.code || error.name || 'unknown error'}.`
  );
}

module.exports = { get, set, deletePrefix, close };

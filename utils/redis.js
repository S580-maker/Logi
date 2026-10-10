require('dotenv').config();
const { createClient } = require('redis');

let redisClient;
let redisErrorLogged = false;

function getRedisClient() {
  if (!process.env.REDIS_URL) return null;
  if (redisClient) return redisClient;

  redisClient = createClient({
    url: process.env.REDIS_URL,
    socket: {
      connectTimeout: 1200,
      reconnectStrategy: false,
    },
  });
  redisClient.on('error', (error) => {
    if (redisErrorLogged) return;
    redisErrorLogged = true;
    console.error(`Redis connection error: ${error.code || error.name || 'unknown error'}.`);
  });

  return redisClient;
}

async function connectRedis() {
  const client = getRedisClient();
  if (!client) return null;

  await client.connect();
  console.info('Redis connected for sessions, rate limits, and cache.');
  return client;
}

module.exports = { connectRedis, getRedisClient };

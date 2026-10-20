require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const path = require('path');
const { RedisStore } = require('connect-redis');
const { connectRedis } = require('./utils/redis');
const { validateProductionEnv } = require('./utils/validate-production-env');
const pool = require('./db/pool');
const { loadSystemConfig, getSystemConfig } = require('./utils/system-config');

const app = express();

if (process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

let startupError;

app.use((req, res, next) => {
  initializeApp.then(() => {
    if (startupError) {
      return res.status(503).json({ error: 'LogiAuth is temporarily unavailable. Please try again shortly.' });
    }
    next();
  });
});

async function configureApp() {
  validateProductionEnv();
  const redisClient = await connectRedis();
  if (process.env.NODE_ENV === 'production' && !redisClient) {
    throw new Error('REDIS_URL is required in production for shared sessions and rate limits.');
  }
  await loadSystemConfig(pool);

  const authRoutes = require('./routes/auth');
  const backupRoutes = require('./routes/backup');
  const groupRoutes = require('./routes/groups');
  const studyRoutes = require('./routes/study');

  app.use(helmet());
  app.use(express.json({ limit: '10kb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());

  app.use(session({
    name: 'logi.sid',
    secret: process.env.SESSION_SECRET,
    ...(redisClient
      ? { store: new RedisStore({ client: redisClient, prefix: 'logiauth:sess:' }) }
      : {}),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: getSystemConfig().session_ttl_minutes * 60 * 1000,
    },
  }));
  app.use((req, res, next) => {
    req.session.cookie.maxAge = getSystemConfig().session_ttl_minutes * 60 * 1000;
    next();
  });

  app.use(express.static(path.join(__dirname, 'public'), {
    etag: true,
    maxAge: '5m',
    setHeaders(res, filePath) {
      if (path.extname(filePath) === '.html') res.setHeader('Cache-Control', 'no-cache');
    },
  }));

  app.use('/api/auth', authRoutes);
  app.use('/api/study', studyRoutes);
  app.use('/api/study/groups', groupRoutes);
  app.use('/api', backupRoutes);

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'API endpoint not found.' });
  });

  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/index.html'));
  });
}

const initializeApp = configureApp().catch((error) => {
  startupError = error;
  console.error(`Could not initialize LogiAuth: ${error.code || error.message}`);
});

if (require.main === module) {
  initializeApp.then(() => {
    if (startupError) {
      process.exitCode = 1;
      return;
    }
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      console.log(`✅ LogiAuth running at http://localhost:${PORT}`);
    });
  });
}

module.exports = app;
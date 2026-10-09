require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const path = require('path');

const authRoutes   = require('./routes/auth');
const backupRoutes = require('./routes/backup');
const studyRoutes  = require('./routes/study');

const app = express();

// --- Security headers ---
app.use(helmet());

// --- Body & cookie parsing ---
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// --- Sessions ---
app.use(session({
  name: 'logi.sid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 1000 * 60 * 60, // 1 hour
  },
}));

// --- Static frontend ---
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  maxAge: '5m',
  setHeaders(res, filePath) {
    if (path.extname(filePath) === '.html') res.setHeader('Cache-Control', 'no-cache');
  },
}));

// --- Routes ---
app.use('/api/auth', authRoutes);
app.use('/api/study', studyRoutes);
app.use('/api', backupRoutes);

// --- Fallback ---
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ LogiAuth running at http://localhost:${PORT}`);
});
const crypto = require('crypto');
const fs = require('fs');
const os = require('node:os');
const path = require('path');
const express = require('express');
const multer = require('multer');
const pool = require('../db/pool');
const cache = require('../utils/cache');
const { buildContentSuggestions } = require('../utils/content-coach');
const { askGemini } = require('../utils/notebook-ai');
const { extractStudyContent } = require('../utils/study-content');
const { convertPowerPoint, removePowerPointPreview } = require('../utils/powerpoint-preview');
const { requireAuth, requireRole } = require('../middleware/validate');

const router = express.Router();
const storageDir = process.env.VERCEL
  ? path.join(os.tmpdir(), 'logiauth-storage')
  : path.join(__dirname, '..', 'storage');
const uploadDir = path.join(storageDir, 'slides');
const MAX_FILE_SIZE = 25 * 1024 * 1024;
const pdfjsAssets = {
  'pdf.mjs': require.resolve('pdfjs-dist/build/pdf.mjs'),
  'pdf.worker.mjs': require.resolve('pdfjs-dist/build/pdf.worker.mjs'),
};
const allowedTypes = {
  '.pdf': 'application/pdf',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const courseAccessSql = (userIdParam, roleParam) => `(
  $${roleParam} IN ('admin', 'editor')
  OR c.created_by IS NULL
  OR c.created_by = $${userIdParam}
  OR c.created_by IN (SELECT id FROM users WHERE role IN ('admin', 'editor'))
)`;

fs.mkdirSync(uploadDir, { recursive: true });

router.get('/pdfjs/:asset', (req, res) => {
  const assetPath = pdfjsAssets[req.params.asset];
  if (!assetPath) return res.status(404).json({ error: 'PDF renderer asset not found.' });
  res.type('application/javascript');
  res.sendFile(assetPath, (error) => {
    if (error && !res.headersSent) {
      console.error('Could not load PDF renderer asset:', error.message);
      res.status(500).json({ error: 'Could not load the slide viewer.' });
    }
  });
});

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, callback) => {
      callback(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`);
    },
  }),
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
  fileFilter: (req, file, callback) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!Object.hasOwn(allowedTypes, ext)) {
      const error = new Error('Only PDF, PPT, and PPTX files are allowed.');
      error.status = 415;
      callback(error);
      return;
    }
    callback(null, true);
  },
});

function validFileSignature(file) {
  const descriptor = fs.openSync(file.path, 'r');
  try {
    const header = Buffer.alloc(8);
    const bytesRead = fs.readSync(descriptor, header, 0, header.length, 0);
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.pdf') return header.subarray(0, bytesRead).toString().startsWith('%PDF-');
    if (ext === '.pptx') return header[0] === 0x50 && header[1] === 0x4b;
    return header.subarray(0, bytesRead).equals(
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
    );
  } finally {
    fs.closeSync(descriptor);
  }
}

async function removeUploadedFile(filePath) {
  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not remove rejected upload:', error.message);
  }
}

function uploadFile(req, res, next) {
  upload.single('slide')(req, res, (error) => {
    if (!error) return next();
    const status = error instanceof multer.MulterError ? 400 : (error.status || 500);
    if (status === 500) console.error('Slide upload parser failed:', error.message);
    res.status(status).json({
      error: error.code === 'LIMIT_FILE_SIZE'
        ? 'File is too large. The maximum upload size is 25 MB.'
        : error.status === 415
          ? error.message
          : 'Could not process the uploaded file.',
    });
  });
}

async function getContentCoach(userId, userRole, refresh = false) {
  const cacheKey = `study:coach:v3:${userId}`;
  const cached = await cache.get(cacheKey);
  if (cached && !refresh) return cached;

  const { rows } = await pool.query(
    `SELECT COUNT(*) OVER()::integer AS total_count,
            s.id, s.course_id, s.original_name, s.storage_name, s.mime_type,
            c.title AS course_title,
            (p.slide_id IS NOT NULL) AS is_completed, p.completed_at,
            COALESCE(n.note, '') AS note
     FROM course_slides s
     JOIN courses c ON c.id = s.course_id
     LEFT JOIN course_progress p ON p.slide_id = s.id AND p.user_id = $1
     LEFT JOIN course_slide_notes n ON n.slide_id = s.id AND n.user_id = $1
     WHERE ${courseAccessSql(1, 2)}
     ORDER BY (p.slide_id IS NOT NULL), s.created_at DESC
     LIMIT 12`,
    [userId, userRole]
  );
  const totalFiles = Number(rows[0]?.total_count || 0);

  const contentItems = [];
  let unreadableCount = 0;
  for (const slide of rows) {
    const filePath = path.join(uploadDir, path.basename(slide.storage_name));
    try {
      const extractionPath = path.extname(slide.storage_name).toLowerCase() === '.ppt'
        ? await convertPowerPoint(slide.storage_name)
        : filePath;
      const extracted = await extractStudyContent(extractionPath);
      if (!extracted.text) {
        unreadableCount += 1;
        continue;
      }
      contentItems.push({ ...slide, ...extracted });
    } catch (error) {
      unreadableCount += 1;
      console.warn(`Could not extract study text from slide ${slide.id}: ${error.message}`);
    }
  }

  if (process.env.GEMINI_API_KEY && contentItems.length) {
    const aiSources = contentItems.map((item) => ({
      id: Number(item.id),
      original_name: item.original_name,
      pages: item.pages,
    }));
    const generated = await askGemini({
      sources: aiSources,
      question: [
        'Analyze these course materials and produce three concise, useful study insights grounded in the sources.',
        'Prioritize the central concepts, explain how key ideas connect, and point out one likely misconception or important distinction if supported.',
        'Finish with one concrete study action the learner can do next.',
        'Cite each factual insight with a short exact quote and its source page. Do not provide a generic keyword list.',
      ].join(' '),
    });
    const response = {
      status: 'ready',
      source: 'gemini',
      message: `Gemini generated these insights from ${contentItems.length} readable course file(s). Citations were checked against the source pages.`,
      suggestions: [{
        title: 'AI-generated study insights',
        detail: generated.answer,
        reason: `Analyzed ${contentItems.length} source file(s).`,
        citations: generated.citations.map((citation) => ({
          ...citation,
          courseId: Number(contentItems.find((item) => Number(item.id) === citation.sourceId)?.course_id),
          slideId: citation.sourceId,
        })),
      }],
      sources: aiSources.map((source) => ({
        slideId: source.id,
        fileName: source.original_name,
        pageCount: source.pages.length,
      })),
      model: generated.model,
    };
    await cache.set(cacheKey, response, 300);
    return response;
  }

  const { suggestions, sources } = buildContentSuggestions(contentItems);

  const response = suggestions.length
    ? {
      status: 'ready',
      message: `I read selectable text from ${sources.length} of ${totalFiles} uploaded files and built these suggestions from recurring concepts in the material.${totalFiles > rows.length ? ` I prioritized the latest and unfinished files; this first pass analyzed ${rows.length}.` : ''}${unreadableCount ? ` ${unreadableCount} analyzed file(s) had no extractable text.` : ''}`,
      suggestions,
      sources,
      unreadableCount,
    }
    : contentItems.length
      ? {
        status: 'text-needs-more',
        message: `I could read text in ${contentItems.length} of ${totalFiles} files, but there is not enough repeated subject-specific content yet to build a reliable suggestion. Add a fuller chapter or slide deck.`,
        suggestions: [],
        sources: contentItems.map((item) => ({
          slideId: Number(item.id),
          fileName: item.original_name,
          pageCount: item.pages.length,
        })),
        unreadableCount,
      }
    : {
      status: rows.length ? 'no-text' : 'no-files',
      message: rows.length
        ? `I could not find enough selectable text in the ${rows.length} analyzed file(s) to make content-specific suggestions. Scanned PDFs need OCR, and older .ppt files are not text-extracted yet. Try uploading a text-based PDF or .pptx.`
        : 'Upload a text-based PDF or .pptx slide deck to get suggestions grounded in its content.',
      suggestions: [],
      sources: [],
      unreadableCount,
    };
  await cache.set(cacheKey, response, 300);
  return response;
}

router.get('/coach', requireAuth, async (req, res) => {
  try {
    res.json(await getContentCoach(
      req.session.user.id,
      req.session.user.role,
      req.query.refresh === '1'
    ));
  } catch (error) {
    console.error('Could not build content-aware study suggestions:', error.message);
    res.status(error.status || 500).json({
      error: error.message || 'Could not analyze your study files. Please try again.',
      retryable: error.retryable ?? (error.status >= 500 || error.status === 429),
    });
  }
});

router.get('/dashboard', requireAuth, async (req, res) => {
  const cacheKey = `study:dashboard:${req.session.user.id}`;
  const cached = await cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const [coursesResult, recentResult, usersResult] = await Promise.all([
      pool.query(
        `SELECT c.id, c.title, c.description, c.created_at,
                COUNT(s.id)::integer AS slide_count,
                COUNT(p.slide_id)::integer AS completed_count
         FROM courses c
         LEFT JOIN course_slides s ON s.course_id = c.id
         LEFT JOIN course_progress p ON p.slide_id = s.id AND p.user_id = $1
         WHERE ${courseAccessSql(1, 2)}
         GROUP BY c.id
         ORDER BY c.created_at DESC`,
        [req.session.user.id, req.session.user.role]
      ),
      pool.query(
        `SELECT s.id, s.original_name, s.size_bytes, s.created_at,
                c.id AS course_id, c.title AS course_title
         FROM course_slides s
         JOIN courses c ON c.id = s.course_id
         WHERE ${courseAccessSql(1, 2)}
         ORDER BY s.created_at DESC
         LIMIT 6`,
        [req.session.user.id, req.session.user.role]
      ),
      req.session.user.role === 'admin'
        ? pool.query('SELECT COUNT(*)::integer AS count FROM users')
        : Promise.resolve({ rows: [{ count: null }] }),
    ]);

    const courses = coursesResult.rows.map((course) => ({
      ...course,
      slide_count: Number(course.slide_count),
      completed_count: Number(course.completed_count),
    }));
    const slideCount = courses.reduce((total, course) => total + course.slide_count, 0);
    const completedCount = courses.reduce((total, course) => total + course.completed_count, 0);
    const response = {
      stats: {
        courseCount: courses.length,
        slideCount,
        completedCount,
        progressPercent: slideCount ? Math.round(completedCount / slideCount * 100) : 0,
        userCount: usersResult.rows[0].count,
      },
      courses,
      recentSlides: recentResult.rows,
    };
    await cache.set(cacheKey, response);
    res.json(response);
  } catch (error) {
    console.error('Could not load study dashboard:', error.message);
    res.status(500).json({ error: 'Could not load dashboard data.' });
  }
});

router.get('/semester', requireAuth, async (req, res) => {
  try {
    const [profileResult, coursesResult] = await Promise.all([
      pool.query(
        `SELECT program_name, semester_name
         FROM user_semester_profiles
         WHERE user_id = $1`,
        [req.session.user.id]
      ),
      pool.query(
        `SELECT c.id, c.title, COUNT(s.id)::integer AS slide_count,
                (usc.course_id IS NOT NULL) AS selected
         FROM courses c
         LEFT JOIN course_slides s ON s.course_id = c.id
         LEFT JOIN user_semester_courses usc
           ON usc.course_id = c.id AND usc.user_id = $1
         WHERE ${courseAccessSql(1, 2)}
         GROUP BY c.id, usc.course_id
         ORDER BY c.title`,
        [req.session.user.id, req.session.user.role]
      ),
    ]);
    res.json({
      profile: profileResult.rows[0] || null,
      courses: coursesResult.rows.map((course) => ({
        ...course,
        id: Number(course.id),
        slide_count: Number(course.slide_count),
      })),
    });
  } catch (error) {
    console.error('Could not load semester planner:', error.message);
    res.status(500).json({ error: 'Could not load your semester planner.' });
  }
});

router.put('/semester', requireAuth, requireRole('editor', 'student'), async (req, res) => {
  const program = typeof req.body?.program === 'string' ? req.body.program.trim() : '';
  const semester = typeof req.body?.semester === 'string' ? req.body.semester.trim() : '';
  const courseIds = req.body?.courseIds === undefined ? [] : req.body.courseIds;
  const courseNames = req.body?.courseNames;
  if (!program || program.length > 120 || semester.length > 80 ||
      !Array.isArray(courseIds) || courseIds.length > 50 ||
      courseIds.some((id) => !Number.isSafeInteger(Number(id)) || Number(id) < 1)) {
    return res.status(400).json({
      error: 'Enter your program, choose or type semester courses, and keep the semester name within 80 characters.',
    });
  }

  if (courseNames !== undefined &&
      (!Array.isArray(courseNames) || courseNames.length > 50 ||
       courseNames.some((name) => typeof name !== 'string' || !name.trim() || name.trim().length > 120))) {
    return res.status(400).json({ error: 'Enter up to 50 course names, each no longer than 120 characters.' });
  }

  const normalizedCourseNames = [...new Set((courseNames || []).map((name) => name.trim()))];
  if (normalizedCourseNames.length + courseIds.length < 1 ||
      normalizedCourseNames.length + courseIds.length > 50) {
    return res.status(400).json({ error: 'Choose or type between 1 and 50 courses for this semester.' });
  }
  const selectedIds = [...new Set(courseIds.map(Number))];
  if (selectedIds.length !== courseIds.length) {
    return res.status(400).json({ error: 'The semester course selection contains duplicates.' });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    if (selectedIds.length) {
      const accessible = await client.query(
        `SELECT c.id
         FROM courses c
         WHERE c.id = ANY($1::integer[]) AND ${courseAccessSql(2, 3)}`,
        [selectedIds, req.session.user.id, req.session.user.role]
      );
      if (accessible.rows.length !== selectedIds.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'One or more selected courses are no longer available.' });
      }
    }

    let resolvedIds = [...selectedIds];
    if (normalizedCourseNames.length) {
      const matchingCourses = await client.query(
        `SELECT DISTINCT ON (LOWER(c.title)) c.id, LOWER(c.title) AS normalized_title
         FROM courses c
         WHERE LOWER(c.title) = ANY($1::text[])
           AND ${courseAccessSql(2, 3)}
         ORDER BY LOWER(c.title), c.id`,
        [normalizedCourseNames.map((name) => name.toLowerCase()), req.session.user.id, req.session.user.role]
      );
      const matchedTitles = new Set(matchingCourses.rows.map((course) => course.normalized_title));
      const missingNames = normalizedCourseNames.filter((name) => !matchedTitles.has(name.toLowerCase()));
      if (missingNames.length) {
        await client.query(
          `INSERT INTO courses (title, description, created_by)
           SELECT missing.title, '', $1
           FROM unnest($2::varchar[]) AS missing(title)`,
          [req.session.user.id, missingNames]
        );
      }
      const namedCourses = await client.query(
        `SELECT DISTINCT ON (LOWER(c.title)) c.id
         FROM courses c
         WHERE LOWER(c.title) = ANY($1::text[])
           AND ${courseAccessSql(2, 3)}
         ORDER BY LOWER(c.title), c.id`,
        [normalizedCourseNames.map((name) => name.toLowerCase()), req.session.user.id, req.session.user.role]
      );
      resolvedIds = [...new Set([...resolvedIds, ...namedCourses.rows.map((course) => Number(course.id))])];
    }

    await client.query(
      `INSERT INTO user_semester_profiles (user_id, program_name, semester_name, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id) DO UPDATE
       SET program_name = EXCLUDED.program_name,
           semester_name = EXCLUDED.semester_name,
           updated_at = NOW()`,
      [req.session.user.id, program, semester]
    );
    await client.query(
      'DELETE FROM user_semester_courses WHERE user_id = $1',
      [req.session.user.id]
    );
    await client.query(
      `INSERT INTO user_semester_courses (user_id, course_id)
       SELECT $1, selected.selected_course_id
       FROM unnest($2::integer[]) AS selected(selected_course_id)`,
      [req.session.user.id, resolvedIds]
    );
    await client.query('COMMIT');
    await cache.deletePrefix('study:');
    res.json({ ok: true, courseCount: resolvedIds.length });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch((rollbackError) => {
      console.error('Could not roll back semester planner update:', rollbackError.message);
    });
    console.error('Could not save semester planner:', error.message);
    res.status(500).json({ error: 'Could not save your semester planner.' });
  } finally {
    client?.release();
  }
});

router.get('/courses/:courseId/notebook', requireAuth, async (req, res) => {
  const courseId = Number(req.params.courseId);
  if (!Number.isSafeInteger(courseId) || courseId < 1) {
    return res.status(400).json({ error: 'Invalid course.' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.original_name, s.size_bytes, s.mime_type, s.created_at,
              (p.slide_id IS NOT NULL) AS is_completed,
              COALESCE(n.note, '') AS note
       FROM course_slides s
       JOIN courses c ON c.id = s.course_id
       LEFT JOIN course_progress p ON p.slide_id = s.id AND p.user_id = $2
       LEFT JOIN course_slide_notes n ON n.slide_id = s.id AND n.user_id = $2
       WHERE c.id = $1 AND ${courseAccessSql(2, 3)}
       ORDER BY s.created_at DESC
       LIMIT 50`,
      [courseId, req.session.user.id, req.session.user.role]
    );
    const courseResult = await pool.query(
      `SELECT c.id, c.title
       FROM courses c
       WHERE c.id = $1 AND ${courseAccessSql(2, 3)}`,
      [courseId, req.session.user.id, req.session.user.role]
    );
    if (!courseResult.rows[0]) return res.status(404).json({ error: 'Course not found.' });
    res.json({
      course: courseResult.rows[0],
      sources: rows,
      aiConfigured: Boolean(process.env.GEMINI_API_KEY),
      model: process.env.GEMINI_MODEL || 'gemini-flash-latest',
    });
  } catch (error) {
    console.error('Could not load course notebook:', error.message);
    res.status(500).json({ error: 'Could not load this course notebook.' });
  }
});

router.post('/courses/:courseId/notebook/chat', requireAuth, requireRole('editor', 'student'), async (req, res) => {
  const courseId = Number(req.params.courseId);
  const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
  const sourceIds = req.body?.sourceIds;
  const history = req.body?.history;
  if (!Number.isSafeInteger(courseId) || courseId < 1 ||
      !question || question.length > 2000 ||
      !Array.isArray(sourceIds) || sourceIds.length < 1 || sourceIds.length > 12 ||
      sourceIds.some((id) => !Number.isSafeInteger(Number(id)) || Number(id) < 1) ||
      (history !== undefined && (!Array.isArray(history) || history.length > 8))) {
    return res.status(400).json({ error: 'Choose 1–12 sources and enter a question no longer than 2,000 characters.' });
  }

  const selectedIds = [...new Set(sourceIds.map(Number))];
  if (selectedIds.length !== sourceIds.length) {
    return res.status(400).json({ error: 'The source selection contains duplicates.' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.course_id, s.original_name, s.storage_name, s.mime_type
       FROM course_slides s
       JOIN courses c ON c.id = s.course_id
       WHERE c.id = $1 AND s.id = ANY($2::integer[])
         AND ${courseAccessSql(3, 4)}
       ORDER BY s.created_at DESC`,
      [courseId, selectedIds, req.session.user.id, req.session.user.role]
    );
    if (rows.length !== selectedIds.length) {
      return res.status(404).json({ error: 'One or more selected sources are no longer available.' });
    }

    const sources = [];
    for (const row of rows) {
      const storedPath = path.join(uploadDir, path.basename(row.storage_name));
      const extractionPath = path.extname(row.storage_name).toLowerCase() === '.ppt'
        ? await convertPowerPoint(row.storage_name)
        : storedPath;
      const extracted = await extractStudyContent(extractionPath);
      if (!extracted.text) {
        return res.status(422).json({
          error: `${row.original_name} has no selectable text. Scanned PDFs need OCR before the notebook can answer from them.`,
        });
      }
      sources.push({
        id: Number(row.id),
        original_name: row.original_name,
        pages: extracted.pages,
      });
    }

    const result = await askGemini({
      sources,
      question,
      history: Array.isArray(history)
        ? history.filter((message) =>
          message && ['user', 'model'].includes(message.role) && typeof message.text === 'string'
        ).slice(-8)
        : [],
    });
    res.json(result);
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error('Could not answer notebook question:', error.message);
    res.status(status).json({
      error: status === 500 && error.message.startsWith('Could not ')
        ? error.message
        : status === 500
          ? 'Could not answer from the selected sources. Please try again.'
          : error.message,
      retryable: error.retryable ?? (status >= 500 || status === 429),
    });
  }
});

router.get('/courses/:courseId/slides', requireAuth, async (req, res) => {
  const courseId = Number(req.params.courseId);
  if (!Number.isSafeInteger(courseId) || courseId < 1) {
    return res.status(400).json({ error: 'Invalid course.' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.original_name, s.size_bytes, s.created_at,
              (p.slide_id IS NOT NULL) AS is_completed,
              COALESCE(n.note, '') AS note,
              s.mime_type,
              (s.uploaded_by = $2 OR c.created_by = $2 OR $3 IN ('admin', 'editor')) AS can_delete
       FROM course_slides s
       JOIN courses c ON c.id = s.course_id
       LEFT JOIN course_progress p ON p.slide_id = s.id AND p.user_id = $2
       LEFT JOIN course_slide_notes n ON n.slide_id = s.id AND n.user_id = $2
       WHERE s.course_id = $1
         AND ${courseAccessSql(2, 3)}
       ORDER BY s.created_at DESC
       LIMIT 50`,
      [courseId, req.session.user.id, req.session.user.role]
    );
    res.json({ slides: rows });
  } catch (error) {
    console.error('Could not load course files:', error.message);
    res.status(500).json({ error: 'Could not load course files.' });
  }
});

router.post('/courses', requireAuth, requireRole('editor', 'student'), async (req, res) => {
  const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
  const description = typeof req.body.description === 'string' ? req.body.description.trim() : '';
  if (!title || title.length > 120 || description.length > 500) {
    return res.status(400).json({ error: 'Course title is required (up to 120 characters); description must be 500 characters or fewer.' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO courses (title, description, created_by)
       VALUES ($1, $2, $3)
       RETURNING id, title, description, created_at`,
      [title, description, req.session.user.id]
    );
    await cache.deletePrefix('study:');
    res.status(201).json({ course: { ...rows[0], slide_count: 0 } });
  } catch (error) {
    console.error('Could not create course:', error.message);
    res.status(500).json({ error: 'Could not create course.' });
  }
});

async function requireCourseAccess(req, res, next) {
  const courseId = Number(req.params.courseId);
  if (!Number.isSafeInteger(courseId) || courseId < 1) {
    return res.status(400).json({ error: 'Invalid course.' });
  }

  try {
    const { rowCount } = await pool.query(
      `SELECT 1 FROM courses c
       WHERE c.id = $1 AND ${courseAccessSql(2, 3)}`,
      [courseId, req.session.user.id, req.session.user.role]
    );
    if (!rowCount) return res.status(404).json({ error: 'Course not found.' });
    next();
  } catch (error) {
    console.error('Could not validate course access:', error.message);
    res.status(500).json({ error: 'Could not access course.' });
  }
}

router.post(
  '/courses/:courseId/slides',
  requireAuth,
  requireRole('editor', 'student'),
  requireCourseAccess,
  uploadFile,
  async (req, res) => {
    const courseId = Number(req.params.courseId);
    if (!Number.isSafeInteger(courseId) || courseId < 1) {
      if (req.file) await removeUploadedFile(req.file.path);
      return res.status(400).json({ error: 'Invalid course.' });
    }
    if (!req.file) return res.status(400).json({ error: 'Choose a slide file to upload.' });

    let signatureIsValid = false;
    try {
      signatureIsValid = validFileSignature(req.file);
    } catch (error) {
      await removeUploadedFile(req.file.path);
      console.error('Could not inspect uploaded slide:', error.message);
      return res.status(500).json({ error: 'Could not inspect the uploaded file.' });
    }
    if (!signatureIsValid) {
      await removeUploadedFile(req.file.path);
      return res.status(415).json({ error: 'The selected file does not match its file type.' });
    }

    const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
    const originalName = path.basename(title || req.file.originalname).slice(0, 255);
    const ext = path.extname(req.file.originalname).toLowerCase();

    try {
      const { rows } = await pool.query(
        `INSERT INTO course_slides
           (course_id, original_name, storage_name, mime_type, size_bytes, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, course_id, original_name, size_bytes, created_at`,
        [
          courseId,
          originalName,
          req.file.filename,
          allowedTypes[ext],
          req.file.size,
          req.session.user.id,
        ]
      );
      await cache.deletePrefix('study:');
      res.status(201).json({ slide: rows[0] });
    } catch (error) {
      await removeUploadedFile(req.file.path);
      if (error.code === '23503') {
        return res.status(404).json({ error: 'Course not found.' });
      }
      console.error('Could not save slide metadata:', error.message);
      res.status(500).json({ error: 'Could not save the uploaded slide.' });
    }
  }
);

router.put('/courses/:courseId/slides/:slideId/progress', requireAuth, requireRole('editor', 'student'), async (req, res) => {
  const courseId = Number(req.params.courseId);
  const slideId = Number(req.params.slideId);
  const completed = req.body?.completed;
  if (!Number.isSafeInteger(courseId) || courseId < 1 ||
      !Number.isSafeInteger(slideId) || slideId < 1 ||
      typeof completed !== 'boolean') {
    return res.status(400).json({ error: 'Invalid progress update.' });
  }

  try {
    if (completed) {
      const result = await pool.query(
        `INSERT INTO course_progress (user_id, slide_id)
         SELECT $1, s.id
         FROM course_slides s
         JOIN courses c ON c.id = s.course_id
         WHERE s.id = $2 AND s.course_id = $3 AND ${courseAccessSql(1, 4)}
         ON CONFLICT (user_id, slide_id) DO UPDATE SET completed_at = NOW()
         RETURNING completed_at`,
        [req.session.user.id, slideId, courseId, req.session.user.role]
      );
      if (!result.rowCount) return res.status(404).json({ error: 'Slide not found in this course.' });
      await cache.deletePrefix('study:');
      return res.json({ completed: true, completedAt: result.rows[0].completed_at });
    }

    const result = await pool.query(
      `DELETE FROM course_progress p
       USING course_slides s
       JOIN courses c ON c.id = s.course_id
       WHERE p.slide_id = s.id
         AND p.user_id = $1
         AND s.id = $2
         AND s.course_id = $3
         AND ${courseAccessSql(1, 4)}`,
      [req.session.user.id, slideId, courseId, req.session.user.role]
    );
    if (!result.rowCount) {
      const exists = await pool.query(
        `SELECT 1
         FROM course_slides s
         JOIN courses c ON c.id = s.course_id
         WHERE s.id = $1 AND s.course_id = $2 AND ${courseAccessSql(3, 4)}`,
        [slideId, courseId, req.session.user.id, req.session.user.role]
      );
      if (!exists.rowCount) return res.status(404).json({ error: 'Slide not found in this course.' });
    }
    await cache.deletePrefix('study:');
    res.json({ completed: false });
  } catch (error) {
    console.error('Could not update slide progress:', error.message);
    res.status(500).json({ error: 'Could not update slide progress.' });
  }
});

router.put('/courses/:courseId/slides/:slideId/note', requireAuth, requireRole('editor', 'student'), async (req, res) => {
  const courseId = Number(req.params.courseId);
  const slideId = Number(req.params.slideId);
  const note = req.body?.note;
  if (!Number.isSafeInteger(courseId) || courseId < 1 ||
      !Number.isSafeInteger(slideId) || slideId < 1 ||
      typeof note !== 'string' || note.length > 10000) {
    return res.status(400).json({ error: 'Notes must be text no longer than 10,000 characters.' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO course_slide_notes (user_id, slide_id, note)
       SELECT $1, s.id, $4
       FROM course_slides s
       JOIN courses c ON c.id = s.course_id
       WHERE s.id = $2 AND s.course_id = $3 AND ${courseAccessSql(1, 5)}
       ON CONFLICT (user_id, slide_id)
       DO UPDATE SET note = EXCLUDED.note, updated_at = NOW()
       RETURNING updated_at`,
      [req.session.user.id, slideId, courseId, note.trim(), req.session.user.role]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Slide not found in this course.' });
    await cache.deletePrefix('study:');
    res.json({ saved: true, updatedAt: result.rows[0].updated_at });
  } catch (error) {
    console.error('Could not save study note:', error.message);
    res.status(500).json({ error: 'Could not save your note.' });
  }
});

router.delete(
  '/courses/:courseId/slides/:slideId',
  requireAuth,
  requireRole('editor', 'student'),
  async (req, res) => {
    const courseId = Number(req.params.courseId);
    const slideId = Number(req.params.slideId);
    if (!Number.isSafeInteger(courseId) || courseId < 1 || !Number.isSafeInteger(slideId) || slideId < 1) {
      return res.status(400).json({ error: 'Invalid slide.' });
    }

    try {
      const result = await pool.query(
        `DELETE FROM course_slides s
         USING courses c
         WHERE s.course_id = c.id
           AND s.id = $1
           AND s.course_id = $2
           AND ${courseAccessSql(3, 4)}
           AND ($4 IN ('admin', 'editor') OR s.uploaded_by = $3 OR c.created_by = $3)
         RETURNING s.storage_name`,
        [slideId, courseId, req.session.user.id, req.session.user.role]
      );
      if (!result.rowCount) return res.status(404).json({ error: 'Slide not found or you cannot delete it.' });

      await cache.deletePrefix('study:');
      const filePath = path.join(uploadDir, path.basename(result.rows[0].storage_name));
      try {
        await fs.promises.unlink(filePath);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          console.error('Slide record deleted but stored file cleanup failed:', error.message);
          return res.status(200).json({
            deleted: true,
            warning: 'Slide removed, but its stored file could not be cleaned up.',
          });
        }
      }
      try {
        await removePowerPointPreview(result.rows[0].storage_name);
      } catch (error) {
        console.error('Slide deleted but its generated preview cleanup failed:', error.message);
      }
      res.json({ deleted: true });
    } catch (error) {
      console.error('Could not delete slide:', error.message);
      res.status(500).json({ error: 'Could not delete the slide.' });
    }
  }
);

router.get('/courses/:courseId/slides/:slideId/view', requireAuth, async (req, res) => {
  const courseId = Number(req.params.courseId);
  const slideId = Number(req.params.slideId);
  if (!Number.isSafeInteger(courseId) || courseId < 1 || !Number.isSafeInteger(slideId) || slideId < 1) {
    return res.status(400).json({ error: 'Invalid slide.' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT s.original_name, s.storage_name, s.mime_type
       FROM course_slides s
       JOIN courses c ON c.id = s.course_id
       WHERE s.id = $1 AND s.course_id = $2 AND ${courseAccessSql(3, 4)}`,
      [slideId, courseId, req.session.user.id, req.session.user.role]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Slide not found.' });
    const isPdf = rows[0].mime_type === 'application/pdf';
    const filePath = isPdf
      ? path.join(uploadDir, path.basename(rows[0].storage_name))
      : await convertPowerPoint(rows[0].storage_name);
    res.type('application/pdf');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(filePath, (error) => {
      if (error && !res.headersSent) {
        if (error.code === 'ENOENT') return res.status(404).json({ error: 'Slide file not found.' });
        console.error('Could not preview slide:', error.message);
        res.status(500).json({ error: 'Could not open slide.' });
      }
    });
  } catch (error) {
    console.error('Could not find slide to preview:', error.message);
    res.status(500).json({ error: 'Could not open slide.' });
  }
});

router.get('/courses/:courseId/slides/:slideId/download', requireAuth, async (req, res) => {
  const courseId = Number(req.params.courseId);
  const slideId = Number(req.params.slideId);
  if (!Number.isSafeInteger(courseId) || !Number.isSafeInteger(slideId)) {
    return res.status(400).json({ error: 'Invalid slide.' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT s.original_name, s.storage_name
       FROM course_slides s
       JOIN courses c ON c.id = s.course_id
       WHERE s.id = $1 AND s.course_id = $2 AND ${courseAccessSql(3, 4)}`,
      [slideId, courseId, req.session.user.id, req.session.user.role]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Slide not found.' });

    const storageName = path.basename(rows[0].storage_name);
    const filePath = path.join(uploadDir, storageName);
    res.download(filePath, rows[0].original_name, (error) => {
      if (error && !res.headersSent) {
        if (error.code === 'ENOENT') return res.status(404).json({ error: 'Slide file not found.' });
        console.error('Could not download slide:', error.message);
        res.status(500).json({ error: 'Could not download slide.' });
      }
    });
  } catch (error) {
    console.error('Could not find slide:', error.message);
    res.status(500).json({ error: 'Could not download slide.' });
  }
});

module.exports = router;

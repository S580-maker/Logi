const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const os = require('node:os');
const path = require('path');
const pool = require('../db/pool');
const cache = require('../utils/cache');
const { requireAuth, requireRole } = require('../middleware/validate');

const router = express.Router();
const canCreateGroup = requireRole('admin', 'manager', 'editor', 'instructor', 'content_manager', 'student');
const groupIdSql = /^\d+$/;
const groupStorageDir = process.env.VERCEL
  ? path.join(os.tmpdir(), 'logiauth-storage')
  : path.join(__dirname, '..', 'storage');
const groupUploadDir = path.join(groupStorageDir, 'slides');
const groupMaterialTypes = {
  '.pdf': 'application/pdf',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain',
};
fs.mkdirSync(groupUploadDir, { recursive: true });
const groupUpload = multer({
  storage: multer.diskStorage({
    destination: groupUploadDir,
    filename: (req, file, callback) => {
      callback(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (!Object.hasOwn(groupMaterialTypes, extension)) {
      const error = new Error('Choose a PDF, PowerPoint, Word, or text file.');
      error.status = 415;
      callback(error);
      return;
    }
    callback(null, true);
  },
});

function handleGroupUpload(req, res, next) {
  groupUpload.single('file')(req, res, (error) => {
    if (!error) return next();
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : error.status || 400;
    res.status(status).json({
      error: status === 413 ? 'Group files must be 25 MB or smaller.' : error.message,
    });
  });
}

function isValidDueDate(value) {
  if (value === null || value === '') return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

async function removeStoredUpload(storageName) {
  try {
    await fs.promises.unlink(path.join(groupUploadDir, path.basename(storageName)));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function parseGroupId(value) {
  if (typeof value !== 'string' || !groupIdSql.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function getMemberRole(groupId, userId) {
  const result = await pool.query(
    'SELECT role FROM study_group_members WHERE group_id = $1 AND user_id = $2',
    [groupId, userId]
  );
  return result.rows[0]?.role || null;
}

async function requireGroupMember(req, res, next) {
  const groupId = parseGroupId(req.params.groupId);
  if (!groupId) return res.status(400).json({ error: 'Invalid study group.' });
  try {
    const role = await getMemberRole(groupId, req.session.user.id);
    if (!role) return res.status(404).json({ error: 'Study group not found.' });
    req.studyGroupId = groupId;
    req.studyGroupRole = role;
    next();
  } catch (error) {
    console.error('Could not verify study group membership:', error.message);
    res.status(500).json({ error: 'Could not access this study group.' });
  }
}

router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT g.id, g.name, g.description, g.join_code, g.discoverable, g.created_at,
              gm.role AS member_role,
              (SELECT COUNT(*)::integer FROM study_group_members members WHERE members.group_id = g.id) AS member_count,
              (SELECT COUNT(*)::integer FROM study_group_courses courses WHERE courses.group_id = g.id) AS course_count
       FROM study_groups g
       JOIN study_group_members gm ON gm.group_id = g.id AND gm.user_id = $1
       ORDER BY g.name`,
      [req.session.user.id]
    );
    res.json({ groups: rows });
  } catch (error) {
    console.error('Could not load study groups:', error.message);
    res.status(500).json({ error: 'Could not load your study groups.' });
  }
});

router.get('/discover', requireAuth, async (req, res) => {
  const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 80) : '';
  try {
    const { rows } = await pool.query(
      `SELECT g.id, g.name, g.description, g.created_at,
              (SELECT COUNT(*)::integer FROM study_group_members members WHERE members.group_id = g.id) AS member_count
       FROM study_groups g
       WHERE g.discoverable = TRUE
         AND ($1 = '' OR g.name ILIKE '%' || $1 || '%' OR g.description ILIKE '%' || $1 || '%')
         AND NOT EXISTS (
           SELECT 1 FROM study_group_members gm
           WHERE gm.group_id = g.id AND gm.user_id = $2
         )
       ORDER BY member_count DESC, g.name
       LIMIT 30`,
      [search, req.session.user.id]
    );
    res.json({ groups: rows });
  } catch (error) {
    console.error('Could not find study groups:', error.message);
    res.status(500).json({ error: 'Could not search for study groups.' });
  }
});

router.get('/available-courses', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.title
       FROM courses c
       WHERE c.created_by = $1
          OR $2 IN ('admin', 'editor')
          OR (
            c.created_by IS NULL
            AND EXISTS (
              SELECT 1
              FROM study_group_members gm
              WHERE gm.user_id = $1 AND gm.role = 'owner'
            )
          )
       ORDER BY c.title
       LIMIT 100`,
      [req.session.user.id, req.session.user.role]
    );
    res.json({ courses: rows });
  } catch (error) {
    console.error('Could not load courses available to share:', error.message);
    res.status(500).json({ error: 'Could not load courses available to share.' });
  }
});

router.post('/', requireAuth, canCreateGroup, async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
  const discoverable = req.body?.discoverable;
  if (!name || name.length > 120 || description.length > 500 || typeof discoverable !== 'boolean') {
    return res.status(400).json({
      error: 'Enter a group name (up to 120 characters), description (up to 500 characters), and choose its visibility.',
    });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const joinCode = crypto.randomBytes(5).toString('hex').toUpperCase().slice(0, 8);
    const { rows } = await client.query(
      `INSERT INTO study_groups (name, description, join_code, discoverable, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, description, join_code, discoverable, created_at`,
      [name, description, joinCode, discoverable, req.session.user.id]
    );
    const group = rows[0];
    await client.query(
      `INSERT INTO study_group_members (group_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [group.id, req.session.user.id]
    );
    await client.query('COMMIT');
    await cache.deletePrefix('study:');
    res.status(201).json({ group: { ...group, member_role: 'owner', member_count: 1, course_count: 0 } });
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    console.error('Could not create study group:', error.message);
    res.status(500).json({ error: 'Could not create study group.' });
  } finally {
    client?.release();
  }
});

router.post('/join', requireAuth, canCreateGroup, async (req, res) => {
  const joinCode = typeof req.body?.joinCode === 'string'
    ? req.body.joinCode.trim().toUpperCase()
    : '';
  if (!/^[A-F0-9]{8}$/.test(joinCode)) {
    return res.status(400).json({ error: 'Enter a valid 8-character group invite code.' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO study_group_members (group_id, user_id, role)
       SELECT id, $2, 'member'
       FROM study_groups
       WHERE join_code = $1
       ON CONFLICT (group_id, user_id) DO NOTHING
       RETURNING group_id`,
      [joinCode, req.session.user.id]
    );
    if (!result.rowCount) {
      const existing = await pool.query(
        `SELECT g.id
         FROM study_groups g
         WHERE g.join_code = $1
           AND EXISTS (
             SELECT 1 FROM study_group_members gm
             WHERE gm.group_id = g.id AND gm.user_id = $2
           )`,
        [joinCode, req.session.user.id]
      );
      if (!existing.rowCount) return res.status(404).json({ error: 'No group matches that invite code.' });
    }
    await cache.deletePrefix('study:');
    res.json({ joined: true });
  } catch (error) {
    console.error('Could not join study group by code:', error.message);
    res.status(500).json({ error: 'Could not join this study group.' });
  }
});

router.post('/:groupId/join', requireAuth, canCreateGroup, async (req, res) => {
  const groupId = parseGroupId(req.params.groupId);
  const inviteCode = typeof req.body?.joinCode === 'string'
    ? req.body.joinCode.trim().toUpperCase()
    : '';
  if (!groupId) return res.status(400).json({ error: 'Invalid study group.' });
  try {
    const result = await pool.query(
      `INSERT INTO study_group_members (group_id, user_id, role)
       SELECT id, $2, 'member'
       FROM study_groups
       WHERE id = $1
         AND (discoverable = TRUE OR join_code = $3)
       ON CONFLICT (group_id, user_id) DO NOTHING
       RETURNING group_id`,
      [groupId, req.session.user.id, inviteCode]
    );
    if (!result.rowCount) {
      const existing = await pool.query(
        `SELECT g.id
         FROM study_groups g
         JOIN study_group_members gm ON gm.group_id = g.id
         WHERE g.id = $1 AND gm.user_id = $2`,
        [groupId, req.session.user.id]
      );
      if (!existing.rowCount) {
        return res.status(404).json({ error: 'This group is private or no longer available. Check its invite code.' });
      }
    }
    await cache.deletePrefix('study:');
    res.json({ joined: true });
  } catch (error) {
    console.error('Could not join study group:', error.message);
    res.status(500).json({ error: 'Could not join this study group.' });
  }
});

router.get('/:groupId', requireAuth, requireGroupMember, async (req, res) => {
  try {
    const [groupResult, coursesResult, suggestionsResult, commentsResult, membersResult, messagesResult, materialsResult, tasksResult] = await Promise.all([
      pool.query(
        `SELECT g.id, g.name, g.description, g.join_code, g.discoverable, g.created_at,
                gm.role AS member_role,
                (SELECT COUNT(*)::integer FROM study_group_members members WHERE members.group_id = g.id) AS member_count
         FROM study_groups g
         JOIN study_group_members gm ON gm.group_id = g.id AND gm.user_id = $2
         WHERE g.id = $1`,
        [req.studyGroupId, req.session.user.id]
      ),
      pool.query(
        `SELECT c.id, c.title, c.description,
                COUNT(DISTINCT s.id)::integer AS slide_count,
                COUNT(DISTINCT p.slide_id)::integer AS completed_count,
                sgc.added_at,
                owner.username AS course_owner
         FROM study_group_courses sgc
         JOIN courses c ON c.id = sgc.course_id
         LEFT JOIN users owner ON owner.id = c.created_by
         LEFT JOIN course_slides s ON s.course_id = c.id
         LEFT JOIN course_progress p ON p.slide_id = s.id AND p.user_id = $2
         WHERE sgc.group_id = $1
         GROUP BY c.id, sgc.added_at, owner.username
         ORDER BY c.title`,
        [req.studyGroupId, req.session.user.id]
      ),
      pool.query(
        `SELECT s.id, s.title, s.body, s.created_at, u.username,
                (s.user_id = $2 OR gm.role = 'owner') AS can_delete
         FROM study_group_suggestions s
         LEFT JOIN users u ON u.id = s.user_id
         JOIN study_group_members gm ON gm.group_id = s.group_id AND gm.user_id = $2
         WHERE s.group_id = $1
         ORDER BY s.created_at DESC
         LIMIT 100`,
        [req.studyGroupId, req.session.user.id]
      ),
      pool.query(
        `SELECT c.id, c.suggestion_id, c.body, c.created_at, u.username,
                (c.user_id = $2 OR gm.role = 'owner') AS can_delete
         FROM study_group_suggestion_comments c
         JOIN study_group_suggestions s ON s.id = c.suggestion_id AND s.group_id = $1
         LEFT JOIN users u ON u.id = c.user_id
         JOIN study_group_members gm ON gm.group_id = s.group_id AND gm.user_id = $2
         ORDER BY c.created_at`,
        [req.studyGroupId, req.session.user.id]
      ),
      pool.query(
        `SELECT u.id AS user_id, u.username, gm.role, gm.joined_at
         FROM study_group_members gm
         JOIN users u ON u.id = gm.user_id
         WHERE gm.group_id = $1
         ORDER BY (gm.role = 'owner') DESC, u.username
         LIMIT 100`,
        [req.studyGroupId]
      ),
      pool.query(
        `SELECT m.id, m.body, m.created_at, u.username,
                (m.user_id = $2) AS is_mine,
                (m.user_id = $2 OR gm.role = 'owner') AS can_delete
         FROM study_group_messages m
         JOIN users u ON u.id = m.user_id
         JOIN study_group_members gm ON gm.group_id = m.group_id AND gm.user_id = $2
         WHERE m.group_id = $1
         ORDER BY m.created_at DESC
         LIMIT 100`,
        [req.studyGroupId, req.session.user.id]
      ),
      pool.query(
        `SELECT f.id, f.original_name, f.mime_type, f.size_bytes, f.created_at, u.username,
                (f.user_id = $2 OR gm.role = 'owner') AS can_delete
         FROM study_group_materials f
         LEFT JOIN users u ON u.id = f.user_id
         JOIN study_group_members gm ON gm.group_id = f.group_id AND gm.user_id = $2
         WHERE f.group_id = $1
         ORDER BY f.created_at DESC
         LIMIT 100`,
        [req.studyGroupId, req.session.user.id]
      ),
      pool.query(
        `SELECT t.id, t.task_type, t.title, t.description, t.due_date, t.status, t.created_at,
                creator.username AS created_by_name, assignee.id AS assigned_to, assignee.username AS assigned_to_name,
                ($2 = t.assigned_to OR t.assigned_to IS NULL OR gm.role = 'owner') AS can_update
         FROM study_group_tasks t
         LEFT JOIN users creator ON creator.id = t.created_by
         LEFT JOIN users assignee ON assignee.id = t.assigned_to
         JOIN study_group_members gm ON gm.group_id = t.group_id AND gm.user_id = $2
         WHERE t.group_id = $1
         ORDER BY (t.status = 'complete'), t.due_date NULLS LAST, t.created_at DESC
         LIMIT 100`,
        [req.studyGroupId, req.session.user.id]
      ),
    ]);
    if (!groupResult.rowCount) return res.status(404).json({ error: 'Study group not found.' });
    const commentsBySuggestion = new Map();
    commentsResult.rows.forEach((comment) => {
      const list = commentsBySuggestion.get(String(comment.suggestion_id)) || [];
      list.push(comment);
      commentsBySuggestion.set(String(comment.suggestion_id), list);
    });
    res.json({
      group: groupResult.rows[0],
      courses: coursesResult.rows.map((course) => ({
        ...course,
        id: Number(course.id),
        slide_count: Number(course.slide_count),
        completed_count: Number(course.completed_count),
      })),
      suggestions: suggestionsResult.rows.map((suggestion) => ({
        ...suggestion,
        comments: commentsBySuggestion.get(String(suggestion.id)) || [],
      })),
      members: membersResult.rows,
      messages: messagesResult.rows.reverse(),
      materials: materialsResult.rows,
      tasks: tasksResult.rows,
    });
  } catch (error) {
    console.error('Could not load study group:', error.message);
    res.status(500).json({ error: 'Could not load this study group.' });
  }
});

router.get('/:groupId/messages', requireAuth, requireGroupMember, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT m.id, m.body, m.created_at, u.username,
              (m.user_id = $2) AS is_mine,
              (m.user_id = $2 OR gm.role = 'owner') AS can_delete
       FROM study_group_messages m
       JOIN users u ON u.id = m.user_id
       JOIN study_group_members gm ON gm.group_id = m.group_id AND gm.user_id = $2
       WHERE m.group_id = $1
       ORDER BY m.created_at DESC
       LIMIT 100`,
      [req.studyGroupId, req.session.user.id]
    );
    res.json({ messages: rows.reverse() });
  } catch (error) {
    console.error('Could not load group chat:', error.message);
    res.status(500).json({ error: 'Could not load group chat.' });
  }
});

router.post('/:groupId/messages', requireAuth, canCreateGroup, requireGroupMember, async (req, res) => {
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  if (!body || body.length > 2000) {
    return res.status(400).json({ error: 'Enter a chat message no longer than 2,000 characters.' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO study_group_messages (group_id, user_id, body)
       VALUES ($1, $2, $3)
       RETURNING id, body, created_at`,
      [req.studyGroupId, req.session.user.id, body]
    );
    res.status(201).json({
      message: { ...rows[0], username: req.session.user.username, is_mine: true, can_delete: true },
    });
  } catch (error) {
    console.error('Could not send group chat message:', error.message);
    res.status(500).json({ error: 'Could not send this message.' });
  }
});

router.delete('/:groupId/messages/:messageId', requireAuth, requireGroupMember, async (req, res) => {
  const messageId = Number(req.params.messageId);
  if (!Number.isSafeInteger(messageId) || messageId < 1) {
    return res.status(400).json({ error: 'Invalid chat message.' });
  }
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM study_group_messages
       WHERE id = $1 AND group_id = $2
         AND (user_id = $3 OR $4 = 'owner')`,
      [messageId, req.studyGroupId, req.session.user.id, req.studyGroupRole]
    );
    if (!rowCount) return res.status(404).json({ error: 'Message not found or cannot be removed.' });
    res.json({ removed: true });
  } catch (error) {
    console.error('Could not remove group chat message:', error.message);
    res.status(500).json({ error: 'Could not remove this message.' });
  }
});

router.post('/:groupId/materials', requireAuth, canCreateGroup, requireGroupMember, handleGroupUpload, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a file to share with the group.' });
  const originalName = path.basename(req.file.originalname).slice(0, 255);
  const extension = path.extname(req.file.originalname).toLowerCase();
  try {
    const { rows } = await pool.query(
      `INSERT INTO study_group_materials
         (group_id, user_id, original_name, storage_name, mime_type, size_bytes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, original_name, mime_type, size_bytes, created_at`,
      [
        req.studyGroupId,
        req.session.user.id,
        originalName,
        path.basename(req.file.filename),
        groupMaterialTypes[extension],
        req.file.size,
      ]
    );
    res.status(201).json({
      material: { ...rows[0], username: req.session.user.username, can_delete: true },
    });
  } catch (error) {
    try {
      await removeStoredUpload(req.file.filename);
    } catch (cleanupError) {
      console.error('Could not remove incomplete group upload:', cleanupError.message);
    }
    console.error('Could not save group material:', error.message);
    res.status(500).json({ error: 'Could not save this group file.' });
  }
});

router.get('/:groupId/materials/:materialId/file', requireAuth, requireGroupMember, async (req, res) => {
  const materialId = Number(req.params.materialId);
  if (!Number.isSafeInteger(materialId) || materialId < 1) {
    return res.status(400).json({ error: 'Invalid group file.' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT original_name, storage_name
       FROM study_group_materials
       WHERE id = $1 AND group_id = $2`,
      [materialId, req.studyGroupId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Group file not found.' });
    const filePath = path.join(groupUploadDir, path.basename(rows[0].storage_name));
    res.download(filePath, rows[0].original_name, (error) => {
      if (error && !res.headersSent) {
        console.error('Could not send group file:', error.message);
        res.status(error.code === 'ENOENT' ? 404 : 500).json({
          error: error.code === 'ENOENT' ? 'The group file is no longer available.' : 'Could not download this group file.',
        });
      }
    });
  } catch (error) {
    console.error('Could not retrieve group file:', error.message);
    res.status(500).json({ error: 'Could not retrieve this group file.' });
  }
});

router.delete('/:groupId/materials/:materialId', requireAuth, requireGroupMember, async (req, res) => {
  const materialId = Number(req.params.materialId);
  if (!Number.isSafeInteger(materialId) || materialId < 1) {
    return res.status(400).json({ error: 'Invalid group file.' });
  }
  try {
    const { rows } = await pool.query(
      `DELETE FROM study_group_materials
       WHERE id = $1 AND group_id = $2
         AND (user_id = $3 OR $4 = 'owner')
       RETURNING storage_name`,
      [materialId, req.studyGroupId, req.session.user.id, req.studyGroupRole]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Group file not found or cannot be removed.' });
    try {
      await removeStoredUpload(rows[0].storage_name);
    } catch (error) {
      console.error('Could not remove deleted group file from storage:', error.message);
    }
    res.json({ removed: true });
  } catch (error) {
    console.error('Could not remove group file:', error.message);
    res.status(500).json({ error: 'Could not remove this group file.' });
  }
});

router.post('/:groupId/tasks', requireAuth, canCreateGroup, requireGroupMember, async (req, res) => {
  if (req.studyGroupRole !== 'owner') return res.status(403).json({ error: 'Only the group leader can create goals and tasks.' });
  const taskType = req.body?.taskType;
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
  const dueDate = req.body?.dueDate || null;
  const assignedTo = req.body?.assignedTo ? Number(req.body.assignedTo) : null;
  if (!['goal', 'task'].includes(taskType) || !title || title.length > 120 ||
      description.length > 1000 || !isValidDueDate(dueDate) ||
      (assignedTo !== null && (!Number.isSafeInteger(assignedTo) || assignedTo < 1))) {
    return res.status(400).json({ error: 'Enter a valid goal or task, description, due date, and group-member assignee.' });
  }
  try {
    if (assignedTo !== null) {
      const member = await pool.query(
        'SELECT 1 FROM study_group_members WHERE group_id = $1 AND user_id = $2',
        [req.studyGroupId, assignedTo]
      );
      if (!member.rowCount) return res.status(400).json({ error: 'Choose a current member of this group.' });
    }
    const { rows } = await pool.query(
      `INSERT INTO study_group_tasks
         (group_id, created_by, assigned_to, task_type, title, description, due_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, task_type, title, description, due_date, status, created_at`,
      [req.studyGroupId, req.session.user.id, assignedTo, taskType, title, description, dueDate]
    );
    res.status(201).json({ task: rows[0] });
  } catch (error) {
    console.error('Could not create group goal or task:', error.message);
    res.status(500).json({ error: 'Could not create this goal or task.' });
  }
});

router.patch('/:groupId/tasks/:taskId', requireAuth, canCreateGroup, requireGroupMember, async (req, res) => {
  const taskId = Number(req.params.taskId);
  const status = req.body?.status;
  if (!Number.isSafeInteger(taskId) || taskId < 1 ||
      !['planned', 'in_progress', 'complete'].includes(status)) {
    return res.status(400).json({ error: 'Choose a valid task and status.' });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE study_group_tasks t
       SET status = $4
       WHERE t.id = $1 AND t.group_id = $2
         AND (t.assigned_to = $3 OR t.assigned_to IS NULL OR $5 = 'owner')
       RETURNING t.id, t.status`,
      [taskId, req.studyGroupId, req.session.user.id, status, req.studyGroupRole]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Goal or task not found, or it is assigned to another member.' });
    res.json({ task: rows[0] });
  } catch (error) {
    console.error('Could not update group task status:', error.message);
    res.status(500).json({ error: 'Could not update this goal or task.' });
  }
});

router.delete('/:groupId/tasks/:taskId', requireAuth, requireGroupMember, async (req, res) => {
  if (req.studyGroupRole !== 'owner') return res.status(403).json({ error: 'Only the group leader can remove goals and tasks.' });
  const taskId = Number(req.params.taskId);
  if (!Number.isSafeInteger(taskId) || taskId < 1) {
    return res.status(400).json({ error: 'Invalid goal or task.' });
  }
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM study_group_tasks WHERE id = $1 AND group_id = $2',
      [taskId, req.studyGroupId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Goal or task not found.' });
    res.json({ removed: true });
  } catch (error) {
    console.error('Could not remove group goal or task:', error.message);
    res.status(500).json({ error: 'Could not remove this goal or task.' });
  }
});

router.post('/:groupId/courses', requireAuth, canCreateGroup, requireGroupMember, async (req, res) => {
  const courseId = Number(req.body?.courseId);
  if (!Number.isSafeInteger(courseId) || courseId < 1) {
    return res.status(400).json({ error: 'Choose a valid course to share.' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO study_group_courses (group_id, course_id, added_by)
       SELECT $1, c.id, $3
       FROM courses c
       WHERE c.id = $2
         AND (
           c.created_by = $3
           OR $4 IN ('admin', 'editor')
           OR (c.created_by IS NULL AND $5 = 'owner')
         )
       ON CONFLICT (group_id, course_id) DO NOTHING
       RETURNING course_id`,
      [req.studyGroupId, courseId, req.session.user.id, req.session.user.role, req.studyGroupRole]
    );
    if (!rows.length) {
      const courseResult = await pool.query('SELECT id FROM courses WHERE id = $1', [courseId]);
      if (!courseResult.rowCount) return res.status(404).json({ error: 'Course not found.' });
      const linked = await pool.query(
        'SELECT 1 FROM study_group_courses WHERE group_id = $1 AND course_id = $2',
        [req.studyGroupId, courseId]
      );
      if (!linked.rowCount) {
        return res.status(403).json({ error: 'Only the course owner, a site editor, or this group’s owner can share that course.' });
      }
      return res.status(409).json({ error: 'This course is already shared with the group.' });
    }
    await cache.deletePrefix('study:');
    res.status(201).json({ shared: true });
  } catch (error) {
    console.error('Could not share course with study group:', error.message);
    res.status(500).json({ error: 'Could not share this course with the group.' });
  }
});

router.delete('/:groupId/courses/:courseId', requireAuth, requireGroupMember, async (req, res) => {
  const courseId = Number(req.params.courseId);
  if (!Number.isSafeInteger(courseId) || courseId < 1) {
    return res.status(400).json({ error: 'Invalid course.' });
  }
  if (req.studyGroupRole !== 'owner') return res.status(403).json({ error: 'Only this group’s owner can remove a shared course.' });
  try {
    const result = await pool.query(
      'DELETE FROM study_group_courses WHERE group_id = $1 AND course_id = $2',
      [req.studyGroupId, courseId]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Shared course not found.' });
    await cache.deletePrefix('study:');
    res.json({ removed: true });
  } catch (error) {
    console.error('Could not remove course from study group:', error.message);
    res.status(500).json({ error: 'Could not remove this shared course.' });
  }
});

router.post('/:groupId/suggestions', requireAuth, canCreateGroup, requireGroupMember, async (req, res) => {
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  if (!title || title.length > 120 || !body || body.length > 2000) {
    return res.status(400).json({ error: 'Enter a suggestion title (up to 120 characters) and details (up to 2,000 characters).' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO study_group_suggestions (group_id, user_id, title, body)
       VALUES ($1, $2, $3, $4)
       RETURNING id, title, body, created_at`,
      [req.studyGroupId, req.session.user.id, title, body]
    );
    await cache.deletePrefix('study:');
    res.status(201).json({ suggestion: { ...rows[0], username: req.session.user.username, can_delete: true } });
  } catch (error) {
    console.error('Could not post group suggestion:', error.message);
    res.status(500).json({ error: 'Could not post this suggestion.' });
  }
});

router.delete('/:groupId/suggestions/:suggestionId', requireAuth, requireGroupMember, async (req, res) => {
  const suggestionId = Number(req.params.suggestionId);
  if (!Number.isSafeInteger(suggestionId) || suggestionId < 1) {
    return res.status(400).json({ error: 'Invalid suggestion.' });
  }
  try {
    const result = await pool.query(
      `DELETE FROM study_group_suggestions
       WHERE id = $1 AND group_id = $2
         AND (user_id = $3 OR $4 = 'owner')`,
      [suggestionId, req.studyGroupId, req.session.user.id, req.studyGroupRole]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Suggestion not found or cannot be removed.' });
    await cache.deletePrefix('study:');
    res.json({ removed: true });
  } catch (error) {
    console.error('Could not remove group suggestion:', error.message);
    res.status(500).json({ error: 'Could not remove this suggestion.' });
  }
});

router.post('/:groupId/suggestions/:suggestionId/comments', requireAuth, canCreateGroup, requireGroupMember, async (req, res) => {
  const suggestionId = Number(req.params.suggestionId);
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  if (!Number.isSafeInteger(suggestionId) || suggestionId < 1 || !body || body.length > 1000) {
    return res.status(400).json({ error: 'Enter a comment no longer than 1,000 characters.' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO study_group_suggestion_comments (suggestion_id, user_id, body)
       SELECT s.id, $3, $4
       FROM study_group_suggestions s
       WHERE s.id = $1 AND s.group_id = $2
       RETURNING id, suggestion_id, body, created_at`,
      [suggestionId, req.studyGroupId, req.session.user.id, body]
    );
    if (!rows.length) return res.status(404).json({ error: 'Group suggestion not found.' });
    await cache.deletePrefix('study:');
    res.status(201).json({
      comment: {
        ...rows[0],
        username: req.session.user.username,
        can_delete: true,
      },
    });
  } catch (error) {
    console.error('Could not comment on group suggestion:', error.message);
    res.status(500).json({ error: 'Could not add this comment.' });
  }
});

router.delete('/:groupId/suggestions/:suggestionId/comments/:commentId', requireAuth, requireGroupMember, async (req, res) => {
  const suggestionId = Number(req.params.suggestionId);
  const commentId = Number(req.params.commentId);
  if (!Number.isSafeInteger(suggestionId) || suggestionId < 1 ||
      !Number.isSafeInteger(commentId) || commentId < 1) {
    return res.status(400).json({ error: 'Invalid group comment.' });
  }
  try {
    const result = await pool.query(
      `DELETE FROM study_group_suggestion_comments c
       USING study_group_suggestions s
       WHERE c.id = $1 AND c.suggestion_id = s.id
         AND s.id = $2 AND s.group_id = $3
         AND (c.user_id = $4 OR $5 = 'owner')`,
      [commentId, suggestionId, req.studyGroupId, req.session.user.id, req.studyGroupRole]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Comment not found or cannot be removed.' });
    await cache.deletePrefix('study:');
    res.json({ removed: true });
  } catch (error) {
    console.error('Could not remove group comment:', error.message);
    res.status(500).json({ error: 'Could not remove this comment.' });
  }
});

router.delete('/:groupId/members/me', requireAuth, requireGroupMember, async (req, res) => {
  if (req.studyGroupRole === 'owner') {
    return res.status(409).json({ error: 'The group owner cannot leave. Delete the group or transfer ownership first.' });
  }
  try {
    await pool.query(
      'DELETE FROM study_group_members WHERE group_id = $1 AND user_id = $2',
      [req.studyGroupId, req.session.user.id]
    );
    await cache.deletePrefix('study:');
    res.json({ left: true });
  } catch (error) {
    console.error('Could not leave study group:', error.message);
    res.status(500).json({ error: 'Could not leave this study group.' });
  }
});

router.delete('/:groupId', requireAuth, requireGroupMember, async (req, res) => {
  if (req.studyGroupRole !== 'owner') return res.status(403).json({ error: 'Only the group owner can delete it.' });
  try {
    const materials = await pool.query(
      'SELECT storage_name FROM study_group_materials WHERE group_id = $1',
      [req.studyGroupId]
    );
    await pool.query('DELETE FROM study_groups WHERE id = $1', [req.studyGroupId]);
    for (const material of materials.rows) {
      try {
        await removeStoredUpload(material.storage_name);
      } catch (error) {
        console.error('Could not remove deleted group material from storage:', error.message);
      }
    }
    await cache.deletePrefix('study:');
    res.json({ deleted: true });
  } catch (error) {
    console.error('Could not delete study group:', error.message);
    res.status(500).json({ error: 'Could not delete this study group.' });
  }
});

module.exports = router;

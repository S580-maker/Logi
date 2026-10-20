-- Users table
CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    username      VARCHAR(50) UNIQUE NOT NULL,
    email         VARCHAR(120) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt          TEXT NOT NULL,
    role          VARCHAR(30) NOT NULL DEFAULT 'student',
    twofa_secret  TEXT,
    twofa_enabled BOOLEAN DEFAULT FALSE,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    last_login    TIMESTAMPTZ,
    last_activity_at TIMESTAMPTZ,
    email_verified_at TIMESTAMPTZ
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS passkey_email_grace_until TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Login attempts (for rate-limiting & auditing)
CREATE TABLE IF NOT EXISTS login_attempts (
    id         SERIAL PRIMARY KEY,
    username   VARCHAR(50),
    ip_address TEXT,
    success    BOOLEAN,
    attempted_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_attempts_ip   ON login_attempts(ip_address);

CREATE TABLE IF NOT EXISTS passkey_credentials (
    id            SERIAL PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_id TEXT NOT NULL UNIQUE,
    public_key    BYTEA NOT NULL,
    counter       BIGINT NOT NULL DEFAULT 0,
    transports    TEXT[] NOT NULL DEFAULT '{}',
    device_type   TEXT NOT NULL,
    backed_up     BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_passkey_credentials_user
    ON passkey_credentials(user_id);

CREATE TABLE IF NOT EXISTS user_recovery_codes (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash  TEXT NOT NULL CHECK (length(code_hash) = 64),
    used_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_recovery_codes_user_unused
    ON user_recovery_codes(user_id, used_at);

-- Study dashboard and private slide uploads
CREATE TABLE IF NOT EXISTS courses (
    id          SERIAL PRIMARY KEY,
    title       VARCHAR(120) NOT NULL,
    description VARCHAR(500) NOT NULL DEFAULT '',
    created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS course_slides (
    id            SERIAL PRIMARY KEY,
    course_id     INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    original_name VARCHAR(255) NOT NULL,
    storage_name  VARCHAR(100) NOT NULL UNIQUE,
    mime_type     VARCHAR(120) NOT NULL,
    size_bytes    BIGINT NOT NULL,
    uploaded_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_course_slides_course_created
    ON course_slides(course_id, created_at DESC);

-- Keep role assignments stable while upgrading existing installations.
DO $$
DECLARE
    role_constraint RECORD;
BEGIN
    FOR role_constraint IN
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'users'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%role%'
    LOOP
        EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', role_constraint.conname);
    END LOOP;

    ALTER TABLE users ALTER COLUMN role SET DEFAULT 'student';
    ALTER TABLE users ADD CONSTRAINT users_role_check
        CHECK (role IN (
            'admin', 'manager', 'editor', 'instructor', 'student',
            'viewer', 'auditor', 'support', 'content_manager'
        ));
END $$;

CREATE TABLE IF NOT EXISTS deleted_users (
    id             BIGSERIAL PRIMARY KEY,
    user_id        INTEGER NOT NULL,
    username       VARCHAR(50) NOT NULL,
    email          VARCHAR(120) NOT NULL,
    role           VARCHAR(30) NOT NULL,
    created_at     TIMESTAMPTZ,
    deleted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_by     INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS system_settings (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    config     JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO system_settings (id, config)
VALUES (1, '{"registration_enabled": true, "session_ttl_minutes": 60, "support_email": ""}'::jsonb)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS system_backups (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    config       JSONB NOT NULL,
    system_state JSONB NOT NULL,
    created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_system_backups_created_at
    ON system_backups(created_at DESC);

CREATE TABLE IF NOT EXISTS course_progress (
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slide_id     INTEGER NOT NULL REFERENCES course_slides(id) ON DELETE CASCADE,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, slide_id)
);

CREATE INDEX IF NOT EXISTS idx_course_progress_slide ON course_progress(slide_id);

CREATE TABLE IF NOT EXISTS course_slide_notes (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slide_id   INTEGER NOT NULL REFERENCES course_slides(id) ON DELETE CASCADE,
    note       TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, slide_id)
);

CREATE INDEX IF NOT EXISTS idx_course_slide_notes_slide ON course_slide_notes(slide_id);

CREATE TABLE IF NOT EXISTS user_semester_profiles (
    user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    program_name  VARCHAR(120) NOT NULL,
    semester_name VARCHAR(80) NOT NULL DEFAULT '',
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_semester_courses (
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    added_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, course_id)
);

CREATE TABLE IF NOT EXISTS study_groups (
    id          BIGSERIAL PRIMARY KEY,
    name        VARCHAR(120) NOT NULL,
    description VARCHAR(500) NOT NULL DEFAULT '',
    join_code   VARCHAR(8) NOT NULL UNIQUE,
    discoverable BOOLEAN NOT NULL DEFAULT TRUE,
    created_by  INTEGER REFERENCES users(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_study_groups_discoverable_name
    ON study_groups(discoverable, name);

CREATE TABLE IF NOT EXISTS study_group_members (
    group_id  BIGINT NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role      VARCHAR(12) NOT NULL DEFAULT 'member'
              CHECK (role IN ('owner', 'member')),
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (group_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_study_group_members_user
    ON study_group_members(user_id, group_id);

CREATE TABLE IF NOT EXISTS study_group_courses (
    group_id  BIGINT NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE,
    course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    added_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    added_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (group_id, course_id)
);

CREATE INDEX IF NOT EXISTS idx_study_group_courses_course
    ON study_group_courses(course_id, group_id);

CREATE TABLE IF NOT EXISTS study_group_suggestions (
    id         BIGSERIAL PRIMARY KEY,
    group_id   BIGINT NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE,
    user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    title      VARCHAR(120) NOT NULL,
    body       VARCHAR(2000) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_study_group_suggestions_group_created
    ON study_group_suggestions(group_id, created_at DESC);

CREATE TABLE IF NOT EXISTS study_group_suggestion_comments (
    id            BIGSERIAL PRIMARY KEY,
    suggestion_id BIGINT NOT NULL REFERENCES study_group_suggestions(id) ON DELETE CASCADE,
    user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    body          VARCHAR(1000) NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_study_group_suggestion_comments_post
    ON study_group_suggestion_comments(suggestion_id, created_at);

CREATE TABLE IF NOT EXISTS study_group_messages (
    id         BIGSERIAL PRIMARY KEY,
    group_id   BIGINT NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body       VARCHAR(2000) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_study_group_messages_group_created
    ON study_group_messages(group_id, created_at DESC);

CREATE TABLE IF NOT EXISTS study_group_materials (
    id            BIGSERIAL PRIMARY KEY,
    group_id      BIGINT NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE,
    user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    original_name VARCHAR(255) NOT NULL,
    storage_name  VARCHAR(255) NOT NULL UNIQUE,
    mime_type     VARCHAR(127) NOT NULL,
    size_bytes    BIGINT NOT NULL CHECK (size_bytes > 0),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_study_group_materials_group_created
    ON study_group_materials(group_id, created_at DESC);

CREATE TABLE IF NOT EXISTS study_group_tasks (
    id          BIGSERIAL PRIMARY KEY,
    group_id    BIGINT NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE,
    created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
    task_type   VARCHAR(8) NOT NULL CHECK (task_type IN ('goal', 'task')),
    title       VARCHAR(120) NOT NULL,
    description VARCHAR(1000) NOT NULL DEFAULT '',
    due_date    DATE,
    status      VARCHAR(16) NOT NULL DEFAULT 'planned'
                CHECK (status IN ('planned', 'in_progress', 'complete')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_study_group_tasks_group_created
    ON study_group_tasks(group_id, created_at DESC);

-- Seed a demo admin (password will be set via a one-off script)
-- Run `node scripts/seed.js` after setup to create users with proper hashes.
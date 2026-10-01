import { query, transaction } from './db';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { ensureCurriculumVersion, ensureBlockCurriculumVersion } from './migrateCurriculum';
import { ensureAuditTable } from './auditSchema';
import { ensureRealtimeTable } from './realtimeSchema';
import { canonicalSubjectCode, subjectKey } from '@shared/subjectCode';

// ─────────────────────────────────────────────────────────────────────────────
// Migration runner with version-tracking via schema_migrations table.
//
// Rules:
//  • Each migration has a unique integer version and a descriptive name.
//  • A migration runs ONLY if its version is not yet recorded in the
//    schema_migrations table — so each migration executes exactly once.
//  • All DDL inside a migration must be idempotent (IF NOT EXISTS / IF EXISTS /
//    ON CONFLICT DO NOTHING) so that a crash mid-run can be retried cleanly.
//  • Never renumber or delete a migration — add new ones at the end.
// ─────────────────────────────────────────────────────────────────────────────

async function ensureMigrationsTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function isApplied(version: number): Promise<boolean> {
  const r = await query(
    'SELECT 1 FROM schema_migrations WHERE version = $1',
    [version]
  );
  return r.rows.length > 0;
}

async function markApplied(version: number, name: string) {
  await query(
    `INSERT INTO schema_migrations (version, name)
     VALUES ($1, $2)
     ON CONFLICT (version) DO NOTHING`,
    [version, name]
  );
}

async function runMigration(
  version: number,
  name: string,
  fn: () => Promise<void>
) {
  if (await isApplied(version)) return;
  console.log(`[migrate] Applying v${version}: ${name}`);
  await fn();
  await markApplied(version, name);
  console.log(`[migrate] v${version} applied.`);
}

// ─── individual migration functions ─────────────────────────────────────────

async function v1_initialSchema() {
  const sql = fs.readFileSync(
    path.join(process.cwd(), 'database', 'schema.sql'),
    'utf-8'
  );
  const stmts = sql.split(';').map(s => s.trim()).filter(Boolean);
  for (const stmt of stmts) {
    try {
      await query(stmt);
    } catch (e) {
      const msg = (e as Error).message ?? '';
      if (!msg.includes('already exists') && !msg.includes('duplicate')) {
        console.warn('[v1] Statement warning:', msg.substring(0, 200));
      }
    }
  }

  // Seed admin account (DO NOTHING preserves any password set by a previous run)
  const adminHash = await bcrypt.hash('admin123', 10);
  await query(`
    INSERT INTO users (username, email, password_hash, role)
    VALUES ($1, $2, $3, 'admin')
    ON CONFLICT (username) DO NOTHING
  `, ['admin', 'admin@school.edu', adminHash]);

  // Seed default dept chair account
  const chairHash = await bcrypt.hash('chair123', 10);
  await query(`
    INSERT INTO users (username, email, password_hash, role)
    VALUES ($1, $2, $3, 'program_chair')
    ON CONFLICT (username) DO NOTHING
  `, ['deptchair', 'deptchair@school.edu', chairHash]);

  // Run seed.sql
  const seedSQL = fs.readFileSync(
    path.join(process.cwd(), 'database', 'seed.sql'),
    'utf-8'
  );
  const seedStmts = seedSQL
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--'));
  for (const stmt of seedStmts) {
    try { await query(stmt); } catch { /* duplicates are fine */ }
  }

  // Generate QR codes for rooms
  const rooms = await query('SELECT id, qr_code_id FROM rooms WHERE qr_code_data IS NULL');
  for (const room of rooms.rows) {
    const qrData = JSON.stringify({ type: 'room', id: room.id, code: room.qr_code_id });
    await query('UPDATE rooms SET qr_code_data = $1 WHERE id = $2', [qrData, room.id]);
  }

  // Populate block_subjects from blocks + curriculums
  const blocks = await query('SELECT b.id AS block_id, b.program_id, b.year_level, b.semester FROM blocks b');
  for (const block of blocks.rows) {
    const subjects = await query(
      `SELECT id FROM curriculums
       WHERE program_id = $1 AND year_level = $2 AND semester = $3 AND is_active = true`,
      [block.program_id, block.year_level, block.semester]
    );
    for (const subject of subjects.rows) {
      await query(
        `INSERT INTO block_subjects (block_id, curriculum_id, status)
         VALUES ($1, $2, 'Unscheduled')
         ON CONFLICT (block_id, curriculum_id) DO NOTHING`,
        [block.block_id, subject.id]
      );
    }
  }

  // Populate master_schedule from block_subjects
  const blockSubjects = await query(
    `SELECT bs.id AS block_subject_id, b.academic_year, b.semester
     FROM block_subjects bs JOIN blocks b ON bs.block_id = b.id`
  );
  for (const bs of blockSubjects.rows) {
    await query(
      `INSERT INTO master_schedule (block_subject_id, status, academic_year, semester)
       VALUES ($1, 'Unassigned', $2, $3)
       ON CONFLICT DO NOTHING`,
      [bs.block_subject_id, bs.academic_year, bs.semester]
    );
  }
}

async function v2_expandPosition() {
  await query(`ALTER TABLE faculty DROP CONSTRAINT IF EXISTS faculty_position_check`).catch(() => {});
  await query(`ALTER TABLE faculty ALTER COLUMN position TYPE VARCHAR(100)`).catch(() => {});
  await query(`UPDATE faculty SET position = 'Instructor I' WHERE position = 'Permanent'`).catch(() => {});
  await query(`
    ALTER TABLE faculty ADD COLUMN IF NOT EXISTS employment_status VARCHAR(20)
    GENERATED ALWAYS AS (
      CASE WHEN position = 'Contractual' THEN 'Contractual' ELSE 'Permanent' END
    ) STORED
  `).catch(() => {});
  await query(`ALTER TABLE faculty DROP CONSTRAINT IF EXISTS faculty_position_check2`).catch(() => {});
  await query(`
    ALTER TABLE faculty ADD CONSTRAINT faculty_position_check2 CHECK (position IN (
      'Temporary Permanent',
      'Instructor I', 'Instructor II', 'Instructor III',
      'Assistant Professor I', 'Assistant Professor II', 'Assistant Professor III',
      'Assistant Professor IV', 'Assistant Professor V',
      'Associate Professor I', 'Associate Professor II',
      'Associate Professor III', 'Associate Professor IV',
      'Professor I', 'Professor II', 'Professor III',
      'Professor IV', 'Professor V', 'Professor VI',
      'Contractual'
    ))
  `).catch(() => {});
}

async function v3_facultyNameParts() {
  for (const sql of [
    `ALTER TABLE faculty ADD COLUMN IF NOT EXISTS first_name  VARCHAR(100)`,
    `ALTER TABLE faculty ADD COLUMN IF NOT EXISTS last_name   VARCHAR(100)`,
    `ALTER TABLE faculty ADD COLUMN IF NOT EXISTS middle_name VARCHAR(100) DEFAULT ''`,
  ]) {
    await query(sql).catch(e => console.warn('[v3]', (e as Error).message));
  }
  await query(`
    UPDATE faculty
    SET
      first_name  = COALESCE(NULLIF(trim(first_name),  ''), split_part(trim(name), ' ', 1)),
      middle_name = COALESCE(middle_name, ''),
      last_name   = COALESCE(
        NULLIF(trim(last_name), ''),
        CASE
          WHEN position(' ' IN trim(name)) > 0
          THEN trim(substring(name FROM position(' ' IN trim(name)) + 1))
          ELSE ''
        END
      )
    WHERE first_name IS NULL OR trim(first_name) = ''
       OR last_name  IS NULL OR trim(last_name)  = ''
  `).catch(e => console.warn('[v3 backfill]', (e as Error).message));
}

async function v4_legacyFacultyCredentials() {
  // These columns were incorrectly added to faculty in an early version.
  // Kept as no-ops for databases that already ran this step.
  await query(`ALTER TABLE faculty ADD COLUMN IF NOT EXISTS username VARCHAR(100)`).catch(() => {});
  await query(`ALTER TABLE faculty ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255)`).catch(() => {});
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS faculty_username_unique
    ON faculty(username) WHERE username IS NOT NULL
  `).catch(() => {});
}

async function v5_nullableEmployeeId() {
  await query(`ALTER TABLE faculty ALTER COLUMN employee_id DROP NOT NULL`).catch(() => {});
  await query(`
    UPDATE faculty
    SET employee_id = 'EMP-' || LPAD(id::text, 4, '0')
    WHERE employee_id IS NULL
  `).catch(e => console.warn('[v5]', (e as Error).message));
}

async function v6_instructorAccounts() {
  await query(`
    CREATE TABLE IF NOT EXISTS instructor_accounts (
      id            SERIAL PRIMARY KEY,
      faculty_id    INTEGER NOT NULL UNIQUE REFERENCES faculty(id) ON DELETE CASCADE,
      username      VARCHAR(100) UNIQUE NOT NULL,
      email         VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role          VARCHAR(50) DEFAULT 'instructor',
      is_active     BOOLEAN DEFAULT TRUE,
      created_at    TIMESTAMP DEFAULT NOW(),
      updated_at    TIMESTAMP DEFAULT NOW()
    )
  `).catch(e => console.warn('[v6] create table:', (e as Error).message));
  await query(`
    CREATE INDEX IF NOT EXISTS idx_instructor_accounts_faculty ON instructor_accounts(faculty_id)
  `).catch(() => {});
  // Migrate any credentials incorrectly stored on faculty (v4 legacy)
  await query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'faculty' AND column_name = 'username'
      ) THEN
        INSERT INTO instructor_accounts (faculty_id, username, email, password_hash, role)
        SELECT
          f.id,
          f.username,
          COALESCE(NULLIF(trim(COALESCE(f.email,'')), ''), f.username || '@placeholder.local'),
          f.password_hash,
          'instructor'
        FROM faculty f
        WHERE f.username IS NOT NULL
          AND f.password_hash IS NOT NULL
        ON CONFLICT DO NOTHING;
      END IF;
    END $$
  `).catch(e => console.warn('[v6] data migrate:', (e as Error).message));
}

async function v7_curriculumUnits() {
  await query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'curriculums'
          AND column_name = 'units'
          AND is_generated = 'ALWAYS'
      ) THEN
        ALTER TABLE curriculums ALTER COLUMN units DROP EXPRESSION;
      END IF;
    END $$
  `).catch(e => console.warn('[v7] drop expression:', (e as Error).message));
  await query(`
    UPDATE curriculums
    SET units = ROUND(lecture_hours + (laboratory_hours * 0.75), 2)
    WHERE units = 0 OR units IS NULL
  `).catch(e => console.warn('[v7] backfill:', (e as Error).message));
}

async function v8_blockPartialUniqueIndex() {
  await query(`DELETE FROM blocks WHERE is_active = false`).catch(e =>
    console.warn('[v8] purge soft-deleted blocks:', (e as Error).message)
  );
  await query(`
    DO $$
    DECLARE _c text;
    BEGIN
      SELECT constraint_name INTO _c
      FROM information_schema.table_constraints
      WHERE table_name      = 'blocks'
        AND constraint_type = 'UNIQUE'
        AND constraint_name LIKE 'blocks_%key';
      IF _c IS NOT NULL THEN
        EXECUTE format('ALTER TABLE blocks DROP CONSTRAINT %I', _c);
      END IF;
    END $$
  `).catch(e => console.warn('[v8] drop old unique:', (e as Error).message));
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS blocks_active_unique
    ON blocks(program_id, year_level, semester, academic_year, block_name)
    WHERE is_active = true
  `).catch(e => console.warn('[v8] partial index:', (e as Error).message));
}

async function v9_roomChangeRequests() {
  await query(`
    CREATE TABLE IF NOT EXISTS room_change_requests (
      id                  SERIAL PRIMARY KEY,
      faculty_id          INTEGER NOT NULL REFERENCES faculty(id) ON DELETE CASCADE,
      master_schedule_id  INTEGER REFERENCES master_schedule(id) ON DELETE SET NULL,
      original_room_id    INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
      requested_room_id   INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
      reason              TEXT NOT NULL,
      status              VARCHAR(20) DEFAULT 'Pending',
      admin_notes         TEXT,
      created_at          TIMESTAMP DEFAULT NOW(),
      updated_at          TIMESTAMP DEFAULT NOW()
    )
  `).catch(e => console.warn('[v9]', (e as Error).message));
  await query(`CREATE INDEX IF NOT EXISTS idx_rcr_faculty ON room_change_requests(faculty_id)`).catch(() => {});
  await query(`CREATE INDEX IF NOT EXISTS idx_rcr_status ON room_change_requests(status)`).catch(() => {});
}

async function v10_roomChangeSubmittedBy() {
  await query(`
    ALTER TABLE room_change_requests
      ADD COLUMN IF NOT EXISTS submitted_by VARCHAR(20) DEFAULT 'admin'
  `).catch(e => console.warn('[v10]', (e as Error).message));
}

async function v11_facultyProfilePicture() {
  await query(`
    ALTER TABLE faculty ADD COLUMN IF NOT EXISTS profile_picture VARCHAR(500)
  `).catch(e => console.warn('[v11]', (e as Error).message));
}

async function v12_employmentStatusRegen() {
  await query(`ALTER TABLE faculty DROP COLUMN IF EXISTS employment_status`).catch(() => {});
  await query(`
    ALTER TABLE faculty ADD COLUMN employment_status VARCHAR(20)
    GENERATED ALWAYS AS (
      CASE WHEN position IN ('Contractual', 'Temporary Permanent') THEN 'Contractual' ELSE 'Permanent' END
    ) STORED
  `).catch(e => console.warn('[v12]', (e as Error).message));
}

async function v13_widenDesignationType() {
  await query(`ALTER TABLE faculty ALTER COLUMN designation_type TYPE TEXT`).catch(e =>
    console.warn('[v13]', (e as Error).message)
  );
}

async function v14_instructorLoadDeductions() {
  await query(`
    CREATE TABLE IF NOT EXISTS instructor_load_deductions (
      id             SERIAL PRIMARY KEY,
      faculty_id     INTEGER NOT NULL REFERENCES faculty(id) ON DELETE CASCADE,
      deduction_type TEXT NOT NULL,
      description    TEXT DEFAULT '',
      deducted_units NUMERIC(4,2) NOT NULL DEFAULT 0,
      semester       TEXT NOT NULL,
      school_year    TEXT NOT NULL,
      created_at     TIMESTAMP DEFAULT NOW(),
      updated_at     TIMESTAMP DEFAULT NOW()
    )
  `).catch(e => console.warn('[v14]', (e as Error).message));
  await query(`
    CREATE INDEX IF NOT EXISTS idx_ild_faculty_sem
    ON instructor_load_deductions(faculty_id, semester, school_year)
  `).catch(() => {});
  // Belt-and-suspenders for v13
  await query(`ALTER TABLE faculty ALTER COLUMN designation_type TYPE TEXT`).catch(() => {});
}

async function v15_roomChangeLifecycle() {
  await query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE  table_name  = 'room_change_requests'
          AND  column_name = 'status'
          AND  character_maximum_length IS NOT NULL
          AND  character_maximum_length < 30
      ) THEN
        ALTER TABLE room_change_requests ALTER COLUMN status TYPE VARCHAR(30);
      END IF;
    END $$
  `).catch(e => console.warn('[v15] widen status:', (e as Error).message));
  await query(`ALTER TABLE room_change_requests ADD COLUMN IF NOT EXISTS confirmation_deadline TIMESTAMPTZ`).catch(() => {});
  await query(`ALTER TABLE room_change_requests ADD COLUMN IF NOT EXISTS auto_notes TEXT`).catch(() => {});
}

async function v16_roomChangeTimestamps() {
  for (const col of ['approved_at', 'rejected_at', 'expired_at', 'confirmed_at']) {
    await query(
      `ALTER TABLE room_change_requests ADD COLUMN IF NOT EXISTS ${col} TIMESTAMPTZ`
    ).catch(e => console.warn(`[v16] ${col}:`, (e as Error).message));
  }
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS room_occupancy_active_room_idx
    ON room_occupancy (room_id)
    WHERE status IN ('Pending', 'Occupied')
  `).catch(() => {});
}

async function v17_usersIsActive() {
  // Add is_active to the users table so administrators can activate /
  // deactivate program_chair accounts.
  await query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE
  `);
  // Back-fill any NULL values produced by the DEFAULT not being applied
  // retroactively on rows that were inserted before this migration.
  await query(`UPDATE users SET is_active = TRUE WHERE is_active IS NULL`);
}

async function v18_userProfilePicture() {
  await query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_picture VARCHAR(500)
  `).catch(e => console.warn('[v18]', (e as Error).message));
}

async function v19_facultyProfessionalProfile() {
  for (const sql of [
    `ALTER TABLE faculty ADD COLUMN IF NOT EXISTS years_in_service          INTEGER`,
    `ALTER TABLE faculty ADD COLUMN IF NOT EXISTS educational_qualification VARCHAR(255)`,
    `ALTER TABLE faculty ADD COLUMN IF NOT EXISTS major                     VARCHAR(255)`,
    `ALTER TABLE faculty ADD COLUMN IF NOT EXISTS eligibility               VARCHAR(255)`,
  ]) {
    await query(sql).catch(e => console.warn('[v19]', (e as Error).message));
  }
}

/**
 * After instructor deletion, master_schedule.faculty_id is SET NULL by FK but
 * status can remain 'Assigned', and soft-deactivated faculty still have
 * faculty_id set. Neither of those slots should count as assigned.
 * Also drop orphan load rows if a live DB ever lacked the CASCADE FK.
 */
async function v20_releaseOrphanedWorkloadAssignments() {
  await query(`
    UPDATE master_schedule ms
    SET faculty_id = NULL,
        status = 'Unassigned',
        updated_at = NOW()
    WHERE ms.faculty_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM faculty f
        WHERE f.id = ms.faculty_id AND f.is_active IS NOT FALSE
      )
  `);

  await query(`
    UPDATE master_schedule
    SET status = 'Unassigned',
        updated_at = NOW()
    WHERE faculty_id IS NULL
      AND status IN ('Assigned', 'Scheduled', 'Completed', 'pending')
  `);

  await query(`
    DELETE FROM instructor_loads il
    WHERE NOT EXISTS (
      SELECT 1 FROM faculty f
      WHERE f.id = il.faculty_id AND f.is_active IS NOT FALSE
    )
  `);

  await query(`
    DELETE FROM overloads o
    WHERE NOT EXISTS (
      SELECT 1 FROM faculty f
      WHERE f.id = o.faculty_id AND f.is_active IS NOT FALSE
    )
  `);
}

async function v21_curriculumSubjectCategory() {
  await query(`
    ALTER TABLE curriculums
    ADD COLUMN IF NOT EXISTS subject_category VARCHAR(10) NOT NULL DEFAULT 'Minor'
  `);
}

async function v22_syncSubjectCategoryFromHours() {
  await query(`
    UPDATE curriculums
    SET subject_category = CASE
          WHEN COALESCE(laboratory_hours, 0) > 0 THEN 'Major'
          ELSE 'Minor'
        END,
        updated_at = NOW()
    WHERE subject_category IS DISTINCT FROM (
      CASE
        WHEN COALESCE(laboratory_hours, 0) > 0 THEN 'Major'
        ELSE 'Minor'
      END
    )
  `);
}

async function v23_instructorGoogleVerification() {
  for (const sql of [
    `ALTER TABLE instructor_accounts ADD COLUMN IF NOT EXISTS google_sub VARCHAR(255)`,
    `ALTER TABLE instructor_accounts ADD COLUMN IF NOT EXISTS google_verified BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE instructor_accounts ADD COLUMN IF NOT EXISTS google_verified_at TIMESTAMPTZ`,
  ]) {
    await query(sql).catch(e => console.warn('[v23]', (e as Error).message));
  }
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS instructor_accounts_google_sub_unique
    ON instructor_accounts (google_sub)
    WHERE google_sub IS NOT NULL
  `).catch(e => console.warn('[v23] google_sub index:', (e as Error).message));
  await query(`
    UPDATE instructor_accounts
    SET google_verified = FALSE
    WHERE google_verified IS NULL
  `).catch(e => console.warn('[v23] backfill:', (e as Error).message));
}

async function v25_authVersionAndTrustedDevices() {
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 1`);
  await query(`ALTER TABLE instructor_accounts ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 1`);
  await query(`UPDATE users SET auth_version = 1 WHERE auth_version IS NULL`);
  await query(`UPDATE instructor_accounts SET auth_version = 1 WHERE auth_version IS NULL`);
  await query(`
    CREATE TABLE IF NOT EXISTS trusted_devices (
      id UUID PRIMARY KEY,
      account_kind VARCHAR(20) NOT NULL,
      account_id INTEGER NOT NULL,
      token_hash VARCHAR(64) NOT NULL UNIQUE,
      device_label VARCHAR(255) NOT NULL DEFAULT 'Unknown device',
      user_agent TEXT,
      ip_at_registration VARCHAR(64),
      last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS trusted_devices_account_idx
    ON trusted_devices (account_kind, account_id)
    WHERE revoked_at IS NULL
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS trusted_devices_hash_idx
    ON trusted_devices (token_hash)
    WHERE revoked_at IS NULL
  `);
}

async function v26_instructorGooglePicture() {
  await query(
    `ALTER TABLE instructor_accounts ADD COLUMN IF NOT EXISTS google_picture VARCHAR(1000)`
  );
}

async function v27_otpPurpose() {
  await query(
    `ALTER TABLE login_otp_challenges ADD COLUMN IF NOT EXISTS purpose VARCHAR(40) NOT NULL DEFAULT 'login'`
  );
  await query(
    `UPDATE login_otp_challenges SET purpose = 'login' WHERE purpose IS NULL`
  ).catch(() => {});
}

async function v28_trustedDeviceActivity() {
  for (const sql of [
    `ALTER TABLE trusted_devices ADD COLUMN IF NOT EXISTS device_type VARCHAR(20)`,
    `ALTER TABLE trusted_devices ADD COLUMN IF NOT EXISTS os_name VARCHAR(64)`,
    `ALTER TABLE trusted_devices ADD COLUMN IF NOT EXISTS browser_name VARCHAR(64)`,
    `ALTER TABLE trusted_devices ADD COLUMN IF NOT EXISTS last_ip VARCHAR(64)`,
    `ALTER TABLE trusted_devices ADD COLUMN IF NOT EXISTS city VARCHAR(120)`,
    `ALTER TABLE trusted_devices ADD COLUMN IF NOT EXISTS region VARCHAR(120)`,
    `ALTER TABLE trusted_devices ADD COLUMN IF NOT EXISTS country VARCHAR(120)`,
    `ALTER TABLE trusted_devices ADD COLUMN IF NOT EXISTS location_label VARCHAR(255)`,
  ]) {
    await query(sql).catch(e => console.warn('[v28]', (e as Error).message));
  }
  await query(`
    UPDATE trusted_devices
    SET last_ip = COALESCE(last_ip, ip_at_registration)
    WHERE last_ip IS NULL AND ip_at_registration IS NOT NULL
  `).catch(() => {});
}

/** Remove ghost schedule_sessions on unassigned master_schedule rows that
 *  falsely triggered block conflicts (e.g. leftover GE-PC after overload delete). */
async function v29_cleanupOrphanedScheduleSessions() {
  await query(`
    DELETE FROM schedule_sessions ss
    USING master_schedule ms
    WHERE ss.master_schedule_id = ms.id
      AND (
        ms.faculty_id IS NULL
        OR LOWER(COALESCE(ms.status, '')) IN ('unassigned', 'pending', 'unscheduled')
      )
  `);

  await query(`
    UPDATE master_schedule
    SET day_pattern = NULL, start_time = NULL, end_time = NULL, room_id = NULL, split_type = NULL
    WHERE faculty_id IS NULL
      OR LOWER(COALESCE(status, '')) IN ('unassigned', 'pending', 'unscheduled')
  `);
}

async function v30_deptChairProgramAndGoogle() {
  for (const sql of [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS program_id INTEGER REFERENCES programs(id) ON DELETE SET NULL`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub VARCHAR(255)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS google_verified BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS google_verified_at TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS google_picture VARCHAR(1000)`,
  ]) {
    await query(sql).catch(e => console.warn('[v30]', (e as Error).message));
  }
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_unique
    ON users (google_sub)
    WHERE google_sub IS NOT NULL
  `).catch(e => console.warn('[v30] google_sub index:', (e as Error).message));
  await query(`
    UPDATE users SET google_verified = FALSE WHERE google_verified IS NULL
  `).catch(e => console.warn('[v30] backfill:', (e as Error).message));
}

async function v31_otpEnabledPreference() {
  for (const sql of [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_enabled BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE instructor_accounts ADD COLUMN IF NOT EXISTS otp_enabled BOOLEAN NOT NULL DEFAULT FALSE`,
  ]) {
    await query(sql).catch(e => console.warn('[v31]', (e as Error).message));
  }
  await query(`UPDATE users SET otp_enabled = FALSE WHERE otp_enabled IS NULL`).catch(() => {});
  await query(
    `UPDATE instructor_accounts SET otp_enabled = FALSE WHERE otp_enabled IS NULL`
  ).catch(() => {});
}

/**
 * Global email identity registry + case-insensitive uniqueness helpers.
 * Cross-role uniqueness is enforced by account_email_registry PK.
 * Existing cross-table duplicates are logged and skipped (not deleted).
 */
async function v32_emailRegistryAndAuthHardening() {
  await query(`
    CREATE TABLE IF NOT EXISTS account_email_registry (
      email_normalized VARCHAR(255) PRIMARY KEY,
      account_kind VARCHAR(20) NOT NULL,
      account_id INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT account_email_registry_kind_check
        CHECK (account_kind IN ('user', 'instructor')),
      CONSTRAINT account_email_registry_owner_unique
        UNIQUE (account_kind, account_id)
    )
  `).catch(e => console.warn('[v32] registry table:', (e as Error).message));

  /* Case-insensitive uniqueness within each table (safe IF NOT EXISTS). */
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_normalized_unique
    ON users (lower(trim(email)))
  `).catch(e => console.warn('[v32] users email index (may have case-dupes):', (e as Error).message));

  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS instructor_accounts_email_normalized_unique
    ON instructor_accounts (lower(trim(email)))
  `).catch(e =>
    console.warn('[v32] instructor email index (may have case-dupes):', (e as Error).message)
  );

  /* Backfill registry — users first, then instructors; skip conflicts. */
  const users = await query(
    `SELECT id, lower(trim(email)) AS email_normalized FROM users WHERE email IS NOT NULL`
  ).catch(() => ({ rows: [] as Array<{ id: number; email_normalized: string }> }));

  for (const row of users.rows) {
    const email = String(row.email_normalized ?? '').trim().toLowerCase();
    if (!email) continue;
    await query(
      `INSERT INTO account_email_registry (email_normalized, account_kind, account_id)
       VALUES ($1, 'user', $2)
       ON CONFLICT DO NOTHING`,
      [email, row.id]
    ).catch(() => {});
  }

  const instructors = await query(
    `SELECT id, lower(trim(email)) AS email_normalized FROM instructor_accounts WHERE email IS NOT NULL`
  ).catch(() => ({ rows: [] as Array<{ id: number; email_normalized: string }> }));

  const crossDupes: string[] = [];
  for (const row of instructors.rows) {
    const email = String(row.email_normalized ?? '').trim().toLowerCase();
    if (!email) continue;
    const existing = await query(
      `SELECT account_kind, account_id FROM account_email_registry WHERE email_normalized = $1`,
      [email]
    ).catch(() => ({ rows: [] as Array<{ account_kind: string; account_id: number }> }));
    if (existing.rows[0]) {
      crossDupes.push(
        `${email} (kept ${existing.rows[0].account_kind}:${existing.rows[0].account_id}; skipped instructor:${row.id})`
      );
      continue;
    }
    await query(
      `INSERT INTO account_email_registry (email_normalized, account_kind, account_id)
       VALUES ($1, 'instructor', $2)
       ON CONFLICT DO NOTHING`,
      [email, row.id]
    ).catch(() => {});
  }

  if (crossDupes.length > 0) {
    console.warn(
      `[v32] Cross-role email duplicates detected (not auto-deleted):\n` +
        crossDupes.slice(0, 50).join('\n') +
        (crossDupes.length > 50 ? `\n... and ${crossDupes.length - 50} more` : '')
    );
  }
}

async function v24_loginOtpChallenges() {
  await query(`
    CREATE TABLE IF NOT EXISTS login_otp_challenges (
      id UUID PRIMARY KEY,
      account_kind VARCHAR(20) NOT NULL,
      account_id INTEGER NOT NULL,
      role VARCHAR(50) NOT NULL,
      email VARCHAR(255) NOT NULL,
      code_hash VARCHAR(64) NOT NULL,
      session_payload JSONB NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      used_at TIMESTAMPTZ,
      last_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS login_otp_challenges_active_account_idx
    ON login_otp_challenges (account_kind, account_id)
    WHERE used_at IS NULL
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS login_otp_challenges_expires_idx
    ON login_otp_challenges (expires_at)
  `);
}

async function v33_curriculumVersion() {
  await ensureCurriculumVersion();
}

async function v34_existingCurriculumIsOld() {
  await ensureCurriculumVersion();
}

async function v35_swapNewSubjectsToOldWhenOldEmpty() {
  const oldExists = await query(`
    SELECT 1 FROM curriculums WHERE curriculum_version = 'old' LIMIT 1
  `);
  if (oldExists.rows.length === 0) {
    await query(`
      UPDATE curriculums
      SET curriculum_version = 'old', updated_at = NOW()
      WHERE curriculum_version = 'new'
    `);
  }
}

async function v36_blockCurriculumVersion() {
  await ensureBlockCurriculumVersion();
}

async function v37_monitoringNotificationUnique() {
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_monitoring_unique
    ON notifications (recipient_role, recipient_id, type, related_module, related_id)
    WHERE type IN ('workload_incomplete', 'block_unassigned')
  `);
}

async function v38_overloadReviewNotificationUnique() {
  await query(`DROP INDEX IF EXISTS idx_notifications_monitoring_unique`);
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_monitoring_unique
    ON notifications (recipient_role, recipient_id, type, related_module, related_id)
    WHERE type IN ('workload_incomplete', 'workload_overload', 'block_unassigned')
  `);
}

async function v39_facultyPrioritySubjects() {
  await query(`
    CREATE TABLE IF NOT EXISTS faculty_priority_subjects (
      id            SERIAL PRIMARY KEY,
      faculty_id    INTEGER NOT NULL REFERENCES faculty(id) ON DELETE CASCADE,
      subject_code  VARCHAR(50) NOT NULL,
      subject_name  VARCHAR(255) NOT NULL DEFAULT '',
      created_at    TIMESTAMP DEFAULT NOW(),
      UNIQUE(faculty_id, subject_code)
    )
  `).catch(e => console.warn('[v39]', (e as Error).message));
}

/**
 * Role restructure: the old "Department Chair" role/behavior (program-scoped
 * access, own /dept-chair dashboard) is renamed to "program_chair". A brand
 * new "department_chair" role is introduced with near-admin access. Existing
 * accounts stored as role='department_chair' keep their exact current
 * permissions — they become 'program_chair' so nothing changes for them.
 */
async function v40_renameDeptChairToProgramChair() {
  await query(`UPDATE users SET role = 'program_chair' WHERE role = 'department_chair'`)
    .catch(e => console.warn('[v40]', (e as Error).message));
}

async function v41_auditLogs() {
  await ensureAuditTable();
}

/**
 * Temporary Permanent is unit-based (18 units, designations allowed) like
 * Permanent; only Contractual stays hour-based (30 hrs). employment_status is
 * generated from position, so only its expression changes — no rows rewritten.
 */
async function v43_temporaryPermanentUnitBased() {
  await query(`
    ALTER TABLE faculty ALTER COLUMN employment_status
    SET EXPRESSION AS (CASE WHEN position = 'Contractual' THEN 'Contractual' ELSE 'Permanent' END)
  `);
}

/** Faculty → blocks they are assigned to teach (filters Faculty Workload's block list). */
async function v44_facultyBlocks() {
  await query(`
    CREATE TABLE IF NOT EXISTS faculty_blocks (
      faculty_id INTEGER NOT NULL REFERENCES faculty(id) ON DELETE CASCADE,
      block_id   INTEGER NOT NULL REFERENCES blocks(id)  ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (faculty_id, block_id)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS faculty_blocks_block_idx ON faculty_blocks (block_id)`);
}

/** Allowed day combinations per school year + semester (Settings → Day
 *  Combinations). `days` is canonical "Mon/Wed/Fri". No rows for a term means
 *  no restriction, so existing terms keep working unchanged. */
async function v46_semesterDayCombinations() {
  await query(`
    CREATE TABLE IF NOT EXISTS semester_day_combinations (
      id            SERIAL PRIMARY KEY,
      academic_year VARCHAR(20) NOT NULL,
      semester      VARCHAR(40) NOT NULL,
      days          VARCHAR(60) NOT NULL,
      is_active     BOOLEAN NOT NULL DEFAULT true,
      sort_order    INTEGER NOT NULL DEFAULT 0,
      created_at    TIMESTAMP DEFAULT NOW(),
      updated_at    TIMESTAMP DEFAULT NOW(),
      UNIQUE (academic_year, semester, days)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS semester_day_combinations_term_idx ON semester_day_combinations (academic_year, semester)`);
}

/** Minor/Major picked by hand on the Curriculum form (overrides the default rule). */
async function v47_curriculumCategoryManual() {
  await query(`ALTER TABLE curriculums ADD COLUMN IF NOT EXISTS subject_category_manual BOOLEAN NOT NULL DEFAULT false`);
}

/** Real-time sync: one version row per topic (services/realtime.ts). */
async function v48_realtimeVersions() {
  await ensureRealtimeTable();
}

/** One-time: each faculty is assigned the blocks they already teach, so the new
 *  block filter on Faculty Workload doesn't hide their current classes. */
async function v45_seedFacultyBlocks() {
  await query(`
    INSERT INTO faculty_blocks (faculty_id, block_id)
    SELECT DISTINCT il.faculty_id, bs.block_id
      FROM instructor_loads il
      JOIN master_schedule ms ON ms.id = il.master_schedule_id
      JOIN block_subjects bs  ON bs.id = ms.block_subject_id
    ON CONFLICT DO NOTHING
  `);
}

/**
 * Priority subjects: the same code + title from different programs is one
 * subject. Tidy stored codes ("GE - AA" → "GE-AA"), drop the duplicates this
 * reveals, and make uniqueness code + title so two different subjects that
 * share a code can both be kept.
 */
async function v42_mergePrioritySubjects() {
  await transaction(async (client) => {
    const res = await client.query(
      `SELECT id, faculty_id, subject_code, subject_name FROM faculty_priority_subjects ORDER BY id`,
    );
    const seen = new Set<string>();
    const dropIds: number[] = [];
    const tidy: Array<{ id: number; code: string; name: string }> = [];
    for (const r of res.rows as Array<{ id: number; faculty_id: number; subject_code: string; subject_name: string }>) {
      const key = `${r.faculty_id}|${subjectKey(r.subject_code, r.subject_name)}`;
      if (seen.has(key)) { dropIds.push(r.id); continue; }
      seen.add(key);
      const code = canonicalSubjectCode(r.subject_code);
      const name = String(r.subject_name ?? '').replace(/\s+/g, ' ').trim();
      if (code !== r.subject_code || name !== r.subject_name) tidy.push({ id: r.id, code, name });
    }
    if (dropIds.length) {
      await client.query(`DELETE FROM faculty_priority_subjects WHERE id = ANY($1)`, [dropIds]);
    }
    await client.query(`
      ALTER TABLE faculty_priority_subjects
        DROP CONSTRAINT IF EXISTS faculty_priority_subjects_faculty_id_subject_code_key
    `);
    for (const t of tidy) {
      await client.query(
        `UPDATE faculty_priority_subjects SET subject_code = $1, subject_name = $2 WHERE id = $3`,
        [t.code, t.name, t.id],
      );
    }
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS faculty_priority_subjects_faculty_code_name_uidx
        ON faculty_priority_subjects (faculty_id, subject_code, subject_name)
    `);
  });
}

// ─── migration registry ───────────────────────────────────────────────────────

const MIGRATIONS: Array<{ version: number; name: string; fn: () => Promise<void> }> = [
  { version:  1, name: 'initial schema + seed',                  fn: v1_initialSchema         },
  { version:  2, name: 'expand position + employment_status',    fn: v2_expandPosition        },
  { version:  3, name: 'faculty name parts',                     fn: v3_facultyNameParts      },
  { version:  4, name: 'legacy faculty credentials (no-op)',     fn: v4_legacyFacultyCredentials },
  { version:  5, name: 'nullable employee_id',                   fn: v5_nullableEmployeeId    },
  { version:  6, name: 'instructor_accounts table',              fn: v6_instructorAccounts    },
  { version:  7, name: 'curriculum units manual',                fn: v7_curriculumUnits       },
  { version:  8, name: 'blocks partial unique index',            fn: v8_blockPartialUniqueIndex },
  { version:  9, name: 'room_change_requests table',             fn: v9_roomChangeRequests    },
  { version: 10, name: 'room_change_requests submitted_by',      fn: v10_roomChangeSubmittedBy },
  { version: 11, name: 'faculty profile_picture',                fn: v11_facultyProfilePicture },
  { version: 12, name: 'employment_status regenerated column',   fn: v12_employmentStatusRegen },
  { version: 13, name: 'designation_type TEXT',                  fn: v13_widenDesignationType },
  { version: 14, name: 'instructor_load_deductions table',       fn: v14_instructorLoadDeductions },
  { version: 15, name: 'room_change lifecycle columns',          fn: v15_roomChangeLifecycle  },
  { version: 16, name: 'room_change audit timestamps',           fn: v16_roomChangeTimestamps },
  { version: 17, name: 'users.is_active for dept chair accounts', fn: v17_usersIsActive       },
  { version: 18, name: 'users.profile_picture',                  fn: v18_userProfilePicture  },
  { version: 19, name: 'faculty professional profile fields',    fn: v19_facultyProfessionalProfile },
  { version: 20, name: 'release orphaned workload assignments',  fn: v20_releaseOrphanedWorkloadAssignments },
  { version: 21, name: 'curriculum subject_category major/minor', fn: v21_curriculumSubjectCategory },
  { version: 22, name: 'sync subject_category from lecture/lab hours', fn: v22_syncSubjectCategoryFromHours },
  { version: 23, name: 'instructor Google verification columns', fn: v23_instructorGoogleVerification },
  { version: 24, name: 'login OTP challenge table',             fn: v24_loginOtpChallenges },
  { version: 25, name: 'auth_version + trusted_devices',        fn: v25_authVersionAndTrustedDevices },
  { version: 26, name: 'instructor google_picture',             fn: v26_instructorGooglePicture },
  { version: 27, name: 'otp challenge purpose',                 fn: v27_otpPurpose },
  { version: 28, name: 'trusted device login activity fields',  fn: v28_trustedDeviceActivity },
  { version: 29, name: 'cleanup orphaned schedule_sessions',    fn: v29_cleanupOrphanedScheduleSessions },
  { version: 30, name: 'dept chair program + Google columns',  fn: v30_deptChairProgramAndGoogle },
  { version: 31, name: 'per-account otp_enabled preference',  fn: v31_otpEnabledPreference },
  { version: 32, name: 'global email registry + auth hardening', fn: v32_emailRegistryAndAuthHardening },
  { version: 33, name: 'curriculum version old/new',             fn: v33_curriculumVersion },
  { version: 34, name: 'existing curriculum rows are old',       fn: v34_existingCurriculumIsOld },
  { version: 35, name: 'swap new subjects to old if old empty',  fn: v35_swapNewSubjectsToOldWhenOldEmpty },
  { version: 36, name: 'blocks.curriculum_version old/new',      fn: v36_blockCurriculumVersion },
  { version: 37, name: 'workload monitoring notification unique', fn: v37_monitoringNotificationUnique },
  { version: 38, name: 'overload review notification unique', fn: v38_overloadReviewNotificationUnique },
  { version: 39, name: 'faculty_priority_subjects table',        fn: v39_facultyPrioritySubjects },
  { version: 40, name: 'rename department_chair role to program_chair', fn: v40_renameDeptChairToProgramChair },
  { version: 41, name: 'audit_logs table',                       fn: v41_auditLogs },
  { version: 42, name: 'merge priority subjects by code + title', fn: v42_mergePrioritySubjects },
  { version: 43, name: 'Temporary Permanent is unit-based',       fn: v43_temporaryPermanentUnitBased },
  { version: 44, name: 'faculty_blocks table',                    fn: v44_facultyBlocks },
  { version: 45, name: 'seed faculty_blocks from current loads',  fn: v45_seedFacultyBlocks },
  { version: 46, name: 'semester_day_combinations table',         fn: v46_semesterDayCombinations },
  { version: 47, name: 'curriculum manual subject_category',      fn: v47_curriculumCategoryManual },
  { version: 48, name: 'realtime_versions table',                 fn: v48_realtimeVersions },
];

// ─── public entry point ───────────────────────────────────────────────────────

// Detect whether this is an existing database that was set up before the
// schema_migrations tracking table existed. If so, stamp all migrations up to
// and including v16 as already-applied so they are not re-run — v17 and above
// will still execute as needed.
async function bootstrapExistingDatabase() {
  const migrationsEmpty = await query(
    'SELECT 1 FROM schema_migrations LIMIT 1'
  ).then(r => r.rows.length === 0);

  if (!migrationsEmpty) return; // already has tracking rows — nothing to bootstrap

  // Check for a well-known column that only exists after v16 was applied.
  // 'confirmed_at' was added in v16 on room_change_requests.
  const hasV16 = await query(`
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'room_change_requests'
      AND column_name = 'confirmed_at'
    LIMIT 1
  `).then(r => r.rows.length > 0);

  if (!hasV16) return; // fresh database — let the normal migration loop handle everything

  // Existing database: stamp v1–v16 as applied so they are skipped.
  console.log('[migrate] Existing database detected — stamping v1–v16 as already applied.');
  for (const m of MIGRATIONS.filter(m => m.version <= 16)) {
    await markApplied(m.version, m.name);
  }
}

export async function runMigrations() {
  try {
    await ensureMigrationsTable();
    await bootstrapExistingDatabase();

    for (const m of MIGRATIONS) {
      await runMigration(m.version, m.name, m.fn);
    }

    console.log('[migrate] All migrations are up to date.');
    return { success: true };
  } catch (error) {
    console.error('[migrate] Fatal migration error:', error);
    throw error;
  }
}

-- ============================================================
-- INSTRUCTOR WORKLOAD, SCHEDULING & ROOM UTILIZATION SYSTEM
-- Database Schema
-- ============================================================

-- Users (Admin / Department Chair authentication)
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(100) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(50) DEFAULT 'admin',
  is_active BOOLEAN DEFAULT TRUE,
  google_sub VARCHAR(255),
  google_verified BOOLEAN NOT NULL DEFAULT FALSE,
  google_verified_at TIMESTAMPTZ,
  google_picture VARCHAR(1000),
  otp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Programs
CREATE TABLE IF NOT EXISTS programs (
  id SERIAL PRIMARY KEY,
  code VARCHAR(20) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  department VARCHAR(255),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Department Chair program scope (added after programs exists)
ALTER TABLE users ADD COLUMN IF NOT EXISTS program_id INTEGER REFERENCES programs(id) ON DELETE SET NULL;

-- Curriculums (Subject definitions per program/year/semester)
CREATE TABLE IF NOT EXISTS curriculums (
  id SERIAL PRIMARY KEY,
  program_id INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  year_level VARCHAR(20) NOT NULL,
  semester VARCHAR(20) NOT NULL,
  subject_code VARCHAR(50) NOT NULL,
  subject_name VARCHAR(255) NOT NULL,
  lecture_hours NUMERIC(4,2) DEFAULT 0,
  laboratory_hours NUMERIC(4,2) DEFAULT 0,
  total_hours NUMERIC(4,2) GENERATED ALWAYS AS (lecture_hours + laboratory_hours) STORED,
  units NUMERIC(4,2) DEFAULT 0,
  prerequisites TEXT NOT NULL DEFAULT '',
  grade VARCHAR(50) NOT NULL DEFAULT '',
  subject_category VARCHAR(10) NOT NULL DEFAULT 'Minor',
  curriculum_version VARCHAR(20) NOT NULL DEFAULT 'old' CHECK (curriculum_version IN ('old', 'new')),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(program_id, year_level, semester, subject_code, curriculum_version)
);

-- Faculty (Instructor profiles)
CREATE TABLE IF NOT EXISTS faculty (
  id SERIAL PRIMARY KEY,
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  middle_name VARCHAR(100) DEFAULT '',
  name VARCHAR(255) NOT NULL,
  employee_id VARCHAR(50) UNIQUE,
  department VARCHAR(255),
  program_id INTEGER REFERENCES programs(id) ON DELETE SET NULL,
  position VARCHAR(100) NOT NULL CHECK (position IN (
    'Temporary Permanent',
    'Instructor I', 'Instructor II', 'Instructor III',
    'Assistant Professor I', 'Assistant Professor II', 'Assistant Professor III',
    'Assistant Professor IV', 'Assistant Professor V',
    'Associate Professor I', 'Associate Professor II',
    'Associate Professor III', 'Associate Professor IV',
    'Professor I', 'Professor II', 'Professor III',
    'Professor IV', 'Professor V', 'Professor VI',
    'Contractual'
  )),
  -- employment_status is auto-derived: Contractual/Temporary Permanent → hour-based, otherwise Permanent
  employment_status VARCHAR(20) GENERATED ALWAYS AS (
    CASE WHEN position IN ('Contractual', 'Temporary Permanent') THEN 'Contractual' ELSE 'Permanent' END
  ) STORED,
  designation_type TEXT DEFAULT 'No Designation',
  designation_units NUMERIC(4,2) DEFAULT 0,
  load_type VARCHAR(50) DEFAULT 'Regular',
  email VARCHAR(255),
  contact_number VARCHAR(20),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Blocks
CREATE TABLE IF NOT EXISTS blocks (
  id SERIAL PRIMARY KEY,
  program_id INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  year_level VARCHAR(20) NOT NULL,
  semester VARCHAR(20) NOT NULL,
  academic_year VARCHAR(20) NOT NULL,
  block_name VARCHAR(10) NOT NULL,
  number_of_students INTEGER DEFAULT 0,
  curriculum_version VARCHAR(20) NOT NULL DEFAULT 'old' CHECK (curriculum_version IN ('old', 'new')),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Block Subjects (Subjects loaded into each block from curriculum)
CREATE TABLE IF NOT EXISTS block_subjects (
  id SERIAL PRIMARY KEY,
  block_id INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  curriculum_id INTEGER NOT NULL REFERENCES curriculums(id) ON DELETE CASCADE,
  status VARCHAR(20) DEFAULT 'Unscheduled',
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(block_id, curriculum_id)
);

-- Master Schedule
CREATE TABLE IF NOT EXISTS master_schedule (
  id SERIAL PRIMARY KEY,
  block_subject_id INTEGER NOT NULL REFERENCES block_subjects(id) ON DELETE CASCADE,
  faculty_id INTEGER REFERENCES faculty(id) ON DELETE SET NULL,
  day_pattern VARCHAR(50),
  start_time TIME,
  end_time TIME,
  room_id INTEGER,
  split_type VARCHAR(20) DEFAULT 'Manual',
  status VARCHAR(20) DEFAULT 'Unassigned',
  academic_year VARCHAR(20),
  semester VARCHAR(20),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Instructor Loads
CREATE TABLE IF NOT EXISTS instructor_loads (
  id SERIAL PRIMARY KEY,
  faculty_id INTEGER NOT NULL REFERENCES faculty(id) ON DELETE CASCADE,
  master_schedule_id INTEGER NOT NULL REFERENCES master_schedule(id) ON DELETE CASCADE,
  load_category VARCHAR(20) NOT NULL CHECK (load_category IN ('Regular', 'Overload', 'Praise')),
  units NUMERIC(4,2) DEFAULT 0,
  hours NUMERIC(4,2) DEFAULT 0,
  academic_year VARCHAR(20) NOT NULL,
  semester VARCHAR(20) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(faculty_id, master_schedule_id)
);

-- Overloads
CREATE TABLE IF NOT EXISTS overloads (
  id SERIAL PRIMARY KEY,
  faculty_id INTEGER NOT NULL REFERENCES faculty(id) ON DELETE CASCADE,
  master_schedule_id INTEGER REFERENCES master_schedule(id) ON DELETE CASCADE,
  units NUMERIC(4,2) DEFAULT 0,
  hours NUMERIC(4,2) DEFAULT 0,
  reason TEXT DEFAULT 'Teaching overload',
  academic_year VARCHAR(20) NOT NULL,
  semester VARCHAR(20) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Praise (Permanent faculty only)
CREATE TABLE IF NOT EXISTS praise (
  id SERIAL PRIMARY KEY,
  faculty_id INTEGER NOT NULL REFERENCES faculty(id) ON DELETE CASCADE,
  praise_type VARCHAR(100) NOT NULL,
  description TEXT,
  equivalent_units NUMERIC(4,2) DEFAULT 0,
  equivalent_hours NUMERIC(4,2) DEFAULT 0,
  academic_year VARCHAR(20) NOT NULL,
  semester VARCHAR(20) NOT NULL,
  remarks TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Rooms
CREATE TABLE IF NOT EXISTS rooms (
  id SERIAL PRIMARY KEY,
  room_name VARCHAR(100) NOT NULL,
  room_type VARCHAR(20) NOT NULL CHECK (room_type IN ('Laboratory', 'Lecture')),
  capacity INTEGER DEFAULT 0,
  building VARCHAR(100),
  qr_code_id VARCHAR(255) UNIQUE,
  qr_code_data TEXT,
  status VARCHAR(20) DEFAULT 'Active',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Schedule Sessions (detailed per-day schedule entries)
CREATE TABLE IF NOT EXISTS schedule_sessions (
  id SERIAL PRIMARY KEY,
  master_schedule_id INTEGER NOT NULL REFERENCES master_schedule(id) ON DELETE CASCADE,
  day_of_week VARCHAR(20) NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  session_hours NUMERIC(4,2) NOT NULL,
  room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- QR Scan Logs
CREATE TABLE IF NOT EXISTS qr_scan_logs (
  id SERIAL PRIMARY KEY,
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  faculty_id INTEGER NOT NULL REFERENCES faculty(id) ON DELETE CASCADE,
  master_schedule_id INTEGER REFERENCES master_schedule(id) ON DELETE SET NULL,
  scan_time TIMESTAMP NOT NULL DEFAULT NOW(),
  scan_date DATE NOT NULL DEFAULT CURRENT_DATE,
  status VARCHAR(20) NOT NULL CHECK (status IN ('Valid', 'Late', 'Overuse', 'Invalid')),
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Room Utilization Logs
CREATE TABLE IF NOT EXISTS room_utilization_logs (
  id SERIAL PRIMARY KEY,
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  faculty_id INTEGER REFERENCES faculty(id) ON DELETE SET NULL,
  master_schedule_id INTEGER REFERENCES master_schedule(id) ON DELETE SET NULL,
  usage_date DATE NOT NULL,
  start_time TIME,
  end_time TIME,
  status VARCHAR(20) DEFAULT 'Used',
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Violations
CREATE TABLE IF NOT EXISTS violations (
  id SERIAL PRIMARY KEY,
  violation_type VARCHAR(50) NOT NULL,
  faculty_id INTEGER REFERENCES faculty(id) ON DELETE SET NULL,
  room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
  master_schedule_id INTEGER REFERENCES master_schedule(id) ON DELETE SET NULL,
  description TEXT,
  violation_date TIMESTAMP DEFAULT NOW(),
  resolved BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Instructor Accounts (login credentials for faculty members)
CREATE TABLE IF NOT EXISTS instructor_accounts (
  id SERIAL PRIMARY KEY,
  faculty_id INTEGER NOT NULL UNIQUE REFERENCES faculty(id) ON DELETE CASCADE,
  username VARCHAR(100) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(50) DEFAULT 'instructor',
  is_active BOOLEAN DEFAULT TRUE,
  google_sub VARCHAR(255) UNIQUE,
  google_verified BOOLEAN NOT NULL DEFAULT FALSE,
  google_verified_at TIMESTAMPTZ,
  google_picture VARCHAR(1000),
  otp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Instructor Load Deductions (normalized per-semester deduction records)
CREATE TABLE IF NOT EXISTS instructor_load_deductions (
  id            SERIAL PRIMARY KEY,
  faculty_id    INTEGER NOT NULL REFERENCES faculty(id) ON DELETE CASCADE,
  deduction_type TEXT NOT NULL,
  description   TEXT DEFAULT '',
  deducted_units NUMERIC(4,2) NOT NULL DEFAULT 0,
  semester      TEXT NOT NULL,
  school_year   TEXT NOT NULL,
  created_at    TIMESTAMP DEFAULT NOW(),
  updated_at    TIMESTAMP DEFAULT NOW()
);

-- Room Occupancy (live room reservation locks — 15-min Pending → Occupied/Expired)
CREATE TABLE IF NOT EXISTS room_occupancy (
  id          SERIAL        PRIMARY KEY,
  room_id     INTEGER       NOT NULL REFERENCES rooms(id)   ON DELETE CASCADE,
  faculty_id  INTEGER       NOT NULL REFERENCES faculty(id) ON DELETE CASCADE,
  status      VARCHAR(20)   NOT NULL DEFAULT 'Pending'
              CHECK (status IN ('Pending','Occupied','Released','Expired')),
  reserved_at TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ   NOT NULL DEFAULT (NOW() + INTERVAL '15 minutes'),
  occupied_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ
);

-- Room Change Requests (instructor-initiated room swaps with QR confirmation)
CREATE TABLE IF NOT EXISTS room_change_requests (
  id                    SERIAL PRIMARY KEY,
  faculty_id            INTEGER NOT NULL REFERENCES faculty(id) ON DELETE CASCADE,
  master_schedule_id    INTEGER REFERENCES master_schedule(id) ON DELETE SET NULL,
  original_room_id      INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
  requested_room_id     INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
  reason                TEXT NOT NULL,
  status                VARCHAR(30) DEFAULT 'Pending',
  admin_notes           TEXT,
  auto_notes            TEXT,
  submitted_by          VARCHAR(20) DEFAULT 'admin',
  confirmation_deadline TIMESTAMPTZ,
  approved_at           TIMESTAMPTZ,
  rejected_at           TIMESTAMPTZ,
  expired_at            TIMESTAMPTZ,
  confirmed_at          TIMESTAMPTZ,
  created_at            TIMESTAMP DEFAULT NOW(),
  updated_at            TIMESTAMP DEFAULT NOW()
);

-- Indexes
-- Partial unique index: only active blocks enforce uniqueness, so a deleted block
-- never blocks re-creation of the same program/year/semester/academic_year/block_name/curriculum.
CREATE UNIQUE INDEX IF NOT EXISTS blocks_active_unique
  ON blocks(program_id, year_level, semester, academic_year, block_name, curriculum_version)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_instructor_accounts_faculty ON instructor_accounts(faculty_id);
CREATE INDEX IF NOT EXISTS idx_curriculums_program ON curriculums(program_id);
CREATE INDEX IF NOT EXISTS idx_blocks_program ON blocks(program_id);
CREATE INDEX IF NOT EXISTS idx_block_subjects_block ON block_subjects(block_id);
CREATE INDEX IF NOT EXISTS idx_master_schedule_faculty ON master_schedule(faculty_id);
CREATE INDEX IF NOT EXISTS idx_master_schedule_block_subject ON master_schedule(block_subject_id);
CREATE INDEX IF NOT EXISTS idx_instructor_loads_faculty ON instructor_loads(faculty_id);
CREATE INDEX IF NOT EXISTS idx_schedule_sessions_master ON schedule_sessions(master_schedule_id);
CREATE INDEX IF NOT EXISTS idx_qr_scan_logs_room ON qr_scan_logs(room_id);
CREATE INDEX IF NOT EXISTS idx_qr_scan_logs_faculty ON qr_scan_logs(faculty_id);
CREATE INDEX IF NOT EXISTS idx_qr_scan_logs_date ON qr_scan_logs(scan_date);

-- Composite indexes for fast conflict detection
-- Used by check-conflicts and scheduling POST for overlap queries
CREATE INDEX IF NOT EXISTS idx_schedule_sessions_conflict
  ON schedule_sessions(day_of_week, start_time, end_time);
CREATE INDEX IF NOT EXISTS idx_schedule_sessions_room_day
  ON schedule_sessions(room_id, day_of_week)
  WHERE room_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_master_schedule_status
  ON master_schedule(status);
CREATE INDEX IF NOT EXISTS idx_master_schedule_faculty_status
  ON master_schedule(faculty_id, status)
  WHERE faculty_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_instructor_loads_faculty_semester
  ON instructor_loads(faculty_id, academic_year, semester);
CREATE INDEX IF NOT EXISTS idx_overloads_faculty_semester
  ON overloads(faculty_id, academic_year, semester);

-- Temporary password-login verification challenges (HMAC of challengeId:code; never store plaintext OTP)
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  purpose VARCHAR(40) NOT NULL DEFAULT 'login'
);
CREATE INDEX IF NOT EXISTS login_otp_challenges_active_account_idx
  ON login_otp_challenges (account_kind, account_id)
  WHERE used_at IS NULL;
CREATE INDEX IF NOT EXISTS login_otp_challenges_expires_idx
  ON login_otp_challenges (expires_at);

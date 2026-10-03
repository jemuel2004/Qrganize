import bcrypt from 'bcryptjs';
import { connectClient } from '@/database/db';
import { FACULTY_ACTIVITIES_SQL } from '@/database/facultyActivitiesSchema';
import { ensureAuditTable } from '@/database/auditSchema';
import { ensureRealtimeTable } from '@/database/realtimeSchema';
import { dayCombinationError, type WeekDay } from '@shared/dayCombination';
import { maxDeductionUnits } from '@shared/regularLoad';
import { parseWorkloadSheet, roomKey } from '@shared/workloadImport';
import { findScheduleConflicts, type ScheduleConflict } from '@/services/scheduleConflicts';
import { generateRoomQr } from '@/services/roomQr';
import { getWorkloadPolicy } from '@/services/workloadPolicy';
import { loadFacultyLoadSummaries } from '@/services/facultyLoadSummaries';
import { syncWorkloadMonitoringNotifications } from '@/services/workloadMonitoring';
import { readWorkloadWorkbook } from './workbook';
import { loadImportCatalog } from './catalog';
import { buildImportPlan } from './plan';
import { clock, dayIndex, describeSessions, fmtHours, sessionsAreValid, shortDay } from './components';
import type {
  ImportPlan, ImportTerm, PlanIssue, PlannedClass, PlannedComponent, PlannedSession, RoomRef, SessionType,
} from './types';

/*
 * Excel workload import — carrying out the plan.
 *
 * Everything runs in ONE transaction: a dry run rolls it back at the end, so
 * it shows exactly what an import would do; --apply commits it. Nothing is
 * deleted or overwritten — an existing record is reused, and a class that is
 * already assigned in QRganize is left as it is.
 *
 * Classes are placed in priority order (Regular, then Overload, then Praise)
 * with QRganize's own conflict check (findScheduleConflicts — the one the
 * Scheduling page uses), so every class sees the ones placed before it:
 *   1. the time from the workbook, if it is valid and free;
 *   2. the same class's time from another sheet of the workbook;
 *   3. otherwise the nearest vacant valid time — same days first, then other
 *      day sets used on the forms — that keeps the length and number of
 *      meetings and is free for the faculty (classes and non-teaching time),
 *      the block and a valid room.
 * A room that is taken or of the wrong type is replaced by a free existing
 * room of the right type; a blank room stays blank.
 */

export interface ImportOptions {
  filePath: string;
  term: ImportTerm;
  apply: boolean;
  /** Initial password of accounts created for new faculty */
  initialPassword: string;
}

type Q = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export interface ComponentOutcome {
  type: SessionType;
  result: 'as-written' | 'adjusted' | 'other-sheet' | 'moved' | 'unscheduled';
  formTime: string;
  sessions: string;
  rooms: string;
  timeConflicts: string[];
  roomNotes: string[];
  notes: string[];
}

export interface ClassOutcome {
  id: string;
  faculty: string;
  subject: string;
  block: string;
  category: string;
  status: 'imported' | 'unchanged' | 'kept-existing';
  value: number;
  unit: 'units' | 'hours';
  excelUnits: number;
  excelHours: number;
  components: ComponentOutcome[];
  notes: string[];
}

export interface ValidationCheck { name: string; ok: boolean; detail: string }

export interface ImportReport {
  mode: 'dry-run' | 'apply';
  file: string;
  term: ImportTerm;
  committed: boolean;
  plan: ImportPlan;
  schoolYear: 'created' | 'existing';
  faculty: {
    created: { name: string; id: number; program: string | null }[];
    matched: { name: string; id: number; excelName: string }[];
    accounts: { name: string; username: string; email: string }[];
    profileFilled: { name: string; fields: string[] }[];
  };
  rooms: { created: { name: string; id: number; type: string; reason: string }[]; matched: { excel: string; room: string }[] };
  blocks: { created: string[]; existing: string[] };
  classes: ClassOutcome[];
  activities: { inserted: number; existing: number; clipped: string[]; dropped: string[] };
  deductions: { faculty: string; status: 'inserted' | 'unchanged' | 'kept-existing' | 'over-limit'; detail: string }[];
  conflicts: { timeDetected: number; timeResolved: number; roomDetected: number; roomResolved: number };
  totals: {
    faculty: string;
    employment: string;
    regular: number; overload: number; praise: number; deloading: number; limit: number;
    unit: 'units' | 'hours';
    excel: { regular: number; overload: number; praise: number };
  }[];
  validation: ValidationCheck[];
  issues: PlanIssue[];
}

const WEEK: WeekDay[] = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const round2 = (n: number) => Math.round(n * 100) / 100;
const naturalKey = (s: string) => s.toLowerCase().replace(/\d+/g, d => d.padStart(6, '0'));

interface RoomInfo { id: number; name: string; type: string; status: string }

interface PlacedSession { day: WeekDay; start: number; end: number; type: SessionType; roomId: number | null }

export async function runWorkloadImport(options: ImportOptions): Promise<ImportReport> {
  const { term } = options;
  const sheets = readWorkloadWorkbook(options.filePath).map(parseWorkloadSheet);

  // Pool-level setup before the transaction (idempotent; nothing is changed if present)
  await ensureRealtimeTable();
  await ensureAuditTable();
  const policy = await getWorkloadPolicy();
  const passwordHash = await bcrypt.hash(options.initialPassword, 12);

  const client = await connectClient();
  const q: Q = (text, params) => client.query(text, params);
  let committed = false;
  try {
    await client.query('BEGIN');
    // Same lock as saving a schedule: no one can book a slot while the import places classes
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('qrganize:schedule-save'))`);
    await ensureSchema(q);

    const catalog = await loadImportCatalog(q, term);
    const plan = buildImportPlan(sheets, catalog, term);
    const report = emptyReport(options, plan);

    report.schoolYear = await ensureSchoolYear(q, term.academicYear);

    // ── Rooms ───────────────────────────────────────────────────────────────
    const rooms = new Map<number, RoomInfo>(catalog.rooms.map(r => [r.id, { ...r }]));
    const newRoomIds = new Map<string, number>();
    for (const r of plan.newRooms) {
      const found = await q(
        `SELECT id, room_name, room_type, COALESCE(status, 'Active') AS status FROM rooms
          WHERE LOWER(REGEXP_REPLACE(TRIM(room_name), '\\s+', ' ', 'g')) = LOWER($1) LIMIT 1`, [r.name]);
      let id: number;
      if (found.rows[0]) {
        id = Number(found.rows[0].id);
      } else {
        const ins = await q(
          `INSERT INTO rooms (room_name, room_type, capacity, building, status) VALUES ($1, $2, 0, NULL, 'Active') RETURNING id`,
          [r.name, r.type]);
        id = Number(ins.rows[0].id);
        await generateRoomQr({ id, room_name: r.name, room_type: r.type }, q);
        report.rooms.created.push({ name: r.name, id, type: r.type, reason: r.reason });
      }
      newRoomIds.set(r.key, id);
      rooms.set(id, { id, name: r.name, type: r.type, status: 'Active' });
    }
    report.rooms.matched = plan.roomMatches.map(m => ({ excel: m.excelText, room: m.roomName }));
    const roomIdOf = (ref: RoomRef | null): number | null =>
      !ref ? null : ref.roomId ?? (ref.newRoomKey ? newRoomIds.get(ref.newRoomKey) ?? null : null);

    // ── Faculty and accounts ─────────────────────────────────────────────────
    const facultyIds = new Map<string, number>();
    const programIdByCode = new Map(catalog.programs.map(p => [p.code.toUpperCase(), p.id]));
    for (const f of plan.faculty) {
      let id: number;
      if (f.existing) {
        id = f.existing.id;
        report.faculty.matched.push({ name: f.existing.name, id, excelName: f.excelName });
      } else {
        const c = f.create!;
        const ins = await q(
          `INSERT INTO faculty (first_name, last_name, middle_name, name, program_id, position, designation_type, designation_units,
                                load_type, years_in_service, educational_qualification, major, eligibility)
           VALUES ($1, $2, $3, $4, $5, NULL, 'No Designation', 0, 'Regular', $6, $7, $8, $9) RETURNING id`,
          [c.firstName, c.lastName, c.middleName, c.fullName,
            c.programCode ? programIdByCode.get(c.programCode.toUpperCase()) ?? null : null,
            f.profileFill.yearsInService ?? null, f.profileFill.qualification ?? null, f.profileFill.major ?? null, f.profileFill.eligibility ?? null]);
        id = Number(ins.rows[0].id);
        await q(`UPDATE faculty SET employee_id = 'FAC-' || LPAD($1::text, 4, '0') WHERE id = $1`, [id]);
        report.faculty.created.push({ name: c.fullName, id, program: c.programCode });
      }
      facultyIds.set(f.key, id);

      if (f.existing) {
        const fields: string[] = [];
        const sets: string[] = [];
        const params: unknown[] = [id];
        const fill = (col: string, label: string, v: unknown) => {
          if (v == null || v === '') return;
          params.push(v);
          sets.push(`${col} = CASE WHEN ${col} IS NULL OR TRIM(${col}::text) = '' THEN $${params.length} ELSE ${col} END`);
          fields.push(`${label}: ${v}`);
        };
        fill('educational_qualification', 'Educational Qualification', f.profileFill.qualification);
        fill('major', 'Major', f.profileFill.major);
        fill('eligibility', 'Eligibility', f.profileFill.eligibility);
        fill('years_in_service', 'Years in Service', f.profileFill.yearsInService);
        if (sets.length) {
          await q(`UPDATE faculty SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`, params);
          report.faculty.profileFilled.push({ name: f.existing.name, fields });
        }
      }

      if (f.needsAccount) {
        const has = await q('SELECT username FROM instructor_accounts WHERE faculty_id = $1', [id]);
        if (!has.rows[0]) {
          const username = await freeUsername(q, f.create?.usernameBase ?? (f.existing?.firstName ?? f.name.first).toLowerCase().replace(/[^a-z0-9]/g, ''));
          const email = await freePlaceholderEmail(q, username);
          const acct = await q(
            `INSERT INTO instructor_accounts (faculty_id, username, email, password_hash, role) VALUES ($1, $2, $3, $4, 'instructor') RETURNING id`,
            [id, username, email, passwordHash]);
          await q(`INSERT INTO account_email_registry (email_normalized, account_kind, account_id) VALUES ($1, 'instructor', $2)`,
            [email, Number(acct.rows[0].id)]);
          report.faculty.accounts.push({ name: f.existing?.name ?? f.create!.fullName, username, email });
        }
      }
    }
    const facultyLabel = new Map(plan.faculty.map(f => [f.key, f.existing?.name ?? f.create!.fullName]));
    const isPermanentOf = new Map(plan.faculty.map(f => [f.key, f.classification === 'Permanent']));

    // ── Blocks ──────────────────────────────────────────────────────────────
    const blockIds = new Map<string, number>();
    for (const b of plan.blocks) {
      const label = `${b.programCode} ${b.year}${b.blockName}`;
      if (b.existingId) {
        blockIds.set(b.key, b.existingId);
        report.blocks.existing.push(label);
        continue;
      }
      const ins = await q(
        `INSERT INTO blocks (program_id, year_level, semester, academic_year, block_name, number_of_students, curriculum_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [b.programId, b.yearLevel, term.semester, term.academicYear, b.blockName, b.students, b.version]);
      const blockId = Number(ins.rows[0].id);
      await q(
        `INSERT INTO block_subjects (block_id, curriculum_id, status)
         SELECT $1, c.id, 'Unscheduled' FROM curriculums c
          WHERE c.program_id = $2 AND c.year_level = $3 AND c.semester = $4 AND c.curriculum_version = $5 AND c.is_active = true
         ON CONFLICT (block_id, curriculum_id) DO NOTHING`,
        [blockId, b.programId, b.yearLevel, term.semester, b.version]);
      await q(
        `INSERT INTO master_schedule (block_subject_id, status, academic_year, semester)
         SELECT bs.id, 'Unassigned', $2, $3 FROM block_subjects bs WHERE bs.block_id = $1
         ON CONFLICT DO NOTHING`,
        [blockId, term.academicYear, term.semester]);
      blockIds.set(b.key, blockId);
      report.blocks.created.push(label);
    }

    // ── Classes, in priority order ──────────────────────────────────────────
    const activitiesByFaculty = new Map<string, { day: WeekDay; start: number; end: number; activity: string }[]>();
    for (const a of plan.activities) activitiesByFaculty.set(a.facultyKey, [...(activitiesByFaculty.get(a.facultyKey) ?? []), a]);
    const ctx: PlacementContext = {
      q, term, rooms, roomIdOf, combos: catalog.dayCombinations, plan, activitiesByFaculty,
      daySets: plan.observedDaySets,
      wanted: plan.classes.flatMap(c => c.components.flatMap(k => (k.candidates[0]?.sessions ?? []).map(s => ({
        key: `${c.id}|${k.type}`, facultyKey: c.facultyKey, blockKey: c.blockKey, day: s.day, start: s.start, end: s.end,
      })))),
      placedKeys: new Set<string>(),
      roomNotesGiven: new Set<string>(),
    };

    const roomTasks: RoomTask[] = [];
    for (const cls of plan.classes) {
      const facultyId = facultyIds.get(cls.facultyKey)!;
      const blockId = blockIds.get(cls.blockKey)!;
      const { outcome, tasks } = await placeClassTimes(ctx, cls, facultyId, blockId, isPermanentOf.get(cls.facultyKey)!, report);
      report.classes.push(outcome);
      roomTasks.push(...tasks);
      if (outcome.status !== 'kept-existing') {
        await q('INSERT INTO faculty_blocks (faculty_id, block_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [facultyId, blockId]);
      }
    }
    await assignRooms(ctx, roomTasks, report);

    // ── Non-teaching activities: teaching time wins, the rest blocks availability ──
    for (const [facultyKey, list] of activitiesByFaculty) {
      const facultyId = facultyIds.get(facultyKey)!;
      const busy = await q(
        `SELECT ss.day_of_week, EXTRACT(EPOCH FROM ss.start_time)::int / 60 AS s, EXTRACT(EPOCH FROM ss.end_time)::int / 60 AS e
           FROM schedule_sessions ss
           JOIN master_schedule ms ON ms.id = ss.master_schedule_id
           JOIN block_subjects bs ON bs.id = ms.block_subject_id
           JOIN blocks b ON b.id = bs.block_id
          WHERE ms.faculty_id = $1 AND ms.status IN ('Assigned', 'Scheduled', 'Completed')
            AND b.semester = $2 AND b.academic_year = $3`,
        [facultyId, term.semester, term.academicYear]);
      for (const a of list) {
        const classes = busy.rows.filter(r => r.day_of_week === a.day).map(r => ({ s: Number(r.s), e: Number(r.e) }));
        let pieces = [{ start: a.start, end: a.end }];
        for (const c of classes) {
          pieces = pieces.flatMap(p => (c.e <= p.start || c.s >= p.end ? [p]
            : [{ start: p.start, end: Math.min(p.end, c.s) }, { start: Math.max(p.start, c.e), end: p.end }].filter(x => x.end - x.start >= 5)));
        }
        const name = facultyLabel.get(facultyKey)!;
        const what = `${name}: ${a.activity} ${shortDay(a.day)} ${clock(a.start)}–${clock(a.end)}`;
        if (!pieces.length) { report.activities.dropped.push(`${what} — the whole time is a class on the form`); continue; }
        if (pieces.length !== 1 || pieces[0].start !== a.start || pieces[0].end !== a.end) {
          report.activities.clipped.push(`${what} → ${pieces.map(p => `${clock(p.start)}–${clock(p.end)}`).join(', ')} (overlapping class time kept as class)`);
        }
        for (const p of pieces) {
          const same = await q(
            `SELECT 1 FROM faculty_activities WHERE faculty_id = $1 AND academic_year = $2 AND semester = $3 AND day_of_week = $4
                AND lower(activity) = lower($5) AND start_time < $7::time AND end_time > $6::time LIMIT 1`,
            [facultyId, term.academicYear, term.semester, a.day, a.activity, hhmm(p.start), hhmm(p.end)]);
          if (same.rows[0]) { report.activities.existing++; continue; }
          await q(
            `INSERT INTO faculty_activities (faculty_id, academic_year, semester, day_of_week, start_time, end_time, activity, source)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'excel-import') ON CONFLICT DO NOTHING`,
            [facultyId, term.academicYear, term.semester, a.day, hhmm(p.start), hhmm(p.end), a.activity]);
          report.activities.inserted++;
        }
      }
    }

    // ── Deloading (Regular Load form) ───────────────────────────────────────
    const maxDeduction = maxDeductionUnits(policy);
    for (const f of plan.faculty) {
      if (!f.deductions.length) continue;
      const id = facultyIds.get(f.key)!;
      const name = facultyLabel.get(f.key)!;
      const total = round2(f.deductions.reduce((s, d) => s + d.units, 0));
      const detail = f.deductions.map(d => `${d.type}: ${d.description} ${d.units}`).join('; ');
      const existing = await q(
        `SELECT deduction_type, description, deducted_units FROM instructor_load_deductions WHERE faculty_id = $1 AND semester = $2 AND school_year = $3`,
        [id, term.semester, term.academicYear]);
      if (existing.rows.length) {
        const sig = (rows: { t: string; d: string; u: number }[]) => rows.map(r => `${r.t}|${r.d}|${round2(r.u)}`).sort().join(';');
        const same = sig(existing.rows.map(r => ({ t: String(r.deduction_type), d: String(r.description ?? ''), u: Number(r.deducted_units) })))
          === sig(f.deductions.map(d => ({ t: d.type, d: d.description, u: d.units })));
        report.deductions.push({ faculty: name, status: same ? 'unchanged' : 'kept-existing', detail: same ? detail : `QRganize already has deloading for this term — kept; the form says ${detail}` });
        continue;
      }
      if (total > maxDeduction + 0.001) {
        report.deductions.push({ faculty: name, status: 'over-limit', detail: `${detail} = ${total} exceeds the ${maxDeduction} maximum — not recorded` });
        continue;
      }
      for (const d of f.deductions) {
        await q(
          `INSERT INTO instructor_load_deductions (faculty_id, deduction_type, description, deducted_units, semester, school_year)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, d.type, d.description, d.units, term.semester, term.academicYear]);
      }
      await q(`UPDATE faculty SET designation_type = $1, designation_units = $2, updated_at = NOW() WHERE id = $3`,
        [f.deductions.map(d => d.type).join(' + '), total, id]);
      report.deductions.push({ faculty: name, status: 'inserted', detail: `${detail} (total ${total})` });
    }

    // ── Totals and validation (inside the same transaction) ────────────────
    report.totals = await workloadTotals(q, plan, facultyIds, facultyLabel, term);
    report.validation = await validate(q, term, plan, facultyIds, report);

    // Open pages refresh once the change is committed; one audit entry for the import
    await q(
      `INSERT INTO realtime_versions AS rv (topic, version, changed_at)
       SELECT t, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000000)::bigint, NOW()
         FROM unnest($1::text[]) AS t
       ON CONFLICT (topic) DO UPDATE SET version = GREATEST(rv.version + 1, EXCLUDED.version), changed_at = NOW()`,
      [['term', 'faculty', 'accounts', 'rooms', 'blocks', 'schedule', 'workload', 'occupancy', 'audit']]);
    const imported = report.classes.filter(c => c.status === 'imported').length;
    await q(
      `INSERT INTO audit_logs (actor_id, actor_role, actor_name, category, action, summary, method, path, status, success, ip, details)
       VALUES (NULL, 'admin', 'Excel workload import', 'Workload', 'Import', $1, 'CLI', 'scripts/import-workload', 200, true, NULL, $2)`,
      [`Imported the ${term.semester} ${term.academicYear} faculty workload from Excel — ${imported} classes, ${report.faculty.created.length} new faculty, ${report.faculty.accounts.length} accounts, ${report.blocks.created.length} blocks, ${report.rooms.created.length} rooms.`.slice(0, 300),
        JSON.stringify({ file: options.filePath.split(/[\\/]/).pop(), classes: imported, faculty_created: report.faculty.created.length, blocks_created: report.blocks.created.length, rooms_created: report.rooms.created.length })]);

    if (options.apply) {
      await client.query('COMMIT');
      committed = true;
    } else {
      await client.query('ROLLBACK');
    }
    report.committed = committed;
    return report;
  } catch (err) {
    if (!committed) await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    if (committed) await syncWorkloadMonitoringNotifications(true).catch(() => {});
  }
}

/* ── Schema needed by the import (created only when missing) ─────────────── */

async function ensureSchema(q: Q) {
  const cols = await q(
    `SELECT table_name, column_name, is_nullable FROM information_schema.columns
      WHERE (table_name, column_name) IN (('overloads','is_praise'), ('instructor_loads','overload_component'), ('schedule_sessions','type'),
                                          ('faculty','position'), ('rooms','qr_generated_at'))`);
  const has = (t: string, c: string) => cols.rows.some(r => r.table_name === t && r.column_name === c);
  if (!has('overloads', 'is_praise')) await q(`ALTER TABLE overloads ADD COLUMN IF NOT EXISTS is_praise BOOLEAN NOT NULL DEFAULT false`);
  if (!has('instructor_loads', 'overload_component')) await q(`ALTER TABLE instructor_loads ADD COLUMN IF NOT EXISTS overload_component VARCHAR(10) DEFAULT 'full'`);
  if (!has('schedule_sessions', 'type')) await q(`ALTER TABLE schedule_sessions ADD COLUMN IF NOT EXISTS type VARCHAR(3) DEFAULT 'lec'`);
  if (!has('rooms', 'qr_generated_at')) await q(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS qr_generated_at TIMESTAMPTZ`);
  if (cols.rows.some(r => r.table_name === 'faculty' && r.column_name === 'position' && r.is_nullable === 'NO')) {
    await q(`ALTER TABLE faculty ALTER COLUMN position DROP NOT NULL`);
  }
  const t = await q(`SELECT to_regclass('public.faculty_activities') AS a, to_regclass('public.school_years') AS y`);
  if (!t.rows[0]?.a) await q(FACULTY_ACTIVITIES_SQL);
  if (!t.rows[0]?.y) await q(`CREATE TABLE IF NOT EXISTS school_years (
      id SERIAL PRIMARY KEY, label VARCHAR(20) NOT NULL UNIQUE,
      status VARCHAR(20) NOT NULL DEFAULT 'Archived' CHECK (status IN ('Active', 'Archived')),
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`);
}

/** The term's school year in Settings, added like "Add school year" does (not made active). */
async function ensureSchoolYear(q: Q, label: string): Promise<'created' | 'existing'> {
  const count = await q('SELECT COUNT(*)::int AS n FROM school_years');
  if (Number(count.rows[0].n) === 0) {
    // Same seeding the school-year list does on first use, so the current year stays active
    const current = await q(`SELECT value FROM system_settings WHERE key = 'current_school_year'`);
    if (current.rows[0]?.value) {
      await q(`INSERT INTO school_years (label, status) VALUES ($1, 'Active') ON CONFLICT (label) DO NOTHING`, [current.rows[0].value]);
    }
  }
  const ins = await q(`INSERT INTO school_years (label, status) VALUES ($1, 'Archived') ON CONFLICT (label) DO NOTHING RETURNING id`, [label]);
  return ins.rows.length ? 'created' : 'existing';
}

async function freeUsername(q: Q, base: string): Promise<string> {
  const stem = base.replace(/[^a-z0-9_]/g, '') || 'faculty';
  for (let n = 0; n < 1000; n++) {
    const candidate = n === 0 ? stem : `${stem}${n}`;
    const taken = await q(
      `SELECT 1 FROM instructor_accounts WHERE LOWER(username) = $1
       UNION ALL SELECT 1 FROM faculty WHERE LOWER(username) = $1 LIMIT 1`, [candidate]);
    if (!taken.rows.length) return candidate;
  }
  throw new Error(`No free username for ${stem}`);
}

/** "<username>@placeholder.local" — QRganize's marker for an account with no registered email */
async function freePlaceholderEmail(q: Q, username: string): Promise<string> {
  for (let n = 0; n < 1000; n++) {
    const email = n === 0 ? `${username}@placeholder.local` : `${username}.${n}@placeholder.local`;
    const taken = await q(
      `SELECT 1 FROM account_email_registry WHERE email_normalized = $1
       UNION ALL SELECT 1 FROM instructor_accounts WHERE lower(trim(email)) = $1
       UNION ALL SELECT 1 FROM users WHERE lower(trim(email)) = $1 LIMIT 1`, [email]);
    if (!taken.rows.length) return email;
  }
  throw new Error(`No free placeholder email for ${username}`);
}

function emptyReport(options: ImportOptions, plan: ImportPlan): ImportReport {
  return {
    mode: options.apply ? 'apply' : 'dry-run',
    file: options.filePath,
    term: options.term,
    committed: false,
    plan,
    schoolYear: 'existing',
    faculty: { created: [], matched: [], accounts: [], profileFilled: [] },
    rooms: { created: [], matched: [] },
    blocks: { created: [], existing: [] },
    classes: [],
    activities: { inserted: 0, existing: 0, clipped: [], dropped: [] },
    deductions: [],
    conflicts: { timeDetected: 0, timeResolved: 0, roomDetected: 0, roomResolved: 0 },
    totals: [],
    validation: [],
    issues: [...plan.issues],
  };
}

/* ── Placing classes: times first, then rooms ────────────────────────────── */

interface PlacementContext {
  q: Q;
  term: ImportTerm;
  rooms: Map<number, RoomInfo>;
  roomIdOf: (ref: RoomRef | null) => number | null;
  combos: WeekDay[][];
  plan: ImportPlan;
  activitiesByFaculty: Map<string, { day: WeekDay; start: number; end: number; activity: string }[]>;
  daySets: WeekDay[][];
  /** Each component's own form time, until it has been placed */
  wanted: { key: string; facultyKey: string; blockKey: string; day: WeekDay; start: number; end: number }[];
  placedKeys: Set<string>;
  roomNotesGiven: Set<string>;
}

/** Placed sessions of one component that share the room the form gives them */
interface RoomTask {
  cls: PlannedClass;
  comp: PlannedComponent;
  outcome: ComponentOutcome;
  msId: number;
  blockId: number;
  sessions: (PlacedSession & { id: number })[];
  /** The form's room for these sessions (null = blank on the form) */
  wanted: RoomRef | null;
}

/**
 * Pass 1 — the class's times. Rooms are left empty here and given in pass 2,
 * once every class has its time, so a room swap never pushes another class
 * out of the room its own form gives it.
 */
async function placeClassTimes(
  ctx: PlacementContext,
  cls: PlannedClass,
  facultyId: number,
  blockId: number,
  isPermanent: boolean,
  report: ImportReport,
): Promise<{ outcome: ClassOutcome; tasks: RoomTask[] }> {
  const { q, term } = ctx;
  const outcome: ClassOutcome = {
    id: cls.id,
    faculty: cls.facultyLabel,
    subject: `${cls.subject.code} ${cls.subject.name}`,
    block: `${cls.programCode} ${cls.year}${cls.block}`,
    category: cls.category.label,
    status: 'imported',
    value: round2(cls.category.portions.reduce((s, p) => s + p.value, 0)),
    unit: isPermanent ? 'units' : 'hours',
    excelUnits: cls.excel.units,
    excelHours: cls.excel.hours,
    components: [],
    notes: [],
  };
  const tasks: RoomTask[] = [];

  // The class's master schedule (created with the block)
  const findMs = () => q(
    `SELECT ms.id, ms.faculty_id FROM master_schedule ms JOIN block_subjects bs ON bs.id = ms.block_subject_id
      WHERE bs.block_id = $1 AND bs.curriculum_id = $2 ORDER BY ms.id DESC LIMIT 1`, [blockId, cls.subject.id]);
  let ms = await findMs();
  if (!ms.rows[0]) {
    const bs = await q(
      `INSERT INTO block_subjects (block_id, curriculum_id, status) VALUES ($1, $2, 'Unscheduled')
       ON CONFLICT (block_id, curriculum_id) DO UPDATE SET status = block_subjects.status RETURNING id`, [blockId, cls.subject.id]);
    await q(`INSERT INTO master_schedule (block_subject_id, status, academic_year, semester) VALUES ($1, 'Unassigned', $2, $3)`,
      [bs.rows[0].id, term.academicYear, term.semester]);
    ms = await findMs();
  }
  const msId = Number(ms.rows[0].id);
  const currentFaculty = ms.rows[0].faculty_id == null ? null : Number(ms.rows[0].faculty_id);
  const loads = await q('SELECT faculty_id, load_category, units, hours, overload_component FROM instructor_loads WHERE master_schedule_id = $1', [msId]);

  // Already assigned in QRganize: never overwritten
  if (currentFaculty != null || loads.rows.length) {
    const owner = currentFaculty ?? Number(loads.rows[0].faculty_id);
    if (owner !== facultyId) {
      const who = await q('SELECT name FROM faculty WHERE id = $1', [owner]);
      const name = String(who.rows[0]?.name ?? `faculty #${owner}`);
      outcome.status = 'kept-existing';
      outcome.notes.push(`already assigned to ${name} in QRganize — kept (the form says ${cls.facultyLabel})`);
      report.issues.push({ level: 'review', topic: 'Existing data', faculty: cls.facultyLabel,
        message: `${outcome.subject} ${outcome.block} is already assigned to ${name} in QRganize; the form gives it to ${cls.facultyLabel} — QRganize's assignment kept.` });
      return { outcome, tasks };
    }
    const il = loads.rows.find(r => Number(r.faculty_id) === facultyId);
    const ol = await q('SELECT units, hours, is_praise FROM overloads WHERE faculty_id = $1 AND master_schedule_id = $2', [facultyId, msId]);
    const value = (r: Record<string, unknown> | undefined) => (r ? Number(isPermanent ? r.units : r.hours) : 0);
    const same = !!il && il.load_category === cls.category.loadCategory
      && Math.abs(value(il) - cls.category.loadValue) < 0.011
      && (il.overload_component ?? 'full') === cls.category.overloadComponent
      && ol.rows.length === (cls.category.overloadRow ? 1 : 0)
      && (!cls.category.overloadRow || (Math.abs(value(ol.rows[0]) - cls.category.overloadRow.value) < 0.011 && !!ol.rows[0].is_praise === cls.category.overloadRow.isPraise));
    outcome.status = same ? 'unchanged' : 'kept-existing';
    if (!same) {
      outcome.notes.push('already assigned to this faculty with different load data — QRganize\'s data kept');
      report.issues.push({ level: 'review', topic: 'Existing data', faculty: cls.facultyLabel,
        message: `${outcome.subject} ${outcome.block}: QRganize already has it for ${cls.facultyLabel} with different load data — kept (the form says ${cls.category.label}).` });
    }
    return { outcome, tasks };
  }

  // Claim the class first so its own other component counts in the conflict check
  await q(`UPDATE master_schedule SET faculty_id = $1, status = 'Assigned', updated_at = NOW() WHERE id = $2`, [facultyId, msId]);

  const placed: PlacedSession[] = [];
  const unscheduled: string[] = [];
  for (const comp of cls.components) {
    const chosen = await chooseTimes(ctx, cls, comp, msId, facultyId, blockId, report);
    outcome.components.push(chosen.outcome);
    if (!chosen.sessions.length) { unscheduled.push(comp.type === 'lec' ? 'Lecture' : 'Laboratory'); continue; }
    const byRoom = new Map<string, { wanted: RoomRef | null; sessions: (PlacedSession & { id: number })[] }>();
    for (const s of chosen.sessions) {
      const ins = await q(
        `INSERT INTO schedule_sessions (master_schedule_id, day_of_week, start_time, end_time, session_hours, room_id, type)
         VALUES ($1, $2, $3, $4, $5, NULL, $6) RETURNING id`,
        [msId, s.day, hhmm(s.start), hhmm(s.end), round2((s.end - s.start) / 60), comp.type]);
      const k = s.room ? String(s.room.roomId ?? s.room.newRoomKey ?? '') : '';
      const group = byRoom.get(k) ?? { wanted: s.room, sessions: [] };
      group.sessions.push({ day: s.day, start: s.start, end: s.end, type: comp.type, roomId: null, id: Number(ins.rows[0].id) });
      byRoom.set(k, group);
      placed.push({ day: s.day, start: s.start, end: s.end, type: comp.type, roomId: null });
    }
    for (const g of byRoom.values()) tasks.push({ cls, comp, outcome: chosen.outcome, msId, blockId, sessions: g.sessions, wanted: g.wanted });
  }
  if (unscheduled.length) {
    const reasons = [...new Set(cls.components.filter(c => !placed.some(s => s.type === c.type)).map(c => c.unscheduledReason ?? 'no vacant valid time was found'))];
    report.issues.push({ level: 'review', topic: 'Schedule', faculty: cls.facultyLabel,
      message: `${cls.subject.code} ${cls.programCode} ${cls.year}${cls.block} (${cls.facultyLabel}) — ${unscheduled.join(' and ')} not scheduled: ${reasons.join('; ')}. The class is assigned with its workload; set its time on the Scheduling page.` });
  }

  const status = cls.components.every(c => placed.some(s => s.type === c.type)) ? 'Scheduled' : 'Assigned';
  if (placed.length) {
    const days = WEEK.filter(d => placed.some(s => s.day === d)).map(shortDay).join('/');
    const first = [...placed].sort((a, b) => a.start - b.start || dayIndex(a.day) - dayIndex(b.day))[0];
    await q(
      `UPDATE master_schedule SET day_pattern = $1, start_time = $2, end_time = $3, split_type = 'Manual', status = $4, updated_at = NOW() WHERE id = $5`,
      [days, hhmm(first.start), hhmm(Math.max(...placed.map(s => s.end))), status, msId]);
  }
  await q(`UPDATE block_subjects SET status = $1 WHERE id = (SELECT block_subject_id FROM master_schedule WHERE id = $2)`, [status, msId]);

  const c = cls.category;
  await q(
    `INSERT INTO instructor_loads (faculty_id, master_schedule_id, load_category, units, hours, academic_year, semester, overload_component)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [facultyId, msId, c.loadCategory, isPermanent ? round2(c.loadValue) : 0, isPermanent ? 0 : round2(c.loadValue), term.academicYear, term.semester, c.overloadComponent]);
  if (c.overloadRow) {
    await q(
      `INSERT INTO overloads (faculty_id, master_schedule_id, units, hours, reason, academic_year, semester, is_praise)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [facultyId, msId, isPermanent ? round2(c.overloadRow.value) : 0, isPermanent ? 0 : round2(c.overloadRow.value), c.overloadRow.reason,
        term.academicYear, term.semester, c.overloadRow.isPraise]);
  }
  return { outcome, tasks };
}

/** One component's time: the workbook's options in order, else the nearest vacant valid time */
async function chooseTimes(
  ctx: PlacementContext, cls: PlannedClass, comp: PlannedComponent, msId: number, facultyId: number, blockId: number, report: ImportReport,
): Promise<{ sessions: PlannedSession[]; outcome: ComponentOutcome }> {
  const label = comp.type === 'lec' ? 'Lecture' : 'Laboratory';
  const out: ComponentOutcome = {
    type: comp.type, result: 'unscheduled', formTime: comp.candidates[0] ? describeSessions(comp.candidates[0].sessions) : '—',
    sessions: '—', rooms: 'no room', timeConflicts: [], roomNotes: [], notes: [],
  };
  if (!comp.candidates.length) {
    out.notes.push(`${label} not scheduled: ${comp.unscheduledReason}`);
    return { sessions: [], outcome: out };
  }

  const key = `${cls.id}|${comp.type}`;
  const done = (sessions: PlannedSession[]) => { ctx.placedKeys.add(key); return sessions; };
  let firstConflict = false;
  for (let i = 0; i < comp.candidates.length; i++) {
    const cand = comp.candidates[i];
    // A second choice must not take another class's own form time (that class would be pushed out)
    if (i > 0 && takesAnotherClassTime(ctx, cls, key, cand.sessions)) continue;
    const t = await tryTimes(ctx, cls, comp, cand.sessions, msId, facultyId, blockId, false);
    if (t.ok) {
      out.result = i === 0 ? (cand.fit === 'as-written' ? 'as-written' : 'adjusted') : 'other-sheet';
      out.sessions = describeSessions(cand.sessions);
      out.notes.push(...cand.notes);
      if (i > 0) {
        out.notes.push(`time from ${cand.sources.map(s => `"${s.sheet}" row ${s.row}`).join(', ')} — the first choice (${out.formTime}) ${out.timeConflicts.length ? `conflicts: ${out.timeConflicts[0]}` : 'is not valid in QRganize'}`);
      }
      if (firstConflict) { report.conflicts.timeDetected++; report.conflicts.timeResolved++; }
      return { sessions: done(cand.sessions), outcome: out };
    }
    if (i === 0) {
      out.timeConflicts.push(...t.timeConflicts);
      firstConflict = t.timeConflicts.length > 0;
      if (t.invalid) out.notes.push(`form time ${out.formTime} is not valid in QRganize: ${t.invalid}`);
    }
  }

  // No workbook time works: the nearest vacant valid time with the same length and meetings
  // (first without taking another class's own form time; only if that finds nothing, any vacant time)
  const base = comp.candidates[0];
  for (const respectOthers of [true, false]) {
    for (const sessions of vacantOptions(ctx, base.sessions)) {
      if (respectOthers && takesAnotherClassTime(ctx, cls, key, sessions)) continue;
      const t = await tryTimes(ctx, cls, comp, sessions, msId, facultyId, blockId, true);
      if (!t.ok) continue;
      out.result = 'moved';
      out.sessions = describeSessions(sessions);
      out.notes.push(...base.notes,
        `moved from ${out.formTime} because ${firstConflict ? 'it conflicts' : 'it is not valid in QRganize'}; ${out.sessions} is the nearest vacant valid time with the same length and number of meetings — free for the faculty (classes and non-teaching time) and the block${respectOthers ? ', and not another class’s own form time' : ''}`);
      if (firstConflict) { report.conflicts.timeDetected++; report.conflicts.timeResolved++; }
      return { sessions: done(sessions), outcome: out };
    }
  }
  ctx.placedKeys.add(key);
  if (firstConflict) report.conflicts.timeDetected++;
  out.notes.push(`${label} not scheduled: the form time conflicts and no vacant valid time was found`);
  return { sessions: [], outcome: out };
}

/**
 * True when these times overlap the form time of a class not placed yet that
 * shares the faculty or the block — taking it would push that class out too.
 */
function takesAnotherClassTime(ctx: PlacementContext, cls: PlannedClass, key: string, sessions: PlannedSession[]): boolean {
  return ctx.wanted.some(w => w.key !== key && !ctx.placedKeys.has(w.key)
    && (w.facultyKey === cls.facultyKey || w.blockKey === cls.blockKey)
    && sessions.some(s => s.day === w.day && w.start < s.end && w.end > s.start));
}

/** Nearest vacant options: same days first (30-minute steps out from the form time), then other day sets of the same size. */
function* vacantOptions(ctx: PlacementContext, base: PlannedSession[]): Generator<PlannedSession[]> {
  const baseDays = [...new Set(base.map(s => s.day))].sort((a, b) => dayIndex(a) - dayIndex(b));
  const allowed = ctx.combos.length ? ctx.combos : ctx.daySets;
  const sets: WeekDay[][] = [baseDays];
  for (const d of allowed) {
    const sorted = [...d].sort((a, b) => dayIndex(a) - dayIndex(b));
    if (sorted.length === baseDays.length && !sets.some(s => s.join() === sorted.join())) sets.push(sorted);
  }
  const deltas: number[] = [0];
  for (let k = 30; k <= 14 * 60; k += 30) deltas.push(k, -k);
  for (const days of sets) {
    const map = new Map(baseDays.map((d, i) => [d, days[i]]));
    for (const delta of deltas) {
      if (days === sets[0] && delta === 0) continue; // the form time itself was already tried
      yield base.map(s => ({ ...s, day: map.get(s.day)!, start: s.start + delta, end: s.end + delta }));
    }
  }
}

/** Is this time free for the class? (QRganize's own rules; rooms come later) */
async function tryTimes(
  ctx: PlacementContext, cls: PlannedClass, comp: PlannedComponent, sessions: PlannedSession[],
  msId: number, facultyId: number, blockId: number, vacantSearch: boolean,
): Promise<{ ok: boolean; timeConflicts: string[]; invalid?: string }> {
  if (!sessionsAreValid(sessions)) return { ok: false, timeConflicts: [], invalid: 'outside 7:00 AM–9:00 PM or over the 12:00–1:00 PM lunch break' };
  if (ctx.combos.length) {
    const err = dayCombinationError(sessions.map(s => s.day), ctx.combos.map(days => ({ days })));
    if (err) return { ok: false, timeConflicts: [], invalid: err };
  }
  if (vacantSearch) {
    // A moved class also avoids the faculty's non-teaching time and the real
    // classes on the forms that were not imported (they still use the time).
    const acts = ctx.activitiesByFaculty.get(cls.facultyKey) ?? [];
    if (sessions.some(s => acts.some(a => a.day === s.day && a.start < s.end && a.end > s.start))) return { ok: false, timeConflicts: [] };
    if (sessions.some(s => ctx.plan.external.some(e => e.day === s.day && e.start < s.end && e.end > s.start
      && (e.facultyKey === cls.facultyKey || e.blockKey === cls.blockKey)))) return { ok: false, timeConflicts: [] };
  }
  const conflicts = await findScheduleConflicts(ctx.q, {
    masterScheduleId: msId, facultyId, blockId, semester: ctx.term.semester, academicYear: ctx.term.academicYear,
    editingType: comp.type,
    sessions: sessions.map(s => ({ day: s.day, start_time: hhmm(s.start), hours: (s.end - s.start) / 60, room_id: null })),
  });
  return { ok: conflicts.length === 0, timeConflicts: uniqueMessages(conflicts) };
}

const uniqueMessages = (list: ScheduleConflict[]) => [...new Set(list.map(c => c.message))];

/**
 * Pass 2 — rooms, in the same priority order. The form's room is kept when it
 * is the right type and free. Otherwise the first free existing room of the
 * right type is used — never one that another class's own form gives it at
 * that time, and never one used then by a class on the forms that wasn't
 * imported. A blank room on the form stays blank.
 */
async function assignRooms(ctx: PlacementContext, tasks: RoomTask[], report: ImportReport): Promise<void> {
  const desires = tasks.map((t, i) => ({ i, roomId: ctx.roomIdOf(t.wanted), sessions: t.sessions }));
  const done = new Set<number>();
  const touched = new Set<number>();
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const { cls, comp } = task;
    const wanted = ctx.roomIdOf(task.wanted);
    done.add(i);
    if (wanted == null) continue; // blank on the form
    const name = ctx.rooms.get(wanted)?.name ?? task.wanted?.excelText ?? '';
    const problem = roomProblem(ctx, cls, comp, wanted);
    let taken: ScheduleConflict | undefined;
    if (!problem) {
      taken = (await roomConflicts(ctx, task, wanted))[0];
      if (!taken) {
        await setRoom(ctx, task, wanted);
        touched.add(task.msId);
        const outside = externalRoomUse(ctx, wanted, task.sessions);
        const noteKey = `${cls.id}|${wanted}`;
        if (outside && !ctx.roomNotesGiven.has(noteKey)) {
          ctx.roomNotesGiven.add(noteKey);
          report.issues.push({ level: 'review', topic: 'Room', faculty: cls.facultyLabel,
            message: `${cls.subject.code} ${cls.programCode} ${cls.year}${cls.block} (${cls.facultyLabel}) keeps ${name} as written on its form; the forms also put ${outside} there at that time.` });
        }
        continue;
      }
      report.conflicts.roomDetected++;
    }
    const reserved = (roomId: number) => desires.some(d => !done.has(d.i) && d.roomId === roomId
      && d.sessions.some(x => task.sessions.some(s => s.day === x.day && x.start < s.end && x.end > s.start)));
    let alt: RoomInfo | null = null;
    for (const room of alternativeRooms(ctx, cls, comp, wanted)) {
      if (reserved(room.id) || externalRoomUse(ctx, room.id, task.sessions)) continue;
      if ((await roomConflicts(ctx, task, room.id)).length === 0) { alt = room; break; }
    }
    const reason = problem ?? taken!.message;
    if (alt) {
      await setRoom(ctx, task, alt.id);
      touched.add(task.msId);
      task.outcome.roomNotes.push(`${name} → ${alt.name}: ${reason}`);
      if (taken) report.conflicts.roomResolved++;
    } else {
      task.outcome.roomNotes.push(`${name} not used: ${reason}; no free ${requiredRoomType(cls, comp) ?? 'suitable'} room at that time — left without a room`);
      report.issues.push({ level: 'review', topic: 'Room', faculty: cls.facultyLabel,
        message: `${cls.subject.code} ${cls.programCode} ${cls.year}${cls.block} ${comp.type === 'lec' ? 'Lecture' : 'Laboratory'} ${describeSessions(task.sessions)}: ${name} can't be used (${reason}) and no other valid room is free — left without a room.` });
    }
  }
  // Room names on the outcome, and the class's main room for the workload pages
  for (const task of tasks) {
    const ids = await ctx.q(`SELECT DISTINCT r.room_name FROM schedule_sessions ss LEFT JOIN rooms r ON r.id = ss.room_id
      WHERE ss.master_schedule_id = $1 AND ss.type = $2`, [task.msId, task.comp.type]);
    task.outcome.rooms = ids.rows.map(r => (r.room_name ? String(r.room_name) : 'no room')).join(', ') || 'no room';
  }
  if (touched.size) {
    await ctx.q(
      `UPDATE master_schedule ms SET room_id = (SELECT ss.room_id FROM schedule_sessions ss WHERE ss.master_schedule_id = ms.id
          ORDER BY ss.start_time, ss.id LIMIT 1) WHERE ms.id = ANY($1::int[])`, [[...touched]]);
  }
}

async function setRoom(ctx: PlacementContext, task: RoomTask, roomId: number) {
  await ctx.q('UPDATE schedule_sessions SET room_id = $1 WHERE id = ANY($2::int[])', [roomId, task.sessions.map(s => s.id)]);
  for (const s of task.sessions) s.roomId = roomId;
}

/** Room clashes for these sessions (facultyId null → only room and block are checked; the block is already free) */
function roomConflicts(ctx: PlacementContext, task: RoomTask, roomId: number) {
  return findScheduleConflicts(ctx.q, {
    masterScheduleId: task.msId, facultyId: null, blockId: task.blockId, semester: ctx.term.semester, academicYear: ctx.term.academicYear,
    editingType: task.comp.type,
    sessions: task.sessions.map(s => ({ day: s.day, start_time: hhmm(s.start), hours: (s.end - s.start) / 60, room_id: roomId })),
  }).then(list => list.filter(c => c.type === 'room'));
}

/** Lab sessions need a Laboratory; a lecture-only subject can't use one (Scheduling's room rules). */
function requiredRoomType(cls: PlannedClass, comp: PlannedComponent): 'Laboratory' | 'Lecture' | null {
  if (comp.type === 'lab') return 'Laboratory';
  if (cls.subject.labHours <= 0) return 'Lecture';
  return null; // the Lecture of a Lec + Lab subject may use either
}

function roomProblem(ctx: PlacementContext, cls: PlannedClass, comp: PlannedComponent, roomId: number): string | null {
  const room = ctx.rooms.get(roomId);
  if (!room) return 'room not found';
  if (room.status !== 'Active') return `${room.name} is not active`;
  const isLab = room.type === 'Laboratory' || room.type === 'Computer Lab';
  if (comp.type === 'lab' && !isLab) return `a Laboratory session needs a laboratory room (${room.name} is a ${room.type} room)`;
  if (comp.type === 'lec' && isLab && cls.subject.labHours <= 0) return `${cls.subject.code} is lecture-only, so it can't use a laboratory room`;
  return null;
}

/**
 * Valid rooms to fall back to: rooms of the same kind as the form's (other
 * "M.P." rooms for an M.P. room), then the general Lecture-N / Laboratory-N
 * rooms in number order. Special rooms (a gym, a robotics lab) are never
 * handed to an unrelated class.
 */
function alternativeRooms(ctx: PlacementContext, cls: PlannedClass, comp: PlannedComponent, wantedId: number): RoomInfo[] {
  const want = requiredRoomType(cls, comp) ?? ctx.rooms.get(wantedId)?.type ?? 'Lecture';
  const fits = (r: RoomInfo) => r.id !== wantedId && r.status === 'Active'
    && (r.type === want || (want === 'Laboratory' && r.type === 'Computer Lab'));
  const letters = (s: string) => s.toUpperCase().replace(/[^A-Z]/g, '');
  const original = ctx.rooms.get(wantedId);
  const all = [...ctx.rooms.values()].filter(fits).sort((a, b) => naturalKey(a.name).localeCompare(naturalKey(b.name)));
  const family = original && roomKey(original.name).kind === 'other'
    ? all.filter(r => roomKey(r.name).kind === 'other' && letters(r.name) === letters(original.name)) : [];
  const general = all.filter(r => roomKey(r.name).kind !== 'other');
  return [...family, ...general];
}

function externalRoomUse(ctx: PlacementContext, roomId: number, sessions: { day: WeekDay; start: number; end: number }[]): string | null {
  const room = ctx.rooms.get(roomId);
  if (!room) return null;
  const key = roomKey(room.name).key;
  const hit = ctx.plan.external.find(e => e.roomKey === key && sessions.some(s => s.day === e.day && e.start < s.end && e.end > s.start));
  return hit ? hit.label : null;
}

/* ── Totals and validation ───────────────────────────────────────────────── */

async function workloadTotals(q: Q, plan: ImportPlan, facultyIds: Map<string, number>, labels: Map<string, string>, term: ImportTerm): Promise<ImportReport['totals']> {
  const summaries = await loadFacultyLoadSummaries({ semester: term.semester, academicYear: term.academicYear, q });
  const out: ImportReport['totals'] = [];
  for (const f of plan.faculty) {
    const id = facultyIds.get(f.key)!;
    const s = summaries[id];
    const isP = f.classification === 'Permanent';
    const praise = round2(isP ? s?.total_praise_units ?? 0 : s?.total_praise_hours ?? 0);
    // What the forms themselves total (only classes that were imported)
    const excel = { regular: 0, overload: 0, praise: 0 };
    for (const c of plan.classes.filter(c => c.facultyKey === f.key)) {
      excel.regular = round2(excel.regular + c.excel.byCategory.Regular);
      excel.overload = round2(excel.overload + c.excel.byCategory.Overload);
      excel.praise = round2(excel.praise + c.excel.byCategory.Praise);
    }
    out.push({
      faculty: labels.get(f.key)!,
      employment: f.classification,
      regular: round2(s?.current_load ?? 0),
      overload: round2(isP ? s?.total_overload_units ?? 0 : s?.total_overload_hours ?? 0),
      praise,
      deloading: round2(s?.total_deduction_units ?? 0),
      limit: round2(s?.regular_load_limit ?? 0),
      unit: isP ? 'units' : 'hours',
      excel,
    });
  }
  return out;
}

async function validate(q: Q, term: ImportTerm, plan: ImportPlan, facultyIds: Map<string, number>, report: ImportReport): Promise<ValidationCheck[]> {
  const checks: ValidationCheck[] = [];
  const add = (name: string, rows: Record<string, unknown>[], describe: (r: Record<string, unknown>) => string) =>
    checks.push({ name, ok: rows.length === 0, detail: rows.length ? rows.slice(0, 12).map(describe).join('; ') + (rows.length > 12 ? `; … ${rows.length - 12} more` : '') : 'none' });
  const termSessions = `
    SELECT ss.id, ss.master_schedule_id AS ms, ss.day_of_week AS day, ss.start_time, ss.end_time, ss.room_id, ss.type,
           ms.faculty_id, bs.block_id, c.subject_code, c.lecture_hours, c.laboratory_hours, b.block_name, b.year_level
      FROM schedule_sessions ss
      JOIN master_schedule ms ON ms.id = ss.master_schedule_id
      JOIN block_subjects bs ON bs.id = ms.block_subject_id
      JOIN curriculums c ON c.id = bs.curriculum_id
      JOIN blocks b ON b.id = bs.block_id
     WHERE ms.faculty_id IS NOT NULL AND ms.status IN ('Assigned','Scheduled','Completed')
       AND b.semester = $1 AND b.academic_year = $2`;
  const p = [term.semester, term.academicYear];
  const overlap = (field: string, extra = '') => q(
    `WITH t AS (${termSessions})
     SELECT a.subject_code AS a_code, a.year_level AS a_year, a.block_name AS a_block, b.subject_code AS b_code, b.block_name AS b_block,
            a.day, a.start_time::text AS a_s, a.end_time::text AS a_e, b.start_time::text AS b_s, b.end_time::text AS b_e
       FROM t a JOIN t b ON a.id < b.id AND a.day = b.day AND a.${field} = b.${field} ${extra}
        AND a.start_time < b.end_time AND b.start_time < a.end_time`, p);
  const fmtOverlap = (r: Record<string, unknown>) => `${r.day}: ${r.a_code} ${String(r.a_s).slice(0, 5)}–${String(r.a_e).slice(0, 5)} × ${r.b_code} ${String(r.b_s).slice(0, 5)}–${String(r.b_e).slice(0, 5)}`;
  add('No faculty double-booking', (await overlap('faculty_id')).rows, fmtOverlap);
  add('No block double-booking', (await overlap('block_id')).rows, fmtOverlap);
  add('No room double-booking (different faculty)', (await overlap('room_id', 'AND a.room_id IS NOT NULL AND a.faculty_id <> b.faculty_id')).rows, fmtOverlap);
  add('No class during the faculty\'s non-teaching time', (await q(
    `WITH t AS (${termSessions})
     SELECT t.subject_code, t.day, t.start_time::text AS s, fa.activity, fa.start_time::text AS fs
       FROM t JOIN faculty_activities fa ON fa.faculty_id = t.faculty_id AND fa.day_of_week = t.day
        AND fa.semester = $1 AND fa.academic_year = $2 AND fa.start_time < t.end_time AND t.start_time < fa.end_time`, p)).rows,
    r => `${r.day} ${r.subject_code} ${String(r.s).slice(0, 5)} × ${r.activity} ${String(r.fs).slice(0, 5)}`);
  add('Every session within 7:00 AM–9:00 PM and clear of lunch', (await q(
    `WITH t AS (${termSessions}) SELECT subject_code, day, start_time::text AS s, end_time::text AS e FROM t
      WHERE start_time < '07:00' OR end_time > '21:00' OR (start_time < '13:00' AND end_time > '12:00')`, p)).rows,
    r => `${r.day} ${r.subject_code} ${r.s}–${r.e}`);
  add('Session hours equal the curriculum Lec / Lab hours', (await q(
    `WITH t AS (${termSessions})
     SELECT subject_code, block_name, type, SUM(EXTRACT(EPOCH FROM end_time - start_time) / 3600) AS h,
            MAX(CASE WHEN type = 'lab' THEN laboratory_hours ELSE lecture_hours END) AS need
       FROM t GROUP BY ms, subject_code, block_name, type
     HAVING ABS(SUM(EXTRACT(EPOCH FROM end_time - start_time) / 3600) - MAX(CASE WHEN type = 'lab' THEN laboratory_hours ELSE lecture_hours END)) > 0.01`, p)).rows,
    r => `${r.subject_code} ${r.block_name} ${r.type}: ${Number(r.h)} h vs ${Number(r.need)} h`);
  add('Room types valid (Lab in a laboratory; lecture-only not in a laboratory)', (await q(
    `WITH t AS (${termSessions})
     SELECT t.subject_code, t.type, r.room_name FROM t JOIN rooms r ON r.id = t.room_id
      WHERE (t.type = 'lab' AND r.room_type NOT IN ('Laboratory','Computer Lab'))
         OR (t.type = 'lec' AND COALESCE(t.laboratory_hours,0) = 0 AND r.room_type IN ('Laboratory','Computer Lab'))
         OR COALESCE(r.status,'Active') <> 'Active'`, p)).rows,
    r => `${r.subject_code} ${r.type} in ${r.room_name}`);
  add('No duplicate sessions', (await q(
    `WITH t AS (${termSessions}) SELECT ms, day, start_time::text AS s, type, COUNT(*) AS n FROM t GROUP BY ms, day, start_time, type HAVING COUNT(*) > 1`, p)).rows,
    r => `ms ${r.ms} ${r.day} ${r.s} ${r.type} ×${r.n}`);
  add('One workload row per class', (await q(
    `SELECT il.master_schedule_id, COUNT(*) AS n FROM instructor_loads il WHERE il.semester = $1 AND il.academic_year = $2
      GROUP BY il.master_schedule_id HAVING COUNT(*) > 1`, p)).rows, r => `ms ${r.master_schedule_id} ×${r.n}`);
  add('At most one Overload / split-Praise row per class', (await q(
    `SELECT faculty_id, master_schedule_id, COUNT(*) AS n FROM overloads WHERE semester = $1 AND academic_year = $2
      GROUP BY faculty_id, master_schedule_id HAVING COUNT(*) > 1`, p)).rows, r => `faculty ${r.faculty_id} ms ${r.master_schedule_id} ×${r.n}`);
  add('Class faculty matches its workload row', (await q(
    `SELECT ms.id, ms.faculty_id, il.faculty_id AS il_faculty FROM master_schedule ms
       JOIN instructor_loads il ON il.master_schedule_id = ms.id
      WHERE il.semester = $1 AND il.academic_year = $2 AND ms.faculty_id IS DISTINCT FROM il.faculty_id`, p)).rows,
    r => `ms ${r.id}: ${r.faculty_id} vs ${r.il_faculty}`);
  add('One master schedule per block subject', (await q(
    `SELECT bs.id, COUNT(ms.id) AS n FROM block_subjects bs JOIN blocks b ON b.id = bs.block_id
       JOIN master_schedule ms ON ms.block_subject_id = bs.id
      WHERE b.semester = $1 AND b.academic_year = $2 GROUP BY bs.id HAVING COUNT(ms.id) > 1`, p)).rows, r => `block subject ${r.id} ×${r.n}`);
  add('No duplicate active faculty names', (await q(
    `SELECT LOWER(TRIM(first_name)) || ' ' || LOWER(TRIM(last_name)) AS n, COUNT(*) AS c FROM faculty WHERE is_active = true
      GROUP BY 1 HAVING COUNT(*) > 1`)).rows, r => `${r.n} ×${r.c}`);
  add('No duplicate usernames / one account per faculty', (await q(
    `SELECT LOWER(username) AS u, COUNT(*) AS c FROM instructor_accounts GROUP BY 1 HAVING COUNT(*) > 1
     UNION ALL SELECT 'faculty #' || faculty_id, COUNT(*) FROM instructor_accounts GROUP BY faculty_id HAVING COUNT(*) > 1`)).rows,
    r => `${r.u} ×${r.c}`);
  add('No duplicate rooms', (await q(
    `SELECT LOWER(REGEXP_REPLACE(TRIM(room_name), '\\s+', ' ', 'g')) AS n, COUNT(*) AS c FROM rooms GROUP BY 1 HAVING COUNT(*) > 1`)).rows,
    r => `${r.n} ×${r.c}`);
  add('No duplicate blocks', (await q(
    `SELECT program_id, year_level, block_name, COUNT(*) AS c FROM blocks WHERE is_active = true AND semester = $1 AND academic_year = $2
      GROUP BY program_id, year_level, block_name, curriculum_version HAVING COUNT(*) > 1`, p)).rows,
    r => `${r.year_level} ${r.block_name} ×${r.c}`);
  const ids = [...facultyIds.values()];
  add('Imported faculty have a name, program and account', (await q(
    `SELECT f.id, f.name FROM faculty f LEFT JOIN instructor_accounts ia ON ia.faculty_id = f.id
      WHERE f.id = ANY($1::int[]) AND (COALESCE(TRIM(f.name), '') = '' OR ia.id IS NULL OR COALESCE(ia.password_hash, '') = '' OR f.program_id IS NULL)`, [ids])).rows,
    r => `#${r.id} ${r.name}`);
  const created = report.rooms.created.map(r => r.name.toUpperCase());
  const blankCreated = report.rooms.created.filter(r => !plan.newRooms.some(n => n.name === r.name));
  checks.push({ name: 'Rooms created only from room names written on the forms', ok: blankCreated.length === 0,
    detail: created.length ? `${created.length} created: ${report.rooms.created.map(r => r.name).join(', ')}` : 'none created' });
  return checks;
}

export { fmtHours };

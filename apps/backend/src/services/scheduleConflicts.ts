/**
 * Schedule conflict detection — the single source of truth for both
 * POST /api/scheduling/check-conflicts (preview) and POST /api/scheduling
 * (save), so the two can never disagree.
 *
 * A new session conflicts with an existing one when they share an
 * instructor, a block (section) or a room, on the same day, in the same
 * semester + academic year, and their times overlap. Times are compared in
 * minutes, with a session that ends at/after midnight (end ≤ start, e.g.
 * 21:00–00:00) treated as ending the next day — a plain TIME comparison
 * would let those slip through.
 *
 * The component being edited (same master_schedule + same lec/lab type) is
 * excluded, since saving replaces it; the sibling Lecture/Laboratory of the
 * same subject still counts.
 */

export const WEEK_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** Academic day: sessions start at/after 7:00 AM and end by 9:00 PM. */
export const DAY_START_MIN = 7 * 60;
export const DAY_END_MIN = 21 * 60;
/** Lunch break for all faculty: 12:00–1:00 PM — no class may overlap it. */
export const LUNCH_START_MIN = 12 * 60;
export const LUNCH_END_MIN = 13 * 60;

/** Statuses whose sessions occupy time. */
const ACTIVE_STATUSES = ['Assigned', 'Scheduled', 'Completed'];

/** 'duplicate' — two sessions of the same save overlap each other */
export type ConflictType = 'instructor' | 'room' | 'block' | 'duplicate';

export interface ConflictSessionInput {
  day: string;
  start_time: string;
  hours: number | string;
  room_id?: string | number | null;
}

export interface ScheduleConflict {
  session_index: number;
  type: ConflictType;
  message: string;
  existing_session_id?: number;
  day?: string;
  existing_start?: string;
  existing_end?: string;
}

type Queryable = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export function timeToMinutes(t: string): number {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + (m || 0);
}

/** " · by <instructor>" — who scheduled the clashing class, so it can be traced */
const by = (row: Record<string, unknown>) => (row.faculty_name ? ` · by ${row.faculty_name}` : '');

function fmt12(t: string): string {
  const [h, m] = t.split(':').map(Number);
  if (Number.isNaN(h)) return t;
  const hh = h % 24;
  return `${hh % 12 || 12}:${String(m || 0).padStart(2, '0')} ${hh >= 12 ? 'PM' : 'AM'}`;
}

/**
 * Validate submitted sessions before any conflict check — an unknown day or
 * malformed time would otherwise match nothing and slip through every check.
 * Returns an error message, or null when valid.
 */
export function validateSessions(sessions: ConflictSessionInput[]): string | null {
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const n = i + 1;
    if (!WEEK_DAYS.includes(s.day)) return `Session ${n}: choose a valid day.`;
    if (!/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(String(s.start_time))) return `Session ${n}: invalid start time.`;
    const h = parseFloat(String(s.hours));
    if (!Number.isFinite(h) || h <= 0 || h > 12) return `Session ${n}: hours must be between 0 and 12.`;
    const start = timeToMinutes(String(s.start_time));
    if (start < DAY_START_MIN) return `Session ${n}: classes can't start before 7:00 AM.`;
    if (start + Math.round(h * 60) > DAY_END_MIN) return `Session ${n}: classes must end by 9:00 PM.`;
    if (start < LUNCH_END_MIN && start + Math.round(h * 60) > LUNCH_START_MIN) {
      return `Session ${n}: overlaps the lunch break (12:00–1:00 PM).`;
    }
  }
  return null;
}

const minutesToTime = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/**
 * Sessions of the same save that overlap each other on the same day — e.g.
 * Monday 8:00–10:00 entered twice. The form already flags these while
 * editing; the save route refuses them too, so a request that skips the form
 * can't store a subject meeting twice at once. One entry per later session.
 * Run after validateSessions (valid days and times, nothing past 9:00 PM).
 */
export function findOverlappingSessions(sessions: ConflictSessionInput[]): ScheduleConflict[] {
  const span = (s: ConflictSessionInput) => {
    const start = timeToMinutes(String(s.start_time));
    return { start, end: start + Math.round(parseFloat(String(s.hours)) * 60) };
  };
  const overlaps: ScheduleConflict[] = [];
  for (let i = 1; i < sessions.length; i++) {
    const a = span(sessions[i]);
    for (let j = 0; j < i; j++) {
      if (sessions[j].day !== sessions[i].day) continue;
      const b = span(sessions[j]);
      if (a.start < b.end && a.end > b.start) {
        const st = minutesToTime(b.start);
        const et = minutesToTime(b.end);
        overlaps.push({
          session_index: i, type: 'duplicate', day: sessions[i].day, existing_start: st, existing_end: et,
          message: `Session ${i + 1} overlaps with Session ${j + 1} on ${sessions[i].day} (${fmt12(st)}–${fmt12(et)}).`,
        });
        break;
      }
    }
  }
  return overlaps;
}

/* Overlap of an existing session (ss) with [$start, $end) minutes, midnight-aware. */
const OVERLAP_SQL = (startParam: string, endParam: string) => `
  (EXTRACT(EPOCH FROM ss.start_time) / 60) < ${endParam}
  AND (EXTRACT(EPOCH FROM ss.end_time) / 60
       + CASE WHEN ss.end_time <= ss.start_time THEN 1440 ELSE 0 END) > ${startParam}`;

export async function findScheduleConflicts(q: Queryable, opts: {
  masterScheduleId: number;
  facultyId: number | null;
  blockId: number;
  semester: string;
  academicYear: string;
  /** Component being replaced ('lec' | 'lab') */
  editingType: 'lec' | 'lab';
  sessions: ConflictSessionInput[];
}): Promise<ScheduleConflict[]> {
  const { masterScheduleId, facultyId, blockId, semester, academicYear, editingType, sessions } = opts;
  const conflicts: ScheduleConflict[] = [];

  // Shared filter: live classes in the same term, excluding the component being replaced
  const common = `
    ms2.faculty_id IS NOT NULL
    AND ms2.status = ANY($1::text[])
    AND ss.day_of_week = $2
    AND (ms2.id <> $3 OR COALESCE(ss.type, 'lec') <> $4)
    AND ($5 = '' OR b2.semester      = $5)
    AND ($6 = '' OR b2.academic_year = $6)
    AND ${OVERLAP_SQL('$7', '$8')}`;
  const from = `
    FROM schedule_sessions ss
    JOIN master_schedule ms2 ON ss.master_schedule_id = ms2.id
    JOIN block_subjects  bs2 ON ms2.block_subject_id  = bs2.id
    JOIN curriculums     c   ON bs2.curriculum_id     = c.id
    JOIN blocks          b2  ON bs2.block_id          = b2.id
    LEFT JOIN faculty    f2  ON f2.id                 = ms2.faculty_id`;
  const cols = `c.subject_code, b2.block_name, ss.id AS session_id,
                COALESCE(NULLIF(TRIM(f2.name), ''), TRIM(CONCAT_WS(' ', f2.first_name, f2.last_name))) AS faculty_name,
                ss.start_time::text AS start_time, ss.end_time::text AS end_time`;

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const start = timeToMinutes(s.start_time);
    const end = start + Math.round(parseFloat(String(s.hours)) * 60);
    const base = [ACTIVE_STATUSES, s.day, masterScheduleId, editingType, semester || '', academicYear || '', start, end];

    const push = (type: ConflictType, r: Record<string, unknown>, message: (st: string, et: string) => string) => {
      const st = String(r.start_time).substring(0, 5);
      const et = String(r.end_time).substring(0, 5);
      conflicts.push({
        session_index: i, type, message: message(st, et),
        existing_session_id: Number(r.session_id), day: s.day, existing_start: st, existing_end: et,
      });
    };

    // Instructor conflict: same instructor, same day, overlapping time —
    // regardless of rooms (an unassigned room never hides it).
    if (facultyId) {
      const r = await q(`SELECT ${cols} ${from} WHERE ms2.faculty_id = $9 AND ${common} LIMIT 1`, [...base, facultyId]);
      if (r.rows[0]) push('instructor', r.rows[0], (st, et) =>
        `Faculty already has a class on ${s.day}: ${r.rows[0].subject_code} (${r.rows[0].block_name}) ${fmt12(st)}–${fmt12(et)}.`);
    }

    const rb = await q(`SELECT ${cols} ${from} WHERE bs2.block_id = $9 AND ${common} LIMIT 1`, [...base, blockId]);
    if (rb.rows[0]) push('block', rb.rows[0], (st, et) =>
      `Block already has another class on ${s.day}: ${rb.rows[0].subject_code} ${fmt12(st)}–${fmt12(et)}${by(rb.rows[0])}.`);

    // Room conflict: same room, same day, overlapping time, a DIFFERENT
    // instructor. (Same instructor is already an instructor conflict — not
    // reported twice.) No room selected → no room check at all.
    if (s.room_id) {
      const rr = await q(
        `SELECT ${cols}, r.room_name ${from} JOIN rooms r ON ss.room_id = r.id
         WHERE ss.room_id = $9 AND ($10::int IS NULL OR ms2.faculty_id <> $10) AND ${common} LIMIT 1`,
        [...base, Number(s.room_id), facultyId],
      );
      if (rr.rows[0]) push('room', rr.rows[0], (st, et) =>
        `Room "${rr.rows[0].room_name}" is already occupied on ${s.day}: ${rr.rows[0].subject_code} (${rr.rows[0].block_name}) ${fmt12(st)}–${fmt12(et)}${by(rr.rows[0])}.`);
    }
  }
  return conflicts;
}

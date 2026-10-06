import type { PoolClient } from 'pg';
import { query } from '@/database/db';
import { movedComponent } from '@shared/loadSplit';

/**
 * Split Overload / Praise Load (part of a subject moved, the rest Regular).
 *
 * The instructor_loads row stays 'Regular' (units/hours = the part that stays
 * Regular) and the moved part lives in one `overloads` row. That row is
 * flagged `is_praise = true` when it counts toward Praise Load instead of
 * Overload — everything that sums `overloads` as overload must exclude it.
 * `lec_part` = how much of the moved part is Lecture (the rest is Laboratory),
 * so any split is possible, e.g. Lecture all Praise + Laboratory 1 unit
 * Regular / 1.25 units Praise (see @shared/loadSplit).
 */
let ready = false;
export async function ensurePraiseSplitColumn() {
  if (ready) return;
  await query(`ALTER TABLE overloads ADD COLUMN IF NOT EXISTS is_praise BOOLEAN NOT NULL DEFAULT false`);
  await query(`ALTER TABLE overloads ADD COLUMN IF NOT EXISTS lec_part NUMERIC(6,2)`);
  ready = true;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The amounts of a subject's Lecture and Laboratory to move (work units), from
 * a request's `parts: { lec, lab }`. Null when the request has no parts.
 */
export function parseMovedParts(
  raw: unknown, lecValue: number, labValue: number,
): { lec: number; lab: number } | { error: string } | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object') return { error: 'Invalid split amounts.' };
  const r = raw as { lec?: unknown; lab?: unknown };
  const read = (v: unknown, max: number, label: string): number | string => {
    if (v === undefined || v === null || v === '') return 0;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return `Enter a valid ${label} amount.`;
    if (n > max + 0.001) return `The ${label} is only ${round2(max)} units.`;
    return round2(Math.min(n, max));
  };
  const lec = read(r.lec, lecValue, 'Lecture');
  if (typeof lec === 'string') return { error: lec };
  const lab = read(r.lab, labValue, 'Laboratory');
  if (typeof lab === 'string') return { error: lab };
  if (lec + lab <= 0.001) return { error: 'Move at least part of the Lecture or Laboratory.' };
  return { lec, lab };
}

/** Save a split: Regular keeps the rest of the subject, one overloads row holds the moved part */
export async function saveSplit(client: PoolClient, s: {
  facultyId: number; msId: number; isPermanent: boolean;
  /** Whole subject value (work units for Permanent, hours for Contractual) */
  total: number;
  lecMoved: number; labMoved: number;
  isPraise: boolean; reason: string;
  academicYear: string; semester: string;
}): Promise<void> {
  const moved = round2(s.lecMoved + s.labMoved);
  const regular = round2(Math.max(0, s.total - moved));
  await client.query(
    `UPDATE instructor_loads
        SET load_category = 'Regular', units = $1, hours = $2, overload_component = $3
      WHERE faculty_id = $4 AND master_schedule_id = $5`,
    [s.isPermanent ? regular : 0, s.isPermanent ? 0 : regular, movedComponent(s.lecMoved, s.labMoved), s.facultyId, s.msId],
  );
  await client.query('DELETE FROM overloads WHERE faculty_id = $1 AND master_schedule_id = $2', [s.facultyId, s.msId]);
  await client.query(
    `INSERT INTO overloads (faculty_id, master_schedule_id, units, hours, reason, academic_year, semester, is_praise, lec_part)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [s.facultyId, s.msId, s.isPermanent ? moved : 0, s.isPermanent ? 0 : moved, s.reason,
      s.academicYear, s.semester, s.isPraise, round2(s.lecMoved)],
  );
}

/** "Lecture 2 + Laboratory 1.25" — the moved part, for messages and reasons */
export function describeMoved(lec: number, lab: number): string {
  const fmt = (n: number) => String(round2(n));
  return [lec > 0.001 ? `Lecture ${fmt(lec)}` : '', lab > 0.001 ? `Laboratory ${fmt(lab)}` : ''].filter(Boolean).join(' + ');
}

import { query } from '@/server/db';

/**
 * Component-level Praise Load (e.g. only the Lab of a Lec+Lab subject).
 *
 * Mirrors a component Overload split: the instructor_loads row stays
 * 'Regular' (units/hours = the part that stays Regular, overload_component =
 * the moved lec/lab), and the moved portion lives in an `overloads` row. That
 * row is flagged `is_praise = true` so it counts toward Praise Load instead of
 * Overload. Everything that sums `overloads` as overload must exclude it.
 */
let ready = false;
export async function ensurePraiseSplitColumn() {
  if (ready) return;
  await query(`ALTER TABLE overloads ADD COLUMN IF NOT EXISTS is_praise BOOLEAN NOT NULL DEFAULT false`);
  ready = true;
}

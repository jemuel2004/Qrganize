import type { PoolClient } from 'pg';
import { query } from '@/database/db';

/**
 * Blocks a faculty member is assigned to teach (Faculty → "Blocks to Handle").
 * Faculty Workload only offers these blocks for that faculty, and
 * /api/workload/assign refuses subjects from any other block. A faculty with
 * no blocks assigned for a term is open: every block of that term is allowed.
 */

/** SQL fragment: the faculty's assigned block ids as a JSON array. Alias it as `assigned_block_ids`. */
export const ASSIGNED_BLOCK_IDS_SUBQUERY = `
  COALESCE((
    SELECT json_agg(fb.block_id ORDER BY fb.block_id)
    FROM faculty_blocks fb
    WHERE fb.faculty_id = f.id
  ), '[]'::json)
`;

/** Replaces the faculty's full set of assigned blocks. `undefined` = field omitted, leave as is. */
export async function setFacultyBlocks(
  client: PoolClient,
  facultyId: number,
  blockIds: unknown,
): Promise<void> {
  if (blockIds === undefined) return;
  const ids = [...new Set((Array.isArray(blockIds) ? blockIds : [])
    .map(n => Number(n))
    .filter(n => Number.isInteger(n) && n > 0))];
  await client.query('DELETE FROM faculty_blocks WHERE faculty_id = $1', [facultyId]);
  if (ids.length === 0) return;
  await client.query(
    `INSERT INTO faculty_blocks (faculty_id, block_id)
     SELECT $1, b.id FROM blocks b WHERE b.id = ANY($2::int[])
     ON CONFLICT DO NOTHING`,
    [facultyId, ids],
  );
}

/** True when the faculty may teach this block: it's one of their assigned
 *  blocks, or they have no blocks assigned for that block's term (open). */
export async function isBlockAssignedToFaculty(facultyId: number, blockId: number): Promise<boolean> {
  const r = await query(
    `SELECT
       EXISTS (SELECT 1 FROM faculty_blocks WHERE faculty_id = $1 AND block_id = $2) AS assigned,
       EXISTS (
         SELECT 1 FROM faculty_blocks fb
           JOIN blocks b2 ON b2.id = fb.block_id
           JOIN blocks b  ON b.id  = $2
          WHERE fb.faculty_id = $1
            AND b2.semester = b.semester AND b2.academic_year = b.academic_year
       ) AS has_any_this_term`,
    [facultyId, blockId],
  );
  const row = r.rows[0] as { assigned: boolean; has_any_this_term: boolean } | undefined;
  return !!row && (row.assigned || !row.has_any_this_term);
}

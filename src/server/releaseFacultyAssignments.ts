import type { PoolClient } from 'pg';

/**
 * Release every active workload slot owned by a faculty member.
 *
 * master_schedule rows are the block's subject slots — they must stay.
 * We clear the instructor (SET NULL), mark the slot Unassigned, drop
 * instructor_loads / overloads, and remove schedule_sessions.
 * Blocks, subjects, programs, and school years are never touched.
 */
export async function releaseFacultyAssignments(client: PoolClient, facultyId: number): Promise<void> {
  const assigned = await client.query<{ id: number }>(
    'SELECT id FROM master_schedule WHERE faculty_id = $1',
    [facultyId],
  );
  const msIds = assigned.rows.map(r => r.id);

  await client.query(
    `UPDATE master_schedule
     SET faculty_id = NULL,
         status = 'Unassigned',
         day_pattern = NULL,
         start_time = NULL,
         end_time = NULL,
         room_id = NULL,
         updated_at = NOW()
     WHERE faculty_id = $1`,
    [facultyId],
  );

  if (msIds.length > 0) {
    await client.query(
      `UPDATE block_subjects
       SET status = 'Unscheduled'
       WHERE id IN (
         SELECT block_subject_id FROM master_schedule WHERE id = ANY($1::int[])
       )`,
      [msIds],
    );
    await client.query(
      'DELETE FROM schedule_sessions WHERE master_schedule_id = ANY($1::int[])',
      [msIds],
    );
  }

  await client.query('DELETE FROM instructor_loads WHERE faculty_id = $1', [facultyId]);
  await client.query('DELETE FROM overloads WHERE faculty_id = $1', [facultyId]);
}

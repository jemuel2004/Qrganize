import { query } from '@/database/db';
import { ensureNstpTables } from '@/database/nstpSchema';
import { EMPTY_NSTP, NSTP_CODE_PATTERN, type NstpSchedule } from '@shared/nstp';

/**
 * NSTP — Class Program only (@shared/nstp). NSTP subjects get no class row
 * (master_schedule), so workload, rooms and conflict checks never see them;
 * every place that makes class rows leaves them out with `notNstpSql`.
 */

/** SQL: this subject code is NSTP — `nstpSql('c.subject_code')` */
export const nstpSql = (codeCol: string) => `(${codeCol} ~* '${NSTP_CODE_PATTERN}')`;

/** SQL: this subject code is not NSTP */
export const notNstpSql = (codeCol: string) => `NOT ${nstpSql(codeCol)}`;

/** The saved NSTP setting (empty until an Administrator sets it) */
export async function getNstpSchedule(): Promise<NstpSchedule> {
  await ensureNstpTables();
  const res = await query(
    `SELECT to_char(start_time, 'HH24:MI') AS start_time, to_char(end_time, 'HH24:MI') AS end_time, handler_name
       FROM nstp_schedule WHERE id = 1`,
  );
  const row = res.rows[0];
  if (!row) return { ...EMPTY_NSTP };
  return { start_time: row.start_time ?? null, end_time: row.end_time ?? null, handler_name: String(row.handler_name ?? '') };
}

/** Save the setting (already checked with validateNstpSchedule) */
export async function saveNstpSchedule(value: NstpSchedule): Promise<NstpSchedule> {
  await ensureNstpTables();
  await query(
    `INSERT INTO nstp_schedule (id, start_time, end_time, handler_name, updated_at)
     VALUES (1, $1::time, $2::time, $3::varchar, NOW())
     ON CONFLICT (id) DO UPDATE SET start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time,
       handler_name = EXCLUDED.handler_name, updated_at = NOW()`,
    [value.start_time, value.end_time, value.handler_name],
  );
  return getNstpSchedule();
}

/**
 * Takes NSTP out of the regular scheduling: each NSTP class row is copied to
 * nstp_archived_classes (with its sessions, workload rows and overloads), then
 * removed — its sessions, workload rows, overloads and classroom releases go
 * with it. Run once by migration v57. Returns how many were removed.
 */
export async function archiveNstpClassRows(): Promise<number> {
  await ensureNstpTables();
  await query(`
    INSERT INTO nstp_archived_classes (master_schedule_id, data)
    SELECT ms.id, jsonb_build_object(
      'subject_code', c.subject_code,
      'block_id', bs.block_id,
      'master_schedule', to_jsonb(ms),
      'sessions', COALESCE((SELECT jsonb_agg(to_jsonb(ss)) FROM schedule_sessions ss WHERE ss.master_schedule_id = ms.id), '[]'::jsonb),
      'instructor_loads', COALESCE((SELECT jsonb_agg(to_jsonb(il)) FROM instructor_loads il WHERE il.master_schedule_id = ms.id), '[]'::jsonb),
      'overloads', COALESCE((SELECT jsonb_agg(to_jsonb(o)) FROM overloads o WHERE o.master_schedule_id = ms.id), '[]'::jsonb)
    )
    FROM master_schedule ms
    JOIN block_subjects bs ON bs.id = ms.block_subject_id
    JOIN curriculums c ON c.id = bs.curriculum_id
    WHERE ${nstpSql('c.subject_code')}
      AND (ms.faculty_id IS NOT NULL
        OR EXISTS (SELECT 1 FROM schedule_sessions ss WHERE ss.master_schedule_id = ms.id)
        OR EXISTS (SELECT 1 FROM instructor_loads il WHERE il.master_schedule_id = ms.id)
        OR EXISTS (SELECT 1 FROM overloads o WHERE o.master_schedule_id = ms.id))`);
  const removed = await query(`
    DELETE FROM master_schedule ms
    USING block_subjects bs, curriculums c
    WHERE bs.id = ms.block_subject_id AND c.id = bs.curriculum_id AND ${nstpSql('c.subject_code')}`);
  return removed.rowCount ?? 0;
}

import { query } from '@/server/db';
import { ensureBlockCurriculumVersion } from '@/server/migrateCurriculum';
import { parseCurriculumVersion } from '@/lib/curriculumVersion';

export interface BlockWithAssignmentCounts {
  id: number;
  block_name: string;
  year_level: string;
  semester: string;
  academic_year: string;
  program_id: number;
  program_code: string;
  program_name: string;
  curriculum_version: string | null;
  subject_count: number;
  unassigned_count: number;
  assigned_count: number;
  scheduled_count: number;
  [key: string]: unknown;
}

/**
 * Per-block assignment counts. A subject is unassigned when the latest
 * master_schedule row has no active faculty_id — same rule as GET /api/blocks.
 */
export async function fetchBlocksWithAssignmentCounts(filters: {
  programId?: string | number | null;
  yearLevel?: string | null;
  semester?: string | null;
  academicYear?: string | null;
  curriculumVersion?: string | null;
}): Promise<BlockWithAssignmentCounts[]> {
  await ensureBlockCurriculumVersion();

  const curriculumVersion = parseCurriculumVersion(filters.curriculumVersion ?? null);
  const baseFilters: string[] = ['b.is_active = true'];
  const params: unknown[] = [];
  let idx = 1;

  if (filters.programId) {
    baseFilters.push(`b.program_id = $${idx++}`);
    params.push(filters.programId);
  }
  if (filters.yearLevel) {
    baseFilters.push(`b.year_level = $${idx++}`);
    params.push(filters.yearLevel);
  }
  if (filters.semester) {
    baseFilters.push(`b.semester = $${idx++}`);
    params.push(filters.semester);
  }
  if (filters.academicYear) {
    baseFilters.push(`b.academic_year = $${idx++}`);
    params.push(filters.academicYear);
  }
  if (curriculumVersion) {
    baseFilters.push(`b.curriculum_version = $${idx++}`);
    params.push(curriculumVersion);
  }

  const where = baseFilters.join(' AND ');
  const sql = `
      SELECT b.*,
        p.code         AS program_code,
        p.name         AS program_name,
        COALESCE(stats.subject_count,    0) AS subject_count,
        COALESCE(stats.unassigned_count, 0) AS unassigned_count,
        COALESCE(stats.assigned_count,   0) AS assigned_count,
        COALESCE(stats.scheduled_count,  0) AS scheduled_count
      FROM blocks b
      JOIN programs p ON b.program_id = p.id
      LEFT JOIN (
        SELECT bs.block_id,
          COUNT(bs.id) AS subject_count,
          COUNT(CASE WHEN f.id IS NULL THEN 1 END) AS unassigned_count,
          COUNT(CASE WHEN f.id IS NOT NULL AND COALESCE(ms.status, '') <> 'Scheduled' THEN 1 END) AS assigned_count,
          COUNT(CASE WHEN f.id IS NOT NULL AND ms.status = 'Scheduled' THEN 1 END) AS scheduled_count
        FROM block_subjects bs
        JOIN curriculums c ON c.id = bs.curriculum_id AND c.is_active = true
        LEFT JOIN LATERAL (
          SELECT faculty_id, status FROM master_schedule
          WHERE block_subject_id = bs.id
          ORDER BY id DESC LIMIT 1
        ) ms ON true
        LEFT JOIN faculty f ON f.id = ms.faculty_id AND f.is_active IS NOT FALSE
        GROUP BY bs.block_id
      ) stats ON stats.block_id = b.id
      WHERE ${where}
      ORDER BY b.program_id, b.year_level, b.block_name
    `;

  const result = await query(sql, params);
  return result.rows as BlockWithAssignmentCounts[];
}

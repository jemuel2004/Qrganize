import { query } from '@/database/db';

/**
 * Codes of the given curriculum subjects that still have classes assigned to
 * faculty. Deleting (archiving) one of those would keep it in Faculty Workload
 * totals while Blocks and Class Program — active subjects only — stop showing
 * it, so it has to be removed from Faculty Workload first.
 */
export async function assignedSubjectCodes(curriculumIds: number[]): Promise<string[]> {
  if (curriculumIds.length === 0) return [];
  const result = await query(`
    SELECT DISTINCT c.subject_code
    FROM   curriculums c
    JOIN   block_subjects  bs ON bs.curriculum_id    = c.id
    JOIN   master_schedule ms ON ms.block_subject_id = bs.id
    WHERE  c.id = ANY($1::int[])
      AND  ms.faculty_id IS NOT NULL
    ORDER BY c.subject_code
  `, [curriculumIds]);
  return result.rows.map(r => String(r.subject_code));
}

export function assignedSubjectsMessage(codes: string[]): string {
  const list = codes.length > 5 ? `${codes.slice(0, 5).join(', ')} and ${codes.length - 5} more` : codes.join(', ');
  return `${list} ${codes.length === 1 ? 'is' : 'are'} still assigned to faculty. Remove ${codes.length === 1 ? 'it' : 'them'} from Faculty Workload before deleting.`;
}

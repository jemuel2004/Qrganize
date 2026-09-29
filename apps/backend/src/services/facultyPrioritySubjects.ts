import type { PoolClient } from 'pg';
import { query } from '@/database/db';
import { mergeSameSubjects } from '@shared/subjectCode';

export interface PrioritySubject {
  subject_code: string;
  subject_name: string;
}

/** SQL fragment: aggregates a faculty's priority subjects as a JSON array. Alias it as `priority_subjects`. */
export const PRIORITY_SUBJECTS_SUBQUERY = `
  COALESCE((
    SELECT json_agg(json_build_object('subject_code', fps.subject_code, 'subject_name', fps.subject_name) ORDER BY fps.subject_code)
    FROM faculty_priority_subjects fps
    WHERE fps.faculty_id = f.id
  ), '[]'::json)
`;

export async function getPrioritySubjects(facultyId: number): Promise<PrioritySubject[]> {
  const result = await query(
    `SELECT subject_code, subject_name FROM faculty_priority_subjects WHERE faculty_id = $1 ORDER BY subject_code`,
    [facultyId]
  );
  return result.rows;
}

/** Replaces a faculty's full set of priority subjects. Pass an empty array to clear them. */
export async function setPrioritySubjects(
  client: PoolClient,
  facultyId: number,
  subjects: PrioritySubject[] | undefined,
): Promise<void> {
  if (subjects === undefined) return; // field omitted — leave existing selections untouched

  await client.query('DELETE FROM faculty_priority_subjects WHERE faculty_id = $1', [facultyId]);

  // Same code + (nearly) same title from different programs is one subject.
  const deduped = mergeSameSubjects(
    subjects
      .filter(s => s?.subject_code?.trim())
      .map(s => ({ subject_code: s.subject_code, subject_name: s.subject_name ?? '' })),
  );

  if (deduped.length === 0) return;

  const values: string[] = [];
  const params: unknown[] = [];
  deduped.forEach((s, i) => {
    values.push(`($1, $${i * 2 + 2}, $${i * 2 + 3})`);
    params.push(s.subject_code, s.subject_name);
  });

  await client.query(
    `INSERT INTO faculty_priority_subjects (faculty_id, subject_code, subject_name) VALUES ${values.join(', ')}
     ON CONFLICT DO NOTHING`,
    [facultyId, ...params]
  );
}

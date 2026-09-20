import { query } from '@/server/db';
import { getActiveAcademicPeriod } from '@/server/activeAcademicPeriod';
import { loadFacultyLoadSummaries } from '@/server/facultyLoadSummaries';
import { fetchBlocksWithAssignmentCounts } from '@/server/blockAssignmentCounts';
import { ensureNotificationsTable } from '@/server/notifications';
import {
  blockCurriculumVersion,
  curriculumVersionAbbrev,
} from '@/lib/curriculumVersion';

const INCOMPLETE_EPS = 0.001;
const WORKLOAD_TYPE = 'workload_incomplete';
const OVERLOAD_TYPE = 'workload_overload';
const BLOCK_TYPE = 'block_unassigned';
const FACULTY_MODULE = 'faculty';
const BLOCK_MODULE = 'block';

export type InstructorCompletionStatus = 'COMPLETE' | 'INCOMPLETE' | 'OVERLOAD';

export interface IncompleteInstructorAlert {
  faculty_id: number;
  name: string;
  employment_status: string;
  program_id: number | null;
  related_program_ids: number[];
  current_load: number;
  regular_load_limit: number;
  remaining_load: number;
  unit: 'units' | 'hours';
  status: InstructorCompletionStatus;
  message: string;
}

export interface IncompleteBlockAlert {
  block_id: number;
  block_name: string;
  program_id: number;
  program_code: string;
  program_name: string;
  year_level: string;
  curriculum_abbrev: string;
  unassigned_count: number;
  subject_count: number;
  message: string;
}

export interface OverloadReviewAlert {
  faculty_id: number;
  name: string;
  related_program_ids: number[];
  overload_subject_count: number;
  message: string;
}

export interface WorkloadMonitoringSnapshot {
  school_year: string | null;
  semester: string | null;
  incomplete_instructors: IncompleteInstructorAlert[];
  incomplete_blocks: IncompleteBlockAlert[];
  overload_review_instructors: OverloadReviewAlert[];
  incomplete_instructor_count: number;
  unassigned_subject_count: number;
  complete_instructor_count: number;
  complete_block_count: number;
}

function fmtQty(n: number): string {
  const v = Number(n) || 0;
  if (Math.abs(v - Math.round(v)) < INCOMPLETE_EPS) return String(Math.round(v));
  return v.toFixed(2);
}

function instructorStatus(remaining: number, hasOverload: boolean): InstructorCompletionStatus {
  if (remaining > INCOMPLETE_EPS) return 'INCOMPLETE';
  if (hasOverload) return 'OVERLOAD';
  return 'COMPLETE';
}

function instructorMessage(a: {
  name: string;
  isPermanent: boolean;
  current: number;
  limit: number;
  remaining: number;
}): string {
  const unit = a.isPermanent ? 'units' : 'hours';
  const kind = a.isPermanent ? 'workload' : 'contractual workload';
  return `${a.name} has an incomplete ${kind}. Current: ${fmtQty(a.current)} / ${fmtQty(a.limit)} ${unit}. Remaining: ${fmtQty(a.remaining)} ${unit}.`;
}

export function filterSnapshotForProgram(
  snapshot: WorkloadMonitoringSnapshot,
  programId: number | null
): WorkloadMonitoringSnapshot {
  if (programId == null) {
    return {
      ...snapshot,
      incomplete_instructors: [],
      incomplete_blocks: [],
      overload_review_instructors: [],
      incomplete_instructor_count: 0,
      unassigned_subject_count: 0,
      complete_instructor_count: 0,
      complete_block_count: 0,
    };
  }
  const instructors = snapshot.incomplete_instructors.filter(i =>
    i.related_program_ids.includes(programId)
  );
  const blocks = snapshot.incomplete_blocks.filter(b => b.program_id === programId);
  const overloadReview = snapshot.overload_review_instructors.filter(i =>
    i.related_program_ids.includes(programId)
  );
  const unassigned = blocks.reduce((s, b) => s + b.unassigned_count, 0);
  return {
    ...snapshot,
    incomplete_instructors: instructors,
    incomplete_blocks: blocks,
    overload_review_instructors: overloadReview,
    incomplete_instructor_count: instructors.length,
    unassigned_subject_count: unassigned,
    complete_instructor_count: 0,
    complete_block_count: 0,
  };
}

export async function computeWorkloadMonitoring(): Promise<WorkloadMonitoringSnapshot> {
  const period = await getActiveAcademicPeriod();
  const semester = period.semester || '';
  const academicYear = period.schoolYear || '';

  const empty: WorkloadMonitoringSnapshot = {
    school_year: period.schoolYear,
    semester: period.semester,
    incomplete_instructors: [],
    incomplete_blocks: [],
    overload_review_instructors: [],
    incomplete_instructor_count: 0,
    unassigned_subject_count: 0,
    complete_instructor_count: 0,
    complete_block_count: 0,
  };

  if (!semester || !academicYear) return empty;

  const [summaries, facultyRows, loadPrograms, blocks, overloadCounts] = await Promise.all([
    loadFacultyLoadSummaries({ semester, academicYear }),
    query(`
      SELECT id, name, program_id, employment_status
      FROM faculty
      WHERE is_active IS NOT FALSE
    `),
    query(`
      SELECT DISTINCT il.faculty_id, b.program_id
      FROM instructor_loads il
      JOIN master_schedule ms ON ms.id = il.master_schedule_id
      JOIN block_subjects bs ON bs.id = ms.block_subject_id
      JOIN blocks b ON b.id = bs.block_id
      WHERE il.semester = $1 AND il.academic_year = $2
        AND b.program_id IS NOT NULL
    `, [semester, academicYear]),
    fetchBlocksWithAssignmentCounts({ semester, academicYear }),
    query(`
      SELECT faculty_id, COUNT(*)::int AS overload_subject_count
      FROM instructor_loads
      WHERE load_category = 'Overload'
        AND semester = $1
        AND academic_year = $2
      GROUP BY faculty_id
    `, [semester, academicYear]),
  ]);

  const related = new Map<number, Set<number>>();
  for (const row of loadPrograms.rows as { faculty_id: number; program_id: number }[]) {
    const fid = Number(row.faculty_id);
    const pid = Number(row.program_id);
    if (!related.has(fid)) related.set(fid, new Set());
    related.get(fid)!.add(pid);
  }

  const incomplete: IncompleteInstructorAlert[] = [];
  let completeInstructors = 0;

  for (const f of facultyRows.rows as {
    id: number; name: string; program_id: number | null; employment_status: string;
  }[]) {
    const s = summaries[f.id];
    if (!s) continue;
    const remaining = s.remaining_load;
    const status = instructorStatus(remaining, s.has_overload);
    if (status === 'COMPLETE' || status === 'OVERLOAD') {
      completeInstructors += 1;
      continue;
    }

    const programIds = related.get(f.id) ? new Set(related.get(f.id)) : new Set<number>();
    if (f.program_id != null) programIds.add(Number(f.program_id));

    const isPermanent = f.employment_status === 'Permanent';
    incomplete.push({
      faculty_id: f.id,
      name: f.name,
      employment_status: f.employment_status,
      program_id: f.program_id != null ? Number(f.program_id) : null,
      related_program_ids: [...programIds],
      current_load: s.current_load,
      regular_load_limit: s.regular_load_limit,
      remaining_load: remaining,
      unit: isPermanent ? 'units' : 'hours',
      status: 'INCOMPLETE',
      message: instructorMessage({
        name: f.name,
        isPermanent,
        current: s.current_load,
        limit: s.regular_load_limit,
        remaining,
      }),
    });
  }

  incomplete.sort((a, b) => a.name.localeCompare(b.name));

  const facultyById = new Map(
    (facultyRows.rows as { id: number; name: string; program_id: number | null }[]).map(f => [f.id, f])
  );
  const overloadReview: OverloadReviewAlert[] = [];
  for (const row of overloadCounts.rows as { faculty_id: number; overload_subject_count: number }[]) {
    const count = Number(row.overload_subject_count) || 0;
    if (count <= 0) continue;
    const f = facultyById.get(Number(row.faculty_id));
    if (!f) continue;
    const programIds = related.get(f.id) ? new Set(related.get(f.id)) : new Set<number>();
    if (f.program_id != null) programIds.add(Number(f.program_id));
    const noun = count === 1 ? 'subject' : 'subjects';
    overloadReview.push({
      faculty_id: f.id,
      name: f.name,
      related_program_ids: [...programIds],
      overload_subject_count: count,
      message: `${f.name} has ${count} ${noun} in Overload requiring review.`,
    });
  }
  overloadReview.sort((a, b) => a.name.localeCompare(b.name));

  const incompleteBlocks: IncompleteBlockAlert[] = [];
  let completeBlocks = 0;
  for (const b of blocks) {
    const subjects = Number(b.subject_count) || 0;
    const unassigned = Number(b.unassigned_count) || 0;
    if (subjects <= 0) continue;
    if (unassigned <= 0) {
      completeBlocks += 1;
      continue;
    }
    const abbr = curriculumVersionAbbrev(blockCurriculumVersion(b.curriculum_version));
    const noun = unassigned === 1 ? 'subject' : 'subjects';
    const programCode = String(b.program_code || '').trim() || 'Program';
    const blockLabel = String(b.block_name || '').trim();
    incompleteBlocks.push({
      block_id: Number(b.id),
      block_name: blockLabel,
      program_id: Number(b.program_id),
      program_code: programCode,
      program_name: String(b.program_name || '').trim(),
      year_level: String(b.year_level || '').trim(),
      curriculum_abbrev: abbr,
      unassigned_count: unassigned,
      subject_count: subjects,
      message: `${programCode} — Block ${blockLabel} has ${unassigned} unassigned ${noun}.`,
    });
  }

  const unassignedTotal = incompleteBlocks.reduce((s, b) => s + b.unassigned_count, 0);

  return {
    school_year: academicYear,
    semester,
    incomplete_instructors: incomplete,
    incomplete_blocks: incompleteBlocks,
    overload_review_instructors: overloadReview,
    incomplete_instructor_count: incomplete.length,
    unassigned_subject_count: unassignedTotal,
    complete_instructor_count: completeInstructors,
    complete_block_count: completeBlocks,
  };
}

async function upsertAlert(params: {
  recipientRole: 'admin' | 'department_chair';
  recipientId: number;
  type: string;
  title: string;
  message: string;
  relatedModule: string;
  relatedId: number;
}) {
  await query(`
    INSERT INTO notifications
      (recipient_id, recipient_role, title, message, type, related_module, related_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (recipient_role, recipient_id, type, related_module, related_id)
      WHERE type IN ('workload_incomplete', 'workload_overload', 'block_unassigned')
    DO UPDATE SET
      title = EXCLUDED.title,
      message = EXCLUDED.message
  `, [
    params.recipientId,
    params.recipientRole,
    params.title,
    params.message,
    params.type,
    params.relatedModule,
    params.relatedId,
  ]);
}

async function pruneAlerts(
  recipientRole: 'admin' | 'department_chair',
  recipientId: number,
  keep: { type: string; module: string; id: number }[]
) {
  if (keep.length === 0) {
    await query(`
      DELETE FROM notifications
      WHERE recipient_role = $1 AND recipient_id = $2
        AND type IN ('workload_incomplete', 'workload_overload', 'block_unassigned')
    `, [recipientRole, recipientId]);
    return;
  }
  const types = keep.map(k => k.type);
  const modules = keep.map(k => k.module);
  const ids = keep.map(k => k.id);
  await query(`
    DELETE FROM notifications n
    WHERE n.recipient_role = $1 AND n.recipient_id = $2
      AND n.type IN ('workload_incomplete', 'workload_overload', 'block_unassigned')
      AND NOT EXISTS (
        SELECT 1
        FROM unnest($3::text[], $4::text[], $5::int[]) AS k(type, module, id)
        WHERE k.type = n.type AND k.module = n.related_module AND k.id = n.related_id
      )
  `, [recipientRole, recipientId, types, modules, ids]);
}

async function syncRecipient(
  recipientRole: 'admin' | 'department_chair',
  recipientId: number,
  snapshot: WorkloadMonitoringSnapshot
) {
  const keep: { type: string; module: string; id: number }[] = [];

  for (const i of snapshot.incomplete_instructors) {
    keep.push({ type: WORKLOAD_TYPE, module: FACULTY_MODULE, id: i.faculty_id });
    await upsertAlert({
      recipientRole,
      recipientId,
      type: WORKLOAD_TYPE,
      title: 'Incomplete Workload',
      message: i.message,
      relatedModule: FACULTY_MODULE,
      relatedId: i.faculty_id,
    });
  }

  for (const i of snapshot.overload_review_instructors) {
    keep.push({ type: OVERLOAD_TYPE, module: FACULTY_MODULE, id: i.faculty_id });
    await upsertAlert({
      recipientRole,
      recipientId,
      type: OVERLOAD_TYPE,
      title: 'Overload Review',
      message: i.message,
      relatedModule: FACULTY_MODULE,
      relatedId: i.faculty_id,
    });
  }

  for (const b of snapshot.incomplete_blocks) {
    keep.push({ type: BLOCK_TYPE, module: BLOCK_MODULE, id: b.block_id });
    await upsertAlert({
      recipientRole,
      recipientId,
      type: BLOCK_TYPE,
      title: 'Unassigned Subjects',
      message: b.message,
      relatedModule: BLOCK_MODULE,
      relatedId: b.block_id,
    });
  }

  await pruneAlerts(recipientRole, recipientId, keep);
}

let lastSyncMs = 0;

export async function syncWorkloadMonitoringNotifications(
  force = false,
  snapshot?: WorkloadMonitoringSnapshot
): Promise<void> {
  const now = Date.now();
  if (!force && now - lastSyncMs < 12_000) return;
  lastSyncMs = now;

  try {
    await ensureNotificationsTable();
    const full = snapshot ?? await computeWorkloadMonitoring();

    await syncRecipient('admin', 0, full);

    const chairs = await query(`
      SELECT id, program_id
      FROM users
      WHERE role = 'department_chair' AND COALESCE(is_active, true) = true
    `);

    for (const chair of chairs.rows as { id: number; program_id: number | null }[]) {
      const pid = chair.program_id == null ? null : Number(chair.program_id);
      const scoped = filterSnapshotForProgram(full, pid);
      await syncRecipient('department_chair', Number(chair.id), scoped);
    }
  } catch (e) {
    console.error('[syncWorkloadMonitoringNotifications]', e);
  }
}

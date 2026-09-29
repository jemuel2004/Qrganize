import { query } from '@/database/db';
import { getActiveAcademicPeriod } from '@/services/activeAcademicPeriod';
import { loadFacultyLoadSummaries } from '@/services/facultyLoadSummaries';
import { fetchBlocksWithAssignmentCounts } from '@/services/blockAssignmentCounts';
import { CONDITION_TYPES_SQL, ensureNotificationsTable } from '@/services/notifications';
import { expireStaleRoomRequests } from '@/services/ensureRoomOccupancy';
import {
  blockCurriculumVersion,
  curriculumVersionAbbrev,
} from '@shared/curriculumVersion';

const INCOMPLETE_EPS = 0.001;
const FACULTY_MODULE = 'faculty';
const BLOCK_MODULE = 'block';
const REQUEST_MODULE = 'room_request';
const SCHEDULE_MODULE = 'schedule';

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

/** Workload complete, but some of the faculty's classes still have no time slot */
export interface ScheduleNeededAlert {
  faculty_id: number;
  name: string;
  related_program_ids: number[];
  unscheduled_count: number;
}

/** Block with some classes scheduled and some not */
export interface IncompleteScheduleBlockAlert {
  block_id: number;
  label: string;
  program_id: number;
  scheduled: number;
  total: number;
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
  schedule_needed_instructors: ScheduleNeededAlert[];
  incomplete_schedule_blocks: IncompleteScheduleBlockAlert[];
  /** Blocks that have classes but none scheduled yet (program id per block, for scoping) */
  unstarted_schedule_blocks: { block_id: number; program_id: number }[];
  /** Faculty whose workload is complete / blocks fully scheduled — to announce resolutions */
  complete_faculty_ids: number[];
  fully_scheduled_block_ids: number[];
  /** Every active faculty member's load this term (Analytics › Faculty Load Status) */
  faculty_loads: FacultyLoadRow[];
}

export interface FacultyLoadRow {
  faculty_id: number;
  name: string;
  current_load: number;
  regular_load_limit: number;
  unit: 'units' | 'hours';
  status: InstructorCompletionStatus;
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
      schedule_needed_instructors: [],
      incomplete_schedule_blocks: [],
      unstarted_schedule_blocks: [],
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
    schedule_needed_instructors: snapshot.schedule_needed_instructors.filter(i => i.related_program_ids.includes(programId)),
    incomplete_schedule_blocks: snapshot.incomplete_schedule_blocks.filter(b => b.program_id === programId),
    unstarted_schedule_blocks: snapshot.unstarted_schedule_blocks.filter(b => b.program_id === programId),
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
    schedule_needed_instructors: [],
    incomplete_schedule_blocks: [],
    unstarted_schedule_blocks: [],
    complete_faculty_ids: [],
    fully_scheduled_block_ids: [],
    faculty_loads: [],
  };

  if (!semester || !academicYear) return empty;

  const hasSlot = `EXISTS (SELECT 1 FROM schedule_sessions ss WHERE ss.master_schedule_id = ms.id
                    AND ss.day_of_week IS NOT NULL AND ss.start_time IS NOT NULL)`;
  const [summaries, facultyRows, loadPrograms, blocks, overloadCounts, blockSlots, facultyUnscheduled] = await Promise.all([
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
    // Classes per block and how many already have a time slot
    query(`
      SELECT bs.block_id,
             COUNT(DISTINCT ms.id)::int AS total,
             COUNT(DISTINCT ms.id) FILTER (WHERE ${hasSlot})::int AS scheduled
      FROM master_schedule ms
      JOIN block_subjects bs ON bs.id = ms.block_subject_id
      JOIN blocks b ON b.id = bs.block_id AND b.is_active = true
      WHERE b.semester = $1 AND b.academic_year = $2
      GROUP BY bs.block_id
    `, [semester, academicYear]),
    // Assigned classes per faculty that still have no time slot
    query(`
      SELECT il.faculty_id, COUNT(DISTINCT ms.id)::int AS unscheduled
      FROM instructor_loads il
      JOIN master_schedule ms ON ms.id = il.master_schedule_id
      WHERE il.semester = $1 AND il.academic_year = $2 AND NOT ${hasSlot}
      GROUP BY il.faculty_id
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
  const facultyLoads: FacultyLoadRow[] = [];
  const completeFaculty: { id: number; name: string; program_id: number | null }[] = [];
  let completeInstructors = 0;

  for (const f of facultyRows.rows as {
    id: number; name: string; program_id: number | null; employment_status: string;
  }[]) {
    const s = summaries[f.id];
    if (!s) continue;
    const remaining = s.remaining_load;
    const status = instructorStatus(remaining, s.has_overload);
    facultyLoads.push({
      faculty_id: f.id, name: f.name, current_load: s.current_load, regular_load_limit: s.regular_load_limit,
      unit: f.employment_status === 'Permanent' ? 'units' : 'hours', status,
    });
    if (status === 'COMPLETE' || status === 'OVERLOAD') {
      completeInstructors += 1;
      completeFaculty.push(f);
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

  /* Scheduling: workload complete but classes without a slot → schedule needed */
  const unscheduledByFaculty = new Map(
    (facultyUnscheduled.rows as { faculty_id: number; unscheduled: number }[]).map(r => [Number(r.faculty_id), Number(r.unscheduled)]),
  );
  const scheduleNeeded: ScheduleNeededAlert[] = completeFaculty
    .filter(f => (unscheduledByFaculty.get(f.id) ?? 0) > 0)
    .map(f => {
      const programIds = related.get(f.id) ? new Set(related.get(f.id)) : new Set<number>();
      if (f.program_id != null) programIds.add(Number(f.program_id));
      return { faculty_id: f.id, name: f.name, related_program_ids: [...programIds], unscheduled_count: unscheduledByFaculty.get(f.id)! };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  /* Scheduling per block: partly scheduled → incomplete; none → not started; all → done */
  const blockInfo = new Map(blocks.map(b => [Number(b.id), b]));
  const incompleteScheduleBlocks: IncompleteScheduleBlockAlert[] = [];
  const unstartedBlocks: { block_id: number; program_id: number }[] = [];
  const fullyScheduled: number[] = [];
  for (const r of blockSlots.rows as { block_id: number; total: number; scheduled: number }[]) {
    const b = blockInfo.get(Number(r.block_id));
    if (!b || r.total <= 0) continue;
    if (r.scheduled >= r.total) { fullyScheduled.push(Number(b.id)); continue; }
    if (r.scheduled === 0) { unstartedBlocks.push({ block_id: Number(b.id), program_id: Number(b.program_id) }); continue; }
    const programCode = String(b.program_code || '').trim() || 'Program';
    incompleteScheduleBlocks.push({
      block_id: Number(b.id),
      label: `${programCode} ${String(b.year_level || '').trim()} — Block ${String(b.block_name || '').trim()}`.replace(/\s+/g, ' '),
      program_id: Number(b.program_id),
      scheduled: r.scheduled,
      total: r.total,
    });
  }

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
    schedule_needed_instructors: scheduleNeeded,
    incomplete_schedule_blocks: incompleteScheduleBlocks,
    unstarted_schedule_blocks: unstartedBlocks,
    complete_faculty_ids: completeFaculty.map(f => f.id),
    faculty_loads: facultyLoads.sort((a, b) => a.name.localeCompare(b.name)),
    fully_scheduled_block_ids: fullyScheduled,
  };
}

type Recipient = 'admin' | 'department_chair' | 'program_chair';
interface Alert { type: string; title: string; message: string; module: string; id: number }
interface PendingRequest { id: number; faculty_name: string; room_name: string | null }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Every alert a recipient should currently see, in plain words */
function alertsFor(snapshot: WorkloadMonitoringSnapshot, requests: PendingRequest[]): Alert[] {
  const alerts: Alert[] = [];
  for (const i of snapshot.incomplete_instructors) {
    alerts.push({
      type: 'workload_incomplete', module: FACULTY_MODULE, id: i.faculty_id,
      title: 'Faculty Workload Incomplete',
      message: `${i.name} has an incomplete workload (${fmtQty(i.current_load)} of ${fmtQty(i.regular_load_limit)} ${i.unit}) and requires review.`,
    });
  }
  for (const i of snapshot.schedule_needed_instructors) {
    alerts.push({
      type: 'schedule_needed', module: FACULTY_MODULE, id: i.faculty_id,
      title: 'Faculty Schedule Needed',
      message: `${i.name} has completed their workload but still needs a class schedule (${plural(i.unscheduled_count, 'class', 'classes')} without a time slot).`,
    });
  }
  for (const b of snapshot.incomplete_schedule_blocks) {
    alerts.push({
      type: 'block_schedule_incomplete', module: BLOCK_MODULE, id: b.block_id,
      title: 'Incomplete Block Schedule',
      message: `${b.label} has ${plural(b.total - b.scheduled, 'class', 'classes')} not yet scheduled (${b.scheduled} of ${b.total} done).`,
    });
  }
  for (const r of requests) {
    alerts.push({
      type: 'room_request_pending', module: REQUEST_MODULE, id: r.id,
      title: 'Room Request Pending',
      message: `${r.faculty_name} submitted a request${r.room_name ? ` for ${r.room_name}` : ''} that requires your review.`,
    });
  }
  for (const i of snapshot.overload_review_instructors) {
    alerts.push({
      type: 'workload_overload', module: FACULTY_MODULE, id: i.faculty_id,
      title: 'Workload Review Required',
      message: `${i.name} has ${plural(i.overload_subject_count, 'subject')} in Overload that need review.`,
    });
  }
  for (const b of snapshot.incomplete_blocks) {
    alerts.push({
      type: 'block_unassigned', module: BLOCK_MODULE, id: b.block_id,
      title: 'Subjects Need a Faculty',
      message: `${b.program_code} — Block ${b.block_name} has ${plural(b.unassigned_count, 'subject')} without an assigned faculty.`,
    });
  }
  if (snapshot.unstarted_schedule_blocks.length > 0) {
    const n = snapshot.unstarted_schedule_blocks.length;
    alerts.push({
      type: 'schedule_pending', module: SCHEDULE_MODULE, id: 0,
      title: 'Schedule Pending',
      message: `${plural(n, 'block')} ${n === 1 ? 'is' : 'are'} still waiting to be scheduled.`,
    });
  }
  return alerts;
}

/**
 * Bring one recipient's condition alerts in line with the current state in
 * three queries: upsert what holds, announce what got resolved by finishing
 * the work, delete the rest. Read state survives an upsert.
 */
async function syncRecipient(recipientRole: Recipient, recipientId: number, alerts: Alert[], snapshot: WorkloadMonitoringSnapshot) {
  if (alerts.length > 0) {
    await query(`
      INSERT INTO notifications (recipient_id, recipient_role, title, message, type, related_module, related_id)
      SELECT $1, $2, a.title, a.message, a.type, a.module, a.id
      FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::int[]) AS a(type, title, message, module, id)
      ON CONFLICT (recipient_role, recipient_id, type, related_module, related_id)
        WHERE type IN (${CONDITION_TYPES_SQL})
      DO UPDATE SET title = EXCLUDED.title, message = EXCLUDED.message
    `, [recipientId, recipientRole, alerts.map(a => a.type), alerts.map(a => a.title), alerts.map(a => a.message), alerts.map(a => a.module), alerts.map(a => a.id)]);
  }

  // Alerts that are about to disappear
  const gone = await query(`
    SELECT n.type, n.related_id FROM notifications n
    WHERE n.recipient_role = $1 AND n.recipient_id = $2 AND n.type IN (${CONDITION_TYPES_SQL})
      AND NOT EXISTS (
        SELECT 1 FROM unnest($3::text[], $4::text[], $5::int[]) AS k(type, module, id)
        WHERE k.type = n.type AND k.module = n.related_module AND k.id = n.related_id
      )
  `, [recipientRole, recipientId, alerts.map(a => a.type), alerts.map(a => a.module), alerts.map(a => a.id)]);

  // Resolved because the work was finished → one low-priority "completed" note
  const completeFaculty = new Set(snapshot.complete_faculty_ids);
  const doneBlocks = new Set(snapshot.fully_scheduled_block_ids);
  const facultyDone = (gone.rows as { type: string; related_id: number }[])
    .filter(r => r.type === 'workload_incomplete' && completeFaculty.has(Number(r.related_id))).map(r => Number(r.related_id));
  const blocksDone = (gone.rows as { type: string; related_id: number }[])
    .filter(r => r.type === 'block_schedule_incomplete' && doneBlocks.has(Number(r.related_id))).map(r => Number(r.related_id));
  if (facultyDone.length || blocksDone.length) {
    await query(`
      INSERT INTO notifications (recipient_id, recipient_role, title, message, type, related_module, related_id)
      SELECT $1::int, $2::text, 'Workload Completed', f.name || ' has completed their workload.', 'workload_completed', '${FACULTY_MODULE}', f.id
      FROM faculty f WHERE f.id = ANY($3::int[])
      UNION ALL
      SELECT $1::int, $2::text, 'Schedule Completed',
             'All classes for ' || COALESCE(p.code || ' ', '') || COALESCE(b.year_level || ' ', '') || '— Block ' || b.block_name || ' have been scheduled.',
             'schedule_completed', '${BLOCK_MODULE}', b.id
      FROM blocks b LEFT JOIN programs p ON p.id = b.program_id WHERE b.id = ANY($4::int[])
    `, [recipientId, recipientRole, facultyDone, blocksDone]);
  }

  if (gone.rows.length > 0) {
    await query(`
      DELETE FROM notifications n
      WHERE n.recipient_role = $1 AND n.recipient_id = $2 AND n.type IN (${CONDITION_TYPES_SQL})
        AND NOT EXISTS (
          SELECT 1 FROM unnest($3::text[], $4::text[], $5::int[]) AS k(type, module, id)
          WHERE k.type = n.type AND k.module = n.related_module AND k.id = n.related_id
        )
    `, [recipientRole, recipientId, alerts.map(a => a.type), alerts.map(a => a.module), alerts.map(a => a.id)]);
  }
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
    await expireStaleRoomRequests();
    const [full, pendingRes] = await Promise.all([
      snapshot ?? computeWorkloadMonitoring(),
      query(`
        SELECT rcr.id,
               COALESCE(NULLIF(TRIM(f.name), ''), NULLIF(TRIM(CONCAT_WS(' ', f.first_name, f.last_name)), ''), 'A faculty member') AS faculty_name,
               r.room_name
        FROM room_change_requests rcr
        JOIN faculty f ON f.id = rcr.faculty_id
        LEFT JOIN rooms r ON r.id = rcr.requested_room_id
        WHERE rcr.status IN ('Pending', 'Pending Confirmation')
      `),
    ]);
    const requests = pendingRes.rows as PendingRequest[];

    // Room requests are reviewed by the admin / department chair
    await syncRecipient('admin', 0, alertsFor(full, requests), full);
    await syncRecipient('department_chair', 0, alertsFor(full, requests), full);
    // Old event-style "New Room Request" rows are replaced by the live pending alert
    await query(`DELETE FROM notifications WHERE type = 'room_request_submitted' AND recipient_role <> 'instructor'`);

    const chairs = await query(`
      SELECT id, program_id
      FROM users
      WHERE role = 'program_chair' AND COALESCE(is_active, true) = true
    `);

    for (const chair of chairs.rows as { id: number; program_id: number | null }[]) {
      const pid = chair.program_id == null ? null : Number(chair.program_id);
      const scoped = filterSnapshotForProgram(full, pid);
      await syncRecipient('program_chair', Number(chair.id), alertsFor(scoped, []), scoped);
    }

    // Condition alerts only belong to current recipients: admin / department chair
    // share id 0, program chairs are per user. Anything else is a leftover duplicate.
    await query(`
      DELETE FROM notifications
      WHERE type IN (${CONDITION_TYPES_SQL})
        AND ((recipient_role IN ('admin', 'department_chair') AND recipient_id <> 0)
          OR (recipient_role = 'program_chair' AND recipient_id <> ALL($1::int[])))
    `, [(chairs.rows as { id: number }[]).map(c => Number(c.id))]);
  } catch (e) {
    console.error('[syncWorkloadMonitoringNotifications]', e);
  }
}

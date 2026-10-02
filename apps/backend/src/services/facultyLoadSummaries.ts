import { query } from '@/database/db';
import { ensurePraiseSplitColumn } from '@/services/praiseSplit';
import { regularUnitsCap } from '@shared/regularLoad';
import { getWorkloadPolicy, sqlNumber } from '@/services/workloadPolicy';

export interface FacultyLoadSummary {
  current_load: number;
  regular_load_limit: number;
  remaining_load: number;
  has_overload: boolean;
  total_deduction_units: number;
  total_overload_units: number;
  total_overload_hours: number;
  total_instructor_units: number;
  /** Subjects assigned this term (Regular, Overload or Praise) — 0 = still needs one */
  assigned_count: number;
  employment_status: string;
}

let deductionsTableReady = false;
async function ensureDeductionsTable() {
  if (deductionsTableReady) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS instructor_load_deductions (
        id            SERIAL PRIMARY KEY,
        faculty_id    INTEGER NOT NULL REFERENCES faculty(id) ON DELETE CASCADE,
        deduction_type TEXT NOT NULL,
        description   TEXT DEFAULT '',
        deducted_units NUMERIC(4,2) NOT NULL DEFAULT 0,
        semester      TEXT NOT NULL,
        school_year   TEXT NOT NULL,
        created_at    TIMESTAMP DEFAULT NOW(),
        updated_at    TIMESTAMP DEFAULT NOW()
      )
    `);
    deductionsTableReady = true;
  } catch (e) {
    console.error('[facultyLoadSummaries] ensureDeductionsTable DDL failed — will retry:', e);
  }
}

/**
 * Same regular-load math as Faculty Workload summaries.
 * Permanent: lecture + 0.75*lab units vs (Regular cap − the term's deloading).
 * Contractual: regular contact hours vs the Contractual hours limit.
 * Limits come from Settings → Workload Limits (18.25 / 30 by default).
 */
export async function loadFacultyLoadSummaries(options: {
  semester: string;
  academicYear: string;
  programId?: string;
}): Promise<Record<number, FacultyLoadSummary>> {
  await ensureDeductionsTable();
  await ensurePraiseSplitColumn();
  const policy = await getWorkloadPolicy();

  const semester = options.semester || '';
  const academicYear = options.academicYear || '';
  const programId = options.programId || '';
  const params: unknown[] = [semester, academicYear];
  let idx = 3;

  let sql = `
      WITH deduction_agg AS (
        SELECT faculty_id, SUM(deducted_units) AS total_deducted
        FROM   instructor_load_deductions
        WHERE  ($1 = '' OR semester    = $1)
          AND  ($2 = '' OR school_year = $2)
        GROUP  BY faculty_id
      ),
      overload_agg AS (
        SELECT faculty_id,
               SUM(units) AS total_units,
               SUM(hours) AS total_hours
        FROM   overloads
        WHERE  is_praise = false
          AND  ($1 = '' OR semester      = $1)
          AND  ($2 = '' OR academic_year = $2)
        GROUP  BY faculty_id
      ),
      -- Split Praise portions: only the Lec or Lab of a Regular subject moved to Praise
      praise_split_agg AS (
        SELECT faculty_id,
               SUM(units) AS total_units,
               SUM(hours) AS total_hours
        FROM   overloads
        WHERE  is_praise = true
          AND  ($1 = '' OR semester      = $1)
          AND  ($2 = '' OR academic_year = $2)
        GROUP  BY faculty_id
      ),
      overloaded_ms AS (
        SELECT faculty_id, master_schedule_id, SUM(hours) AS split_hours
        FROM overloads
        GROUP BY faculty_id, master_schedule_id
      )
      SELECT
        f.id                                                      AS faculty_id,
        f.employment_status,

        CASE WHEN f.employment_status = 'Permanent'
          THEN GREATEST(0, ${sqlNumber(regularUnitsCap(policy))} - COALESCE(da.total_deducted, 0))
          ELSE ${sqlNumber(policy.contractualHours)}
        END                                                       AS regular_load_limit,

        CASE WHEN f.employment_status = 'Permanent'
          THEN COALESCE(da.total_deducted, 0)
          ELSE 0
        END                                                       AS total_deduction_units,

        COALESCE(SUM(
          CASE WHEN il.load_category = 'Regular' THEN
            CASE
              WHEN oms.master_schedule_id IS NOT NULL
                THEN il.units
              ELSE COALESCE(c2.lecture_hours, 0) * 1.0 + COALESCE(c2.laboratory_hours, 0) * 0.75
            END
          ELSE 0 END
        ), 0)                                                     AS total_regular_units,

        -- Split (Contractual): the row keeps only its regular hours; the rest is in overloads
        COALESCE(SUM(
          CASE WHEN il.load_category = 'Regular' THEN
            CASE
              WHEN COALESCE(oms.split_hours, 0) > 0 THEN COALESCE(il.hours, 0)
              ELSE COALESCE(c2.total_hours, il.hours, 0)
            END
          ELSE 0 END
        ), 0)                                                     AS total_regular_hours,

        COALESCE(oa.total_units, 0)                               AS total_overload_units,
        COALESCE(oa.total_hours, 0)                               AS total_overload_hours,

        COALESCE(SUM(
          CASE WHEN il.load_category = 'Praise' THEN
            COALESCE(c2.lecture_hours, 0) * 1.0 + COALESCE(c2.laboratory_hours, 0) * 0.75
          ELSE 0 END
        ), 0) + COALESCE(psa.total_units, 0)                      AS total_praise_units,

        COALESCE(SUM(
          CASE WHEN il.load_category = 'Praise'
            THEN COALESCE(c2.total_hours, il.hours, 0)
          ELSE 0 END
        ), 0) + COALESCE(psa.total_hours, 0)                      AS total_praise_hours,

        COUNT(DISTINCT il.id)                                     AS assigned_count

      FROM   faculty f
      LEFT   JOIN deduction_agg da  ON da.faculty_id = f.id
      LEFT   JOIN overload_agg  oa  ON oa.faculty_id = f.id
      LEFT   JOIN praise_split_agg psa ON psa.faculty_id = f.id
      LEFT   JOIN instructor_loads il
        ON   il.faculty_id    = f.id
        AND  ($1 = '' OR il.semester      = $1)
        AND  ($2 = '' OR il.academic_year = $2)
      LEFT   JOIN master_schedule ms2 ON ms2.id = il.master_schedule_id
      LEFT   JOIN block_subjects  bs2 ON bs2.id = ms2.block_subject_id
      LEFT   JOIN curriculums     c2  ON c2.id  = bs2.curriculum_id
      LEFT   JOIN overloaded_ms   oms
        ON   oms.faculty_id         = il.faculty_id
        AND  oms.master_schedule_id = il.master_schedule_id

      WHERE f.is_active = true
    `;

  if (programId) {
    sql += ` AND f.program_id = $${idx++}`;
    params.push(programId);
  }

  sql += ' GROUP BY f.id, f.employment_status, da.total_deducted, oa.total_units, oa.total_hours, psa.total_units, psa.total_hours';

  const result = await query(sql, params);
  const summaries: Record<number, FacultyLoadSummary> = {};

  for (const row of result.rows) {
    const isP = row.employment_status === 'Permanent';
    const limit = parseFloat(row.regular_load_limit) || 0;
    const current = isP
      ? parseFloat(row.total_regular_units) || 0
      : parseFloat(row.total_regular_hours) || 0;
    const dedUnits = parseFloat(row.total_deduction_units) || 0;
    const olUnits = parseFloat(row.total_overload_units) || 0;
    const olHours = parseFloat(row.total_overload_hours) || 0;
    const praiseUnits = parseFloat(row.total_praise_units) || 0;
    const praiseHours = parseFloat(row.total_praise_hours) || 0;
    const totalInstructor = isP
      ? current + dedUnits + olUnits + praiseUnits
      : current + olHours + praiseHours;

    summaries[row.faculty_id] = {
      current_load: current,
      regular_load_limit: limit,
      remaining_load: limit - current,
      has_overload: olUnits > 0.001 || olHours > 0.001,
      total_deduction_units: dedUnits,
      total_overload_units: olUnits,
      total_overload_hours: olHours,
      total_instructor_units: totalInstructor,
      assigned_count: Number(row.assigned_count) || 0,
      employment_status: row.employment_status,
    };
  }

  return summaries;
}

import { query, transaction } from './db';
import { subjectCategorySql } from '@shared/subjectCategory';

/** True when err is a concurrent pg_class name clash (duplicate relation create). */
function isPgClassNameClash(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' && e?.constraint === 'pg_class_relname_nsp_index';
}

let versionReady: Promise<void> | null = null;

/** Idempotent: add version column and unique index that includes it. */
export function ensureCurriculumVersion(): Promise<void> {
  if (!versionReady) {
    versionReady = (async () => {
      await query(`
        ALTER TABLE curriculums
        ADD COLUMN IF NOT EXISTS curriculum_version VARCHAR(20) NOT NULL DEFAULT 'old'
      `);
      await query(`
        DO $$ BEGIN
          ALTER TABLE curriculums
            ADD CONSTRAINT curriculums_curriculum_version_check
            CHECK (curriculum_version IN ('old', 'new'));
        EXCEPTION
          WHEN duplicate_object THEN NULL;
        END $$
      `);
      await query(`
        ALTER TABLE curriculums
        DROP CONSTRAINT IF EXISTS curriculums_program_id_year_level_semester_subject_code_key
      `);
      await query(`
        CREATE UNIQUE INDEX IF NOT EXISTS curriculums_program_year_sem_code_version_uidx
        ON curriculums (program_id, year_level, semester, subject_code, curriculum_version)
      `);
      await query(`
        ALTER TABLE curriculums ALTER COLUMN curriculum_version SET DEFAULT 'old'
      `);
      const oldExists = await query(`
        SELECT 1 FROM curriculums WHERE curriculum_version = 'old' LIMIT 1
      `);
      if (oldExists.rows.length === 0) {
        await query(`
          UPDATE curriculums
          SET curriculum_version = 'old', updated_at = NOW()
          WHERE curriculum_version = 'new'
        `);
      }
    })().catch(err => {
      versionReady = null;
      throw err;
    });
  }
  return versionReady;
}

let blockVersionReady: Promise<void> | null = null;

const BLOCKS_ACTIVE_UNIQUE_SQL = `
  CREATE UNIQUE INDEX IF NOT EXISTS blocks_active_unique
  ON blocks (program_id, year_level, semester, academic_year, block_name, curriculum_version)
  WHERE is_active = true
`;

/**
 * Idempotent: store Old/New curriculum on each block. Existing rows default to old.
 *
 * Safe under concurrent callers (notifications + workload monitoring on dashboard load).
 * Uses a module-level Promise mutex (same pattern as ensureOtpEnabledColumn) and only
 * DROP/CREATE when the index is missing or still on the pre-v36 column set.
 */
export function ensureBlockCurriculumVersion(): Promise<void> {
  if (!blockVersionReady) {
    blockVersionReady = (async () => {
      await query(`
        ALTER TABLE blocks
        ADD COLUMN IF NOT EXISTS curriculum_version VARCHAR(20) NOT NULL DEFAULT 'old'
      `);
      await query(`
        DO $$ BEGIN
          ALTER TABLE blocks
            ADD CONSTRAINT blocks_curriculum_version_check
            CHECK (curriculum_version IN ('old', 'new'));
        EXCEPTION
          WHEN duplicate_object THEN NULL;
        END $$
      `);

      const existing = await query(`
        SELECT indexdef
        FROM pg_indexes
        WHERE indexname = 'blocks_active_unique'
          AND schemaname = ANY (current_schemas(false))
      `);
      const indexdef = String(existing.rows[0]?.indexdef ?? '');
      const hasCurriculumVersion = /\bcurriculum_version\b/i.test(indexdef);

      if (!indexdef || !hasCurriculumVersion) {
        await query(`DROP INDEX IF EXISTS blocks_active_unique`);
        try {
          await query(BLOCKS_ACTIVE_UNIQUE_SQL);
        } catch (err) {
          // Parallel init: another request already created the relation name.
          if (isPgClassNameClash(err)) {
            const again = await query(`
              SELECT indexdef
              FROM pg_indexes
              WHERE indexname = 'blocks_active_unique'
                AND schemaname = ANY (current_schemas(false))
            `);
            if (/\bcurriculum_version\b/i.test(String(again.rows[0]?.indexdef ?? ''))) {
              return;
            }
          }
          throw err;
        }
      }
    })().catch(err => {
      blockVersionReady = null;
      throw err;
    });
  }
  return blockVersionReady;
}

let hoursReady: Promise<void> | null = null;

/**
 * Idempotent: widen hour columns from NUMERIC(4,2) (max 99.99) to NUMERIC(6,2)
 * so long subjects such as a 240-hour OJT fit. total_hours is generated from
 * the other two, so it is dropped and re-added around the type change.
 */
export function ensureWideHourColumns(): Promise<void> {
  if (!hoursReady) {
    hoursReady = (async () => {
      const narrow = await query(`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = ANY (current_schemas(false))
          AND numeric_precision < 6
          AND (table_name, column_name) IN (
            ('curriculums', 'lecture_hours'), ('curriculums', 'laboratory_hours'),
            ('instructor_loads', 'hours'), ('overloads', 'hours'), ('praise', 'equivalent_hours')
          )
      `);
      const cols = narrow.rows as Array<{ table_name: string; column_name: string }>;
      if (cols.length === 0) return;

      await transaction(async (client) => {
        if (cols.some(c => c.table_name === 'curriculums')) {
          await client.query(`ALTER TABLE curriculums DROP COLUMN IF EXISTS total_hours`);
          await client.query(`
            ALTER TABLE curriculums
              ALTER COLUMN lecture_hours TYPE NUMERIC(6,2),
              ALTER COLUMN laboratory_hours TYPE NUMERIC(6,2)
          `);
          await client.query(`
            ALTER TABLE curriculums
              ADD COLUMN total_hours NUMERIC(6,2) GENERATED ALWAYS AS (lecture_hours + laboratory_hours) STORED
          `);
        }
        for (const c of cols.filter(c => c.table_name !== 'curriculums')) {
          await client.query(`ALTER TABLE ${c.table_name} ALTER COLUMN ${c.column_name} TYPE NUMERIC(6,2)`);
        }
      });
      console.log('[migrate] hour columns widened to NUMERIC(6,2)');
    })().catch(err => {
      hoursReady = null;
      throw err;
    });
  }
  return hoursReady;
}

let migrated = false;
let categorySynced = false;

export async function ensureCurriculumFields(): Promise<void> {
  if (migrated) return;

  await query(`ALTER TABLE curriculums ADD COLUMN IF NOT EXISTS prerequisites TEXT NOT NULL DEFAULT ''`);
  await query(`ALTER TABLE curriculums ADD COLUMN IF NOT EXISTS grade VARCHAR(50) NOT NULL DEFAULT ''`);
  await query(`ALTER TABLE curriculums ADD COLUMN IF NOT EXISTS subject_category VARCHAR(10) NOT NULL DEFAULT 'Minor'`);
  await ensureCurriculumVersion();
  await ensureWideHourColumns();

  /* Lecture only (no lab hours) → Minor; any laboratory hours → Major.
     Idempotent: only rewrites rows that do not already match the rule. */
  if (!categorySynced) {
    try {
      await query(`
        UPDATE curriculums
        SET subject_category = ${subjectCategorySql()},
            updated_at = NOW()
        WHERE subject_category IS DISTINCT FROM (${subjectCategorySql()})
      `);
    } catch (err) {
      console.warn('[migrate] subject_category sync warning (non-fatal):', err);
    }
    categorySynced = true;
  }

  /* ── One-time normalization of existing data ──────────────────────── *
   *                                                                      *
   * Historical imports may have stored "First Year", "FIRST YEAR",       *
   * "First Semester", etc.  The UI dropdowns and current import code     *
   * always use "1st Year" / "1st Semester" style.  Rows with the old    *
   * format never match a filter or duplicate check, so they appear       *
   * missing even though they exist in the database.                      *
   *                                                                      *
   * Strategy:                                                            *
   *  1. For each canonical target, find rows that would CONFLICT after    *
   *     normalization (i.e., a canonical row already exists for the same *
   *     program+year+sem+code).  Mark those as is_active=false so they  *
   *     don't violate the UNIQUE constraint when we UPDATE the others.   *
   *  2. Bulk-UPDATE non-canonical rows to their canonical equivalents.   *
   *  3. Do the same for semester.                                         *
   ************************************************************************/

  try {
    /* ── year_level ── */
    const yearCases = `
      CASE LOWER(TRIM(year_level))
        WHEN 'first year'  THEN '1st Year'
        WHEN '1st year'    THEN '1st Year'
        WHEN '1 year'      THEN '1st Year'
        WHEN 'year 1'      THEN '1st Year'
        WHEN 'year i'      THEN '1st Year'
        WHEN 'i year'      THEN '1st Year'
        WHEN 'second year' THEN '2nd Year'
        WHEN '2nd year'    THEN '2nd Year'
        WHEN '2 year'      THEN '2nd Year'
        WHEN 'year 2'      THEN '2nd Year'
        WHEN 'year ii'     THEN '2nd Year'
        WHEN 'ii year'     THEN '2nd Year'
        WHEN 'third year'  THEN '3rd Year'
        WHEN '3rd year'    THEN '3rd Year'
        WHEN '3 year'      THEN '3rd Year'
        WHEN 'year 3'      THEN '3rd Year'
        WHEN 'year iii'    THEN '3rd Year'
        WHEN 'iii year'    THEN '3rd Year'
        WHEN 'fourth year' THEN '4th Year'
        WHEN '4th year'    THEN '4th Year'
        WHEN '4 year'      THEN '4th Year'
        WHEN 'year 4'      THEN '4th Year'
        WHEN 'year iv'     THEN '4th Year'
        WHEN 'iv year'     THEN '4th Year'
        ELSE year_level
      END`;

    /* Deactivate non-canonical rows where the canonical version already exists */
    await query(`
      UPDATE curriculums SET is_active = false
      WHERE year_level NOT IN ('1st Year','2nd Year','3rd Year','4th Year')
        AND EXISTS (
          SELECT 1 FROM curriculums c2
          WHERE c2.program_id   = curriculums.program_id
            AND c2.year_level   = (${yearCases})
            AND c2.semester     = curriculums.semester
            AND c2.subject_code = curriculums.subject_code
            AND c2.is_active    = true
            AND c2.id          != curriculums.id
        )
    `);

    /* Normalize the remaining non-canonical rows (no conflict after deactivation above) */
    await query(`
      UPDATE curriculums
      SET year_level = (${yearCases}), updated_at = NOW()
      WHERE year_level NOT IN ('1st Year','2nd Year','3rd Year','4th Year')
    `);
  } catch (err) {
    console.warn('[migrate] year_level normalization warning (non-fatal):', err);
  }

  try {
    /* ── semester ── */
    const semCases = `
      CASE LOWER(TRIM(semester))
        WHEN 'first semester'   THEN '1st Semester'
        WHEN '1st semester'     THEN '1st Semester'
        WHEN '1 semester'       THEN '1st Semester'
        WHEN 'semester 1'       THEN '1st Semester'
        WHEN 'first sem'        THEN '1st Semester'
        WHEN '1st sem'          THEN '1st Semester'
        WHEN 'sem 1'            THEN '1st Semester'
        WHEN '1 sem'            THEN '1st Semester'
        WHEN 'second semester'  THEN '2nd Semester'
        WHEN '2nd semester'     THEN '2nd Semester'
        WHEN '2 semester'       THEN '2nd Semester'
        WHEN 'semester 2'       THEN '2nd Semester'
        WHEN 'second sem'       THEN '2nd Semester'
        WHEN '2nd sem'          THEN '2nd Semester'
        WHEN 'sem 2'            THEN '2nd Semester'
        WHEN '2 sem'            THEN '2nd Semester'
        WHEN 'summer semester'  THEN 'Summer'
        WHEN 'summer sem'       THEN 'Summer'
        WHEN 'summer term'      THEN 'Summer'
        WHEN 'summer class'     THEN 'Summer'
        ELSE semester
      END`;

    /* Deactivate non-canonical semester rows where canonical already exists */
    await query(`
      UPDATE curriculums SET is_active = false
      WHERE semester NOT IN ('1st Semester','2nd Semester','Summer')
        AND EXISTS (
          SELECT 1 FROM curriculums c2
          WHERE c2.program_id   = curriculums.program_id
            AND c2.year_level   = curriculums.year_level
            AND c2.semester     = (${semCases})
            AND c2.subject_code = curriculums.subject_code
            AND c2.is_active    = true
            AND c2.id          != curriculums.id
        )
    `);

    /* Normalize the remaining non-canonical semester rows */
    await query(`
      UPDATE curriculums
      SET semester = (${semCases}), updated_at = NOW()
      WHERE semester NOT IN ('1st Semester','2nd Semester','Summer')
    `);
  } catch (err) {
    console.warn('[migrate] semester normalization warning (non-fatal):', err);
  }

  console.log('[migrate] ensureCurriculumFields: columns verified, existing data normalized');
  migrated = true;
}

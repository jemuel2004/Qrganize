import { query } from '@/server/db';
import { ensureSystemSettingsTable } from '@/server/schema-guard';

export interface ActiveAcademicPeriod {
  schoolYear: string | null;
  semester: string | null;
}

/**
 * Admin-configured active academic period.
 * School year: Active row in `school_years`, falling back to system_settings.
 * Semester: system_settings.current_semester.
 */
export async function getActiveAcademicPeriod(): Promise<ActiveAcademicPeriod> {
  await ensureSystemSettingsTable();

  let schoolYear: string | null = null;
  try {
    const syRes = await query(
      "SELECT label FROM school_years WHERE status = 'Active' LIMIT 1"
    );
    schoolYear = syRes.rows[0]?.label ?? null;
  } catch {
    const ssRes = await query(
      "SELECT value FROM system_settings WHERE key = 'current_school_year'"
    );
    schoolYear = ssRes.rows[0]?.value ?? null;
  }

  const semRes = await query(
    "SELECT value FROM system_settings WHERE key = 'current_semester'"
  );
  const semester = semRes.rows[0]?.value ?? null;

  return {
    schoolYear: schoolYear ? String(schoolYear).trim() || null : null,
    semester: semester ? String(semester).trim() || null : null,
  };
}

export function isActivePeriodConfigured(period: ActiveAcademicPeriod): period is { schoolYear: string; semester: string } {
  return Boolean(period.schoolYear && period.semester);
}

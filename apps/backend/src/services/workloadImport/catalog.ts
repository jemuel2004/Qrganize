import { parseDays, type WeekDay } from '@shared/dayCombination';
import type { ImportCatalog, ImportTerm } from './types';

type Queryable = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

const str = (v: unknown) => (v == null ? '' : String(v));
const num = (v: unknown) => (v == null || v === '' ? 0 : Number(v) || 0);

/** Read-only snapshot of the QRganize records the workload import matches against. */
export async function loadImportCatalog(q: Queryable, term: ImportTerm): Promise<ImportCatalog> {
  // One after another: q may be a single transaction client
  const programs = await q(`SELECT id, code FROM programs WHERE is_active IS NOT FALSE ORDER BY id`);
  const subjects = await q(`SELECT id, program_id, year_level, semester, curriculum_version, subject_code, subject_name,
              COALESCE(lecture_hours, 0) AS lec, COALESCE(laboratory_hours, 0) AS lab, COALESCE(total_hours, 0) AS total
         FROM curriculums WHERE is_active = true`);
  const faculty = await q(`SELECT f.id, f.name, f.first_name, f.middle_name, f.last_name, f.position, f.employment_status,
              f.is_active, f.program_id, ia.username AS account_username,
              f.educational_qualification, f.major, f.eligibility, f.years_in_service
         FROM faculty f LEFT JOIN instructor_accounts ia ON ia.faculty_id = f.id
        ORDER BY f.id`);
  const rooms = await q(`SELECT id, room_name, room_type, COALESCE(status, 'Active') AS status FROM rooms ORDER BY id`);
  const blocks = await q(`SELECT id, program_id, year_level, semester, academic_year, block_name, curriculum_version
         FROM blocks WHERE is_active = true AND academic_year = $1 AND semester = $2`, [term.academicYear, term.semester]);
  const combos = await q(`SELECT days FROM semester_day_combinations WHERE academic_year = $1 AND semester = $2 AND is_active = true`,
    [term.academicYear, term.semester]);
  return {
    programs: programs.rows.map(r => ({ id: num(r.id), code: str(r.code) })),
    subjects: subjects.rows.map(r => ({
      id: num(r.id), programId: num(r.program_id), yearLevel: str(r.year_level), semester: str(r.semester),
      version: str(r.curriculum_version), code: str(r.subject_code), name: str(r.subject_name),
      lecHours: num(r.lec), labHours: num(r.lab), totalHours: num(r.total),
    })),
    faculty: faculty.rows.map(r => ({
      id: num(r.id), name: str(r.name), firstName: str(r.first_name), middleName: str(r.middle_name), lastName: str(r.last_name),
      position: r.position == null ? null : str(r.position), employmentStatus: str(r.employment_status),
      isActive: r.is_active !== false, programId: r.program_id == null ? null : num(r.program_id),
      accountUsername: r.account_username == null ? null : str(r.account_username),
      qualification: r.educational_qualification == null ? null : str(r.educational_qualification),
      major: r.major == null ? null : str(r.major),
      eligibility: r.eligibility == null ? null : str(r.eligibility),
      yearsInService: r.years_in_service == null ? null : num(r.years_in_service),
    })),
    rooms: rooms.rows.map(r => ({ id: num(r.id), name: str(r.room_name), type: str(r.room_type), status: str(r.status) })),
    blocks: blocks.rows.map(r => ({
      id: num(r.id), programId: num(r.program_id), yearLevel: str(r.year_level), semester: str(r.semester),
      academicYear: str(r.academic_year), blockName: str(r.block_name), version: str(r.curriculum_version),
    })),
    dayCombinations: combos.rows.map(r => parseDays(str(r.days))).filter((d): d is WeekDay[] => !!d && d.length > 0),
  };
}

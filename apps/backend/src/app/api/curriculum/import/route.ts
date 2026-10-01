import { NextRequest, NextResponse } from 'next/server';
import { query, transaction } from '@/database/db';
import { getAuthUser } from '@/auth/auth';
import { ensureCurriculumFields } from '@/database/migrateCurriculum';
import { normalizeYearLevel, normalizeSemester } from '@shared/normalizeCurriculum';
import { categoryFromHours } from '@shared/subjectCategory';
import {
  DEFAULT_CURRICULUM_VERSION,
  parseCurriculumVersion,
} from '@shared/curriculumVersion';
import { normalizeComparableText, normalizeCourseCode } from '@shared/curriculumImport';
import { getChairAssignedProgramId, isScopedChair } from '@/services/programScope';
import { withAudit } from '@/services/audit';

interface ImportRow {
  program_id: number;
  year_level: string;
  semester: string;
  subject_code: string;
  subject_name: string;
  lecture_hours: number;
  laboratory_hours: number;
  units: number;
  prerequisites: string;
  grade: string;
  subject_category?: string;
}

interface ExistingRow {
  id: number;
  program_id: number;
  year_level: string;
  semester: string;
  subject_code: string;
  subject_name: string;
  lecture_hours: number;
  laboratory_hours: number;
  units: number;
  prerequisites: string;
  grade: string;
  is_active: boolean;
}

function identityKey(programId: number, year: string, sem: string, code: string): string {
  return `${programId}|${year}|${sem}|${code}`;
}

function sameRecord(row: {
  subject_name: string;
  lecture_hours: number;
  laboratory_hours: number;
  units: number;
  prerequisites: string;
  grade: string;
}, existing: ExistingRow): boolean {
  return normalizeComparableText(row.subject_name) === normalizeComparableText(existing.subject_name)
    && Number(row.lecture_hours) === Number(existing.lecture_hours)
    && Number(row.laboratory_hours) === Number(existing.laboratory_hours)
    && Number(row.units) === Number(existing.units)
    && normalizeComparableText(row.prerequisites) === normalizeComparableText(existing.prerequisites ?? '')
    && (row.grade || '') === (existing.grade || '');
}

async function POST_handler(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { id?: number; role?: string } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let chairProgramId: number | null = null;
    if (isScopedChair(auth)) {
      chairProgramId = auth.id ? await getChairAssignedProgramId(Number(auth.id)) : null;
      if (chairProgramId == null) {
        return NextResponse.json({ error: 'No program is assigned to your Program Chair account.' }, { status: 403 });
      }
    }

    await ensureCurriculumFields();

    const body = await req.json();
    const rows: ImportRow[] = body?.rows ?? [];
    const version = parseCurriculumVersion(body?.curriculum_version) ?? DEFAULT_CURRICULUM_VERSION;
    const applyUpdates = body?.apply_updates === true;
    // Subjects the preview found missing from the file — only this import's program and version
    const removeIds = Array.isArray(body?.remove_ids)
      ? [...new Set((body.remove_ids as unknown[]).map(Number).filter(n => Number.isInteger(n) && n > 0))]
      : [];
    const bodyProgramId = Number(body?.program_id);

    if (!Array.isArray(rows) || (rows.length === 0 && removeIds.length === 0)) {
      return NextResponse.json({ error: 'No rows to import' }, { status: 400 });
    }
    if (rows.length > 1500) {
      return NextResponse.json({ error: 'Too many rows. Import at most 1500 subjects at a time.' }, { status: 400 });
    }

    const prepared: Array<{
      programId: number;
      yearLevel: string;
      semester: string;
      subjectCode: string;
      subjectName: string;
      lecHours: number;
      labHours: number;
      units: number;
      prereq: string;
      grade: string;
      category: string;
    }> = [];
    const errors: string[] = [];

    for (const row of rows) {
      if (!row.program_id || !row.year_level || !row.semester || !row.subject_code || !row.subject_name) {
        const missing = [
          !row.program_id && 'program_id',
          !row.year_level && 'year_level',
          !row.semester && 'semester',
          !row.subject_code && 'subject_code',
          !row.subject_name && 'subject_name',
        ].filter(Boolean).join(', ');
        errors.push(`${row.subject_code || '?'}: missing required fields (${missing})`);
        continue;
      }

      const programId = Number(row.program_id);
      const yearLevel = normalizeYearLevel(row.year_level);
      const semester = normalizeSemester(row.semester);
      const subjectCode = String(row.subject_code).toUpperCase().trim();
      const subjectName = String(row.subject_name).trim();
      const lecHours = Number(row.lecture_hours) || 0;
      const labHours = Number(row.laboratory_hours) || 0;
      const units = parseFloat(String(row.units)) || 0;
      const prereq = String(row.prerequisites ?? '').trim();
      const grade = String(row.grade ?? '').trim();
      const category = categoryFromHours(lecHours, labHours, subjectCode);

      if (!Number.isInteger(programId) || programId <= 0) {
        errors.push(`${subjectCode}: invalid program`);
        continue;
      }
      if (chairProgramId != null && programId !== chairProgramId) {
        errors.push(`${subjectCode}: you can only import subjects for your assigned program`);
        continue;
      }
      if (!yearLevel || !semester) {
        errors.push(`${subjectCode}: unrecognized year level ("${row.year_level}") or semester ("${row.semester}")`);
        continue;
      }
      if (subjectCode.length > 50 || subjectName.length > 255) {
        errors.push(`${subjectCode}: value exceeds allowed length`);
        continue;
      }
      // Hours columns are NUMERIC(6,2); units stay NUMERIC(4,2).
      if (lecHours < 0 || labHours < 0 || lecHours + labHours > 9999.99 || units < 0 || units > 99.99) {
        errors.push(`${subjectCode}: hours or units out of range`);
        continue;
      }

      prepared.push({
        programId, yearLevel, semester, subjectCode, subjectName,
        lecHours, labHours, units, prereq, grade, category,
      });
    }

    const programIds = [...new Set(prepared.map(r => r.programId))];
    // Removal-only import (nothing new or changed): scope it to the program the preview was built for
    if (programIds.length === 0 && removeIds.length > 0 && Number.isInteger(bodyProgramId) && bodyProgramId > 0
      && (chairProgramId == null || bodyProgramId === chairProgramId)) {
      programIds.push(bodyProgramId);
    }
    if (programIds.length === 0) {
      return NextResponse.json({ imported: 0, reactivated: 0, updated: 0, removed: 0, total: 0, duplicated: 0, errors });
    }
    const existingRes = await query(
      `SELECT id, program_id, year_level, semester, subject_code, subject_name,
              lecture_hours, laboratory_hours, units, prerequisites, grade, is_active
         FROM curriculums
        WHERE program_id = ANY($1) AND curriculum_version = $2`,
      [programIds, version],
    );
    const existingByKey = new Map<string, ExistingRow>();
    // Same code apart from spaces/dashes ("PATH- FIT 1" vs "PATH-FIT 1") — matches the preview
    const existingByLooseKey = new Map<string, ExistingRow[]>();
    for (const row of existingRes.rows as ExistingRow[]) {
      existingByKey.set(
        identityKey(Number(row.program_id), row.year_level, row.semester, row.subject_code),
        row,
      );
      const loose = identityKey(Number(row.program_id), row.year_level, row.semester, normalizeCourseCode(row.subject_code));
      existingByLooseKey.set(loose, [...(existingByLooseKey.get(loose) ?? []), row]);
    }
    const findExisting = (programId: number, year: string, sem: string, code: string): ExistingRow | undefined => {
      const exact = existingByKey.get(identityKey(programId, year, sem, code));
      if (exact) return exact;
      const loose = existingByLooseKey.get(identityKey(programId, year, sem, normalizeCourseCode(code))) ?? [];
      return loose.length === 1 ? loose[0] : undefined;
    };

    const result = await transaction(async (client) => {
      let imported = 0;
      let reactivated = 0;
      let duplicated = 0;
      let updated = 0;
      let removed = 0;

      for (const row of prepared) {
        const existing = findExisting(row.programId, row.yearLevel, row.semester, row.subjectCode);

        if (!existing) {
          const insertRes = await client.query(
            `INSERT INTO curriculums
               (program_id, year_level, semester, subject_code, subject_name,
                lecture_hours, laboratory_hours, units, prerequisites, grade, subject_category, curriculum_version, is_active)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true)
             ON CONFLICT (program_id, year_level, semester, subject_code, curriculum_version) DO NOTHING`,
            [row.programId, row.yearLevel, row.semester, row.subjectCode, row.subjectName,
             row.lecHours, row.labHours, row.units, row.prereq, row.grade, row.category, version],
          );
          if ((insertRes.rowCount ?? 0) > 0) imported++;
          else duplicated++;
          continue;
        }

        if (existing.is_active === false) {
          await client.query(
            `UPDATE curriculums
                SET is_active=true, subject_name=$1,
                    lecture_hours=$2, laboratory_hours=$3, units=$4,
                    prerequisites=$5, grade=$6,
                    subject_category=CASE WHEN subject_category_manual THEN subject_category ELSE $7 END, updated_at=NOW()
              WHERE id=$8`,
            [row.subjectName, row.lecHours, row.labHours, row.units, row.prereq, row.grade, row.category, existing.id],
          );
          reactivated++;
          continue;
        }

        if (sameRecord({
          subject_name: row.subjectName,
          lecture_hours: row.lecHours,
          laboratory_hours: row.labHours,
          units: row.units,
          prerequisites: row.prereq,
          grade: row.grade,
        }, existing)) {
          duplicated++;
          continue;
        }

        if (applyUpdates) {
          await client.query(
            `UPDATE curriculums
                SET subject_name=$1, lecture_hours=$2, laboratory_hours=$3, units=$4,
                    prerequisites=$5, grade=$6,
                    subject_category=CASE WHEN subject_category_manual THEN subject_category ELSE $7 END, updated_at=NOW()
              WHERE id=$8 AND is_active=true`,
            [row.subjectName, row.lecHours, row.labHours, row.units, row.prereq, row.grade, row.category, existing.id],
          );
          updated++;
        } else {
          duplicated++;
        }
      }

      if (removeIds.length > 0) {
        // Soft delete, same as deleting a subject on the Curriculum page
        const removeRes = await client.query(
          `UPDATE curriculums SET is_active = false, updated_at = NOW()
            WHERE id = ANY($1::int[]) AND program_id = ANY($2::int[])
              AND curriculum_version = $3 AND is_active = true`,
          [removeIds, programIds, version],
        );
        removed = removeRes.rowCount ?? 0;
      }

      return { imported, reactivated, updated, duplicated, removed };
    });

    const total = result.imported + result.reactivated + result.updated + result.removed;
    return NextResponse.json({ ...result, total, errors });
  } catch (error) {
    console.error('[curriculum/import] Fatal error:', error);
    return NextResponse.json({ error: 'Import failed due to a server error.' }, { status: 500 });
  }
}

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const POST = withAudit(POST_handler);

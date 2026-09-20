import { normalizeSemester, normalizeYearLevel } from '../normalizeCurriculum';
import type {
  ComparedImportRow,
  ExistingCurriculumRow,
  FieldChange,
  ParsedSubjectRow,
} from './types';

export function normalizeCourseCode(value: string): string {
  return value.toUpperCase().replace(/[\s\-_.]/g, '');
}

export function normalizeComparableText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[-_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function identityKey(programId: number, year: string, sem: string, code: string): string {
  return `${programId}|${normalizeYearLevel(year)}|${normalizeSemester(sem)}|${code.toUpperCase().trim()}`;
}

function looseCodeKey(programId: number, year: string, sem: string, code: string): string {
  return `${programId}|${normalizeYearLevel(year)}|${normalizeSemester(sem)}|${normalizeCourseCode(code)}`;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function diffFields(row: ParsedSubjectRow, existing: ExistingCurriculumRow): FieldChange[] {
  const changes: FieldChange[] = [];
  if (normalizeComparableText(row.subjectName) !== normalizeComparableText(existing.subject_name)) {
    changes.push({ field: 'Descriptive Title', from: existing.subject_name, to: row.subjectName });
  }
  if (num(row.lectureHours) !== num(existing.lecture_hours)) {
    changes.push({ field: 'Lecture Hours', from: String(existing.lecture_hours), to: String(row.lectureHours) });
  }
  if (num(row.laboratoryHours) !== num(existing.laboratory_hours)) {
    changes.push({ field: 'Lab Hours', from: String(existing.laboratory_hours), to: String(row.laboratoryHours) });
  }
  if (num(row.creditUnits) !== num(existing.units)) {
    changes.push({ field: 'Credit Units', from: String(existing.units), to: String(row.creditUnits) });
  }
  if (normalizeComparableText(row.prerequisites) !== normalizeComparableText(existing.prerequisites ?? '')) {
    changes.push({ field: 'Prerequisites', from: existing.prerequisites || '—', to: row.prerequisites || '—' });
  }
  if ((row.grade || '') !== (existing.grade || '')) {
    changes.push({ field: 'Grade', from: existing.grade || '—', to: row.grade || '—' });
  }
  return changes;
}

export function compareImportRows(
  rows: ParsedSubjectRow[],
  existing: ExistingCurriculumRow[],
  programId: number,
): ComparedImportRow[] {
  const byIdentity = new Map<string, ExistingCurriculumRow>();
  const byLoose = new Map<string, ExistingCurriculumRow[]>();
  for (const item of existing) {
    const key = identityKey(item.program_id, item.year_level, item.semester, item.subject_code);
    byIdentity.set(key, item);
    const loose = looseCodeKey(item.program_id, item.year_level, item.semester, item.subject_code);
    const list = byLoose.get(loose) ?? [];
    list.push(item);
    byLoose.set(loose, list);
  }

  const seenInFile = new Map<string, number>();
  return rows.map(row => {
    const errors = [...row.errors];
    const fileKey = `${row.yearLevel}|${row.semester}|${row.subjectCode}`;
    let status: ComparedImportRow['status'] = errors.length ? 'invalid' : 'new';
    let isDuplicate = false;
    let changes: FieldChange[] = [];

    if (row.yearLevel && row.semester && row.subjectCode) {
      if (seenInFile.has(fileKey)) {
        errors.push(`Duplicate in this file — same as row ${seenInFile.get(fileKey)}`);
        isDuplicate = true;
        status = 'duplicate';
      } else {
        seenInFile.set(fileKey, row.rowNum);
      }
    }

    if (!isDuplicate) {
      const match = byIdentity.get(identityKey(programId, row.yearLevel, row.semester, row.subjectCode));
      if (match) {
        changes = diffFields(row, match);
        status = changes.length === 0 ? 'existing' : 'changed';
      } else {
        const looseMatches = byLoose.get(looseCodeKey(programId, row.yearLevel, row.semester, row.subjectCode)) ?? [];
        if (looseMatches.length === 1 && normalizeCourseCode(looseMatches[0].subject_code) === normalizeCourseCode(row.subjectCode)
          && looseMatches[0].subject_code.toUpperCase().trim() !== row.subjectCode) {
          status = 'possible';
          errors.push(`Possible match for existing code "${looseMatches[0].subject_code}" — confirm before importing`);
          changes = diffFields(row, looseMatches[0]);
        }
      }
    }

    if (errors.length && status === 'new') status = 'invalid';

    const valid = (status === 'new' || status === 'changed') && errors.filter(e => !e.startsWith('Possible match')).length === 0
      && !isDuplicate;

    return {
      ...row,
      errors,
      status,
      valid,
      isDuplicate,
      changes,
    };
  });
}

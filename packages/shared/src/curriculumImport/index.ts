export { parseCurriculumWorkbook, applyMerges, cellStr, parseNum } from './parseWorkbook';
export { compareImportRows, findSubjectsNotInFile, normalizeCourseCode, normalizeComparableText } from './compareExisting';
export { matchHeader, normalizeHeader, scoreHeaderCells, looksLikeTableHeaderRow } from './columnMap';
export { detectYearSemester, isSectionHeadingRow, looksLikeCourseCode } from './yearSemester';
export { detectProgramFromCourseCodes } from './programDetect';
export type { ProgramDetection, ProgramDetectionConfidence, ProgramRecord } from './programDetect';
export type {
  ColumnMapping,
  ComparedImportRow,
  ExistingCurriculumRow,
  ImportDiagnostic,
  ImportRowStatus,
  ParseWorkbookResult,
  ParsedSubjectRow,
  SheetInput,
  WorkbookInput,
} from './types';

export const CURRICULUM_FIELDS = [
  'courseCode',
  'descriptiveTitle',
  'lectureHours',
  'labHours',
  'creditUnits',
  'prerequisites',
  'grade',
  'yearLevel',
  'semester',
  'yearSemester',
] as const;

export type CurriculumField = (typeof CURRICULUM_FIELDS)[number];

export type MatchStrength = 'exact' | 'alias' | 'possible';

export interface ColumnMapping {
  field: CurriculumField;
  excelHeader: string;
  columnIndex: number;
  confidence: number;
  strength: MatchStrength;
  label: string;
}

export interface SheetMerge {
  s: { r: number; c: number };
  e: { r: number; c: number };
}

export interface SheetInput {
  name: string;
  rows: unknown[][];
  merges?: SheetMerge[];
}

export interface WorkbookInput {
  fileName: string;
  sheets: SheetInput[];
}

export interface ParsedSubjectRow {
  rowNum: number;
  sheetName: string;
  yearLevel: string;
  semester: string;
  subjectCode: string;
  subjectName: string;
  lectureHours: number;
  laboratoryHours: number;
  creditUnits: number;
  prerequisites: string;
  grade: string;
  errors: string[];
}

export interface ImportDiagnostic {
  fileName: string;
  sheetsDetected: number;
  sheetNames: string[];
  selectedSheets: string[];
  ignoredSheets: string[];
  headerRow: number | null;
  headerSheet: string | null;
  mappedColumns: Array<{ field: string; header: string; confidence: number; strength: MatchStrength }>;
  missingRequired: string[];
  rowsInspected: number;
  potentialSubjectRows: number;
  reason: string;
  suggestedAction: string;
}

export interface ParseWorkbookResult {
  rows: ParsedSubjectRow[];
  mappings: ColumnMapping[];
  diagnostic: ImportDiagnostic;
  lowConfidenceMappings: ColumnMapping[];
}

export type ImportRowStatus =
  | 'new'
  | 'existing'
  | 'changed'
  | 'duplicate'
  | 'invalid'
  | 'possible';

export interface ExistingCurriculumRow {
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
}

export interface FieldChange {
  field: string;
  from: string;
  to: string;
}

export interface ComparedImportRow extends ParsedSubjectRow {
  status: ImportRowStatus;
  valid: boolean;
  isDuplicate: boolean;
  changes: FieldChange[];
}

export const FIELD_LABELS: Record<CurriculumField, string> = {
  courseCode: 'Course Code',
  descriptiveTitle: 'Descriptive Title',
  lectureHours: 'Lecture Hours',
  labHours: 'Laboratory Hours',
  creditUnits: 'Credit Units',
  prerequisites: 'Prerequisites',
  grade: 'Grade',
  yearLevel: 'Year Level',
  semester: 'Semester',
  yearSemester: 'Year / Semester',
};

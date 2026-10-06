import type { WeekDay } from '@shared/dayCombination';
import type { PersonName, WorkloadRow } from '@shared/workloadImport';

/*
 * Excel workload import — shared shapes.
 *
 * ImportCatalog is a read-only snapshot of the QRganize records the import
 * matches against; ImportPlan is what plan.ts decides from the workbook and
 * that snapshot; apply.ts carries the plan out in one transaction and fills
 * an ImportReport.
 */

export type LoadCategory = 'Regular' | 'Overload' | 'Praise';
export type SessionType = 'lec' | 'lab';

export interface ImportTerm {
  academicYear: string;
  semester: string;
}

export interface CatalogProgram { id: number; code: string }

export interface CatalogSubject {
  id: number;
  programId: number;
  yearLevel: string;
  semester: string;
  version: string;
  code: string;
  name: string;
  lecHours: number;
  labHours: number;
  totalHours: number;
  /** Major subject with a Lecture and a Laboratory — both parts share one laboratory room */
  oneRoom: boolean;
}

export interface CatalogFaculty {
  id: number;
  name: string;
  firstName: string;
  middleName: string;
  lastName: string;
  position: string | null;
  employmentStatus: string;
  isActive: boolean;
  programId: number | null;
  accountUsername: string | null;
  qualification: string | null;
  major: string | null;
  eligibility: string | null;
  yearsInService: number | null;
}

export interface CatalogRoom { id: number; name: string; type: string; status: string }

export interface CatalogBlock {
  id: number;
  programId: number;
  yearLevel: string;
  semester: string;
  academicYear: string;
  blockName: string;
  version: string;
}

export interface ImportCatalog {
  programs: CatalogProgram[];
  subjects: CatalogSubject[];
  faculty: CatalogFaculty[];
  rooms: CatalogRoom[];
  blocks: CatalogBlock[];
  /** Configured day combinations of the import term ("Mon/Thu", …); empty = no restriction */
  dayCombinations: WeekDay[][];
}

/** Where a value came from in the workbook */
export interface SourceRef { sheet: string; row: number }

export type IssueLevel = 'review' | 'skipped' | 'info';

export interface PlanIssue {
  level: IssueLevel;
  /** Short topic used to group the report ("Faculty", "Subject", "Category", …) */
  topic: string;
  faculty?: string;
  source?: SourceRef;
  message: string;
}

/** A room the class uses — an existing QRganize room or one created from the workbook */
export interface RoomRef {
  excelText: string;
  /** Existing rooms.id */
  roomId?: number;
  /** Key into ImportPlan.newRooms */
  newRoomKey?: string;
}

export interface PlannedSession {
  day: WeekDay;
  start: number;
  end: number;
  type: SessionType;
  room: RoomRef | null;
}

/** One way to schedule a component, taken from the workbook */
export interface SessionCandidate {
  sessions: PlannedSession[];
  sources: SourceRef[];
  /** 'as-written' — times exactly as on the form; 'adjusted' — duration set to QRganize's hours */
  fit: 'as-written' | 'adjusted';
  notes: string[];
}

export interface PlannedComponent {
  type: SessionType;
  /** Curriculum hours per week — QRganize's authority */
  hours: number;
  /** Workbook options in the order they are tried */
  candidates: SessionCandidate[];
  /** Why no candidate could be built (component left for manual scheduling) */
  unscheduledReason?: string;
}

/** How the class's workload is stored (same shapes the Faculty Workload moves create) */
export interface CategoryPlan {
  /** instructor_loads.load_category */
  loadCategory: LoadCategory;
  /** instructor_loads.units (Permanent) or .hours (Contractual) */
  loadValue: number;
  overloadComponent: 'full' | SessionType;
  /** overloads row, when part or all of the subject is Overload or split Praise */
  overloadRow: { value: number; isPraise: boolean; reason: string; lecPart?: number | null } | null;
  /** Excel portions behind the decision, for the report */
  portions: { category: LoadCategory; value: number; component: SessionType | 'whole' }[];
  /** Short label for the report: "Regular", "Regular 2.00 + Overload 2.25 (Lab)", … */
  label: string;
}

export interface PlannedClass {
  /** Stable id used in the report: "<faculty key>|<subject id>|<block key>" */
  id: string;
  facultyKey: string;
  facultyLabel: string;
  subject: CatalogSubject;
  programCode: string;
  year: number;
  block: string;
  blockKey: string;
  isPermanent: boolean;
  category: CategoryPlan;
  components: PlannedComponent[];
  /** Placement order — lower first */
  priority: number;
  sources: SourceRef[];
  /** Excel figures for the Excel-vs-QRganize comparison */
  excel: {
    units: number;
    hours: number;
    students: number | null;
    /** As the load forms total it — units (Permanent) or hours (Contractual) */
    byCategory: Record<LoadCategory, number>;
  };
}

export interface PlannedFaculty {
  key: string;
  label: string;
  excelName: string;
  name: PersonName;
  classification: 'Permanent' | 'Contractual';
  sheets: string[];
  /** Existing QRganize faculty, or null when it is created */
  existing: CatalogFaculty | null;
  /** New faculty record (only when existing is null) */
  create: null | {
    firstName: string;
    middleName: string;
    lastName: string;
    fullName: string;
    programCode: string | null;
    usernameBase: string;
  };
  needsAccount: boolean;
  /** Profile fields that are empty in QRganize and present on the form */
  profileFill: Partial<{ qualification: string; major: string; eligibility: string; yearsInService: number }>;
  deductions: { type: string; description: string; units: number; source: SourceRef }[];
}

export interface PlannedActivity {
  facultyKey: string;
  day: WeekDay;
  start: number;
  end: number;
  activity: string;
  source: SourceRef;
}

/** A real workbook class that is not imported but still occupies a block / room / faculty */
export interface ExternalOccupancy {
  label: string;
  facultyKey?: string;
  blockKey?: string;
  roomKey?: string;
  day: WeekDay;
  start: number;
  end: number;
  source: SourceRef;
}

export interface PlannedBlock {
  key: string;
  programId: number;
  programCode: string;
  year: number;
  yearLevel: string;
  blockName: string;
  version: string;
  students: number;
  existingId?: number;
}

export interface PlannedRoom {
  key: string;
  name: string;
  type: 'Lecture' | 'Laboratory';
  reason: string;
  spellings: string[];
}

export interface ImportPlan {
  term: ImportTerm;
  faculty: PlannedFaculty[];
  classes: PlannedClass[];
  blocks: PlannedBlock[];
  newRooms: PlannedRoom[];
  roomMatches: { excelText: string; roomId: number; roomName: string }[];
  activities: PlannedActivity[];
  external: ExternalOccupancy[];
  /** Day sets seen on the forms (for moving a class when its own days are full) */
  observedDaySets: WeekDay[][];
  issues: PlanIssue[];
  /** Workbook overview for the report */
  workbook: {
    sheetsRead: number;
    hiddenSkipped: number;
    nonFacultySheets: string[];
    persons: { name: string; status: string; scope: string; sheets: string[] }[];
    classRows: number;
    activityRows: number;
  };
}

export type { WeekDay, WorkloadRow };

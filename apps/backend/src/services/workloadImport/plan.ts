import type { WeekDay } from '@shared/dayCombination';
import { subjectTitleSimilarity } from '@shared/subjectCode';
import {
  classifySheet, classifyStatus, codeKey, editDistance, nameWord, parseCourse, parsePersonName,
  roomKey, samePerson, titleCaseName, yearLevelLabel,
  type PersonName, type SheetKind, type WorkloadRow, type WorkloadSheet,
} from '@shared/workloadImport';
import {
  candidatesFromDraft, describeSessions, draftsFromSheet, fmtHours, resolveRowComponent, sameSessions,
  type RowComponent, type TimedRow,
} from './components';
import type {
  CatalogFaculty, CatalogSubject, CategoryPlan, ExternalOccupancy, ImportCatalog, ImportPlan, ImportTerm,
  LoadCategory, PlanIssue, PlannedActivity, PlannedBlock, PlannedClass, PlannedComponent, PlannedFaculty,
  PlannedRoom, RoomRef, SessionCandidate, SessionType, SourceRef,
} from './types';

/*
 * Excel workload import — the plan.
 *
 * Reads the parsed forms against a snapshot of QRganize and decides, without
 * touching the database, what the import will do:
 *
 *  • Faculty — only Permanent and Contractual, taken from each form's Status
 *    line (never the title under the signature). A blank or rank-only status
 *    ("Instructor I") falls back to the existing QRganize record. Existing
 *    faculty are matched by first + last name (harmless spelling slips are
 *    accepted and reported); unmatched in-scope faculty are created.
 *  • Forms per faculty — the "actual" sheet is the consolidated timetable;
 *    the Regular / Overload / Praise forms say which load category each part
 *    of a subject is in. Times are taken from the actual sheet first, then the
 *    category forms.
 *  • Classes — course → program/year/block, subject code → the curriculum of
 *    that program, year and semester; the curriculum is the authority for
 *    hours and units.
 *  • Anything that can't be decided safely is left out and reported, and its
 *    time still counts as occupied when a conflicting class has to be moved.
 */

type Role = 'actual' | 'regular' | 'overload' | 'praise' | 'combined';
const ROLE_CATEGORY: Partial<Record<Role, LoadCategory>> = { regular: 'Regular', overload: 'Overload', praise: 'Praise' };

interface PersonSheet { sheet: WorkloadSheet; kind: SheetKind; role: Role | null }
interface Person {
  key: string;
  name: PersonName;
  excelName: string;
  label: string;
  sheets: PersonSheet[];
  statuses: string[];
}

interface ResolvedRow {
  person: Person;
  role: Role;
  row: WorkloadRow;
  subject: CatalogSubject;
  programCode: string;
  year: number;
  block: string;
  blockKey: string;
  comp: RowComponent;
  compNote?: string;
}

const personKeyOf = (p: Pick<PersonName, 'first' | 'last'>) => `${nameWord(p.first)}|${nameWord(p.last)}`;
const fullName = (p: PersonName) => [p.first, p.middle, p.last].filter(Boolean).join(' ');
const round2 = (n: number) => Math.round(n * 100) / 100;
const fmtNum = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
const blockKeyOf = (programCode: string, year: number, block: string) => `${programCode.toUpperCase()}|${year}|${block.toUpperCase()}`;
const srcOf = (row: WorkloadRow): SourceRef => ({ sheet: row.sheet, row: row.row });
const componentLabel = (t: SessionType | 'whole') => (t === 'lec' ? 'Lec' : t === 'lab' ? 'Lab' : 'whole subject');

function facultyNameParts(f: CatalogFaculty): Pick<PersonName, 'first' | 'last'> {
  if (f.firstName?.trim() && f.lastName?.trim()) return { first: f.firstName, last: f.lastName };
  const parsed = parsePersonName(f.name);
  return parsed ?? { first: '', last: '' };
}

/** "5 years", "1 Year" → 5, 1 */
function parseYears(text: string): number | null {
  const m = text.match(/\d+/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isInteger(n) && n >= 0 && n <= 100 ? n : null;
}

const mode = (values: number[]): number | null => {
  if (!values.length) return null;
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
};

export function buildImportPlan(allSheets: WorkloadSheet[], catalog: ImportCatalog, term: ImportTerm): ImportPlan {
  const issues: PlanIssue[] = [];
  const issueKeys = new Set<string>();
  const issue = (i: PlanIssue, dedupeKey?: string) => {
    const k = dedupeKey ?? `${i.level}|${i.topic}|${i.faculty ?? ''}|${i.message}`;
    if (issueKeys.has(k)) return;
    issueKeys.add(k);
    issues.push(i);
  };

  const sheets = allSheets.filter(s => !s.hidden);
  const hiddenSkipped = allSheets.length - sheets.length;

  // ── Persons ───────────────────────────────────────────────────────────────
  const persons: Person[] = [];
  const nonFacultySheets: string[] = [];
  for (const sheet of sheets) {
    const name = parsePersonName(sheet.facultyName);
    if (!name) {
      nonFacultySheets.push(sheet.name);
      if (sheet.rows.some(r => r.kind === 'class')) {
        issue({ level: 'info', topic: 'Workbook', source: { sheet: sheet.name, row: sheet.rows[0].row },
          message: `Sheet "${sheet.name}" names no faculty member ("${sheet.facultyName || 'blank'}") — its ${sheet.rows.filter(r => r.kind === 'class').length} class row(s) were not imported.` });
      }
      continue;
    }
    const key = personKeyOf(name);
    let person = persons.find(p => p.key === key);
    if (!person) {
      person = { key, name, excelName: sheet.facultyName, label: titleCaseName(fullName(name)), sheets: [], statuses: [] };
      persons.push(person);
    }
    if (!person.name.middle && name.middle) { person.name = name; person.excelName = sheet.facultyName; person.label = titleCaseName(fullName(name)); }
    person.sheets.push({ sheet, kind: classifySheet(sheet.name, sheet.category), role: null });
    if (sheet.status && !person.statuses.includes(sheet.status)) person.statuses.push(sheet.status);
  }

  // ── Classification, matching, scope ───────────────────────────────────────
  const plannedFaculty: PlannedFaculty[] = [];
  const workbookPersons: ImportPlan['workbook']['persons'] = [];
  const outOfScope = new Set<string>();
  const inScope = new Map<string, { person: Person; planned: PlannedFaculty }>();

  for (const person of persons) {
    const sheetNames = person.sheets.map(s => s.sheet.name);
    const excelClasses = [...new Set(person.statuses.map(classifyStatus).filter(Boolean))] as string[];
    const loadable = excelClasses.filter(c => c === 'Permanent' || c === 'Contractual') as ('Permanent' | 'Contractual')[];

    const scored = catalog.faculty
      .map(f => ({ f, m: samePerson(facultyNameParts(f), person.name) }))
      .filter((x): x is { f: CatalogFaculty; m: 'exact' | 'spelling' } => !!x.m);
    const active = scored.filter(x => x.f.isActive);
    const exactActive = active.filter(x => x.m === 'exact');
    const candidates = exactActive.length ? exactActive : active;

    let existing: CatalogFaculty | null = null;
    let matchNote = '';
    if (candidates.length === 1) {
      existing = candidates[0].f;
      if (candidates[0].m === 'spelling') matchNote = `QRganize spells the name "${existing.name}"`;
      const qm = existing.middleName?.trim();
      if (person.name.middle && qm && nameWord(qm)[0] !== nameWord(person.name.middle)[0]) {
        matchNote = [matchNote, `middle name differs (form "${person.name.middle}", QRganize "${qm}")`].filter(Boolean).join('; ');
      }
    } else if (candidates.length > 1) {
      issue({ level: 'skipped', topic: 'Faculty', faculty: person.label,
        message: `${person.label} matches ${candidates.length} active QRganize faculty (${candidates.map(c => `#${c.f.id} ${c.f.name}`).join(', ')}) — not imported; merge or deactivate the duplicate first.` });
      workbookPersons.push({ name: person.label, status: person.statuses.join(' / '), scope: 'skipped — ambiguous match', sheets: sheetNames });
      outOfScope.add(person.key);
      continue;
    }

    let classification: 'Permanent' | 'Contractual' | null = null;
    let scopeReason = '';
    if (loadable.length === 1) {
      classification = loadable[0];
      scopeReason = `Status "${person.statuses.filter(s => classifyStatus(s) === loadable[0]).join(' / ')}"`;
      const other = person.statuses.filter(s => classifyStatus(s) !== loadable[0]);
      if (other.length) {
        issue({ level: 'info', topic: 'Faculty', faculty: person.label,
          message: `${person.label}: forms disagree on Status (${person.statuses.map(s => `"${s}"`).join(', ')}) — read as ${loadable[0]}.` });
      }
    } else if (loadable.length > 1) {
      if (existing) {
        classification = existing.employmentStatus === 'Contractual' ? 'Contractual' : 'Permanent';
        scopeReason = `forms say both Permanent and Contractual; QRganize record says ${classification}`;
        issue({ level: 'review', topic: 'Faculty', faculty: person.label, message: `${person.label}: forms say both Permanent and Contractual — QRganize's record (${existing.position ?? 'no rank'}) was used.` });
      }
    } else if (excelClasses.includes('Part-time')) {
      if (existing && ['Permanent', 'Contractual'].includes(existing.employmentStatus)) {
        issue({ level: 'review', topic: 'Faculty', faculty: person.label,
          message: `${person.label}: form Status is "${person.statuses.join(' / ')}" but QRganize has them as ${existing.employmentStatus} — not imported; check which is right.` });
      }
    } else if (existing) {
      classification = existing.employmentStatus === 'Contractual' ? 'Contractual' : 'Permanent';
      scopeReason = `form Status "${person.statuses.join(' / ') || 'blank'}" is not a classification; QRganize record (${existing.position ?? 'no rank'}) is ${classification}`;
    }

    if (!classification) {
      outOfScope.add(person.key);
      const status = person.statuses.join(' / ') || 'blank';
      workbookPersons.push({ name: person.label, status, scope: 'outside Permanent/Contractual — not imported', sheets: sheetNames });
      if (!/part/i.test(status)) {
        issue({ level: 'review', topic: 'Faculty', faculty: person.label,
          message: `${person.label}: form Status "${status}" is not Permanent or Contractual and there is no QRganize record — not imported.` });
      }
      continue;
    }
    if (existing && (existing.employmentStatus === 'Contractual') !== (classification === 'Contractual')) {
      issue({ level: 'review', topic: 'Faculty', faculty: person.label,
        message: `${person.label}: forms say ${classification}, QRganize record is ${existing.employmentStatus} (${existing.position ?? 'no rank'}) — QRganize's record was kept and its unit rules used.` });
      classification = existing.employmentStatus === 'Contractual' ? 'Contractual' : 'Permanent';
    }
    if (!existing) {
      const inactive = scored.filter(x => !x.f.isActive);
      if (inactive.length) {
        issue({ level: 'skipped', topic: 'Faculty', faculty: person.label,
          message: `${person.label} only matches inactive QRganize record(s) (${inactive.map(x => `#${x.f.id} ${x.f.name}`).join(', ')}) — not reactivated or duplicated; reactivate the right record and run the import again.` });
        workbookPersons.push({ name: person.label, status: person.statuses.join(' / '), scope: 'skipped — inactive QRganize record', sheets: sheetNames });
        outOfScope.add(person.key);
        continue;
      }
    }
    if (matchNote) issue({ level: 'info', topic: 'Faculty', faculty: person.label, message: `${person.label} matched to QRganize #${existing!.id}: ${matchNote} (QRganize record not renamed).` });

    const planned: PlannedFaculty = {
      key: person.key,
      label: existing ? existing.name : person.label,
      excelName: person.excelName,
      name: person.name,
      classification,
      sheets: sheetNames,
      existing,
      create: existing ? null : {
        firstName: titleCaseName(person.name.first),
        middleName: person.name.middle ? person.name.middle.toUpperCase() : '',
        lastName: titleCaseName(person.name.last),
        fullName: titleCaseName(fullName(person.name)),
        programCode: null,
        usernameBase: nameWord(person.name.first).split(' ')[0].toLowerCase(),
      },
      needsAccount: !existing || !existing.accountUsername,
      profileFill: {},
      deductions: [],
    };
    plannedFaculty.push(planned);
    inScope.set(person.key, { person, planned });
    workbookPersons.push({ name: person.label, status: person.statuses.join(' / ') || 'blank', scope: `${classification} — ${scopeReason}`, sheets: sheetNames });
  }

  // ── Sheet roles ───────────────────────────────────────────────────────────
  const rowSig = (r: WorkloadRow) => `${codeKey(r.code)}|${codeKey(r.course)}`;
  for (const person of persons) {
    const byKind = (k: SheetKind) => person.sheets.filter(s => s.kind === k);
    const categorySigs = new Set([...byKind('overload'), ...byKind('praise')].flatMap(s => s.sheet.rows.filter(r => r.kind === 'class').map(rowSig)));
    const regulars = byKind('regular');
    const combined = regulars.length > 1
      ? regulars.filter(s => s.sheet.rows.some(r => r.kind === 'class' && categorySigs.has(rowSig(r))))
      : [];
    for (const s of person.sheets) {
      if (s.kind === 'actual') s.role = 'actual';
      else if (s.kind === 'regular') s.role = combined.includes(s) && combined.length < regulars.length ? 'combined' : 'regular';
      else if (s.kind === 'overload' || s.kind === 'praise') s.role = s.kind;
      else s.role = null;
    }
    const roleless = person.sheets.filter(s => !s.role && s.sheet.rows.length);
    if (roleless.length && inScope.has(person.key)) {
      issue({ level: 'review', topic: 'Workbook', faculty: person.label,
        message: `${person.label}: sheet(s) ${roleless.map(s => `"${s.sheet.name}"`).join(', ')} have no recognisable load category ("${roleless.map(s => s.sheet.category).join('", "')}") — not used.` });
    }
    const combinedSheets = person.sheets.filter(s => s.role === 'combined');
    if (combinedSheets.length && inScope.has(person.key)) {
      issue({ level: 'info', topic: 'Workbook', faculty: person.label,
        message: `${person.label}: sheet ${combinedSheets.map(s => `"${s.sheet.name}"`).join(', ')} lists every class (labelled "${combinedSheets[0].sheet.category}") — categories and times were taken from the Regular / Overload / Praise forms, this sheet only where they give no time.` });
    }
  }

  // ── Day groups most forms don't use (taken as written, but worth a look) ──
  const primarySheets = (p: Person) => {
    const actual = p.sheets.filter(s => s.role === 'actual');
    return actual.length ? actual : p.sheets.filter(s => s.role === 'regular');
  };
  const groupUsers = new Map<string, Set<string>>();
  for (const p of persons.filter(p => inScope.has(p.key))) {
    for (const s of primarySheets(p)) {
      for (const r of s.sheet.rows.filter(r => r.kind === 'class' && r.days.length)) {
        const k = r.days.map(d => d.slice(0, 3)).join('/');
        groupUsers.set(k, (groupUsers.get(k) ?? new Set()).add(p.key));
      }
    }
  }
  const scopedCount = inScope.size || 1;
  for (const p of persons.filter(p => inScope.has(p.key))) {
    const rare = [...new Set(primarySheets(p).flatMap(s => s.sheet.rows.filter(r => r.kind === 'class' && r.days.length)
      .map(r => r.days.map(d => d.slice(0, 3)).join('/'))))].filter(k => (groupUsers.get(k)?.size ?? 0) / scopedCount < 0.2);
    if (rare.length) {
      const common = [...groupUsers.entries()].filter(([, u]) => u.size / scopedCount >= 0.5).map(([k]) => k);
      issue({ level: 'review', topic: 'Days', faculty: inScope.get(p.key)!.planned.label,
        message: `${inScope.get(p.key)!.planned.label}'s timetable uses ${rare.join(', ')} (most forms use ${common.join(', ')}) — taken as written; if the heading is left from an older template, correct the days on Scheduling.` });
    }
  }

  // ── Rows → subject, block, component ──────────────────────────────────────
  const programByCode = new Map(catalog.programs.map(p => [p.code.toUpperCase(), p]));
  const versionFor = (programId: number, yearLevel: string): string | null => {
    const established = catalog.blocks.find(b => b.programId === programId && b.yearLevel === yearLevel
      && b.semester === term.semester && b.academicYear === term.academicYear);
    if (established) return established.version;
    const versions = [...new Set(catalog.subjects.filter(s => s.programId === programId && s.yearLevel === yearLevel && s.semester === term.semester).map(s => s.version))];
    return versions.length === 1 ? versions[0] : null;
  };
  const stripMarker = (d: string) => d.replace(/\(\s*(lec|lecture|lab|laboratory|leb)\s*\)/gi, ' ').trim();

  function matchSubject(row: WorkloadRow, programId: number, programCode: string, yearLevel: string, version: string): { subject?: CatalogSubject; note?: string; problem?: string } {
    const list = catalog.subjects.filter(s => s.programId === programId && s.yearLevel === yearLevel && s.semester === term.semester && s.version === version);
    const key = codeKey(row.code);
    const exact = list.filter(s => codeKey(s.code) === key);
    if (exact.length === 1) return { subject: exact[0] };
    if (exact.length > 1) return { problem: `code "${row.code}" matches ${exact.length} ${programCode} ${yearLevel} subjects` };
    const digits = key.replace(/\D/g, '');
    const nearCode = key ? list.filter(s => { const k = codeKey(s.code); return k.replace(/\D/g, '') === digits && digits !== '' && editDistance(k, key) <= 1; }) : [];
    if (nearCode.length === 1) return { subject: nearCode[0], note: `code "${row.code}" read as ${nearCode[0].code} (${nearCode[0].name})` };
    const byTitle = list
      .map(s => ({ s, score: subjectTitleSimilarity(s.name, stripMarker(row.description)) }))
      .filter(x => x.score >= 0.75)
      .sort((a, b) => b.score - a.score);
    if (byTitle.length === 1 || (byTitle.length > 1 && byTitle[0].score - byTitle[1].score > 0.15)) {
      return { subject: byTitle[0].s, note: `code "${row.code}" is not in the curriculum; matched by title "${stripMarker(row.description)}" → ${byTitle[0].s.code} ${byTitle[0].s.name}` };
    }
    return { problem: `"${row.code} ${stripMarker(row.description)}" is not in the ${programCode} ${yearLevel} ${term.semester} curriculum` };
  }

  const resolved: ResolvedRow[] = [];
  const external: ExternalOccupancy[] = [];
  const addExternal = (row: WorkloadRow, label: string, facultyKey?: string) => {
    if (!row.time || !row.days.length) return;
    const c = parseCourse(row.course);
    const blockKey = c.program && c.year && c.block ? blockKeyOf(c.program, c.year, c.block) : undefined;
    const rk = row.room ? roomKey(row.room).key : undefined;
    for (const day of row.days) external.push({ label, facultyKey, blockKey, roomKey: rk, day, start: row.time.start, end: row.time.end, source: srcOf(row) });
  };

  let classRows = 0, activityRows = 0;
  const allClassRows: { person: Person; row: WorkloadRow }[] = [];
  for (const person of persons) {
    for (const ps of person.sheets) {
      for (const row of ps.sheet.rows) {
        if (row.kind === 'class') { classRows++; allClassRows.push({ person, row }); } else activityRows++;
      }
    }
  }

  for (const person of persons) {
    const scoped = inScope.get(person.key);
    for (const ps of person.sheets) {
      for (const row of ps.sheet.rows) {
        if (row.kind !== 'class') continue;
        const what = `${row.code || '(no code)'} ${row.course || '(no course)'}`;
        if (!scoped || !ps.role) {
          addExternal(row, `${person.label}: ${what}${scoped ? '' : ' (not imported)'}`, scoped ? person.key : undefined);
          continue;
        }
        const course = parseCourse(row.course);
        const at = srcOf(row);
        if (!course.program || !course.year || !course.block) {
          issue({ level: 'skipped', topic: 'Block', faculty: person.label, source: at,
            message: `${person.label}: ${row.code} ${stripMarker(row.description)} — course "${row.course}" names no ${!course.program ? 'program' : 'block letter'}; not imported (which block can't be determined).` },
            `course|${person.key}|${codeKey(row.code)}|${codeKey(row.course)}`);
          addExternal(row, `${person.label}: ${what} (block unknown)`, person.key);
          continue;
        }
        const program = programByCode.get(course.program);
        if (!program) {
          issue({ level: 'skipped', topic: 'Program', faculty: person.label, source: at, message: `Program ${course.program} (course "${row.course}") is not in QRganize — row not imported.` },
            `program|${course.program}`);
          addExternal(row, `${person.label}: ${what}`, person.key);
          continue;
        }
        const yearLevel = yearLevelLabel(course.year);
        const version = versionFor(program.id, yearLevel);
        if (!version) {
          issue({ level: 'skipped', topic: 'Curriculum', faculty: person.label, source: at,
            message: `${program.code} ${yearLevel} ${term.semester} has no single active curriculum version — ${what} not imported.` }, `version|${program.id}|${yearLevel}`);
          addExternal(row, `${person.label}: ${what}`, person.key);
          continue;
        }
        const m = matchSubject(row, program.id, program.code, yearLevel, version);
        if (!m.subject) {
          issue({ level: 'skipped', topic: 'Subject', faculty: person.label, source: at, message: `${person.label}: ${m.problem} — not imported.` },
            `subject|${person.key}|${codeKey(row.code)}|${program.code}${course.year}`);
          addExternal(row, `${person.label}: ${what}`, person.key);
          continue;
        }
        if (m.note) issue({ level: 'info', topic: 'Subject', faculty: person.label, source: at, message: `${person.label}: ${m.note}.` }, `subjnote|${codeKey(row.code)}|${m.subject.id}`);
        const comp = resolveRowComponent(row, m.subject.lecHours, m.subject.labHours);
        resolved.push({
          person, role: ps.role, row, subject: m.subject, programCode: program.code, year: course.year, block: course.block,
          blockKey: blockKeyOf(program.code, course.year, course.block), comp: comp.component, compNote: comp.note,
        });
      }
    }
  }

  // ── Rooms ─────────────────────────────────────────────────────────────────
  const catalogRoomByKey = new Map<string, (typeof catalog.rooms)[number]>();
  for (const r of catalog.rooms) {
    const k = roomKey(r.name).key;
    if (!catalogRoomByKey.has(k) || r.status === 'Active') catalogRoomByKey.set(k, r);
  }
  const newRooms = new Map<string, PlannedRoom & { uses: Set<SessionType> }>();
  const roomMatches = new Map<string, { excelText: string; roomId: number; roomName: string }>();
  const roomRef = (text: string, use: SessionType): RoomRef | null => {
    const t = text.trim();
    if (!t) return null;
    const rk = roomKey(t);
    const existing = catalogRoomByKey.get(rk.key);
    if (existing) {
      if (!roomMatches.has(t.toUpperCase())) roomMatches.set(t.toUpperCase(), { excelText: t, roomId: existing.id, roomName: existing.name });
      return { excelText: t, roomId: existing.id };
    }
    let planned = newRooms.get(rk.key);
    if (!planned) {
      const type: 'Lecture' | 'Laboratory' = rk.kind === 'lab' || /\blab\b|laborator/i.test(t) ? 'Laboratory' : 'Lecture';
      planned = { key: rk.key, name: t.replace(/\s+/g, ' '), type, reason: '', spellings: [], uses: new Set() };
      newRooms.set(rk.key, planned);
    }
    planned.spellings.push(t);
    planned.uses.add(use);
    return { excelText: t, newRoomKey: rk.key };
  };

  // ── Classes ───────────────────────────────────────────────────────────────
  const byClass = new Map<string, ResolvedRow[]>();
  for (const r of resolved) {
    const id = `${r.person.key}|${r.subject.id}|${r.blockKey}`;
    byClass.set(id, [...(byClass.get(id) ?? []), r]);
  }

  const classes: PlannedClass[] = [];
  const claimed = new Map<string, string>(); // subject|block → class id
  const categoryRoles: Role[] = ['regular', 'overload', 'praise'];

  for (const [id, rows] of byClass) {
    const { person, subject, programCode, year, block, blockKey } = rows[0];
    const { planned } = inScope.get(person.key)!;
    const isPermanent = planned.classification === 'Permanent';
    const lecH = subject.lecHours, labH = subject.labHours;
    const what = `${subject.code} ${programCode} ${year}${block}`;
    const hasCategoryForms = person.sheets.some(s => s.role && categoryRoles.includes(s.role));
    const skipAll = (level: PlanIssue['level'], message: string) => {
      issue({ level, topic: 'Category', faculty: planned.label, source: srcOf(rows[0].row), message });
      for (const r of rows.filter(r => r.role === 'actual' || r.role === 'combined' || !hasCategoryForms || categoryRoles.includes(r.role))) {
        addExternal(r.row, `${planned.label}: ${what} (not imported)`, person.key);
      }
    };

    for (const r of rows) {
      if (r.compNote) issue({ level: 'info', topic: 'Lec/Lab', faculty: planned.label, source: srcOf(r.row), message: `${planned.label}: ${what} row ${r.row.row} on "${r.row.sheet}" ${r.compNote} — read by its units.` },
        `compnote|${id}|${r.row.timeText}|${r.row.units}`);
    }

    // Category portions from the load forms
    const catRows = rows.filter(r => categoryRoles.includes(r.role));
    if (!catRows.length) {
      skipAll('review', `${planned.label}: ${what} is on "${rows[0].row.sheet}" but on none of the Regular / Overload / Praise forms — its load category is unknown, so it was not assigned.`);
      continue;
    }
    const cat = buildCategoryPlan(catRows, subject, isPermanent);
    if (!cat.plan) {
      skipAll('review', `${planned.label}: ${what} — ${cat.problem}; not assigned (set it on Faculty Workload).`);
      continue;
    }

    const subjectBlock = `${subject.id}|${blockKey}`;
    const prior = claimed.get(subjectBlock);
    if (prior) {
      skipAll('review', `${what} is on the forms of both ${classes.find(c => c.id === prior)?.facultyLabel} and ${planned.label}; QRganize assigns one faculty per class — kept the first, ${planned.label}'s copy not assigned.`);
      continue;
    }
    claimed.set(subjectBlock, id);

    // Timetable candidates: actual sheet first, then the category forms, then a combined sheet
    const order: Role[] = ['actual', 'regular', 'overload', 'praise', 'combined'];
    const components: PlannedComponent[] = [];
    const want: SessionType[] = [];
    if (lecH > 0) want.push('lec');
    if (labH > 0) want.push('lab');
    const found: Record<SessionType, { cand: SessionCandidate; role: Role; seq: number }[]> = { lec: [], lab: [] };
    const problems: Record<SessionType, string[]> = { lec: [], lab: [] };
    let seq = 0;
    const sheetsInOrder = person.sheets
      .filter(s => s.role)
      .sort((a, b) => order.indexOf(a.role!) - order.indexOf(b.role!));
    for (const ps of sheetsInOrder) {
      const sheetRows = rows.filter(r => r.row.sheet === ps.sheet.name);
      const timed: TimedRow[] = [];
      for (const r of sheetRows) {
        const k = r.comp.kind;
        if (k === 'lec' || k === 'lab' || k === 'both') {
          timed.push({ row: r.row, kind: k, room: roomRef(r.row.room, k === 'both' ? (lecH > 0 ? 'lec' : 'lab') : k) });
          if (k === 'both' && labH > 0 && r.row.room) roomRef(r.row.room, 'lab');
        }
      }
      if (!timed.length) continue;
      // The same component written more than once on one form, each copy a full
      // week's hours (e.g. "PATHFIT3 BSIT 2A" on Mon/Thu and again on Tue/Fri):
      // each copy is a separate option, never added together.
      const weekly = (x: TimedRow) => (x.row.time ? ((x.row.time.end - x.row.time.start) * x.row.days.length) / 60 : 0);
      const groupsToDraft: TimedRow[][] = [timed];
      for (const t of want) {
        const copies = timed.filter(x => x.kind === t);
        const need = t === 'lec' ? lecH : labH;
        if (copies.length > 1 && copies.every(x => Math.abs(weekly(x) - need) < 0.01)) {
          const rest = groupsToDraft[0].filter(x => !copies.includes(x));
          groupsToDraft.splice(0, 1, rest, ...copies.map(x => [x]));
          issue({ level: 'review', topic: 'Duplicate', faculty: planned.label, source: srcOf(copies[1].row),
            message: `${planned.label}: ${what} ${t === 'lec' ? 'Lecture' : 'Laboratory'} is written ${copies.length} times on "${ps.sheet.name}" (${copies.map(x => `row ${x.row.row} ${x.row.dayGroup} ${x.row.timeText}`).join('; ')}), each a full week's ${fmtHours(need)} — imported once (the first time that fits); check which is right.` });
        }
      }
      for (const group of groupsToDraft.filter(g => g.length)) {
        const drafts = draftsFromSheet(group, lecH, labH);
        for (const t of want) {
          const d = drafts[t];
          if (!d) continue;
          const c = candidatesFromDraft(d, t, t === 'lec' ? lecH : labH);
          if (c.asWritten) found[t].push({ cand: c.asWritten, role: ps.role!, seq: seq++ });
          if (c.adjusted) found[t].push({ cand: c.adjusted, role: ps.role!, seq: seq++ });
          if (c.problem) problems[t].push(`"${ps.sheet.name}": ${c.problem}`);
        }
        for (const p of drafts.problems) problems.lec.push(`"${ps.sheet.name}" ${p}`);
      }
    }
    for (const t of want) {
      const candidates = orderCandidates(found[t]);
      const hours = t === 'lec' ? lecH : labH;
      const comp: PlannedComponent = { type: t, hours, candidates };
      if (!candidates.length) {
        const unknown = rows.find(r => r.comp.kind === 'unknown');
        comp.unscheduledReason = unknown
          ? `the forms list ${subject.code} as one ${fmtNum(unknown.row.units ?? 0)}-unit, ${fmtNum(unknown.row.hours ?? 0)}-hour item without a Lec/Lab split, but QRganize's curriculum has ${fmtHours(lecH)} Lec + ${fmtHours(labH)} Lab — its time can't be placed without guessing`
          : problems[t].length ? problems[t].join('; ') : `no ${t === 'lec' ? 'Lecture' : 'Laboratory'} time is written on the forms`;
        for (const r of rows.filter(r => r.comp.kind === 'unknown' || r.role === 'actual')) addExternal(r.row, `${planned.label}: ${what} (its time is not scheduled in QRganize)`, person.key);
      }
      components.push(comp);
    }

    const mainCategory = cat.plan.portions.some(p => p.category === 'Regular') ? 0 : cat.plan.portions.some(p => p.category === 'Overload') ? 1 : 2;
    // Excel's own figures for the class: the actual sheet's rows, else the load forms' (a row
    // repeated on a duplicate copy of a form counts once)
    const hasActual = rows.some(r => r.role === 'actual');
    const primary = rows.filter(r => (hasActual ? r.role === 'actual' : categoryRoles.includes(r.role)));
    const figures = new Map<string, { units: number; hours: number }>();
    for (const r of primary) {
      figures.set(`${r.role}|${r.row.days.join('/')}|${r.row.timeText}|${codeKey(r.row.code)}|${r.row.units}|${r.row.hours}`,
        { units: r.row.units ?? 0, hours: r.row.hours ?? 0 });
    }
    const unitsSeen = [...figures.values()].map(f => f.units);
    const hoursSeen = [...figures.values()].reduce((s, f) => s + f.hours, 0);
    // Per category, as the Regular / Overload / Praise forms total them (units; hours for Contractual)
    const byCategory = { Regular: 0, Overload: 0, Praise: 0 };
    const counted = new Set<string>();
    for (const r of catRows) {
      const k = `${r.role}|${r.row.days.join('/')}|${r.row.timeText}|${codeKey(r.row.code)}|${r.row.units}|${r.row.hours}`;
      if (counted.has(k)) continue;
      counted.add(k);
      const cat = ROLE_CATEGORY[r.role]!;
      byCategory[cat] = round2(byCategory[cat] + ((isPermanent ? r.row.units : r.row.hours) ?? 0));
    }
    classes.push({
      id,
      facultyKey: person.key,
      facultyLabel: planned.label,
      subject,
      programCode,
      year,
      block,
      blockKey,
      isPermanent,
      category: cat.plan,
      components,
      priority: mainCategory,
      sources: rows.map(r => srcOf(r.row)),
      excel: {
        units: round2(unitsSeen.reduce((a, b) => a + b, 0)),
        hours: round2(hoursSeen),
        students: mode(rows.map(r => r.row.students).filter((n): n is number => n != null && n > 0)),
        byCategory,
      },
    });
  }

  // Placement order: Regular, Overload, Praise; Permanent faculty first; then by surname
  const surname = (key: string) => key.split('|')[1] ?? key;
  classes.sort((a, b) => a.priority - b.priority || Number(!a.isPermanent) - Number(!b.isPermanent)
    || surname(a.facultyKey).localeCompare(surname(b.facultyKey)) || a.facultyKey.localeCompare(b.facultyKey)
    || a.sources[0].sheet.localeCompare(b.sources[0].sheet) || a.sources[0].row - b.sources[0].row);

  // ── Blocks ────────────────────────────────────────────────────────────────
  const studentsByBlock = new Map<string, number[]>();
  const evidenced = new Set<string>();
  for (const { row } of allClassRows) {
    const c = parseCourse(row.course);
    if (!c.program || !c.year || !c.block) continue;
    const k = blockKeyOf(c.program, c.year, c.block);
    evidenced.add(k);
    if (row.students && row.students > 0) studentsByBlock.set(k, [...(studentsByBlock.get(k) ?? []), row.students]);
  }
  const blocks = new Map<string, PlannedBlock>();
  const mixedCounts: string[] = [];
  const planBlock = (programCode: string, year: number, letter: string) => {
    const key = blockKeyOf(programCode, year, letter);
    if (blocks.has(key)) return;
    const program = programByCode.get(programCode.toUpperCase())!;
    const yearLevel = yearLevelLabel(year);
    const version = versionFor(program.id, yearLevel)!;
    const existing = catalog.blocks.find(b => b.programId === program.id && b.yearLevel === yearLevel && b.semester === term.semester
      && b.academicYear === term.academicYear && b.blockName.toUpperCase() === letter && b.version === version);
    const counts = studentsByBlock.get(key) ?? [];
    blocks.set(key, { key, programId: program.id, programCode: program.code, year, yearLevel, blockName: letter, version, students: mode(counts) ?? 0, existingId: existing?.id });
    if (!existing && new Set(counts).size > 1) mixedCounts.push(`${program.code} ${year}${letter} (${[...new Set(counts)].join('/')} → ${mode(counts)})`);
  };
  for (const c of classes) planBlock(c.programCode, c.year, c.block);
  // Keep Block A → B → C order: fill a gap only with a block the workbook shows exists
  const groups = new Map<string, { programCode: string; year: number; letters: Set<string> }>();
  for (const b of blocks.values()) {
    const g = groups.get(`${b.programCode}|${b.year}`) ?? { programCode: b.programCode, year: b.year, letters: new Set<string>() };
    g.letters.add(b.blockName);
    groups.set(`${b.programCode}|${b.year}`, g);
  }
  for (const g of groups.values()) {
    const program = programByCode.get(g.programCode.toUpperCase())!;
    const max = Math.max(...[...g.letters].map(l => l.charCodeAt(0)));
    for (let code = 65; code < max; code++) {
      const letter = String.fromCharCode(code);
      if (g.letters.has(letter)) continue;
      const exists = catalog.blocks.some(b => b.programId === program.id && b.yearLevel === yearLevelLabel(g.year) && b.semester === term.semester
        && b.academicYear === term.academicYear && b.blockName.toUpperCase() === letter);
      if (exists) continue;
      if (evidenced.has(blockKeyOf(g.programCode, g.year, letter))) {
        planBlock(g.programCode, g.year, letter);
        issue({ level: 'info', topic: 'Block', message: `${g.programCode} ${g.year}${letter} has no imported class but appears on the forms — created so the block letters stay in order.` });
      } else {
        issue({ level: 'review', topic: 'Block', message: `${g.programCode} ${g.year}${letter} is not on any form, so it was not created; higher blocks of ${g.programCode} ${yearLevelLabel(g.year)} were still created (block order has a gap).` });
      }
    }
  }

  if (mixedCounts.length) {
    issue({ level: 'info', topic: 'Block', message: `The "No. of Students" written for the same block differs between subjects in ${mixedCounts.length} block(s); a new block takes the most frequent count: ${mixedCounts.join(', ')}.` });
  }

  // ── New rooms: type from the name, checked against how the forms use them ──
  const plannedRooms: PlannedRoom[] = [];
  for (const r of newRooms.values()) {
    const spellingCounts = new Map<string, number>();
    for (const s of r.spellings) spellingCounts.set(s, (spellingCounts.get(s) ?? 0) + 1);
    r.name = [...spellingCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const usedFor = [...r.uses].map(u => (u === 'lab' ? 'laboratory' : 'lecture')).join(' and ');
    r.reason = r.type === 'Laboratory'
      ? `"${r.name}" names a laboratory; the forms use it for ${usedFor} classes`
      : `the forms use "${r.name}" only for ${usedFor} classes`;
    if (r.type === 'Lecture' && r.uses.has('lab')) r.reason += ' (a laboratory session there is moved to a valid laboratory room)';
    plannedRooms.push({ key: r.key, name: r.name, type: r.type, reason: r.reason, spellings: [...new Set(r.spellings)] });
  }

  // ── Faculty details: program for new faculty, profile, deductions ─────────
  for (const { person, planned } of inScope.values()) {
    const pick = (field: 'qualification' | 'major' | 'eligibility' | 'yearsInService') => {
      const ordered = [...person.sheets].sort((a, b) => (a.role === 'actual' ? -1 : 0) - (b.role === 'actual' ? -1 : 0));
      return ordered.map(s => s.sheet[field]).find(v => v && v.trim()) ?? '';
    };
    const ex = planned.existing;
    const qual = pick('qualification'), major = pick('major'), elig = pick('eligibility'), yis = parseYears(pick('yearsInService'));
    if (qual && !ex?.qualification?.trim()) planned.profileFill.qualification = qual;
    if (major && !ex?.major?.trim()) planned.profileFill.major = major;
    if (elig && !ex?.eligibility?.trim()) planned.profileFill.eligibility = elig;
    if (yis != null && ex?.yearsInService == null) planned.profileFill.yearsInService = yis;

    if (planned.create) {
      const programs = [...new Set(classes.filter(c => c.facultyKey === person.key).map(c => c.programCode))];
      if (programs.length === 1) {
        planned.create.programCode = programs[0];
        issue({ level: 'info', topic: 'Faculty', faculty: planned.label, message: `${planned.label} (new): program set to ${programs[0]} — every class on their form is ${programs[0]}; the form itself names no program.` });
      } else {
        issue({ level: 'review', topic: 'Faculty', faculty: planned.label, message: `${planned.label} (new): classes span ${programs.join(', ') || 'no program'} — program left empty; set it on Faculty.` });
      }
      issue({ level: 'review', topic: 'Faculty', faculty: planned.label,
        message: `${planned.label} (new): Position / Academic Rank left empty — the form only says "${person.statuses.join(' / ')}" (the title under the signature is ignored as instructed); set the rank on Faculty.` });
    }

    // Deloading: the Regular Load form's Designation / Add rows (Permanent only)
    const regularForms = person.sheets.filter(s => s.role === 'regular');
    const deductionForm = regularForms.find(s => s.sheet.footers.some(f => (f.units ?? 0) > 0)) ?? null;
    if (deductionForm) {
      for (const f of deductionForm.sheet.footers) {
        if (!(f.units && f.units > 0)) {
          if (f.description) issue({ level: 'info', topic: 'Deloading', faculty: planned.label, source: { sheet: deductionForm.sheet.name, row: f.row },
            message: `${planned.label}: "${f.label}: ${f.description}" has no units on the form — not recorded as deloading.` });
          continue;
        }
        if (planned.classification !== 'Permanent') {
          issue({ level: 'info', topic: 'Deloading', faculty: planned.label, message: `${planned.label}: ${f.label} ${f.units} on the form — QRganize deloading applies to Permanent faculty only; not recorded.` });
          continue;
        }
        const type = /^designation/i.test(f.label) ? 'Designation'
          : /special/i.test(f.label) ? 'Special Assignment'
          : /research/i.test(f.label) ? 'Research/Extension'
          : /extension/i.test(f.label) ? 'Extension' : f.label;
        planned.deductions.push({
          type,
          description: f.description.replace(/\s*\|\s*/g, ' | ') || type,
          units: f.units,
          source: { sheet: deductionForm.sheet.name, row: f.row },
        });
      }
      const sig = (fs: typeof deductionForm.sheet.footers) => fs.filter(f => (f.units ?? 0) > 0).map(f => `${f.description}=${f.units}`).sort().join(';');
      for (const other of person.sheets.filter(s => s !== deductionForm && s.role !== 'overload' && s.role !== 'praise')) {
        if (other.sheet.footers.some(f => (f.units ?? 0) > 0) && sig(other.sheet.footers) !== sig(deductionForm.sheet.footers)) {
          issue({ level: 'info', topic: 'Deloading', faculty: planned.label,
            message: `${planned.label}: "${other.sheet.name}" shows different deloading (${sig(other.sheet.footers)}) from the Regular Load form "${deductionForm.sheet.name}" (${sig(deductionForm.sheet.footers)}) — the Regular Load form was used.` });
        }
      }
    }
    for (const s of person.sheets.filter(s => s.role === 'overload' || s.role === 'praise')) {
      for (const f of s.sheet.footers.filter(f => (f.units ?? 0) > 0)) {
        issue({ level: 'info', topic: 'Deloading', faculty: planned.label, source: { sheet: s.sheet.name, row: f.row },
          message: `${planned.label}: "${f.label}${f.description ? `: ${f.description}` : ''} = ${f.units}" on the ${s.role} form "${s.sheet.name}" — deloading is read from the Regular Load form only; not recorded.` });
      }
    }
  }

  // ── Non-teaching activities (the faculty's timetable sheet) ───────────────
  const activities: PlannedActivity[] = [];
  for (const { person } of inScope.values()) {
    const timetable = person.sheets.find(s => s.role === 'actual')
      ?? person.sheets.find(s => s.role === 'regular')
      ?? person.sheets.find(s => s.role === 'combined');
    if (!timetable) continue;
    const sameKind = person.sheets.filter(s => s.role === timetable.role); // duplicate copies of a form
    const seen = new Set<string>();
    for (const ps of sameKind) {
      for (const row of ps.sheet.rows) {
        if (row.kind !== 'activity') continue;
        if (!row.time || !row.days.length) {
          issue({ level: 'info', topic: 'Activity', faculty: person.label, source: srcOf(row), message: `${person.label}: "${row.description}" has no readable day/time — not recorded.` });
          continue;
        }
        for (const day of row.days) {
          const k = `${day}|${row.time.start}|${row.time.end}|${row.description.toLowerCase()}`;
          if (seen.has(k)) continue;
          seen.add(k);
          activities.push({ facultyKey: person.key, day, start: row.time.start, end: row.time.end, activity: row.description, source: srcOf(row) });
        }
      }
    }
  }

  const observed = new Map<string, WeekDay[]>();
  for (const r of resolved) if (r.row.days.length) observed.set(r.row.days.join('/'), r.row.days);

  return {
    term,
    faculty: plannedFaculty,
    classes,
    blocks: [...blocks.values()].sort((a, b) => a.key.localeCompare(b.key)),
    newRooms: plannedRooms,
    roomMatches: [...roomMatches.values()],
    activities,
    external,
    observedDaySets: [...observed.values()],
    issues,
    workbook: { sheetsRead: sheets.length, hiddenSkipped, nonFacultySheets, persons: workbookPersons, classRows, activityRows },
  };
}

const ROLE_ORDER: Role[] = ['actual', 'regular', 'overload', 'praise', 'combined'];
const sameDays = (a: WeekDay[], b: WeekDay[]) => a.length === b.length && a.every((d, i) => d === b[i]);
const daysOf = (c: SessionCandidate) => [...new Set(c.sessions.map(s => s.day))];

/**
 * The order a component's workbook options are tried in:
 *  1. the actual sheet, as written;
 *  2. a load form, as written, on the actual sheet's days (it refines the time);
 *  3. the actual sheet, length set to QRganize's hours;
 *  4. the load forms as written (their day headings are sometimes left from an
 *     older template, e.g. "MW" where the actual sheet says "MTh"), then adjusted.
 * Identical options from several sheets are tried once.
 */
function orderCandidates(list: { cand: SessionCandidate; role: Role; seq: number }[]): SessionCandidate[] {
  const actualDays = list.find(x => x.role === 'actual')?.cand;
  const tier = (x: { cand: SessionCandidate; role: Role }) => {
    const written = x.cand.fit === 'as-written';
    if (x.role === 'actual') return written ? 0 : 2;
    if (written && actualDays && sameDays(daysOf(x.cand), daysOf(actualDays))) return 1;
    return written ? 3 : 4;
  };
  const sorted = [...list].sort((a, b) => tier(a) - tier(b) || ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.seq - b.seq);
  const out: SessionCandidate[] = [];
  for (const { cand } of sorted) {
    const same = out.find(x => sameSessions(x.sessions, cand.sessions));
    if (same) same.sources.push(...cand.sources.filter(s => !same.sources.some(x => x.sheet === s.sheet && x.row === s.row)));
    else out.push({ ...cand, sources: [...cand.sources], notes: [...cand.notes] });
  }
  return out;
}

/**
 * The class's workload categories from the Regular / Overload / Praise forms,
 * stored the way Faculty Workload stores them: one load row, plus one
 * overloads row for an Overload part or a split Praise part.
 */
export function buildCategoryPlan(
  rows: { role: Role; comp: RowComponent; row: WorkloadRow }[],
  subject: CatalogSubject,
  isPermanent: boolean,
): { plan?: CategoryPlan; problem?: string } {
  const lecH = subject.lecHours, labH = subject.labHours;
  const value = (t: SessionType | 'whole') => isPermanent
    ? (t === 'lec' ? lecH : t === 'lab' ? labH * 0.75 : lecH + labH * 0.75)
    : (t === 'lec' ? lecH : t === 'lab' ? labH : (subject.totalHours || lecH + labH));
  const comps: SessionType[] = [];
  if (lecH > 0) comps.push('lec');
  if (labH > 0) comps.push('lab');

  const hits: Record<SessionType, { category: LoadCategory; value: number | null }[]> = { lec: [], lab: [] };
  const seen = new Set<string>();
  for (const r of rows) {
    const category = ROLE_CATEGORY[r.role];
    if (!category) continue;
    const add = (t: SessionType, v: number | null) => {
      const k = `${category}|${t}|${v ?? 'full'}|${r.row.timeText}|${r.row.days.join()}`;
      if (seen.has(k)) return; // the same row on a duplicate copy of the form
      seen.add(k);
      hits[t].push({ category, value: v });
    };
    const c = r.comp;
    if (c.kind === 'both' || c.kind === 'unknown') comps.forEach(t => add(t, null));
    else if (c.kind === 'partial') add(c.type, c.value);
    else add(c.kind, null);
  }

  const portions: CategoryPlan['portions'] = [];
  for (const t of comps) {
    const list = hits[t];
    if (!list.length) return { problem: `its ${t === 'lec' ? 'Lecture' : 'Laboratory'} is on none of the load forms` };
    const cats = [...new Set(list.map(h => h.category))];
    if (cats.length === 1) {
      portions.push({ category: cats[0], value: value(t), component: comps.length === 1 ? 'whole' : t });
      continue;
    }
    if (!isPermanent) return { problem: `its ${t === 'lec' ? 'Lecture' : 'Laboratory'} is split between ${cats.join(' and ')} forms (not supported for hour-based loads)` };
    const sums = cats.map(cat => ({ cat, v: round2(list.filter(h => h.category === cat).reduce((s, h) => s + (h.value ?? value(t)), 0)) }));
    const total = sums.reduce((s, x) => s + x.v, 0);
    if (Math.abs(total - value(t)) > 0.011) {
      return { problem: `its ${t === 'lec' ? 'Lecture' : 'Laboratory'} is split ${sums.map(s => `${s.cat} ${fmtNum(s.v)}`).join(' + ')} = ${fmtNum(total)}, but the ${t === 'lec' ? 'Lecture' : 'Laboratory'} is worth ${fmtNum(value(t))}` };
    }
    for (const s of sums) portions.push({ category: s.cat, value: s.v, component: t });
  }

  const sum = (cat: LoadCategory) => round2(portions.filter(p => p.category === cat).reduce((s, p) => s + p.value, 0));
  const R = sum('Regular'), O = sum('Overload'), P = sum('Praise');
  const total = round2(value('whole'));
  const unit = isPermanent ? 'units' : 'hours';
  const describe = (cat: LoadCategory) => portions.filter(p => p.category === cat).map(p => componentLabel(p.component)).join(' + ');

  // Only Permanent faculty carry Overload or Praise Load
  if (!isPermanent && (O > 0 || P > 0)) {
    return { problem: `the forms put ${describe(O > 0 ? 'Overload' : 'Praise')} in ${O > 0 ? 'Overload' : 'Praise Load'}, but Contractual faculty carry Regular Load only` };
  }
  if (O > 0 && P > 0) {
    return { problem: `the forms put ${describe('Overload')} in Overload and ${describe('Praise')} in Praise${R > 0 ? ` and ${describe('Regular')} in Regular` : ''} — QRganize lets a subject be split Regular + Overload or Regular + Praise only, never Overload + Praise` };
  }
  if (O === 0 && P === 0) {
    return { plan: { loadCategory: 'Regular', loadValue: total, overloadComponent: 'full', overloadRow: null, portions, label: 'Regular' } };
  }
  if (R === 0 && P === 0) {
    return { plan: { loadCategory: 'Overload', loadValue: total, overloadComponent: 'full', overloadRow: { value: total, isPraise: false, reason: 'Teaching overload — Excel workload import' }, portions, label: 'Overload' } };
  }
  if (R === 0 && O === 0) {
    return { plan: { loadCategory: 'Praise', loadValue: total, overloadComponent: 'full', overloadRow: null, portions, label: 'Praise' } };
  }
  const moved = portions.filter(p => p.category !== 'Regular');
  const movedValue = O > 0 ? O : P;
  const single = moved.length === 1 && moved[0].component !== 'whole' && Math.abs(moved[0].value - value(moved[0].component)) <= 0.011;
  const component: 'full' | SessionType = single ? (moved[0].component as SessionType) : 'full';
  const isPraise = P > 0;
  // The Lecture's share of the moved part (a Lec + Lab subject split any way between the forms)
  const lecPart = comps.length === 2 ? round2(moved.filter(p => p.component === 'lec').reduce((s, p) => s + p.value, 0)) : null;
  const reason = isPraise
    ? (single ? `Praise Load — ${component === 'lec' ? 'Lecture' : 'Laboratory'} portion` : `Praise Load — ${fmtNum(movedValue)} ${unit} of ${describe('Praise')}`)
    : `Split load — ${R.toFixed(2)} ${unit} Regular, ${movedValue.toFixed(2)} ${unit} Overload`;
  return {
    plan: {
      loadCategory: 'Regular',
      loadValue: R,
      overloadComponent: component,
      overloadRow: { value: movedValue, isPraise, reason, lecPart },
      portions,
      label: `Regular ${fmtNum(R)} (${describe('Regular')}) + ${isPraise ? 'Praise' : 'Overload'} ${fmtNum(movedValue)} (${describe(isPraise ? 'Praise' : 'Overload')})`,
    },
  };
}

export { describeSessions };

/**
 * Curriculum print + Excel export — shared by Curriculum Setup and Reports so
 * both produce exactly the same documents.
 */

import { curriculumVersionFileSlug, curriculumVersionLabel, type CurriculumVersion } from '@shared/curriculumVersion';

/** The curriculum fields the documents need (a subset of the page's row type) */
export interface CurriculumRowLike {
  id: number; program_id: number; program_code: string; program_name: string;
  year_level: string; semester: string;
  subject_code: string; subject_name: string;
  lecture_hours: number; laboratory_hours: number; units: number;
  prerequisites: string; grade: string;
}

export interface CurriculumGroupOf<T> {
  key: string; program_id: number;
  program: string; programName: string;
  yearLevel: string; semester: string;
  subjects: T[];
}

const YEAR_ORDER: Record<string, number> = { '1st Year': 0, '2nd Year': 1, '3rd Year': 2, '4th Year': 3 };
const SEM_ORDER: Record<string, number> = { '1st Semester': 0, '2nd Semester': 1, 'Summer': 2 };

/** Group subjects by program → year level → semester, in curriculum order */
export function groupCurriculums<T extends CurriculumRowLike>(items: T[]): CurriculumGroupOf<T>[] {
  const map = new Map<string, CurriculumGroupOf<T>>();
  for (const c of items) {
    const key = `${c.program_id}||${c.year_level}||${c.semester}`;
    if (!map.has(key)) {
      map.set(key, {
        key, program_id: c.program_id, program: c.program_code,
        programName: c.program_name, yearLevel: c.year_level, semester: c.semester, subjects: [],
      });
    }
    map.get(key)!.subjects.push(c);
  }
  return [...map.values()].sort((a, b) => {
    if (a.program !== b.program) return a.program.localeCompare(b.program);
    const yi = (YEAR_ORDER[a.yearLevel] ?? 99) - (YEAR_ORDER[b.yearLevel] ?? 99);
    if (yi !== 0) return yi;
    return (SEM_ORDER[a.semester] ?? 99) - (SEM_ORDER[b.semester] ?? 99);
  });
}

async function rasterizeLogo(src: string): Promise<{ base64: string; extension: 'png' } | null> {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const size = 192;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx || !img.naturalWidth || !img.naturalHeight) { resolve(null); return; }
      const scale = Math.min(size / img.naturalWidth, size / img.naturalHeight);
      const w = img.naturalWidth * scale;
      const h = img.naturalHeight * scale;
      ctx.clearRect(0, 0, size, size);
      ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
      resolve({ base64: canvas.toDataURL('image/png').split(',')[1] ?? '', extension: 'png' });
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** System logo (Settings) for the Excel header, falling back to the NEMSU seal */
export async function loadExportLogo(): Promise<{ base64: string; extension: 'png' } | null> {
  let configured: string | null = null;
  try {
    const res = await fetch('/api/settings/logo');
    const data = await res.json().catch(() => null) as { logoUrl?: string | null } | null;
    configured = data?.logoUrl ? String(data.logoUrl).split('?')[0] : null;
  } catch { /* use official fallback */ }
  for (const src of [configured, '/nemlogo/NEMSU-logo.png'].filter(Boolean) as string[]) {
    const logo = await rasterizeLogo(src);
    if (logo?.base64) return logo;
  }
  return null;
}

/**
 * The curriculum as the database has it now, grouped like the page and the
 * print — read at the moment of the download, so the file never misses a
 * change made after the page opened. Search on the page doesn't narrow it.
 */
export async function fetchCurriculumGroups(opts: {
  programId: string; version: CurriculumVersion; yearLevel?: string; semester?: string;
}): Promise<CurriculumGroupOf<CurriculumRowLike>[]> {
  const params = new URLSearchParams({ program_id: opts.programId, curriculum_version: opts.version });
  if (opts.yearLevel) params.set('year_level', opts.yearLevel);
  if (opts.semester) params.set('semester', opts.semester);
  const res = await fetch(`/api/curriculum?${params}`, { cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Could not read the curriculum.');
  return groupCurriculums((data.curriculums ?? []) as CurriculumRowLike[]);
}

/** Build and download the curriculum Excel file. Throws with a readable message on failure. */
export async function downloadCurriculumExcel(opts: {
  programName: string; programCode?: string; version: CurriculumVersion;
  groups: CurriculumGroupOf<CurriculumRowLike>[];
}): Promise<void> {
  const logo = await loadExportLogo();
  const res = await fetch('/api/curriculum/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      programName: opts.programName || 'Curriculum',
      programCode: opts.programCode,
      curriculumLabel: curriculumVersionLabel(opts.version),
      groups: opts.groups.map(group => ({
        yearLevel: group.yearLevel,
        semester: group.semester,
        subjects: group.subjects.map(subject => ({
          subject_code: subject.subject_code,
          subject_name: subject.subject_name,
          lecture_hours: Number(subject.lecture_hours) || 0,
          laboratory_hours: Number(subject.laboratory_hours) || 0,
          units: parseFloat(String(subject.units)) || 0,
          prerequisites: subject.prerequisites || '',
          grade: subject.grade || '',
        })),
      })),
      logo,
    }),
  });
  if (!res.ok) {
    let msg = 'Could not generate the Excel template.';
    try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = `${opts.programCode ?? 'Curriculum'}_${curriculumVersionFileSlug(opts.version)}_Curriculum.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Open the printable curriculum. Returns false when the pop-up was blocked. */
export async function printCurriculum(
  groups: CurriculumGroupOf<CurriculumRowLike>[], programName: string, version: CurriculumVersion,
): Promise<boolean> {
  const { openCurriculumPrint } = await import('./CurriculumPrintTemplate');
  return openCurriculumPrint(groups, programName, curriculumVersionLabel(version));
}

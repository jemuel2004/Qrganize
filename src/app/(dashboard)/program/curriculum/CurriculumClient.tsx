'use client';

import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { useToast } from '@/client/context/ToastContext';
import Modal from '@/client/components/ui/Modal';
import {
  Plus, Pencil, Trash2, Upload, FileSpreadsheet,
  X, CheckCircle, AlertTriangle, Info, Download, Layers, Printer,
  ChevronDown,
} from 'lucide-react';
import { SearchInput, FilterSelect, FilterBar } from '@/components/ui/SearchFilter';
import { TableSkeleton, Skeleton } from '@/client/components/ui/skeletons';
import { PageLoadTransition } from '@/client/components/ui/PageLoadTransition';
import { LOADING_DELAY, PAGE_SKELETON_MIN_MS, useMinLoading } from '@/client/hooks/useMinLoading';
import { useScrollLock } from '@/client/hooks/useScrollLock';
import { categoryFromHours, categoryFromSubjectType, type SubjectCategory } from '@/lib/subjectCategory';
import {
  compareImportRows,
  detectProgramFromCourseCodes,
  parseCurriculumWorkbook,
  type ColumnMapping,
  type ImportDiagnostic,
  type ImportRowStatus,
  type ParsedSubjectRow,
  type ProgramDetection,
} from '@/lib/curriculumImport';
import {
  CURRICULUM_VERSIONS,
  CURRICULUM_VERSION_STORAGE_KEY,
  DEFAULT_CURRICULUM_VERSION,
  curriculumVersionFileSlug,
  curriculumVersionLabel,
  parseCurriculumVersion,
  type CurriculumVersion,
} from '@/lib/curriculumVersion';
// BulkAddModal (~44 KB) loads only when opened. xlsx is already on-demand (~900 KB).

const BulkAddModal = dynamic(() => import('./BulkAddModal'), { ssr: false });

/* ── Types ─────────────────────────────────────────────────────────────── */

interface Program { id: number; code: string; name: string; }

interface Curriculum {
  id: number; program_id: number; year_level: string; semester: string;
  subject_code: string; subject_name: string;
  lecture_hours: number; laboratory_hours: number; total_hours: number; units: number;
  prerequisites: string; grade: string;
  program_code: string; program_name: string;
  subject_category: SubjectCategory;
  curriculum_version?: CurriculumVersion;
}

interface PreviewRow {
  _rowNum: number;
  program: string;
  year_level: string;
  semester: string;
  subject_code: string;
  subject_name: string;
  lecture_hours: number;
  laboratory_hours: number;
  credit_units: number;
  computed_total: number;
  prerequisites: string;
  grade: string;
  subject_category: SubjectCategory;
  program_id: number | null;
  isDuplicate: boolean;
  errors: string[];
  valid: boolean;
  status: ImportRowStatus;
  changes: { field: string; from: string; to: string }[];
}

interface CurriculumGroup {
  key: string; program_id: number;
  program: string; programName: string;
  yearLevel: string; semester: string;
  subjects: Curriculum[];
}

interface ImportResult {
  imported:    number;
  reactivated: number;
  updated:     number;
  total:       number;
  duplicated:  number;
  errors:      string[];
}

const MAX_IMPORT_BYTES = 8 * 1024 * 1024;

/* ── Constants ──────────────────────────────────────────────────────────── */

const YEAR_LEVELS = ['1st Year', '2nd Year', '3rd Year', '4th Year'];
const SEMESTERS   = ['1st Semester', '2nd Semester', 'Summer'];
const YEAR_ORDER: Record<string, number> = { '1st Year': 0, '2nd Year': 1, '3rd Year': 2, '4th Year': 3 };
const SEM_ORDER:  Record<string, number> = { '1st Semester': 0, '2nd Semester': 1, 'Summer': 2 };
const SUBJECT_TYPES = ['Lecture', 'Laboratory', 'Lecture + Laboratory'] as const;
type SubjectType = typeof SUBJECT_TYPES[number] | '';

const emptyForm = {
  program_id: '', year_level: '', semester: '',
  subject_type: '' as SubjectType,
  subject_code: '', subject_name: '',
  lecture_hours: '', laboratory_hours: '', units: '',
  prerequisites: '', grade: '',
  subject_category: 'Minor' as SubjectCategory,
};

const fieldCls = 'w-full border border-[#CBD5E1] rounded-xl px-3 py-2.5 text-sm appearance-none bg-white transition-colors placeholder-[#94A3B8] disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-0 focus:border-[#CBD5E1] focus:shadow-none';

const filterLabelCls = 'text-xs font-semibold uppercase tracking-wide text-[#4B5563] mb-1.5';

/* ── Helpers ────────────────────────────────────────────────────────────── */

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

async function loadExportLogo(): Promise<{ base64: string; extension: 'png' } | null> {
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

function inferSubjectType(lec: number, lab: number): SubjectType {
  if (lec > 0 && lab === 0) return 'Lecture';
  if (lab > 0 && lec === 0) return 'Laboratory';
  return 'Lecture + Laboratory';
}

function groupCurriculums(items: Curriculum[]): CurriculumGroup[] {
  const map = new Map<string, CurriculumGroup>();
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

function importStatusMeta(status: ImportRowStatus): { label: string; className: string } {
  switch (status) {
    case 'new': return { label: 'New', className: 'bg-[#ECFDF5] text-[#047857] border-[#A7F3D0]' };
    case 'existing': return { label: 'Existing', className: 'bg-[#F8FAFC] text-[#475569] border-[#E2E8F0]' };
    case 'changed': return { label: 'Changed', className: 'bg-[#FFFBEB] text-[#B45309] border-[#FDE68A]' };
    case 'duplicate': return { label: 'Duplicate', className: 'bg-[#FFF7ED] text-[#C2410C] border-[#FED7AA]' };
    case 'possible': return { label: 'Review', className: 'bg-[#EFF6FF] text-[#1D4ED8] border-[#BFDBFE]' };
    default: return { label: 'Invalid', className: 'bg-[#FEF2F2] text-[#B91C1C] border-[#FECACA]' };
  }
}

/* ── Main component ─────────────────────────────────────────────────────── */

export default function CurriculumPage() {
  const toast = useToast();
  const [curriculums, setCurriculums] = useState<Curriculum[]>([]);
  const [programs, setPrograms]       = useState<Program[]>([]);
  const [filters, setFilters]         = useState({
    program_id: '',
    curriculum_version: DEFAULT_CURRICULUM_VERSION as CurriculumVersion,
    year_level: '',
    semester: '',
    search: '',
  });
  const [form, setForm]               = useState(emptyForm);
  const [editId, setEditId]           = useState<number | null>(null);
  const [modalOpen, setModalOpen]     = useState(false);
  const [formError, setFormError]     = useState('');
  const [loading, setLoading]         = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [booting, setBooting] = useState(true);

  const [bulkOpen, setBulkOpen]           = useState(false);
  const [importOpen, setImportOpen]       = useState(false);
  const [importStep, setImportStep]       = useState<'upload' | 'preview' | 'done'>('upload');
  const [previewRows, setPreviewRows]     = useState<PreviewRow[]>([]);
  const [importLoading, setImportLoading] = useState(false);
  const [importResult, setImportResult]   = useState<ImportResult | null>(null);
  const [importDiagnostic, setImportDiagnostic] = useState<ImportDiagnostic | null>(null);
  const [importMappings, setImportMappings] = useState<ColumnMapping[]>([]);
  const [importProgramDetection, setImportProgramDetection] = useState<ProgramDetection | null>(null);
  const [importProgramMismatch, setImportProgramMismatch] = useState(false);
  const parsedImportRowsRef = useRef<ParsedSubjectRow[]>([]);
  const [dragOver, setDragOver]           = useState(false);
  const [importParsing, setImportParsing] = useState(false);
  const [formatGuideOpen, setFormatGuideOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  useScrollLock(importOpen);

  // Abort controller ref — cancels in-flight requests on rapid filter changes
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    fetch('/api/programs')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setPrograms(d.programs || []); })
      .catch(() => {})
      .finally(() => setBooting(false));
    const stored = parseCurriculumVersion(localStorage.getItem(CURRICULUM_VERSION_STORAGE_KEY));
    if (stored) setFilters(f => ({ ...f, curriculum_version: stored }));
    return () => { abortRef.current?.abort(); };
  }, []);

  const fetchCurriculums = useCallback((programId: string, yearLevel = '', semester = '', version: CurriculumVersion = DEFAULT_CURRICULUM_VERSION) => {
    // Cancel any in-flight request before starting a new one
    abortRef.current?.abort();

    if (!programId) { setCurriculums([]); setListLoading(false); return; }

    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;
    setListLoading(true);

    const p = new URLSearchParams({ program_id: programId, curriculum_version: version });
    if (yearLevel) p.set('year_level', yearLevel);
    if (semester)  p.set('semester',   semester);

    fetch('/api/curriculum?' + p, { signal })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setCurriculums(d.curriculums || []); })
      .catch(err => { if (err.name !== 'AbortError') console.error('[curriculum] fetch error:', err); })
      .finally(() => {
        if (!signal.aborted) setListLoading(false);
      });
  }, []);

  useEffect(() => {
    fetchCurriculums(filters.program_id, filters.year_level, filters.semester, filters.curriculum_version);
  }, [filters.program_id, filters.year_level, filters.semester, filters.curriculum_version, fetchCurriculums]);

  useEffect(() => {
    localStorage.setItem(CURRICULUM_VERSION_STORAGE_KEY, filters.curriculum_version);
  }, [filters.curriculum_version]);

  const lec = parseFloat(String(form.lecture_hours)) || 0;
  const lab = parseFloat(String(form.laboratory_hours)) || 0;

  function openAdd() {
    setForm({
      ...emptyForm,
      // Pre-fill from active filters so the user doesn't have to re-select
      // Leave year_level / semester blank when filter is "All" — user must pick explicitly
      program_id: filters.program_id,
      year_level: filters.year_level,
      semester:   filters.semester,
    });
    setEditId(null);
    setFormError('');
    setModalOpen(true);
  }

  function openEdit(c: Curriculum) {
    setForm({
      program_id: String(c.program_id), year_level: c.year_level, semester: c.semester,
      subject_type: inferSubjectType(c.lecture_hours, c.laboratory_hours),
      subject_code: c.subject_code, subject_name: c.subject_name,
      lecture_hours: String(c.lecture_hours), laboratory_hours: String(c.laboratory_hours),
      units: String(c.units), prerequisites: c.prerequisites || '', grade: c.grade || '',
      subject_category: categoryFromSubjectType(inferSubjectType(c.lecture_hours, c.laboratory_hours)),
    });
    setEditId(c.id); setFormError(''); setModalOpen(true);
  }

  function handleSubjectTypeChange(type: SubjectType) {
    setForm(f => ({
      ...f, subject_type: type,
      subject_category: categoryFromSubjectType(type),
      lecture_hours:    type === 'Laboratory' ? '' : f.lecture_hours,
      laboratory_hours: type === 'Lecture'    ? '' : f.laboratory_hours,
    }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setFormError('');
    if (!form.subject_type) { setFormError('Please select a Subject Type before saving.'); setLoading(false); return; }
    if (form.subject_type === 'Lecture' && lec <= 0) { setFormError('Lecture Hours must be greater than 0 for a Lecture subject.'); setLoading(false); return; }
    if (form.subject_type === 'Laboratory' && lab <= 0) { setFormError('Laboratory Hours must be greater than 0 for a Laboratory subject.'); setLoading(false); return; }
    if (form.subject_type === 'Lecture + Laboratory' && lec <= 0 && lab <= 0) { setFormError('Enter at least one of Lecture Hours or Laboratory Hours.'); setLoading(false); return; }
    const url    = editId ? `/api/curriculum/${editId}` : '/api/curriculum';
    const method = editId ? 'PUT' : 'POST';
    try {
      const res = await fetch(url, {
        method, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          lecture_hours: lec,
          laboratory_hours: lab,
          units: parseFloat(String(form.units)) || 0,
          subject_category: categoryFromSubjectType(form.subject_type),
          curriculum_version: filters.curriculum_version,
        }),
      });
      if (!res.ok) {
        let msg = 'Error saving subject.';
        try { msg = ((await res.json()) as { error?: string })?.error ?? msg; } catch { /* html */ }
        setFormError(msg); toast.error(msg); return;
      }
      const data = await res.json();
      setModalOpen(false);
      toast.success(editId ? 'Subject updated successfully.' : 'Subject added successfully.');
      fetchCurriculums(filters.program_id, filters.year_level, filters.semester, filters.curriculum_version);
    } catch { setFormError('Connection error'); toast.error('Connection error. Please try again.'); }
    finally { setLoading(false); }
  }

  async function handleDelete(id: number) {
    if (!confirm('Delete this subject?')) return;
    const res = await fetch(`/api/curriculum/${id}`, { method: 'DELETE' });
    if (!res.ok) { const d = await res.json(); toast.error(d.error || 'Failed to delete.'); return; }
    toast.delete('Subject deleted successfully.');
    fetchCurriculums(filters.program_id, filters.year_level, filters.semester, filters.curriculum_version);
  }

  async function handleDownload() {
    if (!filters.program_id || groups.length === 0) return;
    const prog = programs.find(p => String(p.id) === filters.program_id);
    try {
      const logo = await loadExportLogo();
      const res = await fetch('/api/curriculum/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          programName: prog?.name || 'Curriculum',
          programCode: prog?.code,
          curriculumLabel: curriculumVersionLabel(filters.curriculum_version),
          groups: groups.map(group => ({
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
        toast.error(msg);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${prog?.code ?? 'Curriculum'}_${curriculumVersionFileSlug(filters.curriculum_version)}_Curriculum.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('Could not generate the Excel template.');
    }
  }

  async function handlePrint() {
    if (!filters.program_id) {
      toast.error('Please select a Program before printing.');
      return;
    }
    if (curriculums.length === 0) {
      toast.error('No curriculum data to print. Add subjects first.');
      return;
    }
    const { openCurriculumPrint } = await import('./CurriculumPrintTemplate');
    const ok = openCurriculumPrint(printGroups, printProgramName, curriculumVersionLabel(filters.curriculum_version));
    if (!ok) {
      toast.error(
        'Pop-up blocked. Allow pop-ups for this site and try again, ' +
        'or use your browser\'s "Print" option directly.',
      );
    }
  }

  function resetImportState() {
    setImportStep('upload');
    setPreviewRows([]);
    setImportResult(null);
    setImportDiagnostic(null);
    setImportMappings([]);
    setImportProgramDetection(null);
    setImportProgramMismatch(false);
    parsedImportRowsRef.current = [];
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function openImport() {
    setImportOpen(true);
    resetImportState();
  }

  function closeImport() {
    setImportOpen(false);
    resetImportState();
  }

  async function buildPreviewRows(parsedRows: ParsedSubjectRow[], target: Program | null) {
    let existing: Curriculum[] = [];
    if (target) {
      try {
        const params = new URLSearchParams({
          program_id: String(target.id),
          curriculum_version: filters.curriculum_version,
        });
        const res = await fetch(`/api/curriculum?${params}`);
        if (res.ok) {
          const data = await res.json() as { curriculums?: Curriculum[] };
          existing = data.curriculums ?? [];
        }
      } catch {
        /* Preview still works; confirm will re-check the database. */
      }
    }
    const compared = compareImportRows(parsedRows, existing, target?.id ?? 0);
    setPreviewRows(compared.map(row => {
      const errors = target ? [...row.errors] : [...row.errors, 'Program was not detected or selected'];
      const valid = Boolean(target) && row.valid;
      return {
        _rowNum: row.rowNum,
        program: target?.code ?? '',
        year_level: row.yearLevel,
        semester: row.semester,
        subject_code: row.subjectCode,
        subject_name: row.subjectName,
        lecture_hours: row.lectureHours,
        laboratory_hours: row.laboratoryHours,
        credit_units: row.creditUnits,
        computed_total: row.lectureHours + row.laboratoryHours,
        prerequisites: row.prerequisites,
        grade: row.grade,
        subject_category: categoryFromHours(row.lectureHours, row.laboratoryHours),
        program_id: target?.id ?? null,
        isDuplicate: row.isDuplicate,
        errors,
        valid,
        status: valid ? row.status : (row.status === 'duplicate' ? row.status : 'invalid'),
        changes: row.changes,
      };
    }));
  }

  async function parseExcelFile(file: File) {
    if (file.size > MAX_IMPORT_BYTES) {
      toast.error('File is too large. Please upload an Excel file under 8 MB.');
      return;
    }
    if (!/\.xlsx?$/i.test(file.name)) {
      toast.error('Please upload a .xlsx or .xls file only.');
      return;
    }

    setImportParsing(true);
    try {
      const XLSX = await import('xlsx');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const workbook = XLSX.read(bytes, { type: 'array' });
      if (!workbook.SheetNames.length) { toast.error('The Excel file has no sheets.'); return; }

      const parsed = parseCurriculumWorkbook({
        fileName: file.name,
        sheets: workbook.SheetNames.map(name => ({
          name,
          rows: XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[name], { header: 1, defval: '', raw: false }),
          merges: workbook.Sheets[name]['!merges'] as Array<{ s: { r: number; c: number }; e: { r: number; c: number } }> | undefined,
        })),
      });

      setImportMappings(parsed.mappings);
      setImportDiagnostic(parsed.diagnostic);

      if (parsed.rows.length === 0) {
        toast.error(parsed.diagnostic.reason);
        return;
      }

      parsedImportRowsRef.current = parsed.rows;
      const selectedProgram = programs.find(p => String(p.id) === filters.program_id) ?? null;
      const detection = detectProgramFromCourseCodes(parsed.rows.map(r => r.subjectCode), programs);
      setImportProgramDetection(detection);

      const mismatch = Boolean(
        selectedProgram
        && detection.program
        && (detection.confidence === 'high' || detection.confidence === 'medium')
        && detection.program.id !== selectedProgram.id,
      );
      setImportProgramMismatch(mismatch);

      const target = mismatch
        ? selectedProgram
        : (detection.program && (detection.confidence === 'high' || detection.confidence === 'medium')
          ? detection.program
          : selectedProgram);

      if (target && !selectedProgram && (detection.confidence === 'high' || detection.confidence === 'medium')) {
        setFilters(f => ({ ...f, program_id: String(target.id) }));
      }

      await buildPreviewRows(parsed.rows, target);
      setImportStep('preview');
    } catch {
      toast.error('Could not read the Excel file. Make sure it is a valid .xlsx or .xls file.');
    } finally {
      setImportParsing(false);
    }
  }

  async function applyDetectedProgram() {
    const detected = importProgramDetection?.program;
    if (!detected) return;
    setFilters(f => ({ ...f, program_id: String(detected.id) }));
    setImportProgramMismatch(false);
    await buildPreviewRows(parsedImportRowsRef.current, detected);
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) parseExcelFile(f);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault(); setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f && (f.name.endsWith('.xlsx') || f.name.endsWith('.xls'))) parseExcelFile(f);
    else toast.error('Please upload a .xlsx or .xls file only.');
  }

  async function handleConfirmImport() {
    if (importProgramMismatch) {
      toast.error('Resolve the program mismatch before importing.');
      return;
    }
    const validRows = previewRows.filter(r => r.valid);
    if (validRows.length === 0) { toast.error('No valid rows to import.'); return; }
    setImportLoading(true);
    try {
      const res = await fetch('/api/curriculum/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          curriculum_version: filters.curriculum_version,
          apply_updates: true,
          rows: validRows.map(r => ({ program_id: r.program_id, year_level: r.year_level, semester: r.semester, subject_code: r.subject_code, subject_name: r.subject_name, lecture_hours: r.lecture_hours, laboratory_hours: r.laboratory_hours, units: r.credit_units, prerequisites: r.prerequisites, grade: r.grade, subject_category: r.subject_category })),
        }),
      });
      if (!res.ok) {
        let msg = 'Import failed.';
        try { msg = ((await res.json()) as { error?: string })?.error ?? msg; } catch { /* html */ }
        toast.error(msg); return;
      }
      const data = await res.json();
      const result: ImportResult = {
        imported: data.imported ?? 0,
        reactivated: data.reactivated ?? 0,
        updated: data.updated ?? 0,
        total: data.total ?? ((data.imported ?? 0) + (data.reactivated ?? 0) + (data.updated ?? 0)),
        duplicated: data.duplicated ?? 0,
        errors: data.errors ?? [],
      };
      setImportResult(result); setImportStep('done');
      const parts: string[] = [];
      if (result.imported    > 0) parts.push(`${result.imported} new`);
      if (result.updated     > 0) parts.push(`${result.updated} updated`);
      if (result.reactivated > 0) parts.push(`${result.reactivated} restored`);
      if (result.duplicated  > 0) parts.push(`${result.duplicated} already existed`);
      if (result.errors.length)   parts.push(`${result.errors.length} error${result.errors.length !== 1 ? 's' : ''}`);
      const summary = parts.length ? parts.join(', ') : '0 subjects added';
      if (result.total > 0) toast.success(`Curriculum imported successfully — ${summary}.`);
      else if (result.duplicated > 0) toast.info(`Import complete — all ${result.duplicated} subjects already exist and are active.`);
      else toast.error(`Import finished with no subjects added — ${summary}.`);
      fetchCurriculums(filters.program_id, filters.year_level, filters.semester, filters.curriculum_version);
    } catch { toast.error('Connection error during import. Please try again.'); }
    finally { setImportLoading(false); }
  }

  /* ── Derived state ──────────────────────────────────────────────────── */

  const validCount  = previewRows.filter(r => r.valid).length;
  const errorCount  = previewRows.filter(r => r.status === 'invalid').length;
  const newCount = previewRows.filter(r => r.status === 'new').length;
  const existingCount = previewRows.filter(r => r.status === 'existing').length;
  const changedCount = previewRows.filter(r => r.status === 'changed').length;
  const duplicateCount = previewRows.filter(r => r.status === 'duplicate' || r.status === 'possible').length;

  const previewGroups = useMemo(() => {
    const m = new Map<string, PreviewRow[]>();
    for (const r of previewRows) {
      const k = `${r.year_level}||${r.semester}`;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    }
    return [...m.entries()].map(([k, rows]) => {
      const [yl, sem] = k.split('||');
      return { key: k, yearLevel: yl || '(unknown)', semester: sem || '(unknown)', rows, valid: rows.filter(r => r.valid).length };
    });
  }, [previewRows]);

  const filtered = curriculums.filter(c =>
    !filters.search ||
    c.subject_code.toLowerCase().includes(filters.search.toLowerCase()) ||
    c.subject_name.toLowerCase().includes(filters.search.toLowerCase()) ||
    (c.prerequisites || '').toLowerCase().includes(filters.search.toLowerCase()),
  );
  const groups = groupCurriculums(filtered);
  const selectedProg = programs.find(p => String(p.id) === filters.program_id);
  const showPageSkeleton = useMinLoading(booting, LOADING_DELAY);
  const showTableSkeleton = useMinLoading(
    !showPageSkeleton && listLoading && !!filters.program_id && curriculums.length === 0,
    PAGE_SKELETON_MIN_MS,
  );

  /* ── Render ─────────────────────────────────────────────────────────── */

  /* ── Print data ─────────────────────────────────────────────────────── */

  // Use the full (unfiltered by search) groups for printing so the document
  // is always complete when "All" filters are active.
  const printGroups = groupCurriculums(curriculums);
  const printProgramName = selectedProg
    ? `${selectedProg.name}`
    : '';

  const btnBase =
    'inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-70';
  const btnSecondary =
    `${btnBase} bg-white border border-[#E5E7EB] text-[#374151] hover:border-[#3C91E6] hover:text-[#2563EB] hover:bg-[#F9FAFB] active:bg-[#EFF6FF]`;
  const btnPrimary =
    `${btnBase} bg-[#2563EB] !text-white hover:bg-[#1D4ED8] active:bg-[#1E40AF] shadow-sm`;

  const pageSkeleton = (
    <div className="space-y-6" role="status" aria-live="polite" aria-label="Loading curriculum setup">
      {/* Title + action buttons */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="space-y-2 min-w-0">
          <Skeleton className="h-8 w-56 rounded-md" />
          <Skeleton className="h-4 w-80 max-w-full rounded" />
        </div>
        <div className="flex gap-2 flex-wrap">
          <Skeleton className="h-10 w-[8.75rem] rounded-xl" />
          <Skeleton className="h-10 w-[8.5rem] rounded-xl" />
          <Skeleton className="h-10 w-[7.5rem] rounded-xl" />
          <Skeleton className="h-10 w-[6.5rem] rounded-xl" />
          <Skeleton className="h-10 w-[7.25rem] rounded-xl" />
        </div>
      </div>

      {/* Filters: Program, Curriculum, Year Level, Semester, Search */}
      <div className="bg-white rounded-2xl border border-[#E5E7EB] shadow-sm px-5 py-4">
        <div className="flex flex-wrap gap-4 items-end">
          <div className="flex flex-col min-w-64 flex-1 gap-1.5">
            <Skeleton className="h-3 w-16 rounded" />
            <Skeleton className="h-[42px] w-full rounded-xl" />
          </div>
          <div className="flex flex-col min-w-48 gap-1.5">
            <Skeleton className="h-3 w-20 rounded" />
            <Skeleton className="h-[42px] w-full rounded-xl" />
          </div>
          <div className="flex flex-col min-w-44 gap-1.5">
            <Skeleton className="h-3 w-16 rounded" />
            <Skeleton className="h-[42px] w-full rounded-xl" />
          </div>
          <div className="flex flex-col min-w-44 gap-1.5">
            <Skeleton className="h-3 w-16 rounded" />
            <Skeleton className="h-[42px] w-full rounded-xl" />
          </div>
          <div className="flex flex-col flex-1 min-w-52 gap-1.5">
            <Skeleton className="h-3 w-14 rounded" />
            <Skeleton className="h-[42px] w-full rounded-xl" />
          </div>
        </div>
      </div>

      {/* Empty content card */}
      <div className="bg-white border border-[#E2E8F0] rounded-2xl py-14 shadow-sm flex flex-col items-center gap-3">
        <Skeleton className="h-4 w-56 rounded" />
      </div>
    </div>
  );

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto w-full min-w-0">

      <PageLoadTransition showSkeleton={showPageSkeleton} skeleton={pageSkeleton}>

      {/* Page Header */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#1E3A5F]">Curriculum Setup</h1>
          <p className="text-sm mt-0.5 text-[#64748B]">Manage subjects per program, year level, and semester</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={handlePrint}
            disabled={!filters.program_id || curriculums.length === 0}
            title={
              !filters.program_id
                ? 'Select a program first'
                : curriculums.length === 0
                  ? 'No subjects to print'
                  : 'Print official NEMSU curriculum document'
            }
            className={btnSecondary}
          >
            <Printer className="w-4 h-4" /> Print Curriculum
          </button>
          <button
            onClick={handleDownload}
            disabled={!filters.program_id || filtered.length === 0}
            title={!filters.program_id ? 'Select a program first' : filtered.length === 0 ? 'No subjects to export' : 'Download in official curriculum format'}
            className={btnSecondary}
          >
            <Download className="w-4 h-4" /> Download Excel
          </button>
          <button
            onClick={openImport}
            className={btnSecondary}
          >
            <FileSpreadsheet className="w-4 h-4" /> Import Excel
          </button>
          <button
            onClick={() => setBulkOpen(true)}
            className={btnSecondary}
          >
            <Layers className="w-4 h-4" /> Bulk Add
          </button>
          <button
            onClick={openAdd}
            className={btnPrimary}
          >
            <Plus className="w-4 h-4" /> Add Subject
          </button>
        </div>
      </div>

      {/* Filters */}
      <FilterBar className="!px-5 !py-4 !mb-6">
        <div className="flex flex-wrap gap-4 items-end">

          {/* Program */}
          <div className="flex flex-col min-w-64 flex-1">
            <label className={filterLabelCls}>Program <span className="text-red-400">*</span></label>
            <FilterSelect
              value={filters.program_id}
              onChange={v => setFilters(f => ({ ...f, program_id: v, year_level: '', semester: '' }))}
              label="Program"
            >
              <option value="">— Select Program —</option>
              {programs.map(p => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}
            </FilterSelect>
          </div>

          {/* Curriculum version */}
          <div className="flex flex-col min-w-48">
            <label className={filterLabelCls}>Curriculum</label>
            <FilterSelect
              value={filters.curriculum_version}
              onChange={v => setFilters(f => ({
                ...f,
                curriculum_version: parseCurriculumVersion(v) ?? DEFAULT_CURRICULUM_VERSION,
              }))}
              label="Curriculum"
            >
              {CURRICULUM_VERSIONS.map(v => (
                <option key={v} value={v}>{curriculumVersionLabel(v)}</option>
              ))}
            </FilterSelect>
          </div>

          {/* Year Level */}
          <div className="flex flex-col min-w-44">
            <label className={filterLabelCls}>Year Level</label>
            <FilterSelect
              value={filters.year_level}
              onChange={v => setFilters(f => ({ ...f, year_level: v }))}
              disabled={!filters.program_id}
              label="Year Level"
            >
              <option value="">All Year Levels</option>
              {YEAR_LEVELS.map(y => <option key={y} value={y}>{y}</option>)}
            </FilterSelect>
          </div>

          {/* Semester */}
          <div className="flex flex-col min-w-44">
            <label className={filterLabelCls}>Semester</label>
            <FilterSelect
              value={filters.semester}
              onChange={v => setFilters(f => ({ ...f, semester: v }))}
              disabled={!filters.program_id}
              label="Semester"
            >
              <option value="">All Semesters</option>
              {SEMESTERS.map(s => <option key={s} value={s}>{s}</option>)}
            </FilterSelect>
          </div>

          {/* Search */}
          <div className="flex flex-col flex-1 min-w-52">
            <label className={filterLabelCls}>Search</label>
            <SearchInput
              value={filters.search}
              onChange={v => setFilters(f => ({ ...f, search: v }))}
              disabled={!filters.program_id}
              placeholder="Search code, name, or prerequisite…"
            />
          </div>

          {/* Clear Search */}
          {filters.program_id && filters.search && (
            <div className="flex flex-col">
              <label className="text-xs font-semibold uppercase tracking-wide text-transparent select-none mb-1.5">Clear</label>
              <button
                onClick={() => setFilters(f => ({ ...f, search: '' }))}
                className="flex items-center gap-1.5 text-sm border border-slate-200 rounded-xl px-4 py-2.5 text-slate-500 hover:border-slate-300 hover:text-slate-700 transition-all duration-150 bg-white"
              >
                <X className="w-3.5 h-3.5" /> Clear Search
              </button>
            </div>
          )}

        </div>

        {/* Active search pill */}
        {filters.search && (
          <div className="flex items-center gap-2 flex-wrap mt-3 pt-3 border-t border-slate-100">
            <span className="text-[11px] text-slate-400">Active search:</span>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-blue-50 text-xs font-semibold border border-blue-200 text-blue-600">
              &ldquo;{filters.search}&rdquo;
              <button onClick={() => setFilters(f => ({ ...f, search: '' }))} className="hover:opacity-70 transition-opacity">
                <X className="w-3 h-3" />
              </button>
            </span>
            <span className="text-[11px] text-slate-400">
              — {filtered.length} of {curriculums.length} subject{curriculums.length !== 1 ? 's' : ''} match
            </span>
          </div>
        )}
      </FilterBar>

      {/* Curriculum table */}
      <PageLoadTransition
        showSkeleton={showTableSkeleton}
        skeleton={<TableSkeleton rows={8} cols={7} />}
      >
      {!filters.program_id ? (
        <div className="bg-white border border-[#E2E8F0] rounded-2xl py-14 text-center shadow-sm">
          <p className="text-sm text-[#64748B]">No curriculum records found.</p>
        </div>
      ) : groups.length === 0 ? (
        <div className="bg-white border border-[#E2E8F0] rounded-2xl py-14 text-center shadow-sm">
          <p className="text-sm text-[#64748B]">
            {filters.search ? <>No subjects match &ldquo;{filters.search}&rdquo;.</> : 'No subjects found.'}
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map(group => {
            const totalLec   = group.subjects.reduce((s, c) => s + Number(c.lecture_hours), 0);
            const totalLab   = group.subjects.reduce((s, c) => s + Number(c.laboratory_hours), 0);
            const totalUnits = group.subjects.reduce((s, c) => s + parseFloat(String(c.units)), 0);
            return (
              <div key={group.key} className="bg-white rounded-xl border border-[#E2E8F0] overflow-hidden">
                <div className="bg-[#3C91E6] px-4 sm:px-6 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-bold text-base text-white leading-tight break-words">{group.program} — {group.programName}</div>
                    <div className="text-sm mt-0.5 font-medium text-white/85">{group.yearLevel} &nbsp;·&nbsp; {group.semester}</div>
                  </div>
                  <span className="self-start bg-white/20 text-white text-xs font-semibold px-3 py-1 rounded-full flex-shrink-0">
                    {group.subjects.length} subject{group.subjects.length !== 1 ? 's' : ''}
                  </span>
                </div>

                {/* Table on all viewports — horizontal scroll only inside this container */}
                <div className="overflow-x-auto overscroll-x-contain">
                  <table className="w-full text-sm min-w-[760px]">
                    <thead>
                      <tr className="border-b border-[color:var(--border-subtle)] bg-[#F8FAFC]">
                        <th className="text-center px-4 py-3 text-xs font-semibold uppercase tracking-wide w-10 text-[#4B5563]">#</th>
                        <th className="text-center px-4 py-3 text-xs font-semibold uppercase tracking-wide whitespace-nowrap min-w-[7.5rem] text-[#4B5563]">Course Code</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wide text-[#4B5563]">Descriptive Title</th>
                        <th className="text-center px-4 py-3 text-xs font-semibold uppercase tracking-wide w-20 text-[#4B5563]">Category</th>
                        <th className="text-center px-4 py-3 text-xs font-semibold uppercase tracking-wide w-20 text-[#4B5563]">Lec Hrs</th>
                        <th className="text-center px-4 py-3 text-xs font-semibold uppercase tracking-wide w-20 text-[#4B5563]">Lab Hrs</th>
                        <th className="text-center px-4 py-3 text-xs font-semibold uppercase tracking-wide w-24 text-[#4B5563]">Credit Units</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wide text-[#4B5563]">Pre-requisite(s)</th>
                        <th className="text-center px-4 py-3 text-xs font-semibold uppercase tracking-wide w-20 text-[#4B5563]">Grade</th>
                        <th className="text-center px-4 py-3 text-xs font-semibold uppercase tracking-wide w-24 text-[#4B5563]">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[color:var(--border-subtle)]">
                      {group.subjects.map((c, i) => (
                        <tr key={c.id} className="hover:bg-[#F8FAFC] transition-colors">
                          <td className="px-4 py-3 text-center text-xs text-[#94A3B8]">{i + 1}</td>
                          <td className="px-4 py-3 text-center whitespace-nowrap align-middle min-w-[7.5rem]">
                            <span className="inline-block font-mono font-semibold px-2.5 py-1 rounded text-xs border bg-[#EFF6FF] border-[#BFDBFE] text-[#3C91E6] whitespace-nowrap">
                              {c.subject_code}
                            </span>
                          </td>
                          <td className="px-4 py-3 font-medium text-[#1E3A5F]">{c.subject_name}</td>
                          <td className="px-4 py-3 text-center">
                            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                              categoryFromHours(c.lecture_hours, c.laboratory_hours) === 'Major'
                                ? 'bg-[#EFF6FF] text-[#3C91E6] border border-[#BFDBFE]'
                                : 'bg-[#F1F5F9] text-[#64748B] border border-[#E2E8F0]'
                            }`}>
                              {categoryFromHours(c.lecture_hours, c.laboratory_hours)}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-center text-[#64748B]">{Number(c.lecture_hours)}</td>
                          <td className="px-4 py-3 text-center text-[#64748B]">{Number(c.laboratory_hours)}</td>
                          <td className="px-4 py-3 text-center font-bold text-[#3C91E6]">{parseFloat(String(c.units)).toFixed(2)}</td>
                          <td className="px-4 py-3 text-sm">
                            {c.prerequisites
                              ? <span className="font-mono text-xs bg-[#F1F5F9] border border-[#E2E8F0] px-2 py-0.5 rounded text-[#64748B]">{c.prerequisites}</span>
                              : <span className="text-xs italic text-[#94A3B8]">—</span>}
                          </td>
                          <td className="px-4 py-3 text-center text-sm text-[#64748B]">
                            {c.grade || <span className="text-xs italic text-[#94A3B8]">—</span>}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center justify-center gap-1">
                              <button type="button" onClick={() => openEdit(c)} className="p-1.5 rounded-lg transition hover:bg-[#EFF6FF] text-[#3C91E6]" title="Edit">
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                              <button type="button" onClick={() => handleDelete(c.id)} className="p-1.5 rounded-lg transition hover:bg-red-50 text-[#EF4444]" title="Delete">
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-[color:var(--border)] bg-[#F8FAFC]">
                        <td colSpan={4} className="px-4 py-3 text-right">
                          <span className="text-xs font-bold uppercase tracking-widest text-[#4B5563]">TOTAL</span>
                        </td>
                        <td className="px-4 py-3 text-center font-bold text-[#1E3A5F]">{totalLec}</td>
                        <td className="px-4 py-3 text-center font-bold text-[#1E3A5F]">{totalLab}</td>
                        <td className="px-4 py-3 text-center font-bold text-base text-[#3C91E6]">{totalUnits.toFixed(2)}</td>
                        <td colSpan={3} className="px-4 py-3" />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            );
          })}
          <div className="flex items-center justify-between pr-1">
            <div className="flex items-center gap-2 flex-wrap">
              {/* Active filter pills */}
              {(filters.year_level || filters.semester) && (
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-xs text-[#94A3B8]">Showing:</span>
                  {filters.year_level
                    ? <span className="text-xs font-semibold px-2 py-0.5 rounded-full border text-[#3C91E6] border-[#BFDBFE] bg-[#EFF6FF]">{filters.year_level}</span>
                    : <span className="text-xs font-semibold px-2 py-0.5 rounded-full border text-[#64748B] border-[#E2E8F0] bg-[#F8FAFC]">All Year Levels</span>}
                  <span className="text-xs text-[#94A3B8]">·</span>
                  {filters.semester
                    ? <span className="text-xs font-semibold px-2 py-0.5 rounded-full border text-[#3C91E6] border-[#BFDBFE] bg-[#EFF6FF]">{filters.semester}</span>
                    : <span className="text-xs font-semibold px-2 py-0.5 rounded-full border text-[#64748B] border-[#E2E8F0] bg-[#F8FAFC]">All Semesters</span>}
                </div>
              )}
            </div>
            <span className="text-xs text-[#94A3B8]">
              {filtered.length} subject{filtered.length !== 1 ? 's' : ''}
              {groups.length > 1 ? ` across ${groups.length} sections` : ''}
            </span>
          </div>
        </div>
      )}
      </PageLoadTransition>
      </PageLoadTransition>

      {/* ── Bulk Add Modal ───────────────────────────────────────────────── */}
      {bulkOpen && (
        <BulkAddModal
          programs={programs}
          curriculumVersion={filters.curriculum_version}
          onClose={() => setBulkOpen(false)}
          onSaved={() => fetchCurriculums(filters.program_id, filters.year_level, filters.semester, filters.curriculum_version)}
        />
      )}

      {/* ── Add / Edit Modal ──────────────────────────────────────────────── */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editId ? 'Edit Subject' : 'Add Subject'}>
        <form onSubmit={handleSubmit} className="space-y-5">
          {formError && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">{formError}</div>
          )}
          <p className="text-sm" style={{ color: '#64748B' }}>
            {editId
              ? `This subject stays on ${curriculumVersionLabel(filters.curriculum_version)}.`
              : `This subject will be saved to ${curriculumVersionLabel(filters.curriculum_version)}.`}
          </p>

          <div>
            <label className="block text-sm font-semibold mb-1.5" style={{ color: '#64748B' }}>Program <span className="text-red-400">*</span></label>
            <select value={form.program_id} onChange={e => setForm(f => ({ ...f, program_id: e.target.value }))} required
              className={fieldCls} style={{ color: '#1E3A5F' }}>
              <option value="">— Select Program —</option>
              {programs.map(p => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-semibold mb-1.5" style={{ color: '#64748B' }}>Year Level <span className="text-red-400">*</span></label>
              <select value={form.year_level} onChange={e => setForm(f => ({ ...f, year_level: e.target.value }))} required
                className={fieldCls} style={{ color: '#1E3A5F' }}>
                <option value="">Select Year Level</option>
                {YEAR_LEVELS.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-semibold mb-1.5" style={{ color: '#64748B' }}>Semester <span className="text-red-400">*</span></label>
              <select value={form.semester} onChange={e => setForm(f => ({ ...f, semester: e.target.value }))} required
                className={fieldCls} style={{ color: '#1E3A5F' }}>
                <option value="">Select Semester</option>
                {SEMESTERS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-semibold mb-1.5" style={{ color: '#64748B' }}>Subject Type <span className="text-red-400">*</span></label>
            <div className="grid grid-cols-3 gap-2">
              {SUBJECT_TYPES.map(type => (
                <button key={type} type="button" onClick={() => handleSubjectTypeChange(type)}
                  className={`py-3.5 px-2 rounded-xl border-2 text-sm font-semibold transition-all text-center leading-snug
                    ${form.subject_type === type
                      ? 'border-[#3C91E6] bg-[#3C91E6] text-white'
                      : 'border-[#E2E8F0] bg-white hover:border-[#3C91E6]/50 hover:bg-[#EFF6FF]'}`}
                  style={form.subject_type !== type ? { color: '#64748B' } : {}}>
                  {type}
                  <div className={`text-xs font-normal mt-0.5 ${form.subject_type === type ? 'text-blue-100' : ''}`}
                    style={form.subject_type !== type ? { color: '#94A3B8' } : {}}>
                    {type === 'Lecture' && 'Lecture hours only'}
                    {type === 'Laboratory' && 'Lab hours only'}
                    {type === 'Lecture + Laboratory' && 'Both hours'}
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-semibold mb-1.5" style={{ color: '#64748B' }}>Subject Category</label>
            <div className="grid grid-cols-2 gap-2">
              {(['Minor', 'Major'] as const).map(cat => {
                const active = form.subject_type
                  ? categoryFromSubjectType(form.subject_type) === cat
                  : false;
                return (
                  <div
                    key={cat}
                    aria-disabled="true"
                    className={`py-3.5 px-2 rounded-xl border-2 text-sm font-semibold text-center leading-snug cursor-default
                      ${active
                        ? 'border-[#3C91E6] bg-[#3C91E6] text-white'
                        : 'border-[#E2E8F0] bg-[#F8FAFC]'}`}
                    style={!active ? { color: '#94A3B8' } : {}}
                  >
                    {cat}
                    <div className={`text-xs font-normal mt-0.5 ${active ? 'text-blue-100' : ''}`}
                      style={!active ? { color: '#CBD5E1' } : {}}>
                      {cat === 'Minor' ? 'Lecture only' : 'Laboratory / Lecture + Laboratory'}
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="text-xs mt-1.5" style={{ color: '#94A3B8' }}>
              {form.subject_type
                ? `${categoryFromSubjectType(form.subject_type)} — automatically determined from Subject Type`
                : 'Select a Subject Type to set the category automatically.'}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-semibold mb-1.5" style={{ color: '#64748B' }}>Course Code <span className="text-red-400">*</span></label>
              <input type="text" value={form.subject_code} onChange={e => setForm(f => ({ ...f, subject_code: e.target.value }))} required
                placeholder="e.g., IT 111" className={fieldCls} style={{ color: '#1E3A5F' }} />
            </div>
            <div>
              <label className="block text-sm font-semibold mb-1.5" style={{ color: '#64748B' }}>Subject Name <span className="text-red-400">*</span></label>
              <input type="text" value={form.subject_name} onChange={e => setForm(f => ({ ...f, subject_name: e.target.value }))} required
                placeholder="e.g., Introduction to Computing" className={fieldCls} style={{ color: '#1E3A5F' }} />
            </div>
          </div>

          {form.subject_type === 'Lecture' && (
            <div>
              <label className="block text-sm font-semibold mb-1.5" style={{ color: '#64748B' }}>Lecture Hours <span className="text-red-400">*</span></label>
              <input type="number" min="0" step="0.5" value={form.lecture_hours} placeholder="e.g., 3"
                onChange={e => setForm(f => ({ ...f, lecture_hours: e.target.value }))}
                className={fieldCls} style={{ color: '#1E3A5F' }} />
              <p className="text-xs mt-1" style={{ color: '#94A3B8' }}>Laboratory Hours set to 0 automatically.</p>
            </div>
          )}
          {form.subject_type === 'Laboratory' && (
            <div>
              <label className="block text-sm font-semibold mb-1.5" style={{ color: '#64748B' }}>Laboratory Hours <span className="text-red-400">*</span></label>
              <input type="number" min="0" step="0.5" value={form.laboratory_hours} placeholder="e.g., 3"
                onChange={e => setForm(f => ({ ...f, laboratory_hours: e.target.value }))}
                className={fieldCls} style={{ color: '#1E3A5F' }} />
              <p className="text-xs mt-1" style={{ color: '#94A3B8' }}>Lecture Hours set to 0 automatically.</p>
            </div>
          )}
          {form.subject_type === 'Lecture + Laboratory' && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-semibold mb-1.5" style={{ color: '#64748B' }}>Lecture Hours <span className="text-red-400">*</span></label>
                <input type="number" min="0" step="0.5" value={form.lecture_hours} placeholder="e.g., 2"
                  onChange={e => setForm(f => ({ ...f, lecture_hours: e.target.value }))}
                  className={fieldCls} style={{ color: '#1E3A5F' }} />
              </div>
              <div>
                <label className="block text-sm font-semibold mb-1.5" style={{ color: '#64748B' }}>Laboratory Hours <span className="text-red-400">*</span></label>
                <input type="number" min="0" step="0.5" value={form.laboratory_hours} placeholder="e.g., 3"
                  onChange={e => setForm(f => ({ ...f, laboratory_hours: e.target.value }))}
                  className={fieldCls} style={{ color: '#1E3A5F' }} />
              </div>
            </div>
          )}

          <div>
            <label className="block text-sm font-semibold mb-1.5" style={{ color: '#64748B' }}>Credit Units <span className="text-red-400">*</span></label>
            <input type="number" min="0" step="0.5" value={form.units} placeholder="e.g., 3"
              onChange={e => setForm(f => ({ ...f, units: e.target.value }))}
              className={fieldCls} style={{ color: '#1E3A5F' }} />
            <p className="text-xs mt-1" style={{ color: '#94A3B8' }}>Official credit units from the curriculum sheet.</p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-semibold mb-1.5" style={{ color: '#64748B' }}>Pre-requisite(s)</label>
              <input type="text" value={form.prerequisites} onChange={e => setForm(f => ({ ...f, prerequisites: e.target.value }))}
                placeholder="e.g., IT 111 or leave blank" className={fieldCls} style={{ color: '#1E3A5F' }} />
              <p className="text-xs mt-1" style={{ color: '#94A3B8' }}>Leave blank if none.</p>
            </div>
            <div>
              <label className="block text-sm font-semibold mb-1.5" style={{ color: '#64748B' }}>Grade</label>
              <input type="text" value={form.grade} onChange={e => setForm(f => ({ ...f, grade: e.target.value }))}
                placeholder="e.g., 75 or leave blank" className={fieldCls} style={{ color: '#1E3A5F' }} />
              <p className="text-xs mt-1" style={{ color: '#94A3B8' }}>Minimum prerequisite grade. Leave blank if none.</p>
            </div>
          </div>

          {form.subject_type && (
            <div className="bg-[#EFF6FF] rounded-xl px-4 py-3.5 border border-[#BFDBFE]">
              <div className="text-xs font-bold uppercase tracking-wide mb-0.5" style={{ color: '#3C91E6' }}>Total Contact Hours (auto-calculated)</div>
              <div className="text-2xl font-bold" style={{ color: '#1E3A5F' }}>{(lec + lab).toFixed(2)} <span className="text-base font-normal" style={{ color: '#64748B' }}>hrs</span></div>
              <div className="text-xs mt-0.5" style={{ color: '#64748B' }}>Lec {lec} + Lab {lab}</div>
            </div>
          )}

          <div className="flex gap-3 pt-1">
            <button type="button" onClick={() => setModalOpen(false)}
              className="flex-1 border border-[#E2E8F0] py-2.5 rounded-xl hover:bg-[#F8FAFC] transition text-sm font-semibold"
              style={{ color: '#64748B' }}>Cancel</button>
            <button type="submit" disabled={loading}
              className="flex-1 text-white py-2.5 rounded-xl disabled:opacity-50 transition text-sm font-semibold hover:opacity-90"
              style={{ backgroundColor: '#3C91E6' }}>
              {loading ? 'Saving…' : editId ? 'Update Subject' : 'Add Subject'}
            </button>
          </div>
        </form>
      </Modal>

      {/* ── Excel Import Modal ─────────────────────────────────────────────── */}
      {importOpen && (
        <div
          className="fixed inset-0 z-50 overflow-hidden bg-slate-900/40 backdrop-blur-[2px]"
          onClick={closeImport}
          onKeyDown={e => { if (e.key === 'Escape') closeImport(); }}
          tabIndex={-1}
          role="presentation"
          data-modal-root
        >
          <div className="absolute inset-3 sm:inset-4 flex min-h-0 items-center justify-center">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="import-curriculum-title"
            className={`bg-white border border-[#E2E8F0] rounded-3xl shadow-[0_28px_64px_-28px_rgba(30,58,95,0.35)] w-full max-w-5xl min-h-0 max-h-full overflow-hidden ${
              importStep === 'preview'
                ? 'grid h-full grid-rows-[auto_auto_minmax(0,1fr)_auto]'
                : 'flex flex-col'
            }`}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 px-6 py-5 flex-shrink-0 border-b border-[#EEF2F7] bg-[linear-gradient(180deg,#F8FBFF_0%,#FFFFFF_100%)]">
              <div className="flex items-start gap-3 min-w-0">
                <div className="w-11 h-11 rounded-2xl bg-[#EFF6FF] text-[#3C91E6] ring-1 ring-[#BFDBFE] flex items-center justify-center shrink-0">
                  <FileSpreadsheet className="w-5 h-5" />
                </div>
                <div className="min-w-0">
                  <h2 id="import-curriculum-title" className="text-lg font-bold tracking-tight" style={{ color: '#1E3A5F' }}>Import curriculum</h2>
                  <p className="text-sm mt-0.5 truncate" style={{ color: '#64748B' }}>
                    {importStep === 'upload'  && (selectedProg ? `${selectedProg.code} — ${selectedProg.name}` : 'Program can be detected from course codes')}
                    {importStep === 'preview' && `${previewRows.length} subjects ready for review`}
                    {importStep === 'done'    && 'Import finished'}
                  </p>
                </div>
              </div>
              <button onClick={closeImport} className="p-2 rounded-xl text-[#94A3B8] hover:text-[#1E3A5F] hover:bg-[#F1F5F9] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3C91E6] focus-visible:ring-offset-2" aria-label="Close">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="px-6 py-4 flex-shrink-0 bg-white">
              <div className="flex items-center">
                {([
                  { k: 'upload', label: 'Upload' },
                  { k: 'preview', label: 'Review' },
                  { k: 'done', label: 'Done' },
                ] as const).map((step, i, all) => {
                  const order = { upload: 0, preview: 1, done: 2 } as const;
                  const current = order[importStep];
                  const done = i < current;
                  const active = i === current;
                  return (
                    <div key={step.k} className="flex items-center flex-1 last:flex-none">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className={`w-8 h-8 rounded-full text-xs font-bold flex items-center justify-center shrink-0 transition shadow-sm ${
                          done ? 'bg-[#10B981] text-white'
                            : active ? 'bg-[#3C91E6] text-white ring-4 ring-[#DBEAFE]'
                            : 'bg-[#F1F5F9] text-[#94A3B8]'
                        }`}>
                          {done ? <CheckCircle className="w-4 h-4" /> : i + 1}
                        </span>
                        <span className={`text-sm font-semibold hidden sm:block ${
                          active ? 'text-[#1E3A5F]' : done ? 'text-[#047857]' : 'text-[#94A3B8]'
                        }`}>
                          {step.label}
                        </span>
                      </div>
                      {i < all.length - 1 && (
                        <div className={`h-0.5 flex-1 mx-3 rounded-full ${i < current ? 'bg-[#6EE7B7]' : 'bg-[#E2E8F0]'}`} />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className={`min-h-0 px-6 ${
              importStep === 'preview' ? 'flex flex-col overflow-hidden' : 'flex-1 overflow-y-auto overscroll-contain pb-2'
            }`}>

              {importStep === 'upload' && (
                <div className="space-y-4">
                  <button
                    type="button"
                    onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={handleDrop}
                    onClick={() => !importParsing && fileInputRef.current?.click()}
                    disabled={importParsing}
                    className={`w-full rounded-2xl border-2 border-dashed px-6 py-8 text-center transition duration-200 ${
                      importParsing
                        ? 'border-[#E2E8F0] bg-[#F8FAFC] cursor-wait'
                        : dragOver
                          ? 'border-[#3C91E6] bg-[#EFF6FF] scale-[1.01] shadow-sm'
                          : 'border-[#E2E8F0] bg-[#F8FAFC] hover:border-[#3C91E6] hover:bg-[#EFF6FF]/70 cursor-pointer'
                    }`}
                  >
                    <div className={`w-14 h-14 mx-auto mb-4 rounded-2xl flex items-center justify-center ${dragOver || importParsing ? 'bg-[#DBEAFE] text-[#3C91E6]' : 'bg-white text-[#94A3B8] shadow-sm ring-1 ring-[#E2E8F0]'}`}>
                      {importParsing
                        ? <div className="w-6 h-6 border-2 border-[#3C91E6] border-t-transparent rounded-full animate-spin" />
                        : <Upload className="w-6 h-6" />}
                    </div>
                    <p className="text-base font-semibold" style={{ color: '#1E3A5F' }}>
                      {importParsing ? 'Reading workbook…' : dragOver ? 'Drop file to upload' : 'Drop your Excel file here'}
                    </p>
                    <p className="text-sm text-[#64748B] mt-1">
                      {importParsing ? 'Detecting headers, subjects, and year sections' : 'or click to browse from your computer'}
                    </p>
                    <div className="mt-4 flex items-center justify-center gap-2">
                      <span className="px-2.5 py-1 rounded-lg bg-white border border-[#E2E8F0] text-[11px] font-semibold text-[#64748B]">.xlsx</span>
                      <span className="px-2.5 py-1 rounded-lg bg-white border border-[#E2E8F0] text-[11px] font-semibold text-[#64748B]">.xls</span>
                      <span className="text-[11px] text-[#94A3B8]">up to 8 MB</span>
                    </div>
                    <input ref={fileInputRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleFileChange} />
                  </button>

                  <div className="rounded-2xl border border-[#E2E8F0] bg-white overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setFormatGuideOpen(o => !o)}
                      className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-[#F8FAFC] transition"
                    >
                      <span className="flex items-center gap-2 text-sm font-semibold text-[#1E3A5F]">
                        <Info className="w-4 h-4 text-[#3C91E6]" />
                        What the file can look like
                      </span>
                      <ChevronDown className={`w-4 h-4 text-[#94A3B8] transition ${formatGuideOpen ? 'rotate-180' : ''}`} />
                    </button>
                    {formatGuideOpen && (
                      <div className="px-4 pb-4 space-y-3 border-t border-[#EEF2F7]">
                        <p className="text-xs text-[#64748B] pt-3">
                          Column names can vary. Year and semester can be a heading or a column. TOTAL rows are ignored.
                        </p>
                        <div className="overflow-x-auto rounded-xl border border-[#E2E8F0]">
                          <table className="text-[11px] w-full">
                            <thead className="bg-[#1E3A5F] text-white/80">
                              <tr>
                                {['Year / Semester', 'Course Code', 'Title', 'Lec', 'Lab', 'Units'].map(h => (
                                  <th key={h} className="text-left font-semibold px-3 py-2 whitespace-nowrap">{h}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody className="text-[#475569]">
                              <tr className="border-t border-[#F1F5F9]">
                                <td className="px-3 py-1.5">FIRST YEAR — First Semester</td>
                                <td className="px-3 py-1.5 font-semibold text-[#1E3A5F]">CS 111</td>
                                <td className="px-3 py-1.5">Introduction to Computing</td>
                                <td className="px-3 py-1.5">2</td>
                                <td className="px-3 py-1.5">3</td>
                                <td className="px-3 py-1.5">3</td>
                              </tr>
                              <tr className="border-t border-[#F1F5F9] bg-[#F8FAFC]">
                                <td className="px-3 py-1.5">FIRST YEAR — First Semester</td>
                                <td className="px-3 py-1.5 font-semibold text-[#1E3A5F]">GE-US</td>
                                <td className="px-3 py-1.5">Understanding the Self</td>
                                <td className="px-3 py-1.5">3</td>
                                <td className="px-3 py-1.5">0</td>
                                <td className="px-3 py-1.5">3</td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                        <div className="grid sm:grid-cols-3 gap-2 text-[11px] text-[#64748B]">
                          <div className="rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] px-3 py-2">Nothing is saved until you confirm.</div>
                          <div className="rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] px-3 py-2">Existing subjects are compared, not duplicated.</div>
                          <div className="rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] px-3 py-2">Program can be inferred from CS, IT, and similar codes.</div>
                        </div>
                      </div>
                    )}
                  </div>

                  {importDiagnostic && previewRows.length === 0 && (
                    <div className="rounded-2xl border border-amber-200 bg-amber-50/80 p-4 text-sm text-amber-900">
                      <h3 className="font-semibold text-slate-800 mb-2">Could not find subject rows</h3>
                      <p className="text-amber-800/90 mb-3">{importDiagnostic.reason}</p>
                      <div className="grid sm:grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-600">
                        <p><span className="font-medium text-slate-700">File</span> — {importDiagnostic.fileName}</p>
                        <p><span className="font-medium text-slate-700">Sheets</span> — {importDiagnostic.sheetNames.join(', ') || 'none'}</p>
                        <p><span className="font-medium text-slate-700">Curriculum sheet</span> — {importDiagnostic.selectedSheets.join(', ') || 'none'}</p>
                        <p><span className="font-medium text-slate-700">Header</span> — {importDiagnostic.headerRow ? `Row ${importDiagnostic.headerRow}` : 'none'}</p>
                        <p><span className="font-medium text-slate-700">Rows inspected</span> — {importDiagnostic.rowsInspected}</p>
                        <p><span className="font-medium text-slate-700">Subjects</span> — {importDiagnostic.potentialSubjectRows}</p>
                      </div>
                      <p className="text-xs mt-3 text-slate-600">{importDiagnostic.suggestedAction}</p>
                    </div>
                  )}
                </div>
              )}

              {/* ── Step 2: Preview ── */}
              {importStep === 'preview' && (
                <div className="flex flex-col flex-1 min-h-0 gap-3 pt-0.5">
                  <div className="min-h-0 max-h-[32%] overflow-y-auto overscroll-contain space-y-3 pr-0.5">
                  <div className="rounded-2xl border border-[#E2E8F0] bg-[#F8FAFC] p-2">
                    <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5">
                    {[
                      { n: previewRows.length, l: 'Detected', tone: 'text-[#1E3A5F] bg-white border-[#E2E8F0]' },
                      { n: newCount, l: 'New', tone: 'text-[#047857] bg-[#ECFDF5] border-[#A7F3D0]' },
                      { n: existingCount, l: 'Existing', tone: 'text-[#475569] bg-white border-[#E2E8F0]' },
                      { n: changedCount, l: 'Changed', tone: 'text-[#B45309] bg-[#FFFBEB] border-[#FDE68A]' },
                      { n: duplicateCount, l: 'Duplicates', tone: 'text-[#C2410C] bg-[#FFF7ED] border-[#FED7AA]' },
                      { n: errorCount, l: 'Invalid', tone: errorCount > 0 ? 'text-[#B91C1C] bg-[#FEF2F2] border-[#FECACA]' : 'text-[#94A3B8] bg-white border-[#E2E8F0]' },
                    ].map(card => (
                      <div key={card.l} className={`rounded-xl border px-2 py-3 text-center transition hover:shadow-sm ${card.tone}`}>
                        <div className="text-xl font-bold tabular-nums leading-none">{card.n}</div>
                        <div className="text-[10px] font-semibold uppercase tracking-wide mt-1.5 opacity-80">{card.l}</div>
                      </div>
                    ))}
                    </div>
                  </div>

                  {importProgramDetection && (
                    <div className={`rounded-2xl px-4 py-3.5 border-l-4 ${
                      importProgramMismatch
                        ? 'bg-[#FEF2F2] border border-[#FECACA] border-l-[#EF4444]'
                        : 'bg-white border border-[#E2E8F0] border-l-[#3C91E6]'
                    }`}>
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#94A3B8]">Detected program</div>
                          <div className="text-sm font-bold mt-0.5" style={{ color: '#1E3A5F' }}>
                            {importProgramDetection.program
                              ? `${importProgramDetection.program.code} — ${importProgramDetection.program.name}`
                              : 'Not enough evidence to map a program'}
                          </div>
                          <p className="text-xs text-[#64748B] mt-1">{importProgramDetection.reason}</p>
                        </div>
                        <span className={`px-2.5 py-1 rounded-full text-[11px] font-semibold border ${
                          importProgramDetection.confidence === 'high' ? 'bg-[#ECFDF5] text-[#047857] border-[#A7F3D0]'
                            : importProgramDetection.confidence === 'medium' ? 'bg-[#FFFBEB] text-[#B45309] border-[#FDE68A]'
                            : 'bg-[#F8FAFC] text-[#64748B] border-[#E2E8F0]'
                        }`}>
                          {importProgramDetection.confidence === 'high' ? 'High confidence' : importProgramDetection.confidence === 'medium' ? 'Medium' : importProgramDetection.confidence === 'low' ? 'Low' : 'No match'}
                        </span>
                      </div>
                      {importProgramMismatch && selectedProg && importProgramDetection.program && (
                        <div className="mt-3 pt-3 border-t border-[#FECACA] text-sm text-[#B91C1C] space-y-2">
                          <p>Selected program is {selectedProg.code}, but this file looks like {importProgramDetection.program.code}. Confirm is paused until you choose.</p>
                          <button
                            type="button"
                            onClick={() => { void applyDetectedProgram(); }}
                            className="px-3 py-1.5 rounded-xl text-xs font-semibold text-white bg-[#3C91E6] hover:bg-[#2563EB] transition"
                          >
                            Use {importProgramDetection.program.code}
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  {importMappings.length > 0 && (
                    <div className="rounded-2xl border border-[#E2E8F0] bg-white px-4 py-3">
                      <h3 className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#94A3B8] mb-2.5">Column mapping</h3>
                      <div className="flex flex-wrap gap-2">
                        {importMappings.map(mapping => (
                          <div key={`${mapping.field}-${mapping.columnIndex}`} className="rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-xs hover:border-[#BFDBFE] hover:bg-[#EFF6FF] transition">
                            <div className="text-[#94A3B8]">{mapping.excelHeader || '(blank)'}</div>
                            <div className="font-semibold text-[#1E3A5F]">{mapping.label}</div>
                            <div className={mapping.strength === 'possible' ? 'text-[#B45309]' : 'text-[#047857]'}>
                              {mapping.confidence}% {mapping.strength === 'exact' ? 'exact' : mapping.strength === 'alias' ? 'alias' : 'review'}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {(errorCount > 0 || changedCount > 0 || duplicateCount > 0) && (
                    <div className="rounded-2xl border border-[#FDE68A] bg-[#FFFBEB] px-4 py-3 flex items-start gap-3 text-sm text-[#92400E]">
                      <AlertTriangle className="w-4 h-4 text-[#D97706] flex-shrink-0 mt-0.5" />
                      <div>
                        {changedCount > 0 && <p>{changedCount} changed subject{changedCount !== 1 ? 's' : ''} will update only after you confirm.</p>}
                        {duplicateCount > 0 && <p>Possible duplicates will not be imported automatically.</p>}
                        {errorCount > 0 && <p>{errorCount} invalid row{errorCount !== 1 ? 's' : ''} will be skipped.</p>}
                      </div>
                    </div>
                  )}

                  {validCount === 0 && (
                    <div className="rounded-2xl border border-[#FECACA] bg-[#FEF2F2] px-4 py-3 flex items-start gap-3 text-sm text-[#B91C1C]">
                      <AlertTriangle className="w-4 h-4 text-[#EF4444] flex-shrink-0 mt-0.5" />
                      <p>No valid rows to import. Check the issues column below.</p>
                    </div>
                  )}
                  </div>

                  {previewGroups.length > 0 && (
                    <div className="shrink-0 flex gap-2 overflow-x-auto overscroll-x-contain pb-0.5">
                      {previewGroups.map(g => (
                        <div key={g.key} className="inline-flex items-center gap-2 shrink-0 rounded-full border border-[#DBEAFE] bg-[#EFF6FF] px-3 py-1.5 text-xs text-[#334155]">
                          <span className="font-semibold text-[#1E3A5F]">{g.yearLevel} · {g.semester}</span>
                          <span className="min-w-[1.25rem] h-5 px-1.5 rounded-full bg-white text-[#3C91E6] font-bold tabular-nums text-center leading-5">{g.rows.length}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex-1 min-h-0 flex flex-col rounded-2xl border border-[#E2E8F0] overflow-hidden bg-white">
                    <div className="flex-1 min-h-0 overflow-auto overscroll-contain">
                      <table className="w-full text-xs">
                        <thead className="sticky top-0 z-10 bg-[#1E3A5F]">
                          <tr>
                            {['Row', 'Status', 'Year', 'Semester', 'Course Code', 'Descriptive Title', 'Lec', 'Lab', 'Units', 'Prerequisites', 'Issues'].map(h => (
                              <th key={h} className="text-left px-3 py-2.5 font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#F1F5F9]">
                          {previewRows.map(row => {
                            const meta = importStatusMeta(row.status);
                            return (
                            <tr key={`${row._rowNum}-${row.subject_code}`} className={row.status === 'invalid' ? 'bg-[#FEF2F2]' : row.status === 'changed' || row.status === 'possible' ? 'bg-[#FFFBEB]/80' : 'hover:bg-[#F8FAFC]'}>
                              <td className="px-3 py-2.5 font-mono text-[#94A3B8]">{row._rowNum}</td>
                              <td className="px-3 py-2.5 whitespace-nowrap">
                                <span className={`inline-flex px-2 py-0.5 rounded-full border text-[11px] font-semibold ${meta.className}`}>{meta.label}</span>
                              </td>
                              <td className="px-3 py-2.5 whitespace-nowrap text-[#64748B]">{row.year_level || <span className="text-red-500 italic">missing</span>}</td>
                              <td className="px-3 py-2.5 whitespace-nowrap text-[#64748B]">{row.semester || <span className="text-red-500 italic">missing</span>}</td>
                              <td className="px-3 py-2.5 font-mono font-semibold whitespace-nowrap text-[#1E3A5F]">{row.subject_code}</td>
                              <td className="px-3 py-2.5 max-w-[180px] truncate text-[#475569]" title={row.subject_name}>{row.subject_name}</td>
                              <td className="px-3 py-2.5 text-center text-[#64748B]">{row.lecture_hours}</td>
                              <td className="px-3 py-2.5 text-center text-[#64748B]">{row.laboratory_hours}</td>
                              <td className="px-3 py-2.5 text-center font-semibold text-[#3C91E6]">{row.credit_units > 0 ? row.credit_units.toFixed(2) : <span className="italic text-[#CBD5E1]">—</span>}</td>
                              <td className="px-3 py-2.5 max-w-[110px] truncate text-[#64748B]" title={row.prerequisites}>{row.prerequisites || '—'}</td>
                              <td className="px-3 py-2.5 min-w-[200px]">
                                {row.changes.length > 0 && (
                                  <ul className="space-y-0.5 mb-1">
                                    {row.changes.map((change, i) => (
                                      <li key={i} className="text-[#B45309]">
                                        {change.field}: {change.from} → {change.to}
                                      </li>
                                    ))}
                                  </ul>
                                )}
                                {row.errors.length > 0 && (
                                  <ul className="space-y-0.5">
                                    {row.errors.map((err, i) => (
                                      <li key={i} className="text-[#B91C1C] flex items-start gap-1">
                                        <span className="flex-shrink-0">•</span>{err}
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </td>
                            </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}

              {/* ── Step 3: Done ── */}
              {importStep === 'done' && importResult && (
                <div className="flex flex-col items-center justify-center py-8 space-y-5">
                  <div className={`w-16 h-16 rounded-2xl flex items-center justify-center ${importResult.total > 0 ? 'bg-[#ECFDF5] text-[#059669] ring-1 ring-[#A7F3D0]' : 'bg-[#FFFBEB] text-[#D97706] ring-1 ring-[#FDE68A]'}`}>
                    <CheckCircle className="w-8 h-8" />
                  </div>
                  <div className="text-center">
                    <h3 className="text-xl font-bold" style={{ color: '#1E3A5F' }}>
                      {importResult.total > 0 ? 'Curriculum imported' : 'Import complete'}
                    </h3>
                    <p className="text-sm text-[#64748B] mt-1">
                      {importResult.total > 0 ? 'The subject list has been refreshed.' : 'No new records were added.'}
                    </p>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 w-full">
                    {[
                      { n: importResult.imported, l: 'New', tone: 'text-[#047857] bg-[#ECFDF5] border-[#A7F3D0]' },
                      { n: importResult.updated, l: 'Updated', tone: 'text-[#B45309] bg-[#FFFBEB] border-[#FDE68A]' },
                      { n: importResult.reactivated, l: 'Restored', tone: 'text-[#2563EB] bg-[#EFF6FF] border-[#BFDBFE]' },
                      { n: importResult.duplicated, l: 'Already there', tone: 'text-[#475569] bg-[#F8FAFC] border-[#E2E8F0]' },
                      { n: importResult.errors.length, l: 'Errors', tone: importResult.errors.length > 0 ? 'text-[#B91C1C] bg-[#FEF2F2] border-[#FECACA]' : 'text-[#94A3B8] bg-[#F8FAFC] border-[#E2E8F0]' },
                    ].map(card => (
                      <div key={card.l} className={`rounded-2xl border px-2 py-3 text-center ${card.tone}`}>
                        <div className="text-2xl font-bold tabular-nums">{card.n}</div>
                        <div className="text-[11px] font-semibold mt-0.5 opacity-80">{card.l}</div>
                      </div>
                    ))}
                  </div>
                  {importResult.duplicated > 0 && importResult.total === 0 && importResult.errors.length === 0 && (
                    <div className="bg-[#EFF6FF] border border-[#BFDBFE] rounded-2xl p-4 w-full max-w-lg text-sm text-center space-y-1" style={{ color: '#3C91E6' }}>
                      <p className="font-semibold" style={{ color: '#1E3A5F' }}>All {importResult.duplicated} subject{importResult.duplicated !== 1 ? 's' : ''} already exist and are active.</p>
                      <p className="text-xs" style={{ color: '#64748B' }}>Scroll down in the Curriculum Setup table — they are visible under the correct Program, Year Level, and Semester.</p>
                    </div>
                  )}
                  {importResult.reactivated > 0 && (
                    <div className="bg-[#ECFDF5] border border-[#A7F3D0] rounded-2xl p-4 w-full max-w-lg text-sm text-center text-[#047857]">
                      <p className="font-semibold">{importResult.reactivated} previously deleted subject{importResult.reactivated !== 1 ? 's were' : ' was'} restored and made active again.</p>
                    </div>
                  )}
                  {importResult.errors.length > 0 && (
                    <div className="bg-[#FEF2F2] border border-[#FECACA] rounded-2xl p-4 w-full max-w-2xl">
                      <p className="text-sm font-semibold text-[#B91C1C] mb-2">{importResult.errors.length} row(s) failed:</p>
                      <ul className="space-y-1 text-xs text-[#B91C1C] max-h-32 overflow-y-auto">
                        {importResult.errors.map((e, i) => <li key={i}>• {e}</li>)}
                      </ul>
                    </div>
                  )}
                  {importResult.total > 0 && (
                    <p className="text-sm text-center text-[#64748B]">
                      The subject list has been refreshed.
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-6 py-3 border-t border-[#E2E8F0] flex flex-col-reverse sm:flex-row sm:justify-between sm:items-center gap-3 bg-[#F8FAFC] z-20">
              {importStep === 'upload' && (
                <>
                  <p className="text-sm text-[#94A3B8] text-center sm:text-left">Nothing is written to the database on upload.</p>
                  <button
                    type="button"
                    onClick={closeImport}
                    className="min-h-11 px-4 py-2 rounded-xl border border-[#E2E8F0] bg-white text-sm font-semibold text-[#475569] hover:border-[#3C91E6] hover:text-[#3C91E6] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3C91E6] focus-visible:ring-offset-2"
                  >
                    Cancel
                  </button>
                </>
              )}
              {importStep === 'preview' && (
                <>
                  <button
                    type="button"
                    onClick={() => { resetImportState(); }}
                    className="min-h-11 w-full sm:w-auto px-4 py-2 rounded-xl border border-[#E2E8F0] bg-white text-sm font-semibold text-[#475569] hover:border-[#3C91E6] hover:text-[#3C91E6] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3C91E6] focus-visible:ring-offset-2">
                    Back to upload
                  </button>
                  <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:gap-3 w-full sm:w-auto">
                    <span className="text-sm text-[#64748B] text-center sm:text-right">{validCount} will be saved</span>
                    <button
                      type="button"
                      onClick={handleConfirmImport}
                      disabled={importLoading || validCount === 0 || importProgramMismatch}
                      className="min-h-11 w-full sm:w-auto px-5 py-2.5 text-white rounded-xl disabled:opacity-50 disabled:cursor-not-allowed transition text-sm font-semibold flex items-center justify-center gap-2 bg-[#3C91E6] hover:bg-[#2563EB] shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3C91E6] focus-visible:ring-offset-2"
                    >
                      {importLoading
                        ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Saving…</>
                        : <><CheckCircle className="w-4 h-4" /> Confirm import</>}
                    </button>
                  </div>
                </>
              )}
              {importStep === 'done' && (
                <div className="flex flex-col-reverse sm:flex-row gap-2 w-full sm:w-auto sm:ml-auto">
                  <button
                    type="button"
                    onClick={openImport}
                    className="min-h-11 w-full sm:w-auto px-4 py-2 rounded-xl border border-[#E2E8F0] bg-white text-sm font-semibold text-[#475569] hover:border-[#3C91E6] hover:text-[#3C91E6] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3C91E6] focus-visible:ring-offset-2"
                  >
                    Import another
                  </button>
                  <button
                    type="button"
                    onClick={closeImport}
                    className="min-h-11 w-full sm:w-auto px-4 py-2 rounded-xl text-sm font-semibold text-white bg-[#3C91E6] hover:bg-[#2563EB] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3C91E6] focus-visible:ring-offset-2"
                  >
                    Close
                  </button>
                </div>
              )}
            </div>
          </div>
          </div>
        </div>
      )}
    </div>
  );
}

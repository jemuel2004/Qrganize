'use client';

import {
  useRef, useState, useCallback,
  type KeyboardEvent, type ClipboardEvent,
} from 'react';
import {
  Plus, Trash2, Copy, Save, X, AlertTriangle, CheckCircle,
  ChevronDown, AlertCircle, Loader2, GripVertical, Info,
} from 'lucide-react';
import { useToast } from '@/context/ToastContext';
import { useScrollLock } from '@/hooks/useScrollLock';
import { categoryFromHours, categoryFromSubjectType, type SubjectCategory } from '@shared/subjectCategory';
import { curriculumVersionLabel, type CurriculumVersion } from '@shared/curriculumVersion';

/* ─── Types ──────────────────────────────────────────────────── */
interface Program { id: number; code: string; name: string; }

type SubjectType = 'Lecture' | 'Laboratory' | 'Lecture + Laboratory' | '';

interface BulkRow {
  _id: string;
  program_id: string;
  year_level: string;
  semester: string;
  subject_type: SubjectType;
  subject_category: SubjectCategory | '';
  subject_code: string;
  subject_name: string;
  units: string;
  lecture_hours: string;
  laboratory_hours: string;
  prerequisites: string;
  grade: string;
  errors: string[];
  valid: boolean;
  saved?: boolean;
  saveError?: string;
}

interface BulkAddModalProps {
  programs: Program[];
  curriculumVersion: CurriculumVersion;
  onClose: () => void;
  onSaved: () => void;
}

interface SaveResult {
  imported: number;
  reactivated: number;
  duplicated: number;
  errors: string[];
  total: number;
}

/* ─── Constants ──────────────────────────────────────────────── */
const YEAR_LEVELS  = ['1st Year', '2nd Year', '3rd Year', '4th Year'];
const SEMESTERS    = ['1st Semester', '2nd Semester', 'Summer'];
const SUBJECT_TYPES: SubjectType[] = ['Lecture', 'Laboratory', 'Lecture + Laboratory'];
const MAX_ROWS     = 500;
const PAGE_SIZE    = 50;

/* ─── Helpers ────────────────────────────────────────────────── */
let _uid = 0;
function uid() { return `br-${++_uid}-${Math.random().toString(36).slice(2, 6)}`; }

function emptyRow(prev?: BulkRow): BulkRow {
  return {
    _id: uid(),
    program_id:     prev?.program_id     ?? '',
    year_level:     prev?.year_level     ?? '',
    semester:       prev?.semester       ?? '',
    subject_type:   prev?.subject_type   ?? '',
    subject_category: prev?.subject_type ? categoryFromSubjectType(prev.subject_type, '') : 'Minor',
    subject_code:   '',
    subject_name:   '',
    units:          '',
    lecture_hours:  '',
    laboratory_hours: '',
    prerequisites:  '',
    grade:          '',
    errors: [], valid: false,
  };
}

function pn(v: string): number {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

function validateRows(rows: BulkRow[]): BulkRow[] {
  const codesSeen = new Map<string, number>();
  return rows.map((r, idx) => {
    const errs: string[] = [];
    if (!r.program_id)   errs.push('Program is required');
    if (!r.year_level)   errs.push('Year Level is required');
    if (!r.semester)     errs.push('Semester is required');
    if (!r.subject_type) errs.push('Subject Type is required');
    if (!r.subject_code.trim()) errs.push('Course Code is required');
    if (!r.subject_name.trim()) errs.push('Subject Name is required');
    if (!r.units || pn(r.units) < 0) errs.push('Credit Units must be ≥ 0');
    const lec = pn(r.lecture_hours), lab = pn(r.laboratory_hours);
    if (r.subject_type === 'Lecture'    && lec <= 0) errs.push('Lecture Hours must be > 0');
    if (r.subject_type === 'Laboratory' && lab <= 0) errs.push('Lab Hours must be > 0');
    if (r.subject_type === 'Lecture + Laboratory' && lec <= 0 && lab <= 0) errs.push('Enter Lec or Lab hours');
    const dupKey = `${r.program_id}|${r.year_level}|${r.semester}|${r.subject_code.trim().toUpperCase()}`;
    if (r.subject_code.trim() && r.program_id && r.year_level && r.semester) {
      if (codesSeen.has(dupKey)) {
        errs.push(`Duplicate of row ${(codesSeen.get(dupKey)! + 1)}`);
      } else {
        codesSeen.set(dupKey, idx);
      }
    }
    return { ...r, errors: errs, valid: errs.length === 0 };
  });
}

/* ─── Inline cell editor ─────────────────────────────────────── */
const inp = 'w-full text-xs bg-transparent outline-none placeholder-[#CBD5E1] py-0.5';
const cellCls = (err: boolean, focus: boolean) =>
  `relative border rounded-lg px-2 py-1.5 transition-colors min-w-0 ${
    err    ? 'border-red-300 bg-red-50/50' :
    focus  ? 'border-[#1D5BD6] bg-[#EFF6FF]/40' :
             'border-[#E2E8F0] bg-white hover:border-[#CBD5E1]'
  }`;

function SelectCell({ value, onChange, options, placeholder, hasError, id }: {
  value: string; onChange: (v: string) => void; options: { value: string; label: string }[];
  placeholder: string; hasError: boolean; id?: string;
}) {
  const [focus, setFocus] = useState(false);
  return (
    <div className={cellCls(hasError, focus)}>
      <select
        id={id}
        value={value}
        onChange={e => onChange(e.target.value)}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        className={`${inp} appearance-none pr-5 cursor-pointer`}
        style={{ color: value ? '#1E293B' : '#94A3B8' }}
      >
        <option value="">{placeholder}</option>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 pointer-events-none text-[#94A3B8]" />
    </div>
  );
}

function TextCell({ value, onChange, placeholder, hasError, onKeyDown, onPaste, autoFocus, id }: {
  value: string; onChange: (v: string) => void; placeholder: string;
  hasError: boolean; onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  onPaste?: (e: ClipboardEvent<HTMLInputElement>) => void;
  autoFocus?: boolean; id?: string;
}) {
  const [focus, setFocus] = useState(false);
  return (
    <div className={cellCls(hasError, focus)}>
      <input
        id={id}
        type="text"
        value={value}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        className={inp}
        style={{ color: '#1E293B' }}
      />
    </div>
  );
}

function NumCell({ value, onChange, placeholder, hasError, onKeyDown }: {
  value: string; onChange: (v: string) => void; placeholder: string;
  hasError: boolean; onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
}) {
  const [focus, setFocus] = useState(false);
  return (
    <div className={cellCls(hasError, focus)}>
      <input
        type="number"
        min="0"
        step="0.5"
        value={value}
        placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        onKeyDown={onKeyDown}
        className={`${inp} text-center tabular-nums`}
        style={{ color: '#1E293B' }}
      />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   MAIN COMPONENT
   ═══════════════════════════════════════════════════════════════ */
export default function BulkAddModal({ programs, curriculumVersion, onClose, onSaved }: BulkAddModalProps) {
  useScrollLock(true);
  const toast    = useToast();
  const tableRef = useRef<HTMLDivElement>(null);

  const [rows, setRows]         = useState<BulkRow[]>(() => [emptyRow()]);
  const [validated, setValidated] = useState(false);
  const [saving, setSaving]     = useState(false);
  const [result, setResult]     = useState<SaveResult | null>(null);
  const [page, setPage]         = useState(0);
  const [search, setSearch]     = useState('');
  const [dragIdx, setDragIdx]   = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  /* ── Derived ─────────────────────────────────────────────── */
  const validatedRows = validated ? rows : rows;
  const filteredRows  = search
    ? validatedRows.filter(r =>
        r.subject_code.toLowerCase().includes(search.toLowerCase()) ||
        r.subject_name.toLowerCase().includes(search.toLowerCase())
      )
    : validatedRows;

  const totalPages   = Math.ceil(filteredRows.length / PAGE_SIZE);
  const pageRows     = filteredRows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const validCount   = rows.filter(r => r.valid).length;
  const errorCount   = rows.filter(r => validated && !r.valid).length;
  const filledCount  = rows.filter(r => r.subject_code || r.subject_name).length;

  /* ── Setters ─────────────────────────────────────────────── */
  const updateRow = useCallback((id: string, patch: Partial<BulkRow>) => {
    setRows(prev => {
      const updated = prev.map(r => r._id !== id ? r : { ...r, ...patch });
      if (validated) return validateRows(updated);
      return updated;
    });
  }, [validated]);

  const addRow = useCallback(() => {
    if (rows.length >= MAX_ROWS) { toast.warning(`Maximum ${MAX_ROWS} rows allowed.`); return; }
    const last = rows[rows.length - 1];
    setRows(prev => {
      const newRow = emptyRow(last);
      const next = [...prev, newRow];
      return validated ? validateRows(next) : next;
    });
    // Scroll to bottom
    setTimeout(() => {
      tableRef.current?.scrollTo({ top: tableRef.current.scrollHeight, behavior: 'smooth' });
    }, 30);
    setPage(Math.floor(rows.length / PAGE_SIZE));
  }, [rows, validated, toast]);

  const duplicateRow = useCallback((id: string) => {
    if (rows.length >= MAX_ROWS) return;
    setRows(prev => {
      const idx = prev.findIndex(r => r._id === id);
      if (idx < 0) return prev;
      const copy = { ...prev[idx], _id: uid(), errors: [], valid: false, saved: undefined, saveError: undefined };
      const next = [...prev.slice(0, idx + 1), copy, ...prev.slice(idx + 1)];
      return validated ? validateRows(next) : next;
    });
  }, [rows.length, validated]);

  const removeRow = useCallback((id: string) => {
    setRows(prev => {
      if (prev.length === 1) return [emptyRow()];
      const next = prev.filter(r => r._id !== id);
      return validated ? validateRows(next) : next;
    });
  }, [validated]);

  const runValidation = useCallback(() => {
    const v = validateRows(rows);
    setRows(v);
    setValidated(true);
    return v;
  }, [rows]);

  /* ── Paste from Excel ────────────────────────────────────── */
  const handleTablePaste = useCallback((e: ClipboardEvent<HTMLInputElement>, rowId: string) => {
    const text = e.clipboardData.getData('text');
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.length <= 1) return; // single cell — let default paste handle it
    e.preventDefault();

    // TSV columns expected: Program, Year Level, Semester, Subject Type, Code, Name, Units, Lec, Lab, Prereq, Grade
    const parsed: BulkRow[] = lines.map(line => {
      const cols = line.split('\t').map(c => c.trim());
      const [prog, yl, sem, stype, code, name, units, lec, lab, prereq, grade] = cols;
      const matchedProg = programs.find(p =>
        p.code.toLowerCase() === (prog ?? '').toLowerCase() ||
        String(p.id) === (prog ?? '')
      );
      return {
        _id: uid(),
        program_id:      matchedProg ? String(matchedProg.id) : '',
        year_level:      YEAR_LEVELS.includes(yl ?? '') ? (yl ?? '') : '',
        semester:        SEMESTERS.includes(sem ?? '') ? (sem ?? '') : '',
        subject_type:    (SUBJECT_TYPES as string[]).includes(stype ?? '') ? (stype as SubjectType) : '',
        subject_category: categoryFromSubjectType(stype ?? '', code),
        subject_code:    (code ?? '').toUpperCase(),
        subject_name:    name ?? '',
        units:           units ?? '',
        lecture_hours:   lec ?? '',
        laboratory_hours: lab ?? '',
        prerequisites:   prereq ?? '',
        grade:           grade ?? '',
        errors: [], valid: false,
      };
    });

    setRows(prev => {
      const idx = prev.findIndex(r => r._id === rowId);
      // Replace empty current row or insert after it
      const base = idx >= 0 && !prev[idx].subject_code && !prev[idx].subject_name
        ? [...prev.slice(0, idx), ...parsed, ...prev.slice(idx + 1)]
        : [...prev.slice(0, idx + 1), ...parsed, ...prev.slice(idx + 1)];
      return validated ? validateRows(base) : base;
    });
  }, [programs, validated]);

  /* ── Drag-to-reorder ─────────────────────────────────────── */
  function handleDragStart(idx: number) { setDragIdx(idx); }
  function handleDragOver(e: React.DragEvent, idx: number) { e.preventDefault(); setDragOverIdx(idx); }
  function handleDrop(targetIdx: number) {
    if (dragIdx === null || dragIdx === targetIdx) { setDragIdx(null); setDragOverIdx(null); return; }
    setRows(prev => {
      const next = [...prev];
      const [moved] = next.splice(dragIdx, 1);
      next.splice(targetIdx, 0, moved);
      return validated ? validateRows(next) : next;
    });
    setDragIdx(null); setDragOverIdx(null);
  }

  /* ── Keyboard navigation ─────────────────────────────────── */
  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>, rowIdx: number) {
    if (e.key === 'Enter' && rowIdx === rows.length - 1) {
      e.preventDefault();
      addRow();
    }
  }

  /* ── Auto-fill ───────────────────────────────────────────── */
  const lastFilled = rows.filter(r => r.program_id || r.year_level || r.semester).slice(-1)[0];

  function applyAutoFill() {
    if (!lastFilled) return;
    setRows(prev => {
      const next = prev.map(r => ({
        ...r,
        program_id: r.program_id || lastFilled.program_id,
        year_level: r.year_level || lastFilled.year_level,
        semester:   r.semester   || lastFilled.semester,
      }));
      return validated ? validateRows(next) : next;
    });
  }

  /* ── Download template ───────────────────────────────────── */
  function downloadTemplate() {
    const headers = ['Program Code', 'Year Level', 'Semester', 'Subject Type', 'Course Code', 'Subject Name', 'Credit Units', 'Lecture Hours', 'Lab Hours', 'Prerequisites', 'Grade', 'Category'];
    const samples = [
      ['BSIT', '1st Year', '1st Semester', 'Lecture + Laboratory', 'IT 111', 'Introduction to Computing', '3', '2', '3', '', '', 'Major'],
      ['BSIT', '1st Year', '1st Semester', 'Lecture', 'GE-US', 'Understanding the Self', '3', '3', '0', '', '', 'Minor'],
    ];
    const rows = [headers, ...samples];
    const csv  = rows.map(r => r.map(c => `"${c}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = 'bulk_add_template.csv'; a.click();
    URL.revokeObjectURL(url);
  }

  /* ── Save ────────────────────────────────────────────────── */
  async function handleSave() {
    const validated = runValidation();
    const valid = validated.filter(r => r.valid);
    if (valid.length === 0) { toast.error('No valid rows to save. Fix validation errors first.'); return; }

    setSaving(true);
    try {
      const payload = valid.map(r => ({
        program_id:       Number(r.program_id),
        year_level:       r.year_level,
        semester:         r.semester,
        subject_code:     r.subject_code.trim().toUpperCase(),
        subject_name:     r.subject_name.trim(),
        lecture_hours:    pn(r.lecture_hours),
        laboratory_hours: pn(r.laboratory_hours),
        units:            pn(r.units),
        prerequisites:    r.prerequisites.trim(),
        grade:            r.grade.trim(),
        subject_category: categoryFromHours(pn(r.lecture_hours), pn(r.laboratory_hours), r.subject_code),
      }));

      const res  = await fetch('/api/curriculum/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ curriculum_version: curriculumVersion, rows: payload }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error || 'Save failed.'); return; }

      const r: SaveResult = {
        imported:    data.imported    ?? 0,
        reactivated: data.reactivated ?? 0,
        duplicated:  data.duplicated  ?? 0,
        errors:      data.errors      ?? [],
        total:       data.total       ?? ((data.imported ?? 0) + (data.reactivated ?? 0)),
      };
      setResult(r);
      const added = r.imported + r.reactivated;
      if (added > 0) {
        toast.success(`Successfully added ${added} of ${valid.length} subject${valid.length !== 1 ? 's' : ''}.`);
        onSaved();
      } else if (r.duplicated > 0) {
        toast.info(`All ${r.duplicated} subjects already exist.`);
      } else {
        toast.error('No subjects were added.');
      }
    } catch { toast.error('Connection error. Please try again.'); }
    finally { setSaving(false); }
  }

  /* ── Render ─────────────────────────────────────────────── */
  const progOpts = programs.map(p => ({ value: String(p.id), label: `${p.code} — ${p.name}` }));
  const ylOpts   = YEAR_LEVELS.map(y => ({ value: y, label: y }));
  const semOpts  = SEMESTERS.map(s => ({ value: s, label: s }));
  const typeOpts = SUBJECT_TYPES.map(t => ({ value: t, label: t }));

  if (result) {
    const added = result.imported + result.reactivated;
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose} data-modal-root>
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-8 flex flex-col items-center gap-5" onClick={e => e.stopPropagation()}>
          <div className={`w-20 h-20 rounded-full flex items-center justify-center ${added > 0 ? 'bg-emerald-50' : 'bg-amber-50'}`}>
            {added > 0
              ? <CheckCircle className="w-10 h-10 text-emerald-600" />
              : <AlertTriangle className="w-10 h-10 text-amber-500" />}
          </div>
          <h2 className="text-2xl font-bold text-center" style={{ color: '#0B2A5B' }}>
            {added > 0 ? 'Subjects Saved!' : 'Import Complete'}
          </h2>
          {added > 0 && (
            <p className="text-[#64748B] text-sm text-center">
              Successfully added <strong className="text-emerald-600">{added}</strong> of <strong>{rows.filter(r => r.valid).length}</strong> subjects.
            </p>
          )}
          <div className="grid grid-cols-3 gap-3 w-full">
            <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-center">
              <div className="text-2xl font-bold text-emerald-600">{result.imported}</div>
              <div className="text-xs text-emerald-700 mt-0.5 font-semibold">New Added</div>
            </div>
            <div className="bg-[#EFF6FF] border border-[#BFDBFE] rounded-xl p-3 text-center">
              <div className="text-2xl font-bold text-[#1D5BD6]">{result.reactivated}</div>
              <div className="text-xs text-[#12408F] mt-0.5 font-semibold">Restored</div>
            </div>
            <div className="bg-slate-50 border border-[#E2E8F0] rounded-xl p-3 text-center">
              <div className="text-2xl font-bold text-slate-500">{result.duplicated}</div>
              <div className="text-xs text-[#64748B] mt-0.5 font-semibold">Already Existed</div>
            </div>
          </div>
          {result.errors.length > 0 && (
            <div className="w-full bg-red-50 border border-red-200 rounded-xl p-4">
              <p className="text-sm font-semibold text-red-700 mb-2">{result.errors.length} row(s) failed:</p>
              <ul className="text-xs text-red-600 space-y-1 max-h-28 overflow-y-auto">
                {result.errors.map((e, i) => <li key={i}>• {e}</li>)}
              </ul>
            </div>
          )}
          <div className="flex gap-3 w-full pt-1">
            <button onClick={() => { setResult(null); setRows([emptyRow()]); setValidated(false); }}
              className="flex-1 border border-[#E2E8F0] rounded-xl py-2.5 text-sm font-semibold hover:bg-[#F8FAFC] transition"
              style={{ color: '#64748B' }}>
              Add More
            </button>
            <button onClick={onClose}
              className="flex-1 rounded-xl py-2.5 text-sm font-bold text-white hover:opacity-90 transition"
              style={{ backgroundColor: '#1D5BD6' }}>
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3"
      onClick={onClose}
      data-modal-root
      onKeyDown={e => { if (e.key === 'Escape') onClose(); }}
      tabIndex={-1}
      role="presentation"
    >
      <div
        className="bg-white border border-[#E2E8F0] rounded-2xl shadow-2xl flex flex-col"
        style={{ width: '98vw', maxWidth: 1400, height: '92vh' }}
        onClick={e => e.stopPropagation()}
      >

        {/* ── Header ─────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E2E8F0] flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[#EFF6FF] rounded-xl flex items-center justify-center">
              <Plus className="w-5 h-5 text-[#1D5BD6]" />
            </div>
            <div>
              <h2 className="text-lg font-bold" style={{ color: '#0B2A5B' }}>Bulk Add Subjects</h2>
              <p className="text-xs" style={{ color: '#64748B' }}>
                Saving to {curriculumVersionLabel(curriculumVersion)}
                {filledCount > 0
                  ? ` · ${filledCount} row${filledCount !== 1 ? 's' : ''} entered · ${validated ? `${validCount} valid, ${errorCount} with errors` : 'not yet validated'}`
                  : ' · Tab/Enter to move between rows'
                }
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Search */}
            <div className="relative hidden sm:block">
              <input
                value={search}
                onChange={e => { setSearch(e.target.value); setPage(0); }}
                placeholder="Search rows…"
                className="border border-[#E2E8F0] rounded-xl pl-3 pr-3 py-2 text-xs w-44 focus:outline-none focus:border-[#1D5BD6] transition-colors"
                style={{ color: '#0B2A5B' }}
              />
              {search && (
                <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-[#94A3B8] hover:text-[#475569]">
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
            <button onClick={onClose} className="p-2 rounded-xl hover:bg-[#F8FAFC] transition" style={{ color: '#64748B' }}>
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* ── Toolbar ────────────────────────────────────────── */}
        <div className="flex items-center gap-2 px-6 py-2.5 border-b border-[#E2E8F0] flex-shrink-0 flex-wrap" style={{ backgroundColor: '#F8FAFC' }}>
          <button onClick={addRow} disabled={rows.length >= MAX_ROWS}
            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg border border-[#BFDBFE] bg-[#EFF6FF] hover:bg-[#DBEAFE] transition disabled:opacity-40"
            style={{ color: '#1D5BD6' }}>
            <Plus className="w-3.5 h-3.5" /> Add Row
          </button>
          <button onClick={applyAutoFill} title="Fill empty Program / Year Level / Semester cells using the last row's values"
            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg border border-[#E2E8F0] bg-white hover:bg-[#F8FAFC] transition"
            style={{ color: '#64748B' }}>
            <Copy className="w-3.5 h-3.5" /> Auto-fill Context
          </button>
          <button onClick={downloadTemplate}
            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg border border-[#E2E8F0] bg-white hover:bg-[#F8FAFC] transition"
            style={{ color: '#64748B' }}>
            <Save className="w-3.5 h-3.5" /> Download Template
          </button>
          <div className="h-5 w-px bg-[#E2E8F0] mx-1" />
          <div className="flex items-center gap-1.5 text-xs" style={{ color: '#94A3B8' }}>
            <Info className="w-3.5 h-3.5 flex-shrink-0" />
            <span>Paste Excel rows directly into any cell • Tab/Enter to navigate • Drag <GripVertical className="inline w-3 h-3" /> to reorder</span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {validated && (
              <div className="flex items-center gap-2 text-xs">
                {validCount > 0 && <span className="text-emerald-700 font-semibold bg-emerald-50 border border-emerald-200 px-2 py-1 rounded-lg">{validCount} valid</span>}
                {errorCount > 0 && <span className="text-red-600 font-semibold bg-red-50 border border-red-200 px-2 py-1 rounded-lg">{errorCount} errors</span>}
              </div>
            )}
            <span className="text-xs" style={{ color: '#94A3B8' }}>{rows.length}/{MAX_ROWS} rows</span>
          </div>
        </div>

        {/* ── Table ──────────────────────────────────────────── */}
        <div className="flex-1 overflow-hidden flex flex-col min-h-0">
          <div ref={tableRef} className="flex-1 overflow-auto">
            <table className="w-full border-collapse text-xs" style={{ minWidth: 1280 }}>
              <thead className="sticky top-0 z-20 bg-[#F8FAFC] border-b border-[#E2E8F0]">
                <tr>
                  <th className="w-8 px-1 py-2.5 text-center" style={{ color: '#94A3B8' }}></th>
                  <th className="w-7 px-1 py-2.5 text-center text-[10px] font-bold uppercase tracking-wide" style={{ color: '#64748B' }}>#</th>
                  <th className="px-1.5 py-2.5 text-left text-[10px] font-bold uppercase tracking-wide min-w-[140px]" style={{ color: '#64748B' }}>Program <span className="text-red-400">*</span></th>
                  <th className="px-1.5 py-2.5 text-left text-[10px] font-bold uppercase tracking-wide min-w-[110px]" style={{ color: '#64748B' }}>Year Level <span className="text-red-400">*</span></th>
                  <th className="px-1.5 py-2.5 text-left text-[10px] font-bold uppercase tracking-wide min-w-[120px]" style={{ color: '#64748B' }}>Semester <span className="text-red-400">*</span></th>
                  <th className="px-1.5 py-2.5 text-left text-[10px] font-bold uppercase tracking-wide min-w-[138px]" style={{ color: '#64748B' }}>Subject Type <span className="text-red-400">*</span></th>
                  <th className="px-1.5 py-2.5 text-left text-[10px] font-bold uppercase tracking-wide min-w-[90px]" style={{ color: '#64748B' }}>Category <span className="text-red-400">*</span></th>
                  <th className="px-1.5 py-2.5 text-left text-[10px] font-bold uppercase tracking-wide min-w-[100px]" style={{ color: '#64748B' }}>Course Code <span className="text-red-400">*</span></th>
                  <th className="px-1.5 py-2.5 text-left text-[10px] font-bold uppercase tracking-wide min-w-[170px]" style={{ color: '#64748B' }}>Subject Name <span className="text-red-400">*</span></th>
                  <th className="px-1.5 py-2.5 text-center text-[10px] font-bold uppercase tracking-wide w-16" style={{ color: '#64748B' }}>Units</th>
                  <th className="px-1.5 py-2.5 text-center text-[10px] font-bold uppercase tracking-wide w-14" style={{ color: '#64748B' }}>Lec Hrs</th>
                  <th className="px-1.5 py-2.5 text-center text-[10px] font-bold uppercase tracking-wide w-14" style={{ color: '#64748B' }}>Lab Hrs</th>
                  <th className="px-1.5 py-2.5 text-left text-[10px] font-bold uppercase tracking-wide min-w-[120px]" style={{ color: '#64748B' }}>Prerequisites</th>
                  <th className="px-1.5 py-2.5 text-left text-[10px] font-bold uppercase tracking-wide w-20" style={{ color: '#64748B' }}>Grade</th>
                  <th className="px-1.5 py-2.5 text-center text-[10px] font-bold uppercase tracking-wide w-20" style={{ color: '#64748B' }}>Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F8FAFC]">
                {pageRows.map((row, pageIdx) => {
                  const globalIdx = page * PAGE_SIZE + pageIdx;
                  const hasErr    = validated && !row.valid;
                  const isDragTarget = dragOverIdx === globalIdx;
                  return (
                    <tr
                      key={row._id}
                      draggable
                      onDragStart={() => handleDragStart(globalIdx)}
                      onDragOver={e => handleDragOver(e, globalIdx)}
                      onDrop={() => handleDrop(globalIdx)}
                      onDragEnd={() => { setDragIdx(null); setDragOverIdx(null); }}
                      className={`transition-colors group ${
                        isDragTarget ? 'bg-[#EFF6FF] border-t-2 border-[#1D5BD6]' :
                        hasErr       ? 'bg-red-50/40' :
                        row.saved    ? 'bg-emerald-50/40' :
                                       'hover:bg-[#F8FAFC]'
                      }`}
                    >
                      {/* Drag handle */}
                      <td className="px-1 py-1.5 text-center">
                        <div className="cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity flex justify-center" style={{ color: '#CBD5E1' }}>
                          <GripVertical className="w-3.5 h-3.5" />
                        </div>
                      </td>

                      {/* Row number + status */}
                      <td className="px-1 py-1.5 text-center">
                        {validated ? (
                          row.valid
                            ? <CheckCircle className="w-3.5 h-3.5 text-emerald-500 mx-auto" />
                            : <AlertCircle className="w-3.5 h-3.5 text-red-500 mx-auto" />
                        ) : (
                          <span className="text-[10px] tabular-nums" style={{ color: '#CBD5E1' }}>{globalIdx + 1}</span>
                        )}
                      </td>

                      {/* Program */}
                      <td className="px-1.5 py-1.5">
                        <SelectCell
                          value={row.program_id}
                          onChange={v => updateRow(row._id, { program_id: v })}
                          options={progOpts}
                          placeholder="Program"
                          hasError={validated && !row.program_id}
                        />
                      </td>

                      {/* Year Level */}
                      <td className="px-1.5 py-1.5">
                        <SelectCell
                          value={row.year_level}
                          onChange={v => updateRow(row._id, { year_level: v })}
                          options={ylOpts}
                          placeholder="Year"
                          hasError={validated && !row.year_level}
                        />
                      </td>

                      {/* Semester */}
                      <td className="px-1.5 py-1.5">
                        <SelectCell
                          value={row.semester}
                          onChange={v => updateRow(row._id, { semester: v })}
                          options={semOpts}
                          placeholder="Semester"
                          hasError={validated && !row.semester}
                        />
                      </td>

                      {/* Subject Type */}
                      <td className="px-1.5 py-1.5">
                        <SelectCell
                          value={row.subject_type}
                          onChange={v => {
                            const t = v as SubjectType;
                            updateRow(row._id, {
                              subject_type: t,
                              subject_category: categoryFromSubjectType(t, row.subject_code),
                              lecture_hours:    t === 'Laboratory' ? '0' : row.lecture_hours,
                              laboratory_hours: t === 'Lecture'    ? '0' : row.laboratory_hours,
                            });
                          }}
                          options={typeOpts}
                          placeholder="Type"
                          hasError={validated && !row.subject_type}
                        />
                      </td>

                      {/* Category (read-only, derived from Subject Type) */}
                      <td className="px-1.5 py-1.5">
                        <div className="px-2 py-1.5 text-xs font-semibold rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] text-center"
                          style={{ color: row.subject_type ? '#0B2A5B' : '#94A3B8' }}>
                          {row.subject_type ? categoryFromSubjectType(row.subject_type, row.subject_code) : '—'}
                        </div>
                      </td>

                      {/* Course Code */}
                      <td className="px-1.5 py-1.5">
                        <TextCell
                          value={row.subject_code}
                          onChange={v => updateRow(row._id, { subject_code: v.toUpperCase() })}
                          placeholder="IT 111"
                          hasError={validated && !row.subject_code.trim()}
                          onKeyDown={e => handleKeyDown(e, globalIdx)}
                          onPaste={e => handleTablePaste(e, row._id)}
                        />
                      </td>

                      {/* Subject Name */}
                      <td className="px-1.5 py-1.5">
                        <TextCell
                          value={row.subject_name}
                          onChange={v => updateRow(row._id, { subject_name: v })}
                          placeholder="Subject name"
                          hasError={validated && !row.subject_name.trim()}
                          onKeyDown={e => handleKeyDown(e, globalIdx)}
                          onPaste={e => handleTablePaste(e, row._id)}
                        />
                      </td>

                      {/* Units */}
                      <td className="px-1.5 py-1.5">
                        <NumCell
                          value={row.units}
                          onChange={v => updateRow(row._id, { units: v })}
                          placeholder="3"
                          hasError={validated && (!row.units || pn(row.units) < 0)}
                          onKeyDown={e => handleKeyDown(e, globalIdx)}
                        />
                      </td>

                      {/* Lec Hours */}
                      <td className="px-1.5 py-1.5">
                        <NumCell
                          value={row.lecture_hours}
                          onChange={v => updateRow(row._id, { lecture_hours: v })}
                          placeholder="0"
                          hasError={validated && row.subject_type === 'Lecture' && pn(row.lecture_hours) <= 0}
                          onKeyDown={e => handleKeyDown(e, globalIdx)}
                        />
                      </td>

                      {/* Lab Hours */}
                      <td className="px-1.5 py-1.5">
                        <NumCell
                          value={row.laboratory_hours}
                          onChange={v => updateRow(row._id, { laboratory_hours: v })}
                          placeholder="0"
                          hasError={validated && row.subject_type === 'Laboratory' && pn(row.laboratory_hours) <= 0}
                          onKeyDown={e => handleKeyDown(e, globalIdx)}
                        />
                      </td>

                      {/* Prerequisites */}
                      <td className="px-1.5 py-1.5">
                        <TextCell
                          value={row.prerequisites}
                          onChange={v => updateRow(row._id, { prerequisites: v })}
                          placeholder="—"
                          hasError={false}
                          onKeyDown={e => handleKeyDown(e, globalIdx)}
                        />
                      </td>

                      {/* Grade */}
                      <td className="px-1.5 py-1.5">
                        <TextCell
                          value={row.grade}
                          onChange={v => updateRow(row._id, { grade: v })}
                          placeholder="—"
                          hasError={false}
                          onKeyDown={e => handleKeyDown(e, globalIdx)}
                        />
                      </td>

                      {/* Actions */}
                      <td className="px-1.5 py-1.5">
                        <div className="flex items-center justify-center gap-0.5">
                          <button onClick={() => duplicateRow(row._id)} title="Duplicate row"
                            className="p-1.5 rounded-lg hover:bg-[#EFF6FF] transition" style={{ color: '#1D5BD6' }}>
                            <Copy className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={() => removeRow(row._id)} title="Delete row"
                            className="p-1.5 rounded-lg hover:bg-red-50 transition" style={{ color: '#EF4444' }}>
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}

                {/* Error tooltip row */}
                {validated && pageRows.some(r => !r.valid) && pageRows.map((row) => {
                  if (row.valid || row.errors.length === 0) return null;
                  return (
                    <tr key={`err-${row._id}`} className="bg-red-50/60">
                      <td colSpan={2} className="pb-1" />
                      <td colSpan={12} className="px-2 pb-2">
                        <div className="flex items-start gap-1.5 flex-wrap">
                          <AlertCircle className="w-3 h-3 text-red-500 flex-shrink-0 mt-0.5" />
                          {row.errors.map((e, i) => (
                            <span key={i} className="text-[10px] text-red-600 bg-red-100 border border-red-200 px-1.5 py-0.5 rounded-md">{e}</span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-6 py-2 border-t border-[#E2E8F0] bg-[#F8FAFC] flex-shrink-0">
              <span className="text-xs" style={{ color: '#64748B' }}>
                Showing rows {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, filteredRows.length)} of {filteredRows.length}
              </span>
              <div className="flex items-center gap-1">
                <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
                  className="px-3 py-1.5 rounded-lg border border-[#E2E8F0] text-xs font-semibold hover:bg-white disabled:opacity-40 transition"
                  style={{ color: '#64748B' }}>← Prev</button>
                {Array.from({ length: totalPages }, (_, i) => (
                  <button key={i} onClick={() => setPage(i)}
                    className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold transition ${page === i ? 'text-white' : 'border border-[#E2E8F0] hover:bg-white'}`}
                    style={page === i ? { backgroundColor: '#1D5BD6' } : { color: '#64748B' }}>
                    {i + 1}
                  </button>
                ))}
                <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page === totalPages - 1}
                  className="px-3 py-1.5 rounded-lg border border-[#E2E8F0] text-xs font-semibold hover:bg-white disabled:opacity-40 transition"
                  style={{ color: '#64748B' }}>Next →</button>
              </div>
            </div>
          )}
        </div>

        {/* ── Footer ─────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-[#E2E8F0] flex-shrink-0 rounded-b-2xl" style={{ backgroundColor: '#F8FAFC' }}>
          <div className="flex items-center gap-3">
            <button onClick={onClose}
              className="px-5 py-2.5 border border-[#E2E8F0] rounded-xl text-sm font-semibold hover:bg-white transition"
              style={{ color: '#64748B' }}>
              Cancel
            </button>
            <button onClick={() => { setRows([emptyRow()]); setValidated(false); setResult(null); }}
              className="px-4 py-2.5 border border-[#E2E8F0] rounded-xl text-sm font-semibold hover:bg-white transition"
              style={{ color: '#64748B' }}>
              Clear All
            </button>
          </div>

          <div className="flex items-center gap-3">
            <button onClick={runValidation}
              className="px-5 py-2.5 border border-[#CBD5E1] rounded-xl text-sm font-semibold hover:bg-white transition"
              style={{ color: '#475569' }}>
              <span className="flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4" /> Validate All
              </span>
            </button>
            <button
              onClick={handleSave}
              disabled={saving || filledCount === 0}
              className="flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-bold text-white transition hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
              style={{ backgroundColor: '#1D5BD6' }}
            >
              {saving
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</>
                : <><Save className="w-4 h-4" /> Save All ({filledCount} row{filledCount !== 1 ? 's' : ''})</>
              }
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

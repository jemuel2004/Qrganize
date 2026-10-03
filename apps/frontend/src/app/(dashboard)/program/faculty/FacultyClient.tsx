'use client';

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { createPortal } from 'react-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { useToast } from '@/context/ToastContext';
import Modal from '@/components/ui/Modal';
import BackButton from '@/components/ui/BackButton';
import WatermarkTitle from '@/components/ui/WatermarkTitle';
import TrashDropAnimation from '@/components/ui/TrashDropAnimation';
import {
  Plus, Pencil, Trash2,
  User, Eye, EyeOff, ChevronDown, AlertTriangle, Star,
} from 'lucide-react';
import SubjectMultiSelect, { type PrioritySubject } from '@/components/ui/SubjectMultiSelect';
import BlockMultiSelect, { type BlockOption } from '@/components/ui/BlockMultiSelect';
import FriendlySelect from '@/components/ui/FriendlySelect';
import { formatLoadCap, shownUnitsCap } from '@shared/regularLoad';
import { useSchoolYear } from '@/context/SchoolYearContext';
import { useRealtime } from '@/context/RealtimeContext';
import { SearchInput, FilterSelect } from '@/components/ui/SearchFilter';
import { ListSkeleton, CardSkeleton, Skeleton } from '@/components/ui/skeletons';
import { PageLoadTransition } from '@/components/ui/PageLoadTransition';
import { EmploymentBadge, EMPLOYMENT_COLORS, employmentColors } from '@/components/ui/EmploymentBadge';
import { PAGE_SKELETON_MIN_MS, useMinLoading } from '@/hooks/useMinLoading';

const FacultyStatsBarChart = dynamic(
  () =>
    import('@/components/charts/FacultyStatsBarChart').then(
      m => m.FacultyStatsBarChart,
    ),
  {
    ssr: false,
    loading: () => <div className="h-[230px] rounded-lg bg-[#F8FAFC] animate-pulse" />,
  },
);

interface Program { id: number; code: string; name: string; }
interface Faculty {
  id: number;
  first_name: string | null; last_name: string | null; middle_name: string | null;
  name: string;
  program_id: number | null; program_code: string | null; program_name: string | null;
  /** null until the academic rank is set (e.g. a faculty added from the workload Excel) */
  position: string | null; employment_status: string;
  designation_type: string; designation_units: number;
  load_type: string; email: string | null;
  google_verified?: boolean;
  remaining_regular_load: number;
  years_in_service: number | null;
  educational_qualification: string | null;
  major: string | null;
  eligibility: string | null;
  specialization: string | null;
  priority_subjects?: PrioritySubject[];
  /** Blocks this faculty is assigned to teach (all terms) */
  assigned_block_ids?: number[];
}

const POSITION_GROUPS: { label: string; items: string[] }[] = [
  { label: 'Hour-based', items: ['Contractual'] },
  { label: 'Temporary', items: ['Temporary Permanent'] },
  { label: 'Instructor', items: ['Instructor I', 'Instructor II', 'Instructor III'] },
  {
    label: 'Assistant Professor',
    items: [
      'Assistant Professor I', 'Assistant Professor II', 'Assistant Professor III',
      'Assistant Professor IV', 'Assistant Professor V',
    ],
  },
  {
    label: 'Associate Professor',
    items: [
      'Associate Professor I', 'Associate Professor II',
      'Associate Professor III', 'Associate Professor IV',
    ],
  },
  {
    label: 'Professor',
    items: [
      'Professor I', 'Professor II', 'Professor III',
      'Professor IV', 'Professor V', 'Professor VI',
    ],
  },
];

const POSITIONS = POSITION_GROUPS.flatMap(group => group.items);

/** Only Contractual is hour-based (hours limit in Settings → Workload Limits); every other position, incl. Temporary Permanent, is unit-based. */
const HOUR_BASED_POSITIONS = new Set(['Contractual']);

const FACULTY_PAGE_SIZE = 10;


const emptyForm = {
  first_name: '', last_name: '', middle_name: '',
  program_id: '',
  position: '',
  designation_type: 'No Designation', designation_units: 0,
  load_type: 'Regular',
  username: '',
  email: '',
  password: '',
  confirmPassword: '',
  years_in_service: '',
  educational_qualification: '',
  major: '',
  eligibility: '',
  specialization: '',
  priority_subjects: [] as PrioritySubject[],
  block_ids: [] as number[],
};

/* ── Unsaved-form draft (survives an accidental modal close) ──────────────
   Keyed by "new" or "edit-<id>" so an in-progress add doesn't leak into an
   edit and vice-versa. Session-scoped (sessionStorage) and never stores
   passwords. */
const FACULTY_DRAFT_KEY = 'qr-faculty-draft';

function draftFormKey(editId: number | null) {
  return editId ? `edit-${editId}` : 'new';
}

function readFacultyDraft(key: string): typeof emptyForm | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(FACULTY_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { key: string; form: typeof emptyForm };
    return parsed.key === key ? { ...emptyForm, ...parsed.form } : null;
  } catch {
    return null;
  }
}

function writeFacultyDraft(key: string, form: typeof emptyForm) {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(FACULTY_DRAFT_KEY, JSON.stringify({
      key,
      form: { ...form, password: '', confirmPassword: '' },
    }));
  } catch {
    // storage unavailable (private mode, quota) — draft just won't persist
  }
}

function clearFacultyDraft() {
  if (typeof window === 'undefined') return;
  try { window.sessionStorage.removeItem(FACULTY_DRAFT_KEY); } catch { /* ignore */ }
}

function computeFullName(fn?: string | null, mn?: string | null, ln?: string | null) {
  return [(fn ?? '').trim(), (mn ?? '').trim(), (ln ?? '').trim()].filter(Boolean).join(' ');
}

function deriveEmploymentStatus(position: string | null): 'Permanent' | 'Contractual' {
  return HOUR_BASED_POSITIONS.has(position ?? '') ? 'Contractual' : 'Permanent';
}

/** Display grouping for the Faculty list/filter/stats. Temporary Permanent is
 *  unit-based, so its stored `employment_status` is already 'Permanent'. */
function facultyDisplayGroup(f: { position: string | null; employment_status: string }): 'Permanent' | 'Contractual' {
  return f.employment_status as 'Permanent' | 'Contractual';
}

// ── Small reusable pieces ─────────────────────────────────────────────────────

function PositionSelect({ value, onChange, error }: { value: string; onChange: (v: string) => void; error?: boolean }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const [dropStyle, setDropStyle] = useState<React.CSSProperties>({});

  function placeMenu() {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const gap = 6;
    const spaceBelow = window.innerHeight - r.bottom - 12;
    const spaceAbove = r.top - 12;
    const maxH = Math.min(288, Math.max(spaceBelow, spaceAbove, 160));
    const openUp = spaceBelow < 180 && spaceAbove > spaceBelow;
    setDropStyle({
      position: 'fixed',
      left: r.left,
      width: r.width,
      maxHeight: maxH,
      zIndex: 10050,
      ...(openUp
        ? { bottom: window.innerHeight - r.top + gap }
        : { top: r.bottom + gap }),
    });
  }

  function closeMenu() {
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    placeMenu();

    function onPointerDown(e: MouseEvent) {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || dropRef.current?.contains(t)) return;
      closeMenu();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      closeMenu();
      triggerRef.current?.focus();
    }
    function onReposition(e: Event) {
      // Scrolling inside the dropdown's own listbox shouldn't re-place it —
      // only reposition when the page/modal behind it scrolled.
      if (dropRef.current?.contains(e.target as Node)) return;
      placeMenu();
    }

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onReposition);
    document.addEventListener('scroll', onReposition, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onReposition);
      document.removeEventListener('scroll', onReposition, true);
    };
  }, [open]);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        data-field="position"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Position / Academic Rank"
        onClick={() => setOpen(prev => !prev)}
        className={[
          FIELD_BASE, 'text-left flex items-center justify-between gap-3',
          error ? FIELD_ERROR : '',
          open ? '!border-[#1D5BD6] ring-4 ring-[#1D5BD6]/15' : '',
        ].join(' ')}
      >
        <span className={`truncate ${value ? 'font-semibold' : 'text-[#94A3B8]'}`}>
          {value || 'Select position'}
        </span>
        <ChevronDown className={`w-5 h-5 flex-shrink-0 transition-transform duration-200 ${open ? 'rotate-180 text-[#1D5BD6]' : 'text-[#64748B]'}`} />
      </button>

      {open && createPortal(
        <div
          ref={dropRef}
          role="listbox"
          aria-label="Position / Academic Rank"
          data-scroll-portal
          style={dropStyle}
          className="overflow-y-auto overscroll-contain rounded-xl border border-[#E2E8F0] bg-white p-1.5 shadow-[0_12px_32px_rgba(11,42,91,0.16)] qr-fade-in"
        >
          {POSITION_GROUPS.map((group, index) => (
            <div key={group.label} className={index > 0 ? 'mt-1 pt-1 border-t border-[#F1F5F9]' : ''}>
              <p className="px-3 pt-2 pb-1 text-[11px] font-bold uppercase tracking-wider text-[#64748B]">
                {group.label}
              </p>
              {group.items.map(p => {
                const isSelected = value === p;
                return (
                  <button
                    key={p}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => { onChange(p); closeMenu(); }}
                    className={[
                      'w-full text-left px-3 py-2.5 rounded-lg text-[15px] transition-colors duration-150',
                      'flex items-center',
                      isSelected
                        ? 'bg-[#EFF6FF] text-[#1D5BD6] font-bold'
                        : 'text-[#0B2A5B] font-medium hover:bg-[#F4F7FC]',
                    ].join(' ')}
                  >
                    <span className="truncate">{p}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}

/* Explicit light colours — the old dark classes were repainted to a flat grey by the light-mode rules */
const FIELD_BASE =
  'w-full min-h-[50px] rounded-xl border border-[#CBD5E1] bg-white px-4 py-3 text-base text-[#0B2A5B] ' +
  'placeholder:text-[#94A3B8] hover:border-[#94A3B8] focus:outline-none focus:border-[#1D5BD6] ' +
  'focus:ring-4 focus:ring-[#1D5BD6]/15 disabled:bg-[#F1F5F9] disabled:cursor-not-allowed transition';
const FIELD_ERROR = '!border-[#EF4444] focus:!ring-[#EF4444]/15';

/** One numbered card per part of the form: 1 Personal, 2 Employment, … */
function FormSection({ step, title, subtitle, children }: {
  step: number; title: string; subtitle?: string; children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-[#E2E8F0] bg-white overflow-hidden">
      <div className="flex items-center gap-3.5 px-5 sm:px-6 py-4 bg-[#F8FAFC] border-b border-[#E2E8F0]">
        <span
          className="w-9 h-9 rounded-full bg-[#0B2A5B] flex items-center justify-center text-[15px] font-bold flex-shrink-0"
          style={{ color: '#FFFFFF' }}
        >
          {step}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[17px] font-bold text-[#0B2A5B] leading-tight">{title}</h3>
          {subtitle && <p className="text-sm text-[#64748B] mt-0.5">{subtitle}</p>}
        </div>
      </div>
      <div className="px-5 sm:px-6 py-5">{children}</div>
    </section>
  );
}

function FieldLabel({ children, required, optional }: { children: React.ReactNode; required?: boolean; optional?: boolean }) {
  return (
    <label className="flex items-center gap-1.5 text-[15px] font-semibold text-[#0B2A5B] mb-2">
      {children}
      {required && <span className="text-[#DC2626]">*</span>}
      {optional && <span className="text-[13px] font-normal text-[#64748B]">(optional)</span>}
    </label>
  );
}

/** Short helper line under a field */
function FieldHint({ children }: { children: React.ReactNode }) {
  return <p className="mt-1.5 text-[13px] text-[#64748B] leading-snug">{children}</p>;
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p className="mt-2 text-sm font-medium text-[#DC2626] flex items-center gap-1.5">
      {message}
    </p>
  );
}

function InputBase({ className = '', ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${FIELD_BASE} ${className}`} />;
}

// ─────────────────────────────────────────────────────────────────────────────

export default function FacultyPage() {
  const toast = useToast();
  const reduceMotion = useReducedMotion();
  const [faculty, setFaculty] = useState<Faculty[]>([]);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [userRole, setUserRole] = useState<'admin' | 'department_chair' | 'program_chair'>('admin');
  const [chairProgramId, setChairProgramId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [form, setForm] = useState(emptyForm);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [editId, setEditId] = useState<number | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [loading, setLoading] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [showSaveSkeleton, setShowSaveSkeleton] = useState(false);
  const [deleteSuccess, setDeleteSuccess] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [googleVerified, setGoogleVerified] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Faculty | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSwitching, setPageSwitching] = useState(false);
  const pageSwitchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  function goToPage(next: number) {
    setPage(next);
    setPageSwitching(true);
    if (pageSwitchTimeout.current) clearTimeout(pageSwitchTimeout.current);
    pageSwitchTimeout.current = setTimeout(() => setPageSwitching(false), PAGE_SKELETON_MIN_MS);
  }

  useEffect(() => () => { if (pageSwitchTimeout.current) clearTimeout(pageSwitchTimeout.current); }, []);

  useEffect(() => {
    fetch('/api/programs')
      .then(r => (r.ok ? r.json() : null))
      .then(d => setPrograms(d?.programs ?? []))
      .catch(() => {});
    fetch('/api/account/me')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        const role = d?.user?.role as string | undefined;
        if (role === 'program_chair') {
          setUserRole('program_chair');
          setChairProgramId(d.user?.program_id != null ? Number(d.user.program_id) : null);
        } else if (role === 'department_chair') {
          setUserRole('department_chair');
        }
      })
      .catch(() => {});
    loadFaculty();
  }, []);

  /* Subjects to Handle — pulled from the full curriculum across all programs
     (not scoped to whichever program this faculty member belongs to). */
  const [subjectOptions, setSubjectOptions] = useState<PrioritySubject[]>([]);
  const [subjectOptionsLoading, setSubjectOptionsLoading] = useState(false);
  useEffect(() => {
    if (!modalOpen) return;
    setSubjectOptionsLoading(true);
    fetch('/api/curriculum/subjects')
      .then(r => r.ok ? r.json() : { subjects: [] })
      .then(d => setSubjectOptions(d.subjects || []))
      .finally(() => setSubjectOptionsLoading(false));
  }, [modalOpen]);

  /* Blocks to Handle — this semester's blocks (assignments from other terms are kept). */
  const { semester: activeSemester, schoolYear: activeYear } = useSchoolYear();
  const [blockOptions, setBlockOptions] = useState<BlockOption[]>([]);
  const [blockOptionsLoading, setBlockOptionsLoading] = useState(false);
  useEffect(() => {
    if (!modalOpen || !activeSemester || !activeYear) return;
    setBlockOptionsLoading(true);
    const qs = new URLSearchParams({ semester: activeSemester, academic_year: activeYear });
    fetch(`/api/blocks?${qs}`)
      .then(r => r.ok ? r.json() : { blocks: [] })
      .then(d => setBlockOptions((d.blocks || []) as BlockOption[]))
      .finally(() => setBlockOptionsLoading(false));
  }, [modalOpen, activeSemester, activeYear]);

  /* Back to page 1 whenever the filtered result set changes shape */
  useEffect(() => { setPage(1); }, [search, statusFilter]);

  function loadFaculty() {
    // Status filtering happens client-side (see `facultyDisplayGroup`).
    setListLoading(true);
    fetch('/api/faculty')
      .then(r => r.json())
      .then(d => setFaculty(d.faculty || []))
      .finally(() => setListLoading(false));
  }

  // Live updates: faculty added, edited, deactivated or their account changed
  // elsewhere — the list reloads quietly (search, filter, page and open forms stay).
  useRealtime(['faculty'], () => fetch('/api/faculty')
    .then(r => (r.ok ? r.json() : null))
    .then(d => { if (d && Array.isArray(d.faculty)) setFaculty(d.faculty); })
    .catch(() => {}), { enabled: !listLoading });

  const fullName = computeFullName(form.first_name, form.middle_name, form.last_name);

  function setField<K extends keyof typeof emptyForm>(key: K, value: typeof emptyForm[K]) {
    setForm(f => ({ ...f, [key]: value }));
    if (fieldErrors[key]) setFieldErrors(e => { const n = { ...e }; delete n[key]; return n; });
  }

  function handlePositionChange(pos: string) {
    if (HOUR_BASED_POSITIONS.has(pos)) {
      setForm(f => ({ ...f, position: pos, designation_type: 'No Designation', designation_units: 0 }));
    } else {
      setForm(f => ({ ...f, position: pos }));
    }
  }

  function openAdd() {
    const draft = readFacultyDraft(draftFormKey(null));
    const base = userRole === 'program_chair' && chairProgramId != null
      ? { ...emptyForm, program_id: String(chairProgramId) }
      : emptyForm;
    setForm(draft ?? base);
    setEditId(null);
    setFieldErrors({});
    setSubmitError('');
    setShowPassword(false);
    setShowConfirmPassword(false);
    setGoogleVerified(false);
    setModalOpen(true);
    if (draft) toast.info('Restored your unsaved changes from last time.');
  }

  /** Close the modal, keeping an in-progress edit so it's there if reopened. */
  function closeModal() {
    const key = draftFormKey(editId);
    const isUnchanged = JSON.stringify(form) === JSON.stringify(emptyForm);
    if (isUnchanged) {
      clearFacultyDraft();
    } else {
      writeFacultyDraft(key, form);
    }
    setModalOpen(false);
  }

  async function openEdit(f: Faculty) {
    setEditId(f.id);
    setFieldErrors({});
    setSubmitError('');
    setShowPassword(false);
    setShowConfirmPassword(false);

    const draft = readFacultyDraft(draftFormKey(f.id));

    setForm(draft ?? {
      first_name: f.first_name ?? '',
      last_name: f.last_name ?? '',
      middle_name: f.middle_name ?? '',
      program_id: f.program_id ? String(f.program_id) : '',
      position: f.position ?? '',
      designation_type: f.designation_type,
      designation_units: f.designation_units,
      load_type: f.load_type || 'Regular',
      username: '',
      email: '',
      password: '',
      confirmPassword: '',
      years_in_service: f.years_in_service != null ? String(f.years_in_service) : '',
      educational_qualification: f.educational_qualification ?? '',
      major: f.major ?? '',
      eligibility: f.eligibility ?? '',
      specialization: f.specialization ?? '',
      priority_subjects: f.priority_subjects ?? [],
      block_ids: f.assigned_block_ids ?? [],
    });
    setModalOpen(true);
    if (draft) toast.info('Restored your unsaved changes from last time.');

    try {
      const res = await fetch(`/api/faculty/${f.id}`);
      if (res.ok) {
        const data = await res.json();
        const detail = data.faculty;
        setGoogleVerified(detail.google_verified === true);
        // A restored draft already reflects what the user was editing —
        // don't clobber it with the (possibly older) server snapshot.
        if (!draft) {
          setForm(prev => ({
            ...prev,
            first_name: detail.first_name ?? prev.first_name,
            last_name: detail.last_name ?? prev.last_name,
            middle_name: detail.middle_name ?? prev.middle_name,
            program_id: detail.program_id != null ? String(detail.program_id) : '',
            position: detail.position ?? prev.position,
            username: detail.username ?? '',
            email: detail.email ?? '',
            years_in_service: detail.years_in_service != null ? String(detail.years_in_service) : '',
            educational_qualification: detail.educational_qualification ?? '',
            major: detail.major ?? '',
            eligibility: detail.eligibility ?? '',
            specialization: detail.specialization ?? '',
            priority_subjects: detail.priority_subjects ?? [],
            block_ids: detail.assigned_block_ids ?? [],
          }));
        }
      }
    } catch {
      // Non-fatal
    }
  }

  function validateForm(): boolean {
    const errors: Record<string, string> = {};

    if (!form.first_name.trim()) errors.first_name = 'First Name is required.';
    if (!form.last_name.trim()) errors.last_name = 'Last Name is required.';
    if (!form.program_id) {
      errors.program_id = 'Program is required.';
    } else if (!programs.some(p => String(p.id) === String(form.program_id))) {
      errors.program_id = 'Invalid program selected.';
    }
    if (!form.position.trim()) {
      errors.position = 'Position / Academic Rank is required.';
    }

    if (form.years_in_service.trim() !== '') {
      const yis = Number(form.years_in_service);
      if (!Number.isInteger(yis) || yis < 0 || yis > 100)
        errors.years_in_service = 'Years in Service must be a whole number between 0 and 100.';
    }
    if (!form.username.trim()) errors.username = 'Username is required.';
    if (!form.email.trim()) {
      errors.email = 'Email is required.';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
      errors.email = 'Please enter a valid email address.';
    }

    if (!editId) {
      if (!form.password) {
        errors.password = 'Password is required.';
      } else if (form.password.length < 8) {
        errors.password = 'Password must be at least 8 characters.';
      }
      if (form.password !== form.confirmPassword) {
        errors.confirmPassword = 'Password and Confirm Password do not match.';
      }
    } else if (form.password) {
      if (form.password.length < 8) {
        errors.password = 'Password must be at least 8 characters.';
      }
      if (form.password !== form.confirmPassword) {
        errors.confirmPassword = 'Password and Confirm Password do not match.';
      }
    }

    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      const order = ['first_name', 'last_name', 'program_id', 'position', 'username', 'email', 'password', 'confirmPassword', 'years_in_service'];
      const first = order.find(k => errors[k]);
      if (first) {
        requestAnimationFrame(() => {
          const el = document.querySelector<HTMLElement>(`[data-field="${first}"]`);
          el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el?.focus();
        });
      }
      return false;
    }
    return true;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validateForm()) return;
    setLoading(true);
    setSubmitError('');

    const payload: Record<string, unknown> = {
      first_name: form.first_name.trim(),
      last_name: form.last_name.trim(),
      middle_name: form.middle_name.trim(),
      program_id: form.program_id ? Number(form.program_id) : null,
      position: form.position,
      designation_type: form.designation_type,
      designation_units: form.designation_units,
      load_type: form.load_type,
      username: form.username.trim(),
      email: form.email.trim(),
      name: fullName,
      years_in_service: form.years_in_service.trim() !== '' ? Number(form.years_in_service) : null,
      educational_qualification: form.educational_qualification.trim() || null,
      major: form.major.trim() || null,
      eligibility: form.eligibility.trim() || null,
      specialization: form.specialization.trim() || null,
      priority_subjects: form.priority_subjects,
      block_ids: form.block_ids,
    };

    if (!editId || form.password) {
      payload.password = form.password;
    }

    const url = editId ? `/api/faculty/${editId}` : '/api/faculty';
    const method = editId ? 'PUT' : 'POST';

    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.field) {
          setFieldErrors(prev => ({ ...prev, [data.field]: data.error }));
          requestAnimationFrame(() => {
            const el = document.querySelector<HTMLElement>(`[data-field="${data.field}"]`);
            el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el?.focus();
          });
        } else {
          setSubmitError(data.error || 'Error saving faculty. Please try again.');
          toast.error(data.error || 'Error saving faculty. Please try again.');
        }
        return;
      }
      clearFacultyDraft();
      setLoading(false);
      setSaveSuccess(true);
      setShowSaveSkeleton(true);
      loadFaculty();
      setTimeout(() => {
        setSaveSuccess(false);
        setShowSaveSkeleton(false);
        setModalOpen(false);
        toast.success(editId ? 'Faculty updated successfully.' : 'Faculty added successfully.');
      }, 1300);
      return;
    } catch {
      setSubmitError('Connection error. Please check your network and try again.');
      toast.error('Connection error. Please check your network and try again.');
    } finally {
      setLoading(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      const res = await fetch(`/api/faculty/${deleteTarget.id}`, { method: 'DELETE' });
      if (res.ok) {
        const deletedName = deleteTarget.name;
        setDeleteLoading(false);
        setDeleteSuccess(true);
        setShowSaveSkeleton(true);
        loadFaculty();
        setTimeout(() => {
          setDeleteSuccess(false);
          setShowSaveSkeleton(false);
          setDeleteTarget(null);
          toast.delete(`${deletedName} has been permanently deleted.`);
        }, 1300);
        return;
      } else {
        const d = await res.json().catch(() => ({}));
        toast.error(d.error || 'Failed to delete faculty. Please try again.');
      }
    } catch {
      toast.error('Connection error. Please try again.');
    } finally {
      setDeleteLoading(false);
    }
  }

  const filtered = faculty
    .filter(f => !statusFilter || facultyDisplayGroup(f) === statusFilter)
    .filter(f =>
      !search ||
      f.name.toLowerCase().includes(search.toLowerCase()) ||
      (f.program_code || '').toLowerCase().includes(search.toLowerCase()) ||
      (f.program_name || '').toLowerCase().includes(search.toLowerCase()) ||
      (f.position ?? '').toLowerCase().includes(search.toLowerCase())
    )
    .sort((a, b) => POSITIONS.indexOf(b.position ?? '') - POSITIONS.indexOf(a.position ?? ''));

  const totalPages = Math.max(1, Math.ceil(filtered.length / FACULTY_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paginated = filtered.slice((safePage - 1) * FACULTY_PAGE_SIZE, safePage * FACULTY_PAGE_SIZE);

  const totalPermanent = faculty.filter(f => facultyDisplayGroup(f) === 'Permanent').length;
  const totalContractual = faculty.filter(f => facultyDisplayGroup(f) === 'Contractual').length;
  const showListSkeleton = useMinLoading(listLoading && faculty.length === 0, PAGE_SKELETON_MIN_MS) || showSaveSkeleton;

  // ── Form ─────────────────────────────────────────────────────────────────────

  const errorBorder = (field: string) => fieldErrors[field] ? FIELD_ERROR : '';

  const formContent = (
    <div className="space-y-5">

      {/* ── 1. Personal Information ── */}
      <FormSection step={1} title="Personal Information">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">

          <div>
            <FieldLabel required>First Name</FieldLabel>
            <InputBase
              value={form.first_name}
              onChange={e => setField('first_name', e.target.value)}
              placeholder="e.g., Juan"
              className={errorBorder('first_name')}
              data-field="first_name"
            />
            <FieldError message={fieldErrors.first_name} />
          </div>

          <div>
            <FieldLabel optional>Middle Name</FieldLabel>
            <InputBase
              value={form.middle_name}
              onChange={e => setField('middle_name', e.target.value)}
              placeholder="e.g., Santos"
            />
          </div>

          <div>
            <FieldLabel required>Last Name</FieldLabel>
            <InputBase
              value={form.last_name}
              onChange={e => setField('last_name', e.target.value)}
              placeholder="e.g., Dela Cruz"
              className={errorBorder('last_name')}
              data-field="last_name"
            />
            <FieldError message={fieldErrors.last_name} />
          </div>

          <div>
            <FieldLabel>
              Full Name
              <span className="ml-1 inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-bold bg-[#EFF6FF] text-[#1D5BD6] border border-[#BFDBFE]">
                Automatic
              </span>
            </FieldLabel>
            <div className="w-full min-h-[50px] rounded-xl border border-[#BFDBFE] bg-[#F5F9FF] px-4 py-3 flex items-center">
              {fullName
                ? <span className="text-base font-bold text-[#0B2A5B]">{fullName}</span>
                : <span className="text-sm text-[#94A3B8]">Fills in from the name fields</span>}
            </div>
          </div>

        </div>
      </FormSection>

      {/* ── 2. Employment Information ── */}
      <FormSection step={2} title="Employment Information">
        <div className="space-y-5">

          <div data-field="program_id" tabIndex={-1} className="outline-none">
            <FieldLabel required>Program</FieldLabel>
            <div className={`rounded-xl ${fieldErrors.program_id ? 'ring-2 ring-[#EF4444]' : ''}`}>
              <FriendlySelect
                value={form.program_id}
                onChange={v => setField('program_id', v)}
                label="Program"
                placeholder="Select a program"
                disabled={userRole === 'program_chair'}
                showHintInTrigger
                minPanelWidth={380}
                options={(userRole === 'program_chair'
                  ? programs.filter(p => p.id === chairProgramId)
                  : programs
                ).map(p => ({ value: String(p.id), label: p.code, hint: p.name }))}
              />
            </div>
            {userRole === 'program_chair' && <FieldHint>Locked to your assigned program.</FieldHint>}
            <FieldError message={fieldErrors.program_id} />
          </div>

          <div>
            <FieldLabel required>Position / Academic Rank</FieldLabel>
            <PositionSelect
              value={form.position}
              onChange={handlePositionChange}
              error={!!fieldErrors.position}
            />
            <FieldError message={fieldErrors.position} />
          </div>

          <div>
            <FieldLabel optional>Subjects to Handle</FieldLabel>
            <SubjectMultiSelect
              options={subjectOptions}
              selected={form.priority_subjects}
              onChange={next => setField('priority_subjects', next)}
              loading={subjectOptionsLoading}
            />
            <FieldHint>Only these show for this faculty in Faculty Workload. Leave empty to allow all.</FieldHint>
          </div>

          <div>
            <FieldLabel optional>Blocks to Handle</FieldLabel>
            <BlockMultiSelect
              blocks={blockOptions}
              selected={form.block_ids ?? []}
              onChange={next => setField('block_ids', next)}
              loading={blockOptionsLoading}
              defaultProgram={programs.find(pr => String(pr.id) === form.program_id)?.code ?? null}
            />
            <FieldHint>{activeSemester || 'This semester'}. Leave empty to allow all blocks.</FieldHint>
          </div>

        </div>
      </FormSection>

      {/* ── 3. Professional Profile ── */}
      <FormSection step={3} title="Professional Profile" subtitle="Optional">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">

          <div className="sm:col-span-2">
            <FieldLabel optional>Specialization</FieldLabel>
            <InputBase
              value={form.specialization}
              onChange={e => setField('specialization', e.target.value)}
              placeholder="e.g., Information Technology / Computer Engineering"
              maxLength={255}
            />
          </div>

          <div>
            <FieldLabel optional>Years in Service</FieldLabel>
            <InputBase
              type="number"
              min={0}
              max={100}
              step={1}
              value={form.years_in_service}
              onChange={e => setField('years_in_service', e.target.value)}
              placeholder="e.g., 5"
              className={errorBorder('years_in_service')}
            />
            <FieldError message={fieldErrors.years_in_service} />
          </div>

          <div>
            <FieldLabel optional>Educational Qualification</FieldLabel>
            <InputBase
              value={form.educational_qualification}
              onChange={e => setField('educational_qualification', e.target.value)}
              placeholder="e.g., Master of Science in IT"
              maxLength={255}
            />
          </div>

          <div>
            <FieldLabel optional>Major</FieldLabel>
            <InputBase
              value={form.major}
              onChange={e => setField('major', e.target.value)}
              placeholder="e.g., Computer Science"
              maxLength={255}
            />
          </div>

          <div>
            <FieldLabel optional>Eligibility / PRC</FieldLabel>
            <InputBase
              value={form.eligibility}
              onChange={e => setField('eligibility', e.target.value)}
              placeholder="e.g., LPT / PRC No. 0123456"
              maxLength={255}
            />
          </div>

        </div>
      </FormSection>

      {/* ── 4. Account Information ── */}
      <FormSection
        step={4}
        title="Account Information"
      >
        {/* Role display */}
        <div className="mb-5 flex items-center gap-3 rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-4 py-3">
          <span className="text-sm font-semibold text-[#334155]">Role</span>
          <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-bold bg-[#EFF6FF] text-[#1D5BD6] border border-[#BFDBFE]">
            Faculty
          </span>
          <span className="text-xs text-[#64748B] ml-auto">Fixed for faculty accounts</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">

          <div>
            <FieldLabel required>Username</FieldLabel>
            <InputBase
              type="text"
              value={form.username}
              onChange={e => setField('username', e.target.value)}
              placeholder="e.g., juan.delacruz"
              autoComplete="off"
              className={errorBorder('username')}
              data-field="username"
            />
            <FieldError message={fieldErrors.username} />
          </div>

          <div>
            <FieldLabel required>Email Address</FieldLabel>
            <InputBase
              type="email"
              value={form.email}
              onChange={e => setField('email', e.target.value)}
              placeholder="e.g., juan.delacruz@school.edu"
              autoComplete="off"
              className={errorBorder('email')}
              data-field="email"
            />
            <FieldError message={fieldErrors.email} />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {editId && googleVerified ? (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-[#ECFDF5] text-[#047857] border border-[#A7F3D0]">
                  Google verified
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-[#FFFBEB] text-[#B45309] border border-[#FDE68A]">
                  Google not verified
                </span>
              )}
            </div>
            <FieldHint>
              {editId
                ? 'Changing the email means they must verify with Google again.'
                : 'They verify by signing in with this Google account.'}
            </FieldHint>
          </div>

          <div>
            <FieldLabel required={!editId} optional={!!editId}>
              {editId ? 'New Password' : 'Password'}
            </FieldLabel>
            <div className="relative">
              <InputBase
                type={showPassword ? 'text' : 'password'}
                value={form.password}
                onChange={e => setField('password', e.target.value)}
                placeholder={editId ? 'Leave blank to keep current' : 'At least 8 characters'}
                autoComplete="new-password"
                className={`pr-12 ${errorBorder('password')}`}
                data-field="password"
              />
              <button
                type="button"
                onClick={() => setShowPassword(p => !p)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-lg text-[#64748B] hover:text-[#0B2A5B] hover:bg-[#F1F5F9] transition-colors"
                tabIndex={-1}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <FieldError message={fieldErrors.password} />
            {!editId && !fieldErrors.password && <FieldHint>Minimum 8 characters.</FieldHint>}
          </div>

          <div>
            <FieldLabel required={!editId} optional={!!editId}>
              {editId ? 'Confirm New Password' : 'Confirm Password'}
            </FieldLabel>
            <div className="relative">
              <InputBase
                type={showConfirmPassword ? 'text' : 'password'}
                value={form.confirmPassword}
                onChange={e => setField('confirmPassword', e.target.value)}
                placeholder="Re-enter the password"
                autoComplete="new-password"
                className={`pr-12 ${errorBorder('confirmPassword')}`}
                data-field="confirmPassword"
              />
              <button
                type="button"
                onClick={() => setShowConfirmPassword(p => !p)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-lg text-[#64748B] hover:text-[#0B2A5B] hover:bg-[#F1F5F9] transition-colors"
                tabIndex={-1}
                aria-label={showConfirmPassword ? 'Hide password' : 'Show password'}
              >
                {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <FieldError message={fieldErrors.confirmPassword} />
          </div>

        </div>
      </FormSection>

    </div>
  );

  const formFooter = (
    <div className="flex flex-col sm:flex-row sm:items-center gap-3">
      {submitError && (
        <div className="flex-1 flex items-center gap-2 bg-[#FEF2F2] border border-[#FECACA] text-[#B91C1C] px-4 py-2.5 rounded-xl text-sm font-medium">
          {submitError}
        </div>
      )}
      <div className="flex gap-3 sm:ml-auto">
        <motion.button
          type="button"
          onClick={closeModal}
          whileTap={reduceMotion ? undefined : { scale: 0.97 }}
          className="px-6 py-3 border border-[#CBD5E1] bg-white text-[#0B2A5B] rounded-xl hover:bg-[#F8FAFC] hover:border-[#94A3B8] transition-colors text-[15px] font-semibold min-w-[110px]"
        >
          Cancel
        </motion.button>
        <motion.button
          type="submit"
          form="faculty-form"
          disabled={loading}
          whileTap={reduceMotion || loading ? undefined : { scale: 0.97 }}
          className="inline-flex items-center justify-center gap-2 px-6 py-3 bg-[#1D5BD6] rounded-xl hover:bg-[#164BB5] disabled:opacity-60 transition-colors text-[15px] font-semibold min-w-[160px] shadow-sm"
          // White set inline — the light-mode rule repaints `text-white` as dark ink
          style={{ color: '#FFFFFF' }}
        >
          {loading
            ? <><span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" /> Saving…</>
            : (editId ? 'Update Faculty' : 'Add Faculty')}
        </motion.button>
      </div>
    </div>
  );

  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto w-full min-w-0">

      <PageLoadTransition
        showSkeleton={showListSkeleton}
        skeleton={
          <div className="space-y-6" role="status" aria-live="polite" aria-label="Loading faculty profiles">
            {/* Title + Add Faculty */}
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-2 min-w-0">
                <Skeleton className="h-8 w-48 sm:w-56 rounded-md" />
                <Skeleton className="h-4 w-72 sm:w-96 max-w-full rounded" />
              </div>
              <Skeleton className="h-11 w-full sm:w-[8.5rem] rounded-xl flex-shrink-0" />
            </div>

            {/* Stats */}
            <CardSkeleton className="h-[212px]" />

            {/* Filters */}
            <div className="bg-white rounded-2xl shadow-[0_1px_3px_rgba(0,0,0,0.06)] p-4 flex flex-col sm:flex-row sm:flex-wrap gap-3">
              <Skeleton className="h-[42px] w-full sm:w-[190px] rounded-xl flex-shrink-0" />
              <Skeleton className="h-[42px] w-full sm:flex-1 sm:min-w-48 rounded-xl" />
            </div>

            {/* List */}
            <ListSkeleton rows={8} />
          </div>
        }
      >

      {/* Page Header */}
      <div className="mb-6">
        <div className="flex items-start justify-between gap-3">
          <BackButton />
          {userRole === 'admin' && (
            <button
              onClick={openAdd}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 min-h-11 rounded-xl transition font-semibold text-sm shadow-sm hover:opacity-90 flex-shrink-0"
              style={{ backgroundColor: '#1D5BD6', color: '#ffffff' }}
            >
              <Plus className="w-4 h-4" /> Add Faculty
            </button>
          )}
        </div>
        <div className="mt-4 sm:mt-7 mb-10">
          <WatermarkTitle>Faculty Profiles</WatermarkTitle>
        </div>
      </div>

      {/* Stats */}
      {faculty.length > 0 && (
        <div className="qr-chart-card rounded-2xl p-4 sm:p-5 mb-6">
          <FacultyStatsBarChart
            data={[
              { name: 'Permanent', value: totalPermanent, color: EMPLOYMENT_COLORS.Permanent.fg, gradient: ['#8FDDC0', '#4DB892'] },
              { name: 'Contractual', value: totalContractual, color: EMPLOYMENT_COLORS.Contractual.fg, gradient: ['#F7CD92', '#EBA158'] },
              { name: 'Total Faculty', value: faculty.length, color: '#1D5BD6', gradient: ['#4F84E8', '#1D4FB8'] },
            ]}
            // Clicking a bar filters the list below; "Total Faculty" or the
            // already-active bar clears the filter.
            activeName={statusFilter || undefined}
            onSelect={name => setStatusFilter(name === 'Total Faculty' || name === statusFilter ? '' : name)}
          />
        </div>
      )}

      {/* Filters */}
      <div className="bg-white rounded-2xl shadow-[0_1px_3px_rgba(0,0,0,0.06)] p-4 mb-6 flex flex-col sm:flex-row sm:flex-wrap gap-3">
        <FilterSelect value={statusFilter} onChange={setStatusFilter} label="Employment Status" className="w-full sm:min-w-[190px] sm:w-auto">
          <option value="">All Employment Status</option>
          <option value="Permanent">Permanent</option>
          <option value="Contractual">Contractual</option>
        </FilterSelect>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search by name, program, or position…"
          className="w-full sm:flex-1 sm:min-w-48"
        />
      </div>

      <div className="bg-white border border-[#E2E8F0] rounded-xl overflow-hidden">
        {/* Mobile cards */}
        <div className="md:hidden divide-y divide-[color:var(--border-subtle)]">
          {pageSwitching ? (
            Array.from({ length: paginated.length || FACULTY_PAGE_SIZE }, (_, i) => (
              <div key={i} className="p-4 flex items-start gap-3">
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-4 w-2/3 rounded" />
                  <Skeleton className="h-3 w-1/2 rounded" />
                  <Skeleton className="h-3 w-1/3 rounded" />
                </div>
                <Skeleton className="h-8 w-16 rounded-lg flex-shrink-0" />
              </div>
            ))
          ) : filtered.length === 0 ? (
            <div className="text-center py-14 px-4 text-sm" style={{ color: '#64748B' }}>
              No faculty found.
            </div>
          ) : paginated.map(f => {
            const empStatus = f.employment_status || deriveEmploymentStatus(f.position);
            const isPermanent = empStatus === 'Permanent';
            return (
              <div key={f.id} className="p-4 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-base break-words leading-snug" style={{ color: '#0B2A5B' }}>{f.name}</p>
                    {f.specialization && (
                      <p className="text-xs mt-0.5 break-words" style={{ color: '#1D5BD6' }}>{f.specialization}</p>
                    )}
                    <p className="text-sm mt-1 break-words" style={{ color: '#64748B' }}>
                      {f.position ?? 'Rank not set'}
                      {f.program_code ? ` · ${f.program_code}` : ''}
                    </p>
                    {f.program_name && (
                      <p className="text-xs mt-0.5 break-words" style={{ color: '#94A3B8' }}>{f.program_name}</p>
                    )}
                    {!f.program_code && (
                      <p className="text-xs italic mt-0.5 font-medium" style={{ color: '#D97706' }}>Not assigned</p>
                    )}
                  </div>
                  {userRole === 'admin' && (
                    <div className="flex gap-1 flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => openEdit(f)}
                        className="min-h-11 min-w-11 inline-flex items-center justify-center rounded-xl transition hover:bg-[#EFF6FF]"
                        style={{ color: '#1D5BD6' }}
                        title="Edit"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(f)}
                        className="min-h-11 min-w-11 inline-flex items-center justify-center rounded-xl transition hover:bg-red-50"
                        style={{ color: '#EF4444' }}
                        title="Delete Faculty"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" style={{ color: '#64748B' }}>
                  <span>{f.designation_type}</span>
                  <span className="font-bold" style={{ color: employmentColors(empStatus).fg }}>
                    {isPermanent
                      ? `${formatLoadCap(shownUnitsCap(parseFloat(String(f.remaining_regular_load))))} units`
                      : `${formatLoadCap(parseFloat(String(f.remaining_regular_load)) || 0)} hrs`}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Desktop table */}
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-[color:var(--border-subtle)] bg-[#F8FAFC]">
              <tr>
                {['Name', 'Program', 'Position', 'Designation', 'Max Load', 'Actions'].map(h => (
                  <th
                    key={h}
                    className={`${h === 'Max Load' ? 'text-center' : 'text-left'} px-5 py-3.5 text-xs font-semibold uppercase tracking-wide whitespace-nowrap text-[#64748B]`}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--border-subtle)]">
              {pageSwitching ? (
                Array.from({ length: paginated.length || FACULTY_PAGE_SIZE }, (_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 6 }, (_, c) => (
                      <td key={c} className={`px-5 py-4 ${c === 4 ? 'text-center' : ''}`}>
                        <Skeleton className={`h-3.5 rounded ${c === 0 ? 'w-32' : c === 4 ? 'w-14 mx-auto' : c === 5 ? 'w-16' : 'w-24'}`} />
                      </td>
                    ))}
                  </tr>
                ))
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-14" style={{ color: '#64748B' }}>
                    No faculty found.
                  </td>
                </tr>
              ) : paginated.map(f => {
                const empStatus = f.employment_status || deriveEmploymentStatus(f.position);
                const isPermanent = empStatus === 'Permanent';
                return (
                  <tr key={f.id} className="hover:bg-[#F8FAFC] transition-colors">
                    <td className="px-5 py-4">
                      <p className="font-semibold flex items-center gap-2" style={{ color: '#0B2A5B' }}>
                        {f.name}
                        {(f.priority_subjects?.length ?? 0) > 0 && (
                          <span
                            className="inline-flex cursor-help"
                            title={`Priority subjects: ${f.priority_subjects!.map(p => p.subject_code).join(', ')}`}
                            aria-label="Has priority subjects"
                          >
                            <Star size={18} fill="#F2B632" color="#C98A0B" strokeWidth={1.5} />
                          </span>
                        )}
                      </p>
                      {f.specialization && (
                        <p className="text-xs mt-0.5" style={{ color: '#1D5BD6' }}>{f.specialization}</p>
                      )}
                    </td>
                    <td className="px-5 py-4">
                      {f.program_code
                        ? (
                          <div>
                            <span className="font-semibold text-xs" style={{ color: '#0B2A5B' }}>{f.program_code}</span>
                            {f.program_name && (
                              <p className="text-[11px] leading-tight mt-0.5 max-w-[200px] break-words" style={{ color: '#64748B' }}>{f.program_name}</p>
                            )}
                          </div>
                        )
                        : <span className="text-xs italic font-medium" style={{ color: '#D97706' }}>Not assigned</span>}
                    </td>
                    <td className="px-5 py-4 font-medium" style={{ color: '#0B2A5B' }}>
                      {f.position ?? <span className="text-xs italic font-medium" style={{ color: '#D97706' }}>Not set</span>}
                    </td>
                    <td className="px-5 py-4 text-xs" style={{ color: '#64748B' }}>{f.designation_type}</td>
                    <td className="px-5 py-4 text-center font-bold" style={{ color: employmentColors(empStatus).fg }}>
                      {isPermanent
                        ? `${formatLoadCap(shownUnitsCap(parseFloat(String(f.remaining_regular_load))))} units`
                        : `${formatLoadCap(parseFloat(String(f.remaining_regular_load)) || 0)} hrs`
                      }
                    </td>
                    <td className="px-5 py-4">
                      {userRole === 'admin' ? (
                        <div className="flex gap-1.5">
                          <button
                            type="button"
                            onClick={() => openEdit(f)}
                            className="p-2 min-h-11 min-w-11 inline-flex items-center justify-center rounded-lg transition hover:bg-[#EFF6FF]"
                            style={{ color: '#1D5BD6' }}
                            title="Edit"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeleteTarget(f)}
                            className="p-2 min-h-11 min-w-11 inline-flex items-center justify-center rounded-lg transition hover:bg-red-50"
                            style={{ color: '#EF4444' }}
                            title="Delete Faculty"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs italic" style={{ color: '#94A3B8' }}>View only</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {filtered.length > 0 && (
          <div className="px-5 py-3 border-t border-[color:var(--border)] flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <p className="text-xs text-[#64748B]">
              Showing {(safePage - 1) * FACULTY_PAGE_SIZE + 1}
              –{Math.min(safePage * FACULTY_PAGE_SIZE, filtered.length)} of {filtered.length} faculty
            </p>
            {totalPages > 1 && (
              <div className="flex items-center gap-2 self-end sm:self-auto">
                <button
                  type="button"
                  onClick={() => goToPage(Math.max(1, safePage - 1))}
                  disabled={safePage === 1}
                  className="inline-flex items-center justify-center min-h-9 px-3 rounded-lg border border-[#E2E8F0] bg-white text-xs font-semibold text-[#475569] hover:bg-[#F8FAFC] hover:border-[#CBD5E1] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Previous
                </button>
                <span className="text-xs font-medium text-[#0B2A5B] tabular-nums px-1 whitespace-nowrap">
                  Page {safePage} of {totalPages}
                </span>
                <button
                  type="button"
                  onClick={() => goToPage(Math.min(totalPages, safePage + 1))}
                  disabled={safePage === totalPages}
                  className="inline-flex items-center justify-center min-h-9 px-3 rounded-lg border border-[#E2E8F0] bg-white text-xs font-semibold text-[#475569] hover:bg-[#F8FAFC] hover:border-[#CBD5E1] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Next
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      </PageLoadTransition>

      {/* Add / Edit Modal */}
      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={editId ? 'Edit Faculty Member' : 'Add Faculty Member'}
        size="xl"
        footer={formFooter}
      >
        {saveSuccess && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-2xl backdrop-blur-md save-success-overlay">
            <div className="save-success-badge flex flex-col items-center gap-3 px-8 py-7 rounded-2xl bg-white border border-[#E2E8F0] shadow-2xl">
              <svg width="72" height="72" viewBox="0 0 52 52">
                <circle
                  className="save-success-circle"
                  cx="26" cy="26" r="24"
                  fill="none" stroke="#22C55E" strokeWidth="3"
                />
                <path
                  className="save-success-check"
                  fill="none" stroke="#22C55E" strokeWidth="3.5"
                  strokeLinecap="round" strokeLinejoin="round"
                  d="M14.5 27 22 34.5 38 17"
                />
              </svg>
              <p className="text-base font-semibold" style={{ color: '#0B2A5B' }}>
                {editId ? 'Faculty updated!' : 'Faculty added!'}
              </p>
            </div>
          </div>
        )}
        <form id="faculty-form" onSubmit={handleSubmit} noValidate>
          {formContent}
        </form>
      </Modal>

      {/* ── Delete Confirmation Modal ── */}
      <Modal
        open={!!deleteTarget}
        onClose={() => !deleteLoading && setDeleteTarget(null)}
        title="Delete Faculty Member"
      >
        {deleteSuccess && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-2xl backdrop-blur-md save-success-overlay">
            <div className="save-success-badge flex flex-col items-center gap-3 px-8 py-7 rounded-2xl bg-white border border-[#E2E8F0] shadow-2xl">
              <TrashDropAnimation className="bg-red-50 border-red-200" />
              <p className="text-base font-semibold" style={{ color: '#0B2A5B' }}>Faculty deleted!</p>
            </div>
          </div>
        )}
        {deleteTarget && (
          <div className="space-y-5">

            {/* Warning icon + headline */}
            <div className="flex flex-col items-center text-center gap-3 pt-1 pb-2">
              <div className="w-16 h-16 rounded-2xl bg-red-500/15 border border-red-500/30 flex items-center justify-center">
                <AlertTriangle className="w-8 h-8 text-red-400" />
              </div>
              <div>
                <p className="text-base font-bold text-white">Permanently Delete Faculty</p>
                <p className="text-sm text-slate-400 mt-1">This action cannot be undone.</p>
              </div>
            </div>

            {/* Faculty info card */}
            <div className="bg-white/5 border border-white/10 rounded-xl px-5 py-4 flex items-center gap-4">
              <div className="w-10 h-10 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center flex-shrink-0">
                <User className="w-5 h-5 text-red-400" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-bold text-white text-base truncate">{deleteTarget.name}</p>
                <p className="text-sm text-slate-400 truncate">{deleteTarget.position}</p>
              </div>
              <EmploymentBadge status={deleteTarget.employment_status} className="flex-shrink-0" />
            </div>

            {/* Confirmation message */}
            <p className="text-sm text-slate-300 leading-relaxed text-center px-1">
              Are you sure you want to permanently delete{' '}
              <strong className="text-white">{deleteTarget.name}</strong>?
              Their faculty account, workload assignments, and schedule entries will also be removed.
            </p>

            {/* What will be deleted */}
            <div className="bg-red-500/8 border border-red-500/25 rounded-xl px-5 py-4 space-y-2">
              <p className="text-xs font-bold text-red-400 uppercase tracking-wide mb-3">The following will be permanently deleted:</p>
              {[
                'Faculty profile and personal information',
                'Faculty login account and credentials',
                'All workload and load assignments',
                'PRAISE and overload records',
                'Load deductions and designations',
                'Profile picture',
              ].map(item => (
                <div key={item} className="flex items-center gap-2.5 text-sm text-red-300">
                  <Trash2 className="w-3.5 h-3.5 flex-shrink-0 text-red-500" />
                  {item}
                </div>
              ))}
              <p className="text-xs text-slate-500 mt-2 pt-2 border-t border-red-500/15">
                Schedule entries will have the faculty unassigned but will not be deleted.
              </p>
            </div>

            {/* Buttons */}
            <div className="flex gap-3 pt-1">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                disabled={deleteLoading}
                className="flex-1 py-3 border border-white/10 text-slate-300 rounded-xl hover:bg-white/10 transition text-sm font-semibold disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                disabled={deleteLoading}
                className="flex-1 py-3 bg-red-600 hover:bg-red-700 text-white rounded-xl transition text-sm font-bold flex items-center justify-center gap-2 disabled:opacity-60"
              >
                {deleteLoading
                  ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Deleting…</>
                  : <><Trash2 className="w-4 h-4" /> Yes, Delete Permanently</>}
              </button>
            </div>

          </div>
        )}
      </Modal>


    </div>
  );
}

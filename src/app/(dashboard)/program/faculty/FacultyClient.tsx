'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useToast } from '@/client/context/ToastContext';
import Modal from '@/client/components/ui/Modal';
import {
  Plus, Pencil, Trash2, Users,
  User, Briefcase, Lock, Eye, EyeOff, ChevronRight, ChevronDown, AlertTriangle,
} from 'lucide-react';
import { SearchInput, FilterSelect } from '@/components/ui/SearchFilter';
import { ListSkeleton, CardSkeleton, Skeleton } from '@/client/components/ui/skeletons';
import { PageLoadTransition } from '@/client/components/ui/PageLoadTransition';
import { PAGE_SKELETON_MIN_MS, useMinLoading } from '@/client/hooks/useMinLoading';

interface Program { id: number; code: string; name: string; }
interface Faculty {
  id: number;
  first_name: string | null; last_name: string | null; middle_name: string | null;
  name: string;
  program_id: number | null; program_code: string | null; program_name: string | null;
  position: string; employment_status: string;
  designation_type: string; designation_units: number;
  load_type: string; email: string | null;
  google_verified?: boolean;
  remaining_regular_load: number;
  years_in_service: number | null;
  educational_qualification: string | null;
  major: string | null;
  eligibility: string | null;
}

const POSITION_GROUPS: { label: string; items: string[] }[] = [
  { label: 'Hour-based', items: ['Contractual', 'Temporary Permanent'] },
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
  { label: 'Professor', items: ['Professor I', 'Professor II'] },
];

const POSITIONS = POSITION_GROUPS.flatMap(group => group.items);

const HOUR_BASED_POSITIONS = new Set(['Contractual', 'Temporary Permanent']);


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
};

function computeFullName(fn?: string | null, mn?: string | null, ln?: string | null) {
  return [(fn ?? '').trim(), (mn ?? '').trim(), (ln ?? '').trim()].filter(Boolean).join(' ');
}

function deriveEmploymentStatus(position: string): 'Permanent' | 'Contractual' {
  return HOUR_BASED_POSITIONS.has(position) ? 'Contractual' : 'Permanent';
}

// ── Small reusable pieces ─────────────────────────────────────────────────────

function EmploymentBadge({ status, position }: { status: string; position?: string }) {
  const isPermanent = position !== 'Temporary Permanent' && status === 'Permanent';
  const label = position === 'Temporary Permanent' ? 'Hour-based' : status;
  if (isPermanent) {
    return (
      <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold border"
        style={{ backgroundColor: '#F1F5F9', color: '#64748B', borderColor: '#CBD5E1' }}>
        {label}
      </span>
    );
  }
  return <span className="text-sm" style={{ color: '#64748B' }}>{label}</span>;
}

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
    function onReposition() {
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
          'w-full border rounded-xl px-4 py-3 text-base text-left text-white bg-[#0b0f1a]',
          'focus:outline-none focus:ring-2 focus:ring-[#3C91E6] focus:border-transparent transition',
          'flex items-center justify-between gap-3',
          error ? 'border-red-500/50' : 'border-white/10',
          open ? 'ring-2 ring-[#3C91E6] border-transparent' : '',
        ].join(' ')}
      >
        <span className={`truncate ${value ? '' : 'text-slate-500'}`}>
          {value || '— Select Position —'}
        </span>
        <ChevronDown className={`w-4 h-4 text-slate-400 flex-shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && createPortal(
        <div
          ref={dropRef}
          role="listbox"
          aria-label="Position / Academic Rank"
          style={dropStyle}
          className="overflow-y-auto rounded-xl border border-white/15 bg-[#111827] py-1.5 shadow-[0_12px_32px_rgba(15,23,42,0.18)] qr-fade-in"
        >
          {POSITION_GROUPS.map((group, index) => (
            <div key={group.label} className={index > 0 ? 'mt-1 pt-1 border-t border-white/10' : ''}>
              <p className="px-3 pt-1.5 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
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
                      'w-full text-left px-3 py-2 text-sm transition-colors duration-150',
                      'flex items-center gap-2',
                      isSelected
                        ? 'bg-[#3C91E6]/15 text-[#2563EB] font-semibold'
                        : 'text-slate-200 hover:bg-white/5',
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

function SectionHeader({ icon, title, subtitle }: { icon: React.ReactNode; title: string; subtitle?: string }) {
  return (
    <div className="flex items-start gap-3 mb-6">
      <div className="w-8 h-8 rounded-xl bg-[#3C91E6]/10 flex items-center justify-center text-[#3C91E6] flex-shrink-0 mt-0.5">
        {icon}
      </div>
      <div className="flex-1">
        <h3 className="text-base font-bold text-white">{title}</h3>
        {subtitle && <p className="text-sm text-slate-400 mt-0.5">{subtitle}</p>}
      </div>
      <div className="flex-1 h-px bg-white/10 mt-4 ml-2 max-w-[60%]" />
    </div>
  );
}

function FieldLabel({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <label className="block text-sm font-semibold text-slate-200 mb-2">
      {children}
      {required && <span className="text-red-400 ml-1">*</span>}
    </label>
  );
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="mt-2 text-sm text-red-400 flex items-center gap-1">⚠ {message}</p>;
}

function InputBase({ className = '', ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full border border-white/10 rounded-xl px-4 py-3 text-base text-white
        placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-[#3C91E6] focus:border-transparent
        bg-[#0b0f1a] disabled:opacity-50 transition ${className}`}
    />
  );
}

function SelectBase({ className = '', ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={`w-full border border-white/10 rounded-xl px-4 py-3 text-base text-white
        focus:outline-none focus:ring-2 focus:ring-[#3C91E6] focus:border-transparent
        bg-[#0b0f1a] transition ${className}`}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export default function FacultyPage() {
  const toast = useToast();
  const [faculty, setFaculty] = useState<Faculty[]>([]);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [form, setForm] = useState(emptyForm);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [editId, setEditId] = useState<number | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [loading, setLoading] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [googleVerified, setGoogleVerified] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Faculty | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  useEffect(() => {
    fetch('/api/programs').then(r => r.json()).then(d => setPrograms(d.programs || []));
    loadFaculty();
  }, []);

  useEffect(() => { loadFaculty(); }, [statusFilter]);

  function loadFaculty() {
    const params = new URLSearchParams();
    if (statusFilter) params.set('employment_status', statusFilter);
    setListLoading(true);
    fetch('/api/faculty?' + params)
      .then(r => r.json())
      .then(d => setFaculty(d.faculty || []))
      .finally(() => setListLoading(false));
  }

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
    setForm(emptyForm);
    setEditId(null);
    setFieldErrors({});
    setSubmitError('');
    setShowPassword(false);
    setShowConfirmPassword(false);
    setGoogleVerified(false);
    setModalOpen(true);
  }

  async function openEdit(f: Faculty) {
    setEditId(f.id);
    setFieldErrors({});
    setSubmitError('');
    setShowPassword(false);
    setShowConfirmPassword(false);

    setForm({
      first_name: f.first_name ?? '',
      last_name: f.last_name ?? '',
      middle_name: f.middle_name ?? '',
      program_id: f.program_id ? String(f.program_id) : '',
      position: f.position,
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
    });
    setModalOpen(true);

    try {
      const res = await fetch(`/api/faculty/${f.id}`);
      if (res.ok) {
        const data = await res.json();
        const detail = data.faculty;
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
        }));
        setGoogleVerified(detail.google_verified === true);
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
      setModalOpen(false);
      toast.success(editId ? 'Faculty updated successfully.' : 'Faculty added successfully.');
      loadFaculty();
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
        toast.delete(`${deleteTarget.name} has been permanently deleted.`);
        setDeleteTarget(null);
        loadFaculty();
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
    .filter(f =>
      !search ||
      f.name.toLowerCase().includes(search.toLowerCase()) ||
      (f.program_code || '').toLowerCase().includes(search.toLowerCase()) ||
      (f.program_name || '').toLowerCase().includes(search.toLowerCase()) ||
      f.position.toLowerCase().includes(search.toLowerCase())
    )
    .sort((a, b) => POSITIONS.indexOf(b.position) - POSITIONS.indexOf(a.position));

  const totalPermanent = faculty.filter(f => f.employment_status === 'Permanent').length;
  const totalContractual = faculty.filter(f => f.employment_status === 'Contractual').length;
  const showListSkeleton = useMinLoading(listLoading && faculty.length === 0, PAGE_SKELETON_MIN_MS);

  // ── Form ─────────────────────────────────────────────────────────────────────

  const errorBorder = (field: string) => fieldErrors[field] ? 'border-red-500/50 focus:ring-red-500' : '';

  const formContent = (
    <div className="space-y-10">

      {/* ── 1. Personal Information ── */}
      <section>
        <SectionHeader
          icon={<User className="w-4 h-4" />}
          title="Personal Information"
          subtitle="Enter the faculty member's full name."
        />
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
            <FieldLabel>
              Middle Name&nbsp;<span className="text-slate-500 font-normal">(optional)</span>
            </FieldLabel>
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
              Full Name&nbsp;
              <span className="ml-1 inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-white/10 text-slate-400 font-normal">
                Auto-generated
              </span>
            </FieldLabel>
            <div className="w-full border border-white/10 rounded-xl px-4 py-3 text-base bg-white/5 text-slate-300 min-h-[50px] flex items-center">
              {fullName
                ? <span className="font-medium text-white">{fullName}</span>
                : <span className="text-slate-500 italic text-sm">Will fill automatically from name above</span>}
            </div>
          </div>

        </div>
      </section>

      {/* ── 2. Employment Information ── */}
      <section>
        <SectionHeader
          icon={<Briefcase className="w-4 h-4" />}
          title="Employment Information"
          subtitle="Select the program and position of this faculty member."
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">

          <div className="sm:col-span-2">
            <FieldLabel required>Program</FieldLabel>
            <SelectBase
              value={form.program_id}
              onChange={e => setField('program_id', e.target.value)}
              className={errorBorder('program_id')}
              data-field="program_id"
            >
              <option value="">— Select Program —</option>
              {programs.map(p => (
                <option key={p.id} value={p.id}>{p.code} — {p.name}</option>
              ))}
            </SelectBase>
            <FieldError message={fieldErrors.program_id} />
          </div>

          <div className="sm:col-span-2">
            <FieldLabel required>Position / Academic Rank</FieldLabel>
            <PositionSelect
              value={form.position}
              onChange={handlePositionChange}
              error={!!fieldErrors.position}
            />
            <FieldError message={fieldErrors.position} />
          </div>

        </div>
      </section>

      {/* ── 3. Professional Profile ── */}
      <section>
        <SectionHeader
          icon={<Briefcase className="w-4 h-4" />}
          title="Professional Profile"
          subtitle="Optional fields shown on the Instructor Workload print form."
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">

          <div>
            <FieldLabel>
              Years in Service&nbsp;<span className="text-slate-500 font-normal">(optional)</span>
            </FieldLabel>
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
            <FieldLabel>
              Educational Qualification&nbsp;<span className="text-slate-500 font-normal">(optional)</span>
            </FieldLabel>
            <InputBase
              value={form.educational_qualification}
              onChange={e => setField('educational_qualification', e.target.value)}
              placeholder="e.g., Master of Science in IT"
              maxLength={255}
            />
          </div>

          <div>
            <FieldLabel>
              Major&nbsp;<span className="text-slate-500 font-normal">(optional)</span>
            </FieldLabel>
            <InputBase
              value={form.major}
              onChange={e => setField('major', e.target.value)}
              placeholder="e.g., Computer Science"
              maxLength={255}
            />
          </div>

          <div>
            <FieldLabel>
              Eligibility / PRC&nbsp;<span className="text-slate-500 font-normal">(optional)</span>
            </FieldLabel>
            <InputBase
              value={form.eligibility}
              onChange={e => setField('eligibility', e.target.value)}
              placeholder="e.g., LPT / PRC No. 0123456"
              maxLength={255}
            />
          </div>

        </div>
      </section>

      {/* ── 4. Account Information ── */}
      <section>
        <SectionHeader
          icon={<Lock className="w-4 h-4" />}
          title="Account Information"
          subtitle={editId
            ? 'Update login credentials. Leave Password blank to keep the current password.'
            : 'Create the login account for this faculty member. They will use these to sign in as Instructor.'}
        />

        {/* Role display */}
        <div className="mb-5 rounded-xl bg-white/5 border border-white/10 px-5 py-4 flex items-center gap-3">
          <span className="text-sm font-semibold text-slate-300">Role:</span>
          <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-semibold bg-blue-500/20 text-blue-400 border border-blue-500/30">
            Instructor
          </span>
          <span className="text-xs text-slate-500 ml-auto">Role is fixed for faculty accounts</span>
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
            <div className="mt-2 flex items-center gap-2">
              {editId && googleVerified ? (
                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                  Google Account: Verified
                </span>
              ) : (
                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/30">
                  Google Account: Not Verified
                </span>
              )}
            </div>
            <p className="mt-1.5 text-xs text-slate-500">
              {editId
                ? 'Changing this email will require the instructor to verify with Google again.'
                : 'The instructor must sign in and connect this Google account to verify it.'}
            </p>
          </div>

          <div>
            <FieldLabel required={!editId}>
              {editId ? 'New Password' : 'Password'}
              {editId && <span className="text-slate-500 font-normal ml-1">(optional)</span>}
            </FieldLabel>
            <div className="relative">
              <InputBase
                type={showPassword ? 'text' : 'password'}
                value={form.password}
                onChange={e => setField('password', e.target.value)}
                placeholder={editId ? 'Leave blank to keep current password' : 'At least 8 characters'}
                autoComplete="new-password"
                className={`pr-12 ${errorBorder('password')}`}
                data-field="password"
              />
              <button
                type="button"
                onClick={() => setShowPassword(p => !p)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white p-1 transition-colors"
                tabIndex={-1}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <FieldError message={fieldErrors.password} />
            {!editId && !fieldErrors.password && (
              <p className="mt-1.5 text-xs text-slate-500">Minimum 8 characters</p>
            )}
          </div>

          <div>
            <FieldLabel required={!editId}>
              {editId ? 'Confirm New Password' : 'Confirm Password'}
              {editId && <span className="text-slate-500 font-normal ml-1">(optional)</span>}
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
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white p-1 transition-colors"
                tabIndex={-1}
                aria-label={showConfirmPassword ? 'Hide password' : 'Show password'}
              >
                {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <FieldError message={fieldErrors.confirmPassword} />
          </div>

        </div>
      </section>

    </div>
  );

  const formFooter = (
    <div className="flex flex-col sm:flex-row gap-3">
      {submitError && (
        <div className="flex-1 bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-2.5 rounded-xl text-sm">
          ⚠ {submitError}
        </div>
      )}
      <div className="flex gap-3 sm:ml-auto">
        <button
          type="button"
          onClick={() => setModalOpen(false)}
          className="px-6 py-3 border border-white/10 text-slate-300 rounded-xl hover:bg-white/10 transition text-sm font-semibold min-w-[110px]"
        >
          Cancel
        </button>
        <button
          type="submit"
          form="faculty-form"
          disabled={loading}
          className="px-6 py-3 bg-[#3C91E6] text-white rounded-xl hover:bg-[#2E7DD1] disabled:opacity-50 transition text-sm font-semibold min-w-[150px]"
        >
          {loading ? 'Saving…' : editId ? 'Update Faculty' : 'Add Faculty'}
        </button>
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
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
              <CardSkeleton className="h-24" />
              <CardSkeleton className="h-24" />
              <CardSkeleton className="h-24" />
            </div>

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
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between mb-6">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold break-words" style={{ color: '#1E3A5F' }}>Faculty Profiles</h1>
          <p className="text-sm mt-0.5" style={{ color: '#64748B' }}>Manage instructor positions, employment status, and designations</p>
        </div>
        <button
          onClick={openAdd}
          className="inline-flex items-center justify-center gap-2 px-5 py-2.5 min-h-11 rounded-xl transition font-semibold text-sm shadow-sm hover:opacity-90 w-full sm:w-auto flex-shrink-0"
          style={{ backgroundColor: '#3C91E6', color: '#ffffff' }}
        >
          <Plus className="w-4 h-4" /> Add Faculty
        </button>
      </div>

      {/* Stats */}
      {faculty.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4 mb-6">
          <div className="bg-white border border-[#E2E8F0] rounded-2xl p-4 sm:p-5 text-center shadow-sm">
            <div className="text-3xl sm:text-4xl font-black mb-1.5" style={{ color: '#1E3A5F' }}>{totalPermanent}</div>
            <div className="text-sm font-medium" style={{ color: '#64748B' }}>Permanent</div>
          </div>
          <div className="bg-white border border-[#E2E8F0] rounded-2xl p-4 sm:p-5 text-center shadow-sm">
            <div className="text-3xl sm:text-4xl font-black mb-1.5" style={{ color: '#1E3A5F' }}>{totalContractual}</div>
            <div className="text-sm font-medium" style={{ color: '#64748B' }}>Contractual</div>
          </div>
          <div className="bg-white border border-[#E2E8F0] rounded-2xl p-4 sm:p-5 text-center shadow-sm">
            <div className="text-3xl sm:text-4xl font-black mb-1.5" style={{ color: '#1E3A5F' }}>{faculty.length}</div>
            <div className="text-sm font-medium" style={{ color: '#64748B' }}>Total Faculty</div>
          </div>
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
          {filtered.length === 0 ? (
            <div className="text-center py-14 px-4 text-sm" style={{ color: '#64748B' }}>
              No faculty found.
            </div>
          ) : filtered.map(f => {
            const empStatus = f.employment_status || deriveEmploymentStatus(f.position);
            const isPermanent = empStatus === 'Permanent';
            return (
              <div key={f.id} className="p-4 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-base break-words leading-snug" style={{ color: '#1E3A5F' }}>{f.name}</p>
                    <p className="text-sm mt-1 break-words" style={{ color: '#64748B' }}>
                      {f.position}
                      {f.program_code ? ` · ${f.program_code}` : ''}
                    </p>
                    {f.program_name && (
                      <p className="text-xs mt-0.5 break-words" style={{ color: '#94A3B8' }}>{f.program_name}</p>
                    )}
                    {!f.program_code && (
                      <p className="text-xs italic mt-0.5 font-medium" style={{ color: '#D97706' }}>Not assigned</p>
                    )}
                  </div>
                  <div className="flex gap-1 flex-shrink-0">
                    <button
                      type="button"
                      onClick={() => openEdit(f)}
                      className="min-h-11 min-w-11 inline-flex items-center justify-center rounded-xl transition hover:bg-[#EFF6FF]"
                      style={{ color: '#3C91E6' }}
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
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" style={{ color: '#64748B' }}>
                  <span>{f.designation_type}</span>
                  <span className="font-bold" style={{ color: '#3C91E6' }}>
                    {isPermanent
                      ? `${Math.round(parseFloat(String(f.remaining_regular_load)))} units`
                      : '30 hrs'}
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
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-14" style={{ color: '#64748B' }}>
                    No faculty found.
                  </td>
                </tr>
              ) : filtered.map(f => {
                const empStatus = f.employment_status || deriveEmploymentStatus(f.position);
                const isPermanent = empStatus === 'Permanent';
                return (
                  <tr key={f.id} className="hover:bg-[#F8FAFC] transition-colors">
                    <td className="px-5 py-4 font-semibold" style={{ color: '#1E3A5F' }}>{f.name}</td>
                    <td className="px-5 py-4">
                      {f.program_code
                        ? (
                          <div>
                            <span className="font-semibold text-xs" style={{ color: '#1E3A5F' }}>{f.program_code}</span>
                            {f.program_name && (
                              <p className="text-[11px] leading-tight mt-0.5 max-w-[200px] break-words" style={{ color: '#64748B' }}>{f.program_name}</p>
                            )}
                          </div>
                        )
                        : <span className="text-xs italic font-medium" style={{ color: '#D97706' }}>Not assigned</span>}
                    </td>
                    <td className="px-5 py-4 font-medium" style={{ color: '#1E3A5F' }}>{f.position}</td>
                    <td className="px-5 py-4 text-xs" style={{ color: '#64748B' }}>{f.designation_type}</td>
                    <td className="px-5 py-4 text-center font-bold" style={{ color: '#3C91E6' }}>
                      {isPermanent
                        ? `${Math.round(parseFloat(String(f.remaining_regular_load)))} units`
                        : '30 hrs'
                      }
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex gap-1.5">
                        <button
                          type="button"
                          onClick={() => openEdit(f)}
                          className="p-2 min-h-11 min-w-11 inline-flex items-center justify-center rounded-lg transition hover:bg-[#EFF6FF]"
                          style={{ color: '#3C91E6' }}
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
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {filtered.length > 0 && (
          <div className="px-5 py-3 border-t border-[color:var(--border)] text-xs text-[#64748B]">
            {filtered.length} instructor{filtered.length !== 1 ? 's' : ''}
          </div>
        )}
      </div>
      </PageLoadTransition>

      {/* Add / Edit Modal */}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editId ? 'Edit Faculty Member' : 'Add Faculty Member'}
        size="xl"
        footer={formFooter}
      >
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
              <EmploymentBadge status={deleteTarget.employment_status} position={deleteTarget.position} />
            </div>

            {/* Confirmation message */}
            <p className="text-sm text-slate-300 leading-relaxed text-center px-1">
              Are you sure you want to permanently delete{' '}
              <strong className="text-white">{deleteTarget.name}</strong>?
              Their instructor account, workload assignments, and schedule entries will also be removed.
            </p>

            {/* What will be deleted */}
            <div className="bg-red-500/8 border border-red-500/25 rounded-xl px-5 py-4 space-y-2">
              <p className="text-xs font-bold text-red-400 uppercase tracking-wide mb-3">The following will be permanently deleted:</p>
              {[
                'Faculty profile and personal information',
                'Instructor login account and credentials',
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
                Schedule entries will have the instructor unassigned but will not be deleted.
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

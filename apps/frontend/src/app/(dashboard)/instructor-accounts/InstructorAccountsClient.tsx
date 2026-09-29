'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '@/context/ToastContext';
import Modal from '@/components/ui/Modal';
import BackButton from '@/components/ui/BackButton';
import WatermarkTitle from '@/components/ui/WatermarkTitle';
import TrashDropAnimation from '@/components/ui/TrashDropAnimation';
import { PageLoadTransition } from '@/components/ui/PageLoadTransition';
import { TableSkeleton } from '@/components/ui/skeletons';
import { LOADING_DELAY, useMinLoading } from '@/hooks/useMinLoading';
import {
  Plus, Pencil, Trash2, Eye, EyeOff, UserCog, ShieldCheck,
  ShieldX, KeyRound, User, X, AlertTriangle, CheckCircle2,
  Upload, Camera, ChevronDown, MoreHorizontal,
} from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';
import AnchoredPopover from '@/components/ui/AnchoredPopover';
import { SearchInput, FilterSelect } from '@/components/ui/SearchFilter';
import SubjectMultiSelect, { type PrioritySubject } from '@/components/ui/SubjectMultiSelect';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Program { id: number; code: string; name: string; }

interface InstructorAccount {
  account_id: number;
  faculty_id: number;
  username: string;
  email: string;
  role: string;
  is_active: boolean;
  account_created_at: string;
  account_updated_at: string;
  name: string;
  first_name: string | null;
  last_name: string | null;
  middle_name: string | null;
  employee_id: string | null;
  position: string;
  employment_status: string;
  program_id: number | null;
  program_code: string | null;
  program_name: string | null;
  profile_picture: string | null;
  specialization?: string | null;
  priority_subjects?: PrioritySubject[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const POSITIONS = [
  'Contractual',
  'Temporary Permanent',
  'Instructor I', 'Instructor II', 'Instructor III',
  'Assistant Professor I', 'Assistant Professor II', 'Assistant Professor III',
  'Assistant Professor IV', 'Assistant Professor V',
  'Associate Professor I', 'Associate Professor II',
  'Associate Professor III', 'Associate Professor IV',
  'Professor I', 'Professor II', 'Professor III',
  'Professor IV', 'Professor V', 'Professor VI',
];

const emptyForm = {
  first_name: '', last_name: '', middle_name: '',
  program_id: '', position: '',
  username: '', email: '', password: '', confirmPassword: '',
  priority_subjects: [] as PrioritySubject[],
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function avatarUrl(account: InstructorAccount, bust = false): string | null {
  if (!account.profile_picture) return null;
  const base = account.profile_picture.split('?')[0];
  return bust ? `${base}?t=${Date.now()}` : base;
}

function fmtDate(iso: string) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
}

function initials(name: string) {
  return name.split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ active }: { active: boolean }) {
  return active
    ? <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 flex-shrink-0" />Active
      </span>
    : <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-500/20 text-slate-400 border border-slate-500/30">
        <span className="w-1.5 h-1.5 rounded-full bg-slate-500 flex-shrink-0" />Inactive
      </span>;
}


function Avatar({ account, size = 10 }: { account: InstructorAccount; size?: number }) {
  const [err, setErr] = useState(false);
  const url = avatarUrl(account);
  const px = size * 4;
  const cls = `w-${size} h-${size} rounded-full object-cover flex-shrink-0`;
  if (url && !err) {
    return <img src={url} alt={account.name} className={cls} style={{ width: px, height: px }} onError={() => setErr(true)} />;
  }
  return (
    <div className={`w-${size} h-${size} rounded-full bg-[#1D5BD6]/20 border border-[#1D5BD6]/30 flex items-center justify-center flex-shrink-0 text-[#1D5BD6] font-bold`}
      style={{ width: px, height: px, fontSize: px / 3.5 }}>
      {initials(account.name) || <User className="w-4 h-4" />}
    </div>
  );
}

function PositionSelect({ value, onChange, error }: { value: string; onChange: (v: string) => void; error?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(p => !p)}
        className={`w-full flex items-center justify-between bg-[#0b0f1a] border rounded-xl px-4 py-3 text-sm text-white text-left transition focus:outline-none focus:ring-1 focus:ring-[#1D5BD6]/50
          ${error ? 'border-red-500/60' : 'border-white/10 hover:border-white/20'}`}
      >
        <span className={value ? 'text-white' : 'text-slate-500'}>{value || '— Select Position —'}</span>
        <ChevronDown className={`w-4 h-4 text-slate-500 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-full bg-[#111827] border border-white/10 rounded-xl shadow-2xl overflow-hidden">
          <div className="max-h-60 overflow-y-auto py-1">
            {POSITIONS.map(p => (
              <button key={p} type="button"
                onClick={() => { onChange(p); setOpen(false); }}
                className={`w-full px-4 py-2.5 text-left text-sm transition-colors hover:bg-white/[0.06]
                  ${value === p ? 'text-[#1D5BD6] font-semibold bg-[#1D5BD6]/10' : 'text-slate-300'}`}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PasswordInput({
  value, onChange, placeholder, error, label, id,
}: { value: string; onChange: (v: string) => void; placeholder?: string; error?: boolean; label: string; id: string }) {
  const [show, setShow] = useState(false);
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-semibold text-slate-300 mb-2">{label}</label>
      <div className="relative">
        <input
          id={id}
          type={show ? 'text' : 'password'}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete="new-password"
          className={`w-full bg-[#0b0f1a] border rounded-xl px-4 py-3 pr-12 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-[#1D5BD6]/50 transition
            ${error ? 'border-red-500/60' : 'border-white/10 hover:border-white/20'}`}
        />
        <button
          type="button"
          onClick={() => setShow(s => !s)}
          tabIndex={-1}
          className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-slate-500 hover:text-slate-300 transition-colors rounded"
          aria-label={show ? 'Hide password' : 'Show password'}
        >
          {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
}

function FormField({ label, id, type = 'text', value, onChange, placeholder, error, required, hint }:
  { label: string; id: string; type?: string; value: string; onChange: (v: string) => void;
    placeholder?: string; error?: boolean; required?: boolean; hint?: string }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-semibold text-slate-300 mb-2">
        {label}{required && <span className="text-red-400 ml-1">*</span>}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full bg-[#0b0f1a] border rounded-xl px-4 py-3 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-[#1D5BD6]/50 transition
          ${error ? 'border-red-500/60' : 'border-white/10 hover:border-white/20'}`}
      />
      {hint && <p className="text-xs text-slate-500 mt-1">{hint}</p>}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function InstructorAccountsClient() {
  const toast = useToast();
  const [accounts, setAccounts] = useState<InstructorAccount[]>([]);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [loading, setLoading]   = useState(true);
  const [search, setSearch]     = useState('');
  const [filterStatus, setFilterStatus]     = useState('');
  const [filterPosition, setFilterPosition] = useState('');
  const showSkeleton = useMinLoading(loading && accounts.length === 0, LOADING_DELAY);
  const [showSaveSkeleton, setShowSaveSkeleton] = useState(false);

  // Modal state
  const [modalOpen, setModalOpen]   = useState(false);
  const [editTarget, setEditTarget] = useState<InstructorAccount | null>(null);
  const [form, setForm] = useState({ ...emptyForm });
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [formLoading, setFormLoading] = useState(false);
  const [formMsg, setFormMsg] = useState('');
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Delete modal
  const [deleteTarget, setDeleteTarget] = useState<InstructorAccount | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [deleteSuccess, setDeleteSuccess] = useState(false);
  const [showDeleteSkeleton, setShowDeleteSkeleton] = useState(false);
  const tableSkeletonVisible = showSkeleton || showSaveSkeleton || showDeleteSkeleton;

  // Reset password modal
  const [resetTarget, setResetTarget] = useState<InstructorAccount | null>(null);
  const [resetPw, setResetPw]         = useState('');
  const [resetConfirmPw, setResetConfirmPw] = useState('');
  const [resetLoading, setResetLoading] = useState(false);
  const [resetError, setResetError]   = useState('');
  const [resetSuccess, setResetSuccess] = useState('');

  // Toggle active
  const [togglingId, setTogglingId] = useState<number | null>(null);

  // Picture upload
  const [picUploading, setPicUploading] = useState(false);
  const [picError, setPicError] = useState('');
  const picInputRef = useRef<HTMLInputElement>(null);


  // Confirmation dialogs
  const [formConfirmOpen, setFormConfirmOpen]       = useState(false);
  const [toggleConfirmTarget, setToggleConfirmTarget] = useState<InstructorAccount | null>(null);
  const [resetConfirmOpen, setResetConfirmOpen]     = useState(false);

  // ── Data loading ──────────────────────────────────────────────────────────

  const loadAccounts = useCallback(() => {
    setLoading(true);
    const p = new URLSearchParams();
    if (search)         p.set('search', search);
    if (filterStatus)   p.set('status', filterStatus);
    if (filterPosition) p.set('position', filterPosition);
    fetch('/api/instructor-accounts?' + p.toString())
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setAccounts(d.accounts || []); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [search, filterStatus, filterPosition]);

  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  useEffect(() => {
    fetch('/api/programs')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setPrograms(d.programs || []); })
      .catch(() => {});
  }, []);

  /* Subjects to Handle — pulled from the full curriculum across all programs
     (not scoped to whichever program this faculty belongs to). */
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

  // ── Form helpers ──────────────────────────────────────────────────────────

  function openCreate() {
    setEditTarget(null);
    setForm({ ...emptyForm });
    setFormErrors({});
    setFormMsg('');
    setPicError('');
    setModalOpen(true);
  }

  function openEdit(a: InstructorAccount) {
    setEditTarget(a);
    setForm({
      first_name:     a.first_name || '',
      last_name:      a.last_name  || '',
      middle_name:    a.middle_name || '',
      program_id:     a.program_id ? String(a.program_id) : '',
      position:       a.position,
      username:       a.username,
      email:          a.email,
      password:       '',
      confirmPassword: '',
      priority_subjects: a.priority_subjects ?? [],
    });
    setFormErrors({});
    setFormMsg('');
    setPicError('');
    setModalOpen(true);
  }

  function setField(key: keyof typeof emptyForm, val: string) {
    setForm(p => ({ ...p, [key]: val }));
    setFormErrors(p => { const n = { ...p }; delete n[key]; return n; });
  }

  function setPrioritySubjectsField(next: PrioritySubject[]) {
    setForm(p => ({ ...p, priority_subjects: next }));
  }

  function validateForm(): boolean {
    const errs: Record<string, string> = {};
    if (!form.first_name.trim())   errs.first_name = 'First Name is required.';
    if (!form.last_name.trim())    errs.last_name  = 'Last Name is required.';
    if (!form.program_id)          errs.program_id = 'Program is required.';
    if (!form.position)            errs.position   = 'Position / Academic Rank is required.';
    if (!form.username.trim())     errs.username   = 'Username is required.';
    if (form.username && !/^[a-zA-Z0-9_]+$/.test(form.username.trim()))
      errs.username = 'Username may only contain letters, numbers, and underscores.';
    if (!form.email.trim())        errs.email      = 'Email is required.';
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim()))
      errs.email = 'Please enter a valid email address.';
    if (!editTarget && !form.password)  errs.password = 'Password is required.';
    if (form.password && form.password.length < 8)
      errs.password = 'Password must be at least 8 characters.';
    if (form.password && form.password !== form.confirmPassword)
      errs.confirmPassword = 'Passwords do not match.';
    setFormErrors(errs);
    return Object.keys(errs).length === 0;
  }

  function submitForm(e: React.FormEvent) {
    e.preventDefault();
    if (!validateForm()) return;
    setFormMsg('');
    setFormConfirmOpen(true);
  }

  async function executeSubmit() {
    setFormConfirmOpen(false);
    setFormLoading(true);
    setFormMsg('');

    const payload = {
      first_name:  form.first_name.trim(),
      last_name:   form.last_name.trim(),
      middle_name: form.middle_name.trim(),
      program_id:  form.program_id ? Number(form.program_id) : null,
      position:    form.position,
      username:    form.username.trim(),
      email:       form.email.trim(),
      password:    form.password || undefined,
      priority_subjects: form.priority_subjects,
    };

    try {
      const url    = editTarget ? `/api/instructor-accounts/${editTarget.faculty_id}` : '/api/instructor-accounts';
      const method = editTarget ? 'PUT' : 'POST';
      const res    = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!res.ok) {
        let data: { error?: string; field?: string } | null = null;
        try { data = await res.json(); } catch { /* html */ }
        if (data?.field) setFormErrors(p => ({ ...p, [data!.field!]: data!.error ?? '' }));
        else setFormMsg(data?.error ?? 'Failed to save.');
        return;
      }
      await res.json();

      setFormLoading(false);
      setSaveSuccess(true);
      setShowSaveSkeleton(true);
      loadAccounts();
      setTimeout(() => {
        setSaveSuccess(false);
        setShowSaveSkeleton(false);
        setModalOpen(false);
        toast.success(editTarget ? 'Account updated successfully.' : 'Faculty account created successfully.');
      }, 1300);
      return;
    } catch {
      setFormMsg('Connection error. Please try again.');
    } finally {
      setFormLoading(false);
    }
  }

  // ── Toggle active ─────────────────────────────────────────────────────────

  function handleToggleActive(a: InstructorAccount) {
    setToggleConfirmTarget(a);
  }

  async function toggleActive(a: InstructorAccount) {
    setToggleConfirmTarget(null);
    setTogglingId(a.faculty_id);
    try {
      const res  = await fetch(`/api/instructor-accounts/${a.faculty_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: !a.is_active }),
      });
      if (!res.ok) {
        let msg = 'Failed to update status.';
        try { msg = ((await res.json()) as { error?: string })?.error ?? msg; } catch { /* html */ }
        toast.error(msg); return;
      }
      await res.json().catch(() => null);
      setAccounts(prev => prev.map(x =>
        x.faculty_id === a.faculty_id ? { ...x, is_active: !a.is_active } : x
      ));
      if (!a.is_active) toast.success('Account activated successfully.');
      else toast.delete('Account deactivated successfully.');
    } catch {
      toast.error('Connection error. Please try again.');
    } finally {
      setTogglingId(null);
    }
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    setDeleteError('');
    try {
      const res = await fetch(`/api/instructor-accounts/${deleteTarget.faculty_id}`, { method: 'DELETE' });
      if (!res.ok) {
        let msg = 'Failed to delete.';
        try { msg = ((await res.json()) as { error?: string })?.error ?? msg; } catch { /* html */ }
        setDeleteError(msg); return;
      }
      const deletedName = deleteTarget.name;
      setDeleteLoading(false);
      setDeleteSuccess(true);
      setShowDeleteSkeleton(true);
      loadAccounts();
      setTimeout(() => {
        setDeleteSuccess(false);
        setShowDeleteSkeleton(false);
        setDeleteTarget(null);
        toast.delete(`${deletedName}'s account has been deactivated.`);
      }, 1300);
      return;
    } catch {
      setDeleteError('Connection error. Please try again.');
    } finally {
      setDeleteLoading(false);
    }
  }

  // ── Reset password ────────────────────────────────────────────────────────

  function openReset(a: InstructorAccount) {
    setResetTarget(a);
    setResetPw('');
    setResetConfirmPw('');
    setResetError('');
    setResetSuccess('');
  }

  function confirmReset() {
    if (!resetTarget) return;
    if (resetPw.length < 8)     { setResetError('Password must be at least 8 characters.'); return; }
    if (resetPw !== resetConfirmPw) { setResetError('Passwords do not match.'); return; }
    setResetError('');
    setResetConfirmOpen(true);
  }

  async function executeReset() {
    if (!resetTarget) return;
    setResetConfirmOpen(false);
    setResetLoading(true);
    setResetError('');
    try {
      const res = await fetch(`/api/instructor-accounts/${resetTarget.faculty_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_password: resetPw }),
      });
      if (!res.ok) {
        let msg = 'Failed to reset password.';
        try { msg = ((await res.json()) as { error?: string })?.error ?? msg; } catch { /* html */ }
        setResetError(msg); return;
      }
      await res.json().catch(() => null);
      setResetSuccess('Password reset successfully.');
      setResetPw(''); setResetConfirmPw('');
      setTimeout(() => { setResetTarget(null); toast.success(`Password reset for ${resetTarget.name}.`); }, 1200);
    } catch {
      setResetError('Connection error. Please try again.');
    } finally {
      setResetLoading(false);
    }
  }

  // ── Profile picture ───────────────────────────────────────────────────────

  async function uploadPicture(file: File) {
    if (!editTarget) return;
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) {
      setPicError('Only JPEG, PNG, WebP, or GIF images are allowed.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setPicError('File must be under 5 MB.');
      return;
    }
    setPicUploading(true);
    setPicError('');
    const fd = new FormData();
    fd.append('picture', file);
    try {
      const res  = await fetch(`/api/instructor-accounts/${editTarget.faculty_id}/picture`, { method: 'POST', body: fd });
      if (!res.ok) {
        let msg = 'Upload failed.';
        try { msg = ((await res.json()) as { error?: string })?.error ?? msg; } catch { /* html */ }
        setPicError(msg); return;
      }
      const data = await res.json();
      // Update local list so avatar refreshes in table
      setAccounts(prev => prev.map(x =>
        x.faculty_id === editTarget.faculty_id
          ? { ...x, profile_picture: data.picture_url.split('?')[0] }
          : x
      ));
      setEditTarget(prev => prev ? { ...prev, profile_picture: data.picture_url.split('?')[0] } : prev);
      toast.success('Profile picture updated.');
    } catch {
      setPicError('Upload failed. Please try again.');
    } finally {
      setPicUploading(false);
      if (picInputRef.current) picInputRef.current.value = '';
    }
  }

  // ── Toast auto-dismiss ────────────────────────────────────────────────────

  // ─── Render ───────────────────────────────────────────────────────────────

  const uniquePositions = [...new Set(accounts.map(a => a.position))].sort();

  return (
    <div className="min-h-screen bg-[#0b0f1a] text-white">


      <div className="p-4 sm:p-6 max-w-7xl mx-auto w-full min-w-0 space-y-6">

        {/* ── Page header (same as the other sections) ── */}
        <div>
          <BackButton />
          <div className="mt-4 sm:mt-7 mb-4">
            <WatermarkTitle>Faculty Accounts</WatermarkTitle>
          </div>
          <div className="flex justify-end">
            <button
              onClick={openCreate}
              className="flex items-center gap-2 bg-[#1D5BD6] hover:bg-[#164BB5] px-5 h-11 rounded-xl font-semibold text-[15px] transition-colors shadow-lg shadow-[#1D5BD6]/20"
              style={{ color: '#FFFFFF' }}
            >
              <Plus className="w-4 h-4" />
              Add Faculty Account
            </button>
          </div>
        </div>

        {/* ── Filters ── */}
        <div className="bg-white rounded-2xl shadow-[0_1px_3px_rgba(0,0,0,0.06)] p-5">
          <div className="flex flex-wrap gap-3">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="Search name, username, email, position…"
              className="flex-1 min-w-[220px]"
            />

            <FilterSelect value={filterStatus} onChange={setFilterStatus} label="Status" className="min-w-[140px]">
              <option value="">All Status</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </FilterSelect>

            <FilterSelect value={filterPosition} onChange={setFilterPosition} label="Position" className="min-w-[160px]">
              <option value="">All Positions</option>
              {uniquePositions.map(p => <option key={p} value={p}>{p}</option>)}
            </FilterSelect>

            {(search || filterStatus || filterPosition) && (
              <button
                onClick={() => { setSearch(''); setFilterStatus(''); setFilterPosition(''); }}
                className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-sm text-slate-500 hover:text-slate-700 border border-slate-200 hover:border-slate-300 bg-white transition-all duration-150"
              >
                <X className="w-3.5 h-3.5" /> Clear
              </button>
            )}
          </div>

          <p className="text-xs text-slate-400 mt-3">
            {tableSkeletonVisible ? 'Loading…' : `${accounts.length} faculty account${accounts.length !== 1 ? 's' : ''} found`}
          </p>
        </div>

        {/* ── Table ── */}
        <PageLoadTransition
          showSkeleton={tableSkeletonVisible}
          skeleton={<TableSkeleton cols={7} rows={8} />}
        >
        <div className="bg-[#111827] border border-white/10 rounded-2xl overflow-hidden">
          {accounts.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 gap-3">
              <div className="w-14 h-14 rounded-2xl bg-white/5 flex items-center justify-center">
                <UserCog className="w-7 h-7 text-slate-600" />
              </div>
              <p className="text-slate-400 font-medium">No faculty accounts found</p>
              <p className="text-slate-600 text-sm">
                {search || filterStatus || filterPosition ? 'Try adjusting your search or filters.' : 'Click "Add Faculty Account" to create one.'}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10 bg-white/[0.02]">
                    <th className="px-4 sm:px-5 py-4 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap">Faculty</th>
                    <th className="hidden md:table-cell px-5 py-4 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap">Position</th>
                    <th className="hidden md:table-cell px-5 py-4 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap">Username</th>
                    <th className="hidden lg:table-cell px-5 py-4 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap">Email</th>
                    <th className="hidden sm:table-cell px-5 py-4 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap">Status</th>
                    <th className="hidden lg:table-cell px-5 py-4 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap">Created</th>
                    <th className="px-5 py-4 text-right text-xs font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.05]">
                  {accounts.map(a => (
                    <tr key={a.faculty_id} className={`transition-colors hover:bg-white/[0.03] ${!a.is_active ? 'opacity-60' : ''}`}>

                      {/* Instructor */}
                      <td className="px-4 sm:px-5 py-4">
                        <div className="flex items-center gap-3">
                          <Avatar account={a} size={10} />
                          <div className="min-w-0">
                            <p className="font-semibold text-white leading-tight break-words">{a.name}</p>
                            {a.specialization && (
                              <p className="text-xs text-[#1D5BD6] mt-0.5">{a.specialization}</p>
                            )}
                            <p className="text-xs text-slate-500 mt-0.5">{a.employee_id || '—'}</p>
                            {/* Phone/tablet: hidden columns fold in under the name */}
                            <p className="md:hidden text-xs text-slate-400 mt-1 break-all">{a.position} · <span className="font-mono">{a.username}</span></p>
                            <div className="sm:hidden mt-1.5"><StatusBadge active={a.is_active} /></div>
                          </div>
                        </div>
                      </td>

                      {/* Position */}
                      <td className="hidden md:table-cell px-5 py-4">
                        <p className="text-slate-300 text-sm leading-snug max-w-[160px]">{a.position}</p>
                      </td>

                      {/* Username */}
                      <td className="hidden md:table-cell px-5 py-4">
                        <p className="text-slate-200 font-mono text-sm">{a.username}</p>
                      </td>

                      {/* Email */}
                      <td className="hidden lg:table-cell px-5 py-4">
                        <p className="text-slate-400 text-sm">{a.email}</p>
                      </td>

                      {/* Status */}
                      <td className="hidden sm:table-cell px-5 py-4">
                        <StatusBadge active={a.is_active} />
                      </td>

                      {/* Created */}
                      <td className="hidden lg:table-cell px-5 py-4">
                        <p className="text-slate-500 text-xs">{fmtDate(a.account_created_at)}</p>
                        <p className="text-slate-600 text-xs mt-0.5">Updated {fmtDate(a.account_updated_at)}</p>
                      </td>

                      {/* Actions */}
                      <td className="px-3 sm:px-5 py-4">
                        <div className="flex items-center justify-end gap-1.5">

                          {/* Edit */}
                          <button
                            onClick={() => openEdit(a)}
                            className="flex items-center gap-1.5 px-3.5 h-9 rounded-lg text-sm font-semibold bg-[#EFF6FF] hover:bg-[#DBEAFE] text-[#1D5BD6] border border-[#BFDBFE] hover:border-[#93C5FD] transition-colors"
                            title="Edit account"
                          >
                            <Pencil className="w-3.5 h-3.5" /> Edit
                          </button>

                          <RowMoreMenu
                            active={a.is_active}
                            toggling={togglingId === a.faculty_id}
                            onReset={() => openReset(a)}
                            onToggle={() => handleToggleActive(a)}
                            onDelete={() => { setDeleteTarget(a); setDeleteError(''); }}
                          />

                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        </PageLoadTransition>

      </div>

      {/* ════════════════════════════════════════════════════════════════════
          CREATE / EDIT MODAL
      ════════════════════════════════════════════════════════════════════ */}
      <Modal
        open={modalOpen}
        onClose={() => !formLoading && setModalOpen(false)}
        title={editTarget ? 'Edit Faculty Account' : 'Add Faculty Account'}
        size="lg"
      >
        {saveSuccess && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-2xl backdrop-blur-md save-success-overlay">
            <div className="save-success-badge flex flex-col items-center gap-3 px-8 py-7 rounded-2xl bg-[#111827] border border-white/10 shadow-2xl">
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
              <p className="text-base font-semibold text-white">
                {editTarget ? 'Account updated!' : 'Account created!'}
              </p>
            </div>
          </div>
        )}
        <form onSubmit={submitForm} noValidate>
          <div className="space-y-6">

            {/* Profile picture (edit only) */}
            {editTarget && (
              <div className="bg-[#0d1424] border border-white/10 rounded-xl p-4">
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Profile Picture</p>
                <div className="flex items-center gap-4">
                  <div className="relative">
                    <Avatar account={editTarget} size={16} />
                    <button
                      type="button"
                      onClick={() => picInputRef.current?.click()}
                      disabled={picUploading}
                      className="absolute -bottom-1 -right-1 w-6 h-6 bg-[#1D5BD6] hover:bg-[#2E7DD1] rounded-full flex items-center justify-center shadow-lg transition disabled:opacity-50"
                      title="Change photo"
                    >
                      <Camera className="w-3 h-3 text-white" />
                    </button>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-white">{editTarget.name}</p>
                    <p className="text-xs text-slate-500 mt-0.5">{editTarget.employee_id || 'No employee ID'}</p>
                    <button
                      type="button"
                      onClick={() => picInputRef.current?.click()}
                      disabled={picUploading}
                      className="mt-2 flex items-center gap-1.5 text-xs text-[#1D5BD6] hover:text-[#60A5FA] transition disabled:opacity-50"
                    >
                      <Upload className="w-3 h-3" />
                      {picUploading ? 'Uploading…' : 'Upload new photo'}
                    </button>
                    <p className="text-xs text-slate-600 mt-0.5">JPEG, PNG, WebP or GIF · Max 5 MB</p>
                    {picError && <p className="text-xs text-red-400 mt-1">{picError}</p>}
                  </div>
                </div>
                <input
                  ref={picInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  className="hidden"
                  onChange={e => { const f = e.target.files?.[0]; if (f) uploadPicture(f); }}
                />
              </div>
            )}

            {/* Section: Name */}
            <div>
              <div className="flex items-center gap-2 mb-4">
                <div className="w-7 h-7 rounded-lg bg-[#1D5BD6]/20 flex items-center justify-center flex-shrink-0">
                  <User className="w-4 h-4 text-[#1D5BD6]" />
                </div>
                <p className="text-sm font-bold text-slate-300 uppercase tracking-wider">Name</p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <FormField
                    id="first_name" label="First Name" required
                    value={form.first_name} onChange={v => setField('first_name', v)}
                    placeholder="e.g. Maria" error={!!formErrors.first_name}
                  />
                  {formErrors.first_name && <p className="text-xs text-red-400 mt-1">{formErrors.first_name}</p>}
                </div>
                <div>
                  <FormField
                    id="middle_name" label="Middle Name"
                    value={form.middle_name} onChange={v => setField('middle_name', v)}
                    placeholder="e.g. Santos"
                  />
                </div>
                <div>
                  <FormField
                    id="last_name" label="Last Name" required
                    value={form.last_name} onChange={v => setField('last_name', v)}
                    placeholder="e.g. Reyes" error={!!formErrors.last_name}
                  />
                  {formErrors.last_name && <p className="text-xs text-red-400 mt-1">{formErrors.last_name}</p>}
                </div>
              </div>
            </div>

            {/* Divider */}
            <div className="border-t border-white/10" />

            {/* Section: Position */}
            <div>
              <div className="flex items-center gap-2 mb-4">
                <div className="w-7 h-7 rounded-lg bg-blue-500/20 flex items-center justify-center flex-shrink-0">
                  <UserCog className="w-4 h-4 text-blue-400" />
                </div>
                <p className="text-sm font-bold text-slate-300 uppercase tracking-wider">Position & Program</p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-semibold text-slate-300 mb-2">
                    Position <span className="text-red-400">*</span>
                  </label>
                  <PositionSelect
                    value={form.position}
                    onChange={v => setField('position', v)}
                    error={!!formErrors.position}
                  />
                  {formErrors.position && <p className="text-xs text-red-400 mt-1">{formErrors.position}</p>}
                </div>
                <div>
                  <label className="block text-sm font-semibold text-slate-300 mb-2">
                    Program <span className="text-red-400">*</span>
                  </label>
                  <select
                    value={form.program_id}
                    onChange={e => setField('program_id', e.target.value)}
                    className={`w-full bg-[#0b0f1a] border rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:ring-1 focus:ring-[#1D5BD6]/50 transition hover:border-white/20 ${formErrors.program_id ? 'border-red-500/50' : 'border-white/10'}`}
                  >
                    <option value="">— Select Program —</option>
                    {programs.map(p => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}
                  </select>
                  {formErrors.program_id && <p className="text-xs text-red-400 mt-1">{formErrors.program_id}</p>}
                </div>
              </div>
              <div className="mt-4">
                <label className="block text-sm font-semibold text-slate-300 mb-2">
                  Subjects to Handle&nbsp;<span className="text-slate-500 font-normal">(optional — a priority recommendation, not a restriction)</span>
                </label>
                <SubjectMultiSelect
                  options={subjectOptions}
                  selected={form.priority_subjects}
                  onChange={setPrioritySubjectsField}
                  loading={subjectOptionsLoading}
                />
              </div>
            </div>

            {/* Divider */}
            <div className="border-t border-white/10" />

            {/* Section: Account Credentials */}
            <div>
              <div className="flex items-center gap-2 mb-4">
                <div className="w-7 h-7 rounded-lg bg-emerald-500/20 flex items-center justify-center flex-shrink-0">
                  <ShieldCheck className="w-4 h-4 text-emerald-400" />
                </div>
                <p className="text-sm font-bold text-slate-300 uppercase tracking-wider">Account Credentials</p>
              </div>

              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <FormField
                      id="username" label="Username" required
                      value={form.username} onChange={v => setField('username', v)}
                      placeholder="e.g. m.reyes" error={!!formErrors.username}
                      hint="Letters, numbers, and underscores only. No spaces."
                    />
                    {formErrors.username && <p className="text-xs text-red-400 mt-1">{formErrors.username}</p>}
                  </div>
                  <div>
                    <FormField
                      id="email" label="Email" type="email" required
                      value={form.email} onChange={v => setField('email', v)}
                      placeholder="e.g. m.reyes@school.edu" error={!!formErrors.email}
                    />
                    {formErrors.email && <p className="text-xs text-red-400 mt-1">{formErrors.email}</p>}
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <PasswordInput
                      id="password"
                      label={editTarget ? 'New Password (leave blank to keep current)' : 'Password *'}
                      value={form.password}
                      onChange={v => setField('password', v)}
                      placeholder={editTarget ? 'Leave blank to keep current password' : 'Min. 8 characters'}
                      error={!!formErrors.password}
                    />
                    {formErrors.password && <p className="text-xs text-red-400 mt-1">{formErrors.password}</p>}
                    <p className="text-xs text-slate-600 mt-1">Minimum 8 characters.</p>
                  </div>
                  <div>
                    <PasswordInput
                      id="confirmPassword"
                      label={editTarget ? 'Confirm New Password' : 'Confirm Password *'}
                      value={form.confirmPassword}
                      onChange={v => setField('confirmPassword', v)}
                      placeholder="Re-enter password"
                      error={!!formErrors.confirmPassword}
                    />
                    {formErrors.confirmPassword && <p className="text-xs text-red-400 mt-1">{formErrors.confirmPassword}</p>}
                  </div>
                </div>
              </div>
            </div>

            {/* Error message */}
            {formMsg && (
              <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-3 rounded-xl text-sm">
                <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                {formMsg}
              </div>
            )}

            {/* Form actions */}
            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={() => !formLoading && setModalOpen(false)}
                disabled={formLoading}
                className="flex-1 border border-white/10 text-slate-300 py-2.5 rounded-xl text-sm font-semibold hover:bg-white/5 transition disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={formLoading}
                className="flex-1 bg-[#1D5BD6] hover:bg-[#2E7DD1] text-white py-2.5 rounded-xl text-sm font-bold transition disabled:opacity-60 flex items-center justify-center gap-2"
              >
                {formLoading
                  ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Saving…</>
                  : editTarget ? 'Save Changes' : 'Create Account'}
              </button>
            </div>

          </div>
        </form>
      </Modal>

      {/* ════════════════════════════════════════════════════════════════════
          DELETE CONFIRMATION MODAL
      ════════════════════════════════════════════════════════════════════ */}
      <Modal
        open={!!deleteTarget}
        onClose={() => !deleteLoading && setDeleteTarget(null)}
        title="Delete Faculty Account"
        size="sm"
      >
        {deleteSuccess && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-2xl backdrop-blur-md save-success-overlay">
            <div className="save-success-badge flex flex-col items-center gap-3 px-8 py-7 rounded-2xl bg-[#111827] border border-white/10 shadow-2xl">
              <TrashDropAnimation className="bg-red-500/15 border-red-500/30" color="#F87171" />
              <p className="text-base font-semibold text-white">Account deleted!</p>
            </div>
          </div>
        )}
        {deleteTarget && (
          <div className="space-y-5">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-xl bg-red-500/20 flex items-center justify-center flex-shrink-0">
                <AlertTriangle className="w-5 h-5 text-red-400" />
              </div>
              <div>
                <p className="text-white font-semibold text-base leading-snug">
                  Are you sure you want to delete this account?
                </p>
                <p className="text-slate-400 text-sm mt-1">
                  This will deactivate <strong className="text-white">{deleteTarget.name}</strong>&apos;s faculty account.
                  They will no longer be able to log in to the faculty portal.
                </p>
              </div>
            </div>

            <div className="bg-[#0d1424] border border-white/10 rounded-xl p-4 flex items-center gap-3">
              <Avatar account={deleteTarget} size={10} />
              <div>
                <p className="text-white font-semibold">{deleteTarget.name}</p>
                <p className="text-slate-400 text-xs">{deleteTarget.username} · {deleteTarget.email}</p>
                <p className="text-slate-500 text-xs">{deleteTarget.position}</p>
              </div>
            </div>

            {deleteError && (
              <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-3 rounded-xl text-sm">
                <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                {deleteError}
              </div>
            )}

            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                disabled={deleteLoading}
                className="flex-1 border border-white/10 text-slate-300 py-2.5 rounded-xl text-sm font-semibold hover:bg-white/5 transition disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                disabled={deleteLoading}
                className="flex-1 bg-red-600 hover:bg-red-700 text-white py-2.5 rounded-xl text-sm font-bold transition disabled:opacity-60 flex items-center justify-center gap-2"
              >
                {deleteLoading
                  ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Deleting…</>
                  : <><Trash2 className="w-4 h-4" /> Yes, Delete Account</>}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* ════════════════════════════════════════════════════════════════════
          RESET PASSWORD MODAL
      ════════════════════════════════════════════════════════════════════ */}
      <Modal
        open={!!resetTarget}
        onClose={() => !resetLoading && setResetTarget(null)}
        title="Reset Password"
        size="sm"
      >
        {resetTarget && (
          <div className="space-y-5">
            <div className="flex items-center gap-3 bg-[#0d1424] border border-white/10 rounded-xl p-4">
              <Avatar account={resetTarget} size={10} />
              <div>
                <p className="text-white font-semibold">{resetTarget.name}</p>
                <p className="text-slate-400 text-xs">{resetTarget.username} · {resetTarget.email}</p>
              </div>
            </div>

            {resetSuccess ? (
              <div className="flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 px-4 py-3 rounded-xl text-sm">
                <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
                {resetSuccess}
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <PasswordInput
                    id="new_password" label="New Password"
                    value={resetPw} onChange={v => { setResetPw(v); setResetError(''); }}
                    placeholder="Min. 8 characters"
                  />
                </div>
                <div>
                  <PasswordInput
                    id="confirm_new_password" label="Confirm New Password"
                    value={resetConfirmPw} onChange={v => { setResetConfirmPw(v); setResetError(''); }}
                    placeholder="Re-enter new password"
                  />
                </div>

                {resetError && (
                  <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-3 rounded-xl text-sm">
                    <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                    {resetError}
                  </div>
                )}

                <div className="flex gap-3 pt-1">
                  <button
                    type="button"
                    onClick={() => setResetTarget(null)}
                    disabled={resetLoading}
                    className="flex-1 border border-white/10 text-slate-300 py-2.5 rounded-xl text-sm font-semibold hover:bg-white/5 transition disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={confirmReset}
                    disabled={resetLoading}
                    className="flex-1 bg-blue-600 hover:bg-blue-700 text-white py-2.5 rounded-xl text-sm font-bold transition disabled:opacity-60 flex items-center justify-center gap-2"
                  >
                    {resetLoading
                      ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Resetting…</>
                      : <><KeyRound className="w-4 h-4" /> Reset Password</>}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* ════════════════════════════════════════════════════════════════════
          CONFIRM CREATE / SAVE MODAL
      ════════════════════════════════════════════════════════════════════ */}
      <Modal
        open={formConfirmOpen}
        onClose={() => !formLoading && setFormConfirmOpen(false)}
        title={editTarget ? 'Confirm Save Changes' : 'Confirm Account Creation'}
        size="sm"
      >
        <div className="space-y-5">

          {/* Icon + message */}
          <div className="flex items-start gap-4">
            <div className={`w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 ${editTarget ? 'bg-blue-500/20' : 'bg-emerald-500/20'}`}>
              {editTarget
                ? <Pencil className="w-5 h-5 text-blue-400" />
                : <Plus className="w-5 h-5 text-emerald-400" />}
            </div>
            <div>
              <p className="text-white font-bold text-base leading-snug">
                {editTarget ? 'Save these changes?' : 'Create this faculty account?'}
              </p>
              <p className="text-slate-400 text-sm mt-1 leading-relaxed">
                {editTarget
                  ? `You are about to update the account details for ${editTarget.name}. Please review before confirming.`
                  : 'Please review the details below before the account is created.'}
              </p>
            </div>
          </div>

          {/* Summary card */}
          <div className="bg-[#0d1424] border border-white/10 rounded-xl divide-y divide-white/[0.06]">
            {[
              { label: 'Full Name', value: [form.first_name, form.middle_name, form.last_name].filter(Boolean).join(' ') || '—' },
              { label: 'Position', value: form.position || '—' },
              { label: 'Username', value: form.username || '—', mono: true },
              { label: 'Email', value: form.email || '—' },
              ...(form.password ? [{ label: 'Password', value: '••••••••' }] : []),
            ].map(row => (
              <div key={row.label} className="flex items-center justify-between px-4 py-2.5 text-sm">
                <span className="text-slate-500 flex-shrink-0 w-24">{row.label}</span>
                <span className={`text-white font-medium text-right truncate ml-2 ${'mono' in row && row.mono ? 'font-mono' : ''}`}>{row.value}</span>
              </div>
            ))}
          </div>

          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={() => setFormConfirmOpen(false)}
              disabled={formLoading}
              className="flex-1 border border-white/10 text-slate-300 py-3 rounded-xl text-sm font-semibold hover:bg-white/5 transition disabled:opacity-50"
            >
              Go Back
            </button>
            <button
              type="button"
              onClick={executeSubmit}
              disabled={formLoading}
              className={`flex-1 text-white py-3 rounded-xl text-sm font-bold transition disabled:opacity-60 flex items-center justify-center gap-2 shadow-lg
                ${editTarget ? 'bg-blue-600 hover:bg-blue-700 shadow-blue-500/20' : 'bg-emerald-600 hover:bg-emerald-700 shadow-emerald-500/20'}`}
            >
              {formLoading
                ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Saving…</>
                : editTarget
                  ? <><CheckCircle2 className="w-4 h-4" /> Yes, Save Changes</>
                  : <><CheckCircle2 className="w-4 h-4" /> Yes, Create Account</>}
            </button>
          </div>

        </div>
      </Modal>

      {/* ════════════════════════════════════════════════════════════════════
          CONFIRM ACTIVATE / DEACTIVATE MODAL
      ════════════════════════════════════════════════════════════════════ */}
      <Modal
        open={!!toggleConfirmTarget}
        onClose={() => togglingId === null && setToggleConfirmTarget(null)}
        title={toggleConfirmTarget?.is_active ? 'Confirm Deactivation' : 'Confirm Activation'}
        size="sm"
      >
        {toggleConfirmTarget && (
          <div className="space-y-5">

            <div className="flex items-start gap-4">
              <div className={`w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 ${toggleConfirmTarget.is_active ? 'bg-amber-500/20' : 'bg-emerald-500/20'}`}>
                {toggleConfirmTarget.is_active
                  ? <ShieldX className="w-5 h-5 text-amber-400" />
                  : <ShieldCheck className="w-5 h-5 text-emerald-400" />}
              </div>
              <div>
                <p className="text-white font-bold text-base leading-snug">
                  {toggleConfirmTarget.is_active
                    ? 'Deactivate this account?'
                    : 'Activate this account?'}
                </p>
                <p className="text-slate-400 text-sm mt-1 leading-relaxed">
                  {toggleConfirmTarget.is_active
                    ? `${toggleConfirmTarget.name} will no longer be able to log in to the faculty portal.`
                    : `${toggleConfirmTarget.name} will be granted access to log in to the faculty portal.`}
                </p>
              </div>
            </div>

            <div className="bg-[#0d1424] border border-white/10 rounded-xl p-4 flex items-center gap-3">
              <Avatar account={toggleConfirmTarget} size={10} />
              <div className="min-w-0">
                <p className="text-white font-semibold truncate">{toggleConfirmTarget.name}</p>
                <p className="text-slate-400 text-xs truncate">{toggleConfirmTarget.username} · {toggleConfirmTarget.email}</p>
                <p className="text-slate-500 text-xs mt-0.5">{toggleConfirmTarget.position}</p>
              </div>
            </div>

            <div className={`rounded-xl px-4 py-3 text-sm flex items-center gap-2 ${toggleConfirmTarget.is_active ? 'bg-amber-500/10 border border-amber-500/20 text-amber-300' : 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-300'}`}>
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              {toggleConfirmTarget.is_active
                ? 'This will prevent the faculty from accessing the system until reactivated.'
                : 'This will restore the faculty\'s ability to log in immediately.'}
            </div>

            <div className="flex gap-3 pt-1">
              <button
                type="button"
                onClick={() => setToggleConfirmTarget(null)}
                disabled={togglingId === toggleConfirmTarget.faculty_id}
                className="flex-1 border border-white/10 text-slate-300 py-3 rounded-xl text-sm font-semibold hover:bg-white/5 transition disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => toggleActive(toggleConfirmTarget)}
                disabled={togglingId === toggleConfirmTarget.faculty_id}
                className={`flex-1 text-white py-3 rounded-xl text-sm font-bold transition disabled:opacity-60 flex items-center justify-center gap-2 shadow-lg
                  ${toggleConfirmTarget.is_active
                    ? 'bg-amber-600 hover:bg-amber-700 shadow-amber-500/20'
                    : 'bg-emerald-600 hover:bg-emerald-700 shadow-emerald-500/20'}`}
              >
                {togglingId === toggleConfirmTarget.faculty_id
                  ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Processing…</>
                  : toggleConfirmTarget.is_active
                    ? <><ShieldX className="w-4 h-4" /> Yes, Deactivate</>
                    : <><ShieldCheck className="w-4 h-4" /> Yes, Activate</>}
              </button>
            </div>

          </div>
        )}
      </Modal>

      {/* ════════════════════════════════════════════════════════════════════
          CONFIRM RESET PASSWORD MODAL
      ════════════════════════════════════════════════════════════════════ */}
      <Modal
        open={resetConfirmOpen}
        onClose={() => !resetLoading && setResetConfirmOpen(false)}
        title="Confirm Password Reset"
        size="sm"
      >
        {resetTarget && (
          <div className="space-y-5">

            <div className="flex items-start gap-4">
              <div className="w-11 h-11 rounded-xl bg-blue-500/20 flex items-center justify-center flex-shrink-0">
                <KeyRound className="w-5 h-5 text-blue-400" />
              </div>
              <div>
                <p className="text-white font-bold text-base leading-snug">Reset this password?</p>
                <p className="text-slate-400 text-sm mt-1 leading-relaxed">
                  You are about to reset the password for <strong className="text-white">{resetTarget.name}</strong>.
                  This takes effect immediately.
                </p>
              </div>
            </div>

            <div className="bg-[#0d1424] border border-white/10 rounded-xl p-4 flex items-center gap-3">
              <Avatar account={resetTarget} size={10} />
              <div className="min-w-0">
                <p className="text-white font-semibold truncate">{resetTarget.name}</p>
                <p className="text-slate-400 text-xs truncate">{resetTarget.username} · {resetTarget.email}</p>
              </div>
            </div>

            <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl px-4 py-3 text-sm text-blue-300 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              The faculty will need to use the new password to log in after this change.
            </div>

            <div className="flex gap-3 pt-1">
              <button
                type="button"
                onClick={() => setResetConfirmOpen(false)}
                disabled={resetLoading}
                className="flex-1 border border-white/10 text-slate-300 py-3 rounded-xl text-sm font-semibold hover:bg-white/5 transition disabled:opacity-50"
              >
                Go Back
              </button>
              <button
                type="button"
                onClick={executeReset}
                disabled={resetLoading}
                className="flex-1 bg-blue-600 hover:bg-blue-700 text-white py-3 rounded-xl text-sm font-bold transition disabled:opacity-60 flex items-center justify-center gap-2 shadow-lg shadow-blue-500/20"
              >
                {resetLoading
                  ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Resetting…</>
                  : <><KeyRound className="w-4 h-4" /> Yes, Reset Password</>}
              </button>
            </div>

          </div>
        )}
      </Modal>

    </div>
  );
}

/* ── Row "More" menu: Reset PW · Deactivate/Activate · Delete ─────────────── */
function RowMoreMenu({ active, toggling, onReset, onToggle, onDelete }: {
  active: boolean;
  toggling: boolean;
  onReset: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const pick = (fn: () => void) => () => { setOpen(false); fn(); };

  const items = [
    { key: 'reset', label: 'Reset password', Icon: KeyRound, color: '#1D5BD6', hover: 'hover:bg-[#EFF6FF]', onClick: onReset },
    active
      ? { key: 'toggle', label: 'Deactivate', Icon: ShieldX, color: '#B45309', hover: 'hover:bg-amber-50', onClick: onToggle }
      : { key: 'toggle', label: 'Activate', Icon: ShieldCheck, color: '#047857', hover: 'hover:bg-emerald-50', onClick: onToggle },
    { key: 'delete', label: 'Delete', Icon: Trash2, color: '#DC2626', hover: 'hover:bg-red-50', onClick: onDelete },
  ];

  return (
    <>
      <motion.button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(v => !v)}
        disabled={toggling}
        whileTap={reduceMotion ? undefined : { scale: 0.95 }}
        aria-haspopup="menu"
        aria-expanded={open}
        title="More actions"
        className={`flex items-center gap-1.5 px-3.5 h-9 rounded-lg text-sm font-semibold border transition-colors disabled:opacity-50 ${
          open ? 'bg-[#0B2A5B] border-[#0B2A5B]' : 'bg-white text-[#0B2A5B] border-[#C7D4EA] hover:bg-[#F4F7FC] hover:border-[#9DB8E8]'
        }`}
        style={open ? { color: '#FFFFFF' } : undefined}
      >
        {toggling
          ? <div className="w-3.5 h-3.5 border border-current border-t-transparent rounded-full animate-spin" />
          : <MoreHorizontal className="w-3.5 h-3.5" />}
        More
      </motion.button>
      <AnchoredPopover open={open} onClose={close} anchorRef={triggerRef} panelRef={panelRef} width={190} maxHeight={220} label="More actions" align="end"
        onKeyDown={e => { if (e.key === 'Escape') { setOpen(false); triggerRef.current?.focus(); } }}>
        <div role="menu" className="p-1.5">
          {items.map(({ key, label, Icon, color, hover, onClick }, i) => (
            <motion.button
              key={key}
              type="button"
              role="menuitem"
              onClick={pick(onClick)}
              initial={reduceMotion ? false : { opacity: 0, x: 6 }}
              animate={{ opacity: 1, x: 0, transition: { duration: 0.2, delay: i * 0.04, ease: [0.4, 0, 0.2, 1] } }}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${hover} ${key === 'delete' ? 'mt-1 border-t border-[#F1F5F9] rounded-t-none pt-2.5' : ''}`}
              style={{ color }}
            >
              <Icon className="w-4 h-4" /> {label}
            </motion.button>
          ))}
        </div>
      </AnchoredPopover>
    </>
  );
}

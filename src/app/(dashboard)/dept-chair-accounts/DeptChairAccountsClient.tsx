'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useToast } from '@/client/context/ToastContext';
import Modal from '@/client/components/ui/Modal';
import { PageLoadTransition } from '@/client/components/ui/PageLoadTransition';
import { Skeleton, TableSkeleton } from '@/client/components/ui/skeletons';
import { LOADING_DELAY, useMinLoading } from '@/client/hooks/useMinLoading';
import {
  Plus, Pencil, Trash2, Eye, EyeOff, Shield, KeyRound,
  UserCheck, UserX, X, AlertTriangle, CheckCircle2,
} from 'lucide-react';
import { SearchInput, FilterSelect } from '@/components/ui/SearchFilter';

interface Program {
  id: number;
  code: string;
  name: string;
}

interface DeptChairAccount {
  id: number;
  username: string;
  email: string;
  role: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  program_id: number | null;
  program_code: string | null;
  program_name: string | null;
  google_verified?: boolean;
}

interface AccountFormData {
  username: string;
  email: string;
  password: string;
  confirm_password: string;
  program_id: string;
}

const EMPTY_FORM: AccountFormData = {
  username: '', email: '', password: '', confirm_password: '', program_id: '',
};

function fmtDate(d: string) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
}

function StatusBadge({ active }: { active: boolean }) {
  return active
    ? <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 flex-shrink-0" />Active
      </span>
    : <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-500/20 text-slate-400 border border-slate-500/30">
        <span className="w-1.5 h-1.5 rounded-full bg-slate-500 flex-shrink-0" />Inactive
      </span>;
}

function FieldLabel({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1.5">
      {children}{required ? <span className="text-red-400"> *</span> : null}
    </label>
  );
}

function TextInput({
  type = 'text', value, onChange, placeholder = '', disabled = false,
}: {
  type?: string; value: string; onChange: (v: string) => void;
  placeholder?: string; disabled?: boolean;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      className="w-full bg-[#0b0f1a] border border-white/10 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-[#3C91E6] focus:border-[#3C91E6] disabled:opacity-50"
    />
  );
}

function PasswordField({
  value, onChange, placeholder = 'Enter password',
}: {
  value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <TextInput type={show ? 'text' : 'password'} value={value} onChange={onChange} placeholder={placeholder} />
      <button
        type="button"
        onClick={() => setShow(s => !s)}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
        aria-label={show ? 'Hide password' : 'Show password'}
      >
        {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
  );
}

function BtnSpinner() {
  return <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin flex-shrink-0" />;
}

export default function DeptChairAccountsClient() {
  const toast = useToast();
  const [accounts, setAccounts] = useState<DeptChairAccount[]>([]);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<'create' | 'edit' | 'password' | 'delete' | null>(null);
  const [selected, setSelected] = useState<DeptChairAccount | null>(null);
  const [form, setForm] = useState<AccountFormData>(EMPTY_FORM);
  const [newPwd, setNewPwd] = useState('');
  const [confirmNewPwd, setConfirmNewPwd] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [togglingId, setTogglingId] = useState<number | null>(null);
  const [formError, setFormError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : '';
      const res = await fetch(`/api/dept-chair-accounts${qs}`);
      if (!res.ok) return;
      const d = await res.json();
      setAccounts(d.accounts ?? []);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, [search]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    fetch('/api/programs')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setPrograms(d.programs || []); })
      .catch(() => {});
  }, []);

  const filtered = accounts.filter(a => {
    if (filterStatus === 'active' && !a.is_active) return false;
    if (filterStatus === 'inactive' && a.is_active) return false;
    return true;
  });

  function openCreate() {
    setForm(EMPTY_FORM); setFormError(''); setModal('create');
  }
  function openEdit(acc: DeptChairAccount) {
    setSelected(acc);
    setForm({
      username: acc.username,
      email: acc.email,
      password: '',
      confirm_password: '',
      program_id: acc.program_id ? String(acc.program_id) : '',
    });
    setFormError('');
    setModal('edit');
  }
  function openPassword(acc: DeptChairAccount) {
    setSelected(acc); setNewPwd(''); setConfirmNewPwd(''); setFormError(''); setModal('password');
  }
  function openDelete(acc: DeptChairAccount) {
    setSelected(acc); setFormError(''); setModal('delete');
  }
  function closeModal() {
    setModal(null); setSelected(null); setFormError('');
  }

  async function handleCreate() {
    if (!form.username.trim()) { setFormError('Username is required.'); return; }
    if (!form.email.trim()) { setFormError('Email is required.'); return; }
    if (!form.program_id) { setFormError('Please select a program.'); return; }
    if (!form.password) { setFormError('Password is required.'); return; }
    if (form.password !== form.confirm_password) { setFormError('Passwords do not match.'); return; }
    if (form.password.length < 8) { setFormError('Password must be at least 8 characters.'); return; }
    setSubmitting(true); setFormError('');
    try {
      const res = await fetch('/api/dept-chair-accounts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: form.username,
          email: form.email,
          password: form.password,
          confirm_password: form.confirm_password,
          program_id: Number(form.program_id),
        }),
      });
      if (!res.ok) {
        let msg = 'Failed to create account.';
        try { msg = ((await res.json()) as { error?: string })?.error ?? msg; } catch { /* html */ }
        setFormError(msg); return;
      }
      const d = await res.json();
      toast.success(`Account "${d.account.username}" created.`);
      closeModal(); load();
    } catch { setFormError('Connection error. Please try again.'); }
    finally { setSubmitting(false); }
  }

  async function handleEdit() {
    if (!selected) return;
    if (!form.username.trim()) { setFormError('Username is required.'); return; }
    if (!form.email.trim()) { setFormError('Email is required.'); return; }
    if (!form.program_id) { setFormError('Please select a program.'); return; }
    if (form.password && form.password !== form.confirm_password) { setFormError('Passwords do not match.'); return; }
    if (form.password && form.password.length < 8) { setFormError('Password must be at least 8 characters.'); return; }
    setSubmitting(true); setFormError('');
    try {
      const payload: Record<string, unknown> = {
        username: form.username,
        email: form.email,
        program_id: Number(form.program_id),
      };
      if (form.password) payload.password = form.password;

      const res = await fetch(`/api/dept-chair-accounts/${selected.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        let msg = 'Failed to update account.';
        try { msg = ((await res.json()) as { error?: string })?.error ?? msg; } catch { /* html */ }
        setFormError(msg); return;
      }
      toast.success('Account updated.');
      closeModal(); load();
    } catch { setFormError('Connection error. Please try again.'); }
    finally { setSubmitting(false); }
  }

  async function handleResetPassword() {
    if (!selected) return;
    if (!newPwd) { setFormError('New password is required.'); return; }
    if (newPwd.length < 8) { setFormError('Password must be at least 8 characters.'); return; }
    if (newPwd !== confirmNewPwd) { setFormError('Passwords do not match.'); return; }
    setSubmitting(true); setFormError('');
    try {
      const res = await fetch(`/api/dept-chair-accounts/${selected.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_password: newPwd }),
      });
      if (!res.ok) {
        let msg = 'Failed to reset password.';
        try { msg = ((await res.json()) as { error?: string })?.error ?? msg; } catch { /* html */ }
        setFormError(msg); return;
      }
      toast.success(`Password reset for "${selected.username}".`);
      closeModal();
    } catch { setFormError('Connection error. Please try again.'); }
    finally { setSubmitting(false); }
  }

  async function handleDelete() {
    if (!selected) return;
    setSubmitting(true); setFormError('');
    try {
      const res = await fetch(`/api/dept-chair-accounts/${selected.id}`, { method: 'DELETE' });
      if (!res.ok) {
        let msg = 'Failed to delete account. Please try again.';
        try { msg = ((await res.json()) as { error?: string })?.error ?? msg; } catch { /* html */ }
        setFormError(msg); return;
      }
      toast.success(`Account "${selected.username}" deleted.`);
      closeModal();
      load();
    } catch {
      setFormError('Connection error. Please check your network and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleActive(acc: DeptChairAccount) {
    setTogglingId(acc.id);
    try {
      const res = await fetch(`/api/dept-chair-accounts/${acc.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: !acc.is_active }),
      });
      if (!res.ok) {
        let msg = 'Action failed.';
        try { msg = ((await res.json()) as { error?: string })?.error ?? msg; } catch { /* html */ }
        toast.error(msg); return;
      }
      const d = await res.json();
      setAccounts(prev => prev.map(a => a.id === acc.id ? d.account : a));
      toast.success(d.account.is_active ? `"${acc.username}" activated.` : `"${acc.username}" deactivated.`);
    } catch { toast.error('Connection error.'); }
    finally { setTogglingId(null); }
  }

  function programLabel(acc: DeptChairAccount) {
    if (acc.program_code) return acc.program_code;
    return '—';
  }

  const canSubmitCreate =
    !!form.username.trim() && !!form.email.trim() && !!form.program_id && !!form.password && !!form.confirm_password;

  const showSkeleton = useMinLoading(loading && accounts.length === 0, LOADING_DELAY);

  const pageSkeleton = (
    <div className="space-y-6" role="status" aria-live="polite" aria-label="Loading department chair accounts">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="space-y-2 min-w-0">
          <Skeleton className="h-8 w-64 max-w-full rounded-md bg-white/10" />
          <Skeleton className="h-4 w-80 max-w-full rounded bg-white/10" />
        </div>
        <Skeleton className="h-10 w-56 rounded-xl bg-white/10 flex-shrink-0" />
      </div>
      <div className="bg-white rounded-2xl shadow-[0_1px_3px_rgba(0,0,0,0.06)] p-5 space-y-3">
        <div className="flex flex-wrap gap-3">
          <Skeleton className="h-[42px] flex-1 min-w-[220px] rounded-xl" />
          <Skeleton className="h-[42px] w-[140px] rounded-xl" />
        </div>
        <Skeleton className="h-3 w-40 rounded" />
      </div>
      <TableSkeleton cols={6} rows={8} />
    </div>
  );

  return (
    <div className="min-h-screen bg-[#0b0f1a] text-white">
      <div className="max-w-7xl mx-auto px-6 py-8 w-full min-w-0">
        <PageLoadTransition
          showSkeleton={showSkeleton}
          skeleton={pageSkeleton}
          className="space-y-6"
        >

        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-white mb-1">Department Chair Accounts</h1>
            <p className="text-slate-400 text-sm">
              Manage department chair login accounts, reset passwords, and control access.
            </p>
          </div>
          <button
            type="button"
            onClick={openCreate}
            className="flex items-center gap-2 bg-[#3C91E6] hover:bg-[#2E7DD1] text-white px-5 py-2.5 rounded-xl font-semibold text-sm transition-colors shadow-lg shadow-[#3C91E6]/20"
          >
            <Plus className="w-4 h-4" />
            Add Department Chair Account
          </button>
        </div>

        <div className="bg-white rounded-2xl shadow-[0_1px_3px_rgba(0,0,0,0.06)] p-5">
          <div className="flex flex-wrap gap-3">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="Search username, email, or program…"
              className="flex-1 min-w-[220px]"
            />
            <FilterSelect value={filterStatus} onChange={setFilterStatus} label="Status" className="min-w-[140px]">
              <option value="">All Status</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </FilterSelect>
            {(search || filterStatus) && (
              <button
                type="button"
                onClick={() => { setSearch(''); setFilterStatus(''); }}
                className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-sm text-slate-500 hover:text-slate-700 border border-slate-200 hover:border-slate-300 bg-white transition-all duration-150"
              >
                <X className="w-3.5 h-3.5" /> Clear
              </button>
            )}
          </div>
          <p className="text-xs text-slate-400 mt-3">
            {`${filtered.length} department chair account${filtered.length !== 1 ? 's' : ''} found`}
          </p>
        </div>

        <div className="w-full min-w-0">
        <div className="bg-[#111827] border border-white/10 rounded-2xl overflow-hidden">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 gap-3">
              <div className="w-14 h-14 rounded-2xl bg-white/5 flex items-center justify-center">
                <Shield className="w-7 h-7 text-slate-600" />
              </div>
              <p className="text-slate-400 font-medium">No department chair accounts found</p>
              <p className="text-slate-600 text-sm">
                {search || filterStatus
                  ? 'Try adjusting your search or filters.'
                  : 'Click "Add Department Chair Account" to create one.'}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10 bg-white/[0.02]">
                    <th className="px-5 py-4 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap">Username</th>
                    <th className="px-5 py-4 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap">Email</th>
                    <th className="px-5 py-4 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap">Program</th>
                    <th className="px-5 py-4 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap">Status</th>
                    <th className="px-5 py-4 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap">Created</th>
                    <th className="px-5 py-4 text-right text-xs font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.05]">
                  {filtered.map(acc => {
                    const busy = togglingId === acc.id;
                    return (
                      <tr key={acc.id} className={`transition-colors hover:bg-white/[0.03] ${!acc.is_active ? 'opacity-60' : ''}`}>
                        <td className="px-5 py-4">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-full bg-[#3C91E6]/20 border border-[#3C91E6]/30 flex items-center justify-center flex-shrink-0 text-[#3C91E6] font-bold text-sm">
                              {acc.username.slice(0, 2).toUpperCase()}
                            </div>
                            <div className="min-w-0">
                              <p className="font-semibold text-white font-mono text-sm">{acc.username}</p>
                              {acc.google_verified ? (
                                <p className="text-[10px] text-emerald-400 mt-0.5">Google: Verified</p>
                              ) : (
                                <p className="text-[10px] text-red-400 mt-0.5">Google: Not Verified</p>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-5 py-4">
                          <p className="text-slate-400 text-sm break-all">{acc.email}</p>
                        </td>
                        <td className="px-5 py-4">
                          <p className="text-slate-200 text-sm font-medium" title={acc.program_name ?? undefined}>
                            {programLabel(acc)}
                          </p>
                          {acc.program_name && (
                            <p className="text-xs text-slate-500 mt-0.5 max-w-[180px] truncate">{acc.program_name}</p>
                          )}
                        </td>
                        <td className="px-5 py-4">
                          <StatusBadge active={acc.is_active} />
                        </td>
                        <td className="px-5 py-4 text-slate-500 text-xs whitespace-nowrap">{fmtDate(acc.created_at)}</td>
                        <td className="px-5 py-4">
                          <div className="flex items-center justify-end gap-1.5 whitespace-nowrap">
                            <button type="button" onClick={() => openEdit(acc)} title="Edit account"
                              className="p-2 rounded-lg text-slate-400 hover:text-[#3C91E6] hover:bg-[#3C91E6]/10 transition-colors min-h-10 min-w-10 inline-flex items-center justify-center">
                              <Pencil className="w-4 h-4" />
                            </button>
                            <button type="button" onClick={() => openPassword(acc)} title="Reset password"
                              className="p-2 rounded-lg text-slate-400 hover:text-amber-400 hover:bg-amber-500/10 transition-colors min-h-10 min-w-10 inline-flex items-center justify-center">
                              <KeyRound className="w-4 h-4" />
                            </button>
                            <button type="button" onClick={() => toggleActive(acc)} disabled={busy}
                              title={acc.is_active ? 'Deactivate' : 'Activate'}
                              className="p-2 rounded-lg text-slate-400 hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors disabled:opacity-40 min-h-10 min-w-10 inline-flex items-center justify-center">
                              {busy
                                ? <div className="w-4 h-4 border-2 border-slate-500 border-t-slate-300 rounded-full animate-spin" />
                                : acc.is_active ? <UserX className="w-4 h-4" /> : <UserCheck className="w-4 h-4" />}
                            </button>
                            <button type="button" onClick={() => openDelete(acc)} title="Delete account"
                              className="p-2 rounded-lg text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition-colors min-h-10 min-w-10 inline-flex items-center justify-center">
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        </div>

        </PageLoadTransition>
      </div>

      {(modal === 'create' || modal === 'edit') && (
        <Modal
          open
          title={modal === 'create' ? 'Create Department Chair Account' : `Edit — ${selected?.username}`}
          onClose={closeModal}
          size="md"
        >
          {formError && (
            <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-3 rounded-xl text-sm mb-4">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              <span className="flex-1">{formError}</span>
            </div>
          )}
          <div className="space-y-4">
            <div>
              <FieldLabel required>Username</FieldLabel>
              <TextInput value={form.username} onChange={v => setForm(f => ({ ...f, username: v }))} placeholder="e.g. jdoe" />
            </div>
            <div>
              <FieldLabel required>Google Email</FieldLabel>
              <TextInput
                type="email"
                value={form.email}
                onChange={v => setForm(f => ({ ...f, email: v }))}
                placeholder="e.g. departmentchair@phd.edu"
              />
              <p className="text-xs text-slate-500 mt-1.5">
                Personal Gmail or university Google Workspace email. They verify Google themselves after login — OTP is not required until then.
              </p>
            </div>
            <div>
              <FieldLabel required>Program</FieldLabel>
              <select
                value={form.program_id}
                onChange={e => setForm(f => ({ ...f, program_id: e.target.value }))}
                className="w-full bg-[#0b0f1a] border border-white/10 rounded-xl px-3.5 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-[#3C91E6] focus:border-[#3C91E6]"
              >
                <option value="">Select Program</option>
                {programs.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.code} — {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <FieldLabel required={modal === 'create'}>
                {modal === 'create' ? 'Password' : 'New Password (optional)'}
              </FieldLabel>
              <PasswordField
                value={form.password}
                onChange={v => setForm(f => ({ ...f, password: v }))}
                placeholder={modal === 'create' ? 'Minimum 8 characters' : 'Leave blank to keep current'}
              />
            </div>
            {(modal === 'create' || form.password) && (
              <div>
                <FieldLabel required={modal === 'create' || !!form.password}>Confirm Password</FieldLabel>
                <PasswordField
                  value={form.confirm_password}
                  onChange={v => setForm(f => ({ ...f, confirm_password: v }))}
                  placeholder="Re-enter password"
                />
              </div>
            )}
            <div className="flex gap-3 pt-1">
              <button type="button" onClick={closeModal} disabled={submitting} className="flex-1 border border-white/10 text-slate-300 hover:bg-white/5 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors">Cancel</button>
              <button
                type="button"
                onClick={modal === 'create' ? handleCreate : handleEdit}
                disabled={submitting || (modal === 'create' && !canSubmitCreate) || (modal === 'edit' && (!form.username.trim() || !form.email.trim() || !form.program_id))}
                className="flex-1 flex items-center justify-center gap-2 bg-[#3C91E6] hover:bg-[#2E7DD1] disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors"
              >
                {submitting
                  ? <><BtnSpinner />{modal === 'create' ? 'Creating…' : 'Saving…'}</>
                  : modal === 'create'
                    ? <><Plus className="w-4 h-4" />Create Account</>
                    : <><CheckCircle2 className="w-4 h-4" />Save Changes</>}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {modal === 'password' && selected && (
        <Modal open title={`Reset Password — ${selected.username}`} onClose={closeModal} size="md">
          <p className="text-sm text-slate-400 mb-4">Set a new password for this Department Chair account.</p>
          {formError && (
            <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-3 rounded-xl text-sm mb-4">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              <span className="flex-1">{formError}</span>
            </div>
          )}
          <div className="space-y-4">
            <div>
              <FieldLabel required>New Password</FieldLabel>
              <PasswordField value={newPwd} onChange={setNewPwd} placeholder="Minimum 8 characters" />
            </div>
            <div>
              <FieldLabel required>Confirm Password</FieldLabel>
              <PasswordField value={confirmNewPwd} onChange={setConfirmNewPwd} placeholder="Re-enter new password" />
            </div>
            <div className="flex gap-3 pt-1">
              <button type="button" onClick={closeModal} disabled={submitting} className="flex-1 border border-white/10 text-slate-300 hover:bg-white/5 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors">Cancel</button>
              <button type="button" onClick={handleResetPassword} disabled={submitting} className="flex-1 flex items-center justify-center gap-2 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors">
                {submitting ? <><BtnSpinner />Resetting…</> : <><KeyRound className="w-4 h-4" />Reset Password</>}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {modal === 'delete' && selected && (
        <Modal open title="Delete Account" onClose={closeModal} size="md">
          {formError && (
            <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-3 rounded-xl text-sm mb-4">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              <span className="flex-1">{formError}</span>
            </div>
          )}
          <div className="flex items-start gap-3 p-4 bg-red-500/10 border border-red-500/30 rounded-xl mb-4">
            <AlertTriangle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-red-300">Permanently delete &quot;{selected.username}&quot;?</p>
              <p className="text-xs text-red-400/80 mt-1">This action cannot be undone. The account and associated data will be removed.</p>
            </div>
          </div>
          <div className="flex gap-3">
            <button type="button" onClick={closeModal} disabled={submitting} className="flex-1 border border-white/10 text-slate-300 hover:bg-white/5 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors">Cancel</button>
            <button type="button" onClick={handleDelete} disabled={submitting} className="flex-1 flex items-center justify-center gap-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors">
              {submitting ? <><BtnSpinner />Deleting…</> : <><Trash2 className="w-4 h-4" />Delete Account</>}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

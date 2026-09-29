'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Script from 'next/script';
import { useToast } from '@/context/ToastContext';
import { roleLabel } from '@/lib/roleAccess';
import { useScrollLock } from '@/hooks/useScrollLock';
import { PageLoadTransition } from '@/components/ui/PageLoadTransition';
import BackButton from '@/components/ui/BackButton';
import { FormSkeleton } from '@/components/ui/skeletons';
import { LOADING_DELAY, useMinLoading } from '@/hooks/useMinLoading';
import {
  CheckCircle, AlertTriangle, X, Eye, EyeOff, ShieldCheck,
  Camera, User, Palette, Lock,
  ChevronDown, ChevronRight, KeyRound, Smartphone, Sun, Moon,
} from 'lucide-react';
import { ProfilePictureUpload } from '@/components/ui/ProfilePictureUpload';
import TrustedDevicesPanel from '@/components/security/TrustedDevicesPanel';
import OtpPreferencePanel from '@/components/security/OtpPreferencePanel';

/* ── Shared helpers ────────────────────────────────────────────── */

function Spinner() {
  return <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin flex-shrink-0" />;
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-[#64748B] uppercase tracking-wide mb-1.5">{label}</label>
      {children}
    </div>
  );
}

function InputField({
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
      className="w-full border border-[#CBD5E1] rounded-xl px-3.5 py-2.5 text-sm text-[#0B2A5B] placeholder-[#CBD5E1]
        focus:outline-none focus:ring-2 focus:ring-[#1D5BD6] focus:border-[#1D5BD6]
        bg-white disabled:bg-[#F8FAFC] disabled:text-[#94A3B8] disabled:cursor-not-allowed transition-all"
    />
  );
}

function PasswordField({
  value, onChange, placeholder = 'Enter password',
}: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <InputField type={show ? 'text' : 'password'} value={value} onChange={onChange} placeholder={placeholder} />
      <button
        type="button"
        onClick={() => setShow(s => !s)}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-[#94A3B8] hover:text-[#64748B]"
      >
        {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
  );
}

function InlineAlert({ type, msg, onClose }: { type: 'error' | 'success'; msg: string; onClose: () => void }) {
  if (!msg) return null;
  const s = type === 'error'
    ? 'bg-red-50 border-red-200 text-red-600'
    : 'bg-emerald-50 border-emerald-200 text-emerald-700';
  const Icon = type === 'error' ? AlertTriangle : CheckCircle;
  return (
    <div className={`flex items-center gap-2 border px-4 py-3 rounded-xl text-sm ${s}`}>
      <Icon className="w-4 h-4 flex-shrink-0" />
      <span className="flex-1">{msg}</span>
      <button onClick={onClose}><X className="w-3.5 h-3.5" /></button>
    </div>
  );
}

/* ── Accordion Card (same as Admin Settings) ───────────────────── */

function AccordionCard({
  icon: Icon,
  title,
  subtitle,
  open,
  onToggle,
  children,
}: {
  icon: React.ElementType;
  title: string;
  subtitle: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-2xl border border-[#E2E8F0] overflow-hidden transition-all duration-200 shadow-sm">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full flex items-center gap-4 px-6 py-5 text-left hover:bg-[#F8FAFC] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1D5BD6] focus-visible:ring-inset"
      >
        <div className="flex-shrink-0 w-11 h-11 bg-[#EFF6FF] rounded-xl flex items-center justify-center">
          <Icon className="w-5 h-5 text-[#1D5BD6]" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[15px] font-bold text-[#0B2A5B] leading-tight">{title}</p>
          <p className="text-sm text-[#64748B] mt-0.5 leading-snug">{subtitle}</p>
        </div>
        <ChevronDown
          className={`flex-shrink-0 w-5 h-5 text-[#94A3B8] transition-transform duration-300 ${open ? 'rotate-180' : ''}`}
        />
      </button>
      <div
        className="grid transition-all duration-300 ease-in-out"
        style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden">
          <div className="border-t border-[#E2E8F0] px-6 py-5">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

function CategoryLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#94A3B8] px-1 mb-2">
      {children}
    </p>
  );
}

/* ── Security action row (opens modal) ─────────────────────────── */

function SecurityActionRow({
  icon: Icon,
  title,
  description,
  onClick,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-4 px-4 py-3.5 text-left rounded-xl hover:bg-[#F8FAFC] transition-colors"
    >
      <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-[#EFF6FF] flex items-center justify-center">
        <Icon className="w-4 h-4 text-[#1D5BD6]" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-[#0B2A5B]">{title}</p>
        <p className="text-[12px] text-[#64748B] mt-0.5">{description}</p>
      </div>
      <ChevronRight className="w-4 h-4 text-[#94A3B8] flex-shrink-0" />
    </button>
  );
}

/* ── Light modal (same as Admin Settings) ──────────────────────── */

function LightModal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  useScrollLock(true);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" data-modal-root>
      <button type="button" className="absolute inset-0 bg-black/40" aria-label="Close" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`relative w-full ${wide ? 'max-w-lg' : 'max-w-md'} rounded-2xl border border-[#E2E8F0] bg-white shadow-xl max-h-[90vh] overflow-y-auto`}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-[#E2E8F0] sticky top-0 bg-white z-10">
          <h2 className="text-base font-bold text-[#0B2A5B]">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-[#94A3B8] hover:text-[#0B2A5B] hover:bg-[#F8FAFC] transition-colors"
            aria-label="Close dialog"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-5 py-5">{children}</div>
      </div>
    </div>
  );
}

/* ── Google Verification (existing logic, unchanged) ───────────── */

function GoogleVerificationSection() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [googleVerified, setGoogleVerified] = useState(false);
  const [gisReady, setGisReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showChange, setShowChange] = useState(false);
  const googleBtnRef = useRef<HTMLDivElement>(null);
  const changeBtnRef = useRef<HTMLDivElement>(null);
  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

  const load = useCallback(() => {
    setLoading(true);
    fetch('/api/account/me')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.user) {
          setEmail(String(d.user.email ?? ''));
          setGoogleVerified(d.user.google_verified === true);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCredential = useCallback(async (response: GoogleCredentialResponse) => {
    setError('');
    setBusy(true);
    try {
      const res = await fetch('/api/dept-chair/verify-google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential: response.credential }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Google verification failed.');
        return;
      }
      setGoogleVerified(true);
      setShowChange(false);
      if (data.email) setEmail(String(data.email));
      toast.success('Google account verified. You can enable Two-Step Verification in Security.');
    } catch {
      setError('Unable to reach the server. Please try again.');
    } finally {
      setBusy(false);
    }
  }, [toast]);

  useEffect(() => {
    if (!gisReady || !clientId || !window.google?.accounts?.id) return;
    const target = !googleVerified
      ? googleBtnRef.current
      : showChange
        ? changeBtnRef.current
        : null;
    if (!target) return;
    target.innerHTML = '';
    window.google.accounts.id.initialize({
      client_id: clientId,
      callback: handleCredential,
      auto_select: false,
      cancel_on_tap_outside: true,
    });
    window.google.accounts.id.renderButton(target, {
      type: 'standard',
      theme: 'filled_blue',
      size: 'large',
      text: 'continue_with',
      width: 280,
    });
  }, [gisReady, clientId, googleVerified, showChange, handleCredential]);

  async function removeGoogle() {
    if (!window.confirm(
      'Remove connected Google account?\n\nThis clears Google verification. Two-Step Verification will be turned off until you verify again.'
    )) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/dept-chair/verify-google', { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Failed to remove Google account.');
        return;
      }
      setGoogleVerified(false);
      setShowChange(false);
      toast.success('Google account unlinked.');
    } catch {
      setError('Unable to reach the server. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-6">
        <div className="w-5 h-5 border-2 border-[#E2E8F0] border-t-[#1D5BD6] rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {clientId && (
        <Script
          src="https://accounts.google.com/gsi/client"
          strategy="afterInteractive"
          onLoad={() => setGisReady(true)}
        />
      )}

      {error && <InlineAlert type="error" msg={error} onClose={() => setError('')} />}

      {!googleVerified ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Verify your Google account to confirm email ownership. After verifying, you can turn on Two-Step Verification (Email OTP) from Password and Security.
        </div>
      ) : (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 flex items-start gap-2">
          <CheckCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-semibold">Google verified</p>
            <p className="text-xs mt-0.5">{email} — email ownership confirmed.</p>
          </div>
        </div>
      )}

      <FieldRow label="Registered email">
        <InputField type="email" value={email} onChange={() => {}} disabled placeholder="" />
      </FieldRow>
      <p className="text-xs text-[#94A3B8] -mt-2">
        The Google account you link must match this email exactly.
      </p>

      {!clientId ? (
        <p className="text-xs text-amber-600">Google Sign-In is not configured.</p>
      ) : !googleVerified ? (
        <div>
          {busy && <p className="text-xs text-[#64748B] mb-2">Verifying…</p>}
          <div ref={googleBtnRef} className="min-h-[40px]" />
        </div>
      ) : (
        <div className="flex flex-wrap gap-3 items-center">
          <button
            type="button"
            onClick={() => setShowChange(s => !s)}
            className="text-sm font-semibold text-[#1D5BD6] hover:text-[#164BB5]"
          >
            {showChange ? 'Cancel' : 'Change Google account'}
          </button>
          <button
            type="button"
            onClick={removeGoogle}
            disabled={busy}
            className="text-sm font-semibold text-red-600 hover:text-red-700 disabled:opacity-50"
          >
            Remove Google account
          </button>
          {showChange && (
            <div className="w-full">
              {busy && <p className="text-xs text-[#64748B] mb-2">Verifying…</p>}
              <div ref={changeBtnRef} className="min-h-[40px]" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Profile Settings (existing logic, unchanged) ──────────────── */

function ProfileSettingsSection() {
  const toast = useToast();
  const [user, setUser] = useState<{ id: number; username: string; email: string; role: string; google_verified?: boolean } | null>(null);
  const [form, setForm] = useState({ username: '', email: '' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    fetch('/api/account/me')
      .then(r => r.json())
      .then(d => {
        if (d.user) { setUser(d.user); setForm({ username: d.user.username, email: d.user.email }); }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    if (!form.username.trim()) { setError('Username is required.'); return; }
    if (!form.email.trim()) { setError('Email is required.'); return; }
    setSaving(true); setError(''); setSuccess('');
    try {
      const res = await fetch('/api/account/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const d = await res.json();
      if (!res.ok) { setError(d.error ?? 'Failed to save.'); return; }
      setUser(d.user);
      setSuccess('Profile updated successfully.');
      toast.success('Profile updated successfully.');
    } catch { setError('Connection error. Please try again.'); }
    finally { setSaving(false); }
  }

  const dirty = user && (form.username !== user.username || form.email !== user.email);

  if (loading) return (
    <div className="flex items-center justify-center py-6">
      <div className="w-5 h-5 border-2 border-[#E2E8F0] border-t-[#1D5BD6] rounded-full animate-spin" />
    </div>
  );

  return (
    <div className="space-y-3">
      {success && <InlineAlert type="success" msg={success} onClose={() => setSuccess('')} />}
      {error && <InlineAlert type="error" msg={error} onClose={() => setError('')} />}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <FieldRow label="Username">
          <InputField value={form.username} onChange={v => setForm(f => ({ ...f, username: v }))} placeholder="Your username" />
        </FieldRow>
        <FieldRow label="Email">
          <InputField type="email" value={form.email} onChange={v => setForm(f => ({ ...f, email: v }))} placeholder="Your email address" />
        </FieldRow>
      </div>

      {user?.google_verified && form.email !== user.email && (
        <p className="text-xs text-amber-600">
          Changing your email will clear Google verification and turn off Two-Step Verification until you verify again.
        </p>
      )}

      <div className="flex items-center justify-between gap-3 pt-0.5">
        {user && (
          <p className="text-xs text-[#94A3B8]">
            Role: <span className="font-medium text-[#64748B]">{roleLabel(user.role)}</span>
          </p>
        )}
        {dirty && (
          <button
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold bg-[#1D5BD6] hover:bg-[#164BB5] disabled:opacity-50 text-white shadow-sm transition-all flex-shrink-0"
          >
            {saving ? <><Spinner />Saving…</> : <><CheckCircle className="w-4 h-4" />Save Profile</>}
          </button>
        )}
      </div>
    </div>
  );
}

/* ── Change Password (existing logic, unchanged) ───────────────── */

function ChangePasswordSection() {
  const toast = useToast();
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  async function changePassword() {
    if (!form.current) { setError('Current password is required.'); return; }
    if (!form.next) { setError('New password is required.'); return; }
    if (form.next.length < 8) { setError('New password must be at least 8 characters.'); return; }
    if (form.next !== form.confirm) { setError('New passwords do not match.'); return; }
    if (form.current === form.next) {
      setError('Your new password must be different from your current password.');
      return;
    }
    setSaving(true); setError(''); setSuccess('');
    try {
      const res = await fetch('/api/account/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: form.current, new_password: form.next, confirm_password: form.confirm }),
      });
      const d = await res.json();
      if (!res.ok) { setError(d.error ?? 'Failed to change password.'); return; }
      toast.success('Password changed. Please sign in again.');
      window.location.href = '/login';
    } catch { setError('Connection error. Please try again.'); }
    finally { setSaving(false); }
  }

  return (
    <div className="space-y-3">
      {success && <InlineAlert type="success" msg={success} onClose={() => setSuccess('')} />}
      {error && <InlineAlert type="error" msg={error} onClose={() => setError('')} />}

      <FieldRow label="Current Password">
        <PasswordField value={form.current} onChange={v => setForm(f => ({ ...f, current: v }))} placeholder="Enter your current password" />
      </FieldRow>
      <FieldRow label="New Password">
        <PasswordField value={form.next} onChange={v => setForm(f => ({ ...f, next: v }))} placeholder="Minimum 8 characters" />
      </FieldRow>
      <FieldRow label="Confirm New Password">
        <PasswordField value={form.confirm} onChange={v => setForm(f => ({ ...f, confirm: v }))} placeholder="Re-enter new password" />
      </FieldRow>

      <button
        onClick={changePassword}
        disabled={saving || !form.current || !form.next || !form.confirm}
        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold bg-[#1D5BD6] hover:bg-[#164BB5] disabled:opacity-50 text-white shadow-sm transition-all"
      >
        {saving ? <><Spinner />Changing…</> : <><ShieldCheck className="w-4 h-4" />Change Password</>}
      </button>
    </div>
  );
}

/* ── Profile Picture (existing logic, unchanged) ───────────────── */

function DeptChairProfilePicture() {
  const [picUrl, setPicUrl] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => r.json())
      .then(d => {
        if (d.user) {
          setPicUrl(d.user.profile_picture ?? null);
          setDisplayName(d.user.username || d.user.email || roleLabel(d.user.role) || 'Program Chair');
        }
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  if (!loaded) return (
    <div className="flex justify-center py-5">
      <div className="w-5 h-5 border-2 border-[#E2E8F0] border-t-[#1D5BD6] rounded-full animate-spin" />
    </div>
  );

  return (
    <ProfilePictureUpload
      currentUrl={picUrl}
      uploadEndpoint="/api/account/me/picture"
      deleteEndpoint="/api/account/me/picture"
      onSuccess={url => setPicUrl(url)}
      onRemove={() => setPicUrl(null)}
      theme="light"
      compact
      displayName={displayName}
      removeLabel="Remove Photo"
    />
  );
}

/* ── Appearance (same localStorage approach as Admin) ──────────── */

function AppearanceSection() {
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem('admin-theme');
    setIsDark(stored === 'dark');
  }, []);

  function toggle() {
    const next = !isDark;
    setIsDark(next);
    localStorage.setItem('admin-theme', next ? 'dark' : 'light');
    document.documentElement.classList.toggle('light', !next);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between p-4 bg-[#F8FAFC] rounded-xl border border-[#E2E8F0]">
        <div className="flex items-center gap-3">
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors ${isDark ? 'bg-slate-800' : 'bg-amber-50'}`}>
            {isDark
              ? <Moon className="w-4 h-4 text-slate-300" />
              : <Sun className="w-4 h-4 text-amber-500" />}
          </div>
          <div>
            <p className="text-sm font-semibold text-[#0B2A5B]">Dark Mode</p>
            <p className="text-xs text-[#64748B] mt-0.5">
              {isDark ? 'Currently using dark theme' : 'Currently using light theme'}
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={toggle}
          aria-label="Toggle dark mode"
          aria-pressed={isDark}
          className={`relative inline-flex h-7 w-12 flex-shrink-0 items-center rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-[#1D5BD6] focus:ring-offset-2 ${
            isDark
              ? 'bg-[#1D5BD6] focus:ring-offset-[#111827]'
              : 'bg-[#CBD5E1] focus:ring-offset-white'
          }`}
        >
          <span
            className={`qr-keep-light inline-block h-5 w-5 transform rounded-full shadow-md ring-1 ring-black/10 transition-transform duration-200 ${
              isDark ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>

      <p className="text-xs text-[#94A3B8]">
        Theme changes apply immediately across the entire application.
      </p>
    </div>
  );
}

/* ── Password and Security (combined accordion content) ────────── */

function PasswordAndSecuritySection() {
  const [modal, setModal] = useState<null | 'password' | 'devices'>(null);

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-[#E2E8F0] overflow-hidden">
        <div className="px-4 py-2.5 bg-[#F8FAFC] border-b border-[#E2E8F0]">
          <p className="text-[11px] font-bold text-[#94A3B8] uppercase tracking-[0.14em]">Security</p>
        </div>
        <div className="p-3">
          <OtpPreferencePanel variant="light" embedded />
        </div>
      </div>

      <div className="rounded-xl border border-[#E2E8F0] overflow-hidden divide-y divide-[#E2E8F0]">
        <div className="px-4 py-2.5 bg-[#F8FAFC]">
          <p className="text-[11px] font-bold text-[#94A3B8] uppercase tracking-[0.14em]">Login &amp; security</p>
        </div>
        <SecurityActionRow
          icon={KeyRound}
          title="Change Password"
          description="Update your account password securely"
          onClick={() => setModal('password')}
        />
      </div>

      <div className="rounded-xl border border-[#E2E8F0] overflow-hidden divide-y divide-[#E2E8F0]">
        <div className="px-4 py-2.5 bg-[#F8FAFC]">
          <p className="text-[11px] font-bold text-[#94A3B8] uppercase tracking-[0.14em]">Where you&apos;re logged in</p>
        </div>
        <SecurityActionRow
          icon={Smartphone}
          title="Trusted Devices"
          description="Review and manage authenticated devices"
          onClick={() => setModal('devices')}
        />
      </div>

      {modal === 'password' && (
        <LightModal title="Change Password" onClose={() => setModal(null)}>
          <p className="text-[12px] text-[#64748B] leading-relaxed mb-4">
            Update your account password securely. You&apos;ll need your current password.
          </p>
          <ChangePasswordSection />
        </LightModal>
      )}

      {modal === 'devices' && (
        <LightModal title="Where You're Logged In" onClose={() => setModal(null)} wide>
          <TrustedDevicesPanel />
        </LightModal>
      )}
    </div>
  );
}

/* ── Main Settings Page ────────────────────────────────────────── */

type SectionId = 'picture' | 'profile' | 'appearance' | 'google' | 'security';

export default function DeptChairAccountClient() {
  const [openSection, setOpenSection] = useState<SectionId | null>(null);
  const [booting, setBooting] = useState(true);
  useEffect(() => { setBooting(false); }, []);
  const showSkeleton = useMinLoading(booting, LOADING_DELAY);

  function toggle(id: SectionId) {
    setOpenSection(prev => (prev === id ? null : id));
  }

  return (
    <div className="min-h-screen bg-[#F8FAFC] p-5 md:p-7 lg:p-8">
      <div className="max-w-2xl">
        <div className="mb-7">
          <BackButton />
          <h1 className="text-2xl font-bold text-[#0B2A5B]">Settings</h1>
        </div>

        <PageLoadTransition
          showSkeleton={showSkeleton}
          skeleton={<FormSkeleton fields={6} />}
        >
        <div className="space-y-8">
          {/* PROFILE */}
          <section className="space-y-3">
            <CategoryLabel>Profile</CategoryLabel>
            <AccordionCard
              icon={Camera}
              title="Profile Picture"
              subtitle="Upload and manage your profile photo"
              open={openSection === 'picture'}
              onToggle={() => toggle('picture')}
            >
              <DeptChairProfilePicture />
            </AccordionCard>
            <AccordionCard
              icon={User}
              title="Account Details"
              subtitle="Username, email, and role"
              open={openSection === 'profile'}
              onToggle={() => toggle('profile')}
            >
              <ProfileSettingsSection />
            </AccordionCard>
            <AccordionCard
              icon={Palette}
              title="Appearance"
              subtitle="Theme and display preferences"
              open={openSection === 'appearance'}
              onToggle={() => toggle('appearance')}
            >
              <AppearanceSection />
            </AccordionCard>
          </section>

          {/* ACCOUNT & SECURITY */}
          <section className="space-y-3">
            <CategoryLabel>Account &amp; Security</CategoryLabel>
            <AccordionCard
              icon={ShieldCheck}
              title="Google Account"
              subtitle="Verification and linked Google account"
              open={openSection === 'google'}
              onToggle={() => toggle('google')}
            >
              <GoogleVerificationSection />
            </AccordionCard>
            <AccordionCard
              icon={Lock}
              title="Password and Security"
              subtitle="Two-step verification, password, and devices"
              open={openSection === 'security'}
              onToggle={() => toggle('security')}
            >
              <PasswordAndSecuritySection />
            </AccordionCard>
          </section>
        </div>
        </PageLoadTransition>
      </div>
    </div>
  );
}

'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useToast } from '@/context/ToastContext';
import { useRealtime } from '@/context/RealtimeContext';
import { useScrollLock } from '@/hooks/useScrollLock';
import ImageCropDialog from '@/components/ui/ImageCropDialog';
import BackButton from '@/components/ui/BackButton';
import WatermarkTitle from '@/components/ui/WatermarkTitle';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useSystemLogo } from '@/hooks/useSystemLogo';
import { PageLoadTransition } from '@/components/ui/PageLoadTransition';
import { FormSkeleton, Skeleton } from '@/components/ui/skeletons';
import { LOADING_DELAY, useMinLoading } from '@/hooks/useMinLoading';
import {
  CheckCircle, ImagePlus, Trash2, Upload, AlertTriangle, X,
  Palette, Sun, Moon,
  CalendarDays, CalendarRange, CalendarPlus, ShieldAlert, Eye, EyeOff, RotateCcw, Plus, Archive,
  KeyRound, ShieldCheck, Smartphone, Lock, ChevronRight, User, Scale,
} from 'lucide-react';
import DayCombinationsSection from './DayCombinationsSection';
import WorkloadLimitsSection from './WorkloadLimitsSection';
import { roleLabel } from '@/lib/roleAccess';
import { ProfilePictureUpload } from '@/components/ui/ProfilePictureUpload';
import SaveSuccessOverlay, { useSaveSuccess } from '@/components/ui/SaveSuccessOverlay';
import TrustedDevicesPanel from '@/components/security/TrustedDevicesPanel';
import OtpPreferencePanel from '@/components/security/OtpPreferencePanel';

/* ── Logo Upload Content ────────────────────────────────────────── */
function LogoUploadContent() {
  const toast = useToast();
  const currentLogo = useSystemLogo();
  const [preview,     setPreview]     = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<File | null>(null);
  const [uploading,   setUploading]   = useState(false);
  const [removing,    setRemoving]    = useState(false);
  const [error,       setError]       = useState('');
  const [success,     setSuccess]     = useState('');
  const [cropSrc,     setCropSrc]     = useState<string | null>(null);
  const [cropFileName, setCropFileName] = useState('logo.png');
  const fileRef = useRef<HTMLInputElement>(null);
  const saved = useSaveSuccess();

  useEffect(() => {
    return () => {
      if (cropSrc) URL.revokeObjectURL(cropSrc);
    };
  }, [cropSrc]);

  function clearCropSrc() {
    setCropSrc(prev => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!e.target.files) return;
    e.target.value = '';
    if (!file) return;
    setError(''); setSuccess('');
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.type)) { setError('Only PNG, JPG, or WEBP images are allowed.'); return; }
    if (file.size > 10 * 1024 * 1024) { setError('File size must be under 10 MB.'); return; }
    clearCropSrc();
    setCropFileName(file.name || 'logo.png');
    setCropSrc(URL.createObjectURL(file));
  }

  function applyCroppedLogo(file: File) {
    clearCropSrc();
    if (preview) URL.revokeObjectURL(preview);
    setPreviewFile(file);
    setPreview(URL.createObjectURL(file));
  }

  function cancelPreview() {
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
    setPreviewFile(null);
    setError('');
  }

  async function uploadLogo() {
    if (!previewFile) return;
    setUploading(true); setError(''); setSuccess('');
    try {
      const form = new FormData();
      form.append('logo', previewFile);
      const res  = await fetch('/api/settings/logo', { method: 'POST', body: form });
      if (!res.ok) {
        let msg = 'Upload failed.';
        try { msg = ((await res.json()) as { error?: string })?.error ?? msg; } catch { /* html */ }
        setError(msg); toast.error(msg); return;
      }
      const data = await res.json();
      if (preview) URL.revokeObjectURL(preview);
      setPreview(null); setPreviewFile(null);
      window.dispatchEvent(new CustomEvent('system-logo-changed', { detail: { logoUrl: data.logoUrl } }));
      // The check draws itself over the logo card, then the toast confirms it
      saved.play(() => toast.success('Logo updated successfully.'));
    } catch {
      setError('Connection error. Please try again.');
      toast.error('Connection error. Please try again.');
    } finally { setUploading(false); }
  }

  async function removeLogo() {
    if (!confirm('Remove the custom logo?')) return;
    setRemoving(true); setError(''); setSuccess('');
    try {
      const res = await fetch('/api/settings/logo', { method: 'DELETE' });
      if (!res.ok) { const d = await res.json(); setError(d.error || 'Failed to remove logo.'); toast.error(d.error || 'Failed to remove logo.'); return; }
      setSuccess('Logo removed.');
      toast.delete('Logo removed.');
      window.dispatchEvent(new CustomEvent('system-logo-changed', { detail: { logoUrl: null } }));
    } catch {
      setError('Connection error. Please try again.');
      toast.error('Connection error. Please try again.');
    } finally { setRemoving(false); }
  }

  return (
    <div className="relative">
      {saved.shown && <SaveSuccessOverlay title="Logo saved" compact />}
      {/* Feedback banners */}
      {success && (
        <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 text-emerald-700 px-4 py-3 rounded-xl text-sm mb-4">
          <CheckCircle className="w-4 h-4 flex-shrink-0" />
          <span className="flex-1">{success}</span>
          <button onClick={() => setSuccess('')}><X className="w-3.5 h-3.5" /></button>
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded-xl text-sm mb-4">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError('')}><X className="w-3.5 h-3.5" /></button>
        </div>
      )}

      <div className="flex flex-col sm:flex-row gap-6 items-start">
        {/* Logo preview */}
        <div className="flex-shrink-0">
          <p className="text-xs font-semibold text-[#64748B] uppercase tracking-wider mb-2">
            {preview ? 'Preview' : 'Current Logo'}
          </p>
          <div className="w-24 h-24 rounded-2xl overflow-hidden border-2 border-[#E2E8F0] bg-[#F8FAFC] flex items-center justify-center shadow-sm relative">
            {preview ? (
              <img src={preview} alt="Preview" className="w-full h-full object-contain p-1" />
            ) : currentLogo ? (
              <img src={currentLogo} alt="Current logo" className="w-full h-full object-contain p-1" />
            ) : (
              <div className="w-full h-full bg-[#F8FAFC]" />
            )}
            {preview && (
              <div className="absolute top-1 right-1 bg-[#1D5BD6] rounded-full px-1.5 py-0.5 text-[10px] font-bold text-white leading-none">
                NEW
              </div>
            )}
          </div>
          {!preview && !currentLogo && (
            <p className="text-xs text-[#94A3B8] mt-1.5 text-center">No logo</p>
          )}
        </div>

        {/* Actions */}
        <div className="flex-1 space-y-3">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={handleFileChange}
          />

          {preview ? (
            <div className="space-y-3">
              <p className="text-sm text-[#334155] font-medium">
                {previewFile?.name}
                <span className="text-[#94A3B8] font-normal ml-2">
                  ({previewFile ? (previewFile.size / 1024).toFixed(0) : 0} KB)
                </span>
              </p>
              <div className="flex gap-2 flex-wrap">
                <button
                  onClick={uploadLogo}
                  disabled={uploading}
                  className="flex items-center gap-2 bg-[#1D5BD6] hover:bg-[#164BB5] disabled:opacity-50 text-white px-4 py-2.5 rounded-xl text-sm font-medium transition-colors shadow-sm"
                >
                  {uploading
                    ? <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />Uploading…</>
                    : <><Upload className="w-4 h-4" />Save Logo</>}
                </button>
                <button
                  onClick={cancelPreview}
                  disabled={uploading}
                  className="flex items-center gap-2 border border-[#E2E8F0] text-[#64748B] hover:bg-[#F8FAFC] px-4 py-2.5 rounded-xl text-sm font-medium transition-colors"
                >
                  <X className="w-4 h-4" /> Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-2.5">
              <button
                onClick={() => fileRef.current?.click()}
                className="flex items-center gap-2 bg-[#EFF6FF] hover:bg-[#DBEAFE] border border-[#BFDBFE] text-[#1D5BD6] px-4 py-2.5 rounded-xl text-sm font-medium transition-colors w-full sm:w-auto"
              >
                <ImagePlus className="w-4 h-4" />
                {currentLogo ? 'Replace Logo' : 'Upload Logo'}
              </button>

              {currentLogo && (
                <button
                  onClick={removeLogo}
                  disabled={removing}
                  className="flex items-center gap-2 border border-red-200 text-red-600 hover:bg-red-50 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors w-full sm:w-auto"
                >
                  {removing
                    ? <><div className="w-4 h-4 border-2 border-red-300 border-t-red-600 rounded-full animate-spin" />Removing…</>
                    : <><Trash2 className="w-4 h-4" />Remove Logo</>}
                </button>
              )}

              <p className="text-xs text-[#94A3B8] leading-relaxed pt-1">
                Appears in the top navigation next to the QRganize name. Crop and zoom like Instagram, then save a sharp PNG.
                <br />Accepted: PNG, JPG, WEBP · Max 10 MB (saved as a high-resolution square PNG).
              </p>
            </div>
          )}
        </div>
      </div>

      <ImageCropDialog
        open={Boolean(cropSrc)}
        imageSrc={cropSrc || ''}
        fileName={cropFileName}
        outputSize={1080}
        outputType="image/png"
        shape="square"
        title="Crop Logo"
        saveLabel="Use Crop"
        onCancel={clearCropSrc}
        onSave={applyCroppedLogo}
      />
    </div>
  );
}

/* ── Appearance Section ─────────────────────────────────────────── */
function AppearanceSection() {
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem('admin-theme');
    // Light is default when no preference is saved
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

        {/* Toggle switch — ON uses brand blue so it stays visible in dark mode;
            thumb uses qr-keep-light so global dark remaps cannot wash it out. */}
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

/* ── Account Management Section ─────────────────────────────────── */
function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-[#64748B] uppercase tracking-wide mb-1.5">{label}</label>
      {children}
    </div>
  );
}

function Input({
  type = 'text', value, onChange, placeholder = '', error = false, disabled = false,
}: {
  type?: string; value: string; onChange: (v: string) => void;
  placeholder?: string; error?: boolean; disabled?: boolean;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      className={`w-full border rounded-xl px-3.5 py-2.5 text-sm text-[#0B2A5B] placeholder-[#CBD5E1]
        focus:outline-none focus:ring-2 focus:ring-[#1D5BD6] focus:border-[#1D5BD6]
        transition-all duration-150 disabled:bg-[#F8FAFC] disabled:text-[#94A3B8] disabled:cursor-not-allowed ${
        error ? 'border-red-300 bg-red-50' : 'border-[#CBD5E1] bg-white'
      }`}
    />
  );
}

function PasswordInput({
  value, onChange, placeholder = 'Enter password', disabled = false,
}: {
  value: string; onChange: (v: string) => void; placeholder?: string; disabled?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input type={show ? 'text' : 'password'} value={value} onChange={onChange} placeholder={placeholder} disabled={disabled} />
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

// ── Sub-section: Admin Profile Picture ────────────────────────────
/** `onSaved` closes the dialog after a new photo — the check then plays over the page */
function AdminProfilePicture({ onSaved }: { onSaved?: () => void }) {
  const [picUrl, setPicUrl] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d?.user) return;
        setPicUrl(d.user.profile_picture ?? null);
        setDisplayName(d.user.username || d.user.email || 'Admin');
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  if (!loaded) {
    return (
      <div className="flex justify-center py-5">
        <div className="w-5 h-5 border-2 border-[#E2E8F0] border-t-[#1D5BD6] rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <ProfilePictureUpload
      currentUrl={picUrl}
      uploadEndpoint="/api/account/me/picture"
      deleteEndpoint="/api/account/me/picture"
      onSuccess={url => { setPicUrl(url); onSaved?.(); }}
      onRemove={() => { setPicUrl(null); onSaved?.(); }}
      theme="light"
      compact
      displayName={displayName}
      removeLabel="Remove Photo"
    />
  );
}

// ── Sub-section: Own Profile Settings ────────────────────────────
function OwnProfileSettings() {
  const toast   = useToast();
  const [user,      setUser]      = useState<{ id: number; username: string; email: string; role: string } | null>(null);
  const [form,      setForm]      = useState({ username: '', email: '' });
  const [loading,   setLoading]   = useState(true);
  const [saving,    setSaving]    = useState(false);
  const [error,     setError]     = useState('');
  const [success,   setSuccess]   = useState('');

  useEffect(() => {
    fetch('/api/account/me')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.user) { setUser(d.user); setForm({ username: d.user.username, email: d.user.email }); } })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    if (!form.username.trim()) { setError('Username is required.'); return; }
    if (!form.email.trim()) { setError('Email is required.'); return; }
    setSaving(true); setError(''); setSuccess('');
    try {
      const res = await fetch('/api/account/me', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        let msg = 'Failed to save.';
        try { msg = ((await res.json()) as { error?: string })?.error ?? msg; } catch { /* html */ }
        setError(msg); return;
      }
      const d = await res.json();
      setUser(d.user); toast.success('Profile updated successfully.');
      setSuccess('Profile updated successfully.');
    } catch { setError('Connection error. Please try again.'); }
    finally { setSaving(false); }
  }

  const dirty = user && (form.username !== user.username || form.email !== user.email);

  // Same shape as the form below (Username | Email, then the role line) — not a spinner
  if (loading) return (
    <div className="space-y-3">
      <FormSkeleton fields={2} columns={2} bare />
      <Skeleton className="h-3 w-32 rounded" />
    </div>
  );

  return (
    <div className="space-y-3">
      {success && <InlineAlert type="success" msg={success} onClose={() => setSuccess('')} />}
      {error   && <InlineAlert type="error"   msg={error}   onClose={() => setError('')} />}

      {/* Username + Email side-by-side on wider layouts to reduce vertical height */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <FieldRow label="Username">
          <Input value={form.username} onChange={v => setForm(f => ({ ...f, username: v }))} placeholder="Your username" />
        </FieldRow>
        <FieldRow label="Email">
          <Input type="email" value={form.email} onChange={v => setForm(f => ({ ...f, email: v }))} placeholder="Your email address" />
        </FieldRow>
      </div>

      {/* Role badge + save button in one row */}
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

// ── Sub-section: Change Own Password ─────────────────────────────
function ChangeOwnPassword({ onSuccess }: { onSuccess?: () => void }) {
  const toast = useToast();
  const [form,      setForm]      = useState({ current: '', next: '', confirm: '' });
  const [saving,    setSaving]    = useState(false);
  const [error,     setError]     = useState('');
  const [success,   setSuccess]   = useState('');

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
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: form.current, new_password: form.next, confirm_password: form.confirm }),
      });
      const d = await res.json();
      if (!res.ok) { setError(d.error ?? 'Failed to change password.'); return; }
      setForm({ current: '', next: '', confirm: '' });
      onSuccess?.();
      toast.success('Password changed. Please sign in again.');
      window.location.href = '/login';
    } catch { setError('Connection error. Please try again.'); }
    finally { setSaving(false); }
  }

  return (
    <div className="space-y-3">
      {success && <InlineAlert type="success" msg={success} onClose={() => setSuccess('')} />}
      {error   && <InlineAlert type="error"   msg={error}   onClose={() => setError('')} />}

      <FieldRow label="Current Password">
        <PasswordInput value={form.current} onChange={v => setForm(f => ({ ...f, current: v }))} placeholder="Enter your current password" />
      </FieldRow>
      <FieldRow label="New Password">
        <PasswordInput value={form.next} onChange={v => setForm(f => ({ ...f, next: v }))} placeholder="Minimum 8 characters" />
      </FieldRow>
      <FieldRow label="Confirm New Password">
        <PasswordInput value={form.confirm} onChange={v => setForm(f => ({ ...f, confirm: v }))} placeholder="Re-enter new password" />
      </FieldRow>
      <button onClick={changePassword} disabled={saving || !form.current || !form.next || !form.confirm} className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold bg-[#1D5BD6] hover:bg-[#164BB5] disabled:opacity-50 text-white shadow-sm transition-all">
        {saving ? <><Spinner />Changing…</> : <><ShieldCheck className="w-4 h-4" />Change Password</>}
      </button>
    </div>
  );
}

// ── Password & Security (Instructor-style rows + modals) ───────────
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
        className={`relative w-full ${wide ? 'max-w-lg' : 'max-w-md'} rounded-2xl overflow-hidden bg-white shadow-xl max-h-[90vh] overflow-y-auto`}
      >
        {/* Royal-blue header — same as every other pop-up */}
        <div className="flex items-center justify-between gap-3 px-5 py-4 sticky top-0 z-10" style={{ background: 'linear-gradient(120deg, #1D5BD6 0%, #0B2A5B 120%)' }}>
          <h2 className="text-base font-bold" style={{ color: '#FFFFFF' }}>{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-white/20 transition-colors"
            style={{ color: '#FFFFFF' }}
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
          <ChangeOwnPassword />
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



/* ── School Year Section ────────────────────────────────────────── */
const SEMESTERS_LIST = ['1st Semester', '2nd Semester', 'Summer'];

interface SchoolYear {
  id:         number;
  label:      string;
  status:     'Active' | 'Archived';
  created_at: string;
}

function nextLabel(years: SchoolYear[]): string {
  if (years.length === 0) {
    const y = new Date().getFullYear();
    return `${y}-${y + 1}`;
  }
  const top = [...years].sort((a, b) => b.label.localeCompare(a.label))[0];
  const end = parseInt(top.label.split('-')[1], 10);
  return `${end}-${end + 1}`;
}

function Spinner({ cls = 'border-white/30 border-t-white' }: { cls?: string }) {
  return <div className={`w-4 h-4 border-2 rounded-full animate-spin flex-shrink-0 ${cls}`} />;
}

const ACTION_EASE = [0.4, 0, 0.2, 1] as const;

/**
 * School Year action button with one shared, gentle motion: the button lifts a
 * touch on hover and presses in on click, and its icon nudges up — the Delete
 * trash can gives a small wiggle instead. Motion is off with reduced motion.
 */
function ActionButton({
  icon: Icon, iconClass = 'w-3.5 h-3.5', wiggle = false, busy, children, disabled, className, style, onClick, title, ariaLabel,
}: {
  icon?: React.ElementType;
  iconClass?: string;
  /** Trash-can wiggle (Delete) instead of the upward nudge */
  wiggle?: boolean;
  /** Shown in place of the icon while the action runs */
  busy?: React.ReactNode;
  children?: React.ReactNode;
  disabled?: boolean;
  className: string;
  style?: React.CSSProperties;
  onClick: () => void;
  title?: string;
  ariaLabel?: string;
}) {
  const reduceMotion = useReducedMotion();
  const live = !reduceMotion && !disabled;
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      style={style}
      className={className}
      initial="rest"
      animate="rest"
      whileHover={live ? 'hover' : undefined}
      whileTap={live ? 'tap' : undefined}
      variants={{ rest: { y: 0, scale: 1 }, hover: { y: -1, scale: 1.04 }, tap: { scale: 0.94 } }}
      transition={{ duration: 0.25, ease: ACTION_EASE }}
    >
      {busy ?? (Icon && (
        <motion.span
          className="inline-flex"
          variants={wiggle
            ? { rest: { rotate: 0 }, hover: { rotate: [0, -14, 10, -6, 0], transition: { duration: 0.5, ease: 'easeInOut' } } }
            : { rest: { y: 0 }, hover: { y: -1.5, transition: { duration: 0.25, ease: ACTION_EASE } } }}
        >
          <Icon className={iconClass} />
        </motion.span>
      ))}
      {children}
    </motion.button>
  );
}

function SchoolYearSection() {
  const toast = useToast();
  const [years,    setYears]    = useState<SchoolYear[]>([]);
  /** Active semester ('' = archived, none active — same rule as school years) */
  const [semester, setSemester] = useState('1st Semester');
  const [newLabel, setNewLabel] = useState('');
  const [loading,  setLoading]  = useState(true);
  const [creating, setCreating] = useState(false);
  const [semBusy,  setSemBusy]  = useState<string | null>(null);
  const [actionId, setActionId] = useState<number | null>(null);
  const [addError, setAddError] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  /** silent: live-update refresh — the list stays on screen */
  async function load(silent = false) {
    if (!silent) setLoading(true);
    try {
      const res = await fetch('/api/school-years');
      if (!res.ok) return;
      const data = await res.json();
      setYears(data.years ?? []);
      setSemester(data.currentSemester ?? '1st Semester');
    } catch { /* silent */ }
    finally { if (!silent) setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  // Live updates: another admin added, activated or archived a school year or
  // changed the semester. Held while this section is saving.
  useRealtime(['term'], () => load(true), {
    enabled: !loading && !creating && semBusy === null && actionId === null && deletingId === null,
  });

  async function addYear(label: string) {
    const clean = label.trim().replace('–', '-').replace('—', '-');
    if (!clean) { setAddError('Enter a school year.'); return; }
    setCreating(true); setAddError('');
    try {
      const res  = await fetch('/api/school-years', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ label: clean }),
      });
      if (!res.ok) {
        let msg = 'Failed to add.';
        try { msg = ((await res.json()) as { error?: string })?.error ?? msg; } catch { /* html */ }
        setAddError(msg); return;
      }
      const data = await res.json();
      setYears(prev =>
        [...prev, data.year as SchoolYear].sort((a, b) => b.label.localeCompare(a.label))
      );
      setNewLabel('');
      toast.success(`${clean} created.`);
    } catch { setAddError('Connection error. Please try again.'); }
    finally { setCreating(false); }
  }

  async function doAction(id: number, action: 'activate' | 'archive') {
    setActionId(id);
    try {
      const res  = await fetch(`/api/school-years/${id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action }),
      });
      if (!res.ok) {
        let msg = 'Action failed.';
        try { msg = ((await res.json()) as { error?: string })?.error ?? msg; } catch { /* html */ }
        toast.error(msg); return;
      }
      const data = await res.json();
      setYears(data.years);
      if (action === 'activate') {
        const active = (data.years as SchoolYear[]).find(y => y.status === 'Active');
        if (active) {
          window.dispatchEvent(new CustomEvent('school-year-changed', {
            detail: { schoolYear: active.label, semester },
          }));
          toast.success(`${active.label} is now the active school year.`);
        }
      } else {
        toast.info('School year archived.');
      }
    } catch { toast.error('Connection error.'); }
    finally { setActionId(null); }
  }

  async function deleteYear(id: number) {
    setDeletingId(id);
    setConfirmDeleteId(null);
    try {
      const res  = await fetch(`/api/school-years/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        let msg = 'Failed to delete.';
        try { msg = ((await res.json()) as { error?: string })?.error ?? msg; } catch { /* html */ }
        toast.error(msg); return;
      }
      const data = await res.json();
      setYears(data.years);
      toast.success('School year deleted.');
    } catch { toast.error('Connection error.'); }
    finally { setDeletingId(null); }
  }

  /** Set Active (`next` = that semester) or Archive the active one (`next` = ''). */
  async function setActiveSemester(target: string, next: string) {
    setSemBusy(target);
    try {
      const res = await fetch('/api/settings/school-year', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ semester: next }),
      });
      if (!res.ok) { toast.error('Failed to save semester.'); return; }
      setSemester(next);
      const active = years.find(y => y.status === 'Active');
      window.dispatchEvent(new CustomEvent('school-year-changed', {
        detail: { schoolYear: active?.label ?? '', semester: next },
      }));
      if (next) toast.success(`${next} is now the active semester.`);
      else toast.info(`${target} archived.`);
    } catch { toast.error('Connection error.'); }
    finally { setSemBusy(null); }
  }

  function generateNext() {
    const next = nextLabel(years);
    if (years.some(y => y.label === next)) {
      toast.warning(`${next} already exists.`);
      return;
    }
    addYear(next);
  }

  const activeYear = years.find(y => y.status === 'Active');
  const next       = nextLabel(years);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="w-6 h-6 border-2 border-[#E2E8F0] border-t-[#1D5BD6] rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">

      {/* ── Active Period Summary ── */}
      {activeYear && (
        <div className="flex items-center gap-3.5 px-4 py-3.5 bg-[#EFF6FF] border border-[#BFDBFE] rounded-2xl">
          <div className="w-9 h-9 rounded-xl bg-[#1D5BD6] flex items-center justify-center flex-shrink-0 shadow-sm">
            <CalendarDays className="w-4 h-4 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-widest text-[#64748B]">Active Period</p>
            <p className="text-sm font-bold text-[#0B2A5B] mt-0.5 leading-tight">
              {activeYear.label}
              <span className="font-normal text-[#64748B] ml-2">· {semester || 'No active semester'}</span>
            </p>
          </div>
          <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-1 rounded-full bg-[#DCFCE7] text-[#16A34A] flex-shrink-0 tracking-wide">
            <span className="w-1.5 h-1.5 rounded-full bg-[#22C55E] inline-block" />
            Active
          </span>
        </div>
      )}

      {/* ── Semesters — same Active / Archived pattern as School Years ── */}
      <div className="rounded-2xl border border-[#E2E8F0] bg-white shadow-sm overflow-hidden">
        <div className="px-5 py-3.5 border-b border-[#F1F5F9]">
          <p className="text-sm font-semibold text-[#0B2A5B]">Semesters</p>
          <p className="text-xs text-[#94A3B8] mt-0.5">
            Only one semester can be active at a time. It applies across all modules.
          </p>
        </div>
        <div className="divide-y divide-[#E2E8F0]">
          {SEMESTERS_LIST.map(sem => {
            const isActive = sem === semester;
            const isBusy   = semBusy === sem;
            const anyBusy  = !!semBusy;
            return (
              <div
                key={sem}
                className={`flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3 transition-colors duration-200 ${
                  isActive ? 'bg-[#F8FAFC]' : 'bg-white hover:bg-[#F8FAFC]'
                }`}
              >
                <span className={`min-w-[5.5rem] sm:min-w-[6.5rem] text-sm font-semibold ${isActive ? 'text-[#0B2A5B]' : 'text-[#64748B]'}`}>
                  {sem}
                </span>
                <span className={`inline-flex items-center text-[10px] font-semibold px-2 py-0.5 rounded-md uppercase tracking-wide flex-shrink-0 ${
                  isActive ? 'bg-[#DCFCE7] text-[#15803D]' : 'bg-[#F1F5F9] text-[#94A3B8]'
                }`}>
                  {isActive ? 'Active' : 'Archived'}
                </span>
                <div className="flex items-center gap-2 flex-shrink-0 ml-auto">
                  {isActive ? (
                    <ActionButton
                      onClick={() => setActiveSemester(sem, '')}
                      disabled={anyBusy}
                      icon={Archive}
                      busy={isBusy ? <Spinner cls="border-[#E2E8F0] border-t-[#94A3B8]" /> : undefined}
                      className="inline-flex items-center justify-center gap-1.5 min-h-[30px] px-3 py-1.5 rounded-lg text-xs font-medium transition-colors duration-200
                        text-[#64748B] border border-[#E2E8F0] bg-white
                        hover:text-[#0B2A5B] hover:border-[#CBD5E1] hover:bg-[#F8FAFC]
                        disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Archive
                    </ActionButton>
                  ) : (
                    <ActionButton
                      onClick={() => setActiveSemester(sem, sem)}
                      disabled={anyBusy}
                      icon={CheckCircle}
                      busy={isBusy ? <Spinner /> : undefined}
                      style={{ color: anyBusy ? '#94A3B8' : '#ffffff' }}
                      className="inline-flex items-center justify-center gap-1.5 min-h-[30px] px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-[#1D5BD6] hover:bg-[#164BB5] transition-colors duration-200 disabled:bg-[#CBD5E1] disabled:cursor-not-allowed"
                    >
                      Set Active
                    </ActionButton>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── School Years List ── */}
      <div className="rounded-2xl border border-[#E2E8F0] bg-white shadow-sm overflow-hidden">

        {/* Header */}
        <div className="px-5 py-3.5 border-b border-[#F1F5F9] flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-[#0B2A5B]">School Years</p>
            <p className="text-xs text-[#94A3B8] mt-0.5">Only one school year can be active at a time.</p>
          </div>
          <ActionButton
            onClick={generateNext}
            disabled={creating || years.some(y => y.label === next)}
            title={`Create ${next}`}
            icon={CalendarPlus}
            busy={creating ? <Spinner /> : undefined}
            className="inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold text-white bg-[#1D5BD6] hover:bg-[#164BB5] transition-colors duration-200 flex-shrink-0 self-start sm:self-auto disabled:bg-[#CBD5E1] disabled:text-white/80 disabled:cursor-not-allowed"
          >
            Generate {next}
          </ActionButton>
        </div>

        {/* List */}
        {years.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-5 py-10 text-center">
            <p className="text-sm font-medium text-[#94A3B8]">No school years yet</p>
            <p className="text-xs text-[#CBD5E1] mt-1">Add one below or click Generate.</p>
          </div>
        ) : (
          <div className="divide-y divide-[#E2E8F0]">
            {years.map(yr => {
              const isActive   = yr.status === 'Active';
              const isLoading  = actionId === yr.id;
              const isDeleting = deletingId === yr.id;
              const anyBusy    = isLoading || isDeleting || !!deletingId || !!actionId;
              const showConfirm = confirmDeleteId === yr.id;
              return (
                <div key={yr.id}>
                  <div
                    className={`flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3 transition-colors duration-100 ${
                      isActive ? 'bg-[#F8FAFC]' : 'bg-white hover:bg-[#F8FAFC]'
                    }`}
                  >
                    {/* Year label */}
                    <span className={`min-w-[5.5rem] sm:min-w-[6.5rem] text-sm font-semibold tabular-nums ${
                      isActive ? 'text-[#0B2A5B]' : 'text-[#64748B]'
                    }`}>
                      {yr.label}
                    </span>

                    {/* Status badge */}
                    <span className={`inline-flex items-center text-[10px] font-semibold px-2 py-0.5 rounded-md uppercase tracking-wide flex-shrink-0 ${
                      isActive
                        ? 'bg-[#DCFCE7] text-[#15803D]'
                        : 'bg-[#F1F5F9] text-[#94A3B8]'
                    }`}>
                      {yr.status}
                    </span>

                    {/* Actions */}
                    <div className="flex items-center gap-2 flex-shrink-0 ml-auto">
                      {isActive ? (
                        <ActionButton
                          onClick={() => doAction(yr.id, 'archive')}
                          disabled={anyBusy}
                          icon={Archive}
                          busy={isLoading ? <Spinner cls="border-[#E2E8F0] border-t-[#94A3B8]" /> : undefined}
                          className="inline-flex items-center justify-center gap-1.5 min-h-[30px] px-3 py-1.5 rounded-lg text-xs font-medium transition-colors duration-200
                            text-[#64748B] border border-[#E2E8F0] bg-white
                            hover:text-[#0B2A5B] hover:border-[#CBD5E1] hover:bg-[#F8FAFC]
                            disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          Archive
                        </ActionButton>
                      ) : (
                        <>
                          <ActionButton
                            onClick={() => doAction(yr.id, 'activate')}
                            disabled={anyBusy}
                            icon={CheckCircle}
                            busy={isLoading ? <Spinner /> : undefined}
                            style={{ color: (isLoading || anyBusy) ? '#94A3B8' : '#ffffff' }}
                            className="inline-flex items-center justify-center gap-1.5 min-h-[30px] px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-[#1D5BD6] hover:bg-[#164BB5] transition-colors duration-200 disabled:bg-[#CBD5E1] disabled:cursor-not-allowed"
                          >
                            Set Active
                          </ActionButton>
                          <ActionButton
                            onClick={() => setConfirmDeleteId(yr.id)}
                            disabled={anyBusy}
                            title="Delete school year"
                            ariaLabel={`Delete ${yr.label}`}
                            icon={Trash2}
                            wiggle
                            busy={isDeleting ? <Spinner cls="border-red-200 border-t-red-500" /> : undefined}
                            className="inline-flex items-center justify-center w-8 h-8 rounded-lg text-red-600 border border-red-200 bg-red-50
                              hover:bg-red-100 hover:border-red-300
                              transition-colors duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
                          />
                        </>
                      )}
                    </div>
                  </div>

                  {/* Inline confirmation dialog */}
                  {showConfirm && (
                    <div className="mx-5 mb-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3.5 flex items-start gap-3">
                      <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-red-700">Delete {yr.label}?</p>
                        <p className="text-xs text-red-500 mt-0.5">
                          This action cannot be undone. The school year will be permanently removed.
                        </p>
                        <div className="flex flex-wrap items-center gap-2 mt-3">
                          <ActionButton
                            onClick={() => deleteYear(yr.id)}
                            icon={Trash2}
                            iconClass="w-3 h-3"
                            wiggle
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-600 text-white hover:bg-red-700 transition-colors duration-200"
                          >
                            Yes, Delete
                          </ActionButton>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(null)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-[#64748B] border border-[#E2E8F0] bg-white hover:bg-[#F8FAFC] transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Add School Year ── */}
      <div className="rounded-2xl border border-[#E2E8F0] bg-white shadow-sm overflow-hidden">
        <div className="px-5 py-3.5 border-b border-[#F1F5F9]">
          <p className="text-sm font-semibold text-[#0B2A5B]">Add School Year</p>
          <p className="text-xs text-[#94A3B8] mt-0.5">
            New years are added as Archived. Activate one to set the system default.
          </p>
        </div>
        <div className="px-5 py-4 space-y-2">
          <div className="flex items-start gap-2.5">
            <div className="flex-1 min-w-0">
              <input
                type="text"
                value={newLabel}
                onChange={e => { setNewLabel(e.target.value); setAddError(''); }}
                onKeyDown={e => e.key === 'Enter' && addYear(newLabel)}
                placeholder="e.g. 2027-2028"
                maxLength={9}
                className={`w-full border rounded-xl px-3.5 py-2.5 text-sm text-[#0B2A5B] placeholder-[#CBD5E1]
                  focus:outline-none focus:ring-2 focus:ring-[#1D5BD6] focus:border-[#1D5BD6] transition-all duration-150 ${
                  addError ? 'border-red-300 bg-red-50' : 'border-[#CBD5E1] bg-white'
                }`}
              />
            </div>
            <ActionButton
              onClick={() => addYear(newLabel)}
              disabled={creating || !newLabel.trim()}
              icon={Plus}
              iconClass="w-4 h-4"
              busy={creating ? <Spinner /> : undefined}
              style={{ color: (creating || !newLabel.trim()) ? '#94A3B8' : '#ffffff' }}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white bg-[#1D5BD6] hover:bg-[#164BB5] transition-colors duration-200 flex-shrink-0 shadow-sm disabled:bg-[#CBD5E1] disabled:shadow-none disabled:cursor-not-allowed"
            >
              {creating ? 'Adding…' : 'Add Year'}
            </ActionButton>
          </div>

          {addError && (
            <p className="flex items-center gap-1.5 text-xs text-red-500">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
              {addError}
            </p>
          )}

          <p className="text-xs text-[#94A3B8] pt-1">
            Format: <span className="font-mono font-medium text-[#64748B]">YYYY-YYYY</span>
            {' '}· End year must be start year + 1 (e.g. 2027-2028).
          </p>
        </div>
      </div>

    </div>
  );
}

/* ── System Reset Section ────────────────────────────────────────── */
function SystemResetSection() {
  const toast = useToast();
  const [password,    setPassword]    = useState('');
  const [showPwd,     setShowPwd]     = useState(false);
  const [verifying,   setVerifying]   = useState(false);
  const [pwdError,    setPwdError]    = useState('');
  const [showConfirm, setShowConfirm] = useState(false);
  const [resetting,   setResetting]   = useState(false);
  const [done,        setDone]        = useState(false);
  useScrollLock(showConfirm);

  async function verify() {
    if (!password.trim()) { setPwdError('Please enter your password.'); return; }
    setVerifying(true); setPwdError('');
    try {
      const res  = await fetch('/api/settings/verify-password', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ password }),
      });
      const data = await res.json();
      if (!data.valid) { setPwdError('Incorrect password. Please try again.'); return; }
      setShowConfirm(true);
    } catch {
      setPwdError('Connection error. Please try again.');
    } finally { setVerifying(false); }
  }

  async function performReset() {
    setResetting(true);
    try {
      const res  = await fetch('/api/settings/reset', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ password }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Reset failed.');
        setShowConfirm(false);
        setPwdError(data.error || 'Reset failed.');
        return;
      }
      setShowConfirm(false);
      setPassword('');
      setDone(true);
      toast.success('System reset completed successfully.');
    } catch {
      toast.error('Connection error. Please try again.');
      setShowConfirm(false);
    } finally { setResetting(false); }
  }

  if (done) {
    return (
      <div className="flex flex-col items-center gap-3 py-4 text-center">
        <div className="w-12 h-12 rounded-full bg-emerald-50 border border-emerald-200 flex items-center justify-center">
          <CheckCircle className="w-6 h-6 text-emerald-500" />
        </div>
        <div>
          <p className="font-semibold text-[#0B2A5B]">Reset Complete</p>
          <p className="text-xs text-[#64748B] mt-1">
            All operational data has been cleared. Permanent records (faculty, curriculum, rooms) are preserved.
          </p>
        </div>
        <button
          onClick={() => setDone(false)}
          className="text-xs text-[#94A3B8] hover:text-[#64748B] underline mt-1"
        >
          Dismiss
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* What gets reset */}
      <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl space-y-2">
        <div className="flex items-center gap-2 text-amber-700">
          <ShieldAlert className="w-4 h-4 flex-shrink-0" />
          <p className="text-sm font-semibold">What will be cleared</p>
        </div>
        <ul className="text-xs text-amber-700 space-y-1 ml-6 list-disc">
          <li>All master schedules and session records</li>
          <li>All faculty workload assignments</li>
          <li>Overload and Praise records</li>
          <li>QR scan logs, room utilization logs, and violations</li>
          <li>Block subject statuses reset to Unscheduled</li>
        </ul>
        <p className="text-xs text-amber-600 font-medium ml-6">
          Faculty records, programs, curriculum, blocks, rooms, and system settings are preserved.
        </p>
      </div>

      {/* Password entry */}
      <div>
        <label className="block text-xs font-semibold text-[#64748B] uppercase tracking-wide mb-1.5">
          Confirm with your password
        </label>
        <div className="relative">
          <input
            type={showPwd ? 'text' : 'password'}
            value={password}
            onChange={e => { setPassword(e.target.value); setPwdError(''); }}
            onKeyDown={e => e.key === 'Enter' && verify()}
            placeholder="Enter admin password…"
            className={`w-full bg-[#F8FAFC] border rounded-xl px-3 py-2.5 pr-10 text-sm text-[#0B2A5B] focus:outline-none focus:ring-2 focus:ring-[#1D5BD6] focus:border-transparent transition-colors ${
              pwdError ? 'border-red-300 bg-red-50' : 'border-[#E2E8F0]'
            }`}
          />
          <button
            type="button"
            onClick={() => setShowPwd(v => !v)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-[#94A3B8] hover:text-[#64748B]"
          >
            {showPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
        {pwdError && (
          <p className="flex items-center gap-1.5 text-xs text-red-600 mt-1.5">
            <AlertTriangle className="w-3.5 h-3.5" />{pwdError}
          </p>
        )}
      </div>

      <button
        onClick={verify}
        disabled={verifying || !password.trim()}
        className="flex items-center gap-2 border-2 border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-50 px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors"
      >
        {verifying
          ? <><div className="w-4 h-4 border-2 border-red-300 border-t-red-600 rounded-full animate-spin" />Verifying…</>
          : <><RotateCcw className="w-4 h-4" />Verify &amp; Continue</>}
      </button>

      {/* Confirmation overlay */}
      {showConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm" data-modal-root>
          <div className="bg-white rounded-2xl shadow-2xl border border-[#E2E8F0] max-w-md w-full p-6 space-y-5">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full bg-red-50 border border-red-200 flex items-center justify-center flex-shrink-0 mt-0.5">
                <ShieldAlert className="w-5 h-5 text-red-500" />
              </div>
              <div>
                <h2 className="font-bold text-[#0B2A5B] text-base">Confirm System Reset</h2>
                <p className="text-sm text-[#64748B] mt-1">
                  <strong className="text-red-600">Warning: This action cannot be undone.</strong>
                  {' '}All schedules, workload assignments, and operational logs will be permanently deleted.
                </p>
                <p className="text-sm text-[#64748B] mt-2">
                  Are you sure you want to reset the system?
                </p>
              </div>
            </div>

            <div className="flex gap-3 pt-1">
              <button
                onClick={() => setShowConfirm(false)}
                disabled={resetting}
                className="flex-1 border border-[#E2E8F0] text-[#64748B] hover:bg-[#F8FAFC] px-4 py-2.5 rounded-xl text-sm font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={performReset}
                disabled={resetting}
                className="flex-1 flex items-center justify-center gap-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors"
              >
                {resetting
                  ? <><div className="w-4 h-4 border-2 border-red-300 border-t-white rounded-full animate-spin" />Resetting…</>
                  : <><RotateCcw className="w-4 h-4" />Yes, Reset System</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Layout: tile home → setting pops up in the centre ─────────────
   Settings opens on a home screen of large, colour-coded tiles (nothing is
   opened automatically). Clicking a tile pops that setting up in a centred,
   balanced-width window with a gradient banner; Close / Esc / backdrop
   returns to the tiles. */
type SettingsSectionId = 'profile' | 'security' | 'school-year' | 'day-combinations' | 'workload-limits' | 'branding' | 'appearance' | 'reset';

interface SectionDef {
  id: SettingsSectionId;
  icon: React.ElementType;
  label: string;
  description: string;
  /** Tile / banner colour */
  tone: string;
}

const SECTION_GROUPS: { label: string; items: SectionDef[] }[] = [
  {
    label: 'My Account',
    items: [
      { id: 'profile', icon: User, label: 'My Profile', description: 'Your photo, username and email', tone: '#1D5BD6' },
      { id: 'security', icon: Lock, label: 'Password & Security', description: 'Password, two-step verification and devices', tone: '#4F46E5' },
    ],
  },
  {
    label: 'System',
    items: [
      { id: 'school-year', icon: CalendarDays, label: 'School Year', description: 'Set the active school year and semester', tone: '#0284C7' },
      { id: 'day-combinations', icon: CalendarRange, label: 'Day Combinations', description: 'Allowed class days (MWF, TTh…) for this semester', tone: '#1D5BD6' },
      { id: 'workload-limits', icon: Scale, label: 'Workload Limits', description: 'Regular load, overload limit and contractual hours', tone: '#0B4FA8' },
      { id: 'branding', icon: ImagePlus, label: 'System Logo', description: 'Upload the logo shown across the system', tone: '#12408F' },
      { id: 'appearance', icon: Palette, label: 'Appearance', description: 'Light or dark display', tone: '#7C3AED' },
    ],
  },
  {
    label: 'Maintenance',
    items: [
      { id: 'reset', icon: ShieldAlert, label: 'System Reset', description: 'Clear system data — cannot be undone', tone: '#DC2626' },
    ],
  },
];
const ALL_SECTIONS = SECTION_GROUPS.flatMap(g => g.items);
const EASE_S = [0.4, 0, 0.2, 1] as const;
const WHITE_TEXT = { color: '#FFFFFF' } as const;

function SectionBody({ id, onClose }: { id: SettingsSectionId; onClose: () => void }) {
  switch (id) {
    case 'profile':
      return (
        <div className="space-y-8">
          <div>
            <p className="text-sm font-bold text-[#0B2A5B] mb-3">Profile Picture</p>
            <AdminProfilePicture onSaved={onClose} />
          </div>
          <div className="border-t border-[#EEF2F8] pt-7">
            <p className="text-sm font-bold text-[#0B2A5B] mb-3">Account Details</p>
            <OwnProfileSettings />
          </div>
        </div>
      );
    case 'security': return <PasswordAndSecuritySection />;
    case 'school-year': return <SchoolYearSection />;
    case 'day-combinations': return <DayCombinationsSection />;
    case 'workload-limits': return <WorkloadLimitsSection />;
    case 'branding': return <LogoUploadContent />;
    case 'appearance': return <AppearanceSection />;
    case 'reset': return <SystemResetSection />;
  }
}

function SettingTile({ item, index, onOpen }: { item: SectionDef; index: number; onOpen: () => void }) {
  const reduceMotion = useReducedMotion();
  const Icon = item.icon;
  return (
    <motion.button
      type="button"
      onClick={onOpen}
      initial={reduceMotion ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0, transition: { duration: 0.4, ease: EASE_S, delay: index * 0.05 } }}
      whileHover={reduceMotion ? undefined : { y: -4, boxShadow: `0 18px 36px -18px ${item.tone}99` }}
      whileTap={reduceMotion ? undefined : { scale: 0.98 }}
      className="qr-stat-tint group relative overflow-hidden text-left rounded-2xl border p-5 flex items-center gap-4 min-h-[104px] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1D5BD6]/40"
      style={{ background: `linear-gradient(135deg, ${item.tone}1A 0%, #FFFFFF 70%)`, borderColor: `${item.tone}33` }}
    >
      {/* soft decorative circle */}
      <span aria-hidden className="absolute -right-8 -top-8 w-28 h-28 rounded-full" style={{ backgroundColor: `${item.tone}0F` }} />
      <span
        className="relative w-14 h-14 rounded-2xl flex items-center justify-center flex-shrink-0 shadow-[0_8px_18px_-8px_rgba(11,42,91,0.45)]"
        style={{ background: `linear-gradient(135deg, ${item.tone} 0%, #0B2A5B 140%)` }}
      >
        <Icon className="w-6 h-6" style={WHITE_TEXT} />
      </span>
      <span className="relative min-w-0 flex-1">
        <span className="block text-[17px] font-bold leading-tight" style={{ color: item.tone === '#DC2626' ? '#B91C1C' : '#0B2A5B' }}>{item.label}</span>
        <span className="block text-sm text-[#64748B] mt-1 leading-snug">{item.description}</span>
      </span>
      <ChevronRight className="relative w-5 h-5 flex-shrink-0 transition-transform duration-200 group-hover:translate-x-1" style={{ color: item.tone }} />
    </motion.button>
  );
}

/** Centred pop-up for one setting (portalled; banner + scrolling body) */
function SettingDialog({ section, onClose }: { section: SectionDef | null; onClose: () => void }) {
  const reduceMotion = useReducedMotion();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  useScrollLock(!!section);
  useEffect(() => {
    if (!section) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [section, onClose]);
  if (!mounted) return null;
  const Icon = section?.icon;

  return createPortal(
    <AnimatePresence>
      {section && (
        <motion.div
          key="setting-dialog"
          className="fixed inset-0 z-40 flex items-center justify-center p-3 sm:p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: { duration: 0.25, ease: EASE_S } }}
          exit={{ opacity: 0, transition: { duration: 0.2, ease: EASE_S } }}
        >
          <div className="absolute inset-0 bg-[#0B2A5B]/40 backdrop-blur-sm" onClick={onClose} aria-hidden />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="setting-dialog-title"
            initial={reduceMotion ? false : { opacity: 0, scale: 0.95, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0, transition: { duration: 0.35, ease: EASE_S } }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 10, transition: { duration: 0.2, ease: EASE_S } }}
            className="relative w-full max-w-3xl max-h-[90vh] flex flex-col rounded-3xl overflow-hidden bg-white shadow-[0_30px_70px_-25px_rgba(11,42,91,0.55)]"
          >
            {/* Gradient banner */}
            <header
              className="relative overflow-hidden flex-shrink-0 px-6 sm:px-8 py-6"
              style={{ background: `linear-gradient(120deg, ${section.tone} 0%, #0B2A5B 115%)` }}
            >
              <span aria-hidden className="absolute -right-14 -top-20 w-56 h-56 rounded-full bg-white/10" />
              <span aria-hidden className="absolute right-28 -bottom-24 w-44 h-44 rounded-full bg-white/[0.06]" />
              <div className="relative flex items-center gap-4">
                <span className="w-14 h-14 rounded-2xl bg-white/15 ring-1 ring-white/25 flex items-center justify-center flex-shrink-0">
                  {Icon && <Icon className="w-7 h-7" style={WHITE_TEXT} />}
                </span>
                <div className="min-w-0 flex-1">
                  <h2 id="setting-dialog-title" className="text-2xl font-bold leading-tight" style={WHITE_TEXT}>{section.label}</h2>
                  <p className="text-[15px] mt-1" style={{ color: 'rgba(255,255,255,0.8)' }}>{section.description}</p>
                </div>
                <motion.button
                  type="button"
                  onClick={onClose}
                  whileTap={reduceMotion ? undefined : { scale: 0.95 }}
                  aria-label="Close"
                  className="self-start inline-flex items-center gap-1.5 h-10 px-3.5 rounded-full bg-white/15 hover:bg-white/25 text-[15px] font-semibold transition-colors flex-shrink-0"
                  style={WHITE_TEXT}
                >
                  <X className="w-5 h-5" style={WHITE_TEXT} /> Close
                </motion.button>
              </div>
            </header>
            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-6 sm:px-8 py-7">
              <SectionBody id={section.id} onClose={onClose} />
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/* ── Main Settings Page ─────────────────────────────────────────── */
export default function SettingsPage() {
  const reduceMotion = useReducedMotion();
  const [active, setActive] = useState<SettingsSectionId | null>(null); // nothing open until a tile is clicked
  const [booting, setBooting] = useState(true);
  useEffect(() => { setBooting(false); }, []);
  const showSkeleton = useMinLoading(booting, LOADING_DELAY);
  const current = active ? ALL_SECTIONS.find(s => s.id === active)! : null;

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto w-full min-w-0">
      <BackButton />
      <div className="mt-4 sm:mt-7 mb-6">
        <WatermarkTitle>Settings</WatermarkTitle>
      </div>

      <PageLoadTransition showSkeleton={showSkeleton} skeleton={<FormSkeleton fields={8} />}>
        <motion.div
          initial={reduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1, transition: { duration: 0.3, ease: EASE_S } }}
          className="space-y-7"
        >
          {SECTION_GROUPS.map((group, gi) => (
            <section key={group.label}>
              <p className="px-1 mb-3 text-xs font-bold uppercase tracking-[0.14em] text-[#64748B]">{group.label}</p>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {group.items.map((item, i) => (
                  <SettingTile key={item.id} item={item} index={gi * 2 + i} onOpen={() => setActive(item.id)} />
                ))}
              </div>
            </section>
          ))}
        </motion.div>
      </PageLoadTransition>

      <SettingDialog section={current} onClose={closeDialog} />
    </div>
  );

  function closeDialog() { setActive(null); }
}

'use client';

import { useEffect, useRef, useState } from 'react';
import { useToast } from '@/client/context/ToastContext';
import { useScrollLock } from '@/client/hooks/useScrollLock';
import ImageCropDialog from '@/client/components/ui/ImageCropDialog';
import { useSystemLogo } from '@/client/hooks/useSystemLogo';
import { PageLoadTransition } from '@/client/components/ui/PageLoadTransition';
import { FormSkeleton } from '@/client/components/ui/skeletons';
import { LOADING_DELAY, useMinLoading } from '@/client/hooks/useMinLoading';
import {
  CheckCircle, ImagePlus, Trash2, Upload, AlertTriangle, X,
  ChevronDown, Palette, Sun, Moon,
  CalendarDays, ShieldAlert, Eye, EyeOff, RotateCcw, Plus,
  KeyRound, ShieldCheck, Smartphone, Camera, Lock, ChevronRight, User,
} from 'lucide-react';
import { ProfilePictureUpload } from '@/client/components/ui/ProfilePictureUpload';
import TrustedDevicesPanel from '@/client/components/security/TrustedDevicesPanel';
import OtpPreferencePanel from '@/client/components/security/OtpPreferencePanel';

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
      setSuccess('Logo updated successfully.');
      toast.success('Logo updated successfully.');
      window.dispatchEvent(new CustomEvent('system-logo-changed', { detail: { logoUrl: data.logoUrl } }));
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
    <div>
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
              <div className="absolute top-1 right-1 bg-[#3C91E6] rounded-full px-1.5 py-0.5 text-[10px] font-bold text-white leading-none">
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
                  className="flex items-center gap-2 bg-[#3C91E6] hover:bg-[#2563EB] disabled:opacity-50 text-white px-4 py-2.5 rounded-xl text-sm font-medium transition-colors shadow-sm"
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
                className="flex items-center gap-2 bg-[#EFF6FF] hover:bg-[#DBEAFE] border border-[#BFDBFE] text-[#3C91E6] px-4 py-2.5 rounded-xl text-sm font-medium transition-colors w-full sm:w-auto"
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
            <p className="text-sm font-semibold text-[#1E3A5F]">Dark Mode</p>
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
          className={`relative inline-flex h-7 w-12 flex-shrink-0 items-center rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-[#3C91E6] focus:ring-offset-2 ${
            isDark
              ? 'bg-[#3C91E6] focus:ring-offset-[#111827]'
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
      className={`w-full border rounded-xl px-3.5 py-2.5 text-sm text-[#1E3A5F] placeholder-[#CBD5E1]
        focus:outline-none focus:ring-2 focus:ring-[#3C91E6] focus:border-[#3C91E6]
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
function AdminProfilePicture() {
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
        <div className="w-5 h-5 border-2 border-[#E2E8F0] border-t-[#3C91E6] rounded-full animate-spin" />
      </div>
    );
  }

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

  if (loading) return (
    <div className="flex items-center justify-center py-6">
      <div className="w-5 h-5 border-2 border-[#E2E8F0] border-t-[#3C91E6] rounded-full animate-spin" />
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
            Role: <span className="font-medium text-[#64748B] capitalize">{user.role.replace(/_/g, ' ')}</span>
          </p>
        )}
        {dirty && (
          <button
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold bg-[#3C91E6] hover:bg-[#2563EB] disabled:opacity-50 text-white shadow-sm transition-all flex-shrink-0"
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
      <button onClick={changePassword} disabled={saving || !form.current || !form.next || !form.confirm} className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold bg-[#3C91E6] hover:bg-[#2563EB] disabled:opacity-50 text-white shadow-sm transition-all">
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
        <Icon className="w-4 h-4 text-[#3C91E6]" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-[#1E3A5F]">{title}</p>
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
        className={`relative w-full ${wide ? 'max-w-lg' : 'max-w-md'} rounded-2xl border border-[#E2E8F0] bg-white shadow-xl max-h-[90vh] overflow-y-auto`}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-[#E2E8F0] sticky top-0 bg-white z-10">
          <h2 className="text-base font-bold text-[#1E3A5F]">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-[#94A3B8] hover:text-[#1E3A5F] hover:bg-[#F8FAFC] transition-colors"
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

function SchoolYearSection() {
  const toast = useToast();
  const [years,    setYears]    = useState<SchoolYear[]>([]);
  const [semester, setSemester] = useState('1st Semester');
  const [newLabel, setNewLabel] = useState('');
  const [savedSemester, setSavedSemester] = useState('1st Semester');
  const [loading,  setLoading]  = useState(true);
  const [creating, setCreating] = useState(false);
  const [saving,   setSaving]   = useState(false);
  const [actionId, setActionId] = useState<number | null>(null);
  const [addError, setAddError] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch('/api/school-years');
      if (!res.ok) return;
      const data = await res.json();
      setYears(data.years ?? []);
      const sem = data.currentSemester ?? '1st Semester';
      setSemester(sem);
      setSavedSemester(sem);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

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

  async function saveSemester() {
    setSaving(true);
    try {
      const res = await fetch('/api/settings/school-year', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ semester }),
      });
      if (!res.ok) { toast.error('Failed to save semester.'); return; }
      setSavedSemester(semester);
      const active = years.find(y => y.status === 'Active');
      window.dispatchEvent(new CustomEvent('school-year-changed', {
        detail: { schoolYear: active?.label ?? '', semester },
      }));
      toast.success('Default semester updated.');
    } catch { toast.error('Connection error.'); }
    finally { setSaving(false); }
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
        <div className="w-6 h-6 border-2 border-[#E2E8F0] border-t-[#3C91E6] rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">

      {/* ── Active Period Summary ── */}
      {activeYear && (
        <div className="flex items-center gap-3.5 px-4 py-3.5 bg-[#EFF6FF] border border-[#BFDBFE] rounded-2xl">
          <div className="w-9 h-9 rounded-xl bg-[#3C91E6] flex items-center justify-center flex-shrink-0 shadow-sm">
            <CalendarDays className="w-4 h-4 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-widest text-[#64748B]">Active Period</p>
            <p className="text-sm font-bold text-[#1E3A5F] mt-0.5 leading-tight">
              {activeYear.label}
              <span className="font-normal text-[#64748B] ml-2">· {semester}</span>
            </p>
          </div>
          <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-1 rounded-full bg-[#DCFCE7] text-[#16A34A] flex-shrink-0 tracking-wide">
            <span className="w-1.5 h-1.5 rounded-full bg-[#22C55E] inline-block" />
            Active
          </span>
        </div>
      )}

      {/* ── Default Semester ── */}
      <div className="rounded-2xl border border-[#E2E8F0] bg-white shadow-sm overflow-hidden">
        <div className="px-5 py-3.5 border-b border-[#F1F5F9]">
          <p className="text-sm font-semibold text-[#1E3A5F]">Default Semester</p>
          <p className="text-xs text-[#94A3B8] mt-0.5">
            Applied across all modules when no semester is explicitly selected.
          </p>
        </div>
        <div className="px-5 py-4 flex items-center gap-3">
          <select
            value={semester}
            onChange={e => setSemester(e.target.value)}
            className="flex-1 border border-[#CBD5E1] rounded-xl px-3.5 py-2.5 text-sm text-[#1E3A5F] bg-white appearance-none focus:outline-none focus:ring-2 focus:ring-[#3C91E6] focus:border-[#3C91E6] transition-all duration-150 cursor-pointer"
          >
            {SEMESTERS_LIST.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          {semester !== savedSemester ? (
            <button
              onClick={saveSemester}
              disabled={saving}
              style={{ color: saving ? '#94A3B8' : '#ffffff' }}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white bg-[#3C91E6] hover:bg-[#2563EB] transition-all duration-150 flex-shrink-0 shadow-sm disabled:bg-[#CBD5E1] disabled:shadow-none disabled:cursor-not-allowed"
            >
              {saving
                ? <><Spinner />Saving…</>
                : <><CheckCircle className="w-4 h-4" />Save</>}
            </button>
          ) : (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-[#DCFCE7] text-[#16A34A] flex-shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-[#22C55E] inline-block" />
              Active
            </span>
          )}
        </div>
      </div>

      {/* ── School Years List ── */}
      <div className="rounded-2xl border border-[#E2E8F0] bg-white shadow-sm overflow-hidden">

        {/* Header */}
        <div className="px-5 py-3.5 border-b border-[#F1F5F9] flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-[#1E3A5F]">School Years</p>
            <p className="text-xs text-[#94A3B8] mt-0.5">Only one school year can be active at a time.</p>
          </div>
          <button
            type="button"
            onClick={generateNext}
            disabled={creating || years.some(y => y.label === next)}
            title={`Create ${next}`}
            className="inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold text-white bg-[#3C91E6] hover:bg-[#2563EB] transition-colors duration-150 flex-shrink-0 self-start sm:self-auto disabled:bg-[#CBD5E1] disabled:text-white/80 disabled:cursor-not-allowed"
          >
            {creating && <Spinner />}
            Generate {next}
          </button>
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
                      isActive ? 'text-[#1E3A5F]' : 'text-[#64748B]'
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
                        <button
                          type="button"
                          onClick={() => doAction(yr.id, 'archive')}
                          disabled={anyBusy}
                          className="inline-flex items-center justify-center gap-1.5 min-h-[30px] px-3 py-1.5 rounded-lg text-xs font-medium transition-colors duration-150
                            text-[#64748B] border border-[#E2E8F0] bg-white
                            hover:text-[#1E3A5F] hover:border-[#CBD5E1] hover:bg-[#F8FAFC]
                            disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {isLoading && <Spinner cls="border-[#E2E8F0] border-t-[#94A3B8]" />}
                          Archive
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => doAction(yr.id, 'activate')}
                            disabled={anyBusy}
                            style={{ color: (isLoading || anyBusy) ? '#94A3B8' : '#ffffff' }}
                            className="inline-flex items-center justify-center gap-1.5 min-h-[30px] px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-[#3C91E6] hover:bg-[#2563EB] transition-colors duration-150 disabled:bg-[#CBD5E1] disabled:cursor-not-allowed"
                          >
                            {isLoading && <Spinner />}
                            Set Active
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(yr.id)}
                            disabled={anyBusy}
                            title="Delete school year"
                            aria-label={`Delete ${yr.label}`}
                            className="inline-flex items-center justify-center w-7 h-7 rounded-lg text-[#94A3B8] border border-[#E2E8F0] bg-white
                              hover:text-red-600 hover:border-red-200 hover:bg-red-50
                              transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            {isDeleting
                              ? <Spinner cls="border-[#E2E8F0] border-t-red-400" />
                              : <Trash2 className="w-3.5 h-3.5" />}
                          </button>
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
                          <button
                            type="button"
                            onClick={() => deleteYear(yr.id)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-600 text-white hover:bg-red-700 transition-colors"
                          >
                            <Trash2 className="w-3 h-3" /> Yes, Delete
                          </button>
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
          <p className="text-sm font-semibold text-[#1E3A5F]">Add School Year</p>
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
                className={`w-full border rounded-xl px-3.5 py-2.5 text-sm text-[#1E3A5F] placeholder-[#CBD5E1]
                  focus:outline-none focus:ring-2 focus:ring-[#3C91E6] focus:border-[#3C91E6] transition-all duration-150 ${
                  addError ? 'border-red-300 bg-red-50' : 'border-[#CBD5E1] bg-white'
                }`}
              />
            </div>
            <button
              onClick={() => addYear(newLabel)}
              disabled={creating || !newLabel.trim()}
              style={{ color: (creating || !newLabel.trim()) ? '#94A3B8' : '#ffffff' }}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white bg-[#3C91E6] hover:bg-[#2563EB] transition-all duration-150 flex-shrink-0 shadow-sm disabled:bg-[#CBD5E1] disabled:shadow-none disabled:cursor-not-allowed"
            >
              {creating
                ? <><Spinner />Adding…</>
                : <><Plus className="w-4 h-4" />Add Year</>}
            </button>
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
          <p className="font-semibold text-[#1E3A5F]">Reset Complete</p>
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
          <li>All instructor workload assignments</li>
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
            className={`w-full bg-[#F8FAFC] border rounded-xl px-3 py-2.5 pr-10 text-sm text-[#1E3A5F] focus:outline-none focus:ring-2 focus:ring-[#3C91E6] focus:border-transparent transition-colors ${
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
                <h2 className="font-bold text-[#1E3A5F] text-base">Confirm System Reset</h2>
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

/* ── Accordion (Instructor-style structure, Admin light theme) ───── */
type SettingsSectionId =
  | 'branding'
  | 'school-year'
  | 'appearance'
  | 'picture'
  | 'account'
  | 'security'
  | 'reset';

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
    <div className="bg-white rounded-2xl border border-[#E2E8F0] overflow-hidden transition-all duration-200 shadow-sm min-w-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full flex items-center gap-4 px-6 py-5 text-left hover:bg-[#F8FAFC] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#3C91E6] focus-visible:ring-inset"
      >
        <div className="flex-shrink-0 w-11 h-11 bg-[#EFF6FF] rounded-xl flex items-center justify-center">
          <Icon className="w-5 h-5 text-[#3C91E6]" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[15px] font-bold text-[#1E3A5F] leading-tight">{title}</p>
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

/* ── Main Settings Page ─────────────────────────────────────────── */
export default function SettingsPage() {
  const [openSection, setOpenSection] = useState<SettingsSectionId | null>(null);
  const [booting, setBooting] = useState(true);
  useEffect(() => { setBooting(false); }, []);
  const showSkeleton = useMinLoading(booting, LOADING_DELAY);

  function toggle(id: SettingsSectionId) {
    setOpenSection(prev => (prev === id ? null : id));
  }

  return (
    <div className="min-h-screen bg-[#F8FAFC] p-5 md:p-7 lg:p-8">
      <div className="max-w-6xl">
        <div className="mb-7">
          <h1 className="text-2xl font-bold text-[#1E3A5F]">Settings</h1>
          <p className="text-[#64748B] text-sm mt-1">
            Manage your system and account preferences.
          </p>
        </div>

        <PageLoadTransition
          showSkeleton={showSkeleton}
          skeleton={<FormSkeleton fields={8} />}
        >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-8 items-start">
          <section className="space-y-3 min-w-0">
            <CategoryLabel>System Settings</CategoryLabel>
            <AccordionCard
              icon={ImagePlus}
              title="System Branding"
              subtitle="Upload and manage the system logo"
              open={openSection === 'branding'}
              onToggle={() => toggle('branding')}
            >
              <LogoUploadContent />
            </AccordionCard>
            <AccordionCard
              icon={CalendarDays}
              title="School Year Management"
              subtitle="Manage school year and semester"
              open={openSection === 'school-year'}
              onToggle={() => toggle('school-year')}
            >
              <SchoolYearSection />
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
            <div className="pt-5 space-y-3">
              <CategoryLabel>Administration</CategoryLabel>
              <AccordionCard
                icon={ShieldAlert}
                title="System Reset"
                subtitle="Administrative system reset"
                open={openSection === 'reset'}
                onToggle={() => toggle('reset')}
              >
                <SystemResetSection />
              </AccordionCard>
            </div>
          </section>

          <section className="space-y-3 min-w-0">
            <CategoryLabel>Account &amp; Security</CategoryLabel>
            <AccordionCard
              icon={Camera}
              title="Profile Picture"
              subtitle="Upload and manage your profile photo"
              open={openSection === 'picture'}
              onToggle={() => toggle('picture')}
            >
              <AdminProfilePicture />
            </AccordionCard>
            <AccordionCard
              icon={User}
              title="Account Details"
              subtitle="Username, email, and role"
              open={openSection === 'account'}
              onToggle={() => toggle('account')}
            >
              <OwnProfileSettings />
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

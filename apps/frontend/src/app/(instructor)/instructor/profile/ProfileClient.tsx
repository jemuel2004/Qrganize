'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import Script from 'next/script';
import {
  Camera, Lock, Palette, Eye, EyeOff, ShieldCheck,
  Check, X, MonitorSmartphone, Sun, Moon,
  Loader2, CheckCircle, AlertCircle, ChevronRight,
  KeyRound,
} from 'lucide-react';
import { useInstructorProfile } from '@/context/InstructorProfileContext';
import { useScrollLock } from '@/hooks/useScrollLock';
import BackButton from '@/components/ui/BackButton';
import WatermarkTitle from '@/components/ui/WatermarkTitle';
import { useInstructorTheme, type InstructorTheme } from '@/context/InstructorThemeContext';
import { ProfilePictureUpload } from '@/components/ui/ProfilePictureUpload';
import TrustedDevicesPanel from '@/components/security/TrustedDevicesPanel';
import OtpPreferencePanel from '@/components/security/OtpPreferencePanel';
import { PageLoadTransition } from '@/components/ui/PageLoadTransition';
import { FormSkeleton } from '@/components/ui/skeletons';
import { LOADING_DELAY, useMinLoading } from '@/hooks/useMinLoading';

/* ── Types ─────────────────────────────────────────────────────── */
type Section = 'picture' | 'security' | 'appearance' | 'google';
type SecurityModal = null | 'password' | 'devices';

/* ── Password helpers ──────────────────────────────────────────── */
function getStrength(pw: string) {
  if (!pw) return { score: 0, label: '', textColor: '', barColor: '' };
  let score = 0;
  if (pw.length >= 8)            score++;
  if (pw.length >= 12)           score++;
  if (/[A-Z]/.test(pw))         score++;
  if (/[0-9]/.test(pw))         score++;
  if (/[^A-Za-z0-9]/.test(pw))  score++;

  if (score <= 1) return { score, label: 'Weak',   textColor: 'text-red-400',     barColor: 'bg-red-500'     };
  if (score === 2) return { score, label: 'Fair',   textColor: 'text-amber-400',   barColor: 'bg-amber-500'   };
  if (score === 3) return { score, label: 'Good',   textColor: 'text-yellow-400',  barColor: 'bg-yellow-400'  };
  return              { score, label: 'Strong', textColor: 'text-emerald-400', barColor: 'bg-emerald-500' };
}

function canSubmitPw(current: string, newPw: string, confirm: string) {
  return current.trim().length > 0 && newPw.length >= 8 && newPw === confirm && getStrength(newPw).score >= 2 && current !== newPw;
}

/* ── Accordion wrapper ─────────────────────────────────────────── */
/** Colour per setting (tile + pop-up banner) */
const SECTION_TONE: Record<Section, string> = {
  picture: '#1D5BD6', appearance: '#7C3AED', security: '#4F46E5', google: '#0284C7',
};
const WHITE = { color: '#FFFFFF' } as const;
const EASE_P = [0.4, 0, 0.2, 1] as const;
/** Pop-up headers are solid royal blue, like every other window in QRganize */
const HEADER_BG = { backgroundColor: '#1D5BD6' } as const;

/** Phones: once the keyboard has opened, scroll the tapped field into the middle of the window */
function revealFocused(e: React.FocusEvent) {
  const el = e.target as HTMLElement;
  if (!el.matches?.('input:not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea, select')) return;
  window.setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300);
}

/**
 * A setting = a big colour tile; clicking it opens the setting in its own
 * centred pop-up (no long scrolling page). Close / Esc / backdrop closes it.
 */
function AccordionCard({
  id, icon: Icon, title, subtitle, open, onToggle, children,
}: {
  id: Section;
  icon: React.ElementType;
  title: string;
  subtitle: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  const tone = SECTION_TONE[id];
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  useScrollLock(open);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // leave Esc to a nested window (e.g. Change Password) when one is open
      if (e.key === 'Escape' && document.querySelectorAll('[data-modal-root]').length === 0) onToggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onToggle]);

  return (
    <>
      <motion.button
        type="button"
        onClick={onToggle}
        whileHover={reduceMotion ? undefined : { y: -4, boxShadow: `0 18px 36px -18px ${tone}99` }}
        whileTap={reduceMotion ? undefined : { scale: 0.98 }}
        className="qr-stat-tint group relative overflow-hidden text-left rounded-2xl border p-5 flex items-center gap-4 min-h-[104px] w-full"
        style={{ background: `linear-gradient(135deg, ${tone}1A 0%, #FFFFFF 70%)`, borderColor: `${tone}33` }}
      >
        <span aria-hidden className="absolute -right-8 -top-8 w-28 h-28 rounded-full" style={{ backgroundColor: `${tone}0F` }} />
        <span className="relative w-14 h-14 rounded-2xl flex items-center justify-center flex-shrink-0 shadow-[0_8px_18px_-8px_rgba(11,42,91,0.45)]"
          style={{ background: `linear-gradient(135deg, ${tone} 0%, #0B2A5B 140%)` }}>
          <Icon className="w-6 h-6" style={WHITE} />
        </span>
        <span className="relative min-w-0 flex-1">
          <span className="block text-[17px] font-bold leading-tight text-[#0B2A5B]">{title}</span>
          <span className="block text-sm text-[#64748B] mt-1 leading-snug">{subtitle}</span>
        </span>
        <ChevronRight className="relative w-5 h-5 flex-shrink-0 transition-transform duration-200 group-hover:translate-x-1" style={{ color: tone }} />
      </motion.button>

      {mounted && createPortal(
        <AnimatePresence>
          {open && (
            /* A centred window on every screen — it fits inside the visible screen and scrolls inside */
            <motion.div key={`setting-${id}`} className="fixed inset-0 z-40 flex items-center justify-center p-3 sm:p-6"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduceMotion ? 0 : 0.25 }}>
              <div className="absolute inset-0 bg-[#0B2A5B]/45 backdrop-blur-sm" onClick={onToggle} aria-hidden />
              <motion.div role="dialog" aria-modal="true" aria-label={title}
                initial={reduceMotion ? false : { opacity: 0, scale: 0.96, y: 12 }}
                animate={{ opacity: 1, scale: 1, y: 0, transition: { type: 'spring', stiffness: 360, damping: 30 } }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 8, transition: { duration: 0.18, ease: EASE_P } }}
                className="relative w-full max-w-lg sm:max-w-2xl max-h-[calc(100dvh-1.5rem)] sm:max-h-[min(90dvh,860px)] flex flex-col rounded-2xl sm:rounded-3xl overflow-hidden bg-white shadow-[0_30px_70px_-25px_rgba(11,42,91,0.6)]">
                <header className="flex-shrink-0 px-4 py-3.5 sm:px-6 sm:py-5" style={HEADER_BG}>
                  <div className="flex items-center gap-3 sm:gap-4">
                    <span className="w-10 h-10 sm:w-12 sm:h-12 rounded-xl sm:rounded-2xl bg-white/15 ring-1 ring-white/25 flex items-center justify-center flex-shrink-0">
                      <Icon className="w-5 h-5 sm:w-6 sm:h-6" style={WHITE} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <h2 className="text-lg sm:text-xl font-bold leading-tight truncate" style={WHITE}>{title}</h2>
                      <p className="text-[13px] sm:text-sm mt-0.5 leading-snug" style={{ color: 'rgba(255,255,255,0.85)' }}>{subtitle}</p>
                    </div>
                    <button type="button" onClick={onToggle} aria-label="Close"
                      className="inline-flex items-center justify-center gap-1.5 h-10 min-w-10 sm:px-3.5 rounded-full bg-white/15 hover:bg-white/25 text-[15px] font-semibold transition-colors flex-shrink-0" style={WHITE}>
                      <X className="w-5 h-5" /> <span className="hidden sm:inline">Close</span>
                    </button>
                  </div>
                </header>
                <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain" onFocusCapture={revealFocused}>{children}</div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}

function SecurityRow({
  icon: Icon,
  title,
  description,
  onClick,
  disabled,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="w-full flex items-center gap-4 px-4 py-3.5 text-left rounded-xl hover:bg-white/[0.04] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-[#12408F]/15 flex items-center justify-center">
        <Icon className="w-4 h-4 text-[#12408F]" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-white">{title}</p>
        <p className="text-[12px] text-slate-400 mt-0.5">{description}</p>
      </div>
      <ChevronRight className="w-4 h-4 text-slate-500 flex-shrink-0" />
    </button>
  );
}

function ModalShell({
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4" data-modal-root>
      <button
        type="button"
        className="absolute inset-0 bg-black/55"
        aria-label="Close"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`relative w-full ${wide ? 'max-w-lg' : 'max-w-md'} rounded-2xl overflow-hidden border border-white/10 bg-[#111827] shadow-xl max-h-[calc(100dvh-1.5rem)] sm:max-h-[90dvh] flex flex-col`}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-4 flex-shrink-0" style={HEADER_BG}>
          <h2 className="text-base font-bold" style={{ color: '#FFFFFF' }}>{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="w-10 h-10 inline-flex items-center justify-center rounded-full bg-white/15 hover:bg-white/25 transition-colors"
            style={{ color: '#FFFFFF' }}
            aria-label="Close dialog"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="px-5 py-5 flex-1 min-h-0 overflow-y-auto overscroll-contain" onFocusCapture={revealFocused}>{children}</div>
      </div>
    </div>
  );
}

function PwField({
  label, value, onChange, visible, onToggle, placeholder, autoComplete,
}: {
  label: string; value: string; onChange: (v: string) => void;
  visible: boolean; onToggle: () => void; placeholder?: string; autoComplete?: string;
}) {
  return (
    <div>
      <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-[0.14em] mb-2">
        {label}
      </label>
      <div className="relative">
        <input
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 pr-12 text-sm text-white placeholder:text-slate-600 focus:border-[#12408F] focus:outline-none transition-colors"
        />
        <button
          type="button"
          onClick={onToggle}
          className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-slate-500 hover:text-slate-300 transition-colors"
          aria-label={visible ? 'Hide password' : 'Show password'}
        >
          {visible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
}

function StrengthBar({ password }: { password: string }) {
  const { score, label, textColor, barColor } = getStrength(password);
  if (!password) return null;
  return (
    <div className="mt-2.5">
      <div className="flex gap-1 mb-1.5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className={`h-1.5 flex-1 rounded-full transition-all duration-300 ${i < score ? barColor : 'bg-white/10'}`} />
        ))}
      </div>
      {label && <span className={`text-[11px] font-bold ${textColor}`}>{label}</span>}
    </div>
  );
}

/* ── Theme card mini preview ───────────────────────────────────── */
function ThemePreviewMini({ dark }: { dark: boolean }) {
  const bg    = dark ? '#0f172a' : '#F8FAFC';
  const card  = dark ? '#111827' : '#FFFFFF';
  const line  = dark ? '#1e293b' : '#E2E8F0';
  const line2 = dark ? '#1a2742' : '#F1F5F9';
  return (
    <div style={{ background: bg, display: 'flex', height: '100%', overflow: 'hidden' }}>
      <div style={{ width: 20, background: '#12408F', flexShrink: 0, padding: '6px 3px', display: 'flex', flexDirection: 'column', gap: 3 }}>
        <div style={{ width: 14, height: 14, background: 'rgba(255,255,255,0.25)', borderRadius: 3 }} />
        {[0,1,2].map(i => <div key={i} style={{ width: 14, height: 4, background: 'rgba(255,255,255,0.18)', borderRadius: 2 }} />)}
      </div>
      <div style={{ flex: 1, padding: '5px 5px 5px 4px', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ height: 7, background: card, borderRadius: 3 }} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 2 }}>
          {[0,1,2].map(i => (
            <div key={i} style={{ height: 18, background: card, borderRadius: 3, padding: '3px 3px' }}>
              <div style={{ width: '60%', height: 2.5, background: '#12408F', borderRadius: 1.5, opacity: 0.55 }} />
              <div style={{ width: '40%', height: 4, background: line, borderRadius: 1.5, marginTop: 3 }} />
            </div>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 3, flex: 1 }}>
          <div style={{ background: card, borderRadius: 3, padding: 3 }}>
            <div style={{ width: '75%', height: 2.5, background: line, borderRadius: 1, marginBottom: 3 }} />
            <div style={{ width: '55%', height: 2.5, background: line2, borderRadius: 1 }} />
          </div>
          <div style={{ background: card, borderRadius: 3, padding: 3 }}>
            <div style={{ width: '70%', height: 2.5, background: line, borderRadius: 1, marginBottom: 3 }} />
            <div style={{ width: '50%', height: 2.5, background: line2, borderRadius: 1 }} />
          </div>
        </div>
      </div>
    </div>
  );
}

function ThemeCard({ id, label, desc, selected, onClick }: {
  id: InstructorTheme; label: string; desc: string; selected: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative flex flex-col gap-3 p-3 rounded-xl border-2 text-left transition-all duration-200 ${
        selected
          ? 'border-[#12408F] bg-[#12408F]/10'
          : 'border-white/10 bg-white/5 hover:border-white/25 hover:bg-white/[0.08]'
      }`}
    >
      <div className="w-full overflow-hidden rounded-lg border border-white/10" style={{ height: 76 }}>
        {id === 'system' ? (
          <div style={{ display: 'flex', height: '100%' }}>
            <div style={{ width: '50%', overflow: 'hidden' }}><ThemePreviewMini dark={false} /></div>
            <div style={{ width: 1, background: 'rgba(120,120,120,0.25)', flexShrink: 0 }} />
            <div style={{ width: '50%', overflow: 'hidden' }}><ThemePreviewMini dark={true} /></div>
          </div>
        ) : (
          <ThemePreviewMini dark={id === 'dark'} />
        )}
      </div>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-bold text-white leading-tight">{label}</p>
          <p className="text-[11px] text-slate-400 mt-0.5">{desc}</p>
        </div>
        {selected && (
          <div className="flex-shrink-0 w-5 h-5 bg-[#12408F] rounded-full flex items-center justify-center">
            <Check className="w-3 h-3 text-white" />
          </div>
        )}
      </div>
    </button>
  );
}

/* ── Main component ────────────────────────────────────────────── */
export default function ProfileClient() {
  const { name, picUrl: contextPicUrl, hasCustomPhoto, updatePicUrl } = useInstructorProfile();
  const { theme, setTheme, saving: themeSaving } = useInstructorTheme();

  const [openSection, setOpenSection] = useState<Section | null>(null); // nothing open until a tile is clicked
  const [booting, setBooting] = useState(true);
  useEffect(() => { setBooting(false); }, []);
  const showSkeleton = useMinLoading(booting, LOADING_DELAY);

  function toggle(id: Section) {
    setOpenSection(prev => (prev === id ? null : id));
  }

  const [localPicUrl, setLocalPicUrl] = useState<string | null>(null);
  const [hasCustom, setHasCustom] = useState(false);
  useEffect(() => { setLocalPicUrl(contextPicUrl); }, [contextPicUrl]);
  useEffect(() => { setHasCustom(hasCustomPhoto); }, [hasCustomPhoto]);

  function handlePicSuccess(url: string) {
    setLocalPicUrl(url);
    setHasCustom(true);
    updatePicUrl(url, { custom: true });
  }
  function handlePicRemove(nextUrl?: string | null) {
    setLocalPicUrl(nextUrl ?? null);
    setHasCustom(false);
    updatePicUrl(nextUrl ?? null, { custom: false });
  }

  /* Security modals */
  const [securityModal, setSecurityModal] = useState<SecurityModal>(null);

  const [pwForm, setPwForm] = useState({ current: '', newPw: '', confirm: '' });
  const [pwVisible, setPwVisible] = useState({ current: false, newPw: false, confirm: false });
  const [pwLoading, setPwLoading] = useState(false);
  const [pwError, setPwError] = useState('');
  const [pwSuccess, setPwSuccess] = useState('');
  const [logoutOthers, setLogoutOthers] = useState(true);

  const googleBtnRef = useRef<HTMLDivElement>(null);
  const changeGoogleBtnRef = useRef<HTMLDivElement>(null);
  const [accountEmail, setAccountEmail] = useState('');
  const [googleVerified, setGoogleVerified] = useState(false);
  const [googleError, setGoogleError] = useState('');
  const [googleBusy, setGoogleBusy] = useState(false);
  const [gisReady, setGisReady] = useState(false);
  const [showChangeGoogle, setShowChangeGoogle] = useState(false);

  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!d?.user) return;
        setAccountEmail(d.user.email ?? '');
        setGoogleVerified(d.user.google_verified === true);
        if (d.user.profile_picture) setLocalPicUrl(d.user.profile_picture);
        setHasCustom(d.user.has_custom_profile_picture === true);
      })
      .catch(() => {});
  }, []);

  const applyGoogleResult = useCallback((data: {
    email?: string;
    picture_url?: string | null;
    has_custom_profile_picture?: boolean;
  }) => {
    setGoogleVerified(true);
    setShowChangeGoogle(false);
    if (data.email) setAccountEmail(data.email);
    if (typeof data.has_custom_profile_picture === 'boolean') {
      setHasCustom(data.has_custom_profile_picture);
    }
    if (data.picture_url) {
      setLocalPicUrl(data.picture_url);
      updatePicUrl(data.picture_url, { custom: data.has_custom_profile_picture === true });
      window.dispatchEvent(new CustomEvent('profile-picture-changed', {
        detail: {
          picUrl: data.picture_url,
          hasCustom: data.has_custom_profile_picture === true,
        },
      }));
    }
  }, [updatePicUrl]);

  const handleGoogleCredential = useCallback(async (response: GoogleCredentialResponse) => {
    setGoogleError('');
    setGoogleBusy(true);
    try {
      const res = await fetch('/api/instructor/verify-google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential: response.credential }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setGoogleError(data.error || 'Google verification failed.');
        return;
      }
      applyGoogleResult(data);
    } catch {
      setGoogleError('Unable to reach the server. Please try again.');
    } finally {
      setGoogleBusy(false);
    }
  }, [applyGoogleResult]);

  useEffect(() => {
    const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
    if (!gisReady || openSection !== 'google') return;
    if (!clientId || !window.google?.accounts?.id) return;

    const target = !googleVerified
      ? googleBtnRef.current
      : showChangeGoogle
        ? changeGoogleBtnRef.current
        : null;
    if (!target) return;

    target.innerHTML = '';
    // As wide as its space (Google allows 200–400 px) — on a phone it fills the window
    const width = Math.round(Math.min(400, Math.max(200, target.clientWidth || 280)));
    window.google.accounts.id.initialize({
      client_id: clientId,
      callback: handleGoogleCredential,
      auto_select: false,
      cancel_on_tap_outside: true,
    });
    window.google.accounts.id.renderButton(target, {
      type: 'standard',
      theme: 'filled_blue',
      size: 'large',
      text: 'continue_with',
      width,
    });
  }, [gisReady, googleVerified, showChangeGoogle, openSection, handleGoogleCredential]);

  async function startChangePassword() {
    setPwSuccess('');
    setPwError('');
    setPwForm({ current: '', newPw: '', confirm: '' });
    setLogoutOthers(true);
    setSecurityModal('password');
  }

  async function closeSecurityModal() {
    setSecurityModal(null);
    setPwError('');
  }

  const toggleVis = useCallback((field: keyof typeof pwVisible) => {
    setPwVisible(v => ({ ...v, [field]: !v[field] }));
  }, []);

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPwError('');
    if (!canSubmitPw(pwForm.current, pwForm.newPw, pwForm.confirm)) return;
    setPwLoading(true);
    try {
      const res = await fetch('/api/instructor/profile/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          current_password: pwForm.current,
          new_password: pwForm.newPw,
          confirm_password: pwForm.confirm,
          logout_other_devices: logoutOthers,
        }),
      });
      const ct = res.headers.get('content-type') ?? '';
      if (!ct.includes('application/json')) {
        setPwError('A server error occurred. Please try again.');
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        setPwError(data.error || 'Failed to update password.');
        return;
      }
      if (data.reauth) {
        window.location.href = '/login';
        return;
      }
      setSecurityModal(null);
      setPwForm({ current: '', newPw: '', confirm: '' });
      setPwSuccess(data.message || 'Password changed successfully.');
      window.setTimeout(() => setPwSuccess(''), 5000);
    } catch {
      setPwError('Unable to reach the server. Please check your connection.');
    } finally {
      setPwLoading(false);
    }
  }

  async function removeGoogleAccount() {
    if (!window.confirm(
      'Remove connected Google account?\n\nThis clears Google verification. Two-Step Verification will be turned off until you verify again. Your Faculty account and any custom profile picture will be kept.'
    )) return;
    setGoogleBusy(true);
    setGoogleError('');
    try {
      const res = await fetch('/api/instructor/verify-google', { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setGoogleError(data.error || 'Failed to remove Google account.');
        return;
      }
      setGoogleVerified(false);
      setShowChangeGoogle(false);
      setHasCustom(data.has_custom_profile_picture === true);
      const nextPic = data.picture_url ?? null;
      setLocalPicUrl(nextPic);
      updatePicUrl(nextPic, { custom: data.has_custom_profile_picture === true });
      window.dispatchEvent(new CustomEvent('profile-picture-changed', {
        detail: {
          picUrl: nextPic,
          hasCustom: data.has_custom_profile_picture === true,
        },
      }));
    } catch {
      setGoogleError('Unable to reach the server. Please try again.');
    } finally {
      setGoogleBusy(false);
    }
  }

  const matchOk   = pwForm.confirm.length > 0 && pwForm.newPw === pwForm.confirm;
  const matchFail = pwForm.confirm.length > 0 && pwForm.newPw !== pwForm.confirm;
  const displayPic = localPicUrl || contextPicUrl;

  return (
    <div className="min-h-full bg-[#0f172a] p-5 md:p-7">
      <Script
        src="https://accounts.google.com/gsi/client"
        strategy="afterInteractive"
        onLoad={() => setGisReady(true)}
      />

      <div className="mb-7">
        <BackButton />
        <div className="mt-2 lg:mt-5">
          <WatermarkTitle>Settings</WatermarkTitle>
        </div>
      </div>

      <PageLoadTransition
        showSkeleton={showSkeleton}
        skeleton={<FormSkeleton fields={6} />}
      >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-5xl mx-auto">

        <AccordionCard
          id="picture"
          icon={Camera}
          title="Profile Picture"
          subtitle="Upload and manage your profile photo"
          open={openSection === 'picture'}
          onToggle={() => toggle('picture')}
        >
          <div className="px-4 py-5 sm:px-6 sm:py-6">
            <ProfilePictureUpload
              currentUrl={displayPic ?? null}
              uploadEndpoint="/api/instructor/profile/picture"
              deleteEndpoint="/api/instructor/profile/picture"
              onSuccess={handlePicSuccess}
              onRemove={handlePicRemove}
              hasRemovablePhoto={hasCustom}
              removeLabel="Remove Photo"
              displayName={name || 'Faculty'}
              theme="dark"
              compact
            />
          </div>
        </AccordionCard>

        <AccordionCard
          id="appearance"
          icon={Palette}
          title="Appearance"
          subtitle="Theme and display preferences"
          open={openSection === 'appearance'}
          onToggle={() => toggle('appearance')}
        >
          <div className="px-4 py-5 sm:px-6 sm:py-6 space-y-5">
            <div>
              <div className="flex items-center justify-between mb-4">
                <div>
                  <p className="text-sm font-bold text-white">Color Theme</p>
                  <p className="text-[11px] text-slate-400 mt-0.5">Syncs across your sessions and devices</p>
                </div>
                {themeSaving && (
                  <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Saving…
                  </div>
                )}
              </div>

              <div className="grid grid-cols-3 gap-3">
                <ThemeCard id="light"  label="Light"  desc="Soft & comfortable"    selected={theme === 'light'}  onClick={() => setTheme('light')}  />
                <ThemeCard id="dark"   label="Dark"   desc="Easy on the eyes"       selected={theme === 'dark'}   onClick={() => setTheme('dark')}   />
                <ThemeCard id="system" label="System" desc="Follows your device"    selected={theme === 'system'} onClick={() => setTheme('system')} />
              </div>
            </div>

            <div className="flex items-center gap-3 bg-white/5 border border-white/10 rounded-xl px-4 py-3">
              <div className="w-8 h-8 bg-[#12408F]/15 rounded-lg flex items-center justify-center flex-shrink-0">
                {theme === 'light'  && <Sun               className="w-4 h-4 text-[#12408F]" />}
                {theme === 'dark'   && <Moon              className="w-4 h-4 text-[#12408F]" />}
                {theme === 'system' && <MonitorSmartphone className="w-4 h-4 text-[#12408F]" />}
              </div>
              <p className="text-[11px] text-slate-400">
                <span className="font-bold text-slate-300">
                  {theme === 'system' ? 'System default' : theme === 'light' ? 'Light mode' : 'Dark mode'}
                </span>
                {' '}— preference saved to your account.
              </p>
            </div>
          </div>
        </AccordionCard>

        {/* ── Password and Security ─────────────────────────────── */}
        <AccordionCard
          id="security"
          icon={Lock}
          title="Password and Security"
          subtitle="Two-step verification, password, and devices"
          open={openSection === 'security'}
          onToggle={() => toggle('security')}
        >
          <div className="px-3 py-3 space-y-1">
            {pwSuccess && (
              <div className="flex items-start gap-3 mx-1 mb-2 bg-emerald-500/10 border border-emerald-500/20 rounded-xl px-4 py-3">
                <CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" />
                <span className="text-sm text-emerald-400 font-medium">{pwSuccess}</span>
              </div>
            )}

            <div className="rounded-xl border border-white/10 overflow-hidden mb-3">
              <div className="px-4 py-2.5 bg-white/[0.02] border-b border-white/10">
                <p className="text-[11px] font-bold text-slate-400 uppercase tracking-[0.14em]">Security</p>
              </div>
              <div className="p-3">
                <OtpPreferencePanel variant="dark" embedded />
              </div>
            </div>

            <div className="rounded-xl border border-white/10 overflow-hidden divide-y divide-white/10">
              <div className="px-4 py-2.5 bg-white/[0.02]">
                <p className="text-[11px] font-bold text-slate-400 uppercase tracking-[0.14em]">Login &amp; security</p>
              </div>
              <SecurityRow
                icon={KeyRound}
                title="Change Password"
                description="Update your account password securely"
                onClick={() => void startChangePassword()}
              />
            </div>

            <div className="rounded-xl border border-white/10 overflow-hidden divide-y divide-white/10 mt-3">
              <div className="px-4 py-2.5 bg-white/[0.02]">
                <p className="text-[11px] font-bold text-slate-400 uppercase tracking-[0.14em]">Security checks</p>
              </div>
              <SecurityRow
                icon={MonitorSmartphone}
                title="Where You're Logged In"
                description="Review and manage devices connected to your account"
                onClick={() => setSecurityModal('devices')}
              />
            </div>

            {!googleVerified && (
              <p className="px-2 pt-3 text-[12px] text-slate-400 leading-relaxed">
                Optional: verify your Google account under Google Account to enable Google sign-in and Two-Step Verification (Email OTP). Password changes do not require verification.
              </p>
            )}
          </div>
        </AccordionCard>

        {/* ── Google Account ────────────────────────────────────── */}
        <AccordionCard
          id="google"
          icon={ShieldCheck}
          title="Google Account"
          subtitle={googleVerified ? 'Verified' : 'Not verified'}
          open={openSection === 'google'}
          onToggle={() => toggle('google')}
        >
          <div className="px-4 py-5 sm:px-6 sm:py-6 space-y-4">
            {googleError && (
              <div className="flex items-start gap-3 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">
                <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                <span className="text-sm text-red-400 font-medium">{googleError}</span>
              </div>
            )}

            <div className="flex items-center justify-between gap-3 bg-white/5 border border-white/10 rounded-xl px-4 py-3">
              <div className="min-w-0">
                <p className="text-[11px] font-bold text-slate-400 uppercase tracking-[0.14em]">Registered email</p>
                <p className="text-sm text-white font-medium mt-0.5 truncate">{accountEmail || '—'}</p>
              </div>
              {googleVerified ? (
                <span className="inline-flex items-center gap-1.5 flex-shrink-0 px-2.5 py-1 rounded-full text-[11px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/25">
                  <CheckCircle className="w-3.5 h-3.5" />
                  Verified
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 flex-shrink-0 px-2.5 py-1 rounded-full text-[11px] font-bold bg-amber-500/15 text-amber-400 border border-amber-500/25">
                  Not Verified
                </span>
              )}
            </div>

            {googleVerified ? (
              <>
                <p className="text-[12px] text-slate-400 leading-relaxed">
                  This Google account matches the email registered for your Faculty profile.
                  Verification confirms ownership only — turn on Two-Step Verification under Password and Security if you want Email OTP at sign-in.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowChangeGoogle(v => !v)}
                    disabled={googleBusy}
                    className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold border border-white/10 text-slate-200 hover:bg-white/5 transition-colors disabled:opacity-50"
                  >
                    Change Google Account
                  </button>
                  <button
                    type="button"
                    onClick={() => void removeGoogleAccount()}
                    disabled={googleBusy}
                    className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold border border-red-500/25 text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                  >
                    {googleBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                    Remove Google Account
                  </button>
                </div>
                {showChangeGoogle && (
                  <div className="pt-1 space-y-2">
                    <p className="text-[12px] text-slate-400">
                      Continue with the Google account that matches your registered email.
                    </p>
                    {!process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ? (
                      <p className="text-sm text-amber-400">Google Sign-In is not configured.</p>
                    ) : (
                      <div className="flex items-center gap-3">
                        <div ref={changeGoogleBtnRef} className={`flex-1 min-w-0 flex justify-center sm:justify-start ${googleBusy ? 'pointer-events-none opacity-60' : ''}`} />
                        {googleBusy && <Loader2 className="w-4 h-4 animate-spin text-slate-400" />}
                      </div>
                    )}
                  </div>
                )}
              </>
            ) : (
              <>
                <p className="text-[12px] text-slate-400 leading-relaxed">
                  Sign in with the same Google account as your registered email to verify ownership.
                  A different Google account will be rejected.
                </p>
                {!process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ? (
                  <p className="text-sm text-amber-400">Google Sign-In is not configured.</p>
                ) : (
                  <div className="flex items-center gap-3">
                    <div ref={googleBtnRef} className={`flex-1 min-w-0 flex justify-center sm:justify-start ${googleBusy ? 'pointer-events-none opacity-60' : ''}`} />
                    {googleBusy && <Loader2 className="w-4 h-4 animate-spin text-slate-400" />}
                  </div>
                )}
              </>
            )}
          </div>
        </AccordionCard>
      </div>
      </PageLoadTransition>

      {/* Change password modal */}
      {securityModal === 'password' && (
        <ModalShell title="Change Password" onClose={() => void closeSecurityModal()}>
          <form onSubmit={handlePasswordSubmit} noValidate className="space-y-4">
            <p className="text-[12px] text-slate-400 leading-relaxed">
              Update your account password securely. Use at least 8 characters with a mix of letters, numbers, and symbols.
            </p>
            {pwError && (
              <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/20 rounded-xl px-3 py-2.5 text-sm text-red-400">
                <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <span>{pwError}</span>
              </div>
            )}
            <PwField
              label="Current Password"
              value={pwForm.current}
              onChange={v => setPwForm(f => ({ ...f, current: v }))}
              visible={pwVisible.current}
              onToggle={() => toggleVis('current')}
              autoComplete="current-password"
            />
            <div>
              <PwField
                label="New Password"
                value={pwForm.newPw}
                onChange={v => setPwForm(f => ({ ...f, newPw: v }))}
                visible={pwVisible.newPw}
                onToggle={() => toggleVis('newPw')}
                autoComplete="new-password"
              />
              {pwForm.newPw && <StrengthBar password={pwForm.newPw} />}
            </div>
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-[0.14em]">
                  Confirm New Password
                </label>
                {matchOk && <span className="text-[11px] text-emerald-400 font-bold flex items-center gap-1"><Check className="w-3 h-3" />Match</span>}
                {matchFail && <span className="text-[11px] text-red-400 font-bold flex items-center gap-1"><X className="w-3 h-3" />No match</span>}
              </div>
              <div className="relative">
                <input
                  type={pwVisible.confirm ? 'text' : 'password'}
                  value={pwForm.confirm}
                  onChange={e => setPwForm(f => ({ ...f, confirm: e.target.value }))}
                  autoComplete="new-password"
                  className={`w-full bg-white/5 border rounded-xl px-4 py-3 pr-12 text-sm text-white focus:outline-none transition-colors ${
                    matchFail ? 'border-red-500/50' : matchOk ? 'border-emerald-500/40' : 'border-white/10 focus:border-[#12408F]'
                  }`}
                />
                <button
                  type="button"
                  onClick={() => toggleVis('confirm')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-slate-500 hover:text-slate-300"
                >
                  {pwVisible.confirm ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <label className="flex items-start gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-3.5 py-3 cursor-pointer">
              <input
                type="checkbox"
                checked={logoutOthers}
                onChange={e => setLogoutOthers(e.target.checked)}
                className="mt-0.5 rounded border-white/20"
              />
              <span>
                <span className="block text-sm font-semibold text-white">Log out of other devices</span>
                <span className="block text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                  Use this if you think someone else may have access to your account. Unchecked keeps the current safer default of signing you out everywhere.
                </span>
              </span>
            </label>

            <button
              type="submit"
              disabled={!canSubmitPw(pwForm.current, pwForm.newPw, pwForm.confirm) || pwLoading}
              className="w-full h-11 rounded-xl bg-[#12408F] hover:bg-[#1D5BD6] disabled:opacity-40 text-white text-sm font-bold transition-colors flex items-center justify-center gap-2"
            >
              {pwLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {pwLoading ? 'Saving…' : 'Change Password'}
            </button>
          </form>
        </ModalShell>
      )}

      {/* Devices modal */}
      {securityModal === 'devices' && (
        <ModalShell title="Where You're Logged In" onClose={() => setSecurityModal(null)} wide>
          <TrustedDevicesPanel variant="dark" embedded />
        </ModalShell>
      )}
    </div>
  );
}

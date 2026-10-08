'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import Script from 'next/script';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  ArrowLeft, ArrowRight, Eye, EyeOff, Lock, MapPin, UserRound,
} from 'lucide-react';
import { LOGIN_FX_CSS } from './loginEffects';
import FlippingLogo from './FlippingLogo';
import RisingParticles from './RisingParticles';
import { headingFont } from '@/lib/fonts';

/** Signed in from a room QR link (phone camera) → back to that room's page */
function qrReturnPath(): string | null {
  try {
    const next = new URLSearchParams(window.location.search).get('next') ?? '';
    return /^\/room\/[A-Za-z0-9%-]{4,100}$/.test(next) ? next : null;
  } catch {
    return null;
  }
}

/* ── Types ────────────────────────────────────────────────────────────── */
/**
 * Administrator, Department Chair, and Program Chair share one login option —
 * the client never states which of the three an account actually is. The
 * server determines the real role (admin / department_chair / program_chair)
 * from the database after authenticating, and routes/permissions follow that.
 */
type Role = 'admin_chair' | 'instructor';

/** `short` is shown on phones, where the full label would wrap inside its button */
const ROLES: { id: Role; label: string; short: string }[] = [
  { id: 'admin_chair', label: 'Administrator / Chair', short: 'Admin / Chair' },
  { id: 'instructor',  label: 'Faculty', short: 'Faculty' },
];

/* ── Component ────────────────────────────────────────────────────────── */
export default function LoginClient() {
  const [role, setRole]               = useState<Role>('admin_chair');
  const [form, setForm]               = useState({ username: '', password: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe]   = useState(false);
  const [error, setError]             = useState('');
  const [loading, setLoading]         = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [gisReady, setGisReady]       = useState(false);
  const [step, setStep]               = useState<'credentials' | 'otp'>('credentials');
  const [otpCode, setOtpCode]         = useState('');
  const [maskedEmail, setMaskedEmail] = useState('');
  const [resendIn, setResendIn]       = useState(0);
  /** Set once the user types, switches role or signs in — a late background answer never overrides that */
  const touchedRef = useRef(false);
  /** A sign-in taking this long is waiting for the server to wake up */
  const [slowServer, setSlowServer] = useState(false);
  /** Back from /change-password: the new password is in place, or a fresh sign-in is needed to set it */
  const [passwordNotice, setPasswordNotice] = useState('');
  useEffect(() => {
    try {
      const sp = new URLSearchParams(window.location.search);
      if (sp.get('changed') === '1') setPasswordNotice('Password changed. Sign in with your new password.');
      else if (sp.get('again') === '1') setPasswordNotice('For your security, sign in again to set your new password.');
    } catch { /* no notice */ }
  }, []);
  const googleBtnRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  // Bumped each time the flipped-in card finishes turning, so the Google button
  // (whose container remounts with the card) gets rendered into the new card.
  const [cardShown, setCardShown] = useState(0);
  const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  const googleEnabled = role === 'instructor' && Boolean(googleClientId);

  /* A sign-in code may still be waiting from before a refresh. Asked in the
     background: the form shows at once and never waits for the server, which
     can take up to a minute to wake on free hosting (this request wakes it). */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/auth/login-otp', { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        if (cancelled || touchedRef.current) return;
        if (res.ok && data.pending) {
          setStep('otp');
          setMaskedEmail(String(data.masked_email ?? ''));
          setResendIn(Number(data.resend_in ?? 0));
          if (data.role === 'admin' || data.role === 'department_chair' || data.role === 'program_chair') {
            setRole('admin_chair');
          } else if (data.role === 'instructor') {
            setRole(data.role);
          }
        }
      } catch {
        /* stay on credentials */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!loading && !googleLoading) return;
    const timer = window.setTimeout(() => setSlowServer(true), 5_000);
    return () => { window.clearTimeout(timer); setSlowServer(false); };
  }, [loading, googleLoading]);

  /**
   * Login is a public page with its own default (light) design.
   * Client navigations from Dark Mode dashboards (router.push('/login'))
   * skip the root bootstrap script — force the Login appearance here
   * without clearing the saved authenticated theme preference.
   */
  useEffect(() => {
    const html = document.documentElement;
    html.classList.add('light');
    html.removeAttribute('data-instructor-theme');
  }, []);

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = window.setTimeout(() => setResendIn(v => Math.max(0, v - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [resendIn]);

  function enterOtpStep(emailMask: string, seconds: number) {
    setStep('otp');
    setMaskedEmail(emailMask);
    setResendIn(seconds);
    setOtpCode('');
    setError('');
    setForm(f => ({ ...f, password: '' }));
  }

  function selectRole(r: Role) {
    touchedRef.current = true;
    setRole(r);
    setError('');
    setForm({ username: '', password: '' });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    touchedRef.current = true;
    if (!form.username.trim()) { setError('Please enter your username or email.'); return; }
    if (!form.password)        { setError('Please enter your password.');           return; }
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: form.username.trim(), password: form.password, role }),
      });
      const ct = res.headers.get('content-type') ?? '';
      if (!ct.includes('application/json')) {
        setError(res.status === 503
          ? 'Service unavailable. Please try again shortly.'
          : 'A server error occurred. Please try again.');
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Login failed. Please try again.');
        return;
      }
      if (data.OTP_REQUIRED || data.requiresOtp || data.mfa_required) {
        enterOtpStep(
          String(data.maskedEmail ?? data.masked_email ?? ''),
          Number(data.resend_after ?? 60)
        );
        return;
      }
      // The server always returns `redirect` for a successful login; this is
      // only a fallback if that were ever missing.
      const fallback = role === 'admin_chair' ? '/dashboard' : '/instructor';
      window.location.href = qrReturnPath() ?? (data.redirect || fallback);
    } catch {
      setError('Unable to reach the server. Please check your connection.');
    } finally {
      setLoading(false);
    }
  }

  async function handleVerifyOtp(e: React.FormEvent) {
    e.preventDefault();
    if (!/^\d{6}$/.test(otpCode)) {
      setError('Enter the 6-digit verification code.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/login-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: otpCode }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Invalid verification code.');
        if (
          res.status === 403 ||
          res.status === 429 ||
          (typeof data.error === 'string' && /login again|expired/i.test(data.error))
        ) {
          setStep('credentials');
          setOtpCode('');
        }
        return;
      }
      window.location.href = qrReturnPath() ?? (data.redirect || '/dashboard');
    } catch {
      setError('Unable to reach the server. Please check your connection.');
    } finally {
      setLoading(false);
    }
  }

  async function handleResend() {
    if (resendIn > 0 || loading) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/login-otp/resend', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Unable to send verification email. Please try again.');
        if (data.resend_after) setResendIn(Number(data.resend_after));
        if (res.status === 401 || res.status === 403) {
          setStep('credentials');
          setOtpCode('');
        }
        return;
      }
      if (data.masked_email) setMaskedEmail(String(data.masked_email));
      setResendIn(Number(data.resend_after ?? 60));
      setOtpCode('');
    } catch {
      setError('Unable to reach the server. Please check your connection.');
    } finally {
      setLoading(false);
    }
  }

  async function handleBackToLogin() {
    setLoading(true);
    try {
      await fetch('/api/auth/login-otp', { method: 'DELETE' });
    } catch {
      /* still return to credentials */
    } finally {
      setStep('credentials');
      setOtpCode('');
      setMaskedEmail('');
      setError('');
      setLoading(false);
    }
  }

  const handleGoogleCredential = useCallback(async (response: GoogleCredentialResponse) => {
    touchedRef.current = true;
    setError('');
    setGoogleLoading(true);
    try {
      const res = await fetch('/api/auth/google-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential: response.credential, role: 'instructor' }),
      });
      const ct = res.headers.get('content-type') ?? '';
      if (!ct.includes('application/json')) {
        setError('A server error occurred. Please try again.');
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'This Google account is not linked to a verified account.');
        return;
      }
      window.location.href = qrReturnPath() ?? (data.redirect || '/instructor');
    } catch {
      setError('Unable to reach the server. Please check your connection.');
    } finally {
      setGoogleLoading(false);
    }
  }, []);

  useEffect(() => {
    const host = googleBtnRef.current;
    if (!gisReady || !googleEnabled || !googleClientId || !host || !window.google?.accounts?.id) {
      return;
    }
    window.google.accounts.id.initialize({
      client_id: googleClientId,
      callback: handleGoogleCredential,
      auto_select: false,
      cancel_on_tap_outside: true,
    });
    /* Google draws the button at a fixed pixel width — size it to the card
       (Google allows 200–400 px) so it never pushes the card wider on phones. */
    let lastWidth = 0;
    const render = () => {
      const width = Math.round(Math.min(368, Math.max(200, host.clientWidth)));
      if (width === lastWidth) return;
      lastWidth = width;
      host.innerHTML = '';
      window.google?.accounts?.id?.renderButton(host, {
        type: 'standard',
        theme: 'outline',
        size: 'large',
        text: 'continue_with',
        shape: 'rectangular',
        width,
        // Always English ("Continue with Google"), whatever language the phone is set to
        locale: 'en',
      });
    };
    render();
    // Re-fit when the screen changes size (e.g. rotating a phone)
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => { clearTimeout(timer); timer = setTimeout(render, 150); };
    window.addEventListener('resize', onResize);
    return () => { clearTimeout(timer); window.removeEventListener('resize', onResize); };
  }, [gisReady, googleEnabled, handleGoogleCredential, googleClientId, cardShown]);

  const usernameLabel = role === 'instructor' ? 'Username or Email' : 'Username';
  const usernamePlaceholder = role === 'instructor' ? 'Enter username or email' : 'Enter your username';

  const inputCls =
    'w-full border border-[#D6E0EF] rounded-xl pl-11 pr-4 text-[15px] text-[#0B2A5B] bg-[#FBFCFE] placeholder:text-[#94A3B8] transition-all duration-150 focus:outline-none focus:bg-white focus:border-[#1D5BD6] focus:ring-4 focus:ring-[#1D5BD6]/10';
  const primaryBtnCls =
    'qrfx-shine w-full font-semibold text-[15px] rounded-xl transition-all duration-150 flex items-center justify-center gap-2 shadow-[0_10px_24px_-10px_rgba(18,64,143,0.7)] hover:brightness-110 active:brightness-95 disabled:opacity-60 disabled:cursor-not-allowed';
  // White label set inline — a `text-white` class gets repainted dark by the
  // light-mode override in globals.css.
  const primaryBtnStyle = { height: '52px', color: '#FFFFFF', backgroundImage: 'linear-gradient(90deg, #0E3F9E 0%, #1D5BD6 100%)' };

  const errorAlert = error ? (
    <div
      role="alert"
      aria-live="polite"
      className="flex items-start gap-2.5 bg-red-50 border border-red-200 text-red-700 px-3.5 py-3 rounded-xl text-[13px] leading-snug mb-4"
    >
      <svg className="w-[15px] h-[15px] mt-[1px] flex-shrink-0" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
        <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
      </svg>
      <span>{error}</span>
    </div>
  ) : null;

  // Switching role turns the Sign In card over: it rotates edge-on, the form
  // swaps to the other role, then it rotates back to face the user.
  // Direction follows the role: Instructor turns the card to the right,
  // Admin turns it back to the left (like turning a page and back).
  const flipHalf = reduceMotion
    ? { duration: 0 }
    : { duration: 0.45, ease: [0.45, 0, 0.55, 1] as const };
  const flipDir = role === 'instructor' ? 1 : -1;
  const cardFlip = {
    // rotateY(+) turns the card's face toward the right
    enter: (dir: number) => (reduceMotion ? { opacity: 1 } : { rotateY: -90 * dir, opacity: 0.6 }),
    center: { rotateY: 0, opacity: 1, transition: flipHalf },
    exit: (dir: number) => (reduceMotion ? { opacity: 1 } : { rotateY: 90 * dir, opacity: 0.6, transition: flipHalf }),
  };

  return (
    <div className="qrfx-login relative min-h-screen grid lg:grid-cols-2 bg-[#F4F7FC]">
      <style>{LOGIN_FX_CSS}</style>
      {/* Glowing seam between the campus panel and the sign-in side */}
      <div aria-hidden className="qrfx-seam hidden lg:block" />
      {role === 'instructor' && googleClientId && (
        <Script
          src="https://accounts.google.com/gsi/client?hl=en"
          strategy="afterInteractive"
          onLoad={() => setGisReady(true)}
        />
      )}

      {/* ════════ LEFT — campus branding (desktop) ════════
          Photo lives at public/login/campus.jpg; until it exists the blue
          gradient underneath shows through on its own.
          Locked to one viewport height (sticky, h-screen, self-start) so the
          footer never moves when the sign-in side grows taller (e.g. the
          Faculty card adds Google sign-in). */}
      <aside
        className="hidden lg:flex lg:sticky lg:top-0 lg:h-screen lg:self-start relative overflow-hidden flex-col justify-between gap-8 px-14 xl:px-20 py-16 [@media(max-height:820px)]:py-10 [@media(max-height:680px)]:py-7"
        style={{
          backgroundImage: [
            'linear-gradient(180deg, rgba(238,243,250,0.96) 0%, rgba(226,235,248,0.82) 38%, rgba(147,178,224,0.35) 62%, rgba(18,64,143,0.78) 100%)',
            "url('/login/campus.jpg')",
            'linear-gradient(180deg, #E4ECF8 0%, #BFD2EE 55%, #1D4F9E 100%)',
          ].join(', '),
          backgroundSize: 'cover, cover, cover',
          backgroundPosition: 'center, center bottom, center',
        }}
      >
        {/* Faded seal watermark, top-left */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/nemlogo/NEMSU-logo.png"
          alt=""
          aria-hidden="true"
          className="absolute -top-24 -left-24 w-[420px] h-[420px] object-contain opacity-[0.07] pointer-events-none select-none"
        />
        <div aria-hidden className="qrfx-sweep" />
        {/* Glowing particles rising up the campus panel */}
        <RisingParticles count={22} tone="light" seed={7} />

        <div className="relative shrink-0" style={{ animation: 'loginFadeIn 0.45s ease both' }}>
          <div className="flex items-center gap-4 mb-14 [@media(max-height:820px)]:mb-8 [@media(max-height:680px)]:mb-5">
            {/* The seal floats and flips over by itself */}
            <FlippingLogo size={84} faceClassName="shadow-[0_8px_24px_-8px_rgba(11,42,91,0.45)]" />
            <div>
              <p className={`${headingFont.className} text-[32px] font-bold text-[#0B2A5B] leading-none`}>Qrganize</p>
              <p className="text-[15px] text-[#22406F] font-medium tracking-[0.45em] uppercase mt-2">NEMSU</p>
            </div>
          </div>

          <h1 className={`${headingFont.className} text-[2.35rem] xl:text-[2.6rem] [@media(max-height:820px)]:text-[2rem] [@media(max-height:680px)]:text-[1.7rem] font-bold text-[#0B2A5B] leading-[1.18] max-w-[620px]`}>
            QR-Based Program Scheduling and Faculty Workload Management System
          </h1>
          <div className="w-14 h-[3px] bg-[#1D5BD6] rounded-full mt-6 mb-6 [@media(max-height:680px)]:mt-4 [@media(max-height:680px)]:mb-4" />
          <p className="text-[17px] text-[#22406F] leading-relaxed max-w-[520px]">
            A centralized platform for managing curriculum, faculty workload,
            scheduling, and room utilization.
          </p>
        </div>

        {/* White set inline (not `text-white`): the light-mode rule in
            globals.css repaints `text-white` as dark ink, and Login is always light */}
        {/* One straight line at every width (qr-campus scales the text to fit);
            the row may use part of the panel's right padding for room */}
        <div
          className="qr-campus-row relative shrink-0 flex items-center gap-3 lg:-mr-8 xl:-mr-12"
          style={{ color: '#FFFFFF', textShadow: '0 1px 8px rgba(11,42,91,0.45)' }}
        >
          <MapPin className="w-6 h-6 flex-shrink-0" fill="currentColor" stroke="#12408F" aria-hidden="true" />
          <p className="qr-campus font-semibold uppercase leading-snug">
            North Eastern Mindanao State University – Cantilan Campus
          </p>
        </div>
      </aside>

      {/* ════════ RIGHT — sign in ════════ */}
      <main
        className="relative flex flex-col min-h-screen px-4 sm:px-8 py-6 sm:py-8 overflow-x-clip"
        style={{ background: 'radial-gradient(900px 500px at 70% 30%, rgba(29,91,214,0.06), transparent 70%), #F4F7FC' }}
      >
        {/* Soft blue lights drifting behind the card, over a faint dot texture */}
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="qrfx-dots" />
          {/* Behind the card only — never over the form (floating over the fields was distracting).
              Phones: bigger and brighter, since only the space around the card shows them */}
          <div className="hidden lg:block"><RisingParticles count={14} tone="blue" seed={21} /></div>
          <div className="lg:hidden"><RisingParticles count={22} tone="blue" seed={33} sizeScale={1.5} strong /></div>
          <div className="qrfx-orb qrfx-orb-a" style={{ width: 440, height: 440, top: '6%', right: -90, background: 'rgba(29,91,214,0.22)' }} />
          <div className="qrfx-orb qrfx-orb-b" style={{ width: 380, height: 380, bottom: '4%', left: '6%', background: 'rgba(127,168,240,0.30)' }} />
        </div>
        {/* Mobile branding */}
        <div className="relative lg:hidden flex flex-col items-center text-center mt-6 mb-6">
          <div className="flex items-center gap-3 mb-2">
            <FlippingLogo size={48} />
            <div className="text-left">
              <p className={`${headingFont.className} text-[22px] font-bold text-[#0B2A5B] leading-none`}>Qrganize</p>
              <p className="text-[11px] text-[#22406F] font-medium tracking-[0.4em] uppercase mt-1">NEMSU</p>
            </div>
          </div>
          <p className="text-[13px] text-[#5B6F8C] max-w-[320px] leading-relaxed">
            QR-Based Program Scheduling and Faculty Workload Management System
          </p>
        </div>

        <div className="relative flex-1 flex items-center justify-center">
          <div
            className="qrfx-stage relative w-full max-w-[460px]"
            style={{ animation: 'loginFadeIn 0.35s ease both', perspective: '1600px' }}
          >
            {/* Soft halo around the card — brightens while typing */}
            <div aria-hidden className="qrfx-halo" />
            {/* ── Sign In card — turns over when the role changes ── */}
            {/* `custom` hands the NEW direction to the exiting card too, so both
                halves of the turn go the same way */}
            <AnimatePresence mode="wait" initial={false} custom={flipDir}>
            <motion.div
              key={role}
              custom={flipDir}
              variants={cardFlip}
              initial="enter"
              animate="center"
              exit="exit"
              onAnimationComplete={() => setCardShown(n => n + 1)}
              // Phones: 24px / 20px inside — the fixed 40px squeezed every row on a 390px screen
              className="relative w-full bg-white border border-[#E3E9F3] rounded-3xl px-5 pt-6 pb-6 sm:px-10 sm:pt-10 sm:pb-[34px]"
              style={{
                boxShadow: '0 1px 3px rgba(11,42,91,0.05), 0 24px 60px -20px rgba(11,42,91,0.28)',
                transformStyle: 'preserve-3d',
                backfaceVisibility: 'hidden',
              }}
            >
              <div className="mb-6 sm:mb-7">
                <div className="flex items-center gap-3">
                  <UserRound className="w-8 h-8 sm:w-9 sm:h-9 text-[#0B2A5B] flex-shrink-0" strokeWidth={1.9} aria-hidden="true" />
                  <h2 className={`${headingFont.className} text-[26px] sm:text-[30px] font-bold text-[#0B2A5B] leading-tight`}>
                    {step === 'otp' ? 'Verify Login' : 'Sign In'}
                  </h2>
                </div>
                <p className="text-[14px] sm:text-[15px] text-[#5B6F8C] mt-2">
                  {step === 'otp'
                    ? 'A 6-digit authentication code was sent to your verified email.'
                    : 'Enter your credentials to continue.'}
                </p>
                {step === 'otp' && maskedEmail ? (
                  <p className="text-[14px] font-semibold text-[#0B2A5B] mt-1.5">{maskedEmail}</p>
                ) : null}
              </div>

              {step === 'otp' ? (
                <form onSubmit={handleVerifyOtp} noValidate>
                  {errorAlert}

                  <div className="mb-5">
                    <label htmlFor="login-otp" className="block text-[14px] font-semibold text-[#0B2A5B] mb-2">
                      Enter verification code
                    </label>
                    <input
                      id="login-otp"
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      pattern="[0-9]*"
                      maxLength={6}
                      value={otpCode}
                      onChange={e => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      placeholder="••••••"
                      autoFocus
                      className="w-full border border-[#D6E0EF] rounded-xl px-4 text-center text-[22px] font-semibold tracking-[0.45em] text-[#0B2A5B] bg-[#FBFCFE] placeholder:text-[#CBD5E1] placeholder:tracking-[0.45em] transition-all duration-150 focus:outline-none focus:bg-white focus:border-[#1D5BD6] focus:ring-4 focus:ring-[#1D5BD6]/10"
                      style={{ height: '54px' }}
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={loading || otpCode.length !== 6}
                    className={primaryBtnCls}
                    style={primaryBtnStyle}
                  >
                    {loading ? (
                      <>
                        <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" aria-hidden="true" />
                        <span>Verifying…</span>
                      </>
                    ) : <>Verify Code <ArrowRight className="w-4 h-4" /></>}
                  </button>

                  <button
                    type="button"
                    onClick={handleResend}
                    disabled={loading || resendIn > 0}
                    className="w-full mt-3 text-[13px] font-semibold text-[#1D5BD6] hover:text-[#164BB5] disabled:text-[#94A3B8] disabled:cursor-not-allowed transition-colors"
                    style={{ height: '40px' }}
                  >
                    {resendIn > 0 ? `Resend available in ${resendIn} seconds` : 'Resend Code'}
                  </button>

                  <button
                    type="button"
                    onClick={handleBackToLogin}
                    disabled={loading}
                    className="w-full text-[13px] font-medium text-[#5B6F8C] hover:text-[#0B2A5B] transition-colors"
                    style={{ height: '36px' }}
                  >
                    Back to Login
                  </button>
                </form>
              ) : (
                <>
                  {/* Role segmented control */}
                  <div className="mb-5">
                    <p className="text-[14px] font-semibold text-[#0B2A5B] mb-2">Role</p>
                    <div
                      role="group"
                      aria-label="Select role"
                      className="flex bg-white border border-[#D6E0EF] rounded-xl p-1 gap-1"
                    >
                      {ROLES.map(r => {
                        const active = role === r.id;
                        return (
                          <button
                            key={r.id}
                            type="button"
                            onClick={() => { if (!active) selectRole(r.id); }}
                            aria-pressed={active}
                            className={[
                              // Each button as wide as its label needs ("Administrator / Chair" is longer than "Faculty"),
                              // the rest shared; min-w-0 + wrapping on phones keeps the card from widening
                              'relative flex-auto min-w-0 min-h-[44px] px-2 py-1.5 inline-flex items-center justify-center gap-2 text-[14px] leading-tight text-center font-semibold rounded-[10px] sm:whitespace-nowrap transition-colors duration-300',
                              active ? 'text-[#1D5BD6]' : 'text-[#0B2A5B] hover:text-[#1D5BD6]',
                            ].join(' ')}
                          >
                            {active && (
                              <span
                                className="absolute inset-0 rounded-[10px] bg-[#EAF1FC] border border-[#BFD3F5] shadow-sm"
                                aria-hidden="true"
                              />
                            )}
                            <span className="relative inline-flex items-center gap-1.5 min-w-0">
                              {active && <UserRound className="hidden sm:inline-block w-4 h-4 flex-shrink-0" aria-hidden="true" />}
                              <span className="sm:hidden">{r.short}</span>
                              <span className="hidden sm:inline">{r.label}</span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <form onSubmit={handleSubmit} noValidate>
                    {passwordNotice && !error && (
                      <div role="status" className="bg-emerald-50 border border-emerald-200 text-emerald-800 px-3.5 py-3 rounded-xl text-[15px] leading-snug mb-4">
                        {passwordNotice}
                      </div>
                    )}
                    {errorAlert}

                    {/* Username */}
                    <div className="mb-4">
                      <label htmlFor="login-username" className="block text-[14px] font-semibold text-[#0B2A5B] mb-2">
                        {usernameLabel}
                      </label>
                      <div className="relative">
                        <UserRound className="absolute left-4 top-1/2 -translate-y-1/2 w-[18px] h-[18px] text-[#5B6F8C] pointer-events-none" aria-hidden="true" />
                        <input
                          id="login-username"
                          type="text"
                          value={form.username}
                          onChange={e => { touchedRef.current = true; setForm(f => ({ ...f, username: e.target.value })); }}
                          placeholder={usernamePlaceholder}
                          autoComplete="username"
                          className={inputCls}
                          style={{ height: '50px' }}
                        />
                      </div>
                    </div>

                    {/* Password */}
                    <div className="mb-4">
                      <label htmlFor="login-password" className="block text-[14px] font-semibold text-[#0B2A5B] mb-2">
                        Password
                      </label>
                      <div className="relative">
                        <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-[18px] h-[18px] text-[#5B6F8C] pointer-events-none" aria-hidden="true" />
                        <input
                          id="login-password"
                          type={showPassword ? 'text' : 'password'}
                          value={form.password}
                          onChange={e => { touchedRef.current = true; setForm(f => ({ ...f, password: e.target.value })); }}
                          placeholder="Enter your password"
                          autoComplete="current-password"
                          className={`${inputCls} !pr-12`}
                          style={{ height: '50px' }}
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword(p => !p)}
                          tabIndex={-1}
                          aria-label={showPassword ? 'Hide password' : 'Show password'}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-[#5B6F8C] hover:text-[#0B2A5B] transition-colors p-1 rounded-md"
                        >
                          {showPassword ? <EyeOff className="w-[18px] h-[18px]" /> : <Eye className="w-[18px] h-[18px]" />}
                        </button>
                      </div>
                    </div>

                    {/* Remember Me + Forgot Password */}
                    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 mb-6">
                      <label className="flex items-center gap-2 cursor-pointer select-none group">
                        <input
                          type="checkbox"
                          checked={rememberMe}
                          onChange={e => setRememberMe(e.target.checked)}
                          className="w-[18px] h-[18px] rounded border-[#B8C6DC] cursor-pointer accent-[#1D5BD6]"
                        />
                        <span className="text-[14px] text-[#22406F] group-hover:text-[#0B2A5B] transition-colors">
                          Remember me
                        </span>
                      </label>
                      <button
                        type="button"
                        className="text-[14px] font-semibold text-[#1D5BD6] hover:text-[#164BB5] transition-colors"
                      >
                        Forgot password?
                      </button>
                    </div>

                    {/* Sign In */}
                    <button
                      type="submit"
                      disabled={loading || googleLoading}
                      className={primaryBtnCls}
                      style={primaryBtnStyle}
                    >
                      {loading ? (
                        <>
                          <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" aria-hidden="true" />
                          <span>Signing in…</span>
                        </>
                      ) : <>Sign In <ArrowRight className="w-4 h-4" /></>}
                    </button>
                    <AnimatePresence initial={false}>
                      {slowServer && (
                        <motion.p
                          key="slow-server"
                          role="status"
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          exit={{ opacity: 0, height: 0 }}
                          transition={{ duration: reduceMotion ? 0 : 0.25, ease: [0.22, 1, 0.36, 1] }}
                          className="overflow-hidden text-center text-[14px] text-[#22406F] leading-snug"
                        >
                          <span className="block pt-3">Waking up the server — this can take up to a minute.</span>
                        </motion.p>
                      )}
                    </AnimatePresence>
                  </form>

                  {role === 'instructor' && (
                    <div className="pt-5">
                      <div className="flex items-center gap-3 mb-5" aria-hidden="true">
                        <div className="flex-1 h-px bg-[#E3E9F3]" />
                        <span className="text-[12px] font-medium text-[#94A3B8] uppercase tracking-wide">or</span>
                        <div className="flex-1 h-px bg-[#E3E9F3]" />
                      </div>
                      {process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ? (
                        <div className="flex flex-col items-center min-w-0">
                          {/* overflow-hidden: the Google button can never widen the card */}
                          <div
                            ref={googleBtnRef}
                            className={`w-full max-w-full min-w-0 overflow-hidden flex justify-center ${googleLoading ? 'pointer-events-none opacity-60' : ''}`}
                          />
                          {googleLoading && (
                            <p className="mt-2 text-[12px] text-[#5B6F8C]">Signing in with Google…</p>
                          )}
                          <p className="mt-2.5 text-center text-[11px] text-[#94A3B8] leading-snug">
                            Use the Google account already verified for this Faculty account.
                          </p>
                        </div>
                      ) : (
                        <p className="text-center text-[12px] text-[#94A3B8]">
                          Google sign-in is not configured.
                        </p>
                      )}
                    </div>
                  )}
                </>
              )}
            </motion.div>
            </AnimatePresence>

          </div>
        </div>

        {/* Role switch button — one arrow pointing where it goes: → on
            Administrator / Chair (turns the card to Faculty, like the card's
            own flip to the right), ← on Faculty (turns it back). On desktop it
            sits on the seam between the branding panel and the sign-in side
            (fixed so it stays centred while the sign-in side scrolls); on mobile
            it sits under the card. */}
        {step !== 'otp' && (
          <button
            type="button"
            onClick={() => selectRole(role === 'admin_chair' ? 'instructor' : 'admin_chair')}
            aria-label={role === 'admin_chair' ? 'Switch to Faculty sign in' : 'Switch to Administrator / Chair sign in'}
            title={role === 'admin_chair' ? 'Faculty' : 'Administrator / Chair'}
            // Desktop only — on phones the Role buttons already switch the card
            className="group z-20 hidden lg:flex lg:fixed lg:left-1/2 lg:top-1/2 lg:-translate-x-1/2 lg:-translate-y-1/2 w-14 h-14 rounded-full bg-white border border-[#E3E9F3] text-[#0B2A5B] shadow-[0_10px_28px_-10px_rgba(11,42,91,0.45)] items-center justify-center overflow-hidden transition-all duration-200 hover:text-[#1D5BD6] hover:border-[#BFD3F5] hover:shadow-[0_12px_30px_-10px_rgba(29,91,214,0.55)] active:scale-95"
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={role}
                className={`inline-flex transition-transform duration-200 ${
                  role === 'admin_chair' ? 'group-hover:translate-x-0.5' : 'group-hover:-translate-x-0.5'
                }`}
                // Slides out the way it points, the new arrow slides in from the other side
                initial={reduceMotion ? false : { opacity: 0, x: role === 'admin_chair' ? -14 : 14 }}
                animate={{ opacity: 1, x: 0, transition: { duration: reduceMotion ? 0 : 0.25, ease: [0.4, 0, 0.2, 1] } }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: role === 'admin_chair' ? 14 : -14, transition: { duration: 0.18, ease: [0.4, 0, 0.2, 1] } }}
                aria-hidden="true"
              >
                {role === 'admin_chair'
                  ? <ArrowRight className="w-6 h-6" strokeWidth={2.2} />
                  : <ArrowLeft className="w-6 h-6" strokeWidth={2.2} />}
              </motion.span>
            </AnimatePresence>
          </button>
        )}

        <p className="relative lg:hidden mt-8 text-center text-[11px] text-[#94A3B8] font-medium tracking-[0.14em] uppercase leading-relaxed">
          North Eastern Mindanao State University – Cantilan Campus
        </p>
      </main>
    </div>
  );
}

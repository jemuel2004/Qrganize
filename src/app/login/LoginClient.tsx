'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import Script from 'next/script';
import { Eye, EyeOff } from 'lucide-react';
import SystemLogo from '@/client/components/ui/SystemLogo';

/* ── Types ────────────────────────────────────────────────────────────── */
type Role = 'admin' | 'department_chair' | 'instructor';

const ROLES: { id: Role; label: string }[] = [
  { id: 'admin',            label: 'Administrator' },
  { id: 'department_chair', label: 'Dept. Chair'   },
  { id: 'instructor',       label: 'Instructor'    },
];

/* ── Component ────────────────────────────────────────────────────────── */
export default function LoginClient() {
  const [role, setRole]               = useState<Role>('admin');
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
  const [checkingChallenge, setCheckingChallenge] = useState(true);
  const googleBtnRef = useRef<HTMLDivElement>(null);
  const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  const googleEnabled = role === 'instructor' && Boolean(googleClientId);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/auth/login-otp');
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.ok && data.pending) {
          setStep('otp');
          setMaskedEmail(String(data.masked_email ?? ''));
          setResendIn(Number(data.resend_in ?? 0));
          if (data.role === 'admin' || data.role === 'department_chair' || data.role === 'instructor') {
            setRole(data.role);
          }
        }
      } catch {
        /* stay on credentials */
      } finally {
        if (!cancelled) setCheckingChallenge(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

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
    setRole(r);
    setError('');
    setForm({ username: '', password: '' });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
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
      const fallback = role === 'admin' ? '/dashboard' : role === 'department_chair' ? '/dept-chair' : '/instructor';
      window.location.href = data.redirect || fallback;
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
      window.location.href = data.redirect || '/dashboard';
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
      window.location.href = data.redirect || '/instructor';
    } catch {
      setError('Unable to reach the server. Please check your connection.');
    } finally {
      setGoogleLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!gisReady || !googleEnabled || !googleClientId || !googleBtnRef.current || !window.google?.accounts?.id) {
      return;
    }
    googleBtnRef.current.innerHTML = '';
    window.google.accounts.id.initialize({
      client_id: googleClientId,
      callback: handleGoogleCredential,
      auto_select: false,
      cancel_on_tap_outside: true,
    });
    window.google.accounts.id.renderButton(googleBtnRef.current, {
      type: 'standard',
      theme: 'outline',
      size: 'large',
      text: 'continue_with',
      shape: 'rectangular',
      width: 368,
    });
  }, [gisReady, googleEnabled, handleGoogleCredential, googleClientId]);

  const usernameLabel = role === 'instructor' ? 'Username or Email' : 'Username';
  const usernamePlaceholder = role === 'instructor' ? 'Enter username or email' : 'Enter your username';

  return (
    <div className="min-h-screen bg-[#F8FAFC] flex items-center justify-center px-4 py-10">
      {role === 'instructor' && googleClientId && (
        <Script
          src="https://accounts.google.com/gsi/client"
          strategy="afterInteractive"
          onLoad={() => setGisReady(true)}
        />
      )}

      {/* ── Page-level fade-in ─── applied via globals.css @keyframes loginFadeIn */}
      <div
        className="w-full max-w-[1040px] flex flex-col lg:flex-row items-center lg:items-center gap-10 lg:gap-0"
        style={{ animation: 'loginFadeIn 0.35s ease both' }}
      >

        {/* ════════════════════════════════════════
            LEFT — Branding (desktop only)
            ════════════════════════════════════════ */}
        <div className="hidden lg:flex flex-col justify-center w-[45%] pr-14 relative">

          {/* Decorative accent circles — very subtle */}
          <div
            aria-hidden="true"
            className="absolute -top-20 -right-8 w-72 h-72 rounded-full pointer-events-none"
            style={{ background: 'radial-gradient(circle, #EFF6FF 0%, transparent 70%)' }}
          />
          <div
            aria-hidden="true"
            className="absolute bottom-0 -right-4 w-44 h-44 rounded-full pointer-events-none"
            style={{ background: 'radial-gradient(circle, #DBEAFE 0%, transparent 70%)', opacity: 0.5 }}
          />

          <div className="relative">
            {/* Logo + name */}
            <div className="flex items-center gap-4 mb-9">
              <SystemLogo size={54} />
              <div>
                <p className="text-[22px] font-bold text-[#1E293B] leading-none tracking-tight">
                  QR<span className="text-[#2563EB]">ganize</span>
                </p>
                <p className="text-[12px] text-[#94A3B8] font-medium tracking-widest uppercase mt-1">
                  NEMSU
                </p>
              </div>
            </div>

            {/* Headline */}
            <h1 className="text-[1.75rem] font-bold text-[#1E293B] leading-snug mb-4">
              QR-Based Program Scheduling and Faculty Workload Management System
            </h1>

            {/* Blue accent rule */}
            <div className="w-10 h-[3px] bg-[#2563EB] rounded-full mb-4" />

            {/* Description */}
            <p className="text-[15px] text-[#64748B] leading-relaxed">
              A centralized platform for managing curriculum, faculty workload,
              scheduling, and room utilization.
            </p>

            {/* University footer */}
            <div className="mt-14 pt-6 border-t border-[#E2E8F0]">
              <p className="text-[11px] font-semibold text-[#94A3B8] uppercase tracking-[0.18em]">
                North Eastern Mindanao State University
              </p>
            </div>
          </div>
        </div>

        {/* Vertical divider */}
        <div className="hidden lg:block w-px self-stretch bg-[#E2E8F0] mx-2 flex-shrink-0" aria-hidden="true" />

        {/* ════════════════════════════════════════
            RIGHT — Login card
            ════════════════════════════════════════ */}
        <div className="flex-1 flex flex-col items-center lg:items-center lg:pl-14 w-full">

          {/* Mobile branding */}
          <div className="lg:hidden flex flex-col items-center text-center mb-7 w-full">
            <div className="flex items-center gap-3 mb-2">
              <SystemLogo size={40} />
              <p className="text-[20px] font-bold text-[#1E293B]">
                QR<span className="text-[#2563EB]">ganize</span>
              </p>
            </div>
            <p className="text-[13px] text-[#64748B] max-w-[300px] leading-relaxed">
              QR-Based Program Scheduling and Faculty Workload Management System
            </p>
          </div>

          {/* ── Login card ── */}
          <div
            className="w-full bg-white border border-[#E5E7EB] rounded-[14px]"
            style={{
              maxWidth: '440px',
              boxShadow: '0 1px 4px rgba(0,0,0,0.05), 0 4px 20px rgba(0,0,0,0.07)',
              padding: '36px 36px 32px',
            }}
          >
            {/* Heading */}
            <div className="mb-6">
              <h2 className="text-[28px] font-bold text-[#1E293B] leading-tight">
                {step === 'otp' ? 'Verify Your Login' : 'Sign in'}
              </h2>
              <p className="text-[15px] text-[#64748B] mt-1">
                {step === 'otp'
                  ? 'A 6-digit authentication code was sent to your verified email.'
                  : 'Enter your credentials to continue.'}
              </p>
              {step === 'otp' && maskedEmail ? (
                <p className="text-[14px] font-medium text-[#1E293B] mt-1.5">{maskedEmail}</p>
              ) : null}
            </div>

            {checkingChallenge ? (
              <div className="flex items-center justify-center py-10">
                <span className="w-6 h-6 border-2 border-[#2563EB]/30 border-t-[#2563EB] rounded-full animate-spin" aria-hidden="true" />
              </div>
            ) : step === 'otp' ? (
              <form onSubmit={handleVerifyOtp} noValidate>
                {error && (
                  <div
                    role="alert"
                    aria-live="polite"
                    className="flex items-start gap-2.5 bg-red-50 border border-red-200 text-red-700 px-3.5 py-3 rounded-[10px] text-[13px] leading-snug mb-4"
                  >
                    <svg className="w-[15px] h-[15px] mt-[1px] flex-shrink-0" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                      <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                    </svg>
                    <span>{error}</span>
                  </div>
                )}

                <div className="mb-5">
                  <label
                    htmlFor="login-otp"
                    className="block text-[13px] font-semibold text-[#374151] mb-[6px]"
                  >
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
                    className="w-full border border-[#E2E8F0] rounded-[10px] px-4 text-center text-[22px] font-semibold tracking-[0.45em] text-[#1E293B] bg-white placeholder:text-[#CBD5E1] placeholder:tracking-[0.45em] transition-all duration-150 focus:outline-none focus:border-[#2563EB] focus:ring-2 focus:ring-[#2563EB]/15"
                    style={{ height: '52px' }}
                  />
                </div>

                <button
                  type="submit"
                  disabled={loading || otpCode.length !== 6}
                  className="w-full bg-[#2563EB] hover:bg-[#1D4ED8] active:bg-[#1E40AF] disabled:opacity-60 disabled:cursor-not-allowed text-white font-semibold text-[15px] rounded-[10px] transition-all duration-150 flex items-center justify-center gap-2"
                  style={{ height: '48px' }}
                >
                  {loading ? (
                    <>
                      <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" aria-hidden="true" />
                      <span>Verifying…</span>
                    </>
                  ) : 'Verify Code'}
                </button>

                <button
                  type="button"
                  onClick={handleResend}
                  disabled={loading || resendIn > 0}
                  className="w-full mt-3 text-[13px] font-semibold text-[#2563EB] hover:text-[#1D4ED8] disabled:text-[#94A3B8] disabled:cursor-not-allowed transition-colors"
                  style={{ height: '40px' }}
                >
                  {resendIn > 0 ? `Resend available in ${resendIn} seconds` : 'Resend Code'}
                </button>

                <button
                  type="button"
                  onClick={handleBackToLogin}
                  disabled={loading}
                  className="w-full text-[13px] font-medium text-[#64748B] hover:text-[#1E293B] transition-colors"
                  style={{ height: '36px' }}
                >
                  Back to Login
                </button>
              </form>
            ) : (
            <>
            {/* Role segmented control */}
            <div className="mb-5">
              <p className="text-[13px] font-semibold text-[#374151] mb-2">Role</p>
              <div
                role="group"
                aria-label="Select role"
                className="flex bg-[#F3F4F6] rounded-[10px] p-[3px] gap-[3px]"
              >
                {ROLES.map(r => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => selectRole(r.id)}
                    aria-pressed={role === r.id}
                    className={[
                      'flex-1 text-[13px] font-semibold rounded-[7px] transition-all duration-150 whitespace-nowrap',
                      role === r.id
                        ? 'bg-white text-[#2563EB] shadow-sm border border-[#E2E8F0]'
                        : 'text-[#6B7280] hover:text-[#1E293B] border border-transparent',
                    ].join(' ')}
                    style={{ height: '40px' }}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Form */}
            <form onSubmit={handleSubmit} noValidate>

              {/* Error alert */}
              {error && (
                <div
                  role="alert"
                  aria-live="polite"
                  className="flex items-start gap-2.5 bg-red-50 border border-red-200 text-red-700 px-3.5 py-3 rounded-[10px] text-[13px] leading-snug mb-4"
                >
                  <svg className="w-[15px] h-[15px] mt-[1px] flex-shrink-0" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                    <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                  </svg>
                  <span>{error}</span>
                </div>
              )}

              {/* Username */}
              <div className="mb-4">
                <label
                  htmlFor="login-username"
                  className="block text-[13px] font-semibold text-[#374151] mb-[6px]"
                >
                  {usernameLabel}
                </label>
                <input
                  id="login-username"
                  type="text"
                  value={form.username}
                  onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
                  placeholder={usernamePlaceholder}
                  autoComplete="username"
                  className="w-full border border-[#E2E8F0] rounded-[10px] px-4 text-[15px] text-[#1E293B] bg-white placeholder:text-[#9CA3AF] transition-all duration-150 focus:outline-none focus:border-[#2563EB] focus:ring-2 focus:ring-[#2563EB]/15"
                  style={{ height: '48px' }}
                />
              </div>

              {/* Password */}
              <div className="mb-4">
                <label
                  htmlFor="login-password"
                  className="block text-[13px] font-semibold text-[#374151] mb-[6px]"
                >
                  Password
                </label>
                <div className="relative">
                  <input
                    id="login-password"
                    type={showPassword ? 'text' : 'password'}
                    value={form.password}
                    onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                    placeholder="Enter your password"
                    autoComplete="current-password"
                    className="w-full border border-[#E2E8F0] rounded-[10px] px-4 pr-11 text-[15px] text-[#1E293B] bg-white placeholder:text-[#9CA3AF] transition-all duration-150 focus:outline-none focus:border-[#2563EB] focus:ring-2 focus:ring-[#2563EB]/15"
                    style={{ height: '48px' }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(p => !p)}
                    tabIndex={-1}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9CA3AF] hover:text-[#64748B] transition-colors p-1 rounded-md"
                  >
                    {showPassword
                      ? <EyeOff className="w-[17px] h-[17px]" />
                      : <Eye    className="w-[17px] h-[17px]" />}
                  </button>
                </div>
              </div>

              {/* Remember Me + Forgot Password */}
              <div className="flex items-center justify-between mb-5">
                <label className="flex items-center gap-2 cursor-pointer select-none group">
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={e => setRememberMe(e.target.checked)}
                    className="w-4 h-4 rounded border-[#D1D5DB] cursor-pointer accent-[#2563EB]"
                  />
                  <span className="text-[13px] text-[#64748B] group-hover:text-[#374151] transition-colors">
                    Remember me
                  </span>
                </label>
                <button
                  type="button"
                  className="text-[13px] font-semibold text-[#2563EB] hover:text-[#1D4ED8] transition-colors"
                >
                  Forgot password?
                </button>
              </div>

              {/* Sign In */}
              <button
                type="submit"
                disabled={loading || googleLoading}
                className="w-full bg-[#2563EB] hover:bg-[#1D4ED8] active:bg-[#1E40AF] disabled:opacity-60 disabled:cursor-not-allowed text-white font-semibold text-[15px] rounded-[10px] transition-all duration-150 flex items-center justify-center gap-2"
                style={{ height: '48px' }}
              >
                {loading ? (
                  <>
                    <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" aria-hidden="true" />
                    <span>Signing in…</span>
                  </>
                ) : 'Sign In'}
              </button>
            </form>

            {role === 'instructor' && (
              <div className="mt-5">
                <div className="flex items-center gap-3 mb-5" aria-hidden="true">
                  <div className="flex-1 h-px bg-[#E2E8F0]" />
                  <span className="text-[12px] font-medium text-[#94A3B8] uppercase tracking-wide">or</span>
                  <div className="flex-1 h-px bg-[#E2E8F0]" />
                </div>
                {process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ? (
                  <div className="flex flex-col items-center">
                    <div
                      ref={googleBtnRef}
                      className={`w-full flex justify-center ${googleLoading ? 'pointer-events-none opacity-60' : ''}`}
                    />
                    {googleLoading && (
                      <p className="mt-2 text-[12px] text-[#64748B]">Signing in with Google…</p>
                    )}
                    <p className="mt-2.5 text-center text-[11px] text-[#94A3B8] leading-snug">
                      Use the Google account already verified for this Instructor account.
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

            {/* Card footer */}
            <p className="mt-7 text-center text-[11px] text-[#94A3B8] font-medium tracking-wide">
              North Eastern Mindanao State University
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

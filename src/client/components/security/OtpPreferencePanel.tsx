'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle, Eye, EyeOff, Loader2, ShieldCheck, X } from 'lucide-react';
import { useLiveCountdown } from '@/client/hooks/useLiveCountdown';
import { formatOtpCooldownMessage, parseOtpCooldownSeconds } from '@/lib/otpCooldown';

type OtpStatus = {
  otp_enabled: boolean;
  google_verified: boolean;
  email: string | null;
  can_enable: boolean;
  requires_google_verification: boolean;
};

/** idle → password → otp → success */
type DisableStage = 'idle' | 'password' | 'otp' | 'success';

const DEFAULT_CODE_LENGTH = 6;

export default function OtpPreferencePanel({
  variant = 'light',
  embedded = false,
}: {
  variant?: 'light' | 'dark';
  embedded?: boolean;
}) {
  const [status, setStatus] = useState<OtpStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stage, setStage] = useState<DisableStage>('idle');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [maskedEmail, setMaskedEmail] = useState('');
  const [codeLength, setCodeLength] = useState(DEFAULT_CODE_LENGTH);
  const cooldown = useLiveCountdown();

  const dark = variant === 'dark';

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await fetch('/api/account/security/otp');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Unable to load security settings.');
        setStatus(null);
        return;
      }
      setStatus({
        otp_enabled: data.otp_enabled === true,
        google_verified: data.google_verified === true,
        email: data.email ?? null,
        can_enable: data.can_enable === true,
        requires_google_verification: data.requires_google_verification === true,
      });
    } catch {
      setError('Unable to load security settings.');
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function resetDisableFlow() {
    setStage('idle');
    setPassword('');
    setShowPw(false);
    setOtpCode('');
    setMaskedEmail('');
    cooldown.clear();
    setError('');
  }

  async function cancelDisableChallenge() {
    await fetch('/api/account/security/otp/disable', { method: 'DELETE' }).catch(() => {});
  }

  function applyCooldownFromResponse(data: Record<string, unknown>, headers?: Headers) {
    const wait = parseOtpCooldownSeconds(data, headers);
    if (wait > 0) {
      cooldown.start(wait);
      setError('');
      return true;
    }
    return false;
  }

  async function enableOtp() {
    if (!status || busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/account/security/otp', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ otp_enabled: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Could not enable Two-Step Verification.');
        return;
      }
      setStatus({
        otp_enabled: data.otp_enabled === true,
        google_verified: data.google_verified === true,
        email: data.email ?? null,
        can_enable: data.can_enable === true,
        requires_google_verification: data.requires_google_verification === true,
      });
    } catch {
      setError('Could not enable Two-Step Verification.');
    } finally {
      setBusy(false);
    }
  }

  async function continueWithPassword() {
    if (!status || busy) return;
    if (!password.trim()) {
      setError('Enter your current password to continue.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/account/security/otp/disable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (applyCooldownFromResponse(data, res.headers)) return;
        setError(data.error || 'Incorrect password.');
        return;
      }
      setPassword('');
      setMaskedEmail(String(data.masked_email || data.maskedEmail || ''));
      setCodeLength(Number(data.code_length) > 0 ? Number(data.code_length) : DEFAULT_CODE_LENGTH);
      cooldown.start(Number(data.resend_after) > 0 ? Number(data.resend_after) : 0);
      setOtpCode('');
      setStage('otp');
    } catch {
      setError('Unable to start verification. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function confirmDisableWithOtp() {
    if (!status || busy) return;
    const digits = otpCode.replace(/\D/g, '');
    if (digits.length !== codeLength) {
      setError(`Enter the ${codeLength}-digit verification code.`);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/account/security/otp/disable', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: digits }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Invalid verification code.');
        return;
      }
      if (data.otp_enabled === true) {
        setError('Could not turn off Two-Step Verification. Please try again.');
        return;
      }
      setStatus(s =>
        s
          ? {
              ...s,
              otp_enabled: false,
            }
          : s
      );
      setStage('success');
      setOtpCode('');
      setMaskedEmail('');
      cooldown.clear();
      void load();
    } catch {
      setError('Unable to verify code. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function resendCode() {
    if (busy || cooldown.active) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/account/security/otp/disable', { method: 'PATCH' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (applyCooldownFromResponse(data, res.headers)) {
          if (res.status === 401) {
            setStage('password');
            setOtpCode('');
          }
          return;
        }
        setError(data.error || 'Unable to resend code.');
        if (res.status === 401) {
          setStage('password');
          setOtpCode('');
        }
        return;
      }
      setMaskedEmail(String(data.masked_email || data.maskedEmail || maskedEmail));
      cooldown.start(Number(data.resend_after) > 0 ? Number(data.resend_after) : 60);
      if (Number(data.code_length) > 0) setCodeLength(Number(data.code_length));
    } catch {
      setError('Unable to resend code.');
    } finally {
      setBusy(false);
    }
  }

  function onToggleClick() {
    if (!status || busy) return;
    setError('');
    if (status.otp_enabled) {
      setStage('password');
      setPassword('');
      setOtpCode('');
      return;
    }
    void enableOtp();
  }

  async function onCancelDisable() {
    if (busy) return;
    if (stage === 'otp') await cancelDisableChallenge();
    resetDisableFlow();
  }

  async function onBackToPassword() {
    if (busy) return;
    await cancelDisableChallenge();
    setStage('password');
    setOtpCode('');
    setMaskedEmail('');
    cooldown.clear();
    setError('');
  }

  const shell = dark
    ? embedded
      ? ''
      : 'rounded-xl border border-white/10 bg-white/[0.03] overflow-hidden'
    : embedded
      ? ''
      : 'rounded-2xl border border-[#E2E8F0] bg-white shadow-sm overflow-hidden';

  const titleCls = dark ? 'text-slate-100' : 'text-[#1E3A5F]';
  const mutedCls = dark ? 'text-slate-400' : 'text-[#64748B]';
  const subtleCls = dark ? 'text-slate-500' : 'text-[#94A3B8]';
  const borderCls = dark ? 'border-white/10' : 'border-[#E2E8F0]';
  const errCls = dark
    ? 'bg-red-500/10 border-red-500/20 text-red-400'
    : 'bg-red-50 border-red-200 text-red-600';
  const hintCls = dark
    ? 'bg-amber-500/10 border-amber-500/20 text-amber-300'
    : 'bg-amber-50 border-amber-200 text-amber-700';
  const okCls = dark
    ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
    : 'bg-emerald-50 border-emerald-200 text-emerald-700';
  const inputCls = dark
    ? 'w-full rounded-xl border border-white/10 bg-white/5 px-3.5 py-2.5 pr-10 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-[#3C91E6]'
    : 'w-full rounded-xl border border-[#CBD5E1] bg-white px-3.5 py-2.5 pr-10 text-sm text-[#1E3A5F] placeholder-[#CBD5E1] focus:outline-none focus:ring-2 focus:ring-[#3C91E6] focus:border-[#3C91E6]';
  const otpInputCls = dark
    ? 'w-full max-w-full rounded-xl border border-white/10 bg-white/5 px-3.5 py-2.5 text-sm tracking-[0.35em] text-center text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-[#3C91E6]'
    : 'w-full max-w-full rounded-xl border border-[#CBD5E1] bg-white px-3.5 py-2.5 text-sm tracking-[0.35em] text-center text-[#1E3A5F] placeholder-[#CBD5E1] focus:outline-none focus:ring-2 focus:ring-[#3C91E6] focus:border-[#3C91E6]';

  if (loading) {
    return (
      <div className={`${shell} flex items-center justify-center py-10`}>
        <Loader2 className={`w-5 h-5 animate-spin ${subtleCls}`} />
      </div>
    );
  }

  const enabled = status?.otp_enabled === true;
  const disabling = stage === 'password' || stage === 'otp' || stage === 'success';
  const showCooldown = cooldown.active;
  const showError = Boolean(error) && !showCooldown;

  return (
    <div className={shell}>
      <div className="p-5 sm:p-6 space-y-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex items-center gap-2">
              <ShieldCheck className={`w-4 h-4 flex-shrink-0 ${enabled ? 'text-emerald-500' : mutedCls}`} />
              <h3 className={`text-sm font-semibold ${titleCls}`}>Two-Step Verification</h3>
            </div>
            <p className={`text-xs font-medium ${mutedCls}`}>Email OTP</p>
            <p className={`text-sm leading-relaxed ${mutedCls}`}>
              Protect your account with an additional verification code during sign-in.
            </p>
            <p className={`text-xs ${subtleCls}`}>
              Status:{' '}
              <span className={enabled ? 'text-emerald-600 font-semibold' : 'font-semibold'}>
                {enabled ? 'On' : 'Off'}
              </span>
            </p>
          </div>

          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label="Two-Step Verification"
            disabled={busy || disabling || (!enabled && status?.can_enable === false)}
            onClick={onToggleClick}
            className={`relative inline-flex h-7 w-12 flex-shrink-0 items-center rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              enabled ? 'bg-emerald-500' : dark ? 'bg-white/15' : 'bg-[#CBD5E1]'
            }`}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${
                enabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>

        {(showError || showCooldown) && (
          <div className={`flex items-start gap-2 border px-3.5 py-3 rounded-xl text-sm ${errCls}`}>
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span className="flex-1 min-w-0 break-words">
              {showCooldown ? formatOtpCooldownMessage(cooldown.seconds) : error}
            </span>
            {!showCooldown && (
              <button type="button" onClick={() => setError('')} aria-label="Dismiss">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        )}

        {!enabled && status && !status.can_enable && stage === 'idle' && (
          <div className={`border px-3.5 py-3 rounded-xl text-sm ${hintCls}`}>
            {status.requires_google_verification
              ? 'Verify your Google email account before enabling Two-Step Verification.'
              : 'Add a valid email address to your account before enabling Two-Step Verification.'}
          </div>
        )}

        {stage === 'password' && (
          <div className={`rounded-xl border ${borderCls} p-4 space-y-3`}>
            <p className={`text-sm font-semibold ${titleCls}`}>Turn off Two-Step Verification?</p>
            <p className={`text-sm ${mutedCls}`}>
              For your security, confirm your current password first.
            </p>
            <div>
              <label className={`block text-xs font-semibold uppercase tracking-wide mb-1.5 ${mutedCls}`}>
                Current Password
              </label>
              <div className="relative">
                <input
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Current password"
                  autoComplete="current-password"
                  className={inputCls}
                  disabled={busy}
                  onKeyDown={e => {
                    if (e.key === 'Enter') void continueWithPassword();
                  }}
                />
                <button
                  type="button"
                  onClick={() => setShowPw(s => !s)}
                  className={`absolute right-3 top-1/2 -translate-y-1/2 ${subtleCls}`}
                  aria-label={showPw ? 'Hide password' : 'Show password'}
                >
                  {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
            <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
              <button
                type="button"
                disabled={busy}
                onClick={() => void onCancelDisable()}
                className={`min-h-11 px-4 py-2.5 rounded-xl text-sm font-semibold ${mutedCls} hover:opacity-80`}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy || !password.trim() || cooldown.active}
                onClick={() => void continueWithPassword()}
                className="inline-flex min-h-11 items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold bg-[#3C91E6] hover:bg-[#2563EB] disabled:opacity-50 text-white"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                Continue
              </button>
            </div>
          </div>
        )}

        {stage === 'otp' && (
          <div className={`rounded-xl border ${borderCls} p-4 space-y-3`}>
            <p className={`text-sm font-semibold ${titleCls}`}>Verify Your Identity</p>
            <p className={`text-sm ${mutedCls}`}>
              We sent a verification code to your verified email.
            </p>
            {maskedEmail && (
              <p className={`text-sm font-medium break-all ${titleCls}`}>{maskedEmail}</p>
            )}
            <div>
              <label className={`block text-xs font-semibold uppercase tracking-wide mb-1.5 ${mutedCls}`}>
                Verification Code
              </label>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={otpCode}
                onChange={e => {
                  const next = e.target.value.replace(/\D/g, '').slice(0, codeLength);
                  setOtpCode(next);
                }}
                placeholder={'_ '.repeat(codeLength).trim()}
                className={otpInputCls}
                disabled={busy}
                maxLength={codeLength}
                onKeyDown={e => {
                  if (e.key === 'Enter') void confirmDisableWithOtp();
                }}
              />
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={busy || cooldown.active}
                onClick={() => void resendCode()}
                className={`text-sm font-semibold ${
                  cooldown.active ? subtleCls : 'text-[#3C91E6] hover:text-[#2563EB]'
                } disabled:opacity-50`}
              >
                {cooldown.active ? `Resend in ${cooldown.seconds}s` : 'Resend code'}
              </button>
            </div>
            <p className={`text-xs ${subtleCls}`}>
              Trusted devices for OTP will also be cleared after this change.
            </p>
            <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
              <button
                type="button"
                disabled={busy}
                onClick={() => void onBackToPassword()}
                className={`min-h-11 px-4 py-2.5 rounded-xl text-sm font-semibold ${mutedCls} hover:opacity-80`}
              >
                Back
              </button>
              <button
                type="button"
                disabled={busy || otpCode.replace(/\D/g, '').length !== codeLength}
                onClick={() => void confirmDisableWithOtp()}
                className="inline-flex min-h-11 items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                Turn Off OTP
              </button>
            </div>
          </div>
        )}

        {stage === 'success' && (
          <div className={`flex items-start gap-2 border px-3.5 py-3 rounded-xl text-sm ${okCls}`}>
            <CheckCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1 space-y-1">
              <p className="font-semibold">Two-Step Verification Turned Off</p>
              <p>Email OTP will no longer be required during sign-in.</p>
              <button
                type="button"
                onClick={resetDisableFlow}
                className="text-xs font-semibold underline underline-offset-2 mt-1"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

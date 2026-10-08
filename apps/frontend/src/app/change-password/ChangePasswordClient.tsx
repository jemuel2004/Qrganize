'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, Circle, Eye, EyeOff, KeyRound, Lock, LogOut, ShieldAlert } from 'lucide-react';
import { headingFont } from '@/lib/fonts';

/** Sets the new password (no current password: the sign-in just proved it) */
const ENDPOINT = '/api/auth/change-default-password';

/** Ends this session and asks for a fresh sign-in (the page only works right after signing in) */
async function signInAgain() {
  try { await fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch { /* still go */ }
  window.location.replace('/login?again=1');
}

/* The box shows focus (globals.css strips every focus style from inputs in light mode). No animation on this page. */
const boxCls =
  'relative rounded-xl border border-[#D6E0EF] bg-[#FBFCFE] focus-within:bg-white focus-within:border-[#1D5BD6] focus-within:ring-4 focus-within:ring-[#1D5BD6]/15';
const inputCls =
  'w-full rounded-xl border-0 bg-transparent pl-11 pr-12 text-base text-[#0B2A5B] placeholder:text-[#94A3B8] focus:outline-none';

function PasswordField({ id, label, value, onChange, autoFocus }: {
  id: string; label: string; value: string; onChange: (v: string) => void; autoFocus?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <div>
      <label htmlFor={id} className="block text-[15px] font-semibold text-[#0B2A5B] mb-2">{label}</label>
      <div className={boxCls}>
        <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-[18px] h-[18px] text-[#5B6F8C] pointer-events-none" aria-hidden="true" />
        {/* autoComplete off: browsers must not suggest a random password and save it before
            Change Password is clicked — the saved one would then fill the sign-in page
            while the account still has its old password */}
        <input
          id={id}
          name={id}
          type={show ? 'text' : 'password'}
          value={value}
          onChange={e => onChange(e.target.value)}
          autoComplete="off"
          data-lpignore="true"
          data-1p-ignore="true"
          autoFocus={autoFocus}
          className={inputCls}
          style={{ height: '52px' }}
        />
        <button
          type="button"
          onClick={() => setShow(s => !s)}
          tabIndex={-1}
          aria-label={show ? 'Hide password' : 'Show password'}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-[#5B6F8C] hover:text-[#0B2A5B] p-1.5 rounded-md"
        >
          {show ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
        </button>
      </div>
    </div>
  );
}

/** One rule of the new password — ticks green once it is met */
function Rule({ met, children }: { met: boolean; children: React.ReactNode }) {
  return (
    <li className={`flex items-center gap-2.5 text-[15px] ${met ? 'text-[#047857]' : 'text-[#5B6F8C]'}`}>
      {met
        ? <CheckCircle2 className="w-[18px] h-[18px] flex-shrink-0" aria-hidden="true" />
        : <Circle className="w-[18px] h-[18px] flex-shrink-0 text-[#B8C6DC]" aria-hidden="true" />}
      <span>{children}</span>
      <span className="sr-only">{met ? '(done)' : '(not yet)'}</span>
    </li>
  );
}

export default function ChangePasswordClient() {
  const [ready, setReady] = useState(false);
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const longEnough = next.length >= 8;
  const mixed = /[A-Za-z]/.test(next) && /[^A-Za-z]/.test(next);
  const matches = next.length > 0 && next === confirm;

  // Same light look as the sign-in page, whatever theme the account uses
  useEffect(() => {
    document.documentElement.classList.add('light');
  }, []);

  useEffect(() => {
    fetch('/api/auth/session', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!d?.role) { window.location.replace('/login'); return; }
        if (!d.must_change_password) { window.location.replace('/'); return; }
        // Signed in a while ago (a browser left open): sign in again first
        if (d.recent_sign_in === false) { void signInAgain(); return; }
        setReady(true);
      })
      .catch(() => setError('Unable to reach the server. Please check your connection.'));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    if (!longEnough) { setError('Your new password must be at least 8 characters.'); return; }
    if (!mixed) { setError('Mix letters with numbers or symbols.'); return; }
    if (next !== confirm) { setError('The new passwords do not match.'); return; }
    setSaving(true);
    setError('');
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_password: next, confirm_password: confirm }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.code === 'REAUTH_REQUIRED') { void signInAgain(); return; }
      if (!res.ok) { setError(data.error || 'Could not change the password. Please try again.'); return; }
      // Every session ends with the old password — sign in again with the new one
      window.location.replace('/login?changed=1');
    } catch {
      setError('Unable to reach the server. Please check your connection.');
    } finally {
      setSaving(false);
    }
  }

  async function signOut() {
    setSigningOut(true);
    try { await fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch { /* still leave */ }
    window.location.replace('/login');
  }

  return (
    <div className="min-h-dvh bg-[#F4F7FC] flex flex-col items-center justify-center px-4 py-8">
      <div className="flex items-center gap-3 mb-6">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/nemlogo/NEMSU-logo.png" alt="" className="w-12 h-12 object-contain" />
        <div>
          <p className={`${headingFont.className} text-[22px] font-bold text-[#0B2A5B] leading-none`}>Qrganize</p>
          <p className="text-[12px] text-[#22406F] font-medium tracking-[0.4em] uppercase mt-1">NEMSU</p>
        </div>
      </div>

      <div
        className="w-full max-w-[460px] bg-white border border-[#E3E9F3] rounded-3xl overflow-hidden"
        style={{ boxShadow: '0 1px 3px rgba(11,42,91,0.05), 0 24px 60px -20px rgba(11,42,91,0.28)' }}
      >
        {/* 1 — What this page is */}
        <div className="px-5 sm:px-8 pt-6 sm:pt-7 pb-5 border-b border-[#EEF2F8]">
          <div className="flex items-center gap-3.5">
            <span className="w-11 h-11 rounded-xl bg-[#EFF6FF] flex items-center justify-center flex-shrink-0" aria-hidden="true">
              <KeyRound className="w-6 h-6 text-[#1D5BD6]" strokeWidth={2} />
            </span>
            <div className="min-w-0">
              <h1 className={`${headingFont.className} text-[21px] sm:text-[24px] font-bold text-[#0B2A5B] leading-tight`}>Change Your Password</h1>
              <p className="text-[15px] text-[#5B6F8C] mt-0.5">Set a new password to continue.</p>
            </div>
          </div>
          <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3 text-[15px] leading-snug text-[#92400E]">
            <ShieldAlert className="w-5 h-5 flex-shrink-0 mt-px" aria-hidden="true" />
            <span>Your account uses a default or common password.</span>
          </div>
        </div>

        <form onSubmit={submit} noValidate className="px-5 sm:px-8 pt-5 pb-6">
          {error && (
            <div role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-3.5 py-3 text-[15px] leading-snug text-red-700">
              {error}
            </div>
          )}

          {/* 2 — The new password, twice */}
          <div className="space-y-4">
            <PasswordField id="cp-new" label="New password" value={next} onChange={setNext} autoFocus />
            <PasswordField id="cp-confirm" label="Confirm new password" value={confirm} onChange={setConfirm} />
          </div>

          {/* 3 — What the password needs */}
          <div className="mt-5 rounded-xl bg-[#F8FAFC] border border-[#EEF2F8] px-4 py-3.5">
            <p className="text-[13px] font-bold uppercase tracking-wide text-[#475569] mb-2.5">Your new password needs</p>
            <ul className="space-y-2">
              <Rule met={longEnough}>At least 8 characters</Rule>
              <Rule met={longEnough && mixed}>Letters with numbers or symbols</Rule>
              <Rule met={matches}>Both passwords match</Rule>
            </ul>
            <p className="mt-2.5 text-[14px] leading-snug text-[#5B6F8C]">
              Avoid names and easy passwords like &ldquo;password123&rdquo;.
            </p>
          </div>

          {/* 4 — Save */}
          <button
            type="submit"
            disabled={saving || !ready}
            className="mt-6 w-full font-semibold text-base rounded-xl flex items-center justify-center bg-[#1D5BD6] hover:bg-[#164BB5] disabled:opacity-60 disabled:cursor-not-allowed"
            style={{ height: '52px', color: '#FFFFFF' }}
          >
            {saving ? 'Saving…' : 'Change Password'}
          </button>
        </form>

        <div className="border-t border-[#EEF2F8] px-5 sm:px-8 py-3">
          <button
            type="button"
            onClick={signOut}
            disabled={signingOut}
            className="w-full h-11 inline-flex items-center justify-center gap-2 rounded-xl text-[15px] font-semibold text-[#22406F] hover:bg-[#F1F5F9] disabled:opacity-60"
          >
            <LogOut className="w-4 h-4" aria-hidden="true" /> Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

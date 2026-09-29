'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Monitor, Smartphone, Tablet, MapPin, Trash2, X, ShieldCheck, Globe,
} from 'lucide-react';
import { useScrollLock } from '@/hooks/useScrollLock';

type Device = {
  id: string;
  device_label: string;
  device_type?: string | null;
  os_name?: string | null;
  browser_name?: string | null;
  last_ip?: string | null;
  city?: string | null;
  region?: string | null;
  country?: string | null;
  location_label?: string | null;
  last_used_at: string;
  expires_at: string;
  created_at: string;
  is_current: boolean;
  is_trusted?: boolean;
  session_status?: 'current' | 'active' | 'known';
  activity_label?: string;
};

function formatWhen(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  if (diffMs < 2 * 60 * 1000) return 'Active now';
  if (diffMs < 60 * 60 * 1000) {
    const mins = Math.max(1, Math.round(diffMs / 60000));
    return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  }

  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startThat = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDiff = Math.round((startToday - startThat) / 86400000);
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (dayDiff === 0) return `Today at ${time}`;
  if (dayDiff === 1) return `Yesterday at ${time}`;
  return date.toLocaleString(undefined, {
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function DeviceIcon({ type, className }: { type?: string | null; className?: string }) {
  if (type === 'mobile') return <Smartphone className={className} />;
  if (type === 'tablet') return <Tablet className={className} />;
  return <Monitor className={className} />;
}

function locationLine(device: Device): string {
  return device.location_label || 'Location unavailable';
}

export default function TrustedDevicesPanel({
  variant = 'light',
  embedded = false,
}: {
  variant?: 'light' | 'dark';
  embedded?: boolean;
}) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [confirmOthers, setConfirmOthers] = useState(false);
  const [detail, setDetail] = useState<Device | null>(null);
  useScrollLock(Boolean(confirmId || confirmOthers || detail));

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await fetch('/api/auth/trusted-devices');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? 'Unable to load login activity.');
        return;
      }
      setDevices(data.devices ?? []);
    } catch {
      setError('Unable to load login activity.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const current = useMemo(() => devices.filter(d => d.is_current), [devices]);
  const others = useMemo(() => devices.filter(d => !d.is_current), [devices]);

  async function removeDevice(id: string) {
    setBusyId(id);
    setError('');
    try {
      const res = await fetch(`/api/auth/trusted-devices/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? 'Failed to log out device.');
        return;
      }
      setDevices(list => list.filter(d => d.id !== id));
      setConfirmId(null);
      if (detail?.id === id) setDetail(null);
    } catch {
      setError('Failed to log out device.');
    } finally {
      setBusyId(null);
    }
  }

  async function removeOthers() {
    setBusyId('others');
    setError('');
    try {
      const res = await fetch('/api/auth/trusted-devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ others: true }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? 'Failed to log out other devices.');
        return;
      }
      setDevices(list => list.filter(d => d.is_current));
      setConfirmOthers(false);
      if (detail && !detail.is_current) setDetail(null);
    } catch {
      setError('Failed to log out other devices.');
    } finally {
      setBusyId(null);
    }
  }

  const dark = variant === 'dark';
  const card = embedded
    ? (dark ? 'text-slate-200' : 'text-[#0B2A5B]')
    : dark
      ? 'bg-white/5 border-white/10 text-slate-200'
      : 'bg-white border-[#E2E8F0] text-[#0B2A5B]';
  const muted = dark ? 'text-slate-400' : 'text-[#64748B]';
  const danger = dark
    ? 'text-red-300 hover:bg-red-500/10'
    : 'text-red-600 hover:bg-red-50';
  const rowBorder = dark ? 'border-white/10' : 'border-[#E2E8F0]';
  const rowHover = dark ? 'hover:bg-white/[0.03]' : 'hover:bg-[#F8FAFC]';
  const shell = embedded
    ? `space-y-5 ${card}`
    : `rounded-2xl border p-5 space-y-5 ${card}`;

  function DeviceRow({ device }: { device: Device }) {
    return (
      <div className={`rounded-xl border ${rowBorder} overflow-hidden`}>
        <button
          type="button"
          onClick={() => setDetail(device)}
          className={`w-full flex items-start gap-3 px-3.5 py-3 text-left transition-colors ${rowHover}`}
        >
          <div className={`mt-0.5 w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${dark ? 'bg-[#12408F]/15' : 'bg-[#EFF6FF]'}`}>
            <DeviceIcon type={device.device_type} className={`w-4 h-4 ${dark ? 'text-[#1D5BD6]' : 'text-[#12408F]'}`} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold truncate">{device.device_label}</p>
            <p className={`text-xs mt-0.5 flex items-center gap-1 ${muted}`}>
              <MapPin className="w-3 h-3 flex-shrink-0" />
              <span className="truncate">{locationLine(device)}</span>
            </p>
            {device.is_current ? (
              <span className="inline-flex items-center gap-1 mt-1.5 text-[10px] font-bold uppercase tracking-wide text-emerald-500">
                <ShieldCheck className="w-3 h-3" />
                {device.activity_label || 'Current session'}
              </span>
            ) : (
              <div className="mt-1.5 space-y-0.5">
                <p className={`text-xs ${muted}`}>
                  Last active: {formatWhen(device.last_used_at)}
                </p>
                <p className={`text-[11px] font-medium ${muted}`}>
                  {device.activity_label || 'Offline · Previously signed in'}
                </p>
              </div>
            )}
          </div>
        </button>
        {!device.is_current && (
          <div className={`px-3.5 py-2 border-t ${rowBorder} flex justify-end`}>
            <button
              type="button"
              onClick={() => setConfirmId(device.id)}
              disabled={busyId !== null}
              className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold ${danger} disabled:opacity-50`}
            >
              <Trash2 className="w-3.5 h-3.5" />
              Log Out
            </button>
          </div>
        )}
      </div>
    );
  }

  if (loading) {
    return (
      <div className={shell}>
        <p className={`text-sm ${muted}`}>Loading login activity…</p>
      </div>
    );
  }

  return (
    <div className={shell}>
      {!embedded && (
        <div>
          <p className="text-sm font-semibold">Where You&apos;re Logged In</p>
          <p className={`text-xs mt-1 ${muted}`}>
            You&apos;re currently logged in on these devices. Location is approximate and based on IP address.
          </p>
        </div>
      )}
      {embedded && (
        <p className={`text-xs ${muted}`}>
          You&apos;re currently logged in on these devices. Location is approximate (IP-based), not GPS.
        </p>
      )}

      {error && <p className="text-sm text-red-500">{error}</p>}

      {devices.length === 0 ? (
        <p className={`text-sm ${muted}`}>
          No devices listed yet. After a successful sign-in, this browser will appear here — including when it later goes offline.
        </p>
      ) : (
        <div className="space-y-5">
          {current.length > 0 && (
            <section className="space-y-2">
              <p className={`text-[11px] font-bold uppercase tracking-[0.14em] ${muted}`}>Current device</p>
              {current.map(device => <DeviceRow key={device.id} device={device} />)}
            </section>
          )}

          {others.length > 0 && (
            <section className="space-y-2">
              <p className={`text-[11px] font-bold uppercase tracking-[0.14em] ${muted}`}>Other devices</p>
              {others.map(device => <DeviceRow key={device.id} device={device} />)}
            </section>
          )}
        </div>
      )}

      {others.length > 0 && (
        <button
          type="button"
          onClick={() => setConfirmOthers(true)}
          disabled={busyId !== null}
          className={`text-xs font-semibold ${danger} disabled:opacity-50`}
        >
          Log out of other devices
        </button>
      )}

      {/* Confirm single logout */}
      {confirmId && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" data-modal-root>
          <button type="button" className="absolute inset-0 bg-black/50" aria-label="Close" onClick={() => setConfirmId(null)} />
          <div className={`relative w-full max-w-sm rounded-2xl border p-5 shadow-xl ${dark ? 'bg-[#111827] border-white/10' : 'bg-white border-[#E2E8F0]'}`}>
            <p className="text-sm font-bold">Log out this device?</p>
            <p className={`text-xs mt-2 leading-relaxed ${muted}`}>
              This device will need to sign in again and may require a verification code on the next password login.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmId(null)}
                className={`px-3 py-2 rounded-xl text-xs font-semibold ${dark ? 'text-slate-300 hover:bg-white/5' : 'text-[#64748B] hover:bg-[#F8FAFC]'}`}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busyId !== null}
                onClick={() => void removeDevice(confirmId)}
                className="px-3 py-2 rounded-xl text-xs font-bold bg-red-600 hover:bg-red-500 text-white disabled:opacity-50"
              >
                {busyId === confirmId ? 'Logging out…' : 'Log Out'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm others */}
      {confirmOthers && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" data-modal-root>
          <button type="button" className="absolute inset-0 bg-black/50" aria-label="Close" onClick={() => setConfirmOthers(false)} />
          <div className={`relative w-full max-w-sm rounded-2xl border p-5 shadow-xl ${dark ? 'bg-[#111827] border-white/10' : 'bg-white border-[#E2E8F0]'}`}>
            <p className="text-sm font-bold">Log out of other devices?</p>
            <p className={`text-xs mt-2 leading-relaxed ${muted}`}>
              Your current device stays signed in. Other listed devices will need to sign in again.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmOthers(false)}
                className={`px-3 py-2 rounded-xl text-xs font-semibold ${dark ? 'text-slate-300 hover:bg-white/5' : 'text-[#64748B] hover:bg-[#F8FAFC]'}`}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busyId !== null}
                onClick={() => void removeOthers()}
                className="px-3 py-2 rounded-xl text-xs font-bold bg-red-600 hover:bg-red-500 text-white disabled:opacity-50"
              >
                {busyId === 'others' ? 'Logging out…' : 'Log Out'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Detail drawer */}
      {detail && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" data-modal-root>
          <button type="button" className="absolute inset-0 bg-black/50" aria-label="Close" onClick={() => setDetail(null)} />
          <div className={`relative w-full max-w-md rounded-2xl overflow-hidden border shadow-xl max-h-[90vh] overflow-y-auto ${dark ? 'bg-[#111827] border-white/10' : 'bg-white border-[#E2E8F0]'}`}>
            <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-5 py-4" style={{ background: 'linear-gradient(120deg, #1D5BD6 0%, #0B2A5B 120%)' }}>
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-white/15 ring-1 ring-white/25">
                  <span style={{ color: "#FFFFFF" }} className="inline-flex"><DeviceIcon type={detail.device_type} className="w-5 h-5" /></span>
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-bold truncate" style={{ color: '#FFFFFF' }}>{detail.device_label}</p>
                  {detail.is_current && (
                    <p className="text-[10px] font-bold uppercase tracking-wide text-emerald-500">This device</p>
                  )}
                </div>
              </div>
              <button type="button" onClick={() => setDetail(null)} className="p-1.5 rounded-lg bg-white/15 hover:bg-white/25" style={{ color: '#FFFFFF' }} aria-label="Close">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-5 py-5 space-y-4">
              <DetailRow label="Device" value={detail.os_name || detail.device_label.split('—')[0]?.trim() || 'Unknown'} muted={muted} />
              <DetailRow label="Browser" value={detail.browser_name || 'Unknown'} muted={muted} />
              <DetailRow
                label="Approximate location"
                value={locationLine(detail)}
                muted={muted}
                hint="Based on IP address, not GPS."
              />
              {detail.last_ip && (
                <DetailRow label="IP address" value={detail.last_ip} muted={muted} />
              )}
              <DetailRow label="Last active" value={formatWhen(detail.last_used_at)} muted={muted} />
              <DetailRow
                label="Status"
                value={detail.activity_label || (detail.is_current ? 'Current session' : 'Offline · Previously signed in')}
                muted={muted}
              />
              <DetailRow
                label="Security"
                value={detail.is_trusted !== false ? 'Trusted device' : 'Authentication required'}
                muted={muted}
              />
              {!detail.is_current && (
                <button
                  type="button"
                  onClick={() => { setConfirmId(detail.id); }}
                  className="w-full mt-2 h-10 rounded-xl text-sm font-bold bg-red-600 hover:bg-red-500 text-white"
                >
                  Log Out
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DetailRow({
  label, value, muted, hint,
}: {
  label: string;
  value: string;
  muted: string;
  hint?: string;
}) {
  return (
    <div>
      <p className={`text-[11px] font-bold uppercase tracking-[0.14em] ${muted}`}>{label}</p>
      <p className="text-sm font-medium mt-1 flex items-start gap-2">
        {label.toLowerCase().includes('location') ? <Globe className={`w-3.5 h-3.5 mt-0.5 ${muted}`} /> : null}
        <span>{value}</span>
      </p>
      {hint ? <p className={`text-[11px] mt-1 ${muted}`}>{hint}</p> : null}
    </div>
  );
}

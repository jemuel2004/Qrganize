'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle, Info, Loader2, Send } from 'lucide-react';
import { useInstructorProfile } from '@/context/InstructorProfileContext';
import {
  NotificationsBlockedError, checkThisDevice, disableOnThisDevice, enableOnThisDevice,
  loadReminderSettings, notificationPermission, reminderSupport, saveReminderSettings, sendTestReminder,
  type ReminderSettings, type ReminderSupport,
} from '@/lib/classReminders';
import { REMINDER_LEADS } from '@shared/classReminderTiming';

/** White text on a blue button (the light theme recolours text-white) */
const ON_BLUE = { backgroundColor: '#1D5BD6', borderColor: '#1D5BD6', color: '#FFFFFF' } as const;

/** Why this browser cannot get reminders, and what to do instead */
const UNSUPPORTED: Record<Exclude<ReminderSupport, 'supported'>, string> = {
  'ios-home-screen':
    'On iPhone and iPad, reminders only work in QRganize added to the Home Screen (iOS 16.4 or later): in Safari tap Share → Add to Home Screen, open QRganize from the Home Screen, then turn reminders on there.',
  'in-app-browser':
    'This app’s built-in browser (Facebook, Messenger…) cannot show notifications. Open QRganize in Chrome or Safari, then turn reminders on there.',
  insecure: 'Reminders need QRganize’s secure address (one that starts with https://).',
  unsupported: 'This browser cannot show notifications from websites. Use Chrome, Edge, Firefox or Safari.',
};

const message = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

/**
 * Settings → Class Reminders: a notification on this device before each of the
 * faculty member's classes, like a calendar — also when QRganize is closed.
 * Permission is asked only when they turn reminders on.
 */
export default function ClassRemindersPanel() {
  const { facultyId } = useInstructorProfile();
  const [support, setSupport] = useState<ReminderSupport>('supported');
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>('default');
  const [settings, setSettings] = useState<ReminderSettings | null>(null);
  const [deviceOn, setDeviceOn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<null | 'switch' | 'lead' | 'test' | 'all-off'>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    const can = reminderSupport();
    setSupport(can);
    setPermission(notificationPermission());
    try {
      const next = await loadReminderSettings();
      setSettings(next);
      setDeviceOn(can === 'supported' ? await checkThisDevice(next.public_key, facultyId).catch(() => false) : false);
      setError('');
    } catch (e) {
      setError(message(e, 'Could not load your class reminder settings.'));
    } finally {
      setLoading(false);
    }
  }, [facultyId]);

  useEffect(() => { void load(); }, [load]);

  // Coming back from the browser's settings: show the permission as it is now
  useEffect(() => {
    const onFocus = () => setPermission(notificationPermission());
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  /** Turn on for this device — straight from the tap, so the browser may ask for permission */
  async function turnOn() {
    if (!settings?.public_key) {
      setError('Class reminders are not available right now. Please try again later.');
      return;
    }
    setBusy('switch');
    setError('');
    setNotice('');
    try {
      await enableOnThisDevice(settings.public_key, facultyId);
      setSettings(await saveReminderSettings({ enabled: true }));
      setDeviceOn(true);
      setNotice('Class reminders are on for this device.');
    } catch (e) {
      if (e instanceof NotificationsBlockedError) {
        if (notificationPermission() === 'default') {
          setError('QRganize needs your permission to show notifications. Tap the switch again and choose Allow.');
        }
      } else {
        setError(message(e, 'Could not turn on class reminders.'));
      }
    } finally {
      setPermission(notificationPermission());
      setBusy(null);
    }
  }

  /** Off: no reminders on any device; this device is forgotten too */
  async function turnOff(kind: 'switch' | 'all-off') {
    setBusy(kind);
    setError('');
    setNotice('');
    try {
      await saveReminderSettings({ enabled: false });
      await disableOnThisDevice();
      setSettings(await loadReminderSettings());
      setDeviceOn(false);
      setNotice('Class reminders are off.');
    } catch (e) {
      setError(message(e, 'Could not turn off class reminders.'));
    } finally {
      setBusy(null);
    }
  }

  async function chooseLead(lead: number) {
    if (!settings || settings.lead_minutes === lead || busy) return;
    const before = settings;
    setSettings({ ...settings, lead_minutes: lead });
    setBusy('lead');
    setError('');
    setNotice('');
    try {
      setSettings(await saveReminderSettings({ lead_minutes: lead }));
    } catch (e) {
      setSettings(before);
      setError(message(e, 'Could not save the reminder time.'));
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    setBusy('test');
    setError('');
    setNotice('');
    try {
      await sendTestReminder();
      setNotice('Test reminder sent — it should appear on this device in a few seconds.');
    } catch (e) {
      setError(message(e, 'Could not send a test reminder.'));
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="px-4 py-12 flex justify-center" role="status" aria-label="Loading class reminders">
        <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
      </div>
    );
  }

  const canUse = support === 'supported';
  const blocked = canUse && permission === 'denied';
  const accountOn = !!settings?.enabled;
  const on = accountOn && deviceOn;
  const otherDevices = Math.max(0, (settings?.devices ?? 0) - (deviceOn ? 1 : 0));

  return (
    <div className="px-4 py-5 sm:px-6 sm:py-6 space-y-5">
      {/* On / off for this device */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-[16px] font-bold text-white">Remind me before each class</p>
          <p className="text-[14px] text-slate-400 mt-1 leading-relaxed">
            A notification on this device before your class starts — even when QRganize is closed.
          </p>
          <p className="text-[14px] mt-2 font-semibold">
            {on ? (
              <span className="text-emerald-400">On for this device</span>
            ) : accountOn && otherDevices > 0 ? (
              <span className="text-amber-400">On for your other device{otherDevices === 1 ? '' : 's'} — not this one</span>
            ) : (
              <span className="text-slate-400">Off</span>
            )}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="Class reminders on this device"
          disabled={!canUse || (blocked && !on) || busy !== null}
          onClick={() => void (on ? turnOff('switch') : turnOn())}
          className={`relative inline-flex h-8 w-14 flex-shrink-0 items-center rounded-full transition-colors duration-300 disabled:opacity-50 disabled:cursor-not-allowed ${
            on ? 'bg-emerald-500' : 'bg-[#CBD5E1]'
          }`}
        >
          {busy === 'switch' ? (
            <Loader2 className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-4 h-4 animate-spin" style={{ color: '#FFFFFF' }} />
          ) : (
            <span
              className={`inline-block h-6 w-6 transform rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.25)] transition duration-300 ${
                on ? 'translate-x-7' : 'translate-x-1'
              }`}
            />
          )}
        </button>
      </div>

      {/* How long before class */}
      {accountOn && (
        <div>
          <p className="text-[15px] font-bold text-white mb-2">When to remind me</p>
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="When to remind me">
            {REMINDER_LEADS.map(lead => {
              const selected = settings?.lead_minutes === lead;
              return (
                <button
                  key={lead}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={busy !== null && busy !== 'lead'}
                  onClick={() => void chooseLead(lead)}
                  className={`min-h-14 rounded-xl border px-2 py-2 text-center transition-colors disabled:opacity-50 ${
                    selected ? '' : 'border-white/10 bg-white/5 text-slate-200 hover:bg-white/10'
                  }`}
                  style={selected ? ON_BLUE : undefined}
                >
                  <span className="block text-[17px] font-bold leading-tight">{lead} min</span>
                  <span className="block text-[12px] font-medium leading-tight mt-0.5">before class</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Notification permission in this browser */}
      {canUse && (
        <p className="text-[14px] text-slate-400">
          Notifications in this browser:{' '}
          <span className={`font-semibold ${permission === 'granted' ? 'text-emerald-400' : permission === 'denied' ? 'text-red-400' : 'text-slate-300'}`}>
            {permission === 'granted' ? 'Allowed' : permission === 'denied' ? 'Blocked' : 'Not asked yet'}
          </span>
        </p>
      )}

      {blocked && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3">
          <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5 text-amber-400" />
          <div className="text-[14px] leading-relaxed text-amber-300">
            <p className="font-bold">Notifications are blocked for QRganize in this browser.</p>
            <p className="mt-1">
              To allow them, tap the lock or settings icon beside the web address → Notifications → Allow.
              In the QRganize Home Screen app on iPhone: Settings → Notifications → QRganize → Allow Notifications.
              Then come back here and turn reminders on.
            </p>
          </div>
        </div>
      )}

      {!canUse && (
        <div className="flex items-start gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-3">
          <Info className="w-5 h-5 flex-shrink-0 mt-0.5 text-slate-400" />
          <p className="text-[14px] leading-relaxed text-slate-300">{UNSUPPORTED[support]}</p>
        </div>
      )}

      {on && (
        <button
          type="button"
          onClick={() => void test()}
          disabled={busy !== null}
          className="inline-flex items-center justify-center gap-2 min-h-12 w-full sm:w-auto px-5 rounded-xl border border-white/10 bg-white/5 text-[15px] font-semibold text-slate-200 hover:bg-white/10 transition-colors disabled:opacity-50"
        >
          {busy === 'test' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          Send a test reminder
        </button>
      )}

      {accountOn && !deviceOn && otherDevices > 0 && (
        <button
          type="button"
          onClick={() => void turnOff('all-off')}
          disabled={busy !== null}
          className="text-[14px] font-semibold text-red-400 hover:underline disabled:opacity-50"
        >
          {busy === 'all-off' ? 'Turning off…' : 'Turn off reminders on all my devices'}
        </button>
      )}

      {notice && (
        <div className="flex items-start gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3" role="status">
          <CheckCircle className="w-5 h-5 flex-shrink-0 mt-0.5 text-emerald-400" />
          <p className="text-[14px] font-medium text-emerald-400">{notice}</p>
        </div>
      )}
      {error && (
        <div className="flex items-start gap-3 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3" role="alert">
          <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5 text-red-400" />
          <p className="text-[14px] font-medium text-red-400">{error}</p>
        </div>
      )}

      <details className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3">
        <summary className="cursor-pointer text-[14px] font-semibold text-slate-300">Not getting reminders?</summary>
        <ul className="mt-2 space-y-1.5 pl-5 list-disc text-[14px] leading-relaxed text-slate-400">
          <li>Notifications must be allowed for this browser in your phone or computer’s settings, and Do Not Disturb / Focus must be off.</li>
          <li>iPhone and iPad: only QRganize added to the Home Screen (iOS 16.4 or later) can get them.</li>
          <li>Facebook and Messenger’s built-in browser cannot show them — use Chrome or Safari.</li>
          <li>Some Android phones stop notifications from apps closed by a battery saver — let your browser run in the background.</li>
          <li>A reminder can come a little late on a slow connection. None comes once the class has started, or on a day you made the classroom available.</li>
        </ul>
      </details>
    </div>
  );
}

'use client';

import { useEffect } from 'react';
import { useInstructorProfile } from '@/context/InstructorProfileContext';
import { checkThisDevice, deviceSubscription, loadReminderSettings } from '@/lib/classReminders';

/**
 * Once per visit on the faculty side: if this browser has class reminders set
 * up, make sure they belong to the faculty member signed in now (a shared
 * computer must never show someone else's classes) and still work. Does
 * nothing on a device that never turned reminders on. Renders nothing.
 */
export default function ReminderDeviceCheck() {
  const { facultyId } = useInstructorProfile();

  useEffect(() => {
    if (!facultyId) return;
    let cancelled = false;
    // After the page has loaded — this never competes with it
    const timer = window.setTimeout(() => {
      (async () => {
        const sub = await deviceSubscription();
        if (!sub || cancelled) return;
        const settings = await loadReminderSettings();
        if (cancelled) return;
        await checkThisDevice(settings.public_key, facultyId);
      })().catch(() => { /* checked again on the next visit */ });
    }, 4000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [facultyId]);

  return null;
}

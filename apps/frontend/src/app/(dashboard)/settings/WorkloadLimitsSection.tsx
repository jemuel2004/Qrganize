'use client';

/**
 * Settings → Workload Limits — the department's load policy: the Permanent
 * Regular Load and Overload limit (units) and the Contractual Regular Load
 * (hours). Every workload page, rule, status and alert uses these values.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Info, Loader2, RotateCcw } from 'lucide-react';
import { useToast } from '@/context/ToastContext';
import { useRealtime } from '@/context/RealtimeContext';
import { setWorkloadPolicyCache } from '@/hooks/useWorkloadPolicy';
import { Skeleton } from '@/components/ui/skeletons';
import {
  DEFAULT_WORKLOAD_POLICY, LOAD_GRACE_UNITS, WORKLOAD_POLICY_LIMITS,
  normalizeWorkloadPolicy, parseWorkloadPolicy, sameWorkloadPolicy,
  type WorkloadPolicy, type WorkloadPolicyField,
} from '@shared/regularLoad';

type Form = Record<WorkloadPolicyField, string>;

const WHITE = { color: '#FFFFFF' } as const;
const toForm = (p: WorkloadPolicy): Form => ({
  regularUnits: String(p.regularUnits),
  overloadUnits: String(p.overloadUnits),
  contractualHours: String(p.contractualHours),
});

const FIELDS: { field: WorkloadPolicyField; title: string; hint: string; step: number }[] = [
  {
    field: 'regularUnits', title: 'Regular load — Permanent', step: 0.25,
    hint: `Up to ${LOAD_GRACE_UNITS} unit above still counts as Regular.`,
  },
  {
    field: 'overloadUnits', title: 'Overload limit — Permanent', step: 0.25,
    hint: 'Per semester. 0 turns Overload off.',
  },
  {
    field: 'contractualHours', title: 'Regular load — Contractual', step: 0.5,
    hint: 'Contact hours per semester.',
  },
];

export default function WorkloadLimitsSection() {
  const toast = useToast();
  const reduceMotion = useReducedMotion();
  const [saved, setSaved] = useState<WorkloadPolicy | null>(null);
  const [form, setForm] = useState<Form>(toForm(DEFAULT_WORKLOAD_POLICY));
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState<{ field?: WorkloadPolicyField; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);

  const parsed = parseWorkloadPolicy(form);
  const dirty = !!saved && (!parsed.ok || !sameWorkloadPolicy(parsed.policy, saved));
  const isDefault = parsed.ok && sameWorkloadPolicy(parsed.policy, DEFAULT_WORKLOAD_POLICY);

  const dirtyRef = useRef(dirty);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/api/settings/workload-policy', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.policy) { setLoadError(data.error || 'Could not load the workload limits.'); return; }
      const policy = normalizeWorkloadPolicy(data.policy);
      setLoadError('');
      setSaved(policy);
      // Unsaved edits win — the form only follows while nothing is being edited
      if (!dirtyRef.current) setForm(toForm(policy));
    } catch {
      setLoadError('Connection error. Please try again.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  // Another admin changed the limits
  useRealtime(['settings'], load, { enabled: !saving });

  function setField(field: WorkloadPolicyField, value: string) {
    setForm(f => ({ ...f, [field]: value }));
    if (error?.field === field || !error?.field) setError(null);
  }

  async function save() {
    if (!parsed.ok) { setError({ field: parsed.field, message: parsed.error }); return; }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/settings/workload-policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed.policy),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError({ field: data.field, message: data.error || 'Could not save the workload limits.' }); return; }
      const policy = normalizeWorkloadPolicy(data.policy ?? parsed.policy);
      setSaved(policy);
      setForm(toForm(policy));
      setWorkloadPolicyCache(policy); // this tab's pages show the new limits at once
      setSuccess(true);
      window.setTimeout(() => {
        setSuccess(false);
        toast.success('Workload limits saved — every faculty load now uses them.');
      }, 1300);
    } catch {
      setError({ message: 'Connection error. Please try again.' });
    } finally {
      setSaving(false);
    }
  }

  if (loadError && !saved) {
    return <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{loadError}</p>;
  }

  if (!saved) {
    return (
      <div className="space-y-4" role="status" aria-label="Loading workload limits">
        {FIELDS.map(f => (
          <div key={f.field} className="flex items-center justify-between gap-4 rounded-2xl border border-[#E2E8F0] p-4">
            <div className="space-y-2 flex-1">
              <Skeleton className="h-4 w-48 rounded" />
              <Skeleton className="h-3 w-64 max-w-full rounded" />
            </div>
            <Skeleton className="h-12 w-36 rounded-xl" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="relative space-y-5">
      {success && (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-white/80 backdrop-blur-sm save-success-overlay">
          <div className="save-success-badge flex flex-col items-center gap-3 px-8 py-7 rounded-2xl bg-white border border-[#E2E8F0] shadow-xl">
            <svg width="72" height="72" viewBox="0 0 52 52" aria-hidden>
              <circle className="save-success-circle" cx="26" cy="26" r="24" fill="none" stroke="#16A34A" strokeWidth="3" />
              <path className="save-success-check" fill="none" stroke="#16A34A" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" d="M14.5 27 22 34.5 38 17" />
            </svg>
            <p className="text-base font-semibold text-[#0B2A5B]">Workload limits saved</p>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {FIELDS.map(({ field, title, hint, step }) => {
          const { min, max, unit } = WORKLOAD_POLICY_LIMITS[field];
          const invalid = error?.field === field;
          return (
            <label
              key={field}
              className={`flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-2xl border p-4 transition-colors ${
                invalid ? 'border-red-300 bg-red-50/60' : 'border-[#E2E8F0] bg-white'
              }`}
            >
              <span className="min-w-0">
                <span className="block text-[15px] font-bold text-[#0B2A5B]">{title}</span>
                <span className="block text-sm text-[#64748B] mt-0.5">
                  {hint} Default {DEFAULT_WORKLOAD_POLICY[field]} {unit}.
                </span>
              </span>
              <span className="flex items-center gap-2 flex-shrink-0">
                <input
                  type="number"
                  inputMode="decimal"
                  min={min}
                  max={max}
                  step={step}
                  value={form[field]}
                  onChange={e => setField(field, e.target.value)}
                  aria-invalid={invalid || undefined}
                  className={`h-12 w-28 rounded-xl border px-3 text-right text-lg font-bold tabular-nums text-[#0B2A5B] bg-white outline-none focus:ring-2 focus:ring-[#1D5BD6]/30 ${
                    invalid ? 'border-red-400' : 'border-[#CBD5E1] focus:border-[#1D5BD6]'
                  }`}
                />
                <span className="w-12 text-sm font-semibold text-[#475569]">{unit}</span>
              </span>
            </label>
          );
        })}
      </div>

      <p className="flex items-start gap-2 text-sm text-[#64748B]">
        <Info className="w-4 h-4 mt-0.5 flex-shrink-0 text-[#1D5BD6]" />
        Applies to every faculty right away — remaining loads, statuses, alerts and printed forms. Loads already assigned are kept.
      </p>

      {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">{error.message}</p>}

      <div className="flex flex-wrap items-center justify-between gap-3 pt-4 border-t border-[#EEF2F8]">
        <button
          type="button"
          disabled={saving || isDefault}
          onClick={() => { setForm(toForm(DEFAULT_WORKLOAD_POLICY)); setError(null); }}
          className="inline-flex items-center gap-2 h-11 px-4 rounded-xl text-sm font-semibold text-[#1D5BD6] hover:bg-[#EFF6FF] disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
        >
          <RotateCcw className="w-4 h-4" /> Use defaults
        </button>
        <div className="flex gap-3">
          <button
            type="button"
            disabled={!dirty || saving}
            onClick={() => { setForm(toForm(saved)); setError(null); }}
            className="h-11 px-5 rounded-xl text-sm font-semibold border border-[#D6E0EF] text-[#0B2A5B] bg-white hover:bg-[#F8FAFC] disabled:opacity-40 transition-colors"
          >
            Discard
          </button>
          <motion.button
            type="button"
            whileTap={reduceMotion ? undefined : { scale: 0.97 }}
            disabled={!dirty || saving}
            onClick={save}
            className="inline-flex items-center gap-2 h-11 px-6 rounded-xl text-sm font-semibold bg-[#1D5BD6] hover:bg-[#164BB5] disabled:opacity-40 transition-colors"
            style={WHITE}
          >
            {saving && <Loader2 className="w-4 h-4 animate-spin" style={WHITE} />}
            {saving ? 'Saving…' : 'Save'}
          </motion.button>
        </div>
      </div>
    </div>
  );
}

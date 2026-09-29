'use client';

/**
 * Settings → Day Combinations — the meeting-day sets (MWF, TTh, MTh, …) that
 * Scheduling may use in the active school year + semester. Saved per term;
 * no active combinations means scheduling is not restricted. Changing the
 * list never alters existing schedules — it governs new scheduling only.
 */

import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { CalendarDays, Info, Loader2, Plus, Trash2 } from 'lucide-react';
import { useSchoolYear } from '@/context/SchoolYearContext';
import { useToast } from '@/context/ToastContext';
import { fetchDayCombinations, invalidateDayCombinations } from '@/lib/dayCombinations';
import {
  DAY_COMBINATION_PRESETS, WEEK_DAYS, daysCode, daysKey, daysLabel, shortDay, sortDays, type WeekDay,
} from '@shared/dayCombination';

interface Row { key: string; days: WeekDay[]; is_active: boolean }

const EASE = [0.4, 0, 0.2, 1] as const;
const WHITE = { color: '#FFFFFF' } as const;
const toRow = (days: WeekDay[], is_active = true): Row => ({ key: daysKey(days), days, is_active });

export default function DayCombinationsSection() {
  const reduceMotion = useReducedMotion();
  const toast = useToast();
  const { schoolYear, semester } = useSchoolYear();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [saved, setSaved] = useState<string>('');
  const [picked, setPicked] = useState<WeekDay[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!schoolYear || !semester) return;
    let alive = true;
    invalidateDayCombinations();
    fetchDayCombinations(semester, schoolYear).then(d => {
      if (!alive) return;
      const list = d.combinations.map(c => toRow(c.days, c.is_active));
      setRows(list);
      setSaved(JSON.stringify(list));
    });
    return () => { alive = false; };
  }, [schoolYear, semester]);

  const dirty = rows !== null && JSON.stringify(rows) !== saved;
  const activeCount = rows?.filter(r => r.is_active).length ?? 0;
  const presets = useMemo(
    () => DAY_COMBINATION_PRESETS.filter(p => !rows?.some(r => r.key === daysKey(p))),
    [rows],
  );
  const pickedKey = picked.length ? daysKey(sortDays(picked)) : '';
  const pickedExists = !!pickedKey && !!rows?.some(r => r.key === pickedKey);

  function add(days: WeekDay[]) {
    const sorted = sortDays(days);
    if (!sorted.length) return;
    const key = daysKey(sorted);
    setRows(prev => (prev?.some(r => r.key === key) ? prev : [...(prev ?? []), toRow(sorted)]));
    setError('');
  }
  function toggleDay(d: WeekDay) {
    setPicked(p => (p.includes(d) ? p.filter(x => x !== d) : [...p, d]));
  }
  function addCustom() {
    if (!picked.length || pickedExists) return;
    add(picked);
    setPicked([]);
  }

  async function save() {
    if (!rows) return;
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/settings/day-combinations', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          academic_year: schoolYear, semester,
          combinations: rows.map(r => ({ days: r.days, is_active: r.is_active })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error || 'Could not save the day combinations.'); return; }
      const list = (data.combinations ?? []).map((c: { days: WeekDay[]; is_active: boolean }) => toRow(c.days, c.is_active));
      setRows(list);
      setSaved(JSON.stringify(list));
      invalidateDayCombinations(); // Scheduling / workload forms pick up the new list
      toast.success('Day combinations saved.');
    } catch {
      setError('Connection error. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  if (!schoolYear || !semester) {
    return (
      <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        Set the active school year and semester first (Settings → School Year).
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {/* Term + status */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="inline-flex items-center gap-2 h-10 px-3.5 rounded-xl border border-[#D6E0EF] bg-white text-[15px] font-semibold text-[#0B2A5B]">
          <CalendarDays className="w-4 h-4 text-[#1D5BD6]" /> Active for {semester} · A.Y. {schoolYear}
        </span>
        {rows && (
          <span className="text-sm text-[#64748B]">
            {activeCount > 0
              ? `${activeCount} allowed combination${activeCount !== 1 ? 's' : ''}`
              : 'No combinations switched on — scheduling may use any days.'}
          </span>
        )}
      </div>

      {/* Allowed Day Combinations */}
      <div>
        <p className="text-sm font-bold text-[#0B2A5B] mb-2.5">Allowed Day Combinations</p>
        {rows === null ? (
          <div className="flex items-center gap-2 text-sm text-[#64748B] py-4"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
        ) : rows.length === 0 ? (
          <p className="rounded-xl border border-dashed border-[#D6E0EF] px-4 py-6 text-center text-sm text-[#64748B]">
            No day combinations yet. Add the ones this semester uses below.
          </p>
        ) : (
          <ul className="rounded-xl border border-[#E3E9F3] divide-y divide-[#EEF2F7] overflow-hidden">
            <AnimatePresence initial={false}>
              {rows.map(r => (
                <motion.li
                  key={r.key}
                  layout={!reduceMotion}
                  initial={reduceMotion ? false : { opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 16 }}
                  transition={{ duration: 0.25, ease: EASE }}
                  className="flex items-center gap-3 px-4 py-3 bg-white"
                >
                  <span className={`min-w-[64px] h-9 px-2.5 rounded-lg flex items-center justify-center text-sm font-bold transition-colors ${
                    r.is_active ? '' : 'bg-[#F1F5F9] text-[#94A3B8]'
                  }`} style={r.is_active ? { backgroundColor: '#1D5BD6', ...WHITE } : undefined}>
                    {daysCode(r.days)}
                  </span>
                  <span className={`flex-1 min-w-0 text-[15px] font-semibold truncate ${r.is_active ? 'text-[#0B2A5B]' : 'text-[#94A3B8] line-through'}`}>
                    {daysLabel(r.days)}
                  </span>
                  {/* Active switch */}
                  <button
                    type="button"
                    role="switch"
                    aria-checked={r.is_active}
                    aria-label={`${daysCode(r.days)} ${r.is_active ? 'active' : 'off'}`}
                    onClick={() => setRows(prev => prev!.map(x => (x.key === r.key ? { ...x, is_active: !x.is_active } : x)))}
                    className="inline-flex items-center gap-2 text-sm font-semibold text-[#475569]"
                  >
                    <span className={`relative w-11 h-6 rounded-full transition-colors ${r.is_active ? 'bg-[#1D5BD6]' : 'bg-[#CBD5E1]'}`}>
                      <motion.span
                        className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow"
                        animate={{ x: r.is_active ? 20 : 0 }}
                        transition={{ duration: reduceMotion ? 0 : 0.2, ease: EASE }}
                      />
                    </span>
                    <span className="w-8 text-left">{r.is_active ? 'On' : 'Off'}</span>
                  </button>
                  <motion.button
                    type="button"
                    whileTap={reduceMotion ? undefined : { scale: 0.9 }}
                    onClick={() => setRows(prev => prev!.filter(x => x.key !== r.key))}
                    aria-label={`Remove ${daysCode(r.days)}`}
                    className="w-9 h-9 rounded-lg flex items-center justify-center text-[#94A3B8] hover:text-red-600 hover:bg-red-50 transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </motion.button>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </div>

      {/* Quick add */}
      {rows && presets.length > 0 && (
        <div>
          <p className="text-sm font-bold text-[#0B2A5B] mb-2.5">Common Combinations</p>
          <div className="flex flex-wrap gap-2">
            {presets.map(p => (
              <motion.button
                key={daysKey(p)}
                type="button"
                whileTap={reduceMotion ? undefined : { scale: 0.95 }}
                onClick={() => add(p)}
                title={daysLabel(p)}
                className="inline-flex items-center gap-1.5 h-10 px-3.5 rounded-xl border border-dashed border-[#9DB8E8] text-sm font-bold text-[#1D5BD6] hover:bg-[#EFF6FF] hover:border-[#1D5BD6] transition-colors"
              >
                <Plus className="w-4 h-4" /> {daysCode(p)}
              </motion.button>
            ))}
          </div>
        </div>
      )}

      {/* Add Custom Combination */}
      {rows && (
        <div>
          <p className="text-sm font-bold text-[#0B2A5B] mb-2.5">Add Custom Combination</p>
          <div className="flex flex-wrap items-center gap-2">
            {WEEK_DAYS.map(d => {
              const on = picked.includes(d);
              return (
                <motion.button
                  key={d}
                  type="button"
                  whileTap={reduceMotion ? undefined : { scale: 0.93 }}
                  onClick={() => toggleDay(d)}
                  aria-pressed={on}
                  className={`w-14 h-11 rounded-xl border text-sm font-bold transition-colors ${
                    on ? 'border-[#0B2A5B]' : 'bg-white border-[#D6E0EF] text-[#0B2A5B] hover:border-[#9DB8E8]'
                  }`}
                  style={on ? { backgroundColor: '#0B2A5B', ...WHITE } : undefined}
                >
                  {shortDay(d)}
                </motion.button>
              );
            })}
            <motion.button
              type="button"
              whileTap={reduceMotion ? undefined : { scale: 0.96 }}
              onClick={addCustom}
              disabled={!picked.length || pickedExists}
              className="inline-flex items-center gap-1.5 h-11 px-4 rounded-xl text-sm font-semibold bg-[#1D5BD6] hover:bg-[#164BB5] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              style={WHITE}
            >
              <Plus className="w-4 h-4" style={WHITE} /> Add {picked.length ? daysCode(sortDays(picked)) : ''}
            </motion.button>
          </div>
          {pickedExists && <p className="mt-1.5 text-xs font-medium text-amber-700">{daysCode(sortDays(picked))} is already in the list.</p>}
        </div>
      )}

      <p className="flex items-start gap-2 text-xs text-[#64748B]">
        <Info className="w-4 h-4 flex-shrink-0 text-[#1D5BD6]" />
        Scheduling for this semester can only use the combinations switched on. Existing schedules are not changed.
      </p>

      {error && <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">{error}</p>}

      <div className="flex justify-end gap-3 pt-4 border-t border-[#EEF2F8]">
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={() => { setRows(JSON.parse(saved)); setError(''); }}
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
  );
}

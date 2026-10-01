'use client';

import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Check, ChevronDown, X } from 'lucide-react';

export interface BlockOption {
  id: number;
  program_code: string;
  year_level: string;
  block_name: string;
}

const YEAR_ORDER = ['1st Year', '2nd Year', '3rd Year', '4th Year'];
const EASE = [0.4, 0, 0.2, 1] as const;

/** "BSIT 1A" */
function shortLabel(b: BlockOption) {
  const yr = (b.year_level.match(/\d/) ?? [''])[0];
  return `${b.program_code} ${yr}${b.block_name}`;
}

/**
 * "Blocks to Handle" — the blocks a faculty member is assigned to.
 * Folded by default (summary + removable tags); opened, pick a program tab,
 * then tap blocks by year level. Faculty Workload only offers these blocks.
 * `selected` may hold ids from other terms; only `blocks` (this term) are
 * shown, and other ids are kept untouched.
 */
export default function BlockMultiSelect({
  blocks, selected, onChange, loading, emptyHint, defaultProgram,
}: {
  blocks: BlockOption[];
  selected: number[];
  onChange: (next: number[]) => void;
  loading?: boolean;
  emptyHint?: string;
  /** Program tab to open on (e.g. the faculty's own program code) */
  defaultProgram?: string | null;
}) {
  const reduceMotion = useReducedMotion();
  const [open, setOpen] = useState(false);
  const chosen = new Set(selected);

  const programs = useMemo(
    () => [...new Set(blocks.map(b => b.program_code))].sort((a, b) => a.localeCompare(b)),
    [blocks],
  );
  const [program, setProgram] = useState<string>('');
  // Open on the faculty's program, else one that already has picks, else the first
  useEffect(() => {
    if (program && programs.includes(program)) return;
    const withPicks = programs.find(p => blocks.some(b => b.program_code === p && chosen.has(b.id)));
    setProgram((defaultProgram && programs.includes(defaultProgram) ? defaultProgram : withPicks) ?? programs[0] ?? '');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [programs, defaultProgram]);

  const toggle = (id: number) =>
    onChange(chosen.has(id) ? selected.filter(x => x !== id) : [...selected, id]);

  const picked = blocks
    .filter(b => chosen.has(b.id))
    .sort((a, b) => shortLabel(a).localeCompare(shortLabel(b), undefined, { numeric: true }));
  const countFor = (p: string) => picked.filter(b => b.program_code === p).length;

  const years = useMemo(() => {
    const map = new Map<string, BlockOption[]>();
    for (const b of blocks.filter(x => x.program_code === program)) {
      map.set(b.year_level, [...(map.get(b.year_level) ?? []), b]);
    }
    return [...map.entries()]
      .sort(([a], [b]) => YEAR_ORDER.indexOf(a) - YEAR_ORDER.indexOf(b))
      .map(([year, list]) => [year, list.sort((a, b) => a.block_name.localeCompare(b.block_name, undefined, { numeric: true }))] as const);
  }, [blocks, program]);

  if (loading) return <p className="text-sm text-slate-500">Loading blocks…</p>;
  if (blocks.length === 0) {
    return <p className="text-sm italic text-slate-500">{emptyHint ?? 'No blocks for this semester yet — create them in Block Creation.'}</p>;
  }

  return (
    <div>
      {/* Picked blocks — always visible, removable */}
      {picked.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2.5">
          <AnimatePresence initial={false}>
            {picked.map(b => (
              <motion.span
                key={b.id}
                layout={!reduceMotion}
                initial={reduceMotion ? false : { opacity: 0, scale: 0.85 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.85 }}
                transition={{ duration: 0.18, ease: EASE }}
                className="inline-flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded-full text-xs font-bold bg-[#1E4FB8]"
                // White set inline — the light-mode rule repaints `text-white` as dark ink
                style={{ color: '#FFFFFF' }}
              >
                {shortLabel(b)}
                <button type="button" onClick={() => toggle(b.id)} aria-label={`Remove ${shortLabel(b)}`} className="opacity-80 hover:opacity-100">
                  <X className="w-3 h-3" />
                </button>
              </motion.span>
            ))}
          </AnimatePresence>
        </div>
      )}

      <div className="rounded-xl border border-[#E2E8F0] bg-white overflow-hidden">
        {/* Fold / unfold */}
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
          className="w-full flex items-center justify-between gap-2 px-4 py-2.5 text-sm text-[#334155] hover:bg-[#F8FAFC] transition-colors"
        >
          <span className="font-semibold">
            {picked.length > 0 ? `${picked.length} block${picked.length !== 1 ? 's' : ''} selected` : 'Select blocks…'}
          </span>
          <motion.span animate={{ rotate: open ? 180 : 0 }} transition={{ duration: reduceMotion ? 0 : 0.2 }} className="inline-flex">
            <ChevronDown className="w-4 h-4 text-[#64748B]" />
          </motion.span>
        </button>

        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              key="panel"
              initial={reduceMotion ? false : { height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.25, ease: EASE }}
              className="overflow-hidden border-t border-[#E2E8F0]"
            >
              {/* Program tabs */}
              <div className="flex flex-wrap gap-2 px-4 pt-3 pb-2.5 bg-[#F8FAFC] border-b border-[#E2E8F0]" role="tablist" aria-label="Program">
                {programs.map(p => {
                  const on = p === program;
                  const n = countFor(p);
                  return (
                    <button
                      key={p}
                      type="button"
                      role="tab"
                      aria-selected={on}
                      onClick={() => setProgram(p)}
                      className={`relative isolate inline-flex items-center gap-1.5 min-h-[36px] px-3.5 rounded-full text-sm font-bold border transition-colors ${
                        on ? 'border-transparent' : 'bg-white border-[#CBD5E1] text-[#0B2A5B] hover:border-[#1D5BD6]'
                      }`}
                      style={on ? { color: '#FFFFFF' } : undefined}
                    >
                      {on && (
                        <motion.span
                          layoutId="block-program-tab"
                          className="absolute inset-0 -z-10 rounded-full bg-[#0B2A5B]"
                          transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 380, damping: 32 }}
                        />
                      )}
                      {p}
                      {n > 0 && (
                        <span className={`min-w-[20px] px-1.5 rounded-full text-[11px] text-center ${on ? 'bg-white/25' : 'bg-[#EAF1FD] text-[#1E4FB8]'}`}>{n}</span>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Year rows for the chosen program */}
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={program}
                  initial={reduceMotion ? false : { opacity: 0, x: 12 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -12 }}
                  transition={{ duration: reduceMotion ? 0 : 0.18, ease: EASE }}
                  className="divide-y divide-[#F1F5F9]"
                >
                  {years.map(([year, list]) => (
                    <div key={year} className="px-4 py-2.5 flex flex-wrap items-center gap-2">
                      <span className="w-[76px] shrink-0 text-sm font-bold text-[#475569]">{year}</span>
                      {list.map(b => {
                        const on = chosen.has(b.id);
                        return (
                          <motion.button
                            key={b.id}
                            type="button"
                            onClick={() => toggle(b.id)}
                            aria-pressed={on}
                            whileTap={reduceMotion ? undefined : { scale: 0.94 }}
                            className={`inline-flex items-center justify-center gap-1 min-w-[44px] min-h-[36px] px-3 rounded-lg border-2 text-sm font-bold transition-colors ${
                              on ? 'bg-[#1E4FB8] border-[#1E4FB8]' : 'bg-white border-[#CBD5E1] text-[#0B2A5B] hover:border-[#1D5BD6]'
                            }`}
                            style={on ? { color: '#FFFFFF' } : undefined}
                            title={`${b.program_code} ${year} — Block ${b.block_name}`}
                          >
                            {on && <Check className="w-3.5 h-3.5" />}
                            {b.block_name}
                          </motion.button>
                        );
                      })}
                    </div>
                  ))}
                </motion.div>
              </AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

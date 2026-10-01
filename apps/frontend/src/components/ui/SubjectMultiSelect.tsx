'use client';

import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { X, ChevronDown } from 'lucide-react';
import { isSameSubject } from '@shared/subjectCode';

const EASE = [0.4, 0, 0.2, 1] as const;

export interface PrioritySubject {
  subject_code: string;
  subject_name: string;
}

/**
 * "Subjects to Handle" — a recommendation for Faculty Workload, not an
 * assignment restriction. Lets the admin pick any number of subjects across
 * the full curriculum (not scoped to one program). Foldable so it doesn't
 * dominate the form when collapsed. Same light look as BlockMultiSelect.
 */
export default function SubjectMultiSelect({
  options, selected, onChange, loading, disabledHint,
  defaultOpen = false,
}: {
  options: PrioritySubject[];
  selected: PrioritySubject[];
  onChange: (next: PrioritySubject[]) => void;
  loading?: boolean;
  disabledHint?: string;
  defaultOpen?: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const [open, setOpen] = useState(defaultOpen);
  const [query, setQuery] = useState('');
  const keyOf = (s: PrioritySubject) => `${s.subject_code}|${s.subject_name}`;
  const isSelected = (opt: PrioritySubject) => selected.some(s => isSameSubject(s, opt));
  const filtered = options.filter(o =>
    !query ||
    o.subject_code.toLowerCase().includes(query.toLowerCase()) ||
    o.subject_name.toLowerCase().includes(query.toLowerCase())
  );

  function toggle(opt: PrioritySubject) {
    if (isSelected(opt)) {
      onChange(selected.filter(s => !isSameSubject(s, opt)));
    } else {
      onChange([...selected, opt]);
    }
  }

  if (disabledHint) {
    return <p className="text-sm italic text-[#64748B]">{disabledHint}</p>;
  }

  return (
    <div>
      {/* Picked subjects — always visible, removable (same look as Blocks to Handle) */}
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2.5">
          <AnimatePresence initial={false}>
            {selected.map(s => (
              <motion.span
                key={keyOf(s)}
                layout={!reduceMotion}
                initial={reduceMotion ? false : { opacity: 0, scale: 0.85 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.85 }}
                transition={{ duration: 0.18, ease: EASE }}
                title={s.subject_name}
                className="inline-flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded-full text-xs font-bold bg-[#1E4FB8]"
                // White set inline — the light-mode rule repaints `text-white` as dark ink
                style={{ color: '#FFFFFF' }}
              >
                {s.subject_code}
                <button type="button" onClick={() => toggle(s)} className="opacity-80 hover:opacity-100" aria-label={`Remove ${s.subject_code}`}>
                  <X className="w-3 h-3" />
                </button>
              </motion.span>
            ))}
          </AnimatePresence>
        </div>
      )}

      <div className="rounded-xl border border-[#CBD5E1] bg-white overflow-hidden">
        <button
          type="button"
          onClick={() => setOpen(v => !v)}
          aria-expanded={open}
          className="w-full flex items-center justify-between gap-2 px-4 py-3 text-[15px] text-[#0B2A5B] hover:bg-[#F8FAFC] transition-colors cursor-pointer"
        >
          <span className={selected.length > 0 ? 'font-semibold' : 'text-[#64748B]'}>
            {selected.length > 0 ? `${selected.length} subject${selected.length !== 1 ? 's' : ''} selected` : 'Select subjects…'}
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
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search code or subject name…"
                className="w-full px-4 py-2.5 text-[15px] text-[#0B2A5B] placeholder:text-[#94A3B8] bg-[#F8FAFC] border-b border-[#E2E8F0] focus:outline-none focus:bg-white"
              />
              <div className="max-h-56 overflow-y-auto overscroll-contain">
                {loading ? (
                  <p className="px-4 py-3 text-sm text-[#64748B]">Loading subjects…</p>
                ) : filtered.length === 0 ? (
                  <p className="px-4 py-3 text-sm text-[#64748B]">
                    {options.length === 0 ? 'No curriculum subjects found.' : 'No subjects match your search.'}
                  </p>
                ) : filtered.map(opt => {
                  const checked = isSelected(opt);
                  return (
                    <label
                      key={keyOf(opt)}
                      className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors ${checked ? 'bg-[#EFF6FF]' : 'hover:bg-[#F8FAFC]'}`}
                    >
                      <input type="checkbox" checked={checked} onChange={() => toggle(opt)} className="w-[18px] h-[18px] accent-[#1D5BD6] flex-shrink-0" />
                      <span className="min-w-0">
                        <span className={`block text-sm font-bold ${checked ? 'text-[#1D5BD6]' : 'text-[#0B2A5B]'}`}>{opt.subject_code}</span>
                        <span className="block text-xs text-[#64748B] truncate">{opt.subject_name}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

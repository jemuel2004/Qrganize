'use client';

import { useState } from 'react';
import { X, ChevronDown } from 'lucide-react';

export interface PrioritySubject {
  subject_code: string;
  subject_name: string;
}

/**
 * "Subjects to Handle" — a recommendation for Faculty Workload, not an
 * assignment restriction. Lets the admin pick any number of subjects across
 * the full curriculum (not scoped to one program). Foldable so it doesn't
 * dominate the form when collapsed. Dark-modal styling to match the
 * Faculty / Instructor Account creation forms.
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
  const [open, setOpen] = useState(defaultOpen);
  const [query, setQuery] = useState('');
  const selectedCodes = new Set(selected.map(s => s.subject_code));
  const filtered = options.filter(o =>
    !query ||
    o.subject_code.toLowerCase().includes(query.toLowerCase()) ||
    o.subject_name.toLowerCase().includes(query.toLowerCase())
  );

  function toggle(opt: PrioritySubject) {
    if (selectedCodes.has(opt.subject_code)) {
      onChange(selected.filter(s => s.subject_code !== opt.subject_code));
    } else {
      onChange([...selected, opt]);
    }
  }

  if (disabledHint) {
    return <p className="text-sm italic text-slate-500">{disabledHint}</p>;
  }

  return (
    <div>
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2.5">
          {selected.map(s => (
            <span key={s.subject_code} className="inline-flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded-full text-xs font-semibold bg-[#1D5BD6]/15 text-[#7CB4EF] border border-[#1D5BD6]/30">
              {s.subject_code}
              <button type="button" onClick={() => toggle(s)} className="hover:text-white transition-colors" aria-label={`Remove ${s.subject_code}`}>
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="border border-white/10 rounded-xl bg-[#0b0f1a] overflow-hidden">
        <button
          type="button"
          onClick={() => setOpen(v => !v)}
          className="w-full flex items-center justify-between gap-2 px-4 py-2.5 text-sm text-slate-300 hover:text-white transition-colors cursor-pointer"
        >
          <span>
            {selected.length > 0 ? `${selected.length} subject${selected.length !== 1 ? 's' : ''} selected` : 'Select subjects…'}
          </span>
          <ChevronDown className={`w-4 h-4 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>

        {open && (
          <>
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search subjects…"
              className="w-full px-4 py-2.5 text-sm text-white placeholder:text-slate-500 bg-transparent border-t border-b border-white/10 focus:outline-none"
            />
            <div className="max-h-48 overflow-y-auto">
              {loading ? (
                <p className="px-4 py-3 text-sm text-slate-500">Loading subjects…</p>
              ) : filtered.length === 0 ? (
                <p className="px-4 py-3 text-sm text-slate-500">
                  {options.length === 0 ? 'No curriculum subjects found.' : 'No subjects match your search.'}
                </p>
              ) : filtered.map(opt => {
                const checked = selectedCodes.has(opt.subject_code);
                return (
                  <label
                    key={opt.subject_code}
                    className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors ${checked ? 'bg-[#1D5BD6]/10' : 'hover:bg-white/5'}`}
                  >
                    <input type="checkbox" checked={checked} onChange={() => toggle(opt)} className="w-4 h-4 accent-[#1D5BD6] flex-shrink-0" />
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-white">{opt.subject_code}</span>
                      <span className="block text-xs text-slate-400 truncate">{opt.subject_name}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

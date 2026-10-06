'use client';

/**
 * Split a subject between Regular Load and Overload / Praise Load, part by part:
 * how much of the Lecture and of the Laboratory moves. E.g. CS 111 — Lecture
 * all Praise, Laboratory 1.25 of its 2.25 units Praise (1 unit stays Regular).
 */

export interface SplitDraft {
  lec: string;
  lab: string;
}

const fmt = (n: number) => String(Math.round(n * 100) / 100);

/** One box → its amount (empty = 0), or null when it is not 0 … max */
function readAmount(text: string, max: number): number | null {
  const t = text.trim();
  if (t === '' || t === '.') return 0;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0 || n > max + 0.001) return null;
  return Math.min(n, max);
}

/** The amounts moved from each part, or null while a box holds an invalid amount */
export function readSplitDraft(draft: SplitDraft, lecValue: number, labValue: number): { lec: number; lab: number } | null {
  const lec = lecValue > 0 ? readAmount(draft.lec, lecValue) : 0;
  const lab = labValue > 0 ? readAmount(draft.lab, labValue) : 0;
  return lec === null || lab === null ? null : { lec, lab };
}

/** Boxes to start from: all of the clicked part moves, none of the other */
export function startSplitDraft(lecValue: number, labValue: number, clicked: 'lec' | 'lab' | 'full', wholeMoved?: number): SplitDraft {
  if (lecValue > 0 && labValue > 0 && clicked !== 'full') {
    return { lec: clicked === 'lec' ? fmt(lecValue) : '0', lab: clicked === 'lab' ? fmt(labValue) : '0' };
  }
  // One-part subject: the given amount (or all of it)
  const moved = wholeMoved ?? lecValue + labValue;
  return lecValue > 0 ? { lec: fmt(Math.min(moved, lecValue)), lab: '0' } : { lec: '0', lab: fmt(Math.min(moved, labValue)) };
}

export default function SplitPartsEditor({
  lecValue, labValue, target, unit, draft, onChange, disabled = false,
}: {
  /** Whole Lecture / Laboratory in the faculty's measure (0 = the subject has none) */
  lecValue: number;
  labValue: number;
  target: 'Overload' | 'Praise';
  unit: string;
  draft: SplitDraft;
  onChange: (next: SplitDraft) => void;
  disabled?: boolean;
}) {
  const ink = target === 'Praise' ? '#6D28D9' : '#C2410C';
  const parts = ([
    { key: 'lec', label: 'Lecture', value: lecValue },
    { key: 'lab', label: 'Laboratory', value: labValue },
  ] as const).filter(p => p.value > 0);
  const moved = readSplitDraft(draft, lecValue, labValue);
  const movedTotal = moved ? moved.lec + moved.lab : 0;
  const quickBtn = 'h-10 px-3 rounded-lg border border-[#D6E0EF] bg-white text-sm font-semibold text-[#0B2A5B] hover:bg-[#F1F5F9] disabled:opacity-50 transition-colors';

  return (
    <div className="space-y-2">
      {parts.map(p => {
        const amount = readAmount(draft[p.key], p.value);
        const id = `split-${target.toLowerCase()}-${p.key}`;
        return (
          <div key={p.key} className="rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3.5 py-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-bold text-[#0B2A5B]">{p.label}</span>
              <span className="text-[13px] text-[#64748B] tabular-nums">{fmt(p.value)} {unit}</span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <label htmlFor={id} className="text-sm font-medium text-[#334155]">To {target}</label>
              <input
                id={id}
                type="number"
                inputMode="decimal"
                min={0}
                max={p.value}
                step={0.25}
                placeholder="0"
                value={draft[p.key]}
                disabled={disabled}
                onChange={e => onChange({ ...draft, [p.key]: e.target.value })}
                aria-invalid={amount === null}
                className={`w-24 h-10 bg-white border rounded-lg px-3 text-base tabular-nums text-[#0B2A5B] focus:outline-none focus:ring-2 focus:ring-[#1D5BD6]/40 ${
                  amount === null ? 'border-[#DC2626]' : 'border-[#CBD5E1] focus:border-[#1D5BD6]'
                }`}
              />
              <button type="button" disabled={disabled} className={quickBtn} onClick={() => onChange({ ...draft, [p.key]: '0' })}>None</button>
              <button type="button" disabled={disabled} className={quickBtn} onClick={() => onChange({ ...draft, [p.key]: fmt(p.value) })}>All</button>
            </div>
            <p className="mt-1.5 text-[13px] text-[#475569] tabular-nums">
              {amount === null
                ? <span className="text-[#B91C1C]">Enter 0 to {fmt(p.value)}.</span>
                : <>Stays Regular: <b className="text-[#0B2A5B]">{fmt(p.value - amount)}</b> {unit}</>}
            </p>
          </div>
        );
      })}
      {moved && (
        <p className="text-sm text-[#475569] tabular-nums">
          {target} <b style={{ color: ink }}>{fmt(movedTotal)}</b>
          <span className="text-[#CBD5E1]"> · </span>
          Regular <b className="text-[#0B2A5B]">{fmt(lecValue + labValue - movedTotal)}</b> {unit}
        </p>
      )}
      {moved && movedTotal <= 0.001 && (
        <p className="text-sm text-[#B91C1C]">Move at least part of the {parts.length > 1 ? 'Lecture or Laboratory' : 'subject'}.</p>
      )}
    </div>
  );
}

'use client';

import React from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  OFFICIAL_GROUPS,
  isEmptySlotCoveredByOccupied,
  type OccupiedTimeRange,
} from '@/lib/officialWorkloadSlots';

export type OfficialFormRow = {
  key: string;
  slotId: string | null;
  timeLabel?: string;
  /** Actual schedule start (minutes) — used to hide overlapping empty template rows. */
  rangeStartMin?: number;
  /** Actual schedule end (minutes). */
  rangeEndMin?: number;
  subjectCode: string;
  description: string;
  course: string;
  students: string;
  units: string;
  hours: string;
  room: string;
  action?: React.ReactNode;
};

export type OfficialFormSummary = {
  unitsText: string;
  hoursText: string;
  designation: string;
  /** Units deducted from the regular load limit for this designation (e.g. "3.00"). */
  designationUnitsText?: string;
  specialAssignments: { key: string; description: string; units: string }[];
  preparations: string;
  totalUnitsText: string;
  /** Label in the Total row Description cell (default: Regular Load). */
  totalDescription?: string;
};

export type OfficialTableVariant = 'regular' | 'overload' | 'praise';

const cellBase = 'border border-[#E2E8F0] print:border-black px-1.5 py-[6px] text-sm text-[#0B2A5B] print:text-black leading-snug align-middle';
const cell = `${cellBase} text-center`;
const head = 'border border-[#E2E8F0] print:border-black px-1 py-[6px] text-sm font-bold text-[#0B2A5B] print:text-black bg-[#F8FAFC] print:bg-white leading-snug text-center align-middle';
/** TIME/DAY: slightly tighter padding; wrap only after the en-dash when needed. */
const timeCell =
  'border border-[#E2E8F0] print:border-black px-1 py-[6px] text-sm text-[#0B2A5B] print:text-black leading-snug align-middle text-center';
const timeHead =
  'border border-[#E2E8F0] print:border-black px-1 py-[6px] text-sm font-bold text-[#0B2A5B] print:text-black bg-[#F8FAFC] print:bg-white leading-snug text-center align-middle';

/** Controlled TIME/DAY content — keeps "7:00 AM" intact; may wrap after "–" on narrow cells. */
function TimeDayLabel({ label }: { label: string }) {
  const m = label.match(/^(.+?)([–-])\s*(.+)$/);
  if (!m) {
    return <span className="whitespace-nowrap">{label}</span>;
  }
  return (
    <>
      <span className="whitespace-nowrap">{m[1]}{m[2]}</span>
      <wbr />
      <span className="whitespace-nowrap">{m[3]}</span>
    </>
  );
}

function DataCells({ row }: { row: OfficialFormRow }) {
  return (
    <>
      <td className={`${cell} font-semibold whitespace-nowrap`}>{row.subjectCode}</td>
      <td
        className={`${cellBase} text-center align-middle whitespace-normal break-words [overflow-wrap:break-word]`}
      >
        {row.description}
      </td>
      <td className={`${cell} whitespace-nowrap`}>{row.course}</td>
      <td className={cell}>{row.students}</td>
      <td className={cell}>{row.units}</td>
      <td className={cell}>{row.hours}</td>
      <td className={`${cell} whitespace-nowrap`}>{row.room}</td>
    </>
  );
}

function EmptyDataCells() {
  return (
    <>
      <td className={cell}>&nbsp;</td>
      <td className={cell}></td>
      <td className={cell}></td>
      <td className={cell}></td>
      <td className={cell}></td>
      <td className={cell}></td>
      <td className={cell}></td>
    </>
  );
}

/** One empty Action cell so every closed row has the same 9-column grid. */
function ActionCell({ show }: { show: boolean }) {
  if (!show) return null;
  return <td className={`${cell} print:hidden`}></td>;
}

/** Action cell content — stack on small screens for readable tap targets. */
function ActionCellContent({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-0.5 max-lg:flex-col max-lg:items-stretch max-lg:gap-1 max-lg:py-0.5">
      {children}
    </div>
  );
}

/**
 * Summary rows match the main table grid.
 * Label spans TIME/DAY + Subject Code (colSpan 2), like the official form.
 * Values stay in Description / Units / Hours so vertical borders line up.
 */
function SummaryRow({
  label,
  description = '',
  units = '',
  hours = '',
  showActions,
  emphasizeNumbers = false,
  emphasizeDescription = false,
}: {
  label: string;
  description?: string;
  units?: string;
  hours?: string;
  showActions: boolean;
  emphasizeNumbers?: boolean;
  emphasizeDescription?: boolean;
}) {
  return (
    <tr>
      <td colSpan={2} className={`${cellBase} font-bold text-left`}>
        {label}
      </td>
      <td
        className={`${cellBase} text-center align-middle whitespace-normal break-words [overflow-wrap:break-word] ${
          emphasizeDescription ? 'font-bold' : ''
        }`}
      >
        {description}
      </td>
      <td className={cell}></td>
      <td className={cell}></td>
      <td className={`${cell} ${emphasizeNumbers ? 'font-bold' : ''}`}>{units}</td>
      <td className={`${cell} ${emphasizeNumbers ? 'font-bold' : ''}`}>{hours}</td>
      <td className={cell}></td>
      <ActionCell show={showActions} />
    </tr>
  );
}

export default function OfficialWorkloadFormTable({
  rows,
  summary,
  showActions = false,
  variant = 'regular',
  /** When false, omit empty day/time slots (useful for Praise Load). */
  showEmptySlots = true,
}: {
  rows: OfficialFormRow[];
  summary?: OfficialFormSummary | null;
  showActions?: boolean;
  variant?: OfficialTableVariant;
  showEmptySlots?: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const colCount = showActions ? 9 : 8;
  const needsClassification = variant !== 'overload' && variant !== 'praise';
  const bySlot = new Map<string, OfficialFormRow[]>();
  const unmatched: OfficialFormRow[] = [];
  for (const row of rows) {
    if (row.slotId) {
      const list = bySlot.get(row.slotId) ?? [];
      list.push(row);
      bySlot.set(row.slotId, list);
    } else {
      unmatched.push(row);
    }
  }

  const specialRows = summary
    ? (summary.specialAssignments.length > 0
      ? summary.specialAssignments
      : [{ key: 'special-empty', description: '', units: '' }])
    : [];

  const totalDescription =
    summary?.totalDescription
    ?? (variant === 'overload' ? 'Overload' : variant === 'praise' ? 'Praise Load' : 'Regular Load');

  /** Occupied intervals per official section — used to suppress redundant empty template rows. */
  const occupiedByGroup = new Map<string, OccupiedTimeRange[]>();
  for (const group of OFFICIAL_GROUPS) {
    const ranges: OccupiedTimeRange[] = [];
    for (const slot of group.slots) {
      for (const row of bySlot.get(slot.id) ?? []) {
        if (row.rangeStartMin != null && row.rangeEndMin != null && row.rangeEndMin > row.rangeStartMin) {
          ranges.push({ startMin: row.rangeStartMin, endMin: row.rangeEndMin });
        }
      }
    }
    occupiedByGroup.set(group.id, ranges);
  }

  const colgroupEl = (
    <colgroup>
      {/* Tuned so 9 columns (with Action) fit a form modal at desktop width. */}
      <col style={{ width: showActions ? '13%' : '15%' }} />
      <col style={{ width: showActions ? '10%' : '11%' }} />
      <col style={{ width: showActions ? '22%' : '28%' }} />
      <col style={{ width: showActions ? '8%' : '9%' }} />
      <col style={{ width: showActions ? '7%' : '7%' }} />
      <col style={{ width: showActions ? '6%' : '7%' }} />
      <col style={{ width: showActions ? '7%' : '8%' }} />
      <col style={{ width: showActions ? '9%' : '15%' }} />
      {showActions && <col style={{ width: '18%' }} />}
    </colgroup>
  );

  const theadEl = (
    <thead>
      <tr>
        <th className={timeHead}>TIME/DAY</th>
        <th className={head}>Subject Code</th>
        <th className={head}>Description</th>
        <th className={head}>Course</th>
        <th className={head}>No. of<br />Students</th>
        <th className={head}>Units</th>
        <th className={head}>No. of<br />Hours</th>
        <th className={head}>Room No.</th>
        {showActions && (
          <th className={`${head} print:hidden`}>Action</th>
        )}
      </tr>
    </thead>
  );

  const tableClassName = [
    'official-workload-table w-full table-fixed border-collapse bg-white text-[#0B2A5B] print:text-black border border-[#E2E8F0] print:border-black',
    /* Below lg: do not compress — enable internal horizontal scroll */
    'max-lg:min-w-[960px]',
    /* Desktop: preserve prior fill behavior */
    'lg:min-w-0',
  ].join(' ');

  /*
   * Screen layout:
   * - Desktop (lg+): table fills the modal width (unchanged).
   * - Mobile/tablet: keep a readable min-width and scroll horizontally inside
   *   this wrapper only — never squeeze columns until headers overlap.
   * Print: globals.css forces min-width: 0 on .official-workload-table.
   */
  return (
    <div className="min-w-0 max-w-full">
      <p className="lg:hidden no-print text-xs text-slate-500 mb-1.5 leading-snug">
        Swipe left or right to view all columns
      </p>

      {/* "Other" subjects — not yet classified into Workload/Overload/Praise Load.
          Schedule details (day/time/room) are irrelevant to that decision, so this
          is a plain classification list, not a scheduling table. The red border +
          pulse are a status indicator (subjects pending classification) — rows fade
          out smoothly as each one gets classified, and the whole block fades/collapses
          away once the list is empty, instead of snapping away instantly. */}
      <AnimatePresence initial={false}>
        {unmatched.length > 0 && (
          <motion.div
            key="other-block"
            exit={{ opacity: 0, height: 0, marginBottom: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.35, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden print:hidden"
            style={{ marginBottom: '1rem' }}
          >
            {/* On Overload / Praise the rows are already classified — they just
                have no day/time yet, so say that instead of "Needs Classification". */}
            <div className={`rounded-xl border bg-white overflow-hidden ${needsClassification ? 'border-red-200' : 'border-[#BFD3F5]'}`}>
              <div className="px-4 pt-3 pb-2 border-b border-[#E2E8F0]">
                <span className="text-sm font-bold text-[#0B2A5B]">
                  {needsClassification
                    ? 'Other — Needs Classification'
                    : `${variant === 'praise' ? 'Praise Load' : 'Overload'} — No Time Slot Yet`}
                </span>
                <p className="text-xs text-[#64748B] mt-0.5">
                  {needsClassification
                    ? 'Not yet assigned to Workload, Overload, or Praise Load.'
                    : variant === 'praise'
                      ? 'Already in Praise Load. Subjects appear in their time slot once scheduled in Scheduling.'
                      : 'Already in Overload. Appears in its time slot once scheduled in Scheduling.'}
                </p>
              </div>
              <div className="divide-y divide-[#F1F5F9]">
                <AnimatePresence initial={false}>
                  {unmatched.map(row => (
                    <motion.div
                      key={row.key}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: reduceMotion ? 0 : 0.25, ease: [0.16, 1, 0.3, 1] }}
                      className="overflow-hidden"
                    >
                      {/* Each row animates its own qr-flag-pulse instance (no shared
                          timer/state), so multiple rows pulse independently. */}
                      <div className={`${needsClassification ? 'qr-flag-pulse ' : ''}flex flex-wrap items-center justify-between gap-3 px-4 py-2.5`}>
                        <div className="min-w-0">
                          <div className="flex items-baseline gap-2 flex-wrap">
                            <span className="font-semibold text-sm text-[#0B2A5B] whitespace-nowrap">{row.subjectCode}</span>
                            <span className="text-sm text-[#0B2A5B]">{row.description}</span>
                          </div>
                          <div className="text-xs text-[#64748B] mt-0.5">
                            {[row.course, row.units && `${row.units} units`].filter(Boolean).join(' · ')}
                          </div>
                        </div>
                        {showActions && row.action && (
                          <div className="shrink-0">{row.action}</div>
                        )}
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="bg-white w-full max-w-full min-w-0 overflow-x-auto overscroll-x-contain [-webkit-overflow-scrolling:touch]">
        <table className={tableClassName}>
          {colgroupEl}
          {theadEl}
          <tbody>
            {OFFICIAL_GROUPS.map(group => {
              const groupHasRows = group.slots.some(slot => (bySlot.get(slot.id) ?? []).length > 0);
              if (!showEmptySlots && !groupHasRows) return null;
              return (
                <React.Fragment key={group.id}>
                  <tr>
                    <td colSpan={colCount} className={`${cellBase} font-bold text-left bg-[#F8FAFC] print:bg-white`}>
                      {group.label}
                    </td>
                  </tr>
                  {group.slots.map(slot => {
                    const items = bySlot.get(slot.id) ?? [];
                    if (items.length === 0) {
                      if (!showEmptySlots) return null;
                      /* Skip predefined empties that fall inside an occupied schedule (e.g. hide
                         2:00–3:30 / 2:30–4:00 when a class already occupies 1:00–4:00). */
                      if (isEmptySlotCoveredByOccupied(slot, occupiedByGroup.get(group.id) ?? [])) {
                        return null;
                      }
                      return (
                        <tr key={slot.id}>
                          <td className={timeCell}>
                            <TimeDayLabel label={slot.timeLabel} />
                          </td>
                          <EmptyDataCells />
                          {showActions && <td className={`${cell} print:hidden`}></td>}
                        </tr>
                      );
                    }
                    return items.map(row => (
                      <tr key={row.key}>
                        <td className={timeCell}>
                          <TimeDayLabel label={row.timeLabel || slot.timeLabel} />
                        </td>
                        <DataCells row={row} />
                        {showActions && (
                          <td className={`${cell} print:hidden px-0.5`}>
                            <ActionCellContent>{row.action}</ActionCellContent>
                          </td>
                        )}
                      </tr>
                    ));
                  })}
                </React.Fragment>
              );
            })}

            {summary && variant === 'regular' && (
              <>
                <SummaryRow
                  label="No. of Units"
                  units={summary.unitsText}
                  hours={summary.hoursText}
                  showActions={showActions}
                  emphasizeNumbers
                />
                <SummaryRow
                  label="Designation"
                  description={summary.designation}
                  units={summary.designationUnitsText}
                  showActions={showActions}
                />
                {specialRows.map(sa => (
                  <SummaryRow
                    key={sa.key}
                    label="Add: Special Assignment"
                    description={sa.description}
                    units={sa.units}
                    showActions={showActions}
                  />
                ))}
                <SummaryRow
                  label="No. of Preparation"
                  description={summary.preparations}
                  showActions={showActions}
                />
                <SummaryRow
                  label="Total No. of Units"
                  description={totalDescription}
                  units={summary.totalUnitsText}
                  showActions={showActions}
                  emphasizeNumbers
                  emphasizeDescription
                />
              </>
            )}

            {summary && variant !== 'regular' && (
              <>
                <SummaryRow
                  label="No. of Units"
                  units={summary.unitsText}
                  hours={summary.hoursText}
                  showActions={showActions}
                  emphasizeNumbers
                />
                <SummaryRow
                  label="Total No. of Units"
                  description={totalDescription}
                  units={summary.totalUnitsText}
                  showActions={showActions}
                  emphasizeNumbers
                  emphasizeDescription
                />
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

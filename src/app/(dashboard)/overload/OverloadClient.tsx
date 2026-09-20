'use client';

import { useEffect, useState, useCallback } from 'react';
import { TrendingUp } from 'lucide-react';
import { SearchInput } from '@/components/ui/SearchFilter';
import { useSchoolYear } from '@/client/context/SchoolYearContext';
import { useToast } from '@/client/context/ToastContext';
import Modal from '@/client/components/ui/Modal';

interface Faculty {
  id: number;
  name: string;
  employee_id: string;
  position: string;
  employment_status: string;
  designation_type: string;
  designation_units: number;
}

interface OverloadRow {
  faculty_id: number;
  faculty_name: string;
  employee_id: string;
  employment_status: string;
  subject_code: string;
  subject_name: string;
  lecture_hours: number;
  laboratory_hours: number;
  curriculum_total_hours: number;
  curriculum_units: number;
  block_name: string;
  year_level: string;
  program_code: string;
  overload_units: number;
  overload_hours: number;
  load_category: string;
  is_split: boolean;
  il_units: number;
  il_hours: number;
  master_schedule_id?: number;
  subject_category?: string;
}

function extractYearNum(yearLevel: string): string {
  const m = yearLevel?.match(/\d/);
  return m ? m[0] : '';
}

export default function OverloadClient() {
  const { schoolYear: globalYear, semester: globalSemester } = useSchoolYear();
  const toast = useToast();

  const [facultyList, setFacultyList] = useState<Faculty[]>([]);
  const [facultySearch, setFacultySearch] = useState('');
  const [selectedFaculty, setSelectedFaculty] = useState<Faculty | null>(null);

  // Semester and school year come directly from Settings — not user-editable here.
  const effectiveSem  = globalSemester;
  const effectiveYear = globalYear;

  const [overloads, setOverloads] = useState<OverloadRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [moveConfirm, setMoveConfirm] = useState<{ ids: number[]; total: number } | null>(null);
  const [moving, setMoving] = useState(false);
  const [returnConfirm, setReturnConfirm] = useState<OverloadRow | null>(null);
  const [returning, setReturning] = useState(false);

  useEffect(() => {
    fetch('/api/faculty').then(r => r.json()).then(d => setFacultyList(d.faculty || []));
  }, []);

  const fetchOverloads = useCallback(() => {
    if (!selectedFaculty || !effectiveSem || !effectiveYear) return;
    setLoading(true);
    const params = new URLSearchParams({
      faculty_id:    String(selectedFaculty.id),
      semester:      effectiveSem,
      academic_year: effectiveYear,
    });
    fetch(`/api/overload?${params}`)
      .then(r => r.json())
      .then(d => setOverloads(d.overloads || []))
      .finally(() => setLoading(false));
  }, [selectedFaculty, effectiveSem, effectiveYear]);

  useEffect(() => {
    if (selectedFaculty && effectiveSem && effectiveYear) {
      fetchOverloads();
    } else {
      setOverloads([]);
    }
  }, [selectedFaculty, effectiveSem, effectiveYear, fetchOverloads]);

  function selectFaculty(f: Faculty) {
    setSelectedFaculty(f);
    setOverloads([]);
    setMoveConfirm(null);
    setReturnConfirm(null);
  }

  const filteredFaculty = facultyList.filter(f =>
    f.name.toLowerCase().includes(facultySearch.toLowerCase()) ||
    f.employee_id.toLowerCase().includes(facultySearch.toLowerCase())
  );

  const isPermanent = selectedFaculty?.employment_status === 'Permanent';
  const overloadLabel = isPermanent ? 'Units' : 'Hours';

  const totalLec = overloads.reduce((s, r) => s + (parseFloat(String(r.lecture_hours)) || 0), 0);
  const totalLab = overloads.reduce((s, r) => s + (parseFloat(String(r.laboratory_hours)) || 0), 0);
  const totalHrs = overloads.reduce((s, r) => s + (parseFloat(String(r.curriculum_total_hours)) || 0), 0);
  const totalOL  = overloads.reduce((s, r) => {
    const val = isPermanent
      ? parseFloat(String(r.overload_units)) || 0
      : parseFloat(String(r.overload_hours)) || 0;
    return s + val;
  }, 0);

  const movableRows = overloads.filter(r =>
    !r.is_split && r.load_category === 'Overload' && Number(r.master_schedule_id) > 0
  );

  function rowOverloadValue(row: OverloadRow): number {
    return isPermanent
      ? parseFloat(String(row.overload_units)) || 0
      : parseFloat(String(row.overload_hours)) || 0;
  }

  function requestMove(ids: number[]) {
    const rows = movableRows.filter(r => ids.includes(Number(r.master_schedule_id)));
    if (rows.length === 0) {
      toast.error('This subject cannot be moved to Praise Load.');
      return;
    }
    const total = rows.reduce((s, r) => s + rowOverloadValue(r), 0);
    setMoveConfirm({ ids: rows.map(r => Number(r.master_schedule_id)), total });
  }

  async function confirmMove() {
    if (!selectedFaculty || !moveConfirm) return;
    setMoving(true);
    try {
      const res = await fetch('/api/workload/move-to-praise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          faculty_id: selectedFaculty.id,
          master_schedule_ids: moveConfirm.ids,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to move subject to Praise Load.');
        return;
      }
      toast.success(data.message || 'Subject moved to Praise Load.');
      setMoveConfirm(null);
      fetchOverloads();
    } catch {
      toast.error('Connection error. Please try again.');
    } finally {
      setMoving(false);
    }
  }

  async function confirmReturnToRegular() {
    if (!selectedFaculty || !returnConfirm) return;
    const msId = Number(returnConfirm.master_schedule_id);
    if (!msId) return;
    setReturning(true);
    try {
      const res = await fetch('/api/workload/return-to-regular', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          faculty_id: selectedFaculty.id,
          master_schedule_id: msId,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to return subject to Regular Load.');
        return;
      }
      toast.success(data.message || 'Subject returned to Regular Load.');
      setReturnConfirm(null);
      fetchOverloads();
    } catch {
      toast.error('Connection error. Please try again.');
    } finally {
      setReturning(false);
    }
  }

  return (
    <div className="p-6 space-y-5">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <TrendingUp className="w-4 h-4 text-amber-400" />
          <span className="text-xs text-slate-500">Scheduling — Overload</span>
        </div>
        <h1 className="text-2xl font-bold text-white">Overload Records</h1>
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* Left: Faculty selector */}
        <div className="col-span-1">
          <div className="bg-[#111827] rounded-xl border border-white/10 sticky top-6">
            <div className="px-4 py-3 border-b border-white/10">
              <div className="font-semibold text-slate-200 text-sm mb-2">Select Instructor</div>
              <SearchInput
                value={facultySearch}
                onChange={setFacultySearch}
                placeholder="Search faculty…"
                className="!py-1.5 !text-xs"
              />
            </div>
            <div className="p-2 max-h-[calc(100vh-280px)] overflow-y-auto">
              {filteredFaculty.length === 0 ? (
                <div className="text-center py-6 text-slate-500 text-sm">No faculty found</div>
              ) : filteredFaculty.map(f => (
                <button
                  key={f.id}
                  onClick={() => selectFaculty(f)}
                  className={`w-full text-left px-3 py-3 rounded-lg transition mb-1
                    ${selectedFaculty?.id === f.id
                      ? 'bg-[#3C91E6] text-white'
                      : 'hover:bg-white/5 text-slate-200'}`}
                >
                  <div className="font-medium text-sm">{f.name}</div>
                  <div className={`text-xs mt-0.5 ${selectedFaculty?.id === f.id ? 'text-blue-200' : 'text-slate-500'}`}>
                    {f.employee_id} · {f.position}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Right: Overload panel */}
        <div className="col-span-2 space-y-4">
          {!selectedFaculty ? (
            <div className="bg-[#111827] rounded-xl border border-white/10 py-14 text-center">
              <p className="text-slate-400 text-sm">No overload records found.</p>
            </div>
          ) : (
            <>
              {/* Instructor info + period selectors */}
              <div className="bg-[#111827] rounded-xl border border-white/10 p-5">
                <div className="mb-4">
                  <h2 className="text-xl font-bold text-white">{selectedFaculty.name}</h2>
                  <div className="flex items-center gap-2 mt-1 text-sm text-slate-400">
                    <span>{selectedFaculty.employee_id}</span>
                    <span>·</span>
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                      isPermanent ? 'bg-blue-500/20 text-blue-400' : 'bg-purple-500/20 text-purple-400'
                    }`}>
                      {selectedFaculty.employment_status}
                    </span>
                    <span>·</span>
                    <span className="text-slate-500">{selectedFaculty.position}</span>
                  </div>
                </div>

                <div className="pt-4 border-t border-white/10 flex items-center gap-3 flex-wrap">
                  <div className="flex flex-col gap-1">
                    <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Semester</label>
                    <div className="text-xs bg-[#0b0f1a] border border-amber-500/30 rounded-lg px-3 py-2 text-white cursor-default select-none">
                      {effectiveSem || '—'}
                    </div>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">School Year</label>
                    <div className="text-xs bg-[#0b0f1a] border border-amber-500/30 rounded-lg px-3 py-2 text-white cursor-default select-none w-36">
                      {effectiveYear || '—'}
                    </div>
                  </div>
                </div>
              </div>

              {/* Overload subjects table */}
              <div className="bg-[#111827] rounded-xl border border-white/10 overflow-hidden">
                <div className="px-5 py-3 border-b border-white/10 flex items-center justify-between gap-3 flex-wrap">
                  <span className="font-semibold text-slate-200 text-sm">Overload Subjects</span>
                  <span className="text-xs text-slate-500">
                    {overloads.length} subject{overloads.length !== 1 ? 's' : ''}
                    {effectiveSem  ? ` · ${effectiveSem}`  : ''}
                    {effectiveYear ? ` ${effectiveYear}` : ''}
                  </span>
                </div>

                {!effectiveSem || !effectiveYear ? (
                  <div className="py-10 text-center text-slate-500 text-sm">
                    No overload records found.
                  </div>
                ) : loading ? (
                  <div className="py-10 text-center text-slate-500 text-sm">Loading…</div>
                ) : overloads.length === 0 ? (
                  <div className="py-10 text-center text-slate-500 text-sm">
                    No overload records for {effectiveSem} {effectiveYear}.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-[#0d1424] border-b border-white/10">
                        <tr>
                          {['Code', 'Subject Name', 'Category', 'Course', 'Lec Hrs', 'Lab Hrs', 'Total Hrs', `Overload ${overloadLabel}`, 'Status', 'Action'].map(h => (
                            <th key={h} className="text-left px-3 py-2.5 font-semibold text-slate-400 uppercase tracking-wide whitespace-nowrap">
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5">
                        {overloads.map((row, i) => {
                          const isSplit = row.is_split;
                          const olVal = isPermanent
                            ? parseFloat(String(row.overload_units)) || 0
                            : parseFloat(String(row.overload_hours)) || 0;
                          const regVal = isPermanent
                            ? parseFloat(String(row.il_units)) || 0
                            : parseFloat(String(row.il_hours)) || 0;
                          const lec = parseFloat(String(row.lecture_hours))          || 0;
                          const lab = parseFloat(String(row.laboratory_hours))       || 0;
                          const hrs = parseFloat(String(row.curriculum_total_hours)) || 0;
                          const yearNum = extractYearNum(row.year_level);
                          const rowBg = isSplit
                            ? 'bg-purple-500/5 hover:bg-purple-500/10'
                            : 'bg-amber-500/5 hover:bg-amber-500/10';
                          const msId = Number(row.master_schedule_id) || 0;
                          const canMove = !isSplit && row.load_category === 'Overload' && msId > 0;
                          const canReturn = msId > 0 && (canMove || isSplit);

                          return (
                            <tr key={i} className={`transition ${rowBg}`}>
                              <td className="px-3 py-2.5 font-mono font-medium text-white whitespace-nowrap">
                                {row.subject_code}
                              </td>
                              <td className="px-3 py-2.5 text-slate-300 max-w-[180px] truncate" title={row.subject_name}>
                                {row.subject_name}
                              </td>
                              <td className="px-3 py-2.5 text-slate-400 whitespace-nowrap">
                                {row.subject_category || '—'}
                              </td>
                              <td className="px-3 py-2.5 text-slate-400 whitespace-nowrap">
                                {row.program_code} {yearNum}{row.block_name}
                              </td>
                              <td className="px-3 py-2.5 text-center text-slate-400">{lec || '—'}</td>
                              <td className="px-3 py-2.5 text-center text-slate-400">{lab || '—'}</td>
                              <td className="px-3 py-2.5 text-center text-slate-400">{hrs}</td>
                              <td className="px-3 py-2.5 text-center font-bold">
                                {isSplit ? (
                                  <div className="flex flex-col items-center gap-0.5">
                                    <span className="text-emerald-400">
                                      {regVal.toFixed(2)}{' '}
                                      <span className="text-[10px] font-normal text-emerald-600">reg</span>
                                    </span>
                                    <span className="text-amber-400">
                                      +{olVal.toFixed(2)}{' '}
                                      <span className="text-[10px] font-normal text-amber-600">ov</span>
                                    </span>
                                  </div>
                                ) : (
                                  <span className="text-amber-400">{olVal.toFixed(2)}</span>
                                )}
                              </td>
                              <td className="px-3 py-2.5">
                                {isSplit ? (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-purple-500/20 text-purple-300 border border-purple-500/30">
                                    Split
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/30">
                                    Overload
                                  </span>
                                )}
                              </td>
                              <td className="px-3 py-2.5">
                                <div className="flex flex-col gap-1 items-start">
                                  {canMove && (
                                  <button
                                    type="button"
                                    onClick={() => requestMove([msId])}
                                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-semibold bg-violet-500/20 text-violet-200 border border-violet-500/30 hover:bg-violet-500/30"
                                  >
                                    Move to Praise Load
                                  </button>
                                  )}
                                  {canReturn && (
                                  <button
                                    type="button"
                                    onClick={() => setReturnConfirm(row)}
                                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-semibold bg-blue-500/20 text-blue-200 border border-blue-500/30 hover:bg-blue-500/30"
                                  >
                                    Return to Regular Load
                                  </button>
                                  )}
                                  {!canMove && !canReturn && (
                                  <span className="text-slate-600">—</span>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot className="bg-[#0d1424] border-t border-white/10">
                        <tr>
                          <td colSpan={4} className="px-3 py-2 text-xs font-semibold text-slate-400 text-right">Totals:</td>
                          <td className="px-3 py-2 text-center text-xs font-bold text-white">{totalLec}</td>
                          <td className="px-3 py-2 text-center text-xs font-bold text-white">{totalLab}</td>
                          <td className="px-3 py-2 text-center text-xs font-bold text-white">{totalHrs.toFixed(2)}</td>
                          <td className="px-3 py-2 text-center text-xs font-bold text-amber-400">{totalOL.toFixed(2)}</td>
                          <td />
                          <td />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <Modal
        open={!!moveConfirm}
        onClose={() => { if (!moving) setMoveConfirm(null); }}
        title="Move to Praise Load"
        size="sm"
        footer={
          <div className="flex gap-3 justify-end">
            <button
              type="button"
              disabled={moving}
              onClick={() => setMoveConfirm(null)}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-white/10 hover:bg-white/20 text-white disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={moving}
              onClick={confirmMove}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-50"
            >
              {moving ? 'Moving…' : 'Move to Praise Load'}
            </button>
          </div>
        }
      >
        <div className="text-sm text-slate-300 space-y-2">
          <p>
            Move this subject from Overload to Praise Load?
          </p>
          <p className="text-white">
            Selected workload:{' '}
            <span className="font-semibold tabular-nums">
              {(moveConfirm?.total ?? 0).toFixed(2)} {overloadLabel.toLowerCase()}
            </span>
          </p>
        </div>
      </Modal>

      <Modal
        open={!!returnConfirm}
        onClose={() => { if (!returning) setReturnConfirm(null); }}
        title="Return to Regular Load"
        size="sm"
        footer={
          <div className="flex gap-3 justify-end">
            <button
              type="button"
              disabled={returning}
              onClick={() => setReturnConfirm(null)}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-white/10 hover:bg-white/20 text-white disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={returning}
              onClick={confirmReturnToRegular}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
            >
              {returning ? 'Returning…' : 'Return to Regular Load'}
            </button>
          </div>
        }
      >
        <div className="text-sm text-slate-300 space-y-2">
          <p>
            Return {returnConfirm?.subject_code} — {returnConfirm?.subject_name} to Regular Load?
          </p>
          <p className="text-xs text-slate-500">
            The subject stays assigned. The current Regular Load will be checked before this is allowed.
          </p>
        </div>
      </Modal>
    </div>
  );
}

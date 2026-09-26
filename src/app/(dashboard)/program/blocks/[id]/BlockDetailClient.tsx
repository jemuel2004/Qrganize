'use client';

import { useEffect, useState, useCallback } from 'react';
import { useToast } from '@/client/context/ToastContext';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft, BookOpen, Plus, Trash2, RefreshCw,
  CheckCircle, AlertTriangle, X, Users, Calendar,
  GraduationCap, Hash, ChevronRight, Clock,
  ChevronDown,
} from 'lucide-react';
import { SearchInput, FilterSelect } from '@/components/ui/SearchFilter';
import {
  blockCurriculumVersion,
  curriculumVersionLabel,
} from '@/lib/curriculumVersion';
import { useScrollLock } from '@/client/hooks/useScrollLock';

interface BlockDetail {
  id: number; program_id: number; program_code: string; program_name: string;
  year_level: string; semester: string; academic_year: string;
  block_name: string; number_of_students: number;
  curriculum_version?: string;
  subjects: SubjectRow[];
}
interface SubjectRow {
  id: number;
  curriculum_id: number;
  subject_code: string; subject_name: string;
  lecture_hours: number; laboratory_hours: number;
  total_hours: number; units: number;
  status: string;
  faculty_name: string | null;
  day_pattern: string | null; start_time: string | null; end_time: string | null;
  room_name: string | null;
  schedule_status: string | null; master_schedule_id: number | null;
}
interface AvailableSubject {
  id: number; subject_code: string; subject_name: string;
  lecture_hours: number; laboratory_hours: number; total_hours: number; units: number;
}
interface Program { id: number; code: string; name: string; }
interface BlockSummary {
  id: number; block_name: string; year_level: string; semester: string;
  academic_year: string; program_id: number;
  curriculum_version?: string;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function scheduleStatusChip(status: string) {
  const key = status || 'Unassigned';
  const cls =
    key === 'Scheduled'
      ? 'bg-[#ECFDF5] text-[#15803D]'
      : key === 'Assigned'
        ? 'bg-[#EFF6FF] text-[#164BB5]'
        : 'bg-[#FFFBEB] text-[#B45309]';
  return (
    <span className={`inline-flex items-center px-3 py-1.5 rounded-full text-sm font-semibold whitespace-nowrap ${cls}`}>
      {key}
    </span>
  );
}

function NextStepLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 min-h-11 px-1 text-base font-semibold text-[#164BB5] hover:text-[#1D4ED8] hover:underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#164BB5]/30 rounded-md whitespace-nowrap"
    >
      {children}
      <ChevronRight className="w-5 h-5" aria-hidden />
    </Link>
  );
}

function InfoCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="bg-white/5 rounded-xl p-4 flex items-start gap-3 border border-white/5">
      <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center flex-shrink-0 text-blue-400">
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-xs text-slate-400 font-medium uppercase tracking-wide mb-0.5">{label}</p>
        <p className="text-sm font-semibold text-white truncate">{value}</p>
      </div>
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────────

export default function BlockDetailPage() {
  const toast  = useToast();
  const router = useRouter();
  const { id } = useParams<{ id: string }>();

  const [block,   setBlock]   = useState<BlockDetail | null>(null);
  const [loading, setLoading] = useState(true);

  const [addOpen,      setAddOpen]      = useState(false);
  useScrollLock(addOpen);
  const [available,    setAvailable]    = useState<AvailableSubject[]>([]);
  const [availLoading, setAvailLoading] = useState(false);
  const [addingId,     setAddingId]     = useState<number | null>(null);

  const [reloading,  setReloading]  = useState(false);
  const [reloadMsg,  setReloadMsg]  = useState('');

  const [activeFilter,  setActiveFilter]  = useState<'all' | 'unassigned' | 'assigned' | 'scheduled'>('all');
  const [subjectSearch, setSubjectSearch] = useState('');

  /* ── Filter state for navigation ── */
  const [programs,     setPrograms]     = useState<Program[]>([]);
  const [allBlocks,    setAllBlocks]    = useState<BlockSummary[]>([]);
  const [selProgram,   setSelProgram]   = useState('');
  const [selYear,      setSelYear]      = useState('');
  const [selSemester,  setSelSemester]  = useState('');
  const [selSchoolYear,setSelSchoolYear]= useState('');
  const [selBlock,     setSelBlock]     = useState('');
  const [filtersReady, setFiltersReady] = useState(false);
  const [filtersOpen,  setFiltersOpen]  = useState(false);
  const [isChair, setIsChair] = useState(false);
  const [roleReady, setRoleReady] = useState(false);

  /* Restore filter panel after mount — sessionStorage is browser-only (SSR-safe). */
  useEffect(() => {
    try {
      if (sessionStorage.getItem('blockSwitchOpen') === '1') setFiltersOpen(true);
    } catch { /* ignore */ }
  }, []);

  /* load programs + role once */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [meRes, progRes] = await Promise.all([
          fetch('/api/account/me'),
          fetch('/api/programs'),
        ]);
        const meData = await meRes.json().catch(() => ({}));
        const progData = await progRes.json().catch(() => ({}));
        if (cancelled) return;
        setPrograms(progData.programs ?? []);
        const role = meData.user?.role;
        const pid = meData.user?.program_id != null ? Number(meData.user.program_id) : null;
        if (role === 'program_chair') {
          setIsChair(true);
          if (pid != null) setSelProgram(String(pid));
        }
      } catch { /* ignore */ }
      finally {
        if (!cancelled) setRoleReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  /* load blocks — chairs scoped to assigned program; admin gets all for switcher */
  useEffect(() => {
    if (!roleReady) return;
    const url = isChair && selProgram
      ? `/api/blocks?${new URLSearchParams({ program_id: selProgram })}`
      : '/api/blocks';
    fetch(url)
      .then(r => r.json())
      .then(d => setAllBlocks(d.blocks ?? []));
  }, [roleReady, isChair, selProgram]);

  /* load block by id */
  const loadBlock = useCallback((blockId: string) => {
    setLoading(true);
    fetch(`/api/blocks/${blockId}`)
      .then(r => r.json())
      .then(d => {
        setBlock(d.block ?? null);
        setLoading(false);
      });
  }, []);

  useEffect(() => { loadBlock(id); }, [id, loadBlock]);

  /* once block is loaded, pre-fill filters */
  useEffect(() => {
    if (block && !filtersReady) {
      setSelProgram(String(block.program_id));
      setSelYear(block.year_level);
      setSelSemester(block.semester);
      setSelSchoolYear(block.academic_year);
      setSelBlock(String(block.id));
      setFiltersReady(true);
    }
  }, [block, filtersReady]);

  /* derived dropdown options from allBlocks */
  const yearOptions = [...new Set(
    allBlocks
      .filter(b => !selProgram || String(b.program_id) === selProgram)
      .map(b => b.year_level)
  )].sort();

  const semesterOptions = [...new Set(
    allBlocks
      .filter(b =>
        (!selProgram || String(b.program_id) === selProgram) &&
        (!selYear    || b.year_level === selYear)
      )
      .map(b => b.semester)
  )].sort();

  const schoolYearOptions = [...new Set(
    allBlocks
      .filter(b =>
        (!selProgram   || String(b.program_id) === selProgram) &&
        (!selYear      || b.year_level === selYear) &&
        (!selSemester  || b.semester === selSemester)
      )
      .map(b => b.academic_year)
  )].sort().reverse();

  const blockOptions = allBlocks
    .filter(b =>
      (!selProgram    || String(b.program_id) === selProgram) &&
      (!selYear       || b.year_level === selYear) &&
      (!selSemester   || b.semester === selSemester) &&
      (!selSchoolYear || b.academic_year === selSchoolYear)
    )
    .sort((a, b) => a.block_name.localeCompare(b.block_name));

  /* keep sessionStorage in sync so panel stays open across block navigation */
  useEffect(() => {
    sessionStorage.setItem('blockSwitchOpen', filtersOpen ? '1' : '0');
  }, [filtersOpen]);

  /* when selBlock changes (from dropdown), navigate */
  function handleBlockSelect(newId: string) {
    setSelBlock(newId);
    if (newId && newId !== id) {
      setFiltersReady(false);
      setActiveFilter('all');
      setSubjectSearch('');
      router.push(`/program/blocks/${newId}`);
    }
  }

  /* reset downstream filters when upstream changes */
  function handleProgramChange(v: string) {
    if (isChair) return;
    setSelProgram(v); setSelYear(''); setSelSemester(''); setSelSchoolYear(''); setSelBlock('');
  }
  function handleYearChange(v: string) {
    setSelYear(v); setSelSemester(''); setSelSchoolYear(''); setSelBlock('');
  }
  function handleSemesterChange(v: string) {
    setSelSemester(v); setSelSchoolYear(''); setSelBlock('');
  }
  function handleSchoolYearChange(v: string) {
    setSelSchoolYear(v); setSelBlock('');
  }

  async function handleRemove(bs: SubjectRow) {
    const assigned = bs.schedule_status && bs.schedule_status !== 'Unassigned';
    const msg = assigned
      ? `Remove "${bs.subject_name}"? This subject has an assigned instructor/schedule. Removing it will also delete its schedule entry.`
      : `Remove "${bs.subject_name}" from this block?`;
    if (!confirm(msg)) return;
    const res = await fetch(`/api/blocks/${id}/subjects?block_subject_id=${bs.id}`, { method: 'DELETE' });
    if (res.ok) { toast.delete(`"${bs.subject_name}" removed from block.`); loadBlock(id); }
    else { const d = await res.json(); toast.error(d.error || 'Failed to remove subject.'); }
  }

  async function handleReload() {
    if (!confirm('Reload subjects from curriculum? Missing subjects will be added. Already existing subjects will not be changed.')) return;
    setReloading(true); setReloadMsg('');
    const res = await fetch(`/api/blocks/${id}/reload`, { method: 'POST' });
    const d = await res.json();
    if (res.ok) {
      const msg = d.added === 0
        ? 'All curriculum subjects are already in this block.'
        : `${d.added} new subject${d.added !== 1 ? 's' : ''} added from curriculum.`;
      setReloadMsg(msg);
      toast.success(msg);
      loadBlock(id);
    } else {
      setReloadMsg(d.error || 'Reload failed');
      toast.error(d.error || 'Reload failed.');
    }
    setReloading(false);
  }

  async function openAddSubject() {
    if (!block) return;
    setAddOpen(true); setAvailLoading(true);
    const existingIds = new Set((block.subjects || []).map(s => s.curriculum_id));
    const p = new URLSearchParams({
      program_id: String(block.program_id),
      year_level: block.year_level,
      semester: block.semester,
      curriculum_version: blockCurriculumVersion(block.curriculum_version),
    });
    const res = await fetch('/api/curriculum?' + p);
    const d = await res.json();
    const all: AvailableSubject[] = d.curriculums || [];
    setAvailable(all.filter(s => !existingIds.has(s.id)));
    setAvailLoading(false);
  }

  async function handleAdd(curriculumId: number) {
    setAddingId(curriculumId);
    const res = await fetch(`/api/blocks/${id}/subjects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ curriculum_id: curriculumId }),
    });
    const d = await res.json();
    if (res.ok) { toast.success('Subject added to block.'); setAvailable(a => a.filter(s => s.id !== curriculumId)); loadBlock(id); }
    else { toast.error(d.error || 'Failed to add subject.'); }
    setAddingId(null);
  }

  // ── loading / not found ───────────────────────────────────────────────────

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="w-8 h-8 border-4 border-[#1D5BD6] border-t-transparent rounded-full animate-spin" />
    </div>
  );
  if (!block) return <div className="p-8 text-red-400 font-medium">Block not found.</div>;

  // ── derived values ────────────────────────────────────────────────────────

  const subjects = (block.subjects || []).filter(s => s.curriculum_id != null);

  const unassignedCount = subjects.filter(s => !s.schedule_status || s.schedule_status === 'Unassigned').length;
  const assignedCount   = subjects.filter(s => s.schedule_status === 'Assigned').length;
  const scheduledCount  = subjects.filter(s => s.schedule_status === 'Scheduled').length;
  const totalLecHours   = subjects.reduce((n, s) => n + parseFloat(String(s.lecture_hours    ?? 0)), 0);
  const totalLabHours   = subjects.reduce((n, s) => n + parseFloat(String(s.laboratory_hours ?? 0)), 0);
  const totalHoursSum   = subjects.reduce((n, s) => n + parseFloat(String(s.total_hours      ?? 0)), 0);
  const totalUnits      = subjects.reduce((n, s) => n + parseFloat(String(s.units            ?? 0)), 0);

  const displaySubjects = subjects.filter(s => {
    const matchesFilter =
      activeFilter === 'all'        ? true :
      activeFilter === 'unassigned' ? (!s.schedule_status || s.schedule_status === 'Unassigned') :
      activeFilter === 'assigned'   ? s.schedule_status === 'Assigned' :
                                      s.schedule_status === 'Scheduled';
    const q = subjectSearch.toLowerCase();
    const matchesSearch = !q ||
      s.subject_code.toLowerCase().includes(q) ||
      s.subject_name.toLowerCase().includes(q) ||
      (s.faculty_name || '').toLowerCase().includes(q);
    return matchesFilter && matchesSearch;
  });

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">

      {/* Back */}
      <Link href="/program/blocks"
        className="inline-flex items-center gap-2 text-[#1D5BD6] hover:text-[#60A5FA] text-sm font-medium transition">
        <ArrowLeft className="w-4 h-4" /> Back to Block Creation
      </Link>

      {/* ── Block Navigation Filters ── */}
      <div className="bg-white rounded-2xl shadow-[0_1px_3px_rgba(0,0,0,0.06)] overflow-hidden">
        <button
          type="button"
          aria-expanded={filtersOpen}
          aria-controls="switch-block-panel"
          onClick={() => setFiltersOpen(o => !o)}
          className="w-full flex items-center justify-between gap-3 px-5 py-3.5 hover:bg-slate-50 active:bg-slate-100 focus-visible:outline-none focus-visible:bg-slate-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#164BB5]/25 transition-colors duration-200"
        >
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-1.5 h-5 rounded-full bg-[#1D5BD6] flex-shrink-0" />
            <span className="text-sm font-bold text-slate-700 uppercase tracking-wide">Switch Block</span>
            <span
              className={`text-xs text-slate-400 ml-1 truncate transition-opacity duration-200 ${
                filtersOpen ? 'opacity-0' : 'opacity-100'
              }`}
            >
              — click to change block
            </span>
          </div>
          <ChevronDown
            className={`w-4 h-4 text-slate-400 flex-shrink-0 transition-transform duration-300 ease-out ${
              filtersOpen ? 'rotate-180' : ''
            }`}
            aria-hidden
          />
        </button>

        <div
          id="switch-block-panel"
          aria-hidden={!filtersOpen}
          inert={!filtersOpen ? true : undefined}
          className={`grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none ${
            filtersOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
          }`}
        >
          <div className="min-h-0 overflow-hidden">
            <div
              className={`px-5 pb-5 pt-1 border-t border-slate-100 transition-opacity duration-300 motion-reduce:transition-none ${
                filtersOpen ? 'opacity-100' : 'opacity-0'
              }`}
            >
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">

          {/* Program */}
          <div className="space-y-1">
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Program</label>
            {isChair ? (
              <div className="bg-slate-50 border border-slate-100 rounded-xl px-3 py-2.5 text-sm text-slate-600 font-medium cursor-default select-none truncate">
                {programs.find(p => String(p.id) === selProgram)
                  ? `${programs.find(p => String(p.id) === selProgram)!.code} — ${programs.find(p => String(p.id) === selProgram)!.name}`
                  : '—'}
              </div>
            ) : (
              <FilterSelect value={selProgram} onChange={handleProgramChange} label="Program">
                <option value="">— Program —</option>
                {programs.map(p => (
                  <option key={p.id} value={p.id}>{p.code} — {p.name}</option>
                ))}
              </FilterSelect>
            )}
          </div>

          {/* Year Level */}
          <div className="space-y-1">
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Year Level</label>
            <FilterSelect value={selYear} onChange={handleYearChange} label="Year Level">
              <option value="">— Year Level —</option>
              {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
            </FilterSelect>
          </div>

          {/* Semester */}
          <div className="space-y-1">
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Semester</label>
            <FilterSelect value={selSemester} onChange={handleSemesterChange} label="Semester">
              <option value="">— Semester —</option>
              {semesterOptions.map(s => <option key={s} value={s}>{s}</option>)}
            </FilterSelect>
          </div>

          {/* School Year */}
          <div className="space-y-1">
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">School Year</label>
            <FilterSelect value={selSchoolYear} onChange={handleSchoolYearChange} label="School Year">
              <option value="">— School Year —</option>
              {schoolYearOptions.map(y => <option key={y} value={y}>{y}</option>)}
            </FilterSelect>
          </div>

          {/* Block */}
          <div className="space-y-1">
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Block</label>
            <FilterSelect
              value={selBlock}
              onChange={handleBlockSelect}
              disabled={blockOptions.length === 0}
              label="Block"
            >
              <option value="">Select Block</option>
              {blockOptions.map(b => (
                <option key={b.id} value={b.id}>
                  Block {b.block_name} Â· {curriculumVersionLabel(blockCurriculumVersion(b.curriculum_version))}
                </option>
              ))}
            </FilterSelect>
          </div>

        </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Block header card ── */}
      <div className="w-fit max-w-full inline-flex items-center gap-2.5 bg-white rounded-2xl shadow-[0_1px_3px_rgba(0,0,0,0.06)] px-4 py-2.5">
        <h1 className="text-lg font-bold text-[#0B2A5B] whitespace-nowrap" title={block.program_name}>
          {block.program_code} — Block {block.block_name}
        </h1>
        <span className="text-sm font-medium text-[#64748B] whitespace-nowrap">
          {curriculumVersionLabel(blockCurriculumVersion(block.curriculum_version))}
        </span>
        <span className="sr-only">{block.program_name}</span>
      </div>

      {/* Reload feedback */}
      {reloadMsg && (
        <div className={`flex items-center gap-3 px-5 py-3.5 rounded-xl text-sm font-medium border
          ${reloadMsg.toLowerCase().includes('fail') || reloadMsg.toLowerCase().includes('error')
            ? 'bg-red-500/10 border-red-500/30 text-red-400'
            : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'}`}>
          <CheckCircle className="w-4 h-4 flex-shrink-0" />
          <span className="flex-1">{reloadMsg}</span>
          <button onClick={() => setReloadMsg('')} className="ml-auto text-current opacity-60 hover:opacity-100 transition">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}


      {/* ── Stats ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-3 sm:gap-4">
        {([
          { key: 'unassigned', label: 'Unassigned',     value: unassignedCount },
          { key: 'assigned',   label: 'Assigned',       value: assignedCount },
          { key: 'scheduled',  label: 'Scheduled',      value: scheduledCount },
          { key: 'all',        label: 'Total Subjects', value: subjects.length },
        ] as const).map(stat => {
          const selected = activeFilter === stat.key;
          return (
            <button
              key={stat.key}
              onClick={() => { setActiveFilter(stat.key); setSubjectSearch(''); }}
              className={[
                'bg-white border border-[#E2E8F0] rounded-2xl p-4 text-center shadow-sm transition-colors duration-150 cursor-pointer',
                selected ? 'border-[#CBD5E1]' : 'hover:border-[#D1D5DB]',
              ].join(' ')}
            >
              <div className="text-2xl sm:text-3xl font-bold mb-1 tabular-nums tracking-tight" style={{ color: '#0B2A5B' }}>
                {stat.value}
              </div>
              <div className="text-sm" style={{ color: '#64748B' }}>{stat.label}</div>
              {selected && (
                <div className="mt-2 h-0.5 rounded-full mx-auto w-8 bg-[#0B2A5B]" />
              )}
            </button>
          );
        })}
        <div className="bg-white border border-[#E2E8F0] rounded-2xl p-4 text-center shadow-sm">
          <div className="text-2xl sm:text-3xl font-bold mb-1 tabular-nums tracking-tight" style={{ color: '#0B2A5B' }}>{totalUnits.toFixed(2)}</div>
          <div className="text-sm" style={{ color: '#64748B' }}>Total Units</div>
        </div>
      </div>

      {/* ── Subjects table ── */}
      <div className="bg-[#111827] rounded-2xl border border-white/10 overflow-hidden">

        <div className="px-6 py-4 bg-[#1D5BD6]">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <h2 className="font-bold text-white text-lg flex items-center gap-2">
                Subjects Loaded
                {activeFilter !== 'all' && (
                  <span className="text-sm font-semibold px-2.5 py-1 rounded-full bg-white/20 text-white uppercase tracking-wide">
                    {activeFilter}
                  </span>
                )}
              </h2>
              <p className="text-sm text-white/85 mt-0.5">
                {displaySubjects.length} of {subjects.length} subject{subjects.length !== 1 ? 's' : ''} shown
                {activeFilter !== 'all' && (
                  <button onClick={() => setActiveFilter('all')} className="ml-2 text-base font-semibold text-white hover:text-white/80 underline">
                    show all
                  </button>
                )}
              </p>
            </div>
            <SearchInput
              value={subjectSearch}
              onChange={setSubjectSearch}
              placeholder="Search subjects or instructor…"
              className="min-w-[240px]"
            />
          </div>
        </div>

        {subjects.length === 0 ? (
          <div className="py-16 text-center px-6">
            <AlertTriangle className="w-10 h-10 text-amber-400 mx-auto mb-3" />
            <p className="text-white font-semibold mb-1">No subjects loaded yet</p>
            <p className="text-sm text-slate-400 mb-5">
              Add subjects manually or click <strong className="text-white">Reload from Curriculum</strong> to load them automatically.
            </p>
            <div className="flex justify-center gap-3 flex-wrap">
              <button onClick={openAddSubject}
                className="flex items-center gap-2 bg-[#1D5BD6] text-white px-5 py-2.5 rounded-xl text-base font-semibold hover:bg-[#2E7DD1] transition">
                <Plus className="w-5 h-5" /> Add Subject
              </button>
              <button onClick={handleReload}
                className="flex items-center gap-2 border border-white/10 text-slate-300 px-5 py-2.5 rounded-xl text-base font-medium hover:bg-white/5 transition">
                <RefreshCw className="w-5 h-5" /> Reload from Curriculum
              </button>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-base">
              <thead>
                <tr className="bg-[#0d1424] border-b border-white/10">
                  <th className="text-left px-4 py-3.5 font-semibold text-slate-400 text-sm uppercase tracking-wide whitespace-nowrap">#</th>
                  <th className="text-left px-4 py-3.5 font-semibold text-slate-400 text-sm uppercase tracking-wide whitespace-nowrap">Course Code</th>
                  <th className="text-left px-4 py-3.5 font-semibold text-slate-400 text-sm uppercase tracking-wide">Course Title</th>
                  <th className="text-center px-4 py-3.5 font-semibold text-slate-400 text-sm uppercase tracking-wide whitespace-nowrap">Total Hrs</th>
                  <th className="text-center px-4 py-3.5 font-semibold text-slate-400 text-sm uppercase tracking-wide whitespace-nowrap">Units</th>
                  <th className="text-left px-4 py-3.5 font-semibold text-slate-400 text-sm uppercase tracking-wide whitespace-nowrap">Instructor</th>
                  <th className="text-left px-4 py-3.5 font-semibold text-slate-400 text-sm uppercase tracking-wide whitespace-nowrap">Day / Time</th>
                  <th className="text-left px-4 py-3.5 font-semibold text-slate-400 text-sm uppercase tracking-wide whitespace-nowrap">Room</th>
                  <th className="text-left px-4 py-3.5 font-semibold text-slate-400 text-sm uppercase tracking-wide whitespace-nowrap">Status</th>
                  <th className="text-left px-4 py-3.5 font-semibold text-slate-400 text-sm uppercase tracking-wide whitespace-nowrap">Next Step</th>
                  <th className="px-4 py-3.5" />
                </tr>
              </thead>

              <tbody className="divide-y divide-white/5">
                {displaySubjects.length === 0 ? (
                  <tr>
                    <td colSpan={13} className="py-12 text-center text-slate-500 text-base">
                      No subjects match your search or filter.
                      <button onClick={() => { setActiveFilter('all'); setSubjectSearch(''); }}
                        className="ml-2 text-base font-semibold text-[#1D5BD6] hover:text-[#60A5FA] underline">Clear filters</button>
                    </td>
                  </tr>
                ) : displaySubjects.map((s, rowIdx) => (
                  <tr key={`bs-${s.id}-${s.curriculum_id}`} className="hover:bg-white/5 transition-colors">
                    <td className="px-4 py-4 text-slate-500 text-sm font-medium">{rowIdx + 1}</td>
                    <td className="px-4 py-4">
                      <span className="font-mono font-semibold text-[#334155] bg-[#F1F5F9] px-2.5 py-1 rounded text-sm">
                        {s.subject_code}
                      </span>
                    </td>
                    <td className="px-4 py-4 text-slate-200 font-medium max-w-[240px]">
                      <span title={s.subject_name}>{s.subject_name}</span>
                    </td>
                    <td className="px-4 py-4 text-center font-semibold text-slate-200">
                      {parseFloat(String(s.total_hours)).toFixed(1)}
                    </td>
                    <td className="px-4 py-4 text-center font-bold text-white">
                      {parseFloat(String(s.units)).toFixed(2)}
                    </td>
                    <td className="px-4 py-4 text-slate-300 whitespace-nowrap">
                      {s.faculty_name
                        ? <span className="font-medium">{s.faculty_name}</span>
                        : <span className="text-slate-500 text-sm italic">Not assigned</span>}
                    </td>
                    <td className="px-4 py-4 whitespace-nowrap text-sm">
                      {s.day_pattern
                        ? <><span className="font-semibold text-slate-200">{s.day_pattern}</span><br />
                            <span className="text-slate-400">{s.start_time?.slice(0, 5)} – {s.end_time?.slice(0, 5)}</span></>
                        : <span className="text-slate-500">—</span>}
                    </td>
                    <td className="px-4 py-4 text-slate-300">
                      {s.room_name || <span className="text-slate-500">—</span>}
                    </td>
                    <td className="px-4 py-4">
                      {scheduleStatusChip(s.schedule_status || 'Unassigned')}
                    </td>
                    <td className="px-4 py-4">
                      {(!s.schedule_status || s.schedule_status === 'Unassigned') && (
                        <NextStepLink href="/workload">Assign instructor</NextStepLink>
                      )}
                      {s.schedule_status === 'Assigned' && (
                        <NextStepLink href="/scheduling">Set schedule</NextStepLink>
                      )}
                    </td>
                    <td className="px-4 py-4">
                      <button onClick={() => handleRemove(s)}
                        className="inline-flex items-center justify-center min-h-11 min-w-11 p-2 text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-lg transition"
                        title="Remove from block">
                        <Trash2 className="w-5 h-5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>

              <tfoot>
                <tr className="bg-[#0d1424] border-t border-white/10 text-white">
                  <td className="px-4 py-3.5 text-sm font-bold uppercase tracking-wide text-slate-300" colSpan={3}>
                    Total — {subjects.length} subject{subjects.length !== 1 ? 's' : ''}
                  </td>
                  <td className="px-4 py-3 text-center font-bold text-white">{totalHoursSum.toFixed(1)}</td>
                  <td className="px-4 py-3 text-center font-bold text-white">{totalUnits.toFixed(2)}</td>
                  <td colSpan={5} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {/* ── Add Subject Modal ── */}
      {addOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          data-modal-root
          onClick={() => setAddOpen(false)}
          onKeyDown={e => { if (e.key === 'Escape') setAddOpen(false); }}
          tabIndex={-1}
          role="presentation"
        >
          <div
            className="bg-[#111827] border border-white/10 rounded-2xl shadow-2xl w-full max-w-lg flex flex-col max-h-[90vh]"
            onClick={e => e.stopPropagation()}
          >

            <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 flex-shrink-0">
              <div>
                <h3 className="font-bold text-white">Add Subject to Block</h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  {block.program_code} {curriculumVersionLabel(blockCurriculumVersion(block.curriculum_version))} Â· {block.year_level}, {block.semester}
                </p>
              </div>
              <button onClick={() => setAddOpen(false)}
                className="p-2 text-slate-400 hover:text-white rounded-xl hover:bg-white/10 transition">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 overflow-y-auto flex-1">
              {availLoading ? (
                <div className="flex justify-center py-10">
                  <div className="w-7 h-7 border-[3px] border-[#1D5BD6] border-t-transparent rounded-full animate-spin" />
                </div>
              ) : available.length === 0 ? (
                <div className="text-center py-10">
                  <CheckCircle className="w-10 h-10 text-emerald-400 mx-auto mb-2" />
                  <p className="text-white font-semibold">All curriculum subjects are loaded.</p>
                  <p className="text-sm text-slate-400 mt-1">
                    To add a new subject, update the{' '}
                    <Link href="/program/curriculum" onClick={() => setAddOpen(false)}
                      className="text-[#1D5BD6] hover:underline font-medium">Curriculum</Link> first.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {available.map(s => (
                    <div key={`avail-${s.id}`}
                      className="flex items-center justify-between p-3.5 border border-white/10 rounded-xl hover:bg-white/5 hover:border-white/20 transition">
                      <div>
                        <div className="font-mono font-bold text-blue-400 text-sm">{s.subject_code}</div>
                        <div className="text-sm text-slate-200 font-medium mt-0.5">{s.subject_name}</div>
                        <div className="text-xs text-slate-400 mt-0.5">
                          Lec {s.lecture_hours}h Â· Lab {s.laboratory_hours}h Â· {parseFloat(String(s.units)).toFixed(2)} units
                        </div>
                      </div>
                      <button
                        onClick={() => handleAdd(s.id)}
                        disabled={addingId === s.id}
                        className="flex items-center gap-1.5 bg-[#1D5BD6] text-white px-3.5 py-2 rounded-lg text-xs font-semibold hover:bg-[#2E7DD1] disabled:opacity-50 transition flex-shrink-0 ml-4">
                        {addingId === s.id
                          ? <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                          : <Plus className="w-3.5 h-3.5" />}
                        Add
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-white/10 bg-white/5 rounded-b-2xl flex-shrink-0">
              <button onClick={() => setAddOpen(false)}
                className="w-full py-2.5 border border-white/10 text-slate-300 rounded-xl hover:bg-white/10 transition text-sm font-semibold">
                Close
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

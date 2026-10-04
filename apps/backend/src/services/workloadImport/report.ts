import type { ImportReport } from './apply';

/* Plain Markdown report of an import or dry run (no passwords, ever). */

const n = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));

export function renderImportReport(r: ImportReport): string {
  const out: string[] = [];
  const line = (s = '') => out.push(s);
  const plan = r.plan;
  const imported = r.classes.filter(c => c.status === 'imported');
  const unchanged = r.classes.filter(c => c.status === 'unchanged');
  const kept = r.classes.filter(c => c.status === 'kept-existing');
  const overLimit = r.classes.filter(c => c.status === 'over-limit');
  const comps = imported.flatMap(c => c.components.map(k => ({ c, k })));
  const count = (res: string) => comps.filter(x => x.k.result === res).length;

  line(`# Excel workload import — ${r.mode === 'apply' ? (r.committed ? 'APPLIED' : 'NOT applied') : 'DRY RUN (nothing saved)'}`);
  line();
  line(`- File: ${r.file.split(/[\\/]/).pop()}`);
  line(`- Term: ${r.term.semester}, ${r.term.academicYear} (school year ${r.schoolYear === 'created' ? 'added to Settings, not made active' : 'already in Settings'})`);
  line(`- Sheets read: ${plan.workbook.sheetsRead} visible (${plan.workbook.hiddenSkipped} hidden sheets skipped); ${plan.workbook.classRows} class rows, ${plan.workbook.activityRows} non-teaching rows`);
  line(`- Non-faculty sheets: ${plan.workbook.nonFacultySheets.join(', ') || 'none'}`);
  line();

  line('## Faculty');
  line();
  line('| Faculty (form) | Status on form | Decision | Sheets |');
  line('|---|---|---|---|');
  for (const p of plan.workbook.persons) line(`| ${p.name} | ${p.status} | ${p.scope} | ${p.sheets.join(', ')} |`);
  line();
  const perm = plan.faculty.filter(f => f.classification === 'Permanent');
  const cont = plan.faculty.filter(f => f.classification === 'Contractual');
  line(`- Permanent: ${perm.length} (${perm.filter(f => f.existing).length} existing, ${perm.filter(f => !f.existing).length} new)`);
  line(`- Contractual: ${cont.length} (${cont.filter(f => f.existing).length} existing, ${cont.filter(f => !f.existing).length} new)`);
  line(`- Created: ${r.faculty.created.map(f => `${f.name} (#${f.id}, ${f.program ?? 'no program'})`).join('; ') || 'none'}`);
  line(`- Accounts created: ${r.faculty.accounts.map(a => `${a.name} → ${a.username} (${a.email})`).join('; ') || 'none'} — initial password as instructed (not shown)`);
  line(`- Profile fields filled (were empty): ${r.faculty.profileFilled.length}`);
  for (const p of r.faculty.profileFilled) line(`  - ${p.name}: ${p.fields.join('; ')}`);
  line();

  line('## Rooms and blocks');
  line();
  line(`- Matched: ${[...new Set(r.rooms.matched.map(m => `${m.excel} → ${m.room}`))].join(', ') || 'none'}`);
  line(`- Created from room names on the forms: ${r.rooms.created.map(x => `${x.name} (${x.type}; ${x.reason})`).join('; ') || 'none'}`);
  line(`- Blocks created: ${r.blocks.created.length ? `${r.blocks.created.length} — ${r.blocks.created.join(', ')}` : 'none'}`);
  line(`- Blocks already in QRganize: ${r.blocks.existing.join(', ') || 'none'}`);
  line();

  line('## Classes');
  line();
  line(`- Planned: ${plan.classes.length}; imported: ${imported.length}; already in QRganize (unchanged): ${unchanged.length}; kept QRganize's different data: ${kept.length}; not assigned (over a Contractual hours limit): ${overLimit.length}`);
  line(`- Components: ${count('as-written')} exactly as on the form, ${count('adjusted')} with the length set to QRganize's hours, ${count('other-sheet')} from another sheet's time, ${count('moved')} moved to a vacant time, ${count('unscheduled')} left unscheduled`);
  line(`- Time conflicts: ${r.conflicts.timeDetected} detected, ${r.conflicts.timeResolved} resolved; room conflicts: ${r.conflicts.roomDetected} detected, ${r.conflicts.roomResolved} resolved`);
  line();
  line('| Faculty | Class | Category | Lec | Lab | Notes |');
  line('|---|---|---|---|---|---|');
  for (const c of r.classes) {
    const cell = (type: 'lec' | 'lab') => {
      const k = c.components.find(x => x.type === type);
      if (!k) return '—';
      if (k.result === 'unscheduled') return 'unscheduled';
      return `${k.sessions} · ${k.rooms}${k.result === 'as-written' ? '' : ` (${k.result})`}`;
    };
    const notes = [...c.notes, ...c.components.flatMap(k => [...k.notes, ...k.roomNotes])];
    line(`| ${c.faculty} | ${c.subject} — ${c.block} | ${c.status === 'imported' ? c.category : c.status} | ${cell('lec')} | ${cell('lab')} | ${notes.join(' · ').replace(/\|/g, '/')} |`);
  }
  line();

  line('## Moved, adjusted or room-changed');
  line();
  for (const { c, k } of comps.filter(x => x.k.result !== 'as-written' || x.k.roomNotes.length)) {
    line(`- ${c.faculty} — ${c.subject.split(' ').slice(0, 2).join(' ')} ${c.block} ${k.type === 'lec' ? 'Lec' : 'Lab'}: form ${k.formTime} → ${k.result === 'unscheduled' ? 'unscheduled' : `${k.sessions} (${k.rooms})`}`);
    for (const note of [...k.timeConflicts.map(t => `conflict: ${t}`), ...k.notes, ...k.roomNotes]) line(`  - ${note}`);
  }
  line();

  line('## Left without a room (blank on the form)');
  line();
  const blank = comps.filter(x => x.k.result !== 'unscheduled' && x.k.rooms.includes('no room') && !x.k.roomNotes.length);
  for (const { c, k } of blank) line(`- ${c.faculty} — ${c.subject.split(' ').slice(0, 2).join(' ')} ${c.block} ${k.type === 'lec' ? 'Lec' : 'Lab'} ${k.sessions}`);
  if (!blank.length) line('- none');
  line();

  line('## Non-teaching time');
  line();
  line(`- Recorded: ${r.activities.inserted} (already present: ${r.activities.existing})`);
  for (const s of r.activities.clipped) line(`- clipped: ${s}`);
  for (const s of r.activities.dropped) line(`- not recorded: ${s}`);
  line();

  line('## Deloading');
  line();
  for (const d of r.deductions) line(`- ${d.faculty}: ${d.status} — ${d.detail}`);
  if (!r.deductions.length) line('- none on the Regular Load forms');
  line();

  line('## Workload totals (QRganize calculation vs the forms)');
  line();
  line('| Faculty | Type | Regular | Overload | Praise | Deloading | Regular limit | Forms: Reg / Ovl / Praise |');
  line('|---|---|---|---|---|---|---|---|');
  for (const t of r.totals) {
    const over = t.regular > t.limit + 0.001 ? ' ⚠ over limit' : '';
    line(`| ${t.faculty} | ${t.employment} (${t.unit}) | ${n(t.regular)}${over} | ${n(t.overload)} | ${n(t.praise)} | ${n(t.deloading)} | ${n(t.limit)} | ${n(t.excel.regular)} / ${n(t.excel.overload)} / ${n(t.excel.praise)} |`);
  }
  line();
  const diffs = imported.filter(c => c.unit === 'units' && Math.abs(c.value - c.excelUnits) > 0.011);
  line(`Classes whose form units differ from QRganize's (${diffs.length} ${diffs.length === 1 ? 'class' : 'classes'}):`);
  for (const c of diffs) line(`- ${c.faculty} — ${c.subject} ${c.block}: form ${n(c.excelUnits)} units, QRganize ${n(c.value)} units (Lec hours + Lab hours × 0.75)`);
  line();

  line('## Validation');
  line();
  for (const v of r.validation) line(`- ${v.ok ? 'PASS' : 'FAIL'} — ${v.name}${v.ok ? '' : `: ${v.detail}`}`);
  line();

  line('## Needs review / not imported');
  line();
  for (const level of ['skipped', 'review', 'info'] as const) {
    const list = r.issues.filter(i => i.level === level);
    if (!list.length) continue;
    line(`### ${level === 'skipped' ? 'Not imported' : level === 'review' ? 'Review' : 'Notes'} (${list.length})`);
    for (const i of list) line(`- [${i.topic}] ${i.message}${i.source ? ` (${i.source.sheet} r${i.source.row})` : ''}`);
    line();
  }
  return out.join('\n');
}

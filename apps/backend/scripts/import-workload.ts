/*
 * Import a faculty workload workbook (NEMSU teaching-load forms) into QRganize.
 *
 *   npx tsx --env-file=apps/backend/.env.local --tsconfig apps/backend/tsconfig.json \
 *     apps/backend/scripts/import-workload.ts "<workbook.xlsx>" [--apply] [--report report.md]
 *     [--academic-year 2026-2027] [--semester "1st Semester"] [--initial-password "<password>"]
 *
 * New faculty accounts get the --initial-password (or IMPORT_INITIAL_PASSWORD);
 * there is no built-in default, so imported accounts never share a guessable one.
 *
 * Without --apply it is a dry run: the whole import runs in a transaction that
 * is rolled back, and the report shows what would happen. With --apply the
 * same transaction is committed. Running it again does not duplicate anything.
 */
import fs from 'node:fs';
import path from 'node:path';
import pool from '@/database/db';
import { runWorkloadImport } from '@/services/workloadImport/apply';
import { renderImportReport } from '@/services/workloadImport/report';
import { weakPasswordReason } from '@/auth/passwordPolicy';

const VALUE_FLAGS = new Set(['--report', '--academic-year', '--semester', '--initial-password']);

/** Command line: one workbook path, --apply, and flags that take a value */
function parseArgs(argv: string[]) {
  const values = new Map<string, string>();
  const positional: string[] = [];
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    if (VALUE_FLAGS.has(argv[i])) values.set(argv[i], argv[++i] ?? '');
    else if (argv[i] === '--apply') apply = true;
    else positional.push(argv[i]);
  }
  return { file: positional[0], apply, value: (name: string) => values.get(name) };
}

/** "BSINF Workload 1st Sem A.Y. 26-27.xlsx" → 1st Semester, 2026-2027 */
function termFromFileName(file: string): { academicYear?: string; semester?: string } {
  const name = path.basename(file);
  const sem = /\b1st\s*sem/i.test(name) ? '1st Semester' : /\b2nd\s*sem/i.test(name) ? '2nd Semester' : /summer/i.test(name) ? 'Summer' : undefined;
  const ay = name.match(/(?:A\.?\s*Y\.?|S\.?\s*Y\.?)\s*(\d{2,4})\s*[-–]\s*(\d{2,4})/i);
  const full = (y: string) => (y.length === 2 ? `20${y}` : y);
  return { semester: sem, academicYear: ay ? `${full(ay[1])}-${full(ay[2])}` : undefined };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { file, apply } = args;
  if (!file || !fs.existsSync(file)) {
    console.error('Usage: import-workload.ts "<workbook.xlsx>" --initial-password "<password>" [--apply] [--report report.md] [--academic-year YYYY-YYYY] [--semester "1st Semester"]');
    process.exit(2);
  }
  const guessed = termFromFileName(file);
  const academicYear = args.value('--academic-year') ?? guessed.academicYear;
  const semester = args.value('--semester') ?? guessed.semester;
  if (!academicYear || !/^\d{4}-\d{4}$/.test(academicYear) || !semester) {
    console.error('Could not tell the term from the file name — pass --academic-year YYYY-YYYY and --semester "1st Semester".');
    process.exit(2);
  }
  // Password for the accounts of new faculty — given each time, never a built-in default
  const initialPassword = args.value('--initial-password') ?? process.env.IMPORT_INITIAL_PASSWORD ?? '';
  const weak = initialPassword.length < 8 ? 'it must be at least 8 characters' : weakPasswordReason(initialPassword);
  if (weak) {
    console.error(`Give new faculty accounts a strong starting password with --initial-password "<password>" (or IMPORT_INITIAL_PASSWORD): ${weak}`);
    process.exit(2);
  }
  console.log(`${apply ? 'Importing' : 'Dry run of'} ${path.basename(file)} for ${semester}, ${academicYear}…`);

  const report = await runWorkloadImport({ filePath: file, term: { academicYear, semester }, apply, initialPassword });
  const text = renderImportReport(report);
  const out = args.value('--report');
  if (out) fs.writeFileSync(out, text, 'utf8');

  const imported = report.classes.filter(c => c.status === 'imported').length;
  const failed = report.validation.filter(v => !v.ok);
  console.log(`${report.committed ? 'Saved' : 'Not saved (dry run)'} — classes imported: ${imported}, unchanged: ${report.classes.filter(c => c.status === 'unchanged').length}, ` +
    `faculty created: ${report.faculty.created.length}, accounts: ${report.faculty.accounts.length}, blocks: ${report.blocks.created.length}, rooms: ${report.rooms.created.length}.`);
  console.log(`Validation: ${report.validation.length - failed.length}/${report.validation.length} passed${failed.length ? ` — failed: ${failed.map(f => f.name).join('; ')}` : ''}.`);
  console.log(`Needs review: ${report.issues.filter(i => i.level !== 'info').length} item(s).${out ? ` Full report: ${out}` : ' Pass --report <file> for the full report.'}`);
}

main()
  .catch(err => {
    console.error('Import failed — nothing was saved:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  // Let the last real-time / notification writes (queued a few ms after commit) finish first
  .finally(() => new Promise(resolve => setTimeout(resolve, 800)).then(() => pool.end()));

import { NextResponse } from 'next/server';
import { query } from '@/database/db';
import { parseId } from '@/database/ids';
import { EMAIL_ALREADY_REGISTERED } from '@/auth/emailIdentity';
import { resetFacultyProfileColumns } from '@/database/schema-guard';

/** Positions allowed by faculty_position_check2. */
export const FACULTY_POSITIONS = [
  'Temporary Permanent',
  'Temporary Permanent',
  'Instructor I', 'Instructor II', 'Instructor III',
  'Assistant Professor I', 'Assistant Professor II', 'Assistant Professor III',
  'Assistant Professor IV', 'Assistant Professor V',
  'Associate Professor I', 'Associate Professor II',
  'Associate Professor III', 'Associate Professor IV',
  'Professor I', 'Professor II', 'Professor III',
  'Professor IV', 'Professor V', 'Professor VI',
  'Contractual',
] as const;

export type FacultyFieldError = { error: string; field: string };

/**
 * Cast $2 to varchar in SET and CASE so PostgreSQL does not fail with
 * 42P08 (inconsistent types deduced for parameter $2: text vs varchar).
 * $2 is the new email. `email` on the right-hand side is the existing row value.
 */
export const INSTRUCTOR_EMAIL_GOOGLE_SQL = `
  email = $2::varchar,
  google_sub = CASE WHEN lower(trim(email)) IS DISTINCT FROM lower(trim($2::varchar)) THEN NULL ELSE google_sub END,
  google_verified = CASE WHEN lower(trim(email)) IS DISTINCT FROM lower(trim($2::varchar)) THEN FALSE ELSE google_verified END,
  google_verified_at = CASE WHEN lower(trim(email)) IS DISTINCT FROM lower(trim($2::varchar)) THEN NULL ELSE google_verified_at END,
  google_picture = CASE WHEN lower(trim(email)) IS DISTINCT FROM lower(trim($2::varchar)) THEN NULL ELSE google_picture END
`.trim();

export function parseProgramId(raw: unknown): { ok: true; id: number } | { ok: false; error: FacultyFieldError } {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: false, error: { error: 'Program is required.', field: 'program_id' } };
  }
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n <= 0) {
    return { ok: false, error: { error: 'Invalid program selected.', field: 'program_id' } };
  }
  return { ok: true, id: n };
}

export async function resolveRequiredProgramId(
  raw: unknown,
): Promise<{ ok: true; id: number } | { ok: false; error: FacultyFieldError }> {
  const parsed = parseProgramId(raw);
  if (!parsed.ok) return parsed;

  const result = await query(
    'SELECT id FROM programs WHERE id = $1 AND is_active IS NOT FALSE',
    [parsed.id],
  );
  if (result.rows.length === 0) {
    return { ok: false, error: { error: 'Invalid program selected.', field: 'program_id' } };
  }
  return { ok: true, id: parsed.id };
}

/**
 * A faculty member's Program is optional: blank → null (no program); a value
 * must be an active program.
 */
export async function resolveOptionalProgramId(
  raw: unknown,
): Promise<{ ok: true; id: number | null } | { ok: false; error: FacultyFieldError }> {
  if (raw === null || raw === undefined || String(raw).trim() === '') return { ok: true, id: null };
  return resolveRequiredProgramId(raw);
}

export function parsePosition(raw: unknown): { ok: true; position: string } | { ok: false; error: FacultyFieldError } {
  const position = String(raw ?? '').trim();
  if (!position) {
    return { ok: false, error: { error: 'Position / Academic Rank is required.', field: 'position' } };
  }
  if (!(FACULTY_POSITIONS as readonly string[]).includes(position)) {
    return { ok: false, error: { error: 'Invalid position selected.', field: 'position' } };
  }
  return { ok: true, position };
}

export function parseFacultyId(raw: string): number | null {
  return parseId(raw);
}

type PgError = Error & {
  code?: string;
  constraint?: string;
  column?: string;
  table?: string;
};

/** Map known PostgreSQL errors from faculty / instructor-account writes. */
export function classifyFacultyPgError(error: unknown): NextResponse | null {
  const err = error as PgError;
  const code = err.code ?? '';
  const msg = (err.message ?? String(error)).toLowerCase();

  switch (code) {
    case '23505':
      if (err.constraint?.includes('username') || msg.includes('username')) {
        return NextResponse.json(
          { error: 'Username already exists. Please choose another username.', field: 'username' },
          { status: 409 },
        );
      }
      if (err.constraint?.includes('email') || msg.includes('email') || msg.includes('account_email_registry')) {
        return NextResponse.json(
          { error: EMAIL_ALREADY_REGISTERED, field: 'email' },
          { status: 409 },
        );
      }
      if (err.constraint?.includes('faculty_id') || msg.includes('faculty_id')) {
        return NextResponse.json(
          { error: 'This faculty member already has an account.' },
          { status: 409 },
        );
      }
      return NextResponse.json(
        { error: 'A duplicate record already exists. Please check your input.' },
        { status: 409 },
      );
    case '23502':
      return NextResponse.json(
        { error: `A required field is missing in the database: "${err.column ?? 'unknown'}". Please contact the administrator.` },
        { status: 400 },
      );
    case '23503':
      return NextResponse.json(
        { error: 'A referenced record (e.g. Program) does not exist. Please verify your selections.' },
        { status: 400 },
      );
    case '23514':
      return NextResponse.json(
        { error: 'One of the submitted values is invalid. Please verify Position and other fields.', field: 'position' },
        { status: 400 },
      );
    case '42703':
      resetFacultyProfileColumns();
      return NextResponse.json(
        { error: 'The database schema is out of date. The server will self-heal on the next request — please try again in a moment.' },
        { status: 503 },
      );
    case '42P01':
      return NextResponse.json(
        { error: 'A required database table is missing. Please restart the server to run migrations.' },
        { status: 503 },
      );
    case '22P02':
    case '22001':
      return NextResponse.json(
        { error: 'One or more fields contain invalid data. Please check your input.' },
        { status: 400 },
      );
    default:
      return null;
  }
}

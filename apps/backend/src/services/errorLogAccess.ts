import type { NextRequest } from 'next/server';
import { getAuthUser } from '@/auth/auth';

/** System → Error Logs is for Administrators and Program Chairs (same as the audit trail). */
export async function errorLogViewer(req: NextRequest): Promise<{ role: string; name: string } | null> {
  const auth = await getAuthUser(req) as { role?: string; name?: string; username?: string } | null;
  if (!auth || (auth.role !== 'admin' && auth.role !== 'program_chair')) return null;
  return { role: auth.role, name: String(auth.name ?? auth.username ?? 'Administrator').slice(0, 120) };
}

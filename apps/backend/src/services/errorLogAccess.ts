import type { NextRequest } from 'next/server';
import { getAuthUser } from '@/auth/auth';

/** System → Error Logs is for Administrators only (same as the audit trail; chairs don't see System logs). */
export async function errorLogViewer(req: NextRequest): Promise<{ role: string; name: string } | null> {
  const auth = await getAuthUser(req) as { role?: string; name?: string; username?: string } | null;
  if (!auth || (auth.role !== 'admin')) return null;
  return { role: auth.role, name: String(auth.name ?? auth.username ?? 'Administrator').slice(0, 120) };
}

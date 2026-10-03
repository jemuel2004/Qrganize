import { Pool, PoolClient } from 'pg';
import { APP_TIMEZONE } from '@/services/appTimezone';

const isProd = process.env.NODE_ENV === 'production';

/**
 * Production uses SSL for remote databases. It is skipped when the database
 * runs on the same machine (local PostgreSQL usually has no SSL) or when
 * explicitly disabled with DB_SSL=false or ?sslmode=disable in DATABASE_URL.
 */
function shouldUseSsl(): boolean {
  if (!isProd) return false;
  if ((process.env.DB_SSL || '').trim().toLowerCase() === 'false') return false;
  try {
    const url = new URL(process.env.DATABASE_URL || '');
    if (url.searchParams.get('sslmode') === 'disable') return false;
    if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)) return false;
  } catch {
    // Unparseable URL — keep the secure default.
  }
  return true;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: shouldUseSsl()
    ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' }
    : false,
  /* Dev: fewer idle PG sockets on the laptop. Production keeps a larger pool. */
  max: isProd ? 10 : 4,
  idleTimeoutMillis: isProd ? 30_000 : 10_000,
});

// Every connection works in Philippine time, whatever the database server's
// default (hosted databases usually run in UTC). CURRENT_DATE / LOCALTIME and
// naive TIMESTAMP columns written with NOW() (scan times, created_at) then
// line up with the Manila dates and class times the rest of the app uses.
// Set once per new connection and awaited before its first query (a query
// sent while another is still running on the same client is deprecated in pg).
const zoned = new WeakSet<PoolClient>();

/** A pooled client in Philippine time — release() it when done */
export async function connectClient(): Promise<PoolClient> {
  const client = await pool.connect();
  if (!zoned.has(client)) {
    try {
      await client.query(`SET TIME ZONE '${APP_TIMEZONE}'`);
      zoned.add(client);
    } catch (err) {
      console.error('[db] Could not set the session time zone:', (err as Error).message);
    }
  }
  return client;
}

export async function query(text: string, params?: unknown[]) {
  const client = await connectClient();
  try {
    const result = await client.query(text, params);
    client.release();
    return result;
  } catch (err) {
    // Like pool.query: a connection that failed a query is not reused
    client.release(err as Error);
    throw err;
  }
}

export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await connectClient();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Without this handler, an idle PostgreSQL client that drops its network
// connection emits an 'error' event. In Node.js 15+ an unhandled
// EventEmitter error crashes the process, causing the Next.js server to
// briefly return HTML error pages — triggering "Unexpected token '<'" on
// the client side. Logging here lets the pool recover gracefully.
pool.on('error', (err) => {
  console.error('[db] Idle client error (pool will recover):', err.message);
});

export default pool;

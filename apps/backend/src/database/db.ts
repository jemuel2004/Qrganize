import { Pool, PoolClient } from 'pg';

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

export async function query(text: string, params?: unknown[]) {
  return pool.query(text, params);
}

export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
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

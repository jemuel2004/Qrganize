import { Pool, PoolClient } from 'pg';

const isProd = process.env.NODE_ENV === 'production';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isProd
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

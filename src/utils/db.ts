// src/utils/db.ts
import { createPool, Pool, PoolOptions } from 'mysql2/promise';

declare global {
  var dbPool: Pool | undefined;
}

const sanitizeEnv = (value?: string): string | undefined => {
  if (!value) return undefined;
  return value.replace(/\\n/g, '').trim().replace(/^['\"]|['\"]$/g, '');
};

const buildPoolConfig = (): PoolOptions => {
  const databaseUrl = sanitizeEnv(process.env.DATABASE_URL);
  const sslRejectUnauthorized = sanitizeEnv(process.env.DB_SSL_REJECT_UNAUTHORIZED) === 'true';

  if (databaseUrl) {
    const parsed = new URL(databaseUrl);
    return {
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : 3306,
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      database: parsed.pathname.replace(/^\//, '') || undefined,
      ssl: parsed.searchParams.get('ssl-mode')?.toUpperCase() === 'REQUIRED' ? { rejectUnauthorized: sslRejectUnauthorized } : undefined,
      waitForConnections: true,
      connectionLimit: 50,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
    };
  }

  const dbHost = sanitizeEnv(process.env.DB_HOST);
  const dbUser = sanitizeEnv(process.env.DB_USER);
  const dbPassword = sanitizeEnv(process.env.DB_PASSWORD);
  const dbDatabase = sanitizeEnv(process.env.DB_DATABASE);
  const dbPort = sanitizeEnv(process.env.DB_PORT);

  return {
    host: dbHost,
    user: dbUser,
    password: dbPassword,
    database: dbDatabase,
    port: dbPort ? Number(dbPort) : undefined,
    ssl: dbPort ? { rejectUnauthorized: sslRejectUnauthorized } : undefined,
    waitForConnections: true,
    connectionLimit: 50,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
  };
};


// This function creates and returns the singleton database pool.
export function getDbConnection(): Promise<Pool> {
  if (!global.dbPool) {
    try {
      global.dbPool = createPool(buildPoolConfig());
      console.log('Database connection pool created.');
    } catch (err) {
      console.error('Failed to create database connection pool:', err);
      throw new Error('Failed to initialize the database pool.');
    }
  }
  return Promise.resolve(global.dbPool);
}

// Optional: Function to close the pool when the application shuts down
export async function closeDbPool() {
  if (global.dbPool) {
    try {
      await global.dbPool.end();
      console.log('Database connection pool closed.');
    } catch (error) {
      console.error('Error closing database connection pool:', error);
    } finally {
      global.dbPool = undefined;
    }
  }
}

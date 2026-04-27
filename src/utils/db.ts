// src/utils/db.ts
import { createPool, Pool } from 'mysql2/promise';

declare global {
  var dbPool: Pool | undefined;
}

// This function creates and returns the singleton database pool.
export function getDbConnection(): Promise<Pool> {
  if (!global.dbPool) {
    try {
      global.dbPool = createPool({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_DATABASE,
        waitForConnections: true,
        connectionLimit: 50,
        enableKeepAlive: true,
        keepAliveInitialDelay: 0,
      });
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

// src/utils/db.ts
import { createPool, Pool } from 'mysql2/promise';

let pool: Pool | null = null;

// This function creates and returns the singleton database pool.
// createPool() in mysql2/promise is synchronous — it returns a Pool directly,
// not a Promise. The singleton pattern here prevents multiple pools being created
// under concurrent requests (the original TOCTOU fix).
export function getDbConnection(): Promise<Pool> {
  if (!pool) {
    try {
      pool = createPool({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_DATABASE,
        waitForConnections: true,
        connectionLimit: 10,
      });
      console.log('Database connection pool created.');
    } catch (err) {
      console.error('Failed to create database connection pool:', err);
      throw new Error('Failed to initialize the database pool.');
    }
  }
  return Promise.resolve(pool);
}

// Optional: Function to close the pool when the application shuts down
export async function closeDbPool() {
  if (pool) {
    try {
      await pool.end();
      console.log('Database connection pool closed.');
    } catch (error) {
      console.error('Error closing database connection pool:', error);
    } finally {
      pool = null;
    }
  }
}

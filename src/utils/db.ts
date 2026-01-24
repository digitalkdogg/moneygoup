// src/utils/db.ts
import { createPool, Pool, PoolConnection } from 'mysql2/promise';

let pool: Pool | null = null;

// This function creates and returns a new database connection from the pool.
// It reads the connection details from environment variables.
export async function getDbConnection(): Promise<PoolConnection> {
  if (!pool) {
    try {
      pool = createPool({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_DATABASE,
        waitForConnections: true,
        connectionLimit: 10, // Adjust as needed
        queueLimit: 0,
      });
      console.log('Database connection pool created.');
    } catch (error) {
      console.error("Failed to create database connection pool:", error);
      throw new Error("Failed to initialize the database pool.");
    }
  }

  try {
    const connection = await pool.getConnection();
    return connection;
  } catch (error) {
    console.error("Failed to get connection from pool:", error);
    throw new Error("Failed to get a database connection.");
  }
}

// Optional: Function to close the pool when the application shuts down
export async function closeDbPool() {
  if (pool) {
    await pool.end();
    pool = null;
    console.log('Database connection pool closed.');
  }
}

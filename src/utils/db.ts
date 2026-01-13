// src/utils/db.ts
import mysql from 'mysql2/promise';

// This function creates and returns a new database connection.
// It reads the connection details from environment variables.
export async function getDbConnection() {
  try {
    const connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
    });
    return connection;
  } catch (error) {
    console.error("Database connection failed:", error);
    throw new Error("Failed to connect to the database.");
  }
}

// src/utils/databaseHelper.ts
import { getDbConnection } from './db';
import mysql from 'mysql2/promise';

// Allowlist of tables this helper is permitted to touch.
// If a caller passes a table name not in this set, the query is rejected
// before it reaches the database — preventing injection if this helper is
// ever refactored to accept user-influenced input.
const ALLOWED_TABLES = new Set([
  'stocks',
  'user_stocks',
  'users',
  'stocksdailyprice',
  'news',
  'user_stock_news',
  'recommended_stocks',
  'recommended_markets',
  'user_stock_predictions',
  'stock_gps_scores',
  'stock_gps_score_history',
]);

/**
 * Validates that a table name is in the explicit allowlist.
 */
function assertValidTable(tableName: string): void {
  if (!ALLOWED_TABLES.has(tableName)) {
    throw new Error(`Invalid or disallowed table name: "${tableName}"`);
  }
}

/**
 * Validates that a column name contains only safe characters.
 * Allows letters, digits, and underscores — no spaces, quotes, or operators.
 */
function assertValidColumnName(columnName: string): void {
  const columnNameRegex = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
  if (!columnNameRegex.test(columnName)) {
    throw new Error(`Invalid column name: "${columnName}"`);
  }
}

/**
 * Validates the full ORDER BY clause — not just the first word.
 *
 * IMPORTANT: A previous version only validated `orderBy.split(' ')[0]`, which
 * allowed injection via payloads like "name ASC; DROP TABLE stocks--" where
 * "name" passes the column check but the rest is raw SQL. This version
 * validates the entire string against a strict pattern.
 *
 * Accepted formats:
 *   "column_name"           e.g. "date"
 *   "column_name ASC"       e.g. "price ASC"
 *   "column_name DESC"      e.g. "created_at DESC"
 *
 * All current call sites of select() pass hardcoded string literals for
 * orderBy, so this pattern covers every legitimate use in the codebase.
 * If you need multi-column or expression-based ORDER BY, use executeRawQuery
 * with a fully static SQL string instead.
 */
function assertValidOrderBy(orderBy: string): void {
  const orderByRegex = /^[a-zA-Z_][a-zA-Z0-9_]*(\s+(ASC|DESC))?$/i;
  if (!orderByRegex.test(orderBy.trim())) {
    throw new Error(
      `Invalid ORDER BY clause: "${orderBy}". ` +
        'Must be a single column name with an optional ASC or DESC direction.'
    );
  }
}

/**
 * Acquires a connection from the pool, runs the operation, then releases it.
 */
async function withConnection<T>(
  operation: (connection: mysql.PoolConnection) => Promise<T>
): Promise<T> {
  const pool = await getDbConnection();
  const connection = await pool.getConnection();
  try {
    return await operation(connection);
  } finally {
    connection.release();
  }
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Inserts a row into `tableName`. Returns the auto-increment insert ID.
 */
export async function insert(
  tableName: string,
  data: Record<string, unknown>
): Promise<number> {
  assertValidTable(tableName);
  Object.keys(data).forEach(assertValidColumnName);

  return withConnection(async (conn) => {
    const columns = Object.keys(data).join(', ');
    const placeholders = Object.keys(data).map(() => '?').join(', ');
    const values = Object.values(data);
    const query = `INSERT INTO ${tableName} (${columns}) VALUES (${placeholders})`;
    const [result] = await conn.execute<mysql.ResultSetHeader>(query, values);
    return result.insertId;
  });
}

/**
 * Inserts a row or updates it on duplicate key. Returns the insert ID (or 0
 * when an existing row was updated).
 */
export async function upsert(
  tableName: string,
  data: Record<string, unknown>,
  uniqueKeys: string[]
): Promise<number> {
  assertValidTable(tableName);
  Object.keys(data).forEach(assertValidColumnName);
  uniqueKeys.forEach(assertValidColumnName);

  return withConnection(async (conn) => {
    const columns = Object.keys(data).join(', ');
    const placeholders = Object.keys(data).map(() => '?').join(', ');
    const values = Object.values(data);

    const updateCols = Object.keys(data).filter((k) => !uniqueKeys.includes(k));
    const updateClause =
      updateCols.length > 0
        ? updateCols.map((k) => `${k} = VALUES(${k})`).join(', ')
        : `${uniqueKeys[0]} = VALUES(${uniqueKeys[0]})`; // no-op fallback

    const query =
      `INSERT INTO ${tableName} (${columns}) VALUES (${placeholders}) ` +
      `ON DUPLICATE KEY UPDATE ${updateClause}`;

    const [result] = await conn.execute<mysql.ResultSetHeader>(query, values);
    return result.insertId;
  });
}

/**
 * Updates rows in `tableName` matching `conditions`. Returns affected row count.
 */
export async function update(
  tableName: string,
  data: Record<string, unknown>,
  conditions: Record<string, unknown>
): Promise<number> {
  assertValidTable(tableName);
  Object.keys(data).forEach(assertValidColumnName);
  Object.keys(conditions).forEach(assertValidColumnName);

  return withConnection(async (conn) => {
    const setClause = Object.keys(data).map((k) => `${k} = ?`).join(', ');
    const whereClause = Object.keys(conditions).map((k) => `${k} = ?`).join(' AND ');
    const values = [...Object.values(data), ...Object.values(conditions)];
    const query = `UPDATE ${tableName} SET ${setClause} WHERE ${whereClause}`;
    const [result] = await conn.execute<mysql.ResultSetHeader>(query, values);
    return result.affectedRows;
  });
}

/**
 * Selects rows from `tableName`.
 *
 * @param tableName  Table to query (must be in ALLOWED_TABLES).
 * @param conditions Optional WHERE conditions — all parameterized.
 * @param orderBy    Optional single-column ORDER BY, e.g. "created_at DESC".
 *                   The full string is validated against a strict allowlist
 *                   pattern. Multi-column sorts are not supported here — use
 *                   executeRawQuery for those.
 * @param limit      Optional LIMIT value.
 */
export async function select(
  tableName: string,
  conditions?: Record<string, unknown>,
  orderBy?: string,
  limit?: number
): Promise<mysql.RowDataPacket[]> {
  assertValidTable(tableName);
  if (conditions) Object.keys(conditions).forEach(assertValidColumnName);

  // Validate the FULL orderBy string — not just the first word.
  // Validating only orderBy.split(' ')[0] would allow payloads like
  // "name ASC; DROP TABLE stocks--" to slip through.
  if (orderBy) assertValidOrderBy(orderBy);

  return withConnection(async (conn) => {
    const values: unknown[] = [];
    let query = `SELECT * FROM ${tableName}`;

    if (conditions && Object.keys(conditions).length > 0) {
      const whereClause = Object.keys(conditions)
        .map((k) => `${k} = ?`)
        .join(' AND ');
      query += ` WHERE ${whereClause}`;
      values.push(...Object.values(conditions));
    }

    if (orderBy) {
      query += ` ORDER BY ${orderBy}`;
    }

    if (limit !== undefined) {
      // LIMIT cannot be a prepared-statement parameter on this MySQL server;
      // limit is always a caller-controlled integer so inlining is safe.
      query += ` LIMIT ${Math.floor(limit)}`;
    }

    const [rows] = await conn.execute<mysql.RowDataPacket[]>(query, values);
    return rows;
  });
}

/**
 * Deletes rows from `tableName` matching `conditions`. Returns affected row count.
 */
export async function remove(
  tableName: string,
  conditions: Record<string, unknown>
): Promise<number> {
  assertValidTable(tableName);
  Object.keys(conditions).forEach(assertValidColumnName);

  return withConnection(async (conn) => {
    const whereClause = Object.keys(conditions).map((k) => `${k} = ?`).join(' AND ');
    const values = Object.values(conditions);
    const query = `DELETE FROM ${tableName} WHERE ${whereClause}`;
    const [result] = await conn.execute<mysql.ResultSetHeader>(query, values);
    return result.affectedRows;
  });
}

/**
 * Executes a raw parameterized query. Use when the helpers above are not
 * expressive enough (e.g. JOINs, multi-column ORDER BY, subqueries).
 *
 * The `params` array is required — pass [] if the query has no bind values.
 * Never interpolate user input into `sql` directly.
 */
export async function executeRawQuery(
  sql: string,
  params: readonly unknown[]
): Promise<[mysql.RowDataPacket[] | mysql.ResultSetHeader, mysql.FieldPacket[]]> {
  return withConnection((conn) => conn.query(sql, params) as any);
}

/**
 * Wraps multiple operations in a database transaction.
 * Rolls back automatically if the callback throws.
 */
export async function transaction<T>(
  callback: (connection: mysql.PoolConnection) => Promise<T>
): Promise<T> {
  const pool = await getDbConnection();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await callback(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
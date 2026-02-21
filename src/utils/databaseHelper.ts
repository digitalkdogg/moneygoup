// src/utils/databaseHelper.ts
import { getDbConnection } from './db';
import mysql from 'mysql2/promise';

/**
 * Executes a database operation within a try-finally block to ensure connection release.
 * @param operation The database operation to execute with the connection.
 * @returns The result of the operation.
 */
async function executeDbOperation<T>(operation: (connection: mysql.PoolConnection) => Promise<T>): Promise<T> {
  let poolConnection: mysql.PoolConnection | null = null;
  let pool: mysql.Pool | null = null;
  try {
    pool = await getDbConnection();
    poolConnection = await pool.getConnection();
    return await operation(poolConnection);
  } finally {
    if (poolConnection) {
      poolConnection.release();
    }
  }
}

/**
 * Inserts a new record into the specified table.
 * @param tableName The name of the table.
 * @param data An object where keys are column names and values are the data to insert.
 * @returns The insert ID of the new record.
 */
export async function insert(tableName: string, data: Record<string, any>): Promise<number> {
  return executeDbOperation(async (connection) => {
    const columns = Object.keys(data).join(', ');
    const placeholders = Object.keys(data).map(() => '?').join(', ');
    const values = Object.values(data);

    const query = `INSERT INTO ${tableName} (${columns}) VALUES (${placeholders})`;
    const [result] = await (connection as any).execute(query, values);
    return (result as mysql.ResultSetHeader).insertId;
  });
}

/**
 * Inserts a new record or updates an existing one if a duplicate key is found.
 * @param tableName The name of the table.
 * @param data An object where keys are column names and values are the data to insert or update.
 * @param uniqueKeys An array of column names that form the unique key to check for duplicates.
 * @returns The insert ID of the new record or 0 if an update occurred.
 */
export async function upsert(tableName: string, data: Record<string, any>, uniqueKeys: string[]): Promise<number | void> {
  return executeDbOperation(async (connection) => {
    const columns = Object.keys(data).join(', ');
    const placeholders = Object.keys(data).map(() => '?').join(', ');
    const values = Object.values(data);

    const updateSetClause = Object.keys(data)
      .filter(key => !uniqueKeys.includes(key)) // Don't update unique keys themselves
      .map(key => `${key} = VALUES(${key})`)
      .join(', ');

    let query = `INSERT INTO ${tableName} (${columns}) VALUES (${placeholders})`;

    if (updateSetClause) {
      query += ` ON DUPLICATE KEY UPDATE ${updateSetClause}`;
    } else {
      // If only unique keys are provided in data, and no other fields to update,
      // we still need an ON DUPLICATE KEY UPDATE clause to avoid an error.
      // A common practice is to update one of the unique keys to its own value,
      // or simply update a non-unique field to its own value if one exists.
      // For simplicity, we'll just update one of the unique keys to itself.
      query += ` ON DUPLICATE KEY UPDATE ${uniqueKeys[0]} = VALUES(${uniqueKeys[0]})`;
    }

    const [result] = await (connection as any).execute(query, values);
    return (result as mysql.ResultSetHeader).insertId;
  });
}

/**
 * Updates records in the specified table.
 * @param tableName The name of the table.
 * @param data An object where keys are column names and values are the data to update.
 * @param conditions An object where keys are column names and values are the conditions for the update.
 * @returns The number of affected rows.
 */
export async function update(tableName: string, data: Record<string, any>, conditions: Record<string, any>): Promise<number> {
  return executeDbOperation(async (connection) => {
    const setClause = Object.keys(data).map(key => `${key} = ?`).join(', ');
    const whereClause = Object.keys(conditions).map(key => `${key} = ?`).join(' AND ');
    const values = [...Object.values(data), ...Object.values(conditions)];

    const query = `UPDATE ${tableName} SET ${setClause} WHERE ${whereClause}`;
    const [result] = await (connection as any).execute(query, values);
    return (result as mysql.ResultSetHeader).affectedRows;
  });
}

/**
 * Selects records from the specified table.
 * @param tableName The name of the table.
 * @param conditions An optional object for WHERE clause conditions.
 * @param orderBy An optional string for the ORDER BY clause.
 * @param limit An optional number for the LIMIT clause.
 * @returns An array of selected records.
 */
export async function select(tableName: string, conditions?: Record<string, any>, orderBy?: string, limit?: number): Promise<any[]> {
  return executeDbOperation(async (connection) => {
    let query = `SELECT * FROM ${tableName}`;
    const values: any[] = [];

    if (conditions && Object.keys(conditions).length > 0) {
      const whereClause = Object.keys(conditions).map(key => `${key} = ?`).join(' AND ');
      query += ` WHERE ${whereClause}`;
      values.push(...Object.values(conditions));
    }

    if (orderBy) {
      query += ` ORDER BY ${orderBy}`;
    }

    if (limit !== undefined) {
      query += ` LIMIT ?`;
      values.push(limit);
    }

    const [rows] = await (connection as any).execute(query, values);
    return rows as any[];
  });
}

/**
 * Deletes records from the specified table.
 * @param tableName The name of the table.
 * @param conditions An object where keys are column names and values are the conditions for deletion.
 * @returns The number of affected rows.
 */
export async function remove(tableName: string, conditions: Record<string, any>): Promise<number> {
  return executeDbOperation(async (connection) => {
    const whereClause = Object.keys(conditions).map(key => `${key} = ?`).join(' AND ');
    const values = Object.values(conditions);

    const query = `DELETE FROM ${tableName} WHERE ${whereClause}`;
    const [result] = await (connection as any).execute(query, values);
    return (result as mysql.ResultSetHeader).affectedRows;
  });
}

/**
 * Heuristic check for obvious SQL injection patterns.
 * Not a complete parser — just a last-resort safety net.
 * Real protection comes from always using parameterized queries.
 */
function assertNoInterpolation(sql: string): void {
  // These patterns strongly suggest user input was interpolated directly
  const suspiciousPatterns = [
    // Unquoted literals that look like they came from string concat
    /WHERE\s+\w+\s*=\s*\d+(?!\s*\?)/i,     // WHERE id = 42  (should be WHERE id = ?)
    /WHERE\s+\w+\s*=\s*'[^']*'/i,          // WHERE name = 'alice'  (should use ?)
    /IN\s*\(\s*(?!')\d/i,                   // IN (1, 2, 3)  (should be IN (?, ?, ?))
    // /LIMIT\s+\d+\s+OFFSET\s+\d+/i,      // LIMIT 10 OFFSET 0  (acceptable — these are usually safe)
  ];

  const isDevOrTest = process.env.NODE_ENV !== 'production';

  for (const pattern of suspiciousPatterns.slice(0, 3)) {
    if (pattern.test(sql)) {
      const message = [
        '[databaseHelper] Possible SQL injection: literal value detected in query.',
        'Use parameterized queries: executeRawQuery("... WHERE id = ?", [id])',
        `Offending query: ${sql.substring(0, 200)}`,
      ].join('\\n');

      if (isDevOrTest) {
        throw new Error(message);   // Hard fail in dev — forces immediate fix
      } else {
        // Assuming `logger` is available globally or imported
        // If not, a simple console.error could be used or `logger` needs to be imported/created
        console.error(message);        // Log in prod, then fall through to block
        throw new Error('Query rejected due to security policy');
      }
    }
  }
}

/**
 * Executes a raw SQL query. Use with caution.
 * @param sql The raw SQL query string.
 * @param params Required array of values to bind to the query. Pass [] if no values.
 * @returns The result of the query.
 */
export async function executeRawQuery(sql: string, params: readonly unknown[]): Promise<[mysql.RowDataPacket[] | mysql.ResultSetHeader, mysql.FieldPacket[]]> {
  assertNoInterpolation(sql);
  return executeDbOperation(async (connection) => {
    return await connection.execute(sql, params);
  });
}

/**
 * Use this ONLY for queries with no user-influenced values whatsoever.
 * The name is intentional — it makes the choice visible in code review.
 * If you're unsure whether to use this, use executeRawQuery with params.
 */
export async function executeStaticQuery(sql: string): Promise<[mysql.RowDataPacket[] | mysql.ResultSetHeader, mysql.FieldPacket[]]> {
  return executeDbOperation(async (connection) => {
    return await connection.execute(sql);
  });
}

// Transaction helper
export async function transaction<T>(callback: (connection: mysql.PoolConnection) => Promise<T>): Promise<T> {
  let poolConnection: mysql.PoolConnection | null = null;
  let pool: mysql.Pool | null = null;
  try {
    pool = await getDbConnection();
    poolConnection = await pool.getConnection();
    await poolConnection.beginTransaction();
    const result = await callback(poolConnection);
    await poolConnection.commit();
    return result;
  } catch (error) {
    if (poolConnection) {
      await poolConnection.rollback();
    }
    throw error;
  } finally {
    if (poolConnection) {
      poolConnection.release();
    }
  }
}

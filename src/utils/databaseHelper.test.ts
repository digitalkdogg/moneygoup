// src/utils/__tests__/databaseHelper.test.ts
//
// Tests for the orderBy injection fix in databaseHelper.select().
// Run with: npx jest databaseHelper.test.ts
//
// The db connection is mocked so these tests run without a real database.

import { select, insert, update, remove } from '@/utils/databaseHelper';

// ---------------------------------------------------------------------------
// Mock the DB connection so no real queries are executed
// ---------------------------------------------------------------------------
jest.mock('@/utils/db', () => ({
  getDbConnection: jest.fn().mockResolvedValue({
    getConnection: jest.fn().mockResolvedValue({
      execute: jest.fn().mockResolvedValue([[{ id: 1 }], []]),
      release: jest.fn(),
    }),
  }),
}));

// ---------------------------------------------------------------------------
// orderBy validation — the core fix for Finding 6
// ---------------------------------------------------------------------------
describe('select() — orderBy injection prevention', () => {
  // -------------------------------------------------------------------------
  // These must THROW before reaching the database
  // -------------------------------------------------------------------------
  const maliciousCases = [
    // Classic SQL injection appended after a valid column name
    ["name ASC; DROP TABLE users--", 'appended statement via semicolon'],
    ["name ASC; DROP TABLE users--", 'appended DROP after valid column'],
    ["id; SELECT * FROM users--",    'SELECT injection via semicolon'],
    ["id UNION SELECT password FROM users", 'UNION injection'],
    ["id, password",                 'comma-separated multi-column (injection vector)'],
    ["id ASC, password DESC",        'multi-column with direction (injection vector)'],
    ["(SELECT 1)",                   'subquery injection'],
    ["id ASC\nDROP TABLE users",     'newline-separated statement'],
    ["id ASC\tDROP TABLE users",     'tab-separated statement'],
    ["id'",                          'quote injection'],
    ["id--",                         'comment injection'],
    ["id /*comment*/",               'block comment injection'],
    ["1=1",                          'boolean expression'],
  ];

  test.each(maliciousCases)(
    'throws on: %s (%s)',
    async (maliciousOrderBy) => {
      await expect(
        select('users', {}, maliciousOrderBy)
      ).rejects.toThrow(/Invalid ORDER BY clause/);
    }
  );

  // -------------------------------------------------------------------------
  // The original vulnerability: only validating the FIRST word
  //
  // "name" passes column-name validation, but "ASC; DROP TABLE users--"
  // would be interpolated unsanitized into the query.
  // This must now throw — the FULL string is validated.
  // -------------------------------------------------------------------------
  test('rejects "name ASC; DROP TABLE users--" even though first word is valid', async () => {
    await expect(
      select('users', {}, 'name ASC; DROP TABLE users--')
    ).rejects.toThrow(/Invalid ORDER BY clause/);
  });

  // -------------------------------------------------------------------------
  // These must PASS (legitimate values used throughout the codebase)
  // -------------------------------------------------------------------------
  const validCases = [
    ['date',             'bare column name'],
    ['date ASC',         'column + ASC'],
    ['date DESC',        'column + DESC'],
    ['created_at',       'underscore column'],
    ['created_at DESC',  'underscore column + DESC'],
    ['regularMarketPrice ASC', 'camelCase column'],
    ['DATE',             'uppercase column'],
    ['DATE DESC',        'uppercase column + direction'],
  ];

  test.each(validCases)(
    'accepts: %s (%s)',
    async (validOrderBy) => {
      await expect(
        select('users', {}, validOrderBy)
      ).resolves.toBeDefined();
    }
  );
});

// ---------------------------------------------------------------------------
// Table allowlist
// ---------------------------------------------------------------------------
describe('select() — table allowlist', () => {
  test('rejects unknown tables', async () => {
    await expect(select('unknown_table')).rejects.toThrow(/disallowed table/);
  });

  test('rejects SQL injection in table name', async () => {
    await expect(select('users; DROP TABLE users--')).rejects.toThrow(/disallowed table/);
  });

  test('accepts known tables', async () => {
    for (const table of ['stocks', 'user_stocks', 'users', 'stocksdailyprice']) {
      await expect(select(table)).resolves.toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Column name validation in conditions
// ---------------------------------------------------------------------------
describe('select() — condition column validation', () => {
  test('rejects injection in condition key', async () => {
    await expect(
      select('users', { 'id; DROP TABLE users--': 1 })
    ).rejects.toThrow(/Invalid column name/);
  });

  test('accepts valid condition keys', async () => {
    await expect(
      select('users', { user_id: 42 })
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// insert() column validation
// ---------------------------------------------------------------------------
describe('insert() — column validation', () => {
  test('rejects injected column names', async () => {
    await expect(
      insert('users', { 'name); DROP TABLE users--': 'test' })
    ).rejects.toThrow(/Invalid column name/);
  });

  test('rejects unknown table', async () => {
    await expect(
      insert('evil_table', { name: 'test' })
    ).rejects.toThrow(/disallowed table/);
  });
});

// ---------------------------------------------------------------------------
// update() validation
// ---------------------------------------------------------------------------
describe('update() — validation', () => {
  test('rejects injected column in data', async () => {
    await expect(
      update('users', { 'email; --': 'x@x.com' }, { user_id: 1 })
    ).rejects.toThrow(/Invalid column name/);
  });

  test('rejects injected column in conditions', async () => {
    await expect(
      update('users', { email: 'x@x.com' }, { 'user_id = 1 OR 1=1--': 1 })
    ).rejects.toThrow(/Invalid column name/);
  });
});

// ---------------------------------------------------------------------------
// remove() validation
// ---------------------------------------------------------------------------
describe('remove() — validation', () => {
  test('rejects injected condition column', async () => {
    await expect(
      remove('users', { 'user_id = 1 OR 1=1--': 1 })
    ).rejects.toThrow(/Invalid column name/);
  });
});
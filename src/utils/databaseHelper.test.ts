import { executeRawQuery, executeStaticQuery } from './databaseHelper';

describe('executeRawQuery — interpolation guard', () => {

  it('throws when a literal number appears in WHERE clause', async () => {
    await expect(
      executeRawQuery('SELECT * FROM users WHERE id = 42', [])
    ).rejects.toThrow('Possible SQL injection');
  });

  it('throws when a quoted string literal appears in WHERE clause', async () => {
    await expect(
      executeRawQuery("SELECT * FROM users WHERE name = 'alice'", [])
    ).rejects.toThrow('Possible SQL injection');
  });

  it('accepts a properly parameterized query', async () => {
    // Should not throw — actual DB call will fail without a real connection,
    // but the guard should pass
    await expect(
      executeRawQuery('SELECT * FROM users WHERE id = ?', [42])
    ).rejects.not.toThrow('Possible SQL injection');
  });

  it('TypeScript: requires params argument — no second arg is a compile error',
    () => {
      // This test documents the type contract. If this file compiles, the type is enforced.
      // @ts-expect-error — params is required
      void executeRawQuery('SELECT 1');
    }
  );
});

describe('executeStaticQuery', () => {
  it('does not throw for static queries', async () => {
    await expect(
      executeStaticQuery('SELECT 1')
    ).rejects.not.toThrow('Possible SQL injection');
  });
});

describe('Database Name Sanitization', () => {
  it('throws for invalid table names', async () => {
    // Dynamically import insert to avoid issues with test setup if insert is not fully mocked
    const { insert } = await import('./databaseHelper');
    await expect(
      insert("users; DROP TABLE users--", { username: "test" })
    ).rejects.toThrow('Invalid or disallowed table name: users; DROP TABLE users--');
  });

  it('throws for invalid column names', async () => {
    const { insert } = await import('./databaseHelper');
    await expect(
      insert("users", { "user;name": "test" })
    ).rejects.toThrow('Invalid column name: user;name');
  });
});


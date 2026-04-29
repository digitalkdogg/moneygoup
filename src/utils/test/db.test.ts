import { createPool } from 'mysql2/promise';
import { getDbConnection, closeDbPool } from '../db';

const mockEnd = jest.fn().mockResolvedValue(undefined);
const mockPool = {
  getConnection: jest.fn(),
  end: mockEnd,
};

jest.mock('mysql2/promise', () => ({
  createPool: jest.fn().mockImplementation(() => mockPool),
}));

describe('db', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.dbPool = undefined;
    delete process.env.DATABASE_URL;
    delete process.env.DB_PORT;
    process.env.DB_HOST = 'localhost';
    process.env.DB_USER = 'user';
    process.env.DB_PASSWORD = 'password';
    process.env.DB_DATABASE = 'db';
  });

  test('getDbConnection creates a pool if it does not exist', async () => {
    const pool = await getDbConnection();
    expect(createPool).toHaveBeenCalled();
    expect(pool).toBe(mockPool);
  });

  test('getDbConnection returns the same pool on subsequent calls', async () => {
    const pool1 = await getDbConnection();
    const pool2 = await getDbConnection();
    expect(pool1).toBe(pool2);
  });

  test('closeDbPool ends the pool', async () => {
    await getDbConnection();
    await closeDbPool();
    expect(mockEnd).toHaveBeenCalled();
  });

   test('getDbConnection uses DATABASE_URL when provided', async () => {
    process.env.DATABASE_URL = 'mysql://avnadmin:pass@db.example.com:21439/defaultdb?ssl-mode=REQUIRED';

    await getDbConnection();

    expect(createPool).toHaveBeenCalledWith(expect.objectContaining({
      host: 'db.example.com',
      port: 21439,
      user: 'avnadmin',
      password: 'pass',
      database: 'defaultdb',
      ssl: { rejectUnauthorized: false },
    }));
  });

  test('getDbConnection respects DB_SSL_REJECT_UNAUTHORIZED=true', async () => {
    process.env.DATABASE_URL = 'mysql://avnadmin:pass@db.example.com:21439/defaultdb?ssl-mode=REQUIRED';
    process.env.DB_SSL_REJECT_UNAUTHORIZED = 'true';

    await getDbConnection();

    expect(createPool).toHaveBeenCalledWith(expect.objectContaining({
      ssl: { rejectUnauthorized: true },
    }));
    delete process.env.DB_SSL_REJECT_UNAUTHORIZED;
  });
});

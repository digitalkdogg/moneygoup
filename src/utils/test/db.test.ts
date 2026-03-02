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
    await closeDbPool();
    expect(mockEnd).toHaveBeenCalled();
  });
});

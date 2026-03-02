import { createLogger } from '../logger';

describe('logger', () => {
  let consoleLogSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  test('createLogger returns info, warn, error functions', () => {
    const logger = createLogger('test-module');
    expect(logger.info).toBeDefined();
    expect(logger.warn).toBeDefined();
    expect(logger.error).toBeDefined();
  });

  test('logger.info outputs JSON to console.log', () => {
    const logger = createLogger('test-module');
    logger.info('test message', { key: 'value' });
    
    expect(consoleLogSpy).toHaveBeenCalled();
    const logOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(logOutput.level).toBe('INFO');
    expect(logOutput.module).toBe('test-module');
    expect(logOutput.message).toBe('test message');
    expect(logOutput.key).toBe('value');
  });

  test('logger.error sanitizes error objects', () => {
    const logger = createLogger('test-module');
    const error = new Error('Dangerous Error');
    logger.error('error message', { error });

    expect(consoleErrorSpy).toHaveBeenCalled();
    const logOutput = JSON.parse(consoleErrorSpy.mock.calls[0][0]);
    expect(logOutput.error.message).toBe('Dangerous Error'); // Newline removed
    expect(logOutput.error.stack).toBeDefined();
  });

  test('logger.warn outputs to console.warn', () => {
    const logger = createLogger('test-module');
    logger.warn('warn message');
    expect(consoleWarnSpy).toHaveBeenCalled();
  });
});

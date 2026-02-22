// src/utils/logger.ts

/** Sanitize a string for safe log inclusion — removes newlines that could forge log lines */
function sanitizeForLog(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value
    .replace(/[\\r\\n]/g, ' ')    // Collapse newlines — stops forged log lines
    .substring(0, 500);          // Cap length — stacks can be enormous
}

/** Safely serialize an Error for log output */
function serializeError(err: unknown): Record<string, unknown> | string {
  if (!(err instanceof Error)) return sanitizeForLog(String(err)) as string;
  return {
    name:    err.name,
    message: sanitizeForLog(err.message),
    stack:   err.stack ? sanitizeForLog(err.stack) : undefined,
  };
}

// Define a simple Logger interface
interface Logger {
  info: (message: string, meta?: Record<string, any>) => void;
  warn: (message: string, meta?: Record<string, any>) => void;
  error: (message: string, meta?: Record<string, any>) => void;
}

// Function to create a logger instance for a given module
export function createLogger(moduleName: string): Logger {
  const log = (level: string, message: string, meta?: Record<string, any>) => {
    const timestamp = new Date().toISOString();
    
    // Safely serialize any error in meta
    const errorDetails = meta?.error ? serializeError(meta.error) : undefined;
    const cleanedMeta = { ...meta };
    if (cleanedMeta.error) {
      delete cleanedMeta.error; // Remove original error to avoid duplication
    }

    // Add moduleName to context for structured logging
    const structuredLog = {
      timestamp,
      level,
      module: moduleName,
      message: sanitizeForLog(message),
      ...cleanedMeta, // Spread all remaining meta properties
      ...(errorDetails && { error: errorDetails }),
    };

    // Output to console (or send to a logging service in a real app)
    const logOutput = JSON.stringify(structuredLog, null, process.env.NODE_ENV !== 'production' ? 2 : undefined);

    switch (level) {
      case 'INFO':
        console.log(logOutput);
        break;
      case 'WARN':
        console.warn(logOutput);
        break;
      case 'ERROR':
        console.error(logOutput);
        break;
      default:
        console.log(logOutput);
    }
  };

  return {
    info: (message, meta) => log('INFO', message, meta),
    warn: (message, meta) => log('WARN', message, meta),
    error: (message, meta) => log('ERROR', message, meta),
  };
}
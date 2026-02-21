// src/utils/logger.ts

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
    
    let errorDetails: { message?: string, stack?: string, name?: string } = {};
    if (meta?.error instanceof Error) {
      errorDetails = { message: meta.error.message, stack: meta.error.stack, name: meta.error.name };
      delete meta.error; // Remove error from meta to avoid duplication
    } else if (typeof meta?.error === 'string') {
      errorDetails = { message: meta.error };
      delete meta.error;
    }

    // Add moduleName to context for structured logging
    const structuredLog = {
      timestamp,
      level,
      module: moduleName,
      message,
      ...meta, // Spread all remaining meta properties
      ...(Object.keys(errorDetails).length > 0 && { error: errorDetails }),
    };

    // Output to console (or send to a logging service in a real app)
    switch (level) {
      case 'INFO':
        console.log(JSON.stringify(structuredLog));
        break;
      case 'WARN':
        console.warn(JSON.stringify(structuredLog));
        break;
      case 'ERROR':
        console.error(JSON.stringify(structuredLog));
        break;
      default:
        console.log(JSON.stringify(structuredLog));
    }
  };

  return {
    info: (message, meta) => log('INFO', message, meta),
    warn: (message, meta) => log('WARN', message, meta),
    error: (message, meta) => log('ERROR', message, meta),
  };
}
// src/utils/logger.ts

// Define a simple Logger interface
interface Logger {
  info: (message: string, context?: Record<string, any>) => void;
  warn: (message: string, context?: Record<string, any>) => void;
  error: (message: string, error?: Error | string, context?: Record<string, any>) => void;
}

// Function to create a logger instance for a given module
export function createLogger(moduleName: string): Logger {
  const log = (level: string, message: string, ...args: any[]) => {
    const timestamp = new Date().toISOString();
    let context: Record<string, any> = {};
    let error: Error | string | undefined;

    // Check for an error object as the first arg if level is error
    if (level === 'ERROR' && args[0] instanceof Error) {
      error = args.shift(); // Remove error from args
    } else if (level === 'ERROR' && typeof args[0] === 'string') {
      error = args.shift(); // Assume it's an error message string
    }

    // Remaining args are context
    if (args.length > 0 && typeof args[0] === 'object' && args[0] !== null) {
      context = args.shift();
    }
    
    // Add moduleName and potentially error details to context for structured logging
    const structuredLog = {
      timestamp,
      level,
      module: moduleName,
      message,
      ...context,
      ...(error && { error: error instanceof Error ? error.message : error, stack: error instanceof Error ? error.stack : undefined }),
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
    info: (message, context) => log('INFO', message, context),
    warn: (message, context) => log('WARN', message, context),
    error: (message, error, context) => log('ERROR', message, error, context),
  };
}
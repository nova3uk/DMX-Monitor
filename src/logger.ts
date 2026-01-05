/**
 * Winston-based logging utility for DMX Monitor
 */

import winston from 'winston';
import { isDMXMonitorError } from './errors';

/** Log levels */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/** Logger configuration */
export interface LoggerConfig {
  level: LogLevel;
  logFile?: string;
  console: boolean;
}

/** Global logger instance */
let loggerInstance: winston.Logger | null = null;

/** Custom format for console output */
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.colorize({ all: true }),
  winston.format.printf(({ level, message, timestamp, ...meta }) => {
    const metaStr = Object.keys(meta).length > 0 
      ? ` ${JSON.stringify(meta)}` 
      : '';
    return `[${timestamp}] ${level}: ${message}${metaStr}`;
  })
);

/** Custom format for file output */
const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

/**
 * Initialize the logger with configuration
 */
export function initLogger(config: LoggerConfig): winston.Logger {
  const transports: winston.transport[] = [];

  // Console transport (disabled during display mode to avoid interference)
  if (config.console) {
    transports.push(
      new winston.transports.Console({
        format: consoleFormat,
        stderrLevels: ['error'],
      })
    );
  }

  // File transport if specified
  if (config.logFile) {
    transports.push(
      new winston.transports.File({
        filename: config.logFile,
        format: fileFormat,
        maxsize: 10 * 1024 * 1024, // 10MB
        maxFiles: 5,
        tailable: true,
      })
    );
  }

  // Create logger
  loggerInstance = winston.createLogger({
    level: config.level,
    transports,
    // Silent if no transports (will be the case during display mode without log file)
    silent: transports.length === 0,
  });

  return loggerInstance;
}

/**
 * Get the logger instance
 */
export function getLogger(): winston.Logger {
  if (!loggerInstance) {
    // Create a default logger if not initialized
    loggerInstance = initLogger({
      level: 'info',
      console: true,
    });
  }
  return loggerInstance;
}

/**
 * Disable console logging (for display mode)
 */
export function disableConsoleLogging(): void {
  if (loggerInstance) {
    loggerInstance.transports.forEach(transport => {
      if (transport instanceof winston.transports.Console) {
        transport.silent = true;
      }
    });
  }
}

/**
 * Enable console logging
 */
export function enableConsoleLogging(): void {
  if (loggerInstance) {
    loggerInstance.transports.forEach(transport => {
      if (transport instanceof winston.transports.Console) {
        transport.silent = false;
      }
    });
  }
}

/**
 * Log an error with full details
 */
export function logError(error: unknown, context?: string): void {
  const logger = getLogger();
  
  if (isDMXMonitorError(error)) {
    logger.error(error.toSafeString(), {
      code: error.code,
      context,
      ...error.toJSON(),
    });
  } else if (error instanceof Error) {
    logger.error(error.message, {
      name: error.name,
      context,
      stack: error.stack,
    });
  } else {
    logger.error(String(error), { context });
  }
}

/**
 * Log a warning
 */
export function logWarn(message: string, meta?: Record<string, unknown>): void {
  getLogger().warn(message, meta);
}

/**
 * Log info message
 */
export function logInfo(message: string, meta?: Record<string, unknown>): void {
  getLogger().info(message, meta);
}

/**
 * Log debug message
 */
export function logDebug(message: string, meta?: Record<string, unknown>): void {
  getLogger().debug(message, meta);
}

/**
 * Create a child logger with additional context
 */
export function createChildLogger(context: Record<string, unknown>): winston.Logger {
  return getLogger().child(context);
}

/**
 * Format error for display to user (safe, no stack traces)
 */
export function formatErrorForUser(error: unknown): string {
  if (isDMXMonitorError(error)) {
    return error.message;
  }
  if (error instanceof Error) {
    // Remove stack trace and technical details
    return error.message.split('\n')[0] ?? 'An error occurred';
  }
  return 'An unexpected error occurred';
}

/**
 * Safely stringify an object for logging
 */
export function safeStringify(obj: unknown, maxLength = 1000): string {
  try {
    const str = JSON.stringify(obj, (key, value) => {
      // Redact potentially sensitive fields
      if (['password', 'token', 'secret', 'key', 'auth'].includes(key.toLowerCase())) {
        return '[REDACTED]';
      }
      // Handle Buffer and Uint8Array
      if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
        return `[Buffer: ${value.length} bytes]`;
      }
      return value;
    });
    if (str.length > maxLength) {
      return str.substring(0, maxLength) + '...[truncated]';
    }
    return str;
  } catch {
    return '[Unable to stringify]';
  }
}

/**
 * Close the logger and flush all transports
 */
export async function closeLogger(): Promise<void> {
  if (loggerInstance) {
    await new Promise<void>((resolve) => {
      loggerInstance?.on('finish', resolve);
      loggerInstance?.end();
    });
    loggerInstance = null;
  }
}

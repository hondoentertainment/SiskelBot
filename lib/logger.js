/**
 * Structured JSON logger for production.
 * In development: pretty-prints with colors.
 * In production (NODE_ENV=production or LOG_FORMAT=json): outputs JSON per line.
 */

const LOG_FORMAT = process.env.LOG_FORMAT || (process.env.NODE_ENV === 'production' ? 'json' : 'pretty');

export function createLogger(module) {
  return {
    info(message, data) { log('info', module, message, data); },
    warn(message, data) { log('warn', module, message, data); },
    error(message, data) { log('error', module, message, data); },
    debug(message, data) { log('debug', module, message, data); },
  };
}

function log(level, module, message, data) {
  if (LOG_FORMAT === 'json') {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      module,
      message,
      ...data,
    };
    // Sanitize sensitive fields
    if (entry.apiKey) entry.apiKey = '[REDACTED]';
    if (entry.token) entry.token = '[REDACTED]';
    if (entry.password) entry.password = '[REDACTED]';
    console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](JSON.stringify(entry));
  } else {
    // Pretty format for development
    const prefix = `[${module}]`;
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn(prefix, message, data ? JSON.stringify(data, null, 2) : '');
  }
}

export const logger = createLogger('app');

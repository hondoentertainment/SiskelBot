/**
 * Structured JSON logger for production.
 * In development: pretty-prints with colors.
 * In production (NODE_ENV=production or LOG_FORMAT=json): outputs JSON per line.
 *
 * Phase 31.4: Log entries are also forwarded to an external log aggregation
 * service (Datadog, Splunk, Loki, Elasticsearch, custom HTTP) when a shipper
 * has been registered via lib/log-shipper.js.
 */

import { getLogShipper } from "./log-shipper.js";

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
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    module,
    message,
    ...data,
  };
  // Sanitize sensitive fields (applied for both output and shipping).
  if (entry.apiKey) entry.apiKey = '[REDACTED]';
  if (entry.token) entry.token = '[REDACTED]';
  if (entry.password) entry.password = '[REDACTED]';

  if (LOG_FORMAT === 'json') {
    console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](JSON.stringify(entry));
  } else {
    // Pretty format for development
    const prefix = `[${module}]`;
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn(prefix, message, data ? JSON.stringify(data, null, 2) : '');
  }

  // Ship to external log aggregator if configured.
  try {
    const shipper = getLogShipper();
    if (shipper) shipper.ship(entry);
  } catch {
    // Never let shipping failures break logging.
  }
}

export const logger = createLogger('app');

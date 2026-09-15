'use strict';

const { config } = require('./config');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] || LEVELS.info;

/** Keys whose values are never written to the log. */
const REDACT = /^(bw_api_secret|bw_api_token|authorization|password|secret|token)$/i;

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = REDACT.test(k) ? '***' : redact(v);
    }
    return out;
  }
  return value;
}

function emit(level, message, fields) {
  if (LEVELS[level] < threshold) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...(fields ? redact(fields) : {}),
  };
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(JSON.stringify(line) + '\n');
}

module.exports = {
  debug: (m, f) => emit('debug', m, f),
  info: (m, f) => emit('info', m, f),
  warn: (m, f) => emit('warn', m, f),
  error: (m, f) => emit('error', m, f),
};

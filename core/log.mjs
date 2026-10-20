/**
 * core/log.mjs — logging that cannot leak a credential.
 *
 * Zelos handles mail passwords and API keys. A log line is the easiest place
 * in a program for one of those to escape, so redaction happens here, on every
 * value, rather than being remembered at each call site.
 */

import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

/** Patterns that mean "this is a secret" regardless of what it was called. */
const SECRET_SHAPES = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,               // OpenAI-style
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,           // Anthropic
  /\bgsk_[A-Za-z0-9]{20,}/g,                // Groq
  /\bAIza[0-9A-Za-z_-]{20,}/g,              // Google
  /\bxai-[A-Za-z0-9]{16,}/g,
  // Zelos's own AI-access token (core/ai-access.mjs). It is the credential that
  // hands somebody's mail to another program, so it is redacted by shape as
  // well as by key name — a log line that interpolates one into a sentence
  // never reaches the `token`/`value` key check.
  /\bzlt_[a-z]{1,8}_[0-9a-f]{4,16}_[A-Za-z0-9_-]{22,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
  /\bBasic\s+[A-Za-z0-9+/]{12,}=*/gi,
];

/** Keys whose *value* is always redacted, whatever it looks like. */
const SECRET_KEYS = new Set([
  'pass', 'password', 'apikey', 'api_key', 'key', 'token', 'secret',
  'authorization', 'x-api-key', 'sessiontoken', 'value',
]);

export function redact(input, seen = new WeakSet()) {
  if (typeof input === 'string') {
    let out = input;
    for (const re of SECRET_SHAPES) out = out.replace(re, (m) => mask(m));
    return out;
  }
  if (!input || typeof input !== 'object') return input;
  if (seen.has(input)) return '[circular]';
  seen.add(input);
  if (Array.isArray(input)) return input.map((v) => redact(v, seen));
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (SECRET_KEYS.has(k.toLowerCase())) out[k] = typeof v === 'string' && v ? mask(v) : v ? '[redacted]' : v;
    else out[k] = redact(v, seen);
  }
  return out;
}

function mask(s) {
  if (typeof s !== 'string' || s.length <= 8) return '[redacted]';
  return `${s.slice(0, 4)}…[redacted ${s.length}ch]`;
}

/**
 * How big a log may be when it is opened before it is set aside. One older
 * generation is kept. Only at open: a session that runs for months still
 * grows its own file until the next launch.
 * The log lives in the data folder people back up, and was the one file there
 * that only ever grew (QA, 2026-10-09, TT-3479).
 */
export const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

/** `<name>.log` → `<name>.log.1`, replacing an older `.1`, when it is over the
 *  limit. Any failure leaves it where it is, to be appended to: logging must
 *  never be the reason the app fails to start. */
function rotateIfLarge(logPath) {
  try {
    if (fs.statSync(logPath).size <= LOG_ROTATE_BYTES) return;
    fs.renameSync(logPath, `${logPath}.1`);
  } catch { /* no log yet, or it could not be moved: keep appending */ }
}

export function createLogger({ dir = null, level = 'info', stream = process.stderr, name = 'zelos' } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  let file = null;
  if (dir) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const logPath = path.join(dir, `${name}.log`);
      rotateIfLarge(logPath);
      file = fs.createWriteStream(logPath, { flags: 'a', mode: 0o600 });
      // Opening and writing a stream can fail after createWriteStream returns.
      // A missing log destination must not become an unhandled error that
      // brings down the board. Keep the terminal sink available for diagnosis.
      file.on('error', (err) => {
        file = null;
        emit('warn', 'File logging is unavailable; continuing with terminal diagnostics', { error: err.message });
      });
    } catch {
      file = null; // logging must never be the reason the app fails to start
    }
  }

  function emit(lvl, msg, meta) {
    if ((LEVELS[lvl] ?? 0) < threshold) return;
    const safeMsg = redact(String(msg));
    const safeMeta = meta === undefined ? undefined : redact(meta);
    const line = { t: new Date().toISOString(), lvl, msg: safeMsg, ...(safeMeta ? { meta: safeMeta } : {}) };
    if (file) file.write(`${JSON.stringify(line)}\n`);
    if (stream && lvl !== 'debug') {
      const tag = { info: '·', warn: '!', error: '✕' }[lvl] || '·';
      stream.write(`${tag} ${safeMsg}${safeMeta ? ` ${JSON.stringify(safeMeta)}` : ''}\n`);
    }
  }

  return {
    debug: (m, x) => emit('debug', m, x),
    info: (m, x) => emit('info', m, x),
    warn: (m, x) => emit('warn', m, x),
    error: (m, x) => emit('error', m, x),
    child(prefix) {
      return {
        debug: (m, x) => emit('debug', `${prefix} ${m}`, x),
        info: (m, x) => emit('info', `${prefix} ${m}`, x),
        warn: (m, x) => emit('warn', `${prefix} ${m}`, x),
        error: (m, x) => emit('error', `${prefix} ${m}`, x),
        child(p2) { return this; },
      };
    },
    close() {
      const closing = file;
      file = null;
      try { closing?.end(); } catch { /* ignore */ }
    },
  };
}

/** Default logger — quiet, no file, safe to import anywhere. */
export const log = createLogger({ level: process.env.ZELOS_LOG_LEVEL || 'info' });

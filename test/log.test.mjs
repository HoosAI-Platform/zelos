import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const run = promisify(execFile);
const loggerModule = new URL('../core/log.mjs', import.meta.url).href;

async function withLogHome(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-log-test-'));
  try { await body(dir); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// A separate process is intentional: an unhandled WriteStream error kills
// the desktop app, and an error listener in this test would hide that failure.
test('an unavailable log file does not crash the app or silence terminal diagnostics', async () => {
  await withLogHome(async (dir) => {
    fs.mkdirSync(path.join(dir, 'desktop.log'));
    const { stderr, stdout } = await run(process.execPath, ['--input-type=module', '-e', `
      import { createLogger } from ${JSON.stringify(loggerModule)};
      const logger = createLogger({ dir: ${JSON.stringify(dir)}, name: 'desktop' });
      logger.info('starting the board');
      setTimeout(() => {
        logger.warn('the board can still report problems');
        logger.close();
        process.stdout.write('alive');
      }, 50);
    `], { timeout: 10_000 });
    assert.equal(stdout, 'alive');
    assert.match(stderr, /starting the board/);
    assert.match(stderr, /the board can still report problems/);
  });
});

test('late shutdown diagnostics do not write to a closed log stream', async () => {
  await withLogHome(async (dir) => {
    const { stderr } = await run(process.execPath, ['--input-type=module', '-e', `
      import { createLogger } from ${JSON.stringify(loggerModule)};
      const logger = createLogger({ dir: ${JSON.stringify(dir)}, name: 'desktop' });
      logger.info('before shutdown');
      logger.close();
      logger.close();
      logger.warn('a pending operation settled after shutdown');
    `], { timeout: 10_000 });
    assert.match(stderr, /a pending operation settled after shutdown/);
    assert.match(fs.readFileSync(path.join(dir, 'desktop.log'), 'utf8'), /before shutdown/);
  });
});

/* (QA, 2026-10-09, TT-3479) desktop.log was opened for append and never
   trimmed. It is now set aside as desktop.log.1 when it is opened over the
   limit, one generation kept. */
const closed = (logger) => new Promise((resolve) => { logger.close(); setTimeout(resolve, 50); });

test('a log opened over the limit is set aside as .1, and the next rotation replaces it', async () => {
  const { createLogger, LOG_ROTATE_BYTES } = await import('../core/log.mjs');
  await withLogHome(async (dir) => {
    const log = path.join(dir, 'desktop.log');
    const old = path.join(dir, 'desktop.log.1');
    fs.writeFileSync(log, 'a'.repeat(LOG_ROTATE_BYTES + 1));

    const first = createLogger({ dir, name: 'desktop', stream: null });
    first.info('after the first rotation');
    await closed(first);
    assert.equal(fs.statSync(old).size, LOG_ROTATE_BYTES + 1, '.1 does not hold the old log');
    assert.ok(fs.statSync(log).size < 1024, 'the log was not started afresh');
    assert.match(fs.readFileSync(log, 'utf8'), /after the first rotation/);

    // Under the limit: left alone and appended to.
    const second = createLogger({ dir, name: 'desktop', stream: null });
    second.info('still the same file');
    await closed(second);
    assert.match(fs.readFileSync(log, 'utf8'), /after the first rotation[\s\S]*still the same file/);

    fs.writeFileSync(log, 'b'.repeat(LOG_ROTATE_BYTES + 2));
    const third = createLogger({ dir, name: 'desktop', stream: null });
    await closed(third);
    assert.equal(fs.statSync(old).size, LOG_ROTATE_BYTES + 2, 'the second rotation did not replace .1');
    assert.equal(fs.readFileSync(old, 'utf8')[0], 'b');
  });
});

test('a log that cannot be set aside is appended to, and nothing throws', async () => {
  const { createLogger, LOG_ROTATE_BYTES } = await import('../core/log.mjs');
  await withLogHome(async (dir) => {
    const log = path.join(dir, 'desktop.log');
    fs.writeFileSync(log, 'a'.repeat(LOG_ROTATE_BYTES + 1));
    // A non-empty directory where .1 goes: no platform will rename a file onto it.
    fs.mkdirSync(path.join(dir, 'desktop.log.1', 'in-the-way'), { recursive: true });

    const logger = createLogger({ dir, name: 'desktop', stream: null });
    logger.info('kept appending');
    await closed(logger);
    assert.ok(fs.statSync(log).size > LOG_ROTATE_BYTES, 'the old content went somewhere');
    assert.match(fs.readFileSync(log, 'utf8').slice(-200), /kept appending/);
  });
});

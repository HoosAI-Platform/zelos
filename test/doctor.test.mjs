/**
 * test/doctor.test.mjs — the checks `zelos doctor` makes, and the ones it did
 * not make.
 *
 * `test/cli.test.mjs` already covers the shape of the report, the exit code and
 * the command line. This file is about the diagnosis itself, and every group in
 * it exists because doctor once returned "Nothing is broken" about a machine
 * that was:
 *
 *  1. **The database.** `diagnose()` imported nothing from ./db.mjs and the
 *     folder check only `existsSync`ed zelos.db, so a file the app dies on at
 *     launch read as "✓ Data folder … database present".
 *  2. **The sent folder.** It was deliberately excluded from the folders the
 *     mail check asks the server for, and then the pass line printed
 *     "reading INBOX" about an account whose every sweep was failing.
 *  3. **The secret store.** `backend()` answers "which store is in use", which
 *     since the pin landed is not the same question as "which store answered".
 *  4. **The settings file.** `loadConfig()` repairs a scalar section on the way
 *     in with nothing but a log line, so doctor called a file "valid" seconds
 *     after the user's identity block had been thrown away.
 *  5. **Redirects.** Both `.ics` readers outside the sweep handed redirect
 *     policy to `fetch`, which follows twenty of them.
 *
 * Nothing here touches the real home or the real keychain: ZELOS_HOME is a
 * throwaway and the backend is forced to the encrypted file before any core
 * module loads.
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-doctor-test-'));
process.env.ZELOS_HOME = path.join(SCRATCH, 'default-home');
process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file';

const { diagnose } = await import('../core/doctor.mjs');
const { SCHEMA_VERSION } = await import('../core/db.mjs');

after(() => {
  try {
    fs.rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (err) {
    // Windows can hold a handle on a temp directory for a moment after the
    // process that read it exits. Litter, not a test result.
    if (err?.code !== 'EPERM' && err?.code !== 'EBUSY' && err?.code !== 'ENOTEMPTY') throw err;
  }
});

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

let counter = 0;

/** A home nothing else has touched. `raw` writes config.json verbatim. */
function freshHome({ config = null, raw = null } = {}) {
  counter += 1;
  const home = path.join(SCRATCH, `home-${counter}`);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  if (raw !== null) fs.writeFileSync(path.join(home, 'config.json'), raw);
  else if (config) fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config, null, 2));
  process.env.ZELOS_HOME = home;
  return home;
}

/** Anything network-shaped throws, so a test that reaches one says so loudly. */
const SILENT_DEPS = {
  backend: async () => ({ name: 'macos-keychain', writable: true, note: 'Stored in your login keychain.' }),
  getSecret: async () => null,
  listModels: async () => { throw new Error('listModels should not have been called'); },
  testImap: async () => { throw new Error('testImap should not have been called'); },
  testCalDav: async () => { throw new Error('testCalDav should not have been called'); },
  fetchImpl: async () => { throw new Error('fetch should not have been called'); },
};

const byId = (report, id) => report.checks.find((c) => c.id === id);

/** A real, migrated-looking database at `home/zelos.db`, at `version`. */
function writeDatabase(home, version = SCHEMA_VERSION) {
  const file = path.join(home, 'zelos.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE items (id TEXT PRIMARY KEY)');
  db.exec(`PRAGMA user_version = ${Number(version)}`);
  db.close();
  return file;
}

async function mockServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const ICS = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'X-WR-CALNAME:Team',
  'BEGIN:VEVENT', 'UID:1@zelos', 'DTSTART:20260811T180000Z', 'DTEND:20260811T190000Z',
  'SUMMARY:Standup', 'END:VEVENT', 'END:VCALENDAR', '',
].join('\r\n');

/* ================================================================== *
 * 1. The database, actually opened
 * ================================================================== */

describe('the database check', () => {
  /**
   * The report's `ok: true` was the false statement, not "database present" —
   * which is literally true of a file that is a directory, a text file, or
   * owned by root. Reproduced in four scratch homes: doctor printed
   * "✓ Data folder … · database present" and "Nothing is broken", exit 0, while
   * `node zelos.mjs` died at startup with a bare `Error: file is not a
   * database` and no pointer back to doctor.
   */
  test('a corrupt zelos.db is a failure that says to move it aside', async () => {
    const home = freshHome();
    fs.writeFileSync(path.join(home, 'zelos.db'), 'this is a text file, not a database\n');

    const report = await diagnose({ deps: SILENT_DEPS });
    const db = byId(report, 'database');
    assert.ok(db, 'there is no database check at all');
    assert.equal(db.status, 'fail', db.detail);
    assert.match(db.detail, /zelos\.db/);
    assert.match(db.detail, /not a database|cannot be opened|damaged/i);
    assert.match(db.action, /move the file aside/i);
    assert.match(db.action, /mv "/, 'the remedy has to be copy-pasteable');
    assert.equal(report.ok, false, 'a home the app cannot start on is not "nothing is broken"');
  });

  test('a zelos.db that is a directory, or unreadable, fails the same way', async () => {
    const home = freshHome();
    fs.mkdirSync(path.join(home, 'zelos.db'));
    const asDirectory = await diagnose({ deps: SILENT_DEPS });
    assert.equal(byId(asDirectory, 'database').status, 'fail');
    assert.equal(asDirectory.ok, false);

    // A backup restored as root, or one `sudo zelos`, leaves exactly this.
    // Skipped for root, who can read it regardless, and on Windows, which does
    // not implement the mode.
    if (process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)) return;
    const locked = freshHome();
    const file = writeDatabase(locked);
    fs.chmodSync(file, 0o000);
    try {
      const report = await diagnose({ deps: SILENT_DEPS });
      const check = byId(report, 'database');
      assert.equal(check.status, 'fail', check.detail);
      assert.match(check.detail, /cannot be opened/);
    } finally {
      fs.chmodSync(file, 0o600);
    }
  });

  /**
   * `migrate()` only ever moves forward and returns `{applied: 0}` without a
   * word, and SCHEMA_VERSION was compared to nothing outside the tests — so an
   * older build reads a newer file happily until it touches a column that is
   * not there. This is the half with no victims yet, and the cheapest one to
   * keep that way.
   */
  test('a database from a newer Zelos is named, and the remedy is not "delete it"', async () => {
    const home = freshHome();
    writeDatabase(home, SCHEMA_VERSION + 5);
    const report = await diagnose({ deps: SILENT_DEPS });
    const db = byId(report, 'database');
    assert.equal(db.status, 'fail', db.detail);
    assert.match(db.detail, new RegExp(`version ${SCHEMA_VERSION + 5}`));
    assert.match(db.detail, new RegExp(`understands ${SCHEMA_VERSION}`));
    assert.match(db.action, /Update Zelos/);
    assert.match(db.action, /Do not delete/, 'the newer build can still read this file');
  });

  test('a healthy database passes and reports the schema it is on', async () => {
    const home = freshHome();
    writeDatabase(home, SCHEMA_VERSION);
    const report = await diagnose({ deps: SILENT_DEPS });
    const db = byId(report, 'database');
    assert.equal(db.status, 'pass', db.detail);
    assert.match(db.detail, new RegExp(`schema ${SCHEMA_VERSION} of ${SCHEMA_VERSION}`));
    assert.match(db.detail, /integrity ok/);
    assert.equal(report.ok, true, JSON.stringify(report.checks.filter((c) => c.status === 'fail')));
  });

  test('an older database is a pass that says it will upgrade itself', async () => {
    const home = freshHome();
    writeDatabase(home, 0);
    const db = byId(await diagnose({ deps: SILENT_DEPS }), 'database');
    assert.equal(db.status, 'pass', db.detail);
    assert.match(db.detail, /upgrades itself on the next launch/);
  });

  /**
   * A fresh install has no database and that is not a finding. It also must not
   * become one: `report.ok` is what the exit code is built from, and a first
   * run that exits 1 sends a new user hunting for a fault that does not exist.
   */
  test('no database yet is "nothing to check", not a failure', async () => {
    freshHome();
    const report = await diagnose({ deps: SILENT_DEPS });
    const db = byId(report, 'database');
    assert.equal(db.status, 'skip');
    assert.match(db.detail, /has not been created yet/);
    assert.equal(report.ok, true);
  });

  /**
   * The check is read-only, and that is load-bearing twice over: doctor
   * diagnoses rather than repairs (a plain `open()` would create the file, set
   * WAL and run migrations — three of the conditions being measured), and
   * `zelos doctor` is most often run while Zelos itself is up.
   */
  test('the check neither creates the database nor disturbs a live one', async () => {
    const home = freshHome();
    await diagnose({ deps: SILENT_DEPS });
    // `paths()` makes cache/ and logs/, which diagnose() has always called for
    // the config path — but nothing here may bring a database into existence,
    // because "there is no database yet" is one of the answers.
    assert.deepEqual(
      fs.readdirSync(home).filter((f) => f.startsWith('zelos.db')),
      [],
      'the diagnosis created the database it was asked to inspect',
    );

    const live = freshHome();
    const file = writeDatabase(live);
    const writer = new DatabaseSync(file);
    writer.exec('PRAGMA journal_mode = WAL');
    writer.exec("INSERT INTO items (id) VALUES ('a')");
    try {
      const db = byId(await diagnose({ deps: SILENT_DEPS }), 'database');
      assert.equal(db.status, 'pass', db.detail);
      // The writer is still usable afterwards; a read-only handle took no lock
      // it did not give back.
      writer.exec("INSERT INTO items (id) VALUES ('b')");
      assert.equal(writer.prepare('SELECT count(*) AS n FROM items').get().n, 2);
    } finally {
      writer.close();
    }
  });
});

/* ================================================================== *
 * 2. The sent folder
 * ================================================================== */

describe('the mail check and the sent folder', () => {
  const account = (over = {}) => ({
    id: 'm_1',
    enabled: true,
    label: 'Work',
    host: 'outlook.office365.com',
    port: 993,
    secure: true,
    user: 'me@example.com',
    keyRef: 'mail.m_1',
    mailboxes: ['INBOX'],
    sentMailbox: 'Sent',
    ...over,
  });

  const M365 = [
    { name: 'INBOX', specialUse: 'inbox' },
    { name: 'Sent Items', specialUse: 'sent' },
    { name: 'Drafts', specialUse: 'drafts' },
    { name: 'Deleted Items', specialUse: 'trash' },
  ];

  /**
   * Reproduced against this exact folder set: the source came back
   * `{label:"Work / Sent", ok:false, error:"Mailbox doesn't exist: Sent"}` on
   * every sweep forever, the run stayed `ok:true`, and doctor said
   * `pass · 4 folders · reading INBOX`. The excluded folder is the one the
   * whole "you promised" half of the board is mined from.
   */
  test('a sent folder the server does not have is a warning, not a pass', async () => {
    freshHome({ config: { mail: [account()] } });
    const report = await diagnose({
      deps: {
        ...SILENT_DEPS,
        getSecret: async () => 'app-password',
        testImap: async () => ({ ok: true, capabilities: [], mailboxes: M365, error: null }),
      },
    });
    const check = byId(report, 'mail.m_1');
    assert.equal(check.status, 'warn', check.detail);
    assert.match(check.detail, /Sent is not on the server/);
    // The server's own \Sent flag, which listMailboxes has computed since the
    // client was written and which nothing outside a test had ever read.
    assert.match(check.action, /Sent Items/, 'the answer was in the response the whole time');
    assert.match(check.action, /Settings → Email → Sent folder/);
  });

  test('the pass line names every folder the sweep will actually read', async () => {
    freshHome({ config: { mail: [account({ mailboxes: ['INBOX', 'Team'], sentMailbox: 'Sent Items' })] } });
    const report = await diagnose({
      deps: {
        ...SILENT_DEPS,
        getSecret: async () => 'app-password',
        testImap: async () => ({
          ok: true,
          capabilities: [],
          mailboxes: [...M365, { name: 'Team', specialUse: null }],
          error: null,
        }),
      },
    });
    const check = byId(report, 'mail.m_1');
    assert.equal(check.status, 'pass', check.detail);
    // core/sweep.mjs's mailboxesFor() builds exactly this list, in this order.
    assert.match(check.detail, /reading INBOX, Team, Sent Items/);
  });

  test('an account with no sent folder passes, and the report says what that costs', async () => {
    freshHome({ config: { mail: [account({ sentMailbox: '' })] } });
    const report = await diagnose({
      deps: {
        ...SILENT_DEPS,
        getSecret: async () => 'app-password',
        testImap: async () => ({ ok: true, capabilities: [], mailboxes: M365, error: null }),
      },
    });
    const check = byId(report, 'mail.m_1');
    assert.equal(check.status, 'pass', check.detail);
    assert.match(check.detail, /no sent folder is set, so nothing you wrote is read/);
  });
});

/* ================================================================== *
 * 3. Which secret store, and how we know
 * ================================================================== */

describe('the secret store check', () => {
  /**
   * The contract, both ends: core/secrets.mjs writes secrets.backend.json at
   * the first successful setSecret (`recordBackend`, called from `setSecret`),
   * and this is the only reader of it outside that module. Written here with
   * the real secrets module rather than by hand, so the file's shape cannot
   * drift on one side without this going red.
   */
  test('a real stored secret pins the folder, and doctor says the name came from the record', async () => {
    const home = freshHome();
    const secrets = await import('../core/secrets.mjs');
    secrets.resetBackendCache();
    await secrets.setSecret('model.default', 'sk-scratch-value');
    assert.ok(fs.existsSync(path.join(home, 'secrets.backend.json')), 'setSecret did not record the store');

    const report = await diagnose({
      deps: { ...SILENT_DEPS, backend: async () => ({ name: 'encrypted-file', writable: true, note: 'AES-256-GCM in your Zelos home.' }) },
    });
    const check = byId(report, 'secrets');
    assert.equal(check.status, 'warn');
    assert.match(check.detail, /pinned to it by its own secrets\.backend\.json/);
    // The remedy used to end "on macOS and Windows the system store is used
    // automatically", which contradicted the warning it had just printed and,
    // once the pin landed, was wrong a second way: the record beats the probe,
    // so a keychain appearing later changes nothing on its own.
    assert.ok(!/used automatically/.test(check.action), check.action);
    assert.match(check.action, /will not undo itself|deliberate act/);
    assert.match(check.action, /secrets\.backend\.json/, 'the file that has to go is not named');
    secrets.resetBackendCache();
  });

  test('a record that disagrees with the store in use is a warning that names both', async () => {
    const home = freshHome();
    fs.writeFileSync(path.join(home, 'secrets.backend.json'), JSON.stringify({ backend: 'libsecret' }));
    const report = await diagnose({
      deps: { ...SILENT_DEPS, backend: async () => ({ name: 'encrypted-file', writable: true, note: 'AES-256-GCM.' }) },
    });
    const check = byId(report, 'secrets');
    assert.equal(check.status, 'warn');
    assert.match(check.detail, /libsecret/);
    assert.match(check.detail, /encrypted-file/);
    assert.ok(check.action, 'a warning with nothing to do is not a warning');
    // ZELOS_SECRETS_BACKEND is forced across this whole file, and that is the
    // reason the two disagree — so the remedy has to name the variable rather
    // than send the reader off re-typing passwords.
    assert.match(check.action, /ZELOS_SECRETS_BACKEND/);
  });

  /**
   * The whole point of the pin is that `backend()` can answer from the record
   * rather than from a live probe — which is also why "✓ macos-keychain" here
   * used to be compatible with a keychain that was not answering at all. Doctor
   * cannot re-probe without a seam secrets.mjs does not offer; what it can do
   * is stop presenting the two as the same fact.
   */
  test('the pass line says whether the name is recorded or merely probed', async () => {
    const home = freshHome();
    const probed = await diagnose({ deps: SILENT_DEPS });
    assert.equal(byId(probed, 'secrets').status, 'pass');
    assert.match(byId(probed, 'secrets').detail, /chosen by probing this machine/);
    assert.match(byId(probed, 'secrets').detail, /not pinned/);

    fs.writeFileSync(path.join(home, 'secrets.backend.json'), JSON.stringify({ backend: 'macos-keychain' }));
    const recorded = await diagnose({ deps: SILENT_DEPS });
    assert.equal(byId(recorded, 'secrets').status, 'pass');
    assert.match(byId(recorded, 'secrets').detail, /recorded in this folder's secrets\.backend\.json/);
    assert.match(byId(recorded, 'secrets').detail, /even if a probe blinks/);
  });
});

/* ================================================================== *
 * 4. A settings file that loaded, and lost something on the way
 * ================================================================== */

describe('the settings file check', () => {
  /**
   * `loadConfig()` puts a scalar section back to its defaults rather than
   * throwing — it has to, because doctor's own advice is "edit config.json
   * directly" and a typo there must not brick the app that reports the typo.
   * The repair is a log line nobody sees, so `validateConfig` was handed a
   * perfectly good object and doctor said "valid" about a file whose identity
   * block had just been thrown away.
   */
  test('a section the file got wrong is reported, even though the config loads', async () => {
    freshHome({ raw: '{\n  "identity": 5,\n  "privacy": []\n}\n' });
    const report = await diagnose({ deps: SILENT_DEPS });
    const config = byId(report, 'config');
    assert.equal(config.status, 'warn', config.detail);
    assert.match(config.detail, /identity/);
    assert.match(config.detail, /privacy/);
    assert.match(config.detail, /is gone|are gone/, 'the values were lost, and that is the point');
    assert.match(config.action, /config\.json/);
    assert.ok(report.ok, 'the app still runs, so this is worth knowing, not broken');
  });

  test('an ordinary settings file is still just valid', async () => {
    freshHome({ config: { version: 1, identity: { name: 'Nemo', email: 'nemo@example.com' } } });
    const config = byId(await diagnose({ deps: SILENT_DEPS }), 'config');
    assert.equal(config.status, 'pass', config.detail);
    assert.match(config.detail, /valid/);
  });

  test('a config that cannot be validated at all still fails, not warns', async () => {
    freshHome({ config: { version: 1, ui: { accent: 'not-a-colour' } } });
    const config = byId(await diagnose({ deps: SILENT_DEPS }), 'config');
    assert.equal(config.status, 'fail');
    assert.match(config.detail, /ui\.accent/);
  });
});

/* ================================================================== *
 * 5. One hop, and the password stays home
 * ================================================================== */

describe('the calendar reader follows one redirect', () => {
  const calendar = (url, over = {}) => ({
    id: 'c_1', enabled: true, label: 'Team', kind: 'ics', url, user: '', keyRef: null, ...over,
  });
  const realFetch = { fetchImpl: (...args) => globalThis.fetch(...args) };

  /**
   * Measured on Node 26.3.0 with the old `redirect: 'follow'`: a 6-origin chain
   * returned 200 having contacted six hosts, and a 22-origin chain contacted
   * twenty-one. So pressing Test or running `zelos doctor` opened connections
   * to as many as twenty hosts the user never typed — inside the same passage
   * of docs/SECURITY.md that invites the reader to check it with tcpdump and
   * promises one hop.
   */
  test('a two-hop chain is refused, and the second host is never contacted', async (t) => {
    const hits = [];
    const third = await mockServer((req, res) => {
      hits.push('third');
      res.writeHead(200, { 'content-type': 'text/calendar' });
      res.end(ICS);
    });
    const second = await mockServer((req, res) => {
      hits.push('second');
      res.writeHead(302, { location: `${third.origin}/team.ics` });
      res.end();
    });
    const first = await mockServer((req, res) => {
      hits.push('first');
      res.writeHead(302, { location: `${second.origin}/team.ics` });
      res.end();
    });
    t.after(async () => { await first.close(); await second.close(); await third.close(); });

    freshHome({ config: { calendars: [calendar(`${first.origin}/team.ics`)] } });
    const report = await diagnose({ deps: { ...SILENT_DEPS, ...realFetch } });
    const check = byId(report, 'calendar.c_1');
    assert.equal(check.status, 'fail', check.detail);
    assert.match(check.detail, /redirects more than once/);
    assert.deepEqual(hits, ['first', 'second'], `the chain kept walking: ${hits.join(' -> ')}`);
    assert.ok(check.action, 'a failure with nothing to do is not a diagnosis');
  });

  test('one hop is followed, and it still reads the calendar', async (t) => {
    const target = await mockServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/calendar' });
      res.end(ICS);
    });
    const entry = await mockServer((req, res) => {
      res.writeHead(301, { location: `${target.origin}/real.ics` });
      res.end();
    });
    t.after(async () => { await entry.close(); await target.close(); });

    freshHome({ config: { calendars: [calendar(`${entry.origin}/team.ics`)] } });
    const check = byId(await diagnose({ deps: { ...SILENT_DEPS, ...realFetch } }), 'calendar.c_1');
    assert.equal(check.status, 'pass', check.detail);
    assert.match(check.detail, /1 entry/);
  });

  /**
   * The origin pin, which the sweep has hand-rolled since the beginning and
   * these two readers delegated to fetch. undici does strip Authorization
   * across origins itself, so nothing leaked — but re-attaching it on a
   * SAME-origin hop is this code's own decision, and a redirect that changes
   * only the path has to keep working for a calendar behind a password.
   */
  test('credentials cross a same-origin hop and never a cross-origin one', async (t) => {
    const seenElsewhere = [];
    const elsewhere = await mockServer((req, res) => {
      seenElsewhere.push(req.headers.authorization ?? null);
      res.writeHead(200, { 'content-type': 'text/calendar' });
      res.end(ICS);
    });
    const seenHere = [];
    const here = await mockServer((req, res) => {
      seenHere.push(req.headers.authorization ?? null);
      if (req.url === '/team.ics') {
        res.writeHead(302, { location: '/real.ics' });
        res.end();
        return;
      }
      if (req.url === '/away.ics') {
        res.writeHead(302, { location: `${elsewhere.origin}/real.ics` });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/calendar' });
      res.end(ICS);
    });
    t.after(async () => { await here.close(); await elsewhere.close(); });

    const withPassword = {
      ...SILENT_DEPS,
      ...realFetch,
      getSecret: async () => 'hunter2-the-real-password',
    };
    const expected = `Basic ${Buffer.from('me@example.com:hunter2-the-real-password').toString('base64')}`;

    freshHome({
      config: {
        calendars: [calendar(`${here.origin}/team.ics`, { user: 'me@example.com', keyRef: 'calendar.c_1' })],
      },
    });
    assert.equal(byId(await diagnose({ deps: withPassword }), 'calendar.c_1').status, 'pass');
    assert.deepEqual(seenHere, [expected, expected], 'a hop inside the same origin dropped the credential');

    freshHome({
      config: {
        calendars: [calendar(`${here.origin}/away.ics`, { user: 'me@example.com', keyRef: 'calendar.c_1' })],
      },
    });
    seenHere.length = 0;
    assert.equal(byId(await diagnose({ deps: withPassword }), 'calendar.c_1').status, 'pass');
    assert.deepEqual(seenHere, [expected], 'the first request should carry it');
    assert.deepEqual(seenElsewhere, [null], 'the password went to a host the user never typed');
  });

  test('a redirect with no destination is named rather than thrown', async (t) => {
    const server = await mockServer((req, res) => { res.writeHead(302); res.end(); });
    t.after(() => server.close());
    freshHome({ config: { calendars: [calendar(`${server.origin}/team.ics`)] } });
    const check = byId(await diagnose({ deps: { ...SILENT_DEPS, ...realFetch } }), 'calendar.c_1');
    assert.equal(check.status, 'fail');
    assert.match(check.detail, /did not say where to/);
    assert.ok(check.action);
  });
});

/* ================================================================== *
 * 6. The two calendar probes that are not an .ics over http
 * ================================================================== */

/**
 * These lived in `checkCalendar` as `if (calendar.kind === 'file')` and
 * `if (calendar.kind === 'caldav')` and had no test of their own: the group
 * above only ever exercises the http reader, so the two branches a user with a
 * local file or a Fastmail account actually takes were carried by nothing.
 *
 * They now live in core/connectors/file.mjs and core/connectors/caldav.mjs, and
 * doctor reaches them through `connector.check(source, ctx)` rather than by
 * knowing what kinds exist. What is pinned here is the SENTENCES, because they
 * are what the person who is stuck reads, and a refactor that quietly reworded
 * them would be a regression no other assertion could see.
 */
describe('the calendar probes that belong to a connector', () => {
  const calendar = (over = {}) => ({
    id: 'c_1', enabled: true, label: 'Team', kind: 'file', url: '', user: '', keyRef: null, ...over,
  });

  test('a local .ics is read off the disk and counted', async () => {
    const home = freshHome();
    const file = path.join(home, 'team.ics');
    fs.writeFileSync(file, ICS);
    freshHome({ config: { calendars: [calendar({ url: file })] } });

    const check = byId(await diagnose({ deps: SILENT_DEPS }), 'calendar.c_1');
    assert.equal(check.status, 'pass', check.detail);
    assert.match(check.detail, /1 entry/);
    assert.ok(check.detail.includes(file), 'the path is what the reader has to check');
  });

  test('a path that is not a readable file says so, and says what to do', async () => {
    const home = freshHome();
    freshHome({ config: { calendars: [calendar({ url: path.join(home, 'nothing-here.ics') })] } });

    const missing = byId(await diagnose({ deps: SILENT_DEPS }), 'calendar.c_1');
    assert.equal(missing.status, 'fail', missing.detail);
    assert.match(missing.detail, /ENOENT|no such file/i);
    assert.match(missing.action, /readable \.ics file on this machine/);

    // A directory is the case a bare readFile reports as something else entirely.
    freshHome({ config: { calendars: [calendar({ url: home })] } });
    const dir = byId(await diagnose({ deps: SILENT_DEPS }), 'calendar.c_1');
    assert.equal(dir.status, 'fail', dir.detail);
    assert.match(dir.detail, /that path is not a file/);
  });

  test('a CalDAV collection is counted, and a refusal names the app-password rule', async () => {
    freshHome({ config: { calendars: [calendar({ kind: 'caldav', url: 'https://dav.example.com/', user: 'me', keyRef: 'calendar.c_1' })] } });

    const asked = [];
    const ok = byId(await diagnose({
      deps: {
        ...SILENT_DEPS,
        getSecret: async () => 'hunter2',
        testCalDav: async (spec) => { asked.push(spec); return { ok: true, calendars: [{}, {}], error: null }; },
      },
    }), 'calendar.c_1');
    assert.equal(ok.status, 'pass', ok.detail);
    assert.match(ok.detail, /2 calendars at https:\/\/dav\.example\.com\//);
    // The stored password is handed over, or this is a test of an anonymous
    // connection rather than of the user's account.
    assert.equal(asked[0].pass, 'hunter2');
    assert.equal(asked[0].user, 'me');

    const refused = byId(await diagnose({
      deps: {
        ...SILENT_DEPS,
        getSecret: async () => 'hunter2',
        testCalDav: async () => ({ ok: false, calendars: [], error: 'the server said 401' }),
      },
    }), 'calendar.c_1');
    assert.equal(refused.status, 'fail', refused.detail);
    assert.match(refused.detail, /the server said 401/);
    assert.match(refused.action, /app-specific password/);
  });

  test('a CalDAV 403 sends the reader to the address, not the password', async () => {
    // QA, 2026-10-10, TT-3455: a 403 is the server refusing this address. The
    // app-specific-password advice above is for a 401, and it is the wrong fix.
    const forbidden = { ok: false, refused: true, calendars: [], error: 'dav.example.com refused access to /alice/cal/ (HTTP 403).' };
    freshHome({ config: { calendars: [calendar({ kind: 'caldav', url: 'https://dav.example.com/alice/cal/', user: 'me', keyRef: 'calendar.c_1' })] } });
    const withUser = byId(await diagnose({
      deps: { ...SILENT_DEPS, getSecret: async () => 'hunter2', testCalDav: async () => forbidden },
    }), 'calendar.c_1');
    assert.equal(withUser.status, 'fail', withUser.detail);
    assert.match(withUser.detail, /refused access to \/alice\/cal\//);
    assert.match(withUser.action, /calendar URL/);
    assert.doesNotMatch(withUser.action, /app-specific|password/);

    freshHome({ config: { calendars: [calendar({ kind: 'caldav', url: 'https://dav.example.com/alice/cal/' })] } });
    const noUser = byId(await diagnose({
      deps: { ...SILENT_DEPS, testCalDav: async () => forbidden },
    }), 'calendar.c_1');
    assert.equal(noUser.status, 'fail', noUser.detail);
    assert.match(noUser.action, /username and password/);
  });

  test('a secret store that will not answer is not reported twice', async () => {
    /* The secret-store line above is already a `fail` when this happens, and
       sending the reader to re-check their calendar address instead is how a
       diagnosis wastes somebody's afternoon. The connection is tried
       unauthenticated and the server's answer is the diagnosis. */
    freshHome({ config: { calendars: [calendar({ kind: 'caldav', url: 'https://dav.example.com/', user: 'me', keyRef: 'calendar.c_1' })] } });
    const asked = [];
    const check = byId(await diagnose({
      deps: {
        ...SILENT_DEPS,
        getSecret: async () => { throw new Error('the keychain is locked'); },
        testCalDav: async (spec) => { asked.push(spec); return { ok: true, calendars: [{}], error: null }; },
      },
    }), 'calendar.c_1');
    assert.equal(check.status, 'pass', check.detail);
    assert.equal(asked[0].pass, null);
  });
});

/* ================================================================== *
 * 7. Where doctor looks
 * ================================================================== */

describe('where doctor looks for the home', () => {
  /**
   * core/config.mjs `homeDir()` has treated the literal strings "undefined"
   * and "null" as no override since one of them became a live data directory
   * named undefined/ in the cwd — they are what `ZELOS_HOME=${home}` becomes
   * when `home` is unset. doctor's own reader had no such guard, so
   * `ZELOS_HOME=undefined zelos doctor` reported on $PWD/undefined while the
   * app it was diagnosing used ~/.zelos. The home directory is redirected to
   * scratch for the duration, so the test never looks at the real one.
   */
  test('REGRESSION: a ZELOS_HOME that is the word "undefined" or "null" is no override here, as it is for the app', async () => {
    const fakeUserHome = path.join(SCRATCH, 'fake-user-home');
    fs.mkdirSync(fakeUserHome, { recursive: true });
    const saved = { ZELOS_HOME: process.env.ZELOS_HOME, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    const restore = (key, value) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
    try {
      process.env.HOME = fakeUserHome;
      process.env.USERPROFILE = fakeUserHome;
      assert.equal(os.homedir(), fakeUserHome, 'this platform did not follow the redirected home, so the test cannot run safely');
      const expected = path.join(fakeUserHome, '.zelos');
      for (const junk of ['undefined', 'null', 'NULL', '  undefined  ', '   ']) {
        process.env.ZELOS_HOME = junk;
        const home = byId(await diagnose({ deps: SILENT_DEPS }), 'home');
        assert.ok(home.detail.startsWith(expected), `ZELOS_HOME=${JSON.stringify(junk)}: doctor looked at ${home.detail}`);
        if (junk.trim()) {
          assert.ok(!home.detail.includes(path.join(process.cwd(), junk.trim())), 'doctor reported on a folder in the working directory');
        }
      }
      // A real override is still honoured exactly as before.
      const real = freshHome();
      assert.ok(byId(await diagnose({ deps: SILENT_DEPS }), 'home').detail.startsWith(real));
    } finally {
      restore('ZELOS_HOME', saved.ZELOS_HOME);
      restore('HOME', saved.HOME);
      restore('USERPROFILE', saved.USERPROFILE);
    }
  });
});

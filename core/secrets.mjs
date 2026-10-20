/**
 * core/secrets.mjs — the only place a credential is allowed to exist.
 *
 * Zelos stores IMAP passwords and model API keys. config.json holds a `keyRef`
 * ("model.default", "mail.m_9f3a1c"); the value behind that ref lives here.
 *
 * Three properties this module is responsible for, in order of importance:
 *
 *  1. **A secret never appears in argv.** `ps` shows every process's command line
 *     to every other process running as this user. `describeCommand()` — the one
 *     function that builds a command line — takes no value parameter at all, so
 *     it is structurally incapable of leaking one. Values travel on stdin.
 *  2. **A secret never lands on disk in plaintext.** Platform keychain first;
 *     the fallback file is AES-256-GCM.
 *  3. **There is no way to enumerate values.** `listRefs()` returns refs. There
 *     is deliberately no `listSecrets`, and the HTTP layer has no read route.
 *
 * Backend order per SPEC §2: macOS keychain, Windows DPAPI, libsecret, then the
 * encrypted-file fallback. Set ZELOS_SECRETS_BACKEND to force one (used by the
 * tests to exercise the fallback on a machine that has a keychain).
 *
 * Detection runs once and is then *pinned*: the first successful write records
 * the store in `secrets.backend.json`, and from then on that record beats the
 * probe — see "the backend on record" below for why a probe that changes its
 * mind is how a user's credentials end up in two places at once.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

import { paths, isValidRef, writeFileAtomic } from './config.mjs';
import { log } from './log.mjs';

export const SERVICE = 'com.zelos.app';

const BACKEND_NAMES = ['macos-keychain', 'windows-dpapi', 'libsecret', 'encrypted-file'];

/** `security` exits 44 for "item not found"; we borrow it for the DPAPI script. */
const NOT_FOUND_EXIT = 44;

const NOTES = {
  'macos-keychain':
    'Stored in your macOS login keychain (service "com.zelos.app"). Zelos never writes the value to disk itself and never passes it on a command line.',
  'windows-dpapi':
    'Encrypted with Windows DPAPI at CurrentUser scope, so only your Windows account can decrypt it. Zelos never passes the value on a command line.',
  libsecret:
    'Stored in your desktop keyring via secret-tool (service "com.zelos.app"). Zelos never passes the value on a command line.',
  'encrypted-file':
    'No system keychain was available, so secrets are stored in an AES-256-GCM encrypted file in your Zelos home, mode 0600, keyed by a random machine seed in .seed. A copy of the encrypted file needs that seed to decrypt it. A backup or disk copy containing both files can decrypt your credentials. It does NOT protect against a process already running as this user: that process can read .seed and decrypt the file exactly as Zelos does. Keep backups private. Install a system keychain for stronger protection.',
};

/* -------------------------------------------------------------- timeouts
 * One number served every subprocess this module runs — a liveness check, a
 * "does this ref still exist", and the write that carries a password — and it
 * was too small for the ones that can lose something.
 *
 * `run()` defaulted to 15_000 ms and the PowerShell probe passed 15_000
 * explicitly, so a liveness check and the write that carries a user's IMAP
 * password were handed the same budget. Two measurements say that is wrong in
 * both directions.
 *
 * (1) A GitHub Actions `windows-latest` runner — fast, idle, nothing else on
 *     it — failed a release build:
 *
 *       ✖ Windows CI: DPAPI is the detected backend and really round-trips a
 *         secret (18136ms)
 *         Error: powershell.exe timed out after 15000ms
 *
 *     It passed on re-run, which is the point. That is not a broken machine;
 *     it is a machine that was slower than a number somebody picked, once.
 *
 *     Which of that test's PowerShell spawns died is not in the output, but it
 *     is derivable, and the derivation is the useful half. The probe SWALLOWS a
 *     timeout and answers false, so a probe that blew the budget would have
 *     failed the test on its `assert.equal(b.name, 'windows-dpapi')` line
 *     rather than escaping as an Error; only setSecret/getSecret/deleteSecret
 *     let one out. So on that machine, at that moment: everything up to and
 *     including the cold probe fitted inside 18_136 − 15_000 = 3_136 ms, and
 *     the very next spawn — the one that autoloads
 *     Microsoft.PowerShell.Security for ConvertFrom-SecureString and writes a
 *     new file through whatever filter drivers are installed — was SIGKILLed at
 *     15_000 ms with work left to do.
 *
 *     A liveness probe and a credential access are not the same size. On one
 *     machine at one moment they differed by a factor of at least 4.8, and one
 *     constant was flattening that.
 *
 * (2) `listRefs()` returned `[]` after 15_020 ms. Those 20 ms of slack over the
 *     probe's own 15_000 are the whole story: the probe timed out, reported "no
 *     PowerShell on this machine", detection fell through to encrypted-file,
 *     and an empty secrets.enc answered that this home has no credentials at
 *     all. Nothing was lost, and nothing said anything — which is the exact
 *     conflation the longest comment in this file warns about, arriving through
 *     the one door that comment did not watch.
 *
 * Where the numbers come from, and why they are not round
 * -------------------------------------------------------
 * 3_136 ms is an UPPER bound on a cold `powershell.exe` on the reference
 * runner: the probe is inside it, but so is the test's own setup. 15_000 ms is
 * not a measurement of how long an access takes — it is how long one was
 * allowed to run before it was killed. The real requirement is unknown, because
 * the kill destroyed the evidence, so it can only be treated as a floor already
 * proved too small on the FASTEST, least contended machine in the fleet. A
 * user's laptop, cold, under load, with an antivirus scanning the spawn and
 * every assembly it maps, is the machine these budgets are actually for.
 *
 * So each budget is derived from one of those two, and its factor says what it
 * is buying:
 *
 *   probe  = 3_136 × 2  =  6_272 ms   headroom for a machine twice as slow as
 *                                     the reference runner, on the cold attempt
 *   access = 15_000 × 4 = 60_000 ms   four times a floor that was already too
 *                                     small on an idle CI box
 *
 * The probe getting SHORTER is not a typo. Two attempts at 6_272 ms is 12_544
 * ms of worst-case wall clock — less than the single 15_000 ms budget it
 * replaces — and it now survives cases the old one failed, because of the two
 * changes below: a timeout is retried, and a timeout no longer reads as "this
 * store is not on this machine".
 *
 * Neither number is what is expected to save a slow machine. The retry is.
 */

/**
 * GH Actions windows-latest, idle: 18_136 ms of test wall clock minus the
 * 15_000 ms the credential access burned before it was killed. An upper bound
 * on a cold probe rather than a measurement of one — the test's own setup is
 * inside it, which is the direction that makes it safe to build on.
 */
const MEASURED_COLD_PROBE_MS = 18_136 - 15_000;

/**
 * Not how long a credential access needs — how long one was allowed to run
 * before it was SIGKILLed with work left. A floor known to be too small on the
 * fastest machine available, and nothing more than that.
 */
const MEASURED_TOO_SMALL_MS = 15_000;

/**
 * The two budgets, exported so a test can pin them and so the arithmetic above
 * is checkable rather than just readable.
 *
 * What sorts a caller into one of them is not who it is but what its silence
 * costs — which is why `hasSecret` is on the short budget alongside the three
 * liveness probes rather than with the other two reads. An unanswered `has`
 * keeps the ref (that is the whole of #24 below), so the only thing a longer
 * budget buys it is the chance to PRUNE, and pruning is a tidiness that
 * self-corrects on the next call. Meanwhile `listRefs` is what `GET
 * /api/health` and `modelIsConfigured` sit on, once per ref: on the access
 * budget a single stalled keyring would hold a UI request for two minutes to
 * arrive at the list it started with. An unanswered `get`, `set` or `delete`
 * costs a credential, and those get the long one.
 */
export const TIMEOUTS_MS = Object.freeze({
  /** Questions whose "I could not tell" answer is already safe. */
  probe: MEASURED_COLD_PROBE_MS * 2, //  6_272
  /** Operations where not getting an answer costs a credential. */
  access: MEASURED_TOO_SMALL_MS * 4, // 60_000
});

/**
 * A timeout is retried once, and ONLY a timeout.
 *
 * The CI failure above passed on re-run, and that is the shape of the entire
 * problem. The first `powershell.exe` on a machine pages in the CLR, the
 * assemblies it needs, and — on Windows — hands every one of them to an
 * antivirus on-access scanner. The next spawn finds all of that in the page
 * cache. So the attempt immediately after a timeout is precisely the attempt
 * most likely to succeed, and the killed first attempt was not wasted: it
 * warmed what it touched.
 *
 * Only a timeout, because a refused spawn is instant and definitive. ENOENT
 * means powershell.exe or secret-tool is not on this machine, and asking twice
 * is a second helping of the same answer. That distinction is also what lets
 * the probe budget be short: a missing tool is reported by the operating system
 * in microseconds and never reaches the timer at all, so shortening the timer
 * costs nothing in the case a long timer looked like it was protecting.
 *
 * Two, not more. A third attempt buys progressively less — the cache is warm
 * after the second — and every attempt is wall clock a caller is sitting on.
 * Exported so the arithmetic above ("two probe attempts still cost less than
 * the one 15_000 ms budget they replace") is something a test can check rather
 * than something this comment asserts.
 */
export const ATTEMPTS = 2;

/**
 * What the code reads. `TIMEOUTS_MS` is the product's answer; this is the
 * binding a test may shrink.
 */
let budgets = TIMEOUTS_MS;

/**
 * Testing seam, of the same kind as `resetBackendCache` below, and it exists
 * for a measured reason: the access budget is 60 s, and a test that had to sit
 * through two of them to prove one branch would add two minutes to a suite that
 * runs in nine seconds. So the budgets are read through a binding a test can
 * shrink — the behaviour under test is the retry and the classification, and
 * neither depends on the size of the number.
 *
 * It hands back a restore function instead of exposing a setter, so a test
 * cannot leave the module holding a 250 ms budget for everything after it. And
 * it is deliberately NOT an environment variable: a knob a user can turn is a
 * knob that can be turned down, and the whole subject of this block is what a
 * number picked in a hurry costs a credential.
 */
export function setTimeoutsForTest(overrides) {
  const previous = budgets;
  budgets = Object.freeze({ ...previous, ...overrides });
  return () => { budgets = previous; };
}

/* ------------------------------------------------------------ subprocess */

/**
 * Run a command, feed `input` to stdin, capture output. Never uses a shell, so
 * nothing here is interpretable by /bin/sh.
 *
 * `timeoutMs` has no default. A default is how one number came to serve a
 * liveness probe and a password write at once; every call site now has to say
 * which of the two it is. `label` names the operation in the timeout message,
 * because `powershell.exe timed out after 15000ms` did not say which of four
 * spawns died and the answer had to be reconstructed from a test's wall clock.
 * A ref is safe to put there — it is an opaque id, never a value.
 */
function run(file, args, { input = null, env = null, timeoutMs, label = file } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError(`secrets: run(${file}) needs an explicit timeout, not ${timeoutMs}`);
  }
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(file, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: env ? { ...process.env, ...env } : process.env,
        windowsHide: true,
      });
    } catch (err) {
      reject(err);
      return;
    }
    const out = [];
    const errOut = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      const err = new Error(`${file} timed out after ${timeoutMs}ms (${label})`);
      /* The one flag everything below reads, and the distinction the whole
         block above turns on. Reaching this timer means the spawn SUCCEEDED —
         we have a child, it started, and it did not finish. So "the tool is not
         on this machine" is the single thing a timeout cannot mean, and the
         only errors that do mean it (ENOENT, EACCES) arrive through the 'error'
         handler below without this flag. */
      err.timedOut = true;
      reject(err);
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => errOut.push(d));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(errOut).toString('utf8'),
      });
    });
    // A tool that exits before reading stdin gives us EPIPE; that is not an error
    // we can do anything about, and the close handler reports the real reason.
    child.stdin.on('error', () => {});
    if (input !== null) child.stdin.end(input);
    else child.stdin.end();
  });
}

/**
 * `run`, and once more if — and only if — it timed out. See ATTEMPTS above for
 * why the second attempt is the one likely to work.
 *
 * Every command this module runs is safe to repeat. `security
 * add-generic-password -U` updates in place, `secret-tool store` replaces, and
 * the DPAPI script writes one file whole; none of them append or accumulate. A
 * SIGKILL part-way through the DPAPI write can leave a truncated blob, and the
 * retry is what REPAIRS that rather than what risks it — while a truncated blob
 * left by two failed attempts is read back by `ConvertTo-SecureString` as an
 * error, not as a plausible wrong password.
 *
 * The warning names the label and the budget and nothing else. `opts` carries
 * the value on `input`, and it must not appear in a log line.
 */
async function runWithRetry(file, args, opts) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run(file, args, opts);
    } catch (err) {
      if (err?.timedOut !== true || attempt >= ATTEMPTS) throw err;
      log.warn(`secrets: ${file} did not answer within ${opts.timeoutMs}ms — trying once more, which is usually the attempt that works`,
        { operation: opts.label, attempt, of: ATTEMPTS });
    }
  }
}

/* --------------------------------------------------------- command shapes */

function psEncoded(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/*
 * Both scripts move bytes themselves rather than letting PowerShell choose.
 *
 * `[Console]::In` and `[Console]::Out` decode and encode using the console's
 * code page — CP437 on a US runner, CP1252 on much of Europe, CP932 in Japan.
 * Zelos writes UTF-8 on stdin and reads UTF-8 back, so on a single-byte locale
 * the two mistakes are inverses and cancel: the bytes survive by accident. On a
 * double-byte locale (Japanese, Chinese, Korean) the mapping is not reversible,
 * and an IMAP password with any non-ASCII character in it comes back corrupted
 * — silently, surfacing weeks later as a login failure nobody can explain.
 *
 * So the standard streams are opened raw and encoded explicitly. This is also
 * why the trailing newline is removed by an exact `EndsWith` test rather than
 * by `-replace '\r?\n$'`: .NET's `$` matches before a final newline as well as
 * at the very end, so that pattern ate the whole trailing run and a secret that
 * legitimately ended in a blank line could not be stored.
 *
 * The terminator is matched as a string built from `[char]10` / `[char]13`
 * rather than as an escape, and cast to `[string]` explicitly because
 * `String.EndsWith(char)` does not exist in the .NET Framework that Windows
 * PowerShell 5.1 runs on — PowerShell would coerce it, and relying on that is
 * how the previous version of this line looked correct and was not. PowerShell escapes with a backtick, not a backslash, so `"\r\n"`
 * written here is the four literal characters and matches nothing — which is
 * exactly how it shipped once, passing every local check and failing only on a
 * real Windows runner. A backtick cannot appear in these scripts anyway: they
 * are JavaScript template literals, and it would end the string.
 */
// String.raw so the PowerShell regex escapes survive JavaScript's own escaping.
const DPAPI_SET = String.raw`
$ErrorActionPreference='Stop'
$in=[Console]::OpenStandardInput()
$ms=New-Object System.IO.MemoryStream
$in.CopyTo($ms)
$v=[Text.Encoding]::UTF8.GetString($ms.ToArray())
$lf=[string][char]10
$cr=[string][char]13
if($v.EndsWith($lf)){$v=$v.Substring(0,$v.Length-1); if($v.EndsWith($cr)){$v=$v.Substring(0,$v.Length-1)}}
$p=$env:ZELOS_SECRET_FILE
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $p) | Out-Null
$blob=ConvertFrom-SecureString -SecureString (ConvertTo-SecureString -String $v -AsPlainText -Force)
[System.IO.File]::WriteAllText($p,$blob)
`;

const DPAPI_GET = String.raw`
$ErrorActionPreference='Stop'
$p=$env:ZELOS_SECRET_FILE
if(-not (Test-Path -LiteralPath $p)){ exit ${NOT_FOUND_EXIT} }
$ss=ConvertTo-SecureString -String ([System.IO.File]::ReadAllText($p))
$b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss)
try{
  $bytes=[Text.Encoding]::UTF8.GetBytes([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b))
  $out=[Console]::OpenStandardOutput()
  $out.Write($bytes,0,$bytes.Length)
  $out.Flush()
}
finally{ [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
`;

/**
 * The single source of truth for every command line this module runs.
 *
 * It takes a backend name, an action and a ref — and **no value**. That is the
 * guarantee: a secret cannot end up in argv because the code that builds argv
 * never receives one. Returns null when the action needs no subprocess.
 *
 * `stdinWrites` is how many times the value must be written, newline-terminated:
 * macOS `security` prompts "password data for new item:" *and* "retype password
 * for new item:", and on a mismatch it silently stores an EMPTY password.
 *
 * `stderrSafe:false` means the command prints the secret on stderr (macOS
 * `find-generic-password -g` does), so that stream must never reach a log or an
 * error message.
 */
export function describeCommand({ name, action, ref, legacy = false }) {
  if (!isValidRef(ref)) throw new TypeError(`secrets: invalid ref ${JSON.stringify(ref)}`);
  if (!BACKEND_NAMES.includes(name)) throw new TypeError(`secrets: unknown backend ${name}`);
  const account = name === 'encrypted-file' || legacy ? ref : `${scopedId()}.${ref}`;

  if (name === 'macos-keychain') {
    switch (action) {
      case 'set':
        return { file: '/usr/bin/security', args: ['add-generic-password', '-U', '-s', SERVICE, '-a', account, '-w'], stdinWrites: 2, stderrSafe: true };
      case 'get':
        // -g prints "password: <value>" (or "password: 0x<hex>") on STDERR.
        return { file: '/usr/bin/security', args: ['find-generic-password', '-g', '-s', SERVICE, '-a', account], stdinWrites: 0, stderrSafe: false };
      case 'has':
        return { file: '/usr/bin/security', args: ['find-generic-password', '-s', SERVICE, '-a', account], stdinWrites: 0, stderrSafe: true };
      case 'delete':
        return { file: '/usr/bin/security', args: ['delete-generic-password', '-s', SERVICE, '-a', account], stdinWrites: 0, stderrSafe: true };
      default:
        throw new TypeError(`secrets: unknown action ${action}`);
    }
  }

  if (name === 'windows-dpapi') {
    const env = { ZELOS_SECRET_FILE: dpapiFile(ref, legacy) };
    const ps = (script) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', psEncoded(script)];
    switch (action) {
      case 'set':
        return { file: 'powershell.exe', args: ps(DPAPI_SET), env, stdinWrites: 1, stderrSafe: true };
      case 'get':
        return { file: 'powershell.exe', args: ps(DPAPI_GET), env, stdinWrites: 0, stderrSafe: true };
      case 'has':
      case 'delete':
        return null; // plain file existence / unlink
      default:
        throw new TypeError(`secrets: unknown action ${action}`);
    }
  }

  if (name === 'libsecret') {
    switch (action) {
      case 'set':
        return { file: 'secret-tool', args: ['store', '--label=Zelos', 'service', SERVICE, 'account', account], stdinWrites: 1, stderrSafe: true };
      case 'get':
      case 'has':
        return { file: 'secret-tool', args: ['lookup', 'service', SERVICE, 'account', account], stdinWrites: 0, stderrSafe: true };
      case 'delete':
        return { file: 'secret-tool', args: ['clear', 'service', SERVICE, 'account', account], stdinWrites: 0, stderrSafe: true };
      default:
        throw new TypeError(`secrets: unknown action ${action}`);
    }
  }

  return null; // encrypted-file is pure JS
}

function dpapiFile(ref, legacy = false, base = process.env.LOCALAPPDATA || path.join(paths().home, 'dpapi')) {
  return path.join(base, 'Zelos', 'secrets', ...(legacy ? [] : [scopedId()]), `${ref}.dpapi`);
}

/**
 * Whether a missing DPAPI blob directory can be believed. dpapiFile() falls
 * back to the Zelos home when %LOCALAPPDATA% is unset, and a variable that
 * names a folder which does not exist is just as clearly not this account's
 * real profile — in both cases Zelos is looking in the wrong place, and
 * nothing it finds missing there says anything about the keys. A
 * %LOCALAPPDATA% that is set and exists is this account's own store, so a
 * home whose blobs are not in it was brought here from somewhere else.
 */
function dpapiAddressAuthoritative() {
  const base = process.env.LOCALAPPDATA;
  return Boolean(base) && fs.existsSync(base);
}

/* ------------------------------------------------------------- detection */

let cachedBackend = null;
let cachedKey = null;

function detectionKey() {
  return `${process.platform}|${process.env.ZELOS_SECRETS_BACKEND || ''}|${paths().home}`;
}

/* A probe that did not answer is not a probe that said "no".
 *
 * This is measurement (2) at the top of the file, and it is the dangerous half
 * of the timeout. Every probe below used to answer `false` for any failure at
 * all, `probeBackend` reads `false` as "this store is not on this machine", and
 * the fallback is encrypted-file. So one slow `powershell.exe` and `listRefs()`
 * reported an empty store after 15_020 ms — not "I could not ask", but "you
 * have no credentials".
 *
 * So two outcomes that used to be one are now separated:
 *
 *  - the spawn was REFUSED. ENOENT or EACCES: the tool is not on this machine,
 *    or cannot be executed. That is a real answer, it costs microseconds, and
 *    it is the answer that should send a home to the encrypted file.
 *  - the spawn SUCCEEDED and the tool did not finish, twice. By construction
 *    the tool exists and started, so absence is the one thing this cannot mean.
 *    It is read as "the store is there and this machine is busy".
 *
 * The record below already protects any home that has successfully stored
 * something. The home this protects is the one that has not: on a fresh
 * install, a probe timeout used to put the FIRST credential a Windows user ever
 * typed into secrets.enc, `recordBackend` pinned the home there, and
 * docs/SECURITY.md and the note in the UI went on saying their operating system
 * was holding it.
 *
 * Being wrong in this direction is loud and recoverable: the next getSecret
 * throws "could not read model.default from windows-dpapi", which is exactly
 * the outcome the record's own comment asks for. Being wrong in the other
 * direction is silent and permanent.
 */
function probeUnanswered(name, err) {
  if (err?.timedOut !== true) return false;
  log.warn(`secrets: ${name} did not answer a liveness probe within ${budgets.probe}ms, twice — treating the store as present, `
    + 'because a spawn that started is not a store that is missing, and falling back would put this home\'s '
    + 'credentials somewhere the documentation says they are not');
  return true;
}

async function probeMacKeychain() {
  try {
    fs.accessSync('/usr/bin/security', fs.constants.X_OK);
  } catch {
    return false;
  }
  try {
    const { code } = await runWithRetry('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-a', 'zelos.probe'],
      { timeoutMs: budgets.probe, label: 'macos-keychain probe' });
    // 0 = an item is there, 44 = reachable and empty. Anything else means we
    // should not rely on it.
    //
    // This form omits -g, so it asks for attributes and never for the item's
    // data — the branch that prompts, and the branch a locked keychain refuses.
    // A locked keychain therefore probably answers 44 here and passes. An
    // earlier version of this comment named a locked keychain and a headless
    // session as the reasons for a non-zero exit; that was asserted rather than
    // measured, and settling it means running `security` against whatever login
    // keychain the machine has, which this module's tests are not allowed to
    // do. The honest half is narrow: a code other than 0 or 44 is an answer we
    // do not understand. The ways we know of to get one are a refused spawn and
    // a sandbox denial. A timeout used to be on that list and no longer belongs
    // there: it does not produce a code at all, and `probeUnanswered` reads it
    // for what it is.
    return code === 0 || code === NOT_FOUND_EXIT;
  } catch (err) {
    return probeUnanswered('macos-keychain', err);
  }
}

async function probePowershell() {
  try {
    const { code } = await runWithRetry('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'],
      { timeoutMs: budgets.probe, label: 'windows-dpapi probe' });
    return code === 0;
  } catch (err) {
    return probeUnanswered('windows-dpapi', err);
  }
}

async function probeSecretTool() {
  try {
    const { code, stderr } = await runWithRetry('secret-tool', ['lookup', 'service', SERVICE, 'account', 'zelos.probe'],
      { timeoutMs: budgets.probe, label: 'libsecret probe' });
    // Not-found is exit 1 with nothing on stderr. A missing keyring daemon
    // complains about D-Bus, and then storing would fail later instead of now.
    // That is a real answer and it still falls back — which is also why the
    // probe budget has to be long enough for secret-tool to GIVE it. A budget
    // so short that this branch could never be reached would pin a machine with
    // no keyring daemon to a keyring that cannot hold anything.
    if (/dbus|d-bus|cannot create|no such secret|failed/i.test(stderr)) return false;
    return code === 0 || code === 1;
  } catch (err) {
    return probeUnanswered('libsecret', err);
  }
}

async function probeBackend() {
  if (process.platform === 'darwin' && (await probeMacKeychain())) return 'macos-keychain';
  if (process.platform === 'win32' && (await probePowershell())) return 'windows-dpapi';
  if (process.platform === 'linux' && (await probeSecretTool())) return 'libsecret';
  return 'encrypted-file';
}

/* -------------------------------------------------- the backend on record
 * A probe is a guess about this instant, and it decided where every credential
 * for the rest of the process went — `backend()` caches under
 * `platform|env|home`, with no probe result in the key, so nothing could revise
 * it. One 8-second timeout, one spawn refused by a sandbox, one secret-tool
 * losing its race with the keyring daemon at session start, and a password
 * typed that afternoon landed in `secrets.enc` — a file the docs tell users is
 * "only present if your system has no keychain". The next launch probed
 * successfully, went back to the keychain, and read the OLD value out of it:
 * a rotated password silently ignored, authentication failing for a reason
 * nothing on screen could explain.
 *
 * So the store a home actually committed to is written down at the first
 * successful setSecret, and from then on the record beats the probe. A
 * disagreement now surfaces as a real error from the tool that is missing
 * ("could not read model.default from macos-keychain") instead of a quiet move
 * to a second store. Two deliberate exceptions:
 *
 *  - ZELOS_SECRETS_BACKEND still wins outright. That is a person saying it on
 *    purpose, and it is how the tests reach the fallback on a machine with a
 *    keychain. It does NOT move the record: `recordBackend` leaves a usable
 *    record alone, so a forced run over a home that has already committed puts
 *    the value somewhere a later unforced run will not look. That is the price
 *    of "the first store to hold a secret wins", and it is deliberate — an
 *    override is not evidence about where the rest of this home's credentials
 *    are. It is not left silent either: `core/doctor.mjs:405-414` reads this
 *    same record, notices the override, and says in as many words that
 *    anything saved while it is set lands elsewhere and will not be found
 *    without it. (An earlier version of this comment claimed the record *was*
 *    updated. It never was, and doctor's text was the honest one.)
 *  - A record naming a backend that cannot exist on this platform is ignored:
 *    that is a home copied from another machine, which is a migration rather
 *    than a flaky probe.
 */

function backendRecordFile() {
  return path.join(paths().home, 'secrets.backend.json');
}

/** Which platform each backend needs. null means "works anywhere". */
const BACKEND_PLATFORM = {
  'macos-keychain': 'darwin',
  'windows-dpapi': 'win32',
  libsecret: 'linux',
  'encrypted-file': null,
};

function readBackendRecord() {
  try {
    const parsed = JSON.parse(fs.readFileSync(backendRecordFile(), 'utf8'));
    return BACKEND_NAMES.includes(parsed?.backend) ? parsed.backend : null;
  } catch {
    return null;
  }
}

function usableHere(name) {
  const needs = BACKEND_PLATFORM[name];
  return needs === null || needs === process.platform;
}

/**
 * Called only after a value really landed somewhere. The first store to hold a
 * secret wins; later calls leave the record alone, because the whole point is
 * that it does not move under a home that has credentials in it. The one
 * rewrite is a record naming a backend this platform does not have — the home
 * has moved machines, and the old name is now unreachable.
 */
function recordBackend(name) {
  const recorded = readBackendRecord();
  if (recorded === name) return;
  if (recorded && usableHere(recorded)) return;
  try {
    writeFileAtomic(backendRecordFile(), `${JSON.stringify({ backend: name }, null, 2)}\n`, 0o600);
  } catch (err) {
    // Losing the record costs the protection above, not the secret that was
    // just stored — so this is a warning, not a failed write.
    log.warn('secrets: could not record which store this home uses', { error: err.message });
  }
}

/**
 * Reconcile a probe with the record. Exported for the same reason
 * `describeCommand` is: it is the whole of the decision, it is pure, and a test
 * can put every combination through it on any platform without going anywhere
 * near a real credential store — which no test of `detect()` itself can do.
 */
export function chooseBackend({ probed, recorded, platform = process.platform }) {
  if (!recorded || recorded === probed) return probed;
  const needs = BACKEND_PLATFORM[recorded];
  if (needs && needs !== platform) return probed;
  return recorded;
}

async function detect() {
  const forced = process.env.ZELOS_SECRETS_BACKEND;
  if (forced) {
    if (!BACKEND_NAMES.includes(forced)) throw new Error(`ZELOS_SECRETS_BACKEND must be one of ${BACKEND_NAMES.join(', ')}`);
    return forced;
  }
  const probed = await probeBackend();
  const recorded = readBackendRecord();
  const chosen = chooseBackend({ probed, recorded });
  if (recorded && recorded !== probed) {
    // Three distinct situations, and they must not share a sentence. The
    // record-wins case has two shapes, because `probeBackend` only ever names
    // encrypted-file as a *fallback*: if the record is an OS store then the
    // probe failed, and if the record is encrypted-file then the probe
    // succeeded and the OS store is back. Saying "it did not answer just now"
    // about encrypted-file — which is a file on disk and always answers — is
    // the opposite of what happened, and it is the more common of the two,
    // since it is what every home that ever fell back looks like from then on.
    let message;
    if (chosen !== recorded) {
      message = `secrets: this folder last used ${recorded}, which does not exist on ${process.platform} — using ${probed}, and anything held by ${recorded} will need re-entering`;
    } else if (recorded === 'encrypted-file') {
      message = `secrets: ${probed} is available again, but this folder's secrets are in secrets.enc — staying there, because a keychain this home has never written to would answer with stale items or nothing at all`;
    } else {
      message = `secrets: ${recorded} is where this folder's secrets were stored, but it did not answer just now — staying with it rather than starting a second store in ${probed}`;
    }
    log.warn(message, { recorded, probed, chosen });
  }
  return chosen;
}

/** -> {name, writable, note} */
export async function backend() {
  const key = detectionKey();
  if (cachedBackend && cachedKey === key) return cachedBackend;
  const name = await detect();
  let writable = true;
  try {
    fs.accessSync(paths().home, fs.constants.W_OK);
  } catch {
    writable = false;
  }
  cachedBackend = Object.freeze({ name, writable, note: NOTES[name] });
  cachedKey = key;
  return cachedBackend;
}

/** Testing seam: forget the probed backend so a changed environment is re-read. */
export function resetBackendCache() {
  cachedBackend = null;
  cachedKey = null;
}

/* --------------------------------------------------------------- the index
 * External keychains cannot be enumerated without prompting the user for
 * access to every item, so the refs Zelos has written are tracked in a small
 * index file. It holds refs and nothing else — never a value.
 */

function indexFile() {
  return path.join(paths().home, 'secrets.index.json');
}

function readIndex(strict = false) {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexFile(), 'utf8'));
    if (strict && (!Array.isArray(parsed?.refs) || !parsed.refs.every(isValidRef))) {
      throw new Error('invalid credential index');
    }
    const refs = Array.isArray(parsed?.refs) ? parsed.refs.filter(isValidRef) : [];
    return [...new Set(refs)].sort();
  } catch (err) {
    if (strict && err.code !== 'ENOENT') {
      throw new Error('secrets: credential index cannot be read; restore secrets.index.json before migrating this home');
    }
    return [];
  }
}

function writeIndex(refs) {
  const unique = [...new Set(refs.filter(isValidRef))].sort();
  writeFileAtomic(indexFile(), `${JSON.stringify({ refs: unique }, null, 2)}\n`, 0o600);
}

function rememberRef(ref) {
  const refs = readIndex();
  if (!refs.includes(ref)) writeIndex([...refs, ref]);
}

function forgetRef(ref) {
  const refs = readIndex();
  if (refs.includes(ref)) writeIndex(refs.filter((r) => r !== ref));
}

// Keep the namespace in the home so moving an existing setup keeps its keys,
// while independently created work/personal setups get different OS entries.
// Only refs already indexed by an older installation may read its unscoped
// entries until the next explicit save. Reads never write a migrated value:
// a concurrent process may be replacing/deleting that key while the OS reads.
// Never remove the shared legacy entry another older home may still need.
function namespaceFile() {
  return path.join(paths().home, 'secrets.namespace.json');
}

/**
 * This home's credential identity, read and never written. A home that has
 * not yet saved anything to an OS store has no identity, and `id` is null:
 * looking for a key — which is all `doctor`, `listRefs` and every read do —
 * must not be what gives it one, because the file it would write is part of
 * the home and a backup or a copy carries it along. Its `legacyRefs` are then
 * the ones ensureNamespace() would record, so reads see the same thing either
 * way.
 */
function readNamespace() {
  let raw;
  try {
    raw = fs.readFileSync(namespaceFile(), 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return { version: 1, id: null, legacyRefs: readIndex(true) };
  }
  let record;
  try { record = JSON.parse(raw); } catch { /* fail without replacing the identity */ }
  if (record?.version !== 1 || !/^[0-9a-f]{32}$/.test(record.id) || !Array.isArray(record.legacyRefs)
      || !record.legacyRefs.every(isValidRef)) {
    throw new Error('secrets: credential namespace is damaged; restore secrets.namespace.json from this home\'s backup');
  }
  return record;
}

/**
 * The identity, created if this home has none. Only a save and the deletion
 * of a pre-upgrade key call this, because only they have to record anything:
 * the save writes under the identity, and the deletion writes a marker that
 * stops the older unscoped key coming back.
 */
export function ensureNamespace() {
  const file = namespaceFile();
  const existing = readNamespace();
  if (existing.id !== null) return existing;
  const fresh = { version: 1, id: crypto.randomBytes(16).toString('hex'), legacyRefs: existing.legacyRefs };
  const text = `${JSON.stringify(fresh, null, 2)}\n`;
  // Written whole beside the real name, then linked into place: a link either
  // creates the file complete or fails because another process got there
  // first. Opening the real name and then writing it left a moment where a
  // reader, or the writer that lost, saw an empty file and called it damaged.
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    try {
      fs.linkSync(temp, file);
      return fresh;
    } catch (linkError) {
      if (linkError.code === 'EEXIST') return readNamespace();
      // Some filesystems have no hard links; there the old exclusive create
      // is the best available, narrow window and all.
      if (linkError.code !== 'EPERM' && linkError.code !== 'ENOTSUP' && linkError.code !== 'ENOSYS') throw linkError;
    }
  } finally {
    fs.rmSync(temp, { force: true });
  }
  let fd;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } catch (writeError) {
    if (writeError.code === 'EEXIST') return readNamespace();
    throw writeError;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return fresh;
}

/* An OS store address under this home's identity. Every reader checks for a
   null id before it gets here, so reaching this without one is a missed check,
   and failing loudly beats inventing an address nothing was ever saved to. */
function scopedId() {
  const { id } = readNamespace();
  if (id === null) throw new Error('secrets: this home has no credential identity yet, so it has no scoped address');
  return id;
}

function hasLegacyRef(ref) {
  const record = readNamespace();
  if (!record.legacyRefs.includes(ref)) return false;
  // Markers are written under the identity, so a home without one has none.
  return record.id === null || !fs.existsSync(legacyMarker(record, ref));
}

function legacyMarker(record, ref) {
  // A tripwire, like scopedId(): every caller has already checked for a null id.
  if (record.id === null) throw new Error('secrets: this home has no credential identity yet, so it has no migration markers');
  return path.join(paths().home, 'secrets.migrated', `${record.id}.${ref}`);
}

function forgetLegacyRef(ref) {
  const record = readNamespace();
  if (!record.legacyRefs.includes(ref)) return;
  const file = legacyMarker(record, ref);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Monotonic per-ref markers cannot lose another process's update to a shared
  // array. In particular a removed scoped key must never revive a legacy one.
  writeFileAtomic(file, '', 0o600);
}

/* ------------------------------------------------- encrypted-file backend */

const AAD = Buffer.from('zelos.secrets.v1');
const SCRYPT = { N: 2 ** 15, r: 8, p: 1 };
const keyCache = new Map();

function seedFile() {
  return path.join(paths().home, '.seed');
}

function storeFile() {
  return path.join(paths().home, 'secrets.enc');
}

/**
 * Move a file out of the way instead of writing over it.
 *
 * `writeFileAtomic()` renames the replacement into place, so the bytes that
 * were there are unlinked the instant it returns. That is fine for a config
 * file and fatal for a key: the old `machineSeed()` minted and wrote a
 * replacement as a side effect of being *asked to read* `.seed`, and the
 * ciphertext was then set aside three lines later under the comment "if the
 * seed turns up, it is still recoverable" — with the seed it needed already
 * destroyed. A rename costs nothing and keeps both halves on disk.
 *
 * Callers pass a shared stamp so a seed and the store it keys land as
 * `.seed.unreadable-1754800000000` / `secrets.enc.unreadable-1754800000000` and
 * are obviously a pair to whoever has to put them back together.
 */
function setAside(file, stamp) {
  const aside = `${file}.unreadable-${stamp}`;
  try {
    fs.renameSync(file, aside);
    return aside;
  } catch {
    return null; // nothing more we can do
  }
}

/**
 * The seed if there is a usable one, and NOTHING written either way.
 *
 * Reading is split from minting because the two used to be the same function,
 * and every caller that only wanted to look — `getSecret()`, which the
 * background sweep and `zelos doctor` both call — could destroy the key. The
 * damage needed no deliberate act: a sync client appending a conflict line, a
 * stray leading byte, a duplicated line, a truncation of a few characters.
 * All of those leave the original 64 hex characters sitting on disk, and all of
 * them used to be answered by overwriting them.
 *
 * `state` is 'ok' | 'absent' | 'malformed'. Nothing tries to salvage a seed out
 * of a malformed file: a file holding two different 64-hex tokens would have us
 * guessing which one keys the store, and guessing wrong writes a fresh store
 * over a recoverable one. The file is kept instead, so a person can pick the
 * right characters out of it by hand — which is exactly how the audit that
 * found this recovered a secret it had proved was still intact.
 */
function readSeed() {
  const file = seedFile();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { seed: null, state: 'absent' };
    throw err;
  }
  const hex = text.trim();
  if (/^[0-9a-f]{64}$/.test(hex)) return { seed: Buffer.from(hex, 'hex'), state: 'ok' };
  return { seed: null, state: 'malformed' };
}

/**
 * 32 random bytes, generated once per machine, mode 0600 — minted only when
 * there is nothing a new seed would strand.
 *
 * Anything still on disk that the new seed cannot open is moved aside first,
 * under one shared timestamp. In practice `readEncryptedStore()` has already
 * done that by the time a write gets here; the check stays because it is the
 * invariant that makes minting safe at all, and a future caller that reaches
 * this without reading first must not be the one that breaks it.
 */
function ensureSeed() {
  const { seed, state } = readSeed();
  if (seed) return seed;

  const stamp = Date.now();
  const asideSeed = state === 'malformed' ? setAside(seedFile(), stamp) : null;
  const asideStore = fs.existsSync(storeFile()) ? setAside(storeFile(), stamp) : null;
  if (asideSeed || asideStore) {
    log.warn('secrets: no usable .seed, so a new one was generated — anything it could not open was moved aside and those secrets must be re-entered',
      { seed: asideSeed, store: asideStore });
  }
  const fresh = crypto.randomBytes(32);
  writeFileAtomic(seedFile(), `${fresh.toString('hex')}\n`, 0o600);
  return fresh;
}

function deriveKey(seed, saltHex) {
  // Keyed on the seed's contents, not its path: a rotated or lost seed must
  // miss the cache, or a stale key would "decrypt" a file it no longer owns.
  const cacheKey = `${crypto.createHash('sha256').update(seed).digest('hex')}|${saltHex}`;
  const hit = keyCache.get(cacheKey);
  if (hit) return hit;
  const key = crypto.scryptSync(seed, Buffer.from(saltHex, 'hex'), 32, {
    ...SCRYPT,
    // 128 * N * r bytes is scrypt's working set; the default 32MB cap is below
    // what N=2^15 needs, so it has to be raised or scryptSync throws.
    maxmem: 256 * SCRYPT.N * SCRYPT.r,
  });
  keyCache.set(cacheKey, key);
  return key;
}

function readEncryptedStore() {
  const file = storeFile();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  // Reading never mints. There is ciphertext in front of us, so a seed created
  // here would be a seed created *for a store it cannot open* — and the write
  // that created it would take the real key with it.
  const { seed, state } = readSeed();
  if (!seed) {
    const stamp = Date.now();
    const asideSeed = state === 'malformed' ? setAside(seedFile(), stamp) : null;
    const asideStore = setAside(file, stamp);
    log.error(state === 'malformed'
      ? 'secrets: .seed is damaged, so the encrypted store cannot be opened; both were moved aside under one timestamp and are recoverable together if the 64 hex characters can be salvaged. Secrets must be re-entered.'
      : 'secrets: .seed is missing, so the encrypted store cannot be opened; the ciphertext was moved aside. Secrets must be re-entered.',
      { seed: asideSeed, store: asideStore });
    return {};
  }

  try {
    const env = JSON.parse(raw);
    const key = deriveKey(seed, env.kdf.salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'hex'));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(env.tag, 'hex'));
    const plain = Buffer.concat([decipher.update(Buffer.from(env.ct, 'base64')), decipher.final()]);
    const parsed = JSON.parse(plain.toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    // A well-formed seed that is the wrong one, or a damaged file. Keep the
    // ciphertext — if the right seed turns up, it is still recoverable — and
    // keep the seed on disk too: it is valid, it is what the next store will be
    // keyed by, and it costs nothing to leave where it is.
    const aside = setAside(file, Date.now());
    log.error('secrets: encrypted store could not be decrypted; moved aside, secrets must be re-entered', { aside, error: err.message });
    return {};
  }
}

function writeEncryptedStore(store) {
  const salt = crypto.randomBytes(16);
  const key = deriveKey(ensureSeed(), salt.toString('hex'));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(store), 'utf8')), cipher.final()]);
  const envelope = {
    v: 1,
    kdf: { name: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, len: 32, salt: salt.toString('hex') },
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    ct: ct.toString('base64'),
  };
  writeFileAtomic(storeFile(), `${JSON.stringify(envelope)}\n`, 0o600);
}

/* --------------------------------------------------------------- the API */

function assertRef(ref) {
  if (!isValidRef(ref)) throw new TypeError(`secrets: invalid ref ${JSON.stringify(ref)}`);
}

function assertValue(name, value) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('secrets: value must be a non-empty string');
  if (value.includes('\0')) throw new TypeError('secrets: value must not contain a NUL byte');
  if ((name === 'macos-keychain' || name === 'libsecret') && /[\r\n]/.test(value)) {
    // Both tools read the value as a line from stdin; a newline would truncate it.
    throw new TypeError(`secrets: the ${name} backend cannot store a value containing a line break`);
  }
}

function stdinFor(desc, value) {
  if (!desc.stdinWrites) return null;
  return `${value}\n`.repeat(desc.stdinWrites);
}

// Keep an application's reads and edits ordered. Legacy fallback reads are
// read-only, so another process cannot turn one into a late migration write.
const secretOperations = new Map();
function withSecretLock(ref, operation) {
  const key = `${paths().home}\0${ref}`;
  const previous = secretOperations.get(key) ?? Promise.resolve();
  const result = previous.then(operation);
  const tail = result.then(() => {}, () => {});
  secretOperations.set(key, tail);
  return result.finally(() => {
    if (secretOperations.get(key) === tail) secretOperations.delete(key);
  });
}

export async function setSecret(ref, value) {
  assertRef(ref);
  bumpGeneration(ref);
  try {
    return await withSecretLock(ref, () => writeSecret(ref, value));
  } finally {
    // Again at the end, and even on a throw: a write that failed half way may
    // still have changed the store, and an answer remembered from before it
    // must not outlive it.
    bumpGeneration(ref);
  }
}

async function writeSecret(ref, value) {
  const { name } = await backend();
  assertValue(name, value);

  // Each path records the backend only after the value is really in it: the
  // record exists to say "this home's credentials are HERE", and a failed write
  // has not put anything anywhere.
  if (name === 'encrypted-file') {
    const store = readEncryptedStore();
    store[ref] = value;
    writeEncryptedStore(store);
    recordBackend(name);
    return { ok: true, backend: name };
  }

  ensureNamespace();
  if (name === 'windows-dpapi') {
    const desc = describeCommand({ name, action: 'set', ref });
    const { code, stderr } = await runWithRetry(desc.file, desc.args,
      { input: stdinFor(desc, value), env: desc.env, timeoutMs: budgets.access, label: `windows-dpapi set ${ref}` });
    if (code !== 0) throw new Error(`secrets: DPAPI write failed for ${ref} (exit ${code}) ${stderr.trim()}`);
    rememberRef(ref);
    recordBackend(name);
    forgetLegacyRef(ref);
    return { ok: true, backend: name };
  }

  const desc = describeCommand({ name, action: 'set', ref });
  const { code, stderr } = await runWithRetry(desc.file, desc.args,
    { input: stdinFor(desc, value), timeoutMs: budgets.access, label: `${name} set ${ref}` });
  if (code !== 0) throw new Error(`secrets: ${desc.file} failed for ${ref} (exit ${code}) ${stderr.trim()}`);
  if (/passwords don't match/i.test(stderr)) {
    // security "succeeds" with exit 0 here and stores an empty password.
    throw new Error(`secrets: keychain rejected the value for ${ref} (prompt mismatch); nothing usable was stored`);
  }
  rememberRef(ref);
  recordBackend(name);
  forgetLegacyRef(ref);
  return { ok: true, backend: name };
}

/**
 * `security find-generic-password -g` writes one of:
 *    password: "plain ascii value"
 *    password: 0x636166C3A9  "caf\303\251"
 * The hex form is used whenever the value is not printable ASCII (which includes
 * any value containing a quote or a backslash), so the two forms never collide
 * and the quoted form can be taken literally.
 */
function parseKeychainPassword(stderr) {
  const m = /^password: (?:0x([0-9A-Fa-f]+)\s+)?"([\s\S]*)"\s*$/m.exec(stderr);
  if (!m) return null;
  if (m[1]) return Buffer.from(m[1], 'hex').toString('utf8');
  return m[2];
}

export async function getSecret(ref) {
  assertRef(ref);
  return withSecretLock(ref, () => readSecret(ref));
}

async function readSecret(ref) {
  const { name } = await backend();

  if (name === 'encrypted-file') {
    const store = readEncryptedStore();
    return Object.hasOwn(store, ref) ? store[ref] : null;
  }

  const value = await readExternalSecret(name, ref);
  if (value !== null || !hasLegacyRef(ref)) return value;
  const previous = await readExternalSecret(name, ref, true);
  return previous;
}

async function readExternalSecret(name, ref, legacy = false) {
  // Nothing has ever been saved under an identity this home does not have.
  if (!legacy && readNamespace().id === null) return null;
  // DPAPI's "not found" is a missing file, which Node can see without paying
  // for a PowerShell start. The script makes the same check and exits
  // NOT_FOUND_EXIT, so this changes how long the answer takes, not what it is.
  if (name === 'windows-dpapi') {
    try {
      fs.statSync(dpapiFile(ref, legacy));
    } catch (err) {
      // Only "there is no such file" is the script's not-found. A file Node
      // may not look at is PowerShell's to report, as it always was.
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    }
  }
  const desc = describeCommand({ name, action: 'get', ref, legacy });
  const { code, stdout, stderr } = await runWithRetry(desc.file, desc.args,
    { env: desc.env, timeoutMs: budgets.access, label: `${name} get ${ref}` });
  if (code === NOT_FOUND_EXIT) return null;
  if (name === 'libsecret' && code === 1) {
    /* secret-tool spends exit 1 on both "no such item" and "the keyring did not
       answer", and this read used to take either as "there is no password for
       this account". `hasSecret` below has always told them apart by reading
       stderr — not-found is exit 1 with nothing printed — and the same test
       belongs here, because this is the conflation with the worse consequence:
       an unanswered `has` leaves a ref in the index, while an unanswered `get`
       hands the caller a null it will act on. Every caller of getSecret already
       handles a throw; none of them can tell a wrong null from a right one.

       The complaint itself is not quoted. secret-tool puts the value on stdout,
       so its stderr is not carrying one, but this module's rule for a `get` is
       that its stderr never reaches a message — on macOS it IS the value. */
    if (!stderr.trim()) return null;
    throw new Error(`secrets: could not read ${ref} from libsecret — secret-tool exited 1 and complained on stderr, `
      + 'which is how it reports a keyring it could not reach, not how it reports an item that is not there');
  }
  if (code !== 0) {
    // stderr may carry the value itself on macOS — never include it.
    throw new Error(`secrets: could not read ${ref} from ${name} (exit ${code})`);
  }
  if (name === 'macos-keychain') return parseKeychainPassword(stderr);
  if (name === 'libsecret') return stdout.replace(/\n$/, '');
  return stdout;
}

export async function deleteSecret(ref) {
  assertRef(ref);
  bumpGeneration(ref);
  try {
    return await withSecretLock(ref, () => removeSecret(ref));
  } finally {
    bumpGeneration(ref);
  }
}

/* ------------------------------------------------------ change detection
 * For a caller that remembers something about a stored value — the AI token
 * check keeps a digest, so that each MCP request on Windows does not start
 * PowerShell — and has to know when to stop believing it. Two signals, and
 * neither reveals anything about the value:
 *
 *  - a per-(home, ref) generation, bumped by every setSecret and deleteSecret
 *    in this process, before the write and again after it;
 *  - for the stores that are plain files, the file's own stamp, which also
 *    moves when another process or another tool changes it. DPAPI stamps both
 *    the scoped blob and the older unscoped one, because a read can come from
 *    either and a save to the scoped one changes which one it comes from.
 *
 * The OS keychains offer no stamp that does not cost a spawn, so a change made
 * to them outside this process is bounded only by the caller's own expiry.
 */
const writeGenerations = new Map();

function generationKey(ref) {
  return `${paths().home}\0${ref}`;
}

function bumpGeneration(ref) {
  const key = generationKey(ref);
  writeGenerations.set(key, (writeGenerations.get(key) ?? 0) + 1);
}

function fileStamp(file) {
  try {
    const stat = fs.statSync(file, { bigint: true });
    return `${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`;
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return 'absent';
    throw err;
  }
}

/** -> {gen, stamp}. Equal answers before and after mean nothing Zelos can see has changed. */
export async function secretVersion(ref) {
  assertRef(ref);
  const { name } = await backend();
  const gen = writeGenerations.get(generationKey(ref)) ?? 0;
  let stamp = null;
  if (name === 'windows-dpapi') {
    const scoped = readNamespace().id === null ? 'unsaved' : fileStamp(dpapiFile(ref));
    stamp = `${scoped}|${hasLegacyRef(ref) ? fileStamp(dpapiFile(ref, true)) : 'no-legacy'}`;
  } else if (name === 'encrypted-file') {
    stamp = fileStamp(storeFile());
  }
  return { gen, stamp };
}

async function removeSecret(ref) {
  const { name } = await backend();

  if (name === 'encrypted-file') {
    const store = readEncryptedStore();
    const existed = Object.hasOwn(store, ref);
    if (existed) {
      delete store[ref];
      writeEncryptedStore(store);
    }
    return { ok: true, deleted: existed };
  }

  const legacy = hasLegacyRef(ref);
  // A pre-upgrade key needs its marker, and the marker needs an identity. Any
  // other key in a home without one was never saved, so there is nothing to
  // ask the OS store to remove.
  if (legacy) ensureNamespace();
  else if (readNamespace().id === null) {
    forgetRef(ref);
    return { ok: true, deleted: false };
  }

  if (name === 'windows-dpapi') {
    let deleted = true;
    try {
      fs.unlinkSync(dpapiFile(ref));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      deleted = legacy;
    }
    forgetLegacyRef(ref);
    forgetRef(ref);
    return { ok: true, deleted };
  }

  const desc = describeCommand({ name, action: 'delete', ref });
  const { code, stderr } = await runWithRetry(desc.file, desc.args,
    { timeoutMs: budgets.access, label: `${name} delete ${ref}` });
  const missing = code === NOT_FOUND_EXIT || (name === 'libsecret' && code === 1 && !stderr.trim());
  if (code !== 0 && !missing) throw new Error(`secrets: could not delete ${ref} from ${name} (exit ${code}) ${stderr.trim()}`);
  forgetLegacyRef(ref);
  forgetRef(ref);
  return { ok: true, deleted: !missing || legacy };
}

/**
 * Three answers, not two: 'yes', 'no', and 'unknown' for a probe that could not
 * be run or would not say.
 *
 * The boolean version could not tell "the user deleted it" from "the keyring
 * did not answer", and `listRefs()` wrote the shrunken list back — so one
 * locked keyring, one unlock prompt answered slower than the 15-second timeout,
 * one D-Bus hiccup, and `secrets.index.json` was permanently emptied. The
 * values themselves survived in the keychain, which is what made it so quiet:
 * mail kept syncing, while Ask started answering "no model is configured yet"
 * and Settings showed placeholders until every password was re-entered.
 *
 * DPAPI has a fourth, 'absent-here': the store answered, and this home's keys
 * are not in it because they were saved on another computer, or by another
 * user account on this one. See below.
 */
async function hasSecret(name, ref, legacy = false) {
  // A home with no identity yet has saved nothing scoped: no blob, no folder.
  const unsaved = !legacy && readNamespace().id === null;
  if (name === 'windows-dpapi') {
    const blob = unsaved ? null : dpapiFile(ref, legacy);
    if (blob !== null && fs.existsSync(blob)) return 'yes';
    const ownFolder = blob !== null && fs.existsSync(path.dirname(blob));
    if (!legacy && hasLegacyRef(ref)) {
      const old = await hasSecret(name, ref, true);
      // The older store is shared by every home on this account, so it can
      // exist while this home has never stored anything here. Its 'no' proves
      // a deletion only when this home's own folder is here too; otherwise
      // the rules below decide, as they would for a key with no older copy.
      if (old !== 'no' || ownFolder) return old;
    } else if (unsaved) {
      return 'no';
    }
    // The blob lives under %LOCALAPPDATA%, and dpapiFile() falls back to the
    // Zelos home when that variable is missing — so a relaunch without it looks
    // in a directory Zelos has never written to, where every ref reads as
    // deleted. A missing directory is not an empty store; it is the wrong
    // address.
    if (ownFolder) return 'no';
    if (!dpapiAddressAuthoritative()) return 'unknown';
    // The right address, and this home has never stored anything there: the
    // home was restored from another computer or user account, whose DPAPI keys
    // cannot decrypt here even if the blobs had come along. That is not 'no'
    // — pointing %LOCALAPPDATA% back at the right profile, or saving the key
    // again, should find the ref still indexed — so listRefs() hides it
    // without pruning it. One exception: blobs written on an earlier launch
    // without %LOCALAPPDATA% sit in the home's own fallback folder, and those
    // keys are this account's, so they stay 'unknown' rather than vanish.
    if (blob !== null && fs.existsSync(path.dirname(dpapiFile(ref, legacy, path.join(paths().home, 'dpapi'))))) return 'unknown';
    return 'absent-here';
  }

  if (unsaved) return hasLegacyRef(ref) ? hasSecret(name, ref, true) : 'no';

  const desc = describeCommand({ name, action: 'has', ref, legacy });
  try {
    // The short budget, and see TIMEOUTS_MS for why: this question's "I could
    // not tell" is safe, and it is asked once per credential on a path a UI
    // request is waiting on.
    const { code, stderr } = await runWithRetry(desc.file, desc.args,
      { env: desc.env, timeoutMs: budgets.probe, label: `${name} has ${ref}` });
    if (code === 0) return 'yes';
    if (name === 'libsecret' && code === 1) {
      // secret-tool spends exit 1 on both "no such item" and "the keyring did
      // not answer" — probeSecretTool() above already knows this and reads
      // stderr to tell them apart. Not-found is exit 1 with nothing on stderr,
      // so anything printed there means we could not ask.
      if (stderr.trim()) return 'unknown';
      return !legacy && hasLegacyRef(ref) ? hasSecret(name, ref, true) : 'no';
    }
    if (code === NOT_FOUND_EXIT) return !legacy && hasLegacyRef(ref) ? hasSecret(name, ref, true) : 'no';
    return 'unknown';
  } catch {
    // Spawn refused, or the tool was SIGKILLed at the access budget on both
    // attempts. Both mean the question was never answered, which is the one
    // thing this must not report as an answer.
    return 'unknown';
  }
}

/**
 * Refs only — this module exposes no way to enumerate values, and the HTTP layer
 * has no read route at all.
 */
export async function listRefs() {
  const { name } = await backend();
  if (name === 'encrypted-file') return Object.keys(readEncryptedStore()).sort();

  const known = readIndex();
  const alive = [];
  const removed = new Set();
  let answered = true;
  for (const ref of known) {
    /* Once one ref has gone unanswered the store is not answering, and asking
       about the rest cannot change what this function DOES: the index is
       already un-prunable for this pass, and a ref nobody has said is gone
       stays in the list either way. What it can change is how long the caller
       waits, and with the budgets at the top of this file that is 12.5 s per
       remaining ref. A home with five credentials on a keyring that has stopped
       answering used to spend a minute here — every sweep cycle, and on every
       `GET /api/health` — to arrive at the list it already had. */
    const state = answered ? await hasSecret(name, ref) : 'unknown';
    // A ref we could not ask about stays in the list. Zelos wrote it, nothing
    // has said it is gone, and the caller's next getSecret() will find out for
    // real — whereas dropping it turns a five-second keyring stall into a UI
    // that says the account was never set up.
    // 'absent-here' is a DPAPI home whose keys are on another computer: an
    // answer, so the rest are still asked about, but not one the UI should
    // show as saved, and not a deletion either.
    if (state === 'yes' || state === 'unknown') alive.push(ref);
    if (state === 'no') removed.add(ref);
    if (state === 'unknown') answered = false;
  }
  // Something deleted outside Zelos (Keychain Access, say) should not linger —
  // but only prune when every probe actually answered. Pruning on a partial
  // answer is what made a transient failure permanent: the index is the only
  // record that a keychain item is ours, and there is no way to rebuild it.
  if (answered && removed.size > 0) {
    // A credential may have been saved while the OS answered these probes.
    // Remove only the refs this pass actually proved absent.
    writeIndex(readIndex().filter((ref) => !removed.has(ref)));
  }
  return alive;
}

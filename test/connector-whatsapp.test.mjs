/**
 * test/connector-whatsapp.test.mjs — the export parser, across the shapes a
 * real person's file actually has.
 *
 * There is no WhatsApp API to test against and that is the point of the
 * connector: the Business Cloud API has no read endpoint, and the libraries
 * that read a personal account risk the account. What this reads is a file the
 * user exported themselves, so the whole risk surface is the parser, and the
 * parser's whole risk is that "the WhatsApp export format" is not one format.
 *
 * It differs by platform (iOS brackets the timestamp, Android does not), by
 * clock (12h with AM/PM, or 24h), by date order (d/m/y nearly everywhere,
 * m/d/y in the US), by separator, and by digit set. A parser written against
 * one locale works for the person who wrote it and silently drops everybody
 * else's messages — silently, because an unparsed line looks exactly like a
 * continuation of the previous one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const whatsappModule = await import('../core/connectors/whatsapp.mjs');
const {
  parseExport, parseHeader, classifyBody, resolveOwner, rowFor, normalizeDigits,
} = whatsappModule;
const whatsapp = whatsappModule.default;

/* ------------------------------------------------------------------ *
 * The platform and locale matrix
 * ------------------------------------------------------------------ */

test('every platform and clock shape a real export uses is parsed, not swallowed', () => {
  const shapes = [
    {
      name: 'iOS, 24h, bracketed',
      text: '[09/08/2026, 14:02:11] Kit Alder: Retainage schedule is posted',
    },
    {
      name: 'iOS, 12h, bracketed',
      text: '[09/08/2026, 2:02:11 PM] Kit Alder: Retainage schedule is posted',
    },
    {
      name: 'Android, 24h, dash',
      text: '09/08/2026, 14:02 - Kit Alder: Retainage schedule is posted',
    },
    {
      name: 'Android, 12h, dash',
      text: '09/08/2026, 2:02 pm - Kit Alder: Retainage schedule is posted',
    },
  ];

  for (const shape of shapes) {
    const header = parseHeader(shape.text);
    assert.ok(header, `${shape.name}: the header did not parse, so this whole export reads as one run-on message`);
    const parsed = parseExport(shape.text, { timezone: 'UTC' });
    assert.equal(parsed.messages.length, 1, `${shape.name}: message lost`);
    assert.equal(parsed.messages[0].sender, 'Kit Alder', `${shape.name}: sender lost`);
    assert.match(parsed.messages[0].text, /Retainage schedule is posted/, `${shape.name}: body lost`);
  }
});

test('an unambiguous day disambiguates the date order for the whole file', () => {
  /* `09/08/2026` is a real date under both readings, so no single line can
     settle it — but `13/08/2026` can only be d/m/y, and one such line anywhere
     in the file settles every other line in it. Getting this wrong moves every
     message in the export by up to eleven months, which puts a conversation
     from last week outside the sweep window and onto no board at all. */
  const dmy = [
    '[13/08/2026, 09:00:00] Kit Alder: the thirteenth is not a month',
    '[09/08/2026, 09:01:00] Kit Alder: so this one is the ninth of August',
  ].join('\n');

  const parsed = parseExport(dmy, { timezone: 'UTC' });
  assert.equal(parsed.order, 'dmy', 'a day over twelve did not settle the order');
  assert.match(parsed.messages[1].iso, /^2026-08-09/, 'the ambiguous line was read in the wrong order');

  // And the override beats the heuristic, because a file with no unambiguous
  // day in it is genuinely undecidable from its content alone.
  const forced = parseExport('[09/08/2026, 09:00:00] Kit Alder: hello', { timezone: 'UTC', order: 'dmy' });
  assert.match(forced.messages[0].iso, /^2026-08-09/, 'the explicit order was ignored');
});

test('a message that wraps is one message, not one per line', () => {
  const wrapped = [
    '[09/08/2026, 14:04:00] Kit Alder: It spans',
    'two lines',
    'and a third',
    '[09/08/2026, 14:05:00] Nemo Hale: Understood',
  ].join('\n');

  const parsed = parseExport(wrapped, { timezone: 'UTC', order: 'dmy' });
  assert.equal(parsed.messages.length, 2, 'a wrapped message was split, or a real one was eaten');
  assert.match(parsed.messages[0].text, /It spans\ntwo lines\nand a third/,
    'the continuation lines did not join the message they belong to');
});

test('system lines are counted, never filed as somebody saying something', () => {
  /* These carry no sender and are not obligations. Filing the encryption
     notice as a message from a person is how a board grows an item nobody
     wrote and nobody can action. */
  const withSystem = [
    'Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them.',
    '[09/08/2026, 14:00:00] Kit Alder created group "Alder site"',
    '[09/08/2026, 14:02:00] Kit Alder: a real message',
    '[09/08/2026, 14:03:00] Nemo Hale: ‎image omitted',
  ].join('\n');

  const parsed = parseExport(withSystem, { timezone: 'UTC', order: 'dmy' });
  const bodies = parsed.messages.map((m) => m.text);
  assert.ok(!bodies.some((b) => /end-to-end encrypted/.test(b)), 'the encryption notice was filed as a message');
  assert.ok(!bodies.some((b) => /created group/.test(b)), 'a group-creation line was filed as a message');
  assert.ok(parsed.systemCount >= 1, 'system lines were dropped without being counted');
  assert.ok(bodies.some((b) => /a real message/.test(b)), 'a real message was lost among the system lines');
});

test('classifyBody knows an attachment placeholder from a sentence', () => {
  /* It is handed the WHOLE body after the timestamp — `Sender: text` — not the
     text alone, because "is there a sender" is most of what separates a message
     from a system line. A bare sentence with no sender prefix is therefore
     correctly a system line: that is what WhatsApp's own notices look like. */
  assert.equal(classifyBody('Kit Alder: Bring the schedule of values.').kind, 'message');
  assert.notEqual(classifyBody('Messages and calls are end-to-end encrypted.').kind, 'message');
  assert.notEqual(classifyBody('Kit Alder created group "Alder site"').kind, 'message');

  /* An attachment placeholder stays a MESSAGE, flagged rather than discarded,
     and that is the right call rather than a missed case: a person really did
     send something at that moment, and dropping the line would leave a silence
     in the conversation where a photo was. The flag is what lets the board say
     "sent a photo" instead of showing an empty row. */
  const img = classifyBody('Kit Alder: ‎image omitted');
  assert.equal(img.kind, 'message', 'an attachment is something a person sent, not a system notice');
  assert.equal(img.attached, true, 'the attachment is not flagged, so the row reads as an empty message');
  assert.equal(classifyBody('Kit Alder: Bring the schedule of values.').attached, false);

  // A colon inside the message must not be mistaken for the sender delimiter.
  const colon = classifyBody('Kit Alder: 9:30 works for me');
  assert.equal(colon.kind, 'message');
  assert.equal(colon.sender, 'Kit Alder', 'the split took the wrong colon');
});

test('non-ASCII digits in a timestamp are read, not refused', () => {
  // Arabic-Indic digits appear in exports from Arabic and Persian locales, and
  // a parser that only knows 0-9 reads such a file as zero messages.
  assert.equal(normalizeDigits('١٣'), '13');
});

/* ------------------------------------------------------------------ *
 * Which side is the user
 * ------------------------------------------------------------------ */

test('the owner is resolved from evidence, and never guessed', () => {
  /* An export has display names and no addresses, so "which of these is me"
     has no answer in the file. The connector's rule is that a coin-flip
     dressed as a result is worse than saying it does not know — a wrong guess
     files everything the user said as owed TO them, inverting the board. */
  const senders = ['Kit Alder', 'Nemo Hale'];

  /* It returns `{name, how}` rather than a bare name, and the `how` is not
     decoration: `collect` reports which evidence it used, so a board that filed
     the wrong side can be explained instead of merely disbelieved. */
  const bySetting = resolveOwner({ configured: 'Nemo Hale', senders });
  assert.equal(bySetting.name, 'Nemo Hale', 'an explicitly configured name must win outright');
  assert.equal(bySetting.how, 'setting');

  const byFile = resolveOwner({ senders, fileName: 'WhatsApp Chat with Kit Alder.txt' });
  assert.equal(byFile.name, 'Nemo Hale',
    'a two-person chat is named after the OTHER party, which names the user by elimination');
  assert.equal(byFile.how, 'filename');

  assert.equal(resolveOwner({ senders, identityEmail: 'nemo@example.com' }).name, 'Nemo Hale',
    'the local part matching exactly one sender is real evidence');

  // A group export is named after the GROUP, so elimination has nothing to
  // eliminate — and naming a member anyway would invert that person's board.
  const unknown = resolveOwner({
    senders: ['Kit Alder', 'Nemo Hale', 'Dana Vance'],
    fileName: 'WhatsApp Chat with Alder site.txt',
  });
  assert.ok(!unknown.name, `a group chat must not nominate a member as the user, got ${JSON.stringify(unknown)}`);
});

/* ------------------------------------------------------------------ *
 * The row the database will actually see
 * ------------------------------------------------------------------ */

test('a row carries no uid at all, so re-importing does not re-insert the chat', () => {
  /* The rule that has already cost this project: `uid: null` coerces to 0 in
     upsertMessage while an omitted uid stays null, and the two hash to
     different row ids — so a connector that flips between them re-inserts
     every row it has ever seen. An export is re-read on every sweep, so this
     connector re-imports the same file forever; if the id moved, so would the
     whole conversation, every half hour. */
  const parsed = parseExport('[09/08/2026, 14:02:00] Kit Alder: hello', { timezone: 'UTC', order: 'dmy' });
  const row = rowFor(parsed.messages[0], { chatKey: 'chat-1', chatName: 'Kit Alder', ownerName: 'Nemo Hale' });

  assert.equal(Object.prototype.hasOwnProperty.call(row, 'uid'), false,
    'the row carries a uid key — omit it entirely or always give it a number, never null');
  assert.ok(row.messageId, 'a row with no messageId gets a random id and re-inserts on every sweep');
  assert.equal(row.direction, 'in', 'a message from the other party is inbound');

  const mine = rowFor({ ...parsed.messages[0], sender: 'Nemo Hale' },
    { chatKey: 'chat-1', chatName: 'Kit Alder', ownerName: 'Nemo Hale' });
  assert.equal(mine.direction, 'out', 'what the user wrote is outbound, or "you promised" cannot be mined from it');

  // Same input, same id — the property that makes re-reading the file safe.
  const again = rowFor(parsed.messages[0], { chatKey: 'chat-1', chatName: 'Kit Alder', ownerName: 'Nemo Hale' });
  assert.equal(again.messageId, row.messageId, 'the id is not stable, so every sweep duplicates the chat');
});

/* ------------------------------------------------------------------ *
 * The file on disk
 * ------------------------------------------------------------------ */

test('REGRESSION: collect reads a plain .txt export — the binary guard must not refuse every text file', async (t) => {
  /* The guard in readExport tested `text.includes('')` — an EMPTY needle, which
     String.prototype.includes answers true for on every string — so every .txt
     export threw ExportError and collect reported the file as "not text (it
     contains NUL bytes)" with zero rows. Android's "Export chat → Without
     media" produces a .txt, so the connector's primary input path never worked
     once; only the .zip branch, which returns before the guard, ever did — and
     check() parses the same .txt head directly, so doctor said "pass" about a
     file the sweep called unreadable. The intended needle is a real NUL byte,
     as folder.mjs spells it. Driven through the real collect(), because every
     other test here calls the parser directly and the parser was never the
     problem. */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-whatsapp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'WhatsApp Chat with Kit Alder.txt');
  fs.writeFileSync(file, [
    '[9/8/26, 9:14:02 AM] Kit Alder: Retainage schedule is posted',
    '[9/8/26, 9:15:00 AM] Nemo Hale: On it',
  ].join('\n'));

  const collectFrom = (target) => whatsapp.collect({
    source: { id: 's_wa', settings: { path: target, yourName: 'Nemo Hale' } },
    label: 'WhatsApp',
    cursor: null,
    timezone: 'UTC',
    identityEmail: '',
    emit() {},
    signal: null,
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });

  const [part] = (await collectFrom(file)).parts;
  assert.equal(part.error, null, `a clean ASCII export was refused: ${part.error}`);
  assert.equal(part.rows.length, 2, 'the export parses on its own and collect still delivered nothing');
  assert.equal(part.rows[0].from.name, 'Kit Alder');

  // The guard still exists for what it was written against: a renamed binary.
  const binary = path.join(dir, 'not-really-a-chat.txt');
  fs.writeFileSync(binary, Buffer.from([0x50, 0x4b, 0x00, 0x01, 0x02]));
  const refused = (await collectFrom(binary)).parts[0];
  assert.equal(refused.rows.length, 0);
  assert.match(String(refused.error), /NUL bytes/, 'a real binary must still be refused by name');
});

test('an unchanged export is not read again at all, only stat-ed (TT-3443)', async (t) => {
  /* QA, 2026-10-10: the signature check came after readExport, so every
     unchanged export was read in full, and a .zip inflated, on every sweep.
     Proved without a spy: after the first read the file's bytes are replaced
     by same-length junk with the same mtime. Its signature is unchanged, so a
     connector that only stats it reports nothing; one that reads it trips the
     NUL-byte guard. */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-whatsapp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'WhatsApp Chat with Kit Alder.txt');
  const text = '[9/8/26, 9:14:02 AM] Kit Alder: Retainage schedule is posted\n';
  fs.writeFileSync(file, text);
  const when = new Date('2026-09-08T12:00:00Z');
  fs.utimesSync(file, when, when);

  const collect = (target, cursor) => whatsapp.collect({
    source: { id: 's_wa', settings: { path: target, yourName: 'Nemo Hale' } },
    label: 'WhatsApp', cursor, timezone: 'UTC', identityEmail: '',
    emit() {}, signal: null, log: { debug() {}, info() {}, warn() {}, error() {} },
  });

  for (const target of [file, dir]) {
    const first = await collect(target, null);
    assert.equal(first.parts[0].rows.length, 1, 'the first read should deliver the message');

    fs.writeFileSync(file, Buffer.alloc(Buffer.byteLength(text), 0));
    fs.utimesSync(file, when, when);
    const second = await collect(target, first.cursor);
    assert.ok(second.parts.every((p) => !p.error), `the unchanged export was read again: ${second.parts.map((p) => p.error).join('; ')}`);
    assert.equal(second.parts.reduce((n, p) => n + p.rows.length, 0), 0);
    assert.deepEqual(second.cursor.seen, first.cursor.seen, 'the skipped export must stay remembered');

    fs.writeFileSync(file, text);
    fs.utimesSync(file, when, when);
  }
});

test('a folder with nothing new to read is a quiet read, not a failure (TT-3442)', async (t) => {
  /* QA, 2026-10-10: an unchanged export adds no part, so the "nothing is
     waiting" note fired on every sweep of a healthy folder, and the sweep
     stores a note as a failed read. */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-whatsapp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const collect = (cursor) => whatsapp.collect({
    source: { id: 's_wa', settings: { path: dir, yourName: 'Nemo Hale' } },
    label: 'WhatsApp', cursor, timezone: 'UTC', identityEmail: '',
    emit() {}, signal: null, log: { debug() {}, info() {}, warn() {}, error() {} },
  });

  // An empty drop folder is a steady state too (new, or emptied after each
  // import); doctor is where it is pointed out.
  const empty = await collect(null);
  assert.ok(empty.parts.every((p) => !p.note && !p.error), 'an empty folder was reported as a failed read');

  fs.writeFileSync(path.join(dir, 'WhatsApp Chat with Kit Alder.txt'),
    '[9/8/26, 9:14:02 AM] Kit Alder: Retainage schedule is posted\n');
  const first = await collect(null);
  assert.equal(first.parts[0].rows.length, 1);

  const again = await collect(first.cursor);
  assert.ok(again.parts.every((p) => !p.note && !p.error),
    `an unchanged folder was reported: ${again.parts.map((p) => p.note || p.error).join('; ')}`);
  assert.equal(again.parts.reduce((n, p) => n + p.rows.length, 0), 0);
});

test('doctor says how old a folder\'s exports are, as it does for one file (TT-3444)', async (t) => {
  /* QA, 2026-10-10: for a folder, check() printed only the count. The age is
     the one question only doctor can usefully ask. */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-whatsapp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const line = '[9/8/26, 9:14:02 AM] Kit Alder: Retainage schedule is posted\n';
  const daysAgo = (n) => new Date(Date.now() - n * 86_400_000 - 3_600_000);
  const write = (name, days) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, line);
    fs.utimesSync(file, daysAgo(days), daysAgo(days));
    return file;
  };

  const kit = write('WhatsApp Chat with Kit Alder.txt', 3);
  const one = await whatsapp.check({ settings: { path: dir } });
  assert.equal(one.status, 'pass', one.detail);
  assert.match(one.detail, /1 export · exported 3 days ago/);

  write('WhatsApp Chat - Alder family.txt', 40);
  const two = await whatsapp.check({ settings: { path: dir } });
  assert.match(two.detail, /2 exports · newest exported 3 days ago, oldest 40 days ago/);

  // Past the 20 a sweep reads, the ages still cover every export, and the
  // line says only the newest are read: a stale chat cannot hide behind them.
  for (let i = 0; i < 20; i += 1) write(`WhatsApp Chat with Crew ${i}.txt`, 2);
  write('WhatsApp Chat with Old Supplier.txt', 400);
  const many = await whatsapp.check({ settings: { path: dir } });
  assert.match(many.detail, /23 exports · newest exported 2 days ago, oldest 400 days ago, and Zelos reads only the newest 20/);

  // The single file it always covered still says so.
  const single = await whatsapp.check({ settings: { path: kit } });
  assert.match(single.detail, /exported 3 days ago/);
});

test('the manifest says out loud that this is an archive, not a connection', () => {
  /* The most important line in the connector is not code. WhatsApp offers no
     way to read a personal account live, so a user who reads "WhatsApp" in a
     source list and assumes it updates has been misled by the product rather
     than by their own optimism. */
  assert.equal(whatsapp.credential, null, 'there is nothing to authenticate against a file on disk');
  assert.deepEqual(whatsapp.origins, [], 'a file reader must not be able to reach the network at all');
  assert.match(`${whatsapp.option}`, /export|file|archive/i,
    'the picker sentence does not say this is a file the user exports');
});

/* ------------------------------------------------------------------ *
 * Zipped exports (TT-3441)
 *
 * iOS hands over a .zip by default, and the connector calls it "the most
 * common thing to arrive here" — yet nothing tested it, and a long chat in one
 * was refused outright: a stored member by a cap on its size, a deflated one
 * as "could not be decompressed" once it inflated past 8 MB. SOURCES.md
 * promises the last 8 MB, as a .txt gets. The archives here are written byte
 * by byte, the way WhatsApp's and Finder's writers lay them out.
 * ------------------------------------------------------------------ */

import zlib from 'node:zlib';

/** A one-member ZIP: stored (0) or deflated (8), optionally streamed with a data descriptor. */
function zipOf(name, data, { method = 8, descriptor = false, compressed = null } = {}) {
  const comp = compressed ?? (method === 8 ? zlib.deflateRawSync(data) : data);
  const crc = zlib.crc32 ? zlib.crc32(data) : 0;
  const nameBuf = Buffer.from(name, 'utf8');
  const flags = descriptor ? 0x0008 : 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(flags, 6);
  local.writeUInt16LE(method, 8);
  // A streaming writer leaves the local sizes zero and writes them afterwards.
  local.writeUInt32LE(descriptor ? 0 : crc, 14);
  local.writeUInt32LE(descriptor ? 0 : comp.length, 18);
  local.writeUInt32LE(descriptor ? 0 : data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const trailer = descriptor ? Buffer.alloc(16) : Buffer.alloc(0);
  if (descriptor) {
    trailer.writeUInt32LE(0x08074b50, 0);
    trailer.writeUInt32LE(crc, 4);
    trailer.writeUInt32LE(comp.length, 8);
    trailer.writeUInt32LE(data.length >>> 0, 12);
  }
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(flags, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(comp.length, 20);
  central.writeUInt32LE(data.length >>> 0, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);
  const body = Buffer.concat([local, nameBuf, comp, trailer]);
  const cd = Buffer.concat([central, nameBuf]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, cd, end]);
}

/** A chat log of `bytes` or more, oldest first, whose very first and last lines are marked. */
function longChat(bytes) {
  const lines = ['[1/1/26, 9:00:00 AM] Kit Alder: THE VERY FIRST MESSAGE'];
  let size = lines[0].length + 1;
  for (let i = 0; size < bytes; i += 1) {
    const minute = String(i % 60).padStart(2, '0');
    // Long messages, so 12 MB is under a thousand of them: under the 2,000
    // message cap, so a missing first message proves the tail was read rather
    // than the cap dropping it — and the parser, not the zip reader, is what a
    // hundred thousand short lines would be timing.
    const line = `[1/1/26, 10:${minute}:00 AM] Kit Alder: progress note ${String(i).padStart(7, '0')} ${'on the retainage schedule and the punch list '.repeat(300)}`;
    lines.push(line);
    size += line.length + 1;
  }
  lines.push('[1/2/26, 9:00:00 AM] Nemo Hale: THE VERY LAST MESSAGE');
  return Buffer.from(lines.join('\n'), 'utf8');
}

async function collectZip(t, archive, fileName = 'WhatsApp Chat - Alder family.zip') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-whatsapp-zip-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, archive);
  const result = await whatsapp.collect({
    source: { id: 's_wa_zip', settings: { path: file, yourName: 'Nemo Hale' } },
    label: 'WhatsApp', cursor: null, timezone: 'UTC', identityEmail: '',
    emit() {}, signal: null, log: { debug() {}, info() {}, warn() {}, error() {} },
  });
  return result.parts[0];
}

test('a zipped chat is read, deflated or stored, and a streaming writer\'s zero local sizes are not believed', async (t) => {
  const chat = Buffer.from([
    '[9/8/26, 9:14:02 AM] Kit Alder: Retainage schedule is posted',
    '[9/8/26, 9:15:00 AM] Nemo Hale: On it',
  ].join('\n'));
  for (const options of [{ method: 8 }, { method: 0 }, { method: 8, descriptor: true }]) {
    const part = await collectZip(t, zipOf('_chat.txt', chat, options));
    assert.equal(part.error, null, `${JSON.stringify(options)}: ${part.error}`);
    assert.equal(part.rows.length, 2, JSON.stringify(options));
    assert.doesNotMatch(String(part.note ?? ''), /Only the last/, 'a short chat was reported as truncated');
  }
});

test('a zipped chat longer than 8 MB is read from the end, as a .txt is, not refused (TT-3441)', async (t) => {
  const chat = longChat(12_000_000);
  for (const options of [{ method: 8 }, { method: 0 }, { method: 8, descriptor: true }]) {
    const part = await collectZip(t, zipOf('_chat.txt', chat, options));
    assert.equal(part.error, null, `${JSON.stringify(options)}: a long zipped chat was refused: ${part.error}`);
    const texts = part.rows.map((row) => row.text);
    assert.ok(texts.some((text) => /THE VERY LAST MESSAGE/.test(text)), `${JSON.stringify(options)}: the newest message is missing`);
    assert.ok(!texts.some((text) => /THE VERY FIRST MESSAGE/.test(text)), `${JSON.stringify(options)}: the oldest message was read, so the tail was not`);
    assert.match(String(part.note), /Only the last 8,000,000 bytes of this file were read\./, JSON.stringify(options));
    assert.doesNotMatch(String(part.note), /keeps the most recent/, 'the message cap, not the tail read, is what dropped the oldest');
  }
});

test('a zipped chat that would inflate past half a gigabyte is refused in words, not inflated for minutes', async (t) => {
  // 520 MB of zeros deflates to about half a megabyte: the shape of a zip bomb.
  const deflate = zlib.createDeflateRaw({ level: 9 });
  const out = [];
  deflate.on('data', (chunk) => out.push(chunk));
  const block = Buffer.alloc(1 << 20);
  for (let i = 0; i < 520; i += 1) deflate.write(block);
  await new Promise((resolve) => deflate.end(resolve));
  const compressed = Buffer.concat(out);

  const part = await collectZip(t, zipOf('_chat.txt', Buffer.alloc(0), { method: 8, compressed }));
  assert.equal(part.rows.length, 0);
  assert.match(String(part.error), /more than 512,000,000 bytes of chat text/);
});

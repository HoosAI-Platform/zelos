/**
 * ui/lib/local-address.js — is an AI address on this machine, or on the
 * network you are on?
 *
 * The engine's answer lives in core/llm.mjs `isLocalAddress`, and it decides
 * whether a model needs a key: everything on loopback, the private IPv4 ranges
 * (10/8, 172.16/12, 192.168/16, link-local), `.local` names and the IPv6 local
 * ranges is reached without one. The page cannot import core/, and it used to
 * ask a regex instead that knew only 127.0.0.1, localhost and ::1 — so a
 * self-hosted runtime on the local network, vLLM on a GPU box at 192.168.1.40,
 * could not be saved keyless: "OpenAI needs a key. Paste one above…", against
 * SPEC.md's "Keyless local models must just work" (QA, 2026-10-10, TT-3449).
 *
 * This is a copy of that function, line for line, and test/ui.test.mjs runs
 * both over the same list of addresses so the two cannot drift.
 */

function tryUrl(s) {
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

/** Hostname of a base URL, tolerating a missing scheme and IPv6 brackets. */
function hostnameOf(baseUrl) {
  if (typeof baseUrl !== 'string') return null;
  const raw = baseUrl.trim();
  if (!raw) return null;
  let parsed = tryUrl(raw);
  if (!parsed || !parsed.hostname) parsed = tryUrl(`http://${raw.replace(/^\/+/, '')}`);
  if (!parsed || !parsed.hostname) return null;
  let host = parsed.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.endsWith('.') && host.length > 1) host = host.slice(0, -1);
  return host || null;
}

function isPrivateV4(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (octets.some((n) => n > 255)) return false;
  const [a, b] = octets;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function expandV6(host) {
  const halves = host.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  let groups;
  if (halves.length === 1) {
    groups = head;
  } else {
    const tail = halves[1] ? halves[1].split(':') : [];
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...Array(fill).fill('0'), ...tail];
  }
  if (groups.length !== 8) return null;
  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return out.some((n) => Number.isNaN(n)) ? null : out;
}

function isLocalV6(host) {
  const dotted = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
  if (dotted) return isPrivateV4(dotted[1]);
  const groups = expandV6(host);
  if (!groups) return false;
  if (groups.every((g, i) => (i < 7 ? g === 0 : g === 1))) return true;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const v4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
    return isPrivateV4(v4);
  }
  if ((groups[0] & 0xfe00) === 0xfc00) return true;
  if ((groups[0] & 0xffc0) === 0xfe80) return true;
  return false;
}

/** core/llm.mjs `isLocalAddress`, for the page: reached without a key. */
export function isLocalAddress(baseUrl) {
  const host = hostnameOf(baseUrl);
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host !== '.local' && host.endsWith('.local')) return true;
  if (host.includes(':')) return isLocalV6(host);
  return isPrivateV4(host);
}

/**
 * On this very machine, as opposed to elsewhere on the network: loopback in
 * any spelling (127/8, ::1, the IPv4-mapped forms) and 0.0.0.0, which a
 * server's "listening on 0.0.0.0" banner invites people to paste and which
 * reaches this machine.
 */
export function isThisMachine(baseUrl) {
  const host = hostnameOf(baseUrl);
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const v4 = (ip) => ip === '0.0.0.0' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip);
  if (v4(host)) return true;
  if (!host.includes(':')) return false;
  const dotted = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
  if (dotted) return v4(dotted[1]);
  const groups = expandV6(host);
  if (!groups) return false;
  if (groups.every((g, i) => (i < 7 ? g === 0 : g === 1))) return true;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) return (groups[6] >> 8) === 127;
  return false;
}

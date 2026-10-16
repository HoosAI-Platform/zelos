/**
 * core/llm.mjs — the model adapter.
 *
 * Two wire protocols cover every mainstream provider and every local runtime,
 * because the protocol is not the company: `openai` speaks
 * POST {baseUrl}/chat/completions with a Bearer token, and `anthropic` speaks
 * POST {baseUrl}/v1/messages with x-api-key + anthropic-version. Ollama, LM
 * Studio, llama.cpp, vLLM and LocalAI all expose the openai shape, so "bring
 * your own model" is one code path, not a plugin system.
 *
 * The rules that shape this file came from a build that got them wrong:
 *   - A missing key is only an error for a NON-local address. A keyless Ollama
 *     on 127.0.0.1 must just work.
 *   - Local endpoints reject `response_format`, so json:true prompts instead
 *     and leans on extractJSON.
 *   - Small local models wrap JSON in fences and prose no matter what the
 *     prompt says, so extractJSON is tolerant by design.
 *   - Every thrown error names the address, because "my key is wrong" and "my
 *     Ollama isn't running" are the same 30 seconds of confusion otherwise.
 */

import { log } from './log.mjs';
import { screenContent, SafetyError } from './safety.mjs';
import { fetchFailureReason } from './fetch-error.mjs';

const llog = log.child('[llm]');

/**
 * How long a request may go without progress. This is an IDLE budget, not a
 * total one: a streaming answer resets it on every chunk that arrives, so a
 * long reply is never killed for being long, only for going quiet.
 */
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_RETRIES = 3;
const RETRY_BASE_MS = 500;
const RETRY_MAX_DELAY_MS = 8_000;
/** Ceiling on time spent sleeping between attempts, so a 429 storm can't hang a sweep. */
const RETRY_BUDGET_MS = 30_000;
const ANTHROPIC_VERSION = '2023-06-01';
const PROBE_TIMEOUT_MS = 1200;
const ERROR_DETAIL_CHARS = 400;

/** Appended to the system prompt when we cannot ask the server for JSON natively. */
const JSON_INSTRUCTION =
  'Reply with a single JSON object and nothing else — no prose before or after it, no markdown code fences.';

export class LLMError extends Error {
  constructor(message, { status = null, address = null, retriable = false, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'LLMError';
    this.status = status;
    this.address = address;
    this.retriable = retriable;
  }
}

/* ------------------------------------------------------------------ *
 * Address handling
 * ------------------------------------------------------------------ */

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
  // `new URL('localhost:1234')` parses as protocol "localhost:", so a parse
  // that yields no hostname still needs the scheme-prefixed retry.
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
  if (a === 0) return true; // 0.0.0.0
  if (a === 10) return true;
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/** Expand an IPv6 literal to eight numeric groups, or null if malformed. */
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
  // A literal written in dotted form, e.g. "::ffff:127.0.0.1" typed by hand.
  const dotted = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
  if (dotted) return isPrivateV4(dotted[1]);
  const groups = expandV6(host);
  if (!groups) return false;
  if (groups.every((g, i) => (i < 7 ? g === 0 : g === 1))) return true; // ::1
  // The same mapped address after WHATWG URL parsing, which re-renders the
  // embedded IPv4 as two hex groups ("::ffff:7f00:1").
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const v4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
    return isPrivateV4(v4);
  }
  if ((groups[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((groups[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  return false;
}

/**
 * True for addresses that live on this machine or this LAN. Locality is what
 * decides whether an API key is required and whether provider-only request
 * parameters are safe to send.
 */
export function isLocalAddress(baseUrl) {
  const host = hostnameOf(baseUrl);
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host !== '.local' && host.endsWith('.local')) return true;
  if (host.includes(':')) return isLocalV6(host);
  return isPrivateV4(host);
}

/** The address we name in errors: the base URL with trailing slashes trimmed. */
function normalizeBase(baseUrl) {
  return String(baseUrl ?? '').trim().replace(/\/+$/, '');
}

/** Anthropic paths live under /v1; tolerate a base URL that already says so. */
function anthropicPath(base, leaf) {
  return /\/v1$/.test(base) ? `${base}/${leaf}` : `${base}/v1/${leaf}`;
}

/* ------------------------------------------------------------------ *
 * Presets
 * ------------------------------------------------------------------ */

export const PRESETS = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    docsUrl: 'https://docs.claude.com/en/api/getting-started',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    local: false,
    suggestedModels: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
    keyless: false,
    note: 'Claude, direct from Anthropic.',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    docsUrl: 'https://platform.openai.com/docs/api-reference/chat',
    keyUrl: 'https://platform.openai.com/api-keys',
    local: false,
    suggestedModels: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o'],
    keyless: false,
    note: 'The original chat-completions endpoint.',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    protocol: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/openai',
    keyUrl: 'https://aistudio.google.com/apikey',
    local: false,
    suggestedModels: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    keyless: false,
    note: "Gemini's OpenAI-compatible endpoint. Use the AI Studio key.",
  },
  {
    id: 'groq',
    label: 'Groq',
    protocol: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    docsUrl: 'https://console.groq.com/docs/openai',
    keyUrl: 'https://console.groq.com/keys',
    local: false,
    suggestedModels: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    keyless: false,
    note: 'Very fast inference for open-weight models.',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    protocol: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    docsUrl: 'https://docs.mistral.ai/api/',
    keyUrl: 'https://console.mistral.ai/api-keys/',
    local: false,
    suggestedModels: ['mistral-large-latest', 'mistral-small-latest'],
    keyless: false,
    note: 'European hosting.',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    docsUrl: 'https://api-docs.deepseek.com/',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    local: false,
    suggestedModels: ['deepseek-chat', 'deepseek-reasoner'],
    keyless: false,
    note: 'Inexpensive, strong at structured output.',
  },
  {
    id: 'xai',
    label: 'xAI',
    protocol: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    docsUrl: 'https://docs.x.ai/docs/api-reference',
    keyUrl: 'https://console.x.ai/',
    local: false,
    suggestedModels: ['grok-4', 'grok-3-mini'],
    keyless: false,
    note: 'Grok.',
  },
  {
    id: 'together',
    label: 'Together',
    protocol: 'openai',
    baseUrl: 'https://api.together.xyz/v1',
    docsUrl: 'https://docs.together.ai/docs/openai-api-compatibility',
    keyUrl: 'https://api.together.xyz/settings/api-keys',
    local: false,
    suggestedModels: ['meta-llama/Llama-3.3-70B-Instruct-Turbo'],
    keyless: false,
    note: 'A wide catalogue of open-weight models.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    docsUrl: 'https://openrouter.ai/docs/quickstart',
    keyUrl: 'https://openrouter.ai/keys',
    local: false,
    suggestedModels: ['anthropic/claude-sonnet-5', 'openai/gpt-4.1'],
    keyless: false,
    note: 'One key, most providers — model ids are namespaced.',
  },
  {
    id: 'fireworks',
    label: 'Fireworks',
    protocol: 'openai',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    docsUrl: 'https://docs.fireworks.ai/api-reference/introduction',
    keyUrl: 'https://fireworks.ai/account/api-keys',
    local: false,
    suggestedModels: ['accounts/fireworks/models/llama-v3p3-70b-instruct'],
    keyless: false,
    note: 'Fast hosted open-weight models.',
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    protocol: 'openai',
    baseUrl: 'https://api.cerebras.ai/v1',
    docsUrl: 'https://inference-docs.cerebras.ai/',
    keyUrl: 'https://cloud.cerebras.ai/',
    local: false,
    suggestedModels: ['llama-3.3-70b'],
    keyless: false,
    note: 'Wafer-scale inference; very high tokens per second.',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:11434/v1',
    docsUrl: 'https://docs.ollama.com/openai',
    keyUrl: null,
    local: true,
    suggestedModels: ['llama3.2', 'qwen2.5', 'mistral-nemo'],
    keyless: true,
    note: 'Runs on your machine. Nothing leaves it. Start it with `ollama serve`.',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:1234/v1',
    docsUrl: 'https://lmstudio.ai/docs/app/api/endpoints/openai',
    keyUrl: null,
    local: true,
    suggestedModels: [],
    keyless: true,
    note: 'Runs on your machine. Turn the local server on from the Developer tab.',
  },
  {
    id: 'llamacpp',
    label: 'llama.cpp',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:8080/v1',
    docsUrl: 'https://github.com/ggml-org/llama.cpp/tree/master/tools/server',
    keyUrl: null,
    local: true,
    suggestedModels: [],
    keyless: true,
    note: 'Runs on your machine, via `llama-server`.',
  },
  {
    id: 'vllm',
    label: 'vLLM',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:8000/v1',
    docsUrl: 'https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html',
    keyUrl: null,
    local: true,
    suggestedModels: [],
    keyless: true,
    note: 'Self-hosted, usually on a GPU box. Model id is the served name.',
  },
  {
    id: 'localai',
    label: 'LocalAI',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:8080/v1',
    docsUrl: 'https://localai.io/features/openai-functions/',
    keyUrl: null,
    local: true,
    suggestedModels: [],
    keyless: true,
    note: 'Runs on your machine. Shares llama.cpp’s default port — change one if you run both.',
  },
];

const DEFAULT_PROBE_TARGETS = [
  { label: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
  { label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1' },
  { label: 'llama.cpp', baseUrl: 'http://127.0.0.1:8080/v1' },
  { label: 'vLLM', baseUrl: 'http://127.0.0.1:8000/v1' },
];

/* ------------------------------------------------------------------ *
 * JSON recovery
 * ------------------------------------------------------------------ */

const FENCE_RE = /```[ \t]*[A-Za-z0-9_+-]*[ \t]*\r?\n([\s\S]*?)```/g;

function tryParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * Walk `text` looking for a balanced run that starts with `open`, respecting
 * string literals and escapes so a `}` inside a quoted value doesn't end the
 * scan early. Returns the first candidate that parses.
 */
function scanBalanced(text, open, close) {
  for (let start = text.indexOf(open); start !== -1; start = text.indexOf(open, start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        if (inString) escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          const parsed = tryParse(text.slice(start, i + 1));
          if (parsed.ok) return parsed;
          break; // unbalanced-but-closed candidate; try the next opener
        }
      }
    }
  }
  return { ok: false };
}

function fencedBlocks(text) {
  const blocks = [];
  FENCE_RE.lastIndex = 0;
  let m;
  while ((m = FENCE_RE.exec(text)) !== null) blocks.push(m[1]);
  if (blocks.length === 0 && text.includes('```')) {
    // An unterminated fence — common when the model hit its token limit.
    const open = /```[ \t]*[A-Za-z0-9_+-]*[ \t]*\r?\n([\s\S]*)$/.exec(text);
    if (open) blocks.push(open[1]);
  }
  return blocks;
}

/**
 * Recover a JSON value from model output that may be fenced, prefaced with
 * prose, or both. Fenced blocks are tried first: prose outside the fence often
 * contains braces of its own, and the fenced block is the model's actual answer.
 * Returns null when nothing parses.
 */
export function extractJSON(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  const direct = tryParse(trimmed);
  if (direct.ok) return direct.value;

  for (const block of fencedBlocks(trimmed)) {
    const whole = tryParse(block.trim());
    if (whole.ok) return whole.value;
    const obj = scanBalanced(block, '{', '}');
    if (obj.ok) return obj.value;
    const arr = scanBalanced(block, '[', ']');
    if (arr.ok) return arr.value;
  }

  const obj = scanBalanced(trimmed, '{', '}');
  if (obj.ok) return obj.value;
  const arr = scanBalanced(trimmed, '[', ']');
  if (arr.ok) return arr.value;
  return null;
}

/* ------------------------------------------------------------------ *
 * Request construction
 * ------------------------------------------------------------------ */

/** Flatten a message content value to plain text. */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('');
  }
  return '';
}

function num(v) {
  return Number.isFinite(v) ? v : 0;
}

function requireProtocol(protocol, address) {
  if (protocol === 'openai' || protocol === 'anthropic') return protocol;
  throw new LLMError(
    `Unknown model protocol "${protocol}" for ${address || '(no address)'} — expected "openai" or "anthropic"`,
    { address: address || null },
  );
}

function requireKey(apiKey, address) {
  if (typeof apiKey === 'string' && apiKey.trim()) return apiKey.trim();
  if (isLocalAddress(address)) return null; // keyless local models are the point
  throw new LLMError(
    'No key has been saved for this AI service — open Settings → AI and paste one. (An AI program on this computer needs no key.)',
    { address: address || null },
  );
}

function authHeaders(protocol, apiKey) {
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (!apiKey) return headers;
  if (protocol === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = ANTHROPIC_VERSION;
  } else {
    headers.authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

/**
 * Split the conversation into a single system string plus user/assistant turns.
 * `role:'system'` entries inside `messages` are folded into the system text so
 * both protocols get the same conversation, expressed the way each expects it.
 */
function normalizeConversation(system, messages) {
  const systems = [];
  if (typeof system === 'string' && system.trim()) systems.push(system.trim());
  const turns = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== 'object') continue;
    const content = textOf(m.content);
    if (!content) continue;
    if (m.role === 'system') {
      systems.push(content);
      continue;
    }
    turns.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content });
  }
  return { system: systems.join('\n\n'), turns };
}

function buildChatRequest(opts, { stream }) {
  const address = normalizeBase(opts.baseUrl);
  const protocol = requireProtocol(opts.protocol, address);
  if (!address) {
    throw new LLMError('No model baseUrl configured — pick a provider in Settings', {
      address: null,
    });
  }
  // The model before the key. DEFAULTS pre-select a hosted provider with an
  // empty model id, so on a home nobody has set up the first thing missing is
  // the choice, not the credential — and the key check ran first, so every run
  // row, the SSE relay and the board banner named a missing API key on an
  // install where the real next step was picking a model.
  //
  // The address is carried on the error and kept OUT of the sentence. This is
  // the one failure a fresh install meets on its first press of the button,
  // and it used to read "No model selected for https://api.anthropic.com" —
  // an address the person had never typed, which read as the program having
  // gone somewhere without asking. The tab it names is the one the Settings
  // strip now labels "AI"; the sweep scheduler's stand-down says the same.
  const model = typeof opts.model === 'string' ? opts.model.trim() : '';
  if (!model) {
    throw new LLMError('No AI has been chosen yet — open Settings → AI and pick one', { address });
  }
  const apiKey = requireKey(opts.apiKey, address);

  const local = isLocalAddress(address);
  // Local runtimes commonly reject response_format outright, so json:true
  // degrades to an instruction the prompt carries and extractJSON cleans up.
  const useResponseFormat = opts.json === true && protocol === 'openai' && !local;
  const conversation = normalizeConversation(opts.system, opts.messages);
  let systemText = conversation.system;
  if (opts.json === true && !useResponseFormat) {
    systemText = systemText ? `${systemText}\n\n${JSON_INSTRUCTION}` : JSON_INSTRUCTION;
  }
  if (conversation.turns.length === 0) {
    throw new LLMError(`No messages to send to ${address}`, { address });
  }

  const maxTokens =
    Number.isFinite(opts.maxTokens) && opts.maxTokens > 0
      ? Math.floor(opts.maxTokens)
      : DEFAULT_MAX_TOKENS;

  let url;
  const body = { model, max_tokens: maxTokens };
  // Sampling knobs go to the OpenAI protocol only. Anthropic's current models
  // (Sonnet 5, Opus 5, and the 4.7+ family) reject `temperature`, `top_p` and
  // `top_k` outright — a 400 reading "temperature is deprecated for this
  // model" — and the config default of 0 was riding on every request, so the
  // first sweep after pasting a working key failed on a field nobody set.
  // Older Claude models accept the field but sample fine without it; the
  // local runtimes and hosted OpenAI-protocol providers still honour it.
  if (protocol !== 'anthropic' && Number.isFinite(opts.temperature)) body.temperature = opts.temperature;

  if (protocol === 'anthropic') {
    url = anthropicPath(address, 'messages');
    if (systemText) body.system = systemText; // top level, never a message
    body.messages = conversation.turns;
    if (stream) body.stream = true;
  } else {
    url = `${address}/chat/completions`;
    body.messages = systemText
      ? [{ role: 'system', content: systemText }, ...conversation.turns]
      : conversation.turns;
    if (useResponseFormat) body.response_format = { type: 'json_object' };
    if (stream) {
      body.stream = true;
      // stream_options is another provider-only parameter local servers may reject.
      if (!local) body.stream_options = { include_usage: true };
    }
  }

  return {
    url,
    method: 'POST',
    headers: authHeaders(protocol, apiKey),
    body: JSON.stringify(body),
    address,
    protocol,
    model,
  };
}

/* ------------------------------------------------------------------ *
 * Transport: timeout, abort, retry
 * ------------------------------------------------------------------ */

function abortLLMError(address) {
  return new LLMError(`Model request to ${address} was cancelled`, {
    address,
    retriable: false,
  });
}

function throwIfAborted(signal, address) {
  if (signal?.aborted) throw abortLLMError(address);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * A per-attempt AbortSignal that folds in the caller's signal and a deadline.
 *
 * The deadline is an IDLE deadline. `kick()` restarts it, and a caller reading
 * a token stream kicks it on every chunk the socket delivers, so a long answer
 * is allowed to take as long as it takes while silence still ends the attempt.
 * An earlier version dropped the timer outright once response *headers* landed,
 * on the reasoning that a live stream should outlive the request timeout — but
 * that threw away the bound instead of moving it, and the streams that need a
 * bound most are exactly the ones that never stop making noise.
 */
function attemptController(callerSignal, timeoutMs) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(new Error('caller aborted'));
  if (callerSignal) {
    if (callerSignal.aborted) onAbort();
    else callerSignal.addEventListener('abort', onAbort, { once: true });
  }
  const expire = () => {
    controller.abort(new DOMException(`timed out after ${timeoutMs}ms`, 'TimeoutError'));
  };
  let timer = setTimeout(expire, timeoutMs);
  return {
    signal: controller.signal,
    kick() {
      if (!timer) return; // already disposed; nothing left to reset
      clearTimeout(timer);
      timer = setTimeout(expire, timeoutMs);
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
      callerSignal?.removeEventListener('abort', onAbort);
    },
  };
}

/** Spec: retry 408, 409, 429 and 5xx. Never 401/403 — a bad key stays bad. */
function isRetriableStatus(status) {
  return status === 408 || status === 409 || status === 429 || (status >= 500 && status <= 599);
}

function parseRetryAfter(header) {
  if (!header) return null;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(header);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - Date.now());
}

function backoffDelay(attempt) {
  const ceiling = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2)); // equal jitter
}

function statusHint(status) {
  if (status === 401 || status === 403) return 'check the API key';
  if (status === 404) return 'check the base URL and the model id';
  if (status === 413) return 'the request was too large';
  if (status === 429) return 'rate limited';
  if (status >= 500) return 'the server errored';
  return 'the request was rejected';
}

/**
 * The credential this request is carrying, in every spelling it went out as.
 * Read back off the headers rather than passed in, so a protocol added later
 * cannot forget to declare it.
 */
function credentialsIn(headers) {
  const out = [];
  const key = headers?.['x-api-key'];
  if (typeof key === 'string' && key) out.push(key);
  const auth = headers?.authorization;
  if (typeof auth === 'string' && auth) {
    out.push(auth);
    const bare = auth.replace(/^\s*(?:bearer|basic)\s+/i, '');
    if (bare && bare !== auth) out.push(bare);
  }
  return out;
}

/**
 * An endpoint's error body is text a third party wrote, and several of them
 * quote the request back — including the `Authorization` header. That detail is
 * shown in Settings, and a sweep writes it into `runs.stats_json` on disk, so
 * the key is struck out before it can travel any further than the socket it was
 * already sent on.
 */
function withoutCredentials(text, secrets) {
  let out = String(text);
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('<key withheld>');
  }
  return out;
}

/**
 * An endpoint's own words, as they may be kept: in `runs.error`, `/api/state`,
 * the log, an export. A 400 whose body was an HTML page went in verbatim,
 * `<script>` and all, though SECURITY.md says screening keeps markup out of
 * the database and the log files and the reply sample beside it was already
 * screened (QA, 2026-10-10, TT-3453). Every path that keeps an endpoint's error
 * text goes through here: the status error, a 200 carrying an error body (from
 * `complete()` and `listModels()`), and a mid-stream error frame. A detail that is trying to be markup is
 * replaced by what it was, which is the useful part anyway: a page is what a
 * wrong base URL answers with.
 */
function screenedDetail(text) {
  try {
    return screenContent(text);
  } catch (err) {
    if (!(err instanceof SafetyError)) throw err;
    return /<\s*(?:!doctype|html|head|body)\b/i.test(text)
      ? 'an HTML page, not the API\'s own error (its text was not kept)'
      : 'its text looked like markup and was not kept';
  }
}

async function readErrorDetail(res, secrets = []) {
  let text;
  try {
    text = await res.text();
  } catch {
    return '';
  }
  if (!text) return '';
  text = withoutCredentials(text, secrets);
  try {
    const json = JSON.parse(text);
    const message =
      json?.error?.message ?? json?.message ?? (typeof json?.error === 'string' ? json.error : null);
    if (typeof message === 'string' && message) return screenedDetail(message.slice(0, ERROR_DETAIL_CHARS));
  } catch {
    /* not JSON — fall through to the raw body */
  }
  // A whole page is described, not kept, whatever is in it: the words a person
  // needs are "this address served a web page", not its markup.
  if (/<\s*(?:!doctype|html|head|body)\b/i.test(text)) return 'an HTML page, not the API\'s own error (its text was not kept)';
  // Screened on twice what is kept, before the cut: a cap can split a tag and
  // hide it, and a hostile body can be megabytes.
  return screenedDetail(text.replace(/\s+/g, ' ').trim().slice(0, ERROR_DETAIL_CHARS * 2)).slice(0, ERROR_DETAIL_CHARS);
}

function httpError(res, detail, address) {
  const status = res.status;
  if (status >= 300 && status < 400) {
    // The server's own words too, so screened like the rest (TT-3453).
    const given = (res.headers.get('location') || 'another address').slice(0, ERROR_DETAIL_CHARS);
    const location = screenedDetail(given) === given ? given : 'an address that looked like markup (not kept)';
    // Following this would forward the API key to a host the user never chose.
    return new LLMError(
      `Model at ${address} redirected to ${location} — point the base URL there directly; Zelos will not forward your key across a redirect`,
      { status, address, retriable: false },
    );
  }
  return new LLMError(
    `Model at ${address} returned ${status} (${statusHint(status)})${detail ? `: ${detail}` : ''}`,
    { status, address, retriable: isRetriableStatus(status) },
  );
}

function transportError(err, address) {
  if (err?.name === 'TimeoutError') {
    return new LLMError(`Model at ${address} did not respond in time`, {
      address,
      retriable: true,
      cause: err,
    });
  }
  // In words, as every other reader now says it (core/fetch-error.mjs, TT-3514).
  const reason = err?.cause || err?.code ? fetchFailureReason(err) : err?.message || 'connection failed';
  return new LLMError(
    `Could not reach the model at ${address} (${reason}) — is it running, and is the base URL right?`,
    { address, retriable: true, cause: err },
  );
}

/**
 * Perform the request, retrying only where the spec allows. Returns the live
 * Response, a `release()` the caller must invoke once the body is done, and a
 * `keepAlive()` a streaming caller invokes for every chunk that arrives.
 */
async function requestWithRetry(req, opts) {
  const retries = Number.isInteger(opts.retries) && opts.retries >= 0 ? opts.retries : DEFAULT_RETRIES;
  const timeoutMs =
    Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const callerSignal = opts.signal ?? null;
  let spentMs = 0;
  let attempt = 0;

  for (;;) {
    throwIfAborted(callerSignal, req.address);
    const control = attemptController(callerSignal, timeoutMs);
    let res;
    try {
      res = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        signal: control.signal,
        redirect: 'manual',
      });
    } catch (err) {
      control.dispose();
      throwIfAborted(callerSignal, req.address);
      const wrapped = transportError(err, req.address);
      const wait = backoffDelay(attempt);
      if (attempt >= retries || spentMs + wait > RETRY_BUDGET_MS) throw wrapped;
      llog.debug('retrying after transport error', { address: req.address, attempt, wait });
      await sleepOrAbort(wait, callerSignal, req.address);
      spentMs += wait;
      attempt++;
      continue;
    }

    if (res.ok) {
      // Headers are not a response — the body still has to arrive, and a 200
      // whose body trickles forever would otherwise hang with no timeout and no
      // way to cancel, because dropping the controller here severs both. So the
      // deadline and the caller's signal stay wired until release(), which every
      // caller invokes once the body is fully read.
      //
      // A non-streaming caller never kicks, so for it this stays a hard total
      // deadline covering the body read. A streaming caller kicks on every
      // chunk, which turns it into a silence detector. The version that cleared
      // the timer here instead had no bound at all past the headers: measured,
      // a server writing `: ping` every two seconds held stream({timeoutMs:1500})
      // open past 45 s with the UI still saying "Thinking…". Proxies inject
      // comment keepalives and anthropic sends {"type":"ping"} by design, so
      // those bytes have to count as liveness — the bug was never that they
      // reset a clock, it was that they were the reason there was no clock.
      return { res, release: () => control.dispose(), keepAlive: () => control.kick() };
    }

    const detail = await readErrorDetail(res, credentialsIn(req.headers));
    control.dispose();
    const err = httpError(res, detail, req.address);
    if (!err.retriable || attempt >= retries) throw err;
    const wait = parseRetryAfter(res.headers.get('retry-after')) ?? backoffDelay(attempt);
    // Honour Retry-After, but never sleep past the budget — a sweep that hangs
    // for an hour because a provider said so is worse than a clean failure.
    if (spentMs + wait > RETRY_BUDGET_MS) throw err;
    llog.debug('retrying after error status', { address: req.address, status: res.status, wait });
    await sleepOrAbort(wait, callerSignal, req.address);
    spentMs += wait;
    attempt++;
  }
}

async function sleepOrAbort(ms, signal, address) {
  try {
    await sleep(ms, signal);
  } catch {
    throw abortLLMError(address);
  }
}

async function readJson(res, address) {
  let text;
  try {
    text = await res.text();
  } catch (err) {
    throw new LLMError(`Could not read the response from ${address}`, {
      address,
      retriable: true,
      cause: err,
    });
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new LLMError(
      `Model at ${address} returned a non-JSON response — is the base URL pointing at the API?`,
      { address, retriable: false, cause: err },
    );
  }
}

/* ------------------------------------------------------------------ *
 * complete()
 * ------------------------------------------------------------------ */

/**
 * Why generation ended, folded into one vocabulary: 'length' when the reply hit
 * the token ceiling, 'stop' when the model finished of its own accord, the
 * provider's raw word for anything rarer, and null when the response did not
 * say. The distinction callers care about is 'length' — a reply cut off
 * mid-JSON will not parse, and the honest advice is "raise maxTokens", not
 * "get a better model".
 */
function normalizeStopReason(protocol, raw) {
  if (typeof raw !== 'string' || !raw) return null;
  if (protocol === 'anthropic') {
    if (raw === 'max_tokens') return 'length';
    if (raw === 'end_turn' || raw === 'stop_sequence') return 'stop';
    return raw;
  }
  return raw; // openai already says 'length' and 'stop'
}

/**
 * The failure a 200 can be hiding. Both protocols have a shape for it: openai's
 * is a top-level `error` object where `choices` should be, anthropic's is the
 * `{"type":"error","error":{…}}` envelope. Both are checked whatever the
 * configured protocol says, because an aggregator can hand back either.
 *
 * Returns null for a healthy body — including one carrying `"error": null`,
 * which several providers send on success and which must not read as a failure.
 */
function errorInBody(raw) {
  const detail = raw?.error;
  if (!detail && raw?.type !== 'error') return null;
  if (typeof detail === 'string' && detail) return detail;
  if (typeof detail?.message === 'string' && detail.message) return detail.message;
  if (typeof raw?.message === 'string' && raw.message) return raw.message;
  return 'no message given';
}

/**
 * One round trip. -> {text, usage:{input,output}, model, stopReason, raw}
 */
export async function complete(opts = {}) {
  const req = buildChatRequest(opts, { stream: false });
  llog.debug('complete', { address: req.address, protocol: req.protocol, model: req.model });
  const { res, release } = await requestWithRetry(req, opts);
  let raw;
  try {
    raw = await readJson(res, req.address);
  } finally {
    release();
  }
  return completionOf(raw, req);
}

/** Decode either a requested completion or a server's non-streaming fallback. */
function completionOf(raw, req) {
  // Not every failure comes with a failing status. OpenRouter answers a billing
  // problem with 200 and "402: insufficient credits" in the envelope; read as a
  // success that is an empty string, and an empty string is not obviously wrong
  // to anyone downstream. It cost us twice: Settings' "Test the connection"
  // painted the broken endpoint green, and the sweep then told the user their
  // model was too small and to go buy a bigger one, for what was a topped-out
  // account. stream() catches the identical body through its own plain-JSON
  // guard; which half you happened to call must not decide whether you are
  // told.
  const bodyError = errorInBody(raw);
  if (bodyError) {
    // Marked non-retriable, unlike the mid-stream case: an error that replaces
    // the whole response is a rejected request (credits, model id, key), where
    // one that interrupts a stream in flight is usually a transient overload.
    const detail = withoutCredentials(bodyError, credentialsIn(req.headers));
    throw new LLMError(
      `Model at ${req.address} returned a success status with an error body: ${screenedDetail(detail).slice(0, ERROR_DETAIL_CHARS)}`,
      { address: req.address, retriable: false },
    );
  }

  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const choice = Array.isArray(raw?.choices) ? raw.choices[0] : null;
  // Validate the protocol envelope, not the presence of prose: a refusal,
  // tool call, or legitimate empty response can carry no text at all.
  const valid = object(raw) && (req.protocol === 'anthropic'
    ? Array.isArray(raw.content)
    : object(choice?.message));
  if (!valid) {
    throw new LLMError(
      `Model at ${req.address} returned an invalid ${req.protocol} response — check the base URL and protocol`,
      { address: req.address, retriable: false },
    );
  }

  if (req.protocol === 'anthropic') {
    const blocks = Array.isArray(raw?.content) ? raw.content : [];
    const text = blocks
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
    return {
      text,
      usage: { input: num(raw?.usage?.input_tokens), output: num(raw?.usage?.output_tokens) },
      model: typeof raw?.model === 'string' ? raw.model : req.model,
      stopReason: normalizeStopReason('anthropic', raw?.stop_reason),
      raw,
    };
  }

  return {
    text: textOf(choice?.message?.content),
    usage: { input: num(raw?.usage?.prompt_tokens), output: num(raw?.usage?.completion_tokens) },
    model: typeof raw?.model === 'string' ? raw.model : req.model,
    stopReason: normalizeStopReason('openai', choice?.finish_reason),
    raw,
  };
}

/* ------------------------------------------------------------------ *
 * stream()
 * ------------------------------------------------------------------ */

const SSE_SEPARATOR = /\r\n\r\n|\n\n|\r\r/;

/** Concatenated `data:` payload of one SSE event block, or null if it has none. */
function dataOf(block) {
  const lines = block.split(/\r\n|\n|\r/);
  const parts = [];
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const value = line.slice(5);
    parts.push(value.startsWith(' ') ? value.slice(1) : value);
  }
  return parts.length ? parts.join('\n') : null;
}

/**
 * Yield each SSE event's data payload from a web ReadableStream of bytes.
 *
 * `onChunk` fires for every read that carries bytes, before any of them are
 * parsed — including SSE comment keepalives and frames this reader goes on to
 * discard. That is deliberate: the idle deadline is a question about the
 * socket, not about the events, and a proxy that says `: ping` is telling the
 * truth about being alive. Kicking only on frames we understood would abort
 * healthy anthropic streams, which ping by design.
 */
async function* sseFrames(webStream, onChunk) {
  const reader = webStream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      onChunk?.();
      buf += decoder.decode(value, { stream: true });
      let match;
      while ((match = SSE_SEPARATOR.exec(buf)) !== null) {
        const block = buf.slice(0, match.index);
        buf = buf.slice(match.index + match[0].length);
        const data = dataOf(block);
        if (data !== null) yield data;
      }
    }
    buf += decoder.decode();
    const tail = dataOf(buf);
    if (tail !== null) yield tail;
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
}

/**
 * The text of a mid-stream `error` frame, made safe to show and to store.
 *
 * A frame like this is written by the provider, and providers quote the request
 * back in them — measured against a loopback endpoint, an upstream that echoes
 * the rejected request handed back `…with Authorization: Bearer sk-live-…`, and
 * `stream()` was the one of this file's four error paths that did not scrub.
 * That mattered more than the others: `core/server.mjs` puts an Ask failure on
 * the SSE channel, where `ui/views/ask.js` writes it into the answer body, AND
 * through `log.warn`, which appends it to `~/.zelos/logs` for good. `complete()`
 * and `listModels()` already went through here; now every path does.
 */
function midStreamDetail(req, raw) {
  const text = typeof raw === 'string' && raw ? raw : 'unknown error';
  return screenedDetail(withoutCredentials(text, credentialsIn(req.headers))).slice(0, ERROR_DETAIL_CHARS);
}

/**
 * Token stream. Yields {type:'delta', text} then a final
 * {type:'done', usage, model, text, stopReason}.
 */
export async function* stream(opts = {}) {
  const req = buildChatRequest(opts, { stream: true });
  llog.debug('stream', { address: req.address, protocol: req.protocol, model: req.model });
  const { res, release, keepAlive } = await requestWithRetry(req, opts);
  if (!res.body) {
    release();
    throw new LLMError(`Model at ${req.address} returned an empty stream`, {
      address: req.address,
      retriable: true,
    });
  }

  // The same 200-with-an-error-envelope complete() guards against, aimed at
  // this half: a rejected stream:true request comes back as plain JSON, which
  // carries no `data:` frames at all — so the loop below would end cleanly on
  // nothing and hand the caller a finished, empty answer with no error. A
  // healthy stream says text/event-stream; anything else is read whole and, if
  // it is the error envelope, reported exactly as complete() reports it.
  const contentType = String(res.headers.get('content-type') ?? '');
  if (contentType && !contentType.includes('text/event-stream')) {
    let raw;
    try {
      raw = await readJson(res, req.address);
    } finally {
      release();
    }
    const { text, usage, model, stopReason } = completionOf(raw, req);
    // Some compatible servers ignore stream:true. Their complete answer is
    // still usable, and its reported usage belongs in the same daily counter.
    if (text) yield { type: 'delta', text };
    yield { type: 'done', usage, model, text, stopReason };
    return;
  }

  const usage = { input: 0, output: 0 };
  let model = req.model;
  let text = '';
  let completed = false;
  let stopReason = null;

  try {
    frames: for await (const data of sseFrames(res.body, keepAlive)) {
      if (req.protocol === 'openai' && data === '[DONE]') {
        completed = true;
        break;
      }
      let event;
      try {
        event = JSON.parse(data);
      } catch {
        continue; // heartbeats and other non-JSON payloads
      }

      if (req.protocol === 'anthropic') {
        switch (event?.type) {
          case 'message_start':
            if (typeof event.message?.model === 'string') model = event.message.model;
            usage.input = num(event.message?.usage?.input_tokens) || usage.input;
            usage.output = num(event.message?.usage?.output_tokens) || usage.output;
            break;
          case 'content_block_delta': {
            const piece = event.delta?.type === 'text_delta' ? event.delta.text : '';
            if (typeof piece === 'string' && piece) {
              text += piece;
              yield { type: 'delta', text: piece };
            }
            break;
          }
          case 'message_delta':
            if (event.usage?.input_tokens != null) usage.input = num(event.usage.input_tokens);
            if (event.usage?.output_tokens != null) usage.output = num(event.usage.output_tokens);
            if (typeof event.delta?.stop_reason === 'string' && event.delta.stop_reason) {
              completed = true;
              stopReason = normalizeStopReason('anthropic', event.delta.stop_reason);
            }
            break;
          case 'message_stop':
            completed = true;
            break frames;
          case 'error':
            throw new LLMError(
              `Model at ${req.address} failed mid-stream: ${midStreamDetail(req, event.error?.message)}`,
              { address: req.address, retriable: true },
            );
          default:
            break;
        }
        continue;
      }

      if (event?.error) {
        throw new LLMError(
          `Model at ${req.address} failed mid-stream: ${midStreamDetail(req, event.error?.message)}`,
          { address: req.address, retriable: true },
        );
      }
      if (typeof event?.model === 'string') model = event.model;
      const choice = Array.isArray(event?.choices) ? event.choices[0] : null;
      if (typeof choice?.finish_reason === 'string' && choice.finish_reason) {
        completed = true;
        stopReason = normalizeStopReason('openai', choice.finish_reason);
      }
      const piece = textOf(choice?.delta?.content);
      if (piece) {
        text += piece;
        yield { type: 'delta', text: piece };
      }
      if (event?.usage) {
        usage.input = num(event.usage.prompt_tokens) || usage.input;
        usage.output = num(event.usage.completion_tokens) || usage.output;
      }
    }
  } catch (err) {
    if (opts.signal?.aborted) throw abortLLMError(req.address);
    if (err instanceof LLMError) throw err;
    throw transportError(err, req.address);
  } finally {
    release();
  }

  // EOF alone does not mean the provider finished the answer. Accept either
  // its final reason or its terminal frame: compatible runtimes may omit the
  // latter, while OpenAI usage can arrive after the finish_reason frame.
  if (!completed) {
    throw new LLMError(`Model at ${req.address} ended before the answer was complete — try again`, {
      address: req.address,
      retriable: true,
    });
  }
  yield { type: 'done', usage, model, text, stopReason };
}

/* ------------------------------------------------------------------ *
 * Discovery
 * ------------------------------------------------------------------ */

function modelRows(raw) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.data)) return raw.data;
  if (Array.isArray(raw?.models)) return raw.models;
  return [];
}

/**
 * GET the endpoint's model catalogue. -> [{id, label}]
 * `retries` and `timeoutMs` are accepted so probeLocal can make it fail fast.
 */
export async function listModels({
  protocol = 'openai',
  baseUrl,
  apiKey,
  signal,
  timeoutMs,
  retries = 1,
} = {}) {
  const address = normalizeBase(baseUrl);
  const proto = requireProtocol(protocol, address);
  if (!address) {
    throw new LLMError('No model baseUrl configured — pick a provider in Settings', {
      address: null,
    });
  }
  const key = requireKey(apiKey, address);
  const url =
    proto === 'anthropic'
      ? `${anthropicPath(address, 'models')}?limit=1000` // default page size is small
      : `${address}/models`;

  const req = {
    url,
    method: 'GET',
    headers: authHeaders(proto, key),
    body: undefined,
    address,
    protocol: proto,
  };
  const { res, release } = await requestWithRetry(req, { signal, timeoutMs, retries });
  let raw;
  try {
    raw = await readJson(res, address);
  } finally {
    release();
  }

  // The same blind spot complete() had, on the same helper. A GET /models that
  // answers 200 with `{"error":{…}}` — a key that is not entitled to the
  // catalogue, an account with no credit, an aggregator refusing the route —
  // carries no `data` and no `models`, so modelRows() finds nothing and this
  // returns []. Downstream, `ui/views/settings.js:278` renders that as
  // "0 models available." beside an empty dropdown: the reason the provider
  // gave is discarded on the way past, and the reader is told the endpoint has
  // no models rather than that it refused to say. Every caller of this function
  // already handles a throw and shows the message — Settings at
  // `ui/views/settings.js:285`, doctor at `core/doctor.mjs:531`, and
  // `probeLocal` deliberately swallows it, which is correct there because
  // "nothing on this port" is its normal answer.
  const bodyError = errorInBody(raw);
  if (bodyError) {
    const detail = withoutCredentials(bodyError, credentialsIn(req.headers));
    throw new LLMError(
      `Model catalogue at ${address} returned a success status with an error body: ${screenedDetail(detail).slice(0, ERROR_DETAIL_CHARS)}`,
      { address, retriable: false },
    );
  }

  const seen = new Set();
  const out = [];
  for (const row of modelRows(raw)) {
    const id = typeof row === 'string' ? row : row?.id || row?.name || row?.model;
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    seen.add(id);
    const display = typeof row === 'object' && row ? row.display_name : null;
    out.push({ id, label: typeof display === 'string' && display ? display : id });
  }
  return out;
}

/**
 * Look for model runtimes already running on this machine. Failures are silent
 * by design: "nothing found" is the normal answer, not an error.
 * -> [{label, baseUrl, protocol:'openai', models:[{id,label}]}]
 */
export async function probeLocal({
  signal,
  targets = DEFAULT_PROBE_TARGETS,
  timeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  const found = await Promise.all(
    targets.map(async (target) => {
      try {
        const models = await listModels({
          protocol: 'openai',
          baseUrl: target.baseUrl,
          signal,
          timeoutMs,
          retries: 0,
        });
        return { label: target.label, baseUrl: target.baseUrl, protocol: 'openai', models };
      } catch {
        return null;
      }
    }),
  );
  return found.filter(Boolean);
}

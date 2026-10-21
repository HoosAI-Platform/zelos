/** Stored reading results, shared by the board and connection settings. */
import { el, button, meander } from './dom.js';
import { state, timezone, startSweep } from './store.js';
import { formatDay, formatTime, toZonedISO } from './time.js';

export function connectionRoute({ configKey, id }) {
  return `#/settings/${configKey}/${encodeURIComponent(id)}`;
}

export function parseConnectionTarget(segment) {
  try { return segment ? decodeURIComponent(segment) : null; }
  catch { return null; }
}

/** Availability is checked again at activation, since a cooldown or another
 * check can start while a Settings card is still on screen. */
export function connectionCheckState(report, now = Date.now()) {
  if (!report?.enabled) return { disabled: true, reason: 'Enable this connection before checking it.' };
  if (state.sweep.running) return { disabled: true, reason: 'A check is already running.' };
  if (Date.parse(report.retryAt) > now) return { disabled: true, reason: `This connection can retry after ${when(report.retryAt)}.` };
  return { disabled: false, reason: 'Checks all enabled connections, then assesses new information when needed. Connection waiting times still apply.' };
}

export function connectionRecovery(id, configKey) {
  const current = () => sourceStatuses().find(row => row.id === id && row.configKey === configKey);
  const note = el('p', { class: 'quiet-note' });
  const check = button('Check all connections', {
    class: 'btn quiet',
    onClick: async () => {
      paint();
      if (connectionCheckState(current()).disabled) return;
      await startSweep('auto');
      paint();
    },
  });
  function paint() {
    const availability = connectionCheckState(current());
    check.disabled = availability.disabled;
    note.textContent = availability.reason;
  }
  paint();
  const retryIn = Date.parse(current()?.retryAt) - Date.now();
  if (retryIn > 0 && retryIn < 2_147_483_647) setTimeout(() => { if (check.isConnected) paint(); }, retryIn + 1);
  return el('div', { class: 'connection-recovery' }, [
    el('p', { class: 'quiet-note', text: configKey === 'sources'
      ? 'Use Edit to update this connection, then check again.'
      : 'Use Edit to update sign-in details or test this connection, then check again.' }),
    check, note,
  ]);
}

/** Configuration is not evidence that credentials work. A successful source
 * read has its own stored timestamp; choosing an AI has no equivalent test
 * record, so this checklist never calls it verified. */
export function setupStatus(navigate) {
  const reports = sourceStatuses();
  const chosen = state.health?.model?.configured === true;
  return el('details', { class: 'setup-status' }, [
    el('summary', { text: 'Setup status' }),
    el('ul', { class: 'setup-status-list' }, [
      el('li', {}, [
        el('span', { text: chosen ? 'AI chosen. Open AI settings to test it.' : 'Choose an AI to assess what your connections read.' }),
        button('AI settings', { class: 'btn quiet', onClick: () => navigate('#/settings/model') }),
      ]),
      ...reports.map(report => el('li', {}, [
        el('span', { text: `${report.label}: ${!report.enabled ? 'paused' : report.ok === false ? 'needs attention' : report.lastSuccessAt ? 'has a successful read on record' : report.unknown ? 'configured; reading status unavailable' : 'configured; no successful read recorded'}.` }),
        button('Review', { class: 'btn quiet', 'aria-label': `Review ${report.label}`, onClick: () => navigate(connectionRoute(report)) }),
      ])),
      !reports.length ? el('li', {}, [
        el('span', { text: 'No connections configured yet.' }),
        button('Add a connection', { class: 'btn quiet', onClick: () => navigate('#/settings/mail') }),
      ]) : null,
    ]),
  ]);
}

export function sourceStatuses() {
  const reports = Array.isArray(state.board.sourceStatus) ? state.board.sourceStatus : null;
  const last = state.board.runs?.last;
  return ['mail', 'calendars', 'sources'].flatMap(configKey => (state.config?.[configKey] || []).map(source => {
    const kind = configKey === 'mail' ? 'mail' : configKey === 'calendars' ? 'calendar' : source.type;
    const current = reports?.find(row => row.id === source.id && row.configKey === configKey);
    // Older servers expose only the latest check. A missing result is unknown,
    // never evidence that the source was read or that it has never been read.
    const entries = (last?.stats?.sources || []).filter(row => row.id === source.id && row.kind === kind);
    const ok = entries.length ? entries.every(row => row.ok === true) : null;
    const attempted = entries.length ? last.ended_at || last.started_at || null : null;
    return {
      id: source.id, kind, configKey, ok,
      lastAttemptAt: attempted,
      lastSuccessAt: ok === true ? attempted : null,
      error: entries.filter(row => row.ok === false).map(row => row.error).filter(Boolean).join(' · ') || null,
      ...(current || {}),
      enabled: source.enabled !== false,
      label: source.label || current?.label || source.user || kind || 'Connection',
      unknown: !reports && !entries.length,
    };
  }));
}

function when(iso) {
  const stamp = Date.parse(iso);
  if (!Number.isFinite(stamp)) return null;
  const zoned = toZonedISO(new Date(stamp), timezone());
  return `${formatDay(zoned)}, ${zoned.slice(0, 4)} · ${formatTime(zoned)}`;
}

function reportNode(report) {
  const paused = !report.enabled;
  const title = paused ? 'Paused'
    : report.ok === false ? 'Needs attention'
      : report.ok === true ? 'Read successfully'
        : report.unknown ? 'No reading result available' : 'Not checked yet';
  const success = when(report.lastSuccessAt);
  const attempted = when(report.lastAttemptAt);
  const retry = when(report.retryAt);
  return el('div', { class: 'source-status' }, [
    el('p', { class: `quiet-note${!paused && report.ok === false ? ' is-bad' : ''}`, text: title }),
    !paused && !success ? el('p', { class: 'quiet-note', text: report.unknown
      ? 'Connection configured. Reading status is unavailable.'
      : 'Settings saved. A successful read has not been recorded yet.' }) : null,
    success ? el('p', { class: 'quiet-note', text: `Last successful read: ${success}` })
      : !paused && report.ok === false ? el('p', { class: 'quiet-note', text: 'No successful read time recorded.' }) : null,
    !paused && report.ok === false && attempted ? el('p', { class: 'quiet-note', text: `Last tried: ${attempted}` }) : null,
    !paused && report.ok === false && report.error ? el('p', { class: 'quiet-note', text: report.error }) : null,
    !paused && retry ? el('p', { class: 'quiet-note', text: `Can retry after: ${retry}` }) : null,
  ]);
}

export function sourceStatusLine(id, configKey) {
  const report = sourceStatuses().find(row => row.id === id && row.configKey === configKey);
  return report ? reportNode(report) : null;
}

export function readingStatus(navigate) {
  const reports = sourceStatuses();
  if (!reports.length) return null;
  const failed = reports.filter(row => row.enabled && row.ok === false).length;
  const panel = el('div', { class: 'worth-body', hidden: !failed }, el('div', { class: 'stack' }, reports.map(report =>
    el('article', { class: 'account' }, [
      el('h2', { class: 'account-label', text: report.label }),
      reportNode(report),
      button(report.enabled && report.ok === false ? 'Review connection' : 'Connection settings', {
        class: 'btn quiet',
        'aria-label': `${report.enabled && report.ok === false ? 'Review connection' : 'Connection settings'}: ${report.label}`,
        onClick: () => navigate(connectionRoute(report)),
      }),
    ]))));
  const toggle = el('button', {
    type: 'button', class: 'worth-toggle', 'aria-expanded': failed ? 'true' : 'false',
    onclick() {
      const open = this.getAttribute('aria-expanded') === 'true';
      this.setAttribute('aria-expanded', open ? 'false' : 'true');
      panel.hidden = open;
    },
  }, [
    el('span', { text: 'Reading status' }),
    el('span', { class: 'mono worth-count', text: failed ? `${failed} ${failed === 1 ? 'needs' : 'need'} attention` : String(reports.length) }),
  ]);
  return el('section', { class: 'section worth' }, [toggle, meander(), panel]);
}

// Every route off the machine the shell is meant to close, each aimed at a
// listener of its own so the check can tell which got through.
(async () => {
  if (document.readyState === 'loading') await new Promise((r) => document.addEventListener('DOMContentLoaded', r));
  const probe = (window.__probe = { tried: 0, errors: [] });
  const spec = JSON.parse(new URLSearchParams(location.search).get('spec'));

  const frame = document.createElement('iframe');
  frame.src = '/frame.html';
  document.body.appendChild(frame);
  await new Promise((r) => frame.addEventListener('load', r));

  // dns-prefetch: a lookup CSP does not govern.
  const prefetch = document.createElement('link');
  prefetch.rel = 'dns-prefetch';
  prefetch.href = `//prefetch.${spec.canary}`;
  document.head.appendChild(prefetch);

  const gathered = [];
  function peer(PC, urls) {
    probe.tried += 1;
    try {
      const pc = new PC({ iceServers: [{ urls, username: 'u', credential: 'p' }], iceTransportPolicy: 'all' });
      pc.createDataChannel('x');
      gathered.push(new Promise((resolve) => {
        pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') resolve(); });
        setTimeout(resolve, 20_000);
      }));
      pc.createOffer().then((offer) => pc.setLocalDescription(offer)).catch((err) => probe.errors.push(`${urls}: ${err.name}`));
    } catch (err) {
      probe.errors.push(`${urls}: ${err.name}`);
    }
  }

  const top = window.RTCPeerConnection;
  const inner = frame.contentWindow.RTCPeerConnection;
  for (const { key, host, port } of spec.routes) {
    if (key === 'turn-tcp') peer(top, `turn:${host}:${port}?transport=tcp`);
    if (key === 'turns') peer(top, `turns:${host}:${port}?transport=tcp`);
    if (key === 'turn-tcp-iframe') peer(inner, `turn:${host}:${port}?transport=tcp`);
    if (key === 'turn-localhost') peer(top, `turn:localhost:${port}?transport=tcp`);
    if (key === 'turn-udp') peer(top, `turn:${host}:${port}?transport=udp`);
    if (key === 'stun') peer(top, `stun:${host}:${port}`);
    if (key === 'webtransport') {
      probe.tried += 1;
      if (typeof WebTransport !== 'function') { probe.errors.push('webtransport: not available'); continue; }
      try { new WebTransport(`https://${host}:${port}/`).closed.catch(() => {}); } catch (err) { probe.errors.push(`webtransport: ${err.name}`); }
    }
  }
  // A TURN hostname: the lookup is the leak, whatever happens after it.
  peer(top, `turn:turn.${spec.canary}:3478?transport=tcp`);

  await Promise.all(gathered);
  window.__probeDone = true;
})();

// Every route off the machine the shell is meant to close, tried at once.
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

  const servers = [];
  for (const { host, port } of spec.targets) {
    servers.push(`turn:${host}:${port}?transport=tcp`, `turn:${host}:${port}?transport=udp`, `turns:${host}:${port}?transport=tcp`, `stun:${host}:${port}`);
  }
  for (const name of spec.hostnames) servers.push(`turn:${name}:${spec.targets[0].port}?transport=tcp`);
  servers.push(`turn:turn.${spec.canary}:3478?transport=tcp`);

  const gathered = [];
  for (const PC of [window.RTCPeerConnection, frame.contentWindow.RTCPeerConnection]) {
    for (const urls of servers) {
      for (const iceTransportPolicy of ['relay', 'all']) {
        probe.tried += 1;
        try {
          const pc = new PC({ iceServers: [{ urls, username: 'u', credential: 'p' }], iceTransportPolicy });
          pc.createDataChannel('x');
          gathered.push(new Promise((resolve) => {
            pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') resolve(); });
            setTimeout(resolve, 20_000);
          }));
          await pc.setLocalDescription(await pc.createOffer());
        } catch (err) {
          probe.errors.push(`${urls}: ${err.name}`);
        }
      }
    }
  }

  // WebTransport: not a request, and it reached the network past the guard.
  if (typeof WebTransport === 'function') {
    for (const { host, port } of spec.targets) {
      probe.tried += 1;
      try { new WebTransport(`https://${host}:${port}/`).closed.catch(() => {}); } catch (err) { probe.errors.push(`webtransport: ${err.name}`); }
    }
  }

  await Promise.all(gathered);
  window.__probeDone = true;
})();

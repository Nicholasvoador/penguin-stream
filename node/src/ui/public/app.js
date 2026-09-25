/* penguin-stream local UI. No framework, no network dependencies. */

const token = new URLSearchParams(location.hash.slice(1)).get('token') || sessionStorage.getItem('ps-ui-token') || '';
if (token) sessionStorage.setItem('ps-ui-token', token);
history.replaceState(null, '', location.pathname);
const $ = (id) => document.getElementById(id);

async function api(path, body) {
  const res = await fetch(`/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

const views = ['idle', 'connect', 'hosting', 'viewing'];
function showView(name) {
  for (const v of views) $(`view-${v}`).hidden = v !== name;
}

function advancedOptions() {
  const display = $('opt-display').value.trim();
  return {
    fps: Number($('opt-fps').value),
    bitrate: Number($('opt-bitrate').value),
    encoder: $('opt-encoder').value || undefined,
    source: $('opt-source').value || undefined,
    display: /^[0-9]{1,2}$/.test(display) ? display : undefined,
    lowLatency: $('opt-low-latency').checked,
    audio: $('opt-audio').checked,
    forceRelay: $('opt-force-relay').checked,
    noStun: $('opt-no-stun').checked,
    stun: $('opt-stun').value.trim() || undefined,
    rendezvous: $('opt-rendezvous').value.trim() || undefined,
    turn: $('opt-turn').value.trim() || undefined,
    turnUser: $('opt-turn-user').value.trim() || undefined,
    turnPassword: $('opt-turn-password').value || undefined,
  };
}

function renderSasWords(el, phrase) {
  el.textContent = '';
  for (const word of String(phrase || '').split(/\s+/).filter(Boolean)) {
    const span = document.createElement('span');
    span.className = 'word';
    span.textContent = word;
    el.appendChild(span);
  }
}

function updateMetricsGrid(prefix, state) {
  const t = state.transport;
  const s = state.stats || {};
  const cfg = state.mediaConfig;
  const elRoute = $(`${prefix}-metric-route`);
  const elRtt = $(`${prefix}-metric-rtt`);
  const elVideo = $(`${prefix}-metric-video`);
  const elFrames = $(`${prefix}-metric-frames`);
  const grid = $(`${prefix}-metrics`);

  if (!t && !cfg && !s.framesSent && !s.framesShown) {
    grid.hidden = true;
    return;
  }
  grid.hidden = false;

  if (t) {
    elRoute.innerHTML = t.relayed
      ? '<span class="badge relayed">🟡 Relayed (TURN)</span>'
      : '<span class="badge direct">🟢 Direct P2P (UDP)</span>';
    const rtt = t.rttMs !== undefined && t.rttMs >= 0 ? `${t.rttMs.toFixed(1)} ms` : (s.rtt ? `${Number(s.rtt).toFixed(1)} ms` : 'Direct LAN (<1 ms)');
    elRtt.textContent = `⚡ ${rtt}`;
  } else {
    elRoute.textContent = 'Connecting…';
    elRtt.textContent = '—';
  }

  if (cfg) {
    const fpsStr = s.fps ? ` @ ${Number(s.fps).toFixed(0)} FPS` : '';
    elVideo.textContent = `${cfg.width}×${cfg.height}${fpsStr} (${cfg.encoder || 'H.264'})`;
  } else {
    elVideo.textContent = '—';
  }

  if (prefix === 'host') {
    const sent = s.framesSent ?? 0;
    const dropped = s.dropped ?? 0;
    const mb = s.bytesSent ? (s.bytesSent / (1024 * 1024)).toFixed(1) + ' MB' : '';
    elFrames.textContent = `${sent} sent${dropped ? ` (${dropped} dropped)` : ''}${mb ? ` · ${mb}` : ''}`;
  } else {
    const shown = s.framesShown ?? 0;
    const mb = s.bytesReceived ? (s.bytesReceived / (1024 * 1024)).toFixed(1) + ' MB' : '';
    elFrames.textContent = `${shown} displayed${mb ? ` · ${mb}` : ''}`;
  }
}

const VIGEM_URL = 'https://github.com/nefarius/ViGEmBus/releases/latest';

function statusLine(el, parts) {
  el.textContent = '';
  for (const part of parts) {
    if (!part) continue;
    const line = document.createElement('div');
    if (part.warn) line.className = 'warn';
    line.textContent = part.text;
    if (part.link) {
      const a = document.createElement('a');
      a.href = part.link;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = part.linkText || part.link;
      line.append(' ', a);
    }
    el.appendChild(line);
  }
}

function renderInput(state) {
  // Host: live permissions and what the machine can actually do.
  const perm = state.permissions || { kbm: false, pad: false };
  $('live-allow-kbm').checked = perm.kbm;
  $('live-allow-pad').checked = perm.pad;
  const st = state.inputStatus;
  const hostParts = [];
  if (st) {
    if (perm.kbm && !st.kbmReady) {
      hostParts.push({ warn: true, text: 'Keyboard & mouse cannot be controlled on this machine right now ' +
        '(on Wayland, allow "remote control" in the screen-sharing prompt; restart sharing to be asked again).' });
    }
    if (perm.pad && !st.padReady) {
      const vigem = /vigem/i.test(st.padError || '');
      hostParts.push({ warn: true, text: `Controllers unavailable: ${st.padError || 'unknown reason'}`,
        link: vigem ? VIGEM_URL : undefined, linkText: vigem ? 'Install ViGEmBus' : undefined });
    } else if (perm.pad && st.pads) {
      hostParts.push({ text: `${st.pads} virtual controller${st.pads === 1 ? '' : 's'} connected (${st.padBackend})` });
    }
  }
  if (state.remoteViewer) {
    hostParts.push({ text: `Viewer is sending: keyboard & mouse ${state.remoteViewer.kbm ? 'on' : 'off'}, ` +
      `controllers ${state.remoteViewer.pad ? `on (${state.remoteViewer.pads})` : 'off'}` });
  }
  statusLine($('host-input-status'), hostParts);

  // Viewer: local switches and what the host allows.
  const vs = state.viewerState;
  $('live-send-kbm').checked = vs ? vs.kbm : $('view-send-kbm').checked;
  $('live-send-pad').checked = vs ? vs.pad : $('view-send-pad').checked;
  $('live-capture').checked = vs ? vs.capture : false;
  $('live-capture').disabled = !(vs ? vs.kbm : true);
  $('viewer-pad-count').textContent = vs && vs.pads ? `(${vs.pads} connected)` : '';
  const hp = state.hostPermissions;
  const viewerParts = [];
  if (hp) {
    const kbm = hp.kbm ? (hp.kbmReady ? 'allowed' : 'allowed, but unavailable on the host') : 'not allowed by the host';
    const pad = hp.pad ? (hp.padReady ? 'allowed' : `allowed, but unavailable on the host (${hp.padError || 'unknown'})`)
      : 'not allowed by the host';
    viewerParts.push({ text: `Keyboard & mouse: ${kbm}` });
    viewerParts.push({ text: `Controllers: ${pad}`, warn: hp.pad && !hp.padReady });
  }
  statusLine($('viewer-input-status'), viewerParts);
}

function render(state) {
  $('device').textContent = `${state.identity.label} · ${state.identity.fingerprint}`;
  renderInput(state);

  const peers = $('peer-list');
  peers.textContent = '';
  if (!state.peers.length) {
    const li = document.createElement('li');
    li.className = 'dim';
    li.textContent = 'No paired devices yet.';
    peers.appendChild(li);
  }
  for (const p of state.peers) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = `${p.label} (${p.role}) — ${p.fingerprint}`;
    const btn = document.createElement('button');
    btn.className = 'link';
    btn.textContent = 'forget';
    btn.onclick = async () => { await api('revoke', { fingerprint: p.fingerprint }); refresh(); };
    li.append(label, btn);
    peers.appendChild(li);
  }

  switch (state.mode) {
    case 'idle':
      showView('idle');
      $('host-options').hidden = false;
      break;
    case 'hosting-waiting':
    case 'hosting-consent':
    case 'hosting-live': {
      showView('hosting');
      $('host-options').hidden = true;
      $('code-display').textContent = state.code || '…';
      const s = $('host-status');
      if (state.mode === 'hosting-live') {
        const t = state.transport;
        s.textContent = t ? (t.relayed ? 'Streaming live via TURN relay' : 'Streaming live over direct peer-to-peer (UDP)') : 'Streaming live';
        s.className = 'status live';
        updateMetricsGrid('host', state);
      } else {
        s.textContent = 'Waiting for someone to connect…';
        s.className = 'status';
        $('host-metrics').hidden = true;
      }
      break;
    }
    case 'connecting':
    case 'viewing': {
      showView('viewing');
      $('host-options').hidden = true;
      $('viewing-title').textContent = state.mode === 'viewing' ? 'Connected' : 'Connecting…';
      if (state.sas) {
        $('viewer-sas').hidden = false;
        renderSasWords($('viewer-sas-words'), state.sas);
      }
      const s = $('viewer-status');
      const t = state.transport;
      if (state.mode === 'viewing') {
        s.textContent = t ? (t.relayed ? 'Connected via TURN relay' : 'Connected directly peer-to-peer (UDP)') : 'Connected';
        s.className = 'status live';
        updateMetricsGrid('viewer', state);
      } else {
        s.textContent = 'Connecting to host…';
        s.className = 'status';
        $('viewer-metrics').hidden = true;
      }
      break;
    }
    default:
      showView('idle');
  }

  if (state.pendingConsent) {
    showConsent(state.pendingConsent);
  } else {
    $('consent-overlay').hidden = true;
  }
}

function showConsent(req) {
  $('consent-fp').textContent = req.fingerprint;
  $('consent-trusted').textContent = req.trusted ? `Yes — ${req.label}` : 'No — first time seeing it';
  $('consent-transport').innerHTML = req.transport?.relayed
    ? '<span class="badge relayed">🟡 Relayed (TURN)</span>'
    : '<span class="badge direct">🟢 Direct P2P (UDP)</span>';
  renderSasWords($('consent-sas'), req.sas);
  $('consent-overlay').hidden = false;
}

async function refresh() {
  try { render(await api('state')); } catch { /* server restarting */ }
}

/* --------------------------- wiring --------------------------- */

$('btn-host').onclick = async () => {
  try {
    await api('host', {
      ...advancedOptions(),
      allowInput: $('host-allow-kbm').checked,
      allowGamepad: $('host-allow-pad').checked,
    });
  } catch (e) { alert(e.message); }
};

$('btn-connect-mode').onclick = () => {
  showView('connect');
  $('host-options').hidden = true;
  $('code-input').focus();
};

const livePermissions = async () => {
  try {
    await api('permissions', { kbm: $('live-allow-kbm').checked, pad: $('live-allow-pad').checked });
  } catch (e) { alert(e.message); refresh(); }
};
$('live-allow-kbm').onchange = livePermissions;
$('live-allow-pad').onchange = livePermissions;

const liveViewerInput = async (changed) => {
  try {
    await api('viewer-input', { [changed]: $(changed === 'kbm' ? 'live-send-kbm'
      : changed === 'pad' ? 'live-send-pad' : 'live-capture').checked });
  } catch (e) { alert(e.message); refresh(); }
};
$('live-send-kbm').onchange = () => liveViewerInput('kbm');
$('live-send-pad').onchange = () => liveViewerInput('pad');
$('live-capture').onchange = () => liveViewerInput('capture');

for (const b of document.querySelectorAll('[data-back]')) {
  b.onclick = () => { showView('idle'); $('host-options').hidden = false; };
}
for (const b of document.querySelectorAll('[data-stop]')) {
  b.onclick = async () => { await api('stop', {}); refresh(); };
}

$('copy-invitation').onclick = async () => {
  const invitation = $('code-display').textContent;
  if (!invitation || invitation === '…') return;
  try {
    await navigator.clipboard.writeText(invitation);
    $('copy-status').textContent = '✓ Copied — send privately to your guest';
    setTimeout(() => { $('copy-status').textContent = ''; }, 4000);
  } catch {
    $('copy-status').textContent = 'Select and copy invitation manually';
  }
};

$('connect-form').onsubmit = async (e) => {
  e.preventDefault();
  const code = $('code-input').value.trim();
  if (!code) return;
  try {
    await api('connect', {
      code,
      ...advancedOptions(),
      sendKbm: $('view-send-kbm').checked,
      sendPad: $('view-send-pad').checked,
    });
  } catch (err) {
    alert(err.message);
  }
};

$('consent-allow').onclick = async () => {
  $('consent-overlay').hidden = true;
  await api('consent', { approve: true });
};
$('consent-deny').onclick = async () => {
  $('consent-overlay').hidden = true;
  await api('consent', { approve: false });
};

/* --------------------------- live updates --------------------------- */

function connectWs() {
  const ws = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(token)}`);
  ws.onmessage = (ev) => {
    const { type, data } = JSON.parse(ev.data);
    if (type === 'state') render(data);
    else if (type === 'consent') showConsent(data);
    else if (type === 'stats') refresh();
    else if (type === 'log') {
      const el = $('log');
      el.textContent += `${data}
`;
      el.scrollTop = el.scrollHeight;
    }
  };
  ws.onclose = () => setTimeout(connectWs, 1500);
}

connectWs();
refresh();

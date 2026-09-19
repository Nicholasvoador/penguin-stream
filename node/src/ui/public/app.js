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
  return {
    fps: Number($('opt-fps').value),
    bitrate: Number($('opt-bitrate').value),
    encoder: $('opt-encoder').value || undefined,
    source: $('opt-source').value || undefined,
    lowLatency: $('opt-low-latency').checked,
    allowInput: $('opt-allow-input').checked,
    audio: $('opt-audio').checked,
    noInput: $('opt-no-input').checked,
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

function render(state) {
  $('device').textContent = `${state.identity.label} · ${state.identity.fingerprint}`;

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
      break;
    case 'hosting-waiting':
    case 'hosting-consent':
    case 'hosting-live': {
      showView('hosting');
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

  if (state.pendingConsent) showConsent(state.pendingConsent);
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
  try { await api('host', advancedOptions()); } catch (e) { alert(e.message); }
};

$('btn-connect-mode').onclick = () => { showView('connect'); $('code-input').focus(); };

for (const b of document.querySelectorAll('[data-back]')) b.onclick = () => showView('idle');
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
    await api('connect', { code, ...advancedOptions() });
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

/* penguin-stream local UI. No framework, no network dependencies. */

const token = new URLSearchParams(location.hash.slice(1)).get('token') || sessionStorage.getItem('ps-ui-token') || '';
if (token) sessionStorage.setItem('ps-ui-token', token);
history.replaceState(null, '', location.pathname);
const $ = (id) => document.getElementById(id);

async function api(path, body, method) {
  const res = await fetch(`/api/${path}`, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(text, error = false) {
  const el = $('toast');
  el.textContent = text;
  el.className = `toast${error ? ' error' : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, error ? 7000 : 3500);
}

/* ------------------------------ navigation ------------------------------ */

const TITLES = {
  home: 'Home', connect: 'Connect', hosting: 'Sharing your screen', viewing: 'Remote desktop',
  settings: 'Settings', devices: 'Devices', network: 'Network', log: 'Activity',
};
let page = 'home';
let lastState = null;

function sessionPage(state = lastState) {
  if (!state) return null;
  if (state.mode.startsWith('hosting')) return 'hosting';
  if (state.mode === 'connecting' || state.mode === 'viewing') return 'viewing';
  return null;
}

function go(name) {
  if (name === 'session') name = sessionPage() || 'home';
  // While a session runs, "Home" and "Connect" lead back to it.
  if ((name === 'home' || name === 'connect') && sessionPage()) name = sessionPage();
  page = name;
  for (const el of document.querySelectorAll('.page')) el.classList.toggle('active', el.id === `page-${name}`);
  const navKey = name === 'hosting' || name === 'viewing' ? 'session' : name === 'connect' ? 'home' : name;
  for (const b of document.querySelectorAll('.nav-item')) b.classList.toggle('active', b.dataset.page === navKey);
  $('page-title').textContent = TITLES[name] || '';
  if (name === 'network' && !netResult) runNetcheck();
}
for (const b of document.querySelectorAll('.nav-item')) b.onclick = () => go(b.dataset.page);
$('net-mini').onclick = () => go('network');

/* ------------------------------ settings ------------------------------ */

let settings = null;
let saveTimer;

function applySettingsToForm(s) {
  for (const el of document.querySelectorAll('[data-setting]')) {
    const v = s[el.dataset.setting];
    if (el.type === 'checkbox') el.checked = Boolean(v);
    else if (el.tagName === 'SELECT') {
      const want = String(v ?? '');
      if (![...el.options].some((o) => o.value === want)) el.add(new Option(want, want));
      el.value = want;
    } else el.value = v ?? '';
  }
  const r = s.relay;
  setRelayMode(r.mode);
  $('relay-cf-key').value = r.cfKeyId || '';
  $('relay-url').value = r.url || '';
  $('relay-turn').value = r.turn || '';
  $('relay-turn-user').value = r.turnUser || '';
  $('relay-cf-token').placeholder = r.cfTokenSet ? '•••••••• saved' : '';
  $('relay-turn-password').placeholder = r.turnPasswordSet ? '•••••••• saved' : '';
}

function readSetting(el) {
  if (el.type === 'checkbox') return el.checked;
  if (el.dataset.type === 'int') return Number(el.value);
  return el.value.trim();
}

async function saveSettings(patch) {
  try {
    settings = await api('settings', patch);
    $('settings-saved').textContent = 'Saved ✓';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { $('settings-saved').textContent = 'Saved automatically'; }, 1600);
  } catch (e) { toast(`Could not save settings: ${e.message}`, true); }
}

for (const el of document.querySelectorAll('[data-setting]')) {
  const handler = () => saveSettings({ [el.dataset.setting]: readSetting(el) });
  el.addEventListener(el.tagName === 'INPUT' && el.type !== 'checkbox' ? 'change' : 'input', handler);
}

/* relay */
let relayMode = 'none';
function setRelayMode(mode) {
  relayMode = mode || 'none';
  for (const b of $('relay-mode').querySelectorAll('button')) b.classList.toggle('active', b.dataset.mode === relayMode);
  for (const p of document.querySelectorAll('.relay-pane')) p.classList.toggle('active', p.dataset.pane === relayMode);
}
for (const b of $('relay-mode').querySelectorAll('button')) b.onclick = () => setRelayMode(b.dataset.mode);

$('relay-save').onclick = async () => {
  const relay = { mode: relayMode };
  if (relayMode === 'cloudflare') {
    relay.cfKeyId = $('relay-cf-key').value.trim();
    if ($('relay-cf-token').value) relay.cfToken = $('relay-cf-token').value.trim();
  } else if (relayMode === 'url') {
    relay.url = $('relay-url').value.trim();
  } else if (relayMode === 'manual') {
    relay.turn = $('relay-turn').value.trim();
    relay.turnUser = $('relay-turn-user').value.trim();
    if ($('relay-turn-password').value) relay.turnPassword = $('relay-turn-password').value;
  }
  const btn = $('relay-save');
  btn.disabled = true;
  $('relay-result').textContent = relayMode === 'none' ? '' : 'Testing relay…';
  try {
    settings = await api('settings', { relay });
    applySettingsToForm(settings);
    $('relay-cf-token').value = '';
    $('relay-turn-password').value = '';
    const r = await runNetcheck();
    if (relayMode === 'none') $('relay-result').textContent = 'Relay off.';
    else if (r?.relay?.ok) $('relay-result').textContent = `✓ Relay works (${r.relay.server}, ${r.relay.rttMs} ms)`;
    else $('relay-result').textContent = `✗ ${r?.relay?.error || 'relay test failed'}`;
  } catch (e) {
    $('relay-result').textContent = `✗ ${e.message}`;
  } finally {
    btn.disabled = false;
  }
};

/* ------------------------------ network check ------------------------------ */

let netResult = null;
let netRunning = null;
function renderNet(r) {
  const mini = $('net-mini');
  mini.className = `net-mini ${r.verdict.level}`;
  mini.querySelector('span').textContent = r.verdict.level === 'good' ? 'Network ready'
    : r.verdict.level === 'ok' ? 'Network: limited' : 'Network: needs relay';
  const v = $('net-verdict');
  v.className = `verdict ${r.verdict.level}`;
  v.textContent = r.verdict.text;
  $('net-v4').textContent = r.v4.ok ? `${r.v4.publicAddress} · ${r.v4.rttMs} ms` : 'unavailable';
  $('net-nat').textContent = !r.v4.ok ? '—' : !r.v4.natted ? 'None (public IP)'
    : r.v4.mapping === 'endpoint-independent' ? 'Endpoint-independent ✓' : r.v4.mapping === 'symmetric' ? 'Symmetric (strict)' : 'Unknown';
  $('net-v6').textContent = r.v6.ok ? 'Available ✓' : 'Not available';
  $('net-relay').textContent = !r.relay.configured ? 'Not configured'
    : r.relay.ok ? `${r.relay.name} ✓ ${r.relay.rttMs} ms` : `${r.relay.name}: failed`;
}
function runNetcheck() {
  if (netRunning) return netRunning;
  $('netcheck-run').disabled = true;
  $('net-verdict').textContent = 'Checking…';
  netRunning = api('netcheck', {})
    .then((r) => { netResult = r; renderNet(r); return r; })
    .catch((e) => { $('net-verdict').textContent = `Check failed: ${e.message}`; return null; })
    .finally(() => { netRunning = null; $('netcheck-run').disabled = false; });
  return netRunning;
}
$('netcheck-run').onclick = () => runNetcheck();

/* ------------------------------ rendering ------------------------------ */

function renderSasWords(el, phrase) {
  el.textContent = '';
  for (const word of String(phrase || '').split(/\s+/).filter(Boolean)) {
    const span = document.createElement('span');
    span.className = 'word';
    span.textContent = word;
    el.appendChild(span);
  }
}

function routeBadge(el, t) {
  el.textContent = '';
  const span = document.createElement('span');
  span.className = `badge${t.relayed ? ' relayed' : ''}`;
  span.textContent = t.relayed ? 'Relayed' : t.localType === 'host' && t.remoteType === 'host' ? 'Direct · LAN' : 'Direct P2P';
  el.appendChild(span);
}

const rate = { host: null, viewer: null };
function renderMetrics(prefix, state) {
  const t = state.transport?.connected !== false ? state.transport : null;
  const live = { ...(state.stats?.transport || {}), ...(t || {}) };
  const s = state.stats || {};
  const cfg = state.mediaConfig;
  if (!t && !cfg && !s.framesSent && !s.framesShown) { $(`${prefix}-metrics`).hidden = true; return; }
  $(`${prefix}-metrics`).hidden = false;

  if (live.connected || t) routeBadge($(`${prefix}-metric-route`), live);
  const rtt = s.transport?.rttMs ?? t?.rttMs;
  $(`${prefix}-metric-rtt`).textContent = Number.isFinite(rtt) ? `${Math.round(rtt)} ms` : '—';
  $(`${prefix}-metric-video`).textContent = cfg
    ? `${cfg.width}×${cfg.height}${s.fps ? ` · ${Math.round(s.fps)} fps` : ''}` : '—';

  const bytes = prefix === 'host' ? s.bytesSent : s.bytesReceived;
  const now = performance.now();
  const prev = rate[prefix];
  if (Number.isFinite(bytes)) {
    if (prev && bytes >= prev.bytes && now - prev.t > 500) {
      const mbps = ((bytes - prev.bytes) * 8) / ((now - prev.t) / 1000) / 1e6;
      $(`${prefix}-metric-rate`).textContent = `${mbps.toFixed(1)} Mbps`;
      rate[prefix] = { bytes, t: now };
    } else if (!prev || bytes < prev.bytes) rate[prefix] = { bytes, t: now };
  }
  $(`${prefix}-metric-frames`).textContent = prefix === 'host'
    ? `${s.framesSent ?? 0}${s.dropped ? ` · ${s.dropped} skipped` : ''}`
    : `${s.framesShown ?? 0}${s.lost ? ` · ${s.lost} lost` : ''}`;
}

const VIGEM_URL = 'https://github.com/nefarius/ViGEmBus/releases/latest';
function statusLines(el, parts) {
  el.textContent = '';
  for (const part of parts.filter(Boolean)) {
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
  statusLines($('host-input-status'), hostParts);

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
    viewerParts.push({ text: `Keyboard & mouse: ${kbm}`, warn: !hp.kbm || !hp.kbmReady });
    viewerParts.push({ text: `Controllers: ${pad}`, warn: hp.pad && !hp.padReady });
  }
  statusLines($('viewer-input-status'), viewerParts);
}

function setPill(text, cls = '') {
  const p = $('status-pill');
  p.className = `pill ${cls}`;
  p.querySelector('span').textContent = text;
}

function setSteps(current) {
  const order = ['invite', 'verify', 'live'];
  const idx = order.indexOf(current);
  for (const el of $('host-steps').querySelectorAll('.step')) {
    const i = order.indexOf(el.dataset.step);
    el.className = `step${i < idx ? ' done' : i === idx ? ' current' : ''}`;
  }
}

function renderDevices(state) {
  const kv = $('this-device');
  kv.textContent = '';
  const rows = [['Name', state.identity.label], ['Fingerprint', state.identity.fingerprint],
    ['System', state.platform === 'win32' ? 'Windows' : state.platform === 'linux' ? 'Linux' : state.platform],
    ['Version', state.version || '—']];
  for (const [k, v] of rows) {
    const a = document.createElement('div'); a.className = 'k'; a.textContent = k;
    const b = document.createElement('div'); b.className = 'v'; b.textContent = v;
    kv.append(a, b);
  }
  const list = $('peer-list');
  list.textContent = '';
  if (!state.peers.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'No paired devices yet. Devices you approve appear here.';
    list.appendChild(li);
  }
  for (const p of state.peers) {
    const li = document.createElement('li');
    const label = document.createElement('div');
    const name = document.createElement('b');
    name.textContent = `${p.label} (${p.role})`;
    const fp = document.createElement('span');
    fp.className = 'fp';
    fp.textContent = p.fingerprint;
    label.append(name, fp);
    const btn = document.createElement('button');
    btn.className = 'btn ghost';
    btn.textContent = 'Forget';
    btn.onclick = async () => { await api('revoke', { fingerprint: p.fingerprint }).catch((e) => toast(e.message, true)); refresh(); };
    li.append(label, btn);
    list.appendChild(li);
  }
}

function render(state, statsOnly = false) {
  const before = sessionPage();
  lastState = state;
  $('device').textContent = `${state.identity.label} · ${state.identity.fingerprint}`;
  if (state.version) $('version').textContent = `v${state.version}`;
  renderInput(state);
  if (!statsOnly) renderDevices(state);

  const sp = sessionPage(state);
  $('nav-session').hidden = !sp;
  if (sp && sp !== before) go(sp);                                   // session started
  if (!sp && before && (page === 'hosting' || page === 'viewing')) { // session ended
    rate.host = rate.viewer = null;
    go('home');
  }

  switch (state.mode) {
    case 'hosting-waiting':
    case 'hosting-consent':
    case 'hosting-live': {
      $('code-display').textContent = state.code || 'Preparing invitation…';
      const s = $('host-status');
      if (state.mode === 'hosting-live') {
        const t = state.transport || state.stats?.transport;
        s.textContent = t?.relayed ? 'Live — streaming through your relay' : 'Live — streaming directly peer-to-peer';
        s.className = 'status-banner live';
        setSteps('live');
        setPill('Sharing live', 'live');
        $('invite-card').hidden = true;
        renderMetrics('host', state);
      } else {
        s.textContent = state.mode === 'hosting-consent' ? 'Someone is asking to connect — compare the words.'
          : 'Waiting for someone to connect…';
        s.className = 'status-banner';
        setSteps(state.mode === 'hosting-consent' ? 'verify' : 'invite');
        setPill(state.mode === 'hosting-consent' ? 'Approval needed' : 'Waiting for viewer', 'wait');
        $('invite-card').hidden = false;
        $('host-metrics').hidden = true;
      }
      break;
    }
    case 'connecting':
    case 'viewing': {
      if (state.sas) { $('viewer-sas').hidden = false; renderSasWords($('viewer-sas-words'), state.sas); }
      else $('viewer-sas').hidden = true;
      const s = $('viewer-status');
      if (state.mode === 'viewing') {
        const t = state.stats?.transport?.connected ? state.stats.transport : state.transport;
        s.textContent = t?.relayed ? 'Connected through a relay' : 'Connected directly peer-to-peer';
        s.className = 'status-banner live';
        setPill('Connected', 'live');
        renderMetrics('viewer', state);
      } else {
        s.textContent = 'Finding the host and securing the connection…';
        s.className = 'status-banner';
        setPill('Connecting…', 'wait');
        $('viewer-metrics').hidden = true;
      }
      break;
    }
    default:
      setPill('Ready');
  }

  if (state.pendingConsent) showConsent(state.pendingConsent);
  else $('consent-overlay').hidden = true;
}

function showConsent(req) {
  $('consent-fp').textContent = req.fingerprint;
  $('consent-trusted').textContent = req.trusted ? `Yes — ${req.label}` : 'No — first time';
  routeBadge($('consent-transport'), req.transport || {});
  renderSasWords($('consent-sas'), req.sas);
  $('consent-overlay').hidden = false;
}

async function refresh() {
  try { render(await api('state')); } catch { /* server restarting */ }
}

/* ------------------------------ actions ------------------------------ */

function sessionOptions() {
  const s = settings || {};
  return {
    fps: s.fps, bitrate: s.bitrate, encoder: s.encoder || undefined, source: s.source || undefined,
    display: /^[0-9]{1,2}$/.test(s.display || '') ? s.display : undefined,
    lowLatency: s.lowLatency !== false, audio: s.audio === true,
  };
}

$('btn-host').onclick = async () => {
  try {
    await api('host', {
      ...sessionOptions(),
      allowInput: $('host-allow-kbm').checked,
      allowGamepad: $('host-allow-pad').checked,
    });
    refresh();
  } catch (e) { toast(e.message, true); }
};

$('btn-connect-mode').onclick = () => { go('connect'); $('code-input').focus(); };
for (const b of document.querySelectorAll('[data-back]')) b.onclick = () => go('home');
for (const b of document.querySelectorAll('[data-stop]')) {
  b.onclick = async () => { await api('stop', {}).catch(() => {}); refresh(); };
}

$('connect-form').onsubmit = async (e) => {
  e.preventDefault();
  const code = $('code-input').value.trim();
  if (!code) { $('code-input').focus(); return; }
  try {
    await api('connect', {
      code, ...sessionOptions(),
      sendKbm: $('view-send-kbm').checked,
      sendPad: $('view-send-pad').checked,
    });
    $('code-input').value = '';
    refresh();
  } catch (err) { toast(err.message, true); }
};

const livePermissions = async () => {
  try { await api('permissions', { kbm: $('live-allow-kbm').checked, pad: $('live-allow-pad').checked }); }
  catch (e) { toast(e.message, true); refresh(); }
};
$('live-allow-kbm').onchange = livePermissions;
$('live-allow-pad').onchange = livePermissions;

const liveViewerInput = async (key, el) => {
  try { await api('viewer-input', { [key]: el.checked }); }
  catch (e) { toast(e.message, true); refresh(); }
};
$('live-send-kbm').onchange = () => liveViewerInput('kbm', $('live-send-kbm'));
$('live-send-pad').onchange = () => liveViewerInput('pad', $('live-send-pad'));
$('live-capture').onchange = () => liveViewerInput('capture', $('live-capture'));

$('copy-invitation').onclick = async () => {
  const invitation = lastState?.code;
  if (!invitation) return;
  try {
    await navigator.clipboard.writeText(invitation);
    $('copy-status').textContent = '✓ Copied — send it privately';
  } catch {
    $('copy-status').textContent = 'Select the invitation and copy it manually';
  }
  setTimeout(() => { $('copy-status').textContent = ''; }, 4000);
};

$('consent-allow').onclick = async () => { $('consent-overlay').hidden = true; await api('consent', { approve: true }).catch(() => {}); };
$('consent-deny').onclick = async () => { $('consent-overlay').hidden = true; await api('consent', { approve: false }).catch(() => {}); };

/* ------------------------------ live updates ------------------------------ */

function connectWs() {
  const ws = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(token)}`);
  ws.onmessage = (ev) => {
    const { type, data } = JSON.parse(ev.data);
    if (type === 'state') render(data);
    else if (type === 'consent') showConsent(data);
    else if (type === 'stats' && lastState) { lastState.stats = data; render(lastState, true); }
    else if (type === 'log') {
      const el = $('log');
      el.textContent += `${new Date().toTimeString().slice(0, 8)}  ${data}\n`;
      if (el.textContent.length > 60000) el.textContent = el.textContent.slice(-40000);
      el.scrollTop = el.scrollHeight;
      if (/^(error|host failed|connect failed)/.test(data)) toast(data.replace(/^[a-z ]+: /, ''), true);
    }
  };
  ws.onclose = () => setTimeout(connectWs, 1500);
}

(async () => {
  try { settings = await api('settings'); applySettingsToForm(settings); } catch (e) { toast(e.message, true); }
  go('home');
  connectWs();
  await refresh();
  runNetcheck();
})();

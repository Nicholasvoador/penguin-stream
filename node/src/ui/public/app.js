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
    allowInput: $('opt-allow-input').checked,
    forceRelay: $('opt-force-relay').checked,
    source: $('opt-source').value,
    turn: $('opt-turn').value.trim(),
    turnUser: $('opt-turn-user').value.trim(),
    turnPassword: $('opt-turn-password').value,
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
        const st = state.stats || {};
        s.textContent = `Streaming${state.mediaConfig ? ` · ${state.mediaConfig.width}×${state.mediaConfig.height} · ${state.mediaConfig.encoder}` : ''}` +
          (st.fps ? ` · ${Number(st.fps).toFixed(0)} fps` : '');
        s.className = 'status live';
      } else {
        s.textContent = 'Waiting for someone to connect…';
        s.className = 'status';
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
      const st = state.stats || {};
      const t = state.transport;
      $('viewer-status').textContent =
        (t ? (t.relayed ? 'Relayed connection' : 'Direct connection') : '') +
        (state.mediaConfig ? ` · ${state.mediaConfig.width}×${state.mediaConfig.height}` : '') +
        (st.framesShown ? ` · ${st.framesShown} frames` : '');
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
  $('consent-transport').textContent = req.transport?.relayed ? 'Relayed' : 'Direct';
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

$('code-input').addEventListener('input', (e) => {
  // Format as the user types, and accept a pasted code in any shape.
  let v = e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 32);
  v = v.match(/.{1,4}/g)?.join('-') || '';
  e.target.value = v;
});

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
      el.textContent += `${data}\n`;
      el.scrollTop = el.scrollHeight;
    }
  };
  ws.onclose = () => setTimeout(connectWs, 1500);
}

connectWs();
refresh();

$('copy-invitation').onclick = async () => {
  const invitation = $('code-display').textContent;
  if (!invitation || invitation === '…') return;
  try {
    await navigator.clipboard.writeText(invitation);
    $('copy-status').textContent = 'Copied — send privately to your guest.';
  } catch {
    $('copy-status').textContent = 'Select the invitation and copy it manually.';
  }
};

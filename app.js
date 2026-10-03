// Lantern dashboard: talks to the lantern over MQTT (WebSocket + TLS).
// cmd/* goes to the lantern, evt/* comes back. See docs/PLAN.md for the topic contract.
'use strict';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('lantern.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('lantern.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

let client = null;
let root = '';
let status = {};
let history = store.get('history', []);   // {dir:'out'|'in', id, text, ts, state:'sent'|'delivered'|'read', img?}
let schedule = [];                         // pending items: mirrors the retained cmd/schedule
let schedDone = store.get('schedDone', []); // delivered items, kept here for display

// ---------- helpers ----------
function toast(text, ms = 2500) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const fmtTime = (ts) => new Date(ts * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
function ago(ts) {
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 90) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return fmtTime(ts);
}
function pub(sub, payload, opts = {}) {
  if (!client || !client.connected) { toast('Not connected'); return Promise.reject(new Error('offline')); }
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return client.publishAsync(`${root}/${sub}`, body, { qos: 1, ...opts });
}

// ---------- connection ----------
function showLogin() {
  $('login').hidden = false;
  $('app').hidden = true;
  const c = store.get('conn', {});
  if (c.broker) $('lBroker').value = c.broker;
  $('lRoot').value = c.root || '';
  $('lUser').value = c.user || '';
}

function connect(conn) {
  root = conn.root;
  let cid = store.get('clientId');
  if (!cid) { cid = 'dash-' + uid(); store.set('clientId', cid); }
  // A persistent session: the broker keeps her replies while this page is closed.
  client = mqtt.connect(conn.broker, {
    clientId: cid, clean: false, username: conn.user || undefined, password: conn.pass || undefined,
    reconnectPeriod: 4000, connectTimeout: 15000,
  });
  client.on('connect', () => {
    client.subscribe([`${root}/evt/#`, `${root}/cmd/schedule`], { qos: 1 });
    $('login').hidden = true;
    $('app').hidden = false;
    renderAll();
  });
  client.on('message', onMessage);
  client.on('error', (e) => toast('Connection error: ' + e.message, 4000));
  client.on('offline', () => setPill(false, 'no connection'));
}

function onMessage(topic, buf, packet) {
  const sub = topic.slice(root.length + 1);
  let d = {};
  try { d = JSON.parse(buf.toString()); } catch { return; }
  switch (sub) {
    case 'evt/status': status = { ...status, ...d }; renderStatus(); break;  // the offline will only carries {online:false}
    case 'evt/config': fillConfig(d); break;
    case 'evt/ack': setState(d.id, 'delivered'); scheduleDelivered(d.id); break;
    case 'evt/read': setState(d.id, 'read'); break;
    case 'evt/reply':
      addHistory({ dir: 'in', id: 'r' + d.ts + d.text.length, text: d.text, ts: d.ts });
      if (!packet.retain && document.hidden === false) toast('Sath: ' + d.text);
      break;
    case 'evt/mood': status.mood = d.mood; status.moodColor = d.color; renderStatus(); break;
    case 'evt/ota': renderOta(d); break;
    case 'cmd/schedule': schedule = Array.isArray(d) ? d : []; renderSchedule(); break;
  }
}

function setPill(on, text) {
  const p = $('pill');
  p.className = 'pill ' + (on ? 'on' : 'off');
  p.textContent = text;
}

// ---------- status ----------
function renderStatus() {
  const s = status;
  setPill(!!s.online, s.online ? 'online' : 'offline');
  $('sMood').innerHTML = s.mood && s.mood !== 'None'
    ? `<span style="color:${s.moodColor || 'inherit'}">&#9679;</span> ${escapeHtml(s.mood)}` : '–';
  if (s.light) {
    $('sLight').textContent = `${s.light.mode} · ${s.light.brightness}%`;
    $('lMode').value = s.light.mode;
    $('lColor').value = (s.light.color || '#ff8c30').toLowerCase();
    $('lBri').value = s.light.brightness;
    $('lSpd').value = s.light.speed;
    $('lBriV').textContent = s.light.brightness + '%';
  }
  $('sUnread').textContent = s.unread ?? '–';
  const b = s.battery;
  $('sBat').innerHTML = !b ? 'not fitted' : b.source === 'usb' ? 'plugged in'
    : `<span style="color:${b.pct <= 15 ? 'var(--bad)' : 'inherit'}">${b.pct}%</span> <span class="muted small">${(b.mv / 1000).toFixed(2)} V</span>`;
  $('sSeen').textContent = s.time ? (s.online ? 'now' : ago(s.time)) : '–';
  $('fwVer').textContent = s.fw || '–';
  $('sWifi').textContent = s.ssid || '–';
  $('sRssi').textContent = s.rssi ? s.rssi + ' dBm' : '–';
  $('sUp').textContent = s.uptime ? Math.floor(s.uptime / 3600) + ' h ' + Math.floor(s.uptime / 60 % 60) + ' min' : '–';
  $('sHeap').textContent = s.heap ? Math.round(s.heap / 1024) + ' KB free' : '–';
}

// ---------- conversation ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function addHistory(item) {
  if (history.some((h) => h.id === item.id)) return;
  history.push(item);
  history = history.slice(-150);
  store.set('history', history);
  renderHistory();
}
function setState(id, state) {
  const h = history.find((x) => x.id === id);
  if (!h || (h.state === 'read' && state === 'delivered')) return;
  h.state = state;
  store.set('history', history);
  renderHistory();
}
function renderHistory() {
  const icons = { sent: '&#10003; sent', delivered: '&#10003;&#10003; on the lantern', read: '&#10084; read' };
  $('history').innerHTML = history.slice().reverse().map((h) => `
    <li class="${h.dir}">
      ${h.img ? `<img src="${h.img}" alt="">` : ''}${escapeHtml(h.text || '')}
      <span class="meta">${fmtTime(h.ts)}${h.dir === 'out' ? ' · ' + (icons[h.state] || '') : ''}</span>
    </li>`).join('') || '<li class="in muted">No messages yet.</li>';
}

$('msgForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('msgText').value.trim();
  if (!text) return;
  const m = { id: uid(), text, from: 'Wikum', ts: Math.floor(Date.now() / 1000), color: $('msgColor').value, anim: $('msgAnim').value };
  try {
    await pub('cmd/msg', m);
    addHistory({ dir: 'out', id: m.id, text, ts: m.ts, state: 'sent' });
    $('msgText').value = '';
  } catch { /* toast already shown */ }
});

$('hugBtn').addEventListener('click', async () => {
  try { await pub('cmd/hug', { color: '#ff2d78' }); toast('Hug sent'); } catch { /* offline */ }
});

// ---------- light ----------
let lightTimer = null;
function sendLight() {
  clearTimeout(lightTimer);
  lightTimer = setTimeout(() => pub('cmd/light', {
    mode: $('lMode').value, color: $('lColor').value, color2: $('lColor2').value,
    brightness: +$('lBri').value, speed: +$('lSpd').value,
  }).catch(() => {}), 250);
}
['lMode', 'lColor', 'lColor2', 'lBri', 'lSpd'].forEach((id) => $(id).addEventListener('input', () => {
  $('lBriV').textContent = $('lBri').value + '%';
  sendLight();
}));
const PRESETS = [
  ['Cosy', 'Candle', '#ff8c30', 60], ['Romantic', 'Breathe', '#ff2d78', 55], ['Sunset', 'Sunset', '#ff7a1a', 70],
  ['Love', 'Heartbeat', '#ff1030', 70], ['Party', 'Rainbow', '#ffffff', 80], ['Calm', 'Breathe', '#2050ff', 40],
  ['Reading', 'Solid', '#ffd6a0', 90], ['Off', 'Off', '#000000', 0],
];
$('presets').innerHTML = PRESETS.map(([n, , c]) => `<button type="button" style="background:${c === '#000000' ? '#333' : c}">${n}</button>`).join('');
[...$('presets').children].forEach((b, i) => b.addEventListener('click', () => {
  const [, mode, color, bri] = PRESETS[i];
  $('lMode').value = mode; $('lColor').value = color; $('lBri').value = bri;
  $('lBriV').textContent = bri + '%';
  sendLight();
}));

// ---------- pictures ----------
const preview = $('picPreview');
const pctx = preview.getContext('2d');
let picBlob = null;

async function encodeJpeg(canvas, maxBytes = 12000) {
  for (let q = 0.9; q >= 0.3; q -= 0.1) {
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', q));
    if (blob.size <= maxBytes) return blob;
  }
  return new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.25));
}
async function setPreview() {
  picBlob = await encodeJpeg(preview);
  $('picSize').textContent = (picBlob.size / 1024).toFixed(1) + ' KB';
  $('picSendCard').hidden = false;
  $('picSendCard').scrollIntoView({ behavior: 'smooth' });
}
$('picFile').addEventListener('change', async () => {
  const f = $('picFile').files[0];
  if (!f) return;
  const img = await createImageBitmap(f);
  const s = Math.min(img.width, img.height);
  pctx.fillStyle = '#000';
  pctx.fillRect(0, 0, 128, 128);
  pctx.imageSmoothingQuality = 'high';
  pctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 128, 128);
  setPreview();
});

// 16x16 pixel art, sent as 8x8 blocks on the 128x128 screen
const PALETTE = ['#000000', '#ffffff', '#ff2d78', '#ff1010', '#ff8c30', '#ffd23c', '#20d040', '#00c8a0', '#2050ff', '#9b30ff', '#8b5a2b', '#ffb6c1'];
let pxColor = PALETTE[2];
let pixels = store.get('pixels', Array(256).fill('#000000'));
const px = $('pixel');
const pxCtx = px.getContext('2d');
function drawPixels() {
  for (let i = 0; i < 256; i++) { pxCtx.fillStyle = pixels[i]; pxCtx.fillRect((i % 16) * 16, Math.floor(i / 16) * 16, 16, 16); }
  pxCtx.strokeStyle = '#ffffff18';
  for (let i = 0; i <= 16; i++) { pxCtx.beginPath(); pxCtx.moveTo(i * 16, 0); pxCtx.lineTo(i * 16, 256); pxCtx.moveTo(0, i * 16); pxCtx.lineTo(256, i * 16); pxCtx.stroke(); }
}
$('palette').innerHTML = PALETTE.map((c) => `<button type="button" style="background:${c}" aria-label="${c}"></button>`).join('');
[...$('palette').children].forEach((b, i) => {
  if (PALETTE[i] === pxColor) b.classList.add('sel');
  b.addEventListener('click', () => { pxColor = PALETTE[i]; [...$('palette').children].forEach((x) => x.classList.remove('sel')); b.classList.add('sel'); });
});
function paint(e) {
  const r = px.getBoundingClientRect();
  const x = Math.floor((e.clientX - r.left) / r.width * 16), y = Math.floor((e.clientY - r.top) / r.height * 16);
  if (x < 0 || y < 0 || x > 15 || y > 15) return;
  pixels[y * 16 + x] = pxColor;
  drawPixels();
}
let painting = false;
px.addEventListener('pointerdown', (e) => { painting = true; px.setPointerCapture(e.pointerId); paint(e); });
px.addEventListener('pointermove', (e) => painting && paint(e));
px.addEventListener('pointerup', () => { painting = false; store.set('pixels', pixels); });
$('pxClear').addEventListener('click', () => { pixels = Array(256).fill('#000000'); drawPixels(); store.set('pixels', pixels); });
$('pxUse').addEventListener('click', () => {
  for (let i = 0; i < 256; i++) { pctx.fillStyle = pixels[i]; pctx.fillRect((i % 16) * 8, Math.floor(i / 16) * 8, 8, 8); }
  setPreview();
});
drawPixels();

$('picSend').addEventListener('click', async () => {
  if (!picBlob) return;
  const bytes = new Uint8Array(await picBlob.arrayBuffer());
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  const b64 = btoa(bin);
  const CHUNK = 2048;
  const total = Math.ceil(b64.length / CHUNK);
  const id = uid();
  const caption = $('picCaption').value.trim();
  const prog = $('picProg');
  prog.hidden = false;
  $('picSend').disabled = true;
  try {
    for (let i = 0; i < total; i++) {
      const chunk = { img_id: id, seq: i, total, b64: b64.slice(i * CHUNK, (i + 1) * CHUNK) };
      if (i === 0) { chunk.from = 'Wikum'; chunk.text = caption; }
      await pub('cmd/img', chunk);
      prog.value = (i + 1) / total;
    }
    addHistory({ dir: 'out', id, text: caption, ts: Math.floor(Date.now() / 1000), state: 'sent', img: preview.toDataURL('image/jpeg', 0.7) });
    toast('Picture sent');
    $('picCaption').value = '';
  } catch { /* offline */ }
  $('picSend').disabled = false;
  prog.hidden = true;
});

// ---------- schedule ----------
function renderSchedule() {
  const items = schedule.slice().sort((a, b) => a.at - b.at);
  $('schedList').innerHTML = items.map((s) => `
    <li class="out">
      <button class="del" data-id="${s.id}" aria-label="Delete">&#10005;</button>
      ${escapeHtml(s.text)}
      <span class="meta">${fmtTime(s.at)} · waiting</span>
    </li>`).join('') + schedDone.slice().reverse().map((s) => `<li class="out" style="opacity:.6">${escapeHtml(s.text)}<span class="meta">${fmtTime(s.at)} · &#10003;&#10003; delivered</span></li>`).join('')
    || '<li class="in muted">Nothing scheduled.</li>';
  $('schedList').querySelectorAll('.del').forEach((b) => b.addEventListener('click', () => {
    saveSchedule(schedule.filter((s) => s.id !== b.dataset.id));
  }));
}
// The lantern confirmed a scheduled item: drop it from the retained list so it can never fire twice.
function scheduleDelivered(id) {
  const s = schedule.find((x) => x.id === id);
  if (!s) return;
  schedDone = [...schedDone.filter((x) => x.id !== id), s].slice(-20);
  store.set('schedDone', schedDone);
  addHistory({ dir: 'out', id: s.id, text: s.text, ts: s.at, state: 'delivered' });
  saveSchedule(schedule.filter((x) => x.id !== id));
}
function saveSchedule(list) {
  schedule = list;
  pub('cmd/schedule', schedule, { retain: true }).then(renderSchedule).catch(() => {});
}
$('schedForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const at = Math.floor(new Date($('schedAt').value).getTime() / 1000);
  if (!at || at < Date.now() / 1000) { toast('Pick a time in the future'); return; }
  saveSchedule([...schedule, { id: uid(), at, text: $('schedText').value.trim(), from: 'Wikum' }]);
  $('schedText').value = '';
  toast('Scheduled for ' + fmtTime(at));
});

// ---------- settings ----------
const MONTHS = ['–', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
$('cBMonth').innerHTML = MONTHS.map((m, i) => `<option value="${i}">${m}</option>`).join('');
$('cBDay').innerHTML = ['–', ...Array.from({ length: 31 }, (_, i) => i + 1)].map((d, i) => `<option value="${i}">${d}</option>`).join('');
let cfgLat = null, cfgLon = null, cfgTz = '';

function fillConfig(c) {
  cfgTz = c.tz || '';
  $('cQuiet').checked = !!(c.quiet && c.quiet.on);
  if (c.quiet) { $('cQStart').value = c.quiet.start; $('cQEnd').value = c.quiet.end; }
  const [bm, bd] = (c.birthday || '').split('-').map(Number);
  $('cBMonth').value = bm || 0;
  $('cBDay').value = bd || 0;
  $('cCity').value = c.city || '';
  cfgLat = c.lat ?? null;
  cfgLon = c.lon ?? null;
  $('cCityHint').textContent = cfgLat != null ? `Using ${cfgLat.toFixed(2)}, ${cfgLon.toFixed(2)}` : '';
}
$('cFind').addEventListener('click', async () => {
  const name = $('cCity').value.trim();
  if (!name) { cfgLat = cfgLon = null; $('cCityHint').textContent = 'Automatic location'; return; }
  try {
    const r = await (await fetch('https://geocoding-api.open-meteo.com/v1/search?count=1&name=' + encodeURIComponent(name))).json();
    const p = r.results && r.results[0];
    if (!p) { $('cCityHint').textContent = 'Place not found'; return; }
    cfgLat = p.latitude; cfgLon = p.longitude;
    $('cCity').value = p.name;
    $('cCityHint').textContent = `${p.name}, ${p.country} (${cfgLat.toFixed(2)}, ${cfgLon.toFixed(2)})`;
  } catch { $('cCityHint').textContent = 'Lookup failed'; }
});
$('cfgForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const m = +$('cBMonth').value, d = +$('cBDay').value;
  const cfg = {
    tz: cfgTz,
    quiet: { on: $('cQuiet').checked, start: $('cQStart').value, end: $('cQEnd').value },
    birthday: m && d ? String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0') : '',
    city: $('cCity').value.trim(),
  };
  if (cfg.city && cfgLat != null) { cfg.lat = cfgLat; cfg.lon = cfgLon; }
  pub('cmd/config', cfg, { retain: true }).then(() => toast('Settings saved')).catch(() => {});
});

// ---------- firmware ----------
function renderOta(d) {
  const t = { downloading: `Downloading ${d.progress}%`, verifying: 'Verifying', done: 'Installed, restarting', failed: 'Failed: ' + d.message };
  $('otaStatus').textContent = `${d.version}: ${t[d.state] || d.state}`;
}
$('otaBtn').addEventListener('click', () => {
  const url = $('otaUrl').value.trim(), version = $('otaVer').value.trim(), sha256 = $('otaSha').value.trim().toLowerCase();
  if (!/^https?:\/\//.test(url) || !/^[0-9a-f]{64}$/.test(sha256)) { toast('Need a firmware URL and a 64-character SHA-256'); return; }
  pub('cmd/ota', { url, version, sha256 }).then(() => ($('otaStatus').textContent = 'Update sent')).catch(() => {});
});

// ---------- misc ----------
$('clearBtn').addEventListener('click', () => {
  if (confirm('Delete all messages on the lantern?')) pub('cmd/clear', {}).then(() => toast('Inbox cleared')).catch(() => {});
});
$('logoutBtn').addEventListener('click', () => {
  if (client) client.end(true);
  store.set('conn', {});
  showLogin();
});
document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('.tab').forEach((t) => (t.hidden = t.id !== 'tab-' + b.dataset.tab));
  store.set('tab', b.dataset.tab);
}));
$('loginForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const conn = { broker: $('lBroker').value.trim(), root: $('lRoot').value.trim(), user: $('lUser').value.trim(), pass: $('lPass').value };
  store.set('conn', conn);
  connect(conn);
});
function renderAll() { renderStatus(); renderHistory(); renderSchedule(); }
setInterval(() => status.time && renderStatus(), 30000);

// Start: reuse saved login; ?root=... in the URL pre-fills the topic root.
const params = new URLSearchParams(location.search);
const saved = store.get('conn', {});
if (params.get('root') && !saved.root) saved.root = params.get('root');
const startTab = store.get('tab', 'home');
document.querySelector(`#tabs button[data-tab="${startTab}"]`)?.click();
if (saved.broker && saved.root) connect(saved); else { showLogin(); if (saved.root) $('lRoot').value = saved.root; }
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

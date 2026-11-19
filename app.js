const $ = selector => document.querySelector(selector);
let state = null;
let offset = 0;
let busy = false;
let toastTimer;
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5000);
}
let localWaking = false;
let wakeAt = 0;
let pendingPlay = false;
const isWaking = () => localWaking || state?.hostWaking;
function applyState(data) {
  state = data;
  offset = state.serverTime - Date.now();
  if (state.hostStreaming && localWaking) {
    localWaking = false;
    if (pendingPlay) { pendingPlay = false; startPlay(); }
  }
  if (localWaking && !state.hostWaking && !state.hostStreaming && Date.now() - wakeAt > 15_000) {
    localWaking = false;
    pendingPlay = false;
    toast('O PS5 não respondeu — abra o Chiaki manualmente ou tente de novo.');
  }
  if (localWaking && Date.now() - wakeAt > 170_000) {
    localWaking = false;
    pendingPlay = false;
    toast('Tempo esgotado ao acordar o PS5. Tente de novo.');
  }
  render();
}
function hostPill() {
  if (isWaking()) return ['ACORDANDO…', 'pill waking'];
  if (state?.rtcEnabled === false) return ['RTC DESLIGADO', 'pill'];
  if (state?.hostOnline) return ['HOST ONLINE', 'pill live'];
  return ['HOST OFFLINE', 'pill'];
}
async function readJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); }
  catch { throw new Error(`Resposta inesperada (${res.status}): o servidor devolveu uma página, não dados. Tente recarregar.`); }
}
async function refresh() {
  try {
    const response = await fetch('/api/state');
    if (!response.ok) throw new Error('Servidor indisponível.');
    applyState(await response.json());
  } catch {
    state = null;
    $('#cta').hidden = true;
    $('#current-name').textContent = 'Conexão indisponível';
    $('#timer').textContent = '— — : — —';
  }
}
async function action(path, data = {}) {
  if (busy) return;
  busy = true;
  try {
    const response = await fetch(`/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state?.user?.csrf ?? '' }, body: JSON.stringify(data) });
    const result = await readJson(response);
    if (!response.ok) throw new Error(result.error);
    if (path === 'logout') disconnectLive();
    await refresh();
    return result;
  } catch (error) { console.error('[action]', error); toast(String(error?.message || 'Não foi possível conectar.').slice(0, 200)); }
  finally { busy = false; }
  return null;
}
function timer() {
  const label = $('#timer-label'), el = $('#timer');
  const current = state?.current;
  const waiter = state?.waiter;
  if (current) {
    const seconds = Math.max(0, Math.floor((Date.now() + offset - current.startedAt) / 1000));
    label.textContent = current.mine ? 'JOGANDO HÁ' : 'JOGANDO HÁ';
    el.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    return;
  }
  if (waiter?.mine && waiter.deadline) {
    const seconds = Math.max(0, Math.ceil((waiter.deadline - Date.now() - offset) / 1000));
    label.textContent = 'VOCÊ ASSUME EM';
    el.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    return;
  }
  if (waiter) { label.textContent = 'ESPERA'; el.textContent = '10:00'; return; }
  label.textContent = 'JOGANDO HÁ';
  el.textContent = '— — : — —';
}
// ---- CTA central: um botão pra tudo (jogar / pedir vez / esperar / sair) ----
function ctaState() {
  if (!state) return null;
  const cur = state.current, req = state.request, waiter = state.waiter;
  const approved = state.user && (state.user.approved || state.user.role === 'admin');
  if (cur?.mine || req?.forMe) return null; // stop-btn / ask-bar assumem
  if (!state.user) return { label: 'JOGAR', sub: 'Toque e diga seu apelido', act: 'auth' };
  if (!approved) return { label: 'AGUARDANDO APROVAÇÃO', sub: 'O admin libera seu aparelho', act: null };
  if (req?.mine) return { label: 'PEDIDO ENVIADO…', sub: `${cur?.name} tem ~45s p/ responder · toque p/ cancelar`, act: 'leave' };
  if (state.declined) return { label: 'ESPERAR 10 MIN', sub: `${cur?.name ?? 'O jogador'} não liberou — entre e assuma`, act: 'wait' };
  if (waiter?.mine) return { label: 'NA ESPERA', sub: 'Você assume em breve · toque p/ sair', act: 'leave' };
  if (waiter) return { label: `${waiter.name.toUpperCase()} NA ESPERA`, sub: 'Prioridade na próxima vez', act: null };
  if (cur) return { label: 'DEIXA EU JOGAR?', sub: `${cur.name} está no controle`, act: 'request' };
  if (isWaking()) return { label: 'ACORDANDO O PS5…', sub: 'pode levar ~1 min', act: null };
  return { label: 'JOGAR', sub: 'A vez está livre', act: 'play' };
}
function render() {
  const current = state.current;
  const mine = Boolean(current?.mine);
  const req = state.request;
  const waiter = state.waiter;
  const approved = state.user && (state.user.approved || state.user.role === 'admin');
  // Conta / topo
  $('#account-btn').textContent = state.user ? state.user.name : 'Entrar';
  $('#account-name').textContent = state.user ? `Logado como ${state.user.name}` : '';
  $('#account-status').textContent = state.user && !approved ? '⏳ Aguardando aprovação do admin' : '';
  $('#pix-btn').hidden = !(state.user && state.pixEnabled);
  $('#chat-btn').hidden = !approved;
  if (!approved) setChatDrawer(false);
  // Aviso quando o admin aprova o usuário conectado (SSE empurra o novo estado).
  const nowApproved = Boolean(approved);
  if (prevApproved === false && nowApproved) toast('Sua conta foi aprovada! Já pode jogar.');
  prevApproved = nowApproved;
  // 🔔 admin: pendentes de aprovação
  const pend = state.pending ?? [];
  $('#admin-bell').hidden = !(state.user?.role === 'admin');
  $('#bell-badge').hidden = !pend.length;
  $('#bell-badge').textContent = pend.length > 9 ? '9+' : String(pend.length);
  $('#bell-empty').hidden = pend.length > 0;
  $('#bell-list').replaceChildren(...pend.map(u => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = u.name;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bell-ok';
    btn.textContent = 'Aprovar';
    btn.addEventListener('click', () => action('admin/action', { userId: u.id, action: 'approve' }));
    li.append(name, btn);
    return li;
  }));
  $('#current-name').textContent = current ? `${current.name}${mine ? ' (você)' : ''} · jogando` : 'Ninguém por enquanto';
  // CTA + pedido de vez
  const cta = ctaState();
  $('#cta').hidden = !cta;
  if (cta) {
    $('#cta-label').textContent = cta.label;
    $('#cta-sub').textContent = cta.sub || '';
    $('#cta').classList.toggle('dim', !cta.act);
  }
  $('#ask-bar').hidden = !(mine && req?.forMe);
  if (mine && req?.forMe) $('#ask-text').textContent = `${req.name} quer jogar:`;
  // Presença
  const on = state.online ?? { viewers: 0, logged: 0, names: [] };
  $('#viewers-count').textContent = on.viewers;
  const guests = on.viewers - on.logged;
  $('#sala-info').textContent = [
    on.names.length ? `Na sala: ${on.names.join(', ')}` : '',
    guests > 0 ? `+${guests} visitante${guests > 1 ? 's' : ''}` : '',
    waiter && !waiter.mine ? `${waiter.name} na espera` : '',
  ].filter(Boolean).join(' · ');
  if (video.hidden) {
    const [label, cls] = hostPill();
    $('#screen-status').textContent = label;
    $('#screen-status').className = cls;
  }
  if (!specStopped) $('#screen-load').textContent = isWaking() ? 'Acordando o PS5 — pode levar ~1 min…' : 'Conectando…';
  timer();
  renderChat();
  updateScreenMode();
  maybeAutoConnect();
}
// ---- Chat ----
let lastChatAt = -1;
let chatReadAt = Date.now(); // não-lidas contam só mensagens novas desta sessão
let prevApproved = null; // transição false→true = aprovado agora → toast
let videoReceiver = null;
let jitTarget = 40;
let jitCalm = 0; // amostras seguidas sem drop — desce o buffer adaptativo
function setJitTarget(ms) {
  try { if (videoReceiver) videoReceiver.jitterBufferTarget = ms; } catch {}
  try { if (videoReceiver) videoReceiver.playoutDelayHint = ms / 1000; } catch {}
}
let chatOlder = [], chatOlderMore = false, chatLoadingOlder = false, chatForceRender = false, chatKeepScroll = null;
function fmtChatTime(at) {
  const d = new Date(at);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function renderChat() {
  const tail = state?.chat ?? [];
  const minTail = tail.length ? tail[0].at : Infinity;
  const msgs = chatOlder.filter(m => m.at < minTail).concat(tail);
  const lastAt = tail.length ? tail[tail.length - 1].at : -1;
  const canSend = Boolean(state?.user && (state.user.approved || state.user.role === 'admin'));
  $('#chat-count').textContent = msgs.length ? `${msgs.length} msg` : '';
  $('#chat-input-row').hidden = !canSend;
  $('#chat-hint').textContent = canSend ? ''
    : state?.user ? 'Cadastro em aprovação — em breve você conversa.'
    : 'Entre na sua conta para conversar';
  if (lastAt === lastChatAt && !chatForceRender) return;
  chatForceRender = false;
  lastChatAt = lastAt;
  const list = $('#chat-list');
  const items = [];
  const hasMore = chatOlder.length ? chatOlderMore : Boolean(state?.chatMore);
  if (hasMore) {
    const li = document.createElement('li');
    li.className = 'chat-older';
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = '↑ mensagens anteriores';
    b.addEventListener('click', loadChatOlder);
    li.append(b);
    items.push(li);
  }
  for (const m of msgs) {
    const li = document.createElement('li');
    const who = document.createElement('b');
    who.textContent = m.n;
    const when = document.createElement('time');
    when.dateTime = new Date(m.at).toISOString();
    when.textContent = fmtChatTime(m.at);
    const txt = document.createElement('span');
    txt.textContent = ' ' + m.t;
    li.append(who, when, txt);
    items.push(li);
  }
  list.replaceChildren(...items);
  // Balão de não-lidas no 💬: conta mensagens de outros após a última leitura.
  const drawerClosed = $('#chat-drawer').hidden;
  const unread = drawerClosed ? msgs.filter(m => m.at > chatReadAt && m.n !== state?.user?.name).length : 0;
  const badge = $('#chat-badge');
  badge.hidden = unread === 0;
  badge.textContent = unread > 9 ? '9+' : String(unread);
  // "Sempre na última mensagem" — exceto quando acabou de carregar página
  // antiga (aí o scroll fica onde estava, sem pular).
  if (chatKeepScroll != null) { list.scrollTop = list.scrollHeight - chatKeepScroll; chatKeepScroll = null; }
  else if (!$('#chat-drawer').hidden) list.scrollTop = list.scrollHeight;
}
async function loadChatOlder() {
  const tail = state?.chat ?? [];
  const before = chatOlder.length ? chatOlder[0].at : tail[0]?.at;
  if (!before || chatLoadingOlder) return;
  chatLoadingOlder = true;
  try {
    const res = await fetch(`/api/chat/older?before=${before}`);
    const d = await readJson(res);
    if (!res.ok) throw 0;
    if (d.messages?.length) {
      chatKeepScroll = $('#chat-list').scrollHeight;
      chatOlder = d.messages.concat(chatOlder);
      chatOlderMore = Boolean(d.more);
      chatForceRender = true;
      renderChat();
    } else { chatOlderMore = false; chatForceRender = true; renderChat(); }
  } catch { toast('Falha ao carregar mensagens antigas.'); }
  chatLoadingOlder = false;
}
async function sendChat() {
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  if (!state?.user) { openNick(); return; }
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.user.csrf },
      body: JSON.stringify({ text }),
    });
    if (res.ok) { input.value = ''; return; }
    const d = await readJson(res);
    toast(d?.error || 'Não foi possível enviar.');
  } catch { toast('Falha ao enviar mensagem.'); }
}
$('#chat-send').addEventListener('click', sendChat);
$('#chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); sendChat(); } });
// ---- Gaveta do chat ----
function setChatDrawer(open) {
  $('#chat-drawer').hidden = !open;
  $('#chat-scrim').hidden = !open;
  if (open) {
    chatReadAt = Date.now();
    $('#chat-badge').hidden = true;
    const l = $('#chat-list');
    l.scrollTop = l.scrollHeight;
  }
}
$('#chat-btn').addEventListener('click', () => setChatDrawer($('#chat-drawer').hidden));
$('#chat-close').addEventListener('click', () => setChatDrawer(false));
$('#chat-scrim').addEventListener('click', () => setChatDrawer(false));
// ---- Identidade: fingerprint do aparelho = a conta (sem senha) ----
async function deviceId() {
  const cached = localStorage.getItem('cdv-device');
  if (cached) return cached;
  const parts = [
    navigator.userAgent, navigator.language, navigator.platform,
    `${screen.width}x${screen.height}x${screen.colorDepth}`,
    new Date().getTimezoneOffset(), navigator.hardwareConcurrency,
    navigator.deviceMemory, navigator.maxTouchPoints,
  ];
  try {
    const c = document.createElement('canvas');
    c.width = 280; c.height = 32;
    const g = c.getContext('2d');
    g.font = '16px monospace';
    g.fillStyle = '#d4f77d';
    g.fillText('cdv·identidade', 8, 22);
    g.strokeStyle = '#40f';
    g.arc(250, 16, 10, 0, 7);
    g.stroke();
    parts.push(c.toDataURL());
  } catch {}
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('|')));
  const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  localStorage.setItem('cdv-device', hex);
  return hex;
}
let devId = null;
async function identify(nick) {
  devId = devId ?? await deviceId();
  const res = await fetch('/api/identify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device: devId, nick }),
  });
  const d = await readJson(res);
  if (!res.ok) throw new Error(d?.error || 'Falha ao entrar.');
  return d;
}
function openNick() {
  if ($('#nick-dialog').open) return;
  $('#nick-hint').textContent = '';
  $('#nick-dialog').showModal();
  setTimeout(() => $('#nick-input').focus(), 80);
}
$('#nick-form').addEventListener('submit', async e => {
  e.preventDefault();
  const nick = $('#nick-input').value.trim();
  if (nick.length < 2) { $('#nick-hint').textContent = 'Apelido: mínimo 2 caracteres.'; return; }
  try {
    await identify(nick);
    $('#nick-dialog').close();
    toast('Pronto! O admin aprova seu aparelho e você já joga.');
    await refresh();
  } catch (err) { $('#nick-hint').textContent = err.message; }
});
// Login silencioso na abertura: aparelho já cadastrado volta direto.
(async () => {
  try { await identify(); } catch {}
  refresh();
})();
$('#account-btn').addEventListener('click', e => {
  e.stopPropagation();
  if (!state?.user) { openNick(); return; }
  $('#account-menu').hidden = !$('#account-menu').hidden;
  if (!$('#account-menu').hidden) $('#bell-menu').hidden = true;
});
$('#admin-bell').addEventListener('click', e => {
  e.stopPropagation();
  $('#bell-menu').hidden = !$('#bell-menu').hidden;
  if (!$('#bell-menu').hidden) $('#account-menu').hidden = true;
});
document.addEventListener('click', e => {
  if (!e.target.closest('#account-menu, #account-btn')) $('#account-menu').hidden = true;
  if (!e.target.closest('#bell-menu, #admin-bell')) $('#bell-menu').hidden = true;
});
$('#pix-btn').addEventListener('click', openPix);
async function openPix() {
  if (!state?.user) { openNick(); return; }
  try {
    const res = await fetch('/api/pix');
    if (!res.ok) throw new Error((await res.json()).error);
    const pix = await res.json();
    $('#pix-amount').textContent = pix.amount ? `Valor sugerido: R$ ${pix.amount} — ajuste no seu banco se quiser.` : 'Valor livre — você escolhe quanto apoiar.';
    $('#pix-code').value = pix.payload;
    $('#pix-qr').replaceChildren();
    const img = document.createElement('img');
    img.src = pix.image || pix.qr;
    img.alt = 'QR Code Pix';
    $('#pix-qr').append(img);
    $('#pix-dialog').showModal();
  } catch (e) { toast(e.message || 'Pix indisponível.'); }
}
$('#pix-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#pix-code').value); toast('Código Pix copiado.'); }
  catch { $('#pix-code').select(); document.execCommand('copy'); toast('Código Pix copiado.'); }
});
$('#pix-paid').addEventListener('click', () => { $('#pix-dialog').close(); action('pix-paid'); toast('Obrigado pelo apoio!'); });
function needAuth() {
  if (!state?.user) { openNick(); return true; }
  if (!(state.user.approved || state.user.role === 'admin')) { toast('Aguardando aprovação do admin.'); return true; }
  return false;
}
async function startPlay() {
  await action('start');
  if (state?.current?.mine && !pc && state?.rtcEnabled !== false) connectLive();
}
async function wakeHost(wantPlay) {
  pendingPlay = wantPlay;
  localWaking = true;
  wakeAt = Date.now();
  if (await action('wake') === null) { localWaking = false; pendingPlay = false; }
}
// CTA único: jogar / pedir vez / esperar / cancelar / entrar.
$('#cta').addEventListener('click', async () => {
  const c = ctaState();
  if (!c?.act) return;
  if (c.act === 'auth') { openNick(); return; }
  if (c.act === 'play') {
    suppressedTurn = null;
    enterFullscreen();
    if (!state?.hostStreaming) { wakeHost(true); return; }
    startPlay();
    return;
  }
  action(c.act);
});
$('#accept-btn').addEventListener('click', () => action('accept'));
$('#decline-btn').addEventListener('click', () => action('decline'));
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => document.getElementById(button.dataset.close).close()));
function training() { $('#training-dialog').showModal(); $('#training-pad').focus(); }
$('#train-nav').addEventListener('click', training);
const keys = new Set();
const allowed = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'ShiftLeft', 'ShiftRight']);
function renderKeys() { $('#input-state').textContent = keys.size ? [...keys].map(key => key.replace('Key', '').replace('Arrow', '').replace('Space', 'Espaço')).join(' + ') : 'Pronto para o próximo comando'; }
$('#training-pad').addEventListener('keydown', event => { if (allowed.has(event.code)) { event.preventDefault(); keys.add(event.code); renderKeys(); } });
window.addEventListener('keyup', event => keys.delete(event.code));
window.addEventListener('blur', () => keys.clear());
$('#training-pad').addEventListener('blur', () => keys.clear());
$('#training-dialog').addEventListener('close', () => keys.clear());
setInterval(() => {
  if (!$('#training-dialog').open) return;
  const pads = [...(navigator.getGamepads?.() ?? [])].filter(Boolean);
  if (!pads.length) { $('#gamepad-state').textContent = 'Nenhum controle detectado — pressione um botão no DS4'; return; }
  $('#gamepad-state').textContent = pads.map(p => {
    const buttons = p.buttons.flatMap((b, i) => b.pressed ? [i] : []);
    const axes = p.axes.map(v => Math.abs(v) < .15 ? '0.00' : v.toFixed(2));
    return `${p.id} (${p.buttons.length} btn) · Botões: ${buttons.join(', ') || 'nenhum'} · Eixos: ${axes.join(' / ')}`;
  }).join(' | ');
}, 100);
setInterval(timer, 200);
refresh();

// Push de estado via SSE; fallback para polling se o stream cair.
let eventSource = null;
function startEvents() {
  try {
    eventSource = new EventSource('/api/events');
    eventSource.onmessage = event => {
      try { applyState(JSON.parse(event.data)); } catch {}
    };
  } catch {}
}
startEvents();
setInterval(() => {
  if (!eventSource || eventSource.readyState === EventSource.CLOSED) refresh();
}, 5000);

// ---- Live: chiaki-ng -> WebRTC -> controle virtual ----
let pc = null, inputChannel = null, inputTimer = null, connectBusy = false;
let seq = 0;
const pendingAcks = new Map(); // seq -> timestamp de envio (performance.now)
let inputRtt = null, inputProc = null;
let negotiatedCodec = null; // 'video/H265' etc — lido do answer SDP; getStats confirma via codecId

function sdpVideoCodec(sdp) {
  const pt = sdp?.match(/m=video \d+ \S+ (\d+)/)?.[1];
  if (!pt) return null;
  const name = sdp.match(new RegExp(`a=rtpmap:${pt} (\\S+)/90000`));
  return name ? `video/${name[1]}` : null;
}
function codecLabel(mime) {
  return { 'video/H265': 'H.265', 'video/H264': 'H.264', 'video/VP8': 'VP8', 'video/VP9': 'VP9', 'video/AV1': 'AV1' }[mime] || (mime || '').replace('video/', '');
}
const video = $('#live-video');
const liveVideo = video; // alias: updateStats sombreia 'video' com o stat inbound-rtp
const ytFrame = $('#yt-live');
const screenEl = document.querySelector('.screen');
const MODES = { foot: 'Pé', driving: 'Dirigindo', menu: 'Menu' };
let controlMode = localStorage.getItem('cdv-mode') || 'foot';
let qualityPref = localStorage.getItem('cdv-quality') || 'auto';
let codecPref = localStorage.getItem('cdv-codec') || 'auto';
// Auto-degrade: framesDropped crescendo = o aparelho não sustenta o perfil
// (decode 1080p60 no celular, estouro de pacotes no Wi-Fi). Desce um degrau
// do perfil a cada ~3s de drops até 'lite' — sem trocar a escolha do usuário.
const Q_LADDER = ['auto', 'detail', 'smooth', 'data', 'lite'];
const degrade = { count: 0, cooldown: 0, applied: null };
let mouseLook = false;
const mouse = { rx: 0, ry: 0, lastMove: 0 };
let autoConnectKey = null, lastAutoAttempt = 0, suppressedTurn = null;

// Teclado: captura global durante a live (não intercepta campos de texto).
const LIVE_KEYS = new Set();
const LIVE_ALLOWED = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyE', 'KeyQ', 'KeyR', 'KeyC', 'KeyV', 'KeyM',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Space', 'ShiftLeft', 'ShiftRight', 'Enter', 'NumpadEnter', 'Escape', 'Tab',
]);
window.addEventListener('keydown', e => {
  if (e.target.matches('input,textarea,select')) return;
  if (!LIVE_ALLOWED.has(e.code)) return;
  if (e.code === 'KeyM' && !e.repeat) { cycleMode(); e.preventDefault(); return; }
  if (!e.repeat) { LIVE_KEYS.add(e.code); e.preventDefault(); }
});
window.addEventListener('keyup', e => LIVE_KEYS.delete(e.code));
window.addEventListener('blur', () => LIVE_KEYS.clear());
document.addEventListener('visibilitychange', () => { if (document.hidden) LIVE_KEYS.clear(); });

function cycleMode() {
  const order = Object.keys(MODES);
  controlMode = order[(order.indexOf(controlMode) + 1) % order.length];
  localStorage.setItem('cdv-mode', controlMode);
  $('#mode-btn').textContent = `Modo: ${MODES[controlMode]}`;
  toast(`Controles em modo ${MODES[controlMode]}.`);
}
$('#mode-btn').addEventListener('click', cycleMode);
$('#mouse-look-btn').addEventListener('click', () => {
  mouseLook = !mouseLook;
  $('#mouse-look-btn').classList.toggle('on', mouseLook);
  mouse.rx = mouse.ry = 0;
});
$('#quality-sel').addEventListener('change', e => {
  qualityPref = e.target.value;
  localStorage.setItem('cdv-quality', qualityPref);
  degrade.applied = null; // escolha manual recomeça a lógica de auto-degrade
  sendVideoPref(qualityPref);
});
// Codec: muda só na próxima negociação — reconecta na hora se já estiver em RTC.
$('#codec-sel').addEventListener('change', e => {
  codecPref = e.target.value;
  localStorage.setItem('cdv-codec', codecPref);
  if (pc) { disconnectLive(); connectLive(true); }
});

// Mouse look: deltas acumulam no analógico direito e decaem rápido ao parar.
screenEl.addEventListener('mousemove', e => {
  if (!mouseLook || !pc) return;
  mouse.rx = Math.max(-1, Math.min(1, mouse.rx + e.movementX * 0.0021));
  mouse.ry = Math.max(-1, Math.min(1, mouse.ry + e.movementY * 0.0021));
  mouse.lastMove = performance.now();
});
screenEl.addEventListener('contextmenu', e => e.preventDefault());

// ---- Touch gamepad ----
const touch = { lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0, buttons: new Set(), used: false };
function bindStick(zoneId, stickId, axis, clickIdx) {
  const zone = document.getElementById(zoneId);
  const stick = document.getElementById(stickId);
  let pid = null, cx = 0, cy = 0, moved = false, downAt = 0;
  const R = 52;
  const update = e => {
    let dx = e.clientX - cx, dy = e.clientY - cy;
    const d = Math.hypot(dx, dy);
    if (d > 8) moved = true;
    if (d > R) { dx *= R / d; dy *= R / d; }
    stick.style.transform = `translate(${dx}px, ${dy}px)`;
    // Deadzone radial: módulo do vetor, não por eixo — evita o "travar"
    // quando um eixo oscila em volta do limiar durante o andar.
    const dead = 0.18;
    const mag = Math.hypot(dx, dy) / R;
    const k = mag < dead ? 0 : Math.min(1, (mag - dead) / (1 - dead)) / mag;
    touch[axis[0]] = dx / R * k; touch[axis[1]] = dy / R * k;
    touch.used = true;
  };
  zone.addEventListener('pointerdown', e => {
    // Um segundo toque na zona (borda do polegar/palma) NÃO pode sequestrar
    // o stick: sem esse guard, o pid novo zerava os eixos → "anda e para".
    if (pid !== null) return;
    pid = e.pointerId;
    moved = false; downAt = performance.now();
    const r = zone.getBoundingClientRect();
    cx = r.left + r.width / 2; cy = r.top + r.height / 2;
    zone.setPointerCapture(pid); update(e); e.preventDefault();
  });
  zone.addEventListener('pointermove', e => { if (e.pointerId === pid) update(e); });
  const end = e => {
    if (e.pointerId !== pid) return;
    pid = null; touch[axis[0]] = touch[axis[1]] = 0;
    stick.style.transform = '';
    // Toque curto sem arrasto = click do analógico (L3/R3), como no DualSense.
    if (!moved && performance.now() - downAt < 300) {
      touch.buttons.add(clickIdx); touch.used = true;
      zone.classList.add('on');
      setTimeout(() => { touch.buttons.delete(clickIdx); zone.classList.remove('on'); }, 120);
    }
  };
  zone.addEventListener('pointerup', end);
  zone.addEventListener('pointercancel', e => { clientLog('stick-cancel', { axis: axis.join(''), type: 'cancel' }); end(e); });
  zone.addEventListener('lostpointercapture', e => { clientLog('stick-cancel', { axis: axis.join(''), type: 'lostcapture' }); end(e); });
}
bindStick('tp-left', 'tp-lstick', ['lx', 'ly'], 10);
bindStick('tp-right', 'tp-rstick', ['rx', 'ry'], 11);
// ---- Overlay: modo (full/sem dpad/mínimo) + transparência ----
const PAD_MODES = { full: 'PAD', racing: 'PAD-R', nodpad: 'PAD−D', minimal: 'PAD·', off: 'PAD×' };
const PAD_ORDER = ['full', 'racing', 'nodpad', 'minimal', 'off'];
const PAD_ALPHAS = [1, 0.55, 0.3];
let padMode = localStorage.getItem('padMode') || 'full';
let padAlpha = Number(localStorage.getItem('padAlpha') ?? 1);
function applyPadStyle() {
  const tp = $('#touch-pad');
  tp.dataset.mode = padMode;
  tp.style.setProperty('--tp-alpha', padAlpha);
  $('#pad-mode-btn').textContent = PAD_MODES[padMode];
  $('#pad-alpha-btn').textContent = `◐ ${Math.round(padAlpha * 100)}%`;
}
$('#pad-mode-btn').addEventListener('click', e => {
  e.preventDefault();
  padMode = PAD_ORDER[(PAD_ORDER.indexOf(padMode) + 1) % PAD_ORDER.length];
  localStorage.setItem('padMode', padMode);
  applyPadStyle();
});
$('#pad-alpha-btn').addEventListener('click', e => {
  e.preventDefault();
  padAlpha = PAD_ALPHAS[(PAD_ALPHAS.indexOf(padAlpha) + 1) % PAD_ALPHAS.length];
  localStorage.setItem('padAlpha', padAlpha);
  applyPadStyle();
});
// Auto-oculta o overlay quando um gamepad físico conecta — o usuário joga
// pelo pad e a tela fica limpa. 🎮 flutuante reexibe; o bloqueio vale até o
// pad desconectar (daí o auto-hide volta a agir no próximo connect).
let padAutoHide = false;
let padHideBlocked = false;
function physicalPadConnected() {
  return [...(navigator.getGamepads?.() ?? [])].some(p => p && p.buttons.length >= 17);
}
addEventListener('gamepadconnected', () => {
  if (!padHideBlocked && physicalPadConnected()) { padAutoHide = true; updateLiveUi(); }
});
addEventListener('gamepaddisconnected', () => {
  if (!physicalPadConnected()) { padAutoHide = false; padHideBlocked = false; updateLiveUi(); }
});
$('#pad-show-btn').addEventListener('click', () => {
  padAutoHide = false;
  padHideBlocked = true;
  if (padMode === 'off') { padMode = 'full'; localStorage.setItem('padMode', padMode); applyPadStyle(); }
  updateLiveUi();
});
applyPadStyle();
// Segurar botão no Android pode abrir menu de contexto — suprime no overlay.
$('#touch-pad').addEventListener('contextmenu', e => e.preventDefault());
document.querySelectorAll('[data-tb]').forEach(btn => {
  const idx = Number(btn.dataset.tb);
  // pointer capture: segurar L3/R2 e arrastar o dedo pra fora do botão não
  // solta no meio — só larga no pointerup de verdade.
  const press = e => { e.preventDefault(); try { btn.setPointerCapture(e.pointerId); } catch {} touch.buttons.add(idx); touch.used = true; btn.classList.add('on'); };
  const release = e => { e.preventDefault(); touch.buttons.delete(idx); btn.classList.remove('on'); };
  btn.addEventListener('pointerdown', press);
  btn.addEventListener('pointerup', release);
  btn.addEventListener('pointercancel', release);
  btn.addEventListener('pointerleave', release);
});
document.querySelectorAll('[data-tb-analog]').forEach(btn => {
  const which = btn.dataset.tbAnalog;
  const press = e => { e.preventDefault(); try { btn.setPointerCapture(e.pointerId); } catch {} touch[which] = 1; touch.used = true; btn.classList.add('on'); };
  const release = e => { e.preventDefault(); touch[which] = 0; btn.classList.remove('on'); };
  btn.addEventListener('pointerdown', press);
  btn.addEventListener('pointerup', release);
  btn.addEventListener('pointercancel', release);
  btn.addEventListener('pointerleave', release);
});

// ---- Montagem do frame de input por modo ----
function keyboardState() {
  const k = code => LIVE_KEYS.has(code);
  const stick = {
    lx: (k('KeyD') ? 1 : 0) - (k('KeyA') ? 1 : 0),
    ly: (k('KeyS') ? 1 : 0) - (k('KeyW') ? 1 : 0),
  };
  if (controlMode === 'driving') {
    // Dirigindo: WASD = esterço/acelerador/freio, Espaço = freio de mão.
    return {
      lx: stick.lx, ly: 0, rx: mouse.rx, ry: mouse.ry,
      lt: k('KeyS') ? 1 : 0, rt: k('KeyW') ? 1 : 0,
      buttons: k('Space') ? [1] : [],
    };
  }
  if (controlMode === 'menu') {
    const buttons = [];
    if (k('ArrowUp') || k('KeyW')) buttons.push(12);
    if (k('ArrowDown') || k('KeyS')) buttons.push(13);
    if (k('ArrowLeft') || k('KeyA')) buttons.push(14);
    if (k('ArrowRight') || k('KeyD')) buttons.push(15);
    if (k('Space') || k('Enter') || k('NumpadEnter')) buttons.push(0);
    if (k('Escape') || k('KeyC')) buttons.push(1);
    if (k('Tab')) buttons.push(9);
    return { lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0, buttons };
  }
  // foot (padrão): WASD move, mouse olha, Espaço=A, Shift=L3 sprint.
  const buttons = [];
  if (k('Space')) buttons.push(0);
  if (k('ShiftLeft') || k('ShiftRight')) buttons.push(10);
  if (k('KeyE')) buttons.push(2);
  if (k('KeyC')) buttons.push(1);
  if (k('KeyV')) buttons.push(3);
  if (k('KeyQ')) buttons.push(4);
  if (k('KeyR')) buttons.push(5);
  return { ...stick, rx: mouse.rx, ry: mouse.ry, lt: 0, rt: 0, buttons };
}
function gamepadState() {
  const pads = [...(navigator.getGamepads?.() ?? [])].filter(p => p && p.buttons.length >= 17);
  if (!pads.length) return null;
  const pad = pads.find(p => p.buttons.some(b => b.pressed) || p.axes.some(a => Math.abs(a) > 0.12)) ?? pads[0];
  const dz = v => Math.abs(v) < 0.12 ? 0 : v;
  const buttons = [];
  pad.buttons.forEach((b, i) => { if (b.pressed && [0, 1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 14, 15].includes(i)) buttons.push(i); });
  return {
    lx: dz(pad.axes[0] ?? 0), ly: dz(pad.axes[1] ?? 0), rx: dz(pad.axes[2] ?? 0), ry: dz(pad.axes[3] ?? 0),
    lt: pad.buttons[6]?.value ?? pad.axes[4] ?? 0, rt: pad.buttons[7]?.value ?? pad.axes[5] ?? 0, buttons,
  };
}
function touchState() {
  if (!touch.used) return null;
  return { lx: touch.lx, ly: touch.ly, rx: touch.rx, ry: touch.ry, lt: touch.lt, rt: touch.rt, buttons: [...touch.buttons] };
}
function currentInput() {
  // Gamepad só vence se tiver atividade REAL — um pad "fantasma" reportado
  // pelo browser (drivers/sensores) devolve zeros e apagaria o touch.
  const g = gamepadState();
  if (g && frameActive(g)) return g;
  return touchState() || keyboardState();
}
const NEUTRAL = { lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0, buttons: [] };
function frameActive(f) {
  return Math.abs(f.lx) + Math.abs(f.ly) + Math.abs(f.rx) + Math.abs(f.ry) + f.lt + f.rt + f.buttons.length > 0;
}
function inputLoop() {
  const mine = state?.current?.mine;
  if (inputChannel?.readyState !== 'open') return;
  // Decaimento do mouse look quando o mouse para.
  if (performance.now() - mouse.lastMove > 90) { mouse.rx *= 0.6; mouse.ry *= 0.6; if (Math.abs(mouse.rx) < 0.02) mouse.rx = 0; if (Math.abs(mouse.ry) < 0.02) mouse.ry = 0; }
  if (!mine) {
    if (sentActiveFlag) {
      sentActiveFlag = false;
      try { inputChannel.send(JSON.stringify({ t: state?.current?.controlToken, s: ++seq, ...NEUTRAL })); } catch {}
    }
    return;
  }
  const frame = currentInput();
  // Canal saturado: descarta o frame novo — os antigos já na fila valem menos
  // que o próximo ciclo; empilhar só aumenta o atraso do input.
  if (inputChannel.bufferedAmount > 131072) return;
  try {
    inputChannel.send(JSON.stringify({ t: state.current.controlToken, s: ++seq, ...frame }));
    pendingAcks.set(seq, performance.now());
    if (pendingAcks.size > 300) pendingAcks.delete(pendingAcks.keys().next().value);
  } catch {}
  sentActiveFlag = frameActive(frame) || sentActiveFlag;
}
let sentActiveFlag = false;
function startInputLoop() {
  stopInputLoop();
  inputTimer = setInterval(inputLoop, 1000 / 60);
}
function stopInputLoop() {
  if (inputTimer) clearInterval(inputTimer);
  inputTimer = null;
}
function sendVideoPref(p) {
  if (inputChannel?.readyState === 'open') {
    try { inputChannel.send(JSON.stringify({ type: 'video-pref', p })); } catch {}
  }
}
function sendNeutral() {
  if (inputChannel?.readyState === 'open') {
    try { inputChannel.send(JSON.stringify({ ...NEUTRAL, t: state?.current?.controlToken })); } catch {}
  }
}
function clientLog(evt, extra = {}) {
  try {
    navigator.sendBeacon('/api/client-log', new Blob([JSON.stringify({ evt, ua: navigator.userAgent.slice(0, 150), ...extra })], { type: 'application/json' }));
  } catch {}
}
async function connectLive(silent = false) {
  if (state?.rtcEnabled === false) { if (!silent) toast('RTC desligado pelo admin.'); return; }
  if (!state?.hostStreaming) { wakeHost(Boolean(state?.current?.mine)); if (!silent) toast('Acordando o PS5…'); return; }
  if (!state?.user) { openNick(); return; }
  if (connectBusy || pc) return;
  connectBusy = true;
  try {
    pc = new RTCPeerConnection(state?.iceServers?.length ? { iceServers: state.iceServers } : undefined);
    pc.ontrack = e => {
      // Folga do decoder: começa em 40ms (a 60fps cada frame tem ~17ms —
      // alvo zero transformava pico de decode em frame pulado) e o loop de
      // stats desce adaptativo enquanto não houver drops (menos vidro).
      videoReceiver = e.receiver;
      jitTarget = 40;
      setJitTarget(jitTarget);
      video.muted = false;
      video.srcObject = e.streams[0];
      video.hidden = false;
      $('#screen-placeholder').hidden = true;
      $('#screen-status').textContent = 'AO VIVO';
      updateLiveUi();
    };
    inputChannel = pc.createDataChannel('input', { ordered: false, maxRetransmits: 0 });
    inputChannel.onopen = () => { degrade.applied = null; degrade.count = 0; sendVideoPref(qualityPref); };
    inputChannel.onmessage = e => {
      try {
        const m = JSON.parse(e.data);
        if (m.type === 'input-ack') {
          const sent = pendingAcks.get(m.s);
          if (sent != null) {
            inputRtt = performance.now() - sent;
            inputProc = m.p;
            pendingAcks.delete(m.s);
          }
        }
      } catch {}
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc?.connectionState)) { clientLog('rtc-state', { cs: pc.connectionState, ice: pc.iceConnectionState }); disconnectLive('Conexão com o host encerrada.'); }
      else if (pc?.connectionState === 'connected') clientLog('rtc-connected', { ice: pc.iceConnectionState });
    };
    const transceiver = pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
    try {
      // HEVC primeiro: Chrome 136+/Safari 18+ oferecem H265 quando há decoder
      // HW (~86% dos Androids). Receiver caps (não sender): devices com só
      // decoder HEVC não listam H265 no sender, e o offer sairia H264-only.
      const all = RTCRtpReceiver.getCapabilities('video')?.codecs ?? [];
      const h265 = all.filter(c => c.mimeType.toLowerCase() === 'video/h265');
      const h264 = all.filter(c => c.mimeType.toLowerCase() === 'video/h264');
      clientLog('video-caps', {
        recv: all.map(c => c.mimeType).join(','),
        codec: codecPref,
      });
      let prefs;
      if (codecPref === 'h265') {
        if (h265.length) prefs = h265;
        else toast('Este browser não anuncia H.265 (sem decoder HW/WebRTC). Caindo p/ Auto.');
      }
      if (!prefs) {
        prefs = codecPref === 'h264' ? h264 : [...h265, ...h264];
      }
      if (prefs.length) transceiver.setCodecPreferences(prefs);
    } catch {}
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise(resolve => {
      if (pc.iceGatheringState === 'complete') return resolve();
      const done = () => { if (pc.iceGatheringState === 'complete') resolve(); };
      pc.addEventListener('icegatheringstatechange', done);
      setTimeout(resolve, 4000);
    });
    clientLog('rtc-offer-start', { rtc: typeof RTCPeerConnection, pads: navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean).map(p => p.id.slice(0, 40)) : 'no-api' });
    const res = await fetch('/api/offer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.user.csrf },
      body: JSON.stringify({ type: pc.localDescription.type, sdp: pc.localDescription.sdp }),
    });
    const ans = await readJson(res);
    if (!res.ok) throw new Error(ans.error || 'Falha ao contatar o agente.');
    await pc.setRemoteDescription(ans);
    negotiatedCodec = sdpVideoCodec(ans.sdp);
    startInputLoop();
    startStatsLoop();
    if (!silent) toast('Live conectada. Entre na fila, confirme seu turno e controle com gamepad, WASD ou touch.');
  } catch (error) {
    console.error('[connectLive]', error);
    clientLog('rtc-fail', { err: String(error?.message || error).slice(0, 200) });
    if (!silent) toast(String(error?.message || 'Não foi possível conectar à live.').slice(0, 200));
    disconnectLive();
  } finally {
    connectBusy = false;
    updateLiveUi();
  }
}
function disconnectLive(message) {
  stopInputLoop();
  stopStatsLoop();
  sendNeutral();
  if (inputChannel) { try { inputChannel.close(); } catch {} }
  if (pc) pc.close();
  pc = null; inputChannel = null; sentActiveFlag = false; inputRtt = inputProc = null; negotiatedCodec = null;
  video.pause(); video.srcObject = null; video.hidden = true;
  $('#screen-placeholder').hidden = false;
  const [label, cls] = hostPill();
  $('#screen-status').textContent = label;
  $('#screen-status').className = cls;
  updateScreenMode();
  updateLiveUi();
}
// ---- Modo de tela: jogador=WebRTC, espectador=YouTube ----
function toEmbedUrl(url) {
  if (!url) return null;
  const raw = url.trim();
  if (/^[\w-]{11}$/.test(raw)) return `https://www.youtube.com/embed/${raw}?autoplay=0&rel=0`;
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^(www|m)\./, '');
    if (host === 'youtu.be') {
      const id = u.pathname.slice(1).split('/')[0];
      return id ? `https://www.youtube.com/embed/${id}?autoplay=0&rel=0` : null;
    }
    if (!host.endsWith('youtube.com') && !host.endsWith('youtube-nocookie.com')) return null;
    if (u.pathname.startsWith('/embed/')) return raw;
    const v = u.searchParams.get('v');
    if (v) return `https://www.youtube.com/embed/${v}?autoplay=0&rel=0`;
    const m = u.pathname.match(/\/(live|shorts)\/([\w-]{6,})/);
    if (m) return `https://www.youtube.com/embed/${m[2]}?autoplay=0&rel=0`;
    return null;
  } catch { return null; }
}
// ---- Espectador: stream única do servidor via MediaMTX (WHEP) ----
let specPc = null, specBusy = false, specFails = 0, lastSpecKey = null, specStopped = false, ytWatching = false;
async function connectSpectator() {
  if (specPc || specBusy) return;
  specBusy = true;
  try {
    const spc = new RTCPeerConnection(state?.iceServers?.length ? { iceServers: state.iceServers } : undefined);
    specPc = spc;
    $('#unwatch-btn').hidden = false;
    spc.addTransceiver('video', { direction: 'recvonly' });
    spc.addTransceiver('audio', { direction: 'recvonly' });
    // WHEP pode mandar áudio e vídeo em MediaStreams separados — juntar os
    // dois tracks num stream só evita srcObject ficar com o stream errado.
    const specStream = new MediaStream();
    spc.ontrack = e => {
      if (!specPc) return;
      specStream.addTrack(e.track);
      video.srcObject = specStream;
      // Só desoculta no 'playing' (primeiro frame real) — evita a caixa preta
      // enquanto o primeiro keyframe não chega.
      video.onplaying = () => { video.hidden = false; $('#screen-placeholder').hidden = true; };
      // Autoplay com som pode ser bloqueado sem gesto prévio — cai mutado
      // e mostra o botão 🔇 pra o usuário ativar o som com um toque.
      video.play().catch(() => {
        video.muted = true;
        video.play().catch(() => {});
        $('#unmute-btn').hidden = false;
      });
    };
    const offer = await spc.createOffer();
    await spc.setLocalDescription(offer);
    await new Promise(res => {
      if (spc.iceGatheringState === 'complete') return res();
      const t = setTimeout(res, 4000);
      spc.addEventListener('icegatheringstatechange', () => { if (spc.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
    });
    const res = await fetch('/api/whep', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sdp: spc.localDescription.sdp }) });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data?.error || `whep HTTP ${res.status}`);
    if (!specPc) return;
    await spc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
    specFails = 0;
    clientLog('spec-connect', {});
  } catch (e) {
    console.error('[spectator]', e);
    specFails++;
    disconnectSpectator();
    if (specFails < 3) setTimeout(updateScreenMode, 4000); // publicação ainda subindo
  } finally {
    specBusy = false;
  }
}
function disconnectSpectator() {
  if (!specPc) return;
  try { specPc.close(); } catch {}
  specPc = null;
  video.onplaying = null;
  video.srcObject = null;
  video.hidden = true;
  $('#unwatch-btn').hidden = true;
  $('#unmute-btn').hidden = true;
}
function updateScreenMode() {
  const cur = state?.current;
  const rtcOn = state?.rtcEnabled !== false;
  const mine = Boolean(cur?.mine) && rtcOn;
  if (mine) specStopped = false; // jogou o turno — volta a assistir normal depois
  const ytUrl = toEmbedUrl(state?.spectatorUrl);
  // Modo relay (stream pública do PS5 no ar) = chave de retry do WHEP.
  const specKey = state?.spectatorMode === 'relay' ? 'relay' : 'youtube';
  if (specKey !== lastSpecKey) { lastSpecKey = specKey; specFails = 0; specStopped = false; }
  $('#watch-btn').hidden = true;
  $('#screen-placeholder .wake-spin').hidden = false;
  if (!rtcOn) {
    // Modo local: admin desligou o RTC — todos veem o embed do canal
    // (live em curso se houver, senão a última). autoplay=0 no embed.
    if (pc) disconnectLive();
    if (specPc) disconnectSpectator();
    video.hidden = true;
    if (ytUrl) {
      if (ytFrame.getAttribute('src') !== ytUrl) ytFrame.src = ytUrl;
      ytFrame.hidden = false;
      $('#screen-placeholder').hidden = true;
    } else {
      if (!ytFrame.hidden) ytFrame.src = 'about:blank';
      ytFrame.hidden = true;
      $('#screen-placeholder').hidden = false;
      $('#screen-load').textContent = 'Jogando local — site desligado pelo admin';
    }
    $('#screen-status').textContent = 'RTC DESLIGADO';
    $('#screen-status').className = 'pill';
    return;
  }
  if (!mine && state?.spectatorMode === 'relay' && !specStopped && specFails < 3) {
    // Espectador: stream única do servidor (WHEP) — ativa sempre que o
    // chiaki está conectado ao PS5, com ou sem jogador no turno.
    if (pc) disconnectLive();
    if (!ytFrame.hidden) ytFrame.src = 'about:blank';
    ytFrame.hidden = true;
    if (!specPc) connectSpectator();
    if (video.hidden) $('#screen-placeholder').hidden = false;
    $('#screen-status').textContent = 'AO VIVO · na sala';
    $('#screen-status').className = 'pill live';
    return;
  }
  if (!mine && state?.spectatorMode === 'relay' && specStopped) {
    // Espectador clicou em "Parar de assistir" — desconecta do relay e
    // fica no placeholder até clicar em "Assistir de novo".
    if (pc) disconnectLive();
    if (specPc) disconnectSpectator();
    if (!ytFrame.hidden) ytFrame.src = 'about:blank';
    ytFrame.hidden = true;
    video.hidden = true;
    $('#screen-placeholder').hidden = false;
    $('#screen-placeholder .wake-spin').hidden = true;
    $('#screen-load').textContent = 'Você parou de assistir';
    $('#watch-btn').hidden = false;
    $('#screen-status').textContent = 'AO VIVO · na sala';
    $('#screen-status').className = 'pill live';
    return;
  }
  if (specPc) disconnectSpectator();
  if (!mine) {
    if (pc) disconnectLive();
    // Sem stream do host: PS5 dormindo. A live do YouTube é GRAVADA —
    // não mostrar como "ao vivo" nem dar autoplay; o usuário escolhe.
    if (ytWatching && ytUrl) {
      if (ytFrame.getAttribute('src') !== ytUrl) ytFrame.src = ytUrl;
      ytFrame.hidden = false;
      video.hidden = true;
      $('#screen-placeholder').hidden = true;
      $('#screen-status').textContent = 'ÚLTIMA LIVE';
      $('#screen-status').className = 'pill';
      return;
    }
    if (!ytFrame.hidden) ytFrame.src = 'about:blank';
    ytFrame.hidden = true;
    video.hidden = true;
    $('#screen-placeholder').hidden = false;
    const waking = isWaking();
    $('#screen-placeholder .wake-spin').hidden = !waking;
    $('#screen-load').textContent = waking ? 'Acordando o PS5 — pode levar ~1 min…' : 'PS5 dormindo';
    $('#sleep-actions').hidden = waking;
    $('#wake-btn').hidden = !state?.hostOnline;
    $('#yt-btn').hidden = !ytUrl;
    $('#screen-status').textContent = 'PS5 DORMINDO';
    $('#screen-status').className = 'pill';
    return;
  }
  if (!ytFrame.hidden) ytFrame.src = 'about:blank';
  ytFrame.hidden = true;
  $('#sleep-actions').hidden = true;
  // Jogador atual: WebRTC direto (auto-connect cuida da conexão).
  if (!pc) {
    $('#screen-placeholder').hidden = false;
    const [label, cls] = hostPill();
    $('#screen-status').textContent = label;
    $('#screen-status').className = cls;
  }
}
const isCoarse = matchMedia('(pointer: coarse)').matches;
function updateLiveUi() {
  const on = Boolean(pc);
  $('#live-bar').hidden = !on;
  $('#zen-btn').hidden = !on;
  $('#stop-btn').hidden = !state?.current?.mine; // sai do turno mesmo antes do RTC abrir
  if (!on) { document.querySelector('.screen')?.classList.remove('zen'); $('#zen-btn').textContent = '⌄'; }
  if (!padHideBlocked && !padAutoHide && physicalPadConnected()) padAutoHide = true;
  $('#touch-pad').hidden = !(on && state?.current?.mine && isCoarse && !padAutoHide);
  // 🎮 flutuante quando o overlay deveria aparecer mas está suprimido
  // (auto-hide por gamepad físico ou modo PAD×).
  $('#pad-show-btn').hidden = !(on && state?.current?.mine && isCoarse && (padAutoHide || padMode === 'off'));
  $('#mode-btn').textContent = `Modo: ${MODES[controlMode]}`;
  $('#quality-sel').value = qualityPref;
  $('#codec-sel').value = codecPref;
  $('#stats-hud').hidden = !on;
}
function maybeAutoConnect() {
  const cur = state?.current;
  if (!cur?.mine || !state.hostStreaming || state?.rtcEnabled === false || pc || connectBusy) return;
  if (Date.now() - lastAutoAttempt < 8000) return;
  const key = `${cur.name}:${cur.startedAt}`;
  if (autoConnectKey === key || suppressedTurn === key) return;
  autoConnectKey = key;
  lastAutoAttempt = Date.now();
  connectLive(true);
}
function enterFullscreen() {
  const screen = document.querySelector('.screen');
  if (!document.fullscreenElement) screen?.requestFullscreen?.().catch(() => {});
}
$('#zen-btn').addEventListener('click', () => {
  const zen = document.querySelector('.screen')?.classList.toggle('zen');
  $('#zen-btn').textContent = zen ? '⌃' : '⌄';
});
$('#stop-btn').addEventListener('click', () => action('leave'));
$('#unwatch-btn').addEventListener('click', () => {
  specStopped = true;
  updateScreenMode();
});
$('#wake-btn').addEventListener('click', () => {
  wakeHost(false); // liga o PS5 pra live pública — não entra no turno
  updateScreenMode();
});
$('#yt-btn').addEventListener('click', () => {
  ytWatching = true;
  updateScreenMode();
});
$('#watch-btn').addEventListener('click', () => {
  specStopped = false; specFails = 0;
  updateScreenMode();
});
$('#unmute-btn').addEventListener('click', () => {
  video.muted = false;
  $('#unmute-btn').hidden = true;
});
$('#fs-btn').addEventListener('click', () => {
  const screen = document.querySelector('.screen');
  if (document.fullscreenElement) document.exitFullscreen();
  else screen.requestFullscreen?.();
});
document.addEventListener('fullscreenchange', () => {
  $('#fs-btn').textContent = '⛶';
});
window.addEventListener('popstate', () => {
  if (document.fullscreenElement) document.exitFullscreen();
});
window.addEventListener('pagehide', sendNeutral);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { LIVE_KEYS.clear(); sendNeutral(); }
  else refresh(); // volta do background: ressincroniza deadline/estado do servidor
});

// ---- Diagnóstico WebRTC ----
let statsTimer = null, lastStatsSample = null;
async function updateStats() {
  if (!pc) return;
  try {
    const report = await pc.getStats();
    let video = null, pair = null, localCand = null, remoteCand = null;
    const candidates = new Map(), codecMap = new Map();
    report.forEach(r => { if (r.type === 'local-candidate' || r.type === 'remote-candidate') candidates.set(r.id, r); });
    report.forEach(r => {
      if (r.type === 'inbound-rtp' && r.kind === 'video' && !video) video = r;
      else if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated && !pair) pair = r;
      else if (r.type === 'codec') codecMap.set(r.id, r);
    });
    if (pair) {
      localCand = candidates.get(pair.localCandidateId);
      remoteCand = candidates.get(pair.remoteCandidateId);
    }
    const codecMime = (video?.codecId && codecMap.get(video.codecId)?.mimeType) || negotiatedCodec;
    const m = []; // [rótulo, valor]
    const head = [];
    if (codecMime) {
      const cls = codecMime === 'video/H265' ? 'hevc' : codecMime === 'video/H264' ? 'avc' : 'other';
      head.push(`<span class="hud-codec ${cls}">${codecLabel(codecMime)}</span>`);
    }
    if (pair?.currentRoundTripTime != null) m.push(['RTT', `${(pair.currentRoundTripTime * 1000).toFixed(0)}ms`]);
    if (inputRtt != null) m.push(['input', `${inputRtt.toFixed(0)}ms`]);
    if (inputProc != null) m.push(['proc', `${inputProc.toFixed(1)}ms`]);
    if (video) {
      const jitterMs = (video.jitterBufferDelay != null && video.jitterBufferTarget != null && video.jitterBufferTarget > 0)
        ? (video.jitterBufferDelay / video.jitterBufferTarget) * 1000 : null;
      if (jitterMs != null) m.push(['buf', `${jitterMs.toFixed(0)}ms`]);
      else if (video.jitter != null) m.push(['jit', `${(video.jitter * 1000).toFixed(0)}ms`]);
      if (video.packetsLost != null && video.packetsReceived > 0) {
        const loss = video.packetsLost / (video.packetsLost + video.packetsReceived) * 100;
        m.push(['loss', `${loss.toFixed(1)}%`]);
      }
      // Catch-up: se o jitter buffer do browser acumular (soluços de rede/
      // decode no celular), acelera o playback sutilmente até drenar — sem
      // isso, um pico de latência fica preso pra sempre no vidro.
      if (jitterMs != null && !liveVideo.paused) {
        const rate = jitterMs > 350 ? 1.2 : jitterMs > 200 ? 1.08 : 1.0;
        if (liveVideo.playbackRate !== rate) liveVideo.playbackRate = rate;
      } else if (liveVideo.playbackRate !== 1.0) liveVideo.playbackRate = 1.0;
      if (video.frameWidth) head.push(`<span class="hud-res">${video.frameWidth}×${video.frameHeight}</span>`);
      if (video.framesPerSecond != null) head.push(`<span class="hud-main">${video.framesPerSecond.toFixed(0)}<i>fps</i></span>`);
      else if (video.framesDecoded != null && lastStatsSample?.framesDecoded != null) {
        const dt = (video.timestamp - lastStatsSample.timestamp) / 1000;
        if (dt > 0) head.push(`<span class="hud-main">${((video.framesDecoded - lastStatsSample.framesDecoded) / dt).toFixed(0)}<i>fps</i></span>`);
      }
      if (video.bytesReceived != null && lastStatsSample?.bytesReceived != null) {
        const dt = (video.timestamp - lastStatsSample.timestamp) / 1000;
        if (dt > 0) head.push(`<span class="hud-main">${((video.bytesReceived - lastStatsSample.bytesReceived) * 8 / dt / 1e6).toFixed(1)}<i>Mbps</i></span>`);
      }
      if (video.totalDecodeTime != null && video.framesDecoded > 0) {
        m.push(['dec', `${(video.totalDecodeTime / video.framesDecoded * 1000).toFixed(1)}ms`]);
      }
      if (video.framesDropped) m.push(['drop', `${video.framesDropped}`]);
      if (video.freezeCount) m.push(['freeze', `${video.freezeCount}`]);
      if (pair?.availableIncomingBitrate != null) {
        m.push(['est', `${(pair.availableIncomingBitrate / 1e6).toFixed(1)}M`]);
      }
      const dropDelta = (video.framesDropped ?? 0) - (lastStatsSample?.framesDropped ?? video.framesDropped ?? 0);
      // Jitter buffer adaptativo: ~8 amostras limpas → desce 10ms (piso 15ms,
      // ~1 frame a 60fps). Drop voltou → sobe pra 40ms na hora.
      if (dropDelta >= 2) {
        if (jitTarget !== 40) { jitTarget = 40; setJitTarget(jitTarget); }
        jitCalm = 0;
      } else if (++jitCalm >= 8 && jitTarget > 15) {
        jitTarget = Math.max(15, jitTarget - 10);
        setJitTarget(jitTarget);
        jitCalm = 0;
      }
      if (dropDelta >= 3) degrade.count++; else degrade.count = Math.max(0, degrade.count - 1);
      if (degrade.cooldown > 0) degrade.cooldown--;
      if (degrade.count >= 3 && degrade.cooldown <= 0) {
        const idx = Q_LADDER.indexOf(degrade.applied ?? qualityPref);
        if (idx >= 0 && idx < Q_LADDER.length - 1) {
          degrade.applied = Q_LADDER[idx + 1];
          try { inputChannel?.send(JSON.stringify({ type: 'video-pref', p: degrade.applied })); } catch {}
          toast(`Vídeo travando — qualidade reduzida p/ ${$('#quality-sel option[value="' + degrade.applied + '"]')?.textContent || degrade.applied}`);
          degrade.cooldown = 8;
        }
        degrade.count = 0;
      }
      lastStatsSample = { framesDecoded: video.framesDecoded, framesDropped: video.framesDropped, bytesReceived: video.bytesReceived, timestamp: video.timestamp };
    }
    const pairType = [localCand?.candidateType, remoteCand?.candidateType].filter(Boolean).join('→');
    if (pairType) m.push(['via', pairType]);
    $('#stats-hud').innerHTML = head.length || m.length
      ? `<div class="hud-top">${head.join('')}</div><div class="hud-grid">${m.map(([k, v]) => `<span class="hud-m">${k}<b>${v}</b></span>`).join('')}</div>`
      : 'coletando…';
  } catch {}
}
function startStatsLoop() {
  stopStatsLoop();
  statsTimer = setInterval(updateStats, 1000);
}
function stopStatsLoop() {
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = null;
  lastStatsSample = null;
}
// Restaura preferências de UI.
$('#mode-btn').textContent = `Modo: ${MODES[controlMode]}`;
$('#quality-sel').value = qualityPref;
$('#mouse-look-btn').classList.toggle('on', mouseLook);
updateLiveUi();
refresh();

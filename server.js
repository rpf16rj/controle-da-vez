import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import QRCode from 'qrcode';
import { Room } from './session.js';
import { UserStore } from './users.js';

const DATA_DIR = process.env.DATA_DIR || dirname(fileURLToPath(import.meta.url));

const AGENT_URL = process.env.AGENT_URL || 'http://127.0.0.1:3001';
const AGENT_TOKEN = process.env.AGENT_TOKEN || '';
const MTX_URL = process.env.MTX_URL || 'http://mediamtx:8889';
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || '127.0.0.1:3000,localhost:3000').split(',');
const ICE_SERVERS = JSON.parse(process.env.ICE_SERVERS || '[]');
// WAN ativa: wan-watch.sh (cron no host) grava data/net.json com o IP público
// de saída e mantém o --external-ip do coturn igual. Aqui o host dos
// turn:/turns: do ICE_SERVERS é trocado por esse IP — failover de WAN ou IP
// dinâmico não deixam mais o TURN apontando pra endereço morto.
const NET_FILE = join(DATA_DIR, 'net.json');
let netCache = { at: 0, net: null };
function hostNet() {
  if (Date.now() - netCache.at < 10_000) return netCache.net;
  let net = null;
  try {
    const raw = JSON.parse(readFileSync(NET_FILE, 'utf8'));
    const age = Math.round((Date.now() - Date.parse(raw.checkedAt)) / 1000);
    net = { ip: raw.ip || null, checkedAt: raw.checkedAt, since: raw.since, ageSec: age, stale: !(age < 300), error: raw.error || undefined };
  } catch {}
  netCache = { at: Date.now(), net };
  return net;
}
function iceServers() {
  const net = hostNet();
  let list = ICE_SERVERS;
  if (net?.ip && !net.stale) {
    list = ICE_SERVERS.map(s => ({
      ...s,
      urls: [].concat(s.urls).map(u => u.replace(/^(turns?:)[^:?]+/, `$1${net.ip}`)),
    }));
  }
  return list.length ? list : undefined;
}
const SPECTATOR_URL = process.env.SPECTATOR_URL || process.env.YOUTUBE_URL || '';
const YT_CHANNEL = (process.env.YT_CHANNEL || 'https://www.youtube.com/@CHANGE_ME').replace(/\/$/, '');
let ytCache = { at: 0, url: null };

// Resolve a live atual do canal (ou a última transmissão) sem API key:
// /@canal/live redireciona pro vídeo quando ao vivo; /@canal/streams lista a mais recente.
async function resolveSpectator() {
  if (Date.now() - ytCache.at < 120_000 && ytCache.url) return ytCache.url;
  const ua = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0 Safari/537.36' };
  try {
    const live = await fetch(`${YT_CHANNEL}/live`, { headers: ua, signal: AbortSignal.timeout(8000) });
    const liveId = /[?&]v=([\w-]{11})/.exec(live.url)?.[1];
    if (live.ok && liveId) {
      ytCache = { at: Date.now(), url: `https://www.youtube.com/watch?v=${liveId}` };
      return ytCache.url;
    }
    const page = await fetch(`${YT_CHANNEL}/streams`, { headers: ua, signal: AbortSignal.timeout(8000) });
    const id = /"videoId":"([\w-]{11})"/.exec(await page.text())?.[1];
    if (id) ytCache = { at: Date.now(), url: `https://www.youtube.com/watch?v=${id}` };
  } catch {}
  return ytCache.url || SPECTATOR_URL || null;
}
resolveSpectator();
const PIX_CODE = process.env.PIX_CODE || '';
const PIX_AMOUNT = process.env.PIX_AMOUNT || '';
const PIX_ENABLED = process.env.PIX_ENABLED === '1';
let rtcEnabled = process.env.RTC_ENABLED !== '0';
const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASS = process.env.ADMIN_PASS || '';
// Rota "secreta" do painel — configurável via ADMIN_PATH no ambiente.
const ADMIN_PATH = process.env.ADMIN_PATH || '/admin-secret-change-me';

const ASSET_V = Date.now().toString(36);
const room = new Room({
  onTurnEnd: (userId, ms) => store.addPlayMs(userId, ms),
});
const store = new UserStore();
if (ADMIN_USER && ADMIN_PASS) store.ensureAdmin(ADMIN_USER, ADMIN_PASS);
let lastGrant = null;
let grantTimer = null;
let agentOnlineCache = { at: 0, online: false, streaming: false, waking: false };

async function agentOnline() {
  if (Date.now() - agentOnlineCache.at < 5000) return agentOnlineCache;
  try {
    const res = await fetch(`${AGENT_URL}/health`, { signal: AbortSignal.timeout(2000) });
    const info = res.ok ? await res.json() : {};
    agentOnlineCache = { at: Date.now(), online: res.ok, streaming: !!info.streaming, waking: !!info.waking, publishing: !!info.publishing };
  } catch {
    agentOnlineCache = { at: Date.now(), online: false, streaming: false, waking: false, publishing: false };
  }
  return agentOnlineCache;
}

async function syncGrant(force = false) {
  room.tick();
  const playing = room.current ?? null;
  // rtcEnabled=false: revoga o controle na hora (grant nulo) — quem estiver
  // no turno perde o input imediatamente; modo local sem interrupções.
  const grant = (playing && rtcEnabled) ? { token: playing.turnToken, expiresAt: Date.now() + 30_000 } : { token: null };
  const signature = JSON.stringify(grant);
  if (!force && signature === lastGrant) return;
  lastGrant = signature;
  try {
    const agent = await fetch(`${AGENT_URL}/grant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(AGENT_TOKEN ? { Authorization: `Bearer ${AGENT_TOKEN}` } : {}) },
      body: signature,
      signal: AbortSignal.timeout(3000),
    });
    if (!agent.ok) lastGrant = null;
  } catch {
    lastGrant = null;
  }
}

function scheduleGrantSync() {
  if (grantTimer) return;
  grantTimer = setTimeout(() => { grantTimer = null; syncGrant(); }, 150);
}

setInterval(() => syncGrant(), 5000);
setInterval(() => syncGrant(true), 60000);

// ---- SSE: push de estado para os clientes ----
const sseClients = new Set();
function sessionUser(sid) {
  const session = store.session(sid);
  if (!session) return null;
  const user = store.user(session.userId);
  return user ? { session, user } : null;
}
function publicUser(auth) {
  if (!auth) return null;
  const u = auth.user;
  return {
    name: u.name, username: u.username, role: u.role,
    approved: u.approved || u.role === 'admin',
    csrf: auth.session.csrf,
  };
}
const isApproved = a => !!(a && (a.user.approved || a.user.role === 'admin'));
const releaseTimers = new Map();
const RELEASE_GRACE_MS = Number(process.env.RELEASE_GRACE_MS || 15000);
function scheduleRelease(uid) {
  if (!uid || releaseTimers.has(uid)) return;
  if ([...sseClients].some(c => c.id === uid)) return;
  releaseTimers.set(uid, setTimeout(() => {
    releaseTimers.delete(uid);
    if ([...sseClients].some(c => c.id === uid)) return;
    const hadRole = room.current?.id === uid || room.waiter?.id === uid || room.request?.id === uid;
    room.leave(uid);
    if (hadRole) { scheduleGrantSync(); broadcastState(); }
  }, RELEASE_GRACE_MS));
}
function cancelRelease(uid) {
  const t = releaseTimers.get(uid);
  if (t) { clearTimeout(t); releaseTimers.delete(uid); }
}
function presence() {
  const names = new Set();
  for (const c of sseClients) {
    if (!c.id) continue;
    const u = store.user(c.id);
    if (u) names.add(u.name);
  }
  return { viewers: sseClients.size, logged: names.size, names: [...names] };
}
function clientPayload(uid, sid) {
  return {
    ...room.snapshot(uid),
    hostOnline: agentOnlineCache.online,
    hostStreaming: agentOnlineCache.streaming,
    hostWaking: agentOnlineCache.waking,
    iceServers: iceServers(),
    hostNet: hostNet() || undefined,
    spectatorUrl: ytCache.url || SPECTATOR_URL || undefined,
    // RTC off (modo local) → todo mundo vê o YouTube, nunca o relay do PS5.
    spectatorMode: rtcEnabled && agentOnlineCache.publishing ? 'relay' : 'youtube',
    rtcEnabled,
    pixEnabled: PIX_ENABLED && Boolean(PIX_CODE),
    pixAmount: PIX_AMOUNT || undefined,
    ranking: store.ranking(5),
    online: presence(),
    ...(isApproved(sessionUser(sid)) ? chatTail() : { chat: [], chatMore: false }),
    ...(sessionUser(sid)?.user.role === 'admin'
      ? { pending: store.users.filter(u => u.role !== 'admin' && !u.approved).map(u => ({ id: u.id, name: u.name })) }
      : {}),
    user: publicUser(sessionUser(sid)),
  };
}
function broadcastState() {
  if (!sseClients.size) return;
  const dead = [];
  for (const client of sseClients) {
    try {
      client.res.write('data: ' + JSON.stringify(clientPayload(client.id, client.sid)) + '\n\n');
    } catch { dead.push(client); }
  }
  dead.forEach(c => sseClients.delete(c));
}
async function agentFetch(path, body) {
  try {
    await fetch(`${AGENT_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(AGENT_TOKEN ? { Authorization: `Bearer ${AGENT_TOKEN}` } : {}) },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(4000),
    });
  } catch {}
}
// ---- Chat da sala: últimas 500 mensagens persistidas em chat.json;
// o payload leva só a página mais recente (o resto via /api/chat/older). ----
const CHAT_FILE = join(DATA_DIR, 'chat.json');
const CHAT_MAX = 500, CHAT_PAGE = 30;
const chatLog = [];
try {
  const saved = JSON.parse(readFileSync(CHAT_FILE, 'utf8'));
  if (Array.isArray(saved)) chatLog.push(...saved.filter(m => m?.n && m?.t).slice(-CHAT_MAX));
} catch {}
const chatTail = () => ({ chat: chatLog.slice(-CHAT_PAGE), chatMore: chatLog.length > CHAT_PAGE });
let chatSaveTimer = null;
function saveChat() {
  if (chatSaveTimer) return;
  chatSaveTimer = setTimeout(() => {
    chatSaveTimer = null;
    try {
      const tmp = CHAT_FILE + '.tmp';
      writeFileSync(tmp, JSON.stringify(chatLog));
      renameSync(tmp, CHAT_FILE);
    } catch (e) { console.error('chat.json: falha ao salvar:', e.message); }
  }, 500);
}
const chatThrottle = new Map();

let lastSig = '';
let heartbeatTick = 0;
setInterval(() => {
  room.tick();
  agentOnline();
  resolveSpectator();
  const c = room.current;
  // A publicação única p/ espectadores é gerida pelo agente: ele publica
  // no MediaMTX enquanto a janela do chiaki existir (publish supervisor).
  const sig = JSON.stringify([c?.id, c?.startedAt, room.request?.id, room.waiter?.id, room.declined?.id, room.completed, agentOnlineCache.online, agentOnlineCache.streaming, agentOnlineCache.waking, ytCache.url]);
  heartbeatTick++;
  if (sig !== lastSig) { lastSig = sig; broadcastState(); }
  else if (heartbeatTick % 40 === 0) { // ~20s
    for (const client of sseClients) { try { client.res.write(': ping\n\n'); } catch {} }
  }
}, 500);

const files = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/mobile.css': ['mobile.css', 'text/css; charset=utf-8'],
  [ADMIN_PATH]: ['admin.html', 'text/html; charset=utf-8'],
  '/admin.js': ['admin.js', 'text/javascript; charset=utf-8'],
  '/pix-qr.png': ['pix-qr.png', 'image/png'],
};
const cookieFor = (sid, proto) =>
  `cdv_session=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 24 * 3600}${proto === 'https' ? '; Secure' : ''}`;
const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };

// Rate limit simples para tentativas de login/cadastro.
const authAttempts = new Map(); // ip -> { count, reset }
function authThrottle(req) {
  const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '?';
  const now = Date.now();
  let rec = authAttempts.get(ip);
  if (!rec || rec.reset < now) { rec = { count: 0, reset: now + 60000 }; authAttempts.set(ip, rec); }
  if (++rec.count > 15) return false;
  if (authAttempts.size > 5000) authAttempts.clear();
  return true;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; frame-src https://www.youtube.com https://www.youtube-nocookie.com");
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const base = `${proto}://${host}`;
  if (!ALLOWED_HOSTS.includes(host)) return json(res, 403, { error: 'Host não permitido.' });
  const path = new URL(req.url, base).pathname;
  try {
    if (req.method === 'GET' && files[path]) {
      const [file, type] = files[path];
      const url = new URL(file, import.meta.url);
      try {
        let body = await readFile(url);
        if (file.endsWith('.html')) body = Buffer.from(body.toString().replaceAll('?v=auth', `?v=${ASSET_V}`));
        res.setHeader('Content-Type', type);
        res.setHeader('Cache-Control', 'no-cache');
        return res.end(body);
      } catch {
        return json(res, 404, { error: 'Não encontrado.' });
      }
    }
    if (!path.startsWith('/api/')) return json(res, 404, { error: 'Não encontrado.' });
    const sid = /(?:^|;\s*)cdv_session=([a-f0-9]{48})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
    const auth = sessionUser(sid);
    const uid = auth?.user.id ?? null;
    if (req.method === 'GET' && path === '/api/state') {
      const agent = await agentOnline();
      return json(res, 200, {
        ...room.snapshot(uid), hostOnline: agent.online, hostStreaming: agent.streaming, hostWaking: agent.waking,
        iceServers: iceServers(),
        hostNet: hostNet() || undefined,
        spectatorUrl: ytCache.url || SPECTATOR_URL || undefined,
        spectatorMode: rtcEnabled && agent.publishing ? 'relay' : 'youtube',
        rtcEnabled,
        pixEnabled: PIX_ENABLED && Boolean(PIX_CODE), pixAmount: PIX_AMOUNT || undefined,
        ranking: store.ranking(5),
        online: presence(),
        ...(isApproved(auth) ? chatTail() : { chat: [], chatMore: false }),
        ...(auth?.user.role === 'admin'
          ? { pending: store.users.filter(u => u.role !== 'admin' && !u.approved).map(u => ({ id: u.id, name: u.name })) }
          : {}),
        user: publicUser(auth),
      });
    }
    // Página anterior do chat: GET /api/chat/older?before=<ts> — restrita a
    // quem está logado e aprovado (mesma regra do tail no estado).
    if (req.method === 'GET' && path === '/api/chat/older') {
      if (!isApproved(auth)) return json(res, 403, { error: 'Entre para ver o chat.' });
      const before = Number(new URL(req.url, base).searchParams.get('before'));
      const pool = Number.isFinite(before) ? chatLog.filter(m => m.at < before) : chatLog;
      return json(res, 200, { messages: pool.slice(-CHAT_PAGE), more: pool.length > CHAT_PAGE });
    }
    if (req.method === 'GET' && path === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const client = { res, id: uid, sid };
      sseClients.add(client);
      cancelRelease(uid);
      broadcastState();
      req.on('close', () => { sseClients.delete(client); scheduleRelease(uid); broadcastState(); });
      const agent = await agentOnline();
      res.write('data: ' + JSON.stringify({ ...clientPayload(uid, sid), hostOnline: agent.online, hostStreaming: agent.streaming, hostWaking: agent.waking }) + '\n\n');
      return;
    }
    // Admin: lista de usuários.
    if (req.method === 'GET' && path === '/api/admin/users') {
      if (auth?.user.role !== 'admin') return json(res, 403, { error: 'Acesso restrito ao administrador.' });
      return json(res, 200, { users: store.list() });
    }
    if (req.method === 'GET' && path === '/api/pix') {
      if (!auth) return json(res, 401, { error: 'Entre na sua conta para ver os dados do Pix.' });
      if (!PIX_CODE) return json(res, 404, { error: 'Pix não configurado.' });
      const payload = PIX_CODE;
      const out = { payload, amount: PIX_AMOUNT || null, qr: null };
      try {
        out.qr = await QRCode.toDataURL(payload, { width: 320, margin: 1 });
      } catch {}
      if (existsSync(new URL('pix-qr.png', import.meta.url))) out.image = '/pix-qr.png';
      return json(res, 200, out);
    }
    if (req.method !== 'POST' || req.headers.origin !== base || !req.headers['content-type']?.startsWith('application/json')) return json(res, 403, { error: 'Origem ou formato inválido.' });
    const bodyLimit = (path === '/api/offer' || path === '/api/whep') ? 262144 : 4096;
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (Buffer.byteLength(body) > bodyLimit) return json(res, 413, { error: 'Mensagem muito grande.' });
    }
    if (path === '/api/wake') {
      if (!auth) return json(res, 401, { error: 'Entre na sua conta para acordar o PS5.' });
      const csrf = req.headers['x-csrf-token'];
      if (typeof csrf !== 'string' || csrf.length !== auth.session.csrf.length || !timingSafeEqual(Buffer.from(csrf), Buffer.from(auth.session.csrf))) {
        return json(res, 403, { error: 'Sessão inválida. Atualize a página.' });
      }
      try {
        const agent = await fetch(`${AGENT_URL}/wake`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(AGENT_TOKEN ? { Authorization: `Bearer ${AGENT_TOKEN}` } : {}) },
          body: '{}',
          signal: AbortSignal.timeout(3000),
        });
        const text = await agent.text();
        setTimeout(broadcastState, 1000);
        res.writeHead(agent.status, { 'Content-Type': 'application/json' });
        return res.end(text);
      } catch {
        return json(res, 503, { error: 'Agente local indisponível. Verifique o PC do jogo.' });
      }
    }
    if (path === '/api/offer') {
      if (!auth) return json(res, 401, { error: 'Entre na sua conta para conectar.' });
      if (!rtcEnabled) return json(res, 503, { error: 'RTC desligado pelo admin.' });
      const csrf = req.headers['x-csrf-token'];
      if (typeof csrf !== 'string' || csrf.length !== auth.session.csrf.length || !timingSafeEqual(Buffer.from(csrf), Buffer.from(auth.session.csrf))) {
        return json(res, 403, { error: 'Sessão inválida. Atualize a página.' });
      }
      try {
        const agent = await fetch(`${AGENT_URL}/offer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(AGENT_TOKEN ? { Authorization: `Bearer ${AGENT_TOKEN}` } : {}) },
          body,
        });
        const text = await agent.text();
        res.writeHead(agent.status, { 'Content-Type': 'application/json' });
        return res.end(text);
      } catch {
        return json(res, 503, { error: 'Agente local indisponível. Verifique o PC do jogo.' });
      }
    }
    if (path === '/api/whep') {
      // Espectadores: SDP -> MediaMTX (1 stream upstream, N viewers).
      if (!rtcEnabled) return json(res, 503, { error: 'RTC desligado pelo admin.' });
      try {
        const sdp = JSON.parse(body || '{}').sdp;
        if (typeof sdp !== 'string' || sdp.length < 10) return json(res, 400, { error: 'SDP inválido.' });
        const mtx = await fetch(`${MTX_URL}/ps5/whep`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/sdp' },
          body: sdp,
          signal: AbortSignal.timeout(8000),
        });
        const text = await mtx.text();
        if (!mtx.ok) return json(res, mtx.status, { error: 'Stream indisponível no momento.' });
        return json(res, 200, { sdp: text });
      } catch {
        return json(res, 503, { error: 'Servidor de stream indisponível.' });
      }
    }
    let data;
    try { data = JSON.parse(body); } catch { return json(res, 400, { error: 'JSON inválido.' }); }
    // ---- Autenticação ----
    // Login/cadastro de jogadores por fingerprint do aparelho: sem senha.
    // Dispositivo conhecido → sessão direta; novo + nick → cadastro pendente
    // de aprovação; novo sem nick → {needNick} (cliente pergunta o apelido).
    if (path === '/api/identify') {
      if (!authThrottle(req)) return json(res, 429, { error: 'Muitas tentativas. Aguarde um minuto.' });
      const device = String(data?.device ?? '').trim().toLowerCase();
      if (!/^[a-f0-9]{32,64}$/.test(device)) return json(res, 400, { error: 'Identificação inválida.' });
      if (auth?.user?.device === device) return json(res, 200, { ok: true, already: true });
      let user = store.byDevice(device);
      if (!user) {
        const nick = String(data?.nick ?? '').replace(/\s+/g, ' ').trim();
        if (!nick) return json(res, 200, { needNick: true });
        try { user = store.registerDevice(device, nick); }
        catch (e) { return json(res, 400, { error: e.message }); }
      }
      const session = store.openSession(user.id);
      res.setHeader('Set-Cookie', cookieFor(session.id, proto));
      broadcastState();
      return json(res, 200, { ok: true });
    }
    if (path === '/api/register' || path === '/api/login') {
      if (!authThrottle(req)) return json(res, 429, { error: 'Muitas tentativas. Aguarde um minuto.' });
      try {
        let user;
        let generated = null;
        if (path === '/api/register') {
          generated = randomBytes(4).toString('hex'); // senha exibida uma única vez
          user = store.register(data?.username ?? '', generated, data?.name ?? '');
        } else {
          user = store.login(data?.username ?? '', data?.password ?? '');
          if (!user) return json(res, 401, { error: 'Usuário ou senha incorretos.' });
        }
        const session = store.openSession(user.id);
        res.setHeader('Set-Cookie', cookieFor(session.id, proto));
        return json(res, 200, { ok: true, password: generated || undefined });
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }
    if (!auth) return json(res, 401, { error: 'Entre na sua conta primeiro.' });
    // Telemetria leve: sendBeacon não consegue mandar X-CSRF-Token, então este
    // endpoint fica fora do gate de CSRF (sem efeito colateral de estado).
    if (path === '/api/client-log') {
      try { const d = JSON.parse(body); console.log(`[client-log] ${auth?.user?.username ?? 'anon'}:`, JSON.stringify(d).slice(0, 500)); }
      catch {}
      return json(res, 200, { ok: true });
    }
    const csrf = req.headers['x-csrf-token'];
    const csrfOk = typeof csrf === 'string' && csrf.length === auth.session.csrf.length && timingSafeEqual(Buffer.from(csrf), Buffer.from(auth.session.csrf));
    if (!csrfOk) return json(res, 403, { error: 'Sessão inválida. Atualize a página.' });
    if (path === '/api/logout') {
      store.closeSession(sid);
      res.setHeader('Set-Cookie', `cdv_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
      return json(res, 200, { ok: true });
    }
    if (path === '/api/chat') {
      const approved = auth.user.approved || auth.user.role === 'admin';
      if (!approved) return json(res, 403, { error: 'Seu cadastro ainda não foi aprovado pelo administrador.' });
      const text = String(data?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
      if (!text) return json(res, 400, { error: 'Mensagem vazia.' });
      const last = chatThrottle.get(uid) ?? 0;
      if (Date.now() - last < 1200) return json(res, 429, { error: 'Devagar — uma mensagem por vez.' });
      chatThrottle.set(uid, Date.now());
      chatLog.push({ n: auth.user.name, t: text, at: Date.now() });
      if (chatLog.length > CHAT_MAX) chatLog.splice(0, chatLog.length - CHAT_MAX);
      saveChat();
      broadcastState();
      return json(res, 200, { ok: true });
    }
    if (path === '/api/rtc-toggle') {
      if (auth.user.role !== 'admin') return json(res, 403, { error: 'Acesso restrito ao administrador.' });
      rtcEnabled = !rtcEnabled;
      broadcastState();
      return json(res, 200, { ok: true, rtcEnabled });
    }
    if (path === '/api/pix-paid') {
      auth.user.paid = true;
      store.save();
      return json(res, 200, { ok: true });
    }
    if (path === '/api/admin/action') {
      if (auth.user.role !== 'admin') return json(res, 403, { error: 'Acesso restrito ao administrador.' });
      const target = store.user(data?.userId ?? '');
      if (!target) return json(res, 404, { error: 'Usuário não encontrado.' });
      if (data.action === 'approve') store.setApproved(target.id, true);
      else if (data.action === 'unapprove') store.setApproved(target.id, false);
      else if (data.action === 'set-password') {
        try {
          const password = store.setPassword(target.id, data.password || null);
          return json(res, 200, { ok: true, password, users: store.list() });
        } catch (e) { return json(res, 400, { error: e.message }); }
      }
      else if (data.action === 'remove') {
        if (target.id === auth.user.id) return json(res, 400, { error: 'Você não pode remover a si mesmo.' });
        store.remove(target.id);
        room.leave(target.id);
      }
      else return json(res, 400, { error: 'Ação inválida.' });
      if (data.action === 'unapprove') room.leave(target.id);
      scheduleGrantSync();
      broadcastState();
      return json(res, 200, { ok: true, users: store.list() });
    }
    // ---- Turnos: exige conta aprovada ----
    const approved = auth.user.approved || auth.user.role === 'admin';
    if (!approved) return json(res, 403, { error: 'Seu cadastro ainda não foi aprovado pelo administrador.' });
    if (!auth.user.lastAction) auth.user.lastAction = 0;
    if (Date.now() - auth.user.lastAction < 300) return json(res, 429, { error: 'Aguarde um instante.' });
    auth.user.lastAction = Date.now();
    if (path === '/api/start') room.start({ id: auth.user.id, name: auth.user.name });
    else if (path === '/api/request') room.requestTurn({ id: auth.user.id, name: auth.user.name });
    else if (path === '/api/accept') room.accept(uid);
    else if (path === '/api/decline') room.decline(uid);
    else if (path === '/api/wait') room.waitTurn({ id: auth.user.id, name: auth.user.name });
    else if (path === '/api/leave') room.leave(uid);
    else return json(res, 404, { error: 'Ação não encontrada.' });
    scheduleGrantSync();
    broadcastState();
    json(res, 200, { ok: true });
  } catch (error) {
    json(res, 400, { error: error.message === 'Este turno não está disponível para você.' ? error.message : 'Não foi possível executar a ação.' });
  }
});
server.listen(PORT, HOST, () => console.log(`Servidor: http://${HOST}:${PORT}`));

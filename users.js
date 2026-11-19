import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = process.env.DATA_DIR || dirname(fileURLToPath(import.meta.url));
const STORE_FILE = join(DATA_DIR, 'users.json');

const USERNAME_RE = /^[\p{L}\p{N}_.-]{2,24}$/u;
const SESSION_TTL = 30 * 24 * 3600 * 1000;

function hashPassword(password, salt) {
  return scryptSync(password, salt, 32).toString('hex');
}

export class UserStore {
  constructor(file = STORE_FILE) {
    this.file = file;
    this.users = [];
    this.sessions = new Map();
    this.load();
  }
  load() {
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8'));
      this.users = data.users ?? [];
      for (const s of data.sessions ?? []) this.sessions.set(s.id, s);
    } catch { /* primeiro boot */ }
  }
  save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      writeFileSync(tmp, JSON.stringify({ users: this.users, sessions: [...this.sessions.values()] }));
      renameSync(tmp, this.file);
    } catch (error) { console.error('users.json: falha ao salvar:', error.message); }
  }
  byName(username) {
    const key = username.trim().toLowerCase();
    return this.users.find(u => u.username.toLowerCase() === key);
  }
  byDevice(device) {
    return this.users.find(u => u.device === device);
  }
  // Cadastro por fingerprint do aparelho: só o apelido é pedido ao usuário.
  // Nasce pendente (approved:false) — o admin libera na página dele.
  registerDevice(device, nickname) {
    const name = String(nickname ?? '').trim().slice(0, 24);
    if (name.length < 2) throw new Error('Apelido: mínimo 2 caracteres.');
    if (this.byDevice(device)) throw new Error('Este aparelho já está cadastrado.');
    // slug único pro username interno (o usuário nunca vê nem digita).
    const base = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 18) || 'player';
    let username = base;
    while (this.byName(username)) username = `${base}-${randomBytes(2).toString('hex')}`;
    const user = {
      id: randomBytes(12).toString('hex'),
      username,
      name,
      device,
      role: 'user',
      approved: false,
      paid: false,
      playMs: 0,
      createdAt: Date.now(),
    };
    this.users.push(user);
    this.save();
    return user;
  }
  register(username, password, displayName) {
    username = username.trim();
    if (!USERNAME_RE.test(username)) throw new Error('Usuário: 2–24 letras, números, ponto, hífen ou sublinhado.');
    if (password.length < 6 || password.length > 128) throw new Error('Senha: mínimo 6 caracteres.');
    if (this.byName(username)) throw new Error('Este usuário já está cadastrado.');
    const salt = randomBytes(16).toString('hex');
    const user = {
      id: randomBytes(12).toString('hex'),
      username,
      name: (displayName || username).trim().slice(0, 24),
      hash: hashPassword(password, salt),
      salt,
      role: 'user',
      approved: true,
      paid: false,
      playMs: 0,
      createdAt: Date.now(),
    };
    this.users.push(user);
    this.save();
    return user;
  }
  login(username, password) {
    const user = this.byName(username);
    if (!user?.hash) return null; // contas por dispositivo não têm senha
    if (!timingSafeEqual(Buffer.from(user.hash), Buffer.from(hashPassword(password, user.salt)))) return null;
    return user;
  }
  openSession(userId) {
    const session = { id: randomBytes(24).toString('hex'), userId, csrf: randomBytes(24).toString('hex'), createdAt: Date.now() };
    this.sessions.set(session.id, session);
    this.save();
    return session;
  }
  session(id) {
    const s = id ? this.sessions.get(id) : null;
    if (!s) return null;
    if (Date.now() - s.createdAt > SESSION_TTL) { this.sessions.delete(id); this.save(); return null; }
    return s;
  }
  closeSession(id) { this.sessions.delete(id); this.save(); }
  user(id) { return this.users.find(u => u.id === id); }
  setPassword(userId, password = null) {
    const u = this.user(userId);
    if (!u) return null;
    if (!password) password = randomBytes(4).toString('hex');
    if (password.length < 6 || password.length > 128) throw new Error('Senha: mínimo 6 caracteres.');
    u.salt = randomBytes(16).toString('hex');
    u.hash = hashPassword(password, u.salt);
    for (const [sid, sess] of this.sessions) if (sess.userId === userId) this.sessions.delete(sid);
    this.save();
    return password;
  }
  setApproved(userId, approved) {
    const u = this.user(userId);
    if (u) { u.approved = approved; this.save(); }
    return u;
  }
  remove(userId) {
    this.users = this.users.filter(u => u.id !== userId);
    for (const [sid, s] of this.sessions) if (s.userId === userId) this.sessions.delete(sid);
    this.save();
  }
  list() {
    return this.users.map(u => ({ id: u.id, username: u.username, name: u.name, role: u.role, approved: u.approved, paid: u.paid, playMs: u.playMs ?? 0, createdAt: u.createdAt }));
  }
  addPlayMs(userId, ms) {
    const u = this.user(userId);
    if (u) { u.playMs = (u.playMs ?? 0) + ms; this.save(); }
  }
  ranking(limit = 5) {
    return this.users
      .filter(u => (u.playMs ?? 0) > 0)
      .sort((a, b) => (b.playMs ?? 0) - (a.playMs ?? 0))
      .slice(0, limit)
      .map(u => ({ name: u.name, playMs: u.playMs }));
  }
  ensureAdmin(username, password, name = 'Admin') {
    if (this.users.some(u => u.role === 'admin')) return;
    const salt = randomBytes(16).toString('hex');
    this.users.push({
      id: randomBytes(12).toString('hex'),
      username, name,
      hash: hashPassword(password, salt), salt,
      role: 'admin', approved: true, paid: false, createdAt: Date.now(),
    });
    this.save();
  }
}

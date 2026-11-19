import { randomBytes } from 'node:crypto';

// Sala sem tempo limite de turno:
//  - livre: qualquer aprovado clica "Vou jogar" e entra direto
//  - ocupado: pedido "Deixa eu jogar?" -> dono aceita (handoff) ou recusa/expira
//  - recusado/expirado: pedinte pode entrar na espera de 10min; ao fim da espera assume
//  - se o dono sair antes, quem espera assume imediatamente
export class Room {
  constructor({ now = Date.now, wait = 600_000, requestTtl = 45_000, onTurnEnd = null } = {}) {
    this.now = now;
    this.waitMs = wait;
    this.requestTtl = requestTtl;
    this.onTurnEnd = onTurnEnd;
    this.current = null;
    this.request = null;
    this.declined = null;
    this.waiter = null;
    this.completed = 0;
  }
  tick() {
    const now = this.now();
    if (this.request && this.request.expiresAt <= now) {
      this.declined = { id: this.request.id, name: this.request.name };
      this.request = null;
    }
    if (this.waiter && (!this.current || this.waiter.deadline <= now)) {
      const next = this.waiter;
      this.waiter = null;
      this.finishTurn();
      this.startTurn(next);
    }
  }
  finishTurn() {
    if (this.current && this.onTurnEnd && this.current.startedAt) {
      try { this.onTurnEnd(this.current.id, Math.max(0, this.now() - this.current.startedAt)); } catch {}
    }
    if (this.current) this.completed++;
    this.current = null;
    this.request = null;
    this.declined = null;
  }
  startTurn(entry) {
    this.current = { id: entry.id, name: entry.name, startedAt: this.now(), turnToken: randomBytes(24).toString('hex') };
  }
  start(user) {
    this.tick();
    if (this.current?.id === user.id) return;
    if (this.current) throw new Error('Já tem alguém jogando. Use "Deixa eu jogar?".');
    if (this.waiter && this.waiter.id !== user.id) throw new Error(`${this.waiter.name} está na espera e tem prioridade.`);
    if (this.waiter?.id === user.id) this.waiter = null;
    this.startTurn(user);
  }
  requestTurn(user) {
    this.tick();
    if (!this.current) { this.start(user); return; }
    if (this.current.id === user.id) return;
    if (this.waiter?.id === user.id) return;
    if (this.waiter) throw new Error(`${this.waiter.name} já está na espera.`);
    if (this.request?.id === user.id) return;
    this.request = { id: user.id, name: user.name, expiresAt: this.now() + this.requestTtl };
    this.declined = null;
  }
  accept(id) {
    this.tick();
    if (this.current?.id !== id || !this.request) throw new Error('Nenhum pedido pendente.');
    const next = this.request;
    this.finishTurn();
    this.startTurn(next);
  }
  decline(id) {
    this.tick();
    if (this.current?.id !== id || !this.request) throw new Error('Nenhum pedido pendente.');
    this.declined = { id: this.request.id, name: this.request.name };
    this.request = null;
  }
  waitTurn(user) {
    this.tick();
    if (this.current?.id === user.id || this.waiter?.id === user.id) return;
    if (this.waiter) throw new Error(`${this.waiter.name} já está na espera.`);
    if (this.declined?.id !== user.id) throw new Error('Peça a vez primeiro com "Deixa eu jogar?".');
    this.waiter = { id: user.id, name: user.name, deadline: this.now() + this.waitMs };
    this.declined = null;
  }
  leave(id) {
    this.tick();
    if (this.request?.id === id) this.request = null;
    if (this.waiter?.id === id) this.waiter = null;
    if (this.declined?.id === id) this.declined = null;
    if (this.current?.id === id) this.finishTurn();
    this.tick();
  }
  snapshot(uid) {
    this.tick();
    const me = item => item && item.id === uid;
    return {
      current: this.current ? { name: this.current.name, mine: me(this.current), startedAt: this.current.startedAt, controlToken: me(this.current) ? this.current.turnToken : undefined } : null,
      request: this.request ? { name: this.request.name, mine: me(this.request), forMe: me(this.current), expiresAt: this.request.expiresAt } : null,
      declined: me(this.declined) ? true : null,
      waiter: this.waiter ? { name: this.waiter.name, mine: me(this.waiter), deadline: this.waiter.deadline } : null,
      completed: this.completed,
      serverTime: this.now(),
      waitMs: this.waitMs,
    };
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from './session.js';
const a = { id: 'a', name: 'Ana' };
const b = { id: 'b', name: 'Bruno' };
const c = { id: 'c', name: 'Carla' };

test('sala livre: quem clica "vou jogar" entra direto sem limite', () => {
  const room = new Room();
  room.start(a);
  assert.equal(room.current.id, 'a');
  assert.equal(room.current.startedAt > 0, true);
  assert.throws(() => room.start(b), /já tem alguém jogando/i);
});

test('pedido aceito: dono sai e pedinte assume (volta pro YouTube)', () => {
  const room = new Room();
  room.start(a);
  room.requestTurn(b);
  assert.equal(room.request.id, 'b');
  room.accept('a');
  assert.equal(room.current.id, 'b');
  assert.equal(room.current.name, 'Bruno');
  assert.equal(room.completed, 1);
});

test('pedido recusado: pedinte pode entrar na espera de 10min', () => {
  const room = new Room();
  room.start(a);
  room.requestTurn(b);
  room.decline('a');
  assert.equal(room.request, null);
  room.waitTurn(b);
  assert.equal(room.waiter.id, 'b');
  assert.equal(room.waiter.deadline - room.now(), 600_000);
});

test('pedido expirado conta como recusa e libera a espera', () => {
  let t = 0;
  const room = new Room({ now: () => t });
  room.start(a);
  room.requestTurn(b);
  t += 46_000;
  room.tick();
  assert.equal(room.request, null);
  assert.equal(room.declined.id, 'b');
  room.waitTurn(b);
  assert.equal(room.waiter.id, 'b');
});

test('fim da espera: quem esperou assume automaticamente', () => {
  let t = 0;
  const room = new Room({ now: () => t });
  room.start(a);
  room.requestTurn(b);
  room.decline('a');
  room.waitTurn(b);
  t += 601_000;
  room.tick();
  assert.equal(room.current.id, 'b');
  assert.equal(room.waiter, null);
  assert.equal(room.completed, 1);
});

test('dono saiu antes: quem espera assume na hora', () => {
  const room = new Room();
  room.start(a);
  room.requestTurn(b);
  room.decline('a');
  room.waitTurn(b);
  room.leave('a');
  assert.equal(room.current.id, 'b');
});

test('espera é única: terceiro não entra nem no pedido', () => {
  const room = new Room();
  room.start(a);
  room.requestTurn(b);
  room.decline('a');
  room.waitTurn(b);
  assert.throws(() => room.requestTurn(c), /já está na espera/i);
});

test('token de controle só vai para o dono do turno e muda a cada turno', () => {
  const room = new Room();
  room.start(a);
  const snapA = room.snapshot('a');
  const snapB = room.snapshot('b');
  assert.ok(snapA.current.controlToken);
  assert.equal(snapB.current.controlToken, undefined);
  const t1 = snapA.current.controlToken;
  room.requestTurn(b);
  room.accept('a');
  const snapB2 = room.snapshot('b');
  assert.notEqual(snapB2.current.controlToken, t1);
});

test('leave limpa todos os papéis do usuário', () => {
  const room = new Room();
  room.start(a);
  room.requestTurn(b);
  room.leave('b');
  assert.equal(room.request, null);
  room.leave('a');
  assert.equal(room.current, null);
});

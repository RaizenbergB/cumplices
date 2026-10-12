// Testes da sala online (anfitrião + celulares) usando a rede de mentirinha.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HostRoom } from '../src/room-host.js';
import { ClientRoom } from '../src/room-client.js';
import { memoryTransport } from '../src/transport.js';
import { createStore, memoryBackend, mulberry32Safe } from './helpers.mjs';

const sleep = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const flush = async () => {
  for (let i = 0; i < 8; i++) await sleep(1);
};

function fakeClock() {
  let t = 1_000_000;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: t + Math.max(0, ms), fn });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [id, x] of timers) if (x.at <= end && (!next || x.at < next[1].at)) next = [id, x];
        if (!next) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].fn();
        await flush();
      }
      t = end;
      await flush();
    },
  };
}

async function setup(n, { names, clock = fakeClock() } = {}) {
  const net = memoryTransport();
  const store = createStore(memoryBackend());
  let hostView = null;
  const host = new HostRoom({
    transport: net,
    store,
    hostName: 'Ana',
    rng: mulberry32Safe(7),
    onChange: (v) => (hostView = v),
    ...clock,
  });
  host.open();
  await flush();
  const clients = [];
  for (let i = 1; i < n; i++) {
    const c = makeClient(net, host.code, `c${i}xxxxxx`, (names && names[i]) || `Jogador${i}`, clock);
    clients.push(c);
    c.room.start();
    await flush();
  }
  await flush();
  return { net, store, host, clients, clock, hostView: () => hostView };
}

function makeClient(net, code, id, name, clock) {
  const c = { last: null, toasts: [] };
  c.room = new ClientRoom({
    transport: net,
    code,
    clientId: id,
    name,
    onChange: (e) => {
      c.last = e;
      if (e.toast) c.toasts.push(e.toast);
    },
    ...clock,
  });
  return c;
}

test('cinco celulares entram, nomes repetidos e sala cheia são recusados', async () => {
  const { host, clients, net, clock } = await setup(5, { names: [null, 'Bia', 'Caio', 'Duda', 'Edu'] });
  assert.equal(host.players.length, 5);
  assert.ok(clients.every((c) => c.last.status === 'conectado'));
  assert.deepEqual(clients[0].last.view.room.players.map((p) => p.name), ['Ana', 'Bia', 'Caio', 'Duda', 'Edu']);
  const dup = makeClient(net, host.code, 'dupdupdup1', '  bía ', clock);
  dup.room.start();
  await flush();
  assert.equal(dup.last.status, 'recusado');
  assert.match(dup.last.reason, /Já tem/);
  for (let i = 0; i < 7; i++) {
    const c = makeClient(net, host.code, `more${i}xxxx`, `Extra ${i}`, clock);
    c.room.start();
    await flush();
  }
  assert.equal(host.players.length, 12);
  const over = makeClient(net, host.code, 'overflow01', 'Treze', clock);
  over.room.start();
  await flush();
  assert.equal(over.last.status, 'recusado');
  assert.match(over.last.reason, /cheia/);
});

test('sala inexistente: depois de algumas tentativas avisa que não achou', async () => {
  const net = memoryTransport();
  const clock = fakeClock();
  const c = makeClient(net, 'ZZZZ', 'lonely0001', 'Sozinho', clock);
  c.room.start();
  await flush();
  await clock.advance(30000);
  assert.equal(c.last.status, 'nao-encontrada');
});

test('partida completa pela rede: só o dono vê o próprio papel; ninguém consegue votar por outro', async () => {
  const { host, clients, hostView } = await setup(6);
  assert.equal(host.startGame().ok, true);
  await flush();
  const all = [{ id: host.hostId, view: () => hostView() }, ...clients.map((c) => ({ id: c.room.clientId, view: () => c.last.view, c }))];
  // papéis: exatamente dois cúmplices, cada um conhece o parceiro
  const roles = all.map((p) => p.view().me.role);
  assert.equal(roles.filter((r) => r === 'cumplice').length, 2);
  for (const p of all) {
    const v = p.view();
    assert.equal(v.game.result, null);
    assert.equal(JSON.stringify(v.game).includes('"cumplices"'), false, 'cúmplices não vazam na visão pública');
    if (v.me.role === 'cumplice') assert.ok(v.me.partner && v.me.partner !== p.id);
  }
  // tentativa de fraude: c1 vota "como" c2
  const victim = clients[1].room.clientId;
  clients[0].room.send({ type: 'vote', player: victim, option: 2 });
  await flush();
  assert.equal(host.game.votes[victim], undefined);
  assert.equal(host.game.votes[clients[0].room.clientId], 2);
  // ação proibida para cliente
  clients[0].room.send({ type: 'next' });
  clients[0].room.send({ type: 'abandon' });
  await flush();
  assert.equal(host.game.phase, 'votar');
  // todos votam A, exceto cúmplices divergentes → DIFERENTE
  const [ca, cb] = host.game.cumplices;
  const optFor = (id) => (id === ca ? 0 : id === cb ? 1 : 2);
  host.hostAct({ type: 'vote', option: optFor(host.hostId) });
  for (const c of clients) c.room.send({ type: 'vote', option: optFor(c.room.clientId) });
  await flush();
  assert.equal(host.game.phase, 'conversa');
  assert.equal(clients[2].last.view.game.history[0].igual, false);
  // um cliente vê o voto dos outros só depois da revelação
  assert.equal(clients[2].last.view.game.history[0].votes[host.hostId], optFor(host.hostId));
  // na primeira pergunta ninguém acusa
  const det = clients.find((c) => !host.game.cumplices.includes(c.room.clientId));
  det.room.send({ type: 'propose', pair: [ca, cb] });
  await flush();
  assert.equal(host.game.phase, 'conversa');
  assert.match(det.toasts[det.toasts.length - 1], /primeira pergunta/);
  // segunda pergunta: de novo DIFERENTE
  host.hostAct({ type: 'next' });
  await flush();
  host.hostAct({ type: 'vote', option: optFor(host.hostId) });
  for (const c of clients) c.room.send({ type: 'vote', option: optFor(c.room.clientId) });
  await flush();
  assert.equal(host.game.round, 2);
  assert.equal(host.game.phase, 'conversa');
  // acusação certa proposta por um detetive
  det.room.send({ type: 'propose', pair: [ca, cb] });
  await flush();
  assert.equal(host.game.phase, 'acusacao');
  assert.ok(det.last.view.game.accusation);
  for (const p of all) {
    const yes = !host.game.cumplices.includes(p.id);
    if (p.id === host.hostId) host.hostAct({ type: 'accuseVote', yes });
    else p.c.room.send({ type: 'accuseVote', yes });
  }
  await flush();
  assert.equal(host.game.result.winner, 'detetives');
  const end = clients[0].last.view;
  assert.deepEqual([...end.game.result.cumplices].sort(), [ca, cb].sort());
  // placar da noite: detetives vencedores +1
  const winners = host.game.players.filter((p) => !host.game.cumplices.includes(p.id));
  for (const w of winners) assert.equal(end.room.scoreboard[w.id].pts, 1);
  for (const c of host.game.cumplices) assert.equal(end.room.scoreboard[c].pts, 0);
});

test('quem entra no meio da partida assiste e joga na próxima', async () => {
  const { host, clients, net, clock } = await setup(5);
  host.startGame();
  await flush();
  const late = makeClient(net, host.code, 'latecomer1', 'Atrasado', clock);
  late.room.start();
  await flush();
  assert.equal(host.waiting.length, 1);
  assert.equal(late.last.view.me, null);
  assert.ok(late.last.view.game);
  late.room.send({ type: 'vote', option: 1 });
  await flush();
  assert.match(late.toasts.join(' '), /assistindo/);
  host.backToLobby();
  await flush();
  assert.equal(host.players.length, 6);
  assert.equal(host.startGame().ok, true);
  await flush();
  assert.ok(late.last.view.me);
  assert.equal(clients.length, 4);
});

test('reconexão: celular cai e volta no meio da votação sem perder o lugar', async () => {
  const { host, clients, net, clock } = await setup(5);
  host.startGame();
  await flush();
  const c = clients[0];
  c.room.send({ type: 'vote', option: 1 });
  await flush();
  net.dropAll(host.listener ? 'cumplices-v1-' + host.code : '');
  await flush();
  assert.ok(clients.every((x) => x.last.status === 'reconectando'));
  assert.equal(host.players.filter((p) => p.connected).length, 1);
  await clock.advance(10000);
  assert.ok(clients.every((x) => x.last.status === 'conectado'));
  assert.equal(host.players.filter((p) => p.connected).length, 5);
  assert.equal(c.last.view.me.myVote, 1, 'o voto continua lá');
});

test('celular que some sem avisar é marcado desconectado; anfitrião pode encerrar a votação', async () => {
  const { host, clients, clock } = await setup(5);
  host.startGame();
  await flush();
  // simula celular que dormiu: para de mandar ping
  const sleepy = clients[3];
  sleepy.room.stop('saiu', null); // não avisa o anfitrião
  host.hostAct({ type: 'vote', option: 0 });
  for (const c of clients.slice(0, 3)) c.room.send({ type: 'vote', option: 0 });
  await clock.advance(31000);
  const p = host.players.find((x) => x.id === sleepy.room.clientId);
  assert.equal(p.connected, false);
  assert.equal(host.game.phase, 'votar');
  host.hostAct({ type: 'closeVoting' });
  assert.equal(host.game.phase === 'conversa' || host.game.phase === 'fim', true);
});

test('tempo de conversa: avança sozinho, pausa na acusação e retoma', async () => {
  const { host, clients, clock } = await setup(5);
  host.setSettings({ timer: 60 });
  host.startGame();
  await flush();
  // 1ª pergunta (ninguém acusa): cúmplices votam diferente; o anfitrião passa adiante
  const [c0] = host.game.cumplices;
  const opt = (id) => (id === c0 ? 1 : 0);
  host.hostAct({ type: 'vote', option: opt(host.hostId) });
  for (const c of clients) c.room.send({ type: 'vote', option: opt(c.room.clientId) });
  await flush();
  host.hostAct({ type: 'next' });
  await flush();
  // 2ª pergunta: todos votam A (IGUAL, 1 ponto; meta 3 com 5 jogadores)
  host.hostAct({ type: 'vote', option: 0 });
  for (const c of clients) c.room.send({ type: 'vote', option: 0 });
  await flush();
  assert.equal(host.game.round, 2);
  assert.equal(host.game.phase, 'conversa');
  assert.ok(clients[0].last.view.timer.left > 59000);
  await clock.advance(30000);
  const ids = host.game.players.map((p) => p.id);
  const innocents = ids.filter((id) => !host.game.cumplices.includes(id));
  host.hostAct({ type: 'propose', pair: [innocents[0], innocents[1]] });
  await flush();
  assert.equal(host.game.phase, 'acusacao');
  assert.equal(host.timer.paused, true);
  await clock.advance(120000); // acusação parada não deixa o tempo correr
  assert.equal(host.game.phase, 'acusacao');
  host.hostAct({ type: 'closeAccusation' }); // ninguém votou → recusada
  await flush();
  assert.equal(host.game.phase, 'conversa');
  assert.ok(host.timer.endsAt - clock.now() >= 20000);
  await clock.advance(31000);
  assert.equal(host.game.phase, 'votar');
  assert.equal(host.game.round, 3);
});

test('anfitrião recarrega a página e retoma a sala com o mesmo código', async () => {
  const { host, clients, net, store, clock } = await setup(5);
  host.startGame();
  await flush();
  host.hostAct({ type: 'vote', option: 2 });
  await flush();
  const code = host.code;
  // a página do anfitrião "morre"
  host.closed = true;
  host.listener.close();
  await flush();
  const saved = HostRoom.loadSaved(store, clock.now());
  assert.ok(saved);
  const again = new HostRoom({ transport: net, store, restore: saved, ...clock });
  again.open();
  await flush();
  assert.equal(again.code, code);
  await clock.advance(12000);
  assert.ok(clients.every((c) => c.last.status === 'conectado'));
  assert.equal(again.game.votes[again.hostId], 2);
  assert.equal(again.players.filter((p) => p.connected).length, 5);
});

test('código ocupado na criação: troca de código sozinho', async () => {
  const net = memoryTransport();
  const clock = fakeClock();
  const store = createStore(memoryBackend());
  const a = new HostRoom({ transport: net, store, hostName: 'A', code: 'ABCD', ...clock });
  a.open();
  await flush();
  const b = new HostRoom({ transport: net, store: createStore(memoryBackend()), hostName: 'B', code: 'ABCD', ...clock });
  b.open();
  await flush();
  await flush();
  assert.equal(a.status, 'aberta');
  assert.equal(b.status, 'aberta');
  assert.notEqual(b.code, 'ABCD');
});

test('sair, ser removido e sala fechada', async () => {
  const { host, clients } = await setup(6);
  clients[0].room.leave();
  await flush();
  assert.equal(host.players.length, 5);
  assert.equal(clients[0].last.status, 'saiu');
  host.kick(clients[1].room.clientId);
  await flush();
  assert.equal(clients[1].last.status, 'removido');
  assert.equal(host.players.length, 4);
  host.close();
  await flush();
  assert.equal(clients[2].last.status, 'encerrada');
});

test('opções da sala: treino, dificuldade e relógio só mudam fora da partida', async () => {
  const { host } = await setup(7);
  assert.equal(host.setSettings({ training: true, ajuste: 1, timer: 90 }).ok, true);
  assert.deepEqual(host.settings, { training: true, ajuste: 1, timer: 90 });
  host.setSettings({ ajuste: 5, timer: 33 });
  assert.equal(host.settings.ajuste, 0);
  assert.equal(host.settings.timer, 0);
  host.setSettings({ ajuste: 1, timer: 90 });
  host.startGame();
  assert.equal(host.game.round, 0, 'começa pela pergunta de treino');
  assert.deepEqual(host.game.settings, { meta: 4, rounds: 6 }, '7 jogadores, mais difícil: 4 IGUAIS em até 6');
  assert.equal(host.setSettings({ training: false }).ok, false);
});

test('quem perde o celular volta pelo nome e recupera o lugar, o papel e o voto', async () => {
  const { host, clients, net, clock } = await setup(6, { names: [null, 'Bia', 'Caio', 'Duda', 'Edu', 'Fê'] });
  host.startGame();
  await flush();
  const caio = clients[1];
  const seat = caio.room.clientId;
  const role = caio.last.view.me.role;
  caio.room.send({ type: 'vote', option: 2 });
  await flush();
  // Caio ainda conectado: ninguém pode entrar com o nome dele
  const impostor = makeClient(net, host.code, 'outroaparelho1', 'caio', clock);
  impostor.room.start();
  await flush();
  assert.equal(impostor.last.status, 'recusado');
  // o celular do Caio some de vez (bateria acabou)
  caio.room.stop('saiu', null);
  await clock.advance(31000);
  assert.equal(host.players.find((p) => p.id === seat).connected, false);
  // ele volta pelo celular de outra pessoa, com o mesmo nome
  const back = makeClient(net, host.code, 'emprestado01', 'Caio', clock);
  back.room.start();
  await flush();
  assert.equal(back.last.status, 'conectado');
  assert.equal(back.last.view.you, seat, 'recupera o mesmo lugar');
  assert.equal(back.last.view.me.role, role, 'e o mesmo papel');
  assert.equal(back.last.view.me.myVote, 2, 'e o voto que já tinha dado');
  assert.equal(host.players.length, 6);
  back.room.send({ type: 'vote', option: 1 });
  await flush();
  assert.equal(host.game.votes[seat], 1, 'joga normalmente pelo aparelho novo');
  // o nome do anfitrião nunca é "recuperável"
  const fakeHost = makeClient(net, host.code, 'falsoanfitr1', 'Ana', clock);
  fakeHost.room.start();
  await flush();
  assert.equal(fakeHost.last.status, 'recusado');
});

test('anfitrião troca a pergunta: todos recebem a nova e votam de novo', async () => {
  const { host, clients } = await setup(5);
  host.startGame();
  await flush();
  const before = host.game.questions[0].q;
  clients[0].room.send({ type: 'vote', option: 1 });
  await flush();
  assert.equal(host.swapQuestion().ok, true);
  await flush();
  const after = clients[2].last.view.game.question.q;
  assert.notEqual(after, before);
  assert.equal(clients[0].last.view.me.myVote, null, 'voto antigo apagado');
  assert.equal(host.game.questions.filter((q) => q.q === after).length, 1, 'não repete pergunta da partida');
});

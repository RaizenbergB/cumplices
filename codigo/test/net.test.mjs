// Testes da rede de verdade (sem WebRTC): sala inteira pelo broker MQTT local (aedes) e o transporte duplo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HostRoom } from '../src/room-host.js';
import { ClientRoom } from '../src/room-client.js';
import { mqttTransport, dualTransport, memoryTransport } from '../src/transport.js';
import { createStore, memoryBackend } from '../src/util.js';
import { mulberry32 } from '../src/engine.js';
import { startBroker } from './mqtt-broker.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, what = 'condição') {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('tempo esgotado esperando: ' + what);
    await sleep(20);
  }
}

function makeHost(transport, name = 'Ana') {
  const h = { view: null, status: null };
  h.room = new HostRoom({
    transport,
    store: createStore(memoryBackend()),
    hostName: name,
    rng: mulberry32(11),
    onChange: (v) => (h.view = v),
    onStatus: (s) => (h.status = s.status),
  });
  h.room.open();
  return h;
}

function makeClient(transport, code, id, name) {
  const c = { last: null, toasts: [] };
  c.room = new ClientRoom({
    transport,
    code,
    clientId: id,
    name,
    onChange: (e) => {
      c.last = e;
      if (e.toast) c.toasts.push(e.toast);
    },
  });
  c.room.start();
  return c;
}

const connected = (c) => c.last && c.last.status === 'conectado' && c.last.view;

/** Joga uma partida inteira: todos votam A em toda pergunta (os cúmplices sempre IGUAL). */
async function playToEnd(host, clients) {
  const everyone = () => [host, ...clients];
  for (let guard = 0; guard < 40; guard++) {
    const g = host.room.game;
    if (!g || g.result) return;
    if (g.phase === 'votar') {
      host.room.hostAct({ type: 'vote', option: 0 });
      for (const c of clients) c.room.send({ type: 'vote', option: 0 });
      const round = g.round;
      await until(() => host.room.game.phase !== 'votar' || host.room.game.round !== round, 8000, 'votação');
    } else if (g.phase === 'conversa') {
      host.room.hostAct({ type: 'ready' });
      for (const c of clients) c.room.send({ type: 'ready' });
      const round = g.round;
      await until(() => host.room.game.phase !== 'conversa' || host.room.game.round !== round, 8000, 'prontos');
    }
  }
  assert.fail('a partida não terminou');
  return everyone;
}

test('partida completa só pelo broker MQTT, com papéis secretos', async () => {
  const b = await startBroker();
  const T = () => mqttTransport({ brokers: [b.url], openTimeout: 3000 });
  const host = makeHost(T());
  await until(() => host.status === 'aberta', 5000, 'sala abrir');
  const names = ['Bia', 'Caio', 'Duda', 'Edu', 'Fê'];
  const clients = names.map((n, i) => makeClient(T(), host.room.code, `cli${i}abcdef`, n));
  await until(() => clients.every(connected) && host.room.players.length === 6, 8000, 'todos entrarem');
  assert.deepEqual(clients[2].last.view.room.players.map((p) => p.name), ['Ana', ...names]);
  assert.equal(host.room.startGame().ok, true);
  await until(() => clients.every((c) => c.last.view.game && c.last.view.me), 5000, 'papéis');
  const roles = clients.map((c) => c.last.view.me.role);
  const hostRole = host.view.me.role;
  assert.equal([...roles, hostRole].filter((r) => r === 'cumplice').length, 2);
  // ninguém recebe o papel dos outros
  for (const c of clients) assert.equal(JSON.stringify(c.last.view.game).includes('cumplices":["'), false);
  await playToEnd(host, clients);
  await until(() => clients.every((c) => c.last.view.game && c.last.view.game.result), 5000, 'fim chegar aos celulares');
  assert.equal(clients[0].last.view.game.result.winner, 'cumplices');
  host.room.close();
  clients.forEach((c) => c.room.leave());
  await sleep(300);
  await b.close();
});

test('MQTT: celular cai e volta sozinho no mesmo lugar; anfitrião cai e todos voltam', async () => {
  const b = await startBroker();
  const T = () => mqttTransport({ brokers: [b.url], openTimeout: 3000 });
  const host = makeHost(T());
  await until(() => host.status === 'aberta', 5000, 'sala abrir');
  const clients = ['Bia', 'Caio', 'Duda', 'Edu'].map((n, i) => makeClient(T(), host.room.code, `queda${i}xyz`, n));
  await until(() => clients.every(connected) && host.room.players.length === 5, 8000, 'todos entrarem');
  host.room.startGame();
  await until(() => clients.every((c) => c.last.view.game), 5000, 'jogo começar');
  // Bia vota e depois a internet dela cai.
  clients[0].room.send({ type: 'vote', option: 2 });
  await until(() => host.room.game.votes[clients[0].room.clientId] === 2, 4000, 'voto da Bia');
  b.drop('c'); // derruba todos os celulares (clientId dos celulares começa com "c")
  await until(() => clients.every((c) => c.last.status !== 'conectado'), 8000, 'celulares perceberem a queda');
  await until(() => clients.every(connected), 15000, 'celulares voltarem');
  assert.equal(host.room.players.length, 5);
  assert.equal(clients[0].last.view.me.myVote, 2, 'o voto da Bia continua lá');
  // Agora cai o anfitrião (clientId começa com "h").
  b.drop('h');
  await sleep(500);
  // Os celulares percebem pelo "ping" e reconectam quando o anfitrião volta ao broker.
  clients[1].room.send({ type: 'vote', option: 1 });
  await until(() => host.room.game.votes[clients[1].room.clientId] === 1, 30000, 'voto depois da queda do anfitrião');
  await until(() => clients.every(connected), 30000, 'todos de volta');
  host.room.close();
  clients.forEach((c) => c.room.leave());
  await sleep(300);
  await b.close();
});

test('MQTT: sala que não existe avisa depois de algumas tentativas', async () => {
  const b = await startBroker();
  const c = makeClient(mqttTransport({ brokers: [b.url], openTimeout: 400 }), 'ZZZZ', 'perdido1abc', 'Gil');
  await until(() => c.last && c.last.status === 'nao-encontrada', 20000, 'aviso de sala inexistente');
  assert.match(c.last.reason, /Não achei a sala ZZZZ/);
  await b.close();
});

test('duplo: se o caminho direto (PeerJS) falha, o celular entra pelo broker', async () => {
  const b = await startBroker();
  const direct = memoryTransport();
  const brokenDirect = memoryTransport(); // outra "rede": o celular não acha o anfitrião por aqui
  const host = makeHost(dualTransport([direct, mqttTransport({ brokers: [b.url], openTimeout: 3000 })]));
  await until(() => host.status === 'aberta', 5000, 'sala abrir');
  const c = makeClient(dualTransport([brokenDirect, mqttTransport({ brokers: [b.url], openTimeout: 3000 })]), host.room.code, 'viabrok1abc', 'Bia');
  await until(() => connected(c), 8000, 'entrar pelo broker');
  assert.equal(host.room.players.length, 2);
  host.room.close();
  c.room.leave();
  await sleep(300);
  await b.close();
});

test('duplo: se o broker está fora do ar, tudo funciona pelo caminho direto', async () => {
  const direct = memoryTransport();
  const dead = 'ws://127.0.0.1:9/mqtt';
  const host = makeHost(dualTransport([direct, mqttTransport({ brokers: [dead], openTimeout: 800 })]));
  await until(() => host.status === 'aberta', 5000, 'sala abrir');
  const clients = ['Bia', 'Caio', 'Duda', 'Edu'].map((n, i) =>
    makeClient(dualTransport([direct, mqttTransport({ brokers: [dead], openTimeout: 800 })]), host.room.code, `dir${i}abcdef`, n),
  );
  await until(() => clients.every(connected) && host.room.players.length === 5, 8000, 'entrar pelo caminho direto');
  host.room.startGame();
  await playToEnd(host, clients);
  assert.ok(host.room.game.result);
  host.room.close();
  clients.forEach((c) => c.room.leave());
});

test('duplo: os dois caminhos funcionando, cada celular fica com um só', async () => {
  const b = await startBroker();
  const direct = memoryTransport({ delay: 30 });
  const T = () => dualTransport([direct, mqttTransport({ brokers: [b.url], openTimeout: 3000 })]);
  const host = makeHost(T());
  await until(() => host.status === 'aberta', 5000, 'sala abrir');
  const clients = ['Bia', 'Caio', 'Duda', 'Edu', 'Fê', 'Gabi'].map((n, i) => makeClient(T(), host.room.code, `amb${i}abcdef`, n));
  await until(() => clients.every(connected) && host.room.players.length === 7, 8000, 'todos entrarem');
  await sleep(400);
  assert.equal(host.room.conns.size, 6, 'uma conexão por celular');
  host.room.startGame();
  await playToEnd(host, clients);
  await until(() => clients.every((c) => c.last.view.game && c.last.view.game.result), 5000, 'fim');
  host.room.close();
  clients.forEach((c) => c.room.leave());
  await sleep(300);
  await b.close();
});

test('duplo: anfitrião que recarrega a página retoma a sala mesmo com o código ainda preso no caminho direto', async () => {
  const b = await startBroker();
  const direct = memoryTransport();
  // Simula o servidor da PeerJS segurando o código antigo: ocupa o nome antes do anfitrião voltar.
  const store = createStore(memoryBackend());
  let view = null;
  let status = null;
  const first = new HostRoom({ transport: dualTransport([direct, mqttTransport({ brokers: [b.url] })]), store, hostName: 'Ana', onChange: (v) => (view = v), onStatus: (s) => (status = s.status) });
  first.open();
  await until(() => status === 'aberta', 5000, 'sala abrir');
  const code = first.code;
  first.save();
  const saved = HostRoom.loadSaved(store);
  // o "servidor" ainda acha que o nome está em uso: outra escuta com o mesmo nome
  const squatter = direct.listen('cumplices-v1-' + code, {});
  first.closed = true; // página fechou sem avisar ninguém
  status = null;
  const again = new HostRoom({ transport: dualTransport([direct, mqttTransport({ brokers: [b.url] })]), store, restore: saved, onChange: (v) => (view = v), onStatus: (s) => (status = s.status) });
  again.open();
  await until(() => status === 'aberta', 6000, 'sala reabrir pelo broker');
  assert.equal(again.code, code, 'o código continua o mesmo');
  const c = makeClient(dualTransport([memoryTransport(), mqttTransport({ brokers: [b.url], openTimeout: 3000 })]), code, 'volta1abcd', 'Bia');
  await until(() => connected(c), 8000, 'entrar na sala retomada');
  squatter.close();
  first.listener.close();
  again.close();
  c.room.leave();
  await sleep(300);
  await b.close();
  assert.ok(view);
});

test('duplo: caminho direto falha na hora e o broker demora: a sala abre sem reiniciar nada', async () => {
  const b = await startBroker();
  // Caminho direto que falha logo de cara (servidor da PeerJS fora do ar).
  const broken = {
    available: () => true,
    listen: (id, h) => {
      setTimeout(() => h.onError && h.onError('network'), 5);
      return { close() {} };
    },
    connect: (id, h) => {
      setTimeout(() => h.onError && h.onError('network'), 5);
      return { send: () => false, close() {} };
    },
  };
  // Broker "lento": o anfitrião só consegue falar com ele depois de 1,5 s.
  const mq = mqttTransport({ brokers: [b.url] });
  let listens = 0;
  const slow = {
    ...mq,
    listen(id, h, o) {
      listens += 1;
      let inner = null;
      let closed = false;
      const timer = setTimeout(() => {
        if (!closed) inner = mq.listen(id, h, o);
      }, 1500);
      return {
        close() {
          closed = true;
          clearTimeout(timer);
          if (inner) inner.close();
        },
      };
    },
  };
  const statuses = [];
  const host = makeHost(dualTransport([broken, slow]));
  const origOnStatus = host.room.onStatus;
  host.room.onStatus = (s) => {
    statuses.push(s.status);
    origOnStatus(s);
  };
  await until(() => host.status === 'aberta', 8000, 'sala abrir pelo broker lento');
  assert.equal(listens, 1, 'o broker não foi reiniciado');
  assert.ok(!statuses.includes('reconectando'), 'a sala não mostrou queda: ' + statuses.join(','));
  const c = makeClient(dualTransport([broken, mqttTransport({ brokers: [b.url], openTimeout: 3000 })]), host.room.code, 'lento1abcd', 'Bia');
  await until(() => connected(c), 8000, 'entrar');
  host.room.close();
  c.room.leave();
  await sleep(300);
  await b.close();
});

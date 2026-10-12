import test from 'node:test';
import assert from 'node:assert/strict';
import { connectMqtt } from '../src/mqtt-lite.js';
import { startBroker } from './mqtt-broker.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function until(fn, ms = 4000) {
  return new Promise((ok, bad) => {
    const t0 = Date.now();
    const tick = () => (fn() ? ok() : Date.now() - t0 > ms ? bad(new Error('tempo esgotado')) : setTimeout(tick, 15));
    tick();
  });
}

test('conecta, assina, publica e recebe (inclusive mensagem grande e acentos)', async () => {
  const b = await startBroker();
  const got = [];
  let conA = false;
  const a = connectMqtt(b.url, { clientId: 'testeA1', onConnect: () => (conA = true), onMessage: (t, m) => got.push([t, m]) });
  await until(() => conA);
  let subOk = null;
  a.subscribe('sala/x/#', (ok) => (subOk = ok));
  await until(() => subOk !== null);
  assert.equal(subOk, true);
  let conB = false;
  const c = connectMqtt(b.url, { clientId: 'testeB1', onConnect: () => (conB = true) });
  await until(() => conB);
  const big = 'ação '.repeat(40000); // ~240 KB: tamanho com 3 bytes e vários quadros
  c.publish('sala/x/1', 'olá, cúmplices!');
  c.publish('sala/x/2', big);
  await until(() => got.length === 2);
  assert.deepEqual(got[0], ['sala/x/1', 'olá, cúmplices!']);
  assert.equal(got[1][1], big);
  a.end();
  c.end();
  await b.close();
});

test('recado de despedida (will) chega quando a conexão cai sem aviso', async () => {
  const b = await startBroker();
  const got = [];
  let ok1 = false;
  let ok2 = false;
  let closed = null;
  const host = connectMqtt(b.url, { clientId: 'hostW', onConnect: () => (ok1 = true), onMessage: (t, m) => got.push(m) });
  await until(() => ok1);
  host.subscribe('caixa', () => {});
  await wait(50);
  connectMqtt(b.url, {
    clientId: 'quedaW',
    will: { topic: 'caixa', payload: '{"t":"close"}' },
    onConnect: () => (ok2 = true),
    onClose: (r) => (closed = r),
  });
  await until(() => ok2);
  b.drop('quedaW');
  await until(() => got.length === 1 && closed !== null);
  assert.equal(got[0], '{"t":"close"}');
  host.end();
  await b.close();
});

test('servidor inexistente: avisa que fechou, sem travar', async () => {
  let reason = null;
  connectMqtt('ws://127.0.0.1:9/mqtt', { clientId: 'semServ', connectTimeout: 1500, onClose: (r) => (reason = r) });
  await until(() => reason !== null, 3000);
  assert.ok(['fechou', 'tempo', 'erro'].includes(reason), reason);
});

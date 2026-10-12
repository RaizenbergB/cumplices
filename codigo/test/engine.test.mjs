import test from 'node:test';
import assert from 'node:assert/strict';
import {
  newGame, act, publicView, privateView, settingsFor, mulberry32, TABLE, MIN_PLAYERS, MAX_PLAYERS,
} from '../src/engine.js';

const Q = (i) => ({ q: 'Pergunta ' + i, a: ['um', 'dois', 'três'] });
const qs = (k) => Array.from({ length: k }, (_, i) => Q(i + 1));
const mk = (n, extra = {}) => {
  const players = Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'Jogador ' + i }));
  return newGame({ players, questions: qs(12), rng: mulberry32(42 + n), ...extra });
};
const must = (r) => {
  assert.equal(r.ok, true, r.message);
  return r.state;
};
const voteAll = (s, fn) => {
  for (const p of s.players) {
    if (s.phase !== 'votar') break;
    s = must(act(s, { type: 'vote', player: p.id, option: fn(p.id) }));
  }
  return s;
};
/** Joga a 1ª pergunta com os cúmplices votando diferente e passa para a 2ª (a acusação só abre nela). */
const toRound2 = (s) => {
  const [a] = s.cumplices;
  s = voteAll(s, (id) => (id === a ? 0 : 1));
  return must(act(s, { type: 'next' }));
};

test('tabela cobre 5 a 12 e meta nunca passa das rodadas', () => {
  for (let n = MIN_PLAYERS; n <= MAX_PLAYERS; n++) {
    for (const adj of [-1, 0, 1]) {
      const st = settingsFor(n, adj);
      assert.ok(st.meta >= 2 && st.meta <= st.rounds, `n=${n} adj=${adj}`);
    }
  }
  assert.deepEqual(settingsFor(6), { meta: TABLE[6].meta, rounds: TABLE[6].rounds });
  assert.deepEqual(settingsFor(7, -1), { meta: 3, rounds: 5 });
  assert.deepEqual(settingsFor(10, 1), { meta: 4, rounds: 5 });
  assert.throws(() => settingsFor(4));
  assert.throws(() => settingsFor(13));
});

test('newGame valida jogadores e perguntas', () => {
  const p4 = Array.from({ length: 4 }, (_, i) => ({ id: 'p' + i, name: 'x' }));
  assert.throws(() => newGame({ players: p4, questions: qs(10) }));
  const p5 = Array.from({ length: 5 }, (_, i) => ({ id: 'p' + i, name: 'x' }));
  assert.throws(() => newGame({ players: [...p5.slice(0, 4), p5[0]], questions: qs(10) }));
  assert.throws(() => newGame({ players: p5, questions: qs(2) }));
  const s = newGame({ players: p5, questions: qs(10) });
  assert.equal(s.cumplices.length, 2);
  assert.notEqual(s.cumplices[0], s.cumplices[1]);
});

test('cúmplices escondidos até o fim', () => {
  const s = mk(7);
  const pv = publicView(s);
  assert.equal(pv.result, null);
  assert.equal(JSON.stringify(pv).includes('cumplices'), false);
  const c = s.cumplices[0];
  const d = s.players.find((p) => !s.cumplices.includes(p.id)).id;
  assert.equal(privateView(s, c).role, 'cumplice');
  assert.equal(privateView(s, c).partner, s.cumplices[1]);
  assert.equal(privateView(s, d).role, 'detetive');
  assert.equal(privateView(s, d).partner, null);
});

test('voto pode mudar até todos votarem; revelação automática', () => {
  let s = mk(5);
  s = must(act(s, { type: 'vote', player: 'p0', option: 0 }));
  s = must(act(s, { type: 'vote', player: 'p0', option: 2 }));
  assert.equal(s.votes.p0, 2);
  assert.equal(publicView(s).votedIds.length, 1);
  assert.equal(act(s, { type: 'vote', player: 'p0', option: 3 }).ok, false);
  assert.equal(act(s, { type: 'vote', player: 'zz', option: 1 }).ok, false);
  s = voteAll(s, () => 1);
  assert.equal(s.history.length, 1);
  assert.equal(s.history[0].igual, true);
  assert.equal(s.pontos, 1);
  assert.equal(s.phase, 'conversa');
});

test('IGUAL e DIFERENTE', () => {
  let s = mk(6);
  const [a, b] = s.cumplices;
  s = voteAll(s, (id) => (id === a ? 0 : id === b ? 1 : 0));
  assert.equal(s.history[0].igual, false);
  assert.equal(s.pontos, 0);
});

test('encerrar votação: cúmplice sem voto conta como DIFERENTE', () => {
  let s = mk(6);
  const [a] = s.cumplices;
  for (const p of s.players) if (p.id !== a) s = must(act(s, { type: 'vote', player: p.id, option: 1 }));
  assert.equal(s.phase, 'votar');
  s = must(act(s, { type: 'closeVoting' }));
  assert.equal(s.history[0].igual, false);
  assert.equal(s.history[0].votes[a], undefined);
});

test('meta atingida: cúmplices vencem na hora', () => {
  let s = mk(5); // meta 3
  for (let r = 0; r < 3; r++) {
    s = voteAll(s, () => 0);
    if (s.phase === 'conversa') s = must(act(s, { type: 'next' }));
  }
  assert.equal(s.phase, 'fim');
  assert.deepEqual(s.result, { winner: 'cumplices', reason: 'meta' });
  assert.equal(publicView(s).result.cumplices.length, 2);
  assert.equal(act(s, { type: 'next' }).ok, false);
});

test('rodadas acabam: detetives vencem', () => {
  let s = mk(5); // 5 rodadas
  const [a, b] = s.cumplices;
  for (let r = 0; r < 5; r++) {
    s = voteAll(s, (id) => (id === a ? 0 : id === b ? 1 : 2));
    if (s.phase === 'conversa') s = must(act(s, { type: 'next' }));
  }
  assert.equal(s.phase, 'fim');
  assert.deepEqual(s.result, { winner: 'detetives', reason: 'rodadas' });
  assert.equal(s.history.length, 5);
});

test('na primeira pergunta ninguém acusa', () => {
  let s = mk(6);
  s = voteAll(s, () => 1);
  const by = s.players.find((p) => !s.cumplices.includes(p.id)).id;
  const r = act(s, { type: 'propose', player: by, pair: s.cumplices });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'cedo');
  assert.equal(act(s, { type: 'localAccusation', pair: s.cumplices }).error, 'cedo');
  s = must(act(s, { type: 'next' }));
  s = voteAll(s, () => 2);
  s = must(act(s, { type: 'propose', player: by, pair: s.cumplices }));
  assert.equal(s.phase, 'acusacao');
});

test('acusação certa aprovada: detetives vencem', () => {
  let s = toRound2(mk(7));
  s = voteAll(s, () => 1);
  const pair = [...s.cumplices].reverse();
  const by = s.players.find((p) => !s.cumplices.includes(p.id)).id;
  s = must(act(s, { type: 'propose', player: by, pair }));
  assert.equal(s.phase, 'acusacao');
  for (const p of s.players) s = must(act(s, { type: 'accuseVote', player: p.id, yes: !s.cumplices.includes(p.id) }));
  assert.equal(s.phase, 'fim');
  assert.deepEqual(s.result, { winner: 'detetives', reason: 'acusacao' });
  assert.equal(s.accusations[0].yes, 5);
  assert.equal(s.accusations[0].correct, true);
});

test('acusação errada aprovada: +1 para os cúmplices e rodada acaba', () => {
  let s = toRound2(mk(9)); // meta 4
  s = voteAll(s, () => 1); // IGUAL → 1 ponto
  const innocents = s.players.filter((p) => !s.cumplices.includes(p.id)).map((p) => p.id);
  const pair = [innocents[0], innocents[1]];
  s = must(act(s, { type: 'propose', player: innocents[2], pair }));
  for (const p of s.players) s = must(act(s, { type: 'accuseVote', player: p.id, yes: true }));
  assert.equal(s.pontos, 2);
  assert.equal(s.bonus, 1);
  assert.equal(s.round, 3);
  assert.equal(s.phase, 'votar');
  // dupla inocentada não pode ser acusada de novo
  s = voteAll(s, (id) => (id === s.cumplices[0] ? 0 : 1));
  const r = act(s, { type: 'propose', player: innocents[3], pair: [pair[1], pair[0]] });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'dupla-inocente');
});

test('acusação errada que completa a meta dá vitória aos cúmplices', () => {
  let s = mk(5); // meta 3
  for (let r = 0; r < 2; r++) {
    s = voteAll(s, () => 2);
    if (r === 0) s = must(act(s, { type: 'next' }));
  }
  assert.equal(s.pontos, 2);
  const innocents = s.players.filter((p) => !s.cumplices.includes(p.id)).map((p) => p.id);
  s = must(act(s, { type: 'propose', player: innocents[0], pair: [innocents[1], innocents[2]] }));
  for (const p of s.players) s = must(act(s, { type: 'accuseVote', player: p.id, yes: true }));
  assert.deepEqual(s.result, { winner: 'cumplices', reason: 'acusacao-errada' });
});

test('empate na votação da acusação não aprova; cada um propõe uma vez por rodada', () => {
  let s = toRound2(mk(6));
  s = voteAll(s, () => 0);
  const ids = s.players.map((p) => p.id);
  s = must(act(s, { type: 'propose', player: ids[0], pair: [ids[1], ids[2]] }));
  ids.forEach((id, i) => {
    s = must(act(s, { type: 'accuseVote', player: id, yes: i < 3 }));
  });
  assert.equal(s.phase, 'conversa');
  assert.equal(s.accusations[0].approved, false);
  assert.equal(s.accusations[0].correct, null);
  assert.equal(act(s, { type: 'propose', player: ids[0], pair: [ids[3], ids[4]] }).error, 'ja-propos');
  s = must(act(s, { type: 'propose', player: ids[1], pair: [ids[3], ids[4]] }));
  s = must(act(s, { type: 'closeAccusation' })); // ninguém votou → não aprovada
  assert.equal(s.accusations[1].approved, false);
  assert.equal(act(s, { type: 'propose', player: ids[2], pair: [ids[2], ids[2]] }).error, 'dupla');
});

test('todos prontos avança; anfitrião também pode avançar', () => {
  let s = mk(5);
  s = voteAll(s, (id) => (id === s.cumplices[0] ? 0 : 1));
  for (const p of s.players.slice(0, 4)) s = must(act(s, { type: 'ready', player: p.id }));
  assert.equal(s.round, 1);
  s = must(act(s, { type: 'ready', player: s.players[4].id }));
  assert.equal(s.round, 2);
  assert.equal(s.phase, 'votar');
  assert.deepEqual(s.votes, {});
});

test('modo um celular: acusação aprovada pela mesa', () => {
  let s = toRound2(mk(8));
  s = voteAll(s, () => 1);
  s = must(act(s, { type: 'localAccusation', pair: s.cumplices }));
  assert.deepEqual(s.result, { winner: 'detetives', reason: 'acusacao' });
});

test('pergunta de treino não vale ponto e não aceita acusação', () => {
  const players = Array.from({ length: 6 }, (_, i) => ({ id: 'p' + i, name: 'J' + i }));
  let s = newGame({ players, questions: qs(10), rng: mulberry32(9), training: true });
  assert.equal(s.round, 0);
  assert.equal(publicView(s).question.q, 'Pergunta 1');
  s = voteAll(s, () => 0);
  assert.equal(s.history[0].training, true);
  assert.equal(s.history[0].igual, true);
  assert.equal(s.pontos, 0);
  assert.equal(act(s, { type: 'propose', player: 'p0', pair: ['p1', 'p2'] }).error, 'treino');
  s = must(act(s, { type: 'next' }));
  assert.equal(s.round, 1);
  assert.equal(publicView(s).question.q, 'Pergunta 2');
  // ainda são 5 rodadas valendo depois do treino
  const [a, b] = s.cumplices;
  for (let r = 0; r < 5; r++) {
    s = voteAll(s, (id) => (id === a ? 0 : id === b ? 1 : 2));
    if (s.phase === 'conversa') s = must(act(s, { type: 'next' }));
  }
  assert.deepEqual(s.result, { winner: 'detetives', reason: 'rodadas' });
  assert.equal(s.history.length, 6);
});

test('abandonar encerra sem vencedor', () => {
  let s = mk(5);
  s = must(act(s, { type: 'abandon' }));
  assert.deepEqual(s.result, { winner: null, reason: 'abandono' });
});

test('ações em fase errada são recusadas sem mudar o estado', () => {
  const s = mk(5);
  for (const a of [
    { type: 'ready', player: 'p0' },
    { type: 'next' },
    { type: 'propose', player: 'p0', pair: ['p1', 'p2'] },
    { type: 'accuseVote', player: 'p0', yes: true },
    { type: 'closeAccusation' },
    { type: 'nada' },
    null,
  ]) {
    const r = act(s, a);
    assert.equal(r.ok, false);
    assert.equal(r.state, s);
  }
});

test('trocar pergunta antes da revelação apaga os votos; depois não deixa', () => {
  let s = mk(6);
  s = must(act(s, { type: 'vote', player: 'p0', option: 2 }));
  s = must(act(s, { type: 'swapQuestion', question: { q: 'Nova?', a: ['x', 'y', 'z'] } }));
  assert.equal(publicView(s).question.q, 'Nova?');
  assert.deepEqual(s.votes, {});
  s = voteAll(s, () => 0);
  assert.equal(s.history[0].q.q, 'Nova?');
  assert.equal(act(s, { type: 'swapQuestion', question: { q: 'Outra', a: ['1', '2', '3'] } }).ok, false);
  assert.equal(act(mk(5), { type: 'swapQuestion', question: { q: 'ruim', a: ['só uma'] } }).ok, false);
});

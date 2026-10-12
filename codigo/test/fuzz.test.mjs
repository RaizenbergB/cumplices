// Teste "bagunça": jogadores aleatórios mandam ações válidas e inválidas em qualquer ordem.
// O motor nunca pode quebrar, travar ou entrar em estado impossível.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newGame, act, mulberry32, settingsFor, publicView, privateView } from '../src/engine.js';

function invariants(s) {
  const iguais = s.history.filter((h) => h.igual && !h.training).length;
  assert.equal(s.pontos, iguais + s.bonus, 'pontos = iguais + bônus');
  assert.ok(['votar', 'conversa', 'acusacao', 'fim'].includes(s.phase), 'fase válida');
  assert.ok(s.round >= 0 && s.round <= s.settings.rounds, 'rodada dentro do limite');
  if (s.phase === 'acusacao') assert.ok(s.accusation && s.accusation.pair.length === 2);
  else assert.equal(s.accusation, null);
  if (s.phase === 'fim') assert.ok(s.result);
  if (s.result && s.result.winner === 'cumplices') assert.ok(s.pontos >= s.settings.meta);
  for (const a of s.accusations) {
    if (a.approved) assert.equal(typeof a.correct, 'boolean');
    else assert.equal(a.correct, null);
  }
  // visões nunca quebram
  publicView(s);
  for (const p of s.players) privateView(s, p.id);
}

test('10.000 partidas com ações aleatórias', () => {
  const rng = mulberry32(2026);
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  let ended = 0;
  for (let g = 0; g < 10000; g++) {
    const n = 5 + Math.floor(rng() * 8);
    const players = Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'J' + i }));
    const training = rng() < 0.3;
    const ajuste = pick([-1, 0, 1]);
    const questions = Array.from({ length: 12 }, (_, i) => ({ q: 'Q' + i, a: ['a', 'b', 'c'] }));
    let s = newGame({ players, questions, rng, settings: settingsFor(n, ajuste), training });
    const ids = players.map((p) => p.id);
    let steps = 0;
    while (!s.result) {
      steps++;
      assert.ok(steps < 5000, 'partida travou');
      const type = pick(['vote', 'vote', 'vote', 'vote', 'closeVoting', 'propose', 'accuseVote', 'accuseVote',
        'accuseVote', 'closeAccusation', 'ready', 'ready', 'next', 'localAccusation', 'lixo']);
      const action = {
        type,
        player: rng() < 0.97 ? pick(ids) : 'intruso',
        option: rng() < 0.95 ? Math.floor(rng() * 3) : 7,
        yes: rng() < 0.5,
        pair: rng() < 0.9 ? [pick(ids), pick(ids)] : ['x'],
      };
      const r = act(s, action);
      if (!r.ok) assert.equal(r.state, s, 'ação recusada não muda o estado');
      s = r.state;
      invariants(s);
    }
    ended++;
  }
  assert.equal(ended, 10000);
});

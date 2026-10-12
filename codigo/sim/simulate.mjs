// Simulações do Cúmplices: jogadores-robôs jogam milhares de partidas usando o motor real (src/engine.js).
// Objetivos: (1) achar furos (partida que não acaba, estados impossíveis, contas erradas);
//            (2) calibrar a meta de pontos e o número de rodadas para cada número de jogadores.
//
// Modelo dos robôs:
//  - Cada pergunta tem uma "preferência da mesa" (distribuição entre A, B, C) sorteada.
//  - Detetives votam com sinceridade, sorteando pela preferência.
//  - Cúmplices tentam votar na resposta que acham que a maioria vai escolher;
//    cada um acerta essa resposta com probabilidade f ("sintonia").
//  - Detetives fazem dedução lógica: guardam as duplas ainda possíveis; usam a informação
//    de cada rodada com probabilidade r ("atenção"). Acusam quando sobram poucas duplas.
//  - Cúmplices votam SIM em acusações erradas (ganham ponto) e NÃO na acusação certa.

import { newGame, act, mulberry32, TABLE, samePair, FIRST_ACCUSATION_ROUND } from '../src/engine.js';

function normal(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function gamma(rng, k) {
  if (k < 1) return gamma(rng, k + 1) * Math.pow(rng(), 1 / k);
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = normal(rng);
    let v = 1 + c * x;
    if (v <= 0) continue;
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
function dirichlet3(rng, alpha) {
  const g = [gamma(rng, alpha), gamma(rng, alpha), gamma(rng, alpha)];
  const t = g[0] + g[1] + g[2];
  return g.map((x) => x / t);
}
function sample(rng, dist) {
  const u = rng();
  if (u < dist[0]) return 0;
  if (u < dist[0] + dist[1]) return 1;
  return 2;
}
function argmax(d) {
  return d[0] >= d[1] && d[0] >= d[2] ? 0 : d[1] >= d[2] ? 1 : 2;
}

function check(cond, msg, ctx) {
  if (!cond) {
    const e = new Error('INVARIANTE QUEBRADA: ' + msg);
    e.ctx = ctx;
    throw e;
  }
}

export function playGame(n, settings, params, rng) {
  const { f, r, K, Kd, P, alpha, despiste = 0, convention = false, voterSlack = 1, noAccuseFirst = FIRST_ACCUSATION_ROUND > 1 } = params;
  const players = Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'J' + i }));
  const dists = [];
  const questions = [];
  for (let i = 0; i < settings.rounds; i++) {
    dists.push(dirichlet3(rng, alpha));
    questions.push({ q: 'Pergunta ' + (i + 1), a: ['a', 'b', 'c'] });
  }
  let state = newGame({ players, questions, rng, settings });
  const ids = players.map((p) => p.id);
  const cum = state.cumplices;
  const isC = (id) => cum.includes(id);
  const pairs = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pairs.push([ids[i], ids[j]]);
  const truePairIdx = pairs.findIndex((p) => samePair(p, cum));
  // Candidatos de cada detetive
  const cand = {};
  for (const id of ids) {
    if (isC(id)) continue;
    cand[id] = pairs.map((p) => !p.includes(id));
  }
  const apply = (a) => {
    const res = act(state, a);
    check(res.ok, 'ação recusada: ' + JSON.stringify(a) + ' -> ' + res.message, { state });
    state = res.state;
  };
  let steps = 0;
  let accusationsMade = 0;
  let wrongAcc = 0;
  while (!state.result) {
    steps++;
    check(steps < 500, 'partida não termina', { state });
    if (state.phase === 'votar') {
      const dist = dists[state.round - 1];
      const modal = argmax(dist);
      const desperate = state.pontos >= state.settings.meta - 1;
      const cVotes = cum.map(() => {
        if (convention) return 0;
        if (rng() < f) return modal;
        const others = [0, 1, 2].filter((x) => x !== modal);
        return others[Math.floor(rng() * 2)];
      });
      if (!desperate && despiste > 0 && rng() < despiste) {
        const others = [0, 1, 2].filter((x) => x !== cVotes[0]);
        cVotes[1] = others[Math.floor(rng() * 2)];
      }
      for (const id of ids) {
        const option = isC(id) ? cVotes[cum.indexOf(id)] : sample(rng, dist);
        apply({ type: 'vote', player: id, option });
      }
      continue;
    }
    if (state.phase === 'conversa') {
      const h = state.history[state.history.length - 1];
      for (const d of Object.keys(cand)) {
        if (rng() >= r) continue; // não prestou atenção nesta rodada
        for (let k = 0; k < pairs.length; k++) {
          if (!cand[d][k]) continue;
          const [a, b] = pairs[k];
          const same = h.votes[a] !== undefined && h.votes[a] === h.votes[b];
          if (same !== h.igual) cand[d][k] = false;
        }
        check(cand[d][truePairIdx], 'detetive eliminou a dupla verdadeira', { state });
      }
      const desperate = state.pontos >= state.settings.meta - 1;
      const thr = desperate ? Kd : K;
      const proposers = Object.keys(cand).sort(() => rng() - 0.5);
      let proposals = 0;
      for (const d of proposers) {
        if (noAccuseFirst && state.round === 1) break;
        if (proposals >= P || state.phase !== 'conversa') break;
        const options = [];
        cand[d].forEach((v, k) => v && options.push(k));
        if (options.length === 0 || options.length > thr) continue;
        const k = options[Math.floor(rng() * options.length)];
        proposals++;
        accusationsMade++;
        apply({ type: 'propose', player: d, pair: pairs[k] });
        for (const id of ids) {
          let yes;
          if (isC(id)) yes = k !== truePairIdx;
          else {
            const size = cand[id].filter(Boolean).length;
            yes = cand[id][k] && size <= thr + voterSlack;
          }
          apply({ type: 'accuseVote', player: id, yes });
        }
        const last = state.accusations[state.accusations.length - 1];
        if (last.approved && !last.correct) {
          wrongAcc++;
          for (const dd of Object.keys(cand)) cand[dd][k] = false;
        }
      }
      if (state.phase === 'conversa') apply({ type: 'next' });
      continue;
    }
    check(false, 'fase inesperada ' + state.phase, { state });
  }
  // Conferências finais
  const iguais = state.history.filter((h) => h.igual).length;
  check(state.pontos === iguais + state.bonus, 'pontos não batem', { state });
  check(state.history.length <= settings.rounds, 'rodadas demais', { state });
  if (state.result.winner === 'cumplices') check(state.pontos >= settings.meta, 'vitória sem meta', { state });
  if (state.result.reason === 'rodadas') check(state.history.length === settings.rounds, 'fim antes da hora', { state });
  return {
    winner: state.result.winner,
    reason: state.result.reason,
    rounds: state.history.length,
    accusations: accusationsMade,
    wrongAcc,
    pontos: state.pontos,
  };
}

export function runBatch(n, settings, params, games, seed) {
  const rng = mulberry32(seed);
  let cw = 0;
  let rounds = 0;
  let acc = 0;
  const reasons = {};
  for (let g = 0; g < games; g++) {
    const res = playGame(n, settings, params, rng);
    if (res.winner === 'cumplices') cw++;
    rounds += res.rounds;
    acc += res.accusations;
    reasons[res.reason] = (reasons[res.reason] || 0) + 1;
  }
  return { cumplicesWin: cw / games, avgRounds: rounds / games, avgAccusations: acc / games, reasons };
}

export const PROFILES = {
  // Mesa: atenção r, confiança K (acusa com até K duplas possíveis), Kd no desespero.
  atenta: { r: 1.0, K: 1, Kd: 3, P: 2 },
  normal: { r: 0.75, K: 2, Kd: 4, P: 2 },
  distraida: { r: 0.5, K: 2, Kd: 5, P: 2 },
};
export const SYNC = { fraca: 0.6, media: 0.75, forte: 0.9 };

const isMain = process.argv[1] && process.argv[1].endsWith("simulate.mjs");
if (isMain) {
  const games = Number(process.argv[2] || 4000);
  const out = [];
  for (let n = 5; n <= 12; n++) {
    const settings = TABLE[n];
    const row = { n, ...settings };
    for (const [pn, p] of Object.entries(PROFILES)) {
      for (const [sn, f] of Object.entries(SYNC)) {
        const params = { ...p, f, alpha: 1.5 };
        const res = runBatch(n, settings, params, games, 1000 * n + pn.length * 7 + Math.round(f * 100));
        row[`${pn}/${sn}`] = Math.round(res.cumplicesWin * 100);
        if (pn === 'normal' && sn === 'media') {
          row.rodadasMedia = res.avgRounds.toFixed(1);
          row.acusacoes = res.avgAccusations.toFixed(2);
        }
      }
    }
    out.push(row);
  }
  console.table(out);
}

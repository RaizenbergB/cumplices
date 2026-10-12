// Cúmplices — motor do jogo.
// Não mexe em tela nem em rede: recebe o estado e uma ação, devolve o novo estado.
// Usado igual pelo site (navegador) e pelas simulações (Node).

export const VERSION = 1;
export const LETTERS = ['A', 'B', 'C'];
export const MIN_PLAYERS = 5;
export const MAX_PLAYERS = 12;

// Meta de pontos dos cúmplices e número máximo de perguntas, por número de jogadores.
// Valores escolhidos pelas simulações (sim/sweep3.mjs, sim/report.mjs): com a mesa usando o histórico,
// os cúmplices vencem perto de 40 a 50% das partidas no "normal".
// facil/dificil: [meta, perguntas] das opções "mais fácil" e "mais difícil" para os cúmplices.
export const TABLE = {
  5: { meta: 3, rounds: 5, facil: [2, 4], dificil: [3, 4] },
  6: { meta: 3, rounds: 5, facil: [2, 4], dificil: [3, 4] },
  7: { meta: 3, rounds: 4, facil: [3, 5], dificil: [4, 6] },
  8: { meta: 3, rounds: 4, facil: [3, 5], dificil: [4, 6] },
  9: { meta: 4, rounds: 7, facil: [3, 5], dificil: [4, 5] },
  10: { meta: 4, rounds: 7, facil: [3, 5], dificil: [4, 5] },
  11: { meta: 4, rounds: 6, facil: [3, 5], dificil: [4, 5] },
  12: { meta: 4, rounds: 6, facil: [3, 5], dificil: [4, 5] },
};

/** Primeira pergunta em que já dá para acusar (na 1ª, todo mundo só observa). */
export const FIRST_ACCUSATION_ROUND = 2;

/**
 * Configuração da partida para n jogadores.
 * ajuste: -1 (mais fácil para os cúmplices), 0 (normal) ou +1 (mais difícil para os cúmplices).
 */
export function settingsFor(n, ajuste = 0) {
  const row = TABLE[n];
  if (!row) throw new Error(`O jogo é para ${MIN_PLAYERS} a ${MAX_PLAYERS} jogadores.`);
  const adj = Math.max(-1, Math.min(1, Math.round(ajuste) || 0));
  if (adj === -1) return { meta: row.facil[0], rounds: row.facil[1] };
  if (adj === 1) return { meta: row.dificil[0], rounds: row.dificil[1] };
  return { meta: row.meta, rounds: row.rounds };
}

// Gerador de números aleatórios com semente (para simulações reproduzíveis).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const clone = (x) => JSON.parse(JSON.stringify(x));
const ok = (state) => ({ ok: true, state });
const fail = (state, error, message) => ({ ok: false, error, message, state });

export function samePair(p, q) {
  return (p[0] === q[0] && p[1] === q[1]) || (p[0] === q[1] && p[1] === q[0]);
}

function isPlayer(s, id) {
  return s.players.some((p) => p.id === id);
}

function normalizePair(s, pair) {
  if (!Array.isArray(pair) || pair.length !== 2) return null;
  const [a, b] = pair;
  if (a === b || !isPlayer(s, a) || !isPlayer(s, b)) return null;
  const order = s.players.map((p) => p.id);
  return order.indexOf(a) < order.indexOf(b) ? [a, b] : [b, a];
}

export function wrongPairs(s) {
  return s.accusations.filter((a) => a.approved && !a.correct).map((a) => a.pair);
}

function wasCleared(s, pair) {
  return wrongPairs(s).some((p) => samePair(p, pair));
}

/**
 * Cria uma partida.
 * players: [{ id, name }] na ordem da mesa (5 a 12).
 * questions: perguntas já sorteadas, uma por rodada (mais uma, se houver pergunta de treino).
 *            Cada uma: { q, a: [r1, r2, r3] }.
 * training: true acrescenta uma pergunta de treino antes da rodada 1 (não vale ponto, ninguém acusa).
 */
export function newGame({ players, questions, rng = Math.random, settings, training = false }) {
  if (!Array.isArray(players)) throw new Error('Lista de jogadores inválida.');
  const n = players.length;
  if (n < MIN_PLAYERS || n > MAX_PLAYERS) {
    throw new Error(`O jogo é para ${MIN_PLAYERS} a ${MAX_PLAYERS} jogadores.`);
  }
  const ids = new Set(players.map((p) => p.id));
  if (ids.size !== n) throw new Error('Há jogadores repetidos.');
  const st = settings ? { meta: settings.meta, rounds: settings.rounds } : settingsFor(n);
  if (!(st.meta >= 1 && st.rounds >= st.meta)) throw new Error('Configuração inválida.');
  const need = st.rounds + (training ? 1 : 0);
  if (!Array.isArray(questions) || questions.length < need) {
    throw new Error('Faltam perguntas para todas as rodadas.');
  }
  const qs = questions.slice(0, need).map((q) => ({ q: q.q, a: q.a.slice(0, 3) }));
  const chosen = shuffle(players.map((p) => p.id), rng).slice(0, 2);
  const order = players.map((p) => p.id);
  chosen.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return {
    v: VERSION,
    players: players.map((p) => ({ id: p.id, name: p.name })),
    settings: st,
    cumplices: chosen,
    trainingQuestion: training ? qs[0] : null,
    questions: training ? qs.slice(1) : qs,
    round: training ? 0 : 1, // rodada 0 = pergunta de treino
    phase: 'votar', // votar → conversa → (acusacao) → votar ... → fim
    votes: {},
    history: [],
    pontos: 0,
    bonus: 0,
    proposed: {},
    accusation: null,
    accusations: [],
    ready: {},
    result: null,
  };
}

function end(s, winner, reason) {
  s.phase = 'fim';
  s.result = { winner, reason };
  s.accusation = null;
}

function nextRound(s) {
  if (s.round >= s.settings.rounds) {
    // Não deveria acontecer: a última rodada termina na revelação.
    end(s, 'detetives', 'rodadas');
    return;
  }
  s.round += 1;
  s.phase = 'votar';
  s.votes = {};
  s.ready = {};
  s.proposed = {};
}

export function currentQuestion(s) {
  if (s.phase === 'fim') return null;
  if (s.round === 0) return s.trainingQuestion;
  return s.questions[s.round - 1];
}

function reveal(s) {
  const [a, b] = s.cumplices;
  const va = s.votes[a];
  const vb = s.votes[b];
  const igual = va !== undefined && vb !== undefined && va === vb;
  const training = s.round === 0;
  s.history.push({
    round: s.round,
    q: currentQuestion(s),
    votes: { ...s.votes },
    igual,
    training,
  });
  s.ready = {};
  s.proposed = {};
  if (training) {
    s.phase = 'conversa';
    return;
  }
  if (igual) s.pontos += 1;
  if (s.pontos >= s.settings.meta) return end(s, 'cumplices', 'meta');
  if (s.round >= s.settings.rounds) return end(s, 'detetives', 'rodadas');
  s.phase = 'conversa';
}

function resolveAccusation(s, forcedApproved) {
  const acc = s.accusation;
  const n = s.players.length;
  const votes = acc.votes || {};
  const yes = Object.values(votes).filter((v) => v === true).length;
  const no = Object.values(votes).filter((v) => v === false).length;
  const approved = forcedApproved === undefined ? yes > n / 2 : forcedApproved;
  const correct = approved ? samePair(acc.pair, s.cumplices) : null;
  s.accusations.push({
    round: s.round,
    by: acc.by,
    pair: acc.pair,
    votes: { ...votes },
    yes,
    no,
    approved,
    correct,
  });
  s.accusation = null;
  if (!approved) {
    s.phase = 'conversa';
    return;
  }
  if (correct) return end(s, 'detetives', 'acusacao');
  s.pontos += 1;
  s.bonus += 1;
  if (s.pontos >= s.settings.meta) return end(s, 'cumplices', 'acusacao-errada');
  nextRound(s);
}

export function allVoted(s) {
  return s.players.every((p) => s.votes[p.id] !== undefined);
}

/**
 * Aplica uma ação. Devolve { ok, state } ou { ok: false, error, message, state }.
 * Ações:
 *  { type: 'vote', player, option }            option = 0, 1 ou 2 (A, B, C); dá para trocar até todos votarem
 *  { type: 'closeVoting' }                      anfitrião encerra a votação; quem não votou fica sem voto
 *  { type: 'swapQuestion', question }           anfitrião troca a pergunta antes da revelação (votos apagados)
 *  { type: 'propose', player, pair: [id, id] }  propor acusação (uma por jogador por rodada)
 *  { type: 'accuseVote', player, yes }          votar sim/não na acusação
 *  { type: 'closeAccusation' }                  anfitrião encerra a votação da acusação; quem não votou conta como não
 *  { type: 'localAccusation', pair }            modo um celular: a mesa aprovou a acusação com as mãos
 *  { type: 'ready', player }                    pronto para a próxima pergunta
 *  { type: 'next' }                             anfitrião passa para a próxima pergunta
 *  { type: 'abandon' }                          encerrar a partida sem vencedor
 */
export function act(state, action) {
  if (!action || typeof action.type !== 'string') return fail(state, 'acao', 'Ação inválida.');
  if (state.result) return fail(state, 'fim', 'A partida já acabou.');
  const s = clone(state);
  const t = action.type;

  if (t === 'abandon') {
    end(s, null, 'abandono');
    return ok(s);
  }

  if (t === 'vote') {
    if (s.phase !== 'votar') return fail(state, 'fase', 'Agora não é hora de votar na pergunta.');
    if (!isPlayer(s, action.player)) return fail(state, 'jogador', 'Jogador desconhecido.');
    if (![0, 1, 2].includes(action.option)) return fail(state, 'opcao', 'Escolha A, B ou C.');
    s.votes[action.player] = action.option;
    if (allVoted(s)) reveal(s);
    return ok(s);
  }

  if (t === 'swapQuestion') {
    // Pergunta confusa ou que ninguém entendeu: troca antes da revelação e apaga os votos.
    if (s.phase !== 'votar') return fail(state, 'fase', 'Só dá para trocar a pergunta antes da revelação.');
    const q = action.question;
    if (!q || typeof q.q !== 'string' || !Array.isArray(q.a) || q.a.length < 3) return fail(state, 'pergunta', 'Pergunta inválida.');
    const nq = { q: q.q, a: q.a.slice(0, 3) };
    if (s.round === 0) s.trainingQuestion = nq;
    else s.questions[s.round - 1] = nq;
    s.votes = {};
    s.swaps = (s.swaps || 0) + 1;
    return ok(s);
  }

  if (t === 'closeVoting') {
    if (s.phase !== 'votar') return fail(state, 'fase', 'Não há votação aberta.');
    reveal(s);
    return ok(s);
  }

  if (t === 'propose' || t === 'localAccusation') {
    if (s.phase !== 'conversa') return fail(state, 'fase', 'Só dá para acusar depois da revelação.');
    if (s.round === 0) return fail(state, 'treino', 'Na pergunta de treino não vale acusar.');
    if (s.round < FIRST_ACCUSATION_ROUND) {
      return fail(state, 'cedo', 'Na primeira pergunta ninguém acusa: só observem. A acusação abre na próxima.');
    }
    const pair = normalizePair(s, action.pair);
    if (!pair) return fail(state, 'dupla', 'Escolha duas pessoas diferentes.');
    if (wasCleared(s, pair)) {
      return fail(state, 'dupla-inocente', 'Essa dupla já foi acusada e não era a dos cúmplices.');
    }
    if (t === 'localAccusation') {
      s.accusation = { by: null, pair, votes: null };
      resolveAccusation(s, true);
      return ok(s);
    }
    if (!isPlayer(s, action.player)) return fail(state, 'jogador', 'Jogador desconhecido.');
    if (s.proposed[action.player]) {
      return fail(state, 'ja-propos', 'Você já propôs uma acusação nesta rodada.');
    }
    s.proposed[action.player] = true;
    s.accusation = { by: action.player, pair, votes: {} };
    s.phase = 'acusacao';
    s.ready = {};
    return ok(s);
  }

  if (t === 'accuseVote') {
    if (s.phase !== 'acusacao') return fail(state, 'fase', 'Não há acusação em votação.');
    if (!isPlayer(s, action.player)) return fail(state, 'jogador', 'Jogador desconhecido.');
    if (typeof action.yes !== 'boolean') return fail(state, 'voto', 'Vote sim ou não.');
    s.accusation.votes[action.player] = action.yes;
    if (s.players.every((p) => s.accusation.votes[p.id] !== undefined)) resolveAccusation(s);
    return ok(s);
  }

  if (t === 'closeAccusation') {
    if (s.phase !== 'acusacao') return fail(state, 'fase', 'Não há acusação em votação.');
    resolveAccusation(s);
    return ok(s);
  }

  if (t === 'ready') {
    if (s.phase !== 'conversa') return fail(state, 'fase', 'Agora não é hora disso.');
    if (!isPlayer(s, action.player)) return fail(state, 'jogador', 'Jogador desconhecido.');
    s.ready[action.player] = true;
    if (s.players.every((p) => s.ready[p.id])) nextRound(s);
    return ok(s);
  }

  if (t === 'next') {
    if (s.phase !== 'conversa') return fail(state, 'fase', 'Agora não é hora disso.');
    nextRound(s);
    return ok(s);
  }

  return fail(state, 'acao', 'Ação desconhecida.');
}

/** O que todo mundo pode ver. Os cúmplices só aparecem quando a partida acaba. */
export function publicView(s) {
  return {
    v: s.v,
    players: s.players,
    settings: s.settings,
    round: s.round,
    phase: s.phase,
    question: currentQuestion(s),
    votedIds: s.phase === 'votar' ? Object.keys(s.votes) : [],
    history: s.history,
    pontos: s.pontos,
    bonus: s.bonus,
    accusation: s.accusation
      ? { by: s.accusation.by, pair: s.accusation.pair, votedIds: Object.keys(s.accusation.votes || {}) }
      : null,
    accusations: s.accusations,
    ready: Object.keys(s.ready),
    proposed: Object.keys(s.proposed),
    result: s.result ? { ...s.result, cumplices: s.cumplices } : null,
  };
}

/** O que só um jogador pode ver. */
export function privateView(s, playerId) {
  const isC = s.cumplices.includes(playerId);
  return {
    role: isC ? 'cumplice' : 'detetive',
    partner: isC ? s.cumplices.find((id) => id !== playerId) : null,
    myVote: s.votes[playerId] !== undefined ? s.votes[playerId] : null,
    myAccuseVote:
      s.accusation && s.accusation.votes && s.accusation.votes[playerId] !== undefined
        ? s.accusation.votes[playerId]
        : null,
  };
}

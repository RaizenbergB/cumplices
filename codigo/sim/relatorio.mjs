// Relatório final das simulações, com a tabela oficial do jogo (src/engine.js).
// Uso: node sim/relatorio.mjs [partidas por linha]
// Cada partida roda no motor de verdade e confere as regras no fim (pontos, rodadas, vencedor).
import { playGame } from './simulate.mjs';
import { TABLE, mulberry32 } from '../src/engine.js';

const games = Number(process.argv[2] || 3000);
const PERFIS = {
  'atenta': { r: 1.0, K: 2, Kd: 4, P: 2, f: 0.75 },
  'normal': { r: 0.75, K: 2, Kd: 4, P: 2, f: 0.75 },
  'cautelosa': { r: 1.0, K: 1, Kd: 2, P: 1, f: 0.75 },
  'afobada': { r: 0.75, K: 4, Kd: 6, P: 3, f: 0.75 },
  'sintonia fraca': { r: 1.0, K: 2, Kd: 4, P: 2, f: 0.6 },
  'sintonia forte': { r: 1.0, K: 2, Kd: 4, P: 2, f: 0.9 },
};
const out = { games, rows: [] };
let total = 0;
for (let n = 5; n <= 12; n++) {
  const st = { meta: TABLE[n].meta, rounds: TABLE[n].rounds };
  const row = { n, meta: st.meta, rodadas: st.rounds };
  for (const [nome, p] of Object.entries(PERFIS)) {
    const rng = mulberry32(20261012 + n * 1009 + nome.length * 31);
    let cw = 0, rr = 0, acc = 0, wrong = 0, maxR = 0;
    const fins = {};
    for (let g = 0; g < games; g++) {
      const res = playGame(n, st, { ...p, alpha: 1.5 }, rng);
      total++;
      if (res.winner === 'cumplices') cw++;
      rr += res.rounds;
      maxR = Math.max(maxR, res.rounds);
      acc += res.accusations;
      wrong += res.wrongAcc;
      fins[res.reason] = (fins[res.reason] || 0) + 1;
    }
    row[nome] = Math.round((cw / games) * 100);
    if (nome === 'atenta') {
      row.rodadasMedia = +(rr / games).toFixed(1);
      row.rodadasMax = maxR;
      row.acusacoesPorPartida = +(acc / games).toFixed(1);
      row.fins = Object.fromEntries(Object.entries(fins).map(([k, v]) => [k, Math.round((v / games) * 100)]));
    }
  }
  out.rows.push(row);
}
out.total = total;
console.log(JSON.stringify(out, null, 1));

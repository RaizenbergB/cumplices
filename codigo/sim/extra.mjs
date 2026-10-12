// Conferências extras de equilíbrio (além de simulate.mjs):
//  1) mesa que usa o histórico na tela (atenção total) com coragem normal;
//  2) cúmplices com "convenção" (sempre a 1ª resposta) e com sintonia fraca;
//  3) quantas partidas acabam cedo demais (vitória dos cúmplices sem a mesa ter tido chance).
import { runBatch, playGame } from './simulate.mjs';
import { TABLE, mulberry32 } from '../src/engine.js';

const games = Number(process.argv[2] || 3000);
const profiles = {
  'historico/media': { r: 1.0, K: 2, Kd: 4, P: 2, f: 0.75 },
  'historico/fraca': { r: 1.0, K: 2, Kd: 4, P: 2, f: 0.6 },
  'historico/forte': { r: 1.0, K: 2, Kd: 4, P: 2, f: 0.9 },
  'cautelosa/media': { r: 1.0, K: 1, Kd: 2, P: 1, f: 0.75 },
  'afobada/media': { r: 0.75, K: 4, Kd: 6, P: 3, f: 0.75 },
  'convencaoA': { r: 1.0, K: 2, Kd: 4, P: 2, f: 0.75, convention: true },
};
const rows = [];
for (let n = 5; n <= 12; n++) {
  const st = TABLE[n];
  const row = { n, meta: st.meta, rodadas: st.rounds };
  for (const [name, p] of Object.entries(profiles)) {
    const res = runBatch(n, st, { ...p, alpha: 1.5 }, games, 777 + n * 31 + name.length);
    row[name] = Math.round(res.cumplicesWin * 100);
  }
  // vitórias relâmpago dos cúmplices: chegaram à meta sem nenhuma rodada "a mais" e sem a mesa acusar
  const rng = mulberry32(4242 + n);
  let fast = 0, early = 0;
  for (let g = 0; g < games; g++) {
    const r = playGame(n, st, { r: 1, K: 2, Kd: 4, P: 2, f: 0.75, alpha: 1.5 }, rng);
    if (r.winner === 'cumplices' && r.rounds <= st.meta && r.accusations === 0) fast++;
    if (r.rounds <= 1) early++;
  }
  row['relampago%'] = Math.round((fast / games) * 1000) / 10;
  row['fim-na-1a%'] = Math.round((early / games) * 1000) / 10;
  rows.push(row);
}
console.table(rows);

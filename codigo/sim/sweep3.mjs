// Varredura de meta × rodadas para cada número de jogadores, com a mesa usando o histórico.
import { playGame } from './simulate.mjs';
import { mulberry32 } from '../src/engine.js';
const n = Number(process.argv[2]);
const games = Number(process.argv[3] || 1500);
const noAccuseFirst = process.argv[4] === 'r2';
const P = {
  hist: { r: 1.0, K: 2, Kd: 4, P: 2, f: 0.75 },
  norm: { r: 0.75, K: 2, Kd: 4, P: 2, f: 0.75 },
  caut: { r: 1.0, K: 1, Kd: 2, P: 1, f: 0.75 },
  afob: { r: 0.75, K: 4, Kd: 6, P: 3, f: 0.75 },
  hfra: { r: 1.0, K: 2, Kd: 4, P: 2, f: 0.6 },
  hfor: { r: 1.0, K: 2, Kd: 4, P: 2, f: 0.9 },
};
const out = [];
for (let meta = 2; meta <= 5; meta++) {
  for (let rounds = meta; rounds <= meta + 4; rounds++) {
    const row = { n, meta, rounds };
    for (const [k, p] of Object.entries(P)) {
      const rng = mulberry32(1000 * n + 37 * meta + rounds + k.length);
      let cw = 0, rr = 0, r1 = 0;
      for (let g = 0; g < games; g++) {
        const res = playGame(n, { meta, rounds }, { ...p, alpha: 1.5, noAccuseFirst }, rng);
        if (res.winner === 'cumplices') cw++;
        rr += res.rounds;
        if (res.rounds <= 1) r1++;
      }
      row[k] = Math.round((cw / games) * 100);
      if (k === 'hist') { row.rod = +(rr / games).toFixed(1); row.r1 = Math.round((r1 / games) * 100); }
    }
    out.push(row);
  }
}
console.log(JSON.stringify(out));

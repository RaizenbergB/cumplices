// Gera o HTML do kit para imprimir (depois vira PDF com ferramentas/kit.py).
// Folhas A4: 1) resumo de uma página, 2) folha do narrador, 3 a 10) 12 credenciais + 60 cartas de pergunta
// em 63 × 88 mm, 9 por folha, com linhas de corte de ponta a ponta.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TABLE } from '../src/engine.js';
import { QUESTIONS } from '../src/questions.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const out = process.argv[2] || join(ROOT, 'kit-build', 'kit.html');
const fontDir = join(ROOT, 'site-base', 'fontes');
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// 60 perguntas espalhadas pelo banco inteiro (pega de todos os temas)
const N_Q = 60;
const picked = [];
for (let k = 0; k < N_Q; k++) picked.push(QUESTIONS[Math.floor((k * QUESTIONS.length) / N_Q)]);

// Papel de segurança em vetor (anéis finos saindo de dois cantos), para o PDF ficar leve.
const rings = (() => {
  let c = '';
  for (let r = 2.5; r < 110; r += 2.65) c += `<circle cx="0" cy="0" r="${r.toFixed(2)}"/><circle cx="63" cy="88" r="${r.toFixed(2)}"/>`;
  return c;
})();
// A textura vai como imagem (a mesma para todas as cartas): o PDF guarda uma vez só e fica leve.
const guil = (kind) => `<img class="guil" src="file://${join(HERE, 'aneis-' + kind + '.jpg')}" alt="">`;
const credential = (kind) =>
  kind === 'c'
    ? `<div class="card cred c">${guil('c')}<p class="head">Credencial secreta</p><span class="stamp">Cúmplice</span>
       <p>Você e a sua dupla tentam responder <b>igual</b>, sem combinar nada.</p><p class="foot"><span class="mk"><i></i><i></i></span> Cúmplices</p></div>`
    : `<div class="card cred d">${guil('d')}<p class="head">Credencial secreta</p><span class="stamp">Detetive</span>
       <p>Descubra quem são os dois cúmplices.</p><p class="foot"><span class="mk"><i></i><i></i></span> Cúmplices</p></div>`;
const question = (q) => `<div class="card q"><p class="qq">${esc(q.q)}</p>
  <ol class="ans">${q.a.map((a, i) => `<li><span class="n n${i}">${i + 1}</span><span>${esc(a)}</span></li>`).join('')}</ol>
  <p class="foot"><span class="mk"><i></i><i></i></span> Cúmplices</p></div>`;

const cards = [
  credential('c'), credential('c'),
  ...Array.from({ length: 10 }, () => credential('d')),
  ...picked.map(question),
];
const sheets = [];
for (let i = 0; i < cards.length; i += 9) sheets.push(cards.slice(i, i + 9));

const rowsMeta = [['5 ou 6', 5], ['7 ou 8', 7], ['9 ou 10', 9], ['11 ou 12', 11]]
  .map(([l, n]) => `<tr><td>${l}</td><td><b>${TABLE[n].meta} IGUAIS</b></td><td>até ${TABLE[n].rounds}</td><td>${Math.floor(n / 2) + 1}${n % 2 === 0 ? ` a ${Math.floor((n + 1) / 2) + 1}` : ''}</td></tr>`)
  .join('');
const majority = [5, 6, 7, 8, 9, 10, 11, 12].map((n) => `<td>${n}: <b>${Math.floor(n / 2) + 1}</b></td>`).join('');
const grid = Array.from({ length: 12 }, () => `<tr><td></td>${'<td></td>'.repeat(7)}</tr>`).join('');

const font = (name, file, weight) =>
  `@font-face{font-family:'${name}';font-weight:${weight};src:url('file://${join(fontDir, file)}') format('woff2')}`;

const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Cúmplices: kit para imprimir</title>
<style>
${font('Rubik', 'rubik-400.woff2', 400)}${font('Rubik', 'rubik-500.woff2', 500)}${font('Rubik', 'rubik-700.woff2', 700)}${font('Rubik', 'rubik-800.woff2', 800)}${font('Rubik Dirt', 'rubik-dirt-carimbo.woff2', 400)}
@page{size:A4;margin:0}
*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
html,body{margin:0;padding:0}
body{font-family:'Rubik',sans-serif;color:#171b2e;--pair:#d94e1a;--det:#2f5db5;--a:#0b7f72;--b:#a87100;--c:#95307a}
.page{width:210mm;height:297mm;position:relative;overflow:hidden;page-break-after:always;break-after:page}
.page:last-child{page-break-after:auto;break-after:auto}
.stamp{display:inline-block;font-family:'Rubik Dirt','Rubik',sans-serif;text-transform:uppercase;line-height:1;padding:.14em .32em .07em;border:.08em solid currentColor;border-radius:.14em;transform:rotate(-4deg);white-space:nowrap}
.mk{display:inline-flex;vertical-align:-.12em}.mk i{width:1em;height:1em;border-radius:50%;background:var(--pair);display:block}.mk i+i{margin-left:-.42em;background:var(--det);mix-blend-mode:multiply}
/* folha de texto */
.text{padding:16mm 16mm 14mm;font-size:10.5pt;line-height:1.42}
.text h1{margin:0 0 4mm;font-size:22pt;display:flex;align-items:center;gap:4mm}
.text h1 .stamp{color:var(--pair);font-size:24pt}
.text h2{font-size:12.5pt;margin:5mm 0 1.5mm;font-weight:800}
.text p,.text li{margin:1.2mm 0}
.text ol,.text ul{margin:1mm 0;padding-left:5mm}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:0 9mm}
table{border-collapse:collapse;width:100%;font-size:9.5pt}
th,td{border-bottom:.3mm solid #c9cfdc;padding:1.2mm 1mm;text-align:left}
th{color:#5b6276;font-weight:700}
.grid{margin-top:2mm}
.grid td{border:.3mm solid #8a93a8;height:8.2mm}
.grid td:first-child{width:38mm}
.grid th{border:.3mm solid #8a93a8;text-align:center}
.box{border:.4mm solid #171b2e;border-radius:3mm;padding:3mm 4mm;margin-top:3mm}
.say{font-style:normal;font-weight:700}
/* folha de cartas */
.sheet{position:absolute;left:10.5mm;top:16.5mm;width:189mm;height:264mm;display:grid;grid-template-columns:repeat(3,63mm);grid-template-rows:repeat(3,88mm)}
.cut{position:absolute;background:transparent}
.cut.v{top:0;bottom:0;width:0;border-left:.25mm dashed #9aa3b5}
.cut.h{left:0;right:0;height:0;border-top:.25mm dashed #9aa3b5}
.card{width:63mm;height:88mm;padding:5mm 5mm 4mm;position:relative;display:flex;flex-direction:column;overflow:hidden}
.card .foot{margin-top:auto;font-size:7.5pt;font-weight:700;color:#5b6276;display:flex;align-items:center;gap:1.5mm}
.cred{align-items:center;text-align:center;justify-content:flex-start;gap:3.6mm}
.cred .guil{position:absolute;inset:0;width:100%;height:100%}
.cred::after{content:'';position:absolute;inset:2.2mm;border:.4mm solid var(--ink);border-radius:2mm;pointer-events:none}
.cred>*:not(.guil){position:relative;z-index:1}
.cred.c{--ink:var(--pair);--ink-l:rgba(217,78,26,.30)}
.cred.d{--ink:var(--det);--ink-l:rgba(47,93,181,.30)}
.cred .head{margin:3mm 0 0;font-size:8.5pt;font-weight:800;color:var(--ink);background:#fff;padding:0 1.5mm;border-radius:1mm}
.cred .stamp{color:var(--ink);font-size:20pt;background:rgba(255,255,255,.9);margin-top:5mm}
.cred p{margin:0;font-size:10pt;line-height:1.35;background:rgba(255,255,255,.9);border-radius:1mm;padding:.6mm 1.6mm}
.cred .foot{background:transparent;justify-content:center}
.q{justify-content:center}
.q .qq{margin:0 0 5mm;font-size:14pt;line-height:1.2;font-weight:800}
.q .foot{position:absolute;left:5mm;bottom:4mm}
.q{padding-bottom:10mm}
.ans{list-style:none;margin:0;padding:0;display:grid;gap:3.4mm}
.ans li{display:flex;gap:2.6mm;align-items:center;font-size:12pt;line-height:1.2;font-weight:500}
.n{flex:none;width:6.6mm;height:6.6mm;border-radius:1.4mm;color:#fff;font-weight:800;font-size:10.5pt;display:grid;place-items:center}
.n0{background:var(--a)}.n1{background:var(--b)}.n2{background:var(--c)}
.pageno{position:absolute;bottom:6mm;right:10.5mm;font-size:7.5pt;color:#8a93a8}
.hint{position:absolute;top:7mm;left:10.5mm;right:10.5mm;font-size:8pt;color:#5b6276}
</style></head><body>

<section class="page text">
  <h1><span class="mk" style="font-size:20pt"><i></i><i></i></span><span class="stamp">Cúmplices</span></h1>
  <p style="font-size:12pt;font-weight:500;margin-top:0">Dois de vocês pensam igual. O resto tem que descobrir quem. Para 5 a 12 pessoas, a partir de 10 anos.</p>
  <div class="cols">
    <div>
      <h2>Objetivo</h2>
      <p>Dois jogadores secretos, os <b>cúmplices</b>, tentam responder igual sem combinar. Os <b>detetives</b> tentam descobrir a dupla antes.</p>
      <h2>Preparação</h2>
      <p><b>Com celular:</b> abra o site do jogo, crie a sala e os outros entram pelo código, link ou QR.</p>
      <p><b>Sem celular:</b> um narrador entrega as credenciais (ou cartas de baralho: reis vermelhos são os cúmplices) e faz o “todos fechem os olhos; cúmplices, abram e vejam a sua dupla”.</p>
      <h2>A cada pergunta</h2>
      <ol>
        <li><b>Respondam em silêncio.</b> Com o narrador: “um, dois, três, já!” e todos mostram 1, 2 ou 3 dedos juntos.</li>
        <li><b>Revelação:</b> IGUAL = os cúmplices escolheram a mesma resposta: +1 ponto para eles. DIFERENTE = nada.</li>
        <li><b>Conversem.</b> Vale mentir. Não vale mostrar o papel.</li>
        <li><b>Acusem</b> (da 2ª pergunta em diante): alguém diz uma dupla e todos votam juntos. Mais da metade diz sim: revela. Certa: detetives vencem. Errada: +1 ponto para os cúmplices e vem a próxima pergunta.</li>
      </ol>
    </div>
    <div>
      <h2>Fim</h2>
      <p><b>Cúmplices</b> vencem ao chegar à meta. <b>Detetives</b> vencem acusando a dupla certa ou se as perguntas acabarem antes.</p>
      <table><thead><tr><th>Pessoas</th><th>Meta</th><th>Perguntas</th></tr></thead><tbody>
      ${[['5 ou 6', 5], ['7 ou 8', 7], ['9 ou 10', 9], ['11 ou 12', 11]].map(([l, n]) => `<tr><td>${l}</td><td><b>${TABLE[n].meta} IGUAIS</b></td><td>até ${TABLE[n].rounds}</td></tr>`).join('')}
      </tbody></table>
      <h2>Sins para aprovar uma acusação</h2>
      <table><tbody><tr>${[5, 6, 7, 8].map((n) => `<td>${n} pessoas: <b>${Math.floor(n / 2) + 1}</b></td>`).join('')}</tr><tr>${[9, 10, 11, 12].map((n) => `<td>${n} pessoas: <b>${Math.floor(n / 2) + 1}</b></td>`).join('')}</tr></tbody></table>
      <h2>Lembretes</h2>
      <ul>
        <li>Cada um propõe no máximo 1 acusação por pergunta.</li>
        <li>Dupla inocentada não pode ser acusada de novo.</li>
        <li>Quem não responder, ou mostrar os dedos atrasado, fica sem resposta. Cúmplice sem resposta conta DIFERENTE.</li>
        <li>Os cúmplices não podem combinar nada, nem antes da partida.</li>
      </ul>
    </div>
  </div>
  <div class="box"><b>Como montar o kit:</b> imprima em tamanho real (100%, sem “ajustar à página”). Corte nas linhas tracejadas, de ponta a ponta da folha. Se quiser, cole em papelão antes de cortar. O verso das cartas fica em branco: assim todas as credenciais parecem iguais viradas para baixo.</div>
  <span class="pageno">1</span>
</section>

<section class="page text">
  <h1 style="font-size:18pt"><span class="stamp" style="font-size:18pt">Narrador</span> Folha do narrador</h1>
  <div class="cols">
    <div>
      <h2>Antes da partida</h2>
      <ol>
        <li>Separe uma credencial por jogador: as 2 de <b>cúmplice</b> e o resto de <b>detetive</b>. Embaralhe e entregue viradas para baixo. Cada um olha em segredo e devolve virada.</li>
        <li>Diga: <span class="say">“Todos fechem os olhos.”</span> <span class="say">“Cúmplices, abram os olhos e vejam a sua dupla.”</span> (Você também olha.) <span class="say">“Cúmplices, fechem.”</span> <span class="say">“Todos, abram.”</span></li>
        <li>Escreva os nomes na grade abaixo e marque a meta.</li>
      </ol>
      <h2>Em cada pergunta</h2>
      <ol>
        <li>Leia a pergunta e as respostas: <span class="say">“1, ... 2, ... 3, ...”</span></li>
        <li><span class="say">“Um, dois, três, já!”</span> Todos mostram 1, 2 ou 3 dedos juntos.</li>
        <li>Anote os dedos de cada um e anuncie, sem expressão: <span class="say">IGUAL</span> (marque 1 ponto) ou <span class="say">DIFERENTE</span>.</li>
        <li>Da 2ª pergunta em diante: quando alguém disser <span class="say">“Acuso Fulano e Beltrano”</span>, conte até três e todos levantam a mão (sim) ou não. Mais da metade? Revele: <span class="say">“Certo!”</span> ou <span class="say">“Errado!”</span> (+1 ponto e próxima pergunta).</li>
      </ol>
    </div>
    <div>
      <h2>Metas</h2>
      <table><thead><tr><th>Pessoas</th><th>Meta</th><th>Perguntas</th></tr></thead><tbody>
      ${[['5 ou 6', 5], ['7 ou 8', 7], ['9 ou 10', 9], ['11 ou 12', 11]].map(([l, n]) => `<tr><td>${l}</td><td><b>${TABLE[n].meta} IGUAIS</b></td><td>até ${TABLE[n].rounds}</td></tr>`).join('')}
      </tbody></table>
      <h2>Sins para aprovar</h2>
      <table><tbody><tr>${[5, 6, 7, 8].map((n) => `<td>${n}: <b>${Math.floor(n / 2) + 1}</b></td>`).join('')}</tr><tr>${[9, 10, 11, 12].map((n) => `<td>${n}: <b>${Math.floor(n / 2) + 1}</b></td>`).join('')}</tr></tbody></table>
      <div class="box"><b>Pontos dos cúmplices</b> (IGUAIS + acusações erradas):<br><span style="font-size:20pt;letter-spacing:4mm">○ ○ ○ ○ ○</span><br><b>Meta desta partida:</b> ______</div>
    </div>
  </div>
  <h2>Histórico (anote 1, 2 ou 3 em cada pergunta; embaixo, IGUAL ou DIFERENTE)</h2>
  <table class="grid"><thead><tr><th>Jogador</th>${[1, 2, 3, 4, 5, 6, 7].map((i) => `<th>${i}</th>`).join('')}</tr></thead>
  <tbody>${grid}<tr><td><b>Carimbo</b></td>${'<td></td>'.repeat(7)}</tr></tbody></table>
  <span class="pageno">2</span>
</section>

${sheets
  .map(
    (cs, si) => `<section class="page">
  <p class="hint">Corte nas linhas tracejadas. Cartas de 63 × 88 mm.</p>
  ${[10.5, 73.5, 136.5, 199.5].map((x) => `<span class="cut v" style="left:${x}mm"></span>`).join('')}
  ${[16.5, 104.5, 192.5, 280.5].map((y) => `<span class="cut h" style="top:${y}mm"></span>`).join('')}
  <div class="sheet">${cs.join('')}</div>
  <span class="pageno">${si + 3}</span>
</section>`,
  )
  .join('')}
</body></html>`;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log('kit.html:', sheets.length + 2, 'folhas,', cards.length, 'cartas ->', out);

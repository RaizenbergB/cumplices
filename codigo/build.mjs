// Gera o site do jogo (tudo o que o GitHub Pages publica):
//   index.html      → o jogo (código e estilo embutidos)
//   regras.html     → livro de regras, guia rápido e resumo para imprimir
//   fontes/         → fontes Rubik e Rubik Dirt (carimbo)
//   icones/, manifest.webmanifest, og.png → ícone, "adicionar à tela inicial" e prévia de link
//   kit/            → PDF para imprimir (gerado por ferramentas/kit.py, copiado se existir)
//
// Uso: node build.mjs            (dentro da pasta "codigo" do repositório: grava na raiz do repositório)
//      OUT=site node build.mjs   (grava em outra pasta)
import { build, transform } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TABLE, FIRST_ACCUSATION_ROUND } from './src/engine.js';
import { QUESTIONS } from './src/questions.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, process.env.OUT || (basename(HERE) === 'codigo' ? '..' : 'site'));
const SITE_URL = process.env.SITE_URL || 'https://raizenbergb.github.io/cumplices/';
const DESCRIPTION =
  'Jogo de dedução para 5 a 12 pessoas, cada uma no seu celular: dois cúmplices tentam responder igual sem combinar, e o resto da mesa tenta descobrir quem são.';
const ICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><circle cx='24' cy='32' r='19' fill='#d94e1a'/><circle cx='40' cy='32' r='19' fill='#2f5db5' fill-opacity='0.85'/></svg>",
  );
const read = (p) => readFileSync(join(HERE, p), 'utf8');

const res = await build({
  entryPoints: [join(HERE, 'src/app.js')],
  bundle: true,
  format: 'iife',
  minify: true,
  write: false,
  target: ['es2019', 'safari13'],
  define: { __ONLINE__: 'true', __SITE_URL__: JSON.stringify(SITE_URL), __PEER_SERVER__: 'null' },
  legalComments: 'none',
});
const app = res.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = (await transform(read('src/style.css'), { loader: 'css', minify: true })).code;
const peer = readFileSync(join(HERE, 'node_modules/peerjs/dist/peerjs.min.js'), 'utf8')
  .replace(/\/\/# sourceMappingURL=.*$/m, '')
  .replace(/<\/script/gi, '<\\/script');

const head = (title, desc, extra = '') => `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<meta name="description" content="${desc}">
<meta name="theme-color" content="#f3f5f9" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0f121c" media="(prefers-color-scheme: dark)">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:type" content="website">
<meta property="og:url" content="${SITE_URL}">
<meta property="og:image" content="${SITE_URL}og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:locale" content="pt_BR">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="${ICON}">
<link rel="apple-touch-icon" href="icones/icone-180.png">
<link rel="manifest" href="manifest.webmanifest">
<link rel="preload" href="fontes/rubik-400.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="fontes/rubik-800.woff2" as="font" type="font/woff2" crossorigin>
${extra}`;

const index = `<!doctype html>
<html lang="pt-BR">
<head>
${head('Cúmplices', DESCRIPTION)}
<style>${css}</style>
</head>
<body>
<div id="app"><main class="screen"><p>Carregando…</p></main></div>
<noscript><p style="padding:16px">Para jogar, ative o JavaScript do navegador.</p></noscript>
<script>/* PeerJS 1.5.5 (licença MIT) — https://peerjs.com */${peer}</script>
<script>${app}</script>
</body>
</html>
`;

// Livro de regras: a tabela de metas vem do próprio motor do jogo (nunca fica diferente do site).
const ROWS = [
  ['5 ou 6', 5],
  ['7 ou 8', 7],
  ['9 ou 10', 9],
  ['11 ou 12', 11],
];
const tableRows = ROWS.map(
  ([label, n]) =>
    `<tr><td>${label}</td><td><b>${TABLE[n].meta} IGUAIS</b></td><td>até ${TABLE[n].rounds}</td><td>${TABLE[n].facil[0]} em até ${TABLE[n].facil[1]}</td><td>${TABLE[n].dificil[0]} em até ${TABLE[n].dificil[1]}</td></tr>`,
).join('');
const tableRowsShort = ROWS.map(
  ([label, n]) => `<tr><td>${label}</td><td><b>${TABLE[n].meta} IGUAIS</b> em até ${TABLE[n].rounds} perguntas</td></tr>`,
).join('');
const majority = [5, 6, 7, 8, 9, 10, 11, 12].map((n) => `<tr><td>${n}</td><td>${Math.floor(n / 2) + 1}</td></tr>`).join('');
let rules = read('src/regras.html')
  .replace('{{HEAD}}', head('Cúmplices: regras', 'Livro de regras do Cúmplices: preparação, rodada, fim de jogo, exemplos, dúvidas, variantes e resumo para imprimir.'))
  .replaceAll('{{TABELA}}', tableRows)
  .replaceAll('{{TABELA_CURTA}}', tableRowsShort)
  .replaceAll('{{MAIORIA}}', majority)
  .replaceAll('{{SITE}}', SITE_URL)
  .replaceAll('{{PERGUNTAS}}', String(QUESTIONS.length))
  .replaceAll('{{PRIMEIRA_ACUSACAO}}', FIRST_ACCUSATION_ROUND === 2 ? 'segunda' : String(FIRST_ACCUSATION_ROUND) + 'ª');
const leftover = rules.match(/\{\{[A-Z_]+\}\}/);
if (leftover) throw new Error('Marcador sem valor em regras.html: ' + leftover[0]);

mkdirSync(join(OUT, 'fontes'), { recursive: true });
mkdirSync(join(OUT, 'icones'), { recursive: true });
writeFileSync(join(OUT, 'index.html'), index);
writeFileSync(join(OUT, 'regras.html'), rules);
writeFileSync(join(OUT, '.nojekyll'), '');
for (const f of readdirSync(join(HERE, 'site-base/fontes'))) copyFileSync(join(HERE, 'site-base/fontes', f), join(OUT, 'fontes', f));
for (const f of existsSync(join(HERE, 'site-base/icones')) ? readdirSync(join(HERE, 'site-base/icones')) : []) {
  copyFileSync(join(HERE, 'site-base/icones', f), join(OUT, 'icones', f));
}
for (const f of ['og.png', 'manifest.webmanifest']) {
  if (existsSync(join(HERE, 'site-base', f))) copyFileSync(join(HERE, 'site-base', f), join(OUT, f));
}
if (existsSync(join(HERE, 'site-base/kit'))) {
  mkdirSync(join(OUT, 'kit'), { recursive: true });
  for (const f of readdirSync(join(HERE, 'site-base/kit'))) copyFileSync(join(HERE, 'site-base/kit', f), join(OUT, 'kit', f));
}
console.log(`Site gerado em ${OUT}: index.html ${(index.length / 1024).toFixed(0)} KB, regras.html ${(rules.length / 1024).toFixed(0)} KB`);

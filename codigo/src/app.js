// Cúmplices — interface do site (modo online e modo um celular só).
import {
  LETTERS, settingsFor, newGame, act, publicView, privateView, currentQuestion, MIN_PLAYERS, MAX_PLAYERS, TABLE,
  FIRST_ACCUSATION_ROUND,
} from './engine.js';
import qrcode from 'qrcode-generator';
import { pickQuestions, questionKey, QUESTIONS } from './questions.js';
import { HostRoom } from './room-host.js';
import { ClientRoom } from './room-client.js';
import { peerTransport, mqttTransport, dualTransport, PUBLIC_BROKERS } from './transport.js';
import {
  createStore, randomId, normalizeCode, cleanName, sameName, initials, secureRandom, scoreGame,
} from './util.js';

/* global __ONLINE__, __SITE_URL__, __PEER_SERVER__ */
const ONLINE = typeof __ONLINE__ !== 'undefined' ? __ONLINE__ : true;
const SITE_URL = typeof __SITE_URL__ !== 'undefined' ? __SITE_URL__ : '';
// Página com o livro de regras (mesma pasta do jogo no site; endereço completo na versão sem modo online).
const RULES_URL = ONLINE ? 'regras.html' : SITE_URL ? SITE_URL + 'regras.html' : '';
const store = createStore();
const $app = document.getElementById('app');

// ---------------------------------------------------------------- estado da tela
const ui = {
  screen: 'inicio',
  comoVolta: 'inicio',
  form: { name: store.get('nome', '') || '', code: '' },
  online: null,
  seenRole: {},
  seenAcc: {},
  overlay: null,
  picking: false,
  pick: [],
  confirm: null,
  toast: null,
  timerEnds: null,
  timerPaused: null,
  animKey: null,
  local: null,
  holding: null,
  pendingRender: false,
};

function deviceId() {
  let id = store.get('id', null);
  if (typeof id !== 'string' || !/^[a-z0-9]{6,32}$/.test(id)) {
    id = randomId(12);
    store.set('id', id);
  }
  return id;
}

// ---------------------------------------------------------------- utilidades de HTML
const esc = (s) =>
  String(s === undefined || s === null ? '' : s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const fingers = (i) => `<span class="fingers" aria-hidden="true">${'<i></i>'.repeat(i + 1)}</span>`;
const badge = (i) => `<span class="badge opt-${i}"><b>${LETTERS[i]}</b>${fingers(i)}</span>`;
const dotsHTML = (pontos, meta) =>
  `<span class="dots" role="img" aria-label="Cúmplices: ${pontos} de ${meta} pontos">${Array.from(
    { length: meta },
    (_, i) => `<i class="${i < pontos ? 'on' : ''}"></i>`,
  ).join('')}</span>`;
const stampHTML = (text, kind, animate, extra = '') =>
  `<span class="stamp stamp-${kind}${animate ? ' stamp-in' : ''}${extra ? ' ' + extra : ''}">${esc(text)}</span>`;
const plural = (n, um, varios) => (n === 1 ? um : varios);
const listNames = (names) => {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  return names.slice(0, -1).join(', ') + ' e ' + names[names.length - 1];
};

function metaText(n, ajuste = 0) {
  const st = settingsFor(n, ajuste);
  return `Com ${n} pessoas, os cúmplices precisam de ${st.meta} IGUAIS em até ${st.rounds} perguntas.`;
}

function toast(msg) {
  ui.toast = msg;
  const el = document.getElementById('toast');
  if (el) {
    el.textContent = msg;
    el.hidden = false;
  }
  clearTimeout(toast.h);
  toast.h = setTimeout(() => {
    ui.toast = null;
    const e2 = document.getElementById('toast');
    if (e2) e2.hidden = true;
  }, 3800);
}

// ---------------------------------------------------------------- tela cheia acordada
let wakeLock = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible' && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
    }
  } catch (e) {
    wakeLock = null;
  }
}

// ---------------------------------------------------------------- navegação
function go(screen) {
  ui.screen = screen;
  ui.picking = false;
  ui.pick = [];
  render();
  window.scrollTo(0, 0);
}

function render() {
  if (ui.holding) {
    ui.pendingRender = true;
    return;
  }
  ui.pendingRender = false;
  let html = '';
  switch (ui.screen) {
    case 'criar':
      html = viewCriar();
      break;
    case 'entrar':
      html = viewEntrar();
      break;
    case 'sala':
      html = viewSala();
      break;
    case 'como':
      html = viewComo();
      break;
    case 'um-config':
      html = viewUmConfig();
      break;
    case 'um':
      html = viewUm();
      break;
    default:
      html = viewInicio();
  }
  html += viewOverlay() + viewConfirm();
  html += `<div id="toast" class="toast" role="status" ${ui.toast ? '' : 'hidden'}>${esc(ui.toast || '')}</div>`;
  $app.innerHTML = html;
  updateTimers();
}

// ---------------------------------------------------------------- início
function viewInicio() {
  const savedHost = ONLINE ? HostRoom.loadSaved(store) : null;
  const savedClient = ONLINE ? store.get('cliente', null) : null;
  const savedLocal = store.get('mesa', null);
  let resume = '';
  if (savedHost) {
    resume += `<div class="resume"><p>Você é o anfitrião da <b>sala ${esc(savedHost.code)}</b>.</p>
      <div class="row"><button class="btn primary" data-a="retomar-anfitriao">Voltar para a sala</button>
      <button class="btn ghost" data-a="descartar-anfitriao">Fechar essa sala</button></div></div>`;
  } else if (savedClient && savedClient.code && Date.now() - (savedClient.at || 0) < 12 * 3600e3) {
    resume += `<div class="resume"><p>Você entrou na <b>sala ${esc(savedClient.code)}</b> como ${esc(savedClient.name)}.</p>
      <div class="row"><button class="btn primary" data-a="retomar-cliente">Voltar para a sala</button>
      <button class="btn ghost" data-a="descartar-cliente">Esquecer</button></div></div>`;
  }
  if (savedLocal && savedLocal.game && !savedLocal.game.result) {
    resume += `<div class="resume"><p><b>Partida em um celular só</b> em andamento.</p>
      <div class="row"><button class="btn primary" data-a="retomar-mesa">Continuar</button>
      <button class="btn ghost" data-a="descartar-mesa">Descartar</button></div></div>`;
  }
  const onlineButtons = ONLINE
    ? `<button class="btn primary big" data-a="ir-criar">Criar sala</button>
       <button class="btn big" data-a="ir-entrar">Entrar numa sala</button>
       <button class="btn big" data-a="ir-um">Jogar com um celular só</button>`
    : `<button class="btn primary big" data-a="ir-um">Jogar com um celular só</button>
       <p class="small muted">Aqui dá para jogar com um celular passando de mão em mão.
       Para cada um jogar no próprio celular, inclusive pela internet, use o site do jogo${
         SITE_URL ? `: <a href="${esc(SITE_URL)}" target="_blank" rel="noopener">${esc(SITE_URL.replace(/^https?:\/\//, ''))}</a>` : ' no GitHub Pages'
       }.</p>`;
  return `<main class="screen">
    <header class="brand">
      <span class="mark" aria-hidden="true"><i></i><i></i></span>
      <h1 class="logo">Cúmplices</h1>
      <p class="tagline">Dois de vocês pensam igual. O resto tem que descobrir quem.</p>
    </header>
    ${resume}
    <div class="stack">${onlineButtons}
      <button class="btn ghost" data-a="ir-como">Como jogar</button>
      ${RULES_URL ? `<a class="btn ghost" href="${esc(RULES_URL)}" target="_blank" rel="noopener">Regras completas</a>` : ''}
    </div>
    <p class="foot">Para 5 a 12 pessoas, a partir de 10 anos. Cada partida leva uns 10 minutos.</p>
  </main>`;
}

function viewCriar() {
  return `<main class="screen">
    <button class="back" data-a="voltar">‹ Voltar</button>
    <h2>Criar sala</h2>
    <p class="lead">Você é o anfitrião: o jogo roda no seu celular. Deixe esta tela aberta até o fim.</p>
    <form data-form="criar" novalidate>
      <label for="nome-criar">Seu nome</label>
      <input type="text" id="nome-criar" name="nome" maxlength="16" autocomplete="nickname" data-bind="name" value="${esc(ui.form.name)}" placeholder="Como te chamam">
      <button class="btn primary big" type="submit">Criar sala</button>
    </form>
  </main>`;
}

function viewEntrar() {
  return `<main class="screen">
    <button class="back" data-a="voltar">‹ Voltar</button>
    <h2>Entrar numa sala</h2>
    <p class="lead">Peça o código de 4 letras para quem criou a sala.</p>
    <form data-form="entrar" novalidate>
      <label for="codigo">Código da sala</label>
      <input type="text" id="codigo" name="codigo" class="code-input" maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" data-bind="code" value="${esc(ui.form.code)}" placeholder="ABCD">
      <label for="nome-entrar">Seu nome</label>
      <input type="text" id="nome-entrar" name="nome" maxlength="16" autocomplete="nickname" data-bind="name" value="${esc(ui.form.name)}" placeholder="Como te chamam">
      <button class="btn primary big" type="submit">Entrar</button>
    </form>
  </main>`;
}

// ---------------------------------------------------------------- como jogar (guia de 3 minutos)
function viewComo() {
  const rows = [
    ['5 ou 6', TABLE[5]],
    ['7 ou 8', TABLE[7]],
    ['9 ou 10', TABLE[9]],
    ['11 ou 12', TABLE[11]],
  ];
  return `<main class="screen">
    <button class="back" data-a="voltar-como">‹ Voltar</button>
    <h2>Como jogar</h2>
    <p class="lead">Dá para explicar em três minutos. Leia em voz alta para a mesa.</p>
    <ol class="steps">
      <li><h3>Dois são cúmplices</h3><p>O celular sorteia em segredo. Os cúmplices sabem quem é a dupla deles. Todo o resto é detetive.</p>
        <div class="demo">${stampHTML('Cúmplice', 'pair', false, 'sm')} ${stampHTML('Detetive', 'det', false, 'sm')}</div></li>
      <li><h3>Pergunta boba, resposta em silêncio</h3><p>Aparece uma pergunta com três respostas. Cada um escolhe a sua sem falar nada. Os cúmplices tentam escolher a mesma, sem combinar.</p>
        <div class="demo"><span class="demo-opt">${badge(0)}Coxinha</span><span class="demo-opt">${badge(1)}Empada</span><span class="demo-opt">${badge(2)}Quibe</span></div></li>
      <li><h3>IGUAL ou DIFERENTE</h3><p>Todas as respostas aparecem. O celular conta só uma coisa: se os dois cúmplices responderam igual. Cada IGUAL é 1 ponto para eles.</p>
        <div class="demo">${stampHTML('Igual', 'pair', false, 'sm')} ${stampHTML('Diferente', 'det', false, 'sm')}</div></li>
      <li><h3>Conversem e acusem</h3><p>A partir da segunda pergunta, quem desconfiar propõe uma dupla e a mesa vota. Se mais da metade disser sim, o celular revela. Acertou: os detetives vencem. Errou: os cúmplices ganham 1 ponto.</p></li>
      <li><h3>Quem vence</h3><p>Os cúmplices vencem quando chegam à meta. Os detetives vencem acusando a dupla certa ou se as perguntas acabarem antes.</p></li>
    </ol>
    <table class="meta-table">
      <thead><tr><th scope="col">Pessoas</th><th scope="col">Meta dos cúmplices</th><th scope="col">Perguntas</th></tr></thead>
      <tbody>${rows.map(([n, r]) => `<tr><td>${n}</td><td>${r.meta} IGUAIS</td><td>até ${r.rounds}</td></tr>`).join('')}</tbody>
    </table>
    <section class="card">
      <h3 class="section-title">Dicas</h3>
      <p><b>Cúmplices:</b> respondam o que a sua dupla responderia. A resposta mais óbvia ajuda a pensar igual e a se esconder no meio da turma.</p>
      <p><b>Detetives:</b> olhem o histórico. Nas perguntas com IGUAL, os dois cúmplices escolheram a mesma resposta; nas com DIFERENTE, não. Cuidado com acusação apressada: cada erro é ponto para eles.</p>
      <p><b>Um celular só:</b> ele passa de mão em mão para cada um ver o papel. Depois todos respondem mostrando 1, 2 ou 3 dedos ao mesmo tempo.</p>
    </section>
    ${RULES_URL ? `<a class="btn big" href="${esc(RULES_URL)}" target="_blank" rel="noopener">Regras completas, dúvidas e variantes</a>` : ''}
    <button class="btn primary big" data-a="voltar-como">Entendi</button>
  </main>`;
}

// ---------------------------------------------------------------- sala online
function nameIn(view, id) {
  const g = view.game;
  const p =
    (g && g.players.find((x) => x.id === id)) ||
    view.room.players.find((x) => x.id === id) ||
    view.room.waiting.find((x) => x.id === id);
  return p ? p.name : '?';
}

function viewSala() {
  const o = ui.online;
  if (!o) return viewInicio();
  const v = o.view;
  const ended = ['recusado', 'nao-encontrada', 'removido', 'encerrada'].includes(o.status);
  if (o.kind === 'client' && ended) {
    return `<main class="screen center">
      <h2>${o.status === 'encerrada' ? 'A sala foi fechada' : o.status === 'removido' ? 'Você saiu da sala' : 'Não deu para entrar'}</h2>
      <p class="lead">${esc(o.reason || '')}</p>
      <button class="btn primary big" data-a="sair-sala">Voltar ao início</button>
    </main>`;
  }
  if (o.kind === 'host' && o.hostStatus && o.hostStatus.status === 'erro') {
    return `<main class="screen center">
      <h2>A sala não abriu</h2>
      <p class="lead">${esc(o.hostStatus.message)}</p>
      <button class="btn primary big" data-a="tentar-abrir">Tentar de novo</button>
      <button class="btn big" data-a="fechar-sala-ja">Voltar ao início</button>
    </main>`;
  }
  if (!v) {
    return `<main class="screen center">
      <div class="spinner" aria-hidden="true"></div>
      <h2>${o.kind === 'host' ? 'Abrindo a sala…' : `Procurando a sala ${esc(o.code || '')}…`}</h2>
      <p class="muted">Isso leva alguns segundos.</p>
      <button class="btn ghost" data-a="sair-sala">Cancelar</button>
    </main>`;
  }
  const banner = connectionBanner(o);
  if (!v.game) return viewLobby(v, banner);
  if (!v.me) return viewSpectator(v, banner);
  const g = v.game;
  if (g.phase !== 'fim' && !ui.seenRole[v.room.code + '-' + v.room.gameNo]) return viewRoleIntro(v);
  if (g.phase === 'votar') return viewVoting(v, banner);
  if (g.phase === 'conversa') return viewTalk(v, banner);
  if (g.phase === 'acusacao') return viewAccusation(v, banner);
  return viewEnd(v, banner);
}

function connectionBanner(o) {
  if (o.kind === 'client' && o.status === 'reconectando') {
    return `<p class="banner" role="status">Sem conexão com o anfitrião. Reconectando…</p>`;
  }
  if (o.kind === 'host' && o.hostStatus) {
    const s = o.hostStatus.status;
    if (s === 'abrindo' || s === 'retomando') return `<p class="banner" role="status">Abrindo a sala… Os outros entram em instantes.</p>`;
    if (s === 'reconectando') {
      return `<p class="banner" role="status">A internet oscilou. Quem já está na sala continua jogando; novos jogadores entram quando ela voltar.</p>`;
    }
  }
  return '';
}

function viewLobby(v, banner) {
  const isHost = ui.online.kind === 'host';
  const room = v.room;
  const players = room.players;
  const n = players.filter((p) => p.connected).length;
  const link = shareLink(room.code);
  const peopleList = players
    .map((p) => {
      const me = p.id === v.you;
      const host = p.id === room.hostId;
      return `<li><span class="av ${p.connected ? '' : 'off'}">${esc(initials(p.name))}</span>
        <span class="nm">${esc(p.name)}${me ? ' <span class="muted">(você)</span>' : ''}</span>
        ${host ? '<span class="tag">anfitrião</span>' : ''}
        ${p.connected ? '' : '<span class="tag off">desconectado</span>'}
        ${isHost && !host ? `<button class="icon-btn" data-a="remover" data-id="${esc(p.id)}" aria-label="Tirar ${esc(p.name)} da sala">×</button>` : ''}</li>`;
    })
    .join('');
  const s = room.settings;
  const settings = isHost
    ? `<section class="card">
        <h3 class="section-title">Opções da partida</h3>
        <label class="switch"><span>Pergunta de treino<br><span class="small muted">Uma rodada que não vale ponto, para quem nunca jogou.</span></span>
          <input type="checkbox" id="op-treino" data-set="training" ${s.training ? 'checked' : ''}></label>
        <div class="option-label"><span>Dificuldade para os cúmplices</span>
          <div class="seg" role="group" aria-label="Dificuldade">
            ${[[-1, 'Mais fácil'], [0, 'Normal'], [1, 'Mais difícil']]
              .map(([val, t]) => `<button type="button" class="segb" data-set="ajuste" data-val="${val}" aria-pressed="${s.ajuste === val}">${t}</button>`)
              .join('')}
          </div></div>
        <div class="option-label"><span>Tempo de conversa por pergunta</span>
          <div class="seg" role="group" aria-label="Tempo de conversa">
            ${[[0, 'Livre'], [60, '1 min'], [90, '1,5 min'], [120, '2 min']]
              .map(([val, t]) => `<button type="button" class="segb" data-set="timer" data-val="${val}" aria-pressed="${s.timer === val}">${t}</button>`)
              .join('')}
          </div></div>
        <p class="small muted">${n >= MIN_PLAYERS && n <= MAX_PLAYERS ? esc(metaText(n, s.ajuste)) : `O jogo precisa de ${MIN_PLAYERS} a ${MAX_PLAYERS} pessoas.`}</p>
      </section>`
    : `<p class="small muted">${n >= MIN_PLAYERS && n <= MAX_PLAYERS ? esc(metaText(n, s.ajuste)) : ''}${s.training ? ' Começa com uma pergunta de treino.' : ''}</p>`;
  const startBtn = isHost
    ? `<button class="btn primary big" data-a="comecar" ${n < MIN_PLAYERS ? 'disabled' : ''}>Começar partida</button>
       ${n < MIN_PLAYERS ? `<p class="center small muted">Faltam ${MIN_PLAYERS - n} ${plural(MIN_PLAYERS - n, 'pessoa', 'pessoas')} para começar.</p>` : ''}`
    : `<p class="center lead">Esperando o anfitrião começar…</p>`;
  return `<main class="screen">
    ${banner}
    <section class="code-card">
      <p class="eyebrow">Código da sala</p>
      <p class="code">${esc(room.code)}</p>
      <p class="small muted">Os outros tocam em <b>Entrar numa sala</b> e digitam esse código.</p>
      ${isHost && link ? `<details class="qr-box" open><summary>Entrar pela câmera</summary>
        <div class="qr" role="img" aria-label="QR code com o link da sala ${esc(room.code)}">${qrSvg(link)}</div>
        <p class="small muted">Quem está perto aponta a câmera do celular e entra direto.</p></details>
        <div class="row"><button class="btn small" data-a="copiar-link">Copiar link</button>${navigator.share ? '<button class="btn small" data-a="compartilhar">Compartilhar</button>' : ''}</div>` : ''}
    </section>
    <section class="stack">
      <h3 class="section-title">Na sala (${players.length})</h3>
      <ul class="people">${peopleList}</ul>
    </section>
    ${settings}
    ${scoreboardHTML(room.scoreboard, isHost)}
    ${startBtn}
    <div class="row">
      <button class="btn ghost" data-a="ir-como">Como jogar</button>
      <button class="btn ghost" data-a="${isHost ? 'fechar-sala' : 'sair-sala'}">${isHost ? 'Fechar a sala' : 'Sair da sala'}</button>
    </div>
  </main>`;
}

/** QR code em SVG (quadradinhos pretos em fundo branco, que qualquer câmera lê). */
function qrSvg(text) {
  try {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
    return `<svg viewBox="-2 -2 ${n + 4} ${n + 4}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges" aria-hidden="true"><rect x="-2" y="-2" width="${n + 4}" height="${n + 4}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  } catch (e) {
    return '';
  }
}

function shareLink(code) {
  try {
    if (!ONLINE || !/^https?:$/.test(location.protocol)) return '';
    return location.origin + location.pathname + '?sala=' + code;
  } catch (e) {
    return '';
  }
}

function scoreboardHTML(sb, canReset) {
  const entries = Object.values(sb || {}).filter((x) => x.games > 0);
  if (entries.length === 0) return '';
  entries.sort((a, b) => b.pts - a.pts || a.name.localeCompare(b.name, 'pt-BR'));
  return `<section class="card">
    <h3 class="section-title">Placar da noite</h3>
    <p class="small muted">Detetive que vence ganha 1 ponto; cúmplice que vence ganha 2.</p>
    <ul class="score">${entries.map((e) => `<li><span>${esc(e.name)}</span><span class="pts">${e.pts}</span></li>`).join('')}</ul>
    ${canReset ? '<button class="btn ghost small" data-a="zerar-placar">Zerar placar</button>' : ''}
  </section>`;
}

function roleCardHTML(me, partnerName, settings) {
  if (!me) return '';
  if (me.role === 'cumplice') {
    return `<div class="role-card cumplice">
      <p class="doc-head">Credencial secreta</p>
      ${stampHTML('Cúmplice', 'pair', false)}
      <p>Sua dupla é <span class="partner">${esc(partnerName)}</span></p>
      <p>Respondam igual sem combinar nada. Cada IGUAL vale 1 ponto. A meta é ${settings.meta} em até ${settings.rounds} perguntas.</p>
    </div>`;
  }
  return `<div class="role-card detetive">
    <p class="doc-head">Credencial secreta</p>
    ${stampHTML('Detetive', 'det', false)}
    <p>Descubra quem são os dois cúmplices.</p>
    <p>Vocês vencem acusando a dupla certa ou se as ${settings.rounds} perguntas acabarem antes de eles chegarem a ${settings.meta} pontos.</p>
  </div>`;
}

function viewRoleIntro(v) {
  const g = v.game;
  const partner = v.me.partner ? nameIn(v, v.me.partner) : '';
  return `<main class="screen">
    <p class="eyebrow">Partida ${v.room.gameNo} na sala ${esc(v.room.code)}</p>
    <h2>Seu papel é secreto</h2>
    <p class="lead">Não deixe ninguém ver sua tela. Segure o botão para ver e solte para esconder.</p>
    <button class="hold" data-hold="papel">Segure aqui para ver seu papel</button>
    <div data-hold-show="papel" hidden>${roleCardHTML(v.me, partner, g.settings)}</div>
    <button class="btn primary big" data-a="vi-papel">Já vi. Vamos jogar</button>
  </main>`;
}

function gamebarHTML(g, peekKind) {
  const label = g.round === 0 ? 'Pergunta de treino' : `Pergunta ${g.round} de ${g.settings.rounds}`;
  const peek =
    peekKind === 'online'
      ? `<button class="peek" data-hold="papel" aria-label="Segure para ver seu papel">Meu papel</button>`
      : peekKind === 'local'
        ? `<button class="peek" data-a="rever-papel">Rever papel</button>`
        : '<span></span>';
  return `<header class="gamebar">
    <span class="eyebrow">${label}</span>
    <span class="gb-meta">Cúmplices ${dotsHTML(g.pontos, g.settings.meta)}</span>
    ${peek}
  </header>`;
}

function peekLayerHTML(v) {
  if (!v.me) return '';
  const partner = v.me.partner ? nameIn(v, v.me.partner) : '';
  return `<div class="peek-layer" data-hold-show="papel" hidden>${roleCardHTML(v.me, partner, v.game.settings)}</div>`;
}

function questionHTML(q, small) {
  return `<h2 class="question${small ? ' sm' : ''}">${esc(q.q)}</h2>`;
}

function hostToolsHTML(buttons) {
  if (!ui.online || ui.online.kind !== 'host') return '';
  return `<section class="card"><h3 class="section-title">Anfitrião</h3>${buttons}
    <button class="btn small ghost" data-a="encerrar-partida">Encerrar partida</button></section>`;
}

function viewVoting(v, banner) {
  const g = v.game;
  const my = v.me.myVote;
  const voted = new Set(g.votedIds);
  const options = g.question.a
    .map(
      (text, i) => `<button class="option opt-${i}" data-a="votar" data-opt="${i}" aria-pressed="${my === i}">
        ${badge(i)}<span>${esc(text)}</span></button>`,
    )
    .join('');
  const faces = g.players
    .map((p) => {
      const conn = (v.room.players.find((x) => x.id === p.id) || { connected: false }).connected;
      return `<span class="who"><span class="av ${conn ? '' : 'off'}">${esc(initials(p.name))}${voted.has(p.id) ? '<span class="ck" aria-hidden="true">✓</span>' : ''}</span><span>${esc(p.name)}</span></span>`;
    })
    .join('');
  const missing = g.players.filter((p) => !voted.has(p.id)).map((p) => p.name);
  return `<main class="screen">
    ${gamebarHTML(g, 'online')}
    ${banner}
    <p class="hush">Silêncio até o último voto</p>
    ${questionHTML(g.question)}
    <div class="options" role="group" aria-label="Respostas">${options}</div>
    <p class="small muted">${my === null ? 'Toque na sua resposta.' : 'Você votou. Dá para trocar até todo mundo votar.'}</p>
    <section class="stack">
      <h3 class="section-title">Votaram ${voted.size} de ${g.players.length}</h3>
      <div class="faces">${faces}</div>
    </section>
    ${hostToolsHTML(`<p class="small muted">Pergunta confusa? Troque antes da revelação (os votos dados são apagados).</p>
      <button class="btn small" data-a="trocar-pergunta">Trocar pergunta</button>
      <p class="small muted">Alguém saiu e travou a votação? Faltam: ${esc(listNames(missing))}.</p>
      <button class="btn small" data-a="encerrar-votacao">Encerrar votação agora</button>`)}
    ${historyHTML(g, v.game.players, false)}
    ${peekLayerHTML(v)}
  </main>`;
}

function revealBlockHTML(g, h, animate) {
  const igual = h.igual;
  const groups = [0, 1, 2]
    .map((i) => {
      const names = g.players.filter((p) => h.votes[p.id] === i).map((p) => p.name);
      return `<div class="group opt-${i}${names.length ? '' : ' empty'}">${badge(i)}<span class="gt">${esc(h.q.a[i])}</span><span class="count">${names.length}</span>
        <span class="gn">${names.length ? esc(names.join(', ')) : 'ninguém'}</span></div>`;
    })
    .join('');
  const noVote = g.players.filter((p) => h.votes[p.id] === undefined).map((p) => p.name);
  const line = h.training
    ? igual
      ? 'Os cúmplices votaram igual. Como é treino, não vale ponto.'
      : 'Os cúmplices votaram diferente. Como é treino, não vale ponto.'
    : igual
      ? 'Os cúmplices votaram igual. Ponto para eles.'
      : 'Os cúmplices votaram diferente. Sem ponto.';
  return `<div class="verdict">${stampHTML(igual ? 'Igual' : 'Diferente', igual ? 'pair' : 'det', animate)}<p class="lead">${line}</p></div>
    ${questionHTML(h.q, true)}
    <div class="groups">${groups}</div>
    ${noVote.length ? `<p class="small muted">Sem voto: ${esc(listNames(noVote))}.</p>` : ''}`;
}

function viewTalk(v, banner) {
  const g = v.game;
  const h = g.history[g.history.length - 1];
  const key = `${v.room.code}-${v.room.gameNo}-${g.round}-reveal`;
  const animate = ui.animKey !== key;
  ui.animKey = key;
  const ready = new Set(g.ready);
  const iReady = ready.has(v.you);
  const proposed = new Set(g.proposed).has(v.you);
  const training = g.round === 0;
  const accuseBtn = training
    ? '<p class="small muted">Na pergunta de treino ninguém acusa.</p>'
    : g.round < FIRST_ACCUSATION_ROUND
      ? '<p class="small muted">Na primeira pergunta ninguém acusa. Só observem quem votou junto.</p>'
      : proposed
      ? '<p class="small muted">Você já propôs uma acusação nesta pergunta.</p>'
      : '<button class="btn big" data-a="abrir-acusacao">Acusar uma dupla</button>';
  const timer = v.timer
    ? `<p class="small muted">${v.timer.paused ? 'Tempo pausado' : 'Tempo de conversa:'} <span class="timer" data-timer>${fmtTime(v.timer.left)}</span></p>`
    : '';
  return `<main class="screen">
    ${gamebarHTML(g, 'online')}
    ${banner}
    ${revealBlockHTML(g, h, animate)}
    <section class="card">
      <p class="lead"><b>Conversem!</b> Quem votou junto? Alguém está estranho?</p>
      ${timer}
      ${accuseBtn}
      <button class="btn big ${iReady ? 'done' : 'primary'}" data-a="pronto">${iReady ? 'Pronto. Esperando os outros' : 'Pronto para a próxima'}</button>
      <p class="small muted center">${ready.size} de ${g.players.length} ${plural(ready.size, 'pronto', 'prontos')}</p>
    </section>
    ${hostToolsHTML('<button class="btn small" data-a="proxima">Passar para a próxima pergunta</button>')}
    ${historyHTML(g, g.players, false)}
    ${ui.picking ? pickerHTML(g, v.you, false) : ''}
    ${peekLayerHTML(v)}
  </main>`;
}

function clearedPairs(g) {
  return g.accusations.filter((a) => a.approved && !a.correct).map((a) => a.pair);
}

function pickerHTML(g, selfId, local) {
  const cleared = clearedPairs(g);
  const candidates = g.players.filter((p) => p.id !== selfId);
  const [a, b] = ui.pick;
  const isCleared = a && b && cleared.some((p) => (p[0] === a && p[1] === b) || (p[0] === b && p[1] === a));
  const nm = (id) => (g.players.find((p) => p.id === id) || {}).name || '';
  const half = Math.floor(g.players.length / 2) + 1;
  return `<div class="backdrop" data-a="fechar-acusacao-fundo"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="t-acusar" data-stop>
    <h3 id="t-acusar">${local ? 'Qual dupla a mesa acusou?' : 'Quem são os cúmplices?'}</h3>
    <p class="small muted">${
      local
        ? `Só marque se a acusação foi aprovada: alguém propôs a dupla e pelo menos ${half} pessoas levantaram a mão.`
        : `Escolha duas pessoas. A mesa vota e precisa de pelo menos ${half} “sim”. Errou: os cúmplices ganham 1 ponto.`
    }</p>
    <div class="pick-grid">${candidates
      .map((p) => `<button class="pick" data-a="escolher" data-id="${esc(p.id)}" aria-pressed="${ui.pick.includes(p.id)}">${esc(p.name)}</button>`)
      .join('')}</div>
    ${isCleared ? '<p class="warn">Essa dupla já foi acusada e era inocente.</p>' : ''}
    <div class="row">
      <button class="btn" data-a="fechar-acusacao">Cancelar</button>
      <button class="btn primary" data-a="${local ? 'acusar-local' : 'enviar-acusacao'}" ${a && b && !isCleared ? '' : 'disabled'}>${
        a && b ? `${local ? 'Revelar' : 'Acusar'}: ${esc(nm(a))} e ${esc(nm(b))}` : 'Escolha duas pessoas'
      }</button>
    </div>
  </div></div>`;
}

function viewAccusation(v, banner) {
  const g = v.game;
  const acc = g.accusation;
  const nm = (id) => nameIn(v, id);
  const mine = v.me.myAccuseVote;
  const half = Math.floor(g.players.length / 2) + 1;
  const votedSet = new Set(acc.votedIds);
  const missing = g.players.filter((p) => !votedSet.has(p.id)).map((p) => p.name);
  return `<main class="screen">
    ${gamebarHTML(g, 'online')}
    ${banner}
    <section class="dossier">
      <p class="eyebrow">Acusação</p>
      <p><b>${esc(nm(acc.by))}</b> acusa:</p>
      <p class="accused">${esc(nm(acc.pair[0]))} e ${esc(nm(acc.pair[1]))}</p>
      <p class="small muted">Se pelo menos ${half} de ${g.players.length} disserem sim, o celular revela a verdade. Acertou: detetives vencem. Errou: +1 ponto para os cúmplices.</p>
    </section>
    <div class="row">
      <button class="btn big yes ${mine === true ? 'on' : ''}" data-a="acusar-sim" aria-pressed="${mine === true}">Sim, acusar</button>
      <button class="btn big no ${mine === false ? 'on' : ''}" data-a="acusar-nao" aria-pressed="${mine === false}">Não</button>
    </div>
    <p class="small muted center">${mine === null ? 'Vote sim ou não.' : 'Dá para trocar até todos votarem.'} Votaram ${votedSet.size} de ${g.players.length}.</p>
    ${hostToolsHTML(`<p class="small muted">Faltam: ${esc(listNames(missing))}. Quem não votar conta como “não”.</p>
      <button class="btn small" data-a="encerrar-acusacao">Encerrar votação da acusação</button>`)}
    ${historyHTML(g, g.players, false)}
    ${peekLayerHTML(v)}
  </main>`;
}

const REASONS = {
  meta: (g) => `Os cúmplices votaram igual e chegaram a ${g.settings.meta} pontos.`,
  'acusacao-errada': () => 'Uma acusação errada deu o último ponto para os cúmplices.',
  acusacao: () => 'A mesa acusou a dupla certa.',
  rodadas: () => 'As perguntas acabaram antes de os cúmplices chegarem à meta.',
  abandono: () => 'A partida foi encerrada antes do fim.',
};

function endBlockHTML(g, players, youId) {
  const r = g.result;
  const winC = r.winner === 'cumplices';
  const title = r.winner ? (winC ? 'Cúmplices venceram' : 'Detetives venceram') : 'Partida encerrada';
  const pair = r.cumplices.map((id) => (players.find((p) => p.id === id) || {}).name || '?');
  let mine = '';
  if (youId && r.winner) {
    const isC = r.cumplices.includes(youId);
    const won = winC === isC;
    mine = `<p class="lead center"><b>${won ? 'Você venceu!' : 'Não foi dessa vez.'}</b> ${isC ? 'Você era cúmplice.' : 'Você era detetive.'}</p>`;
  }
  return `<div class="verdict">${stampHTML(title, r.winner ? (winC ? 'pair' : 'det') : 'neutral', true, 'long')}
      <p class="lead">${REASONS[r.reason] ? REASONS[r.reason](g) : ''}</p></div>
    <div class="pair-reveal"><span class="eyebrow">Os cúmplices eram</span><b>${esc(pair[0])} e ${esc(pair[1])}</b></div>
    ${mine}`;
}

function viewEnd(v, banner) {
  const g = v.game;
  const isHost = ui.online.kind === 'host';
  const key = `${v.room.code}-${v.room.gameNo}-fim`;
  ui.animKey = key;
  return `<main class="screen">
    ${banner}
    ${endBlockHTML(g, g.players, v.you)}
    ${historyHTML(g, g.players, true)}
    ${scoreboardHTML(v.room.scoreboard, false)}
    ${
      isHost
        ? `<button class="btn primary big" data-a="jogar-de-novo">Jogar de novo</button>
           <button class="btn big" data-a="voltar-sala">Mudar opções ou pessoas</button>`
        : `<p class="center lead">Esperando o anfitrião começar outra…</p>
           <button class="btn ghost" data-a="sair-sala">Sair da sala</button>`
    }
  </main>`;
}

function viewSpectator(v, banner) {
  const g = v.game;
  let body = '';
  if (g.phase === 'fim') body = endBlockHTML(g, g.players, null) + historyHTML(g, g.players, true);
  else if (g.phase === 'votar') body = `<p class="hush">Votação em andamento</p>${questionHTML(g.question)}${historyHTML(g, g.players, false)}`;
  else {
    const h = g.history[g.history.length - 1];
    body = (h ? revealBlockHTML(g, h, false) : '') + historyHTML(g, g.players, false);
  }
  return `<main class="screen">
    ${g.phase !== 'fim' ? gamebarHTML(g, null) : ''}
    ${banner}
    <p class="banner">Você chegou no meio da partida e está assistindo. Você entra na próxima.</p>
    ${body}
    <button class="btn ghost" data-a="sair-sala">Sair da sala</button>
  </main>`;
}

function historyHTML(g, players, revealC) {
  const hs = g.history;
  if (hs.length === 0) return '';
  const cSet = new Set(revealC && g.result ? g.result.cumplices : []);
  const head = hs
    .map(
      (h) => `<th scope="col" class="${h.igual ? 'igual' : 'dif'}"><span>${h.training ? 'T' : h.round}</span><span class="sym" aria-label="${
        h.igual ? 'igual' : 'diferente'
      }">${h.igual ? '=' : '≠'}</span></th>`,
    )
    .join('');
  const body = players
    .map((p) => {
      const cells = hs
        .map((h) => {
          const o = h.votes[p.id];
          return `<td>${o === undefined ? '<span class="cell none">–</span>' : `<span class="cell opt-${o}">${LETTERS[o]}</span>`}</td>`;
        })
        .join('');
      return `<tr class="${cSet.has(p.id) ? 'is-c' : ''}"><th scope="row">${esc(p.name)}</th>${cells}</tr>`;
    })
    .join('');
  const nm = (id) => (players.find((p) => p.id === id) || {}).name || '?';
  const accs = g.accusations
    .map((a) => {
      const res = !a.approved
        ? `Recusada (${a.yes} ${plural(a.yes, 'sim', 'sim')}).`
        : a.correct
          ? 'Acertou!'
          : 'Aprovada, mas eram inocentes.';
      return `<li><b>Pergunta ${a.round}:</b> ${a.by ? `${esc(nm(a.by))} acusou ` : 'A mesa acusou '}${esc(nm(a.pair[0]))} e ${esc(nm(a.pair[1]))}. ${res}</li>`;
    })
    .join('');
  return `<section class="stack">
    <h3 class="section-title">Histórico</h3>
    <div class="hscroll"><table class="hist">
      <thead><tr><th scope="col" class="sr">Jogador</th>${head}</tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    <p class="small muted">= os cúmplices votaram igual; ≠ votaram diferente.${cSet.size ? ' Em destaque, os cúmplices.' : ''}</p>
    ${accs ? `<ul class="acc-log">${accs}</ul>` : ''}
  </section>`;
}

function fmtTime(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function updateTimers() {
  const els = document.querySelectorAll('[data-timer]');
  if (!els.length || !ui.timerEnds) return;
  const left = ui.timerEnds - Date.now();
  els.forEach((el) => {
    el.textContent = fmtTime(left);
  });
}
setInterval(updateTimers, 500);

// ---------------------------------------------------------------- avisos (resultado de acusação) e confirmações
function viewOverlay() {
  const o = ui.overlay;
  if (!o) return '';
  const a = o.entry;
  const nm = (id) => (o.players.find((p) => p.id === id) || {}).name || '?';
  const yesNames = Object.entries(a.votes || {})
    .filter(([, v]) => v === true)
    .map(([id]) => nm(id));
  const noNames = Object.entries(a.votes || {})
    .filter(([, v]) => v === false)
    .map(([id]) => nm(id));
  let stamp;
  let text;
  if (!a.approved) {
    stamp = stampHTML('Recusada', 'neutral', true);
    text = `A acusação contra ${esc(nm(a.pair[0]))} e ${esc(nm(a.pair[1]))} não teve votos suficientes (${a.yes} sim). A conversa continua.`;
  } else {
    stamp = stampHTML('Inocentes', 'det', true);
    text = `${esc(nm(a.pair[0]))} e ${esc(nm(a.pair[1]))} não são a dupla. Os cúmplices ganham 1 ponto.`;
  }
  const votes = a.votes
    ? `<p class="small muted">Sim: ${esc(listNames(yesNames)) || 'ninguém'}. Não: ${esc(listNames(noNames)) || 'ninguém'}.</p>`
    : '';
  return `<div class="backdrop"><div class="sheet center" role="dialog" aria-modal="true" aria-label="Resultado da acusação">
    <div class="verdict">${stamp}</div><p class="lead">${text}</p>${votes}
    <button class="btn primary big" data-a="fechar-aviso">Continuar</button></div></div>`;
}

function viewConfirm() {
  const c = ui.confirm;
  if (!c) return '';
  return `<div class="backdrop"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="t-conf">
    <h3 id="t-conf">${esc(c.title)}</h3>${c.text ? `<p>${esc(c.text)}</p>` : ''}
    <div class="row"><button class="btn" data-a="confirm-nao">Cancelar</button>
    <button class="btn ${c.danger ? 'danger' : 'primary'}" data-a="confirm-sim">${esc(c.ok)}</button></div></div></div>`;
}

function askConfirm(title, text, ok, onOk, danger = true) {
  ui.confirm = { title, text, ok, onOk, danger };
  render();
}

/** Mostra o resultado de acusações novas (uma vez por acusação). */
function checkAccusations(key, g, players) {
  if (!g) return;
  const n = g.accusations.length;
  if (!(key in ui.seenAcc)) {
    // Primeira vez que este celular vê esta partida (entrou agora ou recarregou): nada de aviso antigo.
    ui.seenAcc[key] = n;
    return;
  }
  const seen = ui.seenAcc[key];
  if (n > seen) {
    ui.seenAcc[key] = n;
    const last = g.accusations[n - 1];
    if (!(last.approved && last.correct)) ui.overlay = { entry: last, players };
  }
}

// ---------------------------------------------------------------- online: criar, entrar, retomar
function onHostChange(view) {
  if (!ui.online || ui.online.kind !== 'host') return;
  ui.online.view = view;
  afterView(view);
  render();
}

function afterView(view) {
  if (view.timer) {
    ui.timerEnds = view.timer.paused ? null : Date.now() + view.timer.left;
  } else ui.timerEnds = null;
  if (view.game) checkAccusations(view.room.code + '-' + view.room.gameNo, view.game, view.game.players);
  if (!view.game || view.game.phase !== 'conversa') {
    ui.picking = false;
    ui.pick = [];
  }
}

function makeTransport() {
  // Dois caminhos ao mesmo tempo: conexão direta entre celulares (PeerJS) e, como plano B,
  // servidores públicos de mensagens (MQTT). Cada celular fica com o que abrir primeiro.
  // Para testes: ?servidor=127.0.0.1:9000 (PeerJS local), ?mqtt=ws://127.0.0.1:8883/mqtt (broker local),
  // ?rede=direta ou ?rede=mensagens (usa um caminho só).
  const opts = typeof __PEER_SERVER__ !== 'undefined' && __PEER_SERVER__ ? __PEER_SERVER__ : {};
  let brokers = PUBLIC_BROKERS;
  let rede = '';
  try {
    const q = new URLSearchParams(location.search);
    const srv = q.get('servidor');
    if (srv) {
      const [host, port] = srv.split(':');
      Object.assign(opts, { host, port: Number(port || 9000), path: '/', secure: false });
    }
    if (q.get('mqtt')) brokers = q.get('mqtt').split(',').filter(Boolean);
    rede = q.get('rede') || '';
  } catch (e) {
    /* ignore */
  }
  const direct = peerTransport(opts);
  const messages = mqttTransport({ brokers });
  if (rede === 'direta') return direct;
  if (rede === 'mensagens') return messages;
  return dualTransport([direct, messages]);
}

function startHost(name) {
  const transport = makeTransport();
  if (!transport.available()) {
    toast('O modo online não carregou. Confira a internet e recarregue a página.');
    return;
  }
  const room = new HostRoom({
    transport,
    store,
    hostName: name,
    hostId: deviceId(),
    onChange: onHostChange,
    onStatus: (s) => {
      if (ui.online && ui.online.kind === 'host') {
        ui.online.hostStatus = s;
        render();
      }
    },
  });
  ui.online = { kind: 'host', room, view: null, hostStatus: { status: 'abrindo' } };
  room.open();
  keepAwake();
  go('sala');
}

function resumeHost() {
  const saved = HostRoom.loadSaved(store);
  if (!saved) return go('inicio');
  const transport = makeTransport();
  if (!transport.available()) {
    toast('O modo online não carregou. Confira a internet e recarregue a página.');
    return;
  }
  const room = new HostRoom({
    transport,
    store,
    restore: saved,
    onChange: onHostChange,
    onStatus: (s) => {
      if (ui.online && ui.online.kind === 'host') {
        ui.online.hostStatus = s;
        render();
      }
    },
  });
  ui.online = { kind: 'host', room, view: null, hostStatus: { status: 'retomando' } };
  ui.online.view = room.viewFor(room.hostId);
  room.open();
  keepAwake();
  go('sala');
}

function startClient(code, name) {
  const transport = makeTransport();
  if (!transport.available()) {
    toast('O modo online não carregou. Confira a internet e recarregue a página.');
    return;
  }
  const room = new ClientRoom({
    transport,
    code,
    clientId: deviceId(),
    name,
    onChange: (e) => {
      if (!ui.online || ui.online.room !== room) return;
      ui.online.status = e.status;
      ui.online.reason = e.reason;
      if (e.view) {
        ui.online.view = e.view;
        afterView(e.view);
      }
      if (['recusado', 'nao-encontrada', 'removido', 'encerrada'].includes(e.status)) store.del('cliente');
      if (e.toast) toast(e.toast);
      render();
    },
  });
  ui.online = { kind: 'client', room, code, view: null, status: 'conectando' };
  store.set('cliente', { code, name, at: Date.now() });
  room.start();
  keepAwake();
  go('sala');
}

function sendAction(a) {
  const o = ui.online;
  if (!o) return;
  if (o.kind === 'host') {
    const r = o.room.hostAct(a);
    if (r && !r.ok && r.message) toast(r.message);
  } else o.room.send(a);
}

function leaveOnline() {
  const o = ui.online;
  if (o && o.kind === 'client') {
    o.room.leave();
    store.del('cliente');
  }
  ui.online = null;
  go('inicio');
}

// ---------------------------------------------------------------- um celular só
function localSlug(name, taken) {
  let base =
    'j-' +
    cleanName(name)
      .toLocaleLowerCase('pt-BR')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-');
  let id = base;
  let k = 2;
  while (taken.has(id)) id = base + '-' + k++;
  taken.add(id);
  return id;
}

function loadLocal() {
  const saved = store.get('mesa', null);
  const base = {
    stage: 'config',
    names: ['', '', '', '', ''],
    settings: { training: false, ajuste: 0 },
    game: null,
    gameNo: 0,
    passIdx: 0,
    passShow: false,
    entry: {},
    scoreboard: {},
    peek: null,
  };
  if (saved && typeof saved === 'object') return { ...base, ...saved, peek: null };
  return base;
}

function initLocalSeen() {
  const L = ui.local;
  if (L && L.game) ui.seenAcc['local-' + L.gameNo] = L.game.accusations.length;
}

function saveLocal() {
  const L = ui.local;
  if (!L) return;
  store.set('mesa', {
    stage: L.stage,
    names: L.names,
    settings: L.settings,
    game: L.game,
    gameNo: L.gameNo,
    passIdx: L.passIdx,
    passShow: false,
    entry: L.entry,
    scoreboard: L.scoreboard,
  });
}

function viewUmConfig() {
  const L = ui.local;
  const names = L.names;
  const filled = names.map(cleanName).filter(Boolean);
  const n = filled.length;
  const s = L.settings;
  return `<main class="screen">
    <button class="back" data-a="voltar">‹ Voltar</button>
    <h2>Um celular só</h2>
    <p class="lead">O celular passa de mão em mão para cada um ver o papel. Depois fica no meio da mesa e todos votam mostrando 1, 2 ou 3 dedos.</p>
    <form data-form="um" novalidate>
      <fieldset>
        <legend>Quem vai jogar (${MIN_PLAYERS} a ${MAX_PLAYERS})</legend>
        ${names
          .map(
            (nm, i) => `<div class="name-row">
              <input type="text" id="nome-${i}" data-local-name="${i}" maxlength="16" value="${esc(nm)}" placeholder="Jogador ${i + 1}" autocomplete="off" aria-label="Nome do jogador ${i + 1}">
              <button type="button" class="icon-btn" data-a="tirar-nome" data-i="${i}" aria-label="Tirar jogador ${i + 1}" ${names.length <= MIN_PLAYERS ? 'disabled' : ''}>×</button>
            </div>`,
          )
          .join('')}
        ${names.length < MAX_PLAYERS ? '<button type="button" class="btn small" data-a="mais-nome">+ Adicionar jogador</button>' : ''}
      </fieldset>
      <section class="card">
        <label class="switch"><span>Pergunta de treino<br><span class="small muted">Uma rodada que não vale ponto.</span></span>
          <input type="checkbox" id="um-treino" data-local-set="training" ${s.training ? 'checked' : ''}></label>
        <div class="option-label"><span>Dificuldade para os cúmplices</span>
          <div class="seg" role="group" aria-label="Dificuldade">
            ${[[-1, 'Mais fácil'], [0, 'Normal'], [1, 'Mais difícil']]
              .map(([val, t]) => `<button type="button" class="segb" data-a="um-ajuste" data-val="${val}" aria-pressed="${s.ajuste === val}">${t}</button>`)
              .join('')}
          </div></div>
        <p class="small muted" id="um-meta">${n >= MIN_PLAYERS && n <= MAX_PLAYERS ? esc(metaText(n, s.ajuste)) : `Escreva de ${MIN_PLAYERS} a ${MAX_PLAYERS} nomes.`}</p>
      </section>
      <button class="btn primary big" type="submit">Sortear papéis</button>
    </form>
    ${scoreboardHTML(L.scoreboard, true)}
  </main>`;
}

function startLocalGame() {
  const L = ui.local;
  const names = L.names.map(cleanName).filter(Boolean);
  if (names.length < MIN_PLAYERS) return toast(`Escreva pelo menos ${MIN_PLAYERS} nomes.`);
  if (names.length > MAX_PLAYERS) return toast(`O máximo é ${MAX_PLAYERS} pessoas.`);
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      if (sameName(names[i], names[j])) return toast(`O nome "${names[j]}" aparece duas vezes. Use nomes diferentes.`);
    }
  }
  const taken = new Set();
  const players = names.map((nm) => ({ id: localSlug(nm, taken), name: nm }));
  const st = settingsFor(players.length, L.settings.ajuste);
  const need = st.rounds + (L.settings.training ? 1 : 0);
  const usedList = store.get('perguntas-usadas', []);
  const used = new Set(Array.isArray(usedList) ? usedList : []);
  const qs = pickQuestions(need, secureRandom, used);
  let nextUsed = [...used, ...qs.map(questionKey)];
  if (nextUsed.length > QUESTIONS.length - need) nextUsed = qs.map(questionKey);
  store.set('perguntas-usadas', nextUsed);
  L.game = newGame({ players, questions: qs, rng: secureRandom, settings: st, training: !!L.settings.training });
  L.gameNo += 1;
  L.stage = 'passar';
  L.passIdx = 0;
  L.passShow = false;
  L.entry = {};
  ui.seenAcc['local-' + L.gameNo] = 0;
  saveLocal();
  keepAwake();
  go('um');
}

function localApply(action) {
  const L = ui.local;
  const prev = L.game;
  const r = act(prev, action);
  if (!r.ok) {
    toast(r.message);
    return false;
  }
  L.game = r.state;
  if (L.game.result && !prev.result && L.game.result.winner) L.scoreboard = scoreGame(L.scoreboard, L.game);
  checkAccusations('local-' + L.gameNo, L.game, L.game.players);
  saveLocal();
  return true;
}

function localRoleCard(g, id) {
  const me = privateView(g, id);
  const partner = me.partner ? (g.players.find((p) => p.id === me.partner) || {}).name : '';
  return roleCardHTML(me, partner, g.settings);
}

function viewUm() {
  const L = ui.local;
  const g = L.game;
  if (!g) return viewUmConfig();
  if (L.stage === 'passar') {
    const p = g.players[L.passIdx];
    const next = g.players[L.passIdx + 1];
    if (!L.passShow) {
      return `<main class="screen center">
        <p class="eyebrow">Papel secreto ${L.passIdx + 1} de ${g.players.length}</p>
        <h2>Passe o celular para</h2>
        <p class="question">${esc(p.name)}</p>
        <button class="btn primary big" data-a="sou-eu">Sou ${esc(p.name)}</button>
        ${L.passIdx > 0 ? '<button class="btn ghost" data-a="passe-voltar">Voltar para a pessoa anterior</button>' : ''}
      </main>`;
    }
    return `<main class="screen center">
      <p class="eyebrow">${esc(p.name)}, só você olha</p>
      <button class="hold" data-hold="papel">Segure aqui para ver seu papel</button>
      <div data-hold-show="papel" hidden>${localRoleCard(g, p.id)}</div>
      <button class="btn primary big" data-a="passar">${next ? `Escondi. Passar para ${esc(next.name)}` : 'Escondi. Começar o jogo'}</button>
    </main>`;
  }
  if (L.peek) return viewLocalPeek(g);
  if (g.phase === 'votar') return viewLocalVoting(g);
  if (g.phase === 'conversa') return viewLocalTalk(g);
  return viewLocalEnd(g);
}

function viewLocalPeek(g) {
  const L = ui.local;
  const pk = L.peek;
  if (pk.id === null) {
    return `<main class="screen">
      <h2>Quem quer rever o papel?</h2>
      <div class="pick-grid">${g.players.map((p) => `<button class="pick" data-a="peek-quem" data-id="${esc(p.id)}">${esc(p.name)}</button>`).join('')}</div>
      <button class="btn big" data-a="peek-fechar">Cancelar</button>
    </main>`;
  }
  const p = g.players.find((x) => x.id === pk.id);
  if (!pk.show) {
    return `<main class="screen center">
      <h2>Passe o celular para</h2><p class="question">${esc(p.name)}</p>
      <button class="btn primary big" data-a="peek-sou">Sou ${esc(p.name)}</button>
      <button class="btn ghost" data-a="peek-fechar">Cancelar</button>
    </main>`;
  }
  return `<main class="screen center">
    <p class="eyebrow">${esc(p.name)}, só você olha</p>
    <button class="hold" data-hold="papel">Segure aqui para ver seu papel</button>
    <div data-hold-show="papel" hidden>${localRoleCard(g, p.id)}</div>
    <button class="btn primary big" data-a="peek-fechar">Escondi. Voltar para o jogo</button>
  </main>`;
}

function viewLocalVoting(g) {
  const L = ui.local;
  const all = g.players.every((p) => L.entry[p.id] !== undefined);
  const rows = g.players
    .map(
      (p) => `<div class="entry-row"><span class="nm">${esc(p.name)}</span><div class="vbtns">${[0, 1, 2]
        .map(
          (i) => `<button class="vb opt-${i}" data-a="marcar" data-id="${esc(p.id)}" data-opt="${i}" aria-pressed="${L.entry[p.id] === i}" aria-label="${esc(p.name)}: ${LETTERS[i]}">${LETTERS[i]}${fingers(i)}</button>`,
        )
        .join('')}</div></div>`,
    )
    .join('');
  return `<main class="screen">
    ${gamebarHTML(g, 'local')}
    ${questionHTML(currentQuestion(g))}
    <div class="options">${currentQuestion(g).a
      .map((t, i) => `<div class="option static opt-${i}">${badge(i)}<span>${esc(t)}</span></div>`)
      .join('')}</div>
    <p class="banner">Pensem em silêncio. Contem “1, 2, 3” e todos mostram 1, 2 ou 3 dedos ao mesmo tempo.</p>
    <section class="entry">
      <h3 class="section-title">Marque o que cada um mostrou</h3>
      ${rows}
    </section>
    <button class="btn primary big" data-a="revelar" ${all ? '' : 'disabled'}>${all ? 'Revelar' : `Faltam ${g.players.filter((p) => L.entry[p.id] === undefined).length}`}</button>
    <button class="btn ghost" data-a="trocar-pergunta-local">Trocar pergunta</button>
    ${historyHTML(g, g.players, false)}
    <button class="btn ghost" data-a="encerrar-local">Encerrar partida</button>
  </main>`;
}

function viewLocalTalk(g) {
  const L = ui.local;
  const h = g.history[g.history.length - 1];
  const key = `local-${L.gameNo}-${g.round}-reveal`;
  const animate = ui.animKey !== key;
  ui.animKey = key;
  const training = g.round === 0;
  const half = Math.floor(g.players.length / 2) + 1;
  return `<main class="screen">
    ${gamebarHTML(g, 'local')}
    ${revealBlockHTML(g, h, animate)}
    <section class="card">
      <p class="lead"><b>Conversem!</b> Quem votou junto? Alguém está estranho?</p>
      ${
        training
          ? '<p class="small muted">Na pergunta de treino ninguém acusa.</p>'
          : g.round < FIRST_ACCUSATION_ROUND
            ? '<p class="small muted">Na primeira pergunta ninguém acusa. Só observem quem votou junto.</p>'
            : `<p class="small muted">Para acusar: alguém diz a dupla e a mesa vota com a mão. Com ${half} ou mais mãos levantadas, a acusação vale.</p>
             <button class="btn big" data-a="abrir-acusacao">A mesa aprovou uma acusação</button>`
      }
      <button class="btn primary big" data-a="proxima-local">Próxima pergunta</button>
    </section>
    ${historyHTML(g, g.players, false)}
    ${ui.picking ? pickerHTML(g, null, true) : ''}
  </main>`;
}

function viewLocalEnd(game) {
  const L = ui.local;
  const g = publicView(game);
  ui.animKey = `local-${L.gameNo}-fim`;
  return `<main class="screen">
    ${endBlockHTML(g, g.players, null)}
    ${historyHTML(g, g.players, true)}
    ${scoreboardHTML(L.scoreboard, false)}
    <button class="btn primary big" data-a="local-de-novo">Jogar de novo</button>
    <button class="btn big" data-a="local-config">Mudar pessoas ou opções</button>
    <button class="btn ghost" data-a="voltar-inicio">Voltar ao início</button>
  </main>`;
}

// ---------------------------------------------------------------- eventos
const actions = {
  'ir-criar': () => go('criar'),
  'ir-entrar': () => go('entrar'),
  'ir-um': () => {
    if (!ui.local) {
      ui.local = loadLocal();
      initLocalSeen();
    }
    if (ui.local.game && !ui.local.game.result && ui.local.stage !== 'config') go('um');
    else {
      ui.local.stage = 'config';
      go('um-config');
    }
  },
  'ir-como': () => {
    ui.comoVolta = ui.screen;
    go('como');
  },
  'voltar-como': () => go(ui.comoVolta || 'inicio'),
  voltar: () => go('inicio'),
  'voltar-inicio': () => go('inicio'),
  'retomar-anfitriao': () => resumeHost(),
  'descartar-anfitriao': () =>
    askConfirm('Fechar essa sala?', 'Quem estava nela vai ver que a sala acabou quando tentar voltar.', 'Fechar sala', () => {
      HostRoom.forget(store);
      render();
    }),
  'retomar-cliente': () => {
    const c = store.get('cliente', null);
    if (c && c.code && c.name) startClient(c.code, c.name);
  },
  'descartar-cliente': () => {
    store.del('cliente');
    render();
  },
  'retomar-mesa': () => {
    ui.local = loadLocal();
    initLocalSeen();
    go('um');
  },
  'descartar-mesa': () => {
    const L = loadLocal();
    L.game = null;
    L.stage = 'config';
    ui.local = L;
    saveLocal();
    render();
  },
  'sair-sala': () => {
    if (ui.online && ui.online.kind === 'client' && !['recusado', 'nao-encontrada', 'removido', 'encerrada'].includes(ui.online.status)) {
      askConfirm('Sair da sala?', 'Se a partida estiver rolando, você pode voltar depois pelo início.', 'Sair', leaveOnline);
    } else leaveOnline();
  },
  'fechar-sala': () =>
    askConfirm('Fechar a sala?', 'Todo mundo sai da sala.', 'Fechar sala', () => {
      ui.online.room.close();
      ui.online = null;
      go('inicio');
    }),
  'fechar-sala-ja': () => {
    if (ui.online && ui.online.room) ui.online.room.close();
    ui.online = null;
    go('inicio');
  },
  'tentar-abrir': () => {
    const o = ui.online;
    if (o && o.kind === 'host') {
      o.room.retries = 0;
      o.room.open();
    }
  },
  'copiar-link': () => {
    const link = shareLink(ui.online.view.room.code);
    const done = () => toast('Link copiado. Mande no grupo da turma.');
    try {
      navigator.clipboard.writeText(link).then(done, () => toast(link));
    } catch (e) {
      toast(link);
    }
  },
  compartilhar: () => {
    const code = ui.online.view.room.code;
    try {
      navigator.share({ title: 'Cúmplices', text: `Entra na minha sala do Cúmplices. Código: ${code}`, url: shareLink(code) }).catch(() => {});
    } catch (e) {
      /* ignore */
    }
  },
  remover: (el) => {
    const id = el.dataset.id;
    const name = nameIn(ui.online.view, id);
    askConfirm(`Tirar ${name} da sala?`, null, 'Tirar', () => {
      const r = ui.online.room.kick(id);
      if (!r.ok) toast(r.message);
    });
  },
  comecar: () => {
    const r = ui.online.room.startGame();
    if (!r.ok) toast(r.message);
  },
  'jogar-de-novo': () => {
    const r = ui.online.room.startGame();
    if (!r.ok) toast(r.message);
  },
  'voltar-sala': () => ui.online.room.backToLobby(),
  'zerar-placar': () =>
    askConfirm('Zerar o placar da noite?', null, 'Zerar', () => {
      if (ui.screen === 'sala') ui.online.room.resetScoreboard();
      else {
        ui.local.scoreboard = {};
        saveLocal();
        render();
      }
    }),
  'vi-papel': () => {
    const v = ui.online.view;
    ui.seenRole[v.room.code + '-' + v.room.gameNo] = true;
    render();
  },
  votar: (el) => sendAction({ type: 'vote', option: Number(el.dataset.opt) }),
  pronto: () => sendAction({ type: 'ready' }),
  proxima: () => askConfirm('Passar para a próxima pergunta?', 'Mesmo quem ainda não marcou “pronto”.', 'Passar', () => sendAction({ type: 'next' }), false),
  'encerrar-votacao': () =>
    askConfirm('Encerrar a votação?', 'Quem não votou fica sem voto. Se for um cúmplice, conta como DIFERENTE.', 'Encerrar', () =>
      sendAction({ type: 'closeVoting' }),
    ),
  'encerrar-partida': () =>
    askConfirm('Encerrar esta partida?', 'Ninguém ganha pontos. Todo mundo volta para a sala de espera.', 'Encerrar', () =>
      ui.online.room.backToLobby(),
    ),
  'trocar-pergunta': () =>
    askConfirm('Trocar a pergunta?', 'Vem uma pergunta nova e os votos já dados são apagados.', 'Trocar', () => {
      const r = ui.online.room.swapQuestion();
      if (r && !r.ok && r.message) toast(r.message);
    }, false),
  'trocar-pergunta-local': () =>
    askConfirm('Trocar a pergunta?', 'Vem uma pergunta nova. Marquem os dedos de novo.', 'Trocar', () => {
      const L = ui.local;
      const g = L.game;
      const inGame = new Set([...(g.questions || []), g.trainingQuestion].filter(Boolean).map(questionKey));
      const usedList = store.get('perguntas-usadas', []);
      const used = new Set([...(Array.isArray(usedList) ? usedList : []), ...inGame]);
      const [q] = pickQuestions(1, secureRandom, used);
      if (!q) return;
      store.set('perguntas-usadas', [...used, questionKey(q)]);
      L.entry = {};
      localApply({ type: 'swapQuestion', question: q });
      render();
    }, false),
  'encerrar-acusacao': () =>
    askConfirm('Encerrar a votação da acusação?', 'Quem não votou conta como “não”.', 'Encerrar', () => sendAction({ type: 'closeAccusation' })),
  'abrir-acusacao': () => {
    ui.picking = true;
    ui.pick = [];
    render();
  },
  'fechar-acusacao': () => {
    ui.picking = false;
    ui.pick = [];
    render();
  },
  'fechar-acusacao-fundo': (el, ev) => {
    if (ev.target === el) actions['fechar-acusacao']();
  },
  escolher: (el) => {
    const id = el.dataset.id;
    if (ui.pick.includes(id)) ui.pick = ui.pick.filter((x) => x !== id);
    else ui.pick = [...ui.pick, id].slice(-2);
    render();
  },
  'enviar-acusacao': () => {
    if (ui.pick.length !== 2) return;
    sendAction({ type: 'propose', pair: ui.pick.slice() });
    ui.picking = false;
    ui.pick = [];
    render();
  },
  'acusar-sim': () => sendAction({ type: 'accuseVote', yes: true }),
  'acusar-nao': () => sendAction({ type: 'accuseVote', yes: false }),
  'fechar-aviso': () => {
    ui.overlay = null;
    render();
  },
  'confirm-sim': () => {
    const c = ui.confirm;
    ui.confirm = null;
    render();
    if (c && c.onOk) c.onOk();
  },
  'confirm-nao': () => {
    ui.confirm = null;
    render();
  },
  // um celular só
  'mais-nome': () => {
    if (ui.local.names.length < MAX_PLAYERS) ui.local.names.push('');
    saveLocal();
    render();
    const el = document.getElementById('nome-' + (ui.local.names.length - 1));
    if (el) el.focus();
  },
  'tirar-nome': (el) => {
    const i = Number(el.dataset.i);
    if (ui.local.names.length > MIN_PLAYERS) ui.local.names.splice(i, 1);
    saveLocal();
    render();
  },
  'um-ajuste': (el) => {
    ui.local.settings.ajuste = Number(el.dataset.val);
    saveLocal();
    render();
  },
  'sou-eu': () => {
    ui.local.passShow = true;
    render();
  },
  'passe-voltar': () => {
    ui.local.passIdx = Math.max(0, ui.local.passIdx - 1);
    ui.local.passShow = false;
    render();
  },
  passar: () => {
    const L = ui.local;
    L.passShow = false;
    if (L.passIdx + 1 < L.game.players.length) L.passIdx += 1;
    else L.stage = 'jogo';
    saveLocal();
    go('um');
  },
  'rever-papel': () => {
    ui.local.peek = { id: null, show: false };
    render();
  },
  'peek-quem': (el) => {
    ui.local.peek = { id: el.dataset.id, show: false };
    render();
  },
  'peek-sou': () => {
    ui.local.peek.show = true;
    render();
  },
  'peek-fechar': () => {
    ui.local.peek = null;
    render();
  },
  marcar: (el) => {
    const L = ui.local;
    const id = el.dataset.id;
    const o = Number(el.dataset.opt);
    if (L.entry[id] === o) delete L.entry[id];
    else L.entry[id] = o;
    saveLocal();
    render();
  },
  revelar: () => {
    const L = ui.local;
    const g = L.game;
    if (!g.players.every((p) => L.entry[p.id] !== undefined)) return;
    for (const p of g.players) {
      if (L.game.phase !== 'votar') break;
      localApply({ type: 'vote', player: p.id, option: L.entry[p.id] });
    }
    L.entry = {};
    saveLocal();
    go('um');
  },
  'proxima-local': () => {
    localApply({ type: 'next' });
    go('um');
  },
  'acusar-local': () => {
    if (ui.pick.length !== 2) return;
    const pair = ui.pick.slice();
    ui.picking = false;
    ui.pick = [];
    localApply({ type: 'localAccusation', pair });
    render();
  },
  'encerrar-local': () =>
    askConfirm('Encerrar esta partida?', 'Ninguém ganha pontos no placar.', 'Encerrar', () => {
      localApply({ type: 'abandon' });
      render();
    }),
  'local-de-novo': () => startLocalGame(),
  'local-config': () => {
    ui.local.stage = 'config';
    saveLocal();
    go('um-config');
  },
};

$app.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-a]');
  if (!el || !$app.contains(el)) return;
  const fn = actions[el.dataset.a];
  if (!fn) return;
  if (el.dataset.a === 'fechar-acusacao-fundo') {
    fn(el, ev);
    return;
  }
  ev.preventDefault();
  fn(el, ev);
});

// Opções do anfitrião
$app.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-set]');
  if (!el || el.tagName === 'INPUT' || !ui.online) return;
  ui.online.room.setSettings({ [el.dataset.set]: Number(el.dataset.val) });
});
$app.addEventListener('change', (ev) => {
  const el = ev.target;
  if (el.matches('input[type="checkbox"][data-set]') && ui.online) {
    ui.online.room.setSettings({ [el.dataset.set]: el.checked });
  }
  if (el.matches('input[type="checkbox"][data-local-set]') && ui.local) {
    ui.local.settings[el.dataset.localSet] = el.checked;
    saveLocal();
  }
});

$app.addEventListener('input', (ev) => {
  const el = ev.target;
  if (el.dataset.bind === 'name') ui.form.name = el.value;
  if (el.dataset.bind === 'code') {
    const up = el.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    if (up !== el.value) el.value = up;
    ui.form.code = up;
  }
  if (el.dataset.localName !== undefined && ui.local) {
    ui.local.names[Number(el.dataset.localName)] = el.value;
    saveLocal();
    const n = ui.local.names.map(cleanName).filter(Boolean).length;
    const meta = document.getElementById('um-meta');
    if (meta) meta.textContent = n >= MIN_PLAYERS && n <= MAX_PLAYERS ? metaText(n, ui.local.settings.ajuste) : `Escreva de ${MIN_PLAYERS} a ${MAX_PLAYERS} nomes.`;
  }
});

$app.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const form = ev.target.dataset.form;
  if (form === 'criar') {
    const name = cleanName(ui.form.name);
    if (!name) return toast('Digite seu nome.');
    store.set('nome', name);
    startHost(name);
  } else if (form === 'entrar') {
    const code = normalizeCode(ui.form.code);
    const name = cleanName(ui.form.name);
    if (!code) return toast('O código tem 4 letras. Confira com quem criou a sala.');
    if (!name) return toast('Digite seu nome.');
    store.set('nome', name);
    startClient(code, name);
  } else if (form === 'um') {
    startLocalGame();
  }
});

// Segurar para ver o papel
function setHold(on, el) {
  const key = el ? el.dataset.hold : ui.holding;
  if (!key) return;
  document.querySelectorAll(`[data-hold-show="${key}"]`).forEach((x) => {
    x.hidden = !on;
  });
  document.querySelectorAll(`[data-hold="${key}"]`).forEach((x) => x.classList.toggle('active', on));
  if (on) ui.holding = key;
  else {
    ui.holding = null;
    if (ui.pendingRender) render();
  }
}
$app.addEventListener('pointerdown', (ev) => {
  const el = ev.target.closest('[data-hold]');
  if (!el) return;
  ev.preventDefault();
  try {
    el.setPointerCapture(ev.pointerId);
  } catch (e) {
    /* ignore */
  }
  setHold(true, el);
});
for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  document.addEventListener(t, () => {
    if (ui.holding) setHold(false);
  });
}
$app.addEventListener('contextmenu', (ev) => {
  if (ev.target.closest('[data-hold]')) ev.preventDefault();
});
$app.addEventListener('keydown', (ev) => {
  const el = ev.target.closest('[data-hold]');
  if (el && (ev.key === ' ' || ev.key === 'Enter') && !ev.repeat) {
    ev.preventDefault();
    setHold(true, el);
  }
});
$app.addEventListener('keyup', (ev) => {
  if (ui.holding && (ev.key === ' ' || ev.key === 'Enter')) setHold(false);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (ui.online || ui.screen === 'um') keepAwake();
  if (ui.online && ui.online.kind === 'client') ui.online.room.poke();
});
window.addEventListener('pagehide', () => {
  if (ui.online && ui.online.kind === 'host') ui.online.room.save();
});
window.addEventListener('beforeunload', (ev) => {
  if (ui.online && ui.online.kind === 'host' && ui.online.room.inGame()) {
    ev.preventDefault();
    ev.returnValue = '';
  }
});

// ---------------------------------------------------------------- início
function boot() {
  ui.local = loadLocal();
  initLocalSeen();
  const fromLink = ONLINE ? normalizeCode(location.search) : '';
  if (fromLink) {
    const saved = store.get('cliente', null);
    if (saved && saved.code === fromLink && saved.name && Date.now() - (saved.at || 0) < 12 * 3600e3) {
      // Recarregou a página da sala em que já estava: volta direto.
      startClient(saved.code, saved.name);
      return;
    }
    ui.form.code = fromLink;
    ui.screen = 'entrar';
  }
  render();
}
boot();

// Exposto para testes automáticos no navegador.
globalThis.__cumplices = { ui, actions, render };

// Sala do anfitrião: guarda o jogo de verdade e manda para cada celular só o que ele pode ver.
import { newGame, act, publicView, privateView, settingsFor, MIN_PLAYERS, MAX_PLAYERS } from './engine.js';
import { pickQuestions, questionKey, QUESTIONS } from './questions.js';
import { PROTOCOL, PEER_PREFIX, cleanName, sameName, roomCode, randomId, scoreGame, secureRandom } from './util.js';

const CLIENT_ACTIONS = new Set(['vote', 'propose', 'accuseVote', 'ready']);
const HOST_ONLY = new Set(['closeVoting', 'closeAccusation', 'next', 'abandon']);
export const HEARTBEAT_TIMEOUT = 25000;
const SAVE_KEY = 'anfitriao';
const MAX_AGE = 12 * 60 * 60 * 1000;

export class HostRoom {
  constructor(opts) {
    this.transport = opts.transport;
    this.store = opts.store;
    this.now = opts.now || (() => Date.now());
    this.setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer || ((h) => clearTimeout(h));
    this.rng = opts.rng || secureRandom;
    this.onChange = opts.onChange || (() => {});
    this.onStatus = opts.onStatus || (() => {});
    const saved = opts.restore || null;
    if (saved) {
      this.code = saved.code;
      this.hostId = saved.hostId;
      this.players = saved.players.map((p) => ({ id: p.id, name: p.name, connected: p.id === saved.hostId }));
      this.waiting = (saved.waiting || []).map((p) => ({ id: p.id, name: p.name, connected: false }));
      this.settings = { training: false, ajuste: 0, timer: 0, ...(saved.settings || {}) };
      this.scoreboard = saved.scoreboard || {};
      this.aliases = saved.aliases || {};
      this.game = saved.game || null;
      this.gameNo = saved.gameNo || 0;
      this.timer =
        saved.timer && this.game && this.game.phase === 'conversa'
          ? { endsAt: this.now() + Math.max(20000, saved.timer.left || 0) }
          : null;
      this.keepCode = true;
    } else {
      this.code = opts.code || roomCode(this.rng);
      this.hostId = opts.hostId || randomId();
      this.players = [{ id: this.hostId, name: cleanName(opts.hostName) || 'Anfitrião', connected: true }];
      this.waiting = [];
      this.settings = { training: false, ajuste: 0, timer: 0 };
      this.scoreboard = {};
      this.aliases = {};
      this.game = null;
      this.gameNo = 0;
      this.timer = null;
      this.keepCode = false;
    }
    this.conns = new Map();
    this.lastSeen = new Map();
    this.status = 'abrindo';
    this.statusMessage = '';
    this.listener = null;
    this.timerHandle = null;
    this.heartbeatHandle = null;
    this.reopenHandle = null;
    this.retries = 0;
    this.closed = false;
  }

  static loadSaved(store, now = Date.now()) {
    const saved = store.get(SAVE_KEY, null);
    if (!saved || !saved.code || !saved.hostId || !Array.isArray(saved.players)) return null;
    if (now - (saved.savedAt || 0) > MAX_AGE) return null;
    return saved;
  }

  static forget(store) {
    store.del(SAVE_KEY);
  }

  get hostName() {
    const p = this.players.find((x) => x.id === this.hostId);
    return p ? p.name : '';
  }

  // ---------- rede ----------
  open() {
    if (this.closed) return;
    this.status = this.keepCode ? 'retomando' : 'abrindo';
    this.emitStatus();
    if (this.listener) {
      try {
        this.listener.close();
      } catch (e) {
        /* ignore */
      }
    }
    this.listener = this.transport.listen(PEER_PREFIX + this.code, {
      onReady: () => {
        this.status = 'aberta';
        this.statusMessage = '';
        this.retries = 0;
        this.keepCode = true;
        if (this.reopenHandle) {
          this.clearTimer(this.reopenHandle);
          this.reopenHandle = null;
        }
        this.emitStatus();
        this.save();
        this.broadcast();
      },
      onConnection: (conn) => this.attach(conn),
      onError: (type) => this.onListenError(type),
    }, { resume: this.keepCode });
    if (!this.heartbeatHandle) this.startHeartbeat();
    this.scheduleTimer();
    this.broadcast();
  }

  onListenError(type) {
    if (this.closed) return;
    if (type === 'unavailable-id') {
      if (this.keepCode) {
        // O servidor ainda guarda o nome antigo da sala (página recarregada). Tenta de novo.
        if (this.retries < 25) {
          this.retries += 1;
          this.status = 'retomando';
          this.emitStatus();
          this.reopenLater(3000);
          return;
        }
      } else if (this.retries < 6) {
        this.retries += 1;
        this.code = roomCode(this.rng);
        this.open();
        return;
      }
      this.status = 'erro';
      this.statusMessage = 'Não deu para abrir a sala. Feche e crie outra.';
      this.emitStatus();
      return;
    }
    if (type === 'browser-incompatible') {
      this.status = 'erro';
      this.statusMessage = 'Este navegador não aceita o modo online. Use Chrome, Safari ou Firefox atualizados.';
      this.emitStatus();
      return;
    }
    if (['network', 'server-error', 'socket-error', 'socket-closed', 'disconnected'].includes(type)) {
      this.status = 'reconectando';
      this.emitStatus();
      // Transportes que tentam de novo sozinhos avisam quando voltarem (onReady); os outros, reabre.
      if (!this.transport.selfHealing) this.reopenLater(15000);
    }
    // peer-unavailable e outros erros não afetam o anfitrião
  }

  reopenLater(ms) {
    if (this.reopenHandle) this.clearTimer(this.reopenHandle);
    this.reopenHandle = this.setTimer(() => {
      this.reopenHandle = null;
      if (this.status !== 'aberta' && !this.closed) this.open();
    }, ms);
  }

  attach(conn) {
    let id = null;
    conn.on('data', (msg) => {
      if (this.closed || !msg || typeof msg !== 'object') return;
      if (msg.t === 'hello') {
        id = this.onHello(conn, msg);
        return;
      }
      if (!id || this.conns.get(id) !== conn) return;
      this.lastSeen.set(id, this.now());
      if (msg.t === 'ping') conn.send({ t: 'pong' });
      else if (msg.t === 'act') this.onClientAction(id, msg.action);
      else if (msg.t === 'leave') this.onLeave(id);
    });
    conn.on('close', () => {
      if (id && this.conns.get(id) === conn) {
        this.conns.delete(id);
        this.setConnected(id, false);
        this.broadcast();
      }
    });
  }

  findMember(id) {
    return this.players.find((p) => p.id === id) || this.waiting.find((p) => p.id === id) || null;
  }

  inGame() {
    return !!this.game && !this.game.result;
  }

  onHello(conn, msg) {
    const reject = (reason) => {
      conn.send({ t: 'reject', reason });
      return null;
    };
    if (msg.v !== PROTOCOL) return reject('Este celular está com outra versão do jogo. Recarregue a página e tente de novo.');
    let id = typeof msg.clientId === 'string' && /^[a-z0-9]{6,32}$/.test(msg.clientId) ? msg.clientId : null;
    if (!id) return reject('Não deu para identificar este celular. Recarregue a página.');
    if (id === this.hostId) return reject('Esta sala foi criada neste mesmo celular. Use outro aparelho para entrar.');
    const name = cleanName(msg.name);
    if (!name) return reject('Digite seu nome para entrar.');
    const deviceId = id;
    if (this.aliases[deviceId]) id = this.aliases[deviceId];
    let p = this.findMember(id);
    if (!p) {
      const twin = [...this.players, ...this.waiting].find((x) => sameName(x.name, name));
      if (twin && (twin.id === this.hostId || this.conns.has(twin.id))) {
        return reject(`Já tem um "${name}" na sala. Entre com outro nome (por exemplo, com a inicial do sobrenome).`);
      }
      if (twin) {
        // Mesmo nome de alguém que está desconectado: é a mesma pessoa voltando por outro aparelho
        // (ou com o navegador limpo). Ela recupera o lugar, o papel e os votos.
        this.aliases[deviceId] = twin.id;
        id = twin.id;
        p = twin;
      } else {
        const count = this.players.length + this.waiting.length;
        if (count >= MAX_PLAYERS) return reject(`A sala está cheia (máximo de ${MAX_PLAYERS} pessoas).`);
        p = { id, name, connected: true };
        if (this.inGame()) this.waiting.push(p);
        else this.players.push(p);
      }
    } else {
      const others = [...this.players, ...this.waiting].filter((x) => x.id !== id);
      if (!this.inGame() && !sameName(p.name, name) && !others.some((x) => sameName(x.name, name))) p.name = name;
    }
    const old = this.conns.get(id);
    this.conns.set(id, conn);
    if (old && old !== conn) {
      try {
        old.close();
      } catch (e) {
        /* ignore */
      }
    }
    this.lastSeen.set(id, this.now());
    p.connected = true;
    conn.send({ t: 'welcome', you: id, code: this.code });
    this.save();
    this.broadcast();
    return id;
  }

  setConnected(id, value) {
    const p = this.findMember(id);
    if (p) p.connected = value;
  }

  onLeave(id) {
    const conn = this.conns.get(id);
    this.conns.delete(id);
    if (conn) {
      try {
        conn.close();
      } catch (e) {
        /* ignore */
      }
    }
    const inCurrentGame = this.inGame() && this.game.players.some((p) => p.id === id);
    if (inCurrentGame) this.setConnected(id, false);
    else {
      this.players = this.players.filter((p) => p.id !== id);
      this.waiting = this.waiting.filter((p) => p.id !== id);
    }
    this.save();
    this.broadcast();
  }

  startHeartbeat() {
    const tick = () => {
      if (this.closed) return;
      const t = this.now();
      let changed = false;
      for (const [id, conn] of [...this.conns]) {
        if (t - (this.lastSeen.get(id) || 0) > HEARTBEAT_TIMEOUT) {
          this.conns.delete(id);
          this.setConnected(id, false);
          changed = true;
          try {
            conn.close();
          } catch (e) {
            /* ignore */
          }
        }
      }
      if (changed) this.broadcast();
      this.heartbeatHandle = this.setTimer(tick, 5000);
    };
    this.heartbeatHandle = this.setTimer(tick, 5000);
  }

  // ---------- jogo ----------
  onClientAction(id, action) {
    if (!this.inGame()) return;
    if (!action || !CLIENT_ACTIONS.has(action.type)) return;
    if (!this.game.players.some((p) => p.id === id)) {
      this.sendTo(id, { t: 'error', message: 'Você está assistindo esta partida. Entra na próxima.' });
      return;
    }
    const a = { type: action.type, player: id };
    if (action.type === 'vote') a.option = action.option;
    if (action.type === 'propose') a.pair = action.pair;
    if (action.type === 'accuseVote') a.yes = action.yes;
    this.apply(a, id);
  }

  /** Ações vindas da tela do anfitrião (como jogador ou como dono da sala). */
  hostAct(action) {
    if (!action || !this.inGame()) return { ok: false, message: 'Não há partida em andamento.' };
    if (CLIENT_ACTIONS.has(action.type)) return this.apply({ ...action, player: this.hostId }, this.hostId);
    if (HOST_ONLY.has(action.type)) return this.apply({ type: action.type }, this.hostId);
    return { ok: false, message: 'Ação desconhecida.' };
  }

  apply(action, fromId) {
    const prev = this.game;
    const res = act(prev, action);
    if (!res.ok) {
      if (fromId && fromId !== this.hostId) this.sendTo(fromId, { t: 'error', message: res.message });
      return res;
    }
    this.game = res.state;
    this.afterGameChange(prev, this.game);
    this.save();
    this.broadcast();
    return res;
  }

  afterGameChange(prev, next) {
    if (next.result && !prev.result) {
      this.timer = null;
      this.scheduleTimer();
      if (next.result.winner) this.scoreboard = scoreGame(this.scoreboard, next);
      return;
    }
    if (next.phase === 'conversa') {
      if (prev.phase === 'acusacao' && this.timer && this.timer.paused) {
        this.timer = { endsAt: this.now() + Math.max(this.timer.remaining, 20000) };
      } else if (prev.phase !== 'conversa' || prev.round !== next.round) {
        this.timer = this.settings.timer > 0 ? { endsAt: this.now() + this.settings.timer * 1000 } : null;
      }
    } else if (next.phase === 'acusacao') {
      if (this.timer && this.timer.endsAt) {
        this.timer = { paused: true, remaining: Math.max(0, this.timer.endsAt - this.now()) };
      }
    } else {
      this.timer = null;
    }
    this.scheduleTimer();
  }

  scheduleTimer() {
    if (this.timerHandle) {
      this.clearTimer(this.timerHandle);
      this.timerHandle = null;
    }
    if (this.closed || !this.timer || !this.timer.endsAt || !this.game || this.game.phase !== 'conversa') return;
    const ms = Math.max(0, this.timer.endsAt - this.now());
    this.timerHandle = this.setTimer(() => {
      this.timerHandle = null;
      if (this.game && this.game.phase === 'conversa' && this.timer && this.timer.endsAt) {
        this.apply({ type: 'next' }, this.hostId);
      }
    }, ms + 30);
  }

  startGame() {
    if (this.inGame()) return { ok: false, message: 'Já tem uma partida rolando.' };
    const everyone = [...this.players, ...this.waiting];
    const roster = everyone.filter((p) => p.id === this.hostId || p.connected);
    const out = everyone.filter((p) => !roster.includes(p));
    if (roster.length < MIN_PLAYERS) {
      return { ok: false, message: `Precisa de pelo menos ${MIN_PLAYERS} pessoas conectadas (agora são ${roster.length}).` };
    }
    if (roster.length > MAX_PLAYERS) return { ok: false, message: `O máximo é ${MAX_PLAYERS} pessoas.` };
    const st = settingsFor(roster.length, this.settings.ajuste);
    const need = st.rounds + (this.settings.training ? 1 : 0);
    const usedList = this.store.get('perguntas-usadas', []);
    const used = new Set(Array.isArray(usedList) ? usedList : []);
    const qs = pickQuestions(need, this.rng, used);
    let nextUsed = [...used, ...qs.map(questionKey)];
    if (nextUsed.length > QUESTIONS.length - need) nextUsed = qs.map(questionKey);
    this.store.set('perguntas-usadas', nextUsed);
    this.players = roster;
    this.waiting = out;
    this.game = newGame({
      players: roster.map((p) => ({ id: p.id, name: p.name })),
      questions: qs,
      rng: this.rng,
      settings: st,
      training: !!this.settings.training,
    });
    this.gameNo += 1;
    this.timer = null;
    this.scheduleTimer();
    this.save();
    this.broadcast();
    return { ok: true };
  }

  /** Troca a pergunta da vez por uma nova (antes da revelação). */
  swapQuestion() {
    if (!this.inGame() || this.game.phase !== 'votar') return { ok: false, message: 'Só dá para trocar a pergunta antes da revelação.' };
    const g = this.game;
    const inGame = new Set([...(g.questions || []), g.trainingQuestion].filter(Boolean).map(questionKey));
    const usedList = this.store.get('perguntas-usadas', []);
    const used = new Set([...(Array.isArray(usedList) ? usedList : []), ...inGame]);
    const [q] = pickQuestions(1, this.rng, used);
    if (!q) return { ok: false, message: 'Não sobrou pergunta nova.' };
    this.store.set('perguntas-usadas', [...used, questionKey(q)]);
    return this.apply({ type: 'swapQuestion', question: q }, this.hostId);
  }

  /** Encerra a partida atual (se houver) e volta para a sala de espera. */
  backToLobby() {
    if (this.inGame()) this.game = act(this.game, { type: 'abandon' }).state;
    this.game = null;
    this.players = [...this.players, ...this.waiting];
    this.waiting = [];
    this.timer = null;
    this.scheduleTimer();
    this.save();
    this.broadcast();
    return { ok: true };
  }

  kick(id) {
    if (id === this.hostId) return { ok: false, message: 'O anfitrião não pode sair da própria sala.' };
    if (this.inGame() && this.game.players.some((p) => p.id === id)) {
      return { ok: false, message: 'Só dá para tirar alguém fora de uma partida.' };
    }
    const conn = this.conns.get(id);
    if (conn) {
      conn.send({ t: 'kicked' });
      this.setTimer(() => {
        try {
          conn.close();
        } catch (e) {
          /* ignore */
        }
      }, 300);
    }
    this.conns.delete(id);
    this.players = this.players.filter((p) => p.id !== id);
    this.waiting = this.waiting.filter((p) => p.id !== id);
    this.save();
    this.broadcast();
    return { ok: true };
  }

  setSettings(partial) {
    if (this.inGame()) return { ok: false, message: 'Mude as opções entre uma partida e outra.' };
    const s = { ...this.settings };
    if ('training' in partial) s.training = !!partial.training;
    if ('ajuste' in partial) s.ajuste = [-1, 0, 1].includes(Number(partial.ajuste)) ? Number(partial.ajuste) : 0;
    if ('timer' in partial) s.timer = [0, 60, 90, 120].includes(Number(partial.timer)) ? Number(partial.timer) : 0;
    this.settings = s;
    this.save();
    this.broadcast();
    return { ok: true };
  }

  resetScoreboard() {
    this.scoreboard = {};
    this.save();
    this.broadcast();
    return { ok: true };
  }

  close() {
    this.closed = true;
    for (const conn of this.conns.values()) conn.send({ t: 'closed' });
    const conns = [...this.conns.values()];
    this.conns.clear();
    for (const h of [this.timerHandle, this.heartbeatHandle, this.reopenHandle]) if (h) this.clearTimer(h);
    this.setTimer(() => {
      for (const c of conns) {
        try {
          c.close();
        } catch (e) {
          /* ignore */
        }
      }
      if (this.listener) {
        try {
          this.listener.close();
        } catch (e) {
          /* ignore */
        }
      }
    }, 400);
    HostRoom.forget(this.store);
  }

  // ---------- visão e envio ----------
  viewFor(id) {
    const t = this.timer;
    return {
      t: 'state',
      v: PROTOCOL,
      you: id,
      room: {
        code: this.code,
        hostId: this.hostId,
        players: this.players.map((p) => ({ id: p.id, name: p.name, connected: p.id === this.hostId ? true : !!p.connected })),
        waiting: this.waiting.map((p) => ({ id: p.id, name: p.name, connected: !!p.connected })),
        settings: { ...this.settings },
        scoreboard: this.scoreboard,
        gameNo: this.gameNo,
      },
      game: this.game ? publicView(this.game) : null,
      me: this.game && this.game.players.some((p) => p.id === id) ? privateView(this.game, id) : null,
      timer: t ? (t.paused ? { paused: true, left: t.remaining } : { left: Math.max(0, t.endsAt - this.now()) }) : null,
    };
  }

  sendTo(id, msg) {
    const conn = this.conns.get(id);
    if (conn) conn.send(msg);
  }

  broadcast() {
    if (this.closed) return;
    for (const [id, conn] of this.conns) conn.send(this.viewFor(id));
    this.onChange(this.viewFor(this.hostId));
  }

  emitStatus() {
    this.onStatus({ status: this.status, message: this.statusMessage, code: this.code });
  }

  save() {
    if (this.closed) return;
    const t = this.timer;
    this.store.set(SAVE_KEY, {
      code: this.code,
      hostId: this.hostId,
      players: this.players.map((p) => ({ id: p.id, name: p.name })),
      waiting: this.waiting.map((p) => ({ id: p.id, name: p.name })),
      settings: this.settings,
      scoreboard: this.scoreboard,
      aliases: this.aliases,
      game: this.game,
      gameNo: this.gameNo,
      timer: t && t.endsAt ? { left: Math.max(0, t.endsAt - this.now()) } : t && t.paused ? { left: t.remaining } : null,
      savedAt: this.now(),
    });
  }
}

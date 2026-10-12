// Celular de quem entrou na sala: conecta no anfitrião, reconecta sozinho e manda as jogadas.
import { PROTOCOL, PEER_PREFIX } from './util.js';

export class ClientRoom {
  constructor(opts) {
    this.transport = opts.transport;
    this.code = opts.code;
    this.clientId = opts.clientId;
    this.name = opts.name;
    this.onChange = opts.onChange || (() => {});
    this.now = opts.now || (() => Date.now());
    this.setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer || ((h) => clearTimeout(h));
    this.status = 'parado'; // conectando | conectado | reconectando | recusado | nao-encontrada | removido | encerrada | saiu
    this.reason = null;
    this.view = null;
    this.link = null;
    this.attempt = 0;
    this.everJoined = false;
    this.stopped = true;
    this.lastPong = 0;
    this.pending = null;
    this.handles = { retry: null, connect: null, ping: null };
  }

  start() {
    this.stopped = false;
    this.status = 'conectando';
    this.attempt = 0;
    this.connect();
    this.emit();
  }

  clear(name) {
    if (this.handles[name]) {
      this.clearTimer(this.handles[name]);
      this.handles[name] = null;
    }
  }

  connect() {
    if (this.stopped) return;
    this.clear('retry');
    this.clear('connect');
    this.clear('ping');
    if (this.link) {
      const old = this.link;
      this.link = null;
      old.close();
    }
    const myLink = this.transport.connect(PEER_PREFIX + this.code, {
      onOpen: () => {
        if (this.link !== myLink) return;
        this.lastPong = this.now();
        myLink.send({ t: 'hello', v: PROTOCOL, clientId: this.clientId, name: this.name });
      },
      onData: (msg) => {
        if (this.link !== myLink) return;
        this.onData(msg);
      },
      onClose: () => {
        if (this.link !== myLink) return;
        this.onLost('fechou');
      },
      onError: (type) => {
        if (this.link !== myLink) return;
        this.onLost(type);
      },
    });
    this.link = myLink;
    this.handles.connect = this.setTimer(() => {
      this.handles.connect = null;
      if (this.link === myLink && this.status !== 'conectado') this.onLost('tempo');
    }, 15000);
  }

  onData(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'welcome':
        this.clear('connect');
        this.status = 'conectado';
        this.everJoined = true;
        this.attempt = 0;
        this.lastPong = this.now();
        this.startPing();
        this.emit();
        break;
      case 'state':
        this.view = msg;
        if (this.status !== 'conectado') {
          this.status = 'conectado';
          this.clear('connect');
          this.startPing();
        }
        this.lastPong = this.now();
        this.maybeResend();
        this.emit();
        break;
      case 'pong':
        this.lastPong = this.now();
        break;
      case 'error':
        this.pending = null;
        this.emit({ toast: msg.message });
        break;
      case 'reject':
        this.stop('recusado', msg.reason || 'O anfitrião não aceitou a entrada.');
        break;
      case 'kicked':
        this.stop('removido', 'O anfitrião tirou você da sala.');
        break;
      case 'closed':
        this.stop('encerrada', 'O anfitrião fechou a sala.');
        break;
      default:
        break;
    }
  }

  onLost(type) {
    if (this.stopped) return;
    this.clear('ping');
    this.clear('connect');
    if (this.link) {
      const l = this.link;
      this.link = null;
      l.close();
    }
    this.attempt += 1;
    if (!this.everJoined && type === 'peer-unavailable' && this.attempt >= 4) {
      this.stop('nao-encontrada', `Não achei a sala ${this.code}. Confira o código com quem criou a sala.`);
      return;
    }
    if (type === 'browser-incompatible') {
      this.stop('recusado', 'Este navegador não aceita o modo online. Use Chrome, Safari ou Firefox atualizados.');
      return;
    }
    this.status = this.everJoined ? 'reconectando' : 'conectando';
    this.emit();
    const delay = Math.min(8000, Math.round(1000 * Math.pow(1.6, this.attempt - 1)));
    this.handles.retry = this.setTimer(() => {
      this.handles.retry = null;
      this.connect();
    }, delay);
  }

  startPing() {
    this.clear('ping');
    const tick = () => {
      this.handles.ping = null;
      if (this.stopped || !this.link) return;
      if (this.now() - this.lastPong > 20000) {
        this.onLost('sem-resposta');
        return;
      }
      this.link.send({ t: 'ping' });
      this.handles.ping = this.setTimer(tick, 6000);
    };
    this.handles.ping = this.setTimer(tick, 6000);
  }

  send(action) {
    // Guarda a jogada até o anfitrião confirmar: se a conexão cair no caminho, ela é reenviada sozinha.
    const v = this.view;
    const g = v && v.game;
    this.pending = g
      ? { action, gameNo: v.room.gameNo, round: g.round, phase: g.phase, at: this.now(), lastTry: this.now(), tries: 0 }
      : null;
    if (this.link && this.status === 'conectado' && this.link.send({ t: 'act', action })) return true;
    this.emit({ toast: 'Sem conexão com o anfitrião. Tentando reconectar…' });
    this.poke();
    return false;
  }

  /** A jogada pendente já aparece no estado que veio do anfitrião? */
  static applied(action, v) {
    const g = v.game;
    if (!g) return false;
    if (action.type === 'vote') return !!v.me && v.me.myVote === action.option;
    if (action.type === 'ready') return (g.ready || []).includes(v.you);
    if (action.type === 'propose') return (g.proposed || []).includes(v.you);
    if (action.type === 'accuseVote') return !!v.me && v.me.myAccuseVote === action.yes;
    return true;
  }

  maybeResend() {
    const p = this.pending;
    const v = this.view;
    if (!p || !v) return;
    const g = v.game;
    const stale = !g || v.room.gameNo !== p.gameNo || g.round !== p.round || g.phase !== p.phase || g.result;
    if (stale || ClientRoom.applied(p.action, v) || p.tries >= 4 || this.now() - p.at > 90000) {
      this.pending = null;
      return;
    }
    if (this.status !== 'conectado' || !this.link || this.now() - p.lastTry < 1500) return;
    p.tries += 1;
    p.lastTry = this.now();
    this.link.send({ t: 'act', action: p.action });
  }

  /** Tenta reconectar já (por exemplo, quando a tela volta a ficar visível). */
  poke() {
    if (this.stopped) return;
    if (this.status !== 'conectado') {
      this.connect();
      return;
    }
    if (this.now() - this.lastPong > 15000) this.onLost('sem-resposta');
  }

  leave() {
    if (this.link) this.link.send({ t: 'leave' });
    const l = this.link;
    this.link = null;
    this.stop('saiu', null);
    if (l) this.setTimer(() => l.close(), 300);
  }

  stop(status, reason) {
    this.stopped = true;
    this.status = status;
    this.reason = reason;
    for (const k of Object.keys(this.handles)) this.clear(k);
    if (this.link) {
      const l = this.link;
      this.link = null;
      l.close();
    }
    this.emit();
  }

  emit(extra) {
    this.onChange({ status: this.status, reason: this.reason, view: this.view, ...(extra || {}) });
  }
}

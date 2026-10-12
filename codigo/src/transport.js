// Transportes de rede.
// peerTransport: conexão direta entre os celulares (WebRTC via PeerJS, servidor gratuito da PeerJS só apresenta os aparelhos).
// mqttTransport: plano B — os recados passam por servidores públicos de mensagens (MQTT sobre WebSocket).
// dualTransport: usa os dois ao mesmo tempo; o celular fica com o caminho que abrir primeiro.
// memoryTransport: rede de mentirinha, usada nos testes automáticos.
//
// Interface comum:
//   listen(peerId, { onReady, onConnection(conn), onError(type) }, { resume }) -> { close() }
//     conn: { id, send(msg), close(), on('data'|'close', fn) }
//   connect(peerId, { onOpen, onData(msg), onClose, onError(type) }) -> { send(msg) -> bool, close() }
import { connectMqtt } from './mqtt-lite.js';

/** Servidores públicos e gratuitos de mensagens, tentados juntos. */
export const PUBLIC_BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt'];
const MQTT_NS = 'jogo-cumplices/';

function rid(len = 14) {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  const c = typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.getRandomValues ? globalThis.crypto : null;
  const buf = c ? c.getRandomValues(new Uint32Array(len)) : null;
  for (let i = 0; i < len; i++) s += chars[(buf ? buf[i] : Math.floor(Math.random() * 4294967296)) % chars.length];
  return s;
}

/**
 * Plano B: recados pelo broker MQTT.
 * O anfitrião fica conectado em todos os brokers da lista; cada celular tenta todos e fica com o primeiro
 * em que o anfitrião responder. Tópicos: <ns><sala>/h (caixa do anfitrião) e <ns><sala>/c/<link> (caixa do celular).
 */
export function mqttTransport({ brokers = PUBLIC_BROKERS, WebSocketImpl, openTimeout = 6000, readyTimeout = 12000 } = {}) {
  const WS = () => WebSocketImpl || (typeof globalThis !== 'undefined' ? globalThis.WebSocket : undefined);
  const topics = (peerId) => ({
    host: `${MQTT_NS}${peerId}/h`,
    all: `${MQTT_NS}${peerId}/todos`,
    client: (link) => `${MQTT_NS}${peerId}/c/${link}`,
  });
  const parse = (text) => {
    try {
      const m = JSON.parse(text);
      return m && typeof m === 'object' ? m : null;
    } catch (e) {
      return null;
    }
  };
  return {
    selfHealing: true,
    available() {
      return typeof WS() === 'function' && brokers.length > 0;
    },
    listen(peerId, h) {
      const t = topics(peerId);
      let closed = false;
      let readyFired = false;
      let errorFired = false;
      const sessions = brokers.map((url) => {
        const s = { url, client: null, conns: new Map(), retry: null, attempts: 0, failedOnce: false };
        const publishTo = (link, obj) => {
          if (s.client && s.client.connected) s.client.publish(t.client(link), JSON.stringify(obj));
        };
        const makeConn = (link) => {
          const handlers = { data: [], close: [] };
          let gone = false;
          const c = {
            api: {
              id: 'mqtt-' + link,
              send(msg) {
                if (!gone) publishTo(link, { t: 'msg', m: msg });
              },
              close() {
                if (gone) return;
                publishTo(link, { t: 'close' });
                s.conns.delete(link);
                c.drop();
              },
              on(ev, fn) {
                if (handlers[ev]) handlers[ev].push(fn);
              },
            },
            data(msg) {
              if (!gone) handlers.data.forEach((fn) => fn(msg));
            },
            drop() {
              if (gone) return;
              gone = true;
              handlers.close.forEach((fn) => fn());
            },
          };
          return c;
        };
        const onMsg = (text) => {
          const m = parse(text);
          if (!m || typeof m.l !== 'string' || !/^[a-z0-9]{6,40}$/.test(m.l)) return;
          let c = s.conns.get(m.l);
          if (m.t === 'open') {
            if (!c) {
              c = makeConn(m.l);
              s.conns.set(m.l, c);
              if (h.onConnection) h.onConnection(c.api);
            }
            publishTo(m.l, { t: 'opened' });
            return;
          }
          if (!c) {
            // Recado de um link que o anfitrião não conhece (ele recarregou a página): manda reconectar.
            if (m.t === 'msg') publishTo(m.l, { t: 'close' });
            return;
          }
          if (m.t === 'msg') c.data(m.m);
          else if (m.t === 'close') {
            s.conns.delete(m.l);
            c.drop();
          }
        };
        const start = () => {
          if (closed) return;
          s.client = connectMqtt(s.url, {
            clientId: 'h' + rid(19),
            keepalive: 30,
            WebSocketImpl: WS(),
            onConnect: () => {
              s.client.subscribe(t.host, (ok) => {
                if (!ok) return s.client.end();
                s.attempts = 0;
                // Quem ainda estava ligado a uma versão antiga deste anfitrião (queda ou página recarregada)
                // reconecta na hora, em vez de esperar o próximo "ping".
                s.client.publish(t.all, JSON.stringify({ t: 'reopen' }));
                if (!readyFired && !closed) {
                  readyFired = true;
                  if (h.onReady) h.onReady();
                }
              });
            },
            onMessage: (topic, text) => {
              if (topic === t.host) onMsg(text);
            },
            onClose: () => {
              for (const c of [...s.conns.values()]) c.drop();
              s.conns.clear();
              s.failedOnce = true;
              if (closed) return;
              if (!readyFired && !errorFired && sessions.every((x) => x.failedOnce)) {
                errorFired = true;
                if (h.onError) h.onError('network');
              }
              s.attempts += 1;
              s.retry = setTimeout(start, Math.min(15000, Math.round(1000 * Math.pow(1.7, s.attempts))));
            },
          });
        };
        s.start = start;
        s.publishTo = publishTo;
        return s;
      });
      sessions.forEach((s) => s.start());
      const watchdog = setTimeout(() => {
        if (!readyFired && !errorFired && !closed) {
          errorFired = true;
          if (h.onError) h.onError('network');
        }
      }, readyTimeout);
      return {
        close() {
          closed = true;
          clearTimeout(watchdog);
          for (const s of sessions) {
            clearTimeout(s.retry);
            for (const [link, c] of [...s.conns]) {
              s.publishTo(link, { t: 'close' });
              c.drop();
            }
            s.conns.clear();
            if (s.client) s.client.end();
          }
        },
      };
    },
    connect(peerId, h) {
      const t = topics(peerId);
      const link = rid(16);
      let winner = null;
      let done = false;
      const bye = JSON.stringify({ l: link, t: 'close' });
      const quietly = (a) => {
        try {
          if (a.client && a.client.connected) a.client.publish(t.host, bye);
          if (a.client) a.client.end();
        } catch (e) {
          /* ignore */
        }
      };
      const attempts = brokers.map((url) => ({ url, client: null, failed: false }));
      let timer = null;
      const giveUp = (type) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        attempts.forEach(quietly);
        if (h.onError) h.onError(type);
      };
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        attempts.forEach(quietly);
        if (h.onClose) h.onClose();
      };
      const fail = (a) => {
        a.failed = true;
        if (winner === null && attempts.every((x) => x.failed)) giveUp('network');
      };
      for (const a of attempts) {
        a.client = connectMqtt(a.url, {
          clientId: 'c' + rid(19),
          keepalive: 30,
          WebSocketImpl: WS(),
          will: { topic: t.host, payload: bye },
          onConnect: () => {
            a.client.subscribe(t.all, () => {});
            a.client.subscribe(t.client(link), (ok) => {
              if (!ok) return fail(a);
              a.client.publish(t.host, JSON.stringify({ l: link, t: 'open' }));
            });
          },
          onMessage: (topic, text) => {
            if (done) return;
            if (topic === t.all) {
              const r = parse(text);
              if (r && r.t === 'reopen' && winner === a) finish();
              return;
            }
            if (topic !== t.client(link)) return;
            const m = parse(text);
            if (!m) return;
            if (m.t === 'opened') {
              if (winner !== null) {
                if (winner !== a) quietly(a);
                return;
              }
              winner = a;
              clearTimeout(timer);
              attempts.forEach((b) => b !== a && quietly(b));
              if (h.onOpen) h.onOpen();
            } else if (winner === a && m.t === 'msg') {
              if (h.onData) h.onData(m.m);
            } else if (winner === a && m.t === 'close') finish();
          },
          onClose: () => {
            if (winner === a) finish();
            else if (winner === null) fail(a);
          },
        });
      }
      // Ninguém respondeu: a sala não existe (ou o anfitrião está sem internet).
      timer = setTimeout(() => giveUp('peer-unavailable'), openTimeout);
      return {
        send(msg) {
          if (done || !winner || !winner.client.connected) return false;
          return winner.client.publish(t.host, JSON.stringify({ l: link, t: 'msg', m: msg }));
        },
        close() {
          if (done) return;
          done = true;
          clearTimeout(timer);
          attempts.forEach(quietly);
        },
      };
    },
  };
}

/**
 * Usa vários transportes ao mesmo tempo (ex.: PeerJS + MQTT).
 * Anfitrião: escuta em todos; fica "aberto" quando o primeiro estiver pronto e tenta de novo, em segundo plano,
 * o que falhou. Celular: tenta todos juntos e fica com o que abrir primeiro.
 */
export function dualTransport(list) {
  const parts = list.filter((tp) => tp && tp.available());
  return {
    available() {
      return parts.length > 0;
    },
    listen(peerId, h, opts = {}) {
      let closed = false;
      let anyReady = false;
      const subs = parts.map((tp) => ({ tp, listener: null, ready: false, retry: null, tries: 0 }));
      const start = (sub) => {
        if (closed) return;
        sub.listener = sub.tp.listen(
          peerId,
          {
            onReady: () => {
              if (closed) return;
              sub.ready = true;
              sub.tries = 0;
              if (!anyReady) {
                anyReady = true;
                if (h.onReady) h.onReady();
              }
            },
            onConnection: (c) => {
              if (!closed && h.onConnection) h.onConnection(c);
            },
            onError: (type, err) => {
              if (closed) return;
              const someoneElseReady = subs.some((x) => x !== sub && x.ready);
              if (type === 'unavailable-id' && !opts.resume) {
                // Código já usado por outra sala: a sala troca de código.
                if (h.onError) h.onError(type, err);
                return;
              }
              if (type === 'peer-unavailable') return; // não afeta quem escuta
              sub.ready = false;
              if (!someoneElseReady && type !== 'unavailable-id' && h.onError) h.onError(type, err);
              if (sub.tp.selfHealing && type !== 'unavailable-id') return; // ele mesmo tenta de novo
              clearTimeout(sub.retry);
              sub.tries += 1;
              const wait = type === 'unavailable-id' ? 3000 : Math.min(30000, 4000 * sub.tries);
              sub.retry = setTimeout(() => {
                try {
                  if (sub.listener) sub.listener.close();
                } catch (e) {
                  /* ignore */
                }
                start(sub);
              }, wait);
            },
          },
          opts,
        );
      };
      subs.forEach(start);
      return {
        close() {
          closed = true;
          for (const s of subs) {
            clearTimeout(s.retry);
            try {
              if (s.listener) s.listener.close();
            } catch (e) {
              /* ignore */
            }
          }
        },
      };
    },
    connect(peerId, h) {
      let winner = -1;
      let done = false;
      const failed = new Set();
      const errs = [];
      const links = [];
      const markFail = (i, type, err) => {
        if (done || winner !== -1) return;
        failed.add(i);
        errs.push(type);
        if (failed.size === parts.length) {
          done = true;
          let tp = errs[0];
          if (errs.includes('peer-unavailable')) tp = 'peer-unavailable';
          else if (errs.includes('network')) tp = 'network';
          if (h.onError) h.onError(tp, err);
        }
      };
      parts.forEach((tp, i) => {
        links[i] = tp.connect(peerId, {
          onOpen: () => {
            if (done || winner !== -1) {
              if (winner !== i && links[i]) links[i].close();
              return;
            }
            winner = i;
            links.forEach((l, j) => {
              if (j !== i && l) l.close();
            });
            if (h.onOpen) h.onOpen();
          },
          onData: (m) => {
            if (!done && winner === i && h.onData) h.onData(m);
          },
          onClose: () => {
            if (winner === i) {
              if (!done) {
                done = true;
                if (h.onClose) h.onClose();
              }
            } else markFail(i, 'fechou');
          },
          onError: (type, err) => {
            if (winner === i) {
              if (!done) {
                done = true;
                if (h.onError) h.onError(type, err);
              }
            } else markFail(i, type, err);
          },
        });
      });
      return {
        send(msg) {
          if (done || winner === -1) return false;
          return links[winner].send(msg);
        },
        close() {
          done = true;
          links.forEach((l) => {
            try {
              if (l) l.close();
            } catch (e) {
              /* ignore */
            }
          });
        },
      };
    },
  };
}

export function peerTransport(peerOptions = {}) {
  const PeerCtor = () => (typeof globalThis !== 'undefined' ? globalThis.Peer : undefined);
  const opts = () => ({ debug: 1, ...peerOptions });
  return {
    available() {
      return typeof PeerCtor() === 'function';
    },
    listen(peerId, h) {
      const Peer = PeerCtor();
      const peer = new Peer(peerId, opts());
      let closed = false;
      peer.on('open', () => h.onReady && h.onReady());
      peer.on('connection', (c) => {
        const handlers = { data: [], close: [] };
        let gone = false;
        const conn = {
          id: c.peer,
          send(msg) {
            try {
              if (c.open) c.send(msg);
            } catch (e) {
              /* conexão caiu no meio do envio */
            }
          },
          close() {
            try {
              c.close();
            } catch (e) {
              /* ignore */
            }
          },
          on(ev, fn) {
            if (handlers[ev]) handlers[ev].push(fn);
          },
        };
        const fireClose = () => {
          if (gone) return;
          gone = true;
          handlers.close.forEach((fn) => fn());
        };
        c.on('data', (d) => handlers.data.forEach((fn) => fn(d)));
        c.on('close', fireClose);
        c.on('error', fireClose);
        const ready = () => h.onConnection && h.onConnection(conn);
        if (c.open) ready();
        else c.on('open', ready);
      });
      peer.on('disconnected', () => {
        // Perdeu o servidor de apresentação; as conexões já abertas continuam. Tenta voltar.
        if (closed) return;
        setTimeout(() => {
          try {
            if (!closed && !peer.destroyed && peer.disconnected) peer.reconnect();
          } catch (e) {
            /* ignore */
          }
        }, 1500);
      });
      peer.on('error', (err) => h.onError && h.onError((err && err.type) || 'erro', err));
      return {
        close() {
          closed = true;
          try {
            peer.destroy();
          } catch (e) {
            /* ignore */
          }
        },
      };
    },
    connect(peerId, h) {
      const Peer = PeerCtor();
      const peer = new Peer(undefined, opts());
      let c = null;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (h.onClose) h.onClose();
      };
      peer.on('open', () => {
        if (done) return;
        c = peer.connect(peerId, { reliable: true, serialization: 'json' });
        c.on('open', () => h.onOpen && h.onOpen());
        c.on('data', (d) => h.onData && h.onData(d));
        c.on('close', finish);
        c.on('error', () => finish());
      });
      peer.on('error', (err) => {
        if (done) return;
        if (h.onError) h.onError((err && err.type) || 'erro', err);
      });
      return {
        send(msg) {
          try {
            if (c && c.open) {
              c.send(msg);
              return true;
            }
          } catch (e) {
            /* ignore */
          }
          return false;
        },
        close() {
          done = true;
          try {
            peer.destroy();
          } catch (e) {
            /* ignore */
          }
        },
      };
    },
  };
}

/** Rede na memória, para testes. delay em ms (0 = próxima volta do loop). */
export function memoryTransport({ delay = 0 } = {}) {
  const hosts = new Map();
  const later = (fn) => setTimeout(fn, delay);
  const copy = (m) => JSON.parse(JSON.stringify(m));
  const net = {
    hosts,
    /** Derruba todas as conexões de um anfitrião (simula internet caindo). */
    dropAll(peerId) {
      const entry = hosts.get(peerId);
      if (!entry) return;
      for (const link of [...entry.links]) link.kill();
    },
    available() {
      return true;
    },
    listen(peerId, h) {
      if (hosts.has(peerId)) {
        later(() => h.onError && h.onError('unavailable-id'));
        return { close() {} };
      }
      const entry = { h, links: new Set(), closed: false };
      hosts.set(peerId, entry);
      later(() => !entry.closed && h.onReady && h.onReady());
      return {
        close() {
          entry.closed = true;
          if (hosts.get(peerId) === entry) hosts.delete(peerId);
          for (const link of [...entry.links]) link.kill();
        },
      };
    },
    connect(peerId, h) {
      let alive = true;
      let opened = false;
      const hostHandlers = { data: [], close: [] };
      let link = null;
      later(() => {
        if (!alive) return;
        const entry = hosts.get(peerId);
        if (!entry || entry.closed) {
          alive = false;
          if (h.onError) h.onError('peer-unavailable');
          return;
        }
        const hostSide = {
          id: 'mem-' + Math.random().toString(36).slice(2),
          send(msg) {
            if (!alive) return;
            const m = copy(msg);
            later(() => alive && h.onData && h.onData(m));
          },
          close() {
            link.kill();
          },
          on(ev, fn) {
            if (hostHandlers[ev]) hostHandlers[ev].push(fn);
          },
        };
        link = {
          hostSide,
          kill() {
            if (!alive) return;
            alive = false;
            entry.links.delete(link);
            later(() => {
              hostHandlers.close.forEach((fn) => fn());
              if (h.onClose) h.onClose();
            });
          },
        };
        entry.links.add(link);
        entry.h.onConnection(hostSide);
        later(() => {
          if (!alive) return;
          opened = true;
          if (h.onOpen) h.onOpen();
        });
      });
      return {
        send(msg) {
          if (!alive || !opened) return false;
          const m = copy(msg);
          later(() => alive && hostHandlers.data.forEach((fn) => fn(m)));
          return true;
        },
        close() {
          if (link) link.kill();
          alive = false;
        },
      };
    },
  };
  return net;
}

// Cliente MQTT 3.1.1 bem pequeno, sobre WebSocket, sem dependências.
// Serve para o "plano B" da conexão: um servidor público de mensagens (broker MQTT) que só repassa
// recados entre o celular do anfitrião e os outros. Só usa QoS 0 (o jogo reenvia o estado sozinho).
//
// connectMqtt(url, {
//   clientId,            // 1 a 23 letras/números
//   keepalive = 30,      // segundos
//   will,                // { topic, payload } recado que o broker publica se a conexão cair sem aviso
//   connectTimeout = 8000,
//   onConnect(), onMessage(topic, text), onClose(motivo),
//   WebSocketImpl,       // para testes no Node
// }) -> { connected, subscribe(topic, cb(ok)), publish(topic, text, retain), end() }

const te = new TextEncoder();
const td = new TextDecoder();

function concat(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
const u16 = (n) => Uint8Array.of((n >> 8) & 255, n & 255);
function mstr(s) {
  const b = typeof s === 'string' ? te.encode(s) : s;
  return concat([u16(b.length), b]);
}
function varint(n) {
  const out = [];
  do {
    let d = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) d |= 128;
    out.push(d);
  } while (n > 0);
  return Uint8Array.from(out);
}
const packet = (first, body) => concat([Uint8Array.of(first), varint(body.length), body]);

export function connectMqtt(url, opts = {}) {
  const {
    clientId,
    keepalive = 30,
    will = null,
    connectTimeout = 8000,
    onConnect,
    onMessage,
    onClose,
    WebSocketImpl,
  } = opts;
  const WS = WebSocketImpl || (typeof globalThis !== 'undefined' ? globalThis.WebSocket : undefined);
  let ws = null;
  let state = 'connecting'; // connecting | open | closed
  let buf = new Uint8Array(0);
  let nextId = 1;
  let lastIn = Date.now();
  let pingTimer = null;
  let openTimer = null;
  const pendingSubs = new Map();

  function send(bytes) {
    try {
      if (ws && ws.readyState === 1) {
        ws.send(bytes);
        return true;
      }
    } catch (e) {
      /* a conexão caiu no meio do envio */
    }
    return false;
  }

  function finish(reason) {
    if (state === 'closed') return;
    state = 'closed';
    clearInterval(pingTimer);
    clearTimeout(openTimer);
    for (const cb of pendingSubs.values()) {
      try {
        cb(false);
      } catch (e) {
        /* ignore */
      }
    }
    pendingSubs.clear();
    try {
      if (ws) {
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
        ws.close();
      }
    } catch (e) {
      /* ignore */
    }
    if (onClose) onClose(reason);
  }

  function handle(first, body) {
    const type = first >> 4;
    if (type === 2) {
      // CONNACK
      if (body.length < 2 || body[1] !== 0) return finish('recusado');
      state = 'open';
      clearTimeout(openTimer);
      lastIn = Date.now();
      const every = Math.max(2000, Math.floor((keepalive * 1000) / 2));
      pingTimer = setInterval(() => {
        if (state !== 'open') return;
        if (Date.now() - lastIn > keepalive * 1500) return finish('sem-resposta');
        send(Uint8Array.of(0xc0, 0)); // PINGREQ
      }, every);
      if (onConnect) onConnect();
    } else if (type === 3) {
      // PUBLISH
      const qos = (first >> 1) & 3;
      if (body.length < 2) return;
      const tlen = (body[0] << 8) | body[1];
      const topic = td.decode(body.subarray(2, 2 + tlen));
      let p = 2 + tlen;
      if (qos > 0) {
        const id = (body[p] << 8) | body[p + 1];
        p += 2;
        if (qos === 1) send(Uint8Array.of(0x40, 2, (id >> 8) & 255, id & 255)); // PUBACK
      }
      if (onMessage) onMessage(topic, td.decode(body.subarray(p)));
    } else if (type === 9) {
      // SUBACK
      const id = (body[0] << 8) | body[1];
      const cb = pendingSubs.get(id);
      pendingSubs.delete(id);
      if (cb) cb(body.length >= 3 && body[2] !== 0x80);
    }
    // PINGRESP (13) e outros: basta ter chegado (lastIn já foi atualizado)
  }

  function parse() {
    for (;;) {
      if (buf.length < 2) return;
      let mult = 1;
      let len = 0;
      let i = 1;
      let byte;
      do {
        if (i >= buf.length) return; // tamanho ainda incompleto
        byte = buf[i++];
        len += (byte & 127) * mult;
        mult *= 128;
        if (i > 5) return finish('protocolo');
      } while (byte & 128);
      if (buf.length < i + len) return; // pacote ainda incompleto
      const first = buf[0];
      const body = buf.slice(i, i + len);
      buf = buf.slice(i + len);
      handle(first, body);
      if (state === 'closed') return;
    }
  }

  const api = {
    get connected() {
      return state === 'open';
    },
    subscribe(topic, cb) {
      if (state !== 'open') {
        if (cb) cb(false);
        return;
      }
      const id = nextId;
      nextId = nextId >= 65535 ? 1 : nextId + 1;
      if (cb) pendingSubs.set(id, cb);
      const ok = send(packet(0x82, concat([u16(id), mstr(topic), Uint8Array.of(0)])));
      if (!ok && cb) {
        pendingSubs.delete(id);
        cb(false);
      }
    },
    publish(topic, text, retain = false) {
      if (state !== 'open') return false;
      return send(packet(0x30 | (retain ? 1 : 0), concat([mstr(topic), te.encode(String(text))])));
    },
    end() {
      if (state === 'open') send(Uint8Array.of(0xe0, 0)); // DISCONNECT
      finish('fim');
    },
  };

  if (typeof WS !== 'function') {
    setTimeout(() => finish('sem-websocket'), 0);
    return api;
  }
  try {
    ws = new WS(url, ['mqtt']);
    ws.binaryType = 'arraybuffer';
  } catch (e) {
    setTimeout(() => finish('erro'), 0);
    return api;
  }
  openTimer = setTimeout(() => finish('tempo'), connectTimeout);
  ws.onopen = () => {
    let flags = 0x02; // clean session
    const payload = [mstr(clientId)];
    if (will && will.topic) {
      flags |= 0x04; // will, QoS 0, sem retain
      payload.push(mstr(will.topic), mstr(te.encode(String(will.payload))));
    }
    const head = concat([mstr('MQTT'), Uint8Array.of(4, flags), u16(keepalive)]);
    send(packet(0x10, concat([head, ...payload])));
  };
  ws.onmessage = (ev) => {
    lastIn = Date.now();
    let data;
    if (ev.data instanceof ArrayBuffer) data = new Uint8Array(ev.data);
    else if (ArrayBuffer.isView(ev.data)) data = new Uint8Array(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength);
    else return; // texto não faz parte do MQTT
    buf = buf.length ? concat([buf, data]) : data;
    parse();
  };
  ws.onerror = () => {
    /* o onclose vem logo depois */
  };
  ws.onclose = () => finish('fechou');
  return api;
}

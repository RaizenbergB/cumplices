// Utilidades sem DOM (usadas pelo site e pelos testes).

export const PROTOCOL = 1;
export const PEER_PREFIX = 'cumplices-v1-';
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // sem I e O, para não confundir com 1 e 0

function cryptoObj() {
  try {
    if (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.getRandomValues) {
      return globalThis.crypto;
    }
  } catch (e) {
    /* sem crypto */
  }
  return null;
}

/** Número aleatório em [0, 1) usando crypto quando disponível. */
export function secureRandom() {
  const c = cryptoObj();
  if (c) {
    const buf = new Uint32Array(1);
    c.getRandomValues(buf);
    return buf[0] / 4294967296;
  }
  return Math.random();
}

export function randomId(len = 12) {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(secureRandom() * chars.length)];
  return s;
}

export function roomCode(rng = secureRandom) {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_LETTERS[Math.floor(rng() * CODE_LETTERS.length)];
  return s;
}

/** Aceita o que a pessoa digitou ("abcd", "ab cd", link com ?sala=) e devolve o código ou ''. */
export function normalizeCode(input) {
  if (!input) return '';
  let s = String(input);
  const m = s.match(/[?&]sala=([A-Za-z]{4})/);
  if (m) s = m[1];
  s = s.toUpperCase().replace(/[^A-Z]/g, '');
  return s.length === 4 ? s : '';
}

export function cleanName(name) {
  if (typeof name !== 'string') return '';
  return name.replace(/\s+/g, ' ').trim().slice(0, 16);
}

export function sameName(a, b) {
  const norm = (x) => cleanName(x).toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[̀-ͯ]/g, '');
  return norm(a) === norm(b);
}

export function initials(name) {
  const parts = cleanName(name).split(' ').filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Armazenamento seguro: nunca quebra se o navegador bloquear o localStorage. */
export function createStore(backend) {
  const NS = 'cumplices.';
  const get = () => {
    if (backend) return backend;
    try {
      return globalThis.localStorage || null;
    } catch (e) {
      return null;
    }
  };
  return {
    get(key, fallback = null) {
      try {
        const b = get();
        if (!b) return fallback;
        const v = b.getItem(NS + key);
        return v === null || v === undefined ? fallback : JSON.parse(v);
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        const b = get();
        if (b) b.setItem(NS + key, JSON.stringify(value));
      } catch (e) {
        /* sem espaço ou bloqueado: segue sem salvar */
      }
    },
    del(key) {
      try {
        const b = get();
        if (b) b.removeItem(NS + key);
      } catch (e) {
        /* ignore */
      }
    },
  };
}

export function memoryBackend() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

/** Pontos do "placar da noite": detetives vencedores +1, cúmplices vencedores +2. */
export function scoreGame(scoreboard, game) {
  const sb = { ...scoreboard };
  if (!game || !game.result || !game.result.winner) return sb;
  for (const p of game.players) {
    const isC = game.cumplices.includes(p.id);
    const won = (game.result.winner === 'cumplices') === isC;
    const prev = sb[p.id] || { name: p.name, pts: 0, games: 0 };
    sb[p.id] = { name: p.name, pts: prev.pts + (won ? (isC ? 2 : 1) : 0), games: prev.games + 1 };
  }
  return sb;
}

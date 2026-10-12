// Broker MQTT local (só para testes): MQTT sobre WebSocket em 127.0.0.1:<porta>.
// Uso: node test/mqtt-broker.mjs 8883
import { Aedes } from 'aedes';
import { createServer } from 'aedes-server-factory';

export async function startBroker(port = 0) {
  const aedes = await Aedes.createBroker();
  const server = createServer(aedes, { ws: true });
  await new Promise((ok) => server.listen(port, '127.0.0.1', ok));
  const clients = () => Object.values(aedes.clients);
  return {
    port: server.address().port,
    url: `ws://127.0.0.1:${server.address().port}/mqtt`,
    aedes,
    /** Derruba a conexão de todos os clientes cujo id começa com o prefixo (simula internet caindo). */
    drop(prefix = '') {
      for (const c of clients()) if (!prefix || (c.id || '').startsWith(prefix)) c.conn.destroy();
    },
    count: () => clients().length,
    async close() {
      for (const c of clients()) c.conn.destroy();
      await new Promise((ok) => server.close(() => ok()));
      await new Promise((ok) => aedes.close(() => ok()));
    },
  };
}

if (process.argv[1] && process.argv[1].endsWith('mqtt-broker.mjs')) {
  const b = await startBroker(Number(process.argv[2] || 8883));
  console.log('Broker MQTT local em ' + b.url);
}

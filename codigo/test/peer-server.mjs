import http from 'node:http';
import express from 'express';
import { ExpressPeerServer } from 'peer';
const port = Number(process.argv[2] || 9000);
const app = express();
const server = http.createServer(app);
app.use('/', ExpressPeerServer(server, { path: '/' }));
server.listen(port, '127.0.0.1', () => console.log('PeerServer on 127.0.0.1:' + port));

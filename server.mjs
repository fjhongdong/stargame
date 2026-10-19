import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { createArena, addPlayer, startRound, stepArena, snapshotArena, setPlayerInput, normalizeInput, chooseUpgrade } from './shared/engine.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const RECONNECT_GRACE = 30_000;

/**
 * Wire API: create/join/quick/ready/start/input/leave/ping.
 * Input x/y are a direction vector; boost/fire are booleans. All match state is
 * authoritative. Clients receive welcome, joined, state, left, pong, or error.
 * Reconnect with /ws?token=<reconnectToken> within 30 seconds.
 */
export function createRoomManager({ now = Date.now, broadcast = () => {}, random = Math.random } = {}) {
  const rooms = new Map();
  const playerRooms = new Map();
  const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const snapshot = room => ({ code: room.code, hostId: room.hostId, mode: room.mode,
    maxPlayers: 8, arena: { width: 1400, height: 900 }, ...snapshotArena(room.arena) });
  const publish = room => broadcast(snapshot(room));
  const find = id => rooms.get(playerRooms.get(id));
  const requireRoom = id => { const room = find(id); if (!room) throw new Error('请先加入一个房间'); return room; };
  const getCode = () => {
    let code;
    do { code = Array.from({ length: 6 }, () => characters[Math.floor(random() * characters.length)]).join(''); }
    while (rooms.has(code));
    return code;
  };
  function nextHost(room) {
    const humans = [...room.arena.players.values()].filter(p => !p.bot);
    const current = room.arena.players.get(room.hostId);
    if (current?.connected) return;
    const replacement = humans.find(p => p.connected) ?? humans[0];
    if (replacement) { room.hostId = replacement.id; replacement.ready = true; }
  }
  function leave(id) {
    const room = find(id);
    if (!room) return;
    room.arena.players.delete(id);
    playerRooms.delete(id);
    if (![...room.arena.players.values()].some(p => !p.bot)) { rooms.delete(room.code); return; }
    nextHost(room);
    publish(room);
  }
  function join(id, message = {}) {
    const code = typeof message.code === 'string' ? message.code.trim().toUpperCase() : '';
    const room = rooms.get(code);
    if (!room) throw new Error('找不到这个房间，请检查房间码');
    if (room.mode === 'practice') throw new Error('练习房间暂不接受其他玩家');
    if (room.arena.status === 'playing') throw new Error('对局已经开始，请等待下一局');
    if (room.arena.players.size >= 8) throw new Error('房间已满，最多容纳 8 人');
    if (find(id) === room) return room;
    leave(id);
    addPlayer(room.arena, { id, name: message.name, skin: message.skin });
    playerRooms.set(id, code);
    publish(room);
    return room;
  }
  function create(id, message = {}) {
    leave(id);
    const code = getCode();
    const room = { code, hostId: id, mode: message.mode === 'practice' ? 'practice' : 'online',
      arena: createArena({ random }), createdAt: now() };
    addPlayer(room.arena, { id, name: message.name, skin: message.skin, ready: true });
    rooms.set(code, room);
    playerRooms.set(id, code);
    if (room.mode === 'practice') {
      ['月球漫步者', '彗星来客', '银河小霸王', '土星巡游者'].forEach((name, i) =>
        addPlayer(room.arena, { id: `bot-${code}-${i}`, name, skin: (i + 1) % 4, bot: true, ready: true }));
      startRound(room.arena);
    }
    publish(room);
    return room;
  }
  function quick(id, message = {}) {
    const existing = [...rooms.values()].find(room => room.mode === 'online' && room.arena.status === 'lobby' && room.arena.players.size < 8);
    return existing ? join(id, { ...message, code: existing.code }) : create(id, message);
  }
  function ready(id, value) {
    const room = requireRoom(id);
    if (room.arena.status === 'playing') throw new Error('对局进行中');
    const player = room.arena.players.get(id);
    player.ready = typeof value === 'boolean' ? value : !player.ready;
    publish(room);
  }
  function start(id) {
    const room = requireRoom(id);
    if (room.hostId !== id) throw new Error('只有房主可以开始对局');
    if (room.arena.status === 'playing') throw new Error('对局已经开始');
    const active = [...room.arena.players.values()].filter(p => p.connected);
    if (active.length < 2) throw new Error('至少需要 2 位玩家才能开始');
    if (active.some(p => !p.bot && !p.ready)) throw new Error('等待所有玩家准备好');
    startRound(room.arena);
    publish(room);
  }
  function disconnect(id) {
    const room = find(id);
    const player = room?.arena.players.get(id);
    if (!player) return;
    player.connected = false;
    player.disconnectedAt = now();
    player.input = normalizeInput();
    player.fireQueued = player.splitQueued = player.ejectQueued = false;
    nextHost(room);
    publish(room);
  }
  function reconnect(id) {
    const room = find(id);
    const player = room?.arena.players.get(id);
    if (!player) return null;
    if (player.disconnectedAt && now() - player.disconnectedAt > RECONNECT_GRACE) { leave(id); return null; }
    player.connected = true;
    delete player.disconnectedAt;
    nextHost(room);
    publish(room);
    return room;
  }
  let frame = 0;
  function tick(dt = 1 / 30) {
    frame++;
    for (const room of rooms.values()) {
      for (const player of [...room.arena.players.values()]) {
        if (!player.bot && !player.connected && now() - player.disconnectedAt >= RECONNECT_GRACE) leave(player.id);
      }
      if (!rooms.has(room.code)) continue;
      const wasPlaying = room.arena.status === 'playing';
      stepArena(room.arena, dt);
      if (wasPlaying && room.arena.status === 'finished') {
        for (const player of room.arena.players.values()) player.ready = player.bot || player.id === room.hostId;
        publish(room);
      } else if (frame % 2 === 0 && room.arena.status === 'playing') publish(room);
    }
  }
  return { rooms, playerRooms, create, join, quick, ready, start, leave, disconnect, reconnect, tick, find, snapshot,
    input(id, input) { const room = find(id); if (room?.arena.status === 'playing') setPlayerInput(room.arena, id, input); },
    upgrade(id, upgradeId) { const room = requireRoom(id); chooseUpgrade(room.arena, id, upgradeId); publish(room); },
    stats() {
      const players = [...rooms.values()].flatMap(room => [...room.arena.players.values()]);
      return { rooms: rooms.size, players: players.filter(p => !p.bot && p.connected).length,
        playing: [...rooms.values()].filter(room => room.arena.status === 'playing').length };
    },
  };
}

export function createGameServer({ port = Number(process.env.PORT) || 3001, host = '0.0.0.0' } = {}) {
  const sessions = new Map();
  const tokens = new Map();
  const send = (session, message) => {
    if (session?.ws?.readyState === WebSocket.OPEN && session.ws.bufferedAmount < 1_000_000) session.ws.send(JSON.stringify(message));
  };
  const manager = createRoomManager({ broadcast(room) {
    for (const player of room.players) if (!player.bot) send(sessions.get(player.id), { type: 'state', room });
  } });
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2' };
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/api/health' || url.pathname === '/api/stats') {
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify({ ok: true, ...manager.stats() }));
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405); response.end(); return; }
      const pathname = decodeURIComponent(url.pathname);
      const shared = pathname.startsWith('/shared/');
      const base = path.resolve(ROOT, shared ? 'shared' : 'public');
      const relative = shared ? pathname.slice('/shared/'.length) : pathname.slice(1);
      const filename = path.resolve(base, relative || 'index.html');
      if (!filename.startsWith(base + path.sep)) { response.writeHead(403); response.end('Forbidden'); return; }
      const info = await stat(filename);
      if (!info.isFile()) { response.writeHead(404); response.end('Not found'); return; }
      const body = await readFile(filename);
      response.writeHead(200, { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream',
        'Content-Length': body.length, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch (error) {
      response.writeHead(error instanceof URIError ? 400 : 404);
      response.end('Not found');
    }
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  server.on('upgrade', (request, socket, head) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname !== '/ws') { socket.destroy(); return; }
      sockets.handleUpgrade(request, socket, head, ws => sockets.emit('connection', ws, request));
    } catch { socket.destroy(); }
  });
  sockets.on('connection', (ws, request) => {
    const requestedToken = new URL(request.url, 'http://localhost').searchParams.get('token');
    let session = sessions.get(tokens.get(requestedToken));
    if (session?.disconnectedAt && Date.now() - session.disconnectedAt > RECONNECT_GRACE) session = undefined;
    if (!session) {
      session = { id: randomUUID(), reconnectToken: randomBytes(24).toString('base64url'), ws: null,
        lastSeen: Date.now(), disconnectedAt: null, windowStarted: Date.now(), messages: 0 };
      sessions.set(session.id, session);
      tokens.set(session.reconnectToken, session.id);
    }
    const previousSocket = session.ws;
    session.ws = ws;
    session.lastSeen = Date.now();
    session.disconnectedAt = null;
    if (previousSocket && previousSocket !== ws) previousSocket.close(4001, 'Reconnected elsewhere');
    send(session, { type: 'welcome', id: session.id, reconnectToken: session.reconnectToken });
    const restored = manager.reconnect(session.id);
    if (restored) {
      send(session, { type: 'joined', id: session.id, code: restored.code, reconnectToken: session.reconnectToken });
      send(session, { type: 'state', room: manager.snapshot(restored) });
    }
    ws.on('pong', () => { session.lastSeen = Date.now(); });
    ws.on('message', data => {
      if (session.ws !== ws) return;
      const now = Date.now();
      session.lastSeen = now;
      if (now - session.windowStarted >= 1000) { session.windowStarted = now; session.messages = 0; }
      if (++session.messages > 120) { ws.close(1008, 'Too many messages'); return; }
      try {
        const message = JSON.parse(data.toString());
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('消息格式有误');
        switch (message.type) {
          case 'create': case 'join': case 'quick': {
            const room = manager[message.type](session.id, message);
            send(session, { type: 'joined', id: session.id, code: room.code, reconnectToken: session.reconnectToken });
            send(session, { type: 'state', room: manager.snapshot(room) });
            break;
          }
          case 'input': manager.input(session.id, message); break;
          case 'upgrade': manager.upgrade(session.id, message.upgradeId); break;
          case 'ready': manager.ready(session.id, message.ready); break;
          case 'start': case 'restart': manager.start(session.id); break;
          case 'leave': manager.leave(session.id); send(session, { type: 'left' }); break;
          case 'ping': send(session, { type: 'pong', time: message.time ?? now }); break;
          default: throw new Error('未知操作');
        }
      } catch (error) { send(session, { type: 'error', message: error instanceof SyntaxError ? '消息格式有误' : error.message }); }
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      if (session.ws !== ws) return;
      session.ws = null;
      session.disconnectedAt = Date.now();
      manager.disconnect(session.id);
    });
  });
  let lastTick = performance.now();
  const ticker = setInterval(() => {
    const now = performance.now();
    manager.tick(Math.min(0.1, (now - lastTick) / 1000));
    lastTick = now;
  }, 1000 / 30);
  const heartbeat = setInterval(() => {
    for (const session of sessions.values()) {
      if (session.ws && Date.now() - session.lastSeen > 45_000) session.ws.terminate();
      else if (session.ws?.readyState === WebSocket.OPEN) session.ws.ping();
      if (!session.ws && Date.now() - session.disconnectedAt > 60_000) {
        tokens.delete(session.reconnectToken);
        sessions.delete(session.id);
      }
    }
  }, 15_000);
  return { server, manager, sockets,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.removeListener('error', reject); resolve(server.address()); });
    }),
    close: async () => {
      clearInterval(ticker);
      clearInterval(heartbeat);
      for (const ws of sockets.clients) ws.terminate();
      await new Promise(resolve => sockets.close(resolve));
      await new Promise(resolve => server.close(resolve));
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const game = createGameServer();
  const address = await game.listen();
  console.log(`星球大爆炸 · http://localhost:${address.port}`);
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await game.close(); process.exit(0); });
}

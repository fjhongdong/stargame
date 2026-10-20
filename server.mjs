import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { ARENA, createArena, addPlayer, startRound, stepArena, snapshotArena, setPlayerInput, normalizeInput, chooseUpgrade } from './shared/engine.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const RECONNECT_GRACE = 30_000;
const MAX_STATE_BACKLOG = 128 * 1024;
const VIEWPORT_LIMITS = Object.freeze({ width: 4000, height: 2600, margin: 180 });

// Only the part of the world that a player can see needs to cross the network.
// The server supplies defaults for old clients and bounds untrusted dimensions.
function playerViewport(player, requested) {
  const number = (value, fallback) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const width = clamp(number(requested?.width, 1600), 320, VIEWPORT_LIMITS.width);
  const height = clamp(number(requested?.height, 1000), 240, VIEWPORT_LIMITS.height);
  const x = number(player?.x, ARENA.width / 2);
  const y = number(player?.y, ARENA.height / 2);
  return {
    x: clamp(number(requested?.x, x), Math.max(0, x - width / 2), Math.min(ARENA.width, x + width / 2)),
    y: clamp(number(requested?.y, y), Math.max(0, y - height / 2), Math.min(ARENA.height, y + height / 2)),
    width, height, margin: VIEWPORT_LIMITS.margin,
  };
}

function sameDust(a, b) {
  return a && a.x === b.x && a.y === b.y && a.vx === b.vx && a.vy === b.vy
    && a.value === b.value && a.fragment === b.fragment
    && a.color === b.color && a.ownerId === b.ownerId;
}

function prepareDustUpdate(session, snapshot) {
  if (!session.dustDeltas) return { room: snapshot, dustState: null };
  const key = `${snapshot.code}:${snapshot.round}`;
  const previous = session.dustState?.key === key ? session.dustState.dust : null;
  const current = new Map(snapshot.dust.map(dust => [dust.id, dust]));
  const changed = previous ? snapshot.dust.filter(dust => !sameDust(previous.get(dust.id), dust)) : null;
  const removed = previous ? [...previous.keys()].filter(id => !current.has(id)) : null;
  // Each snapshot belongs to a single recipient. Other clients and the room's
  // simulation keep their complete state; only the wire representation changes.
  return { room: previous ? { ...snapshot, dust: changed, dustDelta: true, dustRemoved: removed } : snapshot,
    dustState: { key, dust: current } };
}

/**
 * Wire API: create/join/quick/ready/start/input/leave/ping.
 * Input x/y are a direction vector; fire/rearFire/split are booleans. All match state is
 * authoritative. Clients receive welcome, joined, state, left, pong, or error.
 * Reconnect with /ws?token=<reconnectToken> within 30 seconds.
 */
export function createRoomManager({ now = Date.now, broadcast = () => {}, broadcastRoom, random = Math.random } = {}) {
  const rooms = new Map();
  const playerRooms = new Map();
  const viewports = new Map();
  let frame = 0;
  const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const snapshot = (room, viewport) => ({ code: room.code, hostId: room.hostId, mode: room.mode,
    maxPlayers: 8, arena: ARENA, serverTime: now(), tick: frame,
    ...snapshotArena(room.arena, viewport), ...(viewport ? { viewport } : {}) });
  const snapshotForPlayer = (room, id) => snapshot(room,
    playerViewport(room.arena.players.get(id), viewports.get(id)));
  // Production broadcasts consume the live room lazily: creating one full-world
  // snapshot here would defeat interest management before a client is selected.
  const publish = room => broadcastRoom ? broadcastRoom(room) : broadcast(snapshot(room));
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
    viewports.delete(id);
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
    const mode = message.mode === 'practice' ? 'practice' : 'online';
    const room = { code, hostId: id, mode,
      arena: createArena({ random, endless: mode === 'practice' }), createdAt: now() };
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
    player.fireQueued = player.rearFireQueued = player.splitQueued = false;
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
  function tick(dt = 1 / 30) {
    frame++;
    for (const room of rooms.values()) {
      for (const player of [...room.arena.players.values()]) {
        if (!player.bot && !player.connected && now() - player.disconnectedAt >= RECONNECT_GRACE) leave(player.id);
      }
      if (!rooms.has(room.code)) continue;
      // Keep a disconnected world available for reconnection without spending
      // simulation time on its bots and resources while nobody can observe it.
      // Expiration above still runs, and one connected human keeps play live.
      if (![...room.arena.players.values()].some(player => !player.bot && player.connected)) continue;
      const wasPlaying = room.arena.status === 'playing';
      stepArena(room.arena, dt);
      if (wasPlaying && room.arena.status === 'finished') {
        for (const player of room.arena.players.values()) player.ready = player.bot || player.id === room.hostId;
        publish(room);
      } else if (frame % 2 === 0 && room.arena.status === 'playing') publish(room);
    }
  }
  return { rooms, playerRooms, create, join, quick, ready, start, leave, disconnect, reconnect, tick, find, snapshot, snapshotForPlayer,
    input(id, input) {
      const room = find(id);
      if (room?.arena.status !== 'playing') return;
      if (input?.viewport && typeof input.viewport === 'object') {
        viewports.set(id, playerViewport(room.arena.players.get(id), input.viewport));
      }
      setPlayerInput(room.arena, id, input);
    },
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
    if (session?.ws?.readyState !== WebSocket.OPEN) return false;
    session.ws.send(JSON.stringify(message));
    return true;
  };
  const sendState = (session, room) => {
    // Replaceable states may be skipped, so a slow link never accumulates seconds
    // of stale movement. Control replies still use the reliable send path above.
    if (session?.ws?.readyState !== WebSocket.OPEN) return;
    if (session.ws.bufferedAmount >= MAX_STATE_BACKLOG) { session.pendingRoom = room; return; }
    const update = prepareDustUpdate(session, manager.snapshotForPlayer(room, session.id));
    if (send(session, { type: 'state', room: update.room })) {
      session.dustState = update.dustState;
      session.pendingRoom = null;
    }
  };
  const manager = createRoomManager({ broadcastRoom(room) {
    for (const player of room.arena.players.values()) if (!player.bot) sendState(sessions.get(player.id), room);
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
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 4096,
    perMessageDeflate: { threshold: 1024, serverNoContextTakeover: true, clientNoContextTakeover: true,
      concurrencyLimit: 4, zlibDeflateOptions: { level: 1 } },
  });
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
    session.dustDeltas = false;
    session.dustState = null;
    session.pendingRoom = null;
    if (previousSocket && previousSocket !== ws) previousSocket.close(4001, 'Reconnected elsewhere');
    send(session, { type: 'welcome', id: session.id, reconnectToken: session.reconnectToken });
    const restored = manager.reconnect(session.id);
    if (restored) {
      send(session, { type: 'joined', id: session.id, code: restored.code, reconnectToken: session.reconnectToken });
      sendState(session, restored);
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
            session.dustState = null;
            const room = manager[message.type](session.id, message);
            send(session, { type: 'joined', id: session.id, code: room.code, reconnectToken: session.reconnectToken });
            sendState(session, room);
            break;
          }
          case 'input':
            if (message.dustDeltas === true || message.supportsDustDelta === true) session.dustDeltas = true;
            manager.input(session.id, message);
            break;
          case 'upgrade': manager.upgrade(session.id, message.upgradeId); break;
          case 'ready': manager.ready(session.id, message.ready); break;
          case 'start': case 'restart': manager.start(session.id); break;
          case 'leave':
            manager.leave(session.id);
            session.dustState = session.pendingRoom = null;
            send(session, { type: 'left' });
            break;
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
    // A lobby/final result has no continuous publication. Keep just one pending
    // live room reference so it is eventually refreshed after congestion clears.
    for (const session of sessions.values()) if (session.pendingRoom) {
      if (manager.find(session.id) === session.pendingRoom) sendState(session, session.pendingRoom);
      else session.pendingRoom = null;
    }
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

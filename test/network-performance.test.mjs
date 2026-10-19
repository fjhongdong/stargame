import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { ARENA } from '../shared/engine.js';
import { createGameServer, createRoomManager } from '../server.mjs';

function populateWorld(room) {
  room.arena.dust = Array.from({ length: 6000 }, (_, index) => ({
    id: `bandwidth-${index}`, x: ((index % 100) + 0.5) * ARENA.width / 100,
    y: (Math.floor(index / 100) + 0.5) * ARENA.height / 60, value: 1,
  }));
}

function client(url) {
  const ws = new WebSocket(url);
  const messages = [];
  const pending = new Set();
  ws.on('message', bytes => {
    const message = JSON.parse(bytes.toString());
    messages.push(message);
    for (const request of pending) if (request.filter(message)) {
      clearTimeout(request.timeout);
      pending.delete(request);
      request.resolve(message);
    }
  });
  return {
    ws,
    send(message) { ws.send(JSON.stringify(message)); },
    wait(filter) {
      const existing = messages.find(filter);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const request = { filter, resolve, timeout: setTimeout(() => {
          pending.delete(request);
          reject(new Error('Timed out waiting for viewport state'));
        }, 4000) };
        pending.add(request);
      });
    },
  };
}

test('large-world snapshots send nearby dust while retaining the leaderboard', () => {
  const manager = createRoomManager();
  const room = manager.create('local', { mode: 'practice' });
  populateWorld(room);
  const player = room.arena.players.get('local');
  player.x = ARENA.width / 2;
  player.y = ARENA.height / 2;
  manager.input('local', { x: 0, y: 0, seq: 1, viewport: {
    x: player.x, y: player.y, width: 1600, height: 1000,
  } });
  const snapshot = manager.snapshotForPlayer(room, 'local');
  assert.equal(snapshot.dustTotal, 6000);
  assert.ok(snapshot.dust.length > 30, 'nearby food remains visible');
  assert.ok(snapshot.dust.length < 600, 'most distant food stays off the wire');
  assert.equal(snapshot.players.length, 5, 'all player stats remain available for the leaderboard');
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 65_536, 'normal snapshots fit in 64 KiB before compression');
  for (const dust of snapshot.dust) {
    assert.ok(Math.abs(dust.x - snapshot.viewport.x) <= 980);
    assert.ok(Math.abs(dust.y - snapshot.viewport.y) <= 680);
  }
  assert.deepEqual(snapshot.arena, ARENA);
});

test('viewport bounds stop a client from requesting the entire enlarged world', () => {
  const manager = createRoomManager();
  const room = manager.create('local', { mode: 'practice' });
  populateWorld(room);
  const player = room.arena.players.get('local');
  player.x = ARENA.width / 2;
  player.y = ARENA.height / 2;
  manager.input('local', { x: 0, y: 0, viewport: {
    x: 1e99, y: -1e99, width: 1e99, height: 1e99, margin: 1e99,
  } });
  const snapshot = manager.snapshotForPlayer(room, 'local');
  assert.equal(snapshot.viewport.width, 4000);
  assert.equal(snapshot.viewport.height, 2600);
  assert.equal(snapshot.viewport.margin, 180);
  assert.ok(Math.abs(snapshot.viewport.x - player.x) <= 2000);
  assert.ok(Math.abs(snapshot.viewport.y - player.y) <= 1300);
  assert.ok(snapshot.dust.length < 1000);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 150_000);
});

test('WebSocket states acknowledge applied input and keep distant dust off the wire', async () => {
  const game = createGameServer({ port: 0, host: '127.0.0.1' });
  const address = await game.listen();
  const connection = client(`ws://127.0.0.1:${address.port}/ws`);
  try {
    const welcome = await connection.wait(message => message.type === 'welcome');
    connection.send({ type: 'create', mode: 'practice', name: '网络测试' });
    await connection.wait(message => message.type === 'joined');
    const room = game.manager.find(welcome.id);
    populateWorld(room);
    const player = room.arena.players.get(welcome.id);
    connection.send({ type: 'input', seq: 101, x: 1, y: 0,
      viewport: { x: player.x, y: player.y, width: 1600, height: 1000 } });
    const state = await connection.wait(message => message.type === 'state'
      && message.room.players.find(entry => entry.id === welcome.id)?.lastInputSeq === 101);
    assert.ok(state.room.tick > 0);
    assert.ok(state.room.serverTime > 0);
    assert.ok(state.room.dust.length < state.room.dustTotal / 5);
    assert.match(connection.ws.extensions, /permessage-deflate/);

    connection.send({ type: 'input', seq: 100, x: -1, y: 0 });
    connection.send({ type: 'ping', time: 'stale-input-received' });
    await connection.wait(message => message.type === 'pong' && message.time === 'stale-input-received');
    assert.equal(player.input.x, 1, 'a delayed older input cannot reverse the latest movement');
    assert.equal(player.lastInputSeq, 101);

    const serverSocket = [...game.sockets.clients][0];
    const sentTypes = [];
    const originalSend = serverSocket.send;
    serverSocket.send = function (payload, ...options) {
      sentTypes.push(JSON.parse(payload).type);
      return originalSend.call(this, payload, ...options);
    };
    Object.defineProperty(serverSocket, 'bufferedAmount', { configurable: true, get: () => 200_000 });
    game.manager.tick();
    game.manager.tick();
    connection.send({ type: 'ping', time: 'backpressure-control-reply' });
    await connection.wait(message => message.type === 'pong' && message.time === 'backpressure-control-reply');
    assert.deepEqual(sentTypes, ['pong'], 'slow connections skip stale states while control replies remain reliable');
    delete serverSocket.bufferedAmount;
    serverSocket.send = originalSend;
    game.manager.tick();
    game.manager.tick();
    await connection.wait(message => message.type === 'state' && message.room.tick > state.room.tick + 2);
  } finally {
    connection.ws.terminate();
    await game.close();
  }
});

test('opt-in dust deltas transmit changes and removals, then reconnect with a complete baseline', async () => {
  const game = createGameServer({ port: 0, host: '127.0.0.1' });
  const address = await game.listen();
  const endpoint = `ws://127.0.0.1:${address.port}/ws`;
  const connection = client(endpoint);
  let restored;
  try {
    const welcome = await connection.wait(message => message.type === 'welcome');
    connection.send({ type: 'create', name: '增量测试' });
    await connection.wait(message => message.type === 'joined');
    const room = game.manager.find(welcome.id);
    populateWorld(room);
    const player = room.arena.players.get(welcome.id);
    player.x = ARENA.width / 2;
    player.y = ARENA.height / 2;
    connection.send({ type: 'input', dustDeltas: true });
    connection.send({ type: 'ping', time: 'delta-opt-in' });
    await connection.wait(message => message.type === 'pong' && message.time === 'delta-opt-in');
    game.manager.ready(welcome.id, false);
    const baseline = await connection.wait(message => message.type === 'state' && !message.room.players[0].ready);
    assert.notEqual(baseline.room.dustDelta, true, 'the first opt-in frame supplies a complete baseline');
    const [stationary, moved, removed] = baseline.room.dust.slice(20, 23);
    assert.ok(stationary && moved && removed);
    room.arena.dust = room.arena.dust.filter(dust => dust.id !== removed.id);
    room.arena.dust.find(dust => dust.id === moved.id).x += 7;
    room.arena.dust.push({ id: 'delta-new', x: player.x + 25, y: player.y + 30, value: 1 });
    game.manager.ready(welcome.id, true);
    const delta = await connection.wait(message => message.type === 'state' && message.room.dustDelta
      && message.room.dustRemoved.includes(removed.id));
    assert.deepEqual(delta.room.dustRemoved, [removed.id]);
    assert.equal(delta.room.dust.find(dust => dust.id === moved.id)?.x, moved.x + 7);
    assert.ok(delta.room.dust.some(dust => dust.id === 'delta-new'));
    assert.ok(!delta.room.dust.some(dust => dust.id === stationary.id), 'stationary dust is not repeatedly transmitted');
    assert.equal(delta.room.dust.length, 2);

    const serverSocket = [...game.sockets.clients][0];
    Object.defineProperty(serverSocket, 'bufferedAmount', { configurable: true, get: () => 200_000 });
    room.arena.dust = room.arena.dust.filter(dust => dust.id !== 'delta-new');
    game.manager.ready(welcome.id, false); // This publication is skipped, including its delta cache update.
    delete serverSocket.bufferedAmount;
    await connection.wait(message => message.type === 'state' && message.room.dustDelta
      && message.room.dustRemoved.includes('delta-new'));

    connection.ws.terminate();
    restored = client(`${endpoint}?token=${welcome.reconnectToken}`);
    const reconnect = await restored.wait(message => message.type === 'state');
    assert.notEqual(reconnect.room.dustDelta, true);
    assert.ok(reconnect.room.dust.some(dust => dust.id === stationary.id));
    assert.equal(reconnect.room.dust.find(dust => dust.id === moved.id)?.x, moved.x + 7);
    assert.ok(!reconnect.room.dust.some(dust => dust.id === removed.id || dust.id === 'delta-new'));
  } finally {
    connection.ws.terminate();
    restored?.ws.terminate();
    await game.close();
  }
});

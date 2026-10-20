import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createGameServer } from '../server.mjs';

function client(url) {
  const ws = new WebSocket(url), messages = [], waiters = new Set();
  ws.on('message', bytes => {
    const message = JSON.parse(bytes.toString()); messages.push(message);
    for (const waiter of waiters) if (waiter.predicate(message)) {
      clearTimeout(waiter.timer); waiters.delete(waiter); waiter.resolve(message);
    }
  });
  return { ws, messages, send(message) { ws.send(JSON.stringify(message)); }, wait(predicate) {
    const existing = messages.find(predicate); if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: setTimeout(() => {
        waiters.delete(waiter); reject(new Error('Timed out waiting for a real wave cancellation state'));
      }, 4000) }; waiters.add(waiter);
    });
  } };
}

test('real WebSocket cancellation removes both waves together and survives skipped states and reconnect', async () => {
  const game = createGameServer({ port: 0, host: '127.0.0.1' }), address = await game.listen();
  const endpoint = `ws://127.0.0.1:${address.port}/ws`, a = client(endpoint), b = client(endpoint);
  let restored, blocked;
  try {
    const [welcomeA, welcomeB] = await Promise.all([a.wait(m => m.type === 'welcome'), b.wait(m => m.type === 'welcome')]);
    a.send({ type: 'create', name: '左侧前波' }); const joined = await a.wait(m => m.type === 'joined');
    b.send({ type: 'join', code: joined.code, name: '右侧后波' }); await b.wait(m => m.type === 'joined');
    b.send({ type: 'ready', ready: true });
    await a.wait(m => m.type === 'state' && m.room.players.length === 2 && m.room.players.every(p => p.ready));
    a.send({ type: 'start' }); await a.wait(m => m.type === 'state' && m.room.status === 'playing');
    const room = game.manager.find(welcomeA.id);
    room.arena.random = () => .99;
    room.arena.dust = Array.from({ length: 6000 }, (_, id) => ({ id: `far-${id}`, x: 11000, y: 7000, value: 1, vx: 0, vy: 0 }));
    for (const [id, x] of [[welcomeA.id, 1000], [welcomeB.id, 1400]]) {
      const p = room.arena.players.get(id);
      Object.assign(p, { x, y: 4000, mass: 36, radius: 24, invulnerable: 0, direction: { x: 1, y: 0 } });
      Object.assign(p.cells[0], { x, y: 4000, mass: 36, radius: 24, vx: 0, vy: 0 });
    }
    a.send({ type: 'input', seq: 101, fire: true }); b.send({ type: 'input', seq: 101, rearFire: true });
    const launched = await a.wait(m => m.type === 'state' && m.room.blasts.length === 2);
    assert.deepEqual(new Set(launched.room.blasts.map(wave => wave.mode)), new Set(['forward', 'rear']));
    const waveIds = launched.room.blasts.map(wave => wave.id).sort();
    const serverA = [...game.sockets.clients].find(socket => socket._socket.remotePort === a.ws._socket.localPort);
    assert.ok(serverA, 'backpressure must affect the actual peer of the first client');
    // A link may miss the exact clash frame under ordinary backpressure. The
    // next authoritative state must still carry the event and remove both arcs.
    blocked = serverA;
    Object.defineProperty(blocked, 'bufferedAmount', { configurable: true, get: () => 200_000 });
    const clash = await b.wait(m => m.type === 'state' && m.room.waveClashes?.length > 0);
    const event = clash.room.waveClashes[0];
    assert.ok(!a.messages.some(m => m.type === 'state' && m.room.waveClashes?.some(item => item.id === event.id)), 'the blocked client must genuinely miss the original cancellation publication');
    assert.deepEqual([...event.waveIds].sort(), waveIds);
    assert.deepEqual(new Set(event.ownerIds), new Set([welcomeA.id, welcomeB.id]));
    assert.ok([event.at, event.x, event.y, event.radius].every(Number.isFinite));
    assert.ok(event.x > 1100 && event.x < 1300);
    for (const id of waveIds) assert.ok(!clash.room.blasts.some(wave => wave.id === id), 'the event frame must remove both cancelled waves together');
    assert.ok(clash.room.players.every(player => player.mass === 36 && player.lastWaveHit === null),
      `cancelled waves must not continue to hit their opponents: ${JSON.stringify(clash.room.players.map(player => ({ mass: player.mass, hit: player.lastWaveHit })))}`);
    for (let tick = 0; tick < 3; tick++) game.manager.tick(.1);
    delete blocked.bufferedAmount; blocked = null;
    const recovered = await a.wait(m => m.type === 'state' && m.room.tick > clash.room.tick
      && m.room.waveClashes?.some(item => item.id === event.id));
    assert.ok(recovered.room.time > clash.room.time);
    for (const id of waveIds) assert.ok(!recovered.room.blasts.some(wave => wave.id === id));

    a.ws.terminate(); await once(a.ws, 'close');
    restored = client(`${endpoint}?token=${encodeURIComponent(welcomeA.reconnectToken)}`);
    const baseline = await restored.wait(m => m.type === 'state' && m.room.waveClashes?.some(item => item.id === event.id));
    assert.equal(baseline.room.code, joined.code);
    assert.equal(baseline.room.waveClashes.filter(item => item.id === event.id).length, 1);
    for (const id of waveIds) assert.ok(!baseline.room.blasts.some(wave => wave.id === id));
  } finally {
    if (blocked) delete blocked.bufferedAmount;
    a.ws.terminate(); b.ws.terminate(); restored?.ws.terminate(); await game.close();
  }
});

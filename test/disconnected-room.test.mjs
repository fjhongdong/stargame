import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createGameServer, createRoomManager } from '../server.mjs';
import { METEOR, snapshotArena } from '../shared/engine.js';

function seeded() {
  let seed = 271828;
  return () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 2 ** 32);
}

function client(url) {
  const ws = new WebSocket(url), messages = [], waiters = new Set();
  ws.on('message', bytes => {
    const message = JSON.parse(bytes.toString()); messages.push(message);
    for (const waiter of waiters) if (waiter.predicate(message)) {
      clearTimeout(waiter.timer); waiters.delete(waiter); waiter.resolve(message);
    }
  });
  return { ws, send: message => ws.send(JSON.stringify(message)),
    wait(predicate) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: setTimeout(() => {
          waiters.delete(waiter); reject(new Error('Timed out waiting for room state'));
        }, 4000) };
        waiters.add(waiter);
      });
    },
  };
}

test('unobserved practice freezes its existing world while connected rooms and reconnect expiry continue', () => {
  let now = 1000;
  const publications = [], manager = createRoomManager({ now: () => now, random: seeded(),
    broadcastRoom: room => publications.push(room.code) });
  const sleeping = manager.create('absent', { mode: 'practice' });
  const live = manager.create('host'); manager.join('guest', { code: live.code });
  manager.ready('guest', true); manager.start('host');
  manager.disconnect('guest'); manager.disconnect('absent');
  const frozen = snapshotArena(sleeping.arena), liveTime = live.arena.time;
  assert.equal(sleeping.arena.dust.length, 6000);
  assert.equal(sleeping.arena.meteors.length, METEOR.count);
  publications.length = 0;
  for (let i = 0; i < 90; i++) { now += 1000 / 30; manager.tick(1 / 30); }
  assert.deepEqual(snapshotArena(sleeping.arena), frozen, 'bots, resources, input ages and simulation clock remain frozen together');
  assert.ok(live.arena.time > liveTime + 2.9, 'a room with one remaining human keeps simulating');
  assert.ok(publications.includes(live.code));
  assert.ok(!publications.includes(sleeping.code), 'sleeping rooms do not generate state publications');

  assert.equal(manager.reconnect('absent'), sleeping);
  assert.equal(sleeping.arena.time, frozen.time);
  assert.deepEqual(snapshotArena(sleeping.arena).meteors, frozen.meteors, 'reconnect retains the same meteor IDs and positions');
  manager.tick(1 / 30);
  assert.ok(sleeping.arena.time > frozen.time);
  manager.disconnect('absent'); now += 30_001; manager.tick(1 / 30);
  assert.equal(manager.find('absent'), undefined, 'wall-clock reconnect cleanup continues even while simulation sleeps');
  assert.ok(!manager.rooms.has(sleeping.code));
});

test('real WebSocket disconnect pauses practice and reconnect resumes its retained world without pausing another client', async () => {
  const game = createGameServer({ port: 0, host: '127.0.0.1' }), address = await game.listen();
  const endpoint = `ws://127.0.0.1:${address.port}/ws`, a = client(endpoint), b = client(endpoint);
  let restored;
  try {
    const [welcomeA, welcomeB] = await Promise.all([a.wait(m => m.type === 'welcome'), b.wait(m => m.type === 'welcome')]);
    a.send({ type: 'create', mode: 'practice' }); b.send({ type: 'create', mode: 'practice' });
    await Promise.all([a.wait(m => m.type === 'joined'), b.wait(m => m.type === 'joined')]);
    const sleeping = game.manager.find(welcomeA.id), live = game.manager.find(welcomeB.id);
    const closed = new Promise(resolve => a.ws.once('close', resolve)); a.ws.close(); await closed;
    await b.wait(m => m.type === 'state' && !sleeping.arena.players.get(welcomeA.id).connected);
    const frozen = snapshotArena(sleeping.arena), liveTime = live.arena.time;
    await b.wait(m => m.type === 'state' && m.room.time > liveTime + .25);
    assert.deepEqual(snapshotArena(sleeping.arena), frozen);
    assert.ok(live.arena.time > liveTime + .25);
    restored = client(`${endpoint}?token=${encodeURIComponent(welcomeA.reconnectToken)}`);
    const welcome = await restored.wait(m => m.type === 'welcome');
    assert.equal(welcome.id, welcomeA.id);
    const baseline = await restored.wait(m => m.type === 'state');
    assert.equal(baseline.room.code, sleeping.code);
    assert.equal(baseline.room.simulationTime, frozen.simulationTime, 'the first reconnect packet is the retained world, without catch-up');
    assert.notEqual(baseline.room.dustDelta, true);
    const resumed = await restored.wait(m => m.type === 'state' && m.room.simulationTime > frozen.simulationTime + 60);
    const oldMeteors = new Map(frozen.meteors.map(meteor => [meteor.id, meteor]));
    assert.ok(resumed.room.meteors.some(meteor => {
      const previous = oldMeteors.get(meteor.id);
      return previous && Math.hypot(meteor.x - previous.x, meteor.y - previous.y) > 1;
    }), 'the retained meteor trajectories resume advancing on regular ticks');
  } finally {
    a.ws.terminate(); b.ws.terminate(); restored?.ws.terminate(); await game.close();
  }
});

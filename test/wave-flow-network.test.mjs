import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createGameServer } from '../server.mjs';
import { DUST_COUNT, METEOR } from '../shared/engine.js';

function peer(url) {
  const ws = new WebSocket(url), messages = [], waiting = new Set(), dust = new Map();
  ws.on('message', bytes => {
    const message = JSON.parse(bytes.toString());
    if (message.type === 'state') {
      if (!message.room.dustDelta) dust.clear();
      for (const id of message.room.dustRemoved || []) dust.delete(id);
      for (const item of message.room.dust || []) dust.set(item.id, item);
    }
    messages.push(message);
    for (const item of waiting) if (item.predicate(message)) {
      clearTimeout(item.timer); waiting.delete(item); item.resolve(message);
    }
  });
  return { ws, dust, send(value) { ws.send(JSON.stringify(value)); }, wait(predicate) {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const item = { predicate, resolve, timer: setTimeout(() => {
        waiting.delete(item); reject(new Error('Timed out waiting for wave resource / Dyson exit state'));
      }, 5000) };
      waiting.add(item);
    });
  } };
}

const own = (message, id) => message.room.players.find(player => player.id === id);

async function fixture(mass, targetX, targetY = 4000) {
  const game = createGameServer({ port: 0, host: '127.0.0.1' }), address = await game.listen();
  const url = `ws://127.0.0.1:${address.port}/ws`, a = peer(url), b = peer(url);
  const [wa, wb] = await Promise.all([a.wait(m => m.type === 'welcome'), b.wait(m => m.type === 'welcome')]);
  a.send({ type: 'create' }); const joined = await a.wait(m => m.type === 'joined');
  b.send({ type: 'join', code: joined.code }); await b.wait(m => m.type === 'joined');
  b.send({ type: 'ready', ready: true });
  await a.wait(m => m.type === 'state' && m.room.players.length === 2 && m.room.players.every(p => p.ready));
  a.send({ type: 'start' }); await a.wait(m => m.type === 'state' && m.room.status === 'playing');
  const room = game.manager.find(wa.id), arena = room.arena;
  const source = arena.players.get(wa.id), target = arena.players.get(wb.id);
  arena.random = () => .99;
  arena.dust = Array.from({ length: DUST_COUNT }, (_, i) => ({ id: `far-${i}`, x: 11000, y: 7000, value: 1, vx: 0, vy: 0 }));
  arena.meteors = Array.from({ length: METEOR.count }, (_, i) => ({ id: `far-m-${i}`, x: 1000 + i * 3,
    y: 1000, vx: 180, vy: 0, radius: 3, tailLength: 40, color: '#ffbd68', bornAt: arena.time }));
  arena.meteorsInitialized = true;
  for (const [p, x, y, value] of [[source, 6000, 4000, mass], [target, targetX, targetY, 36]]) {
    Object.assign(p, { x, y, mass: value, radius: 4 * Math.sqrt(value), energy: 100, score: 0,
      invulnerable: 0, cooldown: 0, direction: { x: 1, y: 0 } });
    Object.assign(p.cells[0], { x, y, mass: value, radius: p.radius, vx: 0, vy: 0,
      protectedFor: 0, shatterCooldown: 0, mergeIn: 0 });
  }
  let seq = 0;
  const command = (client, input = {}) => {
    const next = ++seq; client.send({ type: 'input', seq: next, ...input }); return next;
  };
  const ack = (client, id, number) => client.wait(m => m.type === 'state' && own(m, id)?.lastInputSeq === number);
  return { game, arena, a, b, source, target, command, ack,
    async close() { a.ws.terminate(); b.ws.terminate(); await game.close(); } };
}

test('both delta clients remove swept stardust and see mass credit on the original source, with launch-size geometry retained', async () => {
  const f = await fixture(144, 6500, 4300);
  try {
    const { a, b, arena, source, target, command, ack } = f;
    source.stats.growth = 1.2;
    arena.dust.push({ id: 'wave-natural', x: 6250, y: 4000, value: 3, vx: 0, vy: 0 });
    arena.dust.push({ id: 'wave-free-fragment', x: 6250, y: 4002, value: 5, fragment: true, vx: 0, vy: 0 });
    await ack(a, source.id, command(a, { dustDeltas: true }));
    await ack(b, target.id, command(b, { dustDeltas: true }));
    assert.ok(a.dust.has('wave-natural') && b.dust.has('wave-natural'));
    const launched = await ack(a, source.id, command(a, { fire: true }));
    const front = launched.room.blasts.find(w => w.ownerId === source.id);
    assert.ok(front); assert.equal(front.sourceRadius, 48);
    assert.equal(front.width, 84); assert.equal(front.thickness, 12); assert.equal(front.curvature, 8);
    assert.equal(front.width + front.thickness, front.sourceRadius * 2);
    const collected = await a.wait(m => m.type === 'state' && own(m, source.id)?.mass >= 147.6
      && m.room.dustRemoved?.includes('wave-natural'));
    const sameTick = await b.wait(m => m.type === 'state' && m.room.tick === collected.room.tick);
    assert.equal(own(collected, source.id).mass, 147.6);
    assert.equal(own(sameTick, source.id).mass, 147.6);
    assert.equal(own(collected, source.id).score, 6);
    assert.equal(own(collected, target.id).mass, 36);
    assert.ok(!a.dust.has('wave-natural') && !b.dust.has('wave-natural'));
    assert.ok(a.dust.has('wave-free-fragment') && b.dust.has('wave-free-fragment'));
    const laterFront = collected.room.blasts.find(w => w.id === front.id);
    assert.ok(laterFront); assert.equal(laterFront.width, front.width);
    assert.equal(laterFront.sourceRadius, 48, 'collecting while flying does not resize a launched front');
    const expired = await a.wait(m => m.type === 'state' && m.room.tick > collected.room.tick
      && !m.room.blasts.some(w => w.id === front.id));
    await b.wait(m => m.type === 'state' && m.room.tick === expired.room.tick);
    assert.equal(own(expired, source.id).mass, 147.6);
    assert.ok(!a.dust.has('wave-natural') && !b.dust.has('wave-natural'), 'later deltas never resurrect harvested dust');
    assert.ok(arena.dust.some(d => d.id === 'wave-free-fragment'));
  } finally { await f.close(); }
});

test('early Dyson exit is public, locks direction, keeps cooldown, and requires a new post-return press to split', async () => {
  const f = await fixture(72, 6210);
  try {
    const { a, b, source, target, command, ack } = f;
    command(a, { fire: true });
    await a.wait(m => m.type === 'state' && own(m, source.id)?.dysonReady);
    await ack(a, source.id, command(a));
    const active = await ack(a, source.id, command(a, { split: true }));
    const shell = own(active, source.id).dyson;
    assert.ok(shell); assert.equal(shell.canExitAt, shell.startedAt + .6);
    const deadline = source._dysonCooldownUntil;
    await ack(a, source.id, command(a));
    const premature = await ack(a, source.id, command(a, { split: true }));
    assert.ok(premature.room.simulationTime / 1000 < shell.canExitAt);
    assert.equal(own(premature, source.id).dyson.exitRequestedAt, null);
    const held = await a.wait(m => m.type === 'state' && m.room.simulationTime / 1000 >= shell.canExitAt + .05);
    assert.equal(own(held, source.id).dyson.exitRequestedAt, null, 'holding an early press cannot automatically request exit');
    await ack(a, source.id, command(a));
    const requested = await ack(a, source.id, command(a, { split: true, y: -1 }));
    const winding = own(requested, source.id).dyson;
    assert.ok(winding.exitPreview); assert.equal(winding.exitDirectionX, 0); assert.equal(winding.exitDirectionY, -1);
    assert.ok(Math.abs(winding.exitAt - winding.exitRequestedAt - .3) < 1e-8);
    assert.ok(winding.exitPreview.y < own(requested, target.id).cells[0].y);
    const victimView = await b.wait(m => m.type === 'state' && m.room.tick === requested.room.tick);
    assert.deepEqual(own(victimView, source.id).dyson.exitPreview, winding.exitPreview);
    const turned = await ack(a, source.id, command(a, { split: true, y: 1 }));
    assert.equal(own(turned, source.id).dyson.exitDirectionY, -1, 'later steering cannot hide a different exit side');
    const returned = await a.wait(m => m.type === 'state' && own(m, source.id)?.lastDysonEnd?.id === shell.id && !own(m, source.id).dyson);
    const restored = own(returned, source.id);
    assert.equal(restored.lastDysonEnd.reason, 'early-exit');
    assert.ok(Math.abs(restored.lastDysonEnd.at - winding.exitAt) < 1e-8);
    assert.equal(restored.cells.length, 1); assert.ok(restored.dysonCooldown > 6);
    assert.equal(source._dysonCooldownUntil, deadline);
    const stillHeld = await ack(a, source.id, command(a, { split: true }));
    assert.equal(own(stillHeld, source.id).cells.length, 1);
    await ack(a, source.id, command(a));
    const split = await ack(a, source.id, command(a, { split: true, y: -1 }));
    assert.equal(own(split, source.id).cells.length, 2, 'a fresh press after actual return can launch the next ordinary split');
    assert.ok(own(split, source.id).cells.every(c => !c.dysonId));
  } finally { await f.close(); }
});

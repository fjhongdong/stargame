import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createGameServer } from '../server.mjs';
import { METEOR, DUST_COUNT } from '../shared/engine.js';

function client(url) {
  const ws = new WebSocket(url), messages = [], pending = new Set();
  ws.on('message', bytes => {
    const message = JSON.parse(bytes.toString()); messages.push(message);
    for (const waiter of pending) if (waiter.predicate(message)) {
      clearTimeout(waiter.timer); pending.delete(waiter); waiter.resolve(message);
    }
  });
  return { ws, send(message) { ws.send(JSON.stringify(message)); }, wait(predicate) {
    const existing = messages.find(predicate); if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: setTimeout(() => {
        pending.delete(waiter); reject(new Error('Timed out waiting for an authoritative meteor state'));
      }, 4000) }; pending.add(waiter);
    });
  } };
}
const meteor = (state, id = 'entering-meteor') => state.room.meteors?.find(item => item.id === id);

test('real clients observe one authoritative meteor trajectory independent of dust deltas, viewport changes and reconnect', async () => {
  const game = createGameServer({ port: 0, host: '127.0.0.1' }), address = await game.listen();
  const endpoint = `ws://127.0.0.1:${address.port}/ws`, a = client(endpoint), observer = client(endpoint);
  let restored;
  try {
    const [welcomeA, welcomeB] = await Promise.all([a.wait(m => m.type === 'welcome'), observer.wait(m => m.type === 'welcome')]);
    a.send({ type: 'create', name: '陨石同步' }); const joined = await a.wait(m => m.type === 'joined');
    observer.send({ type: 'join', code: joined.code, name: '观察端' }); await observer.wait(m => m.type === 'joined');
    observer.send({ type: 'ready', ready: true });
    await a.wait(m => m.type === 'state' && m.room.players.length === 2 && m.room.players.every(player => player.ready));
    a.send({ type: 'start' }); await a.wait(m => m.type === 'state' && m.room.status === 'playing');
    const room = game.manager.find(welcomeA.id); room.arena.random = () => .99;
    room.arena.dust = Array.from({ length: DUST_COUNT }, (_, id) => ({ id: `far-dust-${id}`, x: 11000, y: 7000, value: 1, vx: 0, vy: 0 }));
    for (const [id, y] of [[welcomeA.id, 3800], [welcomeB.id, 4200]]) {
      const p = room.arena.players.get(id);
      Object.assign(p, { x: 6000, y, mass: 36, radius: 24, invulnerable: 0 });
      Object.assign(p.cells[0], { x: 6000, y, mass: 36, radius: 24, vx: 0, vy: 0 });
    }
    const origin = { x: 4500, y: 4000, vx: 600, vy: 0, bornAt: room.arena.time };
    room.arena.meteors = [
      { id: 'entering-meteor', ...origin, radius: 4, tailLength: 84, color: '#ffbd68' },
      ...Array.from({ length: METEOR.count - 1 }, (_, id) => ({ id: `far-meteor-${id}`,
        x: 1000 + id * 4, y: 1000, vx: 450, vy: 0, radius: 3, tailLength: 63, color: '#83d9ff', bornAt: origin.bornAt })),
    ];
    const viewport = { x: 6000, y: 4000, width: 1600, height: 1000 };
    a.send({ type: 'input', seq: 101, dustDeltas: true, viewport });
    observer.send({ type: 'input', seq: 101, viewport });
    const outside = await a.wait(m => m.type === 'state' && m.room.players.find(p => p.id === welcomeA.id)?.lastInputSeq === 101);
    assert.ok(!meteor(outside), 'an initially distant meteor stays outside this viewport');

    const entered = await a.wait(m => m.type === 'state' && m.room.dustDelta && meteor(m));
    const sameTick = await observer.wait(m => m.type === 'state' && m.room.tick === entered.room.tick);
    assert.deepEqual(sameTick.room.meteors, entered.room.meteors, 'two observers of the same region receive the same IDs and exact coordinates');
    assert.equal(entered.room.meteorTotal, METEOR.count); assert.equal(entered.room.dustTotal, DUST_COUNT);
    assert.ok(entered.room.meteors.length <= METEOR.count);
    assert.ok(!entered.room.dust.some(dust => dust.id === 'entering-meteor'), 'meteor transport must remain independent from ordinary dust');
    const next = await a.wait(m => m.type === 'state' && m.room.tick >= entered.room.tick + 4 && meteor(m));
    const firstPoint = meteor(entered), nextPoint = meteor(next), elapsed = (next.room.simulationTime - entered.room.simulationTime) / 1000;
    assert.ok(elapsed > 0); assert.ok(nextPoint.x > firstPoint.x);
    assert.ok(Math.abs(nextPoint.x - firstPoint.x - origin.vx * elapsed) < .03, 'wire movement follows the authoritative simulation clock');
    assert.equal(nextPoint.y, origin.y); assert.equal(nextPoint.vx, origin.vx); assert.equal(nextPoint.vy, 0);
    assert.equal(next.room.dustDelta, true, 'a dust delta frame still carries the complete current meteor list');

    a.send({ type: 'input', seq: 102, dustDeltas: true, viewport: { ...viewport, x: 8000 } });
    const leftView = await a.wait(m => m.type === 'state' && m.room.players.find(p => p.id === welcomeA.id)?.lastInputSeq === 102);
    assert.ok(!meteor(leftView), 'a new viewport replaces rather than accumulates the prior meteor list');
    const stillObserved = await observer.wait(m => m.type === 'state' && m.room.tick >= leftView.room.tick && meteor(m));
    assert.ok(meteor(stillObserved), 'leaving one client viewport does not remove the shared meteor');

    a.ws.terminate(); await once(a.ws, 'close');
    restored = client(`${endpoint}?token=${encodeURIComponent(welcomeA.reconnectToken)}`);
    const baseline = await restored.wait(m => m.type === 'state' && meteor(m));
    assert.notEqual(baseline.room.dustDelta, true, 'reconnect starts from a complete baseline');
    assert.equal(baseline.room.code, joined.code); assert.equal(baseline.room.meteorTotal, METEOR.count);
    assert.ok(meteor(baseline).x >= nextPoint.x);
    room.arena.meteors = room.arena.meteors.filter(item => item.id !== 'entering-meteor');
    const retired = await restored.wait(m => m.type === 'state' && m.room.tick > baseline.room.tick && !meteor(m));
    assert.equal(retired.room.meteorTotal, METEOR.count, 'retirement refills with new IDs instead of retaining a stale cached meteor');
    assert.equal(retired.room.dustTotal, DUST_COUNT);

    restored.send({ type: 'input', seq: 103, dustDeltas: true, viewport });
    await restored.wait(m => m.type === 'state' && m.room.players.find(p => p.id === welcomeA.id)?.lastInputSeq === 103);
    const target = room.arena.players.get(welcomeA.id);
    Object.assign(target, { mass: 36, radius: 24, energy: 40, score: 0, invulnerable: 0 });
    Object.assign(target.cells[0], { mass: 36, radius: 24, vx: 0, vy: 0, impulseX: 0, impulseY: 0,
      protectedFor: 0, shatterCooldown: 0 });
    room.arena.meteors = [{ id: 'impact-meteor', x: target.cells[0].x - 30, y: target.cells[0].y,
      vx: 600, vy: 0, radius: 4, tailLength: 84, color: '#ffbd68', bornAt: room.arena.time }, ...room.arena.meteors.slice(1)];
    const impacted = await restored.wait(m => m.type === 'state'
      && m.room.players.find(p => p.id === welcomeA.id)?.lastMeteorHit?.meteorId === 'impact-meteor');
    const hitPlayer = impacted.room.players.find(p => p.id === welcomeA.id), hit = hitPlayer.lastMeteorHit;
    assert.equal(impacted.room.dustDelta, true, 'a meteor impact publishes real debris through the existing dust delta transport');
    assert.ok(!meteor(impacted, 'impact-meteor'), 'the impact packet must consume the meteor head and tail');
    assert.ok(hitPlayer.cells[0].vx > 0); assert.equal(hitPlayer.cells[0].lastMeteorHitId, hit.id);
    assert.ok(Math.abs(hitPlayer.mass - 36 * .88) < .01); assert.ok(Math.abs(hit.lostMass - 36 * .12) < 1e-7);
    const owned = impacted.room.dust.filter(dust => dust.fragment && dust.ownerId === target.id);
    const neutral = impacted.room.dust.filter(dust => dust.fragment && !dust.ownerId);
    assert.equal(owned.length, 3); assert.equal(neutral.length, 3);
    assert.ok(neutral.every(dust => dust.ownerId === null && dust.sourceKind === 'meteor'));
    assert.ok(Math.abs(owned.reduce((sum, dust) => sum + dust.value, 0) - hit.lostMass) < 1e-7);
    assert.ok(Math.abs(neutral.reduce((sum, dust) => sum + dust.value, 0) - 4) < 1e-7, 'the meteor itself becomes four units of collectible mass');
    assert.equal(hitPlayer.score, 0); assert.ok(hitPlayer.energy < 42, 'impact does not grant a direct pickup reward');
    const later = await restored.wait(m => m.type === 'state' && m.room.tick >= impacted.room.tick + 4);
    assert.equal(later.room.players.find(p => p.id === welcomeA.id).lastMeteorHit.id, hit.id, 'one consumed meteor produces one impact event');
    assert.ok(!meteor(later, 'impact-meteor')); assert.equal(later.room.meteorTotal, METEOR.count);
  } finally {
    a.ws.terminate(); observer.ws.terminate(); restored?.ws.terminate(); await game.close();
  }
});

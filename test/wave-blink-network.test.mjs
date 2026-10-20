import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createGameServer } from '../server.mjs';
import { DUST_COUNT, METEOR } from '../shared/engine.js';

function client(url) {
  const ws = new WebSocket(url), messages = [], pending = new Set();
  ws.on('message', bytes => {
    const message = JSON.parse(bytes.toString()); messages.push(message);
    for (const waiter of pending) if (waiter.predicate(message)) {
      clearTimeout(waiter.timer); pending.delete(waiter); waiter.resolve(message);
    }
  });
  return { ws, send: message => ws.send(JSON.stringify(message)), wait(predicate) {
    const existing = messages.find(predicate); if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: setTimeout(() => {
        pending.delete(waiter); reject(new Error('Timed out waiting for authoritative wave blink'));
      }, 5000) }; pending.add(waiter);
    });
  } };
}
const player = (message, id) => message.room.players.find(item => item.id === id);
const near = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) < tolerance,
  `${actual} should equal ${expected}`);

async function fixture(targetX = 10000, sourceMass = 36) {
  const game = createGameServer({ port: 0, host: '127.0.0.1' }), address = await game.listen();
  const endpoint = `ws://127.0.0.1:${address.port}/ws`, a = client(endpoint), b = client(endpoint);
  const [welcomeA, welcomeB] = await Promise.all([a.wait(m => m.type === 'welcome'), b.wait(m => m.type === 'welcome')]);
  a.send({ type: 'create' }); const joined = await a.wait(m => m.type === 'joined');
  b.send({ type: 'join', code: joined.code }); await b.wait(m => m.type === 'joined');
  b.send({ type: 'ready', ready: true });
  await a.wait(m => m.type === 'state' && m.room.players.length === 2 && m.room.players.every(p => p.ready));
  a.send({ type: 'start' }); await a.wait(m => m.type === 'state' && m.room.status === 'playing');
  const room = game.manager.find(welcomeA.id), source = room.arena.players.get(welcomeA.id), target = room.arena.players.get(welcomeB.id);
  room.arena.random = () => .99;
  room.arena.dust = Array.from({ length: DUST_COUNT }, (_, id) => ({ id: `far-${id}`, x: 11000, y: 7000, value: 1, vx: 0, vy: 0 }));
  room.arena.meteors = Array.from({ length: METEOR.count }, (_, id) => ({ id: `far-meteor-${id}`,
    x: 1000 + id * 3, y: 1000, vx: 180, vy: 0, radius: 3, tailLength: 40, color: '#ffbd68', bornAt: room.arena.time }));
  room.arena.meteorsInitialized = true;
  for (const [p, x] of [[source, 6000], [target, targetX]]) {
    const mass = p === source ? sourceMass : 36, radius = 4 * Math.sqrt(mass);
    Object.assign(p, { x, y: 4000, mass, radius, score: 0, invulnerable: 0, cooldown: 0, direction: { x: 1, y: 0 } });
    Object.assign(p.cells[0], { x, y: 4000, mass, radius, vx: 0, vy: 0, protectedFor: 0, shatterCooldown: 0 });
  }
  let sequence = 0;
  const command = (peer, input = {}) => { const seq = ++sequence; peer.send({ type: 'input', ...input, seq }); return seq; };
  const acknowledged = (peer, id, seq) => peer.wait(m => m.type === 'state' && player(m, id)?.lastInputSeq === seq);
  async function launch(mode = 'forward') {
    const previous = source.waveBlinkReady?.waveId;
    const seq = command(a, { [mode === 'rear' ? 'rearFire' : 'fire']: true, dustDeltas: true });
    return a.wait(m => m.type === 'state' && player(m, source.id)?.lastInputSeq === seq
      && player(m, source.id)?.waveBlinkReady?.waveId !== previous && player(m, source.id)?.waveBlinkReady);
  }
  return { game, endpoint, a, b, welcomeA, welcomeB, room, source, target, command, acknowledged, launch,
    async close(extra) { a.ws.terminate(); b.ws.terminate(); extra?.ws.terminate(); await game.close(); } };
}

test('a 36-mass source blinks once, consumes only its selected front and cannot cause a later hit or Dyson unlock', async () => {
  const f = await fixture(6400);
  try {
    const { a, b, source, target, room, command, acknowledged } = f;
    const otherSeq = command(b, { fire: true });
    const otherLaunch = await acknowledged(b, target.id, otherSeq);
    const otherId = otherLaunch.room.blasts.find(blast => blast.ownerId === target.id)?.id;
    assert.ok(otherId, 'an unrelated front is already flying away from both bodies');
    const launched = await f.launch(), launchedSource = player(launched, source.id);
    const ready = launchedSource.waveBlinkReady, waveId = ready.waveId, sourceCellId = source.cells[0].id;
    assert.equal(ready.sourceCellId, sourceCellId); assert.ok(ready.expiresAt > launched.room.simulationTime / 1000);
    for (const key of ['x', 'y', 'originX', 'originY', 'directionX', 'directionY', 'speed', 'travel', 'distance']) {
      assert.ok(Number.isFinite(ready[key]), `server supplies ${key} rather than accepting a destination`);
    }
    const seq = command(a, { split: true, destination: { x: 11111, y: 7777 }, blinkX: 11111, blinkY: 7777,
      waveId: 'forged-wave', sourceCellId: target.cells[0].id, mass: 99999 });
    const blinked = await a.wait(m => m.type === 'state' && player(m, source.id)?.lastInputSeq === seq
      && player(m, source.id)?.lastWaveBlink?.waveId === waveId);
    const own = player(blinked, source.id), event = own.lastWaveBlink;
    assert.equal(own.cells.length, 1, '36 mass can blink without the ordinary half-mass split');
    assert.equal(own.cells[0].id, sourceCellId); near(own.mass, 36); assert.equal(own.score, launchedSource.score);
    assert.equal(event.sourceCellId, sourceCellId); assert.equal(own.cells[0].lastWaveBlinkId, event.id);
    assert.equal(own.waveBlinkRevision, 1); assert.equal(own.waveBlinkReady, null);
    assert.ok(event.x - event.fromX > 50 && event.x - event.fromX < 350, 'the epoch event covers a real blink below the generic relocation threshold');
    near(event.fromX, 6000); near(event.fromY, 4000); near(event.y, 4000);
    near(event.vx, 0); near(event.vy, 0); near(own.cells[0].vx, event.vx); near(own.cells[0].vy, event.vy);
    near(own.cells[0].x, event.x, .02); near(own.cells[0].y, event.y, .02);
    assert.ok(!blinked.room.blasts.some(blast => blast.id === waveId), 'the blink and consumed-front removal are delivered in the same packet');
    assert.ok(blinked.room.blasts.some(blast => blast.id === otherId), 'consuming one front leaves the unrelated front intact');
    const age = event.at - launched.room.simulationTime / 1000;
    near(event.x, ready.x + ready.directionX * ready.speed * age, .03);
    near(event.y, ready.y + ready.directionY * ready.speed * age, .03);
    const elapsed = (blinked.room.simulationTime - launched.room.simulationTime) / 1000;
    assert.ok(!('energy' in own));
    near(own.cooldown, Math.max(0, launchedSource.cooldown - elapsed), .03);
    const sameTick = await b.wait(m => m.type === 'state' && m.room.tick === blinked.room.tick);
    assert.deepEqual(player(sameTick, source.id).lastWaveBlink, event);
    assert.deepEqual(player(sameTick, source.id).cells, own.cells);
    assert.ok(!sameTick.room.blasts.some(blast => blast.id === waveId), 'the second human also receives the warp without a surviving front');
    assert.ok(sameTick.room.blasts.some(blast => blast.id === otherId));
    event.x = 11111; own.cells[0].mass = 99999;
    assert.notEqual(source.lastWaveBlink.x, 11111); near(source.cells[0].mass, 36);

    const held = command(a, { split: true });
    const holding = await acknowledged(a, source.id, held);
    assert.equal(player(holding, source.id).waveBlinkRevision, 1); assert.equal(player(holding, source.id).cells.length, 1);
    assert.ok(!holding.room.blasts.some(blast => blast.id === waveId));
    const released = command(a); await acknowledged(a, source.id, released);
    const retry = command(a, { split: true, waveId });
    const retried = await acknowledged(a, source.id, retry);
    assert.equal(player(retried, source.id).waveBlinkRevision, 1);
    assert.equal(player(retried, source.id).lastWaveBlink.id, source.lastWaveBlink.id);
    assert.equal(player(retried, source.id).cells.length, 1);
    assert.ok(!retried.room.blasts.some(blast => blast.id === waveId), 'a fresh retry cannot restore the consumed front');
    const pastDeadline = await a.wait(m => m.type === 'state' && m.room.simulationTime / 1000 > ready.expiresAt + .05);
    assert.ok(!pastDeadline.room.blasts.some(blast => blast.id === waveId));
    assert.equal(player(pastDeadline, target.id).lastWaveHit, null, 'the removed wave cannot hit the body that lay along its remaining path');
    assert.equal(player(pastDeadline, source.id).dysonReady, null);
    assert.equal(player(pastDeadline, source.id).dyson, null);
    assert.equal(player(pastDeadline, source.id).waveBlinkRevision, 1);
    assert.ok(room.arena.dust.filter(dust => !dust.fragment).length >= DUST_COUNT);
  } finally { await f.close(); }
});

test('cancelling the newest rear wave cannot fall back to an older unhit own wave', async () => {
  const f = await fixture(5800, 72);
  try {
    const { a, b, source, target, command, acknowledged } = f;
    source.stats.blastRange = 3; source.stats.blastCooldown = .06;
    const first = await f.launch(), olderId = player(first, source.id).waveBlinkReady.waveId;
    const released = command(a); await acknowledged(a, source.id, released);
    // Both new fronts start between the players and meet before either body.
    command(a, { rearFire: true }); command(b, { fire: true });
    const cancelled = await a.wait(m => m.type === 'state' && m.room.waveClashes?.some(event => event.ownerIds.includes(source.id)));
    const clash = cancelled.room.waveClashes.find(event => event.ownerIds.includes(source.id));
    assert.ok(!clash.waveIds.includes(olderId));
    assert.ok(cancelled.room.blasts.some(blast => blast.id === olderId && !blast.blinkUsed));
    assert.equal(player(cancelled, source.id).waveBlinkReady, null);
    assert.equal(player(cancelled, source.id).lastWaveBlink, null);
    const normal = command(a, { split: true });
    const split = await acknowledged(a, source.id, normal);
    assert.equal(player(split, source.id).cells.length, 2, 'fresh Space retains ordinary splitting when the newest front is gone');
    assert.equal(player(split, source.id).waveBlinkRevision, 0);
    assert.equal(player(split, source.id).lastWaveBlink, null);
    assert.equal(player(split, target.id).lastWaveHit, null);
  } finally { await f.close(); }
});

test('an expired front disappears from authoritative readiness and cannot accept a forged late blink', async () => {
  const f = await fixture(10000, 72);
  try {
    const { a, source, command, acknowledged } = f;
    const launched = await f.launch('rear'), waveId = player(launched, source.id).waveBlinkReady.waveId;
    const expired = await a.wait(m => m.type === 'state' && m.room.tick > launched.room.tick
      && !m.room.blasts.some(blast => blast.id === waveId) && !player(m, source.id)?.waveBlinkReady);
    assert.equal(player(expired, source.id).waveBlinkRevision, 0);
    const late = command(a, { split: true, waveId, blink: true, destination: { x: 100, y: 100 } });
    const normal = await acknowledged(a, source.id, late);
    assert.equal(player(normal, source.id).cells.length, 2);
    assert.equal(player(normal, source.id).lastWaveBlink, null);
    assert.equal(player(normal, source.id).waveBlinkRevision, 0);
  } finally { await f.close(); }
});

test('reconnecting retains the blink event while the consumed front stays absent and cannot rearm', async () => {
  const f = await fixture(10000, 72); let restored;
  try {
    const { a, source, command } = f;
    const launched = await f.launch(), waveId = player(launched, source.id).waveBlinkReady.waveId;
    const seq = command(a, { split: true, dustDeltas: true });
    const blinked = await a.wait(m => m.type === 'state' && player(m, source.id)?.lastInputSeq === seq && player(m, source.id)?.lastWaveBlink);
    const event = player(blinked, source.id).lastWaveBlink;
    a.ws.terminate(); await once(a.ws, 'close');
    restored = client(`${f.endpoint}?token=${encodeURIComponent(f.welcomeA.reconnectToken)}`);
    const baseline = await restored.wait(m => m.type === 'state');
    const own = player(baseline, source.id);
    assert.notEqual(baseline.room.dustDelta, true);
    assert.equal(own.id, source.id); assert.equal(own.waveBlinkRevision, 1);
    assert.deepEqual(own.lastWaveBlink, event); assert.equal(own.cells[0].lastWaveBlinkId, event.id);
    assert.equal(own.waveBlinkReady, null);
    assert.ok(!baseline.room.blasts.some(blast => blast.id === waveId), 'a complete reconnect baseline cannot recreate the consumed wave');
    const normal = command(restored, { split: true });
    const split = await restored.wait(m => m.type === 'state' && player(m, source.id)?.lastInputSeq === normal);
    assert.equal(player(split, source.id).waveBlinkRevision, 1);
    assert.equal(player(split, source.id).lastWaveBlink.id, event.id);
    assert.equal(player(split, source.id).cells.length, 2, 'another fresh Space uses normal splitting after the one blink was spent');
    assert.ok(!split.room.blasts.some(blast => blast.id === waveId));
  } finally { await f.close(restored); }
});

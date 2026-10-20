import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createGameServer } from '../server.mjs';
import { DUST_COUNT, METEOR, snapshotArena } from '../shared/engine.js';

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
        pending.delete(waiter); reject(new Error('Timed out waiting for authoritative Dyson state'));
      }, 4000) }; pending.add(waiter);
    });
  } };
}

const player = (message, id) => message.room.players.find(item => item.id === id);
const near = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) < tolerance,
  `${actual} should equal ${expected}`);

async function fixture() {
  const game = createGameServer({ port: 0, host: '127.0.0.1' }), address = await game.listen();
  const endpoint = `ws://127.0.0.1:${address.port}/ws`, a = client(endpoint), b = client(endpoint);
  const [welcomeA, welcomeB] = await Promise.all([a.wait(m => m.type === 'welcome'), b.wait(m => m.type === 'welcome')]);
  a.send({ type: 'create', name: '戴森球攻击者' }); const joined = await a.wait(m => m.type === 'joined');
  b.send({ type: 'join', code: joined.code, name: '被包围星球' }); await b.wait(m => m.type === 'joined');
  b.send({ type: 'ready', ready: true });
  await a.wait(m => m.type === 'state' && m.room.players.length === 2 && m.room.players.every(p => p.ready));
  a.send({ type: 'start' }); await a.wait(m => m.type === 'state' && m.room.status === 'playing');
  const room = game.manager.find(welcomeA.id), source = room.arena.players.get(welcomeA.id), target = room.arena.players.get(welcomeB.id);
  room.arena.random = () => .99;
  room.arena.dust = Array.from({ length: DUST_COUNT }, (_, id) => ({ id: `far-${id}`, x: 11000, y: 7000, value: 1, vx: 0, vy: 0 }));
  room.arena.meteors = Array.from({ length: METEOR.count }, (_, id) => ({ id: `far-meteor-${id}`,
    x: 1000 + id * 3, y: 1000, vx: 180, vy: 0, radius: 3, tailLength: 40, color: '#ffbd68', bornAt: room.arena.time }));
  room.arena.meteorsInitialized = true;
  let sequence = 0;
  const command = (peer, input = {}) => { const seq = ++sequence; peer.send({ type: 'input', ...input, seq }); return seq; };
  function arrange(mode = 'forward') {
    room.arena.blasts = [];
    for (const [p, x] of [[source, 6000], [target, mode === 'rear' ? 5890 : 6110]]) {
      Object.assign(p, { x, y: 4000, energy: 100, invulnerable: 0, cooldown: 0,
        dysonCooldown: 0, _dysonCooldownUntil: 0, direction: { x: 1, y: 0 } });
      Object.assign(p.cells[0], { x, y: 4000, vx: 0, vy: 0, impulseX: 0, impulseY: 0, protectedFor: 0, shatterCooldown: 0 });
    }
  }
  async function activate(mode = 'forward', afterReady = () => {}) {
    arrange(mode);
    const previousHit = target.lastWaveHit?.id;
    command(a); await a.wait(m => m.type === 'state' && player(m, source.id)?.lastInputSeq === sequence);
    command(a, { [mode === 'rear' ? 'rearFire' : 'fire']: true });
    const ready = await a.wait(m => m.type === 'state' && player(m, source.id)?.dysonReady
      && player(m, target.id)?.lastWaveHit?.id !== previousHit);
    afterReady();
    const readyPlayer = player(ready, source.id), readySeq = command(a);
    await a.wait(m => m.type === 'state' && player(m, source.id)?.lastInputSeq === readySeq);
    const activationSeq = command(a, { split: true });
    const active = await a.wait(m => m.type === 'state' && player(m, source.id)?.dyson
      && player(m, source.id)?.lastInputSeq >= activationSeq);
    return { ready, readyPlayer, active, activationSeq };
  }
  return { game, endpoint, a, b, welcomeA, welcomeB, room, source, target, command, arrange, activate,
    async close(extra) { a.ws.terminate(); b.ws.terminate(); extra?.ws.terminate(); await game.close(); } };
}

test('real wave hits unlock source-core-only Dyson through fresh Space and reject client supplied targets or mass', async () => {
  const f = await fixture();
  try {
    const { a, b, source, target, room, command } = f;
    f.arrange();
    const originalMass = source.mass, targetMass = target.mass;
    const forgedSeq = command(a, { dyson: { targetId: target.id, capturedMass: 99999 }, dysonReady: true,
      targetId: target.id, mass: 99999, stats: { growth: 99 } });
    const rejected = await a.wait(m => m.type === 'state' && player(m, source.id)?.lastInputSeq === forgedSeq);
    assert.equal(player(rejected, source.id).dyson, null);
    assert.equal(player(rejected, source.id).dysonReady, null);
    near(source.mass, originalMass); near(target.mass, targetMass); assert.equal(source.stats.growth, 1);
    a.send({ type: 'dyson', targetId: target.id });
    await a.wait(m => m.type === 'error' && /未知操作/.test(m.message));

    const core = source.cells[0], unrelatedId = 'unrelated-source-core';
    // A wave that has already launched can still arm a source after another
    // core appears; no new wave is fired while multiple cores exist.
    const { ready, readyPlayer, active, activationSeq } = await f.activate('forward', () => {
      source.cells.push({ ...core, id: unrelatedId, x: 8000, y: 4000, mass: 9, radius: 12 });
      source.mass = core.mass + 9;
    });
    assert.equal(readyPlayer.dysonReady.targetId, target.id);
    assert.equal(readyPlayer.dysonReady.sourceCellId, core.id);
    assert.ok(ready.room.dysonRules.window > 0);
    const activeSource = player(active, source.id), shell = activeSource.dyson;
    assert.equal(shell.targetId, target.id); assert.equal(shell.sourceCellId, core.id);
    assert.equal(activeSource.cells.length, 2, 'Space transforms the existing wave source instead of cloning or splitting it');
    assert.equal(activeSource.cells.filter(cell => cell.dysonId === shell.id).length, 1);
    assert.equal(activeSource.cells.find(cell => cell.id === unrelatedId).dysonId, null);
    assert.equal(activeSource.dysonReady, null);
    const sameTick = await b.wait(m => m.type === 'state' && m.room.tick === active.room.tick);
    assert.deepEqual(player(sameTick, source.id).dyson, shell, 'both humans receive the same authoritative active shell');
    activeSource.dyson.targetId = 'forged-local-target'; activeSource.cells[0].mass = 99999;
    assert.equal(source.dyson.targetId, target.id); assert.notEqual(source.cells[0].mass, 99999);

    command(a, { split: true });
    const held = await a.wait(m => m.type === 'state' && m.room.tick > active.room.tick
      && player(m, source.id)?.lastInputSeq > activationSeq);
    assert.equal(player(held, source.id).dyson.id, shell.id, 'holding Space does not restart or duplicate the shell');
    assert.equal(player(held, source.id).cells.length, 2);
    const beforeSource = source.mass, beforeTarget = target.mass, beforeCapture = source.dyson.capturedMass;
    room.arena.dust = [...room.arena.dust.slice(1),
      { id: 'target-actual-pickup', x: target.cells[0].x, y: target.cells[0].y, value: 5, vx: 0, vy: 0 }];
    const captured = await a.wait(m => m.type === 'state' && player(m, source.id)?.dyson?.capturedMass > beforeCapture);
    assert.ok(!room.arena.dust.some(dust => dust.id === 'target-actual-pickup'));
    near(player(captured, target.id).mass, beforeTarget, .02);
    assert.ok(player(captured, source.id).mass > beforeSource, 'interception awards the source real collected mass');
    assert.equal(player(captured, source.id).cells.length, 2);
    assert.ok(room.arena.dust.filter(dust => !dust.fragment).length >= DUST_COUNT, 'normal resource replenishment continues');
  } finally { await f.close(); }
});

test('forged forward and rear fire cannot spend resources with multiple cores, while a fresh shot works after real fusion', async () => {
  const f = await fixture();
  try {
    const { a, source, room, command } = f; f.arrange();
    const core = source.cells[0];
    Object.assign(core, { mass: 18, radius: 4 * Math.sqrt(18), mergeIn: 0 });
    source.cells.push({ ...core, id: 'fusion-return-core', x: core.x + core.radius * 2, y: core.y });
    source.mass = 36;
    for (const input of [{ fire: true }, { rearFire: true }]) {
      const released = command(a); await a.wait(m => m.type === 'state' && player(m, source.id)?.lastInputSeq === released);
      const energy = source.energy, blocked = command(a, input);
      const state = await a.wait(m => m.type === 'state' && player(m, source.id)?.lastInputSeq === blocked);
      assert.equal(player(state, source.id).cells.filter(cell => cell.mass > 0).length, 2);
      assert.ok(!state.room.blasts.some(blast => blast.ownerId === source.id));
      assert.equal(player(state, source.id).cooldown, 0);
      assert.ok(player(state, source.id).energy >= energy, 'a rejected shot does not consume energy');
    }
    for (let tick = 0; tick < 18; tick++) f.game.manager.tick(.1);
    assert.equal(source.cells.length, 1, 'the sibling cores actually fuse in the authoritative simulation');
    const released = command(a); await a.wait(m => m.type === 'state' && player(m, source.id)?.lastInputSeq === released);
    const shot = command(a, { rearFire: true });
    const allowed = await a.wait(m => m.type === 'state' && player(m, source.id)?.lastInputSeq === shot
      && m.room.blasts.some(blast => blast.ownerId === source.id));
    assert.ok(allowed.room.blasts.some(blast => blast.ownerId === source.id && blast.mode === 'rear'));
    assert.ok(player(allowed, source.id).cooldown > 0);
    assert.ok(player(allowed, source.id).energy < 75);
  } finally { await f.close(); }
});

test('Dyson links disappear in the first disconnect, reconnect and leave packets even without a following playing tick', async () => {
  const f = await fixture(); let restored;
  try {
    const { a, b, source, target, room } = f;
    const { active } = await f.activate('rear'), shellId = player(active, source.id).dyson.id;
    b.ws.terminate(); await once(b.ws, 'close');
    const disconnected = await a.wait(m => m.type === 'state' && player(m, target.id)?.connected === false);
    const restoredSource = player(disconnected, source.id);
    assert.equal(restoredSource.dyson, null, 'the immediate disconnect publication has no target link');
    assert.ok(restoredSource.lastDysonEnd?.id); assert.match(restoredSource.lastDysonEnd.reason, /disconnect/);
    assert.ok(restoredSource.cells.every(cell => cell.dysonId !== shellId));
    restored = client(`${f.endpoint}?token=${encodeURIComponent(f.welcomeB.reconnectToken)}`);
    const baseline = await restored.wait(m => m.type === 'state');
    assert.equal(player(baseline, source.id).dyson, null);
    assert.equal(player(baseline, target.id).connected, true);
    assert.notEqual(baseline.room.dustDelta, true);

    f.b = restored;
    const second = await f.activate();
    const secondId = player(second.active, source.id).dyson.id;
    room.arena.status = 'finished';
    a.send({ type: 'leave' });
    const left = await restored.wait(m => m.type === 'state' && !player(m, source.id));
    assert.equal(left.room.status, 'finished');
    assert.ok(left.room.players.every(p => !p.dyson || p.dyson.targetId !== source.id));
    assert.ok(left.room.players.every(p => p.cells.every(cell => cell.dysonId !== secondId)));
    assert.equal(source.dyson, null, 'teardown restores and clears the departed source before removing it from the arena');
    const cloned = snapshotArena(room.arena);
    assert.ok(cloned.players.every(p => !p.dyson || p.dyson.targetId !== source.id));
  } finally { await f.close(restored); }
});

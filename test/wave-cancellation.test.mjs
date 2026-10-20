import test from 'node:test';
import assert from 'node:assert/strict';
import { WAVE, addPlayer, createArena, setPlayerInput, snapshotArena, startRound, stepArena } from '../shared/engine.js';

const near = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `${actual} should equal ${expected} within ${tolerance}`);

function fixture() {
  const arena = createArena({ endless: true, random: () => .99 }); arena.status = 'playing';
  function player(id, x, y = 2000, mass = 36) {
    const p = addPlayer(arena, { id, name: id });
    Object.assign(p.cells[0], { x, y, mass, radius: 4 * Math.sqrt(mass), vx: 0, vy: 0 });
    Object.assign(p, { x, y, mass, radius: 4 * Math.sqrt(mass), invulnerable: 0 });
    return p;
  }
  return { arena, player };
}

function wave(id, x, y, dx, dy, options = {}) {
  return { id, ownerId: `owner-${id}`, kind: 'wave', mode: 'forward', sourceCellId: `source-${id}`,
    x, y, originX: x, originY: y, directionX: dx, directionY: dy,
    width: WAVE.width, thickness: WAVE.thickness, curvature: WAVE.curvature,
    speed: WAVE.speed, distance: WAVE.distance, travel: 0, color: '#5eefa8',
    radius: WAVE.width / 2 + WAVE.curvature + WAVE.thickness / 2,
    hit: new Set(), ...options };
}

function advance(arena, duration, dt = .025) {
  for (let elapsed = 0; elapsed < duration - 1e-9;) {
    const step = Math.min(dt, duration - elapsed); stepArena(arena, step); elapsed += step;
  }
}

test('real forward and rear counter-waves annihilate both attacks without chipping or pushing either planet', () => {
  for (const rear of [false, true]) {
    const { arena, player } = fixture(), left = player('left', 1000), right = player('right', 1400);
    left.direction = { x: rear ? -1 : 1, y: 0 }; right.direction = { x: -1, y: 0 };
    setPlayerInput(arena, left.id, { [rear ? 'rearFire' : 'fire']: true });
    setPlayerInput(arena, right.id, { fire: true }); stepArena(arena, 0);
    assert.equal(arena.blasts.length, 2);
    assert.equal(arena.blasts.find(b => b.ownerId === left.id).mode, rear ? 'rear' : 'forward');
    advance(arena, .4);
    assert.equal(arena.blasts.length, 0); assert.equal(arena.waveClashes.length, 1);
    const clash = arena.waveClashes[0]; near(clash.x, 1200, .02); near(clash.y, 2000, .02);
    for (const p of [left, right]) { near(p.mass, 36); near(p.vx, 0); near(p.vy, 0); assert.equal(p.lastWaveHit, null); }
    assert.equal(arena.dust.filter(d => d.fragment).length, 0);
  }
});

test('a 100ms step detects opposite fast fronts even when neither endpoint intersects', () => {
  const { arena } = fixture();
  arena.blasts = [wave('a', 1000, 2000, 1, 0), wave('b', 1030, 2000, -1, 0)];
  stepArena(arena, .1);
  assert.equal(arena.blasts.length, 0); assert.equal(arena.waveClashes.length, 1);
  near(arena.waveClashes[0].at, (30 - WAVE.thickness) / (2 * WAVE.speed), .00001);
  near(arena.waveClashes[0].x, 1015, .02); near(arena.waveClashes[0].y, 2000, .02);
});

test('finite curved tips can glance but separated wave bounding circles cannot cause a false cancellation', () => {
  const touchingOffset = WAVE.width + WAVE.thickness - 1;
  for (const offset of [touchingOffset, touchingOffset + 2]) {
    const { arena } = fixture();
    arena.blasts = [wave('a', 1000, 2000, 1, 0), wave('b', 1120, 2000 + offset, -1, 0)];
    advance(arena, .25, .1);
    if (offset === touchingOffset) { assert.equal(arena.blasts.length, 0); assert.equal(arena.waveClashes.length, 1); }
    else { assert.equal(arena.blasts.length, 2); assert.equal(arena.waveClashes.length, 0); }
  }
});

test('parallel fronts cancel only on a real simultaneous touch, never on overlap of their swept areas at different times', () => {
  const touchingGap = WAVE.thickness / 2;
  for (const gap of [touchingGap, 45]) {
    const { arena } = fixture();
    arena.blasts = [wave('a', 1000, 2000, 1, 0), wave('b', 1000 + gap, 2000, 1, 0)];
    stepArena(arena, .1);
    if (gap === touchingGap) { assert.equal(arena.blasts.length, 0); assert.equal(arena.waveClashes.length, 1); }
    else {
      assert.equal(arena.blasts.length, 2); assert.equal(arena.waveClashes.length, 0);
      near(arena.blasts[0].x, 1060); near(arena.blasts[1].x, 1105);
    }
  }
});

test('same-owner waves pass through one another, while different owners also cancel on a perpendicular crossing', () => {
  const own = fixture();
  own.arena.blasts = [wave('a', 1000, 2000, 1, 0, { ownerId: 'one-owner' }),
    wave('b', 1030, 2000, -1, 0, { ownerId: 'one-owner' })];
  stepArena(own.arena, .1); assert.equal(own.arena.blasts.length, 2); assert.equal(own.arena.waveClashes.length, 0);
  const cross = fixture();
  cross.arena.blasts = [wave('a', 1000, 2000, 1, 0), wave('b', 1060, 1940, 0, 1)];
  stepArena(cross.arena, .1); assert.equal(cross.arena.blasts.length, 0); assert.equal(cross.arena.waveClashes.length, 1);
});

test('larger mass and range upgrades do not let one wave survive an opposing weaker planet wave', () => {
  const { arena, player } = fixture(), light = player('light', 1000, 2000, 4), heavy = player('heavy', 1600, 2000, 900);
  light.direction = { x: 1, y: 0 }; heavy.direction = { x: -1, y: 0 };
  heavy.stats.blastRange = 1.72; heavy.stats.blastCooldown = .2;
  setPlayerInput(arena, light.id, { fire: true }); setPlayerInput(arena, heavy.id, { fire: true }); stepArena(arena, 0);
  assert.equal(arena.blasts.length, 2); assert.ok(arena.blasts.find(b => b.ownerId === heavy.id).distance > WAVE.distance);
  advance(arena, .5);
  assert.equal(arena.blasts.length, 0); assert.equal(arena.waveClashes.length, 1);
  near(light.mass, 4); near(heavy.mass, 900); assert.equal(light.lastWaveHit, null); assert.equal(heavy.lastWaveHit, null);
});

test('three simultaneously touching owners all cancel independently of insertion order', () => {
  const orders = [['a', 'b', 'c'], ['a', 'c', 'b'], ['b', 'a', 'c'], ['b', 'c', 'a'], ['c', 'a', 'b'], ['c', 'b', 'a']];
  for (const order of orders) {
    const { arena } = fixture();
    const waves = new Map([['a', wave('a', 1000, 2000, 1, 0)], ['b', wave('b', 1000, 2000, -1, 0)],
      ['c', wave('c', 1000, 2000, 0, 1)]]);
    arena.blasts = order.map(id => waves.get(id)); stepArena(arena, 0);
    assert.equal(arena.blasts.length, 0); assert.equal(arena.waveClashes.length, 1);
    assert.deepEqual(arena.waveClashes[0].waveIds, ['a', 'b', 'c']);
    assert.deepEqual(arena.waveClashes[0].ownerIds, ['owner-a', 'owner-b', 'owner-c']);
  }
});

test('expiry truncates the active trajectory rather than leaving a stationary front that a later wave can hit', () => {
  const { arena } = fixture();
  arena.blasts = [wave('expires', 1000, 2000, 1, 0, { originX: 592, travel: 408 }), wave('later', 955, 2000, 1, 0)];
  stepArena(arena, .1);
  assert.equal(arena.waveClashes.length, 0);
  assert.deepEqual(arena.blasts.map(b => b.id), ['later']); near(arena.blasts[0].x, 1015);
  for (const beforeExpiry of [true, false]) {
    const other = fixture();
    other.arena.blasts = [wave('short', 1000, 2000, 1, 0, { originX: 592, travel: 408 }),
      wave('incoming', 1000 + 2 * 12 + WAVE.thickness + (beforeExpiry ? -2 : 2), 2000, -1, 0)];
    stepArena(other.arena, .1);
    assert.equal(other.arena.waveClashes.length, beforeExpiry ? 1 : 0);
    assert.equal(other.arena.blasts.length, beforeExpiry ? 0 : 1);
  }
});

test('cancelled waves cannot chip or push a later target, while a hit that precedes the clash is retained', () => {
  const after = fixture(), protectedByCounter = after.player('owner-b', 1100);
  after.arena.blasts = [wave('a', 1000, 2000, 1, 0), wave('b', 1120, 2000, -1, 0, { ownerId: 'owner-b' })];
  stepArena(after.arena, .1); advance(after.arena, .2);
  assert.equal(after.arena.waveClashes.length, 1); assert.equal(protectedByCounter.lastWaveHit, null);
  near(protectedByCounter.mass, 36); near(protectedByCounter.vx, 0); near(protectedByCounter.vy, 0);
  assert.equal(after.arena.dust.filter(d => d.fragment).length, 0);

  const earlier = fixture(), alreadyHit = earlier.player('victim', 1040, 2000, 9);
  earlier.arena.blasts = [wave('a', 1000, 2000, 1, 0), wave('b', 1120, 2000, -1, 0)];
  stepArena(earlier.arena, .1);
  assert.equal(earlier.arena.waveClashes.length, 1); assert.equal(earlier.arena.blasts.length, 0);
  assert.equal(alreadyHit.lastWaveHit.waveId, 'a'); near(alreadyHit.mass, 9 * .88); assert.ok(alreadyHit.vx > 0);
  assert.ok(alreadyHit.lastWaveHit.at < earlier.arena.waveClashes[0].at);
  assert.equal(earlier.arena.dust.filter(d => d.fragment).length, 3);
});

test('an exactly simultaneous counter-wave takes priority over the attack reaching a player', () => {
  const { arena, player } = fixture(), target = player('counter-owner', 1072, 2000, 9);
  arena.blasts = [wave('attack', 1000, 2000, 1, 0), wave('counter', 1120, 2000, -1, 0, { ownerId: target.id })];
  stepArena(arena, .1);
  assert.equal(arena.blasts.length, 0); assert.equal(arena.waveClashes.length, 1);
  near(arena.waveClashes[0].at, (120 - WAVE.thickness) / (2 * WAVE.speed), .00001);
  assert.equal(target.lastWaveHit, null); near(target.mass, 9); near(target.vx, 0); near(target.vy, 0);
});

test('clash feedback persists, is bounded and copied safely on the wire, is not viewport filtered, and resets each round', () => {
  const { arena } = fixture();
  assert.deepEqual(snapshotArena(arena).waveClashes, []);
  arena.blasts = [wave('a', 1000, 2000, 1, 0), wave('b', 1000, 2000, -1, 0)]; stepArena(arena, 0);
  const event = arena.waveClashes[0];
  for (const field of ['at', 'x', 'y', 'radius']) assert.ok(Number.isFinite(event[field]));
  assert.ok(event.id && event.radius >= 18 && event.radius <= 48);
  const wire = snapshotArena(arena, { x: 10000, y: 7000, width: 40, height: 40, margin: 0 }).waveClashes;
  assert.deepEqual(wire, arena.waveClashes); wire[0].waveIds.push('bad'); wire[0].ownerIds[0] = 'bad'; wire[0].colors[0] = 'bad'; wire[0].x = -1;
  assert.deepEqual(event.waveIds, ['a', 'b']); assert.deepEqual(event.ownerIds, ['owner-a', 'owner-b']); assert.ok(event.colors.every(color => color !== 'bad')); near(event.x, 1000, 40);
  advance(arena, 1); assert.equal(arena.waveClashes.length, 1);
  advance(arena, .6); assert.equal(arena.waveClashes.length, 0);
  for (let i = 0; i < 70; i++) {
    arena.blasts = [wave(`a-${i}`, 1000, 2000, 1, 0), wave(`b-${i}`, 1000, 2000, -1, 0)]; stepArena(arena, 0);
  }
  assert.equal(arena.waveClashes.length, 64); assert.equal(new Set(arena.waveClashes.map(clash => clash.id)).size, 64);
  startRound(arena); assert.deepEqual(arena.waveClashes, []); assert.deepEqual(snapshotArena(arena).waveClashes, []);
});

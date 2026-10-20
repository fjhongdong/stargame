import test from 'node:test';
import assert from 'node:assert/strict';
import { DUST_COUNT, WAVE, addPlayer, createArena, setPlayerInput, snapshotArena, stepArena, waveArcPoint } from '../shared/engine.js';

const near = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `${actual} should equal ${expected} within ${tolerance}`);

function fixture(mass = 36) {
  const arena = createArena({ endless: true, random: () => .99 }); arena.status = 'playing';
  arena.dust = Array.from({ length: DUST_COUNT }, (_, i) => ({ id: `far-${i}`, x: 11000, y: 7000, value: 1, vx: 0, vy: 0 }));
  function player(id, x = 4000, y = 4000, size = mass) {
    const p = addPlayer(arena, { id });
    Object.assign(p, { x, y, mass: size, radius: 4 * Math.sqrt(size), energy: 100, invulnerable: 0 });
    Object.assign(p.cells[0], { x, y, mass: size, radius: p.radius, vx: 0, vy: 0 });
    p.stats.energyRegen = 0;
    return p;
  }
  const owner = player('owner');
  function fire(p = owner, rear = false) {
    setPlayerInput(arena, p.id, {});
    setPlayerInput(arena, p.id, { [rear ? 'rearFire' : 'fire']: true });
    stepArena(arena, 0);
    return arena.blasts.find(w => w.id === p._latestWaveId);
  }
  function put(id, x, y, value = 1, extra = {}) {
    if (!extra.fragment) arena.dust.splice(arena.dust.findIndex(d => d.id.startsWith('far-')), 1);
    const dust = { id, x, y, value, vx: 0, vy: 0, ...extra }; arena.dust.push(dust); return dust;
  }
  return { arena, owner, player, fire, put };
}

test('wave geometry scales with the firing planet radius at launch without changing speed or upgraded range', () => {
  for (const mass of [1, 9, 36, 144, 900]) for (const rear of [false, true]) {
    const { arena, owner, fire } = fixture(mass), radius = owner.cells[0].radius, scale = radius / 24;
    owner.stats.blastRange = 1.36;
    const wave = fire(owner, rear), wire = snapshotArena(arena).blasts.find(b => b.id === wave.id);
    near(wave.width, WAVE.width * scale); near(wave.thickness, WAVE.thickness * scale);
    near(wave.curvature, WAVE.curvature * scale);
    near(wave.width + wave.thickness, radius * 2);
    assert.ok(wave.width + wave.thickness <= radius * 2 + 1e-6, 'the full capsule front must be no wider than its firing planet');
    near(wave.radius, wave.width / 2 + wave.curvature + wave.thickness / 2);
    near(wave.sourceRadius, radius); near(wire.sourceRadius, radius, .01);
    near(wire.width, wave.width); near(wire.thickness, wave.thickness); near(wire.curvature, wave.curvature);
    near(wave.originOffset, radius + wave.thickness / 2 + 4);
    near(wave.speed, WAVE.speed); near(wave.distance, WAVE.distance * 1.36);
    const width = wave.width;
    owner.cells[0].mass *= 4; owner.cells[0].radius *= 2; stepArena(arena, 0);
    near(wave.width, width, 1e-6);
  }
});

test('all parts of the scaled front start outside the source surface at small and large radii', () => {
  for (const mass of [1, 9, 36, 144, 900]) for (const angle of [0, Math.PI / 4, Math.PI]) {
    const { owner, fire } = fixture(mass);
    owner.direction = { x: Math.cos(angle), y: Math.sin(angle) };
    const source = owner.cells[0], wave = fire();
    let previous;
    for (let i = 0; i <= WAVE.segments; i++) {
      const point = waveArcPoint(wave, -1 + 2 * i / WAVE.segments);
      assert.ok(Math.hypot(point.x - source.x, point.y - source.y) - wave.thickness / 2 >= source.radius - 1e-6,
        `mass ${mass}, angle ${angle}: the wave arc must emerge outside its own planet`);
      if (previous) {
        const ax = previous.x - source.x, ay = previous.y - source.y;
        const dx = point.x - previous.x, dy = point.y - previous.y;
        const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy)));
        assert.ok(Math.hypot(ax + t * dx, ay + t * dy) - wave.thickness / 2 >= source.radius - 1e-6,
          `mass ${mass}, angle ${angle}: thick collision segments must also clear the source`);
      }
      previous = point;
    }
  }
});

test('a large planet wave hits a nearby nonoverlapping target without a source-size blind spot', () => {
  const { arena, owner, player, fire } = fixture(400), target = player('nearby-target', 4150, 4000, 36);
  assert.ok(Math.hypot(target.x - owner.x, target.y - owner.y) > target.radius + owner.radius);
  const wave = fire();
  for (let i = 0; i < 12 && !target.lastWaveHit; i++) stepArena(arena, 1 / 120);
  assert.ok(target.lastWaveHit, 'the initial wave must reach a target in the close front gap');
  assert.equal(target.lastWaveHit.waveId, wave.id); assert.equal(owner.dysonReady?.targetId, target.id);
  near(target.mass, 36 * (1 - WAVE.chipFraction));
});

test('a continuous wave sweep collects natural dust into its source using normal growth, score and energy, once only', () => {
  const { arena, owner, fire, put } = fixture(); owner.stats.growth = 1.6;
  const wave = fire(), natural = put('swept-natural', wave.x + 30, wave.y, 2);
  const outside = put('outside-finite-arc', wave.x + 30, wave.y + 100);
  const fragment = put('free-fragment', wave.x + 30, wave.y, 3, { fragment: true, ownerId: null });
  const mass = owner.mass, score = owner.score, energy = owner.energy;
  stepArena(arena, .1);
  near(owner.mass - mass, 3.2); near(owner.score - score, 4); near(owner.energy - energy, 8);
  assert.ok(!arena.dust.includes(natural)); assert.ok(arena.dust.includes(outside)); assert.ok(arena.dust.includes(fragment));
  assert.equal(arena.dust.filter(d => !d.fragment).length, DUST_COUNT);
  assert.equal(arena.naturalDustCount, DUST_COUNT);
  const after = owner.mass; stepArena(arena, 0); near(owner.mass, after);
});

test('two same-owner waves cannot credit the same swept star twice', () => {
  const { arena, owner, fire, put } = fixture(); const first = fire();
  const second = { ...first, id: 'second-same-owner-wave', hit: new Set() }; arena.blasts.push(second);
  const dust = put('one-star-two-waves', first.x + 30, first.y, 2), mass = owner.mass;
  stepArena(arena, .1);
  assert.ok(!arena.dust.includes(dust)); near(owner.mass - mass, 2); near(owner.score, 4);
});

test('a moving natural star crossing a curved tip is collected even when its final position is outside the wave lane', () => {
  const { arena, owner, fire, put } = fixture(), wave = fire();
  const dust = put('moving-through-tip', wave.x, wave.y + wave.width / 2 - 3, 2, { vy: 420 }), mass = owner.mass;
  stepArena(arena, .1);
  assert.ok(dust.y > wave.y + wave.width / 2 + wave.thickness / 2 + 1.5,
    'the star should finish outside the finite front, so final-position testing would miss its crossing');
  assert.ok(!arena.dust.includes(dust)); near(owner.mass - mass, 2);
});

test('wave cancellation clips star collection to the live path before the clash', () => {
  const { arena, owner, fire, put } = fixture(), wave = fire();
  arena.blasts.push({ ...wave, id: 'counter-wave', ownerId: 'absent-counter', sourceCellId: 'missing-source',
    x: wave.x + 70, originX: wave.x + 70, directionX: -1, hit: new Set() });
  const before = put('before-clash', wave.x + 12, wave.y);
  const beyond = put('beyond-clash', wave.x + 60, wave.y), mass = owner.mass;
  stepArena(arena, .1);
  assert.equal(arena.waveClashes.length, 1); assert.equal(arena.blasts.length, 0);
  assert.ok(!arena.dust.includes(before)); assert.ok(arena.dust.includes(beyond)); near(owner.mass - mass, 1);
});

test('expiry and a consumed blink wave cannot collect beyond their last live front', () => {
  const short = fixture(), wave = short.fire();
  wave.travel = wave.distance - 5; wave.originX = wave.x - wave.travel;
  const beyond = short.put('beyond-expiry', wave.x + 40, wave.y), mass = short.owner.mass;
  stepArena(short.arena, .1);
  assert.equal(short.arena.blasts.length, 0); assert.ok(short.arena.dust.includes(beyond)); near(short.owner.mass, mass);

  const blink = fixture(), live = blink.fire(); stepArena(blink.arena, .1);
  const after = blink.put('beyond-blink-landing', live.x + 50, live.y), beforeMass = blink.owner.mass;
  setPlayerInput(blink.arena, blink.owner.id, {}); setPlayerInput(blink.arena, blink.owner.id, { split: true });
  stepArena(blink.arena, 0); assert.ok(blink.owner.lastWaveBlink); assert.equal(blink.arena.blasts.length, 0);
  stepArena(blink.arena, .1);
  assert.ok(blink.arena.dust.includes(after)); near(blink.owner.mass, beforeMass);
});

test('a wave whose original core is gone does not credit a replacement sibling', () => {
  const { arena, owner, fire, put } = fixture(), wave = fire(), source = owner.cells[0];
  owner.cells = [{ ...source, id: 'replacement-core', y: 4500 }];
  const dust = put('orphan-wave-star', wave.x + 30, wave.y), mass = owner.mass;
  stepArena(arena, .1);
  assert.ok(arena.dust.includes(dust)); near(owner.mass, mass); near(owner.score, 0);
});

test('an outgoing wave pickup by a wrapped planet is intercepted by its Dyson occupant', () => {
  const { arena, owner, player, fire, put } = fixture(), target = player('target', 4078);
  fire();
  for (let i = 0; i < 120 && !owner.dysonReady; i++) stepArena(arena, 1 / 120);
  assert.ok(owner.dysonReady);
  setPlayerInput(arena, owner.id, {}); setPlayerInput(arena, owner.id, { split: true }); stepArena(arena, 0);
  assert.ok(owner.dyson); arena.blasts = [];
  owner.stats.growth = 1.6; target.stats.growth = 1.2;
  const outgoing = fire(target), dust = put('target-wave-food', outgoing.x + 30, outgoing.y, 2);
  const ownerMass = owner.mass, targetMass = target.mass, energy = owner.energy;
  stepArena(arena, .1);
  assert.ok(!arena.dust.includes(dust)); near(owner.mass - ownerMass, 3.2); near(target.mass, targetMass);
  near(owner.dyson.capturedMass, 3.2); near(owner.score, 4); near(owner.energy - energy, 8);
});

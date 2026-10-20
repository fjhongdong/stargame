import test from 'node:test';
import assert from 'node:assert/strict';
import { WAVE, SIBLING, createArena, addPlayer, setPlayerInput, stepArena, snapshotArena, waveArcPoint } from '../shared/engine.js';

const near = (actual, expected, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should equal ${expected} within ${tolerance}`);
function fixture() {
  const arena = createArena({ random: () => .99 }); arena.status = 'playing';
  function player(id, x = 1000, y = 1000, mass = 36) {
    const p = addPlayer(arena, { id, name: id });
    Object.assign(p, { x, y, mass, radius: 4 * Math.sqrt(mass), invulnerable: 0 });
    Object.assign(p.cells[0], { x, y, mass, radius: p.radius, vx: 0, vy: 0 });
    return p;
  }
  return { arena, player };
}
function advance(arena, duration, dt = .05) {
  for (let remaining = duration; remaining > 1e-9; remaining -= dt) stepArena(arena, Math.min(dt, remaining));
}
function fire(arena, owner, input = {}) {
  setPlayerInput(arena, owner.id, { ...input, fire: true }); stepArena(arena, .01);
  assert.ok(arena.blasts.length, 'an eligible wave is launched');
  return arena.blasts.at(-1);
}

test('directional waves hit the front while side, rear and out-of-range planets stay safe', () => {
  for (const direction of [{ x: 1, y: 0 }, { x: 0, y: -1 }, { x: .6, y: .8 }]) {
    const { arena, player } = fixture(), owner = player('owner'); owner.direction = direction;
    const front = player('front', 1000 + direction.x * 260, 1000 + direction.y * 260);
    const back = player('back', 1000 - direction.x * 180, 1000 - direction.y * 180);
    const side = player('side', 1000 + direction.x * 180 - direction.y * 200, 1000 + direction.y * 180 + direction.x * 200);
    const beyond = player('beyond', 1000 + direction.x * 700, 1000 + direction.y * 700);
    fire(arena, owner); advance(arena, .8);
    near(front.mass, 36 * .88); assert.ok(front.lastWaveHit);
    for (const safe of [owner, back, side, beyond]) {
      near(safe.mass, 36); assert.equal(safe.lastWaveHit, null);
    }
    assert.equal(arena.blasts.length, 0);
  }
});

test('one wave sheds each intersected cell once and keeps one hit record per victim', () => {
  const { arena, player } = fixture(), owner = player('owner'), target = player('target', 1260, 970);
  target.cells[0].mergeIn = SIBLING.launchGrace;
  target.cells.push({ ...target.cells[0], id: 'other-target-cell', y: 1030 }); target.mass = 72;
  const wave = fire(arena, owner); advance(arena, .6);
  near(target.mass, 72 * .88); assert.equal(wave.hit.size, 1); assert.ok(wave.hit.has(target.id));
  assert.equal(target.lastWaveHit.hitCells, 2);
  assert.equal(arena.dust.filter(dust => dust.fragment && dust.ownerId === target.id).length, 6);
  assert.equal(owner.score, 0); assert.equal(owner.kills, 0);
});

test('a wave leaves a tiny live core without a kill reward or a respawn', () => {
  const { arena, player } = fixture(), owner = player('owner'), target = player('target', 1260, 1000, 1.01);
  const originalCore = target.cells[0].id;
  fire(arena, owner); advance(arena, .65);
  near(target.mass, 1); near(target.lastWaveHit.lostMass, .01);
  assert.equal(target.cells.length, 1); assert.equal(target.cells[0].id, originalCore);
  assert.equal(target.respawnIn, 0); assert.equal(owner.score, 0); assert.equal(owner.kills, 0);
  near(owner.mass, 36); assert.equal(owner.lastWaveHit, null);
});

test('waves honor upgraded cooldown and fresh-edge firing without an energy resource', () => {
  const { arena, player } = fixture(), owner = player('owner');
  owner.stats.blastCooldown = .4;
  fire(arena, owner); near(owner.cooldown, .4);
  assert.ok(!('energy' in owner)); assert.ok(!('blastCost' in owner.stats));
  advance(arena, .1); assert.equal(arena.blasts.length, 1, 'holding fire cannot create repeated waves');
  setPlayerInput(arena, owner.id, { fire: false }); setPlayerInput(arena, owner.id, { fire: true }); stepArena(arena, .01);
  assert.equal(arena.blasts.length, 1, 'cooldown blocks a fresh fire edge');
  advance(arena, .31);
  assert.equal(arena.blasts.length, 1, 'a blocked edge is not queued to fire automatically');
  setPlayerInput(arena, owner.id, { fire: false }); setPlayerInput(arena, owner.id, { fire: true }); stepArena(arena, .01);
  assert.equal(arena.blasts.length, 2); near(owner.cooldown, .4);
  assert.ok(!('energy' in snapshotArena(arena).players[0]));
});

test('launch direction follows actual motion while opposite thrust is still braking', () => {
  const { arena, player } = fixture(), owner = player('owner'); owner.cells[0].vx = 200;
  const wave = fire(arena, owner, { x: -1 });
  assert.ok(owner.cells[0].vx > 0, 'the planet is still physically moving right while braking');
  near(wave.directionX, 1); near(wave.directionY, 0);
  const origin = { x: wave.originX, y: wave.originY };
  advance(arena, .4);
  assert.ok(owner.cells[0].vx < 0, 'opposite thrust eventually reverses the planet');
  near(wave.directionX, 1); near(wave.directionY, 0);
  near(wave.originX, origin.x); near(wave.originY, origin.y);
  near(wave.x, origin.x + wave.travel); near(wave.y, origin.y);
});

test('a stationary one-core wave uses the retained facing and spawns the whole arc outside its source surface', () => {
  const { arena, player } = fixture(), owner = player('owner', 1000, 1000, 100);
  owner.direction = { x: 0, y: -1 };
  const main = owner.cells[0], wave = fire(arena, owner);
  assert.equal(wave.sourceCellId, main.id); near(wave.directionX, 0); near(wave.directionY, -1);
  near(wave.originX, main.x); near(wave.originY, main.y - wave.originOffset);
  near(wave.originOffset, main.radius + wave.thickness / 2 + 4);
  const initial = { ...wave, x: wave.originX, y: wave.originY };
  for (let i = 0; i <= 16; i++) {
    const point = waveArcPoint(initial, -1 + i / 8);
    const distance = Math.hypot(point.x - main.x, point.y - main.y);
    assert.ok(distance - wave.thickness / 2 >= main.radius + 4 - 1e-7, 'the curved tips extend sideways and remain outside the actual round source');
  }
});

test('a range upgrade increases wave travel distance without changing forward propagation speed', () => {
  const { arena, player } = fixture(), owner = player('owner'); owner.stats.blastRange = 1.36;
  const wave = fire(arena, owner);
  const target = player('target', wave.originX + 480, wave.originY);
  near(wave.distance, WAVE.distance * 1.36); assert.equal(wave.speed, WAVE.speed);
  advance(arena, .8); near(target.mass, 36 * .88); assert.ok(arena.blasts.includes(wave));
  advance(arena, .3); assert.ok(!arena.blasts.includes(wave));
});

test('snapshot geometry and viewport culling follow the travelling arc rather than its old origin', () => {
  const { arena, player } = fixture(), owner = player('owner');
  const wave = fire(arena, owner); advance(arena, .45);
  const visible = snapshotArena(arena, { x: wave.x, y: wave.y, width: 40, height: 40, margin: 0 });
  assert.equal(visible.blasts.length, 1);
  const wire = visible.blasts[0];
  assert.equal(wire.kind, 'wave'); assert.equal(wire.mode, 'forward'); assert.equal(wire.sourceCellId, owner.cells[0].id);
  for (const field of ['originX','originY','originOffset','directionX','directionY','width','thickness','curvature','speed','distance','travel','radius','progress']) assert.ok(Number.isFinite(wire[field]), `wire ${field} is finite`);
  near(wire.x, wave.x, .01); near(wire.y, wave.y, .01); assert.ok(wire.progress > 0 && wire.progress < 1);
  const oldOrigin = snapshotArena(arena, { x: wave.originX, y: wave.originY, width: 40, height: 40, margin: 0 });
  assert.equal(oldOrigin.blasts.length, 0);
  assert.ok(!('hit' in wire), 'server-only hit tracking stays private');
});

test('wave sweep hits a tiny target between 100ms endpoints', () => {
  const { arena, player } = fixture(), owner = player('owner'); const wave = fire(arena, owner);
  const target = player('tiny', wave.originX + 100, wave.originY, 8);
  stepArena(arena, .1); assert.equal(target.mass, 8, 'target is still ahead of the thick wavefront');
  const before = wave.x;
  stepArena(arena, .1);
  assert.ok(Math.abs(target.x - before) > target.radius + wave.thickness / 2);
  assert.ok(Math.abs(target.x - wave.x) > target.radius + wave.thickness / 2);
  near(target.mass, 8 * .88); assert.ok(target.lastWaveHit, 'crossing during the step is detected even when both endpoints miss');
});

test('relative motion sweep catches a fast target crossing the wave with both endpoints outside its width', () => {
  const { arena, player } = fixture(), owner = player('owner'); const wave = fire(arena, owner);
  const target = player('crossing', wave.originX + 36, wave.originY + 130, 8);
  target.cells[0].vy = -260 * 2 / (1 - Math.exp(-.2));
  stepArena(arena, .1);
  assert.ok(target.y < wave.originY - 120, 'target ends beyond the far side of the arc');
  near(target.mass, 8 * .88); assert.ok(target.lastWaveHit);
});

test('collision divides each small planet into three or four equal parts and retains one original core', () => {
  for (const mass of [36, 50, 63, 64, 80, 101]) {
    const { arena, player } = fixture(), big = player('big', 1000, 1000, 200);
    const small = player('small', 1000 + big.radius + 4 * Math.sqrt(mass), 1000, mass), coreId = small.cells[0].id;
    stepArena(arena, .01);
    const count = mass < 64 ? 3 : 4;
    const ownFragments = arena.dust.filter(dust => dust.fragment && dust.ownerId === small.id);
    assert.equal(small.cells.length, 1); assert.equal(small.cells[0].id, coreId);
    near(small.mass, mass / count); assert.equal(ownFragments.length, count - 1);
    ownFragments.forEach(fragment => near(fragment.value, small.mass));
    near(big.mass, 190);
    near(big.mass + small.mass + arena.dust.filter(dust => dust.fragment).reduce((sum, dust) => sum + dust.value, 0), 200 + mass);
  }
});

test('the owner may recover all equal fragments after grace without recycled growth or score farming', () => {
  for (const mass of [50, 80]) {
    const { arena, player } = fixture(), big = player('big', 1000, 1000, 200);
    const small = player('small', 1000 + big.radius + 4 * Math.sqrt(mass), 1000, mass);
    small.stats.growth = 1.8;
    stepArena(arena, .01);
    arena.players.delete(big.id);
    arena.dust = arena.dust.filter(dust => dust.fragment && dust.ownerId === small.id);
    arena.dust.forEach(dust => Object.assign(dust, { x: small.x, y: small.y, vx: 0, vy: 0 }));
    Object.assign(small.cells[0], { vx: 0, vy: 0 });
    const coreMass = small.mass;
    stepArena(arena, .1); near(small.mass, coreMass, 1e-8);
    advance(arena, .95);
    near(small.mass, mass); assert.equal(small.score, 0);
    assert.ok(!('energy' in small));
    assert.equal(arena.dust.filter(dust => dust.fragment).length, 0);
  }
});

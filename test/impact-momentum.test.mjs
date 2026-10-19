import test from 'node:test';
import assert from 'node:assert/strict';
import { createArena, addPlayer, stepArena, snapshotArena } from '../shared/engine.js';

const near = (actual, expected, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `${actual} should equal ${expected} within ${tolerance}`);

function fixture({ smallMass = 36, normal = { x: 1, y: 0 }, velocityA = { x: 180, y: 35 }, velocityB = { x: -80, y: -20 } } = {}) {
  const arena = createArena({ random: () => .99 }); arena.status = 'playing';
  const sumRadius = 40 + 4 * Math.sqrt(smallMass);
  const players = [
    { id: 'a-big', mass: 100, position: { x: 1000, y: 1000 }, velocity: velocityA },
    { id: 'b-small', mass: smallMass, position: { x: 1000 + normal.x * sumRadius, y: 1000 + normal.y * sumRadius }, velocity: velocityB },
  ].map(({ id, mass, position, velocity }) => {
    const p = addPlayer(arena, { id, name: id });
    Object.assign(p, { ...position, mass, radius: 4 * Math.sqrt(mass), invulnerable: 0 });
    Object.assign(p.cells[0], { ...position, mass, radius: p.radius, vx: velocity.x, vy: velocity.y });
    return p;
  });
  return { arena, big: players[0], small: players[1] };
}

function material(arena) {
  return [
    ...[...arena.players.values()].flatMap(p => p.cells.map(c => ({ id: `${p.id}:${c.id}`, ownerId: p.id, mass: c.mass, vx: c.vx, vy: c.vy }))),
    ...arena.dust.filter(d => d.fragment).map(d => ({ id: d.id, ownerId: d.ownerId, mass: d.value, vx: d.vx, vy: d.vy })),
  ].sort((a, b) => a.id.localeCompare(b.id));
}
const momentum = parts => parts.reduce((sum, p) => ({ x: sum.x + p.mass * p.vx, y: sum.y + p.mass * p.vy }), { x: 0, y: 0 });

test('fracturing a three- or four-part victim and shedding large-body chips conserves both components of total momentum', () => {
  for (const smallMass of [36, 64, 80]) for (const normal of [{ x: 1, y: 0 }, { x: .6, y: .8 }]) {
    const { arena, big, small } = fixture({ smallMass, normal });
    const before = material(arena), expected = momentum(before);
    stepArena(arena, 0);
    const after = material(arena), actual = momentum(after);
    near(after.reduce((sum, p) => sum + p.mass, 0), before.reduce((sum, p) => sum + p.mass, 0));
    near(actual.x, expected.x); near(actual.y, expected.y);
    near(big.mass, 95); near(small.mass, smallMass / (smallMass < 64 ? 3 : 4));
    assert.equal(after.filter(p => p.ownerId === small.id).length, smallMass < 64 ? 3 : 4);
    assert.ok(big.lastImpact?.fractured); assert.equal(big.lastImpact.id, small.lastImpact.id);
  }
});

test('fragments inherit a uniform change in mother-body velocity without changing relative scatter', () => {
  for (const smallMass of [36, 80]) {
    const velocityA = { x: 180, y: 35 }, velocityB = { x: -80, y: -20 }, shift = { x: 240, y: -130 };
    const original = fixture({ smallMass, velocityA, velocityB });
    const translated = fixture({ smallMass, velocityA: { x: velocityA.x + shift.x, y: velocityA.y + shift.y }, velocityB: { x: velocityB.x + shift.x, y: velocityB.y + shift.y } });
    stepArena(original.arena, 0); stepArena(translated.arena, 0);
    const a = material(original.arena), b = material(translated.arena);
    assert.equal(a.length, b.length);
    a.forEach((part, i) => {
      assert.equal(part.id, b[i].id); near(part.mass, b[i].mass);
      near(b[i].vx - part.vx, shift.x); near(b[i].vy - part.vy, shift.y);
    });
    near(original.big.lastImpact.speed, translated.big.lastImpact.speed);
  }
});

test('harder impacts increase relative fragment spread while preserving its zero net momentum', () => {
  const spreads = [];
  for (const speed of [20, 220, 1200]) {
    const { arena, small } = fixture({ velocityA: { x: speed, y: 25 }, velocityB: { x: 0, y: 25 } });
    stepArena(arena, 0);
    const pieces = material(arena).filter(p => p.ownerId === small.id), mass = pieces.reduce((sum, p) => sum + p.mass, 0);
    const center = momentum(pieces); center.x /= mass; center.y /= mass;
    const spread = pieces.map(p => Math.hypot(p.vx - center.x, p.vy - center.y));
    spread.forEach(value => near(value, spread[0]));
    spreads.push(spread[0]);
  }
  assert.ok(spreads[1] > spreads[0]); near(spreads[2], 300);
});

test('impact metadata identifies the physical contact point and survives serialization without exposing shared references', () => {
  const { arena, big, small } = fixture();
  stepArena(arena, 0);
  const impact = big.lastImpact;
  near(impact.x, 1040); near(impact.y, 1000); near(impact.normalX, 1); near(impact.normalY, 0);
  near(impact.speed, 260); near(impact.radius, 24 * .65);
  assert.equal(impact.fractured, true); assert.equal(impact.at, arena.time);
  const wire = snapshotArena(arena), wireBig = wire.players.find(p => p.id === big.id), wireSmall = wire.players.find(p => p.id === small.id);
  assert.deepEqual(wireBig.lastImpact, impact); assert.deepEqual(wireSmall.lastImpact, impact);
  wireBig.lastImpact.x = -100;
  near(big.lastImpact.x, 1040); near(wireSmall.lastImpact.x, 1040);
});

test('one sustained physical contact episode emits one impact; separate contact emits a new one', () => {
  const { arena, big, small } = fixture({ smallMass: 100, velocityA: { x: 100, y: 0 }, velocityB: { x: 0, y: 0 } });
  stepArena(arena, 0);
  const first = big.lastImpact.id;
  assert.equal(big.lastImpact.fractured, false);
  for (let i = 0; i < 10; i++) {
    Object.assign(big.cells[0], { vx: 100, vy: 0 }); Object.assign(small.cells[0], { vx: 0, vy: 0 });
    stepArena(arena, 0);
    assert.equal(big.lastImpact.id, first); assert.equal(small.lastImpact.id, first);
  }
  small.cells[0].x += 100; stepArena(arena, 0);
  small.cells[0].x = big.cells[0].x + big.cells[0].radius + small.cells[0].radius;
  Object.assign(big.cells[0], { vx: 100, vy: 0 }); Object.assign(small.cells[0], { vx: 0, vy: 0 });
  stepArena(arena, 0);
  assert.notEqual(big.lastImpact.id, first); assert.equal(big.lastImpact.id, small.lastImpact.id);
  assert.equal(arena.dust.filter(d => d.fragment).length, 0);
});

test('resting or gentle equal-mass contact has no false violent impact effect', () => {
  for (const speed of [0, 8, 12]) {
    const { arena, big, small } = fixture({ smallMass: 100, velocityA: { x: speed, y: 0 }, velocityB: { x: 0, y: 0 } });
    stepArena(arena, 0);
    assert.equal(big.lastImpact, null); assert.equal(small.lastImpact, null);
    assert.equal(arena.dust.filter(d => d.fragment).length, 0);
  }
});

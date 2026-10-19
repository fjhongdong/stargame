import test from 'node:test';
import assert from 'node:assert/strict';
import { createArena, addPlayer, stepArena } from '../shared/engine.js';

function fixture(bigMass = 100, smallMass = 36) {
  const arena = createArena({ random: () => .99 }); arena.status = 'playing';
  const players = [bigMass, smallMass].map((mass, i) => {
    const p = addPlayer(arena, { id: i ? 'small' : 'big' });
    const x = 1000 + (i ? 4 * Math.sqrt(bigMass) + 4 * Math.sqrt(smallMass) : 0);
    Object.assign(p, { x, y: 1000, mass, radius: 4 * Math.sqrt(mass), invulnerable: 0 });
    Object.assign(p.cells[0], { x, y: 1000, mass, radius: p.radius, vx: 0, vy: 0 });
    return p;
  });
  return { arena, big: players[0], small: players[1] };
}
const fragments = arena => arena.dust.filter(d => d.fragment);
function assertConserved(arena, expected) {
  const mass = [...arena.players.values()].reduce((sum, p) => sum + p.mass, 0) + fragments(arena).reduce((sum, d) => sum + d.value, 0);
  assert.ok(Math.abs(mass - expected) < 1e-8);
}

for (const protection of ['spawn', 'core', 'cooldown']) {
  test(`a first contact blocked by ${protection} protection may fracture when it expires, without requiring artificial separation`, () => {
    const { arena, big, small } = fixture();
    if (protection === 'spawn') small.invulnerable = .2;
    if (protection === 'core') small.cells[0].protectedFor = .2;
    if (protection === 'cooldown') small.cells[0].shatterCooldown = .2;
    stepArena(arena, .1);
    assert.equal(fragments(arena).length, 0, 'contact must preserve the explicit protection window');
    assert.equal(big.mass, 100); assert.equal(small.mass, 36);
    // No controls or teleports intervene: the same two solid bodies remain
    // touching while the temporary protection naturally runs out.
    for (let frame = 0; frame < 16 && !fragments(arena).length; frame++) stepArena(arena, .025);
    assert.ok(arena.time >= .2 - 1e-8);
    assert.equal(fragments(arena).length, 5, 'a failed protected attempt must not permanently consume the successful-fracture episode lock');
    assert.equal(big.mass, 95); assert.equal(small.mass, 12);
    assert.equal(small.cells.length, 1); assertConserved(arena, 136);
  });
}

test('equal-size contact can fracture once real dust growth makes one touching planet larger', () => {
  const { arena, big, small } = fixture(100, 100);
  stepArena(arena, 0);
  assert.equal(fragments(arena).length, 0, 'equal bodies block each other without fracturing');
  arena.dust.push({ id: 'natural-growth', x: big.x, y: big.y, value: 1, vx: 0, vy: 0 });
  stepArena(arena, .01);
  assert.equal(fragments(arena).length, 6, 'an equal-size first contact must not suppress a newly eligible collision after growth');
  assert.ok(Math.abs(big.mass - 95.95) < 1e-8); assert.equal(small.mass, 25);
  assert.equal(small.cells.length, 1); assertConserved(arena, 201);
});

test('a successful fracture stays locked through continuous contact after cooldown, then unlocks after real separation', () => {
  const { arena, big, small } = fixture(200, 90);
  stepArena(arena, .01);
  assert.equal(big.mass, 190); assert.equal(small.mass, 22.5);
  const firstFracture = small.shatteredAt;
  for (let frame = 0; frame < 80; frame++) {
    for (const dust of fragments(arena)) Object.assign(dust, { x: 11000, y: 7000, vx: 0, vy: 0 });
    for (const p of [big, small]) Object.assign(p.cells[0], { vx: 0, vy: 0 });
    // Keep exerting contact rather than letting the fracture's recoil create
    // the separate-and-return episode required for a second fracture.
    small.cells[0].x = big.cells[0].x + big.cells[0].radius + small.cells[0].radius;
    small.cells[0].y = big.cells[0].y;
    stepArena(arena, .05);
  }
  assert.equal(small.cells[0].shatterCooldown, 0);
  assert.equal(small.shatteredAt, firstFracture, 'protection expiry alone must not farm a second successful fracture in the same contact episode');
  assert.equal(big.mass, 190); assert.equal(small.mass, 22.5); assertConserved(arena, 290);
  small.cells[0].x += 20; stepArena(arena, 0);
  small.cells[0].x = big.cells[0].x + big.cells[0].radius + small.cells[0].radius;
  stepArena(arena, 0);
  assert.ok(Math.abs(big.mass - 180.5) < 1e-8); assert.equal(small.mass, 7.5);
  assertConserved(arena, 290);
});

test('a previously fractured twelve-mass core can fracture again after its protection and cooldown expire', () => {
  const { arena, big, small } = fixture();
  stepArena(arena, .01);
  assert.equal(small.mass, 12);
  for (let frame = 0; frame < 40; frame++) {
    for (const dust of fragments(arena)) Object.assign(dust, { x: 11000, y: 7000, vx: 0, vy: 0 });
    stepArena(arena, .1);
  }
  assert.equal(small.cells[0].protectedFor, 0); assert.equal(small.cells[0].shatterCooldown, 0);
  assert.equal(small.mass, 12);
  small.cells[0].x = big.cells[0].x + big.cells[0].radius + small.cells[0].radius;
  small.cells[0].y = big.cells[0].y;
  stepArena(arena, 0);
  assert.equal(small.mass, 4, 'the original 36→12 fracture must not turn its still-visible core permanently immune to subsequent real collisions');
  assert.ok(Math.abs(big.mass - 90.25) < 1e-8); assertConserved(arena, 136);
});

test('the minimum fracture produces three parts of at least one mass, while smaller cores remain solid', () => {
  for (const mass of [3, 4, 8, 12, 15.99]) {
    const { arena, small } = fixture(100, mass); stepArena(arena, 0);
    assert.ok(Math.abs(small.mass - mass / 3) < 1e-8);
    const pieces = fragments(arena).filter(d => d.ownerId === small.id);
    assert.equal(pieces.length, 2);
    assert.ok(pieces.every(d => d.value >= 1 && Math.abs(d.value - small.mass) < 1e-8));
    assertConserved(arena, 100 + mass);
  }
  for (const mass of [1, 2.99]) {
    const { arena, big, small } = fixture(100, mass); stepArena(arena, 0);
    assert.equal(small.mass, mass); assert.equal(big.mass, 100); assert.equal(fragments(arena).length, 0);
    assert.ok(Math.hypot(big.x - small.x, big.y - small.y) >= big.radius + small.radius - 1e-6);
  }
});

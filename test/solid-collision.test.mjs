import test from 'node:test';
import assert from 'node:assert/strict';
import { ARENA, createArena, addPlayer, setPlayerInput, stepArena, snapshotArena } from '../shared/engine.js';

function fixture(definitions = [
  { id: 'big', mass: 100, x: 1000, y: 1000 },
  { id: 'small', mass: 36, x: 1064, y: 1000 },
]) {
  const arena = createArena({ random: () => .99 });
  arena.status = 'playing';
  const players = definitions.map(({ id, mass, x, y }) => {
    const player = addPlayer(arena, { id, name: id });
    Object.assign(player, { x, y, mass, radius: 4 * Math.sqrt(mass), invulnerable: 0 });
    Object.assign(player.cells[0], { id: `${id}-core`, x, y, mass, radius: player.radius, vx: 0, vy: 0 });
    return player;
  });
  return { arena, players };
}
const loose = arena => arena.dust.filter(dust => dust.fragment || dust.ejected);
const totalMass = arena => [...arena.players.values()].reduce((sum, p) => sum + p.mass, 0) + loose(arena).reduce((sum, dust) => sum + dust.value, 0);
const near = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should be within ${tolerance} of ${expected}`);
function assertSolid(arena, tolerance = 1e-5) {
  const bodies = [...arena.players.values()].flatMap(player => player.cells.map(cell => ({ player, cell })));
  for (const { cell } of bodies) {
    assert.ok(Number.isFinite(cell.x) && Number.isFinite(cell.y));
    assert.ok(cell.x >= cell.radius - tolerance && cell.x <= ARENA.width - cell.radius + tolerance);
    assert.ok(cell.y >= cell.radius - tolerance && cell.y <= ARENA.height - cell.radius + tolerance);
  }
  for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
    const a = bodies[i], b = bodies[j];
    if (a.player === b.player) continue;
    assert.ok(Math.hypot(a.cell.x - b.cell.x, a.cell.y - b.cell.y) >= a.cell.radius + b.cell.radius - tolerance,
      `${a.player.id}/${b.player.id} retain intersecting solid bodies`);
  }
}
function parkLooseMass(arena) {
  for (const dust of loose(arena)) Object.assign(dust, { x: 11000, y: 7000, vx: 0, vy: 0 });
}

test('outer-edge contact fractures the smaller core and chips exactly 5% from the larger planet', () => {
  const { arena, players: [big, small] } = fixture();
  const coreId = small.cells[0].id;
  stepArena(arena, .01);
  assert.equal(big.mass, 95);
  assert.equal(small.mass, 18);
  assert.equal(small.cells.length, 1);
  assert.equal(small.cells[0].id, coreId, 'the original controllable core remains owned by the player');
  const debris = loose(arena);
  assert.equal(debris.filter(dust => dust.ownerId === small.id).length, 2);
  assert.equal(debris.filter(dust => dust.ownerId === big.id).length, 3);
  near(debris.filter(dust => dust.ownerId === small.id).reduce((sum, d) => sum + d.value, 0), 18);
  near(debris.filter(dust => dust.ownerId === big.id).reduce((sum, d) => sum + d.value, 0), 5);
  near(totalMass(arena), 136);
  assert.ok(debris.every(dust => dust.fragment && dust.collectAfter > arena.time && dust.availableAt > dust.collectAfter));
  assert.equal(big.score, 0); assert.equal(small.score, 0);
  assertSolid(arena);
  const snapshot = snapshotArena(arena);
  assert.ok(snapshot.players.every(player => player.collisionRevision > 0));
  assert.equal(snapshot.dust.filter(dust => dust.fragment).length, 5);
});

test('a positive gap does not collide and a strictly larger 1.1x planet can fracture on contact', () => {
  const sumRadius = 4 * Math.sqrt(44) + 4 * Math.sqrt(40);
  for (const gap of [.0001, 1]) {
    const { arena, players: [a, b] } = fixture([
      { id: 'a', mass: 44, x: 1000, y: 1000 }, { id: 'b', mass: 40, x: 1000 + sumRadius + gap, y: 1000 },
    ]);
    stepArena(arena, .01);
    assert.equal(a.mass, 44); assert.equal(b.mass, 40); assert.equal(loose(arena).length, 0);
  }
  const { arena, players: [a, b] } = fixture([
    { id: 'a', mass: 44, x: 1000, y: 1000 }, { id: 'b', mass: 40, x: 1000 + sumRadius, y: 1000 },
  ]);
  stepArena(arena, .01);
  near(a.mass, 41.8); near(b.mass, 20); near(totalMass(arena), 84);
  assertSolid(arena);
});

test('equal planets block each other without shedding mass, even from a deep initial overlap', () => {
  const { arena, players: [a, b] } = fixture([
    { id: 'a', mass: 36, x: 1000, y: 1000 }, { id: 'b', mass: 36, x: 1020, y: 1000 },
  ]);
  stepArena(arena, .01);
  assertSolid(arena);
  assert.equal(a.mass, 36); assert.equal(b.mass, 36); assert.equal(loose(arena).length, 0);
});

test('spawn protection, core protection and fracture cooldown preserve solid bodies', () => {
  for (const protection of ['spawn', 'core', 'cooldown']) {
    const { arena, players: [big, small] } = fixture([
      { id: 'big', mass: 100, x: 1000, y: 1000 }, { id: 'small', mass: 36, x: 1040, y: 1000 },
    ]);
    if (protection === 'spawn') small.invulnerable = 1;
    if (protection === 'core') small.cells[0].protectedFor = 1;
    if (protection === 'cooldown') small.cells[0].shatterCooldown = 3;
    stepArena(arena, .01);
    assertSolid(arena);
    assert.equal(big.mass, 100); assert.equal(small.mass, 36); assert.equal(loose(arena).length, 0);
  }
});

test('persistent contact cannot repeatedly fracture after cooldown; separating and colliding again can', () => {
  const { arena, players: [big, small] } = fixture();
  stepArena(arena, .01);
  const fracturedAt = small.shatteredAt;
  // Keep the bodies touching with zero external momentum, while loose mass is
  // moved out of pickup range so it cannot change the bodies in this fixture.
  for (let frame = 0; frame < 80; frame++) {
    parkLooseMass(arena);
    for (const p of [big, small]) Object.assign(p.cells[0], { vx: 0, vy: 0 });
    small.cells[0].x = big.cells[0].x + big.cells[0].radius + small.cells[0].radius;
    small.cells[0].y = big.cells[0].y;
    stepArena(arena, .05);
  }
  assert.equal(small.shatteredAt, fracturedAt);
  assert.equal(big.mass, 95); assert.equal(small.mass, 18);
  near(totalMass(arena), 136);
  small.cells[0].x += 200; stepArena(arena, .01);
  small.cells[0].x = big.cells[0].x + big.cells[0].radius + small.cells[0].radius;
  stepArena(arena, .01);
  assert.ok(small.shatteredAt > fracturedAt);
  near(big.mass, 90.25); near(small.mass, 9); near(totalMass(arena), 136);
  assertSolid(arena);
});

test('cores too small to fracture still collide and are never swallowed whole', () => {
  const { arena, players: [big, small] } = fixture([
    { id: 'big', mass: 100, x: 1000, y: 1000 }, { id: 'small', mass: 8, x: 1000, y: 1000 },
  ]);
  stepArena(arena, .01);
  assertSolid(arena);
  assert.equal(big.mass, 100); assert.equal(small.mass, 8);
  assert.equal(small.cells.length, 1); assert.equal(small.respawnIn, 0); assert.equal(loose(arena).length, 0);
});

test('swept circle contact stops legal high-speed split launches tunneling across each other', () => {
  for (const masses of [[144, 36], [36, 36]]) {
    const { arena, players: [a, b] } = fixture([
      { id: 'a', mass: masses[0], x: 1000, y: 1000 }, { id: 'b', mass: masses[1], x: 1080, y: 1000 },
    ]);
    a.cells[0].vx = 650 + 360 * Math.pow(36 / a.mass, .18);
    b.cells[0].vx = -(650 + 360 * Math.pow(36 / b.mass, .18));
    setPlayerInput(arena, a.id, { x: 1, boost: true }); setPlayerInput(arena, b.id, { x: -1, boost: true });
    stepArena(arena, .1);
    assert.ok(a.cells[0].x < b.cells[0].x, 'the two bodies keep their spatial order through the collision');
    assertSolid(arena); near(totalMass(arena), masses[0] + masses[1]);
    assert.equal(loose(arena).length > 0, masses[0] !== masses[1]);
  }
});

test('glancing near misses stay independent at high speed', () => {
  const { arena, players: [a, b] } = fixture([
    { id: 'a', mass: 36, x: 1000, y: 1000 }, { id: 'b', mass: 36, x: 1080, y: 1048.01 },
  ]);
  a.cells[0].vx = 1010; b.cells[0].vx = -1010;
  setPlayerInput(arena, a.id, { x: 1, boost: true }); setPlayerInput(arena, b.id, { x: -1, boost: true });
  stepArena(arena, .1);
  assert.ok(a.x > b.x, 'separated trajectories may pass without a false collision');
  assert.equal(a.collisionRevision, 0); assert.equal(b.collisionRevision, 0);
  assert.equal(loose(arena).length, 0);
});

test('wall and corner piles separate without leaving the arena', () => {
  for (const positions of [[[24, 1000], [40, 1000], [56, 1000], [72, 1000]], [[24, 24], [45, 24], [24, 45], [45, 45]]]) {
    const { arena } = fixture(positions.map(([x, y], index) => ({ id: `p${index}`, mass: 36, x, y })));
    stepArena(arena, .01);
    assertSolid(arena, .001);
    near(totalMass(arena), 144); assert.equal(loose(arena).length, 0);
  }
});

test('collision results do not depend on player Map insertion order', () => {
  const definitions = [
    { id: 'a', mass: 100, x: 1000, y: 1000 }, { id: 'b', mass: 36, x: 1040, y: 1000 },
    { id: 'c', mass: 44, x: 1040, y: 1040 },
  ];
  function simulate(reverse) {
    const { arena } = fixture(definitions);
    if (reverse) arena.players = new Map([...arena.players].reverse());
    stepArena(arena, .03);
    const players = [...arena.players.values()].sort((a, b) => a.id.localeCompare(b.id)).map(p => ({ id: p.id, mass: p.mass,
      cells: p.cells.map(c => ({ x: c.x, y: c.y, vx: c.vx, vy: c.vy, mass: c.mass })) }));
    return { players, debris: loose(arena).map(d => ({ ownerId: d.ownerId, value: d.value, x: d.x, y: d.y })) };
  }
  assert.deepEqual(simulate(false), simulate(true));
});

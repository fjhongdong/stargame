import test from 'node:test';
import assert from 'node:assert/strict';
import { ARENA, MOTION, createArena, addPlayer, setPlayerInput, stepArena, snapshotArena } from '../shared/engine.js';

const near = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `${actual} should equal ${expected} within ${tolerance}`);
const jitter = [1 / 60, .043, .009, .025, .083];
function fixture(definitions) {
  const arena = createArena({ random: () => .99 }); arena.status = 'playing';
  const players = definitions.map(({ x, y, vx = 0, vy = 0, input = {} }, i) => {
    const p = addPlayer(arena, { id: `p${i}`, name: `p${i}` });
    Object.assign(p, { x, y, mass: 36, radius: 24, invulnerable: 100 });
    Object.assign(p.cells[0], { x, y, mass: 36, radius: 24, vx, vy });
    setPlayerInput(arena, p.id, input);
    return p;
  });
  return { arena, players };
}
function advance(arena, duration, schedule = jitter, sample = () => {}) {
  let elapsed = 0, frame = 0;
  while (elapsed < duration - 1e-9) {
    const dt = Math.min(schedule[frame++ % schedule.length], duration - elapsed);
    stepArena(arena, dt); elapsed += dt; sample(elapsed, dt);
  }
}

test('a six-body chain under sustained thrust publishes stationary velocity at a wall, even with irregular ticks', () => {
  const { arena, players } = fixture(Array.from({ length: 6 }, (_, i) => ({
    x: ARENA.width - 24 - 48 * (5 - i), y: 3000, input: { x: 1 },
  })));
  advance(arena, .5);
  const settled = players.map(p => ({ x: p.x, y: p.y, revision: p.collisionRevision }));
  advance(arena, 2, [...jitter, .1], () => {
    players.forEach((p, i) => {
      near(p.x, settled[i].x, .0001); near(p.y, settled[i].y, .0001);
      assert.ok(Math.hypot(p.vx, p.vy) < .001, 'a supported body must not advertise forward velocity while its position is fixed');
      assert.equal(p.collisionRevision, settled[i].revision, 'ordinary support forces must not publish a new collision revision every tick');
    });
    snapshotArena(arena).players.forEach(p => { near(p.vx, 0); near(p.vy, 0); });
  });
});

test('opposite sustained thrust settles after the first impact instead of causing an endless sequence of rebounds', () => {
  const { arena, players } = fixture([
    { x: 2000, y: 2000, input: { x: 1 } }, { x: 2160, y: 2000, input: { x: -1 } },
  ]);
  advance(arena, 2);
  const settled = players.map(p => ({ x: p.x, y: p.y, revision: p.collisionRevision })), impactSerial = arena.impactSerial;
  assert.ok(impactSerial > 0, 'the initial physical impact is still reported');
  advance(arena, 1, jitter, () => players.forEach((p, i) => {
    near(p.x, settled[i].x, .001); near(p.y, settled[i].y, .001);
    assert.ok(Math.hypot(p.vx, p.vy) < .001);
    assert.equal(p.collisionRevision, settled[i].revision);
    near(p.mass, 36);
  }));
  assert.equal(arena.impactSerial, impactSerial, 'resting contact must not repeatedly emit impact effects');
});

test('a positive near-contact gap does not silently erase an incoming high-speed collision', () => {
  const { arena, players: [a, b] } = fixture([
    { x: 2000, y: 2000, vx: 300 },
    { x: 2048 + MOTION.contactSlop / 2, y: 2000, vx: -100 },
  ]);
  stepArena(arena, 0);
  near(a.vx, 300); near(b.vx, -100);
  assert.equal(a.lastImpact, null); assert.equal(b.lastImpact, null);
  assert.equal(a.collisionRevision, 0); assert.equal(b.collisionRevision, 0);
  stepArena(arena, MOTION.physicsStep);
  assert.ok(a.lastImpact?.speed > MOTION.restingThreshold, 'the ensuing real impact retains its incoming speed');
  assert.ok((b.vx - a.vx) > 0, 'a genuine high-speed collision still rebounds');
});

test('low-speed contacts remove only closing normal motion and preserve tangential velocity and momentum', () => {
  const normal = { x: .6, y: .8 }, tangent = { x: -.8, y: .6 };
  for (const closing of [30, 220]) {
    const aNormal = closing / 2 + 7, bNormal = 7 - closing / 2;
    const { arena, players: [a, b] } = fixture([
      { x: 2000, y: 2000, vx: normal.x * aNormal + tangent.x * 35, vy: normal.y * aNormal + tangent.y * 35 },
      { x: 2000 + normal.x * 48, y: 2000 + normal.y * 48, vx: normal.x * bNormal - tangent.x * 20, vy: normal.y * bNormal - tangent.y * 20 },
    ]);
    const momentum = { x: 36 * (a.cells[0].vx + b.cells[0].vx), y: 36 * (a.cells[0].vy + b.cells[0].vy) };
    stepArena(arena, 0);
    near(a.vx * tangent.x + a.vy * tangent.y, 35);
    near(b.vx * tangent.x + b.vy * tangent.y, -20);
    near(36 * (a.vx + b.vx), momentum.x); near(36 * (a.vy + b.vy), momentum.y);
    near((b.vx - a.vx) * normal.x + (b.vy - a.vy) * normal.y, closing > MOTION.restingThreshold ? closing * MOTION.restitution : 0);
  }
});

test('wall support removes normal thrust while preserving smooth motion along the wall', () => {
  const { arena, players } = fixture(Array.from({ length: 4 }, (_, i) => ({
    x: ARENA.width - 24 - 48 * (3 - i), y: 3000, input: { x: .6, y: .8 },
  })));
  const originalX = players.map(p => p.x), targetY = 210 * .8;
  advance(arena, 1.5, jitter, elapsed => {
    const expectedV = targetY * (1 - Math.exp(-MOTION.response * elapsed));
    const expectedY = 3000 + targetY * (elapsed - (1 - Math.exp(-MOTION.response * elapsed)) / MOTION.response);
    players.forEach((p, i) => {
      near(p.x, originalX[i], .0001); near(p.y, expectedY, .0001);
      near(p.vx, 0, .001); near(p.vy, expectedV, .0001);
    });
  });
});

test('a fast off-center encounter remains consistent with a fine-step reference across coarse and irregular tick schedules', () => {
  const definitions = [
    { x: 2000, y: 2000, vx: 850 }, { x: 2070, y: 2037, vx: -50 },
  ];
  for (const schedule of [[1 / 30], [.1], jitter]) {
    const tested = fixture(definitions), reference = fixture(definitions);
    let maxError = 0;
    for (let frame = 0; frame < 20; frame++) {
      const dt = schedule[frame % schedule.length];
      stepArena(tested.arena, dt);
      const steps = Math.ceil(dt * 480);
      for (let i = 0; i < steps; i++) stepArena(reference.arena, dt / steps);
      tested.players.forEach((p, i) => { maxError = Math.max(maxError, Math.hypot(p.x - reference.players[i].x, p.y - reference.players[i].y)); });
    }
    assert.ok(maxError < .5, `contact physics diverged ${maxError} units from the reference with schedule ${schedule}`);
  }
});

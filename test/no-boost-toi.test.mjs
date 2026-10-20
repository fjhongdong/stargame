import test from 'node:test';
import assert from 'node:assert/strict';
import { createArena, addPlayer, setPlayerInput, stepArena, snapshotArena, MOTION } from '../shared/engine.js';

function fixture(specs) {
  const arena = createArena({ random: () => 0.99 });
  arena.status = 'playing';
  for (const { id, x, y = 2000, vx = 0, vy = 0, mass = 36 } of specs) {
    const player = addPlayer(arena, { id });
    Object.assign(player, { x, y, mass, radius: 4 * Math.sqrt(mass), invulnerable: 100 });
    Object.assign(player.cells[0], { x, y, vx, vy, mass, radius: player.radius });
  }
  return arena;
}

test('legacy boost input cannot alter movement or the public steering state', () => {
  const normal = fixture([{ id: 'p', x: 1000 }]);
  const legacy = fixture([{ id: 'p', x: 1000 }]);
  setPlayerInput(normal, 'p', { x: 1, y: 0 });
  setPlayerInput(legacy, 'p', { x: 1, y: 0, boost: true });
  for (let i = 0; i < 30; i++) { stepArena(normal, 1 / 30); stepArena(legacy, 1 / 30); }
  const a = normal.players.get('p'), b = legacy.players.get('p');
  assert.equal(a.x, b.x);
  assert.equal(a.vx, b.vx);
  assert.ok(a.vx < 210);
  assert.ok(!('energy' in a)); assert.ok(!('energy' in b));
  assert.ok(!('boost' in b.input));
  const wire = snapshotArena(legacy).players[0];
  assert.deepEqual(wire.steering, { x: 1, y: 0 });
  assert.ok(!('boosting' in wire));
});

test('a head-on impact advances the remaining substep with its outgoing velocity', () => {
  const arena = fixture([{ id: 'a', x: 1000, vx: 200 }, { id: 'b', x: 1080, vx: -200 }]);
  const duration = 0.1, initialGap = 32, relativeVelocity = 400;
  const hitTime = -Math.log(1 - MOTION.drag * initialGap / relativeVelocity) / MOTION.drag;
  const outgoingRelative = relativeVelocity * Math.exp(-MOTION.drag * hitTime) * MOTION.restitution;
  const expectedGap = outgoingRelative * (1 - Math.exp(-MOTION.drag * (duration - hitTime))) / MOTION.drag;
  stepArena(arena, duration);
  const a = arena.players.get('a'), b = arena.players.get('b');
  assert.ok(Math.abs(b.x - a.x - 48 - expectedGap) < 1e-8);
  assert.ok(expectedGap > 0.8, 'there is meaningful outgoing travel left after the contact');
  assert.ok(Math.abs(a.lastImpact.at - hitTime) < 1e-9);
  assert.ok(Math.abs(a.lastImpact.x - 1040) < 1e-8);
  assert.ok(Math.abs(a.vx * 36 + b.vx * 36) < 1e-8);
});

test('coarse head-on and glancing encounters agree with a fine-step trajectory', () => {
  for (const offset of [0, 37]) {
    const specs = [{ id: 'a', x: 2000, vx: 850 }, { id: 'b', x: 2070, y: 2000 + offset, vx: -50 }];
    const coarse = fixture(specs), fine = fixture(specs);
    stepArena(coarse, 0.1);
    for (let i = 0; i < 480; i++) stepArena(fine, 0.1 / 480);
    for (const [id, a] of coarse.players) {
      const b = fine.players.get(id);
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 0.002);
      assert.ok(Math.hypot(a.vx - b.vx, a.vy - b.vy) < 0.002);
      assert.ok(Math.abs(a.lastImpact.at - b.lastImpact.at) < 1e-5);
    }
  }
});

test('an earlier impact invalidates a planned collision that its new path no longer reaches', () => {
  const arena = fixture([{ id: 'a', x: 1000, vx: 2000 }, { id: 'b', x: 1050 },
    { id: 'c', x: 1032, y: 2045 }]);
  stepArena(arena, 1 / 120);
  const third = arena.players.get('c');
  assert.equal(third.vx, 0);
  assert.equal(third.vy, 0);
  assert.equal(third.x, 1032);
  assert.equal(third.y, 2045);
  assert.equal(third.lastImpact, null);
});

test('the outgoing remainder can collide with a third body without tunneling', () => {
  const radiusA = 24, radiusB = 4 * Math.sqrt(1000), radiusC = 4 * Math.sqrt(12);
  const arena = fixture([{ id: 'a', x: 1000, vx: 2000 },
    { id: 'b', x: 1000 + radiusA + radiusB + 1, mass: 1000 },
    { id: 'c', x: 1000 - radiusA - radiusC - 0.2, mass: 12 }]);
  stepArena(arena, 1 / 120);
  const a = arena.players.get('a'), b = arena.players.get('b'), c = arena.players.get('c');
  assert.ok(c.vx < 0 && c.lastImpact, 'the rebounding body reaches the initially untouched third planet');
  assert.ok(a.x > c.x && Math.hypot(a.x - c.x, a.y - c.y) >= radiusA + radiusC - 1e-6);
  assert.ok(b.lastImpact.at <= c.lastImpact.at);
  assert.ok(Math.abs(a.mass * a.vx + b.mass * b.vx + c.mass * c.vx - 36 * 2000 * Math.exp(-MOTION.drag / 120)) < 1e-6);
});

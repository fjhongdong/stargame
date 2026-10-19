import test from 'node:test';
import assert from 'node:assert/strict';
import { ARENA, createArena, addPlayer, setPlayerInput, stepArena, snapshotArena, startRound, integrateMotion } from '../shared/engine.js';

function fixture(positions = [[1000, 1000]], mass = 36) {
  const arena = createArena({ random: () => 0.99 });
  arena.status = 'playing';
  const player = addPlayer(arena, { id: 'controlled' });
  player.cells = positions.map(([x, y], index) => ({ ...player.cells[0], id: `controlled-${index}`,
    x, y, mass, radius: 4 * Math.sqrt(mass) }));
  player.mass = mass * positions.length;
  player.x = positions.reduce((sum, position) => sum + position[0], 0) / positions.length;
  player.y = positions.reduce((sum, position) => sum + position[1], 0) / positions.length;
  return { arena, player };
}

test('single and separated multiple cells accelerate in all four directions without centroid drift', () => {
  for (const positions of [[[1000, 1000]], [[1000, 1000], [1800, 1400]]]) {
    for (const direction of [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }]) {
      const { arena, player } = fixture(positions);
      setPlayerInput(arena, player.id, direction);
      for (let tick = 0; tick < 6; tick++) stepArena(arena, 1 / 30);
      player.cells.forEach((cell, index) => {
        const dx = cell.x - positions[index][0], dy = cell.y - positions[index][1];
        if (direction.x) assert.ok(dx * direction.x > 0 && Math.abs(dx) < 42);
        else assert.equal(dx, 0);
        if (direction.y) assert.ok(dy * direction.y > 0 && Math.abs(dy) < 42);
        else assert.equal(dy, 0);
      });
    }
  }
});

test('opposite input first brakes persistent velocity, then reverses direction', () => {
  const { arena, player } = fixture([[1000, 1000], [1800, 1400]]);
  for (const cell of player.cells) Object.assign(cell, { vx: 210, vy: 0 });
  setPlayerInput(arena, player.id, { x: -1, y: 0 });
  stepArena(arena, 0.05);
  assert.ok(player.cells.every(cell => cell.vx > 0 && cell.vx < 210));
  assert.equal(player.cells[0].y, 1000);
  assert.equal(player.cells[1].y, 1400);
  for (let tick = 0; tick < 10; tick++) stepArena(arena, 0.05);
  assert.ok(player.cells.every(cell => cell.vx < 0));
  assert.ok(player.cells[0].x < 1000 && player.cells[1].x < 1800);
});

test('split launch exposes persistent velocity and release damps it naturally', () => {
  const { arena, player } = fixture([[1000, 1000]], 100);
  setPlayerInput(arena, player.id, { x: 1, split: true });
  stepArena(arena, 0.01);
  assert.equal(player.cells.length, 2);
  assert.equal(player.mass, 100);
  assert.ok(player.cells[0].x > 1000, 'splitting while moving right must not push the original cell left');
  assert.ok(player.cells.every(cell => cell.y === 1000));
  assert.ok(player.cells[1].vx > player.cells[0].vx + 200);
  const snapshot = snapshotArena(arena).players[0];
  assert.ok(snapshot.cells[1].vx > 200);
  assert.equal(snapshot.cells[1].impulseX, 0);
  assert.equal(snapshot.cells[1].impulseY, 0);
  setPlayerInput(arena, player.id, {});
  const before = player.cells.map(cell => ({ x: cell.x, y: cell.y }));
  stepArena(arena, 1 / 30);
  assert.ok(player.cells[1].x > before[1].x);
  assert.ok(player.cells[1].vx > 0 && player.cells[1].vx < snapshot.cells[1].vx);
});

test('diagonal movement has equal directional components and normalized total speed', () => {
  const { arena, player } = fixture([[1000, 1000], [1800, 1400]]);
  setPlayerInput(arena, player.id, { x: 1, y: -1 });
  stepArena(arena, 0.1);
  player.cells.forEach((cell, index) => {
    const dx = cell.x - [1000, 1800][index], dy = cell.y - [1000, 1400][index];
    assert.ok(Math.abs(dx + dy) < 1e-9);
    assert.ok(Math.hypot(dx, dy) > 0 && Math.hypot(dx, dy) < 21);
  });
});

test('free fragments drift while initially stationary controlled cells stay at rest', () => {
  const { arena, player } = fixture();
  const fragment = { id: 'free', x: 3000, y: 3000, vx: 200, vy: 0, value: 8, fragment: true };
  arena.dust = [fragment];
  setPlayerInput(arena, player.id, {});
  stepArena(arena, 0.1);
  assert.equal(player.cells[0].x, 1000);
  assert.equal(player.cells[0].impulseX, 0);
  assert.equal(fragment.x, 3020);
  assert.ok(fragment.vx > 0 && fragment.vx < 200);
});

test('acknowledged input age counts applied simulation time, resets for a new sequence and ignores stale input', () => {
  const { arena, player } = fixture();
  setPlayerInput(arena, player.id, { x: 1, y: 0, seq: 4 });
  assert.equal(player.inputAge, 0);
  assert.equal(player.lastInputSeq, 0);
  stepArena(arena, 0.02);
  assert.equal(player.lastInputSeq, 4);
  assert.equal(player.inputAge, 0.02);
  stepArena(arena, 0.03);
  assert.equal(player.inputAge, 0.05);
  setPlayerInput(arena, player.id, { x: -1, y: 0, seq: 3 });
  stepArena(arena, 0.01);
  assert.equal(player.lastInputSeq, 4);
  assert.ok(Math.abs(player.inputAge - 0.06) < 1e-10);
  assert.equal(player.input.x, 1);
  setPlayerInput(arena, player.id, { x: 0, y: -1, seq: 5 });
  assert.equal(player.lastInputSeq, 4, 'receiving an input does not acknowledge unapplied movement');
  stepArena(arena, 0.04);
  assert.equal(player.lastInputSeq, 5);
  assert.equal(player.inputAge, 0.04);
  assert.equal(snapshotArena(arena).players[0].inputAge, 0.04);
  startRound(arena);
  assert.equal(player.lastInputSeq, 0);
  assert.equal(player.inputAge, 0);
});

test('analytical inertia matches across different prediction step sizes', () => {
  const whole = { x: 1000, y: 1000, vx: 150, vy: -80 };
  const sliced = { ...whole };
  integrateMotion(whole, { x: -1, y: 0 }, 210, 0.4);
  for (let i = 0; i < 40; i++) integrateMotion(sliced, { x: -1, y: 0 }, 210, 0.01);
  for (const property of ['x', 'y', 'vx', 'vy']) assert.ok(Math.abs(whole[property] - sliced[property]) < 1e-8);
  integrateMotion(whole, { x: 0, y: 0 }, 210, 0.5);
  for (let i = 0; i < 50; i++) integrateMotion(sliced, { x: 0, y: 0 }, 210, 0.01);
  for (const property of ['x', 'y', 'vx', 'vy']) assert.ok(Math.abs(whole[property] - sliced[property]) < 1e-8);
});

test('bodies pinned to different walls at one corner separate by sliding along walls', () => {
  const arena = createArena({ random: () => 0.99 });
  arena.status = 'playing';
  const a = addPlayer(arena, { id: 'corner' });
  const b = addPlayer(arena, { id: 'bottom' });
  for (const [p, mass, offset] of [[a, 315.630533333, 0], [b, 157.860755555, 118]]) {
    const radius = 4 * Math.sqrt(mass);
    Object.assign(p.cells[0], { mass, radius, x: ARENA.width - 4 * Math.sqrt(315.630533333) - offset,
      y: ARENA.height - radius });
    p.invulnerable = 10;
  }
  stepArena(arena, 0.03);
  const ac = a.cells[0], bc = b.cells[0];
  assert.ok(Math.hypot(ac.x - bc.x, ac.y - bc.y) >= ac.radius + bc.radius - 1e-5);
  assert.ok(ac.x <= ARENA.width - ac.radius && bc.y <= ARENA.height - bc.radius);
});

test('different-mass unmerged siblings conserve normal momentum and retain tangential velocities', () => {
  const { arena, player } = fixture([[1000, 1000], [1050, 1000]]);
  const [a, b] = player.cells;
  Object.assign(a, { mass: 36, radius: 24, vx: 150, vy: 30, mergeIn: 5 });
  Object.assign(b, { mass: 100, radius: 40, vx: -80, vy: -20, mergeIn: 5 });
  const momentum = a.mass * a.vx + b.mass * b.vx;
  stepArena(arena, 0);
  assert.equal(player.cells.length, 2);
  assert.ok(Math.abs(a.mass * a.vx + b.mass * b.vx - momentum) < 1e-9);
  assert.equal(a.vy, 30);
  assert.equal(b.vy, -20);
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= a.radius + b.radius - 1e-6);
  assert.equal(player.collisionRevision, 1, 'a sibling response increments its owner revision once');
});

test('physics substeps do not repeat a single split or wave action, energy recharge or acknowledged time', () => {
  const { arena, player } = fixture([[1000, 1000]], 200);
  setPlayerInput(arena, player.id, { x: 1, y: 0, split: true, fire: true, seq: 11 });
  stepArena(arena, 0.1);
  assert.equal(player.cells.length, 2);
  assert.equal(player.mass, 200);
  assert.equal(arena.blasts.filter(wave => wave.ownerId === player.id).length, 1);
  assert.ok(Math.abs(player.energy - 30.3) < 1e-9);
  assert.equal(player.lastInputSeq, 11);
  assert.equal(player.inputAge, 0.1);
  assert.equal(arena.blasts[0].travel, 60);
});

test('snapshots retain precise simulation time, accepted steering and shared contact parameters', () => {
  const { arena, player } = fixture();
  arena.time = 1 / 7;
  setPlayerInput(arena, player.id, { x: 1, y: -1, boost: true, seq: 1 });
  stepArena(arena, 0.001);
  const state = snapshotArena(arena);
  assert.equal(state.simulationTime, arena.time * 1000);
  assert.notEqual(state.simulationTime, state.time * 1000);
  assert.deepEqual(state.players[0].steering, { x: player.input.x, y: player.input.y });
  assert.equal(state.motion.physicsStep, 1 / 120);
  assert.equal(state.motion.restingThreshold, 60);
  assert.equal(state.motion.contactSlop, 0.01);
});

test('resting contact slop never erases a high-speed impact before bodies or walls actually touch', () => {
  const { arena, player } = fixture();
  const other = addPlayer(arena, { id: 'other' });
  Object.assign(other.cells[0], { x: 1048.005, y: 1000, vx: -50, vy: 0 });
  player.cells[0].vx = 850;
  player.invulnerable = other.invulnerable = 100;
  stepArena(arena, 0);
  assert.equal(player.cells[0].vx, 850);
  assert.equal(other.cells[0].vx, -50);
  assert.equal(player.lastImpact, null);
  assert.equal(player.collisionRevision, 0);
  arena.players.delete(other.id);
  Object.assign(player.cells[0], { x: ARENA.width - player.cells[0].radius - 0.005, vx: 850 });
  stepArena(arena, 0);
  assert.equal(player.cells[0].vx, 850);
});

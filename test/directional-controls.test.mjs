import test from 'node:test';
import assert from 'node:assert/strict';
import { createArena, addPlayer, setPlayerInput, stepArena, snapshotArena, startRound } from '../shared/engine.js';

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

test('single and separated multiple cells obey all four directions without perpendicular drift', () => {
  for (const positions of [[[1000, 1000]], [[1000, 1000], [1800, 1400]]]) {
    for (const direction of [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }]) {
      const { arena, player } = fixture(positions);
      setPlayerInput(arena, player.id, direction);
      for (let tick = 0; tick < 6; tick++) stepArena(arena, 1 / 30);
      player.cells.forEach((cell, index) => {
        const dx = cell.x - positions[index][0], dy = cell.y - positions[index][1];
        assert.ok(Math.abs(dx - direction.x * 42) < 1e-8, `x direction ${JSON.stringify(direction)} moved ${dx}`);
        assert.ok(Math.abs(dy - direction.y * 42) < 1e-8, `y direction ${JSON.stringify(direction)} moved ${dy}`);
      });
    }
  }
});

test('switching direction immediately cancels opposing and sideways cell impulse', () => {
  const { arena, player } = fixture([[1000, 1000], [1800, 1400]]);
  for (const cell of player.cells) Object.assign(cell, { impulseX: 650, impulseY: 300 });
  setPlayerInput(arena, player.id, { x: -1, y: 0 });
  stepArena(arena, 0.1);
  assert.equal(player.cells[0].x, 979);
  assert.equal(player.cells[0].y, 1000);
  assert.equal(player.cells[1].x, 1779);
  assert.equal(player.cells[1].y, 1400);
  assert.ok(player.cells.every(cell => cell.impulseX === 0 && cell.impulseY === 0));
});

test('forward split impulse remains aligned with intent and release stops controlled cells', () => {
  const { arena, player } = fixture([[1000, 1000]], 100);
  setPlayerInput(arena, player.id, { x: 1, split: true });
  stepArena(arena, 0.01);
  assert.equal(player.cells.length, 2);
  assert.equal(player.mass, 100);
  assert.ok(player.cells[0].x > 1000, 'splitting while moving right must not push the original cell left');
  assert.ok(player.cells.every(cell => cell.y === 1000));
  assert.ok(player.cells[1].impulseX > 0);
  const snapshot = snapshotArena(arena).players[0];
  assert.ok(snapshot.cells[1].impulseX > 0);
  assert.equal(snapshot.cells[1].impulseY, 0);
  setPlayerInput(arena, player.id, {});
  const before = player.cells.map(cell => ({ x: cell.x, y: cell.y }));
  stepArena(arena, 1 / 30);
  assert.deepEqual(player.cells.map(cell => ({ x: cell.x, y: cell.y })), before);
  assert.ok(player.cells.every(cell => cell.impulseX === 0 && cell.impulseY === 0 && cell.vx === 0 && cell.vy === 0));
});

test('diagonal movement has equal directional components and normalized total speed', () => {
  const { arena, player } = fixture([[1000, 1000], [1800, 1400]]);
  setPlayerInput(arena, player.id, { x: 1, y: -1 });
  stepArena(arena, 0.1);
  player.cells.forEach((cell, index) => {
    const dx = cell.x - [1000, 1800][index], dy = cell.y - [1000, 1400][index];
    assert.ok(Math.abs(dx + dy) < 1e-9);
    assert.ok(Math.abs(Math.hypot(dx, dy) - 21) < 1e-9);
  });
});

test('free fragments retain their own drift when controlled cells stop', () => {
  const { arena, player } = fixture();
  player.cells[0].impulseX = 250;
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { createArena, addPlayer, setPlayerInput, stepArena, gravityRadius, snapshotArena } from '../shared/engine.js';

function fixture(mass = 36) {
  const arena = createArena({ random: () => 0.99 });
  arena.status = 'playing';
  const player = addPlayer(arena, { id: 'planet', name: '测试星球' });
  Object.assign(player, { x: 1000, y: 1000, mass, radius: 4 * Math.sqrt(mass) });
  Object.assign(player.cells[0], { x: 1000, y: 1000, mass, radius: player.radius });
  return { arena, player, cell: player.cells[0] };
}

function dustAt(fixture, distance, extra = {}) {
  const dust = { id: 'test-dust', x: fixture.cell.x + distance, y: fixture.cell.y,
    vx: 0, vy: 0, value: 1, ...extra };
  fixture.arena.dust = [dust];
  return dust;
}

test('releasing movement coasts with damping while gravity never accelerates its owner', () => {
  const f = fixture();
  setPlayerInput(f.arena, f.player.id, { x: 1, y: 0 });
  stepArena(f.arena, 0.1);
  const releasedX = f.cell.x;
  const releasedSpeed = f.cell.vx;
  assert.ok(releasedX > 1000);
  setPlayerInput(f.arena, f.player.id, { x: 0, y: 0 });
  dustAt(f, 90);
  for (let tick = 0; tick < 60; tick++) stepArena(f.arena, 1 / 30);
  assert.ok(f.cell.x > releasedX);
  assert.equal(f.cell.y, 1000);
  assert.ok(f.cell.vx > 0 && f.cell.vx < releasedSpeed);
  assert.equal(f.cell.vy, 0);
  assert.ok(f.player.mass > 36, 'nearby dust should still be attracted and absorbed while idle');
  for (let tick = 0; tick < 120; tick++) stepArena(f.arena, 1 / 30);
  assert.equal(f.cell.vx, 0);
  const stoppedX = f.cell.x;
  stepArena(f.arena, 0.1);
  assert.equal(f.cell.x, stoppedX);
});

test('separated cells do not automatically steer toward their centroid without input', () => {
  const f = fixture();
  const other = { ...f.cell, id: 'second-cell', x: 1400 };
  f.player.cells.push(other);
  f.player.x = 1200;
  f.player.mass = 72;
  for (let tick = 0; tick < 90; tick++) stepArena(f.arena, 1 / 30);
  assert.equal(f.cell.x, 1000);
  assert.equal(other.x, 1400);
  assert.equal(f.player.x, 1200);
  assert.ok(f.player.cells.every(cell => cell.vx === 0 && cell.vy === 0));
});

test('split launch becomes persistent velocity that coasts and eventually settles', () => {
  const f = fixture(100);
  setPlayerInput(f.arena, f.player.id, { x: 1, split: true });
  stepArena(f.arena, 0.01);
  assert.equal(f.player.cells.length, 2);
  const launched = f.player.cells[1];
  setPlayerInput(f.arena, f.player.id, {});
  const initialX = launched.x;
  stepArena(f.arena, 0.1);
  assert.ok(launched.x > initialX, 'the split launch retains deliberate inertia after release');
  for (let tick = 0; tick < 150; tick++) stepArena(f.arena, 1 / 30);
  assert.ok(f.player.cells.every(cell => cell.vx === 0 && cell.vy === 0));
  const settled = f.player.cells.map(cell => ({ x: cell.x, y: cell.y }));
  for (let tick = 0; tick < 15; tick++) stepArena(f.arena, 1 / 30);
  assert.deepEqual(f.player.cells.map(cell => ({ x: cell.x, y: cell.y })), settled);
});

test('stationary dust just outside the finite field stays still, while dust inside moves inward', () => {
  const inside = fixture();
  const insideDust = dustAt(inside, gravityRadius(inside.cell, inside.player) - 0.01);
  const outside = fixture();
  const outsideDust = dustAt(outside, gravityRadius(outside.cell, outside.player) + 0.01);
  const beforeInside = insideDust.x;
  const beforeOutside = outsideDust.x;
  stepArena(inside.arena, 0.1);
  stepArena(outside.arena, 0.1);
  assert.ok(insideDust.x < beforeInside && insideDust.vx < 0);
  assert.equal(outsideDust.x, beforeOutside);
  assert.equal(outsideDust.vx, 0);
  assert.equal(outsideDust.vy, 0);
});

test('outside the field, existing fragment motion only coasts and damps without acceleration', () => {
  const f = fixture();
  const fragment = dustAt(f, gravityRadius(f.cell, f.player) + 80,
    { vx: 100, vy: 0, fragment: true });
  const before = fragment.x;
  stepArena(f.arena, 0.1);
  assert.ok(Math.abs(fragment.x - before - 10) < 1e-9);
  assert.ok(Math.abs(fragment.vx - 100 * Math.exp(-0.23)) < 1e-9);
  assert.equal(fragment.vy, 0);
});

test('larger planets pull harder at the same distance and at the same relative field position', () => {
  for (const relative of [false, true]) {
    const small = fixture(36);
    const large = fixture(324);
    const smallDistance = relative ? gravityRadius(small.cell, small.player) * 0.8 : 95;
    const largeDistance = relative ? gravityRadius(large.cell, large.player) * 0.8 : 95;
    const a = dustAt(small, smallDistance);
    const b = dustAt(large, largeDistance);
    const beforeA = a.x, beforeB = b.x;
    stepArena(small.arena, 0.05);
    stepArena(large.arena, 0.05);
    assert.ok(Math.abs(b.vx) > Math.abs(a.vx));
    assert.ok(beforeB - b.x > beforeA - a.x);
  }
});

test('large planet fields keep growing beyond the former 220 limit and magnet adds range', () => {
  const medium = fixture(625);
  const huge = fixture(2500);
  assert.ok(gravityRadius(medium.cell, medium.player) > 220);
  assert.ok(gravityRadius(huge.cell, huge.player) > gravityRadius(medium.cell, medium.player));
  const dust = dustAt(huge, 300);
  const before = dust.x;
  stepArena(huge.arena, 0.1);
  assert.ok(dust.x < before);
  const priorRange = gravityRadius(huge.cell, huge.player);
  huge.player.stats.magnet = 25;
  assert.equal(gravityRadius(huge.cell, huge.player), priorRange + 25);
  assert.equal(snapshotArena(huge.arena).players[0].cells[0].gravityRadius,
    Math.round(gravityRadius(huge.cell, huge.player) * 100) / 100);
});

test('overlapping finite fields attract dust toward the stronger eligible planet', () => {
  const f = fixture(36);
  const larger = addPlayer(f.arena, { id: 'large', name: '大星球' });
  Object.assign(larger, { x: 1200, y: 1000, mass: 324, radius: 72 });
  Object.assign(larger.cells[0], { x: 1200, y: 1000, mass: 324, radius: 72 });
  const dust = dustAt(f, 100);
  stepArena(f.arena, 0.05);
  assert.ok(dust.vx > 0, 'equal-distance dust should follow the higher-mass planet');
});

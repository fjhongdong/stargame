import test from 'node:test';
import assert from 'node:assert/strict';
import { ARENA, DUST_COUNT, createArena, addPlayer, startRound, stepArena,
  setPlayerInput, snapshotArena, queryDust } from '../shared/engine.js';

function seeded(seed = 78237) {
  return () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
}

function game(count = 8) {
  const arena = createArena({ random: seeded() });
  for (let i = 0; i < count; i++) addPlayer(arena, { id: `p${i}`, name: `星球${i}`, bot: true });
  startRound(arena);
  return arena;
}

test('large world has 6,000 natural particles, central encounters and nearby food', () => {
  const arena = game();
  assert.deepEqual(ARENA, { width: 12000, height: 8000 });
  assert.equal(arena.dust.filter(dust => !dust.fragment).length, DUST_COUNT);
  for (const p of arena.players.values()) {
    assert.ok(Math.abs(p.x - ARENA.width / 2) <= 1000);
    assert.ok(Math.abs(p.y - ARENA.height / 2) <= 700);
    assert.ok(queryDust(arena, { x: p.x, y: p.y, width: 1000, height: 1000, margin: 0 }).length >= 24);
  }
  assert.ok(arena.dust.some(dust => dust.x < 1000));
  assert.ok(arena.dust.some(dust => dust.x > ARENA.width - 1000));
  assert.ok(arena.dust.some(dust => dust.y < 1000));
  assert.ok(arena.dust.some(dust => dust.y > ARENA.height - 1000));
});

test('spatial viewport query matches exact filtering and keeps global player metadata', () => {
  const arena = game();
  const view = { x: 6000, y: 4000, width: 1600, height: 1000, margin: 80 };
  const expected = arena.dust.filter(dust => Math.abs(dust.x - view.x) <= view.width / 2 + view.margin &&
    Math.abs(dust.y - view.y) <= view.height / 2 + view.margin).map(dust => dust.id).sort();
  assert.deepEqual(queryDust(arena, view).map(dust => dust.id).sort(), expected);
  const grid = arena.dustGrid;
  const snapshot = snapshotArena(arena, view);
  assert.equal(arena.dustGrid, grid, 'a viewport snapshot must reuse the physics spatial index');
  assert.equal(snapshot.players.length, 8);
  assert.equal(snapshot.dustTotal, 6000);
  assert.equal(snapshot.dust.length, expected.length);
  assert.ok(snapshot.dust.length < 1000);
  assert.deepEqual(snapshot.arena, ARENA);
});

test('moving free particles cross grid buckets and natural refill preserves free mass', () => {
  const arena = createArena({ random: seeded() });
  arena.status = 'playing';
  addPlayer(arena, { id: 'p' });
  const fragment = { id: 'free', x: 250, y: 200, vx: 420, vy: 0, value: 19,
    fragment: true, ownerId: 'p', availableAt: 0, collectAfter: 0 };
  arena.dust = [fragment];
  const before = queryDust(arena, { x: 250, y: 200, width: 10, height: 10, margin: 0 });
  assert.ok(before.includes(fragment));
  stepArena(arena, 0.1);
  assert.ok(fragment.x > 256);
  const after = queryDust(arena, { x: fragment.x, y: fragment.y, width: 10, height: 10, margin: 0 });
  assert.ok(after.includes(fragment));
  assert.equal(arena.dust.filter(dust => !dust.fragment).length, 6000);
  assert.equal(arena.dust.find(dust => dust.id === 'free').value, 19);
  assert.equal(arena.dust.length, 6001);
});

test('input acknowledgments reflect simulated movement and ignore older sequences', () => {
  const arena = game(1);
  const player = arena.players.get('p0');
  player.bot = false;
  setPlayerInput(arena, player.id, { x: 1, y: 0, seq: 7 });
  assert.equal(player.lastInputSeq, 0);
  stepArena(arena, 1 / 30);
  assert.equal(player.lastInputSeq, 7);
  assert.ok(player.cells[0].vx > 0);
  const previousX = player.x;
  setPlayerInput(arena, player.id, { x: -1, y: 0, split: true, seq: 6 });
  stepArena(arena, 1 / 30);
  assert.equal(player.lastInputSeq, 7);
  assert.ok(player.x > previousX);
  assert.ok(snapshotArena(arena).players[0].cells.every(cell => Number.isFinite(cell.vx + cell.vy)));
});

test('eight bots simulate 30 seconds in a populated large world with local queries', t => {
  const arena = game();
  const durations = [];
  for (let tick = 0; tick < 900; tick++) {
    const started = performance.now();
    stepArena(arena, 1 / 30);
    if (tick >= 60) durations.push(performance.now() - started);
  }
  durations.sort((a, b) => a - b);
  const median = durations[Math.floor(durations.length / 2)];
  const p95 = durations[Math.floor(durations.length * 0.95)];
  const mean = durations.reduce((sum, value) => sum + value, 0) / durations.length;
  t.diagnostic(`8 bots / 6,000 natural particles: mean=${mean.toFixed(3)}ms median=${median.toFixed(3)}ms p95=${p95.toFixed(3)}ms`);
  assert.ok(median < 10, `median physics step exceeded 10ms: ${median}`);
  assert.ok(Math.abs(arena.time - 30) < 0.001);
  assert.equal(arena.naturalDustCount, 6000);
  for (const player of arena.players.values()) {
    assert.ok(player.cells.length <= 8);
    assert.ok(Math.abs(player.cells.reduce((sum, cell) => sum + cell.mass, 0) - player.mass) < 1e-8);
    assert.ok(player.cells.every(cell => Number.isFinite(cell.x + cell.y + cell.vx + cell.vy + cell.mass)));
  }
  assert.ok(arena.dust.every(dust => Number.isFinite(dust.x + dust.y + dust.value)));
});

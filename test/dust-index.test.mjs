import test from 'node:test';
import assert from 'node:assert/strict';
import { DUST_COUNT, addPlayer, createArena, queryDust, stepArena } from '../shared/engine.js';

function fixture(particles = []) {
  const arena = createArena({ random: () => 0.5, endless: true });
  const player = addPlayer(arena, { id: 'planet' });
  Object.assign(player, { x: 4000, y: 4000, invulnerable: 0 });
  Object.assign(player.cells[0], { x: 4000, y: 4000 });
  arena.status = 'playing';
  arena.dust = [...particles, ...Array.from({ length: DUST_COUNT - particles.length }, (_, i) => ({
    id: `far-${i}`, x: 10000, y: 7000, value: 1, vx: 0, vy: 0,
  }))];
  return { arena, player };
}

test('direct edits to a stationary particle move its spatial query and activate its physical velocity', () => {
  const dust = { id: 'edited', x: 1000, y: 1000, value: 1, vx: 0, vy: 0 };
  const { arena } = fixture([dust]);
  stepArena(arena, 0);
  Object.assign(dust, { x: 2000, y: 1800, vx: 100, vy: -50 });
  stepArena(arena, 0.1);
  assert.equal(dust.x, 2010); assert.equal(dust.y, 1795);
  assert.ok(Math.abs(dust.vx - 100 * Math.exp(-0.23)) < 1e-10);
  const view = (x, y) => ({ x, y, width: 40, height: 40, margin: 0 });
  assert.ok(!queryDust(arena, view(1000, 1000)).includes(dust));
  assert.ok(queryDust(arena, view(2010, 1795)).includes(dust));
});

test('a same-id replacement inside the original array is collected once without leaving its old body behind', () => {
  const previous = { id: 'replaced', x: 1000, y: 1000, value: 1, vx: 0, vy: 0 };
  const { arena, player } = fixture([previous]);
  stepArena(arena, 0);
  arena.dust[0] = { id: previous.id, x: player.x, y: player.y, value: 2, vx: 0, vy: 0 };
  stepArena(arena, 0);
  assert.equal(player.mass, 38);
  assert.equal(player.score, 4);
  assert.ok(!queryDust(arena, { x: 1000, y: 1000, width: 30, height: 30, margin: 0 })
    .some(dust => dust.id === previous.id));
  assert.ok(![...arena.activeDust].some(dust => dust.id === previous.id));
  assert.equal(arena.naturalDustCount, DUST_COUNT);
});

test('moving between buckets preserves pickup order when an earlier particle initially lies outside the growing body', () => {
  const a = { id: 'earlier-edge', x: 1010, y: 1010, value: 1, vx: 400, vy: 0 };
  const b = { id: 'later-centre', x: 1000, y: 1000, value: 1, vx: 0, vy: 0 };
  const c = { id: 'later-inside', x: 1011, y: 1012, value: 1, vx: 0, vy: 0 };
  const { arena, player } = fixture([a, b, c]);
  stepArena(arena, 0.1); // Moving the first particle swaps the old bucket's tail.
  const offset = 29.2 / Math.sqrt(2);
  Object.assign(a, { x: 1000 + offset, y: 1000 + offset, vx: 0, vy: 0 });
  Object.assign(player.cells[0], { x: 1000, y: 1000 });
  stepArena(arena, 0);
  assert.equal(player.mass, 38, 'the earlier edge particle is visited before the two mass gains');
  assert.ok(arena.dust.includes(a));
  assert.ok(!arena.dust.includes(b)); assert.ok(!arena.dust.includes(c));
});

test('reordering the same particle array takes effect, and changing natural dust into a fragment preserves the refill budget', () => {
  const offset = 29.2 / Math.sqrt(2);
  const a = { id: 'edge', x: 1000 + offset, y: 1000 + offset, value: 1, vx: 0, vy: 0 };
  const b = { id: 'centre', x: 1000, y: 1000, value: 1, vx: 0, vy: 0 };
  const { arena, player } = fixture([a, b]);
  stepArena(arena, 0);
  arena.dust.reverse();
  Object.assign(player.cells[0], { x: 1000, y: 1000 });
  const fragment = arena.dust[100];
  fragment.fragment = true;
  stepArena(arena, 0);
  assert.equal(player.mass, 38, 'the reordered centre is absorbed before the edge');
  assert.equal(arena.naturalDustCount, DUST_COUNT);
  assert.ok(arena.dust.includes(fragment));
  assert.equal(arena.dust.filter(dust => dust.fragment).length, 1);
});

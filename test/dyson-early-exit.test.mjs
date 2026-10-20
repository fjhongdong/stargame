import test from 'node:test';
import assert from 'node:assert/strict';
import { DYSON, DUST_COUNT, addPlayer, cancelDysonLinks, createArena, setPlayerInput, snapshotArena, stepArena } from '../shared/engine.js';

const near = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `${actual} should equal ${expected} within ${tolerance}`);

function fixture({ keepSecondWave = false } = {}) {
  const arena = createArena({ endless: true, random: () => .99 }); arena.status = 'playing';
  arena.dust = Array.from({ length: DUST_COUNT }, (_, i) => ({ id: `far-${i}`, x: 11000, y: 7000, value: 1, vx: 0, vy: 0 }));
  function player(id, x, mass) {
    const p = addPlayer(arena, { id });
    Object.assign(p, { x, y: 4000, mass, radius: 4 * Math.sqrt(mass), energy: 100, invulnerable: 0 });
    Object.assign(p.cells[0], { x, y: 4000, mass, radius: p.radius, vx: 0, vy: 0 });
    p.stats.energyRegen = 0; return p;
  }
  const owner = player('owner', 4000, 72), target = player('target', 4100, 36);
  if (keepSecondWave) {
    owner.stats.blastCooldown = .85 * .85 ** 4;
    owner.stats.blastRange = 1.72;
  }
  setPlayerInput(arena, owner.id, { fire: true }); stepArena(arena, 0);
  for (let i = 0; i < 120 && !owner.dysonReady; i++) stepArena(arena, 1 / 120);
  assert.ok(owner.dysonReady);
  let extraWave;
  if (keepSecondWave) {
    advance(arena, owner.cooldown + 1 / 120);
    setPlayerInput(arena, owner.id, {}); setPlayerInput(arena, owner.id, { rearFire: true }); stepArena(arena, 0);
    extraWave = arena.blasts.find(wave => wave.id === owner._latestWaveId);
    assert.ok(extraWave); assert.equal(extraWave.hit.size, 0);
    assert.equal(owner.dysonReady.targetId, target.id, 'the first real hit must still supply the Dyson entry');
  }
  setPlayerInput(arena, owner.id, {}); setPlayerInput(arena, owner.id, { split: true }); stepArena(arena, 0);
  assert.ok(owner.dyson);
  // Keep exit/mass assertions independent of later legitimate recycling of
  // the free fragments shed by the hit which opened this combo.
  arena.dust = arena.dust.filter(dust => !dust.fragment);
  function press(input = {}) {
    setPlayerInput(arena, owner.id, {}); setPlayerInput(arena, owner.id, { ...input, split: true }); stepArena(arena, 0);
  }
  return { arena, owner, target, press, extraWave };
}

function advance(arena, duration) {
  for (let elapsed = 0; elapsed < duration - 1e-9;) {
    const dt = Math.min(1 / 30, duration - elapsed); stepArena(arena, dt); elapsed += dt;
  }
}

const shellWire = (arena, owner) => snapshotArena(arena).players.find(p => p.id === owner.id).dyson;

test('an early key press is not buffered into a later exit and holding Space cannot exit the shell', () => {
  const { arena, owner, press } = fixture();
  near(DYSON.minActive, .6); near(DYSON.exitWindup, .3);
  near(shellWire(arena, owner).canExitAt, owner.dyson.startedAt + DYSON.minActive);
  advance(arena, DYSON.minActive - .01); press({ y: -1 });
  assert.equal(owner.dyson.exitRequestedAt, null); assert.equal(owner.dyson.exitAt, null);
  advance(arena, .2);
  setPlayerInput(arena, owner.id, { y: -1, split: true }); stepArena(arena, 0);
  assert.ok(owner.dyson); assert.equal(owner.dyson.exitAt, null);
  press({ y: -1 });
  near(owner.dyson.exitRequestedAt, arena.time); near(owner.dyson.exitAt - arena.time, DYSON.exitWindup);
});

test('a requested early exit telegraphs a fixed selected side while its safe preview follows the target', () => {
  const { arena, owner, target, press } = fixture();
  advance(arena, DYSON.minActive); press({ y: -1 });
  const first = shellWire(arena, owner), end = owner.dyson.exitAt;
  assert.ok(first.exitPreview); near(first.exitDirectionX, 0); near(first.exitDirectionY, -1);
  assert.ok(first.exitPreview.y < target.cells[0].y);
  const expectedGap = target.cells[0].radius + owner.cells[0].radius + DYSON.returnClearance;
  near(Math.hypot(first.exitPreview.x - target.cells[0].x, first.exitPreview.y - target.cells[0].y), expectedGap, .02);
  const originalX = first.exitPreview.x; first.exitPreview.x = -999;
  assert.notEqual(owner.dyson.exitPreview.x, -999, 'snapshot preview must not alias mutable engine state');
  setPlayerInput(arena, target.id, { x: 1 }); setPlayerInput(arena, owner.id, { y: 1 });
  advance(arena, DYSON.exitWindup / 2); press({ y: 1 });
  assert.ok(owner.dyson); near(owner.dyson.exitAt, end);
  const latest = shellWire(arena, owner);
  near(latest.exitDirectionY, -1); assert.ok(latest.exitPreview.y < target.cells[0].y);
  assert.ok(latest.exitPreview.x > originalX + 1, 'preview should follow the moving wrapped target');
  const sourceId = owner.cells[0].id;
  advance(arena, DYSON.exitWindup / 2);
  assert.equal(owner.dyson, null); assert.equal(owner.cells[0].id, sourceId);
  assert.equal(owner.lastDysonEnd.reason, 'early-exit'); near(owner.lastDysonEnd.at, end);
  assert.ok(owner.cells[0].y < target.cells[0].y, 'changing direction during windup must not hide a last-instant exit-side swap');
  const gap = Math.hypot(owner.cells[0].x - target.cells[0].x, owner.cells[0].y - target.cells[0].y) - owner.cells[0].radius - target.cells[0].radius;
  assert.ok(gap >= DYSON.returnClearance - .1);
});

test('early restoration preserves intercepted mass and full cooldown and needs another fresh Space to split', () => {
  const { arena, owner, target, press } = fixture();
  const dust = { id: 'captured-before-exit', x: target.cells[0].x, y: target.cells[0].y, value: 3,
    fragment: true, ownerId: null, vx: 0, vy: 0 }; arena.dust.push(dust); stepArena(arena, 0);
  near(owner.dyson.capturedMass, 3); const mass = owner.mass, energy = owner.energy;
  advance(arena, DYSON.minActive); press({ y: -1 }); const startedAt = owner.dyson.startedAt;
  advance(arena, DYSON.exitWindup);
  assert.equal(owner.dyson, null); assert.equal(owner.cells.length, 1); near(owner.mass, mass);
  near(owner.lastDysonEnd.capturedMass, 3); near(owner.energy, energy);
  near(owner.dysonCooldown, DYSON.cooldown - (arena.time - startedAt));
  setPlayerInput(arena, owner.id, { y: -1, split: true }); stepArena(arena, .1);
  assert.equal(owner.cells.length, 1, 'held exit input must not become an ordinary split');
  press({ x: -1 });
  assert.equal(owner.cells.length, 2); near(owner.cells[0].mass + owner.cells[1].mass, mass);
  assert.ok(owner.cells.every(c => !c.dysonId));
});

test('without an exit request the full natural duration and normal return remain unchanged', () => {
  const { arena, owner } = fixture(), startedAt = owner.dyson.startedAt;
  advance(arena, DYSON.duration - .01); assert.ok(owner.dyson); assert.equal(owner.dyson.exitAt, null);
  advance(arena, .01); assert.equal(owner.dyson, null);
  assert.equal(owner.lastDysonEnd.reason, 'expired'); near(owner.lastDysonEnd.at, startedAt + DYSON.duration);
  near(owner.dysonCooldown, DYSON.cooldown - DYSON.duration);
});

test('Dyson entry clears an older blink opportunity while leaving its physical wave alive, so exit can immediately split', () => {
  const { arena, owner, press, extraWave } = fixture({ keepSecondWave: true });
  assert.equal(owner._latestWaveId, null); assert.equal(owner.lastWaveBlink, null);
  assert.ok(arena.blasts.includes(extraWave), 'entry must not erase an unrelated previously launched physical wave');
  assert.equal(snapshotArena(arena).players.find(p => p.id === owner.id).waveBlinkReady, null);
  advance(arena, DYSON.minActive); press({ y: -1 }); advance(arena, DYSON.exitWindup);
  assert.equal(owner.dyson, null); assert.ok(arena.blasts.includes(extraWave));
  assert.equal(extraWave.hit.size, 0); assert.ok(extraWave.travel < extraWave.distance);
  assert.equal(owner.cells.length, 1); press({ x: -1 });
  assert.equal(owner.cells.length, 2, 'fresh Space after restoration must ordinary-split rather than blink to the old wave');
  assert.equal(owner.lastWaveBlink, null); assert.ok(arena.blasts.includes(extraWave));
  const remaining = (extraWave.distance - extraWave.travel) / extraWave.speed;
  advance(arena, remaining + .01); assert.ok(!arena.blasts.includes(extraWave));
});

test('disconnect cleanup during an exit windup restores immediately without retaining a preview or queued split', () => {
  const { arena, owner, target, press } = fixture();
  advance(arena, DYSON.minActive); press({ y: -1 }); assert.ok(owner.dyson.exitAt);
  const mass = owner.mass; cancelDysonLinks(arena, target.id, 'disconnect');
  assert.equal(owner.dyson, null); assert.equal(shellWire(arena, owner), null);
  assert.equal(owner.lastDysonEnd.reason, 'disconnect'); assert.equal(owner.cells.length, 1); near(owner.mass, mass);
  advance(arena, DYSON.exitWindup + .1); assert.equal(owner.cells.length, 1); assert.equal(owner.dyson, null);
});

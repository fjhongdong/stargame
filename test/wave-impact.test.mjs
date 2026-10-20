import test from 'node:test';
import assert from 'node:assert/strict';
import { ARENA, WAVE, SIBLING, createArena, addPlayer, setPlayerInput, stepArena, snapshotArena, startRound } from '../shared/engine.js';

const near = (actual, expected, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should equal ${expected}`);
const fragments = (arena, ownerId) => arena.dust.filter(d => d.fragment && d.ownerId === ownerId);
const totalMass = arena => [...arena.players.values()].reduce((sum, p) => sum + p.mass, 0) + arena.dust.filter(d => d.fragment).reduce((sum, d) => sum + d.value, 0);
function fixture() {
  const arena = createArena({ random: () => .99 }); arena.status = 'playing';
  function player(id, x = 1000, y = 4000, mass = 36) {
    const p = addPlayer(arena, { id, name: id });
    Object.assign(p, { x, y, mass, radius: 4 * Math.sqrt(mass), invulnerable: 0 });
    Object.assign(p.cells[0], { x, y, mass, radius: p.radius, vx: 0, vy: 0 });
    return p;
  }
  const owner = player('owner');
  function fire() { setPlayerInput(arena, owner.id, { fire: true }); stepArena(arena, 0); return arena.blasts.at(-1); }
  return { arena, player, owner, fire };
}
function advance(arena, duration) {
  for (let elapsed = 0; elapsed < duration - 1e-9;) { const dt = Math.min(.025, duration - elapsed); stepArena(arena, dt); elapsed += dt; }
}

test('a wave knocks the actual body, sheds twelve percent, and conserves the post-impulse mass and momentum', () => {
  for (const mass of [1, 36, 3600]) for (const direction of [{ x: 1, y: 0 }, { x: .6, y: .8 }, { x: 0, y: -1 }]) {
    const { arena, player, owner, fire } = fixture(); owner.direction = direction;
    // A surface-launched front must hit a genuinely adjacent, nonoverlapping
    // target; do not rely on the old muzzle spawning thirty units farther out.
    const distance = owner.radius + 4 * Math.sqrt(mass) + 4;
    const target = player('target', owner.x + direction.x * distance, owner.y + direction.y * distance, mass);
    Object.assign(target.cells[0], { vx: 15, vy: -8 });
    const wave = fire(), expected = Math.max(WAVE.minKnockback, Math.min(WAVE.maxKnockback, WAVE.knockback * (36 / mass) ** .35));
    assert.ok(target.lastWaveHit, 'the travelling arc intersects the target body');
    near(target.cells[0].vx - 15, direction.x * expected); near(target.cells[0].vy + 8, direction.y * expected);
    near(target.lastWaveHit.impulse, expected); assert.equal(target.lastWaveHit.waveId, wave.id);
    const lost = Math.min(mass * .12, Math.max(0, mass - 1)), pieces = fragments(arena, target.id);
    near(target.mass, mass - lost); near(target.lastWaveHit.lostMass, lost);
    assert.equal(pieces.length, lost > 0 ? 3 : 0);
    pieces.forEach(piece => near(piece.value, lost / 3)); near(totalMass(arena), 36 + mass);
    const px = target.mass * target.vx + pieces.reduce((sum, d) => sum + d.value * d.vx, 0);
    const py = target.mass * target.vy + pieces.reduce((sum, d) => sum + d.value * d.vy, 0);
    near(px, mass * (15 + direction.x * expected)); near(py, mass * (-8 + direction.y * expected));
    assert.ok(pieces.every(piece => piece.collectAfter > arena.time && piece.availableAt > piece.collectAfter));
  }
});

test('one hit produces real coasting displacement and cannot repeatedly add impulse during subsequent overlap', () => {
  const { arena, player, owner, fire } = fixture();
  const target = player('target', owner.x + owner.radius * 2 + 4), before = target.cells[0].x;
  const wave = fire(), revision = target.collisionRevision, event = target.lastWaveHit;
  near(target.cells[0].vx, WAVE.knockback);
  const massAfter = target.mass, looseAfter = fragments(arena, target.id).length;
  for (let i = 0; i < 5; i++) stepArena(arena, 0);
  near(target.cells[0].vx, WAVE.knockback); assert.equal(target.collisionRevision, revision); assert.equal(target.lastWaveHit, event);
  near(target.mass, massAfter); assert.equal(fragments(arena, target.id).length, looseAfter);
  assert.equal(wave.hit.size, 1);
  advance(arena, .1);
  near(target.x - before, WAVE.knockback * (1 - Math.exp(-.2)) / 2);
  near(target.cells[0].vx, WAVE.knockback * Math.exp(-.2));
  assert.ok(target.x - before > 20, 'the effect must move the planet rather than only play a visual');
});

test('a multi-cell victim receives impulse only on the cells actually intersected by the arc', () => {
  const { arena, player, owner, fire } = fixture();
  const side = (WAVE.width + WAVE.thickness) / 2;
  const front = owner.x + owner.radius + WAVE.thickness / 2 + 4;
  const target = player('target', front + owner.radius / 2, owner.y - side);
  target.cells[0].mergeIn = SIBLING.launchGrace;
  target.cells.push({ ...target.cells[0], id: 'second-hit', y: owner.y + side, mass: 16, radius: 16 });
  assert.ok(Math.hypot(target.x - owner.x, target.y - owner.y) > target.radius + owner.radius);
  assert.ok(target.cells[1].y - target.cells[0].y > target.radius + target.cells[1].radius);
  target.cells.push({ ...target.cells[0], id: 'outside-wave', y: 4240 });
  target.mass = 88;
  fire();
  near(target.cells[0].vx, 240);
  near(target.cells[1].vx, Math.min(320, 240 * (36 / 16) ** .35));
  near(target.cells[2].vx, 0); near(target.cells[2].vy, 0);
  assert.equal(target.lastWaveHit.hitCells, 2);
  assert.deepEqual(target.lastWaveHit.hitCellIds, [target.cells[0].id, 'second-hit']);
  assert.equal(target.lastWaveHit.cellId, target.cells[0].id);
  near(target.cells[0].mass, 36 * .88); near(target.cells[1].mass, 16 * .88); near(target.cells[2].mass, 36);
  near(target.lastWaveHit.lostMass, (36 + 16) * .12);
  assert.equal(fragments(arena, target.id).length, 6);
  near(totalMass(arena), 36 + 88);
});

test('spawn protection, rear position and wave ownership prevent both mass loss and physical knockback', () => {
  const { arena, player, owner, fire } = fixture(), protectedTarget = player('protected', 1078), rear = player('rear', 920);
  protectedTarget.invulnerable = 1;
  fire(); advance(arena, .8);
  for (const p of [owner, protectedTarget, rear]) {
    assert.equal(p.lastWaveHit, null); near(p.vx, 0); near(p.vy, 0); near(p.mass, 36);
  }
  assert.equal(arena.dust.filter(d => d.fragment).length, 0);
});

test('wave feedback identifies the impacted cell and is copied safely, retained after the wave and reset with a new round', () => {
  const { arena, player, owner, fire } = fixture();
  const target = player('target', owner.x + owner.radius * 2 + 4), surfaceX = target.x - target.radius;
  assert.equal(snapshotArena(arena).players.find(p => p.id === target.id).lastWaveHit, null);
  const wave = fire(), event = target.lastWaveHit;
  assert.equal(event.ownerId, owner.id); assert.equal(event.waveId, wave.id); assert.equal(event.cellId, target.cells[0].id);
  near(event.x, surfaceX); near(event.y, 4000); near(event.directionX, 1); near(event.directionY, 0);
  for (const key of ['at', 'x', 'y', 'directionX', 'directionY', 'impulse', 'hitCells', 'lostMass']) assert.ok(Number.isFinite(event[key]));
  assert.equal(event.mode, 'forward');
  for (const key of ['damage', 'hpAfter', 'maxHp', 'killed']) assert.ok(!(key in event), `wave feedback must not retain removed ${key}`);
  const snapshot = snapshotArena(arena), wire = snapshot.players.find(p => p.id === target.id).lastWaveHit;
  for (const p of snapshot.players) for (const key of ['hp', 'maxHp', 'shield', 'lastShieldHit']) {
    assert.ok(!(key in p), `player snapshot must not retain removed ${key}`);
    assert.ok(!(key in p.stats), `stat snapshot must not retain removed ${key}`);
  }
  assert.deepEqual(wire, event); wire.hitCellIds.push('tampered'); wire.x = -1;
  assert.deepEqual(event.hitCellIds, [target.cells[0].id]); near(event.x, surfaceX);
  advance(arena, .8);
  assert.equal(arena.blasts.length, 0); assert.equal(target.lastWaveHit.id, event.id);
  startRound(arena);
  assert.ok([...arena.players.values()].every(p => p.lastWaveHit === null));
});

test('wave knockback near a world wall keeps bodies finite and confined while the ordinary collision response continues', () => {
  const { arena, player, owner, fire } = fixture();
  Object.assign(owner, { x: ARENA.width - 180 }); Object.assign(owner.cells[0], { x: owner.x });
  const target = player('wall-target', ARENA.width - 24);
  fire();
  let hit = false;
  for (let frame = 0; frame < 32; frame++) {
    stepArena(arena, .025); hit ||= Boolean(target.lastWaveHit);
    for (const cell of target.cells) {
      assert.ok(Number.isFinite(cell.vx) && Number.isFinite(cell.vy));
      assert.ok(cell.x <= ARENA.width - cell.radius + 1e-7 && cell.x >= cell.radius - 1e-7);
      assert.ok(cell.y <= ARENA.height - cell.radius + 1e-7 && cell.y >= cell.radius - 1e-7);
    }
  }
  assert.ok(hit); assert.ok(target.x < ARENA.width - 24, 'a real wall rebound must move the pushed body back inside the arena');
});

test('small cores shed only the available mass above one, with no duplicate mass or hidden health elimination', () => {
  for (const mass of [1, 1.01, 1.1, 3, 36]) {
    const { arena, player, owner, fire } = fixture();
    const target = player('target', owner.x + owner.radius + 4 * Math.sqrt(mass) + 4, 4000, mass);
    fire();
    const lost = Math.min(mass * .12, Math.max(0, mass - 1));
    near(target.mass, mass - lost); assert.ok(target.mass >= 1); near(totalMass(arena), 36 + mass);
    fragments(arena, target.id).forEach(piece => near(piece.value, lost / 3));
  }
  const { arena, player, owner, fire } = fixture(), target = player('target', owner.x + owner.radius * 2 + 4);
  for (let hit = 0; hit < 5; hit++) {
    // Stay genuinely adjacent as the hit body shrinks, so every independent
    // wave reaches it at launch without relying on the old oversized front.
    target.cells[0].x = target.x = owner.x + owner.radius + target.cells[0].radius + 4;
    owner.cooldown = 0; setPlayerInput(arena, owner.id, { fire: false }); fire();
    assert.equal(target.cells.length, 1, 'repeated hits change motion and mass rather than triggering a removed health/death system');
    assert.ok(target.mass >= 1);
  }
  near(target.mass, 36 * .88 ** 5); near(totalMass(arena), 72);
});

test('wave fragments have a legal opening outside their source core at every wall and corner', () => {
  const placements = [
    { dx: -1, dy: 0 }, { dx: 1, dy: 0 }, { dx: 0, dy: -1 }, { dx: 0, dy: 1 },
    { dx: -Math.SQRT1_2, dy: -Math.SQRT1_2 }, { dx: Math.SQRT1_2, dy: -Math.SQRT1_2 },
    { dx: -Math.SQRT1_2, dy: Math.SQRT1_2 }, { dx: Math.SQRT1_2, dy: Math.SQRT1_2 },
  ];
  for (const mass of [1.1, 36, 3600]) for (const { dx, dy } of placements) {
    const { arena, player, owner, fire } = fixture(), radius = 4 * Math.sqrt(mass);
    const x = dx < 0 ? radius : dx > 0 ? ARENA.width - radius : ARENA.width / 2;
    const y = dy < 0 ? radius : dy > 0 ? ARENA.height - radius : ARENA.height / 2;
    const separation = owner.radius + radius + 4;
    Object.assign(owner, { x: x - dx * separation, y: y - dy * separation, direction: { x: dx, y: dy } });
    Object.assign(owner.cells[0], { x: owner.x, y: owner.y });
    const target = player('edge-target', x, y, mass);
    fire();
    const pieces = fragments(arena, target.id), core = target.cells[0];
    assert.ok(target.lastWaveHit, `wave must hit mass ${mass} toward (${dx}, ${dy})`);
    assert.equal(pieces.length, 3);
    for (const piece of pieces) {
      assert.ok(piece.x >= 8 && piece.x <= ARENA.width - 8 && piece.y >= 8 && piece.y <= ARENA.height - 8);
      assert.ok(Math.hypot(piece.x - core.x, piece.y - core.y) > core.radius + 5,
        `mass ${mass} at (${dx}, ${dy}) must not spawn inside its source pickup radius`);
    }
    near(totalMass(arena), 36 + mass);
    // Remove the caster so a wall rebound cannot introduce an unrelated second
    // body collision while verifying the fragments' collection grace period.
    arena.players.delete(owner.id);
    for (const dust of arena.dust) if (!dust.fragment) { dust.x = ARENA.width / 2; dust.y = ARENA.height / 2; }
    const postHitMass = target.mass;
    advance(arena, .29);
    assert.equal(fragments(arena, target.id).length, 3);
    near(target.mass, postHitMass); near(totalMass(arena), mass);
  }
});

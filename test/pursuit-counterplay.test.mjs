import test from 'node:test';
import assert from 'node:assert/strict';
import { BLAST_COST, createArena, addPlayer, normalizeInput, setPlayerInput, stepArena, snapshotArena, movementSpeed } from '../shared/engine.js';

const near = (actual, expected, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should equal ${expected}`);
function fixture() {
  const arena = createArena({ random: () => .99 }); arena.status = 'playing';
  function player(id, x = 1000, y = 4000, mass = 36) {
    const p = addPlayer(arena, { id, name: id });
    Object.assign(p, { x, y, mass, radius: 4 * Math.sqrt(mass), energy: 100, invulnerable: 0 });
    Object.assign(p.cells[0], { x, y, mass, radius: p.radius, vx: 0, vy: 0 });
    return p;
  }
  return { arena, player };
}
function advance(arena, duration, dt = .01) {
  for (let time = 0; time < duration - 1e-9;) {
    const elapsed = Math.min(dt, duration - time); stepArena(arena, elapsed); time += elapsed;
  }
}

test('rear fire accepts only boolean input and launches opposite actual motion without recoil', () => {
  assert.equal(normalizeInput({ rearFire: 'true' }).rearFire, false);
  assert.equal(normalizeInput({ rearFire: true }).rearFire, true);
  const { arena, player } = fixture(), owner = player('owner');
  Object.assign(owner.cells[0], { vx: 120, vy: 160 });
  owner.direction = { x: 1, y: 0 };
  setPlayerInput(arena, owner.id, { x: -1, rearFire: true }); stepArena(arena, 0);
  const wave = arena.blasts[0];
  assert.equal(wave.mode, 'rear'); near(wave.directionX, -.6); near(wave.directionY, -.8);
  near(wave.originX, owner.x - .6 * wave.originOffset); near(wave.originY, owner.y - .8 * wave.originOffset);
  near(owner.cells[0].vx, 120); near(owner.cells[0].vy, 160);
  near(owner.energy, 100 - BLAST_COST); near(owner.cooldown, .85);
  assert.equal(snapshotArena(arena).blasts[0].mode, 'rear');
  advance(arena, .2);
  near(wave.directionX, -.6); near(wave.directionY, -.8);
});

test('a stationary rear wave retains the facing and leaves the owner motionless', () => {
  const { arena, player } = fixture(), owner = player('owner'); owner.direction = { x: 0, y: -1 };
  setPlayerInput(arena, owner.id, { rearFire: true }); stepArena(arena, 0);
  const wave = arena.blasts[0];
  near(wave.directionX, 0); near(wave.directionY, 1);
  near(wave.originX, owner.x); near(wave.originY, owner.y + wave.originOffset);
  assert.deepEqual(owner.direction, { x: 0, y: -1 });
  advance(arena, .2); near(owner.vx, 0); near(owner.vy, 0); near(owner.x, 1000); near(owner.y, 4000);
});

test('forward and rear waves cover opposite sides, push the hit target once and never push their owner', () => {
  for (const mode of ['forward', 'rear']) {
    const { arena, player } = fixture(), owner = player('owner');
    Object.assign(owner.cells[0], { vx: 180 });
    const front = player('front', 1078), rear = player('rear', 922);
    setPlayerInput(arena, owner.id, { [mode === 'rear' ? 'rearFire' : 'fire']: true }); stepArena(arena, 0);
    const wave = arena.blasts[0], hit = mode === 'rear' ? rear : front, safe = mode === 'rear' ? front : rear;
    assert.equal(hit.lastWaveHit.mode, mode); assert.equal(hit.lastWaveHit.ownerId, owner.id);
    near(hit.mass, 36 * .88); assert.ok(hit.vx * (mode === 'rear' ? -1 : 1) > 0);
    near(safe.mass, 36); near(safe.vx, 0); assert.equal(safe.lastWaveHit, null);
    near(owner.cells[0].vx, 180); assert.equal(owner.lastWaveHit, null);
    const event = hit.lastWaveHit, velocity = hit.vx, revision = hit.collisionRevision;
    for (let i = 0; i < 5; i++) stepArena(arena, 0);
    assert.equal(wave.hit.size, 1); assert.equal(hit.lastWaveHit, event);
    assert.equal(hit.collisionRevision, revision); near(hit.vx, velocity); near(hit.mass, 36 * .88);
  }
});

test('both wave keys share energy and cooldown, with forward taking a simultaneous edge', () => {
  const { arena, player } = fixture(), owner = player('owner');
  setPlayerInput(arena, owner.id, { fire: true, rearFire: true }); stepArena(arena, 0);
  assert.equal(arena.blasts.length, 1); assert.equal(arena.blasts[0].mode, 'forward');
  near(owner.energy, 70); near(owner.cooldown, .85);
  assert.equal(owner.fireQueued, false); assert.equal(owner.rearFireQueued, false);
  advance(arena, 1);
  assert.equal(arena.blasts.length, 0, 'holding either key does not repeat after cooldown expires');
  near(owner.energy, 73);
  setPlayerInput(arena, owner.id, {}); setPlayerInput(arena, owner.id, { rearFire: true }); stepArena(arena, 0);
  assert.equal(arena.blasts.length, 1); assert.equal(arena.blasts[0].mode, 'rear'); near(owner.energy, 43);
  setPlayerInput(arena, owner.id, { fire: true, rearFire: true }); stepArena(arena, 0);
  assert.equal(arena.blasts.length, 1, 'forward cannot bypass a rear wave cooldown'); near(owner.energy, 43);
  advance(arena, 1); assert.equal(arena.blasts.length, 0, 'a blocked edge is not queued for a delayed automatic shot');
});

test('a rear wave honors the same upgraded cost and requires a new edge after insufficient energy', () => {
  const { arena, player } = fixture(), owner = player('owner');
  Object.assign(owner.stats, { blastCost: 20, blastCooldown: .4, energyRegen: 0 }); owner.energy = 19;
  setPlayerInput(arena, owner.id, { rearFire: true }); stepArena(arena, 0);
  assert.equal(arena.blasts.length, 0); near(owner.cooldown, 0);
  owner.energy = 20; setPlayerInput(arena, owner.id, { rearFire: true }); stepArena(arena, 0);
  assert.equal(arena.blasts.length, 0, 'holding an initially unaffordable shot does not fire later');
  setPlayerInput(arena, owner.id, {}); setPlayerInput(arena, owner.id, { rearFire: true }); stepArena(arena, 0);
  assert.equal(arena.blasts.length, 1); near(owner.energy, 0); near(owner.cooldown, .4);
});

function chase(rearAt, dt) {
  const { arena, player } = fixture();
  const pursuer = player('pursuer', 5800, 4000, 120), target = player('target', 6000);
  const originalCore = target.cells[0].id;
  for (const p of [pursuer, target]) {
    const vx = movementSpeed(p.mass, p.stats.speed);
    Object.assign(p.cells[0], { vx }); Object.assign(p, { vx, vy: 0 });
    setPlayerInput(arena, p.id, { x: 1 });
  }
  setPlayerInput(arena, pursuer.id, { x: 1, split: true });
  const history = [];
  let firstHit = null, fired = false, minGap = Infinity, splitMasses;
  for (let frame = 0; frame < Math.round(3 / dt); frame++) {
    if (!fired && rearAt !== null && arena.time + 1e-8 >= rearAt) {
      setPlayerInput(arena, target.id, { x: 1, rearFire: true }); fired = true;
    }
    stepArena(arena, dt);
    splitMasses ??= pursuer.cells.map(cell => cell.mass);
    history.push(pursuer.cells.map(cell => ({ id: cell.id, mass: cell.mass, vx: cell.vx })));
    if (!firstHit && pursuer.lastWaveHit) firstHit = { ...pursuer.lastWaveHit, frame,
      cells: history.at(-1).filter(cell => pursuer.lastWaveHit.hitCellIds.includes(cell.id)) };
    for (const a of pursuer.cells) for (const b of target.cells) {
      minGap = Math.min(minGap, Math.hypot(a.x - b.x, a.y - b.y) - a.radius - b.radius);
    }
  }
  return { arena, pursuer, target, originalCore, history, firstHit, minGap, splitMasses };
}

test('Space can intercept a fleeing smaller planet, while a timely rear wave physically prevents that intercept', () => {
  for (const dt of [.01, 1 / 120]) {
    const control = chase(null, dt), counter = chase(.1, dt);
    assert.deepEqual(control.splitMasses, [60, 60], 'pursuit puts half the original mass in the launched body');
    assert.ok(control.target.shatteredAt > .2 && control.target.shatteredAt < .4, 'the launched half catches the faster fleeing target');
    assert.ok(control.target.lastImpact?.fractured); near(control.target.mass, 12);
    assert.equal(control.target.cells[0].id, control.originalCore);

    const hit = counter.firstHit;
    assert.ok(hit, 'the rear wave must actually intersect the pursuing body');
    assert.equal(hit.mode, 'rear'); assert.equal(hit.ownerId, counter.target.id);
    near(hit.directionX, -1); near(hit.directionY, 0); near(hit.lostMass, 60 * .12);
    assert.equal(hit.cells.length, 1); near(hit.cells[0].mass, 60 * .88);
    const freeBody = control.history[hit.frame].find(cell => cell.id === hit.cells[0].id);
    assert.ok(freeBody, 'the control run contains the same launched body before contact');
    near(hit.cells[0].vx - freeBody.vx, -hit.impulse);
    assert.ok(hit.impulse > 180, 'counterplay applies a meaningful physical braking impulse');
    near(counter.target.mass, 36); assert.equal(counter.target.lastImpact, null);
    assert.equal(counter.target.shatteredAt, -10); assert.equal(counter.target.cells[0].id, counter.originalCore);
    assert.ok(counter.minGap > 20, 'the counter opens a real gap instead of relying on damage protection');
    assert.ok(counter.arena.dust.filter(dust => !dust.fragment).length >= 6000);
  }
});

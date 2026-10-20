import test from 'node:test';
import assert from 'node:assert/strict';
import { ARENA, DYSON, DUST_COUNT, addPlayer, advanceSiblingFusion, cancelDysonLinks,
  createArena, setPlayerInput, snapshotArena, startRound, stepArena } from '../shared/engine.js';

const near = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `${actual} should equal ${expected} within ${tolerance}`);
const fragments = arena => arena.dust.filter(dust => dust.fragment);
const conservedMass = arena => [...arena.players.values()].reduce((sum, player) =>
  sum + player.cells.reduce((mass, cell) => mass + cell.mass, 0), 0) +
  fragments(arena).reduce((sum, dust) => sum + dust.value, 0);

function fixture({ sourceMass = 36, distance = 78, rear = false } = {}) {
  const arena = createArena({ endless: true, random: () => .99 }); arena.status = 'playing';
  arena.dust = Array.from({ length: DUST_COUNT }, (_, index) => ({ id: `far-${index}`,
    x: 11000, y: 7000, value: 1, vx: 0, vy: 0 }));
  function player(id, x, y = 4000, mass = 36) {
    const p = addPlayer(arena, { id });
    Object.assign(p, { x, y, mass, radius: 4 * Math.sqrt(mass), energy: 100, invulnerable: 0 });
    Object.assign(p.cells[0], { x, y, mass, radius: p.radius, vx: 0, vy: 0 });
    p.stats.energyRegen = 0;
    return p;
  }
  const attacker = player('attacker', 4000, 4000, sourceMass);
  const target = player('target', 4000 + (rear ? -distance : distance));
  const fire = (mode = rear ? 'rear' : 'forward') => {
    setPlayerInput(arena, attacker.id, { [mode === 'rear' ? 'rearFire' : 'fire']: true });
    stepArena(arena, 0);
    return arena.blasts.find(wave => wave.ownerId === attacker.id);
  };
  const activate = (input = {}) => {
    setPlayerInput(arena, attacker.id, {});
    setPlayerInput(arena, attacker.id, { ...input, split: true });
    stepArena(arena, 0);
    assert.ok(attacker.dyson, 'a new Space edge following a real wave hit should create a shell');
    return attacker.cells.find(cell => cell.id === attacker.dyson.sourceCellId);
  };
  return { arena, player, attacker, target, fire, activate };
}

function advance(arena, duration, pattern = [1 / 30], onStep) {
  let elapsed = 0, index = 0;
  while (elapsed < duration - 1e-9) {
    const dt = Math.min(pattern[index++ % pattern.length], duration - elapsed);
    stepArena(arena, dt); elapsed += dt; onStep?.();
  }
}

function putDust(arena, cell, spec) {
  const dust = { id: spec.id, x: cell.x, y: cell.y, vx: 0, vy: 0, value: 1, ...spec };
  if (!dust.fragment) {
    const background = arena.dust.findIndex(item => item.id.startsWith('far-'));
    if (background >= 0) arena.dust.splice(background, 1);
  }
  arena.dust.push(dust);
  return dust;
}

test('a real forward or rear hit arms only its firing core and a fresh Space transforms a sub-48 mass core without splitting it', () => {
  for (const rear of [false, true]) {
    const { arena, attacker, target, fire, activate } = fixture({ rear });
    const id = attacker.cells[0].id, wave = fire(), ready = attacker.dysonReady;
    assert.ok(target.lastWaveHit && ready);
    assert.equal(ready.waveId, wave.id); assert.equal(ready.sourceCellId, id);
    assert.equal(ready.targetId, target.id); assert.equal(ready.targetCellId, target.cells[0].id);
    near(ready.hitAt, target.lastWaveHit.at); near(ready.expiresAt - ready.hitAt, DYSON.window);
    near(ready.directionX, rear ? -1 : 1); near(ready.directionY, 0);
    const before = conservedMass(arena), shell = activate();
    assert.equal(attacker.cells.length, 1); assert.equal(shell.id, id); near(shell.mass, 36);
    assert.equal(shell.dysonId, attacker.dyson.id); assert.equal(attacker.dysonReady, null);
    near(attacker.dyson.endsAt - attacker.dyson.startedAt, DYSON.duration);
    near(attacker.dysonCooldown, DYSON.cooldown); near(attacker.energy, 100 - attacker.stats.blastCost);
    near(conservedMass(arena), before);
    assert.ok(attacker.dysonRevision > 0);
  }
});

test('Space held before the hit cannot trigger a delayed shell, and an expired mark preserves ordinary splitting', () => {
  const held = fixture();
  setPlayerInput(held.arena, held.attacker.id, { fire: true, split: true }); stepArena(held.arena, 0);
  assert.ok(held.attacker.dysonReady); assert.equal(held.attacker.dyson, null);
  setPlayerInput(held.arena, held.attacker.id, { split: true }); stepArena(held.arena, .1);
  assert.equal(held.attacker.dyson, null, 'holding an earlier Space must not convert after its wave lands');
  held.activate();

  const expired = fixture({ sourceMass: 72, distance: 100 }); expired.fire();
  assert.ok(expired.attacker.dysonReady);
  advance(expired.arena, DYSON.window + .05);
  setPlayerInput(expired.arena, expired.attacker.id, { split: true }); stepArena(expired.arena, 0);
  assert.equal(expired.attacker.dyson, null); assert.equal(expired.attacker.cells.length, 2);
});

test('misses, spawn protection and counter-wave cancellation cannot arm the wrapping combo', () => {
  for (const protectedTarget of [false, true]) {
    const { arena, attacker, target, fire } = fixture({ distance: protectedTarget ? 78 : 1200 });
    if (protectedTarget) target.invulnerable = 10;
    fire(); advance(arena, .8);
    assert.equal(attacker.dysonReady, null); assert.equal(target.lastWaveHit, null);
    setPlayerInput(arena, attacker.id, { split: true }); stepArena(arena, 0);
    assert.equal(attacker.dyson, null);
  }
  const { arena, attacker, target, player, fire } = fixture({ distance: 500 });
  const counter = player('counter', 4400); counter.direction = { x: -1, y: 0 };
  fire(); setPlayerInput(arena, counter.id, { fire: true }); stepArena(arena, 0);
  advance(arena, .4);
  assert.equal(arena.waveClashes.length, 1); assert.equal(target.lastWaveHit, null);
  assert.equal(attacker.dysonReady, null);
});

test('interception transfers only actual target pickups, applying attacker growth to natural dust and exact mass to recycled fragments', () => {
  const { arena, attacker, target, fire, activate } = fixture(); fire(); activate();
  attacker.stats.growth = 1.6; target.stats.growth = 1.2;
  const core = attacker.cells[0], victim = target.cells[0], mass = core.mass, targetMass = victim.mass;
  const score = attacker.score, energy = attacker.energy;
  const natural = putDust(arena, victim, { id: 'target-natural', value: 2 });
  const debris = putDust(arena, victim, { id: 'target-debris', value: 3, fragment: true,
    ownerId: null, collectAfter: 0, availableAt: 0 });
  const distant = putDust(arena, victim, { id: 'not-a-pickup', x: victim.x + victim.radius + 40, value: 5 });
  stepArena(arena, 0);
  near(core.mass - mass, 2 * 1.6 + 3); near(victim.mass, targetMass);
  near(attacker.dyson.capturedMass, 2 * 1.6 + 3);
  near(attacker.score - score, 4); near(attacker.energy - energy, 8);
  assert.ok(!arena.dust.includes(natural) && !arena.dust.includes(debris));
  assert.ok(arena.dust.includes(distant));
  assert.equal(arena.dust.filter(dust => !dust.fragment).length, DUST_COUNT);
  const after = core.mass; stepArena(arena, 0); near(core.mass, after);
});

test('target pickup grace and receiver ownership grace survive interception without losing or duplicating a particle', () => {
  const { arena, attacker, target, fire, activate } = fixture(); fire(); activate();
  const core = attacker.cells[0], victim = target.cells[0], attackerMass = core.mass, targetMass = victim.mass;
  const targetGrace = putDust(arena, victim, { id: 'target-owner-grace', value: 3, fragment: true,
    ownerId: target.id, collectAfter: 0, availableAt: .9 });
  const receiverGrace = putDust(arena, victim, { id: 'receiver-owner-grace', value: 2, fragment: true,
    ownerId: attacker.id, collectAfter: 0, availableAt: .9 });
  const globalGrace = putDust(arena, victim, { id: 'global-grace', value: 4, fragment: true,
    ownerId: null, collectAfter: .3, availableAt: 0 });
  stepArena(arena, 0);
  near(core.mass, attackerMass); near(victim.mass, targetMass + 2);
  assert.ok(arena.dust.includes(targetGrace) && arena.dust.includes(globalGrace));
  assert.ok(!arena.dust.includes(receiverGrace), 'an eligible original target keeps its pickup when the receiver is still barred');
  near(attacker.dyson.capturedMass, 0);
  arena.time = .91;
  for (const dust of [targetGrace, globalGrace]) Object.assign(dust, { x: victim.x, y: victim.y });
  stepArena(arena, 0);
  near(core.mass, attackerMass + 7); near(victim.mass, targetMass + 2);
  near(attacker.dyson.capturedMass, 7);
  assert.ok(!arena.dust.includes(targetGrace) && !arena.dust.includes(globalGrace));
});

test('only the marked target core is intercepted while another target sibling and a different player retain their own pickups', () => {
  const { arena, attacker, target, player, fire, activate } = fixture(); fire(); activate();
  const sibling = { ...target.cells[0], id: 'unwrapped-target-sibling', x: 7000, y: 5000,
    mass: 9, radius: 12, vx: 0, vy: 0, fusionId: null, mergeIn: 10 };
  target.cells.push(sibling); target.mass += sibling.mass;
  const third = player('third', 9000, 5000);
  const a = attacker.mass, t = target.mass, z = third.mass;
  putDust(arena, sibling, { id: 'sibling-food', value: 2 });
  putDust(arena, third.cells[0], { id: 'third-food', value: 3 });
  stepArena(arena, 0);
  near(attacker.mass, a); near(target.mass, t + 2); near(third.mass, z + 3);
  near(attacker.dyson.capturedMass, 0);
});

test('the converted core is excluded from ordinary gravity, pickup, solid collisions and meteor impacts', () => {
  const { arena, attacker, target, player, fire, activate } = fixture({ sourceMass: 400, distance: 150 });
  fire(); const source = activate(), victim = target.cells[0], before = conservedMass(arena);
  const untouched = player('near-shell', victim.x, victim.y - 65, 1);
  const dust = putDust(arena, victim, { id: 'outside-target-gravity', x: victim.x + 200 });
  const withinSourceOnly = putDust(arena, victim, { id: 'inside-source-only', y: victim.y + 60 });
  const meteor = { id: 'shell-only-meteor', x: victim.x, y: victim.y + 60, vx: 250, vy: 0,
    radius: 4, mass: 4, tailLength: 50, color: '#ffe787', bornAt: arena.time };
  arena.meteors = [meteor];
  advance(arena, .1);
  near(source.mass, 400); near(attacker.dyson.capturedMass, 0);
  near(untouched.mass, 1); assert.equal(untouched.lastImpact, null);
  assert.equal(attacker.lastMeteorHit, null); assert.equal(target.lastMeteorHit, null);
  assert.ok(arena.meteors.includes(meteor), 'a meteor outside the actual victim must pass the dormant source body');
  near(dust.vx, 0); near(dust.vy, 0);
  assert.ok(arena.dust.includes(withinSourceOnly), 'the large stored source radius must not create a second pickup area');
  near(conservedMass(arena), before + 1);
});

test('a wave launched before a normal split still lands and converts only its original source core while the other core keeps moving', () => {
  const { arena, attacker, target, fire, activate } = fixture({ sourceMass: 72, distance: 300 });
  const sourceId = attacker.cells[0].id, wave = fire(); assert.equal(attacker.dysonReady, null);
  setPlayerInput(arena, attacker.id, { split: true }); stepArena(arena, 0);
  assert.equal(attacker.cells.length, 2); assert.ok(arena.blasts.includes(wave));
  setPlayerInput(arena, attacker.id, {}); advance(arena, .35);
  assert.ok(target.lastWaveHit); assert.equal(attacker.dysonReady.sourceCellId, sourceId);
  const shell = activate(), ordinary = attacker.cells.find(cell => cell.id !== sourceId);
  assert.equal(shell.id, sourceId); assert.ok(!ordinary.dysonId);
  const x = ordinary.x, energy = attacker.energy, ids = attacker.cells.map(cell => cell.id);
  setPlayerInput(arena, attacker.id, {});
  setPlayerInput(arena, attacker.id, { x: 1, fire: true, rearFire: true, split: true });
  advance(arena, .1);
  assert.deepEqual(attacker.cells.map(cell => cell.id), ids); near(attacker.energy, energy);
  assert.ok(ordinary.x > x + 1, 'the non-shell core must continue ordinary physics');
  assert.equal(arena.blasts.filter(blast => blast.ownerId === attacker.id && blast.id !== wave.id).length, 0);
});

test('activating a previously launched wave source safely detaches its in-progress sibling fusion', () => {
  const { arena, attacker, target, fire, activate } = fixture({ sourceMass: 72, distance: 300 });
  fire();
  const source = attacker.cells[0], donor = { ...source, id: 'source-fusion-donor', mass: 12, radius: 4 * Math.sqrt(12),
    x: source.x - source.radius - 4 * Math.sqrt(12) };
  attacker.cells.push(donor); advanceSiblingFusion(attacker.cells, 0);
  assert.ok(source.fusionId); advance(arena, .35); assert.ok(target.lastWaveHit);
  const before = conservedMass(arena); activate();
  assert.equal(source.fusionId, null); assert.equal(donor.fusionId, null); assert.ok(donor.mergeIn > 0);
  near(conservedMass(arena), before);
  advance(arena, .1);
  assert.ok(attacker.cells.every(cell => cell.mass > 0 && Number.isFinite(cell.vx) && Number.isFinite(cell.vy)));
});

test('a marked donor consumed by the target fusion retargets a surviving core without losing the shell or stored mass', () => {
  const { arena, attacker, target, fire, activate } = fixture({ distance: 90 });
  const receiver = target.cells[0];
  Object.assign(receiver, { x: 4090 + 4 * (Math.sqrt(60) + Math.sqrt(12)), mass: 60, radius: 4 * Math.sqrt(60) });
  const donor = { ...receiver, id: 'target-fusion-donor', x: 4090, mass: 12, radius: 4 * Math.sqrt(12) };
  target.cells.push(donor); advanceSiblingFusion(target.cells, 0);
  fire(); assert.equal(attacker.dysonReady.targetCellId, donor.id); activate();
  const sourceId = attacker.cells[0].id, before = conservedMass(arena);
  advance(arena, 1.3, [.1, 1 / 30, .05]);
  assert.equal(target.cells.length, 1); assert.equal(target.cells[0].id, receiver.id);
  assert.ok(attacker.dyson); assert.equal(attacker.dyson.targetCellId, receiver.id);
  assert.equal(attacker.cells[0].id, sourceId); near(conservedMass(arena), before);
});

test('expiry returns the same core safely near the moving target on the chosen side and blocks immediate rewrapping', () => {
  for (const edge of [false, true]) {
    const f = fixture(), { arena, attacker, target, fire, activate } = f;
    if (edge) {
      const shift = ARENA.width - 120 - target.cells[0].x;
      for (const p of [attacker, target]) { p.x += shift; p.cells[0].x += shift; }
    }
    fire(); const source = activate({ y: -1 }), id = source.id, sourceMass = source.mass, before = conservedMass(arena);
    setPlayerInput(arena, attacker.id, { y: -1 });
    advance(arena, DYSON.duration, [.1, 1 / 30, .05]);
    assert.equal(attacker.dyson, null); assert.ok(!source.dysonId); assert.equal(source.id, id);
    assert.ok(attacker.lastDysonEnd); assert.equal(attacker.lastDysonEnd.sourceCellId, id);
    near(source.mass, sourceMass + attacker.lastDysonEnd.capturedMass);
    assert.ok(attacker.dysonCooldown > 0); assert.ok(source.protectedFor > 0);
    const body = target.cells[0], gap = Math.hypot(source.x - body.x, source.y - body.y) - source.radius - body.radius;
    assert.ok(gap >= DYSON.returnClearance - .1, 'return must not create an overlapping body');
    assert.ok(source.y < body.y, 'the final directional input chooses the exit side');
    assert.ok(source.x >= source.radius && source.x <= ARENA.width - source.radius);
    assert.ok(source.y >= source.radius && source.y <= ARENA.height - source.radius);
    near(conservedMass(arena), before);
    setPlayerInput(arena, attacker.id, {}); setPlayerInput(arena, attacker.id, { split: true }); stepArena(arena, 0);
    assert.equal(attacker.dyson, null);
  }
});

test('an occupied target core rejects a competing shell even after the rival lands another wave', () => {
  const { arena, attacker, target, player, fire, activate } = fixture(); fire(); activate();
  advance(arena, .75); // Let the first wave expire so it cannot cancel the rival shot.
  const rival = player('rival', 4300); rival.direction = { x: -1, y: 0 };
  // A second real wave may hit the occupied target, but its split cannot
  // create another shell around the same body or make the wrapped caster nest.
  setPlayerInput(arena, rival.id, { fire: true }); stepArena(arena, 0); advance(arena, .3);
  assert.equal(target.lastWaveHit.ownerId, rival.id, 'the competing caster must actually land its wave before the rejection is tested');
  setPlayerInput(arena, rival.id, { split: true }); stepArena(arena, 0);
  assert.equal(rival.dyson, null); assert.ok(attacker.dyson);
  assert.equal([...arena.players.values()].filter(p => p.dyson).length, 1);
  assert.equal(target.cells.filter(cell => cell.dysonId).length, 0,
    'the target is not converted into an attacking shell');
});

test('cancelling either participant restores synchronously, preserves captured mass and is safe to repeat before a snapshot', () => {
  for (const participant of ['attacker', 'target']) {
    const { arena, attacker, target, fire, activate } = fixture(); fire(); const source = activate();
    putDust(arena, target.cells[0], { id: 'captured-before-leave', value: 2, fragment: true, ownerId: null });
    stepArena(arena, 0); const before = conservedMass(arena), mass = source.mass;
    cancelDysonLinks(arena, participant, 'disconnect');
    const wire = snapshotArena(arena);
    assert.equal(attacker.dyson, null); assert.ok(!source.dysonId); near(source.mass, mass);
    assert.ok(!wire.players.find(p => p.id === target.id).dysonOwnerId);
    assert.ok(wire.players.every(p => !p.dyson)); near(conservedMass(arena), before);
    const ended = attacker.lastDysonEnd?.id;
    cancelDysonLinks(arena, participant, 'disconnect');
    assert.equal(attacker.lastDysonEnd?.id, ended); near(conservedMass(arena), before);
  }
});

test('snapshots copy shell state and a finished or restarted round cannot retain an attachment or a reusable mark', () => {
  const { arena, attacker, target, fire, activate } = fixture(); fire(); activate();
  const snapshot = snapshotArena(arena), wire = snapshot.players.find(player => player.id === attacker.id);
  assert.deepEqual(snapshot.dysonRules, DYSON); assert.ok(wire.dyson);
  assert.equal(wire.cells.find(cell => cell.id === wire.dyson.sourceCellId).dysonId, wire.dyson.id);
  wire.dyson.capturedMass = -999; wire.dyson.targetId = 'tampered';
  assert.notEqual(attacker.dyson.targetId, 'tampered'); near(attacker.dyson.capturedMass, 0);
  arena.endless = false; arena.time = 179.99;
  stepArena(arena, .02);
  assert.equal(arena.status, 'finished');
  assert.ok([...arena.players.values()].every(player => !player.dyson && !player.dysonReady));
  assert.ok([...arena.players.values()].flatMap(player => player.cells).every(cell => !cell.dysonId));
  startRound(arena);
  for (const player of [attacker, target]) {
    assert.equal(player.dyson, null); assert.equal(player.dysonReady, null);
    near(player.dysonCooldown, 0); assert.equal(player.lastDysonEnd, null);
  }
});

test('both wave directions reject multiple controlled cores without a cost, then accept a fresh edge after fusion returns to one core', () => {
  for (const rear of [false, true]) {
    const { arena, attacker } = fixture({ distance: 1200 });
    const source = attacker.cells[0], donor = { ...source, id: 'wave-block-donor', x: source.x - 48 };
    attacker.cells.push(donor); attacker.mass = 72;
    const key = rear ? 'rearFire' : 'fire', energy = attacker.energy;
    setPlayerInput(arena, attacker.id, { [key]: true }); stepArena(arena, 0);
    assert.equal(arena.blasts.length, 0); near(attacker.energy, energy); near(attacker.cooldown, 0);
    advanceSiblingFusion(attacker.cells, 0); advanceSiblingFusion(attacker.cells, 1.2);
    assert.equal(attacker.cells.length, 1);
    setPlayerInput(arena, attacker.id, { [key]: true }); stepArena(arena, 0);
    assert.equal(arena.blasts.length, 0, 'a blocked held key does not automatically fire on fusion');
    setPlayerInput(arena, attacker.id, {}); setPlayerInput(arena, attacker.id, { [key]: true }); stepArena(arena, 0);
    assert.equal(arena.blasts.length, 1); assert.equal(arena.blasts[0].mode, rear ? 'rear' : 'forward');
    near(attacker.energy, energy - attacker.stats.blastCost); assert.ok(attacker.cooldown > 0);
  }
});

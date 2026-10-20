import test from 'node:test';
import assert from 'node:assert/strict';
import { ARENA, DUST_COUNT, WAVE, addPlayer, advanceSiblingFusion, createArena,
  setPlayerInput, snapshotArena, startRound, stepArena } from '../shared/engine.js';

const near = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `${actual} should equal ${expected} within ${tolerance}`);
const wirePlayer = (arena, id) => snapshotArena(arena).players.find(player => player.id === id);

function fixture(mass = 36) {
  const arena = createArena({ endless: true, random: () => .99 }); arena.status = 'playing';
  arena.dust = Array.from({ length: DUST_COUNT }, (_, index) => ({ id: `far-${index}`,
    x: 11000, y: 7000, value: 1, vx: 0, vy: 0 }));
  function player(id, x = 4000, y = 4000, size = 36) {
    const p = addPlayer(arena, { id });
    Object.assign(p, { x, y, mass: size, radius: 4 * Math.sqrt(size), invulnerable: 0, energy: 100 });
    Object.assign(p.cells[0], { x, y, mass: size, radius: p.radius, vx: 0, vy: 0 });
    p.stats.energyRegen = 0;
    return p;
  }
  const owner = player('owner', 4000, 4000, mass);
  function fire(rear = false) {
    setPlayerInput(arena, owner.id, {});
    setPlayerInput(arena, owner.id, { [rear ? 'rearFire' : 'fire']: true }); stepArena(arena, 0);
    return arena.blasts.find(wave => wave.id === owner._latestWaveId) ?? arena.blasts.at(-1);
  }
  function space(dt = 0) {
    setPlayerInput(arena, owner.id, {});
    setPlayerInput(arena, owner.id, { split: true }); stepArena(arena, dt);
    return owner.lastWaveBlink;
  }
  return { arena, owner, player, fire, space };
}

function advance(arena, duration, dt = 1 / 30) {
  let elapsed = 0;
  while (elapsed < duration - 1e-9) {
    const step = Math.min(dt, duration - elapsed); stepArena(arena, step); elapsed += step;
  }
}

function counterWave(id, x, y) {
  return { id, ownerId: 'counter-owner', kind: 'wave', mode: 'forward', sourceCellId: 'counter-source',
    x, y, originX: x, originY: y, directionX: -1, directionY: 0, width: WAVE.width,
    thickness: WAVE.thickness, curvature: WAVE.curvature, speed: WAVE.speed,
    distance: WAVE.distance, travel: 0, color: '#ffe787', radius: 120, hit: new Set() };
}

test('a fresh Space on either directional wave blinks a small source to the current front without altering its identity, mass or momentum', () => {
  for (const rear of [false, true]) {
    const { arena, owner, fire, space } = fixture(), source = owner.cells[0];
    Object.assign(source, { vx: 60, vy: 80 });
    const wave = fire(rear); advance(arena, .15);
    const before = { ...source }, front = { x: wave.x, y: wave.y }, energy = owner.energy, cooldown = owner.cooldown;
    const event = space();
    assert.ok(event, 'a live wave which has not hit anything must offer a blink below the normal split threshold');
    assert.equal(owner.cells.length, 1); assert.equal(source.id, before.id);
    near(source.mass, before.mass); near(source.vx, before.vx); near(source.vy, before.vy);
    near(source.x, front.x); near(source.y, front.y);
    assert.equal(event.waveId, wave.id); assert.equal(event.sourceCellId, source.id);
    near(event.fromX, before.x); near(event.fromY, before.y); near(event.x, front.x); near(event.y, front.y);
    near(event.vx, before.vx); near(event.vy, before.vy); near(event.at, arena.time);
    assert.equal(source.lastWaveBlinkId, event.id); assert.equal(owner.waveBlinkRevision, 1);
    near(owner.energy, energy); near(owner.cooldown, cooldown);
    assert.ok(!arena.blasts.includes(wave)); assert.equal(wave.blinkUsed, true);
  }
});

test('the event uses the server boundary front rather than advancing the wave into the future before teleporting', () => {
  const { arena, owner, fire, space } = fixture(), source = owner.cells[0]; source.vx = 90;
  const wave = fire(); advance(arena, .2);
  const at = arena.time, frontX = wave.x, frontY = wave.y, vx = source.vx, vy = source.vy;
  const event = space(.1);
  assert.ok(event); near(event.at, at); near(event.x, frontX); near(event.y, frontY);
  near(event.vx, vx); near(event.vy, vy);
  near(source.x, frontX + vx * (1 - Math.exp(-.2)) / 2);
  near(source.y, frontY + vy * (1 - Math.exp(-.2)) / 2);
  assert.ok(!arena.blasts.includes(wave));
  near(wave.x, frontX); near(wave.y, frontY);
});

test('same-tick fire and Space cannot blink to a wave which has not yet been launched, and holding Space never triggers later', () => {
  const split = fixture(96);
  setPlayerInput(split.arena, split.owner.id, { fire: true, split: true }); stepArena(split.arena, .1);
  assert.equal(split.owner.cells.length, 2); assert.equal(split.arena.blasts.length, 0);
  assert.equal(split.owner.lastWaveBlink, null); near(split.owner.energy, 100);

  const small = fixture();
  setPlayerInput(small.arena, small.owner.id, { fire: true, split: true }); stepArena(small.arena, 0);
  assert.equal(small.arena.blasts.length, 1); assert.equal(small.owner.lastWaveBlink, null);
  setPlayerInput(small.arena, small.owner.id, { split: true }); stepArena(small.arena, .1);
  assert.equal(small.owner.lastWaveBlink, null);
  assert.ok(small.space());
});

test('one wave is consumed by its only blink and a new Space falls back to ordinary splitting', () => {
  const { arena, owner, fire, space } = fixture(96), source = owner.cells[0];
  const wave = fire(); advance(arena, .1); const first = space();
  assert.ok(first); const revision = owner.waveBlinkRevision, energy = owner.energy;
  const travel = wave.travel, id = first.id;
  space();
  assert.equal(owner.lastWaveBlink.id, id); assert.equal(owner.waveBlinkRevision, revision);
  assert.equal(owner.cells.length, 2); near(owner.cells.reduce((mass, cell) => mass + cell.mass, 0), 96);
  assert.equal(owner.cells[0].id, source.id); assert.ok(!arena.blasts.includes(wave)); near(wave.travel, travel);
  near(owner.energy, energy);
});

test('a consumed wave cannot hit later or arm a late Dyson combo, while an otherwise identical unconsumed wave still hits', () => {
  const { arena, owner, player, fire, space } = fixture(), target = player('target', 4300);
  const sourceId = owner.cells[0].id, wave = fire(); advance(arena, .1);
  const blink = space(); assert.ok(blink); assert.equal(target.lastWaveHit, null);
  assert.ok(!arena.blasts.includes(wave));
  advance(arena, .7);
  assert.equal(target.lastWaveHit, null); assert.equal(owner.dysonReady, null);
  near(target.mass, 36); near(target.vx, 0); near(target.vy, 0);
  assert.equal(arena.dust.filter(dust => dust.fragment).length, 0);
  space();
  assert.equal(owner.dyson, null); assert.equal(owner.lastWaveBlink.id, blink.id);
  assert.equal(owner.cells.length, 1); assert.equal(owner.cells[0].id, sourceId); near(owner.mass, 36);

  const control = fixture(), controlTarget = control.player('target', 4300), liveWave = control.fire();
  advance(control.arena, .4);
  assert.equal(controlTarget.lastWaveHit.waveId, liveWave.id); assert.ok(control.owner.dysonReady);
  control.space(); assert.ok(control.owner.dyson, 'real hits still retain the higher-priority Dyson combo');
});

test('consumption happens before the same tick can produce another hit or a ghost wave clash', () => {
  const hit = fixture(), target = hit.player('same-tick-target', 4200), wave = hit.fire();
  advance(hit.arena, .1);
  assert.equal(target.lastWaveHit, null); const blink = hit.space(.1);
  assert.ok(blink); assert.ok(!hit.arena.blasts.includes(wave));
  assert.equal(target.lastWaveHit, null); assert.equal(hit.owner.dysonReady, null);
  near(target.mass, 36); near(target.vx, 0);

  const clash = fixture(), selected = clash.fire(); advance(clash.arena, .1);
  const counter = counterWave('would-have-clashed', selected.x + 120, selected.y);
  clash.arena.blasts.push(counter);
  const event = clash.space(.1);
  assert.ok(event); assert.ok(!clash.arena.blasts.includes(selected));
  assert.ok(clash.arena.blasts.includes(counter), 'other waves continue after only the selected wave is consumed');
  assert.equal(clash.arena.waveClashes.length, 0, 'a removed wave cannot participate in a later cancellation timeline');
});

test('the latest launched wave is authoritative and used, hit, cancelled or expired latest waves never fall back to an older one', () => {
  for (const blocked of ['used', 'hit', 'cancelled', 'expired']) {
    const { arena, owner, player, fire, space } = fixture(96);
    owner.stats.blastCooldown = .4;
    if (blocked === 'expired') owner.stats.blastRange = 1.72;
    const older = fire(); advance(arena, .45); owner.stats.blastRange = 1;
    if (blocked === 'hit') {
      owner._dysonCooldownUntil = arena.time + 8;
      player('late-target', owner.cells[0].x + owner.cells[0].radius + 54);
    }
    const latest = fire();
    assert.notEqual(latest.id, older.id); assert.ok(arena.blasts.includes(older)); assert.equal(older.hit.size, 0);
    if (blocked === 'used') {
      const first = space(); assert.equal(first.waveId, latest.id);
      assert.ok(!arena.blasts.includes(latest)); assert.ok(arena.blasts.includes(older));
    } else if (blocked === 'hit') {
      assert.ok(latest.hit.size > 0); assert.equal(owner.dysonReady, null);
    } else if (blocked === 'cancelled') {
      arena.blasts.push(counterWave('latest-counter', latest.x + 20, latest.y)); stepArena(arena, 0);
      assert.ok(!arena.blasts.includes(latest)); assert.ok(arena.waveClashes.length > 0);
    } else {
      advance(arena, .705);
      assert.ok(!arena.blasts.includes(latest)); assert.ok(arena.blasts.includes(older));
    }
    const previous = owner.lastWaveBlink?.id ?? null, revision = owner.waveBlinkRevision;
    assert.equal(wirePlayer(arena, owner.id).waveBlinkReady, null, `${blocked} latest must not advertise the older wave`);
    space();
    assert.equal(owner.lastWaveBlink?.id ?? null, previous, `${blocked} latest cannot blink through an older wave`);
    assert.equal(owner.waveBlinkRevision, revision); assert.ok(!older.blinkUsed);
    assert.equal(owner.cells.length, 2, 'without an eligible combo, an affordable normal split remains available');
  }
});

test('a missing firing source cannot blink a replacement core merely because it belongs to the same player', () => {
  const { arena, owner, fire, space } = fixture(96), original = owner.cells[0];
  const wave = fire(); advance(arena, .1);
  owner.cells = [{ ...original, id: 'replacement-core', lastWaveBlinkId: null }];
  assert.equal(wirePlayer(arena, owner.id).waveBlinkReady, null);
  space();
  assert.equal(owner.lastWaveBlink, null); assert.ok(!wave.blinkUsed);
  assert.equal(owner.cells.length, 2); assert.equal(owner.cells[0].id, 'replacement-core');
});

test('a protected miss remains eligible and an occupied or off-map front receives a legal non-destructive arrival', () => {
  for (const wall of [false, true]) {
    const { arena, owner, player, fire, space } = fixture(), source = owner.cells[0];
    let protectedTarget;
    if (wall) { source.x = owner.x = ARENA.width - 200; }
    else { protectedTarget = player('protected-target', 4078); protectedTarget.invulnerable = 100; }
    const wave = fire(); if (wall) advance(arena, .3);
    assert.equal(wave.hit.size, 0); const front = { x: wave.x, y: wave.y }, event = space();
    assert.ok(event); near(source.mass, 36); near(source.vx, 0); near(source.vy, 0);
    assert.ok(source.x >= source.radius && source.x <= ARENA.width - source.radius);
    assert.ok(source.y >= source.radius && source.y <= ARENA.height - source.radius);
    if (protectedTarget) {
      const body = protectedTarget.cells[0]; near(protectedTarget.mass, 36);
      assert.ok(Math.hypot(source.x - body.x, source.y - body.y) >= source.radius + body.radius - 1e-6);
      assert.equal(protectedTarget.lastImpact, null); assert.equal(protectedTarget.lastWaveHit, null);
      assert.ok(Math.hypot(source.x - front.x, source.y - front.y) > 1, 'an occupied exact centre must use a safe offset');
    }
  }
});

test('a fully obstructed arrival preserves the unused wave and falls back to a normal split', () => {
  const { arena, owner, player, fire, space } = fixture(96);
  owner.stats.blastRange = 1.72;
  const wave = fire(); advance(arena, 1);
  // This legal large planet covers the front and its nearby possible landing
  // positions while remaining separated from the original source position.
  const obstacle = player('large-protected-obstacle', wave.x, wave.y, 10000);
  obstacle.invulnerable = 100;
  assert.ok(Math.hypot(owner.cells[0].x - obstacle.x, owner.cells[0].y - obstacle.y) > owner.cells[0].radius + obstacle.radius);
  space();
  assert.equal(owner.lastWaveBlink, null); assert.ok(!wave.blinkUsed); assert.ok(arena.blasts.includes(wave));
  assert.equal(owner.cells.length, 2); near(owner.cells.reduce((mass, cell) => mass + cell.mass, 0), 96);
  near(obstacle.mass, 10000); assert.equal(obstacle.lastImpact, null);
});

test('blinking a fusing source detaches both links while preserving every other core position and velocity', () => {
  const { arena, owner, fire, space } = fixture(), source = owner.cells[0]; source.vx = 40; source.vy = -20;
  const wave = fire();
  const donor = { ...source, id: 'unmoved-donor', mass: 12, radius: 4 * Math.sqrt(12),
    x: source.x - source.radius - 4 * Math.sqrt(12), vx: -10, vy: 30 };
  owner.cells.push(donor); advanceSiblingFusion(owner.cells, 0);
  const before = { ...donor }, velocity = { vx: source.vx, vy: source.vy }, total = source.mass + donor.mass;
  assert.ok(source.fusionId); const event = space();
  assert.ok(event); assert.equal(event.sourceCellId, source.id); assert.equal(event.waveId, wave.id);
  assert.equal(source.fusionId, null); assert.equal(donor.fusionId, null);
  near(source.vx, velocity.vx); near(source.vy, velocity.vy);
  near(donor.x, before.x); near(donor.y, before.y); near(donor.vx, before.vx); near(donor.vy, before.vy);
  near(source.mass + donor.mass, total); assert.ok(!donor.lastWaveBlinkId);
});

test('teleportation does not sweep the old source-to-front segment through intervening planets or meteors', () => {
  const { arena, owner, player, fire, space } = fixture(), source = owner.cells[0];
  const obstacle = player('protected-obstacle', 4120); obstacle.invulnerable = 100;
  const wave = fire(); advance(arena, .3); assert.equal(wave.hit.size, 0);
  const front = wave.x, meteor = { id: 'between-old-and-new', x: 4160, y: 4000, vx: 200, vy: 0,
    radius: 4, mass: 4, tailLength: 50, color: '#ffe787', bornAt: arena.time };
  arena.meteors = [meteor];
  const event = space(.1); assert.ok(event); near(event.x, front);
  near(source.x, front); near(source.mass, 36); near(obstacle.x, 4120); near(obstacle.mass, 36);
  assert.equal(owner.lastImpact, null); assert.equal(obstacle.lastImpact, null);
  assert.equal(owner.lastMeteorHit, null); assert.equal(obstacle.lastMeteorHit, null);
  assert.ok(arena.meteors.includes(meteor), 'only real post-arrival motion may collide with a meteor');
});

test('a real unfinished Dyson cooldown does not impose a second cost or cooldown on a fresh unhit wave blink', () => {
  const { arena, owner, player, fire, space } = fixture(), target = player('target', 4078);
  fire();
  for (let i = 0; i < 30 && !owner.dysonReady; i++) stepArena(arena, 1 / 120);
  space(); assert.ok(owner.dyson);
  advance(arena, 2.4); assert.equal(owner.dyson, null); assert.ok(owner.dysonCooldown > 0);
  Object.assign(target.cells[0], { x: 9000, y: 7000, vx: 0, vy: 0 });
  const wave = fire(), energy = owner.energy, cooldown = owner.cooldown, dysonCooldown = owner.dysonCooldown;
  const event = space();
  assert.ok(event); assert.equal(event.waveId, wave.id); near(owner.energy, energy);
  near(owner.cooldown, cooldown); near(owner.dysonCooldown, dysonCooldown);
});

test('snapshots copy authoritative blink eligibility and the persistent event, and a new round clears the old launch and blink', () => {
  const { arena, owner, fire, space } = fixture(), wave = fire(); advance(arena, .15);
  const readyWire = wirePlayer(arena, owner.id).waveBlinkReady;
  assert.ok(readyWire); assert.equal(readyWire.waveId, wave.id); assert.equal(readyWire.sourceCellId, owner.cells[0].id);
  near(readyWire.x, wave.x); near(readyWire.y, wave.y);
  near(readyWire.expiresAt, arena.time + (wave.distance - wave.travel) / wave.speed);
  readyWire.x = -999; near(wirePlayer(arena, owner.id).waveBlinkReady.x, wave.x);
  const event = space(), snapshot = snapshotArena(arena), wire = snapshot.players.find(player => player.id === owner.id);
  assert.deepEqual(wire.lastWaveBlink, event); assert.equal(wire.waveBlinkRevision, owner.waveBlinkRevision);
  assert.equal(wire.waveBlinkReady, null); assert.equal(wire.cells[0].lastWaveBlinkId, event.id);
  assert.ok(!snapshot.blasts.some(blast => blast.id === wave.id));
  wire.lastWaveBlink.x = -999; near(owner.lastWaveBlink.x, event.x);
  startRound(arena); const fresh = wirePlayer(arena, owner.id);
  assert.equal(fresh.waveBlinkReady, null); assert.equal(fresh.lastWaveBlink, null);
  assert.equal(fresh.waveBlinkRevision, 0); assert.ok(fresh.cells.every(cell => !cell.lastWaveBlinkId));
  space(); assert.equal(owner.lastWaveBlink, null);
});

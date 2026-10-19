import test from 'node:test';
import assert from 'node:assert/strict';
import { ARENA, DUST_COUNT, METEOR, addPlayer, advanceMeteors, createArena, snapshotArena,
  startRound, stepArena } from '../shared/engine.js';

const near = (actual, expected, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `${actual} should equal ${expected} within ${tolerance}`);
function seeded(seed = 918273) {
  return () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
}
function fixture(withPlayer = false) {
  const arena = createArena({ endless: true, random: seeded() });
  const player = withPlayer ? addPlayer(arena, { id: 'planet' }) : null;
  startRound(arena);
  return { arena, player };
}
function probe(arena, fields) {
  const meteor = { ...arena.meteors[0], id: 'trajectory-probe', ...fields };
  arena.meteors[0] = meteor;
  return meteor;
}
function place(player, x, y, mass = 36) {
  Object.assign(player, { x, y, mass, radius: 4 * Math.sqrt(mass), energy: 10, score: 0, invulnerable: 0 });
  Object.assign(player.cells[0], { x, y, mass, radius: player.radius, vx: 0, vy: 0 });
}
function isolateDust(arena) {
  arena.dust = Array.from({ length: DUST_COUNT }, (_, i) => ({ id: `far-dust-${i}`,
    x: 6000, y: 4000, value: 1, vx: 0, vy: 0 }));
}
const free = arena => arena.dust.filter(dust => dust.fragment);
const ownedFragments = (arena, player) => free(arena).filter(dust => dust.ownerId === player.id);
const neutralFragments = arena => free(arena).filter(dust => dust.ownerId == null);
const planetMass = arena => [...arena.players.values()].reduce((mass, player) => mass + player.mass, 0);

test('a round creates a real bounded meteor population with fast nonzero velocities and safe nearby traffic', () => {
  const arena = createArena({ endless: true, random: seeded() });
  assert.deepEqual(arena.meteors, []);
  const humans = [addPlayer(arena, { id: 'one' }), addPlayer(arena, { id: 'two' })];
  startRound(arena);
  assert.equal(arena.meteors.length, METEOR.count); assert.ok(METEOR.count >= 50 && METEOR.count <= 80);
  assert.equal(new Set(arena.meteors.map(meteor => meteor.id)).size, METEOR.count);
  assert.equal(arena.dust.length, DUST_COUNT);
  for (const meteor of arena.meteors) {
    const speed = Math.hypot(meteor.vx, meteor.vy);
    assert.ok(speed >= 450 - 1e-7 && speed <= 750 + 1e-7);
    assert.ok(meteor.radius >= 3 && meteor.radius <= 5);
    assert.ok(meteor.x >= 0 && meteor.x <= ARENA.width && meteor.y >= 0 && meteor.y <= ARENA.height);
    assert.ok(meteor.tailLength >= METEOR.minTail && meteor.tailLength <= METEOR.maxTail);
    assert.ok(Number.isFinite(meteor.bornAt) && meteor.bornAt <= 0,
      'initial background routes may already be in flight when the round begins');
    for (const player of humans) for (const cell of player.cells) assert.ok(
      Math.hypot(meteor.x - cell.x, meteor.y - cell.y) >= cell.radius + 80 - 1e-6,
      'nearby traffic must not be born inside a planet or its launch clearance');
  }
  for (const player of humans) assert.ok(arena.meteors.filter(meteor => {
    const distance = Math.hypot(meteor.x - player.x, meteor.y - player.y);
    return distance <= METEOR.nearRadius;
  }).length >= 3, 'a player must have actual nearby world traffic at the start');
});

test('meteor world positions follow constant straight velocity even inside a strong planet gravity field', () => {
  const { arena, player } = fixture(true);
  Object.assign(player.cells[0], { x: 2000, y: 2000, mass: 10000, radius: 400, vx: 0, vy: 0 });
  Object.assign(player, { x: 2000, y: 2000, mass: 10000, radius: 400, invulnerable: 0 });
  player.stats.magnet = 100;
  const meteor = probe(arena, { x: 2500, y: 2000, vx: 0, vy: 600 });
  const id = meteor.id;
  let elapsed = 0;
  for (const dt of [.1, 1 / 60, .033, .08]) {
    arena.meteors = [meteor];
    stepArena(arena, dt); elapsed += dt;
    const retained = arena.meteors.find(item => item.id === id);
    assert.ok(retained, 'the measured flight stays outside the body and inside the arena');
    near(retained.x, 2500); near(retained.y, 2000 + 600 * elapsed);
    near(retained.vx, 0); near(retained.vy, 600);
  }
  near(player.x, 2000); near(player.y, 2000);
});

test('a departing meteor despawns instead of bouncing or teleporting under its old id', () => {
  const { arena } = fixture();
  const departing = probe(arena, { x: ARENA.width - 5, y: 2000, vx: 600, vy: 0 });
  const beforeIds = new Set(arena.meteors.map(meteor => meteor.id));
  stepArena(arena, .1);
  assert.ok(!arena.meteors.some(meteor => meteor.id === departing.id));
  assert.equal(arena.meteors.length, METEOR.count);
  const replacements = arena.meteors.filter(meteor => !beforeIds.has(meteor.id));
  assert.ok(replacements.length >= 1); assert.ok(replacements.every(meteor => meteor.bornAt >= .1 - 1e-9));
  near(departing.vx, 600); near(departing.vy, 0);
});

test('endless simulation retains a bounded population and fresh ids through sustained traffic beyond three minutes', () => {
  const { arena } = fixture(), seen = new Set(arena.meteors.map(meteor => meteor.id));
  const initialRound = arena.round;
  for (let tick = 0; tick < 3000; tick++) {
    const previous = new Map(arena.meteors.map(meteor => [meteor.id, { ...meteor }]));
    stepArena(arena, .1);
    assert.equal(arena.meteors.length, METEOR.count);
    assert.equal(new Set(arena.meteors.map(meteor => meteor.id)).size, METEOR.count);
    for (const meteor of arena.meteors) {
      const old = previous.get(meteor.id);
      if (old) {
        near(meteor.x, old.x + old.vx * .1); near(meteor.y, old.y + old.vy * .1);
        near(meteor.vx, old.vx); near(meteor.vy, old.vy);
      } else {
        assert.ok(!seen.has(meteor.id), 'a replacement must not reuse an expired track id'); seen.add(meteor.id);
      }
      assert.ok(meteor.x >= 0 && meteor.x <= ARENA.width && meteor.y >= 0 && meteor.y <= ARENA.height);
    }
  }
  assert.ok(arena.time > 299); assert.equal(arena.status, 'playing'); assert.equal(arena.remaining, null);
  assert.equal(arena.round, initialRound); assert.equal(arena.dust.length, DUST_COUNT);
  assert.ok(seen.size > 500, 'the bounded population must keep turning over rather than freezing in a permanent starfield');
});

test('viewport snapshots include incoming trajectories and tails while omitting distant meteors and private simulation fields', () => {
  const { arena } = fixture(), sample = arena.meteors[0];
  arena.meteors = [
    { ...sample, id: 'inside', x: 1000, y: 1000, vx: 600, vy: 0, tailLength: 40, _privateProbe: 'secret' },
    { ...sample, id: 'approaching', x: 1200, y: 1000, vx: -600, vy: 0, tailLength: 40 },
    { ...sample, id: 'far', x: 9000, y: 7000, vx: -600, vy: 0, tailLength: 40 },
  ];
  const wire = snapshotArena(arena, { x: 1000, y: 1000, width: 100, height: 100, margin: 0 });
  assert.equal(wire.meteorTotal, 3); assert.deepEqual(wire.meteor, METEOR);
  assert.deepEqual(wire.meteors.map(meteor => meteor.id).sort(), ['approaching', 'inside']);
  for (const meteor of wire.meteors) {
    for (const field of ['x', 'y', 'vx', 'vy', 'radius', 'tailLength', 'bornAt']) assert.ok(Number.isFinite(meteor[field]));
    assert.ok(!Object.keys(meteor).some(field => field.startsWith('_')));
    assert.equal(typeof meteor.color, 'string');
  }
  wire.meteors[0].x = -1;
  assert.ok(arena.meteors.every(meteor => meteor.x >= 0), 'mutating a snapshot must not mutate authoritative meteor positions');
});

test('starting a new round replaces meteor ids, and the isolated motion helper follows the same ballistic rule', () => {
  const { arena } = fixture(), previous = new Set(arena.meteors.map(meteor => meteor.id));
  stepArena(arena, .1); startRound(arena);
  assert.equal(arena.meteors.length, METEOR.count); assert.ok(arena.meteors.every(meteor => !previous.has(meteor.id)));
  assert.ok(arena.meteors.every(meteor => Number.isFinite(meteor.bornAt) && meteor.bornAt <= 0));
  const meteor = probe(arena, { x: 2000, y: 2000, vx: 360, vy: 480 });
  advanceMeteors(arena, .1);
  near(meteor.x, 2036); near(meteor.y, 2048); near(Math.hypot(meteor.vx, meteor.vy), 600);
});

test('a fast meteor crossing a planet between 100ms endpoints hits once, knocks it and sheds mass without granting rewards', () => {
  const { arena, player } = fixture(true); place(player, 2000, 2000); isolateDust(arena);
  const meteor = probe(arena, { x: 1960, y: 2000, vx: 750, vy: 0, radius: 3 });
  arena.meteors = [meteor];
  assert.ok(40 > 24 + 3 && Math.abs(1960 + 750 * .1 - 2000) > 24 + 3,
    'both meteor endpoints miss the planet; a swept impact is required');
  stepArena(arena, .1);
  assert.ok(!arena.meteors.some(item => item.id === meteor.id));
  const event = player.lastMeteorHit;
  assert.ok(event); assert.equal(event.meteorId, meteor.id); assert.equal(event.cellId, player.cells[0].id);
  near(event.at, 13 / 750, .00001); near(event.x, 1976, .02); near(event.y, 2000, .02);
  near(event.impulse, 90); near(player.vx, 90); near(player.vy, 0);
  near(player.mass, 36 * .88); near(event.lostMass, 36 * .12);
  const planetary = ownedFragments(arena, player), neutral = neutralFragments(arena);
  assert.equal(planetary.length, 3); planetary.forEach(piece => near(piece.value, 36 * .12 / 3));
  assert.equal(neutral.length, 3); neutral.forEach(piece => near(piece.value, 4 / 3));
  near(planetMass(arena) + free(arena).reduce((mass, piece) => mass + piece.value, 0), 36 + 4);
  const px = player.mass * player.vx + free(arena).reduce((p, piece) => p + piece.value * piece.vx, 0);
  const py = player.mass * player.vy + free(arena).reduce((p, piece) => p + piece.value * piece.vy, 0);
  near(px, 4 * 750); near(py, 0);
  assert.equal(player.score, 0); near(player.energy, 10.3);
  assert.equal(player.kills, 0); assert.equal(player.respawnIn, 0);
  const revision = player.collisionRevision;
  arena.meteors = [];
  advanceMeteors(arena, .1, { refill: false });
  assert.equal(player.collisionRevision, revision); assert.equal(player.lastMeteorHit, event);
  for (const field of ['hp', 'maxHp', 'damage', 'hpAfter', 'killed']) assert.ok(!(field in event));
});

test('oblique impacts conserve both axes of post-impulse momentum and retain at least one mass in tiny cores', () => {
  for (const mass of [1, 1.01, 36, 3600]) {
    const { arena, player } = fixture(true); place(player, 2000, 2000, mass); isolateDust(arena);
    const radius = player.radius, dx = .6, dy = .8, distance = radius + 3 + 10;
    const meteor = probe(arena, { x: 2000 - dx * distance, y: 2000 - dy * distance,
      vx: dx * 600, vy: dy * 600, radius: 3 });
    arena.meteors = [meteor];
    advanceMeteors(arena, .1, { refill: false });
    const event = player.lastMeteorHit;
    assert.ok(event); assert.ok(player.mass >= 1);
    const lost = Math.min(mass * .12, Math.max(0, mass - 1)); near(event.lostMass, lost); near(player.mass, mass - lost);
    const pieces = ownedFragments(arena, player);
    assert.equal(pieces.length, lost ? 3 : 0); pieces.forEach(piece => near(piece.value, lost / 3));
    assert.equal(neutralFragments(arena).length, 3);
    near(neutralFragments(arena).reduce((sum, piece) => sum + piece.value, 0), 4);
    near(planetMass(arena) + free(arena).reduce((sum, piece) => sum + piece.value, 0), mass + 4);
    assert.ok(event.impulse > 0 && event.impulse <= 240);
    near(player.vx, event.impulse * dx); near(player.vy, event.impulse * dy);
    near(player.mass * player.vx + free(arena).reduce((sum, piece) => sum + piece.value * piece.vx, 0), 4 * 600 * dx);
    near(player.mass * player.vy + free(arena).reduce((sum, piece) => sum + piece.value * piece.vy, 0), 4 * 600 * dy);
  }
});

test('one meteor chooses the earliest planet surface regardless of player insertion order', () => {
  for (const reversed of [false, true]) {
    const { arena } = fixture();
    const ids = reversed ? ['later', 'earlier'] : ['earlier', 'later'];
    for (const id of ids) {
      const player = addPlayer(arena, { id }); place(player, id === 'earlier' ? 2000 : 2065, 2000, id === 'earlier' ? 36 : 100);
    }
    isolateDust(arena);
    const meteor = probe(arena, { x: 1960, y: 2000, vx: 750, vy: 0, radius: 3 }); arena.meteors = [meteor];
    advanceMeteors(arena, .1, { refill: false });
    assert.equal(arena.meteors.length, 0);
    assert.equal(arena.players.get('earlier').lastMeteorHit?.meteorId, meteor.id);
    assert.equal(arena.players.get('later').lastMeteorHit, null); near(arena.players.get('later').mass, 100);
    near(planetMass(arena) + free(arena).reduce((sum, piece) => sum + piece.value, 0), 136 + 4);
  }
});

test('simultaneous player and cell contacts have a stable id tie-break and cannot duplicate the meteor impact', () => {
  for (const reversed of [false, true]) {
    const { arena } = fixture();
    for (const id of reversed ? ['z-player', 'a-player'] : ['a-player', 'z-player']) {
      const player = addPlayer(arena, { id }); place(player, 2000, 2000);
      player.cells[0].id = 'z-cell';
      if (id === 'a-player') player.cells.push({ ...player.cells[0], id: 'a-cell' });
    }
    isolateDust(arena);
    const meteor = probe(arena, { x: 1960, y: 2000, vx: 750, vy: 0, radius: 3 }); arena.meteors = [meteor];
    advanceMeteors(arena, .1, { refill: false });
    const chosen = arena.players.get('a-player');
    assert.equal(chosen.lastMeteorHit?.cellId, 'a-cell');
    assert.equal(arena.players.get('z-player').lastMeteorHit, null);
    near(chosen.cells.find(cell => cell.id === 'a-cell').mass, 36 * .88);
    near(chosen.cells.find(cell => cell.id === 'z-cell').mass, 36);
    assert.equal(free(arena).length, 6); assert.equal(neutralFragments(arena).length, 3); assert.equal(arena.meteors.length, 0);
  }
});

test('the shattered meteor creates warm neutral absorbable mass without inflating the natural-dust budget or pickup rewards', () => {
  const { arena, player } = fixture(true); place(player, 2000, 2000); isolateDust(arena);
  player.stats.growth = 1.8;
  const meteor = probe(arena, { x: 1960, y: 2000, vx: 750, vy: 0, radius: 3 }); arena.meteors = [meteor];
  advanceMeteors(arena, .1, { refill: false });
  const pieces = neutralFragments(arena);
  assert.equal(pieces.length, 3); near(pieces.reduce((sum, piece) => sum + piece.value, 0), 4);
  for (const piece of pieces) {
    assert.equal(piece.fragment, true); assert.ok(piece.color);
    assert.ok(piece.collectAfter > arena.time, 'the meteor must shatter visibly before its fragments can be absorbed');
  }
  assert.equal(arena.dust.filter(dust => !dust.fragment).length, DUST_COUNT);
  const beforeMass = player.mass, beforeEnergy = player.energy;
  // Put just the neutral debris in the pickup path after its grace; the
  // planet's own debris remains a separately tested conservation account.
  const natural = arena.dust.filter(dust => !dust.fragment);
  for (const piece of pieces) Object.assign(piece, { x: player.x, y: player.y, vx: 0, vy: 0 });
  arena.dust = [...natural, ...pieces];
  arena.time = Math.max(...pieces.map(piece => piece.collectAfter)) + 1e-6;
  stepArena(arena, 0);
  near(player.mass, beforeMass + 4); near(player.energy, beforeEnergy); assert.equal(player.score, 0);
  assert.equal(free(arena).length, 0);
  assert.equal(arena.dust.filter(dust => !dust.fragment).length, DUST_COUNT);
});

test('spawn protection prevents planetary damage and impulse but the meteor still becomes absorbable neutral debris', () => {
  const { arena, player } = fixture(true); place(player, 2000, 2000); isolateDust(arena);
  player.invulnerable = 10;
  const meteor = probe(arena, { x: 1960, y: 2000, vx: 750, vy: 0, radius: 3 }); arena.meteors = [meteor];
  advanceMeteors(arena, .1, { refill: false });
  assert.equal(arena.meteors.length, 0); near(player.mass, 36); near(player.vx, 0); near(player.vy, 0);
  assert.equal(ownedFragments(arena, player).length, 0); assert.equal(neutralFragments(arena).length, 3);
  near(neutralFragments(arena).reduce((sum, piece) => sum + piece.value, 0), 4);
  assert.equal(player.score, 0); near(player.energy, 10);
});

test('meteor contact after the map-exit time is ignored even when the full 100ms trajectory crosses a legal wall-side planet', () => {
  const { arena, player } = fixture(true); place(player, ARENA.width - 24, 2000); isolateDust(arena);
  const meteor = probe(arena, { x: ARENA.width - 1, y: 1960, vx: 50, vy: 600, radius: 3 }); arena.meteors = [meteor];
  advanceMeteors(arena, .1, { refill: false });
  assert.equal(arena.meteors.length, 0); assert.equal(player.lastMeteorHit, null);
  near(player.mass, 36); near(player.vx, 0); near(player.vy, 0); assert.equal(free(arena).length, 0);
});

test('relative swept contact catches a moving planet and meteor whose endpoints both miss', () => {
  const { arena, player } = fixture(true); place(player, 1960, 2000); isolateDust(arena);
  const initialVx = 80 / (1 - Math.exp(-.1));
  player.cells[0].vx = initialVx;
  const meteor = probe(arena, { x: 2000, y: 1970, vx: 0, vy: 600, radius: 3 }); arena.meteors = [meteor];
  const finalFreeX = 1960 + initialVx * (1 - Math.exp(-.2)) / 2;
  assert.ok(Math.hypot(40, 30) > 27 && Math.hypot(finalFreeX - 2000, 30) > 27);
  stepArena(arena, .1);
  assert.equal(player.lastMeteorHit?.meteorId, meteor.id); assert.ok(!arena.meteors.some(item => item.id === meteor.id));
  near(player.mass, 36 * .88); assert.equal(free(arena).length, 6);
  near(planetMass(arena) + free(arena).reduce((sum, piece) => sum + piece.value, 0), 40);
  near(player.mass * player.vx + free(arena).reduce((sum, piece) => sum + piece.value * piece.vx, 0),
    36 * initialVx * Math.exp(-.2), 1e-5);
  near(player.mass * player.vy + free(arena).reduce((sum, piece) => sum + piece.value * piece.vy, 0), 4 * 600, 1e-5);
});

test('meteor impact feedback is copied safely, persists after despawn and resets with per-cell ids in a new round', () => {
  const { arena, player } = fixture(true); place(player, 2000, 2000); isolateDust(arena);
  assert.equal(snapshotArena(arena).players.find(item => item.id === player.id).lastMeteorHit, null);
  const meteor = probe(arena, { x: 1960, y: 2000, vx: 750, vy: 0, radius: 3 }); arena.meteors = [meteor];
  advanceMeteors(arena, .1, { refill: false });
  const event = player.lastMeteorHit;
  assert.ok(event.id); assert.equal(player.cells[0].lastMeteorHitId, event.id);
  const wire = snapshotArena(arena).players.find(item => item.id === player.id);
  assert.deepEqual(wire.lastMeteorHit, event); assert.equal(wire.cells[0].lastMeteorHitId, event.id);
  wire.lastMeteorHit.x = -1; assert.ok(event.x > 0);
  assert.ok(!Object.keys(wire.lastMeteorHit).some(field => field.startsWith('_')));
  arena.meteors = []; advanceMeteors(arena, .1, { refill: false }); assert.equal(player.lastMeteorHit, event);
  startRound(arena);
  assert.equal(player.lastMeteorHit, null); assert.ok(player.cells.every(cell => cell.lastMeteorHitId === null));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createArena, addPlayer, stepArena, setPlayerInput, snapshotArena, movementSpeed } from '../shared/engine.js';

// Exercise the shipped client's prediction with a deterministic clock and the
// real simulation. No DOM or Canvas is needed for this movement regression.
const source = await readFile(new URL('../public/game.js', import.meta.url), 'utf8');
function client() {
  let clock = 0;
  const sent = [];
  const context = vm.createContext({ innerWidth: 1800, innerHeight: 1100,
    window: {}, performance: { now: () => clock }, WebSocket: { OPEN: 1 } });
  const hooks = `
    window.predictionTest = {
      start(state, ping = null) {
        active = true; myId = 'pilot'; rtt = ping;
        socket = { readyState: 1, send: data => window.onSend(JSON.parse(data)) };
        ingestSnapshot(state, performance.now()); room = state;
      },
      press(code) { keys.clear(); if (code) keys.add(code); sendInput(); },
      heartbeat: sendInput,
      packet(state) { ingestSnapshot(state, performance.now()); room = state; },
      frame(dt) { predictOwn(dt, performance.now()); },
      position: getOwnCenter,
      bodies() {
        return room.players.flatMap(player => player.cells.map(cell => {
          const position = player.id === myId ? predictedCells.get(cell.id) : remoteContactPositions.get(player.id + ':' + cell.id) || cell;
          return { id: player.id, x: position.x, y: position.y, radius: cell.radius };
        }));
      },
      ack() { return lastInputAck; },
      remote(key) { return remotePhysics.get(key); },
      trackTime(key) { return cellTracks.get(key)?.at(-1)?.t; },
      velocity() { const model = predictedCells.values().next().value?.model; return { x: model?.vx, y: model?.vy }; },
      ownCell(id) { return predictedCells.get(id); },
      effective(playerId, cellId) {
        const player = room.players.find(player => player.id === playerId);
        return effectiveCell(player, player.cells.find(cell => cell.id === cellId), performance.now());
      },
      models() { return physicsBodies().map(body => ({ ...body.position, id: body.player.id })); },
      intent: getIntent,
      split,
      wave(blast) { return wavePose(blast, performance.now()); },
      lead() { return simulationLead; },
      cacheWaves(state) { cacheWaveVisuals(state, room); },
    };
  `;
  context.window.onSend = message => sent.push(message);
  const instrumented = source.replace('  window.StarGame = {', `${hooks}\n  window.StarGame = {`);
  assert.notEqual(instrumented, source, 'client prediction test hook must attach to the shipped script');
  vm.runInContext(instrumented, context, { filename: 'public/game.js' });
  return { api: context.window.predictionTest, sent, time: value => { clock = value; } };
}

test('delayed acknowledgements preserve inertial braking, coasting and eventual rest', () => {
  const arena = createArena({ random: () => 0.99 }); arena.status = 'playing';
  const player = addPlayer(arena, { id: 'pilot' });
  Object.assign(player, { x: 1000, y: 1000 });
  Object.assign(player.cells[0], { x: 1000, y: 1000 });
  // Keep growth and collisions out of this network-only fixture.
  arena.dust = Array.from({ length: 6000 }, (_, id) => ({ id: `far-${id}`, x: 11000, y: 7000, value: 1, vx: 0, vy: 0 }));
  const snapshot = time => ({ code: 'CLIENT', serverTime: time, ...snapshotArena(arena) });
  const c = client(); c.api.start(snapshot(0));
  const packets = [], samples = [];
  let lastDelivery = 0, previousSent = 0, stopSeq;
  c.api.press('ArrowRight');
  // Sixty render frames / thirty physics ticks / fifteen snapshots per second.
  // Incoming delay jumps from 16 ms to 450 ms while the RTT estimate stays low.
  for (let frame = 1; frame <= 420; frame++) {
    const time = frame * 1000 / 60; c.time(time);
    if (frame === 72) c.api.press('ArrowLeft');
    if (frame === 120) { c.api.press(null); stopSeq = c.sent.at(-1).seq; }
    if (frame % 3 === 0) c.api.heartbeat();
    for (const input of c.sent.slice(previousSent)) setPlayerInput(arena, player.id, input);
    previousSent = c.sent.length;
    if (frame % 2 === 0) stepArena(arena, 1 / 30);
    if (frame % 4 === 0) {
      const delay = frame < 24 ? 16 : 450;
      lastDelivery = Math.max(lastDelivery + 1, time + delay);
      packets.push({ delivery: lastDelivery, state: snapshot(time) });
    }
    while (packets[0]?.delivery <= time) c.api.packet(packets.shift().state);
    c.api.frame(1 / 60);
    const position = c.api.position();
    samples.push({ frame, x: position.x, y: position.y, ack: c.api.ack() });
  }
  for (let i = 1; i < samples.length; i++) {
    const row = samples[i], previous = samples[i - 1];
    if (row.frame < 72) assert.ok(row.x > previous.x, 'held right must keep moving right during the latency spike');
    if (row.frame >= 84 && row.frame < 120) assert.ok(row.x < previous.x, 'after physical braking, held left must not be reversed by delayed packets');
    assert.equal(row.y, 1000, 'horizontal controls must not cause sideways drift');
  }
  const reverse = samples.filter(row => row.frame >= 72 && row.frame < 120);
  assert.ok(reverse[1].x > reverse[0].x, 'reversing thrust must first brake existing momentum');
  assert.ok(reverse[0].x - reverse.at(-1).x > 80, 'network reconciliation cannot stall a held direction');
  const coast = samples.filter(row => row.frame >= 120 && row.frame <= 150);
  assert.ok(coast[0].x - coast.at(-1).x > 40, 'releasing thrust must retain visible coasting');
  const earlyTravel = coast[0].x - coast[6].x, laterTravel = coast[24].x - coast[30].x;
  assert.ok(earlyTravel > laterTravel && laterTravel > 0, 'coasting should gradually slow down');
  const stopped = samples.filter(row => row.ack >= stopSeq && row.frame >= 360);
  assert.ok(stopped.length >= 30, 'the stopped state must be observed for at least half a second');
  assert.ok(Math.max(...stopped.map(row => row.x)) - Math.min(...stopped.map(row => row.x)) < 0.001,
    'repeated acknowledgements after stopping must not create ongoing motion');
  assert.ok(Math.abs(stopped.at(-1).x - player.x) < 0.01, 'stopped prediction must match the authoritative position');
});

test('finishing a gradual merge preserves the surviving prediction while a genuine relocation still aligns', () => {
  const arena = createArena(); arena.status = 'playing';
  const player = addPlayer(arena, { id: 'pilot' });
  const core = player.cells[0];
  Object.assign(core, { x: 1000, y: 1000, mass: 71.9, radius: 4 * Math.sqrt(71.9) });
  player.cells.push({ ...core, id: 'other', x: 1050, mass: .1, radius: 4 * Math.sqrt(.1) });
  Object.assign(player, { x: (1000 * 71.9 + 1050 * .1) / 72, y: 1000, mass: 72, radius: core.radius });
  const c = client(); c.api.start(snapshotArena(arena)); c.api.press('ArrowRight');
  const prediction = c.api.ownCell(core.id), model = prediction.model, previousX = prediction.x;
  // The donor's final small remainder is absorbed at its centre of mass.
  player.cells.splice(1); Object.assign(core, { x: (1000 * 71.9 + 1050 * .1) / 72, mass: 72, radius: 4 * Math.sqrt(72) });
  c.time(50); c.api.packet(snapshotArena(arena));
  assert.equal(c.api.ownCell(core.id), prediction, 'removing the donor must retain the surviving prediction');
  assert.equal(prediction.model, model, 'the surviving physical model is not rebuilt at merge completion');
  assert.equal(prediction.x, previousX, 'merge completion must not teleport the displayed surviving core');
  assert.equal(c.api.ownCell('other'), undefined);
  // A respawn/restore can relocate an existing identifier far off the held axis.
  player.cells[0].y = 1600;
  c.time(100); c.api.packet(snapshotArena(arena));
  assert.equal(c.api.position().y, 1600, 'a genuine relocation must not leave a persistent lateral offset');
  c.time(100 + 1000 / 60); c.api.frame(1 / 60);
  assert.ok(c.api.position().x > previousX);
  assert.equal(c.api.position().y, 1600);
});

test('client prediction keeps touching bodies solid while thrust and server corrections continue', () => {
  const arena = createArena({ random: () => 0.99 }); arena.status = 'playing';
  const pilot = addPlayer(arena, { id: 'pilot' }), other = addPlayer(arena, { id: 'other' });
  Object.assign(pilot.cells[0], { x: 1000, y: 1000 });
  Object.assign(other.cells[0], { x: 1080, y: 1000 });
  arena.dust = Array.from({ length: 6000 }, (_, id) => ({ id: `far-${id}`, x: 11000, y: 7000, value: 1, vx: 0, vy: 0 }));
  const snapshot = time => ({ code: 'SOLID', serverTime: time, ...snapshotArena(arena) });
  const c = client(); c.api.start(snapshot(0)); c.api.press('ArrowRight');
  let sent = 0;
  let minDistance = Infinity;
  for (let frame = 1; frame <= 120; frame++) {
    const time = frame * 1000 / 60; c.time(time);
    if (frame % 3 === 0) c.api.heartbeat();
    for (const input of c.sent.slice(sent)) setPlayerInput(arena, pilot.id, input);
    sent = c.sent.length;
    if (frame % 2 === 0) stepArena(arena, 1 / 30);
    if (frame % 4 === 0) c.api.packet(snapshot(time));
    c.api.frame(1 / 60);
    const [a, b] = c.api.bodies();
    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    minDistance = Math.min(minDistance, distance);
    assert.ok(distance >= a.radius + b.radius - 0.03, 'server blocking must also block the visible prediction');
    assert.ok(a.x < b.x, 'bodies must not pass through each other');
  }
  assert.ok(minDistance < 48.1, 'the fixture must actually reach contact');
});

test('a high speed predicted path cannot jump through a nearby solid body', () => {
  const arena = createArena(); arena.status = 'playing';
  const pilot = addPlayer(arena, { id: 'pilot' }), other = addPlayer(arena, { id: 'other' });
  Object.assign(pilot.cells[0], { x: 1000, y: 1000, vx: 2400 });
  Object.assign(other.cells[0], { x: 1060, y: 1000 });
  const c = client(); c.api.start({ serverTime: 0, ...snapshotArena(arena) });
  c.time(50); c.api.frame(0.05);
  const [a, b] = c.api.bodies();
  assert.ok(a.x < b.x, 'swept collision must preserve which side of the contact each body occupies');
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= a.radius + b.radius - 0.03);
});

test('ordinary collision revisions preserve the visible position and reconcile continuously', () => {
  const arena = createArena(); arena.status = 'playing';
  const pilot = addPlayer(arena, { id: 'pilot' });
  Object.assign(pilot.cells[0], { x: 1000, y: 1000 });
  const c = client(); c.api.start({ serverTime: 0, ...snapshotArena(arena) });
  const before = c.api.position();
  pilot.cells[0].x += 16; pilot.collisionRevision++;
  c.time(50); c.api.packet({ serverTime: 50, ...snapshotArena(arena) });
  assert.equal(c.api.position().x, before.x, 'a contact revision must not teleport the rendered body');
  c.time(50 + 1000 / 60); c.api.frame(1 / 60);
  const travel = c.api.position().x - before.x;
  assert.ok(travel > 0 && travel < 3, 'authority error must settle over frames instead of one packet jump');
});

test('remote contact proxies retain their simulation across snapshots and use simulation time', () => {
  const arena = createArena(); arena.status = 'playing';
  const pilot = addPlayer(arena, { id: 'pilot' }), other = addPlayer(arena, { id: 'other' });
  Object.assign(pilot.cells[0], { x: 1000, y: 1000 });
  Object.assign(other.cells[0], { x: 1060, y: 1000 });
  const c = client(); c.api.start({ serverTime: 100000, ...snapshotArena(arena) });
  const key = `other:${other.cells[0].id}`, proxy = c.api.remote(key), model = proxy.model;
  other.cells[0].x -= 5; other.cells[0].vx = -100;
  arena.time = 0.1;
  c.time(100); c.api.packet({ serverTime: 900000, ...snapshotArena(arena) });
  assert.equal(c.api.remote(key), proxy, 'a new packet must retain the contact proxy');
  assert.equal(c.api.remote(key).model, model, 'a new packet must not replace collision velocity state');
  assert.equal(model.x, 1060, 'authority updates must not reset the proxy position');
  assert.equal(c.api.trackTime(key), 100, 'interpolation uses precise simulation time, independent of wall-clock stalls');
});

test('a far merging donor stays visible on its delayed render clock after the contact model has consumed it', () => {
  const arena = createArena({ random: () => .99 }); arena.status = 'playing';
  const pilot = addPlayer(arena, { id: 'pilot' }), victim = addPlayer(arena, { id: 'victim' });
  Object.assign(pilot.cells[0], { x: 9000, y: 4000 });
  Object.assign(victim.cells[0], { x: 2000, y: 4000 });
  victim.cells.push({ ...victim.cells[0], id: 'merging-donor', x: 2048 });
  arena.dust = Array.from({ length: 6000 }, (_, id) => ({ id: `far-${id}`, x: 11000, y: 7000, value: 1, vx: 0, vy: 0 }));
  stepArena(arena, 0);
  for (let step = 0; step < 11; step++) stepArena(arena, .1);
  const donor = victim.cells.find(cell => cell.fusionRole === 'donor');
  assert.ok(donor); assert.ok(Math.abs(donor.mass - 3) < 1e-7);
  const c = client(); c.api.start(snapshotArena(arena), 360);
  const proxy = c.api.remote(`victim:${donor.id}`);
  assert.ok(proxy.model._consumed, 'the 180ms current-time lead finishes the donor before the delayed presentation');
  const visible = c.api.effective(victim.id, donor.id);
  assert.ok(visible, 'a far donor must still render on the interpolated timeline');
  assert.ok(Math.abs(visible.mass - 3) < 1e-7); assert.ok(Math.abs(visible.radius - 4 * Math.sqrt(3)) < 1e-7);
  proxy.island = true;
  assert.equal(c.api.effective(victim.id, donor.id), null, 'the same donor is consumed on the near current-time contact timeline');
});

test('a wall-pinned contact does not retain phantom momentum after constraints', () => {
  const arena = createArena(); arena.status = 'playing';
  const pilot = addPlayer(arena, { id: 'pilot' }), other = addPlayer(arena, { id: 'other' });
  Object.assign(pilot.cells[0], { x: 12000 - 24 - 48, y: 1000 });
  Object.assign(other.cells[0], { x: 12000 - 24, y: 1000 });
  const c = client(); c.api.start({ serverTime: 0, ...snapshotArena(arena) }); c.api.press('ArrowRight');
  for (let frame = 1; frame <= 30; frame++) {
    c.time(frame * 1000 / 60); c.api.frame(1 / 60);
    assert.ok(Math.abs(c.api.velocity().x) < 1e-4, 'a static wall-supported chain must have static model velocity');
  }
});

test('a real near-field wave uses its contact proxy clock and keeps that clock for its lifetime', () => {
  const arena = createArena(); arena.status = 'playing';
  const pilot = addPlayer(arena, { id: 'pilot' }), other = addPlayer(arena, { id: 'other' });
  Object.assign(pilot.cells[0], { x: 1000, y: 1000 });
  Object.assign(other.cells[0], { x: 1060, y: 1000, vx: 100 });
  const c = client(); c.api.start({ code: 'WAVECLOCK', ...snapshotArena(arena) });
  c.api.heartbeat();
  setPlayerInput(arena, pilot.id, c.sent.at(-1));
  setPlayerInput(arena, other.id, { x: 1, y: 0, fire: true });
  stepArena(arena, 1 / 30);
  const state = { code: 'WAVECLOCK', ...snapshotArena(arena) }, blast = state.blasts[0];
  assert.ok(blast, 'fixture must create an authoritative forward wave');
  c.time(150); c.api.packet(state); c.api.cacheWaves(state);
  c.time(150 + 1000 / 60); c.api.frame(1 / 60);
  const proxy = c.api.remote(`other:${other.cells[0].id}`);
  assert.ok(proxy.island, 'the attacker must be in the current-time contact island');
  const elapsed = c.api.lead() + 1 / 60, pose = c.api.wave(blast);
  assert.ok(Math.abs(pose.x - blast.originX - blast.directionX * (blast.travel + blast.speed * elapsed)) < 1e-6,
    'near-field wave and proxy authority advance on the same simulation horizon');
  proxy.island = false; proxy.islandUntil = 0;
  assert.equal(c.api.wave(blast).x, pose.x, 'leaving an island must not jump a wave back by 100 ms');
});

test('ordinary movement has no keyboard boost or boost field in the network input', () => {
  const arena = createArena(); arena.status = 'playing';
  addPlayer(arena, { id: 'pilot' });
  const c = client(); c.api.start(snapshotArena(arena));
  c.api.press('ShiftLeft');
  assert.equal(c.api.intent().x, 0); assert.equal(c.api.intent().y, 0);
  assert.equal(Object.hasOwn(c.sent.at(-1), 'boost'), false, 'retired boost must not be sent even as false');
  c.api.press('ArrowRight');
  assert.equal(c.sent.at(-1).x, 1);
  assert.equal(Object.hasOwn(c.sent.at(-1), 'boost'), false);
});

test('own and remote prediction use the server advertised mass-speed relationship', () => {
  for (const mass of [9, 36, 144]) {
    const arena = createArena({ random: () => .99 }); arena.status = 'playing';
    const pilot = addPlayer(arena, { id: 'pilot' }), other = addPlayer(arena, { id: 'other' });
    for (const [player, x] of [[pilot, 4000], [other, 5000]]) {
      const speed = movementSpeed(mass, player.stats.speed);
      Object.assign(player.cells[0], { x, y: 4000, mass, radius: 4 * Math.sqrt(mass), vx: speed, vy: 0 });
      setPlayerInput(arena, player.id, { x: 1 });
    }
    const c = client(); c.api.start(snapshotArena(arena)); c.api.press('ArrowRight');
    setPlayerInput(arena, pilot.id, c.sent.at(-1));
    for (let tick = 0; tick < 5; tick++) stepArena(arena, .1);
    c.time(500); c.api.frame(.5);
    const models = c.api.models(); assert.equal(models.length, 2);
    for (const model of models) {
      const cell = arena.players.get(model.id).cells[0];
      assert.ok(Math.abs(model.x - cell.x) < .02, `mass ${mass}: ${model.id} must share authoritative travel`);
      assert.ok(Math.abs(model.vx - cell.vx) < .02, `mass ${mass}: ${model.id} must share authoritative speed`);
    }
  }
});

test('retired Q actions emit no ejection protocol while active splitting remains available', () => {
  const arena = createArena(); arena.status = 'playing';
  const player = addPlayer(arena, { id: 'pilot' });
  Object.assign(player.cells[0], { mass: 72, radius: 4 * Math.sqrt(72), x: 4000, y: 4000 });
  const c = client(); c.api.start(snapshotArena(arena));
  c.api.press('KeyQ');
  assert.equal(c.sent.at(-1).x, 0); assert.equal(c.sent.at(-1).y, 0);
  assert.equal(Object.hasOwn(c.sent.at(-1), 'eject'), false, 'removed ejection must not remain as an inactive network field');
  c.api.split();
  assert.equal(c.sent.at(-1).split, true, 'active splitting remains a playable action');
  assert.equal(Object.hasOwn(c.sent.at(-1), 'eject'), false);
  setPlayerInput(arena, player.id, c.sent.at(-1)); stepArena(arena, 1 / 120);
  assert.equal(player.cells.length, 2);
  assert.ok(Math.abs(player.cells.reduce((sum, cell) => sum + cell.mass, 0) - 72) < 1e-6);
});

test('a swept predicted impact preserves its damped post-impact remainder like the authoritative physics', () => {
  const arena = createArena(); arena.status = 'playing';
  const a = addPlayer(arena, { id: 'pilot' }), b = addPlayer(arena, { id: 'other' });
  Object.assign(a.cells[0], { x: 4000, y: 4000, vx: 180 });
  Object.assign(b.cells[0], { x: 4050, y: 4000, vx: -180 });
  arena.dust = Array.from({ length: 6000 }, (_, id) => ({ id: `far-${id}`, x: 11000, y: 7000, value: 1, vx: 0, vy: 0 }));
  const c = client(); c.api.start(snapshotArena(arena));
  const duration = 1 / 120;
  stepArena(arena, duration); c.time(duration * 1000); c.api.frame(duration);
  for (const model of c.api.models()) {
    const cell = arena.players.get(model.id).cells[0];
    assert.ok(Math.hypot(model.x - cell.x, model.y - cell.y) < .002, 'the impact must retain the same remaining displacement as the server');
    assert.ok(Math.hypot(model.vx - cell.vx, model.vy - cell.vy) < .002);
  }
  const [first, second] = c.api.models();
  assert.ok(second.x - first.x > 48.05, 'a high-speed bounce already separates during the remaining fraction of the same substep');
});

test('a changed predicted trajectory ignores a ghost contact and can hit a third body on its real rebound', () => {
  for (const rebound of [false, true]) {
    const arena = createArena(); arena.status = 'playing';
    const fixture = rebound ? [
      { id: 'pilot', x: 1000, vx: 2000, mass: 36 },
      { id: 'b', x: 1000 + 24 + 4 * Math.sqrt(1000) + 1, mass: 1000 },
      { id: 'c', x: 1000 - 24 - 4 * Math.sqrt(12) - .2, mass: 12 },
    ] : [{ id: 'pilot', x: 1000, vx: 2000 }, { id: 'b', x: 1050 }, { id: 'c', x: 1032, y: 2045 }];
    for (const spec of fixture) {
      const player = addPlayer(arena, { id: spec.id }); player.invulnerable = 100;
      const mass = spec.mass || 36;
      Object.assign(player.cells[0], { x: spec.x, y: spec.y || 2000, mass, radius: 4 * Math.sqrt(mass), vx: spec.vx || 0, vy: 0 });
    }
    arena.dust = Array.from({ length: 6000 }, (_, id) => ({ id: `far-${id}`, x: 11000, y: 7000, value: 1, vx: 0, vy: 0 }));
    const c = client(); c.api.start(snapshotArena(arena));
    const duration = 1 / 120;
    c.time(duration * 1000); c.api.frame(duration);
    const models = c.api.models(), third = models.find(model => model.id === 'c');
    if (!rebound) {
      assert.equal(third.vx, 0); assert.equal(third.vy, 0);
      assert.equal(third.x, 1032); assert.equal(third.y, 2045);
    } else {
      assert.ok(third.vx < 0, 'the real outgoing path must reach the third body');
      for (let i = 0; i < models.length; i++) for (let j = i + 1; j < models.length; j++) {
        const a = models[i], b = models[j], ar = arena.players.get(a.id).cells[0].radius, br = arena.players.get(b.id).cells[0].radius;
        assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= ar + br - 1e-5);
      }
    }
  }
});

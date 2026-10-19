import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createArena, addPlayer, stepArena, setPlayerInput, snapshotArena } from '../shared/engine.js';

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
      start(state) {
        active = true; myId = 'pilot';
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

test('merging and genuine authoritative relocations align before directional prediction continues', () => {
  const arena = createArena(); arena.status = 'playing';
  const player = addPlayer(arena, { id: 'pilot' });
  Object.assign(player.cells[0], { x: 1000, y: 1000 });
  player.cells.push({ ...player.cells[0], id: 'other', x: 1400 });
  const c = client(); c.api.start(snapshotArena(arena)); c.api.press('ArrowRight');
  // A merge changes the surviving cell's position to the combined centre.
  player.cells.splice(1); Object.assign(player.cells[0], { x: 1200, mass: 72 });
  c.time(50); c.api.packet(snapshotArena(arena));
  assert.equal(c.api.position().x, 1200, 'merged cells must align even if movement is held');
  // A respawn/restore can relocate an existing identifier far off the held axis.
  player.cells[0].y = 1600;
  c.time(100); c.api.packet(snapshotArena(arena));
  assert.equal(c.api.position().y, 1600, 'a genuine relocation must not leave a persistent lateral offset');
  c.time(100 + 1000 / 60); c.api.frame(1 / 60);
  assert.ok(c.api.position().x > 1200);
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

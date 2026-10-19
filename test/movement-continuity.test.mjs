import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createArena, addPlayer, setPlayerInput, stepArena, snapshotArena } from '../shared/engine.js';

const source = await readFile(process.env.PLANET_MOVEMENT_CLIENT_PATH || new URL('../public/game.js', import.meta.url), 'utf8');

function freeFlight(delayAt) {
  let clock = 0, serial = 0, lastInputDelivery = 0, lastStateDelivery = 0;
  const events = [], rows = [], packets = [];
  const schedule = (at, action) => events.push({ at, action, order: serial++ });
  const arena = createArena({ random: () => .99 }); arena.status = 'playing';
  const player = addPlayer(arena, { id: 'pilot' });
  Object.assign(player.cells[0], { x: 4000, y: 4000 });
  // No other bodies, pickups, growth, upgrades or frame drops can explain a
  // periodic change in the speed of this constant-thrust flight.
  arena.dust = Array.from({ length: 6000 }, (_, i) => ({ id: `far-${i}`, x: 11000, y: 7000, value: 1, vx: 0, vy: 0 }));
  const state = () => ({ code: 'FLIGHT', serverTime: clock, ...snapshotArena(arena) });
  const context = vm.createContext({ innerWidth: 1280, innerHeight: 800, window: {}, performance: { now: () => clock }, WebSocket: { OPEN: 1 } });
  context.window.onSend = message => {
    lastInputDelivery = Math.max(clock + delayAt(clock), lastInputDelivery + .01);
    schedule(lastInputDelivery, () => setPlayerInput(arena, player.id, message));
  };
  const hooks = `window.reviewMovement = {
    start(state) { active=true;myId='pilot';socket={readyState:1,send:data=>window.onSend(JSON.parse(data))};ingestSnapshot(state,performance.now());room=state; },
    press(code) { keys.clear();if(code)keys.add(code);sendInput(); },
    heartbeat:sendInput,
    packet(state) { const before=this.position();ingestSnapshot(state,performance.now());room=state;return {before,after:this.position()}; },
    frame(dt) { predictOwn(dt,performance.now()); },
    position() { const p=[...predictedCells.values()][0];return {x:p.x,y:p.y,vx:p.vx,vy:p.vy,modelX:p.model.x,modelY:p.model.y}; },
  };`;
  const instrumented = source.replace('  window.StarGame = {', `${hooks}\n  window.StarGame = {`);
  assert.notEqual(instrumented, source);
  vm.runInContext(instrumented, context);
  const api = context.window.reviewMovement; api.start(state()); api.press('ArrowRight');
  for (let frame = 1; frame <= 720; frame++) schedule(frame * 1000 / 60, () => {
    api.frame(1 / 60); rows.push({ at: clock, ...api.position() });
  });
  for (let tick = 1; tick <= 360; tick++) schedule(tick * 1000 / 30 + 7, () => {
    stepArena(arena, 1 / 30);
    if (tick % 2) return;
    const next = state();
    lastStateDelivery = Math.max(clock + delayAt(clock), lastStateDelivery + .01);
    schedule(lastStateDelivery, () => packets.push({ at: clock, ...api.packet(next) }));
  });
  for (let time = 8; time <= 12000; time += 50) schedule(time, () => api.heartbeat());
  schedule(6001, () => api.press('ArrowLeft'));
  schedule(7501, () => api.press(null));
  while (events.length) {
    events.sort((a, b) => a.at - b.at || a.order - b.order);
    const event = events.shift(); if (event.at > 12000) break;
    clock = event.at; event.action();
  }
  const velocities = rows.slice(1).map((row, i) => ({ at: row.at, x: (row.x - rows[i].x) * 60, y: (row.y - rows[i].y) * 60 }));
  return { rows, velocities, packets };
}
const average = values => values.reduce((sum, value) => sum + value, 0) / values.length;

function isolatedClient(initial, roundTrip = null) {
  let clock = 0;
  const context = vm.createContext({ innerWidth: 1280, innerHeight: 800, window: {}, performance: { now: () => clock }, WebSocket: { OPEN: 1 } });
  const hooks = `window.reviewIsolated = {
    start(state, ping) { active=true;myId='pilot';rtt=ping;socket={readyState:1,send() {}};ingestSnapshot(state,performance.now());room=state; },
    packet(state) { ingestSnapshot(state,performance.now());room=state; },
    heartbeat:sendInput,
    frame(dt) { predictOwn(dt,performance.now()); },
    own() { const p=[...predictedCells.values()][0];return {x:p.x,y:p.y,model:{...p.model}}; },
    remote(key) { return remotePhysics.get(key); },
    worldClock() { return renderSimulationTime(performance.now()); },
    lead() { return simulationLead; },
  };`;
  vm.runInContext(source.replace('  window.StarGame = {', `${hooks}\n  window.StarGame = {`), context);
  const api = context.window.reviewIsolated; api.start(initial, roundTrip);
  return { api, time: at => { clock = at; } };
}
function isolatedState(remote = false) {
  const arena = createArena(); arena.status = 'playing';
  const pilot = addPlayer(arena, { id: 'pilot' }); Object.assign(pilot.cells[0], { x: 4000, y: 4000 });
  if (remote) {
    const other = addPlayer(arena, { id: 'remote' }); Object.assign(other.cells[0], { x: 5000, y: 4000, vx: 210, vy: 0 });
    setPlayerInput(arena, other.id, { x: 1 });
  }
  return { code: 'ISOLATED', ...snapshotArena(arena) };
}

test('ordinary 15Hz snapshots do not imprint speed pulses on a constant 60FPS free flight', () => {
  for (const delay of [0, 80, 180]) {
    const flight = freeFlight(() => delay);
    const speeds = flight.velocities.filter(row => row.at >= 1500 && row.at < 5500).map(row => row.x);
    const mean = average(speeds), deviation = Math.sqrt(average(speeds.map(value => (value - mean) ** 2)));
    assert.ok(Math.abs(mean - 210) < 5, `free-flight mean speed ${mean} at ${delay}ms`);
    assert.ok(deviation < 4, `packet-rate speed ripple has standard deviation ${deviation} at ${delay}ms despite a steady 60FPS`);
    assert.ok(flight.packets.every(packet => Math.abs(packet.after.x - packet.before.x) < 1e-6), 'packet receipt itself remains visually continuous');
    assert.ok(flight.rows.every(row => row.y === 4000), 'horizontal flight does not acquire lateral movement');
  }
});

test('a latency spike and ordered recovery cannot reverse a held direction or turn reconciliation into a speed boost', () => {
  const flight = freeFlight(time => time >= 3000 && time < 5000 ? 450 : 80);
  const heldRight = flight.velocities.filter(row => row.at >= 1500 && row.at < 6000);
  assert.ok(heldRight.every(row => row.x > 0), 'without a collision, holding right must not produce any backwards render frame during network recovery');
  assert.ok(Math.max(...heldRight.map(row => row.x)) < 270, 'reconciliation must not accelerate constant thrust far beyond the physical top speed');
  const reversed = flight.velocities.filter(row => row.at >= 6300 && row.at < 7500);
  assert.ok(reversed.every(row => row.x < 0), 'after braking, held left continues left through delayed acknowledgements');
  const earlyCoast = flight.velocities.filter(row => row.at > 7550 && row.at < 7800).map(row => Math.abs(row.x));
  const lateCoast = flight.velocities.filter(row => row.at > 8400 && row.at < 8700).map(row => Math.abs(row.x));
  assert.ok(average(earlyCoast) > average(lateCoast) && average(lateCoast) > 0, 'release retains damped coasting');
});

test('an unpredicted non-fracturing authoritative impact changes physical velocity once without teleporting or repeating its impulse', () => {
  const initial = isolatedState(), c = isolatedClient(initial, 0);
  c.time(100); c.api.frame(.1);
  const before = c.api.own();
  const impactState = structuredClone(initial), pilot = impactState.players[0];
  impactState.time = .1; impactState.simulationTime = 100;
  pilot.cells[0].vx = 160; pilot.collisionRevision++;
  pilot.lastImpact = { id: 'unpredicted-contact', at: .1, x: 3976, y: 4000, normalX: 1, normalY: 0, speed: 220, radius: 15, fractured: false };
  c.api.packet(impactState);
  assert.equal(c.api.own().x, before.x, 'a newly learned collision must preserve the displayed position');
  assert.ok(c.api.own().model.vx > 120, 'a genuine authoritative impulse cannot be reduced to a slow positional correction');
  c.time(100 + 1000 / 60); c.api.frame(1 / 60);
  const moving = c.api.own();
  assert.ok(moving.x - before.x > 2, 'the reported impact creates physical coasting on the next frame');
  assert.ok(moving.model.vx < 160 && moving.model.vx > 120);
  c.time(100 + 1000 / 60 + 1); c.api.packet(structuredClone(impactState));
  assert.equal(c.api.own().model.vx, moving.model.vx, 'a repeated packet carrying the same event must not reset decayed momentum to its old impact value');
  const secondImpact = structuredClone(impactState);
  secondImpact.time = .12; secondImpact.simulationTime = 120;
  secondImpact.players[0].cells[0].vx = -160; secondImpact.players[0].collisionRevision++;
  secondImpact.players[0].lastImpact = { ...pilot.lastImpact, id: 'different-unpredicted-contact', at: .12, normalX: -1 };
  c.time(120); c.api.packet(secondImpact);
  assert.ok(c.api.own().model.vx < -120, 'a different real impact must not be suppressed by the previous impact\'s short contact window');
});

test('the shared render clock stays monotonic and continuous through delayed packet arrivals and ordered recovery', () => {
  const initial = isolatedState(), c = isolatedClient(initial, 0), events = [];
  let previousDelivery = 0, previousFrameTime;
  for (let tick = 1; tick <= 45; tick++) {
    const generated = tick * 1000 / 15, delay = generated < 700 ? 80 : generated < 1900 ? 450 : 80;
    const delivery = Math.max(generated + delay, previousDelivery + 1); previousDelivery = delivery;
    events.push({ at: delivery, packet: true, generated });
  }
  for (let frame = 1; frame <= 220; frame++) events.push({ at: frame * 1000 / 60, packet: false });
  events.sort((a, b) => a.at - b.at);
  let previous = c.api.worldClock();
  for (const event of events) {
    c.time(event.at);
    const before = c.api.worldClock();
    assert.ok(before >= previous - 1e-8, 'ordinary arrival jitter must not move the shared world reference backwards');
    if (event.packet) {
      const next = structuredClone(initial); next.simulationTime = event.generated; next.time = event.generated / 1000;
      c.api.packet(next);
      assert.ok(Math.abs(c.api.worldClock() - before) < 1e-8, 'packet arrival changes clock rate targets without stepping the clock itself');
    } else if (previousFrameTime !== undefined) {
      const frameAdvance = before - previousFrameTime;
      assert.ok(frameAdvance >= 15 - 1e-8 && frameAdvance <= 1000 / 60 * 1.1 + 1e-8, `world reference advanced ${frameAdvance}ms in one rendered frame`);
    }
    if (!event.packet) previousFrameTime = before;
    previous = c.api.worldClock();
  }
});

test('remote current-time proxies use one-way age rather than replaying the full local input round trip', () => {
  const initial = isolatedState(true), c = isolatedClient(initial, 360), key = `remote:${initial.players[1].cells[0].id}`;
  assert.ok(Math.abs(c.api.lead() - .18) < 1e-9);
  assert.ok(Math.abs(c.api.remote(key).model.x - (5000 + 210 * .18)) < 1e-7,
    'a 360ms symmetric round trip implies 180ms of remote snapshot travel, not 360ms');
  const fallback = isolatedClient(initial);
  fallback.api.heartbeat();
  const next = structuredClone(initial); next.players[0].lastInputSeq = 1; next.players[0].inputAge = 0;
  fallback.time(360); fallback.api.packet(next);
  assert.ok(Math.abs(fallback.api.lead() - .18) < 1e-9, 'before ping measurement, the input round-trip fallback is also halved');
  assert.ok(Math.abs(fallback.api.remote(key).authority.x - (5000 + 210 * .18)) < 1e-7);
});

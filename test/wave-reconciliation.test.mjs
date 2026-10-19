import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createArena, addPlayer, setPlayerInput, stepArena, snapshotArena } from '../shared/engine.js';

// Run the shipped reconciliation code with a deterministic clock. Each
// fixture has separated cores, so collision solving cannot hide a lost wave.
const source = await readFile(new URL('../public/game.js', import.meta.url), 'utf8');
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-7,
  `${message}: expected ${expected}, received ${actual}`);

function fixture(remote = false, ping = 0, simultaneousAttackers = false) {
  let clock = 0;
  const arena = createArena(); arena.status = 'playing';
  const pilot = addPlayer(arena, { id: 'pilot' });
  if (remote) Object.assign(pilot.cells[0], { x: 9000, y: 4000 });
  const victim = remote ? addPlayer(arena, { id: 'victim' }) : pilot;
  const first = victim.cells[0];
  Object.assign(first, { x: 2000, y: 4000, vx: 0, vy: 0, mergeIn: 12 });
  victim.cells.push({ ...first, id: 'second-core', x: 3000 });
  victim.cells.push({ ...first, id: 'untouched-core', x: 4000 });
  Object.assign(victim, { x: 3000, y: 4000, mass: 108, invulnerable: 0 });
  const attackers = simultaneousAttackers ? [2078, 3078].map((x, i) => {
    const p = addPlayer(arena, { id: `attacker-${i}` });
    Object.assign(p, { x, y: 4000, energy: 100, invulnerable: 0, direction: { x: -1, y: 0 } });
    Object.assign(p.cells[0], { x, y: 4000 });
    return p;
  }) : [];
  const initial = { code: 'WAVERECONCILE', ...snapshotArena(arena) };
  const context = vm.createContext({ innerWidth: 1280, innerHeight: 800,
    window: {}, performance: { now: () => clock }, WebSocket: { OPEN: 1 } });
  const hooks = `window.waveReconciliationTest = {
    start(state, ping) { active = true; myId = 'pilot'; rtt = ping; socket = { readyState: 1, send() {} }; ingestSnapshot(state, performance.now()); room = state; },
    packet(state) { ingestSnapshot(state, performance.now()); room = state; },
    frame(dt) { predictOwn(dt, performance.now()); },
    ref(playerId, cellId) { return playerId === myId ? predictedCells.get(cellId) : remotePhysics.get(playerId + ':' + cellId); },
  };`;
  const instrumented = source.replace('  window.StarGame = {', `${hooks}\n  window.StarGame = {`);
  assert.notEqual(instrumented, source, 'test hook must attach to the shipped client');
  vm.runInContext(instrumented, context, { filename: 'public/game.js' });
  const api = context.window.waveReconciliationTest; api.start(initial, ping);
  return { api, arena, attackers, initial, victimId: victim.id, cellIds: victim.cells.map(c => c.id),
    time: at => { clock = at; },
    ref: cellId => api.ref(victim.id, cellId) };
}

function hitState(previous, victimId, cellIds, { id = 'wave-one', at = .1, vx = 240, vy = 0, mode = 'forward' } = {}) {
  const next = structuredClone(previous), player = next.players.find(p => p.id === victimId);
  next.time = at; next.simulationTime = at * 1000;
  let lostMass = 0;
  for (const cell of player.cells) if (cellIds.includes(cell.id)) {
    const loss = cell.mass * .12; cell.mass -= loss; cell.radius = 4 * Math.sqrt(cell.mass);
    cell.vx = vx; cell.vy = vy; cell.lastWaveHitId = `${id}:${victimId}`; lostMass += loss;
  }
  player.collisionRevision++;
  player.lastWaveHit = { id: `${id}:${victimId}`, waveId: id, at, ownerId: 'attacker',
    cellId: cellIds[0], hitCellIds: [...cellIds], hitCells: cellIds.length,
    x: 1976, y: 4000, directionX: vx < 0 ? -1 : 1, directionY: 0,
    impulse: Math.hypot(vx, vy), lostMass, mode };
  return next;
}

for (const remote of [false, true]) {
  const label = remote ? 'remote' : 'own';
  test(`${label}: a twelve-percent wave loss adopts each hit core's velocity during an active contact window without moving its position`, () => {
    const c = fixture(remote), [first, second, untouched] = c.cellIds;
    for (const id of c.cellIds) {
      const ref = c.ref(id); ref.contactUntil = 500; ref.normals = [{ x: 1, y: 0 }];
    }
    c.ref(untouched).model.vx = 13;
    const before = c.cellIds.map(id => ({ x: c.ref(id).model.x, y: c.ref(id).model.y }));
    const next = hitState(c.initial, c.victimId, [first, second], { vx: -240, vy: 40, mode: 'rear' });
    c.time(100); c.api.packet(next);
    near(c.ref(first).model.vx, -240, 'first hit core must receive physical momentum immediately');
    near(c.ref(second).model.vx, -240, 'all hitCellIds must receive physical momentum immediately');
    near(c.ref(first).model.vy, 40, 'the full velocity vector is authoritative');
    near(c.ref(untouched).model.vx, 13, 'a player-wide revision must not reset an unhit core');
    c.cellIds.forEach((id, i) => {
      near(c.ref(id).model.x, before[i].x, 'packet arrival preserves model position');
      near(c.ref(id).model.y, before[i].y, 'packet arrival preserves model position');
    });
    c.time(100 + 1000 / 60); c.api.frame(1 / 60);
    assert.ok(c.ref(first).model.x < before[0].x - 3,
      'a real wave must produce coasting on the next frame even with a previously opposing contact normal');
  });

  test(`${label}: repeated metadata cannot reapply a wave, but a distinct wave reverses momentum inside the same contact window`, () => {
    const c = fixture(remote), [first] = c.cellIds;
    c.ref(first).contactUntil = 500;
    const firstHit = hitState(c.initial, c.victimId, [first]);
    c.time(100); c.api.packet(firstHit);
    c.time(100 + 1000 / 60); c.api.frame(1 / 60);
    const coastVelocity = c.ref(first).model.vx;
    assert.ok(coastVelocity > 200 && coastVelocity < 240);
    c.time(120); c.api.packet(structuredClone(firstHit));
    near(c.ref(first).model.vx, coastVelocity, 'repeated event id cannot restore or add the already spent impulse');
    const secondHit = hitState(firstHit, c.victimId, [first], { id: 'wave-two', at: .13, vx: -100, mode: 'rear' });
    c.time(130); c.api.packet(secondHit);
    near(c.ref(first).model.vx, -100, 'a distinct event must immediately replace physical velocity despite contactUntil');
    c.time(140); c.api.packet(structuredClone(secondHit));
    near(c.ref(first).model.vx, -100, 'a repeated second event cannot add a second impulse');
  });
}

test('own wave replay advances the authoritative impulse by one downlink rather than the full round trip', () => {
  const c = fixture(false, 360), [first] = c.cellIds;
  c.ref(first).contactUntil = 500;
  const next = hitState(c.initial, c.victimId, [first]);
  c.time(280); c.api.packet(next);
  near(c.ref(first).model.vx, 240 * Math.exp(-2 * .18), 'the impulse must coast for half the 360 ms round trip');
  near(c.ref(first).model.x, 2000, 'latency compensation cannot teleport the visible model');
});

for (const remote of [false, true]) {
  test(`separate waves hitting different ${remote ? 'remote' : 'own'} cores before one snapshot do not lose or duplicate the earlier core momentum`, () => {
    const c = fixture(remote, 0, true), [first, second] = c.cellIds;
    for (const id of c.cellIds) { c.ref(id).contactUntil = 500; c.ref(id).normals = [{ x: 1, y: 0 }]; }
    c.arena.time = .1;
    for (const attacker of c.attackers) setPlayerInput(c.arena, attacker.id, { fire: true });
    stepArena(c.arena, 0);
    const coalesced = { code: c.initial.code, ...snapshotArena(c.arena) };
    const victim = coalesced.players.find(p => p.id === c.victimId);
    const firstCell = victim.cells.find(cell => cell.id === first), secondCell = victim.cells.find(cell => cell.id === second);
    near(firstCell.mass, 36 * .88, 'the real engine fixture must hit the first core');
    near(secondCell.mass, 36 * .88, 'the real engine fixture must hit the second core');
    near(firstCell.vx, -240, 'the real first wave must impart an authoritative impulse');
    near(secondCell.vx, -240, 'the real second wave must impart an authoritative impulse');
    c.time(100); c.api.packet(coalesced);
    near(c.ref(first).model.vx, firstCell.vx, 'snapshot coalescing must not discard a real impulse on a different hit core');
    near(c.ref(second).model.vx, secondCell.vx, 'the most recent hit core also receives its impulse');
    c.time(100 + 1000 / 60); c.api.frame(1 / 60);
    const firstCoast = c.ref(first).model.vx, secondCoast = c.ref(second).model.vx;
    c.time(120); c.api.packet(structuredClone(coalesced));
    near(c.ref(first).model.vx, firstCoast, 'a repeated snapshot must not restore the first core impulse');
    near(c.ref(second).model.vx, secondCoast, 'a repeated snapshot must not restore the second core impulse');
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createArena, addPlayer, normalizeInput, cleanName, setPlayerInput, stepArena, snapshotArena, chooseUpgrade, startRound, gravityRadius } from '../shared/engine.js';
import { createRoomManager, createGameServer } from '../server.mjs';

function fixture() {
  const arena = createArena({ random: () => 0.99 });
  arena.status = 'playing';
  const player = (id, x = 300, mass = 36) => {
    const p = addPlayer(arena, { id, name: id });
    p.x = x; p.y = 300; p.mass = mass; p.radius = 4 * Math.sqrt(mass); p.invulnerable = 0;
    Object.assign(p.cells[0], { x, y: 300, mass, radius: p.radius });
    return p;
  };
  return { arena, player };
}

test('inputs reject non-finite data and normalize diagonal movement', () => {
  const input = normalizeInput({ x: 900, y: -900, boost: true, fire: 'yes', split: true });
  assert.ok(Math.abs(Math.hypot(input.x, input.y) - 1) < 1e-10);
  assert.ok(!('boost' in input));
  assert.equal(input.fire, false);
  assert.equal(input.split, true);
  assert.deepEqual(normalizeInput({ x: NaN, y: Infinity }), normalizeInput(null));
  assert.equal(cleanName('<小星球>\n\u200B'), '小星球');
  assert.equal([...cleanName('🌍'.repeat(30))].length, 14);
});

test('dust collection increases mass, energy and score once', () => {
  const { arena, player } = fixture();
  const p = player('a');
  p.energy = 10;
  arena.dust = [{ id: 'known', x: 300, y: 300, value: 2 }];
  stepArena(arena, 0.01);
  assert.equal(p.mass, 38);
  assert.equal(p.score, 4);
  assert.ok(p.energy >= 18);
  assert.ok(!arena.dust.some(d => d.id === 'known'));
});

test('split and recombine conserve mass; holding split does not split repeatedly', () => {
  const { arena, player } = fixture();
  const p = player('a', 300, 100);
  setPlayerInput(arena, p.id, { x: 1, split: true });
  stepArena(arena, 0.01);
  assert.equal(p.cells.length, 2);
  assert.equal(p.mass, 100);
  assert.ok(p.cells.every(c => c.mass === 50 && c.mergeIn > 11));
  setPlayerInput(arena, p.id, { x: 1, split: true });
  stepArena(arena, 0.01);
  assert.equal(p.cells.length, 2);
  setPlayerInput(arena, p.id, {});
  for (const cell of p.cells) Object.assign(cell, { x: 300, y: 300, mergeIn: 0, impulseX: 0, impulseY: 0 });
  stepArena(arena, 0.01);
  assert.equal(p.cells.length, 1);
  assert.equal(p.mass, 100);
});

test('live cores separate instead of being swallowed, including preexisting deep overlaps', () => {
  const { arena, player } = fixture();
  const larger = player('a', 300, 100);
  const smaller = player('b', 300, 36);
  smaller.cells[0].shatterCooldown = 3;
  stepArena(arena, 0.01);
  assert.equal(larger.mass, 100);
  assert.equal(smaller.mass, 36);
  assert.equal(smaller.cells.length, 1);
  assert.equal(smaller.respawnIn, 0);
  assert.equal(larger.score, 0);
  assert.equal(larger.kills, 0);
  assert.ok(Math.hypot(larger.x - smaller.x, larger.y - smaller.y) >= larger.radius + smaller.radius - 1e-5);
});

test('equal-sized cells and spawn protection prevent absorption', () => {
  const { arena, player } = fixture();
  const a = player('a', 300, 36);
  const b = player('b', 300, 36);
  stepArena(arena, 0.01);
  assert.equal(a.mass, 36);
  assert.equal(b.mass, 36);
  a.cells[0].mass = 100;
  a.cells[0].radius = 40;
  a.mass = 100;
  b.invulnerable = 2;
  stepArena(arena, 0.01);
  assert.equal(b.cells.length, 1);
});

test('ejection transfers exactly 3 mass into a pellet with own pickup delay', () => {
  const { arena, player } = fixture();
  const p = player('a', 300, 60);
  setPlayerInput(arena, p.id, { x: 1, eject: true });
  stepArena(arena, 0.01);
  const pellet = arena.dust.find(d => d.ejected);
  assert.equal(p.mass, 57);
  assert.equal(pellet.value, 3);
  assert.equal(p.mass + pellet.value, 60);
  pellet.x = p.x; pellet.y = p.y;
  stepArena(arena, 0.01);
  assert.ok(arena.dust.includes(pellet));
});

test('recovering an ejected pellet cannot farm score or energy', () => {
  const { arena, player } = fixture();
  const p = player('a', 300, 60);
  p.energy = 10;
  setPlayerInput(arena, p.id, { eject: true });
  stepArena(arena, 0.01);
  const pellet = arena.dust.find(d => d.ejected);
  Object.assign(pellet, { x: p.x, y: p.y, vx: 0, vy: 0, availableAt: 0 });
  const beforeEnergy = p.energy;
  stepArena(arena, 0.01);
  assert.equal(p.mass, 60);
  assert.equal(p.score, 0);
  assert.ok(p.energy - beforeEnergy < 0.04);
});

test('big impact leaves one controllable core and mass-conserving free fragments', () => {
  const { arena, player } = fixture();
  const big = player('big', 300, 100);
  const small = player('small', 355, 36);
  stepArena(arena, 0.01);
  assert.equal(small.cells.length, 1);
  assert.equal(small.mass, 12);
  assert.equal(big.mass, 95);
  const free = arena.dust.filter(d => d.fragment && d.ownerId === small.id);
  assert.equal(free.length, 2);
  assert.equal(small.mass + free.reduce((sum, fragment) => sum + fragment.value, 0), 36);
  assert.ok(small.cells.every(cell => cell.protectedFor > 0.99 && cell.protectedFor <= 1 &&
    cell.shatterCooldown > 2.99 && cell.shatterCooldown <= 3));
  assert.ok(small.shatteredAt > 0);
  for (const cell of small.cells) Object.assign(cell, { x: big.x, y: big.y, impulseX: 0, impulseY: 0 });
  stepArena(arena, 0.01);
  assert.equal(small.cells.length, 1);
  assert.equal(big.mass, 95);
  assert.ok(snapshotArena(arena).players.find(p => p.id === small.id).cells.every(c => c.protected));
  for (const cell of small.cells) Object.assign(cell, { x: big.x, y: big.y, protectedFor: 0, impulseX: 0, impulseY: 0 });
  stepArena(arena, 0.01);
  assert.equal(small.cells.length, 1);
  assert.equal(big.mass, 95);
});

test('higher-mass impact leaves one core and three free fragments', () => {
  const { arena, player } = fixture();
  player('big', 300, 200);
  const small = player('small', 380, 80);
  stepArena(arena, 0.01);
  assert.equal(small.cells.length, 1);
  assert.equal(small.mass, 20);
  const free = arena.dust.filter(d => d.fragment && d.ownerId === small.id);
  assert.equal(free.length, 3);
  assert.equal(small.mass + free.reduce((sum, fragment) => sum + fragment.value, 0), 80);
});

test('owner may reabsorb free chunks after grace without multiplying recycled mass', () => {
  const { arena, player } = fixture();
  player('big', 300, 100);
  const small = player('small', 355, 36);
  small.stats.growth = 1.8;
  stepArena(arena, 0.01);
  arena.players.delete('big');
  const free = arena.dust.filter(d => d.fragment && d.ownerId === small.id);
  for (const fragment of free) Object.assign(fragment, { x: small.x, y: small.y, vx: 0, vy: 0 });
  stepArena(arena, 0.01);
  assert.equal(small.mass, 12);
  small.cells[0].vx = small.cells[0].vy = 0;
  for (const fragment of free) Object.assign(fragment, { x: small.cells[0].x, y: small.cells[0].y,
    vx: 0, vy: 0, collectAfter: 0, availableAt: 0 });
  stepArena(arena, 0.01);
  assert.equal(small.mass, 36);
  assert.equal(small.score, 0);
  assert.equal(arena.dust.filter(d => d.fragment && d.ownerId === small.id).length, 0);
});

test('gravity attracts dust outside collision range and eventually absorbs it', () => {
  const { arena, player } = fixture();
  const p = player('a', 300, 36);
  const dust = { id: 'gravity-dust', x: 390, y: 300, value: 1 };
  arena.dust = [dust];
  stepArena(arena, 0.1);
  assert.ok(dust.x < 390);
  assert.ok(dust.vx < 0);
  assert.equal(p.mass, 36);
  for (let i = 0; i < 30 && arena.dust.includes(dust); i++) stepArena(arena, 0.1);
  assert.ok(!arena.dust.includes(dust));
  assert.equal(p.mass, 37);
  const smallerRadius = gravityRadius(p.cells[0], p);
  p.cells[0].mass = 100;
  p.cells[0].radius = 40;
  assert.ok(gravityRadius(p.cells[0], p) > smallerRadius);
  const baseRange = gravityRadius(p.cells[0], p);
  p.stats.magnet = 25;
  assert.equal(gravityRadius(p.cells[0], p), baseRange + 25);
});

test('blast damages each opponent once and awards kill score', () => {
  const { arena, player } = fixture();
  const a = player('a', 300);
  const b = player('b', 420);
  setPlayerInput(arena, a.id, { fire: true });
  for (let i = 0; i < 12; i++) stepArena(arena, 0.1);
  assert.equal(b.hp, 60);
  assert.equal(arena.blasts.length, 0);
  assert.ok(a.energy < 40);
  b.hp = 40;
  setPlayerInput(arena, a.id, { fire: false });
  setPlayerInput(arena, a.id, { fire: true });
  for (let i = 0; i < 6; i++) stepArena(arena, 0.1);
  assert.equal(a.kills, 1);
  assert.equal(a.score, 25);
  assert.ok(b.respawnIn > 0);
});

test('round ends authoritatively after 180 seconds and snapshots omit private internals', () => {
  const { arena, player } = fixture();
  const a = player('a');
  a.score = 42;
  player('b', 600).score = 10;
  arena.time = 179.95;
  stepArena(arena, 0.1);
  assert.equal(arena.status, 'finished');
  assert.equal(arena.winnerId, 'a');
  const state = snapshotArena(arena);
  assert.equal(state.remaining, 0);
  assert.equal(state.players[0].cells.length, 1);
  assert.ok(!('input' in state.players[0]));
  assert.ok(!('random' in state));
});

test('growth offers three unique upgrades once per peak milestone and rejects invalid choices', () => {
  const { arena, player } = fixture();
  const p = player('a', 300, 165);
  stepArena(arena, 0.01);
  assert.equal(p.level, 4);
  assert.equal(p.upgradePending, 3);
  assert.equal(p.upgradeChoices.length, 3);
  assert.equal(new Set(p.upgradeChoices.map(option => option.id)).size, 3);
  assert.equal(snapshotArena(arena).players[0].nextUpgradeMass, 240);
  assert.throws(() => chooseUpgrade(arena, 'a', 'invented'), /失效/);
  assert.equal(p.upgradePending, 3);
  const choice = p.upgradeChoices[0].id;
  chooseUpgrade(arena, 'a', choice);
  assert.equal(p.upgrades[choice], 1);
  assert.equal(p.upgradePending, 2);
  assert.equal(p.upgradeChoices.length, 3);
  p.cells[0].mass = 36;
  p.cells[0].radius = 24;
  stepArena(arena, 0.01);
  assert.equal(p.peakMass, 165);
  assert.equal(p.upgradePending, 2);
  p.cells[0].mass = 165;
  p.cells[0].radius = 4 * Math.sqrt(165);
  stepArena(arena, 0.01);
  assert.equal(p.upgradePending, 2);
  startRound(arena);
  assert.equal(p.level, 1);
  assert.equal(p.upgradePending, 0);
  assert.deepEqual(p.upgrades, {});
});

test('selected growth and shield upgrades modify authoritative gameplay', () => {
  const { arena, player } = fixture();
  const p = player('a');
  p.upgradePending = 2;
  p.upgradeChoices = [{ id: 'growth' }, { id: 'shield' }, { id: 'speed' }];
  chooseUpgrade(arena, 'a', 'growth');
  arena.dust = [{ id: 'growth-dust', x: 300, y: 300, value: 5 }];
  stepArena(arena, 0.01);
  assert.equal(p.mass, 42);
  p.upgradeChoices = [{ id: 'shield' }, { id: 'speed' }, { id: 'range' }];
  chooseUpgrade(arena, 'a', 'shield');
  assert.equal(p.hp, 125);
  assert.equal(p.stats.maxHp, 125);
});

test('room lifecycle enforces readiness, host authority and host succession', () => {
  const manager = createRoomManager();
  const room = manager.create('a', { name: '房主' });
  assert.equal(room.arena.players.get('a').ready, true);
  assert.throws(() => manager.start('a'), /至少/);
  manager.join('b', { code: room.code.toLowerCase(), name: '队友' });
  assert.throws(() => manager.start('b'), /房主/);
  assert.throws(() => manager.start('a'), /准备/);
  manager.ready('b', true);
  manager.start('a');
  assert.equal(room.arena.status, 'playing');
  assert.throws(() => manager.join('c', { code: room.code }), /已经开始/);
  manager.disconnect('a');
  assert.equal(room.hostId, 'b');
  assert.equal(manager.reconnect('a'), room);
  assert.equal(room.arena.players.get('a').connected, true);
  room.arena.time = 179.99;
  manager.tick(0.1);
  assert.equal(room.arena.status, 'finished');
  assert.equal(room.arena.players.get('b').ready, true);
  assert.equal(room.arena.players.get('a').ready, false);
  manager.ready('a', true);
  manager.start('b');
  assert.equal(room.arena.round, 2);
  manager.leave('a');
  manager.leave('b');
  assert.equal(manager.rooms.size, 0);
});

test('quick matching and reconnect grace clean up abandoned rooms', () => {
  let now = 1000;
  const manager = createRoomManager({ now: () => now });
  const a = manager.quick('a');
  assert.equal(manager.quick('b'), a);
  assert.equal(manager.stats().players, 2);
  manager.disconnect('a');
  now += 29_000;
  manager.tick();
  assert.ok(manager.find('a'));
  now += 1_001;
  manager.tick();
  assert.equal(manager.find('a'), undefined);
  manager.leave('b');
  assert.equal(manager.stats().rooms, 0);
});

test('practice mode creates real simulated bots and starts immediately', () => {
  const manager = createRoomManager();
  const room = manager.create('a', { mode: 'practice' });
  assert.equal(room.arena.status, 'playing');
  assert.equal(room.arena.players.size, 5);
  const bot = [...room.arena.players.values()].find(p => p.bot);
  const x = bot.x, y = bot.y;
  for (let i = 0; i < 30; i++) manager.tick();
  assert.ok(Math.hypot(bot.x - x, bot.y - y) > 0);
  assert.equal(manager.stats().players, 1);
});

function socketClient(url) {
  const ws = new WebSocket(url);
  const messages = [];
  const pending = [];
  ws.on('message', data => {
    const message = JSON.parse(data.toString());
    messages.push(message);
    for (const request of [...pending]) if (request.filter(message)) {
      clearTimeout(request.timeout);
      pending.splice(pending.indexOf(request), 1);
      request.resolve(message);
    }
  });
  return { ws, send: message => ws.send(JSON.stringify(message)),
    wait: filter => messages.find(filter) ? Promise.resolve(messages.find(filter)) : new Promise((resolve, reject) => {
      const request = { filter, resolve, timeout: setTimeout(() => reject(new Error('WebSocket response timeout')), 3000) };
      pending.push(request);
    }),
  };
}

test('real WebSockets create/join/start, synchronize movement, and reconnect', async () => {
  const game = createGameServer({ port: 0, host: '127.0.0.1' });
  const address = await game.listen();
  const endpoint = `ws://127.0.0.1:${address.port}/ws`;
  const a = socketClient(endpoint);
  const b = socketClient(endpoint);
  try {
    const [welcomeA] = await Promise.all([a.wait(m => m.type === 'welcome'), b.wait(m => m.type === 'welcome')]);
    a.send({ type: 'create', name: '房主', skin: 1 });
    const joined = await a.wait(m => m.type === 'joined');
    b.send({ type: 'join', code: joined.code, name: '队友', skin: 2 });
    await b.wait(m => m.type === 'joined');
    b.send({ type: 'ready', ready: true });
    await a.wait(m => m.type === 'state' && m.room.players.length === 2 && m.room.players.every(p => p.ready));
    a.send({ type: 'start' });
    const playing = await b.wait(m => m.type === 'state' && m.room.status === 'playing');
    const initialX = playing.room.players.find(p => p.id === welcomeA.id).x;
    a.send({ type: 'input', x: initialX > 700 ? -1 : 1, y: 0 });
    const moved = await b.wait(m => m.type === 'state' && m.room.status === 'playing' && Math.abs(m.room.players.find(p => p.id === welcomeA.id).x - initialX) > 5);
    assert.equal(moved.room.players.find(p => p.id === welcomeA.id).color, '#d4b5ff');
    a.ws.close();
    await once(a.ws, 'close');
    const reconnect = socketClient(`${endpoint}?token=${encodeURIComponent(welcomeA.reconnectToken)}`);
    const restored = await reconnect.wait(m => m.type === 'joined');
    assert.equal(restored.id, welcomeA.id);
    assert.equal(restored.code, joined.code);
    reconnect.ws.close();
  } finally {
    a.ws.terminate(); b.ws.terminate();
    await game.close();
  }
});

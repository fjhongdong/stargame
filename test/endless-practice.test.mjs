import test from 'node:test';
import assert from 'node:assert/strict';
import { createArena, addPlayer, startRound, stepArena, setPlayerInput, snapshotArena,
  DUST_COUNT, ROUND_DURATION } from '../shared/engine.js';
import { createRoomManager } from '../server.mjs';

function seeded(seed = 79135) {
  return () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
}

function place(player, x, y) {
  Object.assign(player, { x, y, invulnerable: 0 });
  Object.assign(player.cells[0], { x, y, vx: 0, vy: 0 });
}

test('practice crosses the old time limit and continues moving, collecting and replenishing natural dust', () => {
  const manager = createRoomManager({ random: seeded() });
  const room = manager.create('human', { mode: 'practice', endless: false });
  assert.equal(room.arena.endless, true, 'the server determines the mode instead of trusting an endless request field');
  const first = JSON.parse(JSON.stringify(manager.snapshot(room)));
  assert.equal(first.endless, true);
  assert.equal(first.remaining, null);
  assert.equal(first.players.filter(player => player.bot).length, 4);
  const human = room.arena.players.get('human');
  place(human, 1500, 1500);
  const beforeMass = human.mass;
  room.arena.time = ROUND_DURATION - .05;
  room.arena.dust.push({ id: 'after-limit-food', x: 1500, y: 1500, value: 1 });
  manager.input(human.id, { x: 1, seq: 1 });
  manager.tick(.1);
  assert.equal(room.arena.status, 'playing');
  assert.equal(room.arena.winnerId, null);
  assert.ok(human.mass > beforeMass);
  assert.ok(!room.arena.dust.some(dust => dust.id === 'after-limit-food'));
  const bot = [...room.arena.players.values()].find(player => player.bot);
  const before = { x: bot.x, y: bot.y };
  const retainedRound = room.arena.round;
  for (let i = 0; i < 100; i++) manager.tick(.1);
  const snapshot = manager.snapshotForPlayer(room, human.id);
  assert.ok(snapshot.time > ROUND_DURATION + 9);
  assert.equal(snapshot.status, 'playing');
  assert.equal(snapshot.remaining, null);
  assert.equal(snapshot.winnerId, null);
  assert.equal(snapshot.round, retainedRound, 'training does not silently reset growth at the old time limit');
  assert.ok(Math.hypot(bot.x - before.x, bot.y - before.y) > 1);
  assert.ok(room.arena.dust.filter(dust => !dust.fragment).length >= DUST_COUNT);
});

test('bots killed after three minutes still respawn and keep simulating in endless training', () => {
  const arena = createArena({ endless: true, random: () => .99 });
  arena.status = 'playing';
  arena.time = 600;
  const attacker = addPlayer(arena, { id: 'human' });
  const bot = addPlayer(arena, { id: 'bot', bot: true });
  place(attacker, 6000, 4000);
  place(bot, 6100, 4000);
  bot.hp = 40;
  const previousCore = bot.cells[0].id;
  setPlayerInput(arena, attacker.id, { fire: true });
  stepArena(arena, .1);
  assert.equal(bot.hp, 0, 'an actual authoritative wave kills the bot after the former round boundary');
  assert.equal(bot.cells.length, 0);
  assert.equal(bot.respawnIn, 2);
  for (let i = 0; i < 22; i++) stepArena(arena, .1);
  assert.equal(arena.status, 'playing');
  assert.equal(arena.remaining, null);
  assert.equal(arena.winnerId, null);
  assert.equal(bot.respawnIn, 0);
  assert.equal(bot.hp, bot.stats.maxHp);
  assert.equal(bot.cells.length, 1);
  assert.notEqual(bot.cells[0].id, previousCore);
  assert.ok(Math.hypot(bot.vx, bot.vy) > 0);
});

test('starting a new round resets progress and time while retaining the explicit time-limit mode', () => {
  for (const endless of [false, true]) {
    const arena = createArena({ endless, random: seeded() });
    const player = addPlayer(arena, { id: 'player' });
    startRound(arena);
    arena.time = 600;
    arena.winnerId = 'old-winner';
    player.score = 123;
    player.level = 4;
    player.upgrades.speed = 3;
    startRound(arena);
    const snapshot = snapshotArena(arena);
    assert.equal(snapshot.endless, endless);
    assert.equal(snapshot.time, 0);
    assert.equal(snapshot.remaining, endless ? null : ROUND_DURATION);
    assert.equal(snapshot.status, 'playing');
    assert.equal(snapshot.winnerId, null);
    assert.equal(snapshot.round, 2);
    assert.equal(player.score, 0);
    assert.equal(player.level, 1);
    assert.deepEqual(player.upgrades, {});
  }
});

test('online rooms retain the three-minute finish and cannot opt out through untrusted mode fields', () => {
  const manager = createRoomManager({ random: seeded() });
  const room = manager.create('host', { mode: 'online', endless: true });
  manager.join('guest', { code: room.code });
  manager.ready('guest', true);
  manager.start('host');
  assert.equal(room.arena.endless, false);
  assert.equal(manager.snapshot(room).remaining, ROUND_DURATION);
  room.arena.time = ROUND_DURATION - .05;
  manager.tick(.1);
  const final = manager.snapshot(room);
  assert.equal(final.status, 'finished');
  assert.equal(final.endless, false);
  assert.equal(final.remaining, 0);
  assert.ok(final.winnerId);
  manager.ready('guest', true);
  manager.start('host');
  assert.equal(room.arena.round, 2);
  assert.equal(room.arena.endless, false);
  assert.equal(room.arena.remaining, ROUND_DURATION);
});

test('an abandoned endless practice room still expires after the human reconnect grace', () => {
  let now = 1000;
  const manager = createRoomManager({ now: () => now, random: seeded() });
  const room = manager.create('human', { mode: 'practice' });
  room.arena.time = 600;
  manager.disconnect('human');
  now += 29_999;
  manager.tick(.01);
  assert.equal(manager.find('human'), room);
  assert.equal(room.arena.status, 'playing');
  now += 2;
  manager.tick(.01);
  assert.equal(manager.find('human'), undefined);
  assert.equal(manager.rooms.size, 0);
});

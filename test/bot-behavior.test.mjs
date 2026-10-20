import test from 'node:test';
import assert from 'node:assert/strict';
import { createArena, addPlayer, startRound, stepArena, DUST_COUNT, snapshotArena } from '../shared/engine.js';

function fixture({ enemy = false, cooldown = 0 } = {}) {
  const arena = createArena({ random: () => 0.99 });
  arena.status = 'playing';
  const bot = addPlayer(arena, { id: 'bot', bot: true });
  Object.assign(bot, { x: 6210, y: 4000, invulnerable: 100, cooldown });
  Object.assign(bot.cells[0], { x: bot.x, y: bot.y });
  if (enemy) {
    const p = addPlayer(arena, { id: 'strong-opponent' });
    Object.assign(p, { x: 6000, y: 4000, mass: 100, radius: 40, invulnerable: 100 });
    Object.assign(p.cells[0], { x: p.x, y: p.y, mass: p.mass, radius: p.radius });
  }
  arena.dust = Array.from({ length: DUST_COUNT }, (_, i) => ({ id: `far-${i}`,
    x: 1000 + (i % 100) * 4, y: 1000 + Math.floor(i / 100) * 4, value: 1 }));
  return { arena, bot };
}

function seeded(seed = 78237) {
  return () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
}

test('a weaker bot escapes a stronger opponent instead of oscillating across the chase/flee boundary', () => {
  const { arena, bot } = fixture({ enemy: true });
  let minimumDistance = Infinity;
  for (let i = 0; i < 600; i++) {
    stepArena(arena, 1 / 30);
    minimumDistance = Math.min(minimumDistance, bot.x - 6000);
    assert.ok(bot.input.x >= 0, 'the bot must not turn back toward the stronger opponent');
    assert.ok(bot.vx >= 0, 'the bot must not repeatedly reverse its physical velocity');
  }
  assert.ok(minimumDistance >= 210);
  assert.ok(bot.x - 6000 > 330);
  assert.equal(bot.mass, 36);
});

test('a bot with its wave on cooldown flees the enemy vector independently of the nearest food direction', () => {
  const { arena, bot } = fixture({ enemy: true, cooldown: 10 });
  bot.x = 6190; bot.cells[0].x = 6190;
  arena.dust.push({ id: 'tempting-food', x: 6190, y: 4150, value: 1 });
  stepArena(arena, 1 / 30);
  assert.ok(bot.input.x > .99);
  assert.ok(Math.abs(bot.input.y) < 1e-8);
});

test('foraging keeps a food-area waypoint when a nearer particle appears in another direction', () => {
  const { arena, bot } = fixture();
  arena.dust.push({ id: 'first-food', x: bot.x + 200, y: bot.y, value: 1 });
  stepArena(arena, 1 / 30);
  const target = { ...bot.botState.target };
  arena.dust.push({ id: 'new-nearer-food', x: bot.x, y: bot.y + 130, value: 1 });
  for (let i = 0; i < 9; i++) stepArena(arena, 1 / 30);
  assert.deepEqual(bot.botState.target, target);
  assert.ok(bot.input.x > .99);
  assert.ok(Math.abs(bot.input.y) < 1e-8);
  assert.ok(!('botState' in snapshotArena(arena).players[0]));
  startRound(arena);
  assert.equal(bot.botState, null);
});

test('real practice bots grow from natural dust without rapid alternating steering', t => {
  const arena = createArena({ random: seeded() });
  for (let i = 0; i < 5; i++) addPlayer(arena, { id: `practice-${i}`, bot: i > 0 });
  startRound(arena);
  const previous = new Map();
  let sharpTurns = 0, velocityReversals = 0, growthTicks = 0;
  for (let i = 0; i < 900; i++) {
    stepArena(arena, 1 / 30);
    for (const bot of arena.players.values()) if (bot.bot) {
      const old = previous.get(bot.id);
      if (old) {
        const length = Math.hypot(old.x, old.y) * Math.hypot(bot.input.x, bot.input.y);
        if (length > 1e-8 && old.x * bot.input.x + old.y * bot.input.y < 0) sharpTurns++;
        if (old.vx * bot.vx + old.vy * bot.vy < 0) velocityReversals++;
        if (bot.mass > old.mass) growthTicks++;
      }
      previous.set(bot.id, { ...bot.input, vx: bot.vx, vy: bot.vy, mass: bot.mass });
    }
  }
  t.diagnostic(`4 AI / 30s / 6,000 natural particles: >90° turns=${sharpTurns}, velocity reversals=${velocityReversals}, growth ticks=${growthTicks}`);
  assert.ok(growthTicks > 200, 'exercise actual collection and growth instead of a fixed-mass simulation');
  assert.ok(sharpTurns < 80, `too many abrupt target reversals: ${sharpTurns}`);
  assert.ok(velocityReversals < 15, `too many physical direction reversals: ${velocityReversals}`);
});


test('a fleeing bot counterattacks a larger opponent behind it after a short reaction delay', () => {
  const { arena, bot } = fixture({ enemy: true });
  const opponent = arena.players.get('strong-opponent');
  opponent.invulnerable = 0;
  for (let i = 0; i < 6; i++) stepArena(arena, 1 / 30);
  assert.equal(arena.blasts.length, 0, 'AI must not counterattack immediately on detecting a threat');
  for (let i = 0; i < 30 && !opponent.lastWaveHit; i++) stepArena(arena, 1 / 30);
  assert.ok(opponent.lastWaveHit, 'the bot demonstrates the rear-wave counter in actual training simulation');
  assert.equal(opponent.lastWaveHit.ownerId, bot.id);
  assert.equal(opponent.lastWaveHit.mode, 'rear');
  assert.ok(opponent.lastWaveHit.at - bot.botState.fleeSince >= .2);
  assert.ok(opponent.lastWaveHit.directionX < -.99);
  assert.ok(opponent.mass < 100);
  assert.equal(bot.mass, 36);
  assert.ok(bot.vx > 0, 'counterattacking does not accelerate or reverse the caster');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { ARENA, addPlayer, advanceSiblingFusion, applySiblingGravity, chooseUpgrade, createArena,
  setPlayerInput, siblingGravityRange, stepArena } from '../shared/engine.js';

const near = (actual, expected, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `${actual} should equal ${expected} within ${tolerance}`);
const total = cells => cells.reduce((result, cell) => ({ mass: result.mass + cell.mass,
  px: result.px + cell.mass * cell.vx, py: result.py + cell.mass * cell.vy,
  mx: result.mx + cell.mass * cell.x, my: result.my + cell.mass * cell.y,
}), { mass: 0, px: 0, py: 0, mx: 0, my: 0 });

function assertValidLinks(cells) {
  const byId = new Map(cells.map(cell => [cell.id, cell]));
  for (const cell of cells) {
    assert.ok(Number.isFinite(cell.mass) && cell.mass > 0 && Number.isFinite(cell.vx) && Number.isFinite(cell.vy));
    if (!cell.fusionId) continue;
    const partner = byId.get(cell.fusionPartnerId);
    assert.ok(partner, 'a fusion partner must remain present until its last mass is transferred');
    assert.equal(partner.fusionId, cell.fusionId); assert.equal(partner.fusionPartnerId, cell.id);
    assert.notEqual(partner.fusionRole, cell.fusionRole);
  }
}

function fixture(specs = [{ x: 2000, y: 2000, mass: 100 }]) {
  const arena = createArena({ endless: true, random: () => .99 });
  arena.status = 'playing';
  // Keep natural growth out of a motion/transfer measurement, including wall
  // fixtures. These particles remain real members of the normal spatial grid.
  arena.dust = Array.from({ length: 6000 }, (_, i) => ({ id: `fixture-dust-${i}`,
    x: 6000, y: 4000, value: 1, vx: 0, vy: 0 }));
  const player = addPlayer(arena, { id: 'siblings' });
  player.invulnerable = 0;
  player.cells = specs.map((spec, i) => ({ ...player.cells[0], id: `sibling-${i}`,
    mergeIn: 0, ...spec, radius: 4 * Math.sqrt(spec.mass) }));
  return { arena, player };
}

function advance(arena, duration, pattern = [1 / 30], onStep) {
  let elapsed = 0, index = 0;
  while (elapsed < duration - 1e-9) {
    const dt = Math.min(pattern[index++ % pattern.length], duration - elapsed);
    stepArena(arena, dt); elapsed += dt; onStep?.(dt);
  }
}

test('smaller planets reach a strictly faster ordinary speed, including all speed upgrade ranks', () => {
  for (let rank = 0; rank <= 4; rank++) {
    const speeds = [];
    for (const mass of [1, 9, 36, 144, 576]) {
      const { arena, player } = fixture([{ x: 2000, y: 2000, mass }]);
      for (let i = 0; i < rank; i++) {
        player.upgradeChoices = [{ id: 'speed' }]; player.upgradePending = 1;
        chooseUpgrade(arena, player.id, 'speed');
      }
      setPlayerInput(arena, player.id, { x: .6, y: .8 });
      advance(arena, 3);
      const [cell] = player.cells, speed = Math.hypot(cell.vx, cell.vy);
      speeds.push(speed); near(cell.vx / cell.vy, .75);
      if (mass === 36) near(speed, 210 * (1 + .1 * rank), .001);
    }
    for (let i = 1; i < speeds.length; i++) assert.ok(speeds[i - 1] > speeds[i] + 1,
      `rank ${rank}: reducing mass must materially increase movement speed`);
  }
});

test('a solitary body and separate opponent bodies receive no sibling gravity', () => {
  const single = fixture([{ x: 2000, y: 2000, mass: 36 }]);
  advance(single.arena, 1);
  near(single.player.x, 2000); near(single.player.y, 2000); near(single.player.vx, 0); near(single.player.vy, 0);
  const { arena, player } = fixture([{ x: 2000, y: 2000, mass: 36 }]);
  const opponent = addPlayer(arena, { id: 'opponent' }); opponent.invulnerable = 10;
  Object.assign(opponent.cells[0], { x: 2150, y: 2000, vx: 0, vy: 0 });
  advance(arena, 1);
  near(player.x, 2000); near(player.y, 2000); near(opponent.x, 2150); near(opponent.y, 2000);
  assert.equal(player.cells.length, 1); assert.equal(opponent.cells.length, 1);
});

test('a normally launched split returns and gradually fuses after release and during continuous diagonal flight', () => {
  for (const held of [false, true]) {
    const { arena, player } = fixture([{ x: 2000, y: 2000, mass: 144 }]);
    setPlayerInput(arena, player.id, { x: .6, y: .8, split: true });
    stepArena(arena, 1 / 30);
    assert.equal(player.cells.length, 2);
    const [parent, launched] = player.cells;
    assert.ok((launched.vx - parent.vx) * .6 + (launched.vy - parent.vy) * .8 > 200,
      'manual split must retain a useful forward launch');
    setPlayerInput(arena, player.id, held ? { x: .6, y: .8 } : {});
    let gradualFrames = 0, maximumSeparation = 0, last = total(player.cells), finalMergeJump = null;
    advance(arena, 30, [1 / 30], dt => {
      const current = total(player.cells);
      near(current.mass, 144);
      if (player.cells.length === 2) {
        maximumSeparation = Math.max(maximumSeparation, Math.hypot(player.cells[0].x - player.cells[1].x, player.cells[0].y - player.cells[1].y));
        if (player.cells.some(cell => cell.mass < 71.99)) gradualFrames++;
      } else if (finalMergeJump === null) {
        const dx = current.mx / current.mass - last.mx / last.mass;
        const dy = current.my / current.mass - last.my / last.mass;
        finalMergeJump = Math.hypot(dx, dy);
        assert.ok(finalMergeJump <= Math.max(Math.hypot(last.px, last.py) / last.mass,
          Math.hypot(current.px, current.py) / current.mass) * dt + .05,
        'removing the last donor must not teleport the mass centroid');
      }
      last = current;
    });
    assert.ok(maximumSeparation > 100, 'the two halves must actually separate before returning');
    assert.ok(gradualFrames >= 3, 'fusion must transfer mass over multiple visible frames');
    assert.equal(player.cells.length, 1, held ? 'held input must not leave siblings separated forever' : 'released halves must return without steering');
    assert.ok(finalMergeJump !== null);
  }
});

test('near siblings attract from rest but sufficiently distant siblings remain independent', () => {
  for (const distance of [150, 2500]) {
    const { arena, player } = fixture([{ x: 2000, y: 2000, mass: 36 }, { x: 2000 + distance, y: 2000, mass: 36 }]);
    advance(arena, 1);
    const gap = Math.hypot(player.cells[0].x - player.cells[1].x, player.cells[0].y - player.cells[1].y);
    if (distance === 150) assert.ok(gap < 149, 'nearby siblings must begin closing their separation while controls are released');
    else { near(gap, distance); near(player.cells[0].vx, 0); near(player.cells[1].vx, 0); }
  }
});

test('sibling attraction and progressive transfer conserve mass and both momentum axes apart from ordinary drag', () => {
  for (const separation of [56, 150]) {
    const { arena, player } = fixture([
      { x: 2000, y: 2000, mass: 36, vx: 125, vy: -90 },
      { x: 2000 + separation * .6, y: 2000 + separation * .8, mass: 64, vx: 85, vy: -40 },
    ]);
    const before = total(player.cells);
    let elapsed = 0;
    advance(arena, .3, [1 / 30, 1 / 60, .075, .01], dt => {
      elapsed += dt;
      const current = total(player.cells), decay = Math.exp(-2 * elapsed);
      near(current.mass, before.mass);
      near(current.px, before.px * decay, 1e-5); near(current.py, before.py * decay, 1e-5);
      near(current.mx, before.mx + before.px * (1 - decay) / 2, .001);
      near(current.my, before.my + before.py * (1 - decay) / 2, .001);
    });
    if (separation === 56) assert.ok(player.cells.some(cell => cell.mass < 35.99),
      'the conservation measurement must include actual gradual mass transfer');
  }
});

test('unequal siblings reunite while moving instead of the smaller faster donor escaping', () => {
  const { arena, player } = fixture([
    { x: 2000, y: 2000, mass: 100 },
    { x: 2072, y: 2096, mass: 12 },
  ]);
  setPlayerInput(arena, player.id, { x: .6, y: .8 });
  let transferred = false;
  advance(arena, 15, [1 / 30, .08, 1 / 60], () => {
    near(total(player.cells).mass, 112);
    if (player.cells.length === 2 && player.cells.some(cell => cell.mass < 11.99)) transferred = true;
  });
  assert.ok(transferred, 'the initially smaller leading sibling must progressively feed its receiver');
  assert.equal(player.cells.length, 1);
});

test('two through eight siblings finish fusion at a wall corner under coarse and jittered time steps', () => {
  for (const count of [2, 3, 4, 8]) for (const pattern of [[.1], [1 / 60, .09, 1 / 30, .012]]) {
    const { arena, player } = fixture(Array.from({ length: count }, (_, index) => ({
      x: 24 + (index % 4) * 54, y: 24 + Math.floor(index / 4) * 54, mass: 36,
    })));
    let maxStep = 0;
    const previous = new Map(player.cells.map(cell => [cell.id, { x: cell.x, y: cell.y }]));
    advance(arena, 20, pattern, dt => {
      near(total(player.cells).mass, count * 36);
      for (const cell of player.cells) {
        assert.ok(Number.isFinite(cell.x) && Number.isFinite(cell.y) && Number.isFinite(cell.vx) && Number.isFinite(cell.vy));
        near(cell.radius, 4 * Math.sqrt(cell.mass));
        assert.ok(cell.x >= cell.radius - 1e-6 && cell.x <= ARENA.width - cell.radius + 1e-6);
        assert.ok(cell.y >= cell.radius - 1e-6 && cell.y <= ARENA.height - cell.radius + 1e-6);
        const last = previous.get(cell.id);
        if (last) {
          const displacement = Math.hypot(cell.x - last.x, cell.y - last.y);
          maxStep = Math.max(maxStep, displacement);
          assert.ok(displacement < 1000 * dt + 2, 'fusion must not relocate a surviving body in a single large jump');
        }
        previous.set(cell.id, { x: cell.x, y: cell.y });
      }
    });
    assert.equal(player.cells.length, 1, `${count} siblings must not leave an unpaired permanent core at the corner`);
    assert.ok(maxStep < 102);
  }
});

test('fast approaching sibling circles remain solid during their launch grace period', () => {
  for (const pattern of [[.1], [1 / 60, .09, .01]]) {
    const { arena, player } = fixture([
      { x: 2000, y: 2000, mass: 36, vx: 650, mergeIn: .9 },
      { x: 2100, y: 2000, mass: 36, vx: -650, mergeIn: .9 },
    ]);
    advance(arena, .3, pattern, () => {
      assert.equal(player.cells.length, 2);
      const [a, b] = player.cells;
      assert.ok(a.x <= b.x, 'siblings must not tunnel through and swap sides before fusion is allowed');
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= a.radius + b.radius - 1e-5);
      near(total(player.cells).mass, 72);
    });
  }
});

test('internal fusion conserves both momentum axes and the centroid at every transfer and leaves unrelated siblings alone', () => {
  const { player } = fixture([
    { x: 2000, y: 2000, mass: 25, vx: 140, vy: -95 },
    { x: 2020 + 4 * Math.sqrt(75), y: 2000, mass: 75, vx: -30, vy: 65 },
    { x: 4500, y: 1700, mass: 36, vx: 15, vy: -8 },
  ]);
  const before = total(player.cells), spectator = { ...player.cells[2] };
  advanceSiblingFusion(player.cells, 0);
  assert.ok(player.cells[0].fusionId && player.cells[0].fusionId === player.cells[1].fusionId);
  let partialSteps = 0;
  for (let elapsed = 0, index = 0; elapsed < 1.5;) {
    const dt = Math.min([.1, .012, .075][index++ % 3], 1.5 - elapsed); elapsed += dt;
    advanceSiblingFusion(player.cells, dt);
    const current = total(player.cells);
    near(current.mass, before.mass); near(current.px, before.px); near(current.py, before.py);
    near(current.mx, before.mx); near(current.my, before.my);
    if (player.cells.length === 3) partialSteps++;
  }
  assert.ok(partialSteps >= 8); assert.equal(player.cells.length, 2);
  const unchanged = player.cells.find(cell => cell.id === spectator.id);
  for (const property of ['x', 'y', 'vx', 'vy', 'mass', 'radius']) near(unchanged[property], spectator[property]);
});

test('the finite gravity boundary has real force immediately inside and exactly no force outside', () => {
  for (const side of [-1, 1]) {
    const { player } = fixture([
      { x: 2000, y: 2000, mass: 25, vx: 120, vy: -90 },
      { x: 2150, y: 2000, mass: 75, vx: -30, vy: 65 },
    ]);
    const [a, b] = player.cells, distance = siblingGravityRange(a, b) + side * .001;
    b.x = a.x + distance * .6; b.y = a.y + distance * .8;
    const before = total(player.cells), previousA = { vx: a.vx, vy: a.vy }, previousB = { vx: b.vx, vy: b.vy };
    applySiblingGravity(player.cells, 1 / 120);
    const current = total(player.cells);
    near(current.px, before.px); near(current.py, before.py);
    if (side > 0) {
      near(a.vx, previousA.vx); near(a.vy, previousA.vy); near(b.vx, previousB.vx); near(b.vy, previousB.vy);
    } else {
      assert.ok(a.vx > previousA.vx && a.vy > previousA.vy);
      assert.ok(b.vx < previousB.vx && b.vy < previousB.vy);
    }
  }
});

test('a wave may chip and push either member of an active fusion without losing mass or orphaning its partner', () => {
  for (const role of ['receiver', 'donor']) {
    const { arena, player } = fixture([
      { x: 2000, y: 2000, mass: 80 },
      { x: 2000 + 4 * (Math.sqrt(80) + Math.sqrt(40)), y: 2000, mass: 40 },
    ]);
    advance(arena, .25);
    const hit = player.cells.find(cell => cell.fusionRole === role);
    assert.ok(hit, 'the wave must arrive during a real progressive fusion');
    const direction = role === 'receiver' ? 1 : -1;
    const caster = addPlayer(arena, { id: 'wave-caster' }); caster.invulnerable = 10;
    Object.assign(caster.cells[0], { x: hit.x - direction * 200, y: hit.y, vx: 0, vy: 0 });
    caster.direction = { x: direction, y: 0 };
    setPlayerInput(arena, caster.id, { fire: true });
    for (let tick = 0; tick < 20 && !player.lastWaveHit; tick++) stepArena(arena, 1 / 30);
    assert.ok(player.lastWaveHit?.hitCellIds.includes(hit.id), `the wave must actually hit the ${role}`);
    assert.ok(player.lastWaveHit.lostMass > 0);
    let sawFragments = false;
    advance(arena, 8, [1 / 30, .08, .01], () => {
      assertValidLinks(player.cells);
      const free = arena.dust.filter(dust => dust.fragment);
      sawFragments ||= free.length > 0;
      const bodies = [...arena.players.values()].reduce((mass, p) => mass + p.mass, 0);
      near(bodies + free.reduce((mass, dust) => mass + dust.value, 0), 156);
      for (const cell of player.cells) assert.ok(Number.isFinite(cell.x) && Number.isFinite(cell.y));
    });
    assert.ok(sawFragments); assert.equal(player.cells.length, 1);
    assert.equal(player.cells[0].fusionId, null);
  }
});

test('splitting during fusion cancels old links and a subsequent eight-cell launch still reunites safely', () => {
  const { arena, player } = fixture([
    { x: 2000, y: 2000, mass: 144 }, { x: 2096, y: 2000, mass: 144 },
  ]);
  advance(arena, .25);
  const oldLink = player.cells[0].fusionId;
  assert.ok(oldLink);
  for (let action = 0; action < 2; action++) {
    setPlayerInput(arena, player.id, { x: .6, y: .8, split: true }); stepArena(arena, 1 / 30);
    assert.ok(player.cells.length > 2 && player.cells.length <= 8);
    assert.ok(player.cells.every(cell => cell.fusionId !== oldLink));
    assertValidLinks(player.cells); near(total(player.cells).mass, 288);
    setPlayerInput(arena, player.id, {}); stepArena(arena, 0);
  }
  assert.equal(player.cells.length, 8);
  advance(arena, 25, [1 / 60, .1, 1 / 30, .012], () => {
    assertValidLinks(player.cells); near(total(player.cells).mass, 288);
    assert.ok(player.cells.length <= 8);
  });
  assert.equal(player.cells.length, 1, 'safe cancellation must still allow all relaunched siblings to return and fuse');
});

test('a growing fusion stays solid against an opponent both in open space and along a corner wall', () => {
  for (const [x, y] of [[1000, 1000], [24, 24]]) {
    const { arena, player } = fixture([{ x, y, mass: 36 }, { x: x + 50, y, mass: 36 }]);
    const opponent = addPlayer(arena, { id: 'solid-opponent' });
    player.invulnerable = opponent.invulnerable = 1000;
    Object.assign(opponent.cells[0], { x: x + 100, y, vx: 0, vy: 0 });
    setPlayerInput(arena, player.id, { x: 1, y: 0 });
    for (let tick = 0; tick < 300; tick++) {
      stepArena(arena, [.1, .033, .05][tick % 3]);
      assertValidLinks(player.cells); near(total(player.cells).mass, 72); near(opponent.mass, 36);
      for (const cell of player.cells) for (const other of opponent.cells) {
        assert.ok(Math.hypot(cell.x - other.x, cell.y - other.y) >= cell.radius + other.radius - 1e-5,
          'progressive radius growth may not penetrate a third-party body');
        assert.ok(Number.isFinite(cell.x) && Number.isFinite(cell.y));
      }
    }
    assert.equal(player.cells.length, 1); assert.equal(opponent.cells.length, 1);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { addPlayer, advanceSiblingFusion, createArena, setPlayerInput, snapshotArena, stepArena } from '../shared/engine.js';

const source = await readFile(process.env.PLANET_TIMELINE_CLIENT_PATH || new URL('../public/game.js', import.meta.url), 'utf8');
const near = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `${actual} should equal ${expected} within ${tolerance}`);

function state(players, time = 0) {
  const arena = createArena(); arena.status = 'playing';
  for (const spec of players) {
    const p = addPlayer(arena, { id: spec.id });
    Object.assign(p.cells[0], { x: spec.x, y: spec.y ?? 4000, vx: spec.vx ?? 0, vy: spec.vy ?? 0 });
    Object.assign(p, { x: spec.x, y: spec.y ?? 4000, vx: spec.vx ?? 0, vy: spec.vy ?? 0 });
    setPlayerInput(arena, p.id, { x: spec.steerX ?? 0, y: spec.steerY ?? 0 });
  }
  arena.time = time / 1000;
  return { code: 'TIMELINE', ...snapshotArena(arena) };
}

function client() {
  let clock = 0;
  const drawing = new Proxy({}, { get: () => () => {}, set: () => true });
  const context = vm.createContext({ innerWidth: 1280, innerHeight: 800, window: { timelineDrawing: drawing },
    document: { hidden: false }, performance: { now: () => clock }, requestAnimationFrame() {}, WebSocket: { OPEN: 1 } });
  const hooks = `window.timelineTest={
    start(state,ping=0){active=true;myId='pilot';rtt=ping;ctx=window.timelineDrawing;
      ingestSnapshot(state,performance.now());room=state;cacheWaveVisuals(state,null);
      drawBackground=drawArena=drawMinimap=drawPlanet=drawDust=drawMeteor=drawWaveFeedback=updateHud=()=>{};},
    packet(state){const previous=room;ingestSnapshot(state,performance.now());room=state;cacheWaveVisuals(state,previous);},
    frame(dt){predictOwn(dt,performance.now());},
    render(at){render(at);return this.own();},
    hold(code){keys.clear();if(code)keys.add(code);},
    lagCamera(){const p=[...predictedCells.values()][0];camera={x:p.x-p.model.vx/9,y:p.y-p.model.vy/9,scale:.95,targetX:p.x,targetY:p.y};},
    own(){const p=[...predictedCells.values()][0],view=getCamera();return{x:p.x,y:p.y,model:{...p.model},modelAt:p.modelAt,authorityAt:p.authorityAt,cameraX:view.x,cameraY:view.y,
      screenX:p.x*view.scale+view.offsetX,screenY:p.y*view.scale+view.offsetY,scale:view.scale};},
    remote(key){return remotePhysics.get(key);},
    ownCell(id){return predictedCells.get(id);},
    effective(playerId,cellId){const p=room.players.find(p=>p.id===playerId),c=p?.cells.find(c=>c.id===cellId);return c?effectiveCell(p,c,performance.now()):null;},
    wavePositions(){return Object.fromEntries(room.blasts.map(b=>[b.ownerId,wavePose(b,performance.now()).x]));},
    island(key,value){const p=remotePhysics.get(key);p.island=value;p.islandUntil=value?performance.now()+10000:0;},
  };`;
  const instrumented = source.replace('  window.StarGame = {', `${hooks}\n  window.StarGame = {`);
  assert.notEqual(instrumented, source);
  vm.runInContext(instrumented, context, { filename: 'public/game.js' });
  return { api: context.window.timelineTest, time: value => { clock = value; } };
}

test('a remote planet passing through the contact area keeps continuous forward speed at both 60 and 120 FPS', () => {
  for (const fps of [60, 120]) {
    const initial = state([{ id: 'pilot', x: 2000, y: 2000 }, { id: 'other', x: 1500, y: 2100, vx: 210, steerX: 1 }]);
    const key = `other:${initial.players[1].cells[0].id}`, c = client();
    c.time(180); c.api.start(initial, 360);
    let previous, switches = 0;
    for (let frame = 1; frame <= fps * 5; frame++) {
      const elapsed = frame * 1000 / fps; c.time(180 + elapsed);
      if (frame % (fps / 15) === 0) {
        const next = structuredClone(initial); next.time = elapsed / 1000; next.simulationTime = elapsed;
        next.players[1].cells[0].x = 1500 + .21 * elapsed; c.api.packet(next);
      }
      c.api.frame(1 / fps);
      const p = c.api.remote(key), row = { x: p.visual.x, modelX: p.model.x, island: p.island };
      if (previous) {
        if (row.island !== previous.island) switches++;
        if (frame > fps) {
          near((row.modelX - previous.modelX) * fps, 210, .01);
          near((row.x - previous.x) * fps, 210, 1);
        }
      }
      previous = row;
    }
    assert.ok(switches >= 2, 'the path must actually enter and leave the contact area without colliding');
  }
});

test('after a 500ms frame gap the camera follows the same elapsed inertial path without a screen jump or recovery sprint', () => {
  const initial = state([{ id: 'pilot', x: 6000, vx: 210, steerX: 1 }], 1000), c = client();
  c.time(1000); c.api.start(initial); c.api.hold('ArrowRight'); c.api.lagCamera(); c.api.render(1000);
  for (const at of [1000 + 1000 / 60, 1000 + 2000 / 60, 1050]) { c.time(at); c.api.render(at); }
  const before = c.api.own(); c.time(1550); const after = c.api.render(1550);
  near(after.x - before.x, 105, .01); near(after.cameraX - before.cameraX, 105, .01);
  near(after.screenX, before.screenX, .02); near(after.screenY, before.screenY, .02);
  c.time(1550 + 1000 / 60); const next = c.api.render(1550 + 1000 / 60);
  near((next.cameraX - after.cameraX) * 60, 210, .1);
  near(next.screenX, before.screenX, .02);
});

test('the complete path following a 500ms gap remains inside continuous solid-body collision detection', () => {
  const initial = state([{ id: 'pilot', x: 6000, vx: 2400 }, { id: 'other', x: 6150 }], 1000), c = client();
  const remoteKey = `other:${initial.players[1].cells[0].id}`;
  c.time(1000); c.api.start(initial); c.api.lagCamera(); c.api.render(1000);
  c.time(1500); const own = c.api.render(1500), remote = c.api.remote(remoteKey);
  assert.ok(own.model.x < remote.model.x, 'catching up an old model must not bypass the solid-body solver');
  assert.ok(own.x < remote.visual.x, 'the visible bodies must retain the same side of the contact');
  assert.ok(Math.hypot(own.x - remote.visual.x, own.y - remote.visual.y) >= 48 - .03);
});

test('arrival jitter cannot move own, nearby or far wave heads backwards or create a next-frame catch-up pulse', () => {
  const initial = state([{ id: 'pilot', x: 6000 }, { id: 'near-owner', x: 6200, y: 4100 }, { id: 'far-owner', x: 1000, y: 2000 }], 1000);
  initial.blasts = initial.players.map(player => ({ id: `${player.id}-wave`, ownerId: player.id,
    kind: 'wave', x: 2100, y: 4000, originX: 2000, originY: 4000, directionX: 1, directionY: 0,
    speed: 600, distance: 420, travel: 100, width: 160, curvature: 30, thickness: 20 }));
  const c = client(); c.time(1180); c.api.start(initial, 360); c.api.render(1180);
  c.time(1260); c.api.render(1260); const before = c.api.wavePositions();
  const next = structuredClone(initial); next.time = 1 + 1 / 15; next.simulationTime = 1000 + 1000 / 15;
  for (const blast of next.blasts) { blast.travel = 140; blast.x = 2140; }
  c.api.packet(next); const after = c.api.wavePositions();
  for (const owner of Object.keys(before)) near(after[owner], before[owner], .01);
  c.time(1260 + 1000 / 60); c.api.render(1260 + 1000 / 60); const following = c.api.wavePositions();
  for (const owner of Object.keys(before)) near((following[owner] - after[owner]) * 60, 600, 12);
});

test('remote donor geometry shares the continuous model clock, shrinks gradually and never revives from older snapshots', () => {
  const arena = createArena({ random: () => .99 }); arena.status = 'playing';
  const pilot = addPlayer(arena, { id: 'pilot' }), remote = addPlayer(arena, { id: 'remote' });
  Object.assign(pilot.cells[0], { x: 6000, y: 4000 });
  Object.assign(remote.cells[0], { x: 1000, y: 2000, mass: 60, radius: 4 * Math.sqrt(60) });
  remote.cells.push({ ...remote.cells[0], id: 'donor', x: 1000 + 4 * (Math.sqrt(60) + Math.sqrt(12)), mass: 12, radius: 4 * Math.sqrt(12) });
  arena.dust = Array.from({ length: 6000 }, (_, id) => ({ id: `far-${id}`, x: 11000, y: 7000, value: 1 }));
  advanceSiblingFusion(remote.cells, 0); stepArena(arena, 0);
  const snapshot = () => ({ code: 'FUSION-CLOCK', ...snapshotArena(arena) }), c = client();
  c.time(180); c.api.start(snapshot(), 360);
  const donorKey = 'remote:donor';
  let previousMass = Infinity, visibleFrames = 0, consumed = false;
  for (let frame = 1; frame <= 90; frame++) {
    c.time(180 + frame * 1000 / 60);
    if (frame % 2 === 0) stepArena(arena, 1 / 30);
    if (frame % 4 === 0) c.api.packet(snapshot());
    c.api.frame(1 / 60);
    const proxy = c.api.remote(donorKey), effective = c.api.effective(remote.id, 'donor');
    if (effective) {
      assert.ok(!consumed, 'a packet carrying an older donor must not revive an already consumed visual');
      near(effective.mass, proxy.model.mass); near(effective.radius, 4 * Math.sqrt(proxy.model.mass));
      assert.ok(effective.mass <= previousMass + .005);
      if (previousMass !== Infinity) assert.ok(previousMass - effective.mass < .4, 'mass should transfer over visible frames');
      previousMass = effective.mass; visibleFrames++;
      c.api.island(donorKey, !proxy.island);
      near(c.api.effective(remote.id, 'donor').mass, effective.mass);
    } else consumed = true;
  }
  assert.ok(visibleFrames >= 40 && consumed);
});

test('an asynchronous impulse on one fusing core does not restart the pair while the older sibling catches up', () => {
  const arena = createArena({ random: () => .99 }); arena.status = 'playing';
  const p = addPlayer(arena, { id: 'pilot' }), receiver = p.cells[0];
  p.invulnerable = 0;
  Object.assign(receiver, { x: 6000, y: 4000, mass: 60, radius: 4 * Math.sqrt(60) });
  p.cells.push({ ...receiver, id: 'donor', x: 6000 + 4 * (Math.sqrt(60) + Math.sqrt(12)), mass: 12, radius: 4 * Math.sqrt(12) });
  p.cells.push({ ...receiver, id: 'unrelated', x: 9000, y: 6000, mass: 9, radius: 12, vx: 24, vy: -11 });
  arena.dust = Array.from({ length: 6000 }, (_, id) => ({ id: `far-${id}`, x: 11000, y: 7000, value: 1 }));
  advanceSiblingFusion(p.cells, 0); stepArena(arena, 0);
  const snapshot = () => ({ code: 'FUSION-IMPULSE', ...snapshotArena(arena) }), c = client();
  c.api.start(snapshot(), 20); c.time(100); c.api.frame(.1); stepArena(arena, .1);
  const before = { ...c.api.ownCell(receiver.id).model };
  const donorBefore = { ...c.api.ownCell('donor').model }, unrelatedBefore = { ...c.api.ownCell('unrelated').model };
  const unrelatedAt = c.api.ownCell('unrelated').modelAt;
  // A meteor is applied after the server's body phase. Only the impacted
  // receiver carries new momentum in this packet; the pair couples next step.
  const lostMass = receiver.mass * .12;
  receiver.mass -= lostMass; receiver.radius = 4 * Math.sqrt(receiver.mass); receiver.vx = 20;
  receiver.lastMeteorHitId = 'meteor-pair-clock'; p.collisionRevision++;
  p.lastMeteorHit = { id: receiver.lastMeteorHitId, meteorId: 'meteor', at: .1,
    cellId: receiver.id, hitCellIds: [receiver.id], x: receiver.x - receiver.radius, y: receiver.y,
    directionX: 1, directionY: 0, impulse: 20, lostMass, meteorFragmentMass: 4, protected: false };
  p.mass = p.cells.reduce((mass, cell) => mass + cell.mass, 0);
  c.time(110); c.api.packet(snapshot());
  const pairedReceiver = c.api.ownCell(receiver.id), pairedDonor = c.api.ownCell('donor'), unrelated = c.api.ownCell('unrelated');
  near(pairedReceiver.model.x, before.x); near(pairedReceiver.model.y, before.y);
  near(pairedDonor.model.x, donorBefore.x); near(pairedDonor.model.y, donorBefore.y);
  near(pairedDonor.model.vx, donorBefore.vx); near(pairedDonor.model.vy, donorBefore.vy);
  near(pairedReceiver.modelAt, pairedDonor.modelAt);
  near(unrelated.modelAt, unrelatedAt);
  near(unrelated.model.x, unrelatedBefore.x); near(unrelated.model.y, unrelatedBefore.y);
  near(unrelated.model.vx, unrelatedBefore.vx); near(unrelated.model.vy, unrelatedBefore.vy);
  c.time(100 + 1000 / 60); c.api.frame(1 / 60);
  const after = c.api.ownCell(receiver.id).model, donor = c.api.ownCell('donor').model;
  assert.equal(after.fusionId, before.fusionId); assert.equal(donor.fusionId, after.fusionId);
  assert.ok(after.fusionTime <= before.fusionTime + 1e-6, 'temporarily different model timestamps must not reset a live fusion timer');
  assert.ok(after.fusionProgress >= before.fusionProgress - 1e-6);
  near(after.mass + donor.mass + c.api.ownCell('unrelated').model.mass, p.mass, .01);
});

test('a stale connection resumes a fresh prediction epoch without replaying or teleporting through the unseen interval', () => {
  const initial = state([{ id: 'pilot', x: 6000, vx: 150, steerX: 1 }], 1000), c = client();
  c.time(1000); c.api.start(initial); c.api.hold('ArrowRight'); c.api.lagCamera(); c.api.render(1000);
  c.time(1100); const moving = c.api.render(1100);
  c.time(1800); const paused = c.api.render(1800);
  near(paused.x, moving.x); near(paused.y, moving.y);
  const next = structuredClone(initial), authoritativeX = 6000 + 210 * 2.01 - 10 * (1 - Math.exp(-6 * 2.01));
  next.time = 3.01; next.simulationTime = 3010;
  Object.assign(next.players[0], { x: authoritativeX, vx: 210 });
  Object.assign(next.players[0].cells[0], { x: authoritativeX, vx: 210 });
  assert.ok(authoritativeX - initial.players[0].cells[0].x > 350, 'the fixture crosses the ordinary relocation threshold during a legitimate outage');
  c.time(3010); c.api.packet(next);
  near(c.api.own().x, paused.x, 1e-6);
  const resumeAt = 3010 + 1000 / 60; c.time(resumeAt); const resumed = c.api.render(resumeAt);
  near(resumed.x, paused.x, .001); near(resumed.model.vx, 210, .001);
  assert.ok(resumed.modelAt >= resumeAt - 1e-6, 'the fresh model must not retain the stale simulation timestamp');
  c.time(resumeAt + 1000 / 60); const following = c.api.render(resumeAt + 1000 / 60);
  assert.ok(following.x > resumed.x && following.x - resumed.x <= 4.01,
    'resuming correction must preserve ordinary movement instead of catching up seconds of unseen travel');
  near(following.y, paused.y);
});

test('ordered 80 to 180ms arrival jitter cannot imprint large speed kicks on a free remote planet', () => {
  for (const fps of [60, 120]) {
    const initial = state([{ id: 'pilot', x: 2000, y: 2000 }, { id: 'other', x: 1500, y: 2100, vx: 210, steerX: 1 }]);
    const key = `other:${initial.players[1].cells[0].id}`, c = client(), packets = [];
    const delays = [80, 180, 90, 170, 100, 160, 110, 150, 120, 140, 130, 90];
    let lastDelivery = 0;
    for (let tick = 1; tick <= 120; tick++) {
      const generated = tick * 1000 / 15, delivery = Math.max(lastDelivery + 1, generated + delays[(tick - 1) % delays.length]);
      lastDelivery = delivery;
      const next = structuredClone(initial); next.time = generated / 1000; next.simulationTime = generated;
      next.players[1].cells[0].x = 1500 + .21 * generated; next.players[1].x = next.players[1].cells[0].x;
      packets.push({ delivery, state: next });
    }
    c.time(130); c.api.start(initial, 260);
    let previousX, previousSpeed;
    for (let frame = 1; frame <= fps * 8; frame++) {
      const at = 130 + frame * 1000 / fps;
      while (packets[0]?.delivery <= at) {
        const packet = packets.shift(); c.time(packet.delivery); c.api.packet(packet.state);
      }
      c.time(at); c.api.frame(1 / fps);
      const proxy = c.api.remote(key), speed = previousX === undefined ? 210 : (proxy.visual.x - previousX) * fps;
      if (frame > fps * 2) {
        near(proxy.model.vx, 210, .01);
        assert.ok(speed >= 170 && speed <= 250, `FIFO arrival jitter changed the rendered speed to ${speed} at ${fps} FPS`);
        if (previousSpeed !== undefined) assert.ok(Math.abs(speed - previousSpeed) < 15,
          `ordinary state delivery created a ${Math.abs(speed - previousSpeed)} speed kick at ${fps} FPS`);
      }
      previousX = proxy.visual.x; previousSpeed = speed;
    }
  }
});

test('two distant opponents shown on the current clock remain solid under fixed and jittered state delivery', () => {
  const arena = createArena({ random: () => .99 }); arena.status = 'playing';
  for (const [id, x, vx] of [['pilot', 2000, 0], ['left', 6000, 210], ['right', 6100, -210]]) {
    const player = addPlayer(arena, { id }); player.invulnerable = 1000;
    Object.assign(player.cells[0], { x, y: 4000, vx, vy: 0 });
    setPlayerInput(arena, id, { x: Math.sign(vx), y: 0 });
  }
  arena.dust = Array.from({ length: 6000 }, (_, id) => ({ id: `far-${id}`, x: 11000, y: 7000, value: 1 }));
  const snapshot = () => ({ code: 'FAR-CONTACT', ...snapshotArena(arena) });
  const initial = snapshot(), snapshots = [];
  for (let tick = 1; tick <= 90; tick++) {
    stepArena(arena, 1 / 30);
    if (tick % 2 === 0) snapshots.push({ generated: tick * 1000 / 30, state: snapshot() });
  }
  const leftKey = `left:${initial.players.find(player => player.id === 'left').cells[0].id}`;
  const rightKey = `right:${initial.players.find(player => player.id === 'right').cells[0].id}`;
  for (const fps of [60, 120]) for (const jitter of [false, true]) {
    const c = client(), delays = jitter ? [80, 180, 90, 170, 100, 160, 110, 150, 120, 140, 130, 90] : [130];
    let lastDelivery = 130;
    const packets = snapshots.map((packet, index) => {
      const delivery = Math.max(lastDelivery + 1, packet.generated + delays[index % delays.length]);
      lastDelivery = delivery;
      return { delivery, state: structuredClone(packet.state) };
    });
    c.time(130); c.api.start(structuredClone(initial), 260);
    for (let frame = 1; frame <= fps * 3; frame++) {
      const at = 130 + frame * 1000 / fps;
      while (packets[0]?.delivery <= at) {
        const packet = packets.shift(); c.time(packet.delivery); c.api.packet(packet.state);
      }
      c.time(at); c.api.frame(1 / fps);
      const left = c.api.remote(leftKey), right = c.api.remote(rightKey);
      const own = c.api.own();
      assert.ok(Math.abs(left.model.x - own.model.x) > 3000 && Math.abs(right.model.x - own.model.x) > 3000,
        'the collision must remain far outside the local contact area');
      for (const [a, b, label] of [[left.model, right.model, 'model'], [left.visual, right.visual, 'visible']]) {
        assert.ok(a.x < b.x, `${label} opponents crossed at ${fps} FPS with jitter=${jitter}`);
        const gap = Math.hypot(a.x - b.x, a.y - b.y) - left.model.radius - right.model.radius;
        assert.ok(gap >= -.03, `${label} distant bodies overlapped by ${-gap} at ${fps} FPS with jitter=${jitter}`);
      }
      near(left.model.mass + right.model.mass, 72);
    }
  }
});

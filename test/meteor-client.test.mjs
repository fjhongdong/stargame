import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createArena, addPlayer, stepArena, snapshotArena } from '../shared/engine.js';

const source = await readFile(new URL('../public/game.js', import.meta.url), 'utf8');
const near = (actual, expected, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} should equal ${expected}`);
const flight = (id = 'meteor', extra = {}) => ({ id, x: 6000, y: 4000, vx: 360, vy: 480,
  radius: 4, tailLength: 84, color: '#ffc987', bornAt: 0, ...extra });
const state = (time, meteors, extra = {}) => ({ code: 'METEOR', round: 1, status: 'playing', endless: true,
  time, simulationTime: time * 1000, players: [], dust: [], blasts: [], meteors, ...extra });

function client() {
  let clock = 0, transform = { x: 0, y: 0, angle: 0 };
  const nodes = new Map(), stack = [], drawing = [];
  const point = (x, y) => ({ x: transform.x + x * Math.cos(transform.angle) - y * Math.sin(transform.angle),
    y: transform.y + x * Math.sin(transform.angle) + y * Math.cos(transform.angle) });
  const context2d = new Proxy({
    save() { stack.push({ ...transform }); }, restore() { transform = stack.pop() || { x: 0, y: 0, angle: 0 }; },
    translate(x, y) { Object.assign(transform, point(x, y)); }, rotate(angle) { transform.angle += angle; },
    moveTo(x, y) { drawing.push({ kind: 'move', ...point(x, y) }); },
    lineTo(x, y) { drawing.push({ kind: 'line', ...point(x, y) }); },
    arc(x, y, radius) { drawing.push({ kind: 'arc', radius, ...point(x, y) }); },
  }, { get: (target, key) => target[key] || (() => {}), set: (target, key, value) => { target[key] = value; return true; } });
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { hidden: true, textContent: '', dataset: {}, style: {}, classList: { add() {}, remove() {} } });
    return nodes.get(id);
  };
  const context = vm.createContext({ innerWidth: 1280, innerHeight: 800,
    window: {}, document: { getElementById: node, body: { style: {}, dataset: {} } },
    performance: { now: () => clock }, WebSocket: { OPEN: 1 }, requestAnimationFrame() {}, cancelAnimationFrame() {},
    setTimeout() { return 1; }, clearTimeout() {}, clearInterval() {}, testCanvas: context2d });
  const hooks = `window.meteorTest = {
    setup() {
      active=true;myId='pilot';ctx=testCanvas;previousStatus='playing';previousRound=1;
      updateHud=()=>{};focusGame=()=>{};toast=()=>{};
    },
    packet:receiveRoom,
    ping(value) { rtt=value; },
    pose(id) { return meteorPose((room?.meteors||[]).find(meteor=>meteor.id===id)||{id},performance.now()); },
    draw(id) { const meteor=room.meteors.find(meteor=>meteor.id===id),pose=this.pose(id);if(meteor&&pose)drawMeteor(meteor,pose); },
    ids() { return Array.from(meteorTracks.keys()); },
    ref(playerId,cellId) { return playerId===myId?predictedCells.get(cellId):remotePhysics.get(playerId+':'+cellId); },
    frame(dt) { predictOwn(dt,performance.now()); },
    particles() { return particles.map(particle=>({...particle})); },
    feedback(id) { return combatFeedback.get(id); },
    close() { closeSession(false); },
  };`;
  const instrumented = source.replace('  window.StarGame = {', `${hooks}\n  window.StarGame = {`);
  assert.notEqual(instrumented, source, 'the meteor regression hook must attach to the shipped client');
  vm.runInContext(instrumented, context, { filename: 'public/game.js' });
  const api = context.window.meteorTest; api.setup();
  return { api, drawing, time: value => { clock = value; } };
}

test('15Hz meteor snapshots produce continuous constant-speed 60FPS diagonal flight without packet jumps', () => {
  const c = client(), meteor = flight(), samples = [];
  c.api.packet(state(0, [meteor]));
  for (let frame = 1; frame <= 120; frame++) {
    const time = frame / 60; c.time(time * 1000);
    const before = c.api.pose(meteor.id);
    if (frame % 4 === 0) {
      c.api.packet(state(time, [{ ...meteor, x: Math.round((meteor.x + meteor.vx * time) * 100) / 100,
        y: Math.round((meteor.y + meteor.vy * time) * 100) / 100 }]));
      const after = c.api.pose(meteor.id);
      near(after.x, before.x); near(after.y, before.y);
    }
    const pose = c.api.pose(meteor.id); samples.push(pose);
    near(pose.x, meteor.x + meteor.vx * time, .001); near(pose.y, meteor.y + meteor.vy * time, .001);
  }
  for (let i = 1; i < samples.length; i++) near(Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y), 600 / 60, .001);
});

test('a 360ms round trip keeps 15Hz meteor flight continuous on the current-time presentation horizon', () => {
  const c = client(), meteor = flight(); c.api.ping(360); c.time(180); c.api.packet(state(0, [meteor]));
  for (let frame = 1; frame <= 120; frame++) {
    const elapsed = frame / 60; c.time(180 + elapsed * 1000);
    const before = c.api.pose(meteor.id);
    if (frame % 4 === 0) {
      c.api.packet(state(elapsed, [{ ...meteor, x: meteor.x + meteor.vx * elapsed, y: meteor.y + meteor.vy * elapsed }]));
      const after = c.api.pose(meteor.id); near(after.x, before.x); near(after.y, before.y);
    }
    const pose = c.api.pose(meteor.id);
    near(pose.x, meteor.x + meteor.vx * (elapsed + .18), .001);
    near(pose.y, meteor.y + meteor.vy * (elapsed + .18), .001);
  }
});

test('viewport entry starts at its authoritative time and a complete empty list removes the head and tail', () => {
  const c = client(); c.api.packet(state(0, [])); c.time(500);
  const meteor = flight('entering', { x: 6100, y: 4050, bornAt: .25 });
  c.api.packet(state(.5, [meteor]));
  const entering = c.api.pose(meteor.id); near(entering.x, meteor.x); near(entering.y, meteor.y);
  c.time(550); const moving = c.api.pose(meteor.id);
  assert.ok(moving.x > entering.x && moving.y > entering.y);
  c.api.draw(meteor.id); assert.ok(c.drawing.some(item => item.kind === 'move')); assert.ok(c.drawing.some(item => item.kind === 'arc'));
  c.time(600); c.api.packet(state(.6, []));
  assert.equal(c.api.pose(meteor.id), null); assert.equal(c.api.ids().length, 0);
  const count = c.drawing.length; c.api.draw(meteor.id); assert.equal(c.drawing.length, count, 'an omitted meteor cannot keep drawing its old tail');
});

test('meteor birth, world exit and bounded extrapolation prevent future or runaway ghost paths', () => {
  const c = client(), bornLater = flight('future', { bornAt: .1 }); c.api.packet(state(0, [bornLater]));
  assert.equal(c.api.pose(bornLater.id), null);
  c.time(100); assert.ok(c.api.pose(bornLater.id));
  c.time(1000); const capped = c.api.pose(bornLater.id);
  near(capped.time, 250); near(capped.x, bornLater.x + bornLater.vx * .25); near(capped.y, bornLater.y + bornLater.vy * .25);
  c.time(5000); near(c.api.pose(bornLater.id).x, capped.x);
  const edge = flight('edge', { x: 11990, vx: 600, vy: 0, bornAt: 5 });
  c.api.packet(state(5, [edge])); c.time(5050);
  assert.equal(c.api.pose(edge.id), null, 'the renderer must hide a head that has left the world');
});

test('long render gaps use elapsed simulation time while limiting unconfirmed motion', () => {
  const c = client(), meteor = flight(); c.api.packet(state(0, [meteor]));
  for (const time of [16.667, 83.333, 233.333]) {
    c.time(time); const pose = c.api.pose(meteor.id);
    near(pose.x, meteor.x + meteor.vx * time / 1000, .001);
    near(pose.y, meteor.y + meteor.vy * time / 1000, .001);
  }
  c.time(400); const capped = c.api.pose(meteor.id); near(capped.time, 250);
});

test('a meteor tail follows behind its diagonal velocity and retains a visible small head', () => {
  const c = client(), meteor = flight(); c.api.packet(state(0, [meteor])); c.api.draw(meteor.id);
  const start = c.drawing.find(item => item.kind === 'move'); assert.ok(start);
  const dx = start.x - meteor.x, dy = start.y - meteor.y;
  near(dx * .6 + dy * .8, -meteor.tailLength); near(-dx * .8 + dy * .6, 0);
  const heads = c.drawing.filter(item => item.kind === 'arc');
  assert.ok(heads.some(item => Math.abs(item.radius - meteor.radius) < 1e-7));
  assert.ok(heads.every(item => Math.hypot(item.x - meteor.x, item.y - meteor.y) <= meteor.radius));
});

test('full meteor lists stay independent of dust deltas and clear old room, round and session tracks', () => {
  const c = client(); c.api.packet(state(0, [flight('old')]));
  c.time(50); c.api.packet(state(.05, [flight('new')], { dustDelta: true, dust: [] }));
  assert.deepEqual(Array.from(c.api.ids()), ['new']); assert.equal(c.api.pose('old'), null);
  c.time(100); c.api.packet(state(.1, [], { code: 'OTHER' })); assert.equal(c.api.ids().length, 0);
  c.time(150); c.api.packet(state(.15, [flight('round-one')], { code: 'OTHER' }));
  c.time(200); c.api.packet(state(0, [], { code: 'OTHER', round: 2 })); assert.equal(c.api.ids().length, 0);
  c.time(250); c.api.packet(state(.05, [flight('before-close')], { code: 'OTHER', round: 2 }));
  assert.equal(c.api.ids().length, 1); c.api.close(); assert.equal(c.api.ids().length, 0);
});

for (const remote of [false, true]) {
  test(`${remote ? 'remote' : 'own'} coalesced meteor hits preserve both core impulses once and remove both old rendered meteors`, () => {
    const arena = createArena({ random: () => .99 }); arena.status = 'playing';
    const pilot = addPlayer(arena, { id: 'pilot' });
    if (remote) Object.assign(pilot.cells[0], { x: 9000, y: 4000 });
    const victim = remote ? addPlayer(arena, { id: 'victim' }) : pilot;
    Object.assign(victim, { invulnerable: 0 });
    Object.assign(victim.cells[0], { x: 2000, y: 4000 });
    victim.cells.push({ ...victim.cells[0], id: 'second', x: 3000 }, { ...victim.cells[0], id: 'untouched', x: 4000 });
    arena.dust = Array.from({ length: 6000 }, (_, id) => ({ id: `far-${id}`, x: 11000, y: 7000, value: 1, vx: 0, vy: 0 }));
    arena.meteors = [flight('impact-one', { x: 1970, y: 4000, vx: 600, vy: 0 }), flight('impact-two', { x: 2970, y: 4000, vx: 600, vy: 0 })];
    const snapshot = () => ({ code: 'METEOR-IMPACT', ...snapshotArena(arena) });
    const c = client(); c.api.packet(snapshot());
    const [first, second, untouched] = victim.cells.map(cell => cell.id);
    for (const id of [first, second, untouched]) {
      const ref = c.api.ref(victim.id, id); ref.contactUntil = 500; ref.normals = [{ x: 1, y: 0 }];
    }
    c.api.ref(victim.id, untouched).model.vx = 13;
    const before = [first, second].map(id => c.api.ref(victim.id, id).model.x);
    stepArena(arena, .05); const hit = snapshot();
    const hitVictim = hit.players.find(player => player.id === victim.id);
    const hitCells = [first, second].map(id => hitVictim.cells.find(cell => cell.id === id));
    assert.ok(hitCells.every(cell => cell.lastMeteorHitId && cell.vx > 0));
    assert.notEqual(hitCells[0].lastMeteorHitId, hitCells[1].lastMeteorHitId, 'the two real impacts must have separate authoritative identities');
    c.time(50); c.api.packet(hit);
    hitCells.forEach((cell, index) => {
      near(c.api.ref(victim.id, cell.id).model.vx, cell.vx);
      near(c.api.ref(victim.id, cell.id).model.x, before[index]);
    });
    near(c.api.ref(victim.id, untouched).model.vx, 13);
    assert.equal(c.api.pose('impact-one'), null); assert.equal(c.api.pose('impact-two'), null);
    c.time(50 + 1000 / 60); c.api.frame(1 / 60);
    const coast = hitCells.map(cell => c.api.ref(victim.id, cell.id).model.vx);
    assert.ok(coast.every((velocity, index) => velocity > 0 && velocity < hitCells[index].vx));
    c.time(70); c.api.packet(structuredClone(hit));
    hitCells.forEach((cell, index) => near(c.api.ref(victim.id, cell.id).model.vx, coast[index]));
  });
}

function contactScene() {
  const arena = createArena({ random: () => .99 }); arena.status = 'playing';
  const pilot = addPlayer(arena, { id: 'pilot' });
  Object.assign(pilot, { x: 6000, y: 4000, invulnerable: 0 });
  Object.assign(pilot.cells[0], { x: 6000, y: 4000 });
  arena.dust = Array.from({ length: 6000 }, (_, id) => ({ id: `far-${id}`, x: 11000, y: 7000, value: 1, vx: 0, vy: 0 }));
  arena.meteors = [flight('contact', { x: 5800, y: 4000, vx: 600, vy: 0 })];
  const snapshot = () => ({ code: 'METEOR-CONTACT', ...snapshotArena(arena) });
  const before = snapshot(); stepArena(arena, .1); const early = snapshot();
  stepArena(arena, .1); const prehit = snapshot(); stepArena(arena, .1); const after = snapshot();
  assert.ok(after.players[0].lastMeteorHit, 'the real server fixture must reach impact after both prehit packets');
  return { before, early, prehit, after };
}

test('delayed meteor presentation stops at the own body, stays hidden through old prehit packets and receives authority feedback once', () => {
  const f = contactScene(), c = client(); c.api.ping(360); c.time(180); c.api.packet(structuredClone(f.before));
  let hidden = false, visible = 0;
  for (let frame = 0; frame <= 9; frame++) {
    c.time(180 + frame * 1000 / 60); const pose = c.api.pose('contact');
    if (!pose) hidden = true;
    else { visible++; assert.ok(!hidden, 'a locally predicted contact must not resurrect before authority arrives');
      assert.ok(pose.x <= 6000 - 24 - 4 + .001, 'the displayed meteor must not pass through the own solid body'); }
  }
  assert.ok(visible > 0 && hidden, 'the fixture must exercise a visible approach followed by predicted contact');
  assert.equal(c.api.particles().length, 0, 'render-only clipping does not invent gameplay effects');
  c.time(340); c.api.packet(structuredClone(f.early)); assert.equal(c.api.pose('contact'), null);
  c.time(390); c.api.packet(structuredClone(f.prehit)); assert.equal(c.api.pose('contact'), null);
  c.time(480); c.api.packet(structuredClone(f.after)); assert.equal(c.api.pose('contact'), null);
  const particles = c.api.particles().length; assert.ok(particles > 0);
  assert.equal(c.api.feedback('pilot').hit.id, f.after.players[0].lastMeteorHit.id);
  c.time(490); c.api.packet(structuredClone(f.after)); assert.equal(c.api.particles().length, particles, 'the authoritative confirmation flashes once');
  const stale = structuredClone(f.after); stale.meteors = structuredClone(f.before.meteors);
  c.time(500); c.api.packet(stale); assert.equal(c.api.pose('contact'), null, 'an authoritative impact also rejects an old cached head in the same state');
  assert.equal(c.api.particles().length, particles);
});

test('a predicted meteor contact can recover when a later authoritative snapshot proves the same meteor is still alive', () => {
  const f = contactScene(), c = client(); c.api.ping(360); c.time(180); c.api.packet(structuredClone(f.before));
  c.api.pose('contact'); c.time(330); assert.equal(c.api.pose('contact'), null);
  const fresh = structuredClone(f.before); fresh.time = .4; fresh.simulationTime = 400;
  fresh.meteors[0].x += fresh.meteors[0].vx * .4;
  fresh.players[0].y = fresh.players[0].cells[0].y = 4050;
  c.time(580); c.api.packet(fresh);
  const recovered = c.api.pose('contact'); assert.ok(recovered, 'fresh surviving authority must disprove rather than permanently hide a false contact');
  assert.ok(recovered.x > 6040); assert.equal(recovered.vx, 600);
  assert.equal(c.api.particles().length, 0, 'a disproved prediction must not create an impact flash');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createArena, addPlayer, snapshotArena } from '../shared/engine.js';

const source = await readFile(new URL('../public/game.js', import.meta.url), 'utf8');
const near = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `${actual} should equal ${expected} within ${tolerance}`);

function state({ time = 0, mass = 36, extraCore = false, armed = false, wrapped = false, round = 1, code = 'DYSON' } = {}) {
  const arena = createArena(); arena.status = 'playing'; arena.time = time; arena.round = round;
  const pilot = addPlayer(arena, { id: 'pilot' }), target = addPlayer(arena, { id: 'target' });
  Object.assign(pilot.cells[0], { id: 'source', x: 2000, y: 4000, mass, radius: 4 * Math.sqrt(mass), mergeIn: 10 });
  if (extraCore) pilot.cells.push({ ...pilot.cells[0], id: 'unrelated', x: 8500 + 12 * (1 - Math.exp(-2 * time)),
    y: 6000 - 5.5 * (1 - Math.exp(-2 * time)), mass: 36, radius: 24, vx: 24 * Math.exp(-2 * time), vy: -11 * Math.exp(-2 * time) });
  Object.assign(target.cells[0], { id: 'target-core', x: 6000 + 210 * time, y: 4000, vx: 210, vy: 0 });
  target.input = { x: 1, y: 0, fire: false, rearFire: false, split: false };
  for (const p of [pilot, target]) Object.assign(p, { mass: p.cells.reduce((sum, c) => sum + c.mass, 0),
    x: p.cells[0].x, y: p.cells[0].y, invulnerable: 100 });
  const result = { code, ...snapshotArena(arena), dysonRules: { window: .9, duration: 2.4, cooldown: 8, returnClearance: 16 } };
  const own = result.players.find(p => p.id === 'pilot'), peer = result.players.find(p => p.id === 'target');
  Object.assign(own, { dyson: null, dysonReady: null, dysonCooldown: 0, dysonRevision: 0, lastDysonEnd: null });
  if (armed) own.dysonReady = { id: 'ready-one', waveId: 'wave-one', sourceCellId: 'source', targetId: 'target',
    targetCellId: 'target-core', hitAt: 0, expiresAt: .9, directionX: 1, directionY: 0 };
  if (wrapped) {
    own.dysonRevision = 1;
    own.dyson = { id: 'ring-one', sourceCellId: 'source', targetId: 'target', targetCellId: 'target-core',
      startedAt: 0, endsAt: 2.4, x: peer.cells[0].x, y: peer.cells[0].y, radius: 64, capturedMass: 0, directionX: 1, directionY: 0 };
    Object.assign(own.cells[0], { dysonId: 'ring-one', x: peer.cells[0].x, y: peer.cells[0].y, vx: 0, vy: 0 });
  }
  return result;
}

function client(initial, ping = 0) {
  let clock = 0;
  const sent = [], nodes = new Map(), listeners = new Map(), drawings = [];
  const context2d = new Proxy({}, { get: () => () => {}, set: () => true });
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { id, hidden: false, style: {}, dataset: {}, width: 0, height: 0,
      classList: { add() {}, remove() {} }, setAttribute() {}, focus() {}, appendChild(child) { return child; },
      addEventListener(type, handler) { const key = `${id}:${type}`, list = listeners.get(key) || []; list.push(handler); listeners.set(key, list); },
      querySelectorAll() { return []; }, getContext() { return context2d; }, closest() { return null; },
      getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; }, setPointerCapture() {},
    });
    return nodes.get(id);
  };
  const document = { hidden: false, body: { style: {}, dataset: {}, appendChild(child) { return child; } },
    head: { appendChild() {} }, getElementById: node, createElement: tag => node(`created-${tag}`),
    querySelector: node, addEventListener() {}, fullscreenElement: null };
  const context = vm.createContext({ innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1, window: { dysonDrawing: context2d },
    document, performance: { now: () => clock }, WebSocket: { OPEN: 1 },
    requestAnimationFrame() {}, cancelAnimationFrame() {}, setTimeout() { return 1; }, clearTimeout() {}, clearInterval() {},
    addEventListener(type, handler) { const key = `window:${type}`, list = listeners.get(key) || []; list.push(handler); listeners.set(key, list); },
  });
  const hooks = `window.dysonClientTest = {
    start(state,ping) { install(); active=true; joined=true; myId='pilot'; token='test-token'; rtt=ping;
      socket={readyState:1,send:data=>window.onSend(JSON.parse(data)),close(){}};
      ingestSnapshot(state,performance.now());room=state;ctx=window.dysonDrawing;
      drawBackground=drawArena=drawMinimap=drawDust=drawMeteor=drawGravity=drawWaveFeedback=()=>{};
      drawPlanet=(player,cell)=>window.onDraw({kind:'planet',playerId:player.id,cellId:cell.id});
      drawDyson=(player,shell)=>window.onDraw({kind:'dyson',playerId:player.id,x:shell.x,y:shell.y}); },
    packet(state) { ingestSnapshot(state,performance.now());room=state; },
    resume(state) { reconnecting=false;this.packet(state); },
    frame(dt) { predictOwn(dt,performance.now()); },
    render() { render(performance.now()); },
    ownCell(id) { return predictedCells.get(id); },
    target() { return remotePhysics.get('target:target-core'); },
    shell() { return dysonPose(room.players.find(p=>p.id==='pilot'),performance.now()); },
    center:getOwnCenter,
    effective(id) { const p=room.players.find(p=>p.id==='pilot'),cell=p.cells.find(c=>c.id===id);return cell?effectiveCell(p,cell,performance.now()):null; },
    bodies() { return physicsBodies().map(body=>({playerId:body.player.id,cellId:body.cell.id})); },
    hold(code) { keys.clear();if(code)keys.add(code); },
    intent:getIntent,
    hud() { updateHud(true); },
    reconnect:attemptReconnect,
    close() { closeSession(false); },
  };`;
  context.window.onSend = message => sent.push(message);
  context.window.onDraw = item => drawings.push(item);
  const instrumented = source.replace('  window.StarGame = {', `${hooks}\n  window.StarGame = {`);
  assert.notEqual(instrumented, source, 'Dyson regression hooks must attach to the shipped client');
  vm.runInContext(instrumented, context, { filename: 'public/game.js' });
  const api = context.window.dysonClientTest; api.start(initial, ping);
  function dispatch(key, event = {}) { for (const handler of listeners.get(key) || []) handler({ target: node('gameCanvas'), repeat: false, preventDefault() {}, ...event }); }
  return { api, sent, drawings, node, time: value => { clock = value; },
    key: (code, repeat = false) => dispatch('window:keydown', { code, key: code, repeat }),
    release: code => dispatch('window:keyup', { code, key: code }),
    pointer: id => dispatch(`${id}:pointerdown`, { pointerType: 'touch', pointerId: 1 }),
    mouse: () => dispatch('window:mousemove', { clientX: 1200, clientY: 10 }),
  };
}

test('fresh wave-hit Space and touch split activate the combo below ordinary split mass, while expired marks do not', () => {
  for (const control of ['keyboard', 'touch']) {
    const c = client(state({ armed: true }));
    if (control === 'keyboard') c.key('Space'); else c.pointer('sgTouchSplit');
    assert.equal(c.sent.filter(message => message.split).length, 1, `${control} must send the armed split action at mass 36`);
    assert.ok(c.sent.every(message => !message.fire && !message.rearFire));
    const expired = client(state({ armed: true })); expired.time(1000);
    if (control === 'keyboard') expired.key('Space'); else expired.pointer('sgTouchSplit');
    assert.equal(expired.sent.filter(message => message.split).length, 0, 'an expired combo must retain the ordinary mass requirement');
  }
  const ordinary = client(state({ mass: 72 })); ordinary.key('Space');
  assert.ok(ordinary.sent.some(message => message.split), 'ordinary splitting remains available without a combo');
});

test('a newly active shell ignores wave and early split actions while ordinary movement input remains usable', () => {
  const c = client(state({ wrapped: true, extraCore: true }));
  for (const key of ['KeyE', 'KeyR', 'Space']) { c.key(key); c.release(key); }
  for (const id of ['sgBlast', 'sgRearBlast', 'sgTouchSplit']) c.pointer(id);
  assert.ok(c.sent.every(message => !message.fire && !message.rearFire && !message.split));
  c.key('ArrowRight'); assert.equal(c.sent.at(-1).x, 1);
  c.release('ArrowRight'); c.mouse();
  assert.equal(c.api.intent().x, 0); assert.equal(c.api.intent().y, 0, 'mouse position must not steer a shell or an unrelated core');
});

test('Dyson exit enables after its minimum, locks during warning, and requires a new press to split after restoration', () => {
  for (const control of ['keyboard', 'touch']) {
    const c = client(state({ wrapped: true, mass: 72 })); c.api.hud();
    assert.equal(c.node('sgTouchSplit').disabled, true);
    c.key('Space');
    const active = state({ wrapped: true, time: .65, mass: 72 });
    active.players.find(p => p.id === 'pilot').dyson.canExitAt = .6;
    c.time(650); c.api.packet(active); c.api.hud();
    assert.equal(c.node('sgTouchSplit').disabled, false);
    assert.equal(c.node('sgTouchSplit').textContent, '还原');
    assert.equal(c.node('sgComboAction').textContent, '提前还原');
    c.key('Space', true);
    assert.equal(c.sent.filter(message => message.split).length, 0, 'holding through the minimum cannot auto-request exit');
    c.release('Space');
    if (control === 'keyboard') c.key('Space'); else c.pointer('sgTouchSplit');
    assert.equal(c.sent.filter(message => message.split).length, 1);
    const winding = structuredClone(active); winding.time = .7; winding.simulationTime = 700;
    Object.assign(winding.players.find(p => p.id === 'pilot').dyson, { exitRequestedAt: .65, exitAt: .95,
      exitDirectionX: 0, exitDirectionY: 1, exitPreview: { x: 6136.5, y: 4100, radius: 4 * Math.sqrt(72) } });
    c.time(700); c.api.packet(winding); c.api.hud();
    assert.equal(c.node('sgTouchSplit').disabled, true);
    assert.equal(c.node('sgTouchSplit').textContent, '还原中');
    assert.equal(c.node('sgComboAction').textContent, '正在还原');
    const shell = c.api.shell(), target = c.api.target();
    near(shell.exitPreview.x - shell.x, 0);
    near(shell.exitPreview.y - shell.y, 100);
    assert.ok(shell.exitRemaining > 0 && shell.exitRemaining <= .3);
    c.release('Space'); c.key('Space'); c.release('Space'); c.pointer('sgTouchSplit');
    assert.equal(c.sent.filter(message => message.split).length, 1, 'warning cannot be converted into an ordinary split');
    const returned = state({ time: .95, mass: 72 }), own = returned.players.find(p => p.id === 'pilot');
    Object.assign(own.cells[0], { x: 6200, y: 4100 });
    own.dysonRevision = 2; own.dysonCooldown = 7.05;
    own.lastDysonEnd = { id: 'exit-one', sourceCellId: 'source', at: .95, reason: 'early-exit', x: 6200, y: 4100 };
    c.time(950); c.api.packet(returned); c.api.hud(); c.api.hold(null);
    assert.equal(c.node('sgTouchSplit').disabled, false); assert.equal(c.node('sgTouchSplit').textContent, '分裂');
    c.api.render();
    assert.equal(c.sent.filter(message => message.split).length, 1);
    if (control === 'keyboard') c.key('Space'); else c.pointer('sgTouchSplit');
    assert.equal(c.sent.filter(message => message.split).length, 2, 'a distinct press after return permits normal mass-gated splitting');
    assert.ok(c.sent.every(message => !message.fire && !message.rearFire));
  }
});

test('multiple authoritative cores disable E and R until one core remains, without blocking split-after-launch combo state', () => {
  const initial = state({ extraCore: true }), c = client(initial); c.api.hud();
  assert.equal(c.node('sgBlast').disabled, true); assert.equal(c.node('sgRearBlast').disabled, true);
  for (const key of ['KeyE', 'KeyR']) { c.key(key); c.release(key); }
  assert.ok(c.sent.every(message => !message.fire && !message.rearFire));
  const merged = structuredClone(initial); merged.time = .1; merged.simulationTime = 100;
  const own = merged.players.find(p => p.id === 'pilot'); own.cells.splice(1);
  Object.assign(own.cells[0], { mass: 72, radius: 4 * Math.sqrt(72) }); own.mass = 72;
  c.time(100); c.api.packet(merged); c.api.hud();
  assert.equal(c.node('sgBlast').disabled, false); assert.equal(c.node('sgRearBlast').disabled, false);
  c.key('KeyE'); c.release('KeyE'); c.key('KeyR');
  assert.ok(c.sent.some(message => message.fire)); assert.ok(c.sent.some(message => message.rearFire));
  const combo = client(state({ armed: true, extraCore: true })); combo.key('Space');
  assert.ok(combo.sent.some(message => message.split), 'a wave launched before splitting can still arm its original source core');
});

test('entering a shell suppresses only its source and preserves an unrelated core physical and visible continuation', () => {
  const c = client(state({ extraCore: true })); c.time(100); c.api.frame(.1);
  const unrelated = c.api.ownCell('unrelated'), model = unrelated.model, before = { ...model }, epoch = unrelated.modelAt;
  c.time(110); c.api.packet(state({ time: .11, wrapped: true, extraCore: true }));
  assert.equal(c.api.ownCell('unrelated'), unrelated); assert.equal(unrelated.model, model);
  near(model.x, before.x); near(model.y, before.y); assert.equal(unrelated.modelAt, epoch);
  assert.equal(c.api.effective('source'), null);
  assert.ok(!c.api.bodies().some(body => body.playerId === 'pilot' && body.cellId === 'source'));
  assert.ok(c.api.bodies().some(body => body.playerId === 'pilot' && body.cellId === 'unrelated'));
  c.time(110 + 1000 / 60); c.api.frame(1 / 60);
  assert.ok(model.x > before.x); assert.ok(model.y < before.y);
  c.api.render();
  assert.ok(!c.drawings.some(item => item.kind === 'planet' && item.playerId === 'pilot' && item.cellId === 'source'));
  assert.ok(c.drawings.some(item => item.kind === 'dyson' && item.playerId === 'pilot'));
  near(c.api.center().x, c.api.shell().x); near(c.api.center().y, c.api.shell().y);
});

for (const fps of [60, 120]) {
  test(`the ${fps} FPS shell follows its persistent target under ordered snapshot jitter without packet jumps or reversed frames`, () => {
    const c = client(state({ wrapped: true, extraCore: true }), 360), packets = [];
    const delays = [16, 50, 20, 66, 33, 10]; let lastDelivery = 0;
    for (let tick = 1; tick <= 24; tick++) {
      const time = tick / 15, delivery = Math.max(lastDelivery + 1, time * 1000 + delays[(tick - 1) % delays.length]);
      packets.push({ delivery, state: state({ time, wrapped: true, extraCore: true }) }); lastDelivery = delivery;
    }
    const sourceRef = c.api.ownCell('source'); let previous, delivered = 0;
    for (let frame = 1; frame <= fps * 1.5; frame++) {
      const now = frame * 1000 / fps; c.time(now);
      while (packets[0]?.delivery <= now) {
        const before = c.api.shell(); c.api.packet(packets.shift().state); const after = c.api.shell();
        near(after.x, before.x); near(after.y, before.y); delivered++;
      }
      c.api.frame(1 / fps);
      const shell = c.api.shell(), target = c.api.target();
      assert.ok(shell && Number.isFinite(shell.radius) && shell.radius > 0);
      near(shell.x, target.visual.x); near(shell.y, target.visual.y);
      if (previous) { const speed = (shell.x - previous.x) * fps; assert.ok(speed > 0 && speed < 330, `visible target speed ${speed} must remain a normal forward path`); }
      previous = shell;
      assert.equal(c.api.ownCell('source'), sourceRef, 'repeated active snapshots retain the idle source reference');
    }
    assert.ok(delivered >= 15, 'the regression must actually receive jittered authoritative updates');
  });
}

test('a shell waits for authoritative return and then resets only the source without replaying its wrapped interval or old offset', () => {
  const initial = state({ wrapped: true, extraCore: true }), c = client(initial);
  c.api.hold('ArrowRight'); c.time(100); c.api.frame(.1);
  const unrelated = c.api.ownCell('unrelated'), otherModel = unrelated.model, otherBefore = { ...otherModel };
  c.api.ownCell('source').offsetX = 70;
  const returned = state({ time: .11, extraCore: true }), own = returned.players.find(p => p.id === 'pilot');
  Object.assign(own.cells[0], { x: 6080, y: 4100, vx: 15, vy: -8, mass: 40.32, radius: 4 * Math.sqrt(40.32), dysonId: null });
  own.mass = 76.32; own.dysonRevision = 2;
  own.lastDysonEnd = { id: 'end-one', dysonId: 'ring-one', sourceCellId: 'source', at: .11, reason: 'expired', x: 6080, y: 4100 };
  c.time(110); c.api.packet(returned);
  const sourceRef = c.api.ownCell('source');
  near(sourceRef.x, 6080); near(sourceRef.y, 4100); near(sourceRef.model.x, 6080); near(sourceRef.offsetX || 0, 0);
  assert.equal(c.api.shell(), null); assert.ok(c.api.effective('source'));
  assert.equal(c.api.bodies().filter(body => body.playerId === 'pilot' && body.cellId === 'source').length, 1);
  assert.equal(c.api.ownCell('unrelated'), unrelated); assert.equal(unrelated.model, otherModel); near(otherModel.x, otherBefore.x);
  c.time(110 + 1000 / 60); c.api.frame(1 / 60);
  assert.ok(sourceRef.x > 6080 && sourceRef.x < 6085, 'return must resume from its fresh epoch rather than replay old wrapped movement');
  const beforeDuplicate = sourceRef.x;
  c.time(135); c.api.packet(structuredClone(returned));
  assert.equal(c.api.ownCell('source'), sourceRef); near(sourceRef.x, beforeDuplicate);

  const nearEnd = client(state({ time: 2.3, wrapped: true })); nearEnd.time(200); nearEnd.api.frame(.2);
  assert.ok(nearEnd.api.shell(), 'a local countdown reaching zero cannot recreate the core before the server return packet');
  assert.equal(nearEnd.api.effective('source'), null);
});

test('round, reconnect baseline and explicit leave remove stale shell presentation and permit a clean ordinary core', () => {
  const c = client(state({ wrapped: true })); assert.ok(c.api.shell());
  c.api.reconnect(); assert.equal(c.api.shell(), null);
  c.time(50); c.api.resume(state({ time: .05, wrapped: true })); assert.ok(c.api.shell());
  c.time(100); c.api.packet(state({ round: 2 }));
  assert.equal(c.api.shell(), null); assert.ok(c.api.effective('source'));
  assert.ok(c.api.bodies().some(body => body.playerId === 'pilot' && body.cellId === 'source'));
  c.key('Space'); assert.ok(c.sent.every(message => !message.split), 'a previous round mark must not bypass the new round mass requirement');
  c.time(150); c.api.packet(state({ code: 'NEWROOM', round: 1, wrapped: true })); assert.ok(c.api.shell());
  c.api.close(); c.drawings.length = 0; c.api.render();
  assert.equal(c.api.shell(), null); assert.equal(c.drawings.length, 0, 'leaving the session must stop the old shell render path');
});

test('source entry and return cannot revive a consumed unrelated donor carried by older authoritative fusion geometry', () => {
  const initial = state({ extraCore: true }), own = initial.players.find(p => p.id === 'pilot');
  const receiver = own.cells[1], donor = { ...receiver, id: 'old-donor', mass: .1, radius: 4 * Math.sqrt(.1) };
  Object.assign(receiver, { mass: 71.9, radius: 4 * Math.sqrt(71.9), vx: 0, vy: 0, mergeIn: 0,
    fusionId: 'old-pair', fusionRole: 'receiver', fusionDonorId: donor.id, fusionPartnerId: donor.id, fusionTime: .01, fusionProgress: .99 });
  Object.assign(donor, { x: receiver.x + receiver.radius + donor.radius, vx: 0, vy: 0, mergeIn: 0,
    fusionId: 'old-pair', fusionRole: 'donor', fusionTargetId: receiver.id, fusionPartnerId: receiver.id, fusionTime: .01, fusionProgress: .99 });
  own.cells.push(donor); own.mass = 108;
  const c = client(initial); c.time(20); c.api.frame(.02);
  const receiverRef = c.api.ownCell(receiver.id), donorRef = c.api.ownCell(donor.id);
  assert.equal(donorRef.model.mass, 0); assert.equal(c.api.effective(donor.id), null);
  const completedPair = receiverRef.model._completedFusionId;
  assert.ok(completedPair, 'the fixture must complete its unrelated gradual absorption locally');

  const entered = state({ time: .025, wrapped: true }), enteredOwn = entered.players.find(p => p.id === 'pilot');
  enteredOwn.cells.push(...structuredClone(own.cells.slice(1))); enteredOwn.mass = 108;
  c.time(25); c.api.packet(entered);
  assert.equal(c.api.ownCell(receiver.id), receiverRef); assert.equal(c.api.ownCell(donor.id), donorRef);
  assert.equal(receiverRef.model._completedFusionId, completedPair);
  assert.equal(donorRef.model.mass, 0); assert.equal(c.api.effective(donor.id), null);

  const returned = structuredClone(entered), returnedOwn = returned.players.find(p => p.id === 'pilot');
  returned.time = .03; returned.simulationTime = 30; returnedOwn.dyson = null; returnedOwn.dysonRevision = 2;
  returnedOwn.lastDysonEnd = { id: 'end-with-old-donor', sourceCellId: 'source', at: .03 };
  Object.assign(returnedOwn.cells[0], { dysonId: null, x: 6080, y: 4100, vx: 0, vy: 0 });
  c.time(30); c.api.packet(returned);
  assert.equal(c.api.ownCell(receiver.id), receiverRef); assert.equal(c.api.ownCell(donor.id), donorRef);
  assert.equal(receiverRef.model._completedFusionId, completedPair);
  assert.equal(donorRef.model.mass, 0); assert.equal(c.api.effective(donor.id), null);
  assert.ok(!c.api.bodies().some(body => body.playerId === 'pilot' && body.cellId === donor.id));
});


test('energy-free keyboard and touch waves use only the shared cooldown and core restrictions', () => {
  for (const [code, id, field] of [['KeyE', 'sgBlast', 'fire'], ['KeyR', 'sgRearBlast', 'rearFire']]) {
    for (const control of ['keyboard', 'touch']) {
      const initial = state(), own = initial.players.find(p => p.id === 'pilot');
      assert.equal('energy' in own, false);
      assert.equal('blastCost' in own.stats, false);
      const c = client(initial); c.api.hud();
      assert.equal(c.node(id).disabled, false);
      assert.equal(c.node('sgWaveCooldown').textContent, '就绪');
      if (control === 'keyboard') c.key(code); else c.pointer(id);
      assert.equal(c.sent.filter(message => message[field]).length, 1, `${control} ${code} fires without an energy field`);
      const cooling = structuredClone(initial), coolingOwn = cooling.players.find(p => p.id === 'pilot');
      coolingOwn.cooldown = .4; c.time(50); c.api.packet(cooling); c.api.hud();
      assert.equal(c.node('sgBlast').disabled, true); assert.equal(c.node('sgRearBlast').disabled, true);
      assert.match(c.node('sgWaveCooldown').textContent, /共用冷却/);
      c.release(code);
      if (control === 'keyboard') c.key(code); else c.pointer(id);
      assert.equal(c.sent.filter(message => message[field]).length, 1, 'cooldown still blocks both launch paths');
    }
  }
});

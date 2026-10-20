import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createArena, addPlayer, snapshotArena } from '../shared/engine.js';

const source = await readFile(new URL('../public/game.js', import.meta.url), 'utf8');
const near = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `expected ${expected}, received ${actual}`);
const player = (snapshot, id = 'pilot') => snapshot.players.find(p => p.id === id);

function state({ time = 0, mass = 36, extraCore = false, blink = true, dyson = false, active = false,
  rear = false, round = 1, code = 'BLINK', remote = false } = {}) {
  const arena = createArena(); arena.status = 'playing'; arena.time = time; arena.round = round;
  const pilot = addPlayer(arena, { id: 'pilot' }), target = addPlayer(arena, { id: 'target' });
  Object.assign(pilot.cells[0], { id: 'source', x: 2000, y: 4000, vx: 0, vy: 0,
    mass, radius: 4 * Math.sqrt(mass), mergeIn: 10 });
  Object.assign(target.cells[0], { id: 'target-core', x: 6000 + 210 * time, y: 4000, vx: 210, vy: 0 });
  target.input = { x: 1, y: 0, fire: false, rearFire: false, split: false };
  const owner = remote ? target : pilot;
  if (remote) Object.assign(owner.cells[0], { id: 'source', x: 6000, y: 4000, vx: 0, vy: 0 });
  if (extraCore) owner.cells.push({ ...owner.cells[0], id: 'unrelated',
    x: 8500 + 12 * (1 - Math.exp(-2 * time)), y: 6000 - 5.5 * (1 - Math.exp(-2 * time)),
    mass: 36, radius: 24, vx: 24 * Math.exp(-2 * time), vy: -11 * Math.exp(-2 * time) });
  for (const p of [pilot, target]) Object.assign(p, { mass: p.cells.reduce((sum, c) => sum + c.mass, 0),
    x: p.cells[0].x, y: p.cells[0].y, invulnerable: 100, energy: 100 });
  const result = { code, ...snapshotArena(arena),
    dysonRules: { window: .9, duration: 2.4, cooldown: 8, returnClearance: 16 } };
  const own = player(result), directionX = rear ? -1 : 1, originX = 2000, travel = 20 + time * 600;
  for (const p of result.players) Object.assign(p, { waveBlinkReady: null, waveBlinkRevision: 0, lastWaveBlink: null,
    dyson: null, dysonReady: null, dysonCooldown: 0, dysonRevision: 0, lastDysonEnd: null });
  const blast = { id: 'wave-one', ownerId: 'pilot', sourceCellId: 'source', x: originX + directionX * travel, y: 4000,
    originX, originY: 4000, directionX, directionY: 0, speed: 600, travel, distance: 420,
    width: 160, curvature: 30, thickness: 20, mode: rear ? 'rear' : 'forward', color: '#83d9ff', blinkUsed: false };
  result.blasts = [blast];
  if (blink) own.waveBlinkReady = { waveId: blast.id, sourceCellId: 'source', x: blast.x, y: blast.y,
    originX, originY: 4000, directionX, directionY: 0, speed: 600, travel, distance: 420,
    expiresAt: 400 / 600, launchAt: -20 / 600 };
  if (dyson) own.dysonReady = { id: 'dyson-mark', waveId: 'wave-hit', sourceCellId: 'source',
    targetId: 'target', targetCellId: 'target-core', hitAt: 0, expiresAt: .9, directionX: 1, directionY: 0 };
  if (active) {
    own.dysonRevision = 1;
    own.dyson = { id: 'shell-one', sourceCellId: 'source', targetId: 'target', targetCellId: 'target-core',
      startedAt: 0, endsAt: 2.4, x: 6000, y: 4000, radius: 40, capturedMass: 0, directionX: 1, directionY: 0 };
    own.cells[0].dysonId = 'shell-one';
  }
  return result;
}

function client(initial, ping = 0) {
  let clock = 0;
  const sent = [], nodes = new Map(), listeners = new Map(), drawings = [];
  const context2d = new Proxy({}, { get: (_, key) => key.startsWith('create') ? () => ({ addColorStop() {} }) : () => {}, set: () => true });
  const node = id => {
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id, { id, hidden: false, style: { setProperty() {} }, dataset: {}, width: 0, height: 0,
        classList: { add: (...names) => names.forEach(name => classes.add(name)), remove: (...names) => names.forEach(name => classes.delete(name)), contains: name => classes.has(name),
          toggle(name, enabled) { if (enabled ?? !classes.has(name)) classes.add(name); else classes.delete(name); } },
        setAttribute(name, value) { this[name] = value; }, focus() {}, appendChild(child) { return child; },
        addEventListener(type, handler) { const key = `${id}:${type}`, list = listeners.get(key) || []; list.push(handler); listeners.set(key, list); },
        querySelectorAll() { return []; }, getContext() { return context2d; }, closest() { return null; },
        getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; }, setPointerCapture() {},
      });
    }
    return nodes.get(id);
  };
  const document = { hidden: false, body: { style: {}, dataset: {}, appendChild(child) { return child; } },
    head: { appendChild() {} }, getElementById: node, createElement: tag => node(`created-${tag}`), querySelector: node,
    addEventListener() {}, fullscreenElement: null };
  const context = vm.createContext({ innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
    window: { blinkDrawing: context2d }, document, performance: { now: () => clock }, WebSocket: { OPEN: 1 },
    requestAnimationFrame() {}, cancelAnimationFrame() {}, setTimeout() { return 1; }, clearTimeout() {}, clearInterval() {},
    addEventListener(type, handler) { const key = `window:${type}`, list = listeners.get(key) || []; list.push(handler); listeners.set(key, list); },
  });
  const hooks = `window.blinkClientTest = {
    start(state,ping) { install();active=true;joined=true;myId='pilot';token='test-token';rtt=ping;
      socket={readyState:1,send:data=>window.onSend(JSON.parse(data)),close(){}};
      this.packet(state);ctx=window.blinkDrawing;
      drawBackground=drawArena=drawMinimap=drawDust=drawMeteor=drawGravity=drawWaveFeedback=()=>{};
      drawPlanet=(p,c,pos)=>window.onDraw({kind:'planet',playerId:p.id,cellId:c.id,x:pos.x,y:pos.y});
      drawBlast=(b,at,pose)=>window.onDraw({kind:'wave',id:b.id,...pose});drawDyson=()=>{}; },
    packet(state) { const previous=room;ingestSnapshot(state,performance.now());room=state;receiveWaveClashes(state,previous);cacheWaveVisuals(state,previous); },
    frame(dt) { predictOwn(dt,performance.now()); }, render() { render(performance.now()); },
    ref(id,owner='pilot') { return owner===myId?predictedCells.get(id):remotePhysics.get(owner+':'+id); },
    combo() { return comboReady(room.players.find(p=>p.id===myId),performance.now()); },
    marker() { return comboTargetPose(room?.players?.find(p=>p.id===myId),performance.now()); },
    remaining() { return waveBlinkRemaining(room.players.find(p=>p.id===myId),performance.now()); },
    pose(id='wave-one') { return wavePose(waveVisuals.get(id)?.blast||room.blasts.find(b=>b.id===id),performance.now()); },
    wave(id='wave-one') { return waveVisuals.get(id); },
    timeline() { return renderTimeline; },
    hud() { updateHud(true); },send:sendInput,
    camera() { return camera; }, updateCamera,
    effective(id) { const p=room.players.find(p=>p.id===myId),c=p.cells.find(c=>c.id===id);return c?effectiveCell(p,c,performance.now()):null; },
    dirty(id) { const key='pilot:'+id,ref=predictedCells.get(id);Object.assign(ref,{offsetX:70,offsetY:-20,correctionX:100,correctionY:-50,contactUntil:500,normals:[{x:1,y:0}]});
      contactEpisodes.set(key+'|target:target-core',{fixture:true});remoteContactPositions.set(key,{x:1,y:1});drawnPlayers.set(key,{x:1,y:1}); },
    contacts(id) { const key='pilot:'+id;return [...contactEpisodes.keys()].some(pair=>pair.split('|').includes(key))||remoteContactPositions.has(key); },
    track(id,owner='pilot') { return cellTracks.get(owner+':'+id); },
    reconnect:attemptReconnect,resume(state) { reconnecting=false;this.packet(state); },close() { closeSession(false); },
  };`;
  context.window.onSend = message => sent.push(message);
  context.window.onDraw = item => drawings.push(item);
  const instrumented = source.replace('  window.StarGame = {', `${hooks}\n  window.StarGame = {`);
  assert.notEqual(instrumented, source, 'regression hooks must attach to the shipped client');
  vm.runInContext(instrumented, context, { filename: 'public/game.js' });
  const api = context.window.blinkClientTest; api.start(initial, ping);
  function dispatch(key, event = {}) { for (const handler of listeners.get(key) || []) handler({ target: node('gameCanvas'), repeat: false, preventDefault() {}, ...event }); }
  return { api, sent, drawings, node, time: value => { clock = value; },
    key: (code, repeat = false) => dispatch('window:keydown', { code, key: code, repeat }),
    release: code => dispatch('window:keyup', { code, key: code }),
    touch: () => dispatch('sgTouchSplit:pointerdown', { pointerType: 'touch', pointerId: 1 }),
  };
}

function blinkPacket(previous, { time = .11, owner = 'pilot', ids = ['source'], latest = ids.at(-1), dx = 100 } = {}) {
  const next = structuredClone(previous), p = player(next, owner);
  next.time = time; next.simulationTime = time * 1000;
  p.waveBlinkReady = null; p.waveBlinkRevision += ids.length;
  for (const id of ids) {
    const cell = p.cells.find(c => c.id === id), eventId = `blink-${id}`;
    cell.x += dx; cell.y += 25; cell.lastWaveBlinkId = eventId;
    if (id === latest) p.lastWaveBlink = { id: eventId, waveId: `wave-${id}`, sourceCellId: id, at: time,
      fromX: cell.x - dx, fromY: cell.y - 25, x: cell.x, y: cell.y, vx: cell.vx, vy: cell.vy };
  }
  next.blasts[0].blinkUsed = true;
  return next;
}

test('front and rear wave combos accept fresh Space or touch below split mass without a speculative local warp', () => {
  for (const rear of [false, true]) for (const control of ['keyboard', 'touch']) {
    const c = client(state({ rear })), ref = c.api.ref('source'), before = { ...ref.model };
    assert.equal(c.api.combo().kind, 'blink');
    if (control === 'keyboard') c.key('Space'); else c.touch();
    assert.equal(c.sent.filter(message => message.split).length, 1);
    assert.ok(c.sent.every(message => !message.fire && !message.rearFire));
    assert.equal(c.api.ref('source'), ref); near(ref.x, before.x); near(ref.model.x, before.x);
    assert.equal(ref.model.mass, 36, 'requesting a combo cannot speculate an ordinary split');
  }
});

test('held Space does not auto-activate a newly arriving wave opportunity', () => {
  const c = client(state({ blink: false })); c.key('Space');
  c.time(20); c.api.packet(state({ time: .02 }));
  c.key('Space', true); c.api.send(); c.api.send();
  assert.equal(c.sent.filter(message => message.split).length, 0);
  c.release('Space'); c.key('Space');
  assert.equal(c.sent.filter(message => message.split).length, 1, 'only a fresh press sends the shared action pulse');
});

test('a real-hit Dyson mark wins over blink, and an active shell blocks the whole combo action', () => {
  const c = client(state({ dyson: true }));
  assert.equal(c.api.combo().kind, 'dyson'); c.api.hud();
  assert.match(c.node('sgTouchSplit').textContent, /戴森球/);
  assert.equal(c.node('sgComboPrompt').hidden, false); assert.equal(c.node('sgComboPrompt').dataset.kind, 'dyson');
  assert.equal(c.node('sgComboAction').textContent, '戴森球'); assert.equal(c.node('sgTouchSplit').dataset.combo, 'ready');
  const marker = c.api.marker(), target = c.api.ref('target-core', 'target');
  near(marker.x, target.model.x); near(marker.y, target.model.y);
  c.key('Space'); assert.equal(c.sent.filter(message => message.split).length, 1);
  const wrapped = client(state({ active: true, dyson: true }));
  for (const code of ['Space', 'KeyE', 'KeyR']) { wrapped.key(code); wrapped.release(code); }
  wrapped.touch();
  assert.ok(wrapped.sent.every(message => !message.split && !message.fire && !message.rearFire));
});

test('removing the newest authoritative opportunity cannot fall back to an older cached live wave or a used tail', () => {
  for (const reason of ['hit', 'used', 'cancelled', 'gone']) {
    const initial = state(), older = { ...initial.blasts[0], id: 'older-wave', travel: 0, x: 2000 };
    initial.blasts.unshift(older);
    const c = client(initial), next = state({ time: .1, blink: false });
    next.blasts.unshift({ ...older, travel: 60, x: 2060 });
    if (reason === 'used') next.blasts[1].blinkUsed = true;
    if (reason === 'gone' || reason === 'cancelled') next.blasts.splice(1);
    if (reason === 'cancelled') next.waveClashes = [{ id: 'cancel', at: .1, waveIds: ['wave-one', 'enemy-wave'], ownerIds: ['pilot', 'target'], x: 2080, y: 4000 }];
    c.time(100); c.api.packet(next); c.api.hud();
    assert.ok(!c.api.combo(), `${reason} must remove eligibility even while another cached own wave exists`);
    assert.equal(c.api.remaining(), 0); c.key('Space'); c.touch();
    assert.ok(c.sent.every(message => !message.split));
    assert.doesNotMatch(c.node('sgTouchSplit').textContent, /瞬移/);
  }
  const expired = client(state()); expired.time(800); expired.api.hud(); expired.key('Space');
  assert.equal(expired.api.remaining(), 0); assert.ok(!expired.api.combo());
  assert.ok(expired.sent.every(message => !message.split));
  const ordinary = client(state({ blink: false, mass: 72 })); ordinary.key('Space');
  assert.ok(ordinary.sent.some(message => message.split), 'ordinary split remains the final fallback');
});

test('a short authoritative blink resets only its source epoch and old contacts while preserving wave and sibling continuity', () => {
  const initial = state({ extraCore: true }), c = client(initial);
  c.time(100); c.api.frame(.1); c.api.updateCamera(.1); c.api.dirty('source');
  const sibling = c.api.ref('unrelated'), siblingModel = sibling.model, siblingAt = sibling.modelAt,
    siblingBefore = { ...siblingModel }, timeline = c.api.timeline(), wave = c.api.wave();
  const next = blinkPacket(state({ time: .11, extraCore: true }));
  Object.assign(player(next).cells[0], { vx: 15, vy: -8 });
  Object.assign(player(next).lastWaveBlink, { vx: 15, vy: -8 });
  c.time(110); c.api.packet(next);
  const ref = c.api.ref('source');
  near(ref.x, 2100); near(ref.y, 4025); near(ref.model.x, 2100);
  near(ref.offsetX || 0, 0); near(ref.correctionX || 0, 0); assert.equal(ref.contactUntil || 0, 0);
  assert.equal(ref.normals.length, 0); assert.equal(c.api.contacts('source'), false);
  assert.equal(c.api.track('source').length, 1, 'interpolation cannot carry a segment across the teleport');
  assert.equal(c.api.ref('unrelated'), sibling); assert.equal(sibling.model, siblingModel);
  assert.equal(sibling.modelAt, siblingAt); near(siblingModel.x, siblingBefore.x); near(siblingModel.vx, siblingBefore.vx);
  assert.equal(c.api.timeline(), timeline); near(c.api.wave().launchAt, wave.launchAt);
  c.api.updateCamera(0);
  const centerX = (ref.x * ref.model.mass + sibling.x * sibling.model.mass) / (ref.model.mass + sibling.model.mass);
  near(c.api.camera().targetX, centerX);
  c.time(110 + 1000 / 60); c.api.frame(1 / 60);
  assert.ok(ref.x > 2100 && ref.x < 2101, 'the post-blink frame must integrate only its new epoch');
  assert.ok(sibling.model.x > siblingBefore.x, 'unrelated drift must continue across the teleport packet');
  const x = ref.x, velocity = ref.model.vx;
  c.time(135); c.api.packet(structuredClone(next));
  assert.equal(c.api.ref('source'), ref); near(ref.x, x); near(ref.model.vx, velocity);
});

for (const remote of [false, true]) {
  test(`coalesced per-cell blink ids reseed both ${remote ? 'remote' : 'own'} sources once even when only the latest event survives`, () => {
    const initial = state({ extraCore: true, remote }), owner = remote ? 'target' : 'pilot', c = client(initial);
    c.time(100); c.api.frame(.1);
    const first = c.api.ref('source', owner), second = c.api.ref('unrelated', owner);
    first.offsetX = second.offsetX = 40; first.contactUntil = second.contactUntil = 500;
    const next = blinkPacket(initial, { owner, ids: ['source', 'unrelated'] });
    c.time(110); c.api.packet(next);
    for (const id of ['source', 'unrelated']) {
      const ref = c.api.ref(id, owner), cell = player(next, owner).cells.find(cell => cell.id === id);
      near(ref.model.x, cell.x); near(ref.model.y, cell.y); near(ref.offsetX || 0, 0);
      assert.equal(c.api.track(id, owner).length, 1);
    }
    c.time(110 + 1000 / 60); c.api.frame(1 / 60);
    const current = ['source', 'unrelated'].map(id => ({ ref: c.api.ref(id, owner), x: c.api.ref(id, owner).model.x }));
    c.time(135); c.api.packet(structuredClone(next));
    for (const [i, id] of ['source', 'unrelated'].entries()) {
      assert.equal(c.api.ref(id, owner), current[i].ref); near(c.api.ref(id, owner).model.x, current[i].x);
    }
  });
}

test('a source blink cannot revive a consumed unrelated sibling donor from an older snapshot', () => {
  const initial = state({ extraCore: true }), own = player(initial), receiver = own.cells[1];
  const donor = { ...receiver, id: 'old-donor', mass: .1, radius: 4 * Math.sqrt(.1) };
  Object.assign(receiver, { mass: 71.9, radius: 4 * Math.sqrt(71.9), vx: 0, vy: 0, mergeIn: 0,
    fusionId: 'old-pair', fusionRole: 'receiver', fusionDonorId: donor.id, fusionPartnerId: donor.id, fusionTime: .01, fusionProgress: .99 });
  Object.assign(donor, { x: receiver.x + receiver.radius + donor.radius, vx: 0, vy: 0, mergeIn: 0,
    fusionId: 'old-pair', fusionRole: 'donor', fusionTargetId: receiver.id, fusionPartnerId: receiver.id, fusionTime: .01, fusionProgress: .99 });
  own.cells.push(donor); own.mass = 108;
  const c = client(initial); c.time(20); c.api.frame(.02);
  const receiverRef = c.api.ref(receiver.id), donorRef = c.api.ref(donor.id), completed = receiverRef.model._completedFusionId;
  assert.ok(completed); assert.equal(donorRef.model.mass, 0);
  const next = blinkPacket(initial, { time: .025 }); c.time(25); c.api.packet(next);
  assert.equal(c.api.ref(receiver.id), receiverRef); assert.equal(c.api.ref(donor.id), donorRef);
  assert.equal(receiverRef.model._completedFusionId, completed); assert.equal(donorRef.model.mass, 0);
  assert.equal(c.api.effective(donor.id), null);
});

for (const fps of [60, 120]) {
  test(`${fps} FPS blink reticle shares the continuous wave front under packet jitter`, () => {
    const c = client(state(), 360), packets = [], delays = [16, 50, 20, 66, 33, 10];
    let deliveredAt = 0;
    for (let tick = 1; tick <= 6; tick++) {
      const time = tick / 15, delivery = Math.max(deliveredAt + 1, time * 1000 + delays[tick - 1]);
      packets.push({ delivery, snapshot: state({ time }) }); deliveredAt = delivery;
    }
    let previous, delivered = 0;
    for (let frame = 1; frame <= fps * .45; frame++) {
      const now = frame * 1000 / fps; c.time(now);
      while (packets[0]?.delivery <= now) {
        const before = c.api.pose(); c.api.packet(packets.shift().snapshot); const after = c.api.pose();
        near(after.x, before.x); near(after.y, before.y); delivered++;
      }
      c.api.frame(1 / fps);
      const combo = c.api.combo(), pose = c.api.pose(), marker = c.api.marker();
      assert.equal(combo?.kind, 'blink');
      assert.equal(marker?.kind, 'blink'); near(marker.x, pose.x); near(marker.y, pose.y);
      c.api.hud();
      assert.equal(c.node('sgComboPrompt').hidden, false); assert.equal(c.node('sgComboPrompt').dataset.kind, 'blink');
      assert.equal(c.node('sgComboAction').textContent, '瞬移'); assert.equal(c.node('sgTouchSplit').dataset.combo, 'blink');
      assert.match(c.node('sgComboTime').textContent, /^0\.[0-9]s$/); assert.ok(parseFloat(c.node('sgComboFill').style.width) > 0);
      assert.ok(pose.active); if (previous) assert.ok(pose.x > previous.x && (pose.x - previous.x) * fps < 650);
      previous = pose;
    }
    assert.ok(delivered >= 5, 'the regression must receive actual jittered updates during a live wave');
  });
}

test('death, cancellation, round changes, reconnect and leave clear the old blink cue', () => {
  for (const transition of ['death', 'cancel', 'round', 'room']) {
    const c = client(state()); c.api.hud(); assert.match(c.node('sgTouchSplit').textContent, /瞬移/);
    const next = state({ time: .1, blink: false, round: transition === 'round' ? 2 : 1, code: transition === 'room' ? 'NEW' : 'BLINK' });
    if (transition === 'death') { player(next).cells = []; player(next).respawnIn = 2; }
    if (transition === 'cancel') { next.blasts = []; next.waveClashes = [{ id: 'cancel', at: .1, waveIds: ['wave-one'], ownerIds: ['pilot'], x: 2080, y: 4000 }]; }
    c.time(100); c.api.packet(next); c.api.hud();
    assert.ok(!c.api.combo()); assert.doesNotMatch(c.node('sgTouchSplit').textContent, /瞬移/);
    assert.equal(c.node('sgComboPrompt').hidden, true); assert.equal(c.api.marker(), null);
    c.key('Space'); assert.ok(c.sent.every(message => !message.split));
  }
  const c = client(state()); c.api.reconnect(); c.api.hud(); assert.ok(!c.api.combo());
  assert.doesNotMatch(c.node('sgTouchSplit').textContent, /瞬移/);
  c.time(50); c.api.resume(state({ time: .05 })); assert.equal(c.api.combo().kind, 'blink');
  c.api.close(); c.drawings.length = 0; c.api.render();
  assert.ok(!c.api.combo()); assert.equal(c.drawings.length, 0);
});

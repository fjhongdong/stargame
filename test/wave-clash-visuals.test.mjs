import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createArena, addPlayer, setPlayerInput, stepArena, snapshotArena } from '../shared/engine.js';

const source = await readFile(new URL('../public/game.js', import.meta.url), 'utf8');
function clashFixture(rear = false) {
  const arena = createArena({ endless: true, random: () => .99 });
  arena.status = 'playing'; arena.round = 1;
  for (const [id, x, direction] of [['pilot', 9000, 1], ['left', 1000, 1], ['right', 1400, rear ? 1 : -1]]) {
    const player = addPlayer(arena, { id });
    Object.assign(player, { x, y: 4000, energy: 100, invulnerable: 0, direction: { x: direction, y: 0 } });
    Object.assign(player.cells[0], { x, y: 4000, vx: 0, vy: 0 });
  }
  arena.dust = Array.from({ length: 6000 }, (_, id) => ({ id: `far-${id}`, x: 11000, y: 7000, value: 1, vx: 0, vy: 0 }));
  setPlayerInput(arena, 'left', { fire: true });
  setPlayerInput(arena, 'right', rear ? { rearFire: true } : { fire: true });
  stepArena(arena, 0);
  for (let tick = 0; tick < 18; tick++) stepArena(arena, .01);
  const snapshot = () => ({ code: 'CLASH', ...snapshotArena(arena) });
  const before = snapshot(); assert.equal(before.blasts.length, 2);
  for (let tick = 0; tick < 20 && !arena.waveClashes?.length; tick++) stepArena(arena, .01);
  const after = snapshot();
  assert.equal(after.waveClashes.length, 1, 'the fixture must produce a real authoritative cancellation');
  assert.equal(after.blasts.length, 0);
  return { arena, before, after, snapshot };
}

function client() {
  let clock = 0;
  const nodes = new Map(), drawn = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { hidden: true, textContent: '', dataset: {}, style: {}, classList: { add() {}, remove() {} } });
    return nodes.get(id);
  };
  const canvas = new Proxy({}, { get: () => () => {}, set: () => true });
  const context = vm.createContext({ innerWidth: 1280, innerHeight: 800,
    window: { StarAudio: { play() {} } }, document: { getElementById: node },
    performance: { now: () => clock }, WebSocket: { OPEN: 1 }, requestAnimationFrame() {},
    setTimeout() { return 1; }, clearTimeout() {}, testCanvas: canvas, recordWave: wave => drawn.push(wave) });
  const hooks = `window.waveClashTest = {
    start(state, id='pilot') {
      active=true;myId=id;ctx=testCanvas;socket={readyState:1,send(){}};
      previousStatus='playing';previousRound=state.round;
      updateHud=()=>{};focusGame=()=>{};toast=()=>{};
      drawBackground=()=>{};drawArena=()=>{};drawMinimap=()=>{};drawPlanet=()=>{};drawDust=()=>{};drawGravity=()=>{};
      predictOwn=()=>{};updateCamera=()=>{};camera={x:1200,y:4000,scale:.95};
      const originalDraw=drawBlast;
      drawBlast=(blast,time,pose)=>{recordWave({id:blast.id,tail:pose.tail,active:pose.active});return originalDraw(blast,time,pose)};
      receiveRoom(state);
    },
    packet:receiveRoom,
    render() { render(performance.now()); },
    particles() { return particles.map(p=>({...p})); },
    waves() { return Array.from(waveVisuals.keys()); },
    pose(blast) { return wavePose(blast,performance.now()); },
    cancelled() { return Array.from(cancelledWaves.keys()); },
    seen() { return Array.from(seenWaveClashes.keys()); },
  };`;
  const instrumented = source.replace('  window.StarGame = {', `${hooks}\n  window.StarGame = {`);
  assert.notEqual(instrumented, source, 'the hook must attach to the shipped client');
  vm.runInContext(instrumented, context, { filename: 'public/game.js' });
  return { api: context.window.waveClashTest, time: value => { clock = value; },
    drawn, clearDrawn: () => { drawn.length = 0; }, marker: () => node('sgWaveFeedback') };
}
const flashes = c => c.api.particles().filter(particle => particle.kind === 'wave-clash');

for (const rear of [false, true]) {
  test(`${rear ? 'forward versus rear' : 'opposing forward'} cancellation removes both cached remote arcs and their trails immediately`, () => {
    const f = clashFixture(rear), c = client(); c.time(180); c.api.start(structuredClone(f.before)); c.api.render();
    assert.equal(c.api.waves().length, 2);
    assert.equal(c.drawn.length, 2); assert.ok(c.drawn.every(wave => wave.active && wave.tail > 0), 'both actual remote wave trails must be visible before the clash');
    c.clearDrawn(); c.time(f.after.time * 1000); c.api.packet(structuredClone(f.after));
    assert.equal(c.api.waves().length, 0, 'cancellation must bypass the ordinary missing-remote grace window');
    c.api.render(); assert.equal(c.drawn.length, 0, 'neither the front nor its old tail reaches Canvas after cancellation');
    assert.equal(flashes(c).length, 1); assert.equal(flashes(c)[0].clashId, f.after.waveClashes[0].id);
    assert.equal(c.marker().hidden, true, 'an unrelated observer must not receive a personal combat marker');
    for (const wave of f.before.blasts) assert.equal(c.api.pose(wave).active, false, 'an old pose cannot resurrect the cancelled arc');
    c.time(f.after.time * 1000 + 50); c.api.render(); assert.equal(c.drawn.length, 0);
  });
}

test('a player whose wave was cancelled receives the clash marker without leaving either arc behind', () => {
  const f = clashFixture(), c = client(); c.time(180); c.api.start(structuredClone(f.before), 'left');
  c.time(220); c.api.packet(structuredClone(f.after)); c.api.render();
  assert.equal(c.api.waves().length, 0); assert.equal(c.drawn.length, 0);
  assert.equal(c.marker().hidden, false); assert.match(c.marker().textContent, /引力波抵消/);
  assert.equal(c.marker().dataset.kind, 'clash'); assert.equal(c.marker().dataset.mode, 'clash');
});

test('persistent cancellation metadata deduplicates feedback across an omitted event frame and rejects stale arcs', () => {
  const f = clashFixture(), c = client(); c.time(180); c.api.start(structuredClone(f.before));
  c.time(220); c.api.packet(structuredClone(f.after));
  const first = flashes(c)[0]; assert.ok(first);
  const duplicate = structuredClone(f.after); duplicate.time += .05; duplicate.simulationTime += 50;
  c.time(270); c.api.packet(duplicate);
  assert.equal(flashes(c).length, 1, 'a persistent event must not replay its flash for every state');
  const omitted = structuredClone(duplicate); delete omitted.waveClashes;
  omitted.time += .03; omitted.simulationTime += 30;
  c.time(300); c.api.packet(omitted);
  const stale = structuredClone(duplicate); stale.time += .08; stale.simulationTime += 80;
  stale.blasts = structuredClone(f.before.blasts); stale.waveClashes = [];
  c.time(330); c.api.packet(stale);
  assert.equal(c.api.waves().length, 0, 'brief event omission must not clear the cancelled-wave guard');
  const again = structuredClone(stale); again.blasts = []; again.waveClashes = structuredClone(f.after.waveClashes);
  again.time += .02; again.simulationTime += 20;
  c.time(360); c.api.packet(again);
  assert.equal(flashes(c).length, 1); assert.equal(flashes(c)[0].clashId, first.clashId);
  c.api.render(); assert.equal(c.drawn.length, 0);
});

test('a fresh baseline remembers a still-retained clash without replaying old feedback', () => {
  const f = clashFixture(), c = client(); c.time(220); c.api.start(structuredClone(f.after));
  assert.equal(flashes(c).length, 0, 'joining or reconnecting supplies history rather than a new local clash');
  assert.equal(c.api.waves().length, 0);
  for (const id of f.after.waveClashes[0].waveIds) assert.ok(c.api.cancelled().includes(id));
  c.time(270); c.api.packet(structuredClone(f.after)); assert.equal(flashes(c).length, 0);
  const stale = structuredClone(f.after); stale.blasts = structuredClone(f.before.blasts);
  c.time(300); c.api.packet(stale); c.api.render(); assert.equal(c.drawn.length, 0);
});

test('a clash event removes stale arcs even when the same packet still contains their old visual state', () => {
  const f = clashFixture(), c = client(); c.time(180); c.api.start(structuredClone(f.before));
  const mixed = structuredClone(f.after); mixed.blasts = structuredClone(f.before.blasts);
  c.time(220); c.api.packet(mixed); c.api.render();
  assert.equal(c.api.waves().length, 0); assert.equal(c.drawn.length, 0);
  assert.equal(flashes(c).length, 1);
});

test('a delayed fresh event still flashes once after both old remote fronts have already disappeared', () => {
  const f = clashFixture(), c = client(); c.time(180); c.api.start(structuredClone(f.before));
  const missing = structuredClone(f.after); delete missing.waveClashes;
  c.time(220); c.api.packet(missing);
  c.time(340); c.api.render(); assert.equal(c.api.waves().length, 0, 'ordinary omission cleanup must finish before the delayed event arrives');
  const delayed = structuredClone(f.after); delayed.time = .36; delayed.simulationTime = 360;
  c.time(360); c.api.packet(delayed);
  assert.equal(flashes(c).length, 1, 'fresh feedback does not depend on an old cached front still existing');
  c.time(390); c.api.packet(structuredClone(delayed)); assert.equal(flashes(c).length, 1);
});

test('a reconnect baseline watermark suppresses an older retained event omitted from its first packet', () => {
  const f = clashFixture(), c = client(), baseline = structuredClone(f.after); baseline.waveClashes = [];
  c.time(220); c.api.start(baseline);
  const retained = structuredClone(f.after); retained.time += .05; retained.simulationTime += 50;
  c.time(270); c.api.packet(retained);
  assert.equal(flashes(c).length, 0, 'an event older than the first snapshot is history even if it appears a packet later');
  for (const id of f.after.waveClashes[0].waveIds) assert.ok(c.api.cancelled().includes(id));
  for (const wave of f.before.blasts) assert.equal(c.api.pose(wave).active, false);
});

test('cancellation deduplication and wave guards stay bounded throughout an endless session', () => {
  const f = clashFixture(), c = client(), empty = structuredClone(f.before); empty.blasts = []; empty.waveClashes = [];
  empty.dust = [];
  c.api.start(empty);
  let peakSeen = 0, peakCancelled = 0, recent;
  for (let event = 0; event < 1200; event++) {
    const state = structuredClone(empty), time = 1 + event * .2;
    recent = `long-session-${event}`;
    state.time = time; state.simulationTime = time * 1000;
    state.waveClashes = [{ id: recent, at: time, x: 1200, y: 4000, radius: 24,
      waveIds: [`long-${event}-a`, `long-${event}-b`], ownerIds: ['left', 'right'], colors: ['#83d9ff', '#ffbd68'] }];
    c.time(time * 1000); c.api.packet(state); c.api.render();
    peakSeen = Math.max(peakSeen, c.api.seen().length); peakCancelled = Math.max(peakCancelled, c.api.cancelled().length);
  }
  assert.ok(peakSeen < 1000 && peakCancelled < 1000, `historical metadata grew without a useful bound: ${peakSeen}/${peakCancelled}`);
  assert.ok(c.api.seen().includes(recent)); assert.ok(c.api.cancelled().includes('long-1199-a'));
  assert.ok(!c.api.seen().includes('long-session-0')); assert.ok(!c.api.cancelled().includes('long-0-a'));
});

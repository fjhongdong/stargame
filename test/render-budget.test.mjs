import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { integrateMotion, movementSpeed } from '../shared/engine.js';

const source = await readFile(new URL('../public/game.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function client() {
  let clock = 0, backingWidth = 0, backingHeight = 0, writes = 0;
  const sent = [];
  const canvas = {
    style: { width: '100%', height: '100%' },
    get width() { return backingWidth; }, set width(value) { backingWidth = value; writes++; },
    get height() { return backingHeight; }, set height(value) { backingHeight = value; writes++; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 1920, height: 1080 }; },
  };
  const drawing = new Proxy({}, { get: () => () => {}, set: () => true });
  const context = vm.createContext({ innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 2,
    window: { budgetCanvas: canvas, budgetContext: drawing, onSend: message => sent.push(message) },
    document: { hidden: false },
    performance: { now: () => clock }, WebSocket: { OPEN: 1 }, requestAnimationFrame() {},
  });
  const hooks = `window.renderBudgetTest = {
    start() {
      active=true;myId='pilot';rtt=0;canvas=window.budgetCanvas;ctx=window.budgetContext;
      socket={readyState:1,send:data=>window.onSend(JSON.parse(data))};
      const state={code:'BUDGET',round:1,status:'playing',simulationTime:0,time:0,
        arena:{width:12000,height:8000},dust:[],blasts:[],meteors:[],players:[{
          id:'pilot',name:'pilot',color:'#83d9ff',connected:true,mass:36,radius:24,
          vx:0,vy:0,stats:{speed:1},steering:{x:0,y:0},
          cells:[{id:'core',x:6000,y:4000,mass:36,radius:24,vx:0,vy:0}]
        }]};
      ingestSnapshot(state,performance.now());room=state;
      camera={x:6000,y:4000,scale:.95};resize();updateCamera(0);
    },
    resize,
    quality(at,interval) {updateRenderQuality(at,interval);},
    press(code) { keys.clear();if(code)keys.add(code);sendInput(); },
    touch(x,y) {keys.clear();touchVector={x,y};sendInput();},
    input:sendInput,
    frame(dt) {predictOwn(dt,performance.now());updateCamera(dt);},
    state() {return {width,height,dpr,renderScale,view:getCamera(),position:getOwnCenter(),intent:getIntent(),
      model:{...predictedCells.get('core').model},backgroundPresent:Boolean(backgroundCanvas)};},
    seedBackground() {backgroundCanvas={sentinel:true};},
    group(cells,input,dt) {siblingEnabled=true;let moves=0;advanceCellGroup(cells,{stats:{speed:1}},input,dt,()=>moves++);return {cells,moves};},
  };`;
  const instrumented = source.replace('  window.StarGame = {', `${hooks}\n  window.StarGame = {`);
  assert.notEqual(instrumented, source);
  vm.runInContext(instrumented, context, { filename: 'public/game.js' });
  return { api: context.window.renderBudgetTest, sent, canvas, context,
    time: value => { clock = value; }, writes: () => writes };
}

test('the initial high-DPI backing store has a bounded pixel budget while the viewport retains CSS dimensions', () => {
  const c = client(); c.api.start(); const state = c.api.state();
  assert.ok(c.canvas.width * c.canvas.height <= 2_200_000,
    'a 1920x1080 high-DPI display must not allocate the old 4.67 megapixel frame');
  assert.ok(c.canvas.width > 0 && c.canvas.height > 0);
  assert.equal(state.width, 1920); assert.equal(state.height, 1080);
  assert.equal(c.canvas.style.width, '100%'); assert.equal(c.canvas.style.height, '100%');
});

test('changing only backing resolution preserves world geometry, camera, keyboard and touch intent, and network viewport', () => {
  const c = client(); c.api.start(); c.api.press('ArrowRight');
  const before = plain(c.api.state()), beforePacket = c.sent.at(-1), beforePixels = c.canvas.width * c.canvas.height;
  c.context.devicePixelRatio = .75; c.api.resize(); c.api.input();
  const after = plain(c.api.state()), afterPacket = c.sent.at(-1);
  assert.notEqual(c.canvas.width * c.canvas.height, beforePixels, 'the fixture must actually change backing resolution');
  assert.deepEqual(after.view, before.view); assert.deepEqual(after.position, before.position); assert.deepEqual(after.model, before.model);
  assert.deepEqual(after.intent, before.intent); assert.deepEqual(afterPacket.viewport, beforePacket.viewport);
  assert.equal(afterPacket.x, beforePacket.x); assert.equal(afterPacket.y, beforePacket.y);
  c.api.touch(.6, .8); const touchBefore = plain(c.api.state().intent), packetBefore = c.sent.at(-1);
  c.context.devicePixelRatio = 2; c.api.resize(); c.api.input();
  assert.deepEqual(plain(c.api.state().intent), touchBefore);
  assert.equal(c.sent.at(-1).x, packetBefore.x); assert.equal(c.sent.at(-1).y, packetBefore.y);
});

test('steady frame pressure adapts only at hysteretic intervals without changing physics or oscillating on brief headroom', () => {
  const c = client(); c.api.start();
  const original = plain(c.api.state()), changes = [];
  let previousScale = original.renderScale;
  for (let at = 1000 / 30; at <= 12000; at += 1000 / 30) {
    c.time(at); c.api.quality(at, 1000 / 30);
    const scale = c.api.state().renderScale;
    if (scale !== previousScale) { changes.push({ at, scale }); previousScale = scale; }
  }
  assert.ok(changes.length > 0 && changes.length <= 3, 'sustained pressure must make a few discrete reductions rather than resize every frame');
  assert.ok(changes[0].at >= 2000, 'initial loading gets a warmup before quality changes');
  for (let i = 1; i < changes.length; i++) {
    assert.ok(changes[i].at - changes[i - 1].at >= 1500 - 1e-6);
    assert.ok(changes[i].scale < changes[i - 1].scale);
  }
  assert.equal(c.api.state().renderScale, .65); assert.ok(c.writes() <= 8);
  const afterPressure = plain(c.api.state());
  assert.deepEqual(afterPressure.view, original.view); assert.deepEqual(afterPressure.position, original.position);
  assert.deepEqual(afterPressure.model, original.model); assert.deepEqual(afterPressure.intent, original.intent);
  const floorWrites = c.writes();
  for (let at = 12000 + 1000 / 60; at <= 20000; at += 1000 / 60) { c.time(at); c.api.quality(at, 1000 / 60); }
  assert.equal(c.api.state().renderScale, .65); assert.equal(c.writes(), floorWrites,
    'a short improvement must not immediately restore resolution and create a resize oscillation');
  for (let at = 20000 + 1000 / 60; at <= 26000; at += 1000 / 60) { c.time(at); c.api.quality(at, 1000 / 60); }
  assert.equal(c.api.state().renderScale, .7); assert.equal(c.writes(), floorWrites + 2,
    'sustained headroom should recover one small resolution step');
});

test('a CSS resize invalidates the baked background even when compensating DPR keeps the backing dimensions unchanged', () => {
  const c = client(); c.api.start(); c.api.seedBackground();
  const before = { width: c.canvas.width, height: c.canvas.height, writes: c.writes() };
  c.context.innerWidth = 1280; c.context.innerHeight = 720; c.api.resize();
  assert.equal(c.canvas.width, before.width); assert.equal(c.canvas.height, before.height);
  assert.equal(c.writes(), before.writes, 'an unchanged backing store should not be unnecessarily reallocated');
  assert.equal(c.api.state().width, 1280); assert.equal(c.api.state().height, 720);
  assert.equal(c.api.state().backgroundPresent, false, 'the background depends on CSS dimensions and DPR as well as backing dimensions');
  c.api.seedBackground(); c.api.resize();
  assert.equal(c.api.state().backgroundPresent, true, 'an identical resize must preserve the valid cache');
});

test('the single-core fast path preserves inertia, expires grace and clears orphan fusion links without reviving consumed cells', () => {
  const c = client();
  const core = { id: 'only-core', x: 6000, y: 4000, mass: 36, radius: 24, vx: 125, vy: -90,
    mergeIn: .5, fusionId: 'old-pair', fusionRole: 'receiver', fusionPartnerId: 'gone',
    fusionTargetId: null, fusionDonorId: 'gone', fusionProgress: .8, fusionTime: .2,
    _completedFusionId: 'confirmed-pair', _siblingAwake: true };
  const expected = { ...core }, input = { x: .6, y: -.8 };
  integrateMotion(expected, input, movementSpeed(36), .1);
  const result = c.api.group([core], input, .1);
  assert.equal(result.moves, 1);
  for (const field of ['x', 'y', 'vx', 'vy']) assert.ok(Math.abs(core[field] - expected[field]) < 1e-8);
  assert.equal(core.mass, 36); assert.ok(Math.abs(core.mergeIn - .4) < 1e-9);
  for (const field of ['fusionId', 'fusionRole', 'fusionPartnerId', 'fusionTargetId', 'fusionDonorId']) assert.equal(core[field], null);
  assert.equal(core._completedFusionId, 'confirmed-pair', 'acknowledged donor removal must remain deduplicated');
  const consumed = { ...core, mass: 0, _consumed: true };
  assert.equal(c.api.group([consumed], input, .1).moves, 0); assert.equal(consumed.mass, 0);
  assert.equal(c.api.group([], input, .1).moves, 0);
});

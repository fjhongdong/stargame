import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/game.js', import.meta.url), 'utf8');
function client() {
  let clock = 0, drawnArcs = 0;
  const canvasContext = new Proxy({}, { get: (_target, key) => key === 'arc' ? () => { drawnArcs++; } : () => {}, set: () => true });
  const context = vm.createContext({ innerWidth: 1280, innerHeight: 800, window: {}, document: { hidden: false }, performance: { now: () => clock }, requestAnimationFrame() {}, reviewCanvasContext: canvasContext });
  const hooks = `window.contactVisualTest = {
    setupRoom() { myId='pilot';room={code:'VISUAL',round:1,status:'playing',time:2,players:[{id:'pilot',color:'#83d9ff',cells:[{id:'core',radius:24,mass:36}],mass:36},{id:'remote',color:'#ffbd68',cells:[{id:'other-core',radius:24,mass:36}],mass:36}]}; },
    predict(impact, other='remote', reverse=false) {
      const own={player:{id:'pilot',color:'#83d9ff'},cell:{id:'core',radius:24},own:true,ref:{}};
      const peer={player:{id:other,color:'#ffbd68'},cell:{id:other+'-core',radius:24},own:false,ref:{}};
      emitPredictedContact(reverse?peer:own,reverse?own:peer,impact);
    },
    authority:emitContactEffects,
    particles() { return particles.map(p=>({...p})); },
    predictions() { return predictedContactEffects.size; },
    setupCamera(targetX,cameraX,targetY=4000,cameraY=4000) {
      myId='pilot';room={status:'playing',players:[{id:'pilot',mass:36,cells:[{id:'core',mass:36,radius:24}]}]};
      predictedCells.clear();predictedCells.set('core',{x:targetX,y:targetY,vx:0,vy:0});
      camera={x:cameraX,y:cameraY,scale:.95};updateCamera(0);
    },
    target(x,y=4000,vx=0,vy=0) { Object.assign(predictedCells.get('core'),{x,y,vx,vy}); },
    camera(dt) { updateCamera(dt);return getCamera(); },
    renderBirth(dt) {
      active=true;myId='pilot';ctx=reviewCanvasContext;room={round:1,status:'playing',time:2,players:[],dust:[]};
      camera={x:6000,y:4000,scale:.95};lastFrame=performance.now()-dt*1000;
      drawBackground=()=>{};drawArena=()=>{};drawMinimap=()=>{};updateHud=()=>{};
      predictOwn=()=>emitPredictedContact({player:{id:'pilot',color:'#83d9ff'},cell:{radius:24},own:true,ref:{}},{player:{id:'remote',color:'#ffbd68'},cell:{radius:24},own:false,ref:{}},{x:6000,y:4000,normalX:1,normalY:0,speed:30,at:performance.now()});
      render(performance.now());
    },
  };`;
  const instrumented = source.replace('  window.StarGame = {', `${hooks}\n  window.StarGame = {`);
  assert.notEqual(instrumented, source);
  vm.runInContext(instrumented, context);
  return { api: context.window.contactVisualTest, time: value => { clock = value; }, drawnArcs: () => drawnArcs };
}
const contacts = api => api.particles().filter(p => p.kind === 'contact');
const predictedImpact = at => ({ x: 1024, y: 1000, normalX: 1, normalY: 0, speed: 220, radius: 15, at });
function state(round = 1, impact = null, pair = ['pilot', 'remote'], time = 2.08) {
  return { round, status: 'playing', time, players: pair.map((id, i) => ({ id, color: i ? '#ffbd68' : '#83d9ff', lastImpact: impact })) };
}
const near = (actual, expected, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} should equal ${expected}`);

test('the first predicted local contact flashes immediately and repeated contact with the same unordered pair is suppressed', () => {
  const c = client(); c.api.setupRoom(); c.time(1000);
  c.api.predict(predictedImpact(1000));
  assert.equal(contacts(c.api).length, 1, 'feedback must begin in the predicted contact frame before a server packet arrives');
  assert.ok(c.api.particles().some(p => p.kind === 'chip'));
  near(contacts(c.api)[0].x, 1024); near(contacts(c.api)[0].y, 1000);
  c.time(1080); c.api.predict(predictedImpact(1080), 'remote', true);
  c.time(1199); c.api.predict(predictedImpact(1199));
  assert.equal(contacts(c.api).length, 1, 'contact constraints must not produce another flash every frame or reverse pair order');
  c.time(1200); c.api.predict(predictedImpact(1200), 'third-player');
  assert.equal(contacts(c.api).length, 2, 'a different real contact still receives immediate feedback');
});

test('a newly predicted contact is drawn in its birth frame even when that frame took 150ms', () => {
  const c = client(); c.time(1150); c.api.renderBirth(.15);
  assert.equal(contacts(c.api).length, 1, 'new particles must not be aged by the part of the frame before their birth');
  assert.ok(c.drawnArcs() > 0, 'the first contact ring actually reaches the Canvas draw path');
});

test('authority confirms a predicted pair without flashing twice while unknown impacts still receive feedback', () => {
  const c = client(); c.api.setupRoom(); c.time(1000); c.api.predict(predictedImpact(1000));
  const authority = { ...predictedImpact(2), id: 'server-contact', fractured: false };
  c.time(1080); c.api.authority(state(1, authority), state());
  assert.equal(contacts(c.api).length, 1, 'the server confirmation must acknowledge the prediction rather than replaying its particles');
  c.time(1110); c.api.authority(state(1, authority), state(1, authority));
  assert.equal(contacts(c.api).length, 1, 'repeated snapshots must keep the same event deduplicated');
  const unknown = { ...authority, id: 'unknown-server-contact', x: 1800, at: 2.1 };
  c.time(1150); c.api.authority(state(1, unknown, ['far-a', 'far-b'], 2.15), state(1, authority));
  assert.equal(contacts(c.api).length, 2, 'an impact the local simulation never predicted must remain visible');
});

test('a new round clears predicted-contact deduplication so the next real collision can flash', () => {
  const c = client(); c.api.setupRoom(); c.time(1000); c.api.predict(predictedImpact(1000));
  assert.ok(c.api.predictions() > 0);
  c.time(1050); c.api.authority(state(2, null, ['pilot', 'remote'], 0), state());
  assert.equal(c.api.predictions(), 0);
  const before = contacts(c.api).length;
  c.api.predict(predictedImpact(1050));
  assert.equal(contacts(c.api).length, before + 1, 'previous-round pair history must not suppress the new round');
});

test('camera tracks a constant moving target without packet-rate speed pulses across mixed frame durations', () => {
  const c = client(), speed = 210, response = 9;
  let target = 2000, expectedCamera = target - speed / response;
  c.api.setupCamera(target, expectedCamera);
  const frameTimes = [1 / 60, 1 / 60, 1 / 15, .1, 1 / 60, .15, 1 / 15];
  for (let frame = 0; frame < 42; frame++) {
    const dt = frameTimes[frame % frameTimes.length]; target += speed * dt; expectedCamera += speed * dt;
    c.api.target(target, 4000, speed, 0);
    const camera = c.api.camera(dt);
    near(camera.x, expectedCamera, 1e-6); near(camera.y, 4000);
    near((target - camera.x), speed / response, 1e-6);
  }
});

test('camera retains exponential following for a stationary target and resets genuine relocations', () => {
  const c = client(); c.api.setupCamera(2200, 2000);
  let elapsed = 0;
  for (const dt of [1 / 60, 1 / 15, .1, .15]) {
    elapsed += dt;
    near(c.api.camera(dt).x, 2200 - 200 * Math.exp(-9 * elapsed), 1e-6);
  }
  c.api.target(6000);
  near(c.api.camera(1 / 60).x, 6000, 1e-6);
  c.api.target(6021, 4000, 210);
  const following = c.api.camera(.1);
  assert.ok(following.x > 6000 && following.x <= 6021, 'relocation must reset target history instead of carrying a huge inferred velocity');
  assert.ok(Number.isFinite(following.scale) && following.scale > 0);
});

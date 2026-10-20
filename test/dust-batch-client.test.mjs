import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/game.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

class RecordedPath {
  constructor() { this.commands = []; }
  moveTo(...args) { this.commands.push(['moveTo', ...args]); }
  lineTo(...args) { this.commands.push(['lineTo', ...args]); }
  closePath() { this.commands.push(['closePath']); }
  arc(...args) { this.commands.push(['arc', ...args]); }
}

function client(paths = true) {
  let clock = 0;
  const individuals = [], fills = [], nodes = new Map();
  const drawing = new Proxy({
    fill(path) { if (path?.commands) fills.push({ color: this.fillStyle, commands: plain(path.commands) }); },
    createRadialGradient() { return { addColorStop() {} }; },
    createLinearGradient() { return { addColorStop() {} }; },
  }, {
    get(target, key) { return key in target ? target[key] : () => {}; },
    set(target, key, value) { target[key] = value; return true; },
  });
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { hidden: true, style: {}, dataset: {}, textContent: '',
      classList: { add() {}, remove() {} }, setAttribute() {}, querySelectorAll() { return []; } });
    return nodes.get(id);
  };
  const context = vm.createContext({ innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
    window: { drawing, recordDust(dust, position) { individuals.push({ id: dust.id, x: position.x, y: position.y }); } },
    document: { hidden: false, getElementById: node,
      createElement() { return { width: 0, height: 0, getContext() { return drawing; } }; },
      body: { style: {}, dataset: {}, classList: { add() {}, remove() {} } } },
    performance: { now: () => clock }, WebSocket: { OPEN: 1 },
    requestAnimationFrame() {}, cancelAnimationFrame() {}, setTimeout() {}, clearTimeout() {}, clearInterval() {},
    ...(paths ? { Path2D: RecordedPath } : {}),
  });
  const hooks = `window.dustTest = {
    setup() {
      active=true;myId='pilot';ctx=window.drawing;canvas={};root={hidden:false,dataset:{}};
      width=1280;height=800;dpr=1;camera={x:6000,y:4000,scale:1};previousStatus='playing';previousRound=1;
      updateHud=()=>{};updateDysonHud=()=>{};updateRenderQuality=()=>{};focusGame=()=>{};toast=()=>{};
      predictOwn=()=>{};updateCamera=()=>{};drawBackground=()=>{};drawArena=()=>{};drawMinimap=()=>{};
      drawComboTarget=()=>{};drawWaveFeedback=()=>{};
      drawDust=(dust,position)=>window.recordDust(dust,position);
    },
    packet:receiveRoom,
    frame(at) {render(at);return {renderedDust,materialized:materializedDust.size,tracked:dustTracks.size,view:getCamera()};},
    view(x,y,scale,pixelRatio=1) {camera={x,y,scale};dpr=pixelRatio;},
    cache() {return {members:batchedDust.size,batches:dustBatches.size};},
    reconnect() {token='resume';attemptReconnect();},
    close() {closeSession(false);},
  };`;
  const instrumented = source.replace('  window.StarGame = {', `${hooks}\n  window.StarGame = {`);
  assert.notEqual(instrumented, source);
  vm.runInContext(instrumented, context, { filename: 'public/game.js' });
  const api = context.window.dustTest; api.setup();
  return { api, individuals, fills,
    time(value) { clock = value; },
    frame(value) { clock = value; individuals.length = fills.length = 0; return plain(api.frame(value)); } };
}

const star = (id, x, y = 4000, extra = {}) => ({ id, x, y, vx: 0, vy: 0, value: 1, ...extra });
const state = (time, dust, extra = {}) => ({ code: 'DUST', round: 1, status: 'playing', endless: true,
  time, simulationTime: time * 1000, players: [], dust, blasts: [], meteors: [], ...extra });

// Read centers from the paths actually handed to canvas, without consulting
// cache membership or reproducing the renderer's spatial partition.
function centers(fills) {
  const found = [];
  for (const fill of fills.filter(fill => fill.color === '#c2e6cc')) {
    let points = [];
    for (const command of fill.commands) {
      if (command[0] === 'moveTo') points = [[command[1], command[2]]];
      else if (command[0] === 'lineTo') points.push([command[1], command[2]]);
      else if (command[0] === 'closePath' && points.length) {
        const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
        found.push({ x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 });
        points = [];
      }
    }
  }
  return found;
}

test('natural dust is painted once while fragments remain individual and delta updates remove old ink', () => {
  const c = client();
  c.api.packet(state(0, [star('a', 6000), star('b', 6200), star('fragment', 6100, 4020, { fragment: true, value: 3 })]));
  assert.equal(c.frame(120).renderedDust, 3);
  assert.deepEqual(c.individuals.map(d => d.id), ['fragment']);
  assert.deepEqual(centers(c.fills).sort((a, b) => a.x - b.x), [{ x: 6000, y: 4000 }, { x: 6200, y: 4000 }]);

  c.time(200);
  c.api.packet(state(.2, [star('b', 6205, 4000, { vx: 100 })], { dustDelta: true, dustRemoved: ['a'] }));
  assert.equal(c.frame(220).renderedDust, 2);
  assert.deepEqual(c.individuals.map(d => d.id).sort(), ['b', 'fragment']);
  assert.equal(centers(c.fills).length, 0, 'collected and now-moving stars cannot remain in cached paths');
  assert.ok(c.individuals.find(d => d.id === 'b').x < 6205, 'new movement uses delayed presentation');

  c.time(300);
  c.api.packet(state(.3, [star('b', 6230)], { dustDelta: true }));
  c.frame(320);
  const stopping = c.individuals.find(d => d.id === 'b');
  assert.ok(stopping && stopping.x < 6230, 'a zero velocity update must preserve the final 100ms of travel');
  assert.equal(centers(c.fills).length, 0);

  c.time(450);
  c.api.packet(state(.45, [star('b', 6230)], { dustDelta: true, dustRemoved: ['fragment'] }));
  assert.equal(c.frame(570).renderedDust, 1);
  assert.equal(c.individuals.filter(d => d.id === 'b').length + centers(c.fills).filter(p => p.x === 6230).length, 1);
});

test('full replacement, changed coordinates, room and round transitions never replay old dust positions', () => {
  const c = client();
  c.api.packet(state(0, [star('old', 6000)])); c.frame(120);
  c.time(200); c.api.packet(state(.2, [star('fresh', 6100)], { dustDelta: false }));
  assert.equal(c.frame(320).renderedDust, 1);
  assert.deepEqual(centers(c.fills), [{ x: 6100, y: 4000 }]);

  c.time(400); c.api.packet(state(.4, [star('fresh', 6150)], { code: 'OTHER', round: 2 }));
  assert.equal(c.frame(520).renderedDust, 1);
  const current = [...centers(c.fills), ...c.individuals];
  assert.equal(current.length, 1); assert.equal(current[0].x, 6150);
  assert.ok(!centers(c.fills).some(p => p.x === 6000 || p.x === 6100));

  c.api.reconnect(); assert.deepEqual(plain(c.api.cache()), { members: 0, batches: 0 });
  c.time(600); c.api.packet(state(.6, [star('new-session', 6200)], { code: 'OTHER', round: 2 }));
  c.frame(720);
  assert.deepEqual(centers(c.fills), [{ x: 6200, y: 4000 }]);
  c.api.close(); assert.deepEqual(plain(c.api.cache()), { members: 0, batches: 0 });
});

test('all 6000 world stars survive panning, zoom and DPR changes, with bounded caches after replacement', () => {
  const c = client();
  const dust = Array.from({ length: 6000 }, (_, i) => star(`world-${i}`, 60 + i % 100 * 120, 67 + Math.floor(i / 100) * 133));
  c.api.packet(state(0, dust));
  for (const [x, y, scale, ratio] of [[6000, 4000, 1, 1], [512, 512, .35, 2], [11995, 7995, .7, .75], [6000, 4000, .5, 2]]) {
    c.api.view(x, y, scale, ratio);
    const result = c.frame(120), view = result.view;
    const inView = (p, radius) => p.x + radius >= view.x - view.width / 2 && p.x - radius <= view.x + view.width / 2
      && p.y + radius >= view.y - view.height / 2 && p.y - radius <= view.y + view.height / 2;
    const key = p => `${Math.round(p.x * 1e6)}:${Math.round(p.y * 1e6)}`;
    assert.equal(result.materialized, 6000); assert.equal(result.tracked, 6000);
    assert.equal(result.renderedDust, dust.filter(p => inView(p, 15)).length);
    assert.deepEqual(centers(c.fills).filter(p => inView(p, 3.6)).map(key).sort(),
      dust.filter(p => inView(p, 3.6)).map(key).sort(), 'every visible star has one painted core at its world position');
    const cache = c.api.cache();
    assert.ok(cache.members <= 6000 && cache.batches <= cache.members, 'cache storage stays bounded by the current world');
  }
  for (let iteration = 1; iteration <= 12; iteration++) {
    c.time(iteration * 200);
    c.api.packet(state(iteration / 5, dust.slice(iteration * 100, iteration * 100 + 200), { dustDelta: false }));
    const result = c.frame(iteration * 200 + 120);
    assert.equal(result.materialized, 200); assert.equal(result.tracked, 200);
    assert.ok(c.api.cache().members <= 200, 'full snapshots evict members from every previously visited region');
  }
  c.time(2800); c.api.packet(state(2.8, []));
  assert.equal(c.frame(2920).renderedDust, 0); assert.equal(centers(c.fills).length, 0);
  assert.deepEqual(plain(c.api.cache()), { members: 0, batches: 0 });
});

test('browsers without Path2D retain the individual dust rendering fallback', () => {
  const c = client(false);
  c.api.packet(state(0, [star('a', 6000), star('fragment', 6100, 4000, { fragment: true, value: 3 })]));
  assert.equal(c.frame(120).renderedDust, 2);
  assert.deepEqual(c.individuals.map(d => d.id).sort(), ['a', 'fragment']);
});

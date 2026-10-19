import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createGameServer } from '../server.mjs';

function client(url) {
  const ws = new WebSocket(url);
  const messages = [];
  const waiters = new Set();
  ws.on('message', bytes => {
    const message = JSON.parse(bytes.toString());
    messages.push(message);
    for (const waiter of waiters) {
      if (!waiter.predicate(message)) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(message);
    }
  });
  return {
    ws,
    send(message) { ws.send(JSON.stringify(message)); },
    wait(predicate) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error('Timed out waiting for an authoritative WebSocket message'));
        }, 3000) };
        waiters.add(waiter);
      });
    },
  };
}

test('network inputs stay authoritative and only the offered player may select an upgrade', async () => {
  const game = createGameServer({ port: 0, host: '127.0.0.1' });
  const address = await game.listen();
  const endpoint = `ws://127.0.0.1:${address.port}/ws`;
  const a = client(endpoint), b = client(endpoint);
  try {
    const [welcomeA, welcomeB] = await Promise.all([
      a.wait(m => m.type === 'welcome'), b.wait(m => m.type === 'welcome'),
    ]);
    a.send({ type: 'create', name: '成长玩家' });
    const joined = await a.wait(m => m.type === 'joined');
    b.send({ type: 'join', code: joined.code, name: '观察玩家' });
    await b.wait(m => m.type === 'joined');
    b.send({ type: 'ready', ready: true });
    await a.wait(m => m.type === 'state' && m.room.players.length === 2 && m.room.players.every(p => p.ready));
    a.send({ type: 'start' });
    await a.wait(m => m.type === 'state' && m.room.status === 'playing');

    const room = game.manager.find(welcomeA.id);
    room.arena.random = () => 0.99;
    const playerA = room.arena.players.get(welcomeA.id);
    const playerB = room.arena.players.get(welcomeB.id);
    Object.assign(playerA.cells[0], { x: 300, y: 300, mass: 59, radius: 4 * Math.sqrt(59) });
    Object.assign(playerA, { x: 300, y: 300, mass: 59, invulnerable: 10 });
    Object.assign(playerB.cells[0], { x: 1100, y: 600 });
    Object.assign(playerB, { x: 1100, y: 600, invulnerable: 10 });
    room.arena.dust = [{ id: 'network-milestone', x: 300, y: 300, value: 1 }];
    game.manager.tick(0.01);
    const offered = await a.wait(m => m.type === 'state' && m.room.players.find(p => p.id === welcomeA.id)?.upgradeChoices.length === 3);
    const options = offered.room.players.find(p => p.id === welcomeA.id).upgradeChoices;
    assert.equal(new Set(options.map(option => option.id)).size, 3);
    assert.equal(playerA.mass, 60);

    b.send({ type: 'upgrade', upgradeId: options[0].id, playerId: welcomeA.id });
    await b.wait(m => m.type === 'error' && /强化选项/.test(m.message));
    assert.equal(playerA.upgradePending, 1);
    assert.deepEqual(playerB.upgrades, {});
    a.send({ type: 'upgrade', upgradeId: 'invented-stat' });
    await a.wait(m => m.type === 'error' && /强化选项/.test(m.message));
    assert.equal(playerA.upgradePending, 1);

    // JSON accepts overflowing exponents, so test the real wire parser too.
    a.ws.send('{"type":"input","x":1e999,"y":"1","boost":1,"fire":"true","split":"true","eject":{},"mass":99999,"stats":{"speed":99}}');
    a.send({ type: 'ping', time: 'input-validation-complete' });
    await a.wait(m => m.type === 'pong' && m.time === 'input-validation-complete');
    assert.deepEqual(playerA.input, { x: 0, y: 0, boost: false, fire: false, split: false, eject: false });
    assert.equal(playerA.mass, 60);
    assert.equal(playerA.stats.speed, 1);

    a.send({ type: 'upgrade', upgradeId: options[0].id });
    const selected = await b.wait(m => m.type === 'state' && m.room.players.find(p => p.id === welcomeA.id)?.upgrades.some(u => u.id === options[0].id));
    const synced = selected.room.players.find(p => p.id === welcomeA.id);
    assert.equal(synced.upgradePending, 0);
    assert.equal(synced.upgradeChoices.length, 0);
    assert.equal(synced.upgrades.find(u => u.id === options[0].id).count, 1);
    assert.deepEqual(playerB.upgrades, {});
  } finally {
    a.ws.terminate(); b.ws.terminate();
    await game.close();
  }
});

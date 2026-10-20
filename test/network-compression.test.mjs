import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createGameServer } from '../server.mjs';

function client(url, perMessageDeflate) {
  const ws = new WebSocket(url, { perMessageDeflate }), messages = [], pending = new Set();
  let extension = '';
  ws.on('upgrade', response => { extension = response.headers['sec-websocket-extensions'] || ''; });
  ws.on('message', data => {
    const message = JSON.parse(data.toString()); messages.push(message);
    for (const item of pending) if (item.predicate(message)) {
      clearTimeout(item.timer); pending.delete(item); item.resolve(message);
    }
  });
  return { ws, messages, get extension() { return extension; }, send(message) { ws.send(JSON.stringify(message)); },
    wait(predicate, after = 0) {
      const old = messages.slice(after).find(predicate);
      if (old) return Promise.resolve(old);
      return new Promise((resolve, reject) => {
        const item = { predicate, resolve, timer: setTimeout(() => {
          pending.delete(item); reject(new Error('Timed out waiting for negotiated compressed state'));
        }, 5000) };
        pending.add(item);
      });
    } };
}

test('outgoing dictionaries are reused by default and peers can request resets or no compression', async () => {
  const game = createGameServer({ port: 0, host: '127.0.0.1' }), address = await game.listen(), peers = [];
  try {
    for (const option of [true, { serverNoContextTakeover: true }, false]) {
      const peer = client(`ws://127.0.0.1:${address.port}/ws`, option); peers.push(peer);
      const welcome = await peer.wait(message => message.type === 'welcome');
      if (option === true) {
        assert.match(peer.extension, /permessage-deflate/);
        assert.doesNotMatch(peer.extension, /server_no_context_takeover/);
        assert.match(peer.extension, /client_no_context_takeover/);
      } else if (option === false) assert.equal(peer.extension, '');
      else assert.match(peer.extension, /server_no_context_takeover/);
      peer.send({ type: 'create', name: '压缩兼容验证' });
      await peer.wait(message => message.type === 'joined');
      const serverSocket = [...game.sockets.clients].find(socket => socket._socket.remotePort === peer.ws._socket.localPort);
      const frameCompression = [], sendFrame = serverSocket._sender.sendFrame;
      serverSocket._sender.sendFrame = function (frames, callback) {
        frameCompression.push(Boolean(frames[0][0] & 0x40));
        return sendFrame.call(this, frames, callback);
      };
      for (let turn = 0; turn < 6; turn++) {
        const after = peer.messages.length, ready = turn % 2 !== 0;
        peer.send({ type: 'ready', ready });
        const state = await peer.wait(message => message.type === 'state' &&
          message.room.players.find(player => player.id === welcome.id)?.ready === ready, after);
        const authoritative = game.manager.find(welcome.id).arena.players.get(welcome.id);
        assert.equal(state.room.players.find(player => player.id === welcome.id).ready, authoritative.ready);
        assert.equal(state.room.players.find(player => player.id === welcome.id).name, '压缩兼容验证');
        assert.equal(frameCompression.at(-1), option !== false, 'scene frames use negotiated compression');
        peer.send({ type: 'ping', time: `control-${turn}` });
        await peer.wait(message => message.type === 'pong' && message.time === `control-${turn}`);
        assert.equal(frameCompression.at(-1), false, 'control replies are sent uncompressed');
      }
    }
  } finally {
    for (const peer of peers) peer.ws.terminate();
    await game.close();
  }
});

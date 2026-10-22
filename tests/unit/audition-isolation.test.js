import test from 'node:test';
import assert from 'node:assert/strict';
import { watchControlWrites } from '../e2e/audition-isolation.js';

test('Audition instrumentation catches HTTP, ordinary and binary Socket.IO control events', () => {
  const handlers = new Map(), socket = new Map();
  const writes = watchControlWrites({ on: (name, handler) => handlers.set(name, handler) });
  handlers.get('websocket')({ on: (name, handler) => socket.set(name, handler) });
  const frame = (payload) => socket.get('framesent')({ payload });
  for (const payload of ['40{"protocol":2}', '3', '42["subscribe",["dmx"]]', '42["unsubscribe",["dmx"]]', '420["sync"]']) frame(payload);
  handlers.get('request')({ method: () => 'GET', url: () => '/api/state' });
  assert.deepEqual(writes, []);
  frame('42["set",{"strobeSpeed":17}]');
  frame('451-["picture:frame",{"data":{"_placeholder":true,"num":0}}]');
  frame(new Uint8Array([1, 2, 3]));
  handlers.get('request')({ method: () => 'POST', url: () => '/api/set' });
  assert.deepEqual(writes, [
    { transport: 'socket', event: ['set', { strobeSpeed: 17 }] },
    { transport: 'socket', event: ['picture:frame', { data: { _placeholder: true, num: 0 } }] },
    { transport: 'http', method: 'POST', url: '/api/set' },
  ]);
});

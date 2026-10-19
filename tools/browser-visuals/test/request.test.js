import test from 'node:test';
import assert from 'node:assert/strict';
import { requester } from '../request.js';

/** A socket that records what goes out and answers every acknowledged emit. */
const fakeSocket = (answer = (error, response) => [error, response]) => {
  const sent = [];
  const socket = {
    connected: true,
    timeout(ms) {
      return { emit: (event, ...args) => { const ack = args.pop(); sent.push({ event, args, ms }); ack(...answer()); } };
    },
    get volatile() { throw new Error('a volatile packet is dropped while the transport writes the one before it'); },
  };
  return { socket, sent };
};

test('a request goes out as a plain timed emit, never a volatile one', async () => {
  const { socket, sent } = fakeSocket(() => [null, { ok: true, units: 2 }]);
  const request = requester(socket);
  assert.deepEqual(await request('picture:units'), { ok: true, units: 2 });
  assert.deepEqual(sent, [{ event: 'picture:units', args: [], ms: 600 }]);
});

test('a payload travels before the acknowledgement callback', async () => {
  const { socket, sent } = fakeSocket(() => [null, { ok: true }]);
  await requester(socket, 250)('picture:frame', { leaseId: 'lease' });
  assert.deepEqual(sent, [{ event: 'picture:frame', args: [{ leaseId: 'lease' }], ms: 250 }]);
});

test('a dead socket and a late acknowledgement both reject', async () => {
  const { socket } = fakeSocket(() => [new Error('operation has timed out')]);
  await assert.rejects(requester(socket)('sync'), { message: 'Lightshow acknowledgement timed out' });
  socket.connected = false;
  await assert.rejects(requester(socket)('sync'), { message: 'Lightshow disconnected' });
});

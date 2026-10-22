export function watchControlWrites(page) {
  const writes = [];
  page.on('request', (request) => {
    if (!['GET', 'HEAD'].includes(request.method())) writes.push({ transport: 'http', method: request.method(), url: request.url() });
  });
  page.on('websocket', (socket) => socket.on('framesent', ({ payload }) => {
    if (typeof payload !== 'string' || !/^4[25]/.test(payload)) return;
    const event = JSON.parse(payload.slice(payload.indexOf('[')));
    if (!['subscribe', 'unsubscribe', 'sync'].includes(event[0])) writes.push({ transport: 'socket', event });
  }));
  return writes;
}

export async function protectedState(request) {
  const snapshot = await (await request.get('/api/state')).json();
  // Clock position and the continuously rendered DMX frame advance without a control write.
  const { clock: _clock, dmxSnapshot: _dmx, ...state } = snapshot;
  return { state, library: await (await request.get('/api/effects')).json(), room: await (await request.get('/api/stage/room')).json() };
}

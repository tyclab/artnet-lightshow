/**
 * One acknowledged request over the lightshow socket: the answer, or a rejection
 * when the socket is down or the acknowledgement does not come in time.
 *
 * Never volatile. socket.io drops a volatile packet while the transport is still
 * writing the one before it, and the unit list always went out right behind the
 * state sync, so its acknowledgement timed out every time and the room picture
 * never started.
 */
export const requester = (socket, timeoutMs = 600) => (event, payload) => new Promise((resolve, reject) => {
  if (!socket.connected) { reject(new Error('Lightshow disconnected')); return; }
  const ack = (error, response) => error ? reject(new Error('Lightshow acknowledgement timed out')) : resolve(response);
  const send = socket.timeout(timeoutMs);
  if (payload === undefined) send.emit(event, ack); else send.emit(event, payload, ack);
});

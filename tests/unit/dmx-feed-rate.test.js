// The Stage's DMX feed keeps pace with the engine, so a smooth preset reaches
// the preview with every frame Art-Net sends.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Server } from 'socket.io';

import { setupIntegrations } from '../../src/server/integrations.ts';
import { FRAME_MS, FRAME_RATE } from '../../src/server/frame-clock.ts';
import { ROOM } from '../../src/server/protocol.ts';

const idle = { onPlaybackUpdate() {}, onTrackChange() {}, getStatus: () => ({}), authenticated: false };

function integrations() {
  return setupIntegrations({
    io: new Server(),
    midi: { enabled: false, sendFeedback() {}, listPorts: () => [], onLearn() {}, close() {}, connect() { return true; }, setControlFeedback() {} },
    spotify: { ...idle, startPolling() {}, async getQueue() { return []; } },
    nowPlaying: idle,
    deezerSource: { ...idle, getQueue: () => [], updatePlayback() {}, updateQueue() {}, disconnect() {} },
    prolink: {
      connected: false, stale: false, lastError: null, getNumPeers: () => 0, getFollowed: () => null, getTrack: () => null,
      getLoadedTracks: () => [], getTempo: () => 0, getPositionMs: () => 0,
      onTempoChange() {}, onPeersChange() {}, onFollowChange() {}, onTrackChange() {}, onLoadedTracksChange() {}, onAnyTrackLoaded() {},
    },
    autoShow: {
      running: false, track: null, syncOffsetMs: 0, autoSyncMs: 0, analysis: null,
      getPositionMs: () => 0, getClientState: () => ({}), start() {}, stop() {},
      isCached: () => false, gridFor: () => null, isPrefetching: () => false,
      applyQueueOrder() {}, setPaletteSize() {}, setIntensity() {}, setSyncOffsetMs() {}, adjustAutoSync() {},
    },
  });
}

test('a subscribed Stage is sent one DMX frame per engine frame', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { publisher } = integrations();
  const sent = [];
  // Counted before the feed's dedupe: an idle engine repeats one frame, the timer still fires.
  publisher.wants = (room) => room === ROOM.dmx;
  publisher.sendDmxFrame = (frame) => { sent.push(frame); return true; };

  t.mock.timers.tick(1000 + FRAME_MS / 2);
  assert.equal(sent.length, FRAME_RATE, `a second of feed at ${FRAME_RATE} Hz, not a timer of its own`);
});

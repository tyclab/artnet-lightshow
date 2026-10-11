import { sequenceMode } from './now-playing.js';

const post = (path, body) => ({ path, method: 'POST', ...(body ? { body } : {}) });

export function showActive(s) {
  return !!(s.showOn || s.autoShow?.startPending || s.autoShow?.status === 'playing');
}

export function startShow(s) {
  if (s.autoShow?.status === 'ready') return post('/api/auto/start');
  const requested = s.autoSource || 'auto';
  const source = requested === 'auto' ? s.activeSource || 'timer' : requested;
  const service = source === 'hybrid' ? 'spotify' : source;
  return ['spotify', 'deezer', 'nowplaying', 'prolink'].includes(service)
    ? post(`/api/auto/analyze-${service}`, { start: true }) : post('/api/auto/start');
}

export function driverOf(s, chosen = null) {
  if (chosen === 'auto') return 'auto';
  if (s.sequence?.loaded) return 'sequence';
  if (showActive(s)) return 'auto';
  return chosen === 'sequence' ? 'sequence' : 'look';
}

export function chooseDriver(value, s) {
  if (value.startsWith('sequence:')) return [{ path: '/api/sequence', method: 'PUT', body: { id: value.slice(9) } }];
  const requests = [];
  if (s.sequence?.loaded) requests.push({ path: '/api/sequence', method: 'DELETE' });
  if (value === 'look' && (showActive(s) || ['downloading', 'analyzing'].includes(s.autoShow?.status))) requests.push(post('/api/auto/stop'));
  return requests;
}

export function playlistRowRequests(clipId, playing) {
  return playing ? [post('/api/sequence/stop')]
    : [post(`/api/sequence/jump/${encodeURIComponent(clipId)}`), post('/api/sequence/play')];
}

// Each button names a state and is pressed while the transport is in it, so
// a held or frozen picture reads from the buttons, not from a flipped label.
export function transportButtons(driver, s) {
  if (driver === 'sequence') {
    const q = s.sequence, loaded = !!q?.loaded, loop = q?.loop, mode = loaded ? sequenceMode(q) : null;
    return [
      { id: 'play', label: 'Play', enabled: loaded, pressed: mode === 'playing' },
      { id: 'pause', label: 'Pause', enabled: loaded, pressed: mode === 'paused' },
      { id: 'stop', label: 'Stop', enabled: loaded, pressed: mode === 'hold' || mode === 'black' },
      { id: 'prev', label: 'Previous', enabled: loaded },
      { id: 'next', label: 'Next', enabled: loaded },
      { id: 'shuffle', label: 'Shuffle', enabled: loaded },
      { id: 'loop', label: 'Loop', enabled: loaded && !!loop, pressed: !!loop?.on },
    ].map((button) => ({ ...button, request: post(`/api/sequence/${button.id}`,
      button.id === 'loop' && loop ? { ...loop, on: !loop.on } : null) }));
  }
  if (driver === 'auto') {
    const busy = ['downloading', 'analyzing'].includes(s.autoShow?.status), running = showActive(s);
    return [
      { id: 'play', label: busy ? 'Analysing…' : 'Start show', enabled: !busy && !running, request: startShow(s) },
      { id: 'stop', label: 'Stop show', enabled: running || busy, request: post('/api/auto/stop') },
      ...(busy ? [{ id: 'cancel', label: 'Cancel analysis', enabled: true, request: post('/api/auto/cancel') }] : []),
    ];
  }
  const running = s.running !== false;
  return [
    { id: 'play', label: 'Play look', enabled: true, pressed: running, request: { set: { running: true } } },
    { id: 'pause', label: 'Freeze look', enabled: true, pressed: !running, request: { set: { running: false } } },
  ];
}

const SEQUENCE_WORDS = {
  playing: 'playing', paused: 'paused — clips keep looping', hold: 'stopped — holding the last picture',
  black: 'stopped — black', ended: 'ended', loaded: 'loaded',
};

/** One line naming the state the driver is in; null where the buttons already say it (auto) or nothing is loaded. */
export function transportState(driver, s) {
  if (driver === 'look') return `Look · ${s.running !== false ? 'playing' : 'frozen — holding the last picture; pads still play'}`;
  if (driver !== 'sequence' || !s.sequence?.loaded) return null;
  return `Sequence · ${SEQUENCE_WORDS[sequenceMode(s.sequence)]}`;
}

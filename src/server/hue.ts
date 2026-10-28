import https from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { dtls } from 'node-dtls-client';
import { messageOf } from '../errors.ts';
import type { HueLight } from '../types/rig.ts';

export interface HueBridgeConfig {
  id: string;
  label: string;
  enabled: boolean;
  host: string;
  username: string;
  clientKey: string;
  applicationId: string;
  entertainmentId: string;
}

export interface HueChannelColour {
  id: number;
  r: number;
  g: number;
  b: number;
}

export type HueState = 'idle' | 'connecting' | 'streaming' | 'failed';

export interface HueStatus {
  id: string;
  label: string;
  status: HueState;
  enabled: boolean;
  configured: boolean;
  host: string;
  entertainmentId: string;
  error: string | null;
}

export type LampKind = 'color' | 'ambiance' | 'white';
export interface HueChannelMember {
  deviceId: string | null;
  serviceId: string;
  segmentIndex: number | null;
  segmentLength: number | null;
  segmentCount: number | null;
}

export interface AreaChannel {
  id: number;
  name: string;
  position: unknown;
  devices: string[];
  product: string;
  archetype: string;
  kind: LampKind | null;
  members?: HueChannelMember[];
}

export interface EntertainmentArea {
  id: string;
  name: string;
  status: string;
  channels: AreaChannel[];
  lamps: AreaLamp[];
}

export type PairResult =
  | { ok: true; username: string; clientKey: string; applicationId: string }
  | { ok: false; error: string; pressLink: boolean };

interface BridgeRequest {
  method?: string;
  path: string;
  key?: string;
  body?: unknown;
  withHeaders?: boolean;
}

interface ClipList<T> {
  data?: T[];
}

interface ClipDevice {
  id: string;
  metadata?: { name?: string; archetype?: unknown };
  product_data?: { product_name?: string };
}

interface ClipService {
  id: string;
  owner?: { rid?: string };
  renderer_reference?: { rid?: string; rtype?: string };
  segments?: { segments?: { length: number }[] };
}

interface ClipLight {
  id: string;
  owner?: { rid?: string };

  color?: { gamut_type?: unknown } | null;

  color_temperature?: { mirek_schema?: { mirek_minimum?: unknown; mirek_maximum?: unknown } } | null;

  metadata?: { fixed_mired?: unknown; archetype?: unknown };
}

interface ClipChannel {
  channel_id: number;
  position?: unknown;
  members?: { service?: { rid?: string }; index?: number }[];
}

interface ClipEntertainmentConfig {
  id: string;
  metadata?: { name?: string };
  status?: string;
  active_streamer?: { rid?: string };
  channels?: ClipChannel[];
}

type PairReply = {
  success?: { username?: string; clientkey?: string };
  error?: { type?: number; description?: string };
}[];

interface Lamp {
  name: string;
  product: string;
  archetype: string | null;
  device: string;
  kind: LampKind | null;
  capabilities: LampCapabilities | null;
  segmentLengths?: number[];
}

// Open and close Entertainment sessions around DTLS streaming so the bridge releases the area afterwards.

const STREAM_PORT = 2100;

const CIPHER_SUITE = 'TLS_PSK_WITH_AES_128_GCM_SHA256' as const;

const REST_TIMEOUT_MS = 5000;
// A stalled bridge can ignore every new socket until its Entertainment session is reopened.
const HANDSHAKE_TIMEOUT_MS = 1000;
const HANDSHAKE_TRIES = 5;

const DISCOVERY_URL = 'https://discovery.meethue.com/';

const DEVICE_TYPE = 'tycstation-lightshow';
const DEVICE_NAME_MAX = 19;

function deviceType(label: string): string {
  const first = String(label || '').split('.')[0];
  const plain = first.replace(/[^A-Za-z0-9 _-]+/g, '').trim().slice(0, DEVICE_NAME_MAX).trim();
  const address = /^[0-9a-f-]+$/i.test(first) && /\d/.test(first);
  return `${DEVICE_TYPE}#${plain && !address ? plain : 'lightshow'}`;
}

// Limit transport messages separately from effect cadence; Zigbee relays fewer updates than the stream.
const MIN_FRAME_INTERVAL_MS = 20;

// Limit frames to 20 channels because larger HueStream messages are malformed.
const MAX_CHANNELS = 20;

function bridgeRequest(host: string, options: BridgeRequest & { withHeaders: true }):
  Promise<{ body: unknown; headers: IncomingHttpHeaders }>;
function bridgeRequest(host: string, options: BridgeRequest): Promise<unknown>;
function bridgeRequest(host: string, { method = 'GET', path, key, body, withHeaders = false }: BridgeRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (error: Error | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(error); else resolve(value);
    };
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = https.request({
      host, port: 443, path, method, rejectUnauthorized: false,
      headers: {
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        ...(key ? { 'hue-application-key': key } : {}),
      },
      timeout: REST_TIMEOUT_MS,
    }, (res) => {
      const chunks: Buffer[] = [];
      let ended = false;
      res.on('error', (err: Error) => finish(err));
      res.on('aborted', () => finish(new Error('bridge response was aborted')));
      res.on('close', () => { if (!ended) finish(new Error('bridge response closed before completion')); });
      res.on('data', (chunk: Buffer) => { if (!settled) chunks.push(chunk); });
      res.on('end', () => {
        ended = true;
        if (settled) return;
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = text ? JSON.parse(text) : null; }
        catch (_) { finish(new Error(`bridge returned ${res.statusCode} with a non-JSON body`)); return; }
        if ((res.statusCode ?? 0) >= 400) {
          finish(new Error(describeClipError(parsed) || `bridge returned HTTP ${res.statusCode}`));
          return;
        }
        finish(null, withHeaders ? { body: parsed, headers: res.headers } : parsed);
      });
    });
    const timeout = () => {
      const error = new Error(`no complete answer from ${host} within ${REST_TIMEOUT_MS}ms`);
      finish(error);
      req.destroy(error);
    };
    req.on('timeout', timeout);
    req.on('error', (err: Error) => finish(err));
    if (!settled) {
      deadline = setTimeout(timeout, REST_TIMEOUT_MS);
      deadline.unref?.();
    }
    if (payload) req.write(payload);
    req.end();
  });
}

function describeClipError(parsed: unknown): string | null {
  const list = parsed && typeof parsed === 'object' ? (parsed as { errors?: unknown }).errors : null;
  const errors: { description?: string }[] = Array.isArray(list) ? list : [];
  if (errors.length) return errors[0]?.description || 'bridge returned a CLIP error';
  return null;
}

async function discoverBridges(): Promise<{ bridges: { id: string; host: string }[]; error: string | null }> {
  try {
    const res = await fetch(DISCOVERY_URL, { signal: AbortSignal.timeout(REST_TIMEOUT_MS) });
    if (!res.ok) return { bridges: [], error: `discovery service returned HTTP ${res.status}` };
    const list: unknown = await res.json();
    if (!Array.isArray(list)) return { bridges: [], error: 'discovery service returned an unexpected body' };
    return {
      bridges: list
        .filter((b): b is { id?: string; internalipaddress: string } => b && b.internalipaddress)
        .map((b) => ({ id: b.id || '', host: b.internalipaddress })),
      error: null,
    };
  } catch (err) {
    return { bridges: [], error: messageOf(err) };
  }
}

// Request a client key during pairing because DTLS cannot start with the application key alone.
async function pair(host: string, { label = 'lightshow' } = {}): Promise<PairResult> {
  let parsed: unknown;
  try {
    parsed = await bridgeRequest(host, {
      method: 'POST',
      path: '/api',
      body: { devicetype: deviceType(label), generateclientkey: true },
    });
  } catch (err) {
    return { ok: false, error: messageOf(err), pressLink: false };
  }

  const first = Array.isArray(parsed) ? (parsed as PairReply)[0] : null;
  if (first && first.success && first.success.username) {
    const clientKey = first.success.clientkey || '';
    if (!clientKey) {
      return {
        ok: false,
        pressLink: false,
        error: 'The bridge paired but issued no client key, so the entertainment stream '
          + 'cannot be encrypted. This bridge is too old for the Entertainment API.',
      };
    }
    const applicationId = await fetchApplicationId(host, first.success.username);
    return { ok: true, username: first.success.username, clientKey, applicationId: applicationId || '' };
  }

  const error = first && first.error ? first.error : null;
  if (error && error.type === 101) {
    return {
      ok: false,
      pressLink: true,
      error: 'Press the round button on the bridge, then try again within 30 seconds.',
    };
  }
  return {
    ok: false,
    pressLink: false,
    error: (error && error.description) || 'The bridge refused the pairing request.',
  };
}

async function fetchApplicationId(host: string, key: string): Promise<string | null> {
  try {
    const { headers } = await bridgeRequest(host, { path: '/auth/v1', key, withHeaders: true });
    const id = headers['hue-application-id'];
    return (Array.isArray(id) ? id[0] : id) || null;
  } catch (_) {
    return null;
  }
}

async function fetchLampNames(host: string, key: string): Promise<Map<string, Lamp>> {
  const names = new Map<string, Lamp>();
  try {
    const [services, devices, lights] = await Promise.all([
      bridgeRequest(host, { path: '/clip/v2/resource/entertainment', key }) as Promise<ClipList<ClipService> | null>,
      bridgeRequest(host, { path: '/clip/v2/resource/device', key }) as Promise<ClipList<ClipDevice> | null>,
      bridgeRequest(host, { path: '/clip/v2/resource/light', key }) as Promise<ClipList<ClipLight> | null>,
    ]);

    const deviceById = new Map<string, Omit<Lamp, 'kind' | 'capabilities'>>();
    for (const device of (devices && devices.data) || []) {
      deviceById.set(device.id, {
        name: (device.metadata && device.metadata.name) || '',
        product: (device.product_data && device.product_data.product_name) || '',
        archetype: archetypeOf(device.metadata?.archetype),
        device: device.id,
      });
    }
    const lightById = new Map<string, ClipLight>();
    const lightByDevice = new Map<string, ClipLight>();
    for (const light of (lights && lights.data) || []) {
      lightById.set(light.id, light);
      const owner = light.owner && light.owner.rid;
      if (owner && !lightByDevice.has(owner)) lightByDevice.set(owner, light);
    }

    for (const service of (services && services.data) || []) {
      const owner = service.owner && service.owner.rid;
      const device = owner ? deviceById.get(owner) : null;
      if (!device || !device.name) continue;
      const ref = service.renderer_reference && service.renderer_reference.rid;
      const light = (ref && lightById.get(ref)) || (owner && lightByDevice.get(owner)) || null;
      // CLIP v2 deprecates a light's archetype for its device's, so the light's only fills a gap.
      names.set(service.id, { ...device, archetype: device.archetype ?? archetypeOf(light?.metadata?.archetype),
        kind: light ? kindOf(light) : null, capabilities: light ? capabilitiesOf(light) : null,
        segmentLengths: service.segments?.segments?.map((segment) => segment.length) });
    }
  } catch (_) {
    return new Map();
  }
  return names;
}

// The fitting chosen in the Hue app; the bridge's catch-all value says nothing.
function archetypeOf(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z0-9_]{1,64}$/.test(value) && value !== 'unknown_archetype' ? value : null;
}

function kindOf(light: Pick<ClipLight, 'color' | 'color_temperature'>): LampKind {
  if (light.color && typeof light.color === 'object') return 'color';
  if (light.color_temperature && typeof light.color_temperature === 'object') return 'ambiance';
  return 'white';
}

const KIND_RANK: Record<LampKind, number> = { white: 0, ambiance: 1, color: 2 };

function kindOfChannel(channel: ClipChannel, lamps: Map<string, Lamp>): LampKind | null {
  let best: LampKind | null = null;
  for (const member of channel.members || []) {
    const kind = lamps.get((member.service && member.service.rid) || '')?.kind;
    if (kind && (best === null || KIND_RANK[kind] > KIND_RANK[best])) best = kind;
  }
  return best;
}

function channelMembers(channel: ClipChannel, lamps: Map<string, Lamp>): HueChannelMember[] {
  return (channel.members || []).map((member) => {
    const serviceId = member.service?.rid || '';
    const lamp = lamps.get(serviceId);
    const index = Number.isInteger(member.index) && member.index! >= 0 ? member.index! : null;
    const length = index === null ? undefined : lamp?.segmentLengths?.[index];
    return { serviceId, deviceId: lamp?.device || null, segmentIndex: index,
      segmentLength: typeof length === 'number' && Number.isFinite(length) && length > 0 ? length : null,
      segmentCount: lamp?.segmentLengths?.length || null };
  });
}

// Number channels from repeated devices so gradient-strip bindings remain distinguishable.
function nameChannel(channel: ClipChannel, names: Map<string, Lamp>, segmentCounts: Map<string, number>,
  seen: Map<string, number>): string {
  const labels: string[] = [];
  for (const member of channel.members || []) {
    const rid = member.service && member.service.rid;
    const lamp = rid ? names.get(rid) : null;
    if (!rid || !lamp) continue;
    if ((segmentCounts.get(rid) || 0) > 1) {
      const index = (seen.get(rid) || 0) + 1;
      seen.set(rid, index);
      labels.push(`${lamp.name} ${index}`);
    } else {
      labels.push(lamp.name);
    }
  }
  return [...new Set(labels)].join(' + ');
}

// Read areas from Hue because their channel geometry is configured in the Hue app.
async function listEntertainmentConfigs(host: string, key: string): Promise<EntertainmentArea[]> {
  const parsed = await bridgeRequest(host, {
    path: '/clip/v2/resource/entertainment_configuration',
    key,
  }) as ClipList<ClipEntertainmentConfig> | null;
  const data = parsed && Array.isArray(parsed.data) ? parsed.data : [];
  const names = await fetchLampNames(host, key);

  return data.map((cfg) => {
    const segmentCounts = new Map<string, number>();
    for (const ch of cfg.channels || []) {
      for (const member of ch.members || []) {
        const rid = member.service && member.service.rid;
        if (rid) segmentCounts.set(rid, (segmentCounts.get(rid) || 0) + 1);
      }
    }
    const seen = new Map<string, number>();

    return {
      id: cfg.id,
      name: (cfg.metadata && cfg.metadata.name) || cfg.id,
      status: cfg.status || 'inactive',
      channels: (cfg.channels || []).map((ch) => {
        const lamps = (ch.members || []).map((m) => names.get((m.service && m.service.rid) || '')).filter((l): l is Lamp => !!l);
        return {
          id: ch.channel_id,
          name: nameChannel(ch, names, segmentCounts, seen),
          position: ch.position || null,
          devices: [...new Set(lamps.map((l) => l.device))],
          product: [...new Set(lamps.map((l) => l.product).filter(Boolean))].join(' + '),
          archetype: [...new Set(lamps.map((l) => l.archetype).filter(Boolean))].join(' + '),
          kind: kindOfChannel(ch, names),
          members: channelMembers(ch, names),
        };
      }),
      lamps: lampsOf(cfg.channels || [], names),
    };
  });
}

async function identifyDevices(host: string, key: string, devices: readonly string[]): Promise<number> {
  let sent = 0;
  for (const id of devices) {
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) continue;
    await bridgeRequest(host, {
      method: 'PUT',
      path: `/clip/v2/resource/device/${encodeURIComponent(id)}`,
      key,
      body: { identify: { action: 'identify' } },
    });
    sent++;
  }
  return sent;
}

async function setStreaming(host: string, key: string, configId: string, active: boolean): Promise<void> {
  const parsed = await bridgeRequest(host, {
    method: 'PUT',
    path: `/clip/v2/resource/entertainment_configuration/${encodeURIComponent(configId)}`,
    key,
    body: { action: active ? 'start' : 'stop' },
  });
  const error = describeClipError(parsed);
  if (error) throw new Error(error);
}

// Entertainment ownership is bridge-wide, even when the selected area is inactive.
type Ownership = { kind: 'available' | 'owned' } | { kind: 'occupied'; area: ClipEntertainmentConfig };

async function ownership(config: HueBridgeConfig, identity: string): Promise<Ownership> {
  let parsed: ClipList<ClipEntertainmentConfig>;
  try {
    parsed = await bridgeRequest(config.host, { path: '/clip/v2/resource/entertainment_configuration', key: config.username }) as ClipList<ClipEntertainmentConfig>;
    const error = describeClipError(parsed);
    if (error) throw new Error(error);
    if (!Array.isArray(parsed?.data)) throw new Error('invalid area list');
  } catch (err) {
    throw new Error(`could not verify Entertainment ownership: ${messageOf(err)}`, { cause: err });
  }
  for (const area of parsed.data) {
    if (!area || typeof area.id !== 'string' || !['active', 'inactive'].includes(area.status || '')) {
      throw new Error('could not verify Entertainment ownership: invalid area');
    }
    if (area.status === 'active' && (area.id !== config.entertainmentId || area.active_streamer?.rid !== identity)) {
      return { kind: 'occupied', area };
    }
  }
  const selected = parsed.data.find(area => area.id === config.entertainmentId);
  if (!selected) throw new Error('could not verify Entertainment ownership: selected area is missing');
  return { kind: selected.status === 'active' ? 'owned' : 'available' };
}

const busyMessage = (area: ClipEntertainmentConfig): string =>
  `Entertainment area "${area.metadata?.name || area.id}" is already in use. Stop its sync in the Hue app, Sync Box or other controller; Lightshow will retry automatically.`;

const HEADER = Buffer.from('HueStream', 'ascii');    // 9 bytes
const CONFIG_ID_BYTES = 36;                          // a UUID, as ASCII
const CHANNEL_BYTES = 7;                             // id + 3 × 16-bit colour
const HEADER_BYTES = 16;

// HueStream 2.0 byte layout:
// 0..8 HueStream; 9..10 version 2.0; 11 sequence; 12..13 reserved;
// 14 colour space (0 RGB, 1 xy+brightness); 15 reserved;
// 16..51 entertainment configuration ID, 36 ASCII bytes;
// 52.. channel ID plus 16-bit big-endian R, G, B.
// Scale bytes by 257 so 255 reaches 65535 exactly.
function buildStreamMessage(configId: unknown, channels: readonly HueChannelColour[], sequence = 0): Buffer {
  const id = String(configId || '');
  const packet = Buffer.alloc(HEADER_BYTES + CONFIG_ID_BYTES + channels.length * CHANNEL_BYTES);

  HEADER.copy(packet, 0);
  packet[9] = 0x02;                                  // version major
  packet[10] = 0x00;                                 // version minor
  packet[11] = sequence & 0xff;
  packet[12] = 0x00;
  packet[13] = 0x00;
  packet[14] = 0x00;                                 // RGB
  packet[15] = 0x00;
  packet.write(id.slice(0, CONFIG_ID_BYTES).padEnd(CONFIG_ID_BYTES, '\0'), 16, CONFIG_ID_BYTES, 'ascii');

  let at = HEADER_BYTES + CONFIG_ID_BYTES;
  for (const ch of channels) {
    packet[at] = ch.id & 0xff;
    packet.writeUInt16BE(to16(ch.r), at + 1);
    packet.writeUInt16BE(to16(ch.g), at + 3);
    packet.writeUInt16BE(to16(ch.b), at + 5);
    at += CHANNEL_BYTES;
  }
  return packet;
}

function to16(value: unknown): number {
  const v = Math.max(0, Math.min(255, Math.round(Number(value) || 0)));
  return v * 257;
}

// Keep failed sessions in backoff so render frames cannot trigger repeated handshakes.
const IDLE: HueState = 'idle';
const CONNECTING: HueState = 'connecting';
const STREAMING: HueState = 'streaming';
const FAILED: HueState = 'failed';

const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 60000;

function isConfigured(c: Pick<HueBridgeConfig, 'host' | 'username' | 'clientKey' | 'entertainmentId'>): boolean {
  return !!(c.host && c.username && c.clientKey && c.entertainmentId);
}

export interface ApplicationIdentity {
  source: Pick<HueBridgeConfig, 'id' | 'host' | 'username' | 'applicationId'>;
  applicationId: string;
}
export type ApplicationIdSink = (identity: ApplicationIdentity) => void;
interface OwnedSession { config: HueBridgeConfig; identity: string }

// DNS names are case insensitive and a final dot denotes the same absolute name.
// Do not guess whether different addresses or aliases identify the same bridge.
function physicalHost(host: string): string { return host.trim().toLowerCase().replace(/\.$/, ''); }

class HueSession {
  readonly id: string;
  private config: HueBridgeConfig;
  private status: HueState = IDLE;
  private socket: dtls.Socket | null = null;
  private sequence = 0;
  private lastSentAt = 0;
  private lastError: string | null = null;
  private retryAt = 0;
  private retryDelay = RETRY_BASE_MS;
  private sessionConfig: OwnedSession | null = null;
  private releasing: Promise<void> | null = null;
  private connecting: Promise<void> | null = null;
  private connectEpoch = 0;
  private resolvedApplicationId: string | null = null;
  private lastChannels: number[] = [];
  private readonly sink: () => ApplicationIdSink | null;
  private readonly owners: Map<string, HueSession>;
  private claimedHost: string | null = null;

  constructor(config: HueBridgeConfig, sink: () => ApplicationIdSink | null = () => null, owners = new Map<string, HueSession>()) {
    this.id = config.id;
    this.config = { ...config };
    this.sink = sink;
    this.owners = owners;
  }

  private get name(): string { return this.config.label || this.id; }

  getConfig(): HueBridgeConfig { return { ...this.config }; }

  isConfigured(): boolean { return isConfigured(this.config); }

  getStatus(): HueStatus {
    return {
      id: this.id,
      label: this.config.label,
      status: this.status,
      enabled: !!this.config.enabled,
      configured: this.isConfigured(),
      host: this.config.host,
      entertainmentId: this.config.entertainmentId,
      error: this.lastError,
    };
  }

  // Close the old session before reconfiguration because a bridge allows only one active stream.
  configure(next: Partial<HueBridgeConfig> | null | undefined): HueBridgeConfig {
    const previous = this.config;
    this.config = { ...this.config, ...next, id: this.id };

    const moved = (['host', 'username', 'clientKey', 'applicationId', 'entertainmentId'] as const)
      .some((k) => previous[k] !== this.config[k]);

    if (previous.host !== this.config.host || previous.username !== this.config.username) {
      this.resolvedApplicationId = null;
    }

    if (moved || !this.config.enabled) {
      this.stop().catch(() => { /* teardown is best effort */ });
    }
    if (moved) {
      this.retryDelay = RETRY_BASE_MS;
      this.retryAt = 0;
      this.lastError = null;
    }
    return { ...this.config };
  }

  private track(task: Promise<void>): void {
    this.connecting = task;
    void task.finally(() => { if (this.connecting === task) this.connecting = null; }).catch(() => {});
  }

  private async claimHost(host: string, current: () => boolean): Promise<void> {
    const key = physicalHost(host);
    while (current()) {
      const owner = this.owners.get(key);
      if (!owner || owner === this) {
        this.owners.set(key, this);
        this.claimedHost = key;
        return;
      }
      // A pending STOP belongs to the physical bridge, even when its logical ID
      // was removed. Starting under a new ID before it settles loses the stream.
      if (owner.releasing) await owner.releasing;
      else throw new Error('this physical bridge is already managed by another configured bridge');
    }
  }

  private releaseHost(): void {
    if (this.claimedHost && this.owners.get(this.claimedHost) === this) this.owners.delete(this.claimedHost);
    this.claimedHost = null;
  }

  private async connect(): Promise<void> {
    if (this.status === CONNECTING || this.status === STREAMING) return;
    if (!this.config.enabled || !this.isConfigured()) return;
    this.status = CONNECTING;
    const config = { ...this.config };
    const epoch = ++this.connectEpoch;
    const current = () => this.connectEpoch === epoch && this.status === CONNECTING;
    if (this.sessionConfig) await this.releaseAfter();
    if (!current()) return;
    await this.claimHost(config.host, current);
    if (!current()) return;
    let identity = config.applicationId || this.resolvedApplicationId;
    if (!identity) {
      identity = await fetchApplicationId(config.host, config.username);
      if (!current()) return;
      if (identity) {
        this.resolvedApplicationId = identity;
        const sink = this.sink();
        if (sink) {
          try { sink({ source: { id: this.id, host: config.host, username: config.username, applicationId: config.applicationId }, applicationId: identity }); }
          catch (_) { /* persistence does not own the attempt */ }
        }
      }
    }
    if (!current()) return;
    if (!identity) throw new Error('could not verify the application identity; pair this bridge again');
    if (await this.openSession(config, identity, current)) this.handshake(config, identity, 1);
  }

  private async openSession(config: HueBridgeConfig, identity: string, current: () => boolean, restart = false): Promise<boolean> {
    const before = await ownership(config, identity);
    if (!current()) return false;
    if (before.kind === 'occupied') {
      this.sessionConfig = null;
      throw new Error(busyMessage(before.area));
    }
    if (restart) {
      if (before.kind === 'owned') await setStreaming(config.host, config.username, config.entertainmentId, false);
      this.sessionConfig = null;
      if (!current()) return false;
      return this.openSession(config, identity, current);
    }
    // A cancelled or failed request may still have changed the bridge.
    this.sessionConfig = { config, identity };
    await setStreaming(config.host, config.username, config.entertainmentId, true);
    if (!current()) return false;
    const after = await ownership(config, identity);
    if (!current()) return false;
    if (after.kind === 'occupied') {
      this.sessionConfig = null;
      throw new Error(busyMessage(after.area));
    }
    if (after.kind !== 'owned') throw new Error('could not verify Entertainment ownership after start');
    return true;
  }

  private handshake(config: HueBridgeConfig, identity: string, attempt: number): void {
    let pending: dtls.Socket;
    try {
      pending = dtls.createSocket({
        type: 'udp4',
        address: config.host,
        port: STREAM_PORT,
        psk: { [identity]: Buffer.from(config.clientKey, 'hex') },
        ciphers: [CIPHER_SUITE],
        timeout: HANDSHAKE_TIMEOUT_MS,
      });
    } catch (err) {
      this.fail(`could not open the stream socket: ${messageOf(err)}`);
      return;
    }

    pending.on('connected', () => {
      if (this.socket !== pending) {
        try { pending.close(); } catch (_) { /* already gone */ }
        return;
      }
      this.status = STREAMING;
      this.lastError = null;
      this.retryDelay = RETRY_BASE_MS;
      console.log(`[hue] ${this.name}: streaming to ${config.host}, area ${config.entertainmentId}`);
    });

    pending.on('error', (err: Error) => {
      if (this.socket !== pending) return;
      if (/timed out/.test(err.message) && attempt < HANDSHAKE_TRIES && this.status === CONNECTING && this.sessionConfig) {
        console.warn(`[hue] ${this.name}: ${err.message}, try ${attempt + 1} of ${HANDSHAKE_TRIES}`);
        this.socket = null;
        try { pending.close(); } catch (_) { /* already gone */ }
        const epoch = this.connectEpoch;
        const current = () => this.connectEpoch === epoch && this.status === CONNECTING;
        this.track(this.openSession(config, identity, current, true).then((opened) => {
          if (opened) this.handshake(config, identity, attempt + 1);
        }).catch((error) => {
          if (current()) this.fail(messageOf(error));
        }));
        return;
      }
      this.fail(err.message);
    });

    pending.on('close', () => {
      if (this.socket !== pending) return;
      if (this.status === STREAMING || this.status === CONNECTING) this.fail('the bridge closed the stream');
    });

    this.socket = pending;
  }

  private recordFailure(message: string): void {
    this.lastError = message;
    console.warn(`[hue] ${this.name}: ${message}`);
    this.status = FAILED;
    this.retryAt = Date.now() + this.retryDelay;
    this.retryDelay = Math.min(RETRY_MAX_MS, this.retryDelay * 2);
  }

  private closeSocket(): void {
    const dying = this.socket;
    this.socket = null;
    if (dying) {
      try { dying.close(); } catch (_) { /* already gone */ }
    }
  }

  private releaseAfter(pending: Promise<void> | null = null): Promise<void> {
    if (this.releasing) return this.releasing;
    const release = (async () => {
      if (pending) await pending.catch(() => {});
      const owned = this.sessionConfig;
      if (!owned) { this.releaseHost(); return; }
      const { config, identity } = owned;
      const holder = await ownership(config, identity);
      if (holder.kind === 'owned') await setStreaming(config.host, config.username, config.entertainmentId, false);
      if (this.sessionConfig === owned) this.sessionConfig = null;
      this.releaseHost();
    })();
    this.releasing = release;
    void release.finally(() => { if (this.releasing === release) this.releasing = null; }).catch(() => {});
    return release;
  }

  private fail(message: string): void {
    this.recordFailure(message);
    this.closeSocket();
    const epoch = this.connectEpoch;
    void this.releaseAfter(this.connecting).catch(err => {
      if (this.connectEpoch === epoch) this.recordFailure(`could not release the session: ${messageOf(err)}`);
    });
  }

  async stop(): Promise<void> {
    const epoch = ++this.connectEpoch;
    this.status = IDLE;
    this.lastError = null;
    this.retryDelay = RETRY_BASE_MS;
    this.retryAt = 0;
    this.closeSocket();
    try {
      await this.releaseAfter(this.connecting);
    } catch (err) {
      if (this.connectEpoch === epoch) this.recordFailure(`could not release the session: ${messageOf(err)}`);
      throw err;
    }
  }

  async close(): Promise<void> {
    if (this.status === STREAMING && this.socket && this.lastChannels.length) {
      this.sequence = (this.sequence + 1) & 0xff;
      const dark = this.lastChannels.map((id) => ({ id, r: 0, g: 0, b: 0 }));
      try {
        this.socket.send(buildStreamMessage(this.sessionConfig?.config.entertainmentId || this.config.entertainmentId, dark, this.sequence), () => { /* on the way out */ });
      } catch (_) { /* the session closes regardless */ }
    }
    await this.stop();
  }

  sendFrame(channels: readonly HueChannelColour[]): boolean {
    if (!this.config.enabled || !this.isConfigured()) return false;

    if (!channels.length) {
      if (this.status === STREAMING || this.status === CONNECTING) {
        console.log(`[hue] ${this.name}: no lamp of it in the patch — releasing the entertainment area`);
        void this.stop().catch(() => {});
      }
      return false;
    }

    if (this.status === IDLE || (this.status === FAILED && Date.now() >= this.retryAt)) {
      if (!this.connecting && !this.releasing) {
        const epoch = this.connectEpoch + 1;
        this.track(this.connect().catch((err) => {
          if (this.connectEpoch === epoch && this.status === CONNECTING) this.fail(messageOf(err));
        }));
      }
      return false;
    }
    if (this.status !== STREAMING || !this.socket) return false;

    const now = Date.now();
    if (now - this.lastSentAt < MIN_FRAME_INTERVAL_MS) return false;
    this.lastSentAt = now;

    this.sequence = (this.sequence + 1) & 0xff;
    const slots = channels.length > MAX_CHANNELS ? channels.slice(0, MAX_CHANNELS) : channels;
    this.lastChannels = slots.map((c) => c.id);
    const sending = this.socket;
    try {
      sending.send(buildStreamMessage(this.config.entertainmentId, slots, this.sequence), (err) => {
        if (err && this.socket === sending && this.status === STREAMING) this.fail(`send failed: ${err.message}`);
      });
    } catch (err) {
      this.fail(`send failed: ${messageOf(err)}`);
      return false;
    }
    return true;
  }
}

const sessions = new Map<string, HueSession>();
const retiring = new Map<string, HueSession>();
const physicalOwners = new Map<string, HueSession>();

let onApplicationId: ApplicationIdSink | null = null;
function setApplicationIdSink(fn: ApplicationIdSink | null): void { onApplicationId = fn; }

function configureBridges(list: readonly HueBridgeConfig[]): void {
  const keep = new Set(list.map((b) => b.id));
  for (const [id, session] of sessions) {
    if (keep.has(id)) continue;
    retiring.set(id, session);
    sessions.delete(id);
    void session.stop().then(() => { if (retiring.get(id) === session) retiring.delete(id); }).catch(() => {});
  }
  for (const bridge of list) {
    const session = sessions.get(bridge.id) || retiring.get(bridge.id);
    retiring.delete(bridge.id);
    if (session) {
      session.configure(bridge);
      sessions.set(bridge.id, session);
    } else sessions.set(bridge.id, new HueSession(bridge, () => onApplicationId, physicalOwners));
  }
}

function getSession(id: string): HueSession | null { return sessions.get(id) || null; }

function listSessions(): HueSession[] { return [...sessions.values()]; }

function getConfigs(): HueBridgeConfig[] { return listSessions().map((s) => s.getConfig()); }

function getStatusAll(): HueStatus[] { return listSessions().map((s) => s.getStatus()); }

function anyEnabled(): boolean { return listSessions().some((s) => s.getConfig().enabled); }

function sendFrames(frames: ReadonlyMap<string, readonly HueChannelColour[]>): boolean {
  let sent = false;
  for (const session of sessions.values()) {
    if (session.sendFrame(frames.get(session.id) || [])) sent = true;
  }
  return sent;
}

async function finishAll(operation: 'stop' | 'close'): Promise<void> {
  const all = new Set([...sessions.values(), ...retiring.values()]);
  const results = await Promise.allSettled([...all].map((s) => s[operation]()));
  const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
  if (errors.length) throw new AggregateError(errors, 'could not release all Hue sessions');
}

async function stopAll(): Promise<void> { await finishAll('stop'); }

async function closeAll(): Promise<void> {
  await finishAll('close');
}

function _reset(): void {
  sessions.clear();
  retiring.clear();
  physicalOwners.clear();
  onApplicationId = null;
}

export const STATES = { IDLE, CONNECTING, STREAMING, FAILED };

export {
  STREAM_PORT,
  CIPHER_SUITE,
  MAX_CHANNELS,
  DISCOVERY_URL,
  MIN_FRAME_INTERVAL_MS,
  HEADER_BYTES,
  CONFIG_ID_BYTES,
  CHANNEL_BYTES,
  discoverBridges,
  identifyDevices,
  deviceType,
  pair,
  fetchApplicationId,
  setApplicationIdSink,
  listEntertainmentConfigs,
  fetchLampNames,
  nameChannel,
  archetypeOf,
  kindOf,
  kindOfChannel,
  capabilitiesOf,
  lampsOf,
  channelMembers,
  setStreaming,
  buildStreamMessage,
  to16,
  isConfigured,
  HueSession,
  configureBridges,
  getSession,
  listSessions,
  getConfigs,
  getStatusAll,
  anyEnabled,
  sendFrames,
  stopAll,
  closeAll,
  _reset,
};

export type HueGamut = 'A' | 'B' | 'C' | 'other';

export interface LampCapabilities {

  gamut: HueGamut | null;

  whites: { warm: number; cool: number } | null;

  fixedWhite: number | null;
}

export interface AreaLamp {

  id: string;
  name: string;

  product: string;
  archetype?: string | null;
  /** Every light the lamp drives, lead first; a channel combining several lights is still one lamp. */
  lights?: HueLight[];

  devices: string[];

  channels: number[];

  kind: LampKind | null;
  capabilities: LampCapabilities | null;
}

const GAMUTS: readonly HueGamut[] = ['A', 'B', 'C', 'other'];

function kelvinOf(mirek: unknown): number | null {
  const m = Number(mirek);
  if (!Number.isFinite(m) || m < 50 || m > 1000) return null;
  return Math.round(1e6 / m);
}

function capabilitiesOf(light: Pick<ClipLight, 'color' | 'color_temperature' | 'metadata'>): LampCapabilities {
  const color = light.color && typeof light.color === 'object' ? light.color : null;
  const gamut = color ? (GAMUTS.find((g) => g === color.gamut_type) || 'other') : null;
  const schema = light.color_temperature && typeof light.color_temperature === 'object'
    ? light.color_temperature.mirek_schema : undefined;
  const warm = kelvinOf(schema && schema.mirek_maximum);
  const cool = kelvinOf(schema && schema.mirek_minimum);
  return {
    gamut,
    whites: warm !== null && cool !== null && warm <= cool ? { warm, cool } : null,
    fixedWhite: color || schema ? null : kelvinOf(light.metadata && light.metadata.fixed_mired),
  };
}

function lampsOf(channels: readonly ClipChannel[], names: Map<string, Lamp>): AreaLamp[] {
  const groups = new Map<string, { channels: { id: number; index: number; order: number }[]; services: Set<string> }>();
  channels.forEach((ch, order) => {
    const members = (ch.members || []).filter((m) => m.service && m.service.rid);
    const lead = members[0];
    const key = lead ? lead.service!.rid! : `channel-${ch.channel_id}`;
    let group = groups.get(key);
    if (!group) groups.set(key, group = { channels: [], services: new Set() });
    const index = lead && Number.isInteger(lead.index) ? lead.index as number : order;
    group.channels.push({ id: ch.channel_id, index, order });
    for (const m of members) group.services.add(m.service!.rid!);
  });
  return [...groups].map(([key, group]) => {
    group.channels.sort((a, b) => a.index - b.index || a.order - b.order);
    const lead = names.get(key);
    const lamps = [...group.services].map((rid) => names.get(rid)).filter((l): l is Lamp => !!l);
    return {
      id: key,

      name: [...new Set(lamps.map((l) => l.name).filter(Boolean))].join(' + '),
      product: lead ? lead.product : '',
      archetype: lead?.archetype ?? null,
      lights: lamps.map((l) => ({ product: l.product || '', archetype: l.archetype ?? null })),
      devices: [...new Set(lamps.map((l) => l.device))],
      channels: group.channels.map((c) => c.id),
      kind: lead ? lead.kind : null,
      capabilities: lead ? lead.capabilities : null,
    };
  });
}

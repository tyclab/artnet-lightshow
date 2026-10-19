import { state, universeOf } from './state.ts';
import { getProfile } from './profiles.ts';
import { isHueProfile, hueChannels } from '../shared/hue-lamp.ts';
import { hueSectionColour } from '../shared/hue-colour.ts';
import { channelReader } from '../shared/placement.ts';
import * as universes from './universes.ts';
import { createTransmitter, sacnUniverseFor as mapSacnUniverse } from './transmit.ts';
import { createDiscovery, interfaces, isBroadcastTarget } from './artnet-nodes.ts';
import { isLoopback } from './loopback.ts';
import * as hue from './hue.ts';
import { isArmed, setArmedFlag } from './armed.ts';
import { defaultHueBridgeId } from './settings.ts';
import type { HueChannelColour } from './hue.ts';
import { ddpRoutes } from './ddp-routes.ts';
import { openrgbRoutes } from './openrgb-routes.ts';
import type { SacnOutput, SendOptions, TransmitConfig, Wire } from './transmit.ts';
import type { Settings } from './settings.ts';

let sacn: SacnOutput = {
  enabled: false,
  host: '',
  priority: 100,
  sourceName: 'Tyclab Lightshow',
  universeOffset: 1,
  cid: '',
  interface: '',
};

function configureSacn(config: Partial<SacnOutput> | null | undefined): SacnOutput {
  sacn = { ...sacn, ...config };
  return sacn;
}

function getSacnConfig(): SacnOutput { return { ...sacn }; }

let hueLatencyMs = 0;

function configureHue(config: Partial<Settings['hue']> | null | undefined): HueOutputConfig {
  const { latencyMs, bridges } = config || {};
  if (typeof latencyMs === 'number' && Number.isFinite(latencyMs)) hueLatencyMs = Math.max(0, Math.min(500, Math.round(latencyMs)));
  if (bridges) hue.configureBridges(bridges);
  return getHueConfig();
}

export type HueOutputConfig = Pick<Settings['hue'], 'bridges' | 'latencyMs'>;

function getHueConfig(): HueOutputConfig {
  return { bridges: hue.getConfigs(), latencyMs: hueLatencyMs };
}

const transmitter = createTransmitter();

function artnetDiscoveryWanted(): boolean {
  const a = state.artnet;
  return a.enabled !== false && a.discovery !== false && isBroadcastTarget(a.host) && !isLoopback(a.host);
}

const artnetDiscovery = createDiscovery({
  shouldPoll: artnetDiscoveryWanted,
  targets: () => [...interfaces().map((i) => i.broadcast), state.artnet.host],
});

function transmitConfig(): TransmitConfig {
  return {
    artnet: {
      enabled: state.artnet.enabled,
      host: state.artnet.host,
      port: state.artnet.port,
      sync: !!state.artnet.sync,
      routes: artnetDiscovery.routes(),
    },
    sacn: { ...sacn },
    delayMs: hueLatencyMs > 0 && hue.anyEnabled() ? hueLatencyMs : 0,
    ddp: ddpRoutes(state.fixtures, getProfile, universeOf),
    openrgb: openrgbRoutes(state.fixtures, getProfile, universeOf),
    armed: isArmed(),
  };
}

function setArmed(on: boolean): boolean {
  if (!setArmedFlag(on)) return false;
  if (!on) hue.closeAll().catch(() => { /* best effort, as every teardown is */ });
  return true;
}

function onHueApplicationId(fn: (bridgeId: string, applicationId: string) => void): void { hue.setApplicationIdSink(fn); }

function sacnUniverseFor(universe: number, offset = sacn.universeOffset): number | null {
  return mapSacnUniverse(universe, offset);
}

// Read final DMX so Hue output includes masters, trim, overrides and blackout.
function hueChannelColors(): Map<string, HueChannelColour[]> {
  const out = new Map<string, HueChannelColour[]>();

  const fallback = defaultHueBridgeId(hue.getConfigs());

  for (const fix of state.fixtures) {
    const lamp = fix.output;
    if (!lamp || lamp.protocol !== 'hue') continue;
    const bridge = lamp.bridge || fallback;
    let channels = out.get(bridge);
    if (!channels) {
      channels = [];
      out.set(bridge, channels);
    }
    const profile = getProfile(fix);
    const traits = isHueProfile(profile) ? profile.hue : null;
    const sections = profile.cells ? profile.cells.map((cell) => cell.channelMap) : [profile.channelMap];
    const at = channelReader(universeOf(fix), fix.address, profile, (u) => universes.getBuffer(u));
    sections.forEach((ch, c) => {
      const id = hueChannels(lamp)[c];
      if (id === undefined || channels.some((sent) => sent.id === id)) return;
      channels.push({ id, ...hueSectionColour(ch, at, traits) });
    });
  }
  return out;
}

// Send Hue once per frame because an area can span several DMX universes.
function sendHue(): boolean {
  if (!isArmed()) return false;
  return hue.sendFrames(hueChannelColors());
}

function sendUniverse(universe: number, frame: Buffer, { immediate = false, terminate = false }: SendOptions = {}):
  Wire[] {
  return transmitter.send(universe, frame, transmitConfig(), { immediate, terminate });
}

function endFrame(): void {
  transmitter.endFrame(transmitConfig());
}

export const getHueStatus = () => hue.getStatusAll();
export const stopHue = () => hue.stopAll();

export {
  configureSacn,
  getSacnConfig,
  sacnUniverseFor,
  sendUniverse,
  endFrame,
  transmitConfig,
  setArmed,
  isArmed,
  artnetDiscovery,
  configureHue,
  getHueConfig,
  onHueApplicationId,
  hueChannelColors,
  sendHue,
};

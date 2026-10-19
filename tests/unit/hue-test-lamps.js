
import { hueProfile } from '../../src/server/hue-profile.ts';

export function areaLamp({ id, name = 'Lamp', product = 'Hue color lamp', channels = [0], gamut = 'C', whites = { warm: 2000, cool: 6536 }, fixedWhite = null, devices = [`device-${id}`] }) {
  return { id, name, product, devices, channels, kind: gamut ? 'color' : whites ? 'ambiance' : 'white', capabilities: { gamut, whites, fixedWhite } };
}

export const HUE_COLOR = hueProfile(areaLamp({ id: 'test-color' }));
export const HUE_AMBIANCE = hueProfile(areaLamp({ id: 'test-ambiance', product: 'Hue white ambiance', gamut: null, whites: { warm: 2203, cool: 6536 } }));
export const HUE_WHITE = hueProfile(areaLamp({ id: 'test-white', product: 'Hue white lamp', gamut: null, whites: null, fixedWhite: 2732 }));
export const HUE_GRADIENT = hueProfile(areaLamp({ id: 'test-gradient', product: 'Hue gradient lightstrip', channels: [3, 4, 5, 6, 7] }));

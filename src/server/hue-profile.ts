import { profileSchema, validate } from './validation.ts';
import type { ProfileInput } from './validation.ts';
import type { AreaLamp } from './hue.ts';
import type { ChannelListEntry, ChannelMap, HueLampTraits, ProfileCell } from '../types/rig.ts';
const MAX_LIGHTS = 64;
function hueProfileId(lampId: string, bridgeId = ''): string {
    return `hue-${bridgeId ? `${bridgeId}-` : ''}${lampId}`.slice(0, 128);
}
// The lights' products and fittings ride along so the Stage can aim a lamp nobody has shaped (emission.ts).
function traitsOf(lamp: Pick<AreaLamp, 'capabilities' | 'lights'>): HueLampTraits | null {
    const caps = lamp.capabilities;
    if (!caps)
        return null;
    const fixed = caps.fixedWhite !== null ? { warm: caps.fixedWhite, cool: caps.fixedWhite } : null;
    const lights = (lamp.lights || []).slice(0, MAX_LIGHTS).map((light) => ({ product: light.product.slice(0, 128), archetype: light.archetype }));
    return { gamut: caps.gamut, whites: caps.whites || fixed, ...(lights.length ? { lights } : {}) };
}
function kelvinLabel(kelvin: number): string {
    return `${Math.round(kelvin / 100) * 100} K`;
}
function describe(traits: HueLampTraits, sections: number): string {
    const parts: string[] = [];
    if (sections > 1)
        parts.push(`${sections} sections`);
    if (traits.gamut)
        parts.push(traits.gamut === 'other' ? 'colour' : `colour (gamut ${traits.gamut})`);
    const { whites } = traits;
    if (whites && whites.warm !== whites.cool)
        parts.push(`white ${kelvinLabel(whites.warm)}–${kelvinLabel(whites.cool)}`);
    else if (whites)
        parts.push(`white ${kelvinLabel(whites.warm)}`);
    else if (!traits.gamut)
        parts.push('white');
    return parts.join(', ');
}
function sectionChannels(traits: HueLampTraits): [
    string,
    string
][] {
    const out: [
        string,
        string
    ][] = [['dimmer', 'Dimmer']];
    if (traits.gamut)
        out.push(['red', 'Red'], ['green', 'Green'], ['blue', 'Blue']);
    const { whites } = traits;
    if (whites && whites.warm !== whites.cool) {
        out.push(['warmWhite', `White ${kelvinLabel(whites.warm)}`], ['coolWhite', `White ${kelvinLabel(whites.cool)}`]);
    }
    if (traits.gamut)
        out.push(['uv', 'UV (shown as violet)']);
    return out;
}
function hueProfile(lamp: AreaLamp, bridgeId = ''): ProfileInput | null {
    const traits = traitsOf(lamp);
    if (!traits || !lamp.channels.length)
        return null;
    const section = sectionChannels(traits);
    const sections = lamp.channels.length;
    const channelList: ChannelListEntry[] = [];
    const channelMap: ChannelMap = {};
    const cells: ProfileCell[] = [];
    for (let c = 0; c < sections; c++) {
        const map: ChannelMap = {};
        section.forEach(([attribute, name], k) => {
            const offset = c * section.length + k;
            map[attribute] = offset;
            channelList.push(sections > 1 ? { offset, name: `Section ${c + 1} ${name}`, attribute, cell: c } : { offset, name, attribute });
        });
        if (sections > 1)
            cells.push({ name: `Section ${c + 1}`, channelMap: map });
        else
            Object.assign(channelMap, map);
    }
    return validate(profileSchema, {
        id: hueProfileId(lamp.id, bridgeId),
        name: (lamp.product || 'Hue lamp').slice(0, 128),
        modeName: describe(traits, sections).slice(0, 128),
        channelCount: sections * section.length,
        channelMap,
        channelList,
        ...(cells.length ? { cells } : {}),
        hue: traits,
    }, 'Hue lamp profile');
}
export { hueProfile, hueProfileId, traitsOf };

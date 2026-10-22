import { useRef, useState } from 'preact/hooks';
import { colourHsv, hsvColour, huePair } from '../../src/shared/colour-sliders.ts';

export function ColourSliders({ value, onChange, label = 'Colour' }) {
  const remembered = useRef({ value: null, hsv: null });
  const parsed = colourHsv(value);
  const hsv = remembered.current.value === value ? remembered.current.hsv : parsed;
  const change = (key, number) => {
    const next = { ...hsv, [key]: number };
    const hex = hsvColour(next, value);
    remembered.current = { value: hex, hsv: next };
    onChange(hex);
  };
  return <div class="colour-sliders" role="group" aria-label={`${label} sliders`}>
    {['hue', 'saturation', 'brightness'].map((key) => <label key={key}>
      <span>{key[0].toUpperCase() + key.slice(1)}</span>
      <input type="range" min="0" max={key === 'hue' ? 360 : 100} step="1" value={hsv[key]}
        class={key === 'hue' ? 'hue-slider' : ''} aria-label={`${label} ${key}`}
        aria-valuetext={`${Math.round(hsv[key])}${key === 'hue' ? ' degrees' : ' percent'}`}
        onInput={(e) => change(key, Number(e.currentTarget.value))} />
      <span class="colour-slider-value" aria-hidden="true">{Math.round(hsv[key])}{key === 'hue' ? '°' : '%'}</span>
    </label>)}
  </div>;
}

export function HuePair({ onChange }) {
  const [hue, setHue] = useState(210), [separation, setSeparation] = useState(180);
  const [saturation, setSaturation] = useState(90), [brightness, setBrightness] = useState(100);
  const pair = huePair(hue, separation, saturation, brightness);
  return <details class="hue-pair"><summary>Generate a hue pair</summary>
    <div class="colour-sliders">
      {[[hue, setHue, 'Pair hue', 360], [separation, setSeparation, 'Hue separation', 360],
        [saturation, setSaturation, 'Pair saturation', 100], [brightness, setBrightness, 'Pair brightness', 100]].map(([value, set, label, max]) =>
        <label key={label}><span>{label}</span><input type="range" min="0" max={max} step="1" value={value} aria-label={label}
          onInput={(e) => set(Number(e.currentTarget.value))} /><span class="colour-slider-value" aria-hidden="true">{value}{max === 360 ? '°' : '%'}</span></label>)}
    </div>
    <div class="palette-tools"><span class="pair-preview" aria-label="Generated pair">{pair.map((hex) => <i key={hex} style={{ background: hex.slice(0, 7) }} />)}</span>
      <button type="button" class="btn sm" onClick={() => onChange(pair)}>Use hue pair</button></div>
  </details>;
}

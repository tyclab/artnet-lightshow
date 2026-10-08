import { send } from '../state.js';

export function TempoScale({ bpm = 120, direction }) {
  const half = direction === 'half';
  return <button type="button" class="btn sm" disabled={half ? bpm < 40 : bpm > 150}
    onClick={() => send({ bpm: half ? bpm / 2 : bpm * 2 })}
    aria-label={half ? 'Half tempo' : 'Double tempo'}
    title={half ? 'Halve the global tempo' : 'Double the global tempo'}>{half ? '½' : '×2'}</button>;
}

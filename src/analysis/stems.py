"""Source separation, so the instrument roles are measured rather than inferred."""

from dataclasses import dataclass, field
import os
import random
import sys
import threading

import numpy as np

from . import models


@dataclass
class Stems:
    """Separated sources, resampled to the analysis rate and summed to mono."""

    drums: np.ndarray = field(default_factory=lambda: np.zeros(0))
    bass: np.ndarray = field(default_factory=lambda: np.zeros(0))
    vocals: np.ndarray = field(default_factory=lambda: np.zeros(0))
    other: np.ndarray = field(default_factory=lambda: np.zeros(0))
    sample_rate: int = 0
    backend: str = 'demucs'

    def named(self, name):
        return getattr(self, name, np.zeros(0))

    @property
    def names(self):
        return ('drums', 'bass', 'vocals', 'other')

    def energies(self):
        """RMS per stem as a share of the total: what a track is *made of*."""
        levels = {}
        for name in self.names:
            signal = self.named(name)
            levels[name] = float(np.sqrt(np.mean(signal ** 2))) if signal.size else 0.0
        total = sum(levels.values())
        if total <= 1e-12:
            return {name: 0.0 for name in self.names}
        return {name: value / total for name, value in levels.items()}


def separate(mono, sample_rate, overlap=0.10, segment_seconds=None, stereo_loader=None, seed=0):
    """
    Split `mono` into stems, returned at the same rate and length.

    `stereo_loader(rate)` returns the same span of the source as (2, n) at
    `rate` — an array, or a `preprocess.SeparationSpan` read a piece at a
    time — or None. When it gives one, Demucs separates the real stereo at its
    own rate instead of the mono signal copied into two channels: it has the
    channel difference and the top octave to work with. Called only once the
    separator is loaded, so a track that never reaches Demucs never pays for
    the reload. The stems still come back at `sample_rate`, one per sample of
    `mono`.

    `overlap` trades quality for time. Demucs defaults to 0.25; 0.10 is roughly
    a fifth faster and the difference does not survive the downstream use, which
    is envelopes and onset times rather than anything anybody listens to.

    `seed` draws Demucs's random shift, so one track always separates alike.
    """
    import torch
    import librosa

    # Demucs is the default: BS-RoFormer takes ~7x as long, longer than the track on an integrated GPU.
    if models.bs_roformer_enabled() and not models.gpu_fault():
        try:
            return separate_bs_roformer(mono, sample_rate, stereo_loader)
        except Exception as exc:
            models.gpu_fault(exc)
            print(f'[stems] BS-RoFormer unavailable; using Demucs: {exc}', file=sys.stderr)
            # Never hold both separators; the next track retries BS-RoFormer on a clean card.
            models.unload('bs-roformer-4stem')

    model = models.separator()

    stereo = stereo_loader(model.samplerate) if stereo_loader else None
    if stereo is not None and np.ndim(stereo) == 2 and stereo.shape[0] == 2:
        pair = stereo
    else:
        resampled = librosa.resample(np.asarray(mono, dtype=np.float32),
                                     orig_sr=sample_rate, target_sr=model.samplerate)
        pair = np.vstack([resampled, resampled])

    def run(device):
        with torch.no_grad():
            return _demucs(model, pair, device, overlap, segment_seconds, sample_rate, mono.size,
                           random.Random(seed))

    separated = models.run_pass('demucs', run, modules=[model])
    return Stems(sample_rate=sample_rate,
                 **{name: separated.get(name, np.zeros(mono.size, dtype=np.float32))
                    for name in ('drums', 'bass', 'vocals', 'other')})


def _demucs(model, pair, device, overlap, segment, rate, size, rng):
    """
    Demucs's `apply_model(shifts=1, split=True)`, a segment at a time, its
    random shift drawn from `rng` rather than the global `random`.

    Called on the whole track, `apply_model` holds the track in four stereo
    stems at 44.1 kHz twice over, plus two copies of the input: 4 MB per second
    of audio, 3.6 GB for fifteen minutes, on a host with 4 GB to spare. Here the
    same segments, weights and random shift are run in the same order, each
    finished stretch is folded to mono and resampled as soon as no later
    segment overlaps it, and what is held is the stems at `rate`. For the same
    random draw the stems are the ones `apply_model` gives, bit for bit.
    """
    from demucs.apply import BagOfModels

    if isinstance(model, BagOfModels):
        members = list(zip(model.models, model.weights))
    else:
        members = [(model, [1.0] * len(model.sources))]
    totals = [sum(weights[k] for _, weights in members) for k in range(len(model.sources))]
    out = None
    for member, weights in members:
        stems = _stream(member, pair, device, overlap, segment, rate, size, rng)
        scale = np.asarray([w / t for w, t in zip(weights, totals)], dtype=np.float32)
        if not np.all(scale == 1.0):
            stems *= scale[:, None]
        out = stems if out is None else out + stems
    return dict(zip(model.sources, out))


def _stream(model, pair, device, overlap, segment, rate, size, rng):
    """One model's stems at `rate` as (sources, size); see `_demucs`."""
    import soxr
    import torch as th
    from demucs.apply import TensorChunk, apply_model

    read = pair.read if hasattr(pair, 'read') else (lambda a, b: np.asarray(pair[:, a:b]))
    channels, length = int(pair.shape[0]), int(pair.shape[-1])
    sources = len(model.sources)
    out = np.zeros((sources, size), dtype=np.float32)
    written = [0] * sources
    resamplers = ([soxr.ResampleStream(model.samplerate, rate, 1, dtype='float32', quality='soxr_hq')
                   for _ in range(sources)] if int(model.samplerate) != int(rate) else None)

    def emit(block, last=False):
        """Fold (sources, channels, n) at the model rate to mono stems at `rate`."""
        for k in range(sources):
            mono = block[k].mean(dim=0).numpy()
            if resamplers is not None:
                mono = resamplers[k].resample_chunk(mono, last=last)
            # Two resamples can drift by a sample; stems must line up with the feature grid.
            n = max(0, min(mono.size, size - written[k]))
            out[k, written[k]:written[k] + n] = mono[:n]
            written[k] += n

    # apply_model's shift: the input padded by `max_shift` of silence on each
    # side, read from `shift` on; the output from `max_shift - shift` on is the track.
    max_shift = int(0.5 * model.samplerate)
    shift = rng.randint(0, max_shift)
    span = length + max_shift - shift
    lead = max_shift - shift
    padded_length = length + 2 * max_shift

    if segment is None and getattr(model, 'segment', None) is None:
        # A model without a training segment is applied whole, as before.
        mix = th.zeros(1, channels, span)
        mix[0, :, lead:] = th.from_numpy(np.ascontiguousarray(read(0, length), dtype=np.float32))
        emit(apply_model(model, mix, shifts=0, device=device, split=True, overlap=overlap,
                         progress=False)[0, ..., lead:].cpu(), last=True)
        return out

    # apply_model's split: segments `stride` apart, each weighted by a triangle.
    segment_length = int(model.samplerate * (segment or model.segment))
    stride = int((1 - overlap) * segment_length)
    weight = th.cat([th.arange(1, segment_length // 2 + 1, device=device),
                     th.arange(segment_length - segment_length // 2, 0, -1, device=device)])
    weight = (weight / weight.max()) ** 1.

    def window(start, stop):
        """The padded input from `start` to `stop`: silence outside the track."""
        piece = th.zeros(1, channels, stop - start)
        a, b = max(start, max_shift), min(stop, max_shift + length)
        if b > a:
            piece[0, :, a - start:b - start] = th.from_numpy(
                np.ascontiguousarray(read(a - max_shift, b - max_shift), dtype=np.float32))
        return piece

    acc = th.zeros(1, sources, channels, segment_length)
    total = th.zeros(segment_length)
    base = 0

    def flush(upto, last=False):
        """Hand on the stretch from `base` to `upto`, which no later segment touches."""
        nonlocal acc, total, base
        n = upto - base
        if n <= 0 and not last:
            return
        done = acc[..., :n] / total[:n]
        lo, hi = max(base, lead), min(upto, lead + length)
        if hi > lo or last:
            emit(done[0, ..., max(0, lo - base):max(0, hi - base)], last=last)
        acc = th.cat([acc[..., n:], acc.new_zeros(1, sources, channels, n)], dim=-1)
        total = th.cat([total[n:], total.new_zeros(n)])
        base = upto

    for offset in range(0, span, stride):
        flush(offset)
        chunk_length = min(segment_length, span - offset)
        # Wide enough for any padding apply_model adds around a segment.
        start = max(0, shift + offset - 2 * segment_length)
        stop = min(padded_length, shift + offset + 3 * segment_length)
        chunk = TensorChunk(window(start, stop), shift + offset - start, chunk_length)
        chunk_out = apply_model(model, chunk, shifts=0, split=False, overlap=overlap,
                                progress=False, device=device, segment=segment)
        acc[..., :chunk_length] += (weight[:chunk_length] * chunk_out).to('cpu')
        total[:chunk_length] += weight[:chunk_length].to('cpu')
    flush(span, last=True)
    return out


BS_ROFORMER_RATE = 44100

# Calls swap the shared separator's output_dir; interleaved swaps landed stems in the working directory.
_BS_ROFORMER_LOCK = threading.Lock()

STEM_OF = {'drums': 'drums', 'bass': 'bass', 'vocals': 'vocals', 'other': 'other',
           'guitar': 'other', 'piano': 'other'}


def separate_bs_roformer(mono, sample_rate, stereo_loader=None):
    """
    Run the configured four-stem BS-RoFormer and normalise its outputs.

    Like Demucs, it is given the real stereo at its own rate when
    `stereo_loader` can supply it, and the mono analysis signal otherwise.
    """
    import os
    import sys
    import tempfile
    import soundfile as sf
    import librosa
    separator = models.bs_roformer_separator()
    with tempfile.TemporaryDirectory(prefix='artnet-bs-') as tmp:
        source = os.path.join(tmp, 'input.wav')
        stereo = stereo_loader(BS_ROFORMER_RATE) if stereo_loader else None
        if stereo is not None and np.ndim(stereo) == 2 and stereo.shape[0] == 2:
            sf.write(source, np.asarray(stereo, dtype=np.float32).T, BS_ROFORMER_RATE)
        else:
            sf.write(source, np.asarray(mono, dtype=np.float32), sample_rate)
        with _BS_ROFORMER_LOCK:
            # audio-separator copies output_dir into the loaded model, so redirect both.
            targets = [separator, separator.model_instance]
            previous_dirs = [target.output_dir for target in targets]
            try:
                for target in targets:
                    target.output_dir = tmp
                with models.inference('bs-roformer', modules=[models.bs_roformer_module(separator)]):
                    paths = separator.separate(source)
            finally:
                for target, previous in zip(targets, previous_dirs):
                    target.output_dir = previous
        stems = {}
        for item in paths:
            label = os.path.basename(item).lower()
            source_name = next((n for n in STEM_OF if f'({n})' in label), None)
            if source_name:
                name = STEM_OF[source_name]
                output = item if os.path.isabs(item) else os.path.join(tmp, item)
                signal, sr = librosa.load(output, sr=sample_rate, mono=True)
                signal = np.pad(signal, (0, max(0, len(mono) - len(signal))))[:len(mono)]
                stems[name] = stems[name] + signal if name in stems else signal
    return Stems(sample_rate=sample_rate, backend='bs_roformer', **{
        name: stems.get(name, np.zeros(len(mono), dtype=np.float32))
        for name in ('drums', 'bass', 'vocals', 'other')})


def envelope(signal, features, smooth_sec=0.0):
    """A stem's 0..1 level on the feature grid (same hop), indexable alongside the bands and onsets."""
    from . import dsp
    if signal.size == 0 or features.n_frames == 0:
        return np.zeros(features.n_frames)
    hop, n_fft = features.hop_length, features.n_fft
    frames = features.n_frames
    padded = np.pad(signal, (n_fft // 2, n_fft // 2))
    levels = np.empty(frames)
    for i in range(frames):
        start = i * hop
        window = padded[start:start + n_fft]
        levels[i] = np.sqrt(np.mean(window ** 2)) if window.size else 0.0
    if smooth_sec > 0:
        levels = dsp.moving_average(levels, max(1, int(smooth_sec * features.frame_rate)))
    return dsp.robust_norm(levels)

"""The music at pixel rate: each stem's level fifty times a second, and every kick, snare and hat as it is hit."""

import base64

import numpy as np

from . import dsp

# MDB Drums F within 50 ms on the Demucs drum stem: kick 0.88, snare 0.71, hats 0.50 (texture only).
RATE = 50                 # envelope points per second
# Lane-rule version (schema pulse.detector): 2 = rules measured on real drumming (scripts/eval-drums.py).
DETECTOR = 2
DB_RANGE = 36.0           # what 0..1 spans, below the stem's own loud level
SILENT_DB = -60.0         # a stem never louder than this is empty

_N_FFT = 1024
_HOP = 256

LANE_BANDS = {
    'kick': (30.0, 150.0),
    'snare': (1000.0, 5000.0),
    'hats': (7000.0, 11000.0),
}
_MIN_GAP = {'kick': 0.09, 'snare': 0.13, 'hats': 0.05}
_FLOOR = 0.25
_KICK_UNDER_SNARE = 0.8


def envelope(signal, sample_rate):
    """
    `signal`'s level at RATE Hz, 0..1, as uint8.

    RMS over 40 ms windows every 20 ms, in dB, mapped from DB_RANGE below the
    signal's own loud level (its 99.5th percentile) up to that level. Relative
    to the stem rather than to the mix, so a bar driven by the vocal stem uses
    its whole range for the voice; a stem that is effectively empty stays at 0.
    """
    x = np.asarray(signal, dtype=np.float32).ravel()
    hop = max(1, int(round(sample_rate / RATE)))
    count = int(np.ceil(x.size / hop)) if x.size else 0
    if count == 0:
        return np.zeros(0, dtype=np.uint8)
    padded = np.pad(x, (hop // 2, hop * 2))
    power = padded.astype(np.float64) ** 2
    cumulative = np.concatenate([[0.0], np.cumsum(power)])
    starts = np.arange(count) * hop
    width = 2 * hop
    rms = np.sqrt(np.maximum(0.0, (cumulative[starts + width] - cumulative[starts]) / width))
    db = 20.0 * np.log10(np.maximum(rms, 1e-9))
    loud = float(np.percentile(db, 99.5))
    if loud < SILENT_DB:
        return np.zeros(count, dtype=np.uint8)
    level = np.clip((db - (loud - DB_RANGE)) / DB_RANGE, 0.0, 1.0)
    return np.round(level * 255).astype(np.uint8)


def encode(values):
    return base64.b64encode(np.asarray(values, dtype=np.uint8).tobytes()).decode('ascii')


def decode(text):
    return np.frombuffer(base64.b64decode(text), dtype=np.uint8)


def _band_flux(magnitude, frequencies, low, high):
    mask = (frequencies >= low) & (frequencies < high)
    if not np.any(mask):
        return np.zeros(magnitude.shape[1])
    # Linear, not log: on a log scale a hat's faint tail below 5 kHz reads as a snare.
    band = magnitude[mask]
    flux = np.maximum(np.diff(band, axis=1, prepend=band[:, :1]), 0.0).mean(axis=0)
    scale = float(np.percentile(flux, 99)) if flux.size else 0.0
    return flux / scale if scale > 1e-9 else np.zeros_like(flux)


def lanes(drums, sample_rate):
    """
    `{lane: {'t': [...], 's': [...]}}` for the kick, the snare and the hats:
    onset times in seconds and strengths 0..1.
    """
    import librosa
    x = np.asarray(drums, dtype=np.float32).ravel()
    empty = {name: {'t': [], 's': []} for name in LANE_BANDS}
    if x.size < _N_FFT or float(np.max(np.abs(x))) < 1e-4:
        return empty
    magnitude = np.abs(librosa.stft(x, n_fft=_N_FFT, hop_length=_HOP))
    frequencies = librosa.fft_frequencies(sr=sample_rate, n_fft=_N_FFT)
    frame_rate = sample_rate / _HOP
    flux = {name: _band_flux(magnitude, frequencies, lo, hi)
            for name, (lo, hi) in LANE_BANDS.items()}

    def local(values):
        return np.maximum(values, np.maximum(np.roll(values, 1), np.roll(values, -1)))

    near = {name: local(values) for name, values in flux.items()}
    snare = np.where(near['kick'] > flux['snare'] * 1.2, 0.0, flux['snare'])
    claims = {
        # Only a weak low rise under a bigger snare is its body; a kick played with the snare is a full rise.
        'kick': np.where((near['snare'] > flux['kick']) & (flux['kick'] < _KICK_UNDER_SNARE), 0.0, flux['kick']),
        'snare': np.where(near['hats'] > snare * 1.5, 0.0, snare),
        'hats': np.where(near['snare'] > flux['hats'] * 0.8, 0.0, flux['hats']),
    }

    out = {}
    for name, strength in claims.items():
        wait = max(1, int(_MIN_GAP[name] * frame_rate))
        peaks = dsp.adaptive_peaks(strength, pre=int(frame_rate * 0.5), post=int(frame_rate * 0.5),
                                   delta=0.25, wait=wait)
        peaks = [int(p) for p in peaks if strength[p] >= _FLOOR]
        out[name] = {
            't': [round(float(p * _HOP / sample_rate), 3) for p in peaks],
            's': [round(float(min(1.0, strength[p])), 2) for p in peaks],
        }
    return out


def analyse(audio, stems=None):
    """The document's `pulse` block for one track."""
    envelopes = {'mix': encode(envelope(audio.mono, audio.sample_rate))}
    if stems is not None:
        for name in stems.names:
            envelopes[name] = encode(envelope(stems.named(name), stems.sample_rate))
        drums, rate, source = stems.drums, stems.sample_rate, 'stems'
    else:
        drums, rate, source = audio.percussive, audio.sample_rate, 'mix'
    return {
        'rate': RATE,
        'encoding': 'u8-base64',
        'source': source,
        'detector': DETECTOR,
        'envelopes': envelopes,
        'lanes': lanes(drums, rate),
    }

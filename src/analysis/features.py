"""Stage 2 — frame-level features on one shared time grid."""

from dataclasses import dataclass, field

import numpy as np

from . import dsp
from .config import PreprocessConfig


@dataclass
class FrameFeatures:
    times: np.ndarray
    magnitude: np.ndarray
    frequencies: np.ndarray
    sample_rate: int
    hop_length: int
    n_fft: int

    rms: np.ndarray = field(default_factory=lambda: np.zeros(0))
    energy: np.ndarray = field(default_factory=lambda: np.zeros(0))
    loudness: np.ndarray = field(default_factory=lambda: np.zeros(0))
    centroid: np.ndarray = field(default_factory=lambda: np.zeros(0))
    rolloff: np.ndarray = field(default_factory=lambda: np.zeros(0))
    rolloff_low: np.ndarray = field(default_factory=lambda: np.zeros(0))
    flux: np.ndarray = field(default_factory=lambda: np.zeros(0))
    zcr: np.ndarray = field(default_factory=lambda: np.zeros(0))
    flatness: np.ndarray = field(default_factory=lambda: np.zeros(0))
    contrast: np.ndarray = field(default_factory=lambda: np.zeros(0))
    percussive_onset: np.ndarray = field(default_factory=lambda: np.zeros(0))
    chroma: np.ndarray = field(default_factory=lambda: np.zeros((12, 0)))
    harmonic_magnitude: np.ndarray = field(default_factory=lambda: np.zeros((0, 0)))
    percussive_magnitude: np.ndarray = field(default_factory=lambda: np.zeros((0, 0)))
    #: Empty when the source has nothing above the analysis Nyquist: `air` is then absent, not silent.
    wideband_magnitude: np.ndarray = field(default_factory=lambda: np.zeros((0, 0)))
    wideband_frequencies: np.ndarray = field(default_factory=lambda: np.zeros(0))

    @property
    def n_frames(self):
        return int(self.magnitude.shape[1]) if self.magnitude.size else 0

    @property
    def frame_rate(self):
        return self.sample_rate / float(self.hop_length)


def _trim_to(*arrays):
    """Clip every array to the shortest length so the grid stays aligned."""
    n = min(a.shape[-1] for a in arrays if a.size)
    return [a[..., :n] for a in arrays]


def spectral_flux(magnitude, lag=1):
    """
    Half-wave rectified spectral difference, summed over bins.

    Rectification is the whole trick: only *increases* in a bin count. A note
    ending is a large spectral change and not an onset, and a detector that
    counts it fires twice per note.
    """
    if magnitude.size == 0 or magnitude.shape[1] <= lag:
        return np.zeros(magnitude.shape[1] if magnitude.size else 0)
    diff = np.diff(magnitude, n=1, axis=1)
    if lag > 1:
        diff = magnitude[:, lag:] - magnitude[:, :-lag]
    rectified = np.maximum(diff, 0.0)
    flux = np.sum(rectified, axis=0)
    return np.concatenate([np.zeros(magnitude.shape[1] - flux.size), flux])


def cqt_chroma(audio, config: PreprocessConfig = None):
    """
    The chroma `extract` uses, or None when the CQT fails.

    Whole, not a stretch at a time: its tuning estimate and its resampling
    are track-wide. Its working memory, 1.6 MB per second of audio, is handed
    back as soon as it is done.
    """
    import librosa
    from . import models
    config = config or PreprocessConfig()
    try:
        return librosa.feature.chroma_cqt(y=audio.harmonic, sr=audio.sample_rate,
                                          hop_length=config.hop_length)
    except Exception:
        return None
    finally:
        models.trim()


def extract(audio, config: PreprocessConfig = None) -> FrameFeatures:
    """
    Compute the shared frame grid from a `PreparedAudio`.

    Whatever is per frame is computed a stretch of frames at a time
    (`_magnitude`, `_by_frames`): on a whole track each step's temporaries were
    one to four more spectrograms, and the spectrograms the grid keeps were
    already held. The chroma is computed first, before there are
    spectrograms to sit beside it.
    """
    import librosa

    config = config or PreprocessConfig()
    sr = audio.sample_rate
    hop, n_fft = config.hop_length, config.n_fft

    chroma = cqt_chroma(audio, config)

    magnitude = _magnitude(audio.mono, n_fft, hop)
    harmonic_mag = _magnitude(audio.harmonic, n_fft, hop)
    percussive_mag = _magnitude(audio.percussive, n_fft, hop)
    magnitude, harmonic_mag, percussive_mag = _trim_to(
        magnitude, harmonic_mag, percussive_mag)

    frequencies = librosa.fft_frequencies(sr=sr, n_fft=n_fft)
    times = dsp.frames_to_times(magnitude.shape[1], sr, hop)

    rms = _by_frames(lambda S: librosa.feature.rms(S=S, frame_length=n_fft, hop_length=hop)[0], magnitude)
    centroid = _by_frames(lambda S: librosa.feature.spectral_centroid(S=S, sr=sr)[0], magnitude)
    rolloff = _by_frames(lambda S: librosa.feature.spectral_rolloff(S=S, sr=sr, roll_percent=0.85)[0],
                         magnitude)
    rolloff_low = _by_frames(lambda S: librosa.feature.spectral_rolloff(S=S, sr=sr, roll_percent=0.20)[0],
                             magnitude)
    flatness = _by_frames(lambda S: librosa.feature.spectral_flatness(S=S)[0], magnitude)
    zcr = librosa.feature.zero_crossing_rate(
        audio.mono, frame_length=n_fft, hop_length=hop)[0]
    try:
        # Whole: its decibels are clipped against the track's loudest band.
        contrast = np.mean(
            librosa.feature.spectral_contrast(S=magnitude, sr=sr), axis=0)
    except Exception:
        contrast = np.zeros(magnitude.shape[1])

    flux = _flux(magnitude)
    percussive_onset = librosa.onset.onset_strength(
        S=librosa.amplitude_to_db(percussive_mag, ref=np.max), sr=sr, hop_length=hop)

    if chroma is None:
        chroma = librosa.feature.chroma_stft(S=harmonic_mag, sr=sr)

    # K-weighting-shaped tilt per frame, not full BS.1770; absolute calibration comes from stage 1's integrated value.
    weights = _k_weight_response(frequencies)
    weighted_power = _by_frames(lambda S: np.sum((S ** 2) * weights[:, None], axis=0), magnitude)
    with np.errstate(divide='ignore'):
        loudness = -0.691 + 10.0 * np.log10(np.maximum(weighted_power, 1e-12))

    arrays = _trim_to(rms, centroid, rolloff, rolloff_low, flatness, zcr,
                      contrast, flux, percussive_onset, loudness)
    (rms, centroid, rolloff, rolloff_low, flatness, zcr,
     contrast, flux, percussive_onset, loudness) = arrays
    n = rms.size
    chroma = chroma[:, :n] if chroma.shape[1] >= n else np.pad(
        chroma, ((0, 0), (0, n - chroma.shape[1])), mode='edge')

    wideband_mag, wideband_freqs = _wideband_spectrogram(audio, config, n)

    return FrameFeatures(
        times=times[:n],
        magnitude=magnitude[:, :n],
        frequencies=frequencies,
        sample_rate=sr,
        hop_length=hop,
        n_fft=n_fft,
        rms=rms,
        energy=dsp.robust_norm(rms),
        loudness=loudness,
        centroid=centroid,
        rolloff=rolloff,
        rolloff_low=rolloff_low,
        flux=flux,
        zcr=zcr,
        flatness=flatness,
        contrast=contrast,
        percussive_onset=percussive_onset,
        chroma=chroma,
        harmonic_magnitude=harmonic_mag[:, :n],
        percussive_magnitude=percussive_mag[:, :n],
        wideband_magnitude=wideband_mag,
        wideband_frequencies=wideband_freqs,
    )


# Frames per stretch: 47 s at the analysis rate.
_STRETCH = 2048


def _magnitude(y, n_fft, hop):
    """
    `np.abs(librosa.stft(y, n_fft=n_fft, hop_length=hop))`, a stretch of frames at a time.

    A frame reads only the window around its centre, so each stretch is cut on
    the frame grid with half a window and a frame to spare on either side, and
    its frames are the whole-track call's; the complex spectrogram of the
    whole track is never held.
    """
    import librosa
    frames = 1 + y.size // hop
    guard = (n_fft // (2 * hop) + 2) * hop
    out = None
    for first in range(0, frames, _STRETCH):
        last = min(frames, first + _STRETCH)
        lo, hi = max(0, first * hop - guard), min(y.size, (last - 1) * hop + guard)
        part = np.abs(librosa.stft(y[lo:hi], n_fft=n_fft, hop_length=hop))
        if out is None:
            # librosa's layout: a frame's bins are contiguous, and numpy sums them pairwise.
            out = np.empty((part.shape[0], frames), dtype=part.dtype, order='F')
        skip = (first * hop - lo) // hop
        out[:, first:last] = part[:, skip:skip + last - first]
    return out


def _by_frames(fn, S):
    """`fn(S)` for a feature computed frame by frame, a stretch of frames at a time."""
    if S.shape[1] <= _STRETCH:
        return fn(S)
    return np.concatenate([fn(S[:, a:a + _STRETCH]) for a in range(0, S.shape[1], _STRETCH)], axis=-1)


def _flux(magnitude):
    """`spectral_flux(magnitude)` a stretch at a time: each stretch carries the frame before it."""
    if magnitude.shape[1] <= _STRETCH:
        return spectral_flux(magnitude)
    flux = np.zeros(magnitude.shape[1])
    for a in range(1, magnitude.shape[1], _STRETCH):
        b = min(magnitude.shape[1], a + _STRETCH)
        flux[a:b] = np.sum(np.maximum(np.diff(magnitude[:, a - 1:b], n=1, axis=1), 0.0), axis=0)
    return flux


def _wideband_spectrogram(audio, config, n_frames):
    """
    STFT of the wideband pass, resampled onto the main frame grid.

    The analysis rate is 22.05 kHz, which puts Nyquist at 11 kHz — below the
    bottom of the `air` band. Air is not a large part of a mix but it is the
    part that separates an open, expensive-sounding chorus from a closed one,
    and a lighting show that cannot see it loses that distinction entirely. The
    hop is scaled by the rate ratio so frame i means the same instant in both
    grids.
    """
    if audio.wideband is None or audio.wideband_rate <= 0:
        return np.zeros((0, 0)), np.zeros(0)
    import librosa
    ratio = audio.wideband_rate / float(audio.sample_rate)
    hop = max(1, int(round(config.hop_length * ratio)))
    n_fft = max(256, int(2 ** round(np.log2(config.n_fft * ratio))))
    try:
        magnitude = _magnitude(audio.wideband, n_fft, hop)
    except Exception:
        return np.zeros((0, 0)), np.zeros(0)
    if magnitude.shape[1] >= n_frames:
        magnitude = magnitude[:, :n_frames]
    else:
        pad = n_frames - magnitude.shape[1]
        magnitude = np.pad(magnitude, ((0, 0), (0, pad)), mode='edge')
    return magnitude, librosa.fft_frequencies(sr=audio.wideband_rate, n_fft=n_fft)


def _k_weight_response(frequencies):
    """
    Magnitude response of the BS.1770 K-weighting curve, sampled at the FFT bin
    frequencies, as a power weight. A shelf above ~1.7 kHz and a high-pass
    below ~40 Hz — the two things that make loudness differ from energy.
    """
    f = np.asarray(frequencies, dtype=float)
    f = np.maximum(f, 1e-6)
    hp = (f ** 2) / (f ** 2 + 38.0 ** 2)
    shelf_gain = 10.0 ** (3.99984385397 / 20.0)
    shelf = 1.0 + (shelf_gain - 1.0) * (f ** 2) / (f ** 2 + 1681.97 ** 2)
    return (hp * shelf) ** 2


def summarise(features: FrameFeatures):
    """Track-level scalars derived from the frame grid, for the document."""
    def stat(arr):
        arr = np.asarray(arr, dtype=float)
        if arr.size == 0:
            return {'mean': 0.0, 'std': 0.0, 'p90': 0.0}
        return {
            'mean': round(float(np.mean(arr)), 4),
            'std': round(float(np.std(arr)), 4),
            'p90': round(float(np.percentile(arr, 90)), 4),
        }

    return {
        'rms': stat(features.rms),
        'centroid': stat(features.centroid),
        'rolloff': stat(features.rolloff),
        'flux': stat(features.flux),
        'zcr': stat(features.zcr),
        'flatness': stat(features.flatness),
        'contrast': stat(features.contrast),
    }

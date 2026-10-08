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


def extract(audio, config: PreprocessConfig = None) -> FrameFeatures:
    """Compute the shared frame grid from a `PreparedAudio`."""
    import librosa

    config = config or PreprocessConfig()
    sr = audio.sample_rate
    hop, n_fft = config.hop_length, config.n_fft

    magnitude = np.abs(librosa.stft(audio.mono, n_fft=n_fft, hop_length=hop))
    harmonic_mag = np.abs(librosa.stft(audio.harmonic, n_fft=n_fft, hop_length=hop))
    percussive_mag = np.abs(librosa.stft(audio.percussive, n_fft=n_fft, hop_length=hop))
    magnitude, harmonic_mag, percussive_mag = _trim_to(
        magnitude, harmonic_mag, percussive_mag)

    frequencies = librosa.fft_frequencies(sr=sr, n_fft=n_fft)
    times = dsp.frames_to_times(magnitude.shape[1], sr, hop)

    rms = librosa.feature.rms(S=magnitude, frame_length=n_fft, hop_length=hop)[0]
    centroid = librosa.feature.spectral_centroid(S=magnitude, sr=sr)[0]
    rolloff = librosa.feature.spectral_rolloff(S=magnitude, sr=sr, roll_percent=0.85)[0]
    rolloff_low = librosa.feature.spectral_rolloff(S=magnitude, sr=sr, roll_percent=0.20)[0]
    flatness = librosa.feature.spectral_flatness(S=magnitude)[0]
    zcr = librosa.feature.zero_crossing_rate(
        audio.mono, frame_length=n_fft, hop_length=hop)[0]
    try:
        contrast = np.mean(
            librosa.feature.spectral_contrast(S=magnitude, sr=sr), axis=0)
    except Exception:
        contrast = np.zeros(magnitude.shape[1])

    flux = spectral_flux(magnitude)
    percussive_onset = librosa.onset.onset_strength(
        S=librosa.amplitude_to_db(percussive_mag, ref=np.max), sr=sr, hop_length=hop)

    try:
        chroma = librosa.feature.chroma_cqt(y=audio.harmonic, sr=sr, hop_length=hop)
    except Exception:
        chroma = librosa.feature.chroma_stft(S=harmonic_mag, sr=sr)

    # K-weighting-shaped tilt per frame, not full BS.1770; absolute calibration comes from stage 1's integrated value.
    weights = _k_weight_response(frequencies)
    weighted_power = np.sum((magnitude ** 2) * weights[:, None], axis=0)
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
        magnitude = np.abs(librosa.stft(audio.wideband, n_fft=n_fft, hop_length=hop))
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

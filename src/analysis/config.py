"""
Every tuning constant in the analysis pipeline, in one place.

Stages import from here rather than hard-coding numbers so a value can be
traced from the show back to the thing it controls, and so the whole pipeline
can be re-tuned for an unusual rig or an unusual genre by passing a modified
`AnalysisConfig` into `pipeline.analyze()`.

Units are stated on every field. Seconds are seconds, Hz are Hz, and anything
named `*_ratio` or `*_score` is a 0..1 fraction.
"""

from dataclasses import dataclass, field, replace
from typing import Dict, Tuple


BANDS: Dict[str, Tuple[float, float]] = {
    'sub':      (20.0, 60.0),      # felt more than heard; 808s, sub drops
    'bass':     (60.0, 250.0),     # kick body, bass guitar, bass synth
    'lowmid':   (250.0, 500.0),    # warmth, low vocals, guitar body
    'mid':      (500.0, 2000.0),   # vocal fundamentals, most melody
    'presence': (2000.0, 5000.0),  # snare crack, vocal intelligibility
    'high':     (5000.0, 12000.0), # hats, cymbals, transient detail
    'air':      (12000.0, 20000.0) # shimmer, reverb tails, "expensive" top
}

BAND_ORDER = list(BANDS.keys())


@dataclass(frozen=True)
class PreprocessConfig:
    sample_rate: int = 22050
    wideband_rate: int = 32000
    highpass_hz: float = 18.0
    target_lufs: float = -18.0
    max_gain_db: float = 24.0
    noise_floor_percentile: float = 5.0
    noise_reduction: float = 0.5
    hpss_margin: float = 3.0
    n_fft: int = 2048
    hop_length: int = 512


@dataclass(frozen=True)
class RhythmConfig:
    tempo_min: float = 55.0
    tempo_max: float = 200.0
    tempo_prior_bpm: float = 120.0
    tempo_prior_std: float = 1.0
    #: Window over which local tempo is measured, seconds.
    tempo_window_sec: float = 8.0
    onset_delta: float = 0.07
    #: Minimum gap between onsets, seconds. Two hits closer than this are one.
    onset_min_gap_sec: float = 0.03
    downbeat_tolerance_ratio: float = 0.25
    meters: Tuple[int, ...] = (4, 3)


@dataclass(frozen=True)
class StructureConfig:
    recurrence_width: int = 9
    min_section_sec: float = 8.0
    min_clusters: int = 3
    max_clusters: int = 10
    novelty_kernel_beats: int = 16
    label_smoothing_beats: int = 17
    repeat_threshold: int = 2


@dataclass(frozen=True)
class DynamicsConfig:
    drop_min_rise: float = 0.22
    drop_min_breakdown: float = 0.18
    drop_sustain_sec: float = 4.0
    #: Minimum gap between two accepted drops, seconds.
    drop_min_gap_sec: float = 12.0
    #: Roughly one drop per this many seconds of track is kept, most confident
    #: first. Pop songs do not have eight drops.
    drop_density_sec: float = 50.0
    #: Build-up search window before a drop, seconds.
    buildup_max_sec: float = 16.0
    buildup_min_sec: float = 1.5
    buildup_trend: float = 0.80
    silence_threshold: float = 0.06
    silence_min_sec: float = 0.4
    spike_min_sigma: float = 2.2
    break_min_fall: float = 0.25
    break_min_sec: float = 3.0


@dataclass(frozen=True)
class EventConfig:
    #: Beat events below this confidence are not emitted at all — the show
    #: engine should never be handed a beat the analyser does not believe in.
    beat_min_confidence: float = 0.10
    bass_hit_threshold: float = 0.55
    #: Minimum gap between successive bass-hit events, seconds.
    bass_hit_min_gap_sec: float = 0.18
    vocal_threshold: float = 0.42
    vocal_min_sec: float = 4.0
    melody_change_threshold: float = 0.34
    melody_change_min_gap_sec: float = 6.0


@dataclass(frozen=True)
class RealtimeConfig:
    sample_rate: int = 22050
    hop_length: int = 512
    n_fft: int = 1024
    #: Length of the rolling history used for adaptive thresholds, seconds.
    history_sec: float = 10.0
    onset_k: float = 1.6
    #: Tempo is re-estimated this often, seconds.
    tempo_refresh_sec: float = 2.0
    #: How often the beat phase is re-fitted to the recent onsets, seconds.
    phase_refresh_sec: float = 0.5
    #: How much onset history each re-fit reads, seconds: enough beats that a
    #: syncopated bar is outvoted, few enough to follow a drifting tempo.
    phase_window_sec: float = 4.0
    phase_lock_strength: float = 0.5
    frequency_lock_strength: float = 0.012


@dataclass(frozen=True)
class AnalysisConfig:
    preprocess: PreprocessConfig = field(default_factory=PreprocessConfig)
    rhythm: RhythmConfig = field(default_factory=RhythmConfig)
    structure: StructureConfig = field(default_factory=StructureConfig)
    dynamics: DynamicsConfig = field(default_factory=DynamicsConfig)
    events: EventConfig = field(default_factory=EventConfig)
    realtime: RealtimeConfig = field(default_factory=RealtimeConfig)
    enable_semantics: bool = True
    enable_tagger: bool = True
    separate_sources: bool = True
    parallel: bool = True
    structure_model: str = None

    def tuned(self, **overrides) -> 'AnalysisConfig':
        """Return a copy with top-level fields replaced. Useful from tests."""
        return replace(self, **overrides)


DEFAULT = AnalysisConfig()

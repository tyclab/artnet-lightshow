"""SongFormer (Hao et al., 2025): the sections a listener would name."""

import contextlib
import importlib.util
import math
import os
import sys
import types
from pathlib import Path

from . import models

RATE = 24000
WINDOW_SEC = 420
MIN_WINDOW_SEC = 60
# Working memory per second² of window, on CPU: a 420 s window needs ~22 GB and got the worker OOM-killed on 16 GB.
GB_PER_SECOND_SQUARED = 1.25e-4
MEMORY_SHARE = 0.6
REQUIRED_FILES = ('model.safetensors', 'modeling_songformer.py', 'config.json',
                  'muq_config2.json', 'msd_stats.json')
REQUIRED_PACKAGES = ('muq', 'x_transformers', 'omegaconf', 'ema_pytorch', 'loguru',
                     'safetensors', 'transformers')
MODES = ('auto', 'songformer', 'off')  # auto runs it only on a GPU: on a laptop CPU it is ~0.75x real time


def _log(message):
    print(f'[songformer] {message}', file=sys.stderr, flush=True)


def model_dir():
    root = Path(os.environ.get('ARTNET_MODEL_DIR',
                               Path.home() / '.cache' / 'artnet-lightshow' / 'models'))
    return Path(os.environ.get('ARTNET_SONGFORMER_MODEL') or root / 'songformer')


def mode(value=None):
    """The configured mode, `auto` when unset or unrecognised."""
    value = (value or os.environ.get('ARTNET_STRUCTURE_MODEL') or 'auto').strip().lower()
    return value if value in MODES else 'auto'


def missing():
    """What stops SongFormer loading here: missing files and packages, or []."""
    directory = model_dir()
    gaps = [f'{directory / name}' for name in REQUIRED_FILES if not (directory / name).is_file()]
    for package in REQUIRED_PACKAGES:
        try:
            found = importlib.util.find_spec(package) is not None
        except (ImportError, ValueError):
            found = False
        if not found:
            gaps.append(f'python package {package}')
    return gaps


def available():
    return not missing()


def wanted(value=None):
    """Should this track's sections come from SongFormer?"""
    chosen = mode(value)
    if chosen == 'off' or not available():
        return False
    if chosen == 'songformer':
        return True
    return models.on_gpu()


def _stub_msaf():
    """Stub msaf, imported only for evaluation metrics: msaf pins enum34, which breaks the stdlib on Python 3."""
    if 'msaf' in sys.modules or importlib.util.find_spec('msaf') is not None:
        return
    def compute_results(*_args, **_kwargs):
        raise RuntimeError('msaf is not installed; SongFormer evaluation is unavailable')
    msaf = types.ModuleType('msaf')
    evaluation = types.ModuleType('msaf.eval')
    evaluation.compute_results = compute_results
    msaf.eval = evaluation
    sys.modules['msaf'] = msaf
    sys.modules['msaf.eval'] = evaluation


def load():
    """
    The model, built once per process: on the analysis device, or in RAM when
    models are kept there between passes (models.offloading).
    """
    directory = model_dir()

    def build():
        target = models.home()
        gaps = missing()
        if gaps:
            raise RuntimeError(f'SongFormer is not installed: missing {", ".join(gaps)}')
        _stub_msaf()
        os.environ['SONGFORMER_LOCAL_DIR'] = str(directory)
        if str(directory) not in sys.path:
            sys.path.insert(0, str(directory))
        import torch
        from safetensors.torch import load_file
        _log(f'loading from {directory}…')
        # Its code and transformers print on stdout, the worker's protocol stream.
        with contextlib.redirect_stdout(sys.stderr):
            modeling = importlib.import_module('modeling_songformer')
            configuration = importlib.import_module('configuration_songformer')
            config = configuration.SongFormerConfig.from_pretrained(str(directory))
            model = modeling.SongFormerModel(config)
            state = load_file(str(directory / 'model.safetensors'))
            model.load_state_dict(state, strict=True)
            del state
        model = model.float().to(target).eval()
        if models.offloading():
            models.park(model)
        return model

    return models.cached(f'songformer:{directory}', build)


def available_gb(device):
    """Memory free for the model now: the card's, or the machine's. None if unknown."""
    if str(device).startswith('cuda'):
        try:
            import torch
            return torch.cuda.mem_get_info()[0] / 1e9
        except Exception:
            return None
    try:
        import psutil
        return psutil.virtual_memory().available / 1e9
    except Exception:
        pass
    try:
        with open('/proc/meminfo') as handle:
            for line in handle:
                if line.startswith('MemAvailable:'):
                    return int(line.split()[1]) / 1e6
    except OSError:
        pass
    return None


def window_for(duration, free_gb):
    """
    The window to read a track of `duration` seconds in, given `free_gb`.

    The longest whole number of 30-second steps (the model's inner windows)
    whose working memory fits in its share of what is free, at most 420 s.
    A track longer than that is read in equal windows rather than full ones
    and a scrap. Raises MemoryError when not even MIN_WINDOW_SEC fits.
    Unknown free memory is treated as 8 GB.
    """
    budget = (8.0 if free_gb is None else free_gb) * MEMORY_SHARE
    fits = math.sqrt(max(0.0, budget) / GB_PER_SECOND_SQUARED)
    window = min(WINDOW_SEC, int(fits // 30) * 30)
    if window < MIN_WINDOW_SEC:
        raise MemoryError(f'SongFormer needs {GB_PER_SECOND_SQUARED * MIN_WINDOW_SEC ** 2 / MEMORY_SHARE:.1f} GB '
                          f'free for its shortest window; {free_gb:.1f} GB is')
    if duration <= window:
        return window
    count = math.ceil(duration / window)
    return min(window, int(math.ceil(duration / count / 30)) * 30)


def _fit_windows(audio, window=WINDOW_SEC):
    """
    Trim a tail the model would never finish.

    Its window loop skips a window of 1024 samples or fewer without moving on,
    so a track a few milliseconds longer than a multiple of the window hangs
    the worker. Those milliseconds carry no structure.
    """
    step = window * RATE
    tail = len(audio) % step
    if 0 < tail <= 1024 and len(audio) > step:
        return audio[:len(audio) - tail]
    return audio


def sections(samples, sample_rate):
    """
    Sections of mono `samples`, as `[{'start', 'end', 'label'}, …]` in seconds.

    Labels are SongFormer's own: intro, verse, pre-chorus, chorus, bridge,
    inst, outro, silence. Raises when the model cannot run, or when there is
    not the memory to; the caller keeps the labeller's answer.
    """
    import numpy as np
    import torch
    from .preprocess import resample
    audio = np.asarray(samples, dtype=np.float32)
    if audio.ndim > 1:
        audio = audio.mean(axis=0)
    audio = resample(audio, sample_rate, RATE)
    if audio.size < RATE * 5:
        return []
    model = load()

    def run(device):
        with torch.inference_mode(), contextlib.redirect_stdout(sys.stderr):
            window = window_for(audio.size / RATE, available_gb(device))
            if window < WINDOW_SEC:
                _log(f'reading in {window} s windows ({audio.size / RATE:.0f} s track)')
            fitted = _fit_windows(audio, window)
            model.config.win_size = model.config.hop_size = window
            return fitted, model(fitted)

    audio, rows = models.run_pass('songformer', run, modules=[model])
    duration = audio.size / RATE
    out = []
    for row in rows or []:
        start = max(0.0, float(row['start']))
        end = min(duration, float(row['end']))
        if end - start > 0.05:
            out.append({'start': round(start, 3), 'end': round(end, 3), 'label': str(row['label'])})
    return out

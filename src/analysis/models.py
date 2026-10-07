"""The one place torch lives."""

import contextlib
import os
import sys
import threading
import warnings
import weakref

_LOCK = threading.RLock()
_CACHE = {}
_DEVICE = None
_OFFLOAD = None


class _Turns:
    """Re-entrant GPU turn queue; first/reserve prioritize the beat model.
    Active passes are never interrupted. Separate from the model-cache _LOCK so
    loading a model cannot block another model's in-flight inference.
    """

    def __init__(self):
        self._cond = threading.Condition()
        self._owner = None
        self._depth = 0
        self._reserved = []
        self._first_waiting = 0

    def reserve(self):
        """Keep the next `first` turn for a pass that has not asked yet."""
        token = object()
        with self._cond:
            self._reserved.append(token)
        return token

    def cancel(self, token):
        """Give up a reservation that was never used. Safe once it has been."""
        with self._cond:
            if token in self._reserved:
                self._reserved.remove(token)
                self._cond.notify_all()

    def acquire(self, first=False):
        me = threading.get_ident()
        with self._cond:
            if self._owner == me:
                self._depth += 1
                return
            if first:
                self._first_waiting += 1
            try:
                while self._owner is not None or (
                        not first and (self._reserved or self._first_waiting)):
                    self._cond.wait()
            finally:
                if first:
                    self._first_waiting -= 1
            if first and self._reserved:
                self._reserved.pop(0)
            self._owner = me
            self._depth = 1

    def release(self):
        with self._cond:
            self._depth -= 1
            if self._depth == 0:
                self._owner = None
                self._cond.notify_all()


_TURNS = _Turns()

os.environ.setdefault('PYTORCH_CUDA_ALLOC_CONF', 'expandable_segments:True')

# Keep rotary-embedding-torch 0.6: 0.8's changed cache semantics silently break audio-separator.
warnings.filterwarnings(
    'ignore', message=r'`torch\.cuda\.amp\.autocast\(args\.\.\.\)` is deprecated',
    category=FutureWarning, module=r'rotary_embedding_torch')
warnings.filterwarnings(
    'ignore', message=r'`torch\.nn\.utils\.weight_norm` is deprecated',
    category=FutureWarning)


def _log(message):
    print(f'[models] {message}', file=sys.stderr, flush=True)


def device():
    """
    The torch device everything runs on, decided once per process.

    `ARTNET_ANALYSIS_DEVICE` overrides it — useful for forcing CPU when a GPU
    is busy driving a visualiser, which on a one-machine setup it often is.
    """
    global _DEVICE
    if _DEVICE is not None:
        return _DEVICE
    with _LOCK:
        if _DEVICE is not None:
            return _DEVICE
        import torch
        chosen = _override(torch)
        if chosen:
            source = 'from ARTNET_ANALYSIS_DEVICE'
        elif torch.cuda.is_available():
            chosen, source = 'cuda', torch.cuda.get_device_name(0)
        else:
            chosen, source = 'cpu', None
        if chosen.startswith('cuda'):
            _avoid_miopen(torch)
            _log(f'device: {chosen} ({source})')
            _decide_offload(torch, chosen)
        elif chosen == 'cpu':
            cores = os.cpu_count() or 4
            torch.set_num_threads(max(1, cores - 1))
            _log(f'device: cpu ({max(1, cores - 1)} of {cores} threads'
                 f'{", " + source if source else ""})')
        else:
            _log(f'device: {chosen} ({source})')
        _DEVICE = chosen
        return _DEVICE


def _override(torch):
    """Return a usable ARTNET_ANALYSIS_DEVICE override; log and ignore invalid values."""
    wanted = os.environ.get('ARTNET_ANALYSIS_DEVICE', '').strip().lower()
    if not wanted:
        return None
    try:
        parsed = torch.device(wanted)
    except (RuntimeError, ValueError, TypeError):
        _log(f'ARTNET_ANALYSIS_DEVICE={wanted!r} is not a device; choosing one')
        return None
    if parsed.type == 'cuda' and not torch.cuda.is_available():
        _log(f'ARTNET_ANALYSIS_DEVICE={wanted!r}, but this torch has no usable GPU; '
             'choosing one')
        return None
    if parsed.type not in ('cpu', 'cuda', 'mps', 'xpu'):
        _log(f'ARTNET_ANALYSIS_DEVICE={wanted!r} is not supported here; choosing one')
        return None
    return wanted


def _avoid_miopen(torch):
    """Disable ROCm MIOpen kernels whose runtime compiler lacks C++ headers on Windows.
    PyTorch native kernels avoid BatchNorm failures; ARTNET_MIOPEN=1 opts back in.
    """
    if getattr(torch.version, 'hip', None) and os.environ.get('ARTNET_MIOPEN', '') != '1':
        torch.backends.cudnn.enabled = False
        _log('MIOpen off (ROCm): using PyTorch kernels; ARTNET_MIOPEN=1 to re-enable')



SMALL_CARD_GB = 12
_PARKED = weakref.WeakKeyDictionary()   # module -> its weights in RAM
_PINNED = [0]                           # bytes pinned so far
_PIN_WARNED = [False]


def _decide_offload(torch, chosen):
    """Keep models in RAM between passes on this card? Decided with the device."""
    global _OFFLOAD
    wanted = os.environ.get('ARTNET_GPU_MEMORY', 'auto').strip().lower() or 'auto'
    total = None
    try:
        index = torch.device(chosen).index or 0
        total = torch.cuda.get_device_properties(index).total_memory / 2 ** 30
    except Exception:  # pragma: no cover - a card torch cannot describe
        pass
    if wanted == 'offload':
        _OFFLOAD, why = True, 'ARTNET_GPU_MEMORY=offload'
    elif wanted == 'resident':
        _OFFLOAD, why = False, 'ARTNET_GPU_MEMORY=resident'
    else:
        if wanted != 'auto':
            _log(f'ARTNET_GPU_MEMORY={wanted!r} is not auto, offload or resident; using auto')
        _OFFLOAD = total is not None and total < SMALL_CARD_GB
        why = f'{total:.0f} GB card' if total is not None else 'card size unknown'
    _log(('models in RAM, on the card for their pass only' if _OFFLOAD
          else 'models stay on the card') + f' ({why})')
    return _OFFLOAD


def offloading():
    """Do models live in RAM between their passes? Only ever on a CUDA card."""
    if not on_gpu():
        return False
    if _OFFLOAD is None:
        try:
            import torch
            _decide_offload(torch, str(device()))
        except Exception:
            return False
    return bool(_OFFLOAD)


def home():
    """Where a model is built: in RAM when offloading, else on the device."""
    return 'cpu' if offloading() else device()


def _slots(module):
    """
    A module's weights: (owner, kind, name, tensor) for every parameter and
    buffer of every submodule. A weight two submodules share (tied weights)
    is listed under each; callers move it once.
    """
    import torch
    if not isinstance(module, torch.nn.Module):
        return []
    out = []
    for owner in module.modules():
        for name, tensor in owner._parameters.items():
            if tensor is not None:
                out.append((owner, 'parameter', name, tensor))
        for name, tensor in owner._buffers.items():
            if tensor is not None:
                out.append((owner, 'buffer', name, tensor))
    return out


def _put(owner, kind, name, tensor, value):
    """
    Point a weight at `value`, as `nn.Module.to` does: the same Parameter
    re-pointed where torch allows it (between RAM and a card), a new one
    where it does not.
    """
    if kind == 'buffer':
        owner._buffers[name] = value
        return
    try:
        tensor.data = value
    except RuntimeError:
        import torch
        owner._parameters[name] = torch.nn.Parameter(value, requires_grad=tensor.requires_grad)


def _ram_bytes():
    """The machine's RAM, or None."""
    try:
        return os.sysconf('SC_PAGE_SIZE') * os.sysconf('SC_PHYS_PAGES')
    except (AttributeError, ValueError, OSError):
        pass
    try:
        import psutil
        return psutil.virtual_memory().total
    except Exception:
        pass
    if sys.platform == 'win32':
        try:
            import ctypes

            class Status(ctypes.Structure):
                _fields_ = [('length', ctypes.c_ulong), ('load', ctypes.c_ulong),
                            ('total', ctypes.c_ulonglong), ('available', ctypes.c_ulonglong),
                            ('page_total', ctypes.c_ulonglong), ('page_free', ctypes.c_ulonglong),
                            ('virtual_total', ctypes.c_ulonglong), ('virtual_free', ctypes.c_ulonglong),
                            ('extended', ctypes.c_ulonglong)]
            status = Status()
            status.length = ctypes.sizeof(Status)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
                return status.total
        except Exception:
            pass
    return None


def _pin_budget():
    """
    Bytes of weights to pin: a quarter of the machine's RAM, or ARTNET_PINNED_GB.

    Pinned memory cannot be paged out, so it is RAM the rest of the machine —
    the server, the browser, the DJ software — no longer has. Past the budget
    weights are kept in ordinary memory: the copy is slower, still no disk.
    """
    raw = os.environ.get('ARTNET_PINNED_GB', '').strip()
    if raw:
        try:
            return max(0.0, float(raw)) * 2 ** 30
        except ValueError:
            _log(f'ARTNET_PINNED_GB={raw!r} is not a number; using a quarter of the RAM')
    ram = _ram_bytes()
    return ram / 4 if ram else 8 * 2 ** 30


def _host_copy(tensor):
    """The tensor in RAM, pinned while the budget allows."""
    import torch
    value = tensor.detach()
    size = value.numel() * value.element_size()
    if on_gpu() and _PINNED[0] + size <= _pin_budget():
        try:
            host = torch.empty(value.shape, dtype=value.dtype, pin_memory=True)
            host.copy_(value)
            _PINNED[0] += size
            return host
        except Exception as exc:
            if not _PIN_WARNED[0]:
                _PIN_WARNED[0] = True
                _log(f'could not pin weights in RAM ({exc}); keeping them in ordinary memory')
    return value if value.device.type == 'cpu' else value.to('cpu')


def park(module):
    """
    Put a module's weights in RAM, and drop any copy of them on the card.

    The first time, a copy of each weight is made in RAM (pinned); every time
    after, the weights simply go back to that copy. Anything that is not a
    torch module is left as it is.
    """
    slots = _slots(module)
    if not slots:
        return
    with _LOCK:
        store = _PARKED.get(module)
        if store is None:
            store = {}
            _PARKED[module] = store
        made = {}
        for owner, kind, name, tensor in slots:
            key = (id(owner), kind, name)
            host = store.get(key)
            if host is None:
                host = made.get(id(tensor))
                if host is None:
                    host = made[id(tensor)] = _host_copy(tensor)
                store[key] = host
            _put(owner, kind, name, tensor, host)


def _forget_parked(module):
    """Drop a module's copy in RAM, and count its pinned bytes as free again."""
    store = _PARKED.pop(module, None) if module is not None else None
    for host in {id(host): host for host in (store or {}).values()}.values():
        try:
            if host.is_pinned():
                _PINNED[0] -= host.numel() * host.element_size()
        except Exception:  # pragma: no cover - a tensor torch cannot describe
            pass


def to_card(module, target):
    """Put a module's weights on `target` for a pass, from RAM where they are there."""
    slots = _slots(module)
    if not slots:
        return
    where = _as_device(target)
    moved = {}
    for owner, kind, name, tensor in slots:
        if tensor.device != where:
            value = moved.get(id(tensor))
            if value is None:
                value = moved[id(tensor)] = tensor.detach().to(where, non_blocking=True)
            _put(owner, kind, name, tensor, value)


def _as_device(target):
    import torch
    parsed = torch.device(target)
    if parsed.type == 'cuda' and parsed.index is None:
        return torch.device('cuda', torch.cuda.current_device())
    return parsed


def out_of_memory(exc, label='a model'):
    """
    Did this pass run the card out of memory? If so, make room and say so.

    The pass is then run again on the CPU by the caller. The first time it
    happens with the models kept on the card, they are kept in RAM between
    passes from then on: whatever is on the card next time is only what the
    pass in hand needs.
    """
    global _OFFLOAD
    torch = sys.modules.get('torch')
    kind = getattr(getattr(torch, 'cuda', None), 'OutOfMemoryError', None) if torch else None
    if not ((kind and isinstance(exc, kind)) or 'out of memory' in str(exc).lower()):
        return False
    release_memory()
    if on_gpu() and not _OFFLOAD:
        _OFFLOAD = True
        _log(f'{label} ran out of memory on the card: running it on the CPU, and keeping models in RAM '
             'between passes from now on (Analysis → GPU memory)')
    else:
        _log(f'{label} ran out of memory on the card: running it on the CPU')
    return True


def run_pass(label, run, modules=(), first=False):
    """
    One model's pass over one track: `run(device)`, with `modules` on that device.

    On the card when there is one, taking its turn (`inference`). On the CPU
    when the card has faulted (`gpu_fault`) or when the pass ran it out of
    memory — slower, but the track still gets its answer. Anything else the
    pass raises is raised.
    """
    target = device()
    if str(target) == 'cpu':
        return run('cpu')
    if not gpu_fault():
        try:
            with inference(label, first=first, modules=modules):
                return run(target)
        except Exception as exc:
            if not (gpu_fault(exc) or out_of_memory(exc, label)):
                raise
    for module in modules:
        park(module)
    return run('cpu')


def require(package, install_hint):
    """Import a package or raise with something an operator can act on."""
    import importlib
    try:
        return importlib.import_module(package)
    except ImportError as exc:
        missing = getattr(exc, 'name', None)
        if missing and missing != package and not package.startswith(missing + '.'):
            raise RuntimeError(
                f'{package} could not load because its dependency {missing} '
                f'is missing or cannot be imported ({exc}). '
                f'Install the analysis dependencies into {sys.executable}: '
                f'{install_hint}') from exc
        raise RuntimeError(
            f'{package} is required by the analyser but is not installed '
            f'({exc}). Install it with: {install_hint}') from exc


def checkpoint_cache():
    """Where torch.hub keeps downloaded weights."""
    import torch
    return os.path.join(torch.hub.get_dir(), 'checkpoints')


def local_checkpoint(filename):
    """Return a downloaded checkpoint path, or None, without network resolution.
    Shortname lookup can hang on venue networks even when weights are already local.
    """
    path = os.path.join(checkpoint_cache(), filename)
    return path if os.path.isfile(path) else None


def cached(key, build):
    """Build a model once per process and hand back the same instance after."""
    if key in _CACHE:
        return _CACHE[key]
    with _LOCK:
        if key in _CACHE:
            return _CACHE[key]
        _CACHE[key] = build()
        return _CACHE[key]


def unload(key):
    """Evict a cached model and release its GPU weights."""
    with _LOCK:
        model = _CACHE.pop(key, None)
    if model is None:
        return False
    _forget_parked(model)
    _forget_parked(bs_roformer_module(model))
    del model
    release_memory()
    _log(f'unloaded {key}')
    return True


_GPU_FAULT = None


def gpu_fault(exc=None):
    """Record a persistent GPU FFT fault, or return the recorded fault when called bare.
    With an exception, return whether it is a recognized fault. The failing stage
    and later stages use CPU; recycle the worker after replying to restore the GPU.
    """
    global _GPU_FAULT
    if exc is None:
        return _GPU_FAULT
    text = str(exc)
    if not any(mark in text for mark in ('HIPFFT_', 'CUFFT_', 'cuFFT error', 'hipErrorLaunchFailure')):
        return False
    if _GPU_FAULT is None:
        _GPU_FAULT = text
        _log(f'GPU fault ({text}); finishing this track on the CPU, then restarting the worker')
    return True


def on_gpu():
    """Is the pipeline running on CUDA? Asked without importing torch."""
    return str(device()).startswith('cuda')


def release_memory():
    """Release unused allocator blocks between stages/tracks; per-window calls would synchronize the GPU."""
    if not on_gpu():
        return
    try:
        import torch
        gc_collect()
        torch.cuda.empty_cache()
    except Exception as exc:  # pragma: no cover - diagnostics only
        _log(f'could not release device memory: {exc}')


def gc_collect():
    """Drop unreachable tensors before asking the allocator to hand blocks back.

    A tensor caught in a traceback or a reference cycle still owns its memory,
    and `empty_cache()` can only free what nothing points at any more.
    """
    import gc
    gc.collect()


@contextlib.contextmanager
def inference(label='model', first=False, modules=()):
    """Serialize one model's GPU pass and release cached allocations afterwards.
    first=True prioritizes the beat model without interrupting an active pass.
    Move modules to the device for the turn and back to RAM when offloading.
    On CPU this context is a no-op, preserving pipeline parallelism.
    """
    if not on_gpu():
        yield
        return
    _TURNS.acquire(first=first)
    try:
        target = device()
        for module in modules:
            to_card(module, target)
        yield
    finally:
        try:
            if offloading():
                for module in modules:
                    park(module)
            release_memory()
        finally:
            _TURNS.release()


def reserve_first_turn():
    """Reserve the next GPU turn for the beat model; return a cancel token or None on CPU."""
    return _TURNS.reserve() if on_gpu() else None


def cancel_turn(token):
    """Release a reservation that was never taken — the pass failed early."""
    if token is not None:
        _TURNS.cancel(token)



def beat_tracker(on=None):
    """Load Beat This! without the madmom DBN postprocessor.
    on='cpu' uses a separate CPU instance after a GPU fault.
    """
    target = on or device()

    def build():
        require('beat_this', 'pip install -r requirements.txt')
        from beat_this.inference import Audio2Beats
        local = local_checkpoint('beat_this-final0.ckpt')
        if local:
            _log('loading beat_this from cache')
            return Audio2Beats(checkpoint_path=local, device=target, dbn=False)
        _log('downloading beat_this checkpoint (~80 MB, once)…')
        return Audio2Beats(device=target, dbn=False)
    return cached('beat_this' if target == device() else f'beat_this:{target}', build)



def separator(name='htdemucs'):
    """Load Demucs v4 for drums, bass, vocals and other stems."""
    def build():
        require('demucs', 'pip install -r requirements.txt')
        from demucs.pretrained import get_model
        _log(f'loading demucs {name}…')
        model = get_model(name)
        model.eval()
        if offloading():
            park(model)
        return model
    return cached(f'demucs:{name}', build)


def bs_roformer_separator():
    """Load the four-stem BS-RoFormer through audio-separator."""
    def build():
        module = require('audio_separator.separator', 'pip install -r requirements.txt')
        Separator = module.Separator
        model_dir, filename = bs_roformer_checkpoint()
        model = Separator(output_dir=None, output_format='WAV',
                          model_file_dir=model_dir,
                          log_level=40, use_autocast=False)
        try:
            model.load_model(model_filename=filename)
        except ValueError as exc:
            raise RuntimeError(
                f'BS-RoFormer checkpoint is not registered by audio-separator: {filename}. '
                'Set ARTNET_BS_ROFORMER_MODEL to a supported audio-separator model name '
                'or leave ARTNET_USE_BS_ROFORMER disabled.') from exc
        if offloading():
            park(bs_roformer_module(model))
        return model
    return cached('bs-roformer-4stem', build)


def bs_roformer_module(separator_):
    """
    The torch model inside audio-separator's Separator, or None.

    audio-separator keeps it as `model_instance.model_run`. Where a version of
    it does not, the model simply stays where audio-separator put it.
    """
    return getattr(getattr(separator_, 'model_instance', None), 'model_run', None)


def bs_roformer_checkpoint():
    """
    (directory, filename) of the BS-RoFormer checkpoint to load.

    ARTNET_BS_ROFORMER_MODEL is either a model name audio-separator knows,
    looked for in the model directory, or the path to a checkpoint anywhere.
    """
    model_dir = os.environ.get(
        'ARTNET_MODEL_DIR', os.path.expanduser('~/.cache/artnet-lightshow/models'))
    filename = os.environ.get('ARTNET_BS_ROFORMER_MODEL', '').strip()
    if not filename:
        return model_dir, 'BS-Roformer-SW.ckpt'
    if os.path.isfile(filename):
        return os.path.dirname(os.path.abspath(filename)), os.path.basename(filename)
    return model_dir, filename


def bs_roformer_enabled():
    """Read ARTNET_USE_BS_ROFORMER; unset uses the same Demucs default as server settings."""
    return os.environ.get('ARTNET_USE_BS_ROFORMER', '0').lower() not in ('0', 'false', 'no', '')


def warm_up():
    """Load the beat model first, then optional models and only the selected separator.
    Returns the loaded model names; avoids first-track latency and unused GPU weights.
    """
    chosen = bs_roformer_separator if bs_roformer_enabled() else separator
    loaded = []
    for name, load in (('beat_this', beat_tracker), (chosen.__name__, chosen)):
        try:
            load()
            loaded.append(name)
        except Exception as exc:
            _log(f'warm-up of {name} failed: {exc}')
    return loaded

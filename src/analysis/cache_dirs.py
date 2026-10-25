"""Where the analysis keeps models and evaluation corpora.

LIGHTSHOW_MODEL_DIR / LIGHTSHOW_EVAL_DIR win; the ARTNET_* names from before the
rename still count. Without either, ~/.cache/tycstation-lightshow, or the old
~/.cache/artnet-lightshow while only that one exists."""
from __future__ import annotations

import os
from pathlib import Path

NEW_CACHE = Path.home() / ".cache" / "tycstation-lightshow"
OLD_CACHE = Path.home() / ".cache" / "artnet-lightshow"


def cache_root() -> Path:
    return OLD_CACHE if OLD_CACHE.is_dir() and not NEW_CACHE.is_dir() else NEW_CACHE


def _from_env(*names: str) -> Path | None:
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return Path(value)
    return None


def model_dir() -> Path:
    return _from_env("LIGHTSHOW_MODEL_DIR", "ARTNET_MODEL_DIR") or cache_root() / "models"


def eval_dir() -> Path:
    return _from_env("LIGHTSHOW_EVAL_DIR", "ARTNET_EVAL_DIR") or cache_root() / "eval"

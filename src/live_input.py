#!/usr/bin/env python3
"""Launcher for the live input service."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from analysis.live import main  # noqa: E402

if __name__ == '__main__':
    sys.exit(main())

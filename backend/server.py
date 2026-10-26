"""Entrypoint for the local simulation backend.

The implementation lives in the project-root ``server.py`` so it can also be
started with ``python3 server.py``.  This wrapper keeps the documented
``python3 backend/server.py`` command working without third-party packages.
"""

from __future__ import annotations

import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server import main  # noqa: E402


if __name__ == "__main__":
    main()

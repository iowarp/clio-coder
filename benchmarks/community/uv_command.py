"""Helpers for running benchmark Python commands through uv.

Benchmark grader subprocesses should not bake in a developer's current
interpreter path. These helpers produce portable `uv run --no-project ...`
commands and honor UV_BIN for operators that pin a uv executable.
"""

from __future__ import annotations

import os
from collections.abc import Iterable


def _env_packages() -> list[str]:
    raw = os.environ.get("CLIO_CODER_BENCH_UV_WITH", "")
    return [item.strip() for item in raw.split(",") if item.strip()]


def uv_python_cmd(packages: Iterable[str] = ()) -> list[str]:
    """Return a `uv run` command prefix that launches Python."""
    cmd = [os.environ.get("UV_BIN", "uv"), "run", "--no-project"]
    for package in [*_env_packages(), *packages]:
        cmd.extend(["--with", package])
    cmd.append("python")
    return cmd


def uv_script_cmd(script: str | os.PathLike[str], packages: Iterable[str] = ()) -> list[str]:
    """Return a `uv run` command prefix that launches a benchmark script."""
    return [*uv_python_cmd(packages), str(script)]

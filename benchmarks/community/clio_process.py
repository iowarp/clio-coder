"""One bounded process-group runner for community adapters."""

from __future__ import annotations

import os
import signal
import subprocess
from pathlib import Path
from typing import Mapping, Sequence


def run_json_command(
    cmd: Sequence[str],
    *,
    cwd: Path,
    events_path: Path,
    timeout: int,
    env: Mapping[str, str] | None = None,
    terminate_grace: float = 5.0,
) -> tuple[int, bool, str]:
    """Run one Clio command and terminate its whole POSIX group on timeout."""
    events_path.parent.mkdir(parents=True, exist_ok=True)
    child_env = dict(os.environ if env is None else env)
    with events_path.open("w", encoding="utf-8") as stdout:
        proc = subprocess.Popen(
            list(cmd),
            cwd=cwd,
            env=child_env,
            stdout=stdout,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=os.name == "posix",
        )
        try:
            _, stderr = proc.communicate(timeout=timeout)
            return proc.returncode, False, stderr or ""
        except subprocess.TimeoutExpired:
            _signal_process(proc, signal.SIGTERM)
            try:
                _, stderr = proc.communicate(timeout=terminate_grace)
            except subprocess.TimeoutExpired:
                _signal_process(proc, signal.SIGKILL)
                _, stderr = proc.communicate()
            return 124, True, stderr or ""


def _signal_process(proc: subprocess.Popen[str], sig: signal.Signals) -> None:
    if proc.poll() is not None:
        return
    try:
        if os.name == "posix":
            os.killpg(proc.pid, sig)
        else:
            proc.send_signal(sig)
    except ProcessLookupError:
        pass

"""Terminal-Bench installed agent for the current Clio Coder candidate.

The Terminal-Bench runner owns episode scheduling, logs, and scoring. This
module only installs Clio in the task container, renders the explicitly supplied
target, and returns one blocking `clio-coder run` command. Campaign aggregation
reads Terminal-Bench's final output; the agent writes no competing side result.
"""
import os
import shlex
from pathlib import Path

from terminal_bench.agents.installed_agents.abstract_installed_agent import (
    AbstractInstalledAgent,
)
from terminal_bench.terminal.models import TerminalCommand

def _required(kwargs: dict, kwarg: str, environment: str) -> str:
    value = kwargs.get(kwarg) or os.environ.get(environment)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{kwarg} or {environment} is required")
    return value.strip()


class ClioCoder(AbstractInstalledAgent):
    @staticmethod
    def name() -> str:
        return "clio-coder"

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._main_target = _required(kwargs, "main_target", "CLIO_CODER_MAIN_TARGET")
        self._main_model = _required(kwargs, "main_model", "CLIO_CODER_MAIN_MODEL")
        self._main_runtime = _required(kwargs, "main_runtime", "CLIO_CODER_MAIN_RUNTIME")
        self._main_thinking = _required(kwargs, "main_thinking", "CLIO_CODER_MAIN_THINKING")
        self._timeout_sec = int(kwargs.get("timeout_sec", os.environ.get("CLIO_CODER_TASK_TIMEOUT", "1800")))

    @property
    def _env(self) -> dict[str, str]:
        # Written into the container; install-clio.sh renders settings.yaml from these.
        return {
            "CLIO_CODER_AUTONOMY": os.environ.get("CLIO_CODER_AUTONOMY", "full-auto"),
            "CLIO_CODER_MAIN_URL": _required({}, "main_url", "CLIO_CODER_MAIN_URL"),
            "CLIO_CODER_MAIN_TARGET": self._main_target,
            "CLIO_CODER_MAIN_MODEL": self._main_model,
            "CLIO_CODER_MAIN_RUNTIME": self._main_runtime,
            "CLIO_CODER_MAIN_THINKING": self._main_thinking,
            "CLIO_CODER_TARBALL_URL": _required({}, "tarball_url", "CLIO_CODER_TARBALL_URL"),
            # Local llama.cpp / LM Studio ignore the key value, but Clio requires one to be
            # resolvable. A fresh in-container install has no stored credential, so provide a
            # dummy via env vars that the rendered settings.yaml references with apiKeyEnvVar.
            "CLIO_CODER_LLAMACPP_KEY": os.environ.get("CLIO_CODER_LLAMACPP_KEY", "clio-local-target"),
            "CLIO_CODER_LMSTUDIO_KEY": os.environ.get("CLIO_CODER_LMSTUDIO_KEY", "clio-local-target"),
        }

    @property
    def _install_agent_script_path(self) -> Path:
        return Path(__file__).parent / "install-clio.sh"

    def _run_agent_commands(self, instruction: str) -> list[TerminalCommand]:
        # One headless full-auto episode. Clio's own bash/edit tools act on the container
        # filesystem; the model lives on the remote fleet.
        cmd = (
            f"clio-coder run --target {shlex.quote(self._main_target)} "
            f"--model {shlex.quote(self._main_model)} {shlex.quote(instruction)}"
        )
        return [
            TerminalCommand(
                command=cmd,
                max_timeout_sec=float(self._timeout_sec),
                block=True,
            )
        ]

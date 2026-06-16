"""Terminal-Bench 2.0 agent that wraps Clio Coder.

Installs Clio into the task container and runs `clio run` headless (full-auto) against
the operator's local fleet: the `mini` llama.cpp orchestrator and the `dynamo` LM Studio
workers. Built on terminal_bench's AbstractInstalledAgent, the same base the bundled
claude_code / codex / aider agents use.

Run it:
  tb run -d terminal-bench@2.0 -k 1 \
     --agent-import-path "tb_clio_agent.clio_agent:ClioAgent"

Live-smoke prerequisites (verify before a real run):
  1. The task container can reach the fleet host IPs (CLIO_MAIN_URL / CLIO_WORKER_URL).
     Terminal-Bench's default bridge network routes LAN IPs through the host in most
     setups; confirm with a curl from inside one task container first.
  2. Clio is installable in-container. Clio is not published to npm, so the install
     script fetches a tarball from CLIO_TARBALL_URL (the output of `npm pack`, served on
     a URL the container can reach). Without that URL the install step fails fast with a
     clear message instead of silently producing empty runs.

Tunables via `--agent-kwarg key=value` or env:
  main_target (CLIO_MAIN_TARGET), main_model (CLIO_MAIN_MODEL),
  worker_model (CLIO_WORKER_MODEL), timeout_sec (CLIO_TASK_TIMEOUT),
  CLIO_MAIN_URL, CLIO_WORKER_URL, CLIO_TARBALL_URL.
"""
import os
import shlex
from pathlib import Path

from terminal_bench.agents.installed_agents.abstract_installed_agent import (
    AbstractInstalledAgent,
)
from terminal_bench.terminal.models import TerminalCommand


class ClioAgent(AbstractInstalledAgent):
    @staticmethod
    def name() -> str:
        return "clio-coder"

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._main_target = kwargs.get("main_target", os.environ.get("CLIO_MAIN_TARGET", "mini"))
        self._main_model = kwargs.get(
            "main_model",
            os.environ.get("CLIO_MAIN_MODEL", "Qwopus3.6-27B-Coder-MTP-Q5_K_M-262K"),
        )
        self._worker_model = kwargs.get(
            "worker_model", os.environ.get("CLIO_WORKER_MODEL", "qwopus3.6-27b-v1-preview")
        )
        self._timeout_sec = int(kwargs.get("timeout_sec", os.environ.get("CLIO_TASK_TIMEOUT", "1800")))

    @property
    def _env(self) -> dict[str, str]:
        # Written into the container; install-clio.sh renders settings.yaml from these.
        return {
            "CLIO_NO_UPDATE_NOTIFIER": "1",
            "CLIO_AUTONOMY": os.environ.get("CLIO_AUTONOMY", "full-auto"),
            "CLIO_MAIN_URL": os.environ.get("CLIO_MAIN_URL", "http://192.168.86.141:8080"),
            "CLIO_MAIN_MODEL": self._main_model,
            "CLIO_WORKER_URL": os.environ.get("CLIO_WORKER_URL", "http://192.168.86.143:1234"),
            "CLIO_WORKER_MODEL": self._worker_model,
            "CLIO_TARBALL_URL": os.environ.get("CLIO_TARBALL_URL", ""),
            # Local llama.cpp / LM Studio ignore the key value, but Clio requires one to be
            # resolvable. A fresh in-container install has no stored credential, so provide a
            # dummy via env vars that the rendered settings.yaml references with apiKeyEnvVar.
            "CLIO_LLAMACPP_KEY": os.environ.get("CLIO_LLAMACPP_KEY", "clio-local-target"),
            "CLIO_LMSTUDIO_KEY": os.environ.get("CLIO_LMSTUDIO_KEY", "clio-local-target"),
        }

    @property
    def _install_agent_script_path(self) -> Path:
        return Path(__file__).parent / "install-clio.sh"

    def _run_agent_commands(self, instruction: str) -> list[TerminalCommand]:
        # One headless full-auto episode. Clio's own bash/edit tools act on the container
        # filesystem; the model lives on the remote fleet.
        cmd = (
            f"clio run --target {shlex.quote(self._main_target)} "
            f"--model {shlex.quote(self._main_model)} {shlex.quote(instruction)}"
        )
        return [
            TerminalCommand(
                command=cmd,
                max_timeout_sec=float(self._timeout_sec),
                block=True,
            )
        ]

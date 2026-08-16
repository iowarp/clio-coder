"""Terminal-Bench 2.0 agent that wraps Clio Coder.

Installs Clio into the task container and runs `clio-coder run` headless against the
operator's configured fleet. Built on terminal_bench's AbstractInstalledAgent,
the same base the bundled claude_code, codex, and aider agents use.

Run it (dataset selection is `name==version`, and `-k` is an agent kwarg, not
a task count, so the task count is `--n-tasks`):
  tb run -d terminal-bench-core==0.1.1 --n-concurrent 1 --n-tasks 1 \
     --agent-import-path "tb_clio_coder.clio_coder:ClioCoder"

Live-smoke prerequisites:
  1. The task container can reach CLIO_CODER_MAIN_URL and CLIO_CODER_WORKER_URL.
  2. Clio is installable in-container. The install script prefers a tarball from
     CLIO_CODER_TARBALL_URL (the output of `npm pack`, served on a URL the container can
     reach) so a run measures the working tree rather than the last published release,
     and falls back to `npm i -g @iowarp/clio-coder` from the registry.

Tunables via `--agent-kwarg key=value` or env:
  main_target (CLIO_CODER_MAIN_TARGET), main_model (CLIO_CODER_MAIN_MODEL),
  main_runtime (CLIO_CODER_MAIN_RUNTIME), main_thinking (CLIO_CODER_MAIN_THINKING),
  worker_target (CLIO_CODER_WORKER_TARGET), worker_model (CLIO_CODER_WORKER_MODEL),
  worker_runtime (CLIO_CODER_WORKER_RUNTIME), worker_thinking (CLIO_CODER_WORKER_THINKING),
  timeout_sec (CLIO_CODER_TASK_TIMEOUT),
  CLIO_CODER_MAIN_URL, CLIO_CODER_WORKER_URL, CLIO_CODER_TARBALL_URL.

The runtime of each node travels with it. A fleet whose orchestrator is LM
Studio and whose workers are llama.cpp is the reverse of the other common
layout, and a hardcoded runtime would describe the operator's endpoint as
something it is not.

Token accounting: this agent deliberately uses none of `clio_usage.py`, and
that is not an oversight. The HumanEval, SciCode, and SWE-bench adapters run
`clio-coder run --json` as their own child, keep the event stream in a file, and
republish the usage they folded on their own stdout so a parent `clio-coder eval`
observes it. This agent does neither half. `_run_agent_commands` returns a
`TerminalCommand` that the terminal-bench harness executes inside the task
container: the harness owns the process and its terminal, this agent never
sees stdout, `--json` is not passed, and no event stream is written anywhere
this process can read. There is no observed usage to fold, and no parent
`clio-coder eval` reads this module's stdout. Terminal-bench's own runner produces
the episode's scoring.

Making usage measurable here means changing what terminal-bench executes and
where it deposits the stream, which is a separate, larger change to the
harness integration rather than an accounting fix. Publishing an invented or
zero count instead would be worse than the absence: an unobserved run was not
a free one.
"""
import os
import shlex
import sys
from pathlib import Path

from terminal_bench.agents.installed_agents.abstract_installed_agent import (
    AbstractInstalledAgent,
)
from terminal_bench.terminal.models import TerminalCommand

# Shared fleet defaults (benchmarks/community/clio_fleet.py). Guarded so the
# agent still loads if the private config is missing.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from result_manifest import target_profile, write_result_manifest

try:
    from clio_fleet import load_fleet

    _F = load_fleet()
    _DEF = {
        "main_target": _F["orchestrator"]["target"],
        "main_model": _F["orchestrator"]["model"],
        "main_runtime": _F["orchestrator"].get("runtime", "llamacpp"),
        "main_thinking": _F["orchestrator"].get("thinking", "off"),
        "worker_target": _F["workers"]["target"],
        "worker_model": _F["workers"]["model"],
        "worker_runtime": _F["workers"].get("runtime", "lmstudio-native"),
        "worker_thinking": _F["workers"].get("thinking", "off"),
        "autonomy": _F.get("autonomy", "full-auto"),
    }
except Exception:
    _DEF = {
        "main_target": "local-main",
        "main_model": "Qwopus3.6-27B-Coder-MTP-Q5_K_M-262K",
        "main_runtime": "llamacpp",
        "main_thinking": "off",
        "worker_target": "local-worker",
        "worker_model": "qwopus3.6-27b-v1-preview",
        "worker_runtime": "lmstudio-native",
        "worker_thinking": "off",
        "autonomy": "full-auto",
    }


class ClioCoder(AbstractInstalledAgent):
    @staticmethod
    def name() -> str:
        return "clio-coder"

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._main_target = kwargs.get("main_target", os.environ.get("CLIO_CODER_MAIN_TARGET", _DEF["main_target"]))
        self._main_model = kwargs.get(
            "main_model",
            os.environ.get("CLIO_CODER_MAIN_MODEL", _DEF["main_model"]),
        )
        self._worker_target = kwargs.get(
            "worker_target",
            os.environ.get("CLIO_CODER_WORKER_TARGET", _DEF["worker_target"]),
        )
        self._worker_model = kwargs.get(
            "worker_model", os.environ.get("CLIO_CODER_WORKER_MODEL", _DEF["worker_model"])
        )
        self._main_runtime = kwargs.get(
            "main_runtime", os.environ.get("CLIO_CODER_MAIN_RUNTIME", _DEF["main_runtime"])
        )
        self._worker_runtime = kwargs.get(
            "worker_runtime", os.environ.get("CLIO_CODER_WORKER_RUNTIME", _DEF["worker_runtime"])
        )
        self._main_thinking = kwargs.get(
            "main_thinking", os.environ.get("CLIO_CODER_MAIN_THINKING", _DEF["main_thinking"])
        )
        self._worker_thinking = kwargs.get(
            "worker_thinking", os.environ.get("CLIO_CODER_WORKER_THINKING", _DEF["worker_thinking"])
        )
        self._timeout_sec = int(kwargs.get("timeout_sec", os.environ.get("CLIO_CODER_TASK_TIMEOUT", "1800")))
        self._result_dir = Path(
            os.environ.get(
                "CLIO_CODER_TB_RESULT_DIR",
                str(Path(__file__).resolve().parents[1] / "runs" / "latest"),
            )
        )
        # One agent instance serves every episode in a tb run. A manifest keyed
        # only by the result dir would leave the last episode's record standing
        # for all of them, so each episode writes under the trial directory the
        # harness gave it.
        self._episode: str | None = None

    @property
    def _env(self) -> dict[str, str]:
        # Written into the container; install-clio.sh renders settings.yaml from these.
        return {
            "CLIO_CODER_AUTONOMY": os.environ.get("CLIO_CODER_AUTONOMY", "full-auto"),
            "CLIO_CODER_MAIN_URL": os.environ.get("CLIO_CODER_MAIN_URL", ""),
            "CLIO_CODER_MAIN_TARGET": self._main_target,
            "CLIO_CODER_MAIN_MODEL": self._main_model,
            "CLIO_CODER_MAIN_RUNTIME": self._main_runtime,
            "CLIO_CODER_MAIN_THINKING": self._main_thinking,
            "CLIO_CODER_WORKER_URL": os.environ.get("CLIO_CODER_WORKER_URL", ""),
            "CLIO_CODER_WORKER_TARGET": self._worker_target,
            "CLIO_CODER_WORKER_MODEL": self._worker_model,
            "CLIO_CODER_WORKER_RUNTIME": self._worker_runtime,
            "CLIO_CODER_WORKER_THINKING": self._worker_thinking,
            "CLIO_CODER_TARBALL_URL": os.environ.get("CLIO_CODER_TARBALL_URL", ""),
            # Local llama.cpp / LM Studio ignore the key value, but Clio requires one to be
            # resolvable. A fresh in-container install has no stored credential, so provide a
            # dummy via env vars that the rendered settings.yaml references with apiKeyEnvVar.
            "CLIO_CODER_LLAMACPP_KEY": os.environ.get("CLIO_CODER_LLAMACPP_KEY", "clio-local-target"),
            "CLIO_CODER_LMSTUDIO_KEY": os.environ.get("CLIO_CODER_LMSTUDIO_KEY", "clio-local-target"),
        }

    @property
    def _install_agent_script_path(self) -> Path:
        return Path(__file__).parent / "install-clio.sh"

    def perform_task(self, instruction, session, logging_dir=None):
        # The harness names the episode through its per-trial logging dir; it is
        # the only episode identity this agent is handed.
        self._episode = logging_dir.name if logging_dir is not None else None
        return super().perform_task(instruction, session, logging_dir)

    def _run_agent_commands(self, instruction: str) -> list[TerminalCommand]:
        # One headless full-auto episode. Clio's own bash/edit tools act on the container
        # filesystem; the model lives on the remote fleet.
        self._write_scheduled_manifest(instruction)
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

    def _write_scheduled_manifest(self, instruction: str) -> None:
        dataset = os.environ.get("CLIO_CODER_TB_DATASET", "terminal-bench")
        dataset_split = os.environ.get("CLIO_CODER_TB_DATASET_SPLIT", "unspecified")
        summary = {
            "suite": "terminal-bench",
            "dataset": dataset,
            "datasetSplit": dataset_split,
            "instances": 1,
            "resolved": 0,
            "errors": 0,
            "status": "scheduled",
            "episode": self._episode,
            "instructionBytes": len(instruction.encode("utf-8")),
            "timeoutSeconds": self._timeout_sec,
        }
        write_result_manifest(
            self._result_dir / self._episode if self._episode else self._result_dir,
            suite="terminal-bench",
            dataset=dataset,
            dataset_split=dataset_split,
            model=self._main_model,
            profile=target_profile(
                target=self._main_target,
                model=self._main_model,
                runtime=self._main_runtime,
                thinking=self._main_thinking,
                workerTarget=self._worker_target,
                workerModel=self._worker_model,
                workerRuntime=self._worker_runtime,
            ),
            instances=1,
            resolved=0,
            errors=0,
            artifact_paths=[],
            summary=summary,
            notes=[
                "Terminal-Bench final scoring is produced by the tb runner. This manifest records the scheduled Clio episode.",
                "Join it to the tb run's own results.json through the episode field, which is the harness trial directory name.",
            ],
        )

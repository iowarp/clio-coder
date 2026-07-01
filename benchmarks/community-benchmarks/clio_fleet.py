#!/usr/bin/env python3
"""Single source of truth for the model fleets the benchmark + battletest
harnesses drive.

`load_fleet()` reads fleet.json (next to this file), selects a named profile
(`local-single`, `local-split`, `cloud-claude`, `cloud-openai`), and applies the
per-node CLIO_* environment overrides, so a run can retarget without editing the
file. It returns a flat dict with `orchestrator` and `workers` nodes plus
`profile`, `autonomy`, and `predictionModelName`, which is the shape every
adapter (swebench_clio.py, tb_clio_agent/clio_agent.py, the battletest) consumes.

Profile selection order: the `profile` argument, then $CLIO_FLEET_PROFILE, then
the `default` in fleet.json. Running this module prints the resolved fleet and is
what `npm run bench:tb` uses as a preflight.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

FLEET_JSON = Path(__file__).resolve().parent / "fleet.json"

# Per-node fields and the CLIO_* env var that overrides each, matching the vars
# the terminal-bench agent and install-clio.sh already use.
_ORCH_ENV = {"url": "CLIO_MAIN_URL", "model": "CLIO_MAIN_MODEL", "target": "CLIO_MAIN_TARGET", "thinking": "CLIO_MAIN_THINKING"}
_WORK_ENV = {"url": "CLIO_WORKER_URL", "model": "CLIO_WORKER_MODEL", "target": "CLIO_WORKER_TARGET", "thinking": "CLIO_WORKER_THINKING"}


def _apply_env(node: dict[str, Any], env_map: dict[str, str]) -> dict[str, Any]:
    resolved = {key: value for key, value in node.items() if key != "description"}
    for field, env_var in env_map.items():
        override = os.environ.get(env_var)
        if override:
            resolved[field] = override
    return resolved


def _read(path: str | os.PathLike[str] | None) -> dict[str, Any]:
    return json.loads(Path(path or FLEET_JSON).read_text(encoding="utf-8"))


def list_profiles(path: str | os.PathLike[str] | None = None) -> list[str]:
    return sorted(_read(path).get("profiles", {}).keys())


def load_fleet(path: str | os.PathLike[str] | None = None, profile: str | None = None) -> dict[str, Any]:
    """Load one fleet profile with environment overrides applied."""
    data = _read(path)
    profiles = data.get("profiles", {})
    name = profile or os.environ.get("CLIO_FLEET_PROFILE") or data.get("default")
    if name not in profiles:
        raise KeyError(f"unknown fleet profile {name!r}; available: {sorted(profiles)}")
    prof = profiles[name]
    return {
        "profile": name,
        "orchestrator": _apply_env(prof["orchestrator"], _ORCH_ENV),
        "workers": _apply_env(prof["workers"], _WORK_ENV),
        "autonomy": os.environ.get("CLIO_AUTONOMY", data.get("autonomy", "full-auto")),
        "predictionModelName": os.environ.get("CLIO_PRED_MODEL", data.get("predictionModelName", "clio-coder")),
    }


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    profile = argv[0] if argv else None
    fleet = load_fleet(profile=profile)
    print(json.dumps(fleet, indent=2, sort_keys=True))
    orch, work = fleet["orchestrator"], fleet["workers"]
    print(f"\n# profile: {fleet['profile']} (available: {', '.join(list_profiles())})", file=sys.stderr)
    print(f"#   orchestrator {orch.get('target')} ({orch.get('runtime')}) {orch.get('url', 'oauth')} model={orch.get('model')}", file=sys.stderr)
    print(f"#   workers      {work.get('target')} ({work.get('runtime')}) {work.get('url', 'oauth')} model={work.get('model')}", file=sys.stderr)
    print(
        "# Terminal-Bench (needs the `tb` CLI + Docker):\n"
        "#   tb run -d terminal-bench-core==0.1.1 --n-concurrent 1 "
        '--agent-import-path "tb_clio_agent.clio_agent:ClioAgent" --output-path runs/smoke',
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

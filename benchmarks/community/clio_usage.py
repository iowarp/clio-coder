"""Observed token accounting for the Clio benchmark adapters.

An adapter runs `clio --no-context-files run --json` as its own child and keeps
the event stream in a file, so a parent `clio eval` sees only the adapter's
stdout and observes no usage at all. These helpers fold the usage the adapter
did observe and re-publish it on the adapter's stdout in the one shape the eval
runner's fold understands, so the eval's accounting is measured rather than
unmeasured.

The fold matches `src/domains/eval/metrics/token-stream.ts` exactly: usage is
counted from `message_end` only, because that is the one event carrying a
completed assistant message's tokens exactly once. `turn_end` republishes the
same message and `agent_end` republishes its segment's summary, so counting
those would multiply a run's reported cost. Every message counts, because a
headless turn spans several agent segments and the run's cost is their sum.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, TextIO

COUNT_FIELDS = ("input", "output", "cacheRead", "cacheWrite")


def empty_usage() -> dict[str, int]:
    return {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0}


def _number(record: Any, field: str) -> int:
    value = record.get(field) if isinstance(record, dict) else None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    return int(value)


def add_usage(left: dict[str, int], right: dict[str, int]) -> dict[str, int]:
    return {key: int(left.get(key, 0)) + int(right.get(key, 0)) for key in (*COUNT_FIELDS, "totalTokens")}


def fold_message_end_usage(events_path: Path | str) -> dict[str, int] | None:
    """Sum a run's observed usage, or None when the stream reported none.

    None is not zero. A run that reported no usage was not free; it was
    unobserved, and the caller must say so rather than publish a zero.
    """
    path = Path(events_path)
    if not path.exists():
        return None
    total = empty_usage()
    measured = False
    with path.open("r", encoding="utf-8", errors="replace") as stream:
        for line in stream:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(event, dict) or event.get("type") != "message_end":
                continue
            message = event.get("message")
            if not isinstance(message, dict) or message.get("role") != "assistant":
                continue
            usage = message.get("usage")
            if not isinstance(usage, dict):
                continue
            measured = True
            counts = {field: _number(usage, field) for field in COUNT_FIELDS}
            reported_total = _number(usage, "totalTokens")
            counts["totalTokens"] = reported_total if reported_total > 0 else sum(counts.values())
            total = add_usage(total, counts)
    return total if measured else None


def run_id_from_events(events_path: Path | str) -> str | None:
    """The run id the stream reported, or None when it reported none.

    Receipt lookup keys on this id, so guessing one would read another run's
    receipt. Absence stays absence.
    """
    path = Path(events_path)
    if not path.exists():
        return None
    with path.open("r", encoding="utf-8", errors="replace") as stream:
        for line in stream:
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(event, dict):
                continue
            session = event.get("session")
            run_id = (session or {}).get("runId") if isinstance(session, dict) else None
            if not run_id:
                run_id = event.get("runId")
            if isinstance(run_id, str) and run_id:
                return run_id
    return None


def emit_observed_usage(usage: dict[str, int] | None, stream: TextIO | None = None) -> None:
    """Republish observed usage on adapter stdout for a parent eval's fold.

    Nothing is written when nothing was observed, so an absent count stays
    absent instead of becoming a zero the parent would sum as real.
    """
    if usage is None:
        return
    out = sys.stdout if stream is None else stream
    payload = {
        "type": "message_end",
        "message": {
            "role": "assistant",
            "content": [],
            "usage": {
                "input": int(usage.get("input", 0)),
                "output": int(usage.get("output", 0)),
                "cacheRead": int(usage.get("cacheRead", 0)),
                "cacheWrite": int(usage.get("cacheWrite", 0)),
                "totalTokens": int(usage.get("totalTokens", 0)),
            },
        },
    }
    out.write(json.dumps(payload) + "\n")
    out.flush()


def clio_state_dir() -> Path:
    """Resolve Clio's state directory the way Clio itself resolves it.

    An adapter that hardcodes ~/.local/state reads a different Clio's receipts
    than the one it just ran whenever the run is isolated by CLIO_HOME.
    """
    explicit = os.environ.get("CLIO_STATE_DIR", "").strip()
    if explicit:
        return Path(explicit)
    home = os.environ.get("CLIO_HOME", "").strip()
    if home:
        return Path(home) / "state"
    xdg = os.environ.get("XDG_STATE_HOME", "").strip()
    base = Path(xdg) if xdg else Path.home() / ".local" / "state"
    return base / "clio"


def receipt_total_tokens(run_id: str | None) -> int | None:
    """Total tokens from a sealed receipt, or None when there is no receipt."""
    if not run_id:
        return None
    path = clio_state_dir() / "receipts" / f"{run_id}.json"
    if not path.exists():
        return None
    try:
        receipt = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    for key_path in (("tokenCount",), ("usage", "totalTokens"), ("tokens",), ("usage", "total")):
        cursor: Any = receipt
        for key in key_path:
            cursor = cursor.get(key) if isinstance(cursor, dict) else None
        if isinstance(cursor, (int, float)) and not isinstance(cursor, bool) and cursor:
            return int(cursor)
    return None

#!/usr/bin/env python3
"""SciCode adapter for Clio Coder.

The adapter has three jobs:
  1. Inspect the local SciCode prompt corpus and report whether scoring data is present.
  2. Generate a normal `clio eval` task file whose setup command runs Clio on a
     SciCode problem and whose verifier command grades the generated code.
  3. Grade a generated problem by executing each sub-step against official-style
     target values.

Faithful SciCode scoring needs the external numeric target artifact. Upstream
SciCode loads it through `process_hdf5_to_tuple(step_id, n, test_data.h5)`.
This script supports that path when the SciCode package plus h5py/scipy/numpy
are installed, and also supports a small JSON target manifest for smoke tests.
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import textwrap
import time
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_DATA = REPO_ROOT / "benchmarks" / "data" / "science-problems" / "problems_all.jsonl"
DEFAULT_TEMPLATE = REPO_ROOT / "benchmarks" / "data" / "science-problems" / "background_comment_template.txt"
CLIO = os.environ.get("CLIO_BIN", "clio")

SPECIAL_STEP_SNIPPETS = {
    "13.6": DEFAULT_DATA.parent / "13.6.txt",
    "62.1": DEFAULT_DATA.parent / "62.1.txt",
    "76.3": DEFAULT_DATA.parent / "76.3.txt",
}

PYTHON_BLOCK_RE = re.compile(r"```(?:python)?\s*\n(.*?)```", re.DOTALL | re.IGNORECASE)


class DataBlocked(RuntimeError):
    """Raised when the adapter is wired but official scoring data is absent."""


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, 1):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                rows.append(json.loads(stripped))
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path}:{line_no}: invalid JSONL: {exc}") from exc
    return rows


def problem_by_id(rows: list[dict[str, Any]], problem_id: str) -> dict[str, Any]:
    for row in rows:
        if str(row.get("problem_id")) == str(problem_id):
            return row
    raise KeyError(f"problem id not found: {problem_id}")


def selected_problems(rows: list[dict[str, Any]], ids: list[str], limit: int) -> list[dict[str, Any]]:
    if ids:
        selected = [problem_by_id(rows, problem_id) for problem_id in ids]
    else:
        selected = rows
    return selected[:limit] if limit > 0 else selected


def step_number(step: dict[str, Any]) -> str:
    return str(step.get("step_number", "")).strip()


def step_index(problem: dict[str, Any], step_id: str) -> int:
    for index, step in enumerate(problem.get("sub_steps", [])):
        if step_number(step) == step_id:
            return index
    raise KeyError(f"step id not found in problem {problem.get('problem_id')}: {step_id}")


def load_template(path: Path | None) -> str:
    source = path or DEFAULT_TEMPLATE
    if source.exists():
        return source.read_text(encoding="utf-8")
    return textwrap.dedent(
        """\
        PREVIOUS STEPS DESCRIPTION:
        {problem_steps_str}

        NEXT STEP - PROBLEM DESCRIPTION AND FUNCTION HEADER:
        {next_step_str}

        DEPENDENCIES:
        {dependencies}
        """
    )


def extract_symbol_name(function_header: str) -> str | None:
    parsed = ast.parse(function_header)
    for node in ast.walk(parsed):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            return node.name
    match = re.search(r"\b(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]*)\s*[\(:]", function_header)
    return match.group(1) if match else None


def extract_symbol_source(source: str, name: str) -> str | None:
    try:
        parsed = ast.parse(source)
    except SyntaxError:
        return None
    for node in parsed.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name == name:
            return ast.get_source_segment(source, node) or ast.unparse(node)
    return None


def render_previous_steps(problem: dict[str, Any], current_index: int, generated_dir: Path | None = None) -> str:
    chunks: list[str] = []
    for index, step in enumerate(problem.get("sub_steps", [])[:current_index]):
        step_id = step_number(step)
        chunks.append(f"Step {step_id}: {step.get('step_description_prompt', '')}")
        code = None
        if generated_dir is not None:
            code_path = generated_dir / f"{step_id}.py"
            if code_path.exists():
                code_text = code_path.read_text(encoding="utf-8")
                symbol = extract_symbol_name(str(step.get("function_header", "")))
                code = extract_symbol_source(code_text, symbol) if symbol else code_text
        if code is None and step_id in SPECIAL_STEP_SNIPPETS and SPECIAL_STEP_SNIPPETS[step_id].exists():
            code = SPECIAL_STEP_SNIPPETS[step_id].read_text(encoding="utf-8")
        if code:
            chunks.append(code)
        chunks.append("------")
    return "\n\n".join(chunks[:-1]) if chunks else "None."


def render_next_step(step: dict[str, Any], with_background: bool) -> str:
    pieces = [str(step.get("step_description_prompt", "")), str(step.get("function_header", ""))]
    if with_background and step.get("step_background"):
        pieces.insert(1, str(step["step_background"]))
    return "\n\n".join(piece for piece in pieces if piece)


def render_prompt(
    problem: dict[str, Any],
    step: dict[str, Any],
    current_index: int,
    generated_dir: Path | None,
    template: str,
    with_background: bool,
) -> str:
    body = template.format(
        problem_steps_str=render_previous_steps(problem, current_index, generated_dir),
        next_step_str=render_next_step(step, with_background),
        dependencies=problem.get("required_dependencies", ""),
    )
    return textwrap.dedent(
        f"""\
        You are solving SciCode problem {problem.get('problem_id')} ({problem.get('problem_name')}).

        Main problem:
        {problem.get('problem_description_main', '')}

        IO contract:
        {problem.get('problem_io', '')}

        Write or update solution.py in the current directory. Preserve earlier
        step implementations in that file. For this turn, implement only step
        {step_number(step)} and any small helper it needs. Do not write tests.

        {body}
        """
    )


def quote_command(parts: list[str]) -> str:
    return " ".join(shlex.quote(part) for part in parts)


def yaml_block(text: str, indent: int) -> str:
    prefix = " " * indent
    if text == "":
        return f"{prefix}|\n{prefix}\n"
    return f"{prefix}|\n" + "\n".join(f"{prefix}{line}" for line in text.splitlines()) + "\n"


def generate_tasks(args: argparse.Namespace) -> int:
    data = Path(args.data)
    rows = read_jsonl(data)
    problems = selected_problems(rows, args.problem_id, args.limit)
    script = Path(__file__).resolve()
    run_root = Path(args.run_root)
    lines = ["version: 1", "tasks:"]
    for problem in problems:
        problem_id = str(problem["problem_id"])
        task_id = f"scicode-{problem_id}"
        prompt = textwrap.dedent(
            f"""\
            Run SciCode problem {problem_id} through Clio, then grade every sub-step.

            Dataset: {data}
            Problem: {problem.get('problem_name')}
            """
        )
        out_dir = run_root / task_id
        setup = [
            sys.executable,
            str(script),
            "run-problem",
            "--data",
            str(data),
            "--problem-id",
            problem_id,
            "--out",
            str(out_dir),
            "--timeout",
            str(args.timeout),
        ]
        if args.target:
            setup.extend(["--target", args.target])
        if args.model:
            setup.extend(["--model", args.model])
        if args.with_background:
            setup.append("--with-background")
        verifier = [
            sys.executable,
            str(script),
            "grade-problem",
            "--data",
            str(data),
            "--problem-id",
            problem_id,
            "--run",
            str(out_dir),
        ]
        if args.h5py_file:
            verifier.extend(["--h5py-file", str(args.h5py_file)])
        if args.references:
            verifier.extend(["--references", str(args.references)])
        lines.extend(
            [
                f"  - id: {task_id}",
                "    prompt: |",
                *[f"      {line}" for line in prompt.splitlines()],
                "    cwd: .",
                "    setup:",
                f"      - {json.dumps(quote_command(setup))}",
                "    verifier:",
                f"      - {json.dumps(quote_command(verifier))}",
                f"    timeoutMs: {int(args.timeout) * 1000}",
                "    tags:",
                "      - scicode",
                "      - science",
                f"      - problem-{problem_id}",
            ]
        )
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {len(problems)} SciCode eval task(s) to {out}", file=sys.stderr)
    return 0


def inspect_data(args: argparse.Namespace) -> int:
    data = Path(args.data)
    rows = read_jsonl(data)
    sub_steps = [step for row in rows for step in row.get("sub_steps", [])]
    tests = [case for step in sub_steps for case in step.get("test_cases", [])]
    general_tests = [case for row in rows for case in row.get("general_tests", [])]
    target_refs = sum(1 for case in tests + general_tests if "target" in case)
    no_test_steps = [step_number(step) for step in sub_steps if len(step.get("test_cases", [])) == 0]
    h5py_file = Path(args.h5py_file) if args.h5py_file else None
    references = Path(args.references) if args.references else None
    payload = {
        "data": str(data),
        "problems": len(rows),
        "sub_steps": len(sub_steps),
        "step_tests": len(tests),
        "general_tests": len(general_tests),
        "tests_referencing_target": target_refs,
        "no_test_steps": no_test_steps,
        "h5py_file_present": bool(h5py_file and h5py_file.exists()),
        "json_references_present": bool(references and references.exists()),
        "faithful_scoring_ready": bool((h5py_file and h5py_file.exists()) or (references and references.exists())),
    }
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


def run_clio_step(prompt: str, cwd: Path, events_path: Path, timeout: int, target: str | None, model: str | None) -> dict[str, Any]:
    cmd = [CLIO, "--no-context-files", "run", "--json"]
    if target:
        cmd.extend(["--target", target])
    if model:
        cmd.extend(["--model", model])
    cmd.append(prompt)
    env = {**os.environ, "CLIO_NO_UPDATE_NOTIFIER": "1"}
    started = time.time()
    timed_out = False
    stderr = ""
    with events_path.open("w", encoding="utf-8") as stdout:
        try:
            proc = subprocess.run(cmd, cwd=cwd, env=env, stdout=stdout, stderr=subprocess.PIPE, text=True, timeout=timeout)
            code = proc.returncode
            stderr = proc.stderr
        except subprocess.TimeoutExpired as exc:
            code = 124
            timed_out = True
            stderr = str(exc)
    return {
        "exit": code,
        "timed_out": timed_out,
        "wall_s": round(time.time() - started, 3),
        "stderr": stderr[-4000:],
        "events": str(events_path),
    }


def extract_python_from_events(events_path: Path) -> str | None:
    chunks: list[str] = []
    if not events_path.exists():
        return None
    for line in events_path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        collect_strings(payload, chunks)
    matches: list[str] = []
    for chunk in chunks:
        matches.extend(match.group(1) for match in PYTHON_BLOCK_RE.finditer(chunk))
    return matches[-1].strip() + "\n" if matches else None


def collect_strings(value: Any, out: list[str]) -> None:
    if isinstance(value, str):
        out.append(value)
    elif isinstance(value, dict):
        for item in value.values():
            collect_strings(item, out)
    elif isinstance(value, list):
        for item in value:
            collect_strings(item, out)


def snapshot_step_code(problem: dict[str, Any], run_dir: Path, step_id: str) -> None:
    generated_dir = run_dir / "generated_code"
    generated_dir.mkdir(parents=True, exist_ok=True)
    solution = run_dir / "solution.py"
    if not solution.exists():
        return
    content = solution.read_text(encoding="utf-8")
    deps = str(problem.get("required_dependencies", "")).strip()
    prefix = f"{deps}\n\n" if deps and deps not in content else ""
    (generated_dir / f"{step_id}.py").write_text(prefix + content, encoding="utf-8")


def run_problem(args: argparse.Namespace) -> int:
    data = Path(args.data)
    problem = problem_by_id(read_jsonl(data), args.problem_id)
    run_dir = Path(args.out)
    if args.force and run_dir.exists():
        shutil.rmtree(run_dir)
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "events").mkdir(parents=True, exist_ok=True)
    (run_dir / "prompts").mkdir(parents=True, exist_ok=True)
    template = load_template(Path(args.template) if args.template else None)
    metrics_path = run_dir / "metrics.jsonl"
    failures = 0
    with metrics_path.open("w", encoding="utf-8") as metrics:
        for index, step in enumerate(problem.get("sub_steps", [])):
            step_id = step_number(step)
            prompt = render_prompt(problem, step, index, run_dir / "generated_code", template, args.with_background)
            (run_dir / "prompts" / f"{step_id}.md").write_text(prompt, encoding="utf-8")
            if args.dry_run:
                metric = {"step_id": step_id, "dry_run": True, "exit": 0}
            else:
                metric = run_clio_step(
                    prompt=prompt,
                    cwd=run_dir,
                    events_path=run_dir / "events" / f"{step_id}.jsonl",
                    timeout=args.timeout,
                    target=args.target,
                    model=args.model,
                )
                if not (run_dir / "solution.py").exists():
                    extracted = extract_python_from_events(Path(metric["events"]))
                    if extracted:
                        (run_dir / "solution.py").write_text(extracted, encoding="utf-8")
                if metric["exit"] != 0:
                    failures += 1
            snapshot_step_code(problem, run_dir, step_id)
            metrics.write(json.dumps({"problem_id": problem["problem_id"], "step_id": step_id, **metric}) + "\n")
            metrics.flush()
            if failures and not args.continue_on_error:
                break
    (run_dir / "problem.json").write_text(json.dumps(problem, indent=2) + "\n", encoding="utf-8")
    return 0 if failures == 0 else 1


def load_json_references(path: Path | None) -> dict[str, Any] | None:
    if path is None:
        return None
    if not path.exists():
        raise DataBlocked(f"reference target manifest not found: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def targets_from_json_manifest(refs: dict[str, Any], problem_id: str, step_id: str, test_count: int) -> list[str]:
    node: Any = refs
    if "problems" in node:
        node = node["problems"].get(str(problem_id), {})
    if "steps" in node:
        node = node["steps"]
    if "targets" in node:
        node = node["targets"]
    raw_targets = node.get(step_id) if isinstance(node, dict) else None
    if raw_targets is None:
        raise DataBlocked(f"reference targets missing for step {step_id}")
    if len(raw_targets) != test_count:
        raise DataBlocked(f"step {step_id} expected {test_count} target(s), found {len(raw_targets)}")
    return [target_to_python_expr(item) for item in raw_targets]


def target_to_python_expr(item: Any) -> str:
    if isinstance(item, dict):
        for key in ("target_expr", "expr", "python"):
            if isinstance(item.get(key), str):
                return item[key]
        if "target_json" in item:
            return repr(item["target_json"])
        if "value" in item:
            return repr(item["value"])
    return repr(item)


def hdf5_target_header(step_id: str, test_count: int, h5py_file: Path) -> str:
    if not h5py_file.exists():
        raise DataBlocked(f"SciCode HDF5 target file not found: {h5py_file}")
    return textwrap.dedent(
        f"""\
        from scicode.parse.parse import process_hdf5_to_tuple
        targets = process_hdf5_to_tuple({step_id!r}, {test_count}, {str(h5py_file)!r})
        """
    )


def json_target_header(refs: dict[str, Any], problem_id: str, step_id: str, test_count: int) -> str:
    exprs = targets_from_json_manifest(refs, problem_id, step_id, test_count)
    return "targets = [\n" + "".join(f"    {expr},\n" for expr in exprs) + "]\n"


def build_step_assertion_script(
    problem: dict[str, Any],
    step: dict[str, Any],
    code_path: Path,
    h5py_file: Path | None,
    refs: dict[str, Any] | None,
) -> str:
    step_id = step_number(step)
    tests = list(step.get("test_cases", []))
    if not tests:
        raise DataBlocked(f"step {step_id} has no visible test cases")
    if not code_path.exists():
        raise FileNotFoundError(f"generated code missing for step {step_id}: {code_path}")
    if h5py_file is not None:
        target_header = hdf5_target_header(step_id, len(tests), h5py_file)
    elif refs is not None:
        target_header = json_target_header(refs, str(problem["problem_id"]), step_id, len(tests))
    else:
        raise DataBlocked("no SciCode target artifact supplied; pass --h5py-file or --references")
    lines = [code_path.read_text(encoding="utf-8"), "", target_header]
    for index, test in enumerate(tests):
        lines.append(f"target = targets[{index}]")
        lines.append(test)
        lines.append("")
    return "\n".join(lines)


def run_python_script(script: str, cwd: Path, timeout: int) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="clio-scicode-") as tmp:
        path = Path(tmp) / "assert_step.py"
        path.write_text(script, encoding="utf-8")
        started = time.time()
        try:
            proc = subprocess.run(
                [sys.executable, str(path)],
                cwd=cwd,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
            return {
                "exit": proc.returncode,
                "timed_out": False,
                "wall_s": round(time.time() - started, 3),
                "stdout": proc.stdout[-4000:],
                "stderr": proc.stderr[-4000:],
            }
        except subprocess.TimeoutExpired as exc:
            return {
                "exit": 124,
                "timed_out": True,
                "wall_s": round(time.time() - started, 3),
                "stdout": (exc.stdout or "")[-4000:] if isinstance(exc.stdout, str) else "",
                "stderr": str(exc)[-4000:],
            }


def grade_step_result(
    problem: dict[str, Any],
    step: dict[str, Any],
    run_dir: Path,
    h5py_file: Path | None,
    refs: dict[str, Any] | None,
    timeout: int,
) -> dict[str, Any]:
    step_id = step_number(step)
    code_path = run_dir / "generated_code" / f"{step_id}.py"
    try:
        script = build_step_assertion_script(problem, step, code_path, h5py_file, refs)
    except DataBlocked as exc:
        return {"step_id": step_id, "status": "blocked", "pass": False, "reason": str(exc)}
    except FileNotFoundError as exc:
        return {"step_id": step_id, "status": "fail", "pass": False, "reason": str(exc)}
    result = run_python_script(script, run_dir, timeout)
    return {
        "step_id": step_id,
        "status": "pass" if result["exit"] == 0 else "fail",
        "pass": result["exit"] == 0,
        **result,
    }


def grade_problem(args: argparse.Namespace) -> int:
    data = Path(args.data)
    problem = problem_by_id(read_jsonl(data), args.problem_id)
    refs = load_json_references(Path(args.references) if args.references else None)
    h5py_file = Path(args.h5py_file) if args.h5py_file else None
    run_dir = Path(args.run)
    results = [
        grade_step_result(problem, step, run_dir, h5py_file, refs, args.timeout)
        for step in problem.get("sub_steps", [])
    ]
    blocked = [result for result in results if result["status"] == "blocked"]
    passed = [result for result in results if result["pass"]]
    failed = [result for result in results if result["status"] == "fail"]
    main_pass = len(blocked) == 0 and len(failed) == 0 and len(passed) == len(results)
    report = {
        "problem_id": str(problem["problem_id"]),
        "problem_name": problem.get("problem_name"),
        "main_pass": main_pass,
        "steps": len(results),
        "passed_steps": len(passed),
        "failed_steps": len(failed),
        "blocked_steps": len(blocked),
        "results": results,
        "scoring_rule": "main_pass requires every sub-step to pass",
    }
    report_path = Path(args.report) if args.report else run_dir / "scicode-grade.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    if blocked:
        return 2
    return 0 if main_pass else 1


def grade_step(args: argparse.Namespace) -> int:
    problem = problem_by_id(read_jsonl(Path(args.data)), args.problem_id)
    refs = load_json_references(Path(args.references) if args.references else None)
    h5py_file = Path(args.h5py_file) if args.h5py_file else None
    step = problem["sub_steps"][step_index(problem, args.step_number)]
    result = grade_step_result(problem, step, Path(args.run), h5py_file, refs, args.timeout)
    print(json.dumps(result, indent=2))
    if result["status"] == "blocked":
        return 2
    return 0 if result["pass"] else 1


def add_common_data_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--data", default=str(DEFAULT_DATA), help="SciCode problems JSONL")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    inspect = sub.add_parser("inspect-data", help="summarize dataset and scoring readiness")
    add_common_data_args(inspect)
    inspect.add_argument("--h5py-file", default=None, help="official SciCode test_data.h5")
    inspect.add_argument("--references", default=None, help="small JSON target manifest")
    inspect.set_defaults(func=inspect_data)

    tasks = sub.add_parser("generate-tasks", help="write a clio eval YAML task file")
    add_common_data_args(tasks)
    tasks.add_argument("--out", required=True)
    tasks.add_argument("--run-root", default=".clio-scicode")
    tasks.add_argument("--problem-id", action="append", default=[])
    tasks.add_argument("--limit", type=int, default=0)
    tasks.add_argument("--timeout", type=int, default=1800)
    tasks.add_argument("--target", default=None)
    tasks.add_argument("--model", default=None)
    tasks.add_argument("--h5py-file", default=None)
    tasks.add_argument("--references", default=None)
    tasks.add_argument("--with-background", action="store_true")
    tasks.set_defaults(func=generate_tasks)

    run = sub.add_parser("run-problem", help="run Clio through every sub-step in one problem")
    add_common_data_args(run)
    run.add_argument("--problem-id", required=True)
    run.add_argument("--out", required=True)
    run.add_argument("--timeout", type=int, default=1800)
    run.add_argument("--target", default=None)
    run.add_argument("--model", default=None)
    run.add_argument("--template", default=None)
    run.add_argument("--with-background", action="store_true")
    run.add_argument("--continue-on-error", action="store_true")
    run.add_argument("--force", action="store_true", help="replace an existing run directory")
    run.add_argument("--dry-run", action="store_true", help="render prompts without calling Clio")
    run.set_defaults(func=run_problem)

    grade = sub.add_parser("grade-problem", help="grade every sub-step for one generated problem")
    add_common_data_args(grade)
    grade.add_argument("--problem-id", required=True)
    grade.add_argument("--run", required=True)
    grade.add_argument("--h5py-file", default=None)
    grade.add_argument("--references", default=None)
    grade.add_argument("--timeout", type=int, default=1800)
    grade.add_argument("--report", default=None)
    grade.set_defaults(func=grade_problem)

    grade_one = sub.add_parser("grade-step", help="grade one generated sub-step")
    add_common_data_args(grade_one)
    grade_one.add_argument("--problem-id", required=True)
    grade_one.add_argument("--step-number", required=True)
    grade_one.add_argument("--run", required=True)
    grade_one.add_argument("--h5py-file", default=None)
    grade_one.add_argument("--references", default=None)
    grade_one.add_argument("--timeout", type=int, default=1800)
    grade_one.set_defaults(func=grade_step)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except DataBlocked as exc:
        print(f"DATA_BLOCKED: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

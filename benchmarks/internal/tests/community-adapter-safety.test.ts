import { deepStrictEqual, doesNotMatch, match, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const REPO_ROOT = new URL("../../..", import.meta.url).pathname;
const PYTHON = process.env.PYTHON ?? "python3";
const LIVECODEBENCH = join(REPO_ROOT, "benchmarks", "community", "livecodebench", "livecodebench_clio.py");

function pythonJson(source: string, env: NodeJS.ProcessEnv = {}): unknown {
	const result = spawnSync(PYTHON, ["-c", source], {
		cwd: REPO_ROOT,
		encoding: "utf8",
		env: {
			...process.env,
			CLIO_CODER_BENCH_UV_WITH: "",
			DS1000_GRADER_WITH: "",
			BIGCODEBENCH_GRADER_WITH: "",
			SCIENCEAGENTBENCH_GRADER_WITH: "",
			...env,
		},
	});
	strictEqual(result.status, 0, result.stderr);
	return JSON.parse(result.stdout);
}

const LOAD_HELPER = `
import importlib.util
import json
import os
import pathlib
import sys

root = pathlib.Path.cwd()

def load(name, relative):
    path = root / relative
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module
`;

describe("contracts/community adapter safety", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-community-safety-"));
	});

	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	it("decodes only the expected LiveCodeBench JSON-string pickle and refuses GLOBAL/REDUCE", () => {
		const marker = join(scratch, "pickle-payload-executed");
		const outcome = pythonJson(
			`${LOAD_HELPER}
import base64
import os
import pickle
import zlib

lcb = load("lcb_adapter", "benchmarks/community/livecodebench/livecodebench_clio.py")
expected = [{"input": "[1, 2]", "output": "3"}]
valid = base64.b64encode(zlib.compress(pickle.dumps(json.dumps(expected)))).decode("ascii")
decoded = lcb.decode_private_tests(valid)

command = "touch " + os.environ["PICKLE_MARKER"]
malicious_pickle = b"cos\\nsystem\\n(S'" + command.encode("utf-8") + b"'\\ntR."
malicious = base64.b64encode(zlib.compress(malicious_pickle)).decode("ascii")
try:
    lcb.decode_private_tests(malicious)
    refused = False
    refusal = None
except lcb.RefusedPickle as exc:
    refused = True
    refusal = str(exc)

wrong_shape = base64.b64encode(zlib.compress(pickle.dumps(expected))).decode("ascii")
try:
    lcb.decode_private_tests(wrong_shape)
    shape_refused = False
except lcb.RefusedPickle:
    shape_refused = True

print(json.dumps({
    "decoded": decoded,
    "refused": refused,
    "refusal": refusal,
    "shapeRefused": shape_refused,
    "markerExists": pathlib.Path(os.environ["PICKLE_MARKER"]).exists(),
}))
`,
			{ PICKLE_MARKER: marker },
		) as {
			decoded: Array<Record<string, string>>;
			refused: boolean;
			refusal: string;
			shapeRefused: boolean;
			markerExists: boolean;
		};

		deepStrictEqual(outcome.decoded, [{ input: "[1, 2]", output: "3" }]);
		strictEqual(outcome.refused, true);
		match(outcome.refusal, /refusing to resolve (?:posix|os)\.system/);
		strictEqual(outcome.shapeRefused, true);
		strictEqual(outcome.markerExists, false);
		strictEqual(existsSync(marker), false);

		const source = readFileSync(LIVECODEBENCH, "utf8");
		doesNotMatch(source, /\bpickle\.loads\s*\(/u);
		doesNotMatch(source, /\bfrom\s+pickle\s+import\b/u);
	});

	it("builds uv --with arguments only from each grading task's dependencies", () => {
		const outcome = pythonJson(`${LOAD_HELPER}
ds = load("ds_adapter", "benchmarks/community/ds-1000/ds1000_clio.py")
bcb = load("bcb_adapter", "benchmarks/community/bigcodebench/bigcodebench_clio.py")
sab = load("sab_adapter", "benchmarks/community/scienceagentbench/scienceagentbench_clio.py")
uv = load("uv_adapter", "benchmarks/community/uv_command.py")

ds_packages = ds.grader_packages({
    "metadata": {"problem_id": 350, "library": "Numpy"},
    "code_context": "import numpy as np\\nimport scipy.stats\\n",
})
ds_pandas_packages = ds.grader_packages({
    "metadata": {"problem_id": 0, "library": "Pandas"},
    "code_context": "import pandas as pd\\nimport numpy as np\\n",
})
ds_nested_packages = ds.grader_packages({
    "metadata": {"problem_id": 511, "library": "Matplotlib"},
    "code_context": "import matplotlib\\nexec_context = '''import pandas as pd\\nimport seaborn as sns\\ndef task():\\n[insert]\\n'''\\n",
})
bcb_packages = bcb.grader_packages({
    "task_id": "BigCodeBench/287", "libs": ["json", "collections", "os"],
    "code_prompt": "from collections import Counter\\nimport os\\nimport json\\n",
    "test": "import unittest\\nfrom faker import Faker\\n",
})
bcb_pillow_packages = bcb.grader_packages({
    "task_id": "BigCodeBench/424", "libs": ["sklearn", "numpy", "cv2", "os"],
    "code_prompt": "import cv2\\nimport numpy as np\\nfrom sklearn.cluster import KMeans\\n",
    "test": "from PIL import Image, ImageDraw\\n",
})
bcb_crypto_packages = bcb.grader_packages({"task_id": "BigCodeBench/583", "libs": ["Crypto"]})
bcb_legacy_packages = bcb.grader_packages({
    "task_id": "BigCodeBench/legacy", "libs": ["cgi", "keras"],
})
bcb_incomplete_packages = bcb.grader_packages({
    "task_id": "BigCodeBench/incomplete", "libs": [],
    "code_prompt": "import pandas as pd\\ndef task_func(value):\\n",
    "test": "import unittest;import time;import json;print('still incomplete')\\n",
})
sab_packages = sab.grader_packages([
    "import pandas as pd\\nfrom sklearn.metrics import accuracy_score\\n",
    "import json\\n",
])
print(json.dumps({
    "ds": list(ds_packages),
    "dsCommand": uv.uv_python_cmd(ds_packages),
    "dsPandas": list(ds_pandas_packages),
    "dsNested": list(ds_nested_packages),
    "bcb": list(bcb_packages),
    "bcbCommand": uv.uv_python_cmd(bcb_packages),
    "bcbPillow": list(bcb_pillow_packages),
    "bcbCrypto": list(bcb_crypto_packages),
    "bcbLegacy": list(bcb_legacy_packages),
    "bcbIncomplete": list(bcb_incomplete_packages),
    "sab": list(sab_packages),
    "sabCommand": uv.uv_python_cmd(sab_packages),
}))
`) as Record<string, string[]>;

		deepStrictEqual(outcome.ds, ["numpy", "scipy"]);
		deepStrictEqual(outcome.dsPandas, ["numpy", "pandas"]);
		deepStrictEqual(outcome.dsNested, ["matplotlib", "pandas", "seaborn"]);
		deepStrictEqual(outcome.bcb, ["Faker"]);
		deepStrictEqual(outcome.bcbPillow, ["scikit-learn", "numpy", "opencv-python-headless", "pillow"]);
		deepStrictEqual(outcome.bcbCrypto, ["pycryptodome"]);
		deepStrictEqual(outcome.bcbLegacy, ["legacy-cgi", "tensorflow"]);
		deepStrictEqual(outcome.bcbIncomplete, ["pandas"]);
		strictEqual(
			outcome.bcbIncomplete.some((item) => item.includes(";")),
			false,
		);
		deepStrictEqual(outcome.sab, ["pandas", "scikit-learn"]);
		for (const suite of ["ds", "bcb", "sab"] as const) {
			const command = outcome[`${suite}Command`];
			strictEqual(command?.[0], "uv");
			strictEqual(command?.at(-1), "python");
			for (const unrelated of ["tensorflow", "torch", "opencv-python-headless", "matplotlib"]) {
				strictEqual(command?.includes(unrelated), false, `${suite} selected unrelated ${unrelated}`);
			}
		}
		strictEqual(outcome.bcbCommand?.includes("scipy"), false);
		strictEqual(outcome.sabCommand?.includes("scipy"), false);
		strictEqual(outcome.dsCommand?.includes("pandas"), false);
	});

	it("interpolates multiline task text after dedenting every adapter template", () => {
		const prompts = pythonJson(`${LOAD_HELPER}
ds = load("ds_prompt", "benchmarks/community/ds-1000/ds1000_clio.py")
lcb = load("lcb_prompt", "benchmarks/community/livecodebench/livecodebench_clio.py")
bcb = load("bcb_prompt", "benchmarks/community/bigcodebench/bigcodebench_clio.py")
mpe = load("mpe_prompt", "benchmarks/community/multipl-e/multiple_clio.py")
sab = load("sab_prompt", "benchmarks/community/scienceagentbench/scienceagentbench_clio.py")
core = load("core_prompt", "benchmarks/community/core-bench/corebench_clio.py")

print(json.dumps({
    "ds": ds.render_clio_prompt({
        "metadata": {"problem_id": 7, "library": "Pandas", "perturbation_type": "Origin"},
        "prompt": "DS-FIRST\\nDS-SECOND",
        "code_context": "",
    }),
    "lcb": lcb.render_clio_prompt({
        "task_id": "LiveCodeBench/x", "platform": "atcoder", "difficulty": "easy",
        "contest_id": "c", "contest_date": "2026-01-01", "question_content": "LCB-FIRST\\nLCB-SECOND",
    }, False),
    "bcb": bcb.render_clio_prompt({
        "task_id": "BigCodeBench/1", "entry_point": "answer",
        "instruct_prompt": "BCB-FIRST\\nBCB-SECOND",
    }, "instruct"),
    "mpe": mpe.render_clio_prompt({
        "name": "fixture", "prompt": "MPE-FIRST\\nMPE-SECOND", "tests": "}", "stop_tokens": ["\\n}"],
    }, mpe.LANGUAGES["cpp"]),
    "sab": sab.render_clio_prompt({
        "instance_id": 1, "domain": "Chemistry", "gold_program_name": "gold.py",
        "dataset_folder_tree": "|-- data\\n|---- values.csv", "output_fname": "pred_results/out.csv",
        "task_inst": "SAB-FIRST\\nSAB-SECOND", "domain_knowledge": "KNOW-FIRST\\nKNOW-SECOND",
    }),
    "core": core.render_clio_prompt({
        "capsule_id": "capsule-x", "capsule_title": "CORE-TITLE-FIRST\\nCORE-TITLE-SECOND",
        "task_prompt": "CORE-FIRST\\nCORE-SECOND",
        "results": [{"answer": 1}],
    }, "hard", ""),
}))
`) as Record<string, string>;

		for (const [suite, secondLine] of [
			["ds", "DS-SECOND"],
			["lcb", "LCB-SECOND"],
			["bcb", "BCB-SECOND"],
			["mpe", "MPE-SECOND"],
			["sab", "SAB-SECOND"],
			["core", "CORE-SECOND"],
		] as const) {
			strictEqual(
				prompts[suite]?.split("\n").some((line) => line.startsWith(secondLine)),
				true,
				`${suite} indented multiline text`,
			);
		}
		strictEqual(prompts.sab?.split("\n").includes("KNOW-SECOND"), true);
		strictEqual(prompts.sab?.split("\n").includes("|---- values.csv"), true);
		strictEqual(prompts.core?.split("\n").includes("CORE-TITLE-SECOND."), true);
	});

	it("keeps ScienceAgentBench private evaluators outside model-visible paths", () => {
		const outcome = pythonJson(
			`${LOAD_HELPER}
sab = load("sab_isolation", "benchmarks/community/scienceagentbench/scienceagentbench_clio.py")

scratch = pathlib.Path(os.environ["SAFETY_SCRATCH"])
benchmark = scratch / "private-benchmark"
dataset = benchmark / "datasets" / "task-one"
evaluators = benchmark / "eval_programs"
dataset.mkdir(parents=True)
evaluators.mkdir(parents=True)
(dataset / "value.txt").write_text("private-original", encoding="utf-8")
(evaluators / "secret.py").write_text("PRIVATE_EVALUATOR_SOURCE", encoding="utf-8")
(evaluators / "fixture_eval.py").write_text(
    "from pathlib import Path\\n"
    "def eval():\\n"
    "    value = Path('pred_results/output.txt').read_text(encoding='utf-8')\\n"
    "    return (value == 'accepted', value)\\n",
    encoding="utf-8",
)
task = {
    "instance_id": 1,
    "domain": "fixture",
    "dataset_folder_tree": "|-- task-one/\\n|---- value.txt",
    "output_fname": "pred_results/output.txt",
    "gold_program_name": "solution.py",
    "eval_script_name": "fixture_eval.py",
}
run_dir = scratch / "sab-run"
workspace = sab.prepare_workspace(task, run_dir, benchmark)
visible_dataset = workspace / "benchmark" / "datasets" / "task-one"
evaluator_via_dataset = visible_dataset / ".." / ".." / "eval_programs" / "secret.py"
(visible_dataset / "value.txt").write_text("model-mutated", encoding="utf-8")
program = """from pathlib import Path
if Path('benchmark/eval_programs').exists():
    raise RuntimeError('private evaluator was visible during generated-program execution')
Path('pred_results/output.txt').write_text('accepted', encoding='utf-8')
"""
grade = sab.grade_program(task, program, run_dir, benchmark, 30, 30, ())
print(json.dumps({
    "datasetIsSymlink": visible_dataset.is_symlink(),
    "sourceUnchanged": (dataset / "value.txt").read_text(encoding="utf-8"),
    "evaluatorReachableFromDataset": evaluator_via_dataset.exists(),
    "passed": grade.get("passed"),
    "validProgram": grade.get("validProgram"),
    "stage": grade.get("stage"),
}))
`,
			{ SAFETY_SCRATCH: scratch },
		) as Record<string, unknown>;

		strictEqual(outcome.datasetIsSymlink, false);
		strictEqual(outcome.sourceUnchanged, "private-original");
		strictEqual(outcome.evaluatorReachableFromDataset, false);
		strictEqual(outcome.passed, true);
		strictEqual(outcome.validProgram, true);
		strictEqual(outcome.stage, "eval");
	});

	it("contains CORE-Bench capsule extraction and rejects archive links", () => {
		const outcome = pythonJson(
			`${LOAD_HELPER}
import io
import tarfile

core = load("core_extraction", "benchmarks/community/core-bench/corebench_clio.py")
scratch = pathlib.Path(os.environ["SAFETY_SCRATCH"])
archive = scratch / "capsule.tar.gz"
destination = scratch / "extract"
escape = scratch / "extract-escape"

def add_file(tar, name, contents):
    payload = contents.encode("utf-8")
    member = tarfile.TarInfo(name)
    member.size = len(payload)
    tar.addfile(member, io.BytesIO(payload))

with tarfile.open(archive, "w:gz") as tar:
    add_file(tar, "capsule/safe.txt", "safe")
    add_file(tar, "../extract-escape/marker.txt", "escaped")
    link = tarfile.TarInfo("capsule/link")
    link.type = tarfile.SYMTYPE
    link.linkname = "../../extract-escape"
    tar.addfile(link)
    add_file(tar, "capsule/link/contained.txt", "contained")

root = core.extract_capsule(archive, destination)
print(json.dumps({
    "root": root.name,
    "safe": (destination / "capsule" / "safe.txt").read_text(encoding="utf-8"),
    "escaped": (escape / "marker.txt").exists(),
    "linkIsSymlink": (destination / "capsule" / "link").is_symlink(),
    "laterFileContained": (destination / "capsule" / "link" / "contained.txt").is_file(),
}))
`,
			{ SAFETY_SCRATCH: scratch },
		) as Record<string, unknown>;

		strictEqual(outcome.root, "capsule");
		strictEqual(outcome.safe, "safe");
		strictEqual(outcome.escaped, false);
		strictEqual(outcome.linkIsSymlink, false);
		strictEqual(outcome.laterFileContained, true);
	});
});

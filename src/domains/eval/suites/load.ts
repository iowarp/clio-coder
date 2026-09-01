import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { EvalSuiteV2, LoadedEvalSuiteV2 } from "../schema/suite.js";
import { type EvalValidationIssue, validateEvalSuiteV2 } from "../schema/validate.js";
import { loadEvalTaskFile } from "../task-file.js";

export class EvalSuiteFileError extends Error {
	readonly issues: EvalValidationIssue[];

	constructor(issues: ReadonlyArray<EvalValidationIssue>) {
		super(`eval suite invalid (${issues.length} ${issues.length === 1 ? "issue" : "issues"})`);
		this.name = "EvalSuiteFileError";
		this.issues = [...issues];
	}
}

export async function loadEvalSuiteFile(path: string): Promise<LoadedEvalSuiteV2> {
	const resolved = resolve(path);
	const raw = await readFile(resolved, "utf8");
	let parsed: unknown;
	try {
		parsed = parseYaml(raw);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new EvalSuiteFileError([{ path: "$", message: `invalid YAML: ${message}` }]);
	}
	const result = validateEvalSuiteV2(parsed);
	if (!result.valid) throw new EvalSuiteFileError(result.issues);
	return {
		path: resolved,
		baseDir: dirname(resolved),
		hash: sha256Hex(raw),
		suite: result.suite,
	};
}

export async function loadV1TaskFileAsSuite(path: string, repeatOverride?: number): Promise<LoadedEvalSuiteV2> {
	const loaded = await loadEvalTaskFile(path);
	const suite: EvalSuiteV2 = {
		version: 2,
		suite: {
			id: "v1-task-file",
			title: "v1 task file",
			visibility: "local",
			description: "Compatibility adapter for version 1 eval task files.",
			provenance: { taskFileVersion: 1 },
		},
		matrix: {
			targets: [{ id: "local" }],
			repeats: repeatOverride ?? 1,
		},
		tasks: loaded.taskFile.tasks.map((task) => ({
			id: task.id,
			tags: task.tags,
			workspace: { kind: "local", path: task.cwd },
			runner: { kind: "external-command", commands: task.setup },
			verify: { commands: task.verifier },
			metrics: { collect: ["latency.wallMs", "verifier.exitCode"] },
			timeoutMs: task.timeoutMs,
		})),
	};
	return {
		path: loaded.path,
		baseDir: loaded.baseDir,
		hash: loaded.contentHash,
		suite,
	};
}

function sha256Hex(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

import { parseEvalBehaviorScenarioV1 } from "./behavioral.js";
import {
	EVAL_SUITE_V2_VERSION,
	type EvalAssertionOp,
	type EvalMetricAssertion,
	type EvalRunnerKind,
	type EvalSuiteTaskV2,
	type EvalSuiteV2,
	type EvalWorkspaceKind,
} from "./suite.js";

const RUNNER_KINDS = new Set<EvalRunnerKind>(["clio-run", "context-index", "context-init", "external-command"]);
const WORKSPACE_KINDS = new Set<EvalWorkspaceKind>(["local", "git", "temp-copy"]);
const OPS = new Set<EvalAssertionOp>(["lt", "lte", "gt", "gte", "eq", "neq"]);

export type EvalSuiteValidationResult =
	| { valid: true; suite: EvalSuiteV2 }
	| { valid: false; issues: EvalValidationIssue[] };

export interface EvalValidationIssue {
	path: string;
	message: string;
}

export function validateEvalSuiteV2(value: unknown): EvalSuiteValidationResult {
	const issues: EvalValidationIssue[] = [];
	if (!isRecord(value)) return { valid: false, issues: [{ path: "$", message: "expected object" }] };
	if (value.version !== EVAL_SUITE_V2_VERSION) issues.push({ path: "$.version", message: "expected version 2" });
	const suite = readSuiteInfo(value.suite, "$.suite", issues);
	const matrix = readMatrix(value.matrix, "$.matrix", issues);
	const tasks = readTasks(value.tasks, "$.tasks", issues);
	const thresholds = readThresholds(value.thresholds, "$.thresholds", issues);
	if (issues.length > 0 || suite === null || matrix === null || tasks === null) return { valid: false, issues };
	return {
		valid: true,
		suite: {
			version: 2,
			suite,
			matrix,
			tasks,
			...(thresholds === undefined ? {} : { thresholds }),
		},
	};
}

function readSuiteInfo(value: unknown, path: string, issues: EvalValidationIssue[]): EvalSuiteV2["suite"] | null {
	if (!isRecord(value)) {
		issues.push({ path, message: "expected object" });
		return null;
	}
	const id = readId(value, path, "id", issues);
	const title = readNonEmptyString(value, path, "title", issues);
	const visibility = readNonEmptyString(value, path, "visibility", issues);
	if (id === null || title === null || visibility === null) return null;
	const description = optionalString(value, "description");
	const provenance = isRecord(value.provenance) ? value.provenance : undefined;
	return {
		id,
		title,
		visibility,
		...(description === undefined ? {} : { description }),
		...(provenance ? { provenance } : {}),
	};
}

function readMatrix(value: unknown, path: string, issues: EvalValidationIssue[]): EvalSuiteV2["matrix"] | null {
	if (!isRecord(value)) {
		issues.push({ path, message: "expected object" });
		return null;
	}
	const repeats = readPositiveInteger(value, path, "repeats", issues);
	if (!Array.isArray(value.targets) || value.targets.length === 0) {
		issues.push({ path: `${path}.targets`, message: "expected non-empty array" });
		return null;
	}
	const targets = value.targets.flatMap((target, index) => {
		if (!isRecord(target)) {
			issues.push({ path: `${path}.targets[${index}]`, message: "expected object" });
			return [];
		}
		const id = readId(target, `${path}.targets[${index}]`, "id", issues);
		if (id === null) return [];
		const suiteTarget = { id };
		const model = optionalString(target, "model");
		const thinking = optionalString(target, "thinking");
		return [
			{ ...suiteTarget, ...(model === undefined ? {} : { model }), ...(thinking === undefined ? {} : { thinking }) },
		];
	});
	if (repeats === null || targets.length === 0) return null;
	const maxCostUsd = value.maxCostUsd;
	if (maxCostUsd !== undefined && (typeof maxCostUsd !== "number" || !Number.isFinite(maxCostUsd) || maxCostUsd < 0)) {
		issues.push({ path: `${path}.maxCostUsd`, message: "expected non-negative number" });
		return null;
	}
	return { targets, repeats, ...(maxCostUsd === undefined ? {} : { maxCostUsd }) };
}

function readTasks(value: unknown, path: string, issues: EvalValidationIssue[]): EvalSuiteTaskV2[] | null {
	if (!Array.isArray(value) || value.length === 0) {
		issues.push({ path, message: "expected non-empty array" });
		return null;
	}
	const seen = new Set<string>();
	const tasks: EvalSuiteTaskV2[] = [];
	for (let index = 0; index < value.length; index += 1) {
		const task = readTask(value[index], `${path}[${index}]`, issues);
		if (task === null) continue;
		if (seen.has(task.id)) issues.push({ path: `${path}[${index}].id`, message: `duplicate task id: ${task.id}` });
		seen.add(task.id);
		tasks.push(task);
	}
	return tasks.length > 0 ? tasks : null;
}

function readTask(value: unknown, path: string, issues: EvalValidationIssue[]): EvalSuiteTaskV2 | null {
	if (!isRecord(value)) {
		issues.push({ path, message: "expected object" });
		return null;
	}
	const id = readId(value, path, "id", issues);
	const workspace = readWorkspace(value.workspace, `${path}.workspace`, issues);
	const runner = readRunner(value.runner, `${path}.runner`, issues);
	const timeoutMs = readPositiveInteger(value, path, "timeoutMs", issues);
	const behavioral = readBehavioral(value.behavioral, `${path}.behavioral`, issues);
	if (id === null || workspace === null || runner === null || timeoutMs === null) return null;
	return {
		id,
		tags: readOptionalStringArray(value, "tags", `${path}.tags`, issues),
		...(behavioral === undefined ? {} : { behavioral }),
		workspace,
		runner,
		verify: readVerify(value.verify, `${path}.verify`, issues),
		metrics: readMetrics(value.metrics, `${path}.metrics`, issues),
		timeoutMs,
	};
}

function readBehavioral(
	value: unknown,
	path: string,
	issues: EvalValidationIssue[],
): EvalSuiteTaskV2["behavioral"] | undefined {
	if (value === undefined) return undefined;
	try {
		return parseEvalBehaviorScenarioV1(value, path);
	} catch (error) {
		issues.push({ path, message: error instanceof Error ? error.message : String(error) });
		return undefined;
	}
}

function readWorkspace(
	value: unknown,
	path: string,
	issues: EvalValidationIssue[],
): EvalSuiteV2["tasks"][number]["workspace"] | null {
	if (!isRecord(value)) {
		issues.push({ path, message: "expected object" });
		return null;
	}
	const kind = value.kind;
	if (typeof kind !== "string" || !WORKSPACE_KINDS.has(kind as EvalWorkspaceKind)) {
		issues.push({ path: `${path}.kind`, message: "expected local, git, or temp-copy" });
		return null;
	}
	const pathValue = optionalString(value, "path");
	const url = optionalString(value, "url");
	const commit = optionalString(value, "commit");
	const checkout = optionalString(value, "checkout");
	return {
		kind: kind as EvalWorkspaceKind,
		...(pathValue === undefined ? {} : { path: pathValue }),
		...(url === undefined ? {} : { url }),
		...(commit === undefined ? {} : { commit }),
		...(checkout === undefined ? {} : { checkout }),
		excludes: readOptionalStringArray(value, "excludes", `${path}.excludes`, issues),
		setup: readOptionalStringArray(value, "setup", `${path}.setup`, issues),
	};
}

function readRunner(
	value: unknown,
	path: string,
	issues: EvalValidationIssue[],
): EvalSuiteV2["tasks"][number]["runner"] | null {
	if (!isRecord(value)) {
		issues.push({ path, message: "expected object" });
		return null;
	}
	const kind = value.kind;
	if (typeof kind !== "string" || !RUNNER_KINDS.has(kind as EvalRunnerKind)) {
		issues.push({ path: `${path}.kind`, message: "expected clio-run, context-index, context-init, or external-command" });
		return null;
	}
	const prompt = optionalString(value, "prompt");
	const agent = optionalString(value, "agent");
	if (agent !== undefined && kind !== "clio-run") {
		issues.push({ path: `${path}.agent`, message: "agent is only valid on the clio-run runner" });
	}
	const command = optionalString(value, "command");
	return {
		kind: kind as EvalRunnerKind,
		...(prompt === undefined ? {} : { prompt }),
		...(agent === undefined ? {} : { agent }),
		...(command === undefined ? {} : { command }),
		commands: readOptionalStringArray(value, "commands", `${path}.commands`, issues),
		args: readOptionalStringArray(value, "args", `${path}.args`, issues),
		...(typeof value.timeoutMs === "number" ? { timeoutMs: value.timeoutMs } : {}),
	};
}

function readVerify(
	value: unknown,
	path: string,
	issues: EvalValidationIssue[],
): EvalSuiteV2["tasks"][number]["verify"] {
	if (value === undefined) return {};
	if (!isRecord(value)) {
		issues.push({ path, message: "expected object" });
		return {};
	}
	return {
		commands: readOptionalStringArray(value, "commands", `${path}.commands`, issues),
		measure: readOptionalStringArray(value, "measure", `${path}.measure`, issues),
		assertions: readAssertions(value.assertions, `${path}.assertions`, issues),
		forbidPaths: readOptionalStringArray(value, "forbidPaths", `${path}.forbidPaths`, issues),
	};
}

function readMetrics(
	value: unknown,
	path: string,
	issues: EvalValidationIssue[],
): EvalSuiteV2["tasks"][number]["metrics"] {
	if (value === undefined) return { collect: [] };
	if (!isRecord(value)) {
		issues.push({ path, message: "expected object" });
		return { collect: [] };
	}
	return { collect: readOptionalStringArray(value, "collect", `${path}.collect`, issues) };
}

function readThresholds(
	value: unknown,
	path: string,
	issues: EvalValidationIssue[],
): EvalSuiteV2["thresholds"] | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		issues.push({ path, message: "expected object" });
		return undefined;
	}
	return { fail: readAssertions(value.fail, `${path}.fail`, issues) };
}

function readAssertions(value: unknown, path: string, issues: EvalValidationIssue[]): EvalMetricAssertion[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		issues.push({ path, message: "expected array" });
		return [];
	}
	const out: EvalMetricAssertion[] = [];
	for (let index = 0; index < value.length; index += 1) {
		const entry = value[index];
		if (!isRecord(entry)) {
			issues.push({ path: `${path}[${index}]`, message: "expected object" });
			continue;
		}
		const metric = readNonEmptyString(entry, `${path}[${index}]`, "metric", issues);
		const op = entry.op;
		if (typeof op !== "string" || !OPS.has(op as EvalAssertionOp)) {
			issues.push({ path: `${path}[${index}].op`, message: "expected lt, lte, gt, gte, eq, or neq" });
			continue;
		}
		const valueField = entry.value;
		if (metric === null || !["number", "string", "boolean"].includes(typeof valueField)) {
			issues.push({ path: `${path}[${index}].value`, message: "expected number, string, or boolean" });
			continue;
		}
		out.push({ metric, op: op as EvalAssertionOp, value: valueField as number | string | boolean });
	}
	return out;
}

function readId(
	record: Record<string, unknown>,
	path: string,
	field: string,
	issues: EvalValidationIssue[],
): string | null {
	const value = readNonEmptyString(record, path, field, issues);
	if (value !== null && !/^[A-Za-z0-9._-]+$/.test(value)) {
		issues.push({
			path: `${path}.${field}`,
			message: "expected id with letters, numbers, dots, underscores, or hyphens",
		});
	}
	return value;
}

function readNonEmptyString(
	record: Record<string, unknown>,
	path: string,
	field: string,
	issues: EvalValidationIssue[],
): string | null {
	const value = record[field];
	if (typeof value !== "string" || value.trim().length === 0) {
		issues.push({ path: `${path}.${field}`, message: "expected non-empty string" });
		return null;
	}
	return value;
}

function readPositiveInteger(
	record: Record<string, unknown>,
	path: string,
	field: string,
	issues: EvalValidationIssue[],
): number | null {
	const value = record[field];
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		issues.push({ path: `${path}.${field}`, message: "expected positive integer" });
		return null;
	}
	return value;
}

function readOptionalStringArray(
	record: Record<string, unknown>,
	field: string,
	path: string,
	issues: EvalValidationIssue[],
): string[] {
	const value = record[field];
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		issues.push({ path, message: "expected string array" });
		return [];
	}
	return value.flatMap((entry, index) => {
		if (typeof entry === "string" && entry.trim().length > 0) return [entry];
		issues.push({ path: `${path}[${index}]`, message: "expected non-empty string" });
		return [];
	});
}

function optionalString(record: Record<string, unknown>, field: string): string | undefined {
	const value = record[field];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

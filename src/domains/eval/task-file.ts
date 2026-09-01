import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
	EVAL_TASK_FILE_VERSION,
	type EvalTask,
	type EvalTaskFileValidationResult,
	type EvalValidationIssue,
	type LoadedEvalTaskFile,
} from "./types.js";

const TASK_KEYS = new Set(["id", "prompt", "cwd", "setup", "verifier", "timeoutMs", "tags"]);

export async function loadEvalTaskFile(path: string): Promise<LoadedEvalTaskFile> {
	const resolved = resolve(path);
	const raw = await readFile(resolved, "utf8");
	const result = parseEvalTaskFileYaml(raw);
	if (!result.valid) {
		throw new EvalTaskFileError(result.issues);
	}
	const baseDir = dirname(resolved);
	const cwdIssues = validateTaskCwds(result.taskFile.tasks, baseDir);
	if (cwdIssues.length > 0) throw new EvalTaskFileError(cwdIssues);
	return {
		path: resolved,
		baseDir,
		contentHash: sha256Hex(raw),
		taskFile: result.taskFile,
	};
}

export function parseEvalTaskFileYaml(raw: string): EvalTaskFileValidationResult {
	let parsed: unknown;
	try {
		parsed = parseYaml(raw);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { valid: false, issues: [{ path: "$", message: `invalid YAML: ${message}` }] };
	}
	return validateEvalTaskFile(parsed);
}

export function validateEvalTaskFile(value: unknown): EvalTaskFileValidationResult {
	const issues: EvalValidationIssue[] = [];
	if (!isRecord(value)) {
		return { valid: false, issues: [{ path: "$", message: "expected object" }] };
	}
	if (value.version !== EVAL_TASK_FILE_VERSION) {
		issues.push({ path: "$.version", message: "expected version 1" });
	}
	if (!Array.isArray(value.tasks)) {
		issues.push({ path: "$.tasks", message: "expected non-empty array" });
		return { valid: false, issues };
	}
	if (value.tasks.length === 0) {
		issues.push({ path: "$.tasks", message: "expected non-empty array" });
	}
	const tasks: EvalTask[] = [];
	const seenIds = new Set<string>();
	for (let index = 0; index < value.tasks.length; index += 1) {
		const task = parseTask(value.tasks[index], `$.tasks[${index}]`, issues);
		if (task === null) continue;
		if (seenIds.has(task.id)) {
			issues.push({ path: `$.tasks[${index}].id`, message: `duplicate task id: ${task.id}` });
		}
		seenIds.add(task.id);
		tasks.push(task);
	}
	if (issues.length > 0) return { valid: false, issues };
	return { valid: true, taskFile: { version: 1, tasks } };
}

export class EvalTaskFileError extends Error {
	readonly issues: EvalValidationIssue[];

	constructor(issues: ReadonlyArray<EvalValidationIssue>) {
		super(`eval task file invalid (${issues.length} ${issues.length === 1 ? "issue" : "issues"})`);
		this.name = "EvalTaskFileError";
		this.issues = [...issues];
	}
}

function parseTask(value: unknown, path: string, issues: EvalValidationIssue[]): EvalTask | null {
	if (!isRecord(value)) {
		issues.push({ path, message: "expected object" });
		return null;
	}
	for (const key of Object.keys(value).sort((a, b) => a.localeCompare(b))) {
		if (!TASK_KEYS.has(key)) issues.push({ path: `${path}.${key}`, message: "unknown field" });
	}
	const id = readNonEmptyString(value, path, "id", issues);
	if (id !== null && !/^[A-Za-z0-9._-]+$/.test(id)) {
		issues.push({ path: `${path}.id`, message: "expected id with letters, numbers, dots, underscores, or hyphens" });
	}
	const prompt = readNonEmptyString(value, path, "prompt", issues);
	const cwd = readNonEmptyString(value, path, "cwd", issues);
	if (cwd !== null && isAbsolute(cwd)) {
		issues.push({ path: `${path}.cwd`, message: "expected repo-local relative path" });
	}
	const setup = readStringArray(value, path, "setup", issues, true);
	const verifier = readStringArray(value, path, "verifier", issues, false);
	if (verifier !== null && verifier.length === 0) {
		issues.push({ path: `${path}.verifier`, message: "expected at least one command" });
	}
	const timeoutMs = readPositiveInteger(value, path, "timeoutMs", issues);
	const tags = readStringArray(value, path, "tags", issues, true);
	if (id === null || prompt === null || cwd === null || setup === null || verifier === null || timeoutMs === null) {
		return null;
	}
	return { id, prompt, cwd, setup, verifier, timeoutMs, tags: tags ?? [] };
}

function validateTaskCwds(tasks: ReadonlyArray<EvalTask>, baseDir: string): EvalValidationIssue[] {
	const issues: EvalValidationIssue[] = [];
	for (let index = 0; index < tasks.length; index += 1) {
		const task = tasks[index];
		if (task === undefined) continue;
		const resolved = resolve(baseDir, task.cwd);
		const rel = relative(baseDir, resolved);
		if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) continue;
		issues.push({ path: `$.tasks[${index}].cwd`, message: "cwd must stay within the task file directory" });
	}
	return issues;
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

function readStringArray(
	record: Record<string, unknown>,
	path: string,
	field: string,
	issues: EvalValidationIssue[],
	allowMissing: boolean,
): string[] | null {
	const value = record[field];
	if (value === undefined && allowMissing) return [];
	if (!Array.isArray(value)) {
		issues.push({ path: `${path}.${field}`, message: "expected string array" });
		return null;
	}
	const out: string[] = [];
	for (let index = 0; index < value.length; index += 1) {
		const entry = value[index];
		if (typeof entry !== "string" || entry.trim().length === 0) {
			issues.push({ path: `${path}.${field}[${index}]`, message: "expected non-empty string" });
			continue;
		}
		out.push(entry);
	}
	return out;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256Hex(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

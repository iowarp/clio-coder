import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	EvalCommandResult,
	EvalFailureClass,
	EvalFailureClassCount,
	EvalRunArtifact,
	EvalRunRecord,
	EvalSummary,
} from "./types.js";

const NODE_SIGNALS = new Set<string>([
	"SIGHUP",
	"SIGINT",
	"SIGQUIT",
	"SIGILL",
	"SIGTRAP",
	"SIGABRT",
	"SIGIOT",
	"SIGBUS",
	"SIGFPE",
	"SIGKILL",
	"SIGUSR1",
	"SIGSEGV",
	"SIGUSR2",
	"SIGPIPE",
	"SIGALRM",
	"SIGTERM",
	"SIGCHLD",
	"SIGSTKFLT",
	"SIGCONT",
	"SIGSTOP",
	"SIGTSTP",
	"SIGTTIN",
	"SIGTTOU",
	"SIGURG",
	"SIGXCPU",
	"SIGXFSZ",
	"SIGVTALRM",
	"SIGPROF",
	"SIGWINCH",
	"SIGIO",
	"SIGPOLL",
	"SIGPWR",
	"SIGSYS",
	"SIGUNUSED",
]);

export function evalRoot(dataDir: string): string {
	return join(dataDir, "evals");
}

export function evalArtifactPath(dataDir: string, evalId: string): string {
	return join(evalRoot(dataDir), `${evalId}.json`);
}

export function createEvalId(startedAt: Date, taskFileHash: string): string {
	const stamp = startedAt.toISOString().replace(/[-:.]/g, "");
	return `eval-${stamp}-${taskFileHash.slice(0, 8)}`;
}

export async function writeEvalArtifact(dataDir: string, artifact: EvalRunArtifact): Promise<string> {
	const path = evalArtifactPath(dataDir, artifact.evalId);
	await mkdir(evalRoot(dataDir), { recursive: true });
	await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
	return path;
}

export async function loadEvalArtifact(dataDir: string, evalId: string): Promise<EvalRunArtifact> {
	let raw: string;
	try {
		raw = await readFile(evalArtifactPath(dataDir, evalId), "utf8");
	} catch (error) {
		if (isErrorWithCode(error) && error.code === "ENOENT") throw new Error(`eval artifact not found: ${evalId}`);
		throw error;
	}
	const parsed = parseJson(raw, evalId);
	return parseArtifact(parsed, evalId);
}

export function taskFileHash(raw: string): string {
	return createHash("sha256").update(raw, "utf8").digest("hex");
}

function parseArtifact(value: unknown, source: string): EvalRunArtifact {
	if (!isRecord(value)) throw new Error(`${source}: expected object`);
	if (value.version !== 1) throw new Error(`${source}.version: expected 1`);
	const results = readArray(value, source, "results").map((entry, index) =>
		parseRecord(entry, `${source}.results[${index}]`),
	);
	return {
		version: 1,
		evalId: readString(value, source, "evalId"),
		taskFile: readString(value, source, "taskFile"),
		taskFileHash: readString(value, source, "taskFileHash"),
		repeat: readNumber(value, source, "repeat"),
		startedAt: readString(value, source, "startedAt"),
		endedAt: readString(value, source, "endedAt"),
		summary: parseSummary(value.summary, `${source}.summary`),
		results,
	};
}

function parseSummary(value: unknown, source: string): EvalSummary {
	if (!isRecord(value)) throw new Error(`${source}: expected object`);
	return {
		runs: readNumber(value, source, "runs"),
		passed: readNumber(value, source, "passed"),
		failed: readNumber(value, source, "failed"),
		passRate: readNumber(value, source, "passRate"),
		tokens: readNumber(value, source, "tokens"),
		costUsd: readNumber(value, source, "costUsd"),
		wallTimeMs: readNumber(value, source, "wallTimeMs"),
		failureClasses: readArray(value, source, "failureClasses").map((entry, index) =>
			parseFailureClassCount(entry, `${source}.failureClasses[${index}]`),
		),
	};
}

function parseRecord(value: unknown, source: string): EvalRunRecord {
	if (!isRecord(value)) throw new Error(`${source}: expected object`);
	const failureClass = readOptionalFailureClass(value, source, "failureClass");
	const record: EvalRunRecord = {
		taskId: readString(value, source, "taskId"),
		runId: readString(value, source, "runId"),
		repeatIndex: readNumber(value, source, "repeatIndex"),
		cwd: readString(value, source, "cwd"),
		prompt: readString(value, source, "prompt"),
		tags: readStringArray(value, source, "tags"),
		pass: readBoolean(value, source, "pass"),
		exitCode: readNumber(value, source, "exitCode"),
		tokens: readNumber(value, source, "tokens"),
		costUsd: readNumber(value, source, "costUsd"),
		wallTimeMs: readNumber(value, source, "wallTimeMs"),
		commands: readArray(value, source, "commands").map((entry, index) =>
			parseCommand(entry, `${source}.commands[${index}]`),
		),
	};
	if (failureClass !== undefined) record.failureClass = failureClass;
	const receiptPath = readOptionalString(value, source, "receiptPath");
	if (receiptPath !== undefined) record.receiptPath = receiptPath;
	const evidenceId = readOptionalString(value, source, "evidenceId");
	if (evidenceId !== undefined) record.evidenceId = evidenceId;
	return record;
}

function parseCommand(value: unknown, source: string): EvalCommandResult {
	if (!isRecord(value)) throw new Error(`${source}: expected object`);
	const phase = readString(value, source, "phase");
	if (phase !== "setup" && phase !== "verifier") throw new Error(`${source}.phase: expected setup or verifier`);
	return {
		phase,
		index: readNumber(value, source, "index"),
		command: readString(value, source, "command"),
		exitCode: readNumber(value, source, "exitCode"),
		signal: readSignal(value.signal, `${source}.signal`),
		timedOut: readBoolean(value, source, "timedOut"),
		wallTimeMs: readNumber(value, source, "wallTimeMs"),
		stdout: readStringAllowEmpty(value, source, "stdout"),
		stderr: readStringAllowEmpty(value, source, "stderr"),
	};
}

function readSignal(value: unknown, source: string): NodeJS.Signals | null {
	if (value === null) return null;
	if (typeof value === "string" && NODE_SIGNALS.has(value)) return value as NodeJS.Signals;
	throw new Error(`${source}: expected signal or null`);
}

function parseFailureClassCount(value: unknown, source: string): EvalFailureClassCount {
	if (!isRecord(value)) throw new Error(`${source}: expected object`);
	return {
		failureClass: readFailureClass(value, source, "failureClass"),
		count: readNumber(value, source, "count"),
	};
}

function readFailureClass(record: Record<string, unknown>, source: string, field: string): EvalFailureClass {
	const value = record[field];
	if (
		value === "setup_failed" ||
		value === "verifier_failed" ||
		value === "timeout" ||
		value === "cwd_missing" ||
		value === "command_error"
	) {
		return value;
	}
	throw new Error(`${source}.${field}: expected failure class`);
}

function readOptionalFailureClass(
	record: Record<string, unknown>,
	source: string,
	field: string,
): EvalFailureClass | undefined {
	if (record[field] === undefined) return undefined;
	return readFailureClass(record, source, field);
}

function readString(record: Record<string, unknown>, source: string, field: string): string {
	const value = record[field];
	if (typeof value !== "string" || value.length === 0) throw new Error(`${source}.${field}: expected string`);
	return value;
}

function readStringAllowEmpty(record: Record<string, unknown>, source: string, field: string): string {
	const value = record[field];
	if (typeof value !== "string") throw new Error(`${source}.${field}: expected string`);
	return value;
}

function readOptionalString(record: Record<string, unknown>, source: string, field: string): string | undefined {
	const value = record[field];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length === 0) throw new Error(`${source}.${field}: expected string`);
	return value;
}

function readStringArray(record: Record<string, unknown>, source: string, field: string): string[] {
	const value = readArray(record, source, field);
	const out: string[] = [];
	for (let index = 0; index < value.length; index += 1) {
		const entry = value[index];
		if (typeof entry !== "string") throw new Error(`${source}.${field}[${index}]: expected string`);
		out.push(entry);
	}
	return out;
}

function readNumber(record: Record<string, unknown>, source: string, field: string): number {
	const value = record[field];
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${source}.${field}: expected number`);
	return value;
}

function readBoolean(record: Record<string, unknown>, source: string, field: string): boolean {
	const value = record[field];
	if (typeof value !== "boolean") throw new Error(`${source}.${field}: expected boolean`);
	return value;
}

function readArray(record: Record<string, unknown>, source: string, field: string): unknown[] {
	const value = record[field];
	if (!Array.isArray(value)) throw new Error(`${source}.${field}: expected array`);
	return value;
}

function parseJson(raw: string, source: string): unknown {
	try {
		return JSON.parse(raw) as unknown;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${source}: invalid JSON: ${message}`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrorWithCode(error: unknown): error is Error & { code: string } {
	return error instanceof Error && "code" in error && typeof (error as { code?: unknown }).code === "string";
}

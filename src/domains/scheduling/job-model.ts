import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { snapshotTurnConstraints } from "../../core/turn-constraints.js";
import type {
	JobCreateInput,
	JobEvidence,
	JobOwner,
	JobPredicate,
	JobRecord,
	JobRunResult,
	JobSpec,
} from "./job-types.js";

export const JOB_HISTORY_LIMIT = 10;
export const JOB_SESSION_LIMIT = 32;
export const JOB_SUMMARY_BYTES = 2048;
export const JOB_JSON_BYTES = 16_384;
const MAX_DURATION_MS = 31 * 24 * 60 * 60_000;

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function integer(value: unknown, min: number, max: number, label: string): asserts value is number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
		throw new Error(`job: ${label} must be an integer between ${min} and ${max}`);
}
function text(value: unknown, max: number, label: string): asserts value is string {
	if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > max || value.includes("\0"))
		throw new Error(`job: invalid ${label} (maximum ${max} bytes)`);
}
function keys(value: object, allowed: readonly string[], label: string): void {
	if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`job: unsupported ${label} field`);
}
export function normalizeJobOwner(owner: JobOwner): JobOwner {
	if (!object(owner)) throw new Error("job: owner required");
	text(owner.sessionId, 256, "session id");
	text(owner.generation, 256, "owner generation");
	text(owner.cwd, 4096, "cwd");
	if (!isAbsolute(owner.cwd)) throw new Error("job: cwd must be absolute");
	return { sessionId: owner.sessionId, generation: owner.generation, cwd: realpathSync(owner.cwd) };
}
export function sameJobOwner(left: JobOwner, right: JobOwner): boolean {
	return left.sessionId === right.sessionId && left.cwd === right.cwd;
}
function validateJobPredicate(predicate: JobPredicate): JobPredicate {
	if (!object(predicate)) throw new Error("job: invalid predicate");
	keys(predicate, ["path", "op", "value"], "predicate");
	if (!Array.isArray(predicate.path) || predicate.path.length > 16) throw new Error("job: invalid predicate path");
	for (const key of predicate.path) {
		text(key, 128, "predicate path segment");
		if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("job: unsafe predicate path");
	}
	if (!["eq", "ne", "lt", "lte", "gt", "gte", "exists"].includes(predicate.op))
		throw new Error("job: invalid predicate operator");
	const value = predicate.value;
	if (predicate.op === "exists") {
		if (value !== undefined) throw new Error("job: exists takes no value");
	} else if (value === undefined || (value !== null && !["string", "number", "boolean"].includes(typeof value))) {
		throw new Error("job: predicate value must be a JSON scalar");
	}
	if (typeof value === "number" && !Number.isFinite(value)) throw new Error("job: non-finite predicate value");
	if (typeof value === "string" && Buffer.byteLength(value) > 2048) throw new Error("job: predicate value too large");
	if (["lt", "lte", "gt", "gte"].includes(predicate.op) && typeof value !== "number")
		throw new Error("job: ordered comparisons require a number");
	return { path: [...predicate.path], op: predicate.op, ...(value !== undefined ? { value } : {}) };
}
export function normalizeJobSpec(input: JobCreateInput, now: number): JobSpec {
	if (!object(input)) throw new Error("job: specification required");
	keys(
		input,
		["intervalMs", "runner", "count", "deadlineAt", "timeoutMs", "until", "onMatch", "constraints", "originTurnId"],
		"specification",
	);
	integer(now, 0, Number.MAX_SAFE_INTEGER - MAX_DURATION_MS, "clock");
	integer(input.intervalMs, 1000, MAX_DURATION_MS, "intervalMs");
	if (!object(input.runner)) throw new Error("job: runner required");
	let runner: JobSpec["runner"];
	if (input.runner.kind === "command") {
		keys(input.runner, ["kind", "argv", "executableSha256"], "command runner");
		if (!Array.isArray(input.runner.argv) || input.runner.argv.length < 1 || input.runner.argv.length > 128)
			throw new Error("job: argv requires 1..128 literal arguments");
		if (input.runner.argv.some((arg) => typeof arg !== "string" || arg.includes("\0")))
			throw new Error("job: invalid argv");
		text(input.runner.argv[0], 4096, "executable");
		if (Buffer.byteLength(JSON.stringify(input.runner.argv)) > 16_384) throw new Error("job: argv too large");
		if (
			input.runner.executableSha256 !== undefined &&
			(typeof input.runner.executableSha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.runner.executableSha256))
		)
			throw new Error("job: invalid executable digest");
		runner = {
			kind: "command",
			argv: [...input.runner.argv],
			...(input.runner.executableSha256 !== undefined ? { executableSha256: input.runner.executableSha256 } : {}),
		};
	} else if (input.runner.kind === "main") {
		keys(input.runner, ["kind", "prompt"], "main runner");
		text(input.runner.prompt, 8192, "prompt");
		runner = { kind: "main", prompt: input.runner.prompt };
	} else throw new Error("job: Stage 1 supports command and main runners only");
	if (input.count !== undefined) integer(input.count, 1, 100_000, "count");
	if (input.deadlineAt !== undefined) integer(input.deadlineAt, now + 1, now + MAX_DURATION_MS, "deadlineAt");
	const timeoutMs = input.timeoutMs ?? (runner.kind === "command" ? 60_000 : 600_000);
	integer(timeoutMs, 1, MAX_DURATION_MS, "timeoutMs");
	const until = input.until === undefined ? null : validateJobPredicate(input.until);
	if (until !== null && runner.kind !== "command")
		throw new Error("job: typed JSON predicates require a command runner");
	const onMatch = input.onMatch ?? { kind: "notice" };
	if (!object(onMatch)) throw new Error("job: invalid onMatch");
	if (onMatch.kind === "main_turn") {
		keys(onMatch, ["kind", "prompt"], "match action");
		text(onMatch.prompt, 8192, "follow-up prompt");
		if (until === null) throw new Error("job: analysis wake requires a predicate");
	} else if (onMatch.kind === "notice") keys(onMatch, ["kind"], "match action");
	else throw new Error("job: invalid match action");
	if (input.originTurnId !== undefined) text(input.originTurnId, 256, "origin turn id");
	return {
		intervalMs: input.intervalMs,
		runner,
		count: input.count ?? (input.deadlineAt === undefined ? 5 : null),
		deadlineAt: input.deadlineAt ?? null,
		timeoutMs,
		until,
		onMatch: { ...onMatch },
		constraints: snapshotTurnConstraints(input.constraints) ?? null,
		originTurnId: input.originTurnId ?? null,
	};
}
export function jobSpecHash(spec: JobSpec): string {
	return createHash("sha256").update(JSON.stringify(spec)).digest("hex");
}
export function matchesJobPredicate(predicate: JobPredicate, json: unknown): boolean {
	let value = json;
	for (const segment of predicate.path) {
		if (value === null || typeof value !== "object" || !Object.hasOwn(value, segment)) return false;
		value = (value as Record<string, unknown>)[segment];
	}
	if (predicate.op === "exists") return value !== undefined;
	if (predicate.op === "eq") return value === predicate.value;
	if (predicate.op === "ne") return value !== undefined && value !== predicate.value;
	if (typeof value !== "number" || !Number.isFinite(value) || typeof predicate.value !== "number") return false;
	switch (predicate.op) {
		case "lt":
			return value < predicate.value;
		case "lte":
			return value <= predicate.value;
		case "gt":
			return value > predicate.value;
		case "gte":
			return value >= predicate.value;
	}
}
export function jobHasUnresolvedCleanup(job: JobRecord): boolean {
	return (
		job.active?.evidence?.cleanupUnresolved === true ||
		job.delivery?.evidence?.cleanupUnresolved === true ||
		job.history.some((occurrence) => occurrence.evidence?.cleanupUnresolved === true)
	);
}
export function jobIsComplete(job: JobRecord): boolean {
	return (
		job.state === "terminal" &&
		!jobHasUnresolvedCleanup(job) &&
		!job.cancelRequested &&
		job.active === null &&
		job.pending === null &&
		(job.delivery === null || !["pending", "running"].includes(job.delivery.state))
	);
}
export function clipJobText(value: string, bytes = JOB_SUMMARY_BYTES): string {
	if (Buffer.byteLength(value) <= bytes) return value;
	const prefix = Buffer.from(value)
		.subarray(0, bytes - 3)
		.toString("utf8")
		.replace(/\uFFFD$/, "");
	return `${prefix}…`;
}
export function jobEvidence(result: JobRunResult, forced?: JobEvidence["outcome"]): JobEvidence {
	let json: unknown = null;
	let truncated = false;
	let jsonComplete = result.json !== undefined && result.jsonComplete !== false;
	try {
		const encoded = JSON.stringify(result.json ?? null, (_key, value: unknown) => {
			if (
				["undefined", "bigint", "function", "symbol"].includes(typeof value) ||
				(typeof value === "number" && !Number.isFinite(value))
			)
				throw new Error("not finite JSON");
			return value;
		});
		if (Buffer.byteLength(encoded) <= JOB_JSON_BYTES) json = JSON.parse(encoded) as unknown;
		else {
			truncated = true;
			jsonComplete = false;
		}
	} catch {
		// Non-JSON output is evidence unavailable, never predicate success (#411).
		truncated = true;
		jsonComplete = false;
	}
	const cleanupUnresolved = result.cleanupUnresolved === true;
	const sourceSummary = typeof result.summary === "string" ? result.summary : "";
	const summary = clipJobText(
		cleanupUnresolved ? `Cleanup unresolved; termination is unconfirmed. ${sourceSummary}` : sourceSummary,
	);
	return {
		outcome: cleanupUnresolved ? "failed" : (forced ?? (result.outcome === "deferred" ? "failed" : result.outcome)),
		summary,
		json,
		jsonComplete: jsonComplete && !cleanupUnresolved,
		cleanupUnresolved,
		evidenceRefs: (result.evidenceRefs ?? []).slice(0, 8).map((ref) => clipJobText(ref, 1024)),
		costUsd:
			typeof result.costUsd === "number" && Number.isFinite(result.costUsd) && result.costUsd >= 0 ? result.costUsd : null,
		truncated: truncated || summary !== (result.summary ?? "") || (result.evidenceRefs?.length ?? 0) > 8,
		errorClass: cleanupUnresolved ? "execution" : (result.errorClass ?? null),
	};
}

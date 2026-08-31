/**
 * Bounded adapter for Clio Coder's durable trace accounting.
 *
 * `trace runs --json` emits the whole row, including the request text the
 * operator typed, and it accepts a database path and a limit. This adapter
 * invokes only the fixed `trace inspect --json`, whose argv is not a surface,
 * and validates the already-narrowed payload again before it reaches the
 * browser. An installation that never enabled tracing answers `available:
 * false`, which is a different fact from a database holding no runs.
 */

import { resolve } from "node:path";
import { ClioReadCommandError, ClioReadCommandRunner } from "./clio-read-command.ts";
import {
	type CommandErrorCode,
	MAX_WIRE_TRACE_EVENT_KINDS,
	MAX_WIRE_TRACE_PHASES,
	MAX_WIRE_TRACE_PROCESS_KINDS,
	MAX_WIRE_TRACE_RUNS,
	type WireTraceEvents,
	type WireTraceInspection,
	type WireTracePhase,
	type WireTraceProcesses,
	type WireTraceRun,
} from "./src/protocol.ts";

export const DEFAULT_TRACE_INSPECT_TIMEOUT_MS = 10_000;
export const MAX_TRACE_INSPECT_STDOUT_BYTES = 1024 * 1024;
export const MAX_TRACE_INSPECT_STDERR_BYTES = 64 * 1024;
/** A year of wall time. Anything past it is a clock fault, not a long run. */
const MAX_ELAPSED_MS = 365 * 24 * 60 * 60 * 1_000;
const MAX_TOKENS = 1_000_000_000;
const MAX_COST_USD = 1_000_000;
const encoder = new TextEncoder();

export interface ClioTraceInspector {
	inspect(cwd: string): Promise<WireTraceInspection>;
}

export interface ClioCliTraceInspectorOptions {
	readonly executable?: string;
	/** Test/development prefix only. Browser commands can never influence argv. */
	readonly prefixArgs?: readonly string[];
	readonly timeoutMs?: number;
	readonly maximumStdoutBytes?: number;
	readonly maximumStderrBytes?: number;
	readonly now?: () => number;
	readonly log?: (message: string) => void;
}

export class ClioTraceProjectionError extends Error {
	override readonly name = "ClioTraceProjectionError";
}

export class ClioTraceInspectError extends Error {
	override readonly name = "ClioTraceInspectError";

	constructor(readonly code: CommandErrorCode, message: string) {
		super(message);
	}
}

function projectionError(message: string): never {
	throw new ClioTraceProjectionError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function exactKeys(record: Record<string, unknown>, required: readonly string[]): boolean {
	const keys = Object.keys(record);
	return keys.length === required.length && required.every((key) => Object.hasOwn(record, key));
}

function text(value: unknown, maximumBytes: number): string | null {
	if (typeof value !== "string" || value.length === 0 || value.trim() !== value) return null;
	if (encoder.encode(value).byteLength > maximumBytes) return null;
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return null;
	}
	return value;
}

function nullableText(value: unknown, maximumBytes: number): string | null | undefined {
	return value === null ? null : text(value, maximumBytes) ?? undefined;
}

function timestamp(value: unknown): string | null {
	const candidate = text(value, 128);
	if (candidate === null) return null;
	const parsed = new Date(candidate);
	return Number.isNaN(parsed.getTime()) || parsed.toISOString() !== candidate ? null : candidate;
}

/** A bounded non-negative integer, or `undefined` when the value is not one. */
function counter(value: unknown, maximum: number): number | undefined {
	return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum
		? value as number
		: undefined;
}

function nullableCounter(value: unknown, maximum: number): number | null | undefined {
	return value === null ? null : counter(value, maximum);
}

/** A bounded non-negative amount. Kept as a number so the browser formats it. */
function nullableAmount(value: unknown): number | null | undefined {
	if (value === null) return null;
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_COST_USD ? value : undefined;
}

function projectPhase(value: unknown): WireTracePhase {
	const keys = [
		"name",
		"kind",
		"owner",
		"status",
		"attempt",
		"retries",
		"failed",
		"elapsedMs",
		"totalTokens",
		"totalCostUsd",
	] as const;
	if (!isRecord(value) || !exactKeys(value, keys)) {
		return projectionError("Clio Coder returned an invalid trace phase row.");
	}
	const name = text(value.name, 128);
	const kind = text(value.kind, 64);
	const owner = text(value.owner, 128);
	const status = text(value.status, 64);
	const attempt = counter(value.attempt, 10_000);
	const retries = counter(value.retries, 10_000);
	const elapsedMs = nullableCounter(value.elapsedMs, MAX_ELAPSED_MS);
	const totalTokens = nullableCounter(value.totalTokens, MAX_TOKENS);
	const totalCostUsd = nullableAmount(value.totalCostUsd);
	if (
		name === null || kind === null || owner === null || status === null ||
		attempt === undefined || retries === undefined || elapsedMs === undefined ||
		totalTokens === undefined || totalCostUsd === undefined ||
		typeof value.failed !== "boolean"
	) return projectionError("Clio Coder returned an invalid trace phase row.");
	return { name, kind, owner, status, attempt, retries, failed: value.failed, elapsedMs, totalTokens, totalCostUsd };
}

function projectEvents(value: unknown): WireTraceEvents {
	if (!isRecord(value) || !exactKeys(value, ["total", "firstAt", "lastAt", "kinds", "kindsTruncated"])) {
		return projectionError("Clio Coder returned an invalid trace event summary.");
	}
	const total = counter(value.total, MAX_TOKENS);
	const firstAt = value.firstAt === null ? null : timestamp(value.firstAt);
	const lastAt = value.lastAt === null ? null : timestamp(value.lastAt);
	if (
		total === undefined || firstAt === undefined || lastAt === undefined ||
		(value.firstAt !== null && firstAt === null) || (value.lastAt !== null && lastAt === null) ||
		typeof value.kindsTruncated !== "boolean" || !Array.isArray(value.kinds) ||
		value.kinds.length > MAX_WIRE_TRACE_EVENT_KINDS
	) return projectionError("Clio Coder returned an invalid trace event summary.");
	// A span has both ends or neither, and it has them exactly when there were
	// events to span. A half-open span is not a narrower answer, it is a broken
	// one, and the total is the only thing that says which case applies.
	if ((firstAt === null) !== (lastAt === null) || (total === 0) !== (firstAt === null)) {
		return projectionError("Clio Coder returned a trace event span that contradicts its total.");
	}
	const kinds = value.kinds.map((entry) => {
		if (!isRecord(entry) || !exactKeys(entry, ["kind", "count"])) {
			return projectionError("Clio Coder returned an invalid trace event kind.");
		}
		const kind = text(entry.kind, 64);
		const count = counter(entry.count, MAX_TOKENS);
		if (kind === null || count === undefined) {
			return projectionError("Clio Coder returned an invalid trace event kind.");
		}
		return { kind, count };
	});
	if (new Set(kinds.map((entry) => entry.kind)).size !== kinds.length) {
		return projectionError("Clio Coder returned duplicate trace event kinds.");
	}
	// A complete breakdown accounts for every event; a truncated one accounts for
	// fewer, never more.
	const sum = kinds.reduce((running, entry) => running + entry.count, 0);
	if (value.kindsTruncated ? sum > total : sum !== total) {
		return projectionError("Clio Coder returned trace event kinds that do not account for the total.");
	}
	return { total, firstAt, lastAt, kinds, kindsTruncated: value.kindsTruncated };
}

function projectProcesses(value: unknown): WireTraceProcesses {
	if (!isRecord(value) || !exactKeys(value, ["total", "running", "kinds", "kindsTruncated"])) {
		return projectionError("Clio Coder returned an invalid trace process summary.");
	}
	const total = counter(value.total, MAX_TOKENS);
	const running = counter(value.running, MAX_TOKENS);
	if (
		total === undefined || running === undefined || running > total ||
		typeof value.kindsTruncated !== "boolean" || !Array.isArray(value.kinds) ||
		value.kinds.length > MAX_WIRE_TRACE_PROCESS_KINDS
	) return projectionError("Clio Coder returned an invalid trace process summary.");
	const kinds = value.kinds.map((entry) => {
		if (!isRecord(entry) || !exactKeys(entry, ["kind", "total", "running"])) {
			return projectionError("Clio Coder returned an invalid trace process kind.");
		}
		const kind = text(entry.kind, 64);
		const kindTotal = counter(entry.total, MAX_TOKENS);
		const kindRunning = counter(entry.running, MAX_TOKENS);
		if (kind === null || kindTotal === undefined || kindRunning === undefined || kindRunning > kindTotal) {
			return projectionError("Clio Coder returned an invalid trace process kind.");
		}
		return { kind, total: kindTotal, running: kindRunning };
	});
	if (new Set(kinds.map((entry) => entry.kind)).size !== kinds.length) {
		return projectionError("Clio Coder returned duplicate trace process kinds.");
	}
	return { total, running, kinds, kindsTruncated: value.kindsTruncated };
}

function projectRun(value: unknown): WireTraceRun {
	const keys = [
		"runId",
		"agent",
		"target",
		"model",
		"runtime",
		"node",
		"status",
		"startedAt",
		"elapsedMs",
		"totalTokens",
		"totalCostUsd",
		"phases",
		"phasesTruncated",
		"events",
		"processes",
	] as const;
	if (!isRecord(value) || !exactKeys(value, keys)) {
		return projectionError("Clio Coder returned an invalid trace run row.");
	}
	const runId = text(value.runId, 128);
	const agent = text(value.agent, 128);
	const target = text(value.target, 128);
	const model = text(value.model, 256);
	const runtime = text(value.runtime, 128);
	const node = nullableText(value.node, 128);
	const status = text(value.status, 64);
	const startedAt = timestamp(value.startedAt);
	const elapsedMs = nullableCounter(value.elapsedMs, MAX_ELAPSED_MS);
	const totalTokens = nullableCounter(value.totalTokens, MAX_TOKENS);
	const totalCostUsd = nullableAmount(value.totalCostUsd);
	if (
		runId === null || agent === null || target === null || model === null ||
		runtime === null || node === undefined || status === null || startedAt === null ||
		elapsedMs === undefined || totalTokens === undefined || totalCostUsd === undefined ||
		typeof value.phasesTruncated !== "boolean" || !Array.isArray(value.phases) ||
		value.phases.length > MAX_WIRE_TRACE_PHASES
	) return projectionError("Clio Coder returned an invalid trace run row.");
	const events = projectEvents(value.events);
	const processes = projectProcesses(value.processes);
	return {
		runId,
		agent,
		target,
		model,
		runtime,
		node,
		status,
		startedAt,
		elapsedMs,
		totalTokens,
		totalCostUsd,
		phases: value.phases.map(projectPhase),
		phasesTruncated: value.phasesTruncated,
		events,
		processes,
	};
}

export function projectTraceInspection(value: unknown, inspectedAt: string): WireTraceInspection {
	if (!isRecord(value) || !exactKeys(value, ["version", "generatedAt", "available", "runs", "truncated"])) {
		throw new ClioTraceProjectionError("Clio Coder returned an invalid trace snapshot.");
	}
	const generatedAt = timestamp(value.generatedAt);
	if (
		value.version !== 1 || generatedAt === null || typeof value.available !== "boolean" ||
		typeof value.truncated !== "boolean" || !Array.isArray(value.runs) ||
		value.runs.length > MAX_WIRE_TRACE_RUNS
	) {
		throw new ClioTraceProjectionError("Clio Coder returned an invalid trace snapshot.");
	}
	// An unavailable trace database has nothing to have read, so rows alongside
	// that claim mean the snapshot is not describing one installation.
	if (!value.available && (value.runs.length > 0 || value.truncated)) {
		throw new ClioTraceProjectionError("Clio Coder returned contradictory trace availability facts.");
	}
	const runs = value.runs.map(projectRun);
	if (new Set(runs.map((run) => run.runId)).size !== runs.length) {
		throw new ClioTraceProjectionError("Clio Coder returned duplicate trace run identities.");
	}
	return {
		scope: "installation",
		inspectedAt,
		generatedAt,
		available: value.available,
		runs,
		truncated: value.truncated,
	};
}

export class ClioCliTraceInspector implements ClioTraceInspector {
	readonly #runner: ClioReadCommandRunner;
	readonly #now: () => number;
	readonly #log: (message: string) => void;

	constructor(options: ClioCliTraceInspectorOptions = {}) {
		this.#runner = new ClioReadCommandRunner({
			executable: options.executable,
			prefixArgs: options.prefixArgs,
			timeoutMs: options.timeoutMs ?? DEFAULT_TRACE_INSPECT_TIMEOUT_MS,
			maximumStdoutBytes: options.maximumStdoutBytes ?? MAX_TRACE_INSPECT_STDOUT_BYTES,
			maximumStderrBytes: options.maximumStderrBytes ?? MAX_TRACE_INSPECT_STDERR_BYTES,
		});
		this.#now = options.now ?? Date.now;
		this.#log = options.log ?? (() => undefined);
	}

	async inspect(cwd: string): Promise<WireTraceInspection> {
		let parsed: unknown;
		try {
			parsed = await this.#runner.runJson(resolve(cwd), ["trace", "inspect", "--json"]);
		} catch (error) {
			if (!(error instanceof ClioReadCommandError)) throw error;
			if (error.code === "spawn") {
				throw new ClioTraceInspectError("not-ready", "The GUI could not start Clio Coder's trace inspector.");
			}
			if (error.code === "timeout") {
				throw new ClioTraceInspectError("not-ready", "Clio Coder's trace inspection did not finish in time.");
			}
			if (error.code === "exit") {
				const unsupported =
					/(?:unknown|unsupported).{0,32}(?:command|trace|inspect)|trace.{0,32}(?:unknown|unsupported)/iu
						.test(error.diagnostic);
				this.#log(`Clio Coder trace inspector exited with code ${error.exitCode ?? "unknown"}.`);
				throw new ClioTraceInspectError(
					unsupported ? "unsupported" : "not-ready",
					unsupported
						? "This Clio Coder version does not provide durable trace accounting."
						: "Clio Coder could not inspect its durable trace database.",
				);
			}
			throw new ClioTraceInspectError("internal", "Clio Coder returned an invalid or oversized trace snapshot.");
		}
		try {
			return projectTraceInspection(parsed, new Date(this.#now()).toISOString());
		} catch (error) {
			if (!(error instanceof ClioTraceProjectionError)) throw error;
			this.#log("Clio Coder trace projection rejected an incompatible snapshot.");
			throw new ClioTraceInspectError(
				"internal",
				"Clio Coder's durable trace view is not compatible with this GUI build.",
			);
		}
	}
}

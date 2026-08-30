/**
 * Bounded adapter for Clio Coder's installation-wide durable dispatch status.
 *
 * The browser supplies no argv and receives no run, agent, node, process, path,
 * lineage, or budget identifiers. This projection carries only admission state,
 * heartbeat counts, and exact cumulative totals reported by Clio Coder.
 */

import { resolve } from "node:path";
import { ClioReadCommandError, ClioReadCommandRunner } from "./clio-read-command.ts";
import type { CommandErrorCode, WireDispatchInspection } from "./src/protocol.ts";

export const DEFAULT_DISPATCH_INSPECT_TIMEOUT_MS = 8_000;
export const MAX_DISPATCH_INSPECT_STDOUT_BYTES = 2 * 1024 * 1024;
export const MAX_DISPATCH_INSPECT_STDERR_BYTES = 64 * 1024;
const MAX_RAW_RUNNING_ROWS = 4_096;
const MAX_RAW_RETRY_ROWS = 4_096;

export interface ClioDispatchInspector {
	inspect(cwd: string): Promise<WireDispatchInspection>;
}

export interface ClioCliDispatchInspectorOptions {
	readonly executable?: string;
	/** Test/development prefix only. Browser commands can never influence argv. */
	readonly prefixArgs?: readonly string[];
	readonly timeoutMs?: number;
	readonly maximumStdoutBytes?: number;
	readonly maximumStderrBytes?: number;
	readonly now?: () => number;
	readonly log?: (message: string) => void;
}

export class ClioDispatchProjectionError extends Error {
	override readonly name = "ClioDispatchProjectionError";
}

export class ClioDispatchInspectError extends Error {
	override readonly name = "ClioDispatchInspectError";

	constructor(readonly code: CommandErrorCode, message: string) {
		super(message);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function canonicalTimestamp(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value ? null : value;
}

function boundedNumber(value: unknown, integer: boolean): number | null {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) return null;
	if (integer && !Number.isSafeInteger(value)) return null;
	return value;
}

type Heartbeat = "alive" | "stale" | "dead" | "n/a";

function heartbeat(value: unknown): Heartbeat | null {
	return value === "alive" || value === "stale" || value === "dead" || value === "n/a" ? value : null;
}

export function projectDispatchInspection(value: unknown, inspectedAt: string): WireDispatchInspection {
	if (!isRecord(value)) throw new ClioDispatchProjectionError("Clio Coder returned an invalid dispatch snapshot.");
	const generatedAt = canonicalTimestamp(value.generatedAt);
	const admission = value.admission;
	const runningRows = value.running;
	const retryingRows = value.retrying;
	const totals = value.totals;
	if (
		generatedAt === null || !isRecord(admission) || !Array.isArray(runningRows) || !Array.isArray(retryingRows) ||
		!isRecord(totals) || runningRows.length > MAX_RAW_RUNNING_ROWS || retryingRows.length > MAX_RAW_RETRY_ROWS
	) throw new ClioDispatchProjectionError("Clio Coder returned an invalid dispatch snapshot.");

	let admissionState: "open" | "draining";
	let expiresAt: string | null;
	if (admission.state === "open") {
		admissionState = "open";
		expiresAt = null;
	} else if (admission.state === "draining") {
		admissionState = "draining";
		expiresAt = canonicalTimestamp(admission.expiresAt);
		if (expiresAt === null) {
			throw new ClioDispatchProjectionError("Clio Coder returned an invalid dispatch drain expiry.");
		}
	} else throw new ClioDispatchProjectionError("Clio Coder returned an invalid dispatch admission state.");

	const running = { total: runningRows.length, alive: 0, stale: 0, dead: 0, unreported: 0 };
	for (const row of runningRows) {
		if (!isRecord(row)) throw new ClioDispatchProjectionError("Clio Coder returned an invalid running dispatch row.");
		const phase = row.outcomePhase;
		const status = heartbeat(row.heartbeat);
		if ((phase !== "running" && phase !== "stale") || status === null) {
			throw new ClioDispatchProjectionError("Clio Coder returned an invalid running dispatch row.");
		}
		if ((phase === "stale") !== (status === "stale")) {
			throw new ClioDispatchProjectionError("Clio Coder returned a contradictory running dispatch row.");
		}
		if (status === "n/a") running.unreported += 1;
		else running[status] += 1;
	}
	if (!retryingRows.every(isRecord)) {
		throw new ClioDispatchProjectionError("Clio Coder returned an invalid retry queue.");
	}

	const inputTokens = boundedNumber(totals.inputTokens, true);
	const outputTokens = boundedNumber(totals.outputTokens, true);
	const totalTokens = boundedNumber(totals.totalTokens, true);
	const costUsd = boundedNumber(totals.costUsd, false);
	const runtimeSeconds = boundedNumber(totals.runtimeSeconds, false);
	if (
		inputTokens === null || outputTokens === null || totalTokens === null || costUsd === null ||
		runtimeSeconds === null
	) throw new ClioDispatchProjectionError("Clio Coder returned invalid dispatch totals.");

	return {
		scope: "installation",
		inspectedAt,
		generatedAt,
		admission: { state: admissionState, expiresAt },
		running,
		retryingCount: retryingRows.length,
		totals: { inputTokens, outputTokens, totalTokens, costUsd, runtimeSeconds },
	};
}

export class ClioCliDispatchInspector implements ClioDispatchInspector {
	readonly #runner: ClioReadCommandRunner;
	readonly #now: () => number;
	readonly #log: (message: string) => void;

	constructor(options: ClioCliDispatchInspectorOptions = {}) {
		this.#runner = new ClioReadCommandRunner({
			executable: options.executable,
			prefixArgs: options.prefixArgs,
			timeoutMs: options.timeoutMs ?? DEFAULT_DISPATCH_INSPECT_TIMEOUT_MS,
			maximumStdoutBytes: options.maximumStdoutBytes ?? MAX_DISPATCH_INSPECT_STDOUT_BYTES,
			maximumStderrBytes: options.maximumStderrBytes ?? MAX_DISPATCH_INSPECT_STDERR_BYTES,
		});
		this.#now = options.now ?? Date.now;
		this.#log = options.log ?? (() => undefined);
	}

	async inspect(cwd: string): Promise<WireDispatchInspection> {
		let parsed: unknown;
		try {
			parsed = await this.#runner.runJson(resolve(cwd), ["fleet", "status", "--json"]);
		} catch (error) {
			if (!(error instanceof ClioReadCommandError)) throw error;
			if (error.code === "spawn") {
				throw new ClioDispatchInspectError("not-ready", "The GUI could not start Clio Coder's dispatch inspector.");
			}
			if (error.code === "timeout") {
				throw new ClioDispatchInspectError("not-ready", "Clio Coder's dispatch inspection did not finish in time.");
			}
			if (error.code === "exit") {
				const unsupported = /(?:unknown|unsupported).{0,32}(?:command|fleet)|fleet.{0,32}(?:unknown|unsupported)/iu
					.test(error.diagnostic);
				this.#log(`Clio Coder dispatch inspector exited with code ${error.exitCode ?? "unknown"}.`);
				throw new ClioDispatchInspectError(
					unsupported ? "unsupported" : "not-ready",
					unsupported
						? "This Clio Coder version does not provide dispatch status inspection."
						: "Clio Coder could not inspect the installation-wide dispatch ledger.",
				);
			}
			throw new ClioDispatchInspectError("internal", "Clio Coder returned an invalid or oversized dispatch snapshot.");
		}
		try {
			return projectDispatchInspection(parsed, new Date(this.#now()).toISOString());
		} catch (error) {
			if (!(error instanceof ClioDispatchProjectionError)) throw error;
			this.#log("Clio Coder dispatch projection rejected an incompatible snapshot.");
			throw new ClioDispatchInspectError(
				"internal",
				"Clio Coder's dispatch status is not compatible with this GUI build.",
			);
		}
	}
}

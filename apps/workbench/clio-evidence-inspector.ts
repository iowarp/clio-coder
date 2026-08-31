/**
 * Bounded adapter for Clio Coder's durable evidence inventory.
 *
 * The browser supplies no evidence id or argv. `evidence inventory --json`
 * selects the newest bounded window itself and has already dropped the task
 * text, working directories, and bundle file names an overview carries; this
 * host projection revalidates what is left and rejects any field outside the
 * closed GUI DTO before the snapshot reaches the renderer.
 */

import { resolve } from "node:path";
import { ClioReadCommandError, ClioReadCommandRunner } from "./clio-read-command.ts";
import {
	type CommandErrorCode,
	EVIDENCE_AXES,
	EVIDENCE_AXIS_STATES,
	EVIDENCE_SOURCE_KINDS,
	EVIDENCE_TRUST_VERDICTS,
	MAX_WIRE_EVIDENCE_ARTIFACTS,
	MAX_WIRE_EVIDENCE_DETAIL_RUNS,
	MAX_WIRE_EVIDENCE_IDS,
	type WireEvidenceArtifact,
	type WireEvidenceDetail,
	type WireEvidenceDetailRun,
	type WireEvidenceInspection,
} from "./src/protocol.ts";

export const DEFAULT_EVIDENCE_INSPECT_TIMEOUT_MS = 15_000;
export const MAX_EVIDENCE_INSPECT_STDOUT_BYTES = 1024 * 1024;
export const MAX_EVIDENCE_INSPECT_STDERR_BYTES = 64 * 1024;
const MAX_COUNT = 1_000_000_000;
const MAX_COST_USD = 1_000_000;
const MAX_ELAPSED_MS = 365 * 24 * 60 * 60 * 1_000;
const encoder = new TextEncoder();

export interface ClioEvidenceInspector {
	inspect(cwd: string): Promise<WireEvidenceInspection>;
	/**
	 * Read one bundle. `evidenceId` must already have been admitted by the
	 * host's artifact allowlist; this adapter never widens that decision.
	 */
	read(cwd: string, evidenceId: string): Promise<WireEvidenceDetail>;
}

export interface ClioCliEvidenceInspectorOptions {
	readonly executable?: string;
	/** Test/development prefix only. Browser commands can never influence argv. */
	readonly prefixArgs?: readonly string[];
	readonly timeoutMs?: number;
	readonly maximumStdoutBytes?: number;
	readonly maximumStderrBytes?: number;
	readonly now?: () => number;
	readonly log?: (message: string) => void;
}

export class ClioEvidenceProjectionError extends Error {
	override readonly name = "ClioEvidenceProjectionError";
}

export class ClioEvidenceInspectError extends Error {
	override readonly name = "ClioEvidenceInspectError";

	constructor(readonly code: CommandErrorCode, message: string) {
		super(message);
	}
}

function projectionError(message: string): never {
	throw new ClioEvidenceProjectionError(message);
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

function timestamp(value: unknown): string | null {
	const candidate = text(value, 128);
	if (candidate === null) return null;
	const parsed = new Date(candidate);
	return Number.isNaN(parsed.getTime()) || parsed.toISOString() !== candidate ? null : candidate;
}

function nullableTimestamp(value: unknown): string | null | undefined {
	return value === null ? null : timestamp(value) ?? undefined;
}

function counter(value: unknown, maximum: number): number | undefined {
	return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum
		? value as number
		: undefined;
}

function amount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_COST_USD ? value : undefined;
}

/** A bounded list of distinct identity strings. */
function identities(value: unknown, label: string): readonly string[] {
	if (!Array.isArray(value) || value.length > MAX_WIRE_EVIDENCE_IDS) {
		return projectionError(`Clio Coder returned an invalid evidence ${label} list.`);
	}
	const list = value.map((entry) => text(entry, 128));
	if (list.some((entry) => entry === null) || new Set(list).size !== list.length) {
		return projectionError(`Clio Coder returned an invalid evidence ${label} list.`);
	}
	return list as string[];
}

function isOneOf<const T extends readonly string[]>(value: unknown, choices: T): value is T[number] {
	return typeof value === "string" && choices.includes(value as T[number]);
}

function projectTotals(value: unknown): WireEvidenceArtifact["totals"] {
	const keys = [
		"runs",
		"receipts",
		"toolCalls",
		"toolErrors",
		"blockedToolCalls",
		"protectedArtifacts",
		"tokens",
		"costUsd",
		"wallTimeMs",
	] as const;
	if (!isRecord(value) || !exactKeys(value, keys)) {
		return projectionError("Clio Coder returned invalid evidence totals.");
	}
	const counts = {
		runs: counter(value.runs, MAX_COUNT),
		receipts: counter(value.receipts, MAX_COUNT),
		toolCalls: counter(value.toolCalls, MAX_COUNT),
		toolErrors: counter(value.toolErrors, MAX_COUNT),
		blockedToolCalls: counter(value.blockedToolCalls, MAX_COUNT),
		protectedArtifacts: counter(value.protectedArtifacts, MAX_COUNT),
		tokens: counter(value.tokens, MAX_COUNT),
		wallTimeMs: counter(value.wallTimeMs, MAX_ELAPSED_MS),
	};
	const costUsd = amount(value.costUsd);
	if (Object.values(counts).some((entry) => entry === undefined) || costUsd === undefined) {
		return projectionError("Clio Coder returned invalid evidence totals.");
	}
	// A failed or blocked call is a subset of the calls that were attempted, so a
	// larger subset means the bundle is not describing one run of work.
	if ((counts.toolErrors as number) > (counts.toolCalls as number)) {
		return projectionError("Clio Coder returned contradictory evidence tool counts.");
	}
	return { ...(counts as Record<keyof typeof counts, number>), costUsd };
}

function projectArtifact(value: unknown): WireEvidenceArtifact {
	const keys = [
		"evidenceId",
		"sourceKind",
		"generatedAt",
		"startedAt",
		"endedAt",
		"runIds",
		"runIdsTruncated",
		"agentIds",
		"statuses",
		"tags",
		"totals",
		"redactionCount",
		"trust",
	] as const;
	if (!isRecord(value) || !exactKeys(value, keys)) {
		return projectionError("Clio Coder returned an invalid evidence row.");
	}
	const evidenceId = text(value.evidenceId, 128);
	const generatedAt = timestamp(value.generatedAt);
	const startedAt = nullableTimestamp(value.startedAt);
	const endedAt = nullableTimestamp(value.endedAt);
	const redactionCount = counter(value.redactionCount, MAX_COUNT);
	if (
		evidenceId === null || generatedAt === null || startedAt === undefined ||
		endedAt === undefined || redactionCount === undefined ||
		!isOneOf(value.sourceKind, EVIDENCE_SOURCE_KINDS) ||
		typeof value.runIdsTruncated !== "boolean"
	) return projectionError("Clio Coder returned an invalid evidence row.");
	if (!isRecord(value.trust) || !exactKeys(value.trust, ["verdict", "runsCovered", "historical"])) {
		return projectionError("Clio Coder returned an invalid evidence trust record.");
	}
	const runsCovered = counter(value.trust.runsCovered, MAX_COUNT);
	if (
		!isOneOf(value.trust.verdict, EVIDENCE_TRUST_VERDICTS) || runsCovered === undefined ||
		typeof value.trust.historical !== "boolean"
	) return projectionError("Clio Coder returned an invalid evidence trust record.");
	// A bundle with no canonical trust record cannot have a verdict of its own,
	// and one that recorded runs is no longer in the historical format.
	if (value.trust.historical && (runsCovered > 0 || value.trust.verdict !== "unknown")) {
		return projectionError("Clio Coder returned contradictory evidence trust facts.");
	}
	const tags = identities(value.tags, "tag");
	return {
		evidenceId,
		sourceKind: value.sourceKind,
		generatedAt,
		startedAt,
		endedAt,
		runIds: identities(value.runIds, "run id"),
		runIdsTruncated: value.runIdsTruncated,
		agentIds: identities(value.agentIds, "agent id"),
		statuses: identities(value.statuses, "status"),
		tags,
		totals: projectTotals(value.totals),
		redactionCount,
		trust: { verdict: value.trust.verdict, runsCovered, historical: value.trust.historical },
	};
}

export function projectEvidenceInspection(value: unknown, inspectedAt: string): WireEvidenceInspection {
	if (!isRecord(value) || !exactKeys(value, ["version", "generatedAt", "artifacts", "truncated"])) {
		throw new ClioEvidenceProjectionError("Clio Coder returned an invalid evidence inventory.");
	}
	const generatedAt = timestamp(value.generatedAt);
	if (
		value.version !== 1 || generatedAt === null || !Array.isArray(value.artifacts) ||
		value.artifacts.length > MAX_WIRE_EVIDENCE_ARTIFACTS || typeof value.truncated !== "boolean"
	) {
		throw new ClioEvidenceProjectionError("Clio Coder returned an invalid evidence inventory.");
	}
	const artifacts = value.artifacts.map(projectArtifact);
	if (new Set(artifacts.map((artifact) => artifact.evidenceId)).size !== artifacts.length) {
		throw new ClioEvidenceProjectionError("Clio Coder returned duplicate evidence identities.");
	}
	return { scope: "installation", inspectedAt, generatedAt, artifacts, truncated: value.truncated };
}

function projectDetailRun(value: unknown): WireEvidenceDetailRun {
	if (!isRecord(value) || !exactKeys(value, ["runId", "verdict", "axes"])) {
		return projectionError("Clio Coder returned an invalid evidence trust run.");
	}
	const runId = text(value.runId, 128);
	if (runId === null || !isOneOf(value.verdict, EVIDENCE_TRUST_VERDICTS) || !isRecord(value.axes)) {
		return projectionError("Clio Coder returned an invalid evidence trust run.");
	}
	if (!exactKeys(value.axes, EVIDENCE_AXES)) {
		return projectionError("Clio Coder returned an incomplete evidence axis record.");
	}
	const axes: Record<string, string> = {};
	for (const axis of EVIDENCE_AXES) {
		const state = value.axes[axis];
		// Each axis has its own closed state set, so a state that is legal on one
		// axis is still a rejection on another.
		if (!isOneOf(state, EVIDENCE_AXIS_STATES[axis])) {
			return projectionError("Clio Coder returned an invalid evidence axis state.");
		}
		axes[axis] = state;
	}
	return { runId, verdict: value.verdict, axes: axes as WireEvidenceDetailRun["axes"] };
}

export function projectEvidenceDetail(value: unknown, inspectedAt: string, requestedId: string): WireEvidenceDetail {
	if (
		!isRecord(value) ||
		!exactKeys(value, ["version", "generatedAt", "evidenceId", "sourceKind", "canonical", "runs", "runsTruncated"])
	) {
		throw new ClioEvidenceProjectionError("Clio Coder returned an invalid evidence record.");
	}
	const generatedAt = timestamp(value.generatedAt);
	const evidenceId = text(value.evidenceId, 128);
	if (
		value.version !== 1 || generatedAt === null || evidenceId === null ||
		!isOneOf(value.sourceKind, EVIDENCE_SOURCE_KINDS) || typeof value.canonical !== "boolean" ||
		typeof value.runsTruncated !== "boolean" || !Array.isArray(value.runs) ||
		value.runs.length > MAX_WIRE_EVIDENCE_DETAIL_RUNS
	) {
		throw new ClioEvidenceProjectionError("Clio Coder returned an invalid evidence record.");
	}
	// The host asked about one bundle. A record for a different one means the
	// process read something other than what the allowlist admitted, which is
	// the single failure this whole boundary exists to prevent.
	if (evidenceId !== requestedId) {
		throw new ClioEvidenceProjectionError("Clio Coder returned a record for a different evidence artifact.");
	}
	const runs = value.runs.map(projectDetailRun);
	if (new Set(runs.map((run) => run.runId)).size !== runs.length) {
		throw new ClioEvidenceProjectionError("Clio Coder returned duplicate evidence trust runs.");
	}
	// A bundle with no canonical projection has no axes to report, and one that
	// reported axes is not in the historical format.
	if (!value.canonical && (runs.length > 0 || value.runsTruncated)) {
		throw new ClioEvidenceProjectionError("Clio Coder returned contradictory evidence projection facts.");
	}
	return {
		evidenceId,
		sourceKind: value.sourceKind,
		inspectedAt,
		generatedAt,
		canonical: value.canonical,
		runs,
		runsTruncated: value.runsTruncated,
	};
}

export class ClioCliEvidenceInspector implements ClioEvidenceInspector {
	readonly #runner: ClioReadCommandRunner;
	readonly #now: () => number;
	readonly #log: (message: string) => void;

	constructor(options: ClioCliEvidenceInspectorOptions = {}) {
		this.#runner = new ClioReadCommandRunner({
			executable: options.executable,
			prefixArgs: options.prefixArgs,
			timeoutMs: options.timeoutMs ?? DEFAULT_EVIDENCE_INSPECT_TIMEOUT_MS,
			maximumStdoutBytes: options.maximumStdoutBytes ?? MAX_EVIDENCE_INSPECT_STDOUT_BYTES,
			maximumStderrBytes: options.maximumStderrBytes ?? MAX_EVIDENCE_INSPECT_STDERR_BYTES,
		});
		this.#now = options.now ?? Date.now;
		this.#log = options.log ?? (() => undefined);
	}

	async inspect(cwd: string): Promise<WireEvidenceInspection> {
		let parsed: unknown;
		try {
			parsed = await this.#runner.runJson(resolve(cwd), ["evidence", "inventory", "--json"]);
		} catch (error) {
			if (!(error instanceof ClioReadCommandError)) throw error;
			if (error.code === "spawn") {
				throw new ClioEvidenceInspectError("not-ready", "The GUI could not start Clio Coder's evidence inspector.");
			}
			if (error.code === "timeout") {
				throw new ClioEvidenceInspectError("not-ready", "Clio Coder's evidence inspection did not finish in time.");
			}
			if (error.code === "exit") {
				const unsupported =
					/(?:unknown|unsupported).{0,32}(?:command|evidence|inventory)|inventory.{0,32}(?:unknown|unsupported)/iu
						.test(error.diagnostic);
				this.#log(`Clio Coder evidence inspector exited with code ${error.exitCode ?? "unknown"}.`);
				throw new ClioEvidenceInspectError(
					unsupported ? "unsupported" : "not-ready",
					unsupported
						? "This Clio Coder version does not provide an evidence inventory."
						: "Clio Coder could not inspect its durable evidence artifacts.",
				);
			}
			throw new ClioEvidenceInspectError("internal", "Clio Coder returned an invalid or oversized evidence inventory.");
		}
		try {
			return projectEvidenceInspection(parsed, new Date(this.#now()).toISOString());
		} catch (error) {
			if (!(error instanceof ClioEvidenceProjectionError)) throw error;
			this.#log("Clio Coder evidence projection rejected an incompatible inventory.");
			throw new ClioEvidenceInspectError(
				"internal",
				"Clio Coder's evidence inventory is not compatible with this GUI build.",
			);
		}
	}

	async read(cwd: string, evidenceId: string): Promise<WireEvidenceDetail> {
		let parsed: unknown;
		try {
			// The id is the sole variable argument this host ever passes, and it is
			// only ever one the allowlist already admitted.
			parsed = await this.#runner.runJson(resolve(cwd), ["evidence", "inspect", evidenceId, "--json"]);
		} catch (error) {
			if (!(error instanceof ClioReadCommandError)) throw error;
			if (error.code === "spawn") {
				throw new ClioEvidenceInspectError("not-ready", "The GUI could not start Clio Coder's evidence reader.");
			}
			if (error.code === "timeout") {
				throw new ClioEvidenceInspectError("not-ready", "Clio Coder's evidence read did not finish in time.");
			}
			if (error.code === "exit") {
				// A bundle can be removed between the inventory and the read, which is
				// an ordinary race and not a failure of the installation.
				const missing = /not found|no such|missing/iu.test(error.diagnostic);
				this.#log(`Clio Coder evidence reader exited with code ${error.exitCode ?? "unknown"}.`);
				throw new ClioEvidenceInspectError(
					missing ? "not-found" : "not-ready",
					missing
						? "Clio Coder no longer has that evidence bundle."
						: "Clio Coder could not read that evidence bundle.",
				);
			}
			throw new ClioEvidenceInspectError("internal", "Clio Coder returned an invalid or oversized evidence record.");
		}
		try {
			return projectEvidenceDetail(parsed, new Date(this.#now()).toISOString(), evidenceId);
		} catch (error) {
			if (!(error instanceof ClioEvidenceProjectionError)) throw error;
			this.#log("Clio Coder evidence projection rejected an incompatible record.");
			throw new ClioEvidenceInspectError(
				"internal",
				"Clio Coder's evidence record is not compatible with this GUI build.",
			);
		}
	}
}

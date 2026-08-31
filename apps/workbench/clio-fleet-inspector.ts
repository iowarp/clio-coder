/**
 * Bounded adapter for Clio Coder's recent durable run and event-journal view.
 *
 * The browser supplies no run id or argv. Clio Coder selects the newest bounded
 * window, and this host projection rejects paths, raw receipts, and any field
 * outside the closed GUI DTO before the snapshot reaches the renderer.
 */

import { resolve } from "node:path";
import { ClioReadCommandError, ClioReadCommandRunner } from "./clio-read-command.ts";
import {
	type CommandErrorCode,
	FLEET_EVIDENCE_STATES,
	FLEET_JOURNAL_STATES,
	MAX_WIRE_FLEET_INSPECTION_EVENTS,
	MAX_WIRE_FLEET_INSPECTION_ROOTS,
	MAX_WIRE_FLEET_INSPECTION_RUNS,
	MAX_WIRE_FLEET_INSPECTION_STEPS,
	type WireFleetInspection,
	type WireFleetInspectionEvent,
	type WireFleetInspectionRoot,
	type WireFleetInspectionRun,
	type WireFleetInspectionStep,
} from "./src/protocol.ts";

export const DEFAULT_FLEET_INSPECT_TIMEOUT_MS = 8_000;
export const MAX_FLEET_INSPECT_STDOUT_BYTES = 1024 * 1024;
export const MAX_FLEET_INSPECT_STDERR_BYTES = 64 * 1024;
const encoder = new TextEncoder();

export interface ClioFleetInspector {
	inspect(cwd: string): Promise<WireFleetInspection>;
}

export interface ClioCliFleetInspectorOptions {
	readonly executable?: string;
	/** Test/development prefix only. Browser commands can never influence argv. */
	readonly prefixArgs?: readonly string[];
	readonly timeoutMs?: number;
	readonly maximumStdoutBytes?: number;
	readonly maximumStderrBytes?: number;
	readonly now?: () => number;
	readonly log?: (message: string) => void;
}

export class ClioFleetProjectionError extends Error {
	override readonly name = "ClioFleetProjectionError";
}

export class ClioFleetInspectError extends Error {
	override readonly name = "ClioFleetInspectError";

	constructor(readonly code: CommandErrorCode, message: string) {
		super(message);
	}
}

function projectionError(message: string): never {
	throw new ClioFleetProjectionError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function exactKeys(
	record: Record<string, unknown>,
	required: readonly string[],
): boolean {
	const keys = Object.keys(record);
	return keys.length === required.length &&
		required.every((key) => Object.hasOwn(record, key));
}

function text(value: unknown, maximumBytes: number): string | null {
	if (
		typeof value !== "string" || value.length === 0 || value.trim() !== value
	) return null;
	if (encoder.encode(value).byteLength > maximumBytes) return null;
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return null;
	}
	return value;
}

function nullableText(
	value: unknown,
	maximumBytes: number,
): string | null | undefined {
	return value === null ? null : text(value, maximumBytes) ?? undefined;
}

function timestamp(value: unknown): string | null {
	const candidate = text(value, 128);
	if (candidate === null) return null;
	const parsed = new Date(candidate);
	return Number.isNaN(parsed.getTime()) || parsed.toISOString() !== candidate ? null : candidate;
}

function elapsed(value: unknown): number | null {
	return Number.isSafeInteger(value) && (value as number) >= 0 &&
			(value as number) <= 365 * 24 * 60 * 60 * 1_000
		? value as number
		: null;
}

/** A planned/recorded step tally. Bounded well above any fleet an operator writes. */
function count(value: unknown): number | null {
	return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 10_000 ? value as number : null;
}

function isOneOf<const T extends readonly string[]>(
	value: unknown,
	choices: T,
): value is T[number] {
	return typeof value === "string" && choices.includes(value as T[number]);
}

function projectEvent(value: unknown): WireFleetInspectionEvent {
	if (!isRecord(value) || !exactKeys(value, ["at", "label", "detail"])) {
		return projectionError("Clio Coder returned an invalid run-journal event.");
	}
	const at = timestamp(value.at);
	const label = text(value.label, 128);
	const detail = nullableText(value.detail, 512);
	if (at === null || label === null || detail === undefined) {
		return projectionError("Clio Coder returned an invalid run-journal event.");
	}
	return { at, label, detail };
}

function projectRun(value: unknown): WireFleetInspectionRun {
	const keys = [
		"runId",
		"agentId",
		"model",
		"target",
		"node",
		"phase",
		"startedAt",
		"elapsedMs",
		"task",
		"journal",
		"events",
		"eventsTruncated",
		"evidence",
		"outcome",
		"outcomeDetail",
		"terminal",
	] as const;
	if (!isRecord(value) || !exactKeys(value, keys)) {
		return projectionError("Clio Coder returned an invalid durable run row.");
	}
	const runId = text(value.runId, 128);
	const agentId = text(value.agentId, 128);
	const model = text(value.model, 256);
	const target = text(value.target, 128);
	const node = text(value.node, 128);
	const phase = text(value.phase, 128);
	const startedAt = timestamp(value.startedAt);
	const elapsedMs = elapsed(value.elapsedMs);
	const task = nullableText(value.task, 1024);
	const outcome = nullableText(value.outcome, 256);
	const outcomeDetail = nullableText(value.outcomeDetail, 512);
	if (
		runId === null || agentId === null || model === null || target === null ||
		node === null || phase === null ||
		startedAt === null || elapsedMs === null || task === undefined ||
		outcome === undefined || outcomeDetail === undefined ||
		!isOneOf(value.journal, FLEET_JOURNAL_STATES) ||
		typeof value.eventsTruncated !== "boolean" ||
		typeof value.terminal !== "boolean" || !Array.isArray(value.events) ||
		value.events.length > MAX_WIRE_FLEET_INSPECTION_EVENTS
	) return projectionError("Clio Coder returned an invalid durable run row.");
	if (
		!isRecord(value.evidence) ||
		!exactKeys(value.evidence, ["state", "summary"])
	) {
		return projectionError("Clio Coder returned invalid receipt trust facts.");
	}
	const evidenceSummary = text(value.evidence.summary, 512);
	if (
		!isOneOf(value.evidence.state, FLEET_EVIDENCE_STATES) ||
		evidenceSummary === null
	) {
		return projectionError("Clio Coder returned invalid receipt trust facts.");
	}
	return {
		runId,
		agentId,
		model,
		target,
		node,
		phase,
		startedAt,
		elapsedMs,
		task,
		journal: value.journal,
		events: value.events.map(projectEvent),
		eventsTruncated: value.eventsTruncated,
		evidence: { state: value.evidence.state, summary: evidenceSummary },
		outcome,
		outcomeDetail,
		terminal: value.terminal,
	};
}

function projectStep(value: unknown): WireFleetInspectionStep {
	if (
		!isRecord(value) ||
		!exactKeys(value, ["stepId", "runId", "agentId", "outcome", "detail"])
	) {
		return projectionError("Clio Coder returned an invalid fleet step row.");
	}
	const stepId = text(value.stepId, 128);
	const runId = nullableText(value.runId, 128);
	const agentId = nullableText(value.agentId, 128);
	const outcome = text(value.outcome, 256);
	const detail = nullableText(value.detail, 512);
	if (
		stepId === null || runId === undefined || agentId === undefined ||
		outcome === null || detail === undefined
	) {
		return projectionError("Clio Coder returned an invalid fleet step row.");
	}
	// A step with no terminal run has nothing to attribute, so an agent id
	// without one is a record this projection cannot render truthfully.
	if (runId === null && agentId !== null) {
		return projectionError("Clio Coder attributed an agent to a fleet step that never ran.");
	}
	return { stepId, runId, agentId, outcome, detail };
}

function projectRoot(value: unknown): WireFleetInspectionRoot {
	const keys = [
		"rootId",
		"fleet",
		"startedAt",
		"elapsedMs",
		"running",
		"resumedFrom",
		"plannedSteps",
		"recordedSteps",
		"steps",
		"stepsTruncated",
	] as const;
	if (!isRecord(value) || !exactKeys(value, keys)) {
		return projectionError("Clio Coder returned an invalid fleet root row.");
	}
	const rootId = text(value.rootId, 128);
	const fleet = text(value.fleet, 128);
	const startedAt = timestamp(value.startedAt);
	const elapsedMs = elapsed(value.elapsedMs);
	const resumedFrom = nullableText(value.resumedFrom, 128);
	const plannedSteps = count(value.plannedSteps);
	const recordedSteps = count(value.recordedSteps);
	if (
		rootId === null || fleet === null || startedAt === null ||
		elapsedMs === null || resumedFrom === undefined ||
		plannedSteps === null || recordedSteps === null ||
		typeof value.running !== "boolean" ||
		typeof value.stepsTruncated !== "boolean" ||
		!Array.isArray(value.steps) ||
		value.steps.length > MAX_WIRE_FLEET_INSPECTION_STEPS
	) {
		return projectionError("Clio Coder returned an invalid fleet root row.");
	}
	const steps = value.steps.map(projectStep);
	if (new Set(steps.map((step) => step.stepId)).size !== steps.length) {
		return projectionError("Clio Coder returned duplicate fleet step identities.");
	}
	if (recordedSteps > plannedSteps || steps.length > plannedSteps) {
		return projectionError("Clio Coder returned contradictory fleet step counts.");
	}
	return {
		rootId,
		fleet,
		startedAt,
		elapsedMs,
		running: value.running,
		resumedFrom,
		plannedSteps,
		recordedSteps,
		steps,
		stepsTruncated: value.stepsTruncated,
	};
}

export function projectFleetInspection(
	value: unknown,
	inspectedAt: string,
): WireFleetInspection {
	if (
		!isRecord(value) ||
		!exactKeys(value, [
			"version",
			"generatedAt",
			"runs",
			"truncated",
			"roots",
			"rootsTruncated",
		])
	) {
		throw new ClioFleetProjectionError(
			"Clio Coder returned an invalid recent-run snapshot.",
		);
	}
	const generatedAt = timestamp(value.generatedAt);
	if (
		value.version !== 1 || generatedAt === null || !Array.isArray(value.runs) ||
		value.runs.length > MAX_WIRE_FLEET_INSPECTION_RUNS ||
		typeof value.truncated !== "boolean" || !Array.isArray(value.roots) ||
		value.roots.length > MAX_WIRE_FLEET_INSPECTION_ROOTS ||
		typeof value.rootsTruncated !== "boolean"
	) {
		throw new ClioFleetProjectionError(
			"Clio Coder returned an invalid recent-run snapshot.",
		);
	}
	const runs = value.runs.map(projectRun);
	if (new Set(runs.map((run) => run.runId)).size !== runs.length) {
		throw new ClioFleetProjectionError(
			"Clio Coder returned duplicate durable run identities.",
		);
	}
	const roots = value.roots.map(projectRoot);
	if (new Set(roots.map((root) => root.rootId)).size !== roots.length) {
		throw new ClioFleetProjectionError(
			"Clio Coder returned duplicate fleet root identities.",
		);
	}
	return {
		scope: "installation",
		inspectedAt,
		generatedAt,
		runs,
		truncated: value.truncated,
		roots,
		rootsTruncated: value.rootsTruncated,
	};
}

export class ClioCliFleetInspector implements ClioFleetInspector {
	readonly #runner: ClioReadCommandRunner;
	readonly #now: () => number;
	readonly #log: (message: string) => void;

	constructor(options: ClioCliFleetInspectorOptions = {}) {
		this.#runner = new ClioReadCommandRunner({
			executable: options.executable,
			prefixArgs: options.prefixArgs,
			timeoutMs: options.timeoutMs ?? DEFAULT_FLEET_INSPECT_TIMEOUT_MS,
			maximumStdoutBytes: options.maximumStdoutBytes ??
				MAX_FLEET_INSPECT_STDOUT_BYTES,
			maximumStderrBytes: options.maximumStderrBytes ??
				MAX_FLEET_INSPECT_STDERR_BYTES,
		});
		this.#now = options.now ?? Date.now;
		this.#log = options.log ?? (() => undefined);
	}

	async inspect(cwd: string): Promise<WireFleetInspection> {
		let parsed: unknown;
		try {
			parsed = await this.#runner.runJson(resolve(cwd), [
				"fleet",
				"inspect",
				"--json",
			]);
		} catch (error) {
			if (!(error instanceof ClioReadCommandError)) throw error;
			if (error.code === "spawn") {
				throw new ClioFleetInspectError(
					"not-ready",
					"The GUI could not start Clio Coder's run inspector.",
				);
			}
			if (error.code === "timeout") {
				throw new ClioFleetInspectError(
					"not-ready",
					"Clio Coder's run inspection did not finish in time.",
				);
			}
			if (error.code === "exit") {
				const unsupported = /(?:unknown|unsupported).{0,32}(?:command|inspect)|inspect.{0,32}(?:unknown|unsupported)/iu
					.test(error.diagnostic);
				this.#log(
					`Clio Coder run inspector exited with code ${error.exitCode ?? "unknown"}.`,
				);
				throw new ClioFleetInspectError(
					unsupported ? "unsupported" : "not-ready",
					unsupported
						? "This Clio Coder version does not provide durable run inspection."
						: "Clio Coder could not inspect its recent durable runs.",
				);
			}
			throw new ClioFleetInspectError(
				"internal",
				"Clio Coder returned an invalid or oversized run snapshot.",
			);
		}
		try {
			return projectFleetInspection(
				parsed,
				new Date(this.#now()).toISOString(),
			);
		} catch (error) {
			if (!(error instanceof ClioFleetProjectionError)) throw error;
			this.#log("Clio Coder run projection rejected an incompatible snapshot.");
			throw new ClioFleetInspectError(
				"internal",
				"Clio Coder's durable run view is not compatible with this GUI build.",
			);
		}
	}
}

/**
 * Bounded adapter for Clio Coder's sealed coordinator gate decisions.
 *
 * A review or compete gate seals an integrity-covered artifact per decision,
 * and nothing in the operator surface reads them back. This adapter invokes
 * only the fixed `fleet decisions --json`, whose argv is not a surface, and
 * validates the already-narrowed payload again before it reaches the browser.
 *
 * The decision's stored prose never appears in that payload: it is classified
 * on the host into a closed set, because the strings it is classified from
 * interpolate a receipt's failure reason, the names of protected artifacts a
 * candidate touched, and an operator approval request id. Neither do the
 * receipt digests, which a verified artifact carries per subject and which tell
 * a reader nothing the run id does not.
 */

import { resolve } from "node:path";
import { ClioReadCommandError, ClioReadCommandRunner } from "./clio-read-command.ts";
import {
	type CommandErrorCode,
	GATE_DECISION_OUTCOMES,
	GATE_DECISION_REASONS,
	GATE_OUTCOMES_BY_TOPOLOGY,
	GATE_OUTCOMES_WITH_WINNER,
	GATE_TOPOLOGIES,
	MAX_WIRE_GATE_DECISION_SUBJECTS,
	MAX_WIRE_GATE_DECISIONS,
	type WireGateCorrelation,
	type WireGateDecision,
	type WireGateDecisions,
	type WireGateWinner,
} from "./src/protocol.ts";

export const DEFAULT_DECISIONS_TIMEOUT_MS = 8_000;
export const MAX_DECISIONS_STDOUT_BYTES = 512 * 1024;
export const MAX_DECISIONS_STDERR_BYTES = 64 * 1024;
const encoder = new TextEncoder();

export interface ClioDecisionsInspector {
	inspect(cwd: string): Promise<WireGateDecisions>;
}

export interface ClioCliDecisionsInspectorOptions {
	readonly executable?: string;
	/** Test/development prefix only. Browser commands can never influence argv. */
	readonly prefixArgs?: readonly string[];
	readonly timeoutMs?: number;
	readonly maximumStdoutBytes?: number;
	readonly maximumStderrBytes?: number;
	readonly now?: () => number;
	readonly log?: (message: string) => void;
}

export class ClioDecisionsProjectionError extends Error {
	override readonly name = "ClioDecisionsProjectionError";
}

export class ClioDecisionsInspectError extends Error {
	override readonly name = "ClioDecisionsInspectError";

	constructor(readonly code: CommandErrorCode, message: string) {
		super(message);
	}
}

function projectionError(message: string): never {
	throw new ClioDecisionsProjectionError(message);
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

function count(value: unknown): number | null {
	return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 10_000 ? value as number : null;
}

function isOneOf<const T extends readonly string[]>(value: unknown, choices: T): value is T[number] {
	return typeof value === "string" && choices.includes(value as T[number]);
}

function projectCorrelation(value: unknown): WireGateCorrelation {
	const keys = ["agent", "target", "modelFamily", "runtime", "node", "independent"] as const;
	if (!isRecord(value) || !exactKeys(value, keys)) {
		return projectionError("Clio Coder returned an invalid gate correlation.");
	}
	for (const key of keys) {
		if (typeof value[key] !== "boolean") {
			return projectionError("Clio Coder returned an invalid gate correlation.");
		}
	}
	const agent = value.agent as boolean;
	const modelFamily = value.modelFamily as boolean;
	const independent = value.independent as boolean;
	// Independence is defined as sharing neither the agent nor the model family.
	// A decision claiming both is claiming a second opinion it did not get.
	if (independent !== (!agent && !modelFamily)) {
		return projectionError("Clio Coder returned a gate correlation whose dimensions contradict its independence.");
	}
	return {
		agent,
		target: value.target as boolean,
		modelFamily,
		runtime: value.runtime as boolean,
		node: value.node as boolean,
		independent,
	};
}

function projectWinner(value: unknown): WireGateWinner {
	if (!isRecord(value) || !exactKeys(value, ["index", "runId"])) {
		return projectionError("Clio Coder returned an invalid gate winner.");
	}
	const index = count(value.index);
	const runId = text(value.runId, 128);
	if (index === null || index < 1 || runId === null) {
		return projectionError("Clio Coder returned an invalid gate winner.");
	}
	return { index, runId };
}

function projectDecision(value: unknown): WireGateDecision {
	const keys = [
		"id",
		"group",
		"topology",
		"cycle",
		"outcome",
		"decidedAt",
		"subjects",
		"subjectsTruncated",
		"decider",
		"correlation",
		"winner",
		"confirms",
		"reason",
	] as const;
	if (!isRecord(value) || !exactKeys(value, keys)) {
		return projectionError("Clio Coder returned an invalid gate decision.");
	}
	const id = text(value.id, 128);
	const group = text(value.group, 128);
	const decidedAt = timestamp(value.decidedAt);
	const cycle = count(value.cycle);
	const decider = nullableText(value.decider, 128);
	const confirms = nullableText(value.confirms, 128);
	if (
		id === null || group === null || decidedAt === null || cycle === null || cycle < 1 ||
		decider === undefined || confirms === undefined ||
		!isOneOf(value.topology, GATE_TOPOLOGIES) ||
		!isOneOf(value.outcome, GATE_DECISION_OUTCOMES) ||
		(value.reason !== null && !isOneOf(value.reason, GATE_DECISION_REASONS)) ||
		typeof value.subjectsTruncated !== "boolean" ||
		!Array.isArray(value.subjects) || value.subjects.length === 0 ||
		value.subjects.length > MAX_WIRE_GATE_DECISION_SUBJECTS
	) return projectionError("Clio Coder returned an invalid gate decision.");
	// A review gate answers pass/fail/revise/exhausted and a compete gate answers
	// winner/no-winner/confirmed/applied. Neither reaches the other's verdicts.
	if (!GATE_OUTCOMES_BY_TOPOLOGY[value.topology].includes(value.outcome)) {
		return projectionError("Clio Coder returned a gate outcome its topology cannot reach.");
	}
	const subjects: string[] = [];
	for (const entry of value.subjects) {
		const runId = text(entry, 128);
		if (runId === null || subjects.includes(runId)) {
			return projectionError("Clio Coder returned an invalid gate subject.");
		}
		subjects.push(runId);
	}
	const correlation = value.correlation === null ? null : projectCorrelation(value.correlation);
	// A correlation measures a decider against its subjects, so it cannot exist
	// without one. The decision store refuses the pair for the same reason.
	if (correlation !== null && decider === null) {
		return projectionError("Clio Coder returned a gate correlation with no decider to measure.");
	}
	const winner = value.winner === null ? null : projectWinner(value.winner);
	if ((winner !== null) !== GATE_OUTCOMES_WITH_WINNER.includes(value.outcome)) {
		return projectionError("Clio Coder returned a gate winner its outcome does not account for.");
	}
	if (winner !== null && !subjects.includes(winner.runId) && !value.subjectsTruncated) {
		return projectionError("Clio Coder returned a gate winner the decision did not grade.");
	}
	return {
		id,
		group,
		topology: value.topology,
		cycle,
		outcome: value.outcome,
		decidedAt,
		subjects,
		subjectsTruncated: value.subjectsTruncated,
		decider,
		correlation,
		winner,
		confirms,
		reason: value.reason as WireGateDecision["reason"],
	};
}

export function projectGateDecisions(value: unknown, inspectedAt: string): WireGateDecisions {
	if (
		!isRecord(value) ||
		!exactKeys(value, ["version", "generatedAt", "available", "decisions", "truncated", "unverifiable"])
	) {
		throw new ClioDecisionsProjectionError("Clio Coder returned an invalid gate decision snapshot.");
	}
	const generatedAt = timestamp(value.generatedAt);
	const unverifiable = count(value.unverifiable);
	if (
		value.version !== 1 || generatedAt === null || unverifiable === null ||
		typeof value.available !== "boolean" || typeof value.truncated !== "boolean" ||
		!Array.isArray(value.decisions) || value.decisions.length > MAX_WIRE_GATE_DECISIONS
	) {
		throw new ClioDecisionsProjectionError("Clio Coder returned an invalid gate decision snapshot.");
	}
	const decisions = value.decisions.map(projectDecision);
	if (new Set(decisions.map((decision) => decision.id)).size !== decisions.length) {
		throw new ClioDecisionsProjectionError("Clio Coder returned duplicate gate decision identities.");
	}
	// An installation with no decision store has nothing to report and nothing to
	// have failed verification, so a snapshot claiming either is describing a
	// store it also says does not exist.
	if (!value.available && (decisions.length > 0 || value.truncated || unverifiable > 0)) {
		throw new ClioDecisionsProjectionError("Clio Coder reported gate decisions from a store it says is absent.");
	}
	return {
		scope: "installation",
		inspectedAt,
		generatedAt,
		available: value.available,
		decisions,
		truncated: value.truncated,
		unverifiable,
	};
}

export class ClioCliDecisionsInspector implements ClioDecisionsInspector {
	readonly #runner: ClioReadCommandRunner;
	readonly #now: () => number;
	readonly #log: (message: string) => void;

	constructor(options: ClioCliDecisionsInspectorOptions = {}) {
		this.#runner = new ClioReadCommandRunner({
			executable: options.executable,
			prefixArgs: options.prefixArgs,
			timeoutMs: options.timeoutMs ?? DEFAULT_DECISIONS_TIMEOUT_MS,
			maximumStdoutBytes: options.maximumStdoutBytes ?? MAX_DECISIONS_STDOUT_BYTES,
			maximumStderrBytes: options.maximumStderrBytes ?? MAX_DECISIONS_STDERR_BYTES,
		});
		this.#now = options.now ?? Date.now;
		this.#log = options.log ?? (() => undefined);
	}

	async inspect(cwd: string): Promise<WireGateDecisions> {
		let parsed: unknown;
		try {
			parsed = await this.#runner.runJson(resolve(cwd), ["fleet", "decisions", "--json"]);
		} catch (error) {
			if (!(error instanceof ClioReadCommandError)) throw error;
			if (error.code === "spawn") {
				throw new ClioDecisionsInspectError("not-ready", "The GUI could not start Clio Coder's gate decision reader.");
			}
			if (error.code === "timeout") {
				throw new ClioDecisionsInspectError("not-ready", "Clio Coder's gate decision read did not finish in time.");
			}
			if (error.code === "exit") {
				const unsupported =
					/(?:unknown|unsupported).{0,32}(?:command|subcommand|decisions)|decisions.{0,32}(?:unknown|unsupported)/iu
						.test(error.diagnostic);
				this.#log(`Clio Coder gate decision reader exited with code ${error.exitCode ?? "unknown"}.`);
				throw new ClioDecisionsInspectError(
					unsupported ? "unsupported" : "not-ready",
					unsupported
						? "This Clio Coder version does not provide sealed gate decisions."
						: "Clio Coder could not read its sealed gate decisions.",
				);
			}
			throw new ClioDecisionsInspectError("internal", "Clio Coder returned an invalid or oversized decision snapshot.");
		}
		try {
			return projectGateDecisions(parsed, new Date(this.#now()).toISOString());
		} catch (error) {
			if (!(error instanceof ClioDecisionsProjectionError)) throw error;
			this.#log("Clio Coder gate decision projection rejected an incompatible snapshot.");
			throw new ClioDecisionsInspectError(
				"internal",
				"Clio Coder's sealed gate decisions are not compatible with this GUI build.",
			);
		}
	}
}

/**
 * Bounded adapter for Clio Coder's external coding agent detection.
 *
 * `configure --interop` is an interactive review that writes delegation peers
 * into settings, so it is not a transport this host can invoke. This adapter
 * runs only the fixed `interop inspect --json`, whose argv is not a surface,
 * and validates the already-narrowed payload again before it reaches the
 * browser.
 *
 * The read runs no foreign executable. Detection can probe `<bin> --version`
 * and this command deliberately does not, so a refresh in the browser cannot
 * become "execute every coding agent installed on this machine". A version
 * still crosses, as the last one Clio Coder observed for the same binary.
 *
 * Resolved binaries and the directories these agents own under the operator's
 * home never cross. Whether a directory exists does; where it is does not.
 */

import { resolve } from "node:path";
import { ClioReadCommandError, ClioReadCommandRunner } from "./clio-read-command.ts";
import {
	type CommandErrorCode,
	INTEROP_AGENT_IDS,
	INTEROP_DECISIONS,
	INTEROP_PRESENCES,
	MAX_WIRE_INTEROP_AGENTS,
	type WireInteropAgent,
	type WireInteropInspection,
} from "./src/protocol.ts";

export const DEFAULT_INTEROP_INSPECT_TIMEOUT_MS = 10_000;
export const MAX_INTEROP_INSPECT_STDOUT_BYTES = 256 * 1024;
export const MAX_INTEROP_INSPECT_STDERR_BYTES = 64 * 1024;
const encoder = new TextEncoder();

export interface ClioInteropInspector {
	inspect(cwd: string): Promise<WireInteropInspection>;
}

export interface ClioCliInteropInspectorOptions {
	readonly executable?: string;
	/** Test/development prefix only. Browser commands can never influence argv. */
	readonly prefixArgs?: readonly string[];
	readonly timeoutMs?: number;
	readonly maximumStdoutBytes?: number;
	readonly maximumStderrBytes?: number;
	readonly now?: () => number;
	readonly log?: (message: string) => void;
}

export class ClioInteropProjectionError extends Error {
	override readonly name = "ClioInteropProjectionError";
}

export class ClioInteropInspectError extends Error {
	override readonly name = "ClioInteropInspectError";

	constructor(readonly code: CommandErrorCode, message: string) {
		super(message);
	}
}

function projectionError(message: string): never {
	throw new ClioInteropProjectionError(message);
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
	return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1_000 ? value as number : null;
}

function isOneOf<const T extends readonly string[]>(value: unknown, choices: T): value is T[number] {
	return typeof value === "string" && choices.includes(value as T[number]);
}

/**
 * A version string, and only a version string.
 *
 * Detection takes the first version-shaped token out of a foreign agent's
 * `--version` output, so the value is already narrow. Requiring the shape again
 * here means an agent that starts printing a banner cannot spend that output as
 * a label in this GUI.
 */
const VERSION_SHAPE = /^\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/u;

function projectAgent(value: unknown): WireInteropAgent {
	const keys = [
		"id",
		"label",
		"presence",
		"version",
		"hasUserDirectory",
		"acp",
		"adapter",
		"configured",
		"decision",
		"decidedAt",
		"decisionStale",
		"proposed",
		"needsNetworkInstall",
	] as const;
	if (!isRecord(value) || !exactKeys(value, keys)) {
		return projectionError("Clio Coder returned an invalid detected-agent row.");
	}
	const label = text(value.label, 64);
	const version = nullableText(value.version, 64);
	const decidedAt = value.decidedAt === null ? null : timestamp(value.decidedAt);
	if (
		label === null || version === undefined ||
		(value.decidedAt !== null && decidedAt === null) ||
		!isOneOf(value.id, INTEROP_AGENT_IDS) ||
		!isOneOf(value.presence, INTEROP_PRESENCES) ||
		(value.adapter !== null && !isOneOf(value.adapter, INTEROP_PRESENCES)) ||
		(value.decision !== null && !isOneOf(value.decision, INTEROP_DECISIONS)) ||
		typeof value.hasUserDirectory !== "boolean" || typeof value.acp !== "boolean" ||
		typeof value.configured !== "boolean" || typeof value.decisionStale !== "boolean" ||
		typeof value.proposed !== "boolean" || typeof value.needsNetworkInstall !== "boolean"
	) return projectionError("Clio Coder returned an invalid detected-agent row.");
	if (version !== null && !VERSION_SHAPE.test(version)) {
		return projectionError("Clio Coder returned an agent version that is not a version.");
	}
	// Only a kind with an ACP recipe has an adapter to report on.
	if (value.acp !== (value.adapter !== null)) {
		return projectionError("Clio Coder returned an adapter state that does not track its ACP recipe.");
	}
	// A decision and its stamp are written together.
	if ((value.decision === null) !== (decidedAt === null)) {
		return projectionError("Clio Coder returned a decision stamp without the decision it belongs to.");
	}
	if (value.decisionStale && value.decision === null) {
		return projectionError("Clio Coder called a decision stale that was never taken.");
	}
	// Clio Coder offers only an installed ACP peer that is neither wired nor
	// settled against the facts as they now stand.
	if (value.proposed && (value.presence !== "present" || !value.acp || value.configured)) {
		return projectionError("Clio Coder offered an agent as a proposal it does not qualify for.");
	}
	if (value.needsNetworkInstall && !value.acp) {
		return projectionError("Clio Coder reported an adapter install for a kind with no recipe.");
	}
	return {
		id: value.id,
		label,
		presence: value.presence,
		version,
		hasUserDirectory: value.hasUserDirectory,
		acp: value.acp,
		adapter: value.adapter as WireInteropAgent["adapter"],
		configured: value.configured,
		decision: value.decision as WireInteropAgent["decision"],
		decidedAt,
		decisionStale: value.decisionStale,
		proposed: value.proposed,
		needsNetworkInstall: value.needsNetworkInstall,
	};
}

export function projectInteropInspection(value: unknown, inspectedAt: string): WireInteropInspection {
	if (
		!isRecord(value) ||
		!exactKeys(value, ["version", "generatedAt", "detectedAt", "knownKinds", "agents"])
	) {
		throw new ClioInteropProjectionError("Clio Coder returned an invalid detected-agent inventory.");
	}
	const generatedAt = timestamp(value.generatedAt);
	const detectedAt = timestamp(value.detectedAt);
	const knownKinds = count(value.knownKinds);
	if (
		value.version !== 1 || generatedAt === null || detectedAt === null || knownKinds === null ||
		!Array.isArray(value.agents) || value.agents.length > MAX_WIRE_INTEROP_AGENTS
	) {
		throw new ClioInteropProjectionError("Clio Coder returned an invalid detected-agent inventory.");
	}
	const agents = value.agents.map(projectAgent);
	if (new Set(agents.map((agent) => agent.id)).size !== agents.length) {
		throw new ClioInteropProjectionError("Clio Coder returned duplicate detected-agent identities.");
	}
	// Detection walks the registry once and drops a kind with nothing to report.
	if (agents.length > knownKinds) {
		throw new ClioInteropProjectionError("Clio Coder reported more agents than it knows kinds.");
	}
	return { scope: "installation", inspectedAt, generatedAt, detectedAt, knownKinds, agents };
}

export class ClioCliInteropInspector implements ClioInteropInspector {
	readonly #runner: ClioReadCommandRunner;
	readonly #now: () => number;
	readonly #log: (message: string) => void;

	constructor(options: ClioCliInteropInspectorOptions = {}) {
		this.#runner = new ClioReadCommandRunner({
			executable: options.executable,
			prefixArgs: options.prefixArgs,
			timeoutMs: options.timeoutMs ?? DEFAULT_INTEROP_INSPECT_TIMEOUT_MS,
			maximumStdoutBytes: options.maximumStdoutBytes ?? MAX_INTEROP_INSPECT_STDOUT_BYTES,
			maximumStderrBytes: options.maximumStderrBytes ?? MAX_INTEROP_INSPECT_STDERR_BYTES,
		});
		this.#now = options.now ?? Date.now;
		this.#log = options.log ?? (() => undefined);
	}

	async inspect(cwd: string): Promise<WireInteropInspection> {
		let parsed: unknown;
		try {
			parsed = await this.#runner.runJson(resolve(cwd), ["interop", "inspect", "--json"]);
		} catch (error) {
			if (!(error instanceof ClioReadCommandError)) throw error;
			if (error.code === "spawn") {
				throw new ClioInteropInspectError("not-ready", "The GUI could not start Clio Coder's agent detector.");
			}
			if (error.code === "timeout") {
				throw new ClioInteropInspectError("not-ready", "Clio Coder's agent detection did not finish in time.");
			}
			if (error.code === "exit") {
				const unsupported =
					/(?:unknown|unsupported).{0,32}(?:command|subcommand|interop)|interop.{0,32}(?:unknown|unsupported)/iu
						.test(error.diagnostic);
				this.#log(`Clio Coder agent detector exited with code ${error.exitCode ?? "unknown"}.`);
				throw new ClioInteropInspectError(
					unsupported ? "unsupported" : "not-ready",
					unsupported
						? "This Clio Coder version does not provide external agent detection."
						: "Clio Coder could not detect the external coding agents on this machine.",
				);
			}
			throw new ClioInteropInspectError("internal", "Clio Coder returned an invalid or oversized agent inventory.");
		}
		try {
			return projectInteropInspection(parsed, new Date(this.#now()).toISOString());
		} catch (error) {
			if (!(error instanceof ClioInteropProjectionError)) throw error;
			this.#log("Clio Coder agent projection rejected an incompatible inventory.");
			throw new ClioInteropInspectError(
				"internal",
				"Clio Coder's agent detection is not compatible with this GUI build.",
			);
		}
	}
}

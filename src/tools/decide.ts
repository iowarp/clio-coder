import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import type { DecisionBoardStore } from "../domains/session/decision-board.js";
import { decisionRef } from "../domains/session/entries.js";
import type { ToolResult, ToolSpec } from "./registry.js";

/**
 * The model's own design decisions, recorded on the session decision board
 * beside the operator's `ask_user` answers. A `decide` call appends one
 * `decisionLedger` entry with `origin: "agent"` and one `DecisionRecord` with
 * `source: "agent"`, the alternatives the model rejected, and why. Dispatch
 * seals every active decision's ref onto the run envelope and receipt, and
 * the commit seams turn the same refs into `Clio-Decision:` trailers, so a
 * receipt or a commit names the choices it was made under.
 */

export const DECIDE_CAPS = Object.freeze({
	keyBytes: 64,
	valueBytes: 512,
	alternatives: 6,
	alternativeBytes: 256,
	rationaleBytes: 1024,
	labelBytes: 128,
});

const KEBAB_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export interface DecideToolDeps {
	decisionBoard?: DecisionBoardStore;
}

function utf8Bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function boundedText(value: unknown, field: string, cap: number): string | Error {
	if (typeof value !== "string") return new Error(`decide: ${field} must be a string`);
	const trimmed = value.trim();
	if (trimmed.length === 0) return new Error(`decide: ${field} is required`);
	if (utf8Bytes(trimmed) > cap) return new Error(`decide: ${field} exceeds the ${cap}-byte cap`);
	return trimmed;
}

function boundedAlternatives(value: unknown): string[] | Error {
	if (!Array.isArray(value) || value.length === 0) {
		return new Error("decide: alternatives must list at least one option you rejected");
	}
	if (value.length > DECIDE_CAPS.alternatives) {
		return new Error(`decide: alternatives exceeds the ${DECIDE_CAPS.alternatives}-entry cap`);
	}
	const alternatives: string[] = [];
	for (const [index, entry] of value.entries()) {
		const text = boundedText(entry, `alternatives[${index}]`, DECIDE_CAPS.alternativeBytes);
		if (text instanceof Error) return text;
		alternatives.push(text);
	}
	return alternatives;
}

export function createDecideTool(deps: DecideToolDeps = {}): ToolSpec {
	return {
		name: ToolNames.Decide,
		description:
			"Record a design decision you made between two or more viable options, with the alternatives you rejected and why. Call it before implementing the choice; a later call with the same key supersedes the earlier record.",
		parameters: Type.Object({
			key: Type.String({
				description: `Stable kebab-case name for the decision, e.g. "cache-key-shape" (at most ${DECIDE_CAPS.keyBytes} bytes).`,
			}),
			value: Type.String({ description: `The option you chose (at most ${DECIDE_CAPS.valueBytes} bytes).` }),
			alternatives: Type.Array(Type.String(), {
				description: `Options you considered and rejected, 1 to ${DECIDE_CAPS.alternatives} entries.`,
			}),
			rationale: Type.String({
				description: `Why the chosen option won over the alternatives (at most ${DECIDE_CAPS.rationaleBytes} bytes).`,
			}),
			label: Type.Optional(Type.String({ description: "Short human-readable title for the decision." })),
		}),
		// Read class on purpose: the only effect is one session-ledger append,
		// so it must stay available at every autonomy level without a prompt.
		baseActionClass: "read",
		executionMode: "sequential",
		async run(args): Promise<ToolResult> {
			const key = boundedText(args.key, "key", DECIDE_CAPS.keyBytes);
			if (key instanceof Error) return { kind: "error", message: key.message };
			if (!KEBAB_KEY.test(key)) {
				return { kind: "error", message: "decide: key must be kebab-case (lowercase letters, digits, single hyphens)" };
			}
			const value = boundedText(args.value, "value", DECIDE_CAPS.valueBytes);
			if (value instanceof Error) return { kind: "error", message: value.message };
			const alternatives = boundedAlternatives(args.alternatives);
			if (alternatives instanceof Error) return { kind: "error", message: alternatives.message };
			const rationale = boundedText(args.rationale, "rationale", DECIDE_CAPS.rationaleBytes);
			if (rationale instanceof Error) return { kind: "error", message: rationale.message };
			let label: string | undefined;
			if (args.label !== undefined && args.label !== null) {
				const bounded = boundedText(args.label, "label", DECIDE_CAPS.labelBytes);
				if (bounded instanceof Error) return { kind: "error", message: bounded.message };
				label = bounded;
			}
			if (deps.decisionBoard === undefined) {
				return { kind: "error", message: "decide: no session decision board is available in this context" };
			}
			let outcome: ReturnType<DecisionBoardStore["recordAgentDecision"]>;
			try {
				outcome = deps.decisionBoard.recordAgentDecision({
					key,
					value,
					alternatives,
					rationale,
					...(label !== undefined ? { label } : {}),
				});
			} catch (error) {
				return { kind: "error", message: error instanceof Error ? error.message : String(error) };
			}
			const ref = decisionRef(outcome.entry.interviewId, key);
			const supersededNote =
				outcome.superseded === null
					? ""
					: ` (supersedes ${decisionRef(outcome.superseded.interviewId, outcome.superseded.key)})`;
			return {
				kind: "ok",
				output: `decision recorded: ${key} = ${value} [${ref}]${supersededNote}\n`,
				details: {
					decision: {
						ref,
						key,
						value,
						alternatives,
						rationale,
						...(label !== undefined ? { label } : {}),
						...(outcome.superseded !== null
							? { superseded: decisionRef(outcome.superseded.interviewId, outcome.superseded.key) }
							: {}),
					},
				},
			};
		},
	};
}

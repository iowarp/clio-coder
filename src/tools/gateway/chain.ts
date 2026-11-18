import {
	carriesToolResultNote,
	recordedToolResultNotes,
	TOOL_RESULT_HOST_NOTES_KEY,
} from "../../core/reminder-framing.js";
import { skillActivationFromToolDetails } from "../../core/skill-activation.js";
import { ToolNames } from "../../core/tool-names.js";
import type { ToolInvokeOptions, ToolResult, ToolSpec } from "../registry.js";
import { boundedToolResultExcerpt, toolResultContextText } from "../result-disposition.js";
import { CHAIN_OUTPUT_TRUNCATED_MARKER } from "../surface.js";
import { byteLength, truncateUtf8 } from "../truncate-utf8.js";

export const CHAIN_MAX_STEPS = 16;
const CHAIN_RESULT_BYTES = 32 * 1024;

interface Step {
	id: string;
	capability: string;
	args: Record<string, unknown>;
	after: string[];
}

export interface ChainDeps {
	getSpec(name: string): ToolSpec | undefined;
	call(name: string, args: Record<string, unknown>, options?: ToolInvokeOptions): Promise<ToolResult>;
}

export type ChainStatus = "complete" | "paused" | "failed";

/**
 * Each step's byte allowance from the aggregate budget, by max-min fairness:
 * a step under an equal share of what is left keeps its whole text and its
 * unused bytes go to the larger steps. Every step fits whole when the sizes
 * sum within the budget, and the allowances never sum past it.
 */
function chainStepAllowances(sizes: ReadonlyArray<number>, budget: number): number[] {
	const allowances = [...sizes];
	const order = sizes.map((_, index) => index).sort((a, b) => (sizes[a] ?? 0) - (sizes[b] ?? 0) || a - b);
	let remaining = budget;
	order.forEach((index, rank) => {
		const share = Math.floor(remaining / (order.length - rank));
		const allowance = Math.min(sizes[index] ?? 0, share);
		allowances[index] = allowance;
		remaining -= allowance;
	});
	return allowances;
}

/** One settled step as the model reads it: raw output under its header, never JSON-escaped. */
export interface ChainStepRow {
	id: string;
	capability: string;
	kind: ToolResult["kind"];
	/** The step's output after the per-step allowance, or the whole activation projection. */
	output: string;
	truncated: boolean;
}

/**
 * The line a settled step's raw output follows. Compaction proves a chained
 * skill load was fully visible by finding the child body directly under this
 * header (`historicalSkillReceipt` in src/domains/session/compaction/compact.ts),
 * so a format change here must move there too.
 */
function chainStepHeader(row: Pick<ChainStepRow, "id" | "capability" | "kind" | "truncated">): string {
	// Step ids are validated; a capability is free text, and a line break in it
	// would open a forged section.
	const capability = row.capability.replace(/\s+/gu, " ");
	return `### step ${row.id} (${capability}): ${row.kind}${row.truncated ? ", truncated" : ""}`;
}

/**
 * The aggregate text: a status line, the boundary that stopped scheduling,
 * then every settled step in plan order. File contents and command output
 * stay byte-exact so the model can read them and quote them into an edit.
 */
export function renderChainOutput(input: {
	status: ChainStatus;
	total: number;
	rows: ReadonlyArray<ChainStepRow>;
	pending: ReadonlyArray<string>;
	boundary?: string;
}): string {
	const noun = input.total === 1 ? "step" : "steps";
	const pending = input.pending.length > 0 ? ` Pending: ${input.pending.join(", ")}.` : "";
	const head = [`Chain ${input.status}: ${input.rows.length} of ${input.total} ${noun} settled.${pending}`];
	if (input.boundary !== undefined) head.push(`Boundary: ${input.boundary}`);
	const sections = input.rows.map((row) => `${chainStepHeader(row)}\n${row.output}`);
	return [head.join("\n"), ...sections].join("\n\n");
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function references(value: unknown, depth = 0): string[] {
	if (depth > 32) throw new Error("argument nesting exceeds 32");
	if (Array.isArray(value)) return value.flatMap((entry) => references(entry, depth + 1));
	if (!record(value)) return [];
	if ("$from" in value) {
		if (
			typeof value.$from !== "string" ||
			!Array.isArray(value.path) ||
			value.path.some((part) => typeof part !== "string") ||
			Object.keys(value).some((key) => key !== "$from" && key !== "path")
		) {
			throw new Error("a result reference must be {$from:<step id>,path:[<keys>]}");
		}
		return [value.$from];
	}
	return Object.values(value).flatMap((entry) => references(entry, depth + 1));
}

const STEP_KEYS = ["id", "capability", "args", "after"];
const STEP_ID = /^[a-z][a-z0-9_-]{0,31}$/u;

function shapeOf(value: unknown): string {
	return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

/** A step's args, accepting the JSON-encoded object some model families send in place of the object. */
function stepArgs(value: unknown, at: string): Record<string, unknown> {
	if (value === undefined) throw new Error(`${at}.args is missing`);
	if (record(value)) return value;
	if (typeof value === "string") {
		let parsed: unknown;
		try {
			parsed = JSON.parse(value);
		} catch {
			/* Reported below. */
		}
		if (record(parsed)) return parsed;
		throw new Error(`${at}.args must be an object (got a string that is not a JSON object)`);
	}
	throw new Error(`${at}.args must be an object (got ${shapeOf(value)})`);
}

function parseSteps(value: unknown): Step[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > CHAIN_MAX_STEPS) {
		throw new Error(`steps must contain 1..${CHAIN_MAX_STEPS} operations`);
	}
	const parsed = value.map((entry, index): Omit<Step, "id"> & { id: string | undefined } => {
		const at = `steps[${index}]`;
		if (!record(entry)) throw new Error(`${at} must be an object (got ${shapeOf(entry)})`);
		const unknown = Object.keys(entry).find((key) => !STEP_KEYS.includes(key));
		if (unknown !== undefined)
			throw new Error(`${at} has unknown key "${unknown}"; a step takes id, capability, args, after`);
		if (entry.id !== undefined && (typeof entry.id !== "string" || !STEP_ID.test(entry.id)))
			throw new Error(`${at}.id must match ${STEP_ID.source}`);
		if (typeof entry.capability !== "string" || !entry.capability.trim())
			throw new Error(`${at}.capability must be a non-empty string`);
		const args = stepArgs(entry.args, at);
		if (entry.after !== undefined && (!Array.isArray(entry.after) || entry.after.some((id) => typeof id !== "string")))
			throw new Error(`${at}.after must be an array of step ids`);
		if (entry.capability.trim() === ToolNames.Gateway) throw new Error("nested gateways are not chain steps");
		if (entry.capability.trim() === ToolNames.SelfCompact)
			throw new Error("self_compact must be called alone with gateway op=call");
		return {
			id: entry.id as string | undefined,
			capability: entry.capability.trim(),
			args,
			after: [...new Set([...((entry.after as string[]) ?? []), ...references(args)])],
		};
	});
	// A step without an id gets one by position only while nothing can depend on it.
	const linked = parsed.some((step) => step.after.length > 0);
	const used = new Set(parsed.flatMap((step) => (step.id === undefined ? [] : [step.id])));
	const steps = parsed.map((step, index): Step => {
		if (step.id !== undefined) return { ...step, id: step.id };
		if (linked)
			throw new Error(`steps[${index}].id is missing; every step needs an id when any step uses after or $from`);
		let id = `s${index + 1}`;
		for (let n = 2; used.has(id); n++) id = `s${index + 1}_${n}`;
		used.add(id);
		return { ...step, id };
	});
	const seen = new Map<string, number>();
	steps.forEach((step, index) => {
		const first = seen.get(step.id);
		if (first !== undefined) throw new Error(`steps[${index}].id "${step.id}" repeats steps[${first}].id`);
		seen.set(step.id, index);
	});
	steps.forEach((step, index) => {
		const unknown = step.after.find((id) => !seen.has(id));
		if (unknown !== undefined) throw new Error(`steps[${index}] depends on unknown step id "${unknown}"`);
	});
	const visited = new Set<string>();
	while (visited.size < steps.length) {
		const ready = steps.filter((step) => !visited.has(step.id) && step.after.every((id) => visited.has(id)));
		if (ready.length === 0) throw new Error("dependency cycle");
		for (const step of ready) visited.add(step.id);
	}
	return steps;
}

function resultValue(result: ToolResult): Record<string, unknown> {
	const output = toolResultContextText(result);
	let json: unknown;
	try {
		json = JSON.parse(output);
	} catch {
		/* Text results are still addressable as output. */
	}
	return { output, details: result.details ?? {}, ...(json !== undefined ? { json } : {}) };
}

function bind(value: unknown, results: ReadonlyMap<string, ToolResult>): unknown {
	if (Array.isArray(value)) return value.map((entry) => bind(entry, results));
	if (!record(value)) return value;
	if (typeof value.$from === "string") {
		const result = results.get(value.$from);
		if (result?.kind !== "ok") throw new Error(`no successful result for ${value.$from}`);
		let selected: unknown = resultValue(result);
		for (const key of value.path as string[]) {
			if (
				(!record(selected) && !Array.isArray(selected)) ||
				["__proto__", "prototype", "constructor"].includes(key) ||
				!Object.hasOwn(selected, key)
			)
				throw new Error(`missing result path for ${value.$from}`);
			selected = (selected as Record<string, unknown>)[key];
		}
		return structuredClone(selected);
	}
	return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, bind(entry, results)]));
}

/** A bounded dependency plan. Every operation retains its own validation, admission, and hooks. */
export async function runGatewayChain(
	value: unknown,
	deps: ChainDeps,
	options?: ToolInvokeOptions,
): Promise<ToolResult> {
	let steps: Step[];
	try {
		steps = parseSteps(value);
	} catch (error) {
		return {
			kind: "error",
			message: `gateway: invalid chain: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	const results = new Map<string, ToolResult>();
	const executedArgs = new Map<string, Record<string, unknown>>();
	/** Steps whose `$from` binding failed: they settled as failures without ever running. */
	const bindingErrors = new Map<string, string>();
	let boundary: string | undefined;
	let terminal = false;
	let activationDetails: Record<string, unknown> | undefined;
	const parallel = (step: Step): boolean => {
		const spec = deps.getSpec(step.capability);
		// Unknown/MCP operations stay serial. Activation changes the next step's
		// permission surface; it must not race other operations, even though the
		// context tool's ordinary observation modes support concurrency.
		return (
			spec?.executionMode === "parallel" &&
			spec.baseActionClass === "read" &&
			spec.safetyCall === undefined &&
			step.capability !== ToolNames.Context
		);
	};
	/** Each step's own span, so `run --json` gives a chain step's end frame the duration a direct call's carries. */
	const durations = new Map<string, number>();
	const execute = async (step: Step): Promise<void> => {
		let args: Record<string, unknown>;
		try {
			args = bind(step.args, results) as Record<string, unknown>;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			bindingErrors.set(step.id, message);
			results.set(step.id, { kind: "error", message });
			boundary = `step ${step.id} failed; review its evidence before continuing`;
			return;
		}
		const started = performance.now();
		try {
			executedArgs.set(step.id, args);
			const result = await deps.call(step.capability, args, {
				...options,
				// Each step is a distinct operation, so loop/budget accounting must
				// count it even though the outer gateway was already counted.
				nested: false,
				...(options?.toolCallId ? { toolCallId: `${options.toolCallId}:${step.id}` } : {}),
			});
			results.set(step.id, result);
			if (result.kind === "error") boundary = `step ${step.id} failed; review its evidence before continuing`;
			if (result.kind === "ok" && result.terminate === true) {
				terminal = true;
				boundary = `step ${step.id} completed the turn`;
			}
			if (
				step.capability === ToolNames.Context &&
				result.kind === "ok" &&
				skillActivationFromToolDetails(result.details)
			) {
				activationDetails = result.details;
				boundary = `skill loaded by ${step.id}; apply its instructions before continuing`;
			}
			if (step.capability === ToolNames.AskUser && result.kind === "ok")
				boundary = `operator replied to ${step.id}; reason from the answer before continuing`;
		} catch (error) {
			results.set(step.id, { kind: "error", message: error instanceof Error ? error.message : String(error) });
			boundary = `step ${step.id} failed; review its evidence before continuing`;
		} finally {
			durations.set(step.id, Math.round(Math.max(0, performance.now() - started)));
		}
	};
	while (results.size < steps.length && boundary === undefined) {
		if (options?.signal?.aborted) {
			boundary = "chain cancelled";
			break;
		}
		const ready = steps.filter(
			(step) => !results.has(step.id) && step.after.every((id) => results.get(id)?.kind === "ok"),
		);
		const first = ready[0];
		if (!first) break;
		if (parallel(first)) await Promise.all(ready.filter(parallel).slice(0, 4).map(execute));
		else await execute(first);
	}
	// The context tool already budgets activation instructions. Preserve that
	// projection so it can be read before another operation; the other settled
	// steps share the aggregate budget, measured before anything is cut.
	const exempt = (step: Step, result: ToolResult): boolean =>
		step.capability === ToolNames.Context && activationDetails === result.details;
	const budgeted = steps.flatMap((step) => {
		const result = results.get(step.id);
		return result === undefined || exempt(step, result) ? [] : [step.id];
	});
	const allowances = chainStepAllowances(
		budgeted.map((id) => byteLength(toolResultContextText(results.get(id) as ToolResult))),
		CHAIN_RESULT_BYTES,
	);
	const allowanceOf = new Map(budgeted.map((id, index) => [id, allowances[index] ?? 0]));
	const markerBytes = byteLength(CHAIN_OUTPUT_TRUNCATED_MARKER);
	const projectedOutput = (step: Step, result: ToolResult): string => {
		const output = toolResultContextText(result);
		const allowance = allowanceOf.get(step.id);
		if (allowance === undefined || byteLength(output) <= allowance) return output;
		// A failure's diagnostic (the assertion, the file and line) sits at its end.
		if (result.kind === "error") return boundedToolResultExcerpt(output, allowance);
		return truncateUtf8(output, Math.max(0, allowance - markerBytes), CHAIN_OUTPUT_TRUNCATED_MARKER);
	};
	const rows = steps.flatMap((step): ChainStepRow[] => {
		const result = results.get(step.id);
		if (result === undefined) return [];
		const output = projectedOutput(step, result);
		return [
			{
				id: step.id,
				capability: step.capability,
				kind: result.kind,
				output,
				truncated: output !== toolResultContextText(result),
			},
		];
	});
	const pending = steps.filter((step) => !results.has(step.id)).map((step) => step.id);
	const failed = rows.some((row) => row.kind === "error");
	const output = renderChainOutput({
		status: failed ? "failed" : terminal ? "complete" : boundary ? "paused" : "complete",
		total: steps.length,
		rows,
		pending,
		...(boundary ? { boundary } : {}),
	});
	// Each step's notes were appended and recorded by its own nested registry
	// call; the chain hands on those its projected section still carries, and
	// the registry keeps them only because it delegated this chain itself.
	const hostNotes = rows.flatMap((row) =>
		recordedToolResultNotes(results.get(row.id)?.details).filter((note) => carriesToolResultNote(row.output, note)),
	);
	const details = {
		...activationDetails,
		...(activationDetails ? { capability: ToolNames.Context } : {}),
		...(hostNotes.length > 0 ? { [TOOL_RESULT_HOST_NOTES_KEY]: hostNotes } : {}),
		op: "chain",
		// `truncated` lets a consumer tell a complete step from a cut one
		// without reading the model-facing text.
		steps: rows.map(({ id, capability, kind, truncated }) => ({ id, capability, kind, truncated })),
		pending,
		chainResults: [...results].flatMap(([id, result]): Array<Record<string, unknown>> => {
			const step = steps.find((candidate) => candidate.id === id);
			if (!step) return [];
			const bindingError = bindingErrors.get(step.id);
			if (bindingError !== undefined) {
				// A failed binding is a settled failure that never ran. It carries no
				// `args`, because no arguments were ever resolved or executed, so every
				// consumer that counts executed operations skips it; displays and
				// eviction still see the failure through `bindingError`.
				return [
					{
						id: step.id,
						capability: step.capability,
						isError: true,
						bindingError,
						durationMs: 0,
						requestedArgs: step.args,
						result: {
							content: [{ type: "text", text: projectedOutput(step, result) }],
							details: { kind: "error" },
						},
					},
				];
			}
			const args = executedArgs.get(step.id);
			if (!result || !args) return [];
			return [
				{
					id: step.id,
					capability: step.capability,
					args,
					isError: result.kind === "error",
					durationMs: durations.get(step.id) ?? 0,
					result: {
						content: [{ type: "text", text: projectedOutput(step, result) }],
						details: { ...result.details, kind: result.kind },
					},
				},
			];
		}),
	};
	if (failed) return { kind: "error", message: output, details };
	return {
		kind: "ok",
		output,
		details,
		images: [...results.values()].flatMap((result) => (result.kind === "ok" ? (result.images ?? []) : [])),
		...(terminal ? { terminate: true } : {}),
	};
}

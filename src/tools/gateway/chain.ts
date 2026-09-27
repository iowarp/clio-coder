import { skillActivationFromToolDetails } from "../../core/skill-activation.js";
import { ToolNames } from "../../core/tool-names.js";
import type { ToolInvokeOptions, ToolResult, ToolSpec } from "../registry.js";
import { toolResultContextText } from "../result-disposition.js";
import { CHAIN_OUTPUT_TRUNCATED_MARKER } from "../surface.js";
import { truncateUtf8 } from "../truncate-utf8.js";

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

function parseSteps(value: unknown): Step[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > CHAIN_MAX_STEPS) {
		throw new Error(`steps must contain 1..${CHAIN_MAX_STEPS} operations`);
	}
	const steps = value.map((entry): Step => {
		if (
			!record(entry) ||
			typeof entry.id !== "string" ||
			!/^[a-z][a-z0-9_-]{0,31}$/u.test(entry.id) ||
			typeof entry.capability !== "string" ||
			!entry.capability.trim() ||
			!record(entry.args) ||
			(entry.after !== undefined && (!Array.isArray(entry.after) || entry.after.some((id) => typeof id !== "string"))) ||
			Object.keys(entry).some((key) => !["id", "capability", "args", "after"].includes(key))
		) {
			throw new Error("each step needs id, capability, args, and optional after:[ids]");
		}
		if (entry.capability.trim() === ToolNames.Gateway) throw new Error("nested gateways are not chain steps");
		if (entry.capability.trim() === ToolNames.SelfCompact)
			throw new Error("self_compact must be called alone with gateway op=call");
		return {
			id: entry.id,
			capability: entry.capability.trim(),
			args: entry.args,
			after: [...new Set([...((entry.after as string[]) ?? []), ...references(entry.args)])],
		};
	});
	const ids = new Set(steps.map((step) => step.id));
	if (ids.size !== steps.length) throw new Error("step ids must be unique");
	for (const step of steps) {
		if (step.after.some((id) => !ids.has(id))) throw new Error(`unknown dependency for ${step.id}`);
	}
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
	const allowance = Math.floor(CHAIN_RESULT_BYTES / Math.max(1, results.size));
	const projectedOutput = (step: Step, result: ToolResult): string => {
		const output = toolResultContextText(result);
		// The context tool already budgets activation instructions. Preserve
		// that projection so it can be read before another operation.
		if (step.capability === ToolNames.Context && activationDetails === result.details) return output;
		return truncateUtf8(output, allowance, CHAIN_OUTPUT_TRUNCATED_MARKER);
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
	const details = {
		...activationDetails,
		...(activationDetails ? { capability: ToolNames.Context } : {}),
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

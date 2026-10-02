import { discoveryScore } from "../../core/harness-discovery.js";
import { validateEngineToolArguments } from "../../engine/ai.js";
import type { ToolSpec, ToolUsageExample } from "../registry.js";
import { toolSpecPlacement } from "../surface.js";

const EXAMPLE_MAX_BYTES = 768;
const EXAMPLES_PER_TOOL = 8;
const examplesBySpec = new WeakMap<ToolSpec, ReadonlyArray<ToolUsageExample>>();

/** Stale examples must disappear rather than teach a call the live schema rejects. */
function validatedExamples(spec: ToolSpec): ReadonlyArray<ToolUsageExample> {
	const cached = examplesBySpec.get(spec);
	if (cached) return cached;
	const examples: ToolUsageExample[] = [];
	for (const example of spec.metadata?.examples ?? []) {
		if (examples.length >= EXAMPLES_PER_TOOL) break;
		try {
			const serialized = JSON.stringify(example);
			if (Buffer.byteLength(serialized) > EXAMPLE_MAX_BYTES || !example.goal.trim()) continue;
			const copy = JSON.parse(serialized) as ToolUsageExample;
			const args = validateEngineToolArguments(
				{ name: spec.name, description: spec.description, parameters: spec.parameters },
				{ type: "toolCall", id: "example", name: spec.name, arguments: copy.args },
			) as Record<string, unknown>;
			examples.push({ goal: copy.goal, args, ...(copy.startup === true ? { startup: true } : {}) });
		} catch {
			// Descriptor guidance is optional; malformed or obsolete examples cannot break discovery.
		}
	}
	examplesBySpec.set(spec, examples);
	return examples;
}

/** The same schema check protects both startup orientation and on-demand examples. */
export function capabilityStarterArgs(spec: ToolSpec): Readonly<Record<string, unknown>> | undefined {
	return validatedExamples(spec).find((example) => example.startup)?.args;
}

/** Bounded schema cues and validated examples for calls made before describe. */
export function capabilityArgumentShape(spec: ToolSpec, exampleLimit = EXAMPLES_PER_TOOL): string {
	const required = (spec.parameters as { required?: string[] }).required ?? [];
	const requiredCue = required.length > 0 ? `Required args: ${required.join(", ")}.` : "";
	const parts = [
		Buffer.byteLength(requiredCue) > 512 ? `${requiredCue.slice(0, 120)}… Describe for all required args.` : requiredCue,
	];
	for (const { args } of validatedExamples(spec).slice(0, exampleLimit)) {
		const part = `args=${JSON.stringify(args)}`;
		if (Buffer.byteLength([...parts, part].join(" ")) > 2048) break;
		parts.push(part);
	}
	return parts.filter(Boolean).join(" ");
}

/** Ready-to-adapt gateway arguments; sample paths and values are examples, not observations. */
export function gatewayExamples(spec: ToolSpec, query = "", limit = 3) {
	// Dispatch can be described here, but its attached tool must still be called directly.
	if (toolSpecPlacement(spec) === "direct") return [];
	const examples = validatedExamples(spec);
	const ranked = query
		? examples
				.map((example, index) => ({ example, index, score: discoveryScore(query, "", example.goal) }))
				.sort((a, b) => b.score - a.score || a.index - b.index)
				.map(({ example }) => example)
		: examples;
	return ranked.slice(0, limit).map(({ goal, args }) => ({
		goal,
		call: { op: "call", capability: spec.name, args },
	}));
}

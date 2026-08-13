import { escapeRegExp } from "../tools/ignore-policy.js";

/**
 * Whether a runtime's models are prone to narrating tool calls as prose instead
 * of emitting them.
 *
 * Keyed on the local-native tier rather than a list of server names. The
 * behavior belongs to open-weight models served locally, not to the two servers
 * that happened to be tested first: the same model narrating through llama.cpp
 * narrates through Ollama, vLLM, and SGLang, and a name list left those runs
 * with no cutoff at all. Hosted runtimes are unaffected either way.
 */
export function runtimeNarratesToolCalls(runtimeTier: string | undefined): boolean {
	return runtimeTier === "local-native";
}

export interface ToolProseLoopInput {
	text: string;
	activeToolNames: ReadonlyArray<string>;
	hasStructuredToolCall?: boolean;
}

export type ToolProseLoopAssessment =
	| { kind: "ok" }
	| {
			kind: "loop";
			reason: string;
			matchCount: number;
	  };

const MIN_TOOL_PROSE_CHARS = 1200;
const TOOL_PROSE_REPEAT_THRESHOLD = 4;

/**
 * Characters of new text between assessments.
 *
 * The assessment lower-cases and collapses the whole accumulated answer, then
 * runs three regexes per active tool plus a generic one over it. Running that
 * on every streamed delta makes the cost quadratic in answer length: measured
 * on a 6942-character answer arriving as 1157 deltas, it spent 178ms of
 * synchronous time in the streaming hot path, and the last hundred deltas cost
 * roughly twice what the first hundred did. That time is taken from the same
 * event loop the render timer waits on.
 *
 * A narration loop needs four repetitions of a whole sentence to trip the
 * threshold, and the detector does not even look below 1200 characters, so
 * sampling every half-kilobyte cannot miss one. It bounds the work to a handful
 * of scans per answer instead of one per token.
 */
const TOOL_PROSE_ASSESS_STRIDE_CHARS = 512;

/**
 * True when enough new text has accumulated to be worth re-scanning.
 * `lastAssessedChars` is 0 before the first assessment of a run.
 */
export function shouldAssessToolProse(textLength: number, lastAssessedChars: number): boolean {
	if (textLength < MIN_TOOL_PROSE_CHARS) return false;
	return textLength - lastAssessedChars >= TOOL_PROSE_ASSESS_STRIDE_CHARS;
}

function count(pattern: RegExp, text: string): number {
	let matches = 0;
	pattern.lastIndex = 0;
	while (pattern.exec(text)) matches += 1;
	return matches;
}

function toolPattern(toolName: string): string {
	const escaped = escapeRegExp(toolName.trim().toLowerCase());
	return escaped.replace(/[_-]+/g, "[ _-]+");
}

function normalizedToolNames(names: ReadonlyArray<string>): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const raw of names) {
		const name = raw.trim().toLowerCase();
		if (name.length === 0 || seen.has(name)) continue;
		seen.add(name);
		out.push(name);
	}
	return out;
}

export function assessToolProseLoop(input: ToolProseLoopInput): ToolProseLoopAssessment {
	if (input.hasStructuredToolCall === true) return { kind: "ok" };
	if (input.text.length < MIN_TOOL_PROSE_CHARS) return { kind: "ok" };
	const tools = normalizedToolNames(input.activeToolNames);
	if (tools.length === 0) return { kind: "ok" };

	const text = input.text.toLowerCase().replace(/\s+/g, " ");
	let maxToolMatches = 0;
	let matchedTool = "";

	for (const toolName of tools) {
		const name = toolPattern(toolName);
		const patterns = [
			new RegExp(`\\b(?:execute|call|make|use)\\s+the\\s+${name}\\s+tool\\s+call\\b`, "g"),
			new RegExp(`\\b(?:execute|call|use)\\s+the\\s+${name}\\s+tool\\b`, "g"),
			new RegExp(`\\b${name}\\s+tool\\s+call\\b`, "g"),
		];
		const matches = patterns.reduce((sum, pattern) => sum + count(pattern, text), 0);
		if (matches > maxToolMatches) {
			maxToolMatches = matches;
			matchedTool = toolName;
		}
	}

	const genericMatches = count(
		/\b(?:i(?:'|’)ll|i will|i(?:'|’)m going to|i am going to)\s+(?:now\s+)?(?:execute|call|make|use)\s+the\s+[a-z0-9_-]+\s+(?:tool\s+)?call\b/g,
		text,
	);
	const matchCount = Math.max(maxToolMatches, genericMatches);
	if (matchCount < TOOL_PROSE_REPEAT_THRESHOLD) return { kind: "ok" };

	const target = matchedTool.length > 0 ? ` for '${matchedTool}'` : "";
	return {
		kind: "loop",
		matchCount,
		reason: `local model repeated tool-call narration${target} ${matchCount} times without emitting a structured tool call`,
	};
}

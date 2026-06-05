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

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

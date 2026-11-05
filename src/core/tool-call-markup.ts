/**
 * Dead tool-call markup a model can emit as plain text: the chat template's call syntax arrives as prose or reasoning
 * because the runtime did not parse it into a structured call, so nothing runs. Measured on a local model target,
 * roughly one locked turn in three answered the forced text-only round this way. Complete blocks are stripped wherever
 * they appear; unterminated trailing blocks (a length stop mid-markup) are stripped only when followed by a call body
 * (`<function=` or a JSON opener), so prose that merely quotes the "<tool_call>" phrase survives.
 */
const DEAD_TOOL_CALL_MARKUP_PATTERNS: ReadonlyArray<RegExp> = [
	/<tool_call>[\s\S]*?<\/tool_call>/gi,
	/<function=[\w.-]+>[\s\S]*?<\/function>/gi,
	/<tool_call>\s*(?:<function=|[{[])[\s\S]*$/i,
	/<function=[\w.-]+>[\s\S]*$/i,
];

/** Strip dead tool-call markup from model text; trims only when something was stripped. */
export function stripDeadToolCallMarkup(text: string): string {
	let out = text;
	for (const pattern of DEAD_TOOL_CALL_MARKUP_PATTERNS) {
		out = out.replace(pattern, "");
	}
	return out === text ? text : out.trim();
}

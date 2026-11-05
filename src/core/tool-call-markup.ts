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

function writtenCallNames(block: string): string[] | null {
	const inner = block
		.replace(/^<tool_call>\s*/iu, "")
		.replace(/\s*<\/tool_call>$/iu, "")
		.trim();
	const fn = /^<function=([\w.-]+)>/iu.exec(inner);
	if (fn?.[1] !== undefined) {
		// A close that is not the block's last token means something follows the call, so this is not a call on its own.
		const close = inner.search(/<\/function>/iu);
		return close === -1 || close === inner.length - "</function>".length ? [fn[1]] : null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(inner);
	} catch {
		// Text that only resembles a call is a quote.
		return null;
	}
	const calls = Array.isArray(parsed) ? parsed : [parsed];
	const names: string[] = [];
	for (const call of calls) {
		const { name, arguments: args, parameters } = (call ?? {}) as Record<string, unknown>;
		const body = args ?? parameters;
		if (typeof name !== "string" || body === null || typeof body !== "object") return null;
		names.push(name);
	}
	return names.length > 0 ? names : null;
}

/** Where the last call block starts, taking a `<function=` that a `<tool_call>` wraps as that block's opener. */
function lastCallBlockStart(text: string): number {
	const tag = text.toLowerCase().lastIndexOf("<tool_call>");
	const fn = text.toLowerCase().lastIndexOf("<function=");
	if (fn > tag && !/<tool_call>\s*$/iu.test(text.slice(0, fn))) return fn;
	return tag;
}

/**
 * The calls a reply ended on but only wrote out, and the prose before them. Prose can quote markup, so a block counts
 * only when all of this holds: nothing follows it, it parses as a call, every call names a tool the session has, it
 * starts a line or a sentence rather than finishing one, and it sits outside an open code fence. Everything else is a
 * quote and stays the model's text.
 */
export function readTrailingWrittenCalls(
	text: string,
	onSurface: (tool: string) => boolean,
): { prose: string; tools: string[] } | null {
	let prose = text.trimEnd();
	const tools: string[] = [];
	let openedLine = false;
	for (;;) {
		const start = lastCallBlockStart(prose);
		if (start === -1) break;
		const names = writtenCallNames(prose.slice(start));
		if (names === null || !names.every(onSurface)) break;
		tools.unshift(...names);
		openedLine = /\n\s*$/u.test(prose.slice(0, start));
		prose = prose.slice(0, start).trimEnd();
	}
	if (tools.length === 0) return null;
	if (prose.length > 0 && !openedLine && !/[.!?:…]$/u.test(prose)) return null;
	if ((prose.match(/```/gu)?.length ?? 0) % 2 === 1) return null;
	return { prose, tools };
}

const ANNOUNCED_ACTION =
	/\b(?:i will|i'll|i am going to|i'm going to|i need to|i should|let me|let's|now i|next i|first i|going to)\b|^(?:now|next|then)\b|^(?:applying|calling|checking|creating|editing|fixing|looking|proceeding|reading|running|searching|trying|updating|using|writing)\b/iu;

/** Whether the prose ahead of a written call leads into it, which leaves the request unanswered. */
export function proseAnnouncesCall(prose: string): boolean {
	const trimmed = prose.trim();
	if (trimmed.length === 0 || trimmed.endsWith(":")) return true;
	const sentences = trimmed.split(/(?<=[.!?…])\s+|\n+/u);
	return ANNOUNCED_ACTION.test((sentences.at(-1) ?? "").trim());
}

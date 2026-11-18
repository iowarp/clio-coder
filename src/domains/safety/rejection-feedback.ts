/**
 * Human-readable rejection messages for blocked tool calls. The registry
 * renders `short` in the UI footer, attaches `detail` to the audit
 * record, and surfaces `hints` to the worker so the next turn can recover
 * without another round-trip.
 */

export interface RejectionContext {
	tool: string;
	actionClass: string;
	posture?: string;
	reasons: ReadonlyArray<string>;
	ruleId?: string;
	/** A yolo floor block: the short form names the floor rule that fired, not the call's action class. */
	floor?: true;
}

export interface RejectionMessage {
	short: string;
	detail: string;
	hints: ReadonlyArray<string>;
}

const HARD_BLOCK_CLASSES: ReadonlyArray<string> = ["git_destructive"];

function buildShort(ctx: RejectionContext): string {
	const postureSuffix = ctx.posture ? ` in ${ctx.posture}` : "";
	const subject = ctx.floor === true && ctx.ruleId !== undefined ? ctx.ruleId : ctx.actionClass;
	return `${ctx.tool} blocked: ${subject}${postureSuffix}`;
}

function buildDetail(ctx: RejectionContext): string {
	const lines: string[] = [`Clio refused to run ${ctx.tool}.`];
	for (const reason of ctx.reasons) {
		lines.push(`- ${reason}`);
	}
	if (ctx.ruleId) {
		lines.push(`rule: ${ctx.ruleId}`);
	}
	return lines.join("\n");
}

function buildHints(ctx: RejectionContext): string[] {
	const hints: string[] = [];
	const hardBlock = HARD_BLOCK_CLASSES.includes(ctx.actionClass) || ctx.ruleId !== undefined;
	if (hardBlock) {
		hints.push("This is a hard block; confirmation cannot override it.");
		return hints;
	}
	if (ctx.actionClass === "system_modify") {
		hints.push("Operator confirmation is required for this action.");
	}
	return hints;
}

export function formatRejection(ctx: RejectionContext): RejectionMessage {
	return {
		short: buildShort(ctx),
		detail: buildDetail(ctx),
		hints: buildHints(ctx),
	};
}

/**
 * The model-facing text for a blocked tool call. The short label alone
 * ("read blocked: read") tells the model nothing about why the call failed
 * or how to recover, which is how blocked-call retry spirals start: the next
 * turn re-tries the same target through another tool because nothing said
 * the gate applies everywhere. Compose the verdict reason (which a loop
 * guard may already have replaced with its own recovery feedback) with the
 * rejection's detail and hints, deduplicated line by line, and close with
 * the standing pivot instruction, which always closes the message. Output is
 * enforced-bounded: lines cap at 300 characters and the message at 16 lines,
 * because reason strings interpolate caller data (paths, commands) verbatim.
 * An overlong line breaks at sentence ends and then gives up quoted text, so
 * the remedy clause after a long command survives (`boundLine`).
 */
const MODEL_REJECTION_PIVOT =
	"Do not retry this action through another tool or a respelled command (other flags, quoting, or a wrapper) unless a hint above names one; pivot or report the blocker.";
const MODEL_REJECTION_MAX_LINES = 16;
const MODEL_REJECTION_MAX_LINE_CHARS = 300;
const QUOTED_SPAN = /`[^`]*`/g;
/** Characters a shortened quoted span keeps, enough to recognize the command. */
const QUOTED_SPAN_KEEP_CHARS = 60;

/** A quoted heredoc stays one span on its line instead of spending the line budget on its body. */
function foldQuotedLineBreaks(text: string): string {
	return text.replace(QUOTED_SPAN, (span) => (span.includes("\n") ? span.replace(/\s*\n\s*/g, " ⏎ ") : span));
}

/** Split after a sentence end (". " or "; ") outside a quoted span. */
function sentences(line: string): string[] {
	const parts: string[] = [];
	let quoted = false;
	let start = 0;
	for (let index = 0; index < line.length; index++) {
		const char = line[index];
		if (char === "`") quoted = !quoted;
		else if (!quoted && (char === "." || char === ";") && line[index + 1] === " ") {
			parts.push(line.slice(start, index + 1));
			start = index + 2;
		}
	}
	parts.push(line.slice(start));
	return parts.filter((part) => part.length > 0);
}

/** Shorten the longest quoted spans (commands, paths) until the text fits or none is long enough to give. */
function shortenQuoted(text: string): string {
	const max = MODEL_REJECTION_MAX_LINE_CHARS;
	let shortened = text;
	while (shortened.length > max) {
		let longest: RegExpExecArray | undefined;
		for (const span of shortened.matchAll(QUOTED_SPAN)) {
			const length = span[0].length;
			if (length > QUOTED_SPAN_KEEP_CHARS + 3 && length > (longest?.[0].length ?? 0)) longest = span;
		}
		if (longest === undefined) break;
		const inner = longest[0].slice(1, -1);
		const keep = Math.max(QUOTED_SPAN_KEEP_CHARS, inner.length - (shortened.length - max) - 1);
		const head = shortened.slice(0, longest.index);
		shortened = `${head}\`${inner.slice(0, keep)}…\`${shortened.slice(longest.index + longest[0].length)}`;
	}
	return shortened;
}

/**
 * Bound one line: pack whole sentences into lines under the cap, shorten quoted text in a sentence still over it,
 * and cut only what quoting cannot explain.
 */
function boundLine(line: string): string[] {
	const max = MODEL_REJECTION_MAX_LINE_CHARS;
	if (line.length <= max) return [line];
	const lines: string[] = [];
	for (const sentence of sentences(line)) {
		const fitted = shortenQuoted(sentence);
		const bounded = fitted.length > max ? `${fitted.slice(0, max)}…` : fitted;
		const last = lines.length - 1;
		if (last >= 0 && (lines[last]?.length ?? 0) + 1 + bounded.length <= max) lines[last] = `${lines[last]} ${bounded}`;
		else lines.push(bounded);
	}
	return lines;
}

/**
 * A blocked call's result as an operator reads it. The closing instruction and an operator-approval remedy are
 * addressed to the model, so the row drops them; the result itself keeps every line for /view.
 */
export function withoutModelRejectionAdvice(text: string): string {
	return text
		.split("\n")
		.filter((line) => {
			const trimmed = line.trim();
			return trimmed !== MODEL_REJECTION_PIVOT && !trimmed.startsWith("To allow it: the operator must approve it;");
		})
		.join("\n");
}

export function formatModelRejection(
	reason: string,
	rejection?: RejectionMessage,
	account?: ReadonlyArray<string>,
): string {
	const lines: string[] = [];
	const seen = new Set<string>();
	const push = (line: string): void => {
		for (const bounded of boundLine(line)) {
			const trimmed = bounded.trim();
			if (trimmed.length === 0) continue;
			const normalized = trimmed.replace(/^-\s+/, "");
			if (seen.has(normalized) || normalized === MODEL_REJECTION_PIVOT) continue;
			seen.add(normalized);
			lines.push(trimmed);
		}
	};
	for (const line of foldQuotedLineBreaks(reason).split("\n")) push(line);
	// The structured refusal account (`denialLines`) follows the reason so the
	// line budget below never elides who refused and what would allow it.
	for (const line of account ?? []) push(line);
	if (rejection) {
		for (const line of rejection.detail.split("\n")) push(line);
		for (const hint of rejection.hints) push(hint);
	}
	// Bound the body and close with the standing pivot instruction, always
	// last: recovery guidance must be the final thing the model reads even
	// when a policy author pre-seeds the same sentence into the detail.
	const bodyBudget = MODEL_REJECTION_MAX_LINES - 1;
	const body = lines.length > bodyBudget ? [...lines.slice(0, bodyBudget - 1), "(further detail elided)"] : lines;
	return [...body, MODEL_REJECTION_PIVOT].join("\n");
}

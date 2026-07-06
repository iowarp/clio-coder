/**
 * Human-readable rejection messages for blocked tool calls. The registry
 * (slice 6) renders `short` in the UI footer, attaches `detail` to the audit
 * record, and surfaces `hints` to the worker so the next turn can recover
 * without another round-trip.
 */

export interface RejectionContext {
	tool: string;
	actionClass: string;
	posture?: string;
	reasons: ReadonlyArray<string>;
	ruleId?: string;
}

export interface RejectionMessage {
	short: string;
	detail: string;
	hints: ReadonlyArray<string>;
}

const HARD_BLOCK_CLASSES: ReadonlyArray<string> = ["git_destructive"];

function buildShort(ctx: RejectionContext): string {
	const postureSuffix = ctx.posture ? ` in ${ctx.posture}` : "";
	return `${ctx.tool} blocked: ${ctx.actionClass}${postureSuffix}`;
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
 */
const MODEL_REJECTION_PIVOT = "Do not retry this action through another tool; pivot or report the blocker.";
const MODEL_REJECTION_MAX_LINES = 16;
const MODEL_REJECTION_MAX_LINE_CHARS = 300;

export function formatModelRejection(reason: string, rejection?: RejectionMessage): string {
	const lines: string[] = [];
	const seen = new Set<string>();
	const push = (line: string): void => {
		const bounded =
			line.length > MODEL_REJECTION_MAX_LINE_CHARS ? `${line.slice(0, MODEL_REJECTION_MAX_LINE_CHARS)}…` : line;
		const trimmed = bounded.trim();
		if (trimmed.length === 0) return;
		const normalized = trimmed.replace(/^-\s+/, "");
		if (seen.has(normalized) || normalized === MODEL_REJECTION_PIVOT) return;
		seen.add(normalized);
		lines.push(trimmed);
	};
	for (const line of reason.split("\n")) push(line);
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

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
 * the standing pivot instruction. Bounded output: every line is a short
 * sentence authored by the policy engine or a guard.
 */
export function formatModelRejection(reason: string, rejection?: RejectionMessage): string {
	const lines: string[] = [];
	const seen = new Set<string>();
	const push = (line: string): void => {
		const trimmed = line.trim();
		if (trimmed.length === 0) return;
		const normalized = trimmed.replace(/^-\s+/, "");
		if (seen.has(normalized)) return;
		seen.add(normalized);
		lines.push(trimmed);
	};
	push(reason);
	if (rejection) {
		for (const line of rejection.detail.split("\n")) push(line);
		for (const hint of rejection.hints) push(hint);
	}
	push("Do not retry this action through another tool; pivot or report the blocker.");
	return lines.join("\n");
}

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

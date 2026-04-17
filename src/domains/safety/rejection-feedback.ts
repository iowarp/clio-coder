/**
 * Human-readable rejection messages for blocked tool calls. The registry
 * (slice 6) renders `short` in the UI footer, attaches `detail` to the audit
 * record, and surfaces `hints` to the worker so the next turn can recover
 * without another round-trip.
 */

export interface RejectionContext {
	tool: string;
	actionClass: string;
	mode?: string;
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
	const modeSuffix = ctx.mode ? ` in ${ctx.mode}` : "";
	return `${ctx.tool} blocked: ${ctx.actionClass}${modeSuffix}`;
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
		hints.push("This is a hard block — no mode allows it.");
		return hints;
	}
	if (ctx.mode === "default" && ctx.actionClass === "system_modify") {
		hints.push("Switch to super mode (Alt+S) to unblock this class.");
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

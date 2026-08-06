import type { EvalTokenMetricsV3 } from "../schema/artifact.js";

export interface EvalTokenStreamUsage {
	/**
	 * True when the stream carried at least one completed assistant message
	 * with provider usage. False means this runner observed no token
	 * accounting at all, which is not the same as a run that cost nothing.
	 */
	measured: boolean;
	tokens: EvalTokenMetricsV3;
	costUsd: number;
}

export interface EvalTokenUsageFold {
	/** Feed a raw stdout chunk; partial trailing lines are held until completed. */
	push(chunk: string): void;
	usage(): EvalTokenStreamUsage;
}

export const UNMEASURED_TOKEN_USAGE: EvalTokenStreamUsage = {
	measured: false,
	tokens: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
	costUsd: 0,
};

/**
 * Fold provider usage out of a `clio run --json` stream as it arrives.
 *
 * Usage is counted from `message_end` events only. That is the one event
 * carrying a completed message's usage exactly once; `turn_end` republishes
 * the same assistant message and `agent_end` republishes its segment's
 * summary, so counting those too would multiply a run's reported cost. Every
 * message counts, because a headless turn spans several agent segments and the
 * run's cost is their sum.
 *
 * Folding as the stream arrives is what makes the count trustworthy: the
 * operator-facing stdout artifact keeps only a bounded head and tail, so a
 * verbose run's usage events do not survive in it.
 */
export function createTokenUsageFold(): EvalTokenUsageFold {
	const tokens: EvalTokenMetricsV3 = { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 };
	let costUsd = 0;
	let measured = false;
	let pending = "";

	const consume = (line: string): void => {
		if (line.trim().length === 0) return;
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		if (!isRecord(event) || event.type !== "message_end") return;
		const message = isRecord(event.message) ? event.message : undefined;
		if (message === undefined || message.role !== "assistant") return;
		const usage = isRecord(message.usage) ? message.usage : undefined;
		if (usage === undefined) return;
		measured = true;
		const input = numberField(usage, "input");
		const output = numberField(usage, "output");
		const cacheRead = numberField(usage, "cacheRead");
		const cacheWrite = numberField(usage, "cacheWrite");
		const totalTokens = numberField(usage, "totalTokens");
		tokens.input += input;
		tokens.output += output;
		tokens.cacheRead += cacheRead;
		tokens.cacheWrite += cacheWrite;
		tokens.total += totalTokens > 0 ? totalTokens : input + output + cacheRead + cacheWrite;
		if (isRecord(usage.cost)) costUsd += numberField(usage.cost, "total");
	};

	return {
		push(chunk: string): void {
			pending += chunk;
			for (;;) {
				const newline = pending.indexOf("\n");
				if (newline === -1) break;
				consume(pending.slice(0, newline).replace(/\r$/u, ""));
				pending = pending.slice(newline + 1);
			}
		},
		usage(): EvalTokenStreamUsage {
			if (pending.length > 0) {
				consume(pending.replace(/\r$/u, ""));
				pending = "";
			}
			return { measured, tokens: { ...tokens }, costUsd };
		},
	};
}

/** Whole-buffer form of {@link createTokenUsageFold}. */
export function tokenUsageFromJsonl(stream: string): EvalTokenStreamUsage {
	const fold = createTokenUsageFold();
	fold.push(stream);
	return fold.usage();
}

export function addTokenStreamUsage(left: EvalTokenStreamUsage, right: EvalTokenStreamUsage): EvalTokenStreamUsage {
	return {
		measured: left.measured || right.measured,
		tokens: {
			input: left.tokens.input + right.tokens.input,
			output: left.tokens.output + right.tokens.output,
			total: left.tokens.total + right.tokens.total,
			cacheRead: left.tokens.cacheRead + right.tokens.cacheRead,
			cacheWrite: left.tokens.cacheWrite + right.tokens.cacheWrite,
		},
		costUsd: left.costUsd + right.costUsd,
	};
}

/**
 * Metric keys for one runner's token accounting. An unmeasured runner emits
 * `tokens.measured: false` and no counts at all, so nothing downstream can
 * read an absence as a zero-cost run.
 */
export function tokenMetricEntries(usage: EvalTokenStreamUsage): Record<string, number | boolean> {
	if (!usage.measured) return { "tokens.measured": false };
	return {
		"tokens.measured": true,
		"tokens.input": usage.tokens.input,
		"tokens.output": usage.tokens.output,
		"tokens.total": usage.tokens.total,
		"tokens.cacheRead": usage.tokens.cacheRead,
		"tokens.cacheWrite": usage.tokens.cacheWrite,
		...(usage.costUsd > 0 ? { "cost.usd": usage.costUsd } : {}),
	};
}

function numberField(record: Record<string, unknown>, field: string): number {
	const value = record[field];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

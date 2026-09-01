import { performance } from "node:perf_hooks";
import type { SessionEntry } from "../../session/entries.js";

export interface EvalCallLedgerFold {
	push(chunk: string): void;
	entries(): SessionEntry[];
}

/** Fold structured assistant completions into the eval's per-call ledger. */
export function createEvalCallLedgerFold(now: () => number = () => performance.now()): EvalCallLedgerFold {
	const entries: SessionEntry[] = [];
	let pending = "";
	let activeStartedAt: number | null = null;
	let activeFirstOutputAt: number | null = null;

	const consume = (line: string): void => {
		const event = parseRecord(line);
		if (event === null) return;
		if (event.type === "message_start" && isAssistantMessage(event.message)) {
			activeStartedAt = now();
			activeFirstOutputAt = null;
			return;
		}
		if (event.type === "message_update" && activeStartedAt !== null && activeFirstOutputAt === null) {
			activeFirstOutputAt = now();
			return;
		}
		if (event.type !== "message_end" || !isAssistantMessage(event.message)) return;
		const message = event.message;
		const usage = isRecord(message.usage) ? message.usage : null;
		if (usage === null) {
			activeStartedAt = null;
			activeFirstOutputAt = null;
			return;
		}
		const endedAt = now();
		const promptCache: Record<string, unknown> = {
			input: nonNegativeNumber(usage.input) ?? 0,
			cacheRead: nonNegativeNumber(usage.cacheRead) ?? 0,
			cacheWrite: nonNegativeNumber(usage.cacheWrite) ?? 0,
			backendVerdict: "unknown",
		};
		if (isRecord(message.backendTimings)) promptCache.backend = structuredClone(message.backendTimings);
		const previous = entries.at(-1);
		entries.push({
			kind: "message",
			role: "assistant",
			turnId: `eval-call-${entries.length + 1}`,
			parentTurnId: previous?.turnId ?? null,
			timestamp: messageTimestamp(message.timestamp),
			payload: {
				promptCache,
				timing: {
					ttftMs:
						activeStartedAt === null ? null : Math.round(Math.max(0, (activeFirstOutputAt ?? endedAt) - activeStartedAt)),
					apiMs: activeStartedAt === null ? 0 : Math.round(Math.max(0, endedAt - activeStartedAt)),
				},
				usage: structuredClone(usage),
			},
		});
		activeStartedAt = null;
		activeFirstOutputAt = null;
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
		entries(): SessionEntry[] {
			if (pending.length > 0) {
				consume(pending.replace(/\r$/u, ""));
				pending = "";
			}
			return structuredClone(entries);
		},
	};
}

function isAssistantMessage(value: unknown): value is Record<string, unknown> & { role: "assistant" } {
	return isRecord(value) && value.role === "assistant";
}

function messageTimestamp(value: unknown): string {
	const milliseconds = nonNegativeNumber(value);
	if (milliseconds === null) return new Date(0).toISOString();
	const date = new Date(milliseconds);
	return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString();
}

function nonNegativeNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function parseRecord(line: string): Record<string, unknown> | null {
	if (line.trim().length === 0) return null;
	try {
		const value: unknown = JSON.parse(line);
		return isRecord(value) ? value : null;
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

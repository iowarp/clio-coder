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
		if (isAssistantOutput(event) && activeStartedAt !== null && activeFirstOutputAt === null) {
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
		const timestamp = messageTimestamp(message.timestamp);
		entries.push({
			kind: "message",
			role: "assistant",
			turnId: `eval-call-${entries.length + 1}`,
			parentTurnId: previous?.turnId ?? null,
			timestamp: timestamp ?? new Date(0).toISOString(),
			payload: {
				// Retain the legacy ISO placeholder without treating it as observed
				// chronology. Per-call monotonic timing remains usable on its own.
				...(timestamp === null ? { timestampEstimated: true } : {}),
				promptCache,
				timing:
					activeStartedAt === null
						? null
						: {
								ttftMs: activeFirstOutputAt === null ? null : Math.round(Math.max(0, activeFirstOutputAt - activeStartedAt)),
								apiMs: Math.round(Math.max(0, endedAt - activeStartedAt)),
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

function isAssistantOutput(event: Record<string, unknown>): boolean {
	// Headless chat projects updates to text/thinking deltas; worker stdout
	// retains the nested update. Structural events are not token observations.
	const output = event.type === "message_update" ? event.assistantMessageEvent : event;
	if (!isRecord(output)) return false;
	if (output.type === "toolcall_start") return event.type === "message_update";
	return (
		(output.type === "text_delta" || output.type === "thinking_delta" || output.type === "toolcall_delta") &&
		typeof output.delta === "string" &&
		output.delta.length > 0
	);
}

function isAssistantMessage(value: unknown): value is Record<string, unknown> & { role: "assistant" } {
	return isRecord(value) && value.role === "assistant";
}

function messageTimestamp(value: unknown): string | null {
	const milliseconds = nonNegativeNumber(value);
	if (milliseconds === null) return null;
	const date = new Date(milliseconds);
	return Number.isFinite(date.getTime()) ? date.toISOString() : null;
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

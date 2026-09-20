type TimingEvent = {
	type: string;
	message?: { role?: string };
	assistantMessageEvent?: unknown;
};

export function hasAssistantGenerationDelta(update: unknown): boolean {
	if (typeof update !== "object" || update === null) return false;
	const event = update as { type?: unknown; delta?: unknown };
	return (
		event.type === "toolcall_start" ||
		((event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") &&
			typeof event.delta === "string" &&
			event.delta.length > 0)
	);
}

/** Monotonic generation spans; tool waits and each call's prefill stay outside Tk/s. */
export function createAssistantGenerationTiming() {
	let startedAt: number | null = null;
	let firstDeltaAt: number | null = null;
	let activeSince: number | null = null;
	let settledMs = 0;
	const settle = (at: number): void => {
		if (activeSince !== null) settledMs += Math.max(0, at - activeSince);
		activeSince = null;
	};
	return {
		record(event: TimingEvent, at: number): void {
			if (event.type === "agent_start") {
				startedAt = at;
				firstDeltaAt = null;
				activeSince = null;
				settledMs = 0;
			} else if (startedAt !== null) {
				if (event.type === "message_update" && hasAssistantGenerationDelta(event.assistantMessageEvent)) {
					firstDeltaAt ??= at;
					activeSince ??= at;
				} else if ((event.type === "message_end" && event.message?.role === "assistant") || event.type === "agent_end") {
					settle(at);
				}
			}
		},
		snapshot(at: number): { durationMs: number; ttftMs: number } | null {
			if (startedAt === null || firstDeltaAt === null) return null;
			return {
				durationMs: Math.max(1, settledMs + (activeSince === null ? 0 : Math.max(0, at - activeSince))),
				ttftMs: Math.max(0, firstDeltaAt - startedAt),
			};
		},
	};
}

/** Session choices are operator answers, never inferred from node registration or model prose. */
const choices = new Map<string, string>();
export const FLEET_PLACEMENT_HEADER = "Fleet node";

export function sessionFleetNode(sessionId: string | null | undefined): string | null {
	return sessionId ? (choices.get(sessionId) ?? null) : null;
}

export function rememberSessionFleetNode(sessionId: string, nodeId: string): void {
	// Bound process memory across long-lived applications with many sessions.
	if (!choices.has(sessionId) && choices.size >= 128) {
		const oldest = choices.keys().next().value;
		if (oldest) choices.delete(oldest);
	}
	choices.set(sessionId, nodeId);
}

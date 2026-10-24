import type { ProviderCheckpointHandle } from "../engine/types.js";

export function isProviderCheckpointHandle(value: unknown): value is ProviderCheckpointHandle {
	if (value === null || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return (
		v.version === 1 &&
		typeof v.digest === "string" &&
		/^[a-f0-9]{64}$/.test(v.digest) &&
		typeof v.outputTokens === "number" &&
		Number.isFinite(v.outputTokens) &&
		v.outputTokens >= 0 &&
		(v.replayInputTokens === undefined ||
			(typeof v.replayInputTokens === "number" && Number.isFinite(v.replayInputTokens) && v.replayInputTokens >= 0))
	);
}

/** Only protocol failures authorize a paid portable retry; programming errors must surface (#423). */
export class ProviderCompactionError extends Error {
	constructor(readonly category: string) {
		super(category);
		this.name = "ProviderCompactionError";
	}
}

/** A declined portable cut resolves the old native handle without paying again on every send (#423). */
export function providerFallbackDigests(entries: ReadonlyArray<unknown>): Set<string> {
	const resolved = new Set<string>();
	for (const entry of entries) {
		const row = entry as {
			kind?: unknown;
			customType?: unknown;
			data?: { version?: unknown; checkpointDigest?: unknown; providerFallbackReason?: unknown };
		};
		if (
			row?.kind === "custom" &&
			row.customType === "clio_coder_provider_fallback" &&
			row.data?.version === 1 &&
			typeof row.data.checkpointDigest === "string" &&
			/^[a-f0-9]{64}$/u.test(row.data.checkpointDigest) &&
			typeof row.data.providerFallbackReason === "string"
		)
			resolved.add(row.data.checkpointDigest);
	}
	return resolved;
}

/** Host metadata only; the wire adapter replaces this user placeholder with exact provider items (#423). */
export function providerCheckpointFromMessage(message: unknown): ProviderCheckpointHandle | undefined {
	const value = (message as { clioProviderCheckpoint?: unknown } | null)?.clioProviderCheckpoint;
	return isProviderCheckpointHandle(value) ? value : undefined;
}

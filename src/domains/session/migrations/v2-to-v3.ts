import type { SessionMeta } from "../contract.js";

/**
 * v2→v3 session-format migration.
 *
 * v3 removes the per-turn prompt-envelope diagnostics that the one-prompt-
 * per-session design made meaningless: entry-level `renderedPromptHash` and
 * `dynamicInputs`, payload-level `promptDiagnostics` in their old envelope
 * shape, and the always-null `compiledPromptHash`/`staticCompositionHash`
 * meta fields. Old sessions simply carry no prompt diagnostics after
 * migration; the new shape cannot be derived from the old one and stale
 * envelope hashes must not masquerade as current diagnostics.
 *
 * Meta mutation happens here; the ledger rewrite is driven by
 * `resumeSessionState`, which feeds every entry through
 * `stripV2PromptArtifacts` exactly once and persists via the session writer.
 * Idempotent on both axes.
 */
export function migrateV2ToV3(meta: SessionMeta): void {
	const current = meta.sessionFormatVersion ?? 1;
	if (current >= 3) return;
	const record = meta as unknown as Record<string, unknown>;
	delete record.compiledPromptHash;
	delete record.staticCompositionHash;
	meta.sessionFormatVersion = 3;
}

/** Strip dead v2 prompt-diagnostics fields from one ledger entry. */
export function stripV2PromptArtifacts(entry: unknown): unknown {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
	const record = entry as Record<string, unknown>;
	const hasEntryFields = "renderedPromptHash" in record || "dynamicInputs" in record;
	const payload = record.payload;
	const payloadHasDiagnostics =
		payload !== null && typeof payload === "object" && !Array.isArray(payload) && "promptDiagnostics" in payload;
	if (!hasEntryFields && !payloadHasDiagnostics) return entry;
	const next: Record<string, unknown> = { ...record };
	delete next.renderedPromptHash;
	delete next.dynamicInputs;
	if (payloadHasDiagnostics) {
		const nextPayload = { ...(payload as Record<string, unknown>) };
		delete nextPayload.promptDiagnostics;
		next.payload = nextPayload;
	}
	return next;
}

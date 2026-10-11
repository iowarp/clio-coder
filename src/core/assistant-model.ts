/** Recorded response provenance, independent of the session's current route. */
export function assistantModelLabel(message: unknown): string | null {
	if (message === null || typeof message !== "object" || Array.isArray(message)) return null;
	const record = message as Record<string, unknown>;
	const clean = (value: unknown): string | null =>
		typeof value === "string" && value.trim().length > 0
			? value
					.replace(/[\p{Cc}\p{Cf}]/gu, " ")
					.trim()
					.slice(0, 256)
			: null;
	const model = clean(record.model);
	if (model === null) return null;
	const provider = clean(record.provider);
	return provider === null ? model : `${provider} · ${model}`;
}

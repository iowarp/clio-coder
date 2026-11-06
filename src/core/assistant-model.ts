/**
 * A message for a call Clio never sent, such as one whose admission could not load its model. It carries the route
 * the call was meant for, but no route replied to it.
 */
export function assistantMessageNeverSent(message: unknown): boolean {
	if (message === null || typeof message !== "object" || Array.isArray(message)) return false;
	const record = message as {
		callInvoked?: unknown;
		failure?: { invoked?: unknown };
		usage?: { callInvoked?: unknown };
	};
	return record.callInvoked === false || record.failure?.invoked === false || record.usage?.callInvoked === false;
}

/** Recorded response provenance, independent of the session's current route; a call never sent has none. */
export function assistantModelLabel(message: unknown, targetId?: string | null): string | null {
	if (message === null || typeof message !== "object" || Array.isArray(message)) return null;
	if (assistantMessageNeverSent(message)) return null;
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
	// A message records the wire protocol as its provider. The target is what the operator chose and the rail names.
	const provider = clean(targetId) ?? clean(record.provider);
	return provider === null ? model : `${provider} · ${model}`;
}

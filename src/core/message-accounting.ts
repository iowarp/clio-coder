const record = (value: unknown): Record<string, unknown> | null =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** Read Clio's annotations separately from immutable provider usage; old ledgers stored them inside usage (#434). */
export function messageUsageForAccounting(message: unknown): Record<string, unknown> | null {
	const raw = record(message);
	const usage = record(raw?.usage);
	if (!raw || !usage) return null;
	const accounting = record(raw.callAccounting);
	const result = { ...usage };
	for (const key of ["usageObserved", "costProvenance", "targetId"] as const) {
		if (accounting?.[key] !== undefined) result[key] = accounting[key];
	}
	if (typeof raw.callInvoked === "boolean") result.callInvoked = raw.callInvoked;
	if (record(raw.failure)?.invoked === false) result.callInvoked = false;
	return result;
}

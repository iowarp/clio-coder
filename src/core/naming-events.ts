const CLIO_CODER_EVENT_SUFFIXES = new Set([
	"permission_escalated",
	"permission_resolved",
	"plan_update",
	"run_outcome",
	"safety_decision",
	"skill_activation",
	"steer_received",
	"tool_activity",
	"tool_finish",
	"tool_start",
	"usage",
	"verification",
	"write_record_downgraded",
]);

/** Canonicalize one released snake-case event id without accepting arbitrary prefixes. */
export function normalizeClioCoderEventType(type: string): string {
	if (!type.startsWith("clio_") || type.startsWith("clio_coder_")) return type;
	const suffix = type.slice("clio_".length);
	return CLIO_CODER_EVENT_SUFFIXES.has(suffix) ? `clio_coder_${suffix}` : type;
}

/** Clone one decoded event only when its top-level discriminator is legacy. */
export function normalizeClioCoderEventRecord(record: Record<string, unknown>): Record<string, unknown> {
	if (typeof record.type !== "string") return record;
	const type = normalizeClioCoderEventType(record.type);
	return type === record.type ? record : { ...record, type };
}

/**
 * Normalize legacy event discriminators in an in-memory decoded history tree.
 * This never writes the source session/eval/evidence file.
 */
export function normalizeClioCoderEventTree(value: unknown): unknown {
	if (Array.isArray(value)) {
		let changed = false;
		const next = value.map((entry) => {
			const normalized = normalizeClioCoderEventTree(entry);
			if (normalized !== entry) changed = true;
			return normalized;
		});
		return changed ? next : value;
	}
	if (typeof value !== "object" || value === null) return value;
	const record = value as Record<string, unknown>;
	let changed = false;
	const next: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(record)) {
		const normalized = normalizeClioCoderEventTree(entry);
		next[key] = normalized;
		if (normalized !== entry) changed = true;
	}
	if (typeof record.type === "string") {
		const type = normalizeClioCoderEventType(record.type);
		if (type !== record.type) {
			next.type = type;
			changed = true;
		}
	}
	return changed ? next : value;
}

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
 * Whether `normalizeClioCoderEventTree` would change anything in `value`: some record's `type` is a legacy id. It
 * allocates nothing, so a current ledger line, which has none, costs one read-only walk instead of a copied tree.
 */
function holdsLegacyEventType(value: unknown): boolean {
	if (Array.isArray(value)) {
		for (const entry of value) if (holdsLegacyEventType(entry)) return true;
		return false;
	}
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	if (typeof record.type === "string" && normalizeClioCoderEventType(record.type) !== record.type) return true;
	for (const key in record) {
		if (Object.hasOwn(record, key) && holdsLegacyEventType(record[key])) return true;
	}
	return false;
}

/**
 * Normalize legacy event discriminators in an in-memory decoded history tree.
 * This never writes the source session or evidence file. A tree with nothing to
 * change comes back as the same value without being copied.
 */
export function normalizeClioCoderEventTree(value: unknown): unknown {
	return holdsLegacyEventType(value) ? normalizeLegacyEventTree(value) : value;
}

function normalizeLegacyEventTree(value: unknown): unknown {
	if (Array.isArray(value)) {
		let changed = false;
		const next = value.map((entry) => {
			const normalized = normalizeLegacyEventTree(entry);
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
		const normalized = normalizeLegacyEventTree(entry);
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

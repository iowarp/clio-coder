import { resolve } from "node:path";
import { CONTEXT_OPERATION_CUSTOM_TYPE, readContextOperation } from "../core/context-operation.js";
import type { SessionEntry } from "../domains/session/entries.js";

/** Read only at the host's next prompt boundary; replay and live share this durable source. */
export function contextOperationAwareness(entries: readonly SessionEntry[], sessionId: string, cwd: string): string {
	const latest = new Map<string, Record<string, unknown>>();
	for (const entry of entries) {
		if (
			entry.kind !== "custom" ||
			entry.customType !== CONTEXT_OPERATION_CUSTOM_TYPE ||
			!entry.data ||
			typeof entry.data !== "object"
		)
			continue;
		const value = readContextOperation(entry.data);
		if (!value) continue;
		if (
			value.version !== 1 ||
			value.sessionId !== sessionId ||
			value.cwd !== resolve(cwd) ||
			value.origin !== "operator" ||
			typeof value.kind !== "string" ||
			!["completed", "previewed", "unchanged", "cancelled", "failed"].includes(String(value.outcome))
		)
			continue;
		// Reset supersedes prior project curation; later results supersede the same verb.
		if (value.kind === "context-clear" && value.outcome === "completed") latest.clear();
		latest.delete(value.kind);
		latest.set(value.kind, {
			operation: value.kind,
			outcome: value.outcome,
			// Numeric evidence only: no authored text, paths, provider errors, or secrets.
			facts: Array.isArray(value.facts)
				? value.facts.slice(0, 8).flatMap((fact: unknown) => {
						if (!fact || typeof fact !== "object") return [];
						const f = fact as Record<string, unknown>;
						return typeof f.kind === "string" &&
							typeof f.unit === "string" &&
							typeof f.count === "number" &&
							Number.isSafeInteger(f.count) &&
							f.count >= 0
							? [{ kind: f.kind.slice(0, 24), unit: f.unit.slice(0, 24), count: f.count }]
							: [];
					})
				: [],
		});
	}
	const facts = [...latest.values()].slice(-6);
	return facts.length
		? `<context-operation-update>Host-recorded operator actions (facts only; no response requested): ${JSON.stringify(facts)}</context-operation-update>`
		: "";
}

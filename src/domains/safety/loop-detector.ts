/**
 * Simple sliding-window loop detector. Pure logic; the caller owns state
 * storage. Slice 3 hands this an identity key composed of tool name + canonical
 * arg hash and a `Date.now()` reading so runaway workers can be caught before
 * their audit trail floods disk. `hashToolCall` builds that identity key and
 * lives here, beside the detector, so every observer (the registry's hook
 * input, tests, diagnostics) fingerprints calls identically.
 */

export interface LoopDetectorState {
	recent: ReadonlyArray<{ key: string; at: number }>;
	windowMs: number;
	maxRepeats: number;
}

export interface LoopVerdict {
	looping: boolean;
	key: string;
	count: number;
}

const DEFAULT_WINDOW_MS = 30_000;
const DEFAULT_MAX_REPEATS = 5;

export function createLoopState(opts?: { windowMs?: number; maxRepeats?: number }): LoopDetectorState {
	const windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
	const maxRepeats = opts?.maxRepeats ?? DEFAULT_MAX_REPEATS;
	return { recent: [], windowMs, maxRepeats };
}

/** Compute a stable fingerprint from a tool name plus its arguments. */
export function hashToolCall(tool: string, args: unknown): string {
	let argPart: string;
	try {
		argPart = canonicalSerialize(args ?? {}, new WeakSet<object>());
	} catch {
		// Fall back to a tool-only fingerprint when args contain non-serializable
		// values (e.g. functions). The detector still triggers when the tool name
		// alone repeats, which matches the user-visible failure mode.
		argPart = "<unrepresentable>";
	}
	return `${tool}${argPart}`;
}

function canonicalSerialize(value: unknown, seen: WeakSet<object>): string {
	if (value === null) return "null";
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new Error(`canonicalSerialize: non-finite number ${String(value)} is not representable`);
		}
		return JSON.stringify(value);
	}
	if (typeof value === "string" || typeof value === "boolean") {
		return JSON.stringify(value);
	}
	if (typeof value === "bigint") {
		throw new Error("canonicalSerialize: bigint is not representable");
	}
	if (typeof value === "symbol" || typeof value === "function" || value === undefined) {
		throw new Error(`canonicalSerialize: ${typeof value} is not representable`);
	}
	if (Array.isArray(value)) {
		if (seen.has(value)) throw new Error("canonicalSerialize: circular reference is not representable");
		seen.add(value);
		try {
			const parts: string[] = [];
			for (let i = 0; i < value.length; i++) {
				if (!(i in value) || value[i] === undefined) {
					parts.push("null");
					continue;
				}
				parts.push(canonicalSerialize(value[i], seen));
			}
			return `[${parts.join(",")}]`;
		} finally {
			seen.delete(value);
		}
	}
	if (typeof value === "object") {
		if (value instanceof Date) {
			const jsonValue = value.toJSON();
			return jsonValue === null ? "null" : JSON.stringify(jsonValue);
		}
		if (seen.has(value)) throw new Error("canonicalSerialize: circular reference is not representable");
		seen.add(value);
		const obj = value as Record<string, unknown>;
		try {
			const keys = Object.keys(obj).sort();
			const parts: string[] = [];
			for (const key of keys) {
				const child = obj[key];
				if (child === undefined) continue;
				parts.push(`${JSON.stringify(key)}:${canonicalSerialize(child, seen)}`);
			}
			return `{${parts.join(",")}}`;
		} finally {
			seen.delete(value);
		}
	}
	throw new Error(`canonicalSerialize: unsupported value of type ${typeof value}`);
}

export function observe(state: LoopDetectorState, key: string, now: number): [LoopDetectorState, LoopVerdict] {
	const cutoff = now - state.windowMs;
	const trimmed = state.recent.filter((entry) => entry.at >= cutoff);
	const next = [...trimmed, { key, at: now }];
	let count = 0;
	for (const entry of next) {
		if (entry.key === key) count += 1;
	}
	const looping = count >= state.maxRepeats;
	const newState: LoopDetectorState = {
		recent: next,
		windowMs: state.windowMs,
		maxRepeats: state.maxRepeats,
	};
	return [newState, { looping, key, count }];
}

export type StoreBackendKind = "local" | "clio-core";

export type StoreTagClass = "input" | "output" | "cache" | "archive";

export interface StoreBackendFacts {
	kind: StoreBackendKind;
	/** One sentence: what a tag and a blob are on this backend. */
	mapping: string;
	tiers: false | ReadonlyArray<{ name: string; score: number; freeBytes: number | null }>;
	multiNode: boolean;
	durable: boolean;
	conditionalPut: "if-absent" | "if-absent-and-version";
	blobVersions: boolean;
	freeBytes: number | null;
}

export interface StoreBlobStat {
	bytes: number;
	modifiedMs: number;
	version: number | null;
}

/**
 * What one put stored, observed by the put itself: the size and sha256 of the
 * bytes it streamed and the stat of its own copy before it took the blob's
 * name, so a concurrent writer's bytes never stand in for this put's.
 */
export interface StoreBlobPut extends StoreBlobStat {
	sha256: string;
	/** The backend's own name for the blob: the absolute path on the local backend. */
	key: string;
}

export type StoreRefusalReason =
	| "invalid-name"
	| "not-found"
	| "exists"
	| "not-a-file"
	| "is-link"
	| "no-space"
	| "unavailable"
	| "io";

/** The one error a backend throws for an expected failure. */
export class StoreRefusal extends Error {
	readonly reason: StoreRefusalReason;

	constructor(reason: StoreRefusalReason, message: string) {
		super(message);
		this.name = "StoreRefusal";
		this.reason = reason;
	}
}

/** Longest blob-name pattern a listing accepts; patterns come from the model and the CLI. */
export const STORE_PATTERN_MAX_LENGTH = 256;

/** The quantifier starting at `i`, if any: `*`, `+`, `?` or an open-ended `{n,}` / `{n,m}`. */
function quantifierAt(pattern: string, i: number): boolean {
	const ch = pattern[i];
	if (ch === "*" || ch === "+" || ch === "?") return true;
	return ch === "{" && /^\{\d+,\d*\}/.test(pattern.slice(i));
}

/**
 * True when a quantified group contains a quantifier at any depth, such as `(a+)+`, `((a+))+` or
 * `(a(b+))*`: the shape that backtracks exponentially on a near-miss name. Escapes and character
 * classes are skipped, so `[(]a+` is not a group.
 */
function hasNestedQuantifier(pattern: string): boolean {
	const open: boolean[] = [];
	let inClass = false;
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === "\\") {
			i++;
			continue;
		}
		if (inClass) {
			if (ch === "]") inClass = false;
			continue;
		}
		if (ch === "[") {
			inClass = true;
		} else if (ch === "(") {
			open.push(false);
			if (pattern[i + 1] === "?") i++;
		} else if (ch === ")") {
			const inner = open.pop() ?? false;
			const quantified = quantifierAt(pattern, i + 1);
			if (inner && quantified) return true;
			if ((inner || quantified) && open.length > 0) open[open.length - 1] = true;
		} else if (quantifierAt(pattern, i) && open.length > 0) {
			open[open.length - 1] = true;
		}
	}
	return false;
}
const BACKREFERENCE = /\\(?:[1-9]|k<)/;

/**
 * Compile a blob-name pattern anchored to the whole name, refusing (`invalid-name`) one that
 * is too long, uses a backreference or nests quantifiers, so a listing cannot hang on it.
 */
export function compileBlobPattern(pattern: string): RegExp {
	if (pattern.length > STORE_PATTERN_MAX_LENGTH) {
		throw new StoreRefusal("invalid-name", `Invalid blob pattern: longer than ${STORE_PATTERN_MAX_LENGTH} characters`);
	}
	if (BACKREFERENCE.test(pattern)) {
		throw new StoreRefusal("invalid-name", "Invalid blob pattern: backreferences are not allowed");
	}
	if (hasNestedQuantifier(pattern)) {
		throw new StoreRefusal("invalid-name", "Invalid blob pattern: a quantified group may not contain another quantifier");
	}
	try {
		return new RegExp(`^(?:${pattern})$`);
	} catch (error) {
		throw new StoreRefusal(
			"invalid-name",
			`Invalid blob pattern: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

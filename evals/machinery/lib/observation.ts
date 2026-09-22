/**
 * The observation contract every machinery scenario returns, and the behavior
 * digest computed over it.
 *
 * The digest follows the method `evals/tool-bench/lib/driver.ts` uses: replace
 * the paths and identities that move between runs with fixed tokens, blank the
 * keys that carry time, serialize with sorted object keys, and hash that. The
 * helpers are a second implementation rather than an import because the bench
 * driver installs filesystem counters and a private state directory at module
 * load, and a machinery scenario must not pay for either.
 */
import { createHash } from "node:crypto";

export const MEASURE_SCHEMA = "clio-coder.eval.measure.v1";
export const BEHAVIOR_SCHEMA = "clio-coder.machinery.behavior.v1";

export interface MachineryObservation {
	/** Named facts the scenario observed. The digest fingerprints this document. */
	facts: Record<string, unknown>;
	/** Expectations that did not hold. Empty means the scenario solved. */
	failures: string[];
}

export type MachineryScenario = () => Promise<MachineryObservation>;

/** Pair the observed facts with the expectations about them, naming each one. */
export function observe(facts: Record<string, unknown>, checks: Record<string, boolean>): MachineryObservation {
	const failures = Object.entries(checks)
		.filter(([, held]) => !held)
		.map(([name]) => name);
	return { facts, failures };
}

/** Random names a scratch path or a freshly allocated run identity can put in an observed value. */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;

/**
 * A scratch directory a scenario made for itself, once the temp root it sits in
 * has been replaced. `mkdtemp` appends six random characters, so the name is a
 * property of the run rather than of the harness.
 */
const SCRATCH_NAME = /(?<=<tmp>\/)clio-coder-[A-Za-z0-9.-]+/gu;

/**
 * Keys whose value is a clock reading or a duration. They are a property of
 * when the scenario ran, not of the harness, so they are blanked rather than
 * hashed.
 */
const VOLATILE_KEY =
	/^(?:at|timestamp|startedAt|finishedAt|createdAt|lastTouchedAt|recordedAt|queuedAt|deadlineAt|heartbeatAt|durationMs|elapsedMs|executedMs|wallMs|mtimeMs|atimeMs|ctimeMs|birthtimeMs)$/u;

/**
 * Replace scratch paths and UUIDs inside strings and blank the keys that carry
 * time. Each root is a (path, token) pair; the longest path is applied first so
 * a nested scratch directory wins over the temp directory that holds it.
 */
export function normalize(value: unknown, roots: ReadonlyArray<readonly [string, string]>): unknown {
	if (typeof value === "string") {
		let out = value;
		for (const [root, token] of roots) out = out.split(root).join(token);
		return out.replace(SCRATCH_NAME, "<scratch>").replace(UUID, "<uuid>");
	}
	if (Array.isArray(value)) return value.map((item) => normalize(item, roots));
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value))
			out[key] = VOLATILE_KEY.test(key) ? "<volatile>" : normalize(item, roots);
		return out;
	}
	return value;
}

/** JSON with sorted object keys and undefined members dropped. */
export function canonicalJson(value: unknown): string {
	if (value === undefined) return "null";
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	const entries = Object.entries(value)
		.filter(([, item]) => item !== undefined)
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
	return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

export function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export interface BehaviorDocument {
	schema: typeof BEHAVIOR_SCHEMA;
	suite: string;
	scenario: string;
	facts: unknown;
	failures: ReadonlyArray<string>;
}

/**
 * The canonical document the digest hashes. The failures are part of it so a
 * scenario that starts failing moves its digest as well as `task.solved`, and
 * the recorded line says which expectation broke.
 */
export function behaviorDocument(
	suite: string,
	scenario: string,
	observation: MachineryObservation,
	roots: ReadonlyArray<readonly [string, string]>,
): BehaviorDocument {
	return {
		schema: BEHAVIOR_SCHEMA,
		suite,
		scenario,
		facts: normalize(observation.facts, roots),
		failures: [...observation.failures].sort(),
	};
}

export function behaviorDigest(document: BehaviorDocument): string {
	return sha256(canonicalJson(document));
}

/**
 * The one metric line the runner reads. Only the digest is printed: wall time,
 * RSS and CPU are properties of the machine that ran the suite, and `task.solved`
 * is the measure command's exit status.
 */
export function measureLine(digest: string): string {
	return JSON.stringify({ schema: MEASURE_SCHEMA, metrics: { "custom.digest.behavior": digest } });
}

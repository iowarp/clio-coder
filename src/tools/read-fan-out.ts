import { resolveGuardrail } from "../core/guardrails.js";
import type { RegistryVerdict } from "./registry.js";

/**
 * A `read` call naming several files (`paths`) is N single-path reads joined into one result. The registry expands
 * it at its `invoke` entry, before admission, so every path meets the safety policy, the workspace boundary, the
 * sandbox check, denial memory and the tool hooks as its own one-path call; nothing downstream learns the array
 * (maintainer 2026-11-22, option a). The joined output stays under the one per-call byte cap a single read has.
 */

/** How many files one `read` call takes through `paths`. */
export const READ_PATHS_MAX = 16;

/** The smallest share of the per-call cap a further path is started with; below it the path is named as not read. */
export const READ_PATHS_MIN_SLICE_BYTES = 1024;

/** The per-call cap the paths of one call share: the read guardrail, floored as `readMaxBytes` floors it. */
export function readFanOutCapBytes(): number {
	return Math.max(READ_PATHS_MIN_SLICE_BYTES, resolveGuardrail("readMaxBytes"));
}

const NOT_SHARED = new Set(["path", "paths", "pages", "member"]);

/** Why a `paths` value cannot be expanded, or null when it can. Shared by the registry and the tool body. */
export function readPathsShapeError(args: Readonly<Record<string, unknown>> | undefined): string | null {
	const paths = args?.paths;
	if (!Array.isArray(paths) || paths.length === 0) return null;
	if (paths.some((path) => typeof path !== "string" || path.length === 0)) {
		return 'read: paths must be an array of file path strings, as in {"paths":["src/a.py","src/b.py"]}';
	}
	if (paths.length > READ_PATHS_MAX) {
		return `read: paths takes at most ${READ_PATHS_MAX} files per call (got ${paths.length}); split the list`;
	}
	if (args?.pages !== undefined || args?.member !== undefined) {
		return "read: pages and member apply to one document; read it with path, not paths";
	}
	return null;
}

/** The single-path reads a call expands into, or null for a call that is one read (or whose `paths` is malformed). */
export function readFanOut(
	args: Readonly<Record<string, unknown>> | undefined,
): { paths: string[]; shared: Record<string, unknown> } | null {
	const paths = args?.paths;
	if (!Array.isArray(paths) || paths.length === 0 || readPathsShapeError(args) !== null) return null;
	const first = typeof args?.path === "string" && args.path.length > 0 ? [args.path] : [];
	const shared = Object.fromEntries(Object.entries(args ?? {}).filter(([key]) => !NOT_SHARED.has(key)));
	return { paths: [...new Set([...first, ...(paths as string[])])], shared };
}

/** One path of a multi-path read: its verdict, or null when the call's cap was spent before it started. */
export interface ReadFanOutEntry {
	path: string;
	verdict: RegistryVerdict | null;
}

function entryText(entry: ReadFanOutEntry): string {
	const { verdict } = entry;
	if (verdict === null) return "not read: this call's byte cap was used by the files above; read it in another call";
	if (verdict.kind !== "ok") return `not read: ${verdict.reason}`;
	return verdict.result.kind === "ok" ? verdict.result.output : verdict.result.message;
}

/**
 * Join the per-path verdicts. When every started read was blocked the call is blocked, with the first refusal's
 * decision and each path's reason; otherwise it is one ok result with a `== <path> ==` header per file, a refused
 * or failed path carrying its own reason in place. `details.reads` keeps each path's own details for consumers
 * that key on a single read (citation grounding).
 */
export function joinReadFanOut(reads: ReadonlyArray<ReadFanOutEntry>): RegistryVerdict {
	const output = reads.map((entry) => `== ${entry.path} ==\n${entryText(entry)}`).join("\n\n");
	const settled = reads.flatMap((entry) => (entry.verdict === null ? [] : [entry.verdict]));
	const ran = settled.find((verdict) => verdict.kind === "ok");
	if (ran === undefined || ran.kind !== "ok") {
		const blocked = settled[0];
		if (blocked === undefined) throw new Error("read fan-out: no path was started");
		return blocked.kind === "ok" ? blocked : { ...blocked, reason: output };
	}
	const images = settled.flatMap((verdict) =>
		verdict.kind === "ok" && verdict.result.kind === "ok" ? (verdict.result.images ?? []) : [],
	);
	return {
		...ran,
		result: {
			kind: "ok",
			output,
			...(images.length > 0 ? { images } : {}),
			details: {
				reads: reads.map((entry) => ({
					path: entry.path,
					status:
						entry.verdict === null
							? "not_started"
							: entry.verdict.kind !== "ok"
								? "refused"
								: entry.verdict.result.kind === "ok"
									? "ok"
									: "error",
					...(entry.verdict?.kind === "ok" && entry.verdict.result.details !== undefined
						? { details: entry.verdict.result.details }
						: {}),
				})),
			},
		},
	};
}

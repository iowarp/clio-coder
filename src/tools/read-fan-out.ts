import { resolveGuardrail } from "../core/guardrails.js";
import { denialLines } from "../domains/safety/denial.js";
import { formatModelRejection } from "../domains/safety/rejection-feedback.js";
import type { RegistryVerdict } from "./registry.js";
import { truncateUtf8 } from "./truncate-utf8.js";

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

/** Carries a malformed `paths` refusal through single-call admission in place of the array (review-sol-1 point 4). */
export const MALFORMED_READ_PATHS = "malformedPaths";

/**
 * A call whose `paths` cannot be expanded, rewritten so nothing downstream sees the array: admission and the loop
 * middleware get a read with no path, and the body returns the shape refusal it carries.
 */
export function malformedReadPathsCall(
	args: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> | null {
	const refusal = readPathsShapeError(args);
	return refusal === null ? null : { [MALFORMED_READ_PATHS]: refusal };
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

/** What every path keeps back from the shared cap for its header, separator and a refusal or not-read note. */
const ENTRY_OVERHEAD_BYTES = 160;

/** One path of a multi-path read: its verdict, or null when the call's cap was spent before it started. */
export interface ReadFanOutEntry {
	path: string;
	verdict: RegistryVerdict | null;
	/** The text the model reads for this path, already cut to what the cap had left. */
	text: string;
}

const NOT_STARTED = "not read: this call's byte cap was used by the files above; read it in another call";

/** The header each path's section opens with, counted against the cap like the body. */
function readFanOutHeader(path: string): string {
	return `== ${path} ==\n`;
}

/**
 * The shared cap as a running balance. Every path is charged its header, the separator and its text, whatever the
 * text is (file content, a tool error, a refusal with its hints), and each path keeps `ENTRY_OVERHEAD_BYTES` in
 * reserve so a later path can always be named as refused or not read (review-sol-1 point 1).
 */
export function createReadFanOutBudget(paths: ReadonlyArray<string>, capBytes: number) {
	let left = capBytes;
	let pending = paths.length;
	const reserve = (): number => pending * ENTRY_OVERHEAD_BYTES;
	return {
		/** Bytes the next path's body may use, or 0 when only its note fits. */
		open(path: string): number {
			pending -= 1;
			left -= Buffer.byteLength(readFanOutHeader(path)) + 2;
			return Math.max(0, left - reserve() - ENTRY_OVERHEAD_BYTES);
		},
		/** Cut one path's text to what is left and charge it. */
		settle(text: string): string {
			const room = Math.max(ENTRY_OVERHEAD_BYTES, left - reserve());
			const cut = truncateUtf8(text, room, "\n[cut: this call's byte cap]");
			left -= Buffer.byteLength(cut);
			return cut;
		},
	};
}

/** The text the model reads for one settled path: the result as the single call would show it. */
export function readFanOutText(verdict: RegistryVerdict | null): string {
	if (verdict === null) return NOT_STARTED;
	if (verdict.kind === "not_visible") return `not read: ${verdict.reason}`;
	if (verdict.kind === "blocked") {
		// The same composition a single refused call gets (agent-tools): reason, the policy's why and hints, the denial.
		const rejection = "rejection" in verdict.decision ? verdict.decision.rejection : undefined;
		const account = verdict.denial !== undefined ? denialLines(verdict.denial) : undefined;
		return `not read: ${formatModelRejection(verdict.reason, rejection, account)}`;
	}
	const { result } = verdict;
	if (result.kind === "error") return result.message;
	// An image rides outside the text cap, so a multi-path call does not carry one.
	if (result.images !== undefined && result.images.length > 0) return "not shown: an image is read alone, with path";
	return result.modelContext ?? result.output;
}

type ReadStatus = "ok" | "error" | "refused" | "not_started";

function statusOf(verdict: RegistryVerdict | null): ReadStatus {
	if (verdict === null) return "not_started";
	if (verdict.kind !== "ok") return "refused";
	return verdict.result.kind === "ok" ? "ok" : "error";
}

/**
 * Join the per-path verdicts into the one verdict the call returns.
 * - Every started path refused: the call is blocked, with the first refusal's decision and each path's reason.
 * - No path returned content (errors, or errors beside refusals): an error result, so a batch of failures is never
 *   reported as a success (review-sol-1 point 2).
 * - Otherwise one ok result with a header per file, a refused or failed path carrying its own text in place.
 * `details.reads` keeps each path's status and own details for consumers that key on a single read (citation
 * grounding); when the spent turn pool stopped every path before it ran, the top-level `notExecuted` marker and
 * `observation` of a single such read are kept.
 */
export function joinReadFanOut(reads: ReadonlyArray<ReadFanOutEntry>, capBytes: number): RegistryVerdict {
	const joined = reads.map((entry) => `${readFanOutHeader(entry.path)}${entry.text}`).join("\n\n");
	// The balance already holds the sum under the cap; this is the backstop if a caller skipped it.
	const output = truncateUtf8(joined, capBytes, "\n[cut: this call's byte cap]");
	const settled = reads.flatMap((entry) => (entry.verdict === null ? [] : [entry.verdict]));
	const ran = settled.find((verdict) => verdict.kind === "ok");
	if (ran === undefined || ran.kind !== "ok") {
		const blocked = settled[0];
		if (blocked === undefined) throw new Error("read fan-out: no path was started");
		if (blocked.kind !== "blocked") return blocked;
		const reasons = reads.map((entry) =>
			entry.verdict?.kind === "blocked" || entry.verdict?.kind === "not_visible"
				? `${entry.path}: ${entry.verdict.reason}`
				: `${entry.path}: not read`,
		);
		return { ...blocked, reason: reasons.join("\n") };
	}
	const results = settled.flatMap((verdict) => (verdict.kind === "ok" ? [verdict.result] : []));
	const shown = results.filter((result) => result.kind === "ok");
	const stopped = shown.filter((result) => result.details?.notExecuted !== undefined);
	const first = stopped[0];
	const details = {
		...(first !== undefined && stopped.length === shown.length
			? { observation: first.details?.observation, notExecuted: first.details?.notExecuted }
			: {}),
		reads: reads.map((entry) => ({
			path: entry.path,
			status: statusOf(entry.verdict),
			...(entry.verdict?.kind === "ok" && entry.verdict.result.details !== undefined
				? { details: entry.verdict.result.details }
				: {}),
		})),
	};
	return {
		...ran,
		result: shown.length === 0 ? { kind: "error", message: output, details } : { kind: "ok", output, details },
	};
}

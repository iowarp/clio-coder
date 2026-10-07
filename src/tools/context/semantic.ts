import { ToolNames } from "../../core/tool-names.js";
import type { SemanticFilters, SemanticSearchResult, SemanticSourceKind } from "../../domains/semantic/index.js";
import type { ObservationReservation } from "../observation.js";
import {
	commitObservationReservation,
	createObservationPathFilter,
	finalizeObservation,
	releaseObservation,
} from "../observation.js";
import type { ToolInvokeOptions, ToolResult } from "../registry.js";

export type ContextSemanticRequest = Pick<SemanticFilters, "kinds" | "runId" | "mediaType" | "after" | "before"> & {
	query: string;
	limit: number;
};

export type ContextSemanticSearch = (
	request: ContextSemanticRequest,
	context: { cwd: string; signal?: AbortSignal; allowsPath?: (path: string) => boolean },
) => Promise<SemanticSearchResult>;

export interface ContextSemanticDeps {
	/** Bound by the host to the live opt-in setting; absent dependencies fail closed. */
	isEnabled(): boolean;
	/** Resolves the ownership-scoped bridge only on an enabled, valid search. No refresh or inference here. */
	loadSearch(): Promise<ContextSemanticSearch>;
}

export const SEMANTIC_TOOL_MAX_QUERY_CHARS = 2000;
export const SEMANTIC_TOOL_TIMEOUT_MS = 6000;
const KINDS: readonly SemanticSourceKind[] = ["code", "wiki", "memory", "evidence", "inbox", "recording"];
const ARGUMENTS = new Set(["scope", "query", "limit", "kinds", "run_id", "media_type", "after", "before"]);
const UNAVAILABLE =
	"context: semantic search is disabled or unavailable in this run. Use code_nav, grep, or evidence to locate original sources.";

export function semanticUnavailable(): ToolResult {
	return { kind: "error", message: UNAVAILABLE };
}

function parseRequest(args: Record<string, unknown>): ContextSemanticRequest | string {
	if (Object.keys(args).some((key) => !ARGUMENTS.has(key)))
		return "Semantic search accepts query, limit, kinds, run_id, media_type, after and before; project, visibility and eligibility are host-owned.";
	if (typeof args.query !== "string" || !args.query.trim() || args.query.length > SEMANTIC_TOOL_MAX_QUERY_CHARS)
		return `Semantic query must contain 1-${SEMANTIC_TOOL_MAX_QUERY_CHARS} characters.`;
	const limit = args.limit ?? 5;
	if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 20)
		return "Semantic limit must be an integer from 1 to 20.";
	if (
		args.kinds !== undefined &&
		(!Array.isArray(args.kinds) ||
			args.kinds.length < 1 ||
			args.kinds.length > KINDS.length ||
			args.kinds.some((kind: unknown) => typeof kind !== "string" || !KINDS.includes(kind as SemanticSourceKind)))
	)
		return `Semantic kinds must contain 1-${KINDS.length} supported source kinds.`;
	for (const name of ["run_id", "media_type"] as const)
		if (args[name] !== undefined && (typeof args[name] !== "string" || !args[name].trim() || args[name].length > 256))
			return `Semantic ${name} must contain 1-256 characters.`;
	const dates: { after?: string; before?: string } = {};
	for (const name of ["after", "before"] as const) {
		const value = args[name];
		if (value === undefined) continue;
		if (
			typeof value !== "string" ||
			value.length > 32 ||
			!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) ||
			!Number.isFinite(Date.parse(value))
		)
			return `Semantic ${name} must be an ISO date or timestamp.`;
		const canonical = new Date(value).toISOString();
		if (canonical.slice(0, 10) !== value.slice(0, 10)) return `Semantic ${name} must use a valid UTC date.`;
		// A date-only upper bound includes its whole UTC day.
		dates[name] = name === "before" && !value.includes("T") ? `${value}T23:59:59.999Z` : canonical;
	}
	if (dates.after && dates.before && dates.after > dates.before) return "Semantic after must not follow before.";
	return {
		query: args.query.trim(),
		limit,
		...(args.kinds ? { kinds: [...new Set(args.kinds as SemanticSourceKind[])] } : {}),
		...(typeof args.run_id === "string" ? { runId: args.run_id } : {}),
		...(typeof args.media_type === "string" ? { mediaType: args.media_type } : {}),
		...dates,
	};
}

/** This explicit observation never refreshes sources or appends prompt/session entries. */
export async function runSemanticScope(
	deps: ContextSemanticDeps,
	args: Record<string, unknown>,
	cwd: string,
	reservation: ObservationReservation,
	options?: ToolInvokeOptions,
): Promise<ToolResult> {
	const request = parseRequest(args);
	if (typeof request === "string") return { kind: "error", message: `context: ${request}` };
	const controller = new AbortController();
	let rejectAborted: ((reason: Error) => void) | undefined;
	const aborted = new Promise<never>((_, reject) => {
		rejectAborted = reject;
	});
	const cancel = () => {
		controller.abort();
		rejectAborted?.(new Error("semantic search cancelled"));
	};
	options?.signal?.addEventListener("abort", cancel, { once: true });
	const timer = setTimeout(() => {
		controller.abort();
		rejectAborted?.(new Error("semantic search exceeded its time budget"));
	}, SEMANTIC_TOOL_TIMEOUT_MS);
	commitObservationReservation(reservation);
	try {
		if (!deps.isEnabled()) return semanticUnavailable();
		if (options?.signal?.aborted) {
			controller.abort();
			return { kind: "error", message: "context: semantic search cancelled" };
		}
		const paths = createObservationPathFilter(cwd, options?.allowsObservationPath);
		const search = async () => {
			const callback = await deps.loadSearch();
			controller.signal.throwIfAborted();
			if (!deps.isEnabled()) return null;
			return callback(request, { cwd, signal: controller.signal, allowsPath: (path) => paths.allows(path) });
		};
		const result = await Promise.race([search(), aborted]);
		controller.signal.throwIfAborted();
		if (!result || !deps.isEnabled()) return semanticUnavailable();
		// The bridge owns project/visibility/memory eligibility; repeat registry path protection before rendering or offload.
		const hits = result.hits
			.slice(0, request.limit)
			.filter((hit) => hit.kind === "memory" || paths.allows(hit.path))
			.map((hit) => ({
				id: hit.id,
				sourceId: hit.sourceId,
				kind: hit.kind,
				path: hit.path,
				location: {
					...(hit.location.line !== undefined ? { line: hit.location.line } : {}),
					...(hit.location.endLine !== undefined ? { endLine: hit.location.endLine } : {}),
					...(hit.location.byte !== undefined ? { byte: hit.location.byte } : {}),
					...(hit.location.page !== undefined ? { page: hit.location.page } : {}),
					...(hit.location.cell !== undefined ? { cell: hit.location.cell } : {}),
					...(hit.location.output !== undefined ? { output: hit.location.output } : {}),
					...(hit.location.frame !== undefined ? { frame: hit.location.frame } : {}),
					...(hit.location.startSeconds !== undefined ? { startSeconds: hit.location.startSeconds } : {}),
					...(hit.location.endSeconds !== undefined ? { endSeconds: hit.location.endSeconds } : {}),
				},
				excerpt: hit.excerpt.slice(0, 480),
				score: hit.score,
				method: hit.method,
				mediaType: hit.mediaType,
				...(hit.evidenceId ? { evidenceId: hit.evidenceId } : {}),
				...(hit.runId ? { runId: hit.runId } : {}),
				...(hit.experimentId ? { experimentId: hit.experimentId } : {}),
			}));
		const payload = {
			hits,
			generation: result.generation,
			profileKey: result.profileKey,
			indexedAt: result.indexedAt,
			pending: result.pending,
			truncated: result.truncated || result.hits.length > request.limit,
			...(result.fallbackReason ? { fallbackReason: result.fallbackReason.slice(0, 256) } : {}),
			followUp:
				"These candidates locate sources. Inspect originals before making claims: for evidence or recording hits call evidence(mode=inspect,id=hit.evidenceId); direct reads of XDG evidence paths may be blocked. Use read, code_nav or artifact readers for other sources. Similarity does not establish correctness.",
		};
		const totalHitCount = hits.length;
		const fullOutput = JSON.stringify(payload);
		let output = fullOutput;
		while (Buffer.byteLength(output) > reservation.callCapBytes && payload.hits.length) {
			payload.hits.pop();
			payload.truncated = true;
			output = JSON.stringify(payload);
		}
		return finalizeObservation({
			tool: ToolNames.Context,
			unit: "results",
			format: "json",
			output,
			shownCount: payload.hits.length,
			totalCount: result.truncated ? null : totalHitCount,
			truncated: payload.truncated,
			reservation,
			withheldPaths: paths.withheldPaths,
			...(output !== fullOutput ? { fullOutput } : {}),
			...(options ? { options } : {}),
		});
	} catch (error) {
		return {
			kind: "error",
			message: `context: semantic search unavailable: ${(error instanceof Error ? error.message : String(error)).slice(0, 256)}. Use code_nav, grep, or evidence to inspect originals.`,
		};
	} finally {
		clearTimeout(timer);
		options?.signal?.removeEventListener("abort", cancel);
		releaseObservation(reservation);
	}
}

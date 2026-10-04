import type { AcpArtifactPage, AcpArtifactReadRequest, AcpArtifactRow } from "./types.js";

export type { AcpArtifactPage, AcpArtifactReadRequest, AcpArtifactRow } from "./types.js";
export { ACP_ARTIFACTS_LIST_METHOD, ACP_ARTIFACTS_META_KEY, ACP_ARTIFACTS_READ_METHOD } from "./types.js";

/**
 * `_clio-coder/artifacts/list` and `_clio-coder/artifacts/read`: the session's
 * `/view` artifacts for an ACP client (ACP ask 03).
 *
 * Both read the providers the terminal overlay reads, from
 * src/domains/session/view-artifacts.ts, so a client lists the same rows with
 * the same titles and reads the same lines. Titles and subtitles pass through
 * the overlay's own sanitizer; bodies travel as loaded, as the overlay shows
 * them. A protected artifact's load renders its protection record, never the
 * file, and its read carries the refusal reason.
 *
 * The provider module loads on first use, so the server chunk does not carry
 * the evidence, receipt and audit readers until a client asks.
 */

import type {
	ArtifactProvider,
	ArtifactProviderDeps,
	ViewArtifact,
	ViewArtifactCategory,
	ViewArtifactFormat,
} from "../../domains/session/view-artifacts.js";
import { AcpRequestError } from "./errors.js";

/**
 * Every `/view` category except `transcript`, which is the terminal chat
 * panel's rendering of the conversation a client already holds.
 */
export const ACP_ARTIFACT_CATEGORIES: readonly ViewArtifactCategory[] = [
	"accountability",
	"evidence",
	"receipt",
	"dispatch",
	"task-ledger",
	"workspace",
	"tool-output",
	"protected-artifact",
	"compaction",
	"prompt-manifest",
	"audit",
	"system-prompt",
];

const CATEGORY_SET = new Set<string>(ACP_ARTIFACT_CATEGORIES);
/** Rows per category in one list, newest first. */
export const ACP_ARTIFACTS_PER_CATEGORY = 200;
const DEFAULT_READ_LINES = 2_000;
/** JSON-encoded bytes of one page's lines, well inside the transport's 1 MiB frame. */
const MAX_PAGE_BYTES = 512 * 1024;
const MAX_TITLE_BYTES = 512;
const MAX_SUBTITLE_BYTES = 1_024;

/** The bound session's provider inputs; null when `sessionId` is not the session this host is running. */
export interface AcpArtifactsSource {
	deps(sessionId: string): ArtifactProviderDeps | null;
}

const loadProviders = async (): Promise<typeof import("../../domains/session/view-artifacts.js")> =>
	await import("../../domains/session/view-artifacts.js");

function utf8Slice(value: string, maxBytes: number): string {
	const buffer = Buffer.from(value, "utf8");
	if (buffer.length <= maxBytes) return value;
	// toString drops a code point split at the cut instead of emitting half of it.
	return `${buffer
		.subarray(0, Math.max(0, maxBytes - 3))
		.toString("utf8")
		.replace(/�$/u, "")}…`;
}

function invalid(message: string): AcpRequestError {
	return new AcpRequestError(-32602, message, { code: "invalid_params" });
}

export function parseArtifactCategories(value: unknown): ViewArtifactCategory[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > ACP_ARTIFACT_CATEGORIES.length) {
		throw invalid("categories must be an array of artifact categories");
	}
	for (const item of value) {
		if (typeof item !== "string" || !CATEGORY_SET.has(item)) throw invalid("categories names an unknown category");
	}
	return value as ViewArtifactCategory[];
}

function nonNegativeInteger(value: unknown, name: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw invalid(`${name} must be a non-negative integer`);
	}
	return value;
}

function expectedFormat(
	artifact: ViewArtifact,
	workspaceFormat: (path: string) => ViewArtifactFormat,
): ViewArtifactFormat {
	if (artifact.id.endsWith(":read-errors")) return "markdown";
	switch (artifact.category) {
		case "dispatch":
		case "tool-output":
		case "transcript":
			return "text";
		case "prompt-manifest":
		case "audit":
			return "json";
		case "workspace":
			return artifact.path ? workspaceFormat(artifact.path) : "text";
		case "system-prompt":
			return artifact.timestamp > 0 ? "markdown" : "text";
		default:
			return "markdown";
	}
}

function providersFor(
	mod: Awaited<ReturnType<typeof loadProviders>>,
	deps: ArtifactProviderDeps,
	categories: ReadonlySet<string>,
): ArtifactProvider[] {
	return mod.createDefaultArtifactProviders(deps).filter((provider) => categories.has(provider.category));
}

export async function listAcpArtifacts(
	deps: ArtifactProviderDeps,
	categories: ReadonlyArray<ViewArtifactCategory> | undefined,
): Promise<{ artifacts: AcpArtifactRow[]; truncated: boolean }> {
	const mod = await loadProviders();
	const wanted = new Set<string>(categories ?? ACP_ARTIFACT_CATEGORIES);
	const sorted = await mod.listViewArtifacts(providersFor(mod, deps, wanted));
	const perCategory = new Map<string, number>();
	const artifacts: AcpArtifactRow[] = [];
	let truncated = false;
	for (const artifact of sorted) {
		const seen = perCategory.get(artifact.category) ?? 0;
		if (seen >= ACP_ARTIFACTS_PER_CATEGORY) {
			truncated = true;
			continue;
		}
		perCategory.set(artifact.category, seen + 1);
		artifacts.push({
			id: `${artifact.category}/${artifact.id}`,
			category: artifact.category,
			title: utf8Slice(mod.viewArtifactDisplayText(artifact.title), MAX_TITLE_BYTES),
			...(artifact.description
				? { subtitle: utf8Slice(mod.viewArtifactDisplayText(artifact.description), MAX_SUBTITLE_BYTES) }
				: {}),
			...(artifact.timestamp > 0 ? { at: new Date(artifact.timestamp).toISOString() } : {}),
			...(artifact.sizeBytes !== undefined ? { sizeBytes: artifact.sizeBytes } : {}),
			format: expectedFormat(artifact, mod.workspaceArtifactFormat),
			...(artifact.refusal !== undefined ? { protected: true as const } : {}),
		});
	}
	return { artifacts, truncated };
}

export function parseArtifactReadRequest(params: Record<string, unknown>): AcpArtifactReadRequest {
	const id = params.id;
	if (typeof id !== "string" || id.length === 0 || Buffer.byteLength(id, "utf8") > 8_192) {
		throw invalid("id is required");
	}
	if (params.details !== undefined && typeof params.details !== "boolean") throw invalid("details must be a boolean");
	const offset = nonNegativeInteger(params.offset, "offset");
	const limit = nonNegativeInteger(params.limit, "limit");
	if (limit === 0) throw invalid("limit must be positive");
	return {
		id,
		...(offset !== undefined ? { offset } : {}),
		...(limit !== undefined ? { limit } : {}),
		...(params.details === true ? { details: true } : {}),
	};
}

export async function readAcpArtifact(
	deps: ArtifactProviderDeps,
	request: AcpArtifactReadRequest,
): Promise<AcpArtifactPage> {
	const slash = request.id.indexOf("/");
	const category = slash > 0 ? request.id.slice(0, slash) : "";
	const providerId = request.id.slice(slash + 1);
	const unknown = () => new AcpRequestError(-32602, "unknown artifact", { code: "artifact_unknown" });
	if (!CATEGORY_SET.has(category)) throw unknown();
	const mod = await loadProviders();
	const [provider] = providersFor(mod, deps, new Set([category]));
	const artifact = provider ? (await provider.list()).find((item) => item.id === providerId) : undefined;
	if (!artifact) throw unknown();
	const loaded = await artifact.load();
	const source = request.details ? loaded.details : loaded;
	if (!source) throw invalid("artifact has no details view");

	const { VIEW_ARTIFACT_LINE_CAP } = mod;
	const totalLines = source.lines.length;
	const offset = Math.min(request.offset ?? 0, totalLines);
	const limit = Math.min(request.limit ?? DEFAULT_READ_LINES, VIEW_ARTIFACT_LINE_CAP);
	const lines: string[] = [];
	let bytes = 0;
	let clippedLines = 0;
	let index = offset;
	for (; index < totalLines && lines.length < limit; index++) {
		let line = source.lines[index] ?? "";
		let size = Buffer.byteLength(JSON.stringify(line), "utf8") + 1;
		if (size > MAX_PAGE_BYTES - bytes) {
			// A later page takes this line whole; only a line larger than a page is cut.
			if (lines.length > 0) break;
			line = utf8Slice(line, MAX_PAGE_BYTES / 8);
			size = Buffer.byteLength(JSON.stringify(line), "utf8") + 1;
			clippedLines++;
		}
		lines.push(line);
		bytes += size;
	}
	return {
		id: request.id,
		category: artifact.category,
		title: utf8Slice(mod.viewArtifactDisplayText(artifact.title), MAX_TITLE_BYTES),
		format: source.format,
		lines,
		offset,
		totalLines,
		nextOffset: index < totalLines ? index : null,
		...(clippedLines > 0 ? { clippedLines } : {}),
		...(!request.details && loaded.details
			? { details: { format: loaded.details.format, lineCount: loaded.details.lines.length } }
			: {}),
		...(artifact.refusal !== undefined ? { refused: { reason: mod.viewArtifactDisplayText(artifact.refusal) } } : {}),
	};
}

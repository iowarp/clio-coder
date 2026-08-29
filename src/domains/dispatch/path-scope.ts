import {
	asDirectoryPathBoundary,
	normalizePathBoundaryEntry,
	PathBoundaryError,
	pathBoundaryCovers,
	resolvePathBoundary,
} from "../../core/path-boundary.js";
import type { DispatchRequest } from "./contract.js";

/** Path-like tokens retained for requests that do not carry typed intent. */
const DISPATCH_PATH_TOKEN_RE = /(?:[\w.-]+\/)+[\w.-]+|\b[\w-]+\.[A-Za-z0-9]{1,8}\b/g;
const HTTP_URL_RE = /\bhttps?:\/\/\S+/gu;
const POSIX_ABSOLUTE_TOKEN_RE = /(?:^|[\s("'])((?:\/[\w.~+-]+)+)/gu;
const WINDOWS_ABSOLUTE_TOKEN_RE = /(?:^|[\s("'])([A-Za-z]:[\\/][^\s"']+)/gu;
const BACKSLASH_PATH_RE = /\b[A-Za-z_.-][\w.-]*\\(?:(?:[\w.-]+\\)+[\w.-]+|[\w-]+\.[A-Za-z0-9]{1,8})\b/gu;
const DOUBLE_SEPARATOR_PATH_RE = /\b[\w.-]+\/\/[\w./-]+/gu;

export type DispatchPathProvenanceKind = "declared" | "derived" | "inferred";
export type DispatchPathConfidence = "certain" | "high" | "medium" | "low";
export type DispatchPathProvenanceSource =
	| "intent.read_roots"
	| "intent.write_roots"
	| "intent.relevant_paths"
	| "writeRoots"
	| "task"
	| "briefing";
export type DispatchPathProvenanceReason =
	| "explicit_intent"
	| "legacy_write_roots"
	| "task_path_token"
	| "briefing_path_token";

export interface DispatchPathProvenanceEvidence {
	provenance: DispatchPathProvenanceKind;
	source: DispatchPathProvenanceSource;
	confidence: DispatchPathConfidence;
	reason: DispatchPathProvenanceReason;
}

export interface DispatchPathProvenanceEntry {
	path: string;
	evidence: DispatchPathProvenanceEvidence[];
}

export interface DispatchPathScopeProvenance {
	version: 1;
	mode: "declared" | "legacy-inferred";
	workingContextPaths: DispatchPathProvenanceEntry[];
	writeBoundaries: DispatchPathProvenanceEntry[];
}

export interface DispatchPathScope {
	source: "declared" | "inferred";
	workingContextPaths: ReadonlyArray<string>;
	writeBoundaries: ReadonlyArray<string>;
	inferredOnlyPaths: ReadonlyArray<string>;
	provenance: DispatchPathScopeProvenance;
}

export interface DeclaredScopeReplacementNotice {
	code: "typed_scope_replaced_inferred_paths";
	level: "warning";
	omittedPaths: ReadonlyArray<string>;
	message: string;
}

export interface LegacyScopeInferenceNotice {
	code: "legacy_scope_inferred" | "legacy_scope_empty";
	level: "warning";
	paths: ReadonlyArray<{
		path: string;
		policy: "working-context" | "write-boundary";
		provenance: DispatchPathProvenanceKind;
		source: DispatchPathProvenanceSource;
		confidence: DispatchPathConfidence;
	}>;
	message: string;
}

export type DispatchPathScopeInferenceErrorCode = "legacy_scope_path_absolute" | "legacy_scope_path_malformed";

export class DispatchPathScopeInferenceError extends Error {
	readonly code: DispatchPathScopeInferenceErrorCode;
	readonly source: "task" | "briefing";
	readonly token: string;

	constructor(code: DispatchPathScopeInferenceErrorCode, source: "task" | "briefing", token: string, detail: string) {
		super(`${code}: ${source} contains ${detail} '${token}'; declare intent explicitly`);
		this.name = "DispatchPathScopeInferenceError";
		this.code = code;
		this.source = source;
		this.token = token;
	}
}

const DECLARED_EVIDENCE = {
	readRoots: {
		provenance: "declared",
		source: "intent.read_roots",
		confidence: "certain",
		reason: "explicit_intent",
	},
	writeRoots: {
		provenance: "declared",
		source: "intent.write_roots",
		confidence: "certain",
		reason: "explicit_intent",
	},
	relevantPaths: {
		provenance: "declared",
		source: "intent.relevant_paths",
		confidence: "certain",
		reason: "explicit_intent",
	},
} as const satisfies Record<"readRoots" | "writeRoots" | "relevantPaths", DispatchPathProvenanceEvidence>;

function cloneEvidence(evidence: DispatchPathProvenanceEvidence): DispatchPathProvenanceEvidence {
	return { ...evidence };
}

function addProvenance(
	entries: Map<string, DispatchPathProvenanceEntry>,
	path: string,
	evidence: DispatchPathProvenanceEvidence,
): void {
	const current = entries.get(path);
	if (current === undefined) {
		entries.set(path, { path, evidence: [cloneEvidence(evidence)] });
		return;
	}
	if (!current.evidence.some((entry) => entry.source === evidence.source)) {
		current.evidence.push(cloneEvidence(evidence));
	}
}

function sortedEntries(entries: Map<string, DispatchPathProvenanceEntry>): DispatchPathProvenanceEntry[] {
	return [...entries.values()]
		.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
		.map((entry) => ({ path: entry.path, evidence: entry.evidence.map(cloneEvidence) }));
}

/** Build the required field-level provenance for normalized declared intent. */
export function declaredIntentPathProvenance(input: {
	readRoots: ReadonlyArray<string>;
	writeRoots: ReadonlyArray<string>;
	relevantPaths: ReadonlyArray<string>;
}): DispatchPathProvenanceEntry[] {
	const entries = new Map<string, DispatchPathProvenanceEntry>();
	for (const path of input.readRoots) addProvenance(entries, path, DECLARED_EVIDENCE.readRoots);
	for (const path of input.writeRoots) addProvenance(entries, path, DECLARED_EVIDENCE.writeRoots);
	for (const path of input.relevantPaths) addProvenance(entries, path, DECLARED_EVIDENCE.relevantPaths);
	return sortedEntries(entries);
}

function inferredPaths(req: Pick<DispatchRequest, "task" | "briefing">): string[] {
	const paths = new Set<string>();
	const text = `${req.task}\n${req.briefing ?? ""}`;
	for (const match of text.matchAll(DISPATCH_PATH_TOKEN_RE)) {
		const token = inferredPathToken(match[0]);
		if (token.startsWith("http://") || token.startsWith("https://")) continue;
		paths.add(token);
	}
	return [...paths];
}

function inferredPathToken(token: string): string {
	return token.replace(/\.+$/u, "");
}

function failMalformedText(text: string, source: "task" | "briefing"): void {
	const withoutUrls = text.replace(HTTP_URL_RE, (url) => " ".repeat(url.length));
	const absolute = POSIX_ABSOLUTE_TOKEN_RE.exec(withoutUrls)?.[1];
	POSIX_ABSOLUTE_TOKEN_RE.lastIndex = 0;
	if (absolute !== undefined) {
		throw new DispatchPathScopeInferenceError("legacy_scope_path_absolute", source, absolute, "an absolute path token");
	}
	const windowsAbsolute = WINDOWS_ABSOLUTE_TOKEN_RE.exec(withoutUrls)?.[1];
	WINDOWS_ABSOLUTE_TOKEN_RE.lastIndex = 0;
	if (windowsAbsolute !== undefined) {
		throw new DispatchPathScopeInferenceError(
			"legacy_scope_path_absolute",
			source,
			windowsAbsolute,
			"an absolute path token",
		);
	}
	for (const pattern of [BACKSLASH_PATH_RE, DOUBLE_SEPARATOR_PATH_RE]) {
		const malformed = pattern.exec(withoutUrls)?.[0];
		pattern.lastIndex = 0;
		if (malformed !== undefined) {
			throw new DispatchPathScopeInferenceError(
				"legacy_scope_path_malformed",
				source,
				malformed,
				"a malformed path token",
			);
		}
	}
}

function strictInferredPaths(
	text: string,
	source: "task" | "briefing",
): Array<{ path: string; evidence: DispatchPathProvenanceEvidence }> {
	failMalformedText(text, source);
	const withoutUrls = text.replace(HTTP_URL_RE, (url) => " ".repeat(url.length));
	const evidence: DispatchPathProvenanceEvidence =
		source === "task"
			? { provenance: "inferred", source, confidence: "medium", reason: "task_path_token" }
			: { provenance: "inferred", source, confidence: "low", reason: "briefing_path_token" };
	const result: Array<{ path: string; evidence: DispatchPathProvenanceEvidence }> = [];
	for (const match of withoutUrls.matchAll(DISPATCH_PATH_TOKEN_RE)) {
		const token = inferredPathToken(match[0]);
		try {
			result.push({ path: normalizePathBoundaryEntry(token), evidence });
		} catch (error) {
			const code =
				error instanceof PathBoundaryError && error.code === "absolute"
					? "legacy_scope_path_absolute"
					: "legacy_scope_path_malformed";
			throw new DispatchPathScopeInferenceError(
				code,
				source,
				token,
				code === "legacy_scope_path_absolute" ? "an absolute path token" : "a malformed path token",
			);
		}
	}
	return result;
}

function legacyPathScope(req: DispatchRequest, cwd: string): DispatchPathScope {
	const workingEntries = new Map<string, DispatchPathProvenanceEntry>();
	const writeEntries = new Map<string, DispatchPathProvenanceEntry>();
	const writeEvidence: DispatchPathProvenanceEvidence = {
		provenance: "derived",
		source: "writeRoots",
		confidence: "high",
		reason: "legacy_write_roots",
	};
	for (const root of req.writeRoots ?? []) {
		addProvenance(workingEntries, root, writeEvidence);
		addProvenance(writeEntries, asDirectoryPathBoundary(resolvePathBoundary(cwd, root)), writeEvidence);
	}
	for (const candidate of strictInferredPaths(req.task, "task")) {
		addProvenance(workingEntries, candidate.path, candidate.evidence);
	}
	if (req.briefing !== undefined) {
		for (const candidate of strictInferredPaths(req.briefing, "briefing")) {
			addProvenance(workingEntries, candidate.path, candidate.evidence);
		}
	}
	const workingContext = [...workingEntries.values()].map((entry) => ({
		path: entry.path,
		evidence: entry.evidence.map(cloneEvidence),
	}));
	const writeBoundaries = [...writeEntries.values()].map((entry) => ({
		path: entry.path,
		evidence: entry.evidence.map(cloneEvidence),
	}));
	return {
		source: "inferred",
		workingContextPaths: workingContext.map((entry) => entry.path),
		writeBoundaries: writeBoundaries.map((entry) => entry.path),
		inferredOnlyPaths: [],
		provenance: {
			version: 1,
			mode: "legacy-inferred",
			workingContextPaths: workingContext,
			writeBoundaries,
		},
	};
}

/** Resolve every policy-bearing path projection for one dispatch request. */
export function resolveDispatchPathScope(req: DispatchRequest): DispatchPathScope {
	const cwd = req.cwd ?? process.cwd();
	if (req.intent === undefined) return legacyPathScope(req, cwd);

	const declaredProvenance = declaredIntentPathProvenance(req.intent);
	const declaredPaths = declaredProvenance.map((entry) => entry.path);
	const inferredOnlyPaths = inferredPaths(req).filter((candidate) => !pathBoundaryCovers(declaredPaths, candidate));
	const writeEvidence = DECLARED_EVIDENCE.writeRoots;
	const writeBoundaries = req.intent.writeRoots.map((root) => ({
		path: resolvePathBoundary(cwd, root),
		evidence: [cloneEvidence(writeEvidence)],
	}));
	return {
		source: "declared",
		workingContextPaths: declaredPaths,
		writeBoundaries: writeBoundaries.map((entry) => entry.path),
		inferredOnlyPaths,
		provenance: {
			version: 1,
			mode: "declared",
			workingContextPaths: declaredProvenance,
			writeBoundaries,
		},
	};
}

/** Render the named diagnostic for the declared-scope replacement tradeoff. */
export function declaredScopeReplacementDiagnostic(scope: DispatchPathScope): string | null {
	if (scope.source !== "declared" || scope.inferredOnlyPaths.length === 0) return null;
	return `typed_scope_replaced_inferred_paths: typed intent omitted prose-inferred paths ${scope.inferredOnlyPaths.join(
		", ",
	)}; those paths did not select project rules or expand worker authority`;
}

/** Render the interactive warning for the declared-scope replacement tradeoff. */
export function declaredScopeReplacementNotice(scope: DispatchPathScope): DeclaredScopeReplacementNotice | null {
	if (scope.source !== "declared" || scope.inferredOnlyPaths.length === 0) return null;
	const omittedPaths = [...scope.inferredOnlyPaths];
	return {
		code: "typed_scope_replaced_inferred_paths",
		level: "warning",
		omittedPaths,
		message: `[dispatch scope] typed intent replaced prose path inference; omitted paths: ${omittedPaths.join(
			", ",
		)}. Those paths did not select project rules or expand worker authority.`,
	};
}

function legacyNoticePaths(scope: DispatchPathScope): LegacyScopeInferenceNotice["paths"] {
	const paths: Array<LegacyScopeInferenceNotice["paths"][number]> = [];
	for (const [policy, entries] of [
		["working-context", scope.provenance.workingContextPaths],
		["write-boundary", scope.provenance.writeBoundaries],
	] as const) {
		for (const entry of entries) {
			for (const evidence of entry.evidence) {
				paths.push({
					path: entry.path,
					policy,
					provenance: evidence.provenance,
					source: evidence.source,
					confidence: evidence.confidence,
				});
			}
		}
	}
	return paths;
}

/** Render the operator-visible warning for a legacy scope resolution. */
export function legacyScopeInferenceNotice(scope: DispatchPathScope): LegacyScopeInferenceNotice | null {
	if (scope.source !== "inferred") return null;
	const paths = legacyNoticePaths(scope);
	if (paths.length === 0) {
		return {
			code: "legacy_scope_empty",
			level: "warning",
			paths,
			message:
				"[dispatch scope] legacy dispatch has no declared intent and inferred no policy-bearing paths. Path-scoped rules received no inferred match input, and worker authority did not expand.",
		};
	}
	const rendered = paths
		.map(
			(entry) =>
				`${entry.policy} ${entry.path} (provenance=${entry.provenance} source=${entry.source} confidence=${entry.confidence})`,
		)
		.join("; ");
	return {
		code: "legacy_scope_inferred",
		level: "warning",
		paths,
		message: `[dispatch scope] legacy dispatch resolved policy-bearing scope without declared intent: ${rendered}. Review this scope before execution.`,
	};
}

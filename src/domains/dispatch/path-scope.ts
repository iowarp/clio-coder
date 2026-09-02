import { existsSync } from "node:fs";
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
const PARENT_PREFIX_RE = /^(?:\.\.\/)+/u;

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

/**
 * A prose token whose leading "../" run inference had to reinterpret, kept so
 * the notice can name the raw token beside the scope it produced. `resolved` is
 * the repository path the stripped remainder anchored to, or null when nothing
 * under the dispatch root carried it and the token took no part in scope.
 */
export interface DispatchInferredParentToken {
	token: string;
	resolved: string | null;
	source: "task" | "briefing";
}

export interface DispatchPathScope {
	source: "declared" | "inferred";
	workingContextPaths: ReadonlyArray<string>;
	writeBoundaries: ReadonlyArray<string>;
	inferredOnlyPaths: ReadonlyArray<string>;
	parentTokens: ReadonlyArray<DispatchInferredParentToken>;
	provenance: DispatchPathScopeProvenance;
}

export interface DeclaredScopeReplacementNotice {
	code: "typed_scope_replaced_inferred_paths";
	level: "warning";
	omittedPaths: ReadonlyArray<string>;
	message: string;
}

export interface InferredScopeParentTokenNotice {
	code: "legacy_scope_inferred";
	level: "warning";
	paths: ReadonlyArray<{
		path: string;
		policy: "working-context";
		provenance: "inferred";
		source: "task" | "briefing";
		confidence: "low";
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

/** One prose token read as a repository path, as an anchored "../" quote, or as neither. */
type InferredPathToken =
	| { kind: "token"; token: string }
	| { kind: "anchored"; token: string; resolved: string }
	| { kind: "dropped"; token: string };

function inferredPaths(
	req: Pick<DispatchRequest, "task" | "briefing">,
	root: string,
): { paths: string[]; droppedTokens: string[] } {
	const paths = new Set<string>();
	const droppedTokens = new Set<string>();
	const text = `${req.task}\n${req.briefing ?? ""}`;
	for (const match of text.matchAll(DISPATCH_PATH_TOKEN_RE)) {
		const inferred = inferredPathToken(match[0], root);
		if (inferred.kind === "dropped") {
			droppedTokens.add(inferred.token);
			continue;
		}
		const token = inferred.kind === "anchored" ? inferred.resolved : inferred.token;
		if (token.startsWith("http://") || token.startsWith("https://")) continue;
		paths.add(token);
	}
	return { paths: [...paths], droppedTokens: [...droppedTokens] };
}

/**
 * A leading "./" is how prose quotes an import specifier ("./parser.js"); it
 * names the same repository path without the prefix, and the boundary grammar
 * would otherwise refuse the whole dispatch for a dot segment.
 *
 * A leading "../" run is that same quote copied out of a file whose location
 * this function never sees. Both callers, strictInferredPaths and
 * inferredPaths, are handed the task or briefing text and nothing else, so the
 * origin the run is measured against is unknowable here and no arithmetic on
 * the run's length can decide whether it escapes. What is decidable is whether
 * the remainder names something under the dispatch root, so the run is
 * stripped and the remainder probed: "../src/store.js" quoted out of
 * test/store.test.ts anchors to src/store.js, and "../../../etc/passwd"
 * anchors to nothing in a checkout that holds no etc/passwd.
 *
 * That is a deliberate reading of issue #266, recorded here because it is the
 * one place the choice is made. Criterion 1 ("never rejects the dispatch") and
 * criterion 2 ("a prose token whose .. segments would leave the repository
 * root is still refused") ask for opposite answers on a leading run, and only
 * criterion 1 is decidable without an origin, so a run that names nothing is
 * dropped rather than refused. Neither outcome widens authority: an inferred
 * path selects project rules and compiles context but never becomes a write
 * boundary, and an anchored remainder carries no ".." so path.resolve keeps it
 * under the root. Both outcomes are named to the operator by
 * inferredScopeParentTokenNotice, so the reinterpretation is never silent.
 *
 * The probe costs one existsSync per "../"-leading token (3 microseconds on a
 * hit and 2 on a miss over 5,000 warm calls on this checkout) and no stat at
 * all for the ordinary token, which the grammar matches dozens of per dispatch
 * (the 27 tokens per task measured for REPORTABLE_OMITTED_PATH_RE below).
 *
 * A ".." or "." outside the leading run ("../src/../../b.ts", "../src/./b.ts")
 * walks back out of a segment it already anchored, which is decidable without
 * an origin, so it falls through to the boundary grammar and keeps its
 * refusal, as does a run that leaves no remainder at all ("../..").
 */
function inferredPathToken(raw: string, root: string): InferredPathToken {
	const token = raw.replace(/^\.\//u, "").replace(/\.+$/u, "");
	const parents = PARENT_PREFIX_RE.exec(token)?.[0];
	if (parents === undefined) return { kind: "token", token };
	const rest = token.slice(parents.length);
	const segments = rest.split("/");
	if (rest.length === 0 || segments.includes("..") || segments.includes(".")) return { kind: "token", token };
	return existsSync(resolvePathBoundary(root, rest))
		? { kind: "anchored", token, resolved: rest }
		: { kind: "dropped", token };
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
	root: string,
): {
	paths: Array<{ path: string; evidence: DispatchPathProvenanceEvidence }>;
	parentTokens: DispatchInferredParentToken[];
} {
	failMalformedText(text, source);
	const withoutUrls = text.replace(HTTP_URL_RE, (url) => " ".repeat(url.length));
	const evidence: DispatchPathProvenanceEvidence =
		source === "task"
			? { provenance: "inferred", source, confidence: "medium", reason: "task_path_token" }
			: { provenance: "inferred", source, confidence: "low", reason: "briefing_path_token" };
	const paths: Array<{ path: string; evidence: DispatchPathProvenanceEvidence }> = [];
	const parentTokens: DispatchInferredParentToken[] = [];
	for (const match of withoutUrls.matchAll(DISPATCH_PATH_TOKEN_RE)) {
		const inferred = inferredPathToken(match[0], root);
		if (inferred.kind === "dropped") {
			parentTokens.push({ token: inferred.token, resolved: null, source });
			continue;
		}
		if (inferred.kind === "anchored") {
			parentTokens.push({ token: inferred.token, resolved: inferred.resolved, source });
		}
		const token = inferred.kind === "anchored" ? inferred.resolved : inferred.token;
		try {
			paths.push({ path: normalizePathBoundaryEntry(token), evidence });
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
	return { paths, parentTokens };
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
	// One map across both fields, first field winning: an orchestrator that
	// restates the file it is asking about quotes the same specifier in the task
	// and in the briefing, and the notice must name it once rather than spend two
	// of its twelve render slots on the same token.
	const parentTokens = new Map<string, DispatchInferredParentToken>();
	const recordParentTokens = (entries: ReadonlyArray<DispatchInferredParentToken>): void => {
		for (const entry of entries) if (!parentTokens.has(entry.token)) parentTokens.set(entry.token, entry);
	};
	const taskScope = strictInferredPaths(req.task, "task", cwd);
	for (const candidate of taskScope.paths) addProvenance(workingEntries, candidate.path, candidate.evidence);
	recordParentTokens(taskScope.parentTokens);
	if (req.briefing !== undefined) {
		const briefingScope = strictInferredPaths(req.briefing, "briefing", cwd);
		for (const candidate of briefingScope.paths) addProvenance(workingEntries, candidate.path, candidate.evidence);
		recordParentTokens(briefingScope.parentTokens);
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
		parentTokens: [...parentTokens.values()],
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
	const inferred = inferredPaths(req, cwd);
	// A dropped token cannot be covered by a declaration, so it is always listed.
	// An anchored one is listed under the path it anchored to and goes through
	// the same coverage test the notice has always applied, which is why
	// "../src/store.js" under a declared "src/" stops reading as an omitted path.
	const inferredOnlyPaths = [
		...inferred.paths.filter((candidate) => !pathBoundaryCovers(declaredPaths, candidate)),
		...inferred.droppedTokens,
	];
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
		// Empty on purpose: the declaration is the scope here, so no "../" token
		// changed what the worker sees and there is nothing for the legacy notice
		// to report. A dropped one still reaches the operator through
		// inferredOnlyPaths above.
		parentTokens: [],
		provenance: {
			version: 1,
			mode: "declared",
			workingContextPaths: declaredProvenance,
			writeBoundaries,
		},
	};
}

/**
 * The prose token grammar also matches version numbers, ratios, and Latin
 * abbreviations ("0.5", "v24.9", "e.g", "dead/raw"). Those never select a rule
 * or a boundary, so the replacement notice names only tokens that read as
 * repository paths: a segment with a source or document file extension, or
 * a trailing directory separator. Method names (`Store.fromText`, `store.set`)
 * share the dotted shape and are excluded by the extension list. A live three-task dispatch printed 27
 * "omitted paths" per task, most of them numbers, three times over.
 */
const REPORTABLE_OMITTED_PATH_RE =
	/\.(?:[cm]?[jt]sx?|json|ya?ml|md|txt|py|go|rs|c|h|cc|cpp|hpp|java|rb|sh|toml|css|html|sql|lock)(?:\/|$)|\/$/u;
const OMITTED_PATH_REPORT_CAP = 12;

/** Omitted prose paths worth telling the operator about, capped for the transcript. */
function reportableOmittedPaths(scope: DispatchPathScope): string[] {
	return scope.inferredOnlyPaths.filter((path) => REPORTABLE_OMITTED_PATH_RE.test(path));
}

function renderOmittedPaths(paths: ReadonlyArray<string>): string {
	if (paths.length <= OMITTED_PATH_REPORT_CAP) return paths.join(", ");
	return `${paths.slice(0, OMITTED_PATH_REPORT_CAP).join(", ")} and ${paths.length - OMITTED_PATH_REPORT_CAP} more`;
}

/** Render the named diagnostic for the declared-scope replacement tradeoff. */
export function declaredScopeReplacementDiagnostic(scope: DispatchPathScope): string | null {
	if (scope.source !== "declared") return null;
	const omitted = reportableOmittedPaths(scope);
	if (omitted.length === 0) return null;
	return `typed_scope_replaced_inferred_paths: typed intent omitted prose-inferred paths ${renderOmittedPaths(
		omitted,
	)}; those paths did not select project rules or expand worker authority`;
}

/** Render the interactive warning for the declared-scope replacement tradeoff. */
export function declaredScopeReplacementNotice(scope: DispatchPathScope): DeclaredScopeReplacementNotice | null {
	if (scope.source !== "declared") return null;
	const omittedPaths = reportableOmittedPaths(scope);
	if (omittedPaths.length === 0) return null;
	return {
		code: "typed_scope_replaced_inferred_paths",
		level: "warning",
		omittedPaths,
		message: `[dispatch scope] typed intent replaced prose path inference; omitted paths: ${renderOmittedPaths(
			omittedPaths,
		)}. Those paths did not select project rules or expand worker authority.`,
	};
}

/**
 * A reinterpreted "../" token is the one legacy-mode scope fact worth the
 * transcript. It fires only where a leading "../" run made inference choose
 * between a path the prose never literally spelled and no path at all, which
 * before this release failed the whole dispatch, so unlike a per-dispatch
 * inference notice it cannot warn on the ordinary case that
 * `publishDispatchPathScope` deliberately keeps quiet. The anchored token earns
 * the line more than the dropped one: dropping subtracts from scope, while
 * anchoring puts "src/store.js" in working context because prose said
 * "../src/store.js", and a rewrite the operator cannot see is one nobody can
 * check.
 *
 * Declared mode records none. The declaration is the scope there, and a prose
 * token that never entered it is already the subject of
 * `declaredScopeReplacementNotice`. That notice filters by
 * REPORTABLE_OMITTED_PATH_RE, so a declared-mode drop of "../data/blob.bin" or
 * "../src/helper" is in fact named nowhere; that is the accepted cost of not
 * spending a second per-dispatch notice on a token that took no part in a scope
 * the intent had already fixed.
 *
 * The legacy list is not filtered by REPORTABLE_OMITTED_PATH_RE, because the
 * "../" prefix is itself the filter: the version numbers, ratios, and Latin
 * abbreviations that filter exists for ("0.5", "v24.9", "e.g", "4/10") cannot
 * carry one.
 *
 * Both notices render one `<raw token> -> <anchored path or "dropped">` pair
 * per entry, under the same twelve-entry cap the replacement notice uses.
 */
function renderParentTokens(tokens: ReadonlyArray<DispatchInferredParentToken>): string {
	return renderOmittedPaths(tokens.map((entry) => `${entry.token} -> ${entry.resolved ?? "dropped"}`));
}

/** Render the named diagnostic for prose tokens whose leading "../" run was reinterpreted. */
export function inferredScopeParentTokenDiagnostic(scope: DispatchPathScope): string | null {
	const tokens = scope.parentTokens;
	if (tokens.length === 0) return null;
	return `legacy_scope_inferred: prose inference resolved path tokens carrying a leading '../' run against the dispatch root ${renderParentTokens(
		tokens,
	)}; an anchored token selects project rules without expanding worker authority and a dropped one took no part in scope`;
}

/** Render the interactive warning for prose tokens whose leading "../" run was reinterpreted. */
export function inferredScopeParentTokenNotice(scope: DispatchPathScope): InferredScopeParentTokenNotice | null {
	const tokens = scope.parentTokens;
	if (tokens.length === 0) return null;
	return {
		code: "legacy_scope_inferred",
		level: "warning",
		// Every entry names the raw prose token, the one spelling both outcomes
		// share; the message carries what each one resolved to.
		paths: tokens.map((entry) => ({
			path: entry.token,
			policy: "working-context",
			provenance: "inferred",
			source: entry.source,
			confidence: "low",
		})),
		message: `[dispatch scope] prose inference resolved path tokens carrying a leading '../' run against the dispatch root: ${renderParentTokens(
			tokens,
		)}. An anchored token selects project rules without expanding worker authority; a dropped one took no part in scope.`,
	};
}

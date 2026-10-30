/**
 * Scoped settings layering. Effective settings come from four file layers plus
 * CLI flags, lowest precedence first:
 *
 *   built-in  <  user settings.yaml  <  project .clio-coder/settings.yaml
 *             <  project .clio-coder/settings.local.yaml  <  CLI flags
 *
 * Layering happens on the raw parsed blobs so each effective leaf can be
 * attributed to the layer that set it, then the merged blob is validated against
 * the one strict schema (core/config.ts). Project layers are committed
 * team configuration and must stay secrets-free, so credential-bearing keys are
 * stripped from the project and project.local layers with a diagnostic.
 * Autonomy is operator-owned and is also stripped from project layers, as are
 * yolo's scratch roots and any raise of telemetry capture.
 *
 * Merge semantics, documented and explicit: objects deep-merge key by key;
 * arrays and scalars replace wholesale (a later layer's array wins entirely).
 * Replacing arrays keeps the result predictable and avoids ambiguous element
 * identity. Reads are best-effort: a missing file is skipped, and a malformed
 * file degrades to the lower layers with an issue rather than throwing.
 */

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
	type AutonomyLevel,
	autonomyRank,
	DEFAULT_AUTONOMY_LEVEL,
	isAutonomyLevel,
} from "../domains/safety/autonomy.js";
import {
	applySettingsDelta,
	type ClioSettings,
	reportSettingsWarnings,
	type SettingsIssue,
	type SettingsMutator,
	SettingsValidationError,
	settingsPath,
	updateSavedSettingsDocument,
	validateSettings,
} from "./config.js";
import { DEFAULT_SETTINGS } from "./defaults.js";
import { safeResourceWrite } from "./safe-resource-write.js";
import { withStateFileLockSync } from "./state-file-lock.js";
import {
	captureProjectSurface,
	type ProjectSurfaceFile,
	projectSurfaceTrustNotice,
	recordProjectSurfaceTrust,
} from "./workspace-trust.js";
import { renderYamlPreservingLayout } from "./yaml-preserve.js";

export type SettingsOrigin = "built-in" | "user" | "project" | "project.local" | "cli";

export interface SettingsLayerIssue {
	origin: SettingsOrigin;
	path: string;
	message: string;
	kind?: SettingsIssue["kind"];
}

export interface SettingsLayerInfo {
	origin: SettingsOrigin;
	path: string;
	present: boolean;
}

export interface LayeredSettings {
	settings: ClioSettings;
	/** Setting path with JSON brackets for literal map keys. Missing keys are built-in defaults. */
	sources: Record<string, SettingsOrigin>;
	issues: SettingsLayerIssue[];
	layers: SettingsLayerInfo[];
}

const STRICT_USER_ISSUES = Symbol("strict-user-issues");
type InternalLayeredSettings = LayeredSettings & { [STRICT_USER_ISSUES]: SettingsIssue[] };

// Keys whose presence in a project layer means a credential leaked into a
// committed file. `auth` carries target headers and api keys; the rest cover
// stray secrets. Stripped from project layers with a diagnostic.
const CREDENTIAL_KEYS: ReadonlySet<string> = new Set(["auth", "apikey", "api_key", "token", "secret", "password"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepEquals(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((entry, index) => deepEquals(entry, b[index]));
	}
	if (!isRecord(a) || !isRecord(b)) return false;
	const keys = Object.keys(a);
	if (keys.length !== Object.keys(b).length) return false;
	return keys.every((key) => key in b && deepEquals(a[key], b[key]));
}

function settingPath(segments: readonly string[]): string {
	return segments.reduce(
		(path, key) => (/^[\w-]+$/u.test(key) ? `${path ? `${path}.` : ""}${key}` : `${path}[${JSON.stringify(key)}]`),
		"",
	);
}

function settingPathSegments(path: string): string[] {
	return Array.from(
		path.matchAll(/([^.[\]]+)|\[("(?:[^"\\]|\\.)*"|\d+)\]/gu),
		(match) => match[1] ?? (JSON.parse(match[2] ?? '""') as string | number).toString(),
	);
}

export function settingsValueFor(root: unknown, path: string): unknown {
	let current = root;
	for (const key of settingPathSegments(path)) {
		if (current === null || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

function pruneSources(sources: Record<string, SettingsOrigin>, path: string): void {
	for (const key of Object.keys(sources)) {
		if (key === path || key.startsWith(`${path}.`) || key.startsWith(`${path}[`)) delete sources[key];
	}
}

function recordSources(
	value: unknown,
	path: readonly string[],
	origin: SettingsOrigin,
	sources: Record<string, SettingsOrigin>,
): void {
	sources[settingPath(path)] = origin;
	if (isRecord(value)) {
		for (const [key, child] of Object.entries(value)) recordSources(child, [...path, key], origin, sources);
	}
}

interface RawLayer {
	origin: SettingsOrigin;
	path: string;
	blob: Record<string, unknown> | undefined;
}

function rawLayerGraphIssue(value: unknown): { path: string; message: string } | undefined {
	const ancestors = new Set<object>();
	let remaining = 100_000;
	const visit = (node: unknown, path: string, depth: number): ReturnType<typeof rawLayerGraphIssue> => {
		if (--remaining < 0) return { path, message: "settings graph exceeds 100000 expanded values" };
		if (node === null || typeof node !== "object") return undefined;
		if (ancestors.has(node)) return { path, message: "cyclic YAML alias is not allowed in settings" };
		if (depth > 100) return { path, message: "settings graph exceeds 100 nested collections" };
		ancestors.add(node);
		for (const [key, child] of Object.entries(node)) {
			const childPath = Array.isArray(node) ? `${path}[${key}]` : path ? `${path}.${key}` : key;
			const issue = visit(child, childPath, depth + 1);
			if (issue) return issue;
		}
		ancestors.delete(node);
		return undefined;
	};
	return visit(value, "", 0);
}

function readRawLayer(
	origin: SettingsOrigin,
	path: string,
	issues: SettingsLayerIssue[],
	capturedText?: string,
): RawLayer {
	if (capturedText === undefined && !existsSync(path)) return { origin, path, blob: undefined };
	let text: string;
	try {
		text = capturedText ?? readFileSync(path, "utf8");
	} catch (err) {
		issues.push({
			origin,
			path: "(root)",
			message: `unreadable: ${err instanceof Error ? err.message : String(err)}`,
			kind: "unreadable",
		});
		return { origin, path, blob: undefined };
	}
	let parsed: unknown;
	try {
		parsed = parseYaml(text, { maxAliasCount: 100 });
	} catch (err) {
		issues.push({
			origin,
			path: "(root)",
			message: `${path}: invalid YAML: ${err instanceof Error ? err.message : String(err)}`,
			kind: "syntax",
		});
		return { origin, path, blob: undefined };
	}
	if (parsed === null || parsed === undefined) return { origin, path, blob: {} };
	if (!isRecord(parsed)) {
		issues.push({ origin, path: "(root)", message: "settings file must be a mapping at the root" });
		return { origin, path, blob: undefined };
	}
	const graphIssue = rawLayerGraphIssue(parsed);
	if (graphIssue) {
		issues.push({ origin, path: graphIssue.path || "(root)", message: `${path}: ${graphIssue.message}`, kind: "syntax" });
		return { origin, path, blob: undefined };
	}
	return { origin, path, blob: parsed };
}

/**
 * Remove credential-bearing keys from a project layer, recording where each was
 * dropped. Recurses through nested objects and arrays so a credential nested
 * under `targets[].auth` is caught too.
 */
function stripCredentials(value: unknown, origin: SettingsOrigin, path: string, issues: SettingsLayerIssue[]): unknown {
	if (Array.isArray(value)) {
		return value.map((item, index) => stripCredentials(item, origin, `${path}[${index}]`, issues));
	}
	if (!isRecord(value)) return value;
	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		if (CREDENTIAL_KEYS.has(key.toLowerCase())) {
			issues.push({
				origin,
				path: path ? `${path}.${key}` : key,
				message: "credentials are not allowed in project settings; key ignored",
			});
			continue;
		}
		out[key] = stripCredentials(child, origin, path ? `${path}.${key}` : key, issues);
	}
	return out;
}

/** The operator's own level, which a project layer may tighten but never loosen. */
function userAutonomy(userBlob: Record<string, unknown> | undefined): AutonomyLevel {
	const safety = userBlob?.safety;
	return isRecord(safety) && isAutonomyLevel(safety.autonomy) ? safety.autonomy : DEFAULT_AUTONOMY_LEVEL;
}

function stripProjectAutonomy(
	blob: Record<string, unknown>,
	origin: SettingsOrigin,
	issues: SettingsLayerIssue[],
	operatorLevel: AutonomyLevel,
): Record<string, unknown> {
	if (!isRecord(blob.safety) || !Object.hasOwn(blob.safety, "autonomy")) return blob;
	const requested = blob.safety.autonomy;
	// A repository may ask for more confirmation than the operator's default,
	// never less. The kept value is a starting point: the session toggle and
	// --autonomy still belong to the operator.
	if (isAutonomyLevel(requested) && autonomyRank(requested) <= autonomyRank(operatorLevel)) return blob;
	issues.push({
		origin,
		path: "safety.autonomy",
		message: isAutonomyLevel(requested)
			? "project autonomy may only tighten the level in user settings; project value ignored"
			: "autonomy is set only in user settings or by the operator; project value ignored",
	});
	const safety = { ...blob.safety };
	delete safety.autonomy;
	const cleaned = { ...blob };
	if (Object.keys(safety).length === 0) delete cleaned.safety;
	else cleaned.safety = safety;
	return cleaned;
}

/**
 * A repository may lower telemetry capture but never raise it, so opening a
 * cloned project cannot switch the operator into research mode or turn on a
 * research flag their own file leaves off (#434, O6). Content capture still
 * needs the operator's workspace consent, which no settings layer grants.
 */
function stripProjectTelemetry(
	blob: Record<string, unknown>,
	origin: SettingsOrigin,
	issues: SettingsLayerIssue[],
	userBlob: Record<string, unknown> | undefined,
): Record<string, unknown> {
	if (!isRecord(blob.telemetry)) return blob;
	const operator = isRecord(userBlob?.telemetry) ? userBlob.telemetry : {};
	const operatorResearch = isRecord(operator.research) ? operator.research : {};
	const telemetry: Record<string, unknown> = { ...blob.telemetry };
	let stripped = false;
	const reject = (path: string) => {
		issues.push({
			origin,
			path,
			message: "a project may only lower telemetry capture from user settings; project value ignored",
		});
		stripped = true;
	};
	if (Object.hasOwn(telemetry, "mode")) {
		const operatorMode = operator.mode === "research" ? "research" : DEFAULT_SETTINGS.telemetry.mode;
		if (telemetry.mode !== "standard" && telemetry.mode !== operatorMode) {
			reject("telemetry.mode");
			delete telemetry.mode;
		}
	}
	if (isRecord(telemetry.research)) {
		const research: Record<string, unknown> = { ...telemetry.research };
		for (const [flag, requested] of Object.entries(research)) {
			if (requested === false || !Object.hasOwn(DEFAULT_SETTINGS.telemetry.research, flag)) continue;
			const fallback = DEFAULT_SETTINGS.telemetry.research[flag as keyof ClioSettings["telemetry"]["research"]];
			const operatorFlag = typeof operatorResearch[flag] === "boolean" ? operatorResearch[flag] : fallback;
			if (requested === true && operatorFlag === true) continue;
			reject(`telemetry.research.${flag}`);
			delete research[flag];
		}
		if (Object.keys(research).length === 0) delete telemetry.research;
		else telemetry.research = research;
	}
	if (!stripped) return blob;
	const cleaned = { ...blob };
	if (Object.keys(telemetry).length === 0) delete cleaned.telemetry;
	else cleaned.telemetry = telemetry;
	return cleaned;
}

/**
 * `systemOne.record` keeps redacted decision state and prompts without research
 * consent, so as a deprecated alias of research capture only the operator's own
 * file may turn it on (#434).
 */
function stripProjectSystemOneRecord(
	blob: Record<string, unknown>,
	origin: SettingsOrigin,
	issues: SettingsLayerIssue[],
	userBlob: Record<string, unknown> | undefined,
): Record<string, unknown> {
	if (!isRecord(blob.systemOne) || !Object.hasOwn(blob.systemOne, "record") || blob.systemOne.record === false)
		return blob;
	if (isRecord(userBlob?.systemOne) && userBlob.systemOne.record === true) return blob;
	issues.push({
		origin,
		path: "systemOne.record",
		message: "a project may only lower telemetry capture from user settings; project value ignored",
	});
	const systemOne = { ...blob.systemOne };
	delete systemOne.record;
	const cleaned = { ...blob };
	if (Object.keys(systemOne).length === 0) delete cleaned.systemOne;
	else cleaned.systemOne = systemOne;
	return cleaned;
}

/**
 * Safety keys only the operator's own file may set. Scratch roots widen where
 * yolo may delete outside the workspace (#419), so a repository can neither set
 * nor extend them. The unattended window decides how long Clio waits for this
 * operator before answering a card or a question itself (#421), so a
 * repository cannot shorten it to answer ahead of them. The safety judge
 * reviews calls against the operator's words, so a repository can neither
 * write its rules nor choose its model.
 */
const OPERATOR_ONLY_SAFETY_KEYS: ReadonlyArray<{ key: string; message: string }> = [
	{ key: "scratchRoots", message: "scratch roots are set only in user settings; project value ignored" },
	// A repository could otherwise hand its own commands the operator's tokens.
	{
		key: "sandboxPassEnv",
		message: "sandbox environment pass-through is set only in user settings; project value ignored",
	},
	// A repository could otherwise reopen the sockets that run code outside the sandbox.
	{
		key: "sandboxUnixSockets",
		message: "sandbox unix-socket access is set only in user settings; project value ignored",
	},
	{
		key: "unattendedAfterSeconds",
		message: "the unattended timeout is set only in user settings; project value ignored",
	},
	// Acceptance of yolo is the operator's own, never a repository's (#407).
	{ key: "yoloAccepted", message: "yolo acceptance is recorded only in user settings; project value ignored" },
	// The judge decides which calls run without the operator, so a repository
	// could otherwise add allow rules, retarget it or switch it off.
	{ key: "judge", message: "the safety judge is configured only in user settings; project value ignored" },
];

function stripProjectOperatorSafety(
	blob: Record<string, unknown>,
	origin: SettingsOrigin,
	issues: SettingsLayerIssue[],
): Record<string, unknown> {
	if (!isRecord(blob.safety)) return blob;
	const safety: Record<string, unknown> = { ...blob.safety };
	let stripped = false;
	for (const { key, message } of OPERATOR_ONLY_SAFETY_KEYS) {
		if (!Object.hasOwn(safety, key)) continue;
		issues.push({ origin, path: `safety.${key}`, message });
		delete safety[key];
		stripped = true;
	}
	if (!stripped) return blob;
	const cleaned = { ...blob };
	if (Object.keys(safety).length === 0) delete cleaned.safety;
	else cleaned.safety = safety;
	return cleaned;
}

/**
 * `trustedUnmediated` hands a runtime its own authority over writes, so only
 * the operator's user settings may grant it. A trusted project layer that
 * defines targets or external agents could otherwise trust itself.
 */
function stripProjectRuntimeTrust(
	blob: Record<string, unknown>,
	origin: SettingsOrigin,
	issues: SettingsLayerIssue[],
): Record<string, unknown> {
	const strip = (entries: unknown, path: string): unknown => {
		if (!Array.isArray(entries)) return entries;
		return entries.map((entry, index) => {
			if (!isRecord(entry) || !Object.hasOwn(entry, "trustedUnmediated")) return entry;
			issues.push({
				origin,
				path: `${path}[${index}].trustedUnmediated`,
				message: "trustedUnmediated is set only in user settings; project value ignored",
			});
			const { trustedUnmediated: _ignored, ...rest } = entry;
			return rest;
		});
	};
	let cleaned = blob;
	if (Array.isArray(blob.targets)) cleaned = { ...cleaned, targets: strip(blob.targets, "targets") };
	const integrations = blob.integrations;
	if (
		isRecord(integrations) &&
		isRecord(integrations.externalAgents) &&
		Array.isArray(integrations.externalAgents.entries)
	) {
		cleaned = {
			...cleaned,
			integrations: {
				...integrations,
				externalAgents: {
					...integrations.externalAgents,
					entries: strip(integrations.externalAgents.entries, "integrations.externalAgents.entries"),
				},
			},
		};
	}
	return cleaned;
}

/**
 * Deep-merge raw layer blobs in precedence order, recording the origin that last
 * set each leaf. Objects recurse; arrays and scalars replace.
 */
function mergeLayersWithSources(layers: ReadonlyArray<RawLayer>): {
	merged: Record<string, unknown>;
	sources: Record<string, SettingsOrigin>;
} {
	const merged: Record<string, unknown> = {};
	const sources: Record<string, SettingsOrigin> = {};
	for (const layer of layers) {
		if (layer.blob === undefined) continue;
		mergeInto(merged, layer.blob, layer.origin, [], sources);
	}
	return { merged, sources };
}

function mergeInto(
	target: Record<string, unknown>,
	source: Record<string, unknown>,
	origin: SettingsOrigin,
	prefix: readonly string[],
	sources: Record<string, SettingsOrigin>,
): void {
	for (const [key, value] of Object.entries(source)) {
		const segments = [...prefix, key];
		const path = settingPath(segments);
		if (isRecord(value)) {
			const existing = target[key];
			const nested = isRecord(existing) ? existing : {};
			mergeInto(nested, value, origin, segments, sources);
			target[key] = nested;
			sources[path] = origin;
		} else {
			if (isRecord(target[key])) pruneSources(sources, path);
			target[key] = Array.isArray(value) ? [...value] : value;
			sources[path] = origin;
		}
	}
}

export interface ReadLayeredSettingsOptions {
	/** Override the user settings.yaml path; defaults to the resolved config dir. */
	userPath?: string;
}

interface PreparedLayers {
	projectFile: string;
	localFile: string;
	projectRaw: RawLayer;
	localRaw: RawLayer;
	project: RawLayer;
	local: RawLayer;
}

function prepareProjectLayers(
	cwd: string,
	issues: SettingsLayerIssue[],
	userBlob: Record<string, unknown> | undefined,
): PreparedLayers {
	const operatorLevel = userAutonomy(userBlob);
	const projectFile = join(cwd, ".clio-coder", "settings.yaml");
	const localFile = join(cwd, ".clio-coder", "settings.local.yaml");
	const snapshot = captureProjectSurface(cwd, "settings");
	const readProjectLayer = (origin: SettingsOrigin, path: string, file: ProjectSurfaceFile | undefined): RawLayer => {
		if (file?.error !== undefined) issues.push({ origin, path, message: file.error, kind: "unreadable" });
		if (file?.text === null || file === undefined) return { origin, path, blob: undefined };
		const raw = readRawLayer(origin, path, issues, file.text);
		const blob =
			raw.blob === undefined
				? undefined
				: stripProjectSystemOneRecord(
						stripProjectTelemetry(
							stripProjectOperatorSafety(
								stripProjectRuntimeTrust(stripProjectAutonomy(raw.blob, origin, issues, operatorLevel), origin, issues),
								origin,
								issues,
							),
							origin,
							issues,
							userBlob,
						),
						origin,
						issues,
						userBlob,
					);
		if (snapshot.verdict !== "trusted") {
			issues.push({ origin, path, message: projectSurfaceTrustNotice(snapshot, file.path) });
			return { origin, path, blob: undefined };
		}
		return { ...raw, blob };
	};
	const projectRaw = readProjectLayer("project", projectFile, snapshot.files[0]);
	const localRaw = readProjectLayer("project.local", localFile, snapshot.files[1]);
	const project: RawLayer = {
		...projectRaw,
		blob:
			projectRaw.blob === undefined
				? undefined
				: (stripCredentials(projectRaw.blob, "project", "", issues) as Record<string, unknown>),
	};
	const local: RawLayer = {
		...localRaw,
		blob:
			localRaw.blob === undefined
				? undefined
				: (stripCredentials(localRaw.blob, "project.local", "", issues) as Record<string, unknown>),
	};
	return { projectFile, localFile, projectRaw, localRaw, project, local };
}

function validateLayerStack(
	user: RawLayer,
	prepared: PreparedLayers,
	issues: SettingsLayerIssue[],
): { settings: ClioSettings; sources: Record<string, SettingsOrigin> } {
	const { merged, sources } = mergeLayersWithSources([user, prepared.project, prepared.local]);
	const validation = validateSettings(merged);
	for (const issue of validation.issues) {
		issues.push({ origin: settingsSourceFor(sources, issue.path), path: issue.path, message: issue.message });
	}
	// AUD-2 finding 4: keep rejected input in diagnostics before attributing its fallback.
	for (const path of Object.keys(sources)) {
		const effective = settingsValueFor(validation.settings, path);
		const raw = settingsValueFor(merged, path);
		if (effective === undefined) {
			delete sources[path];
		} else if (
			!deepEquals(raw, effective) &&
			(!isRecord(effective) || !isRecord(raw)) &&
			(!Array.isArray(effective) || !Array.isArray(raw)) &&
			validation.issues.some((issue) => issue.path === settingPathSegments(path).join("."))
		) {
			pruneSources(sources, path);
			recordSources(effective, settingPathSegments(path), "built-in", sources);
		}
	}
	return { settings: validation.settings, sources };
}

/**
 * Read and layer settings for `cwd`, returning the validated effective settings
 * plus per-leaf source attribution. Never throws: validation issues and layer
 * problems are returned, and the effective settings always validate (invalid
 * merges fall back to the schema defaults for the offending keys).
 */
export function readLayeredSettings(cwd: string, options: ReadLayeredSettingsOptions = {}): LayeredSettings {
	const issues: SettingsLayerIssue[] = [];
	const userFile = options.userPath ?? settingsPath();
	const user = readRawLayer("user", userFile, issues);
	const prepared = prepareProjectLayers(cwd, issues, user.blob);
	const { settings, sources } = validateLayerStack(user, prepared, issues);
	reportSettingsWarnings(settings);

	const strictUserIssues =
		user.blob === undefined
			? []
			: validateSettings(user.blob).issues.map((issue) => ({
					path: issue.path,
					message: issue.message,
					...(issue.kind ? { kind: issue.kind } : {}),
				}));
	return {
		settings,
		sources,
		issues,
		layers: [
			{ origin: "built-in", path: "(defaults)", present: true },
			{ origin: "user", path: userFile, present: user.blob !== undefined },
			{ origin: "project", path: prepared.projectFile, present: prepared.projectRaw.blob !== undefined },
			{ origin: "project.local", path: prepared.localFile, present: prepared.localRaw.blob !== undefined },
		],
		[STRICT_USER_ISSUES]: strictUserIssues,
	} as InternalLayeredSettings;
}

/**
 * Read the complete effective stack once while retaining settings.yaml's
 * strict launch gate. Project-layer issues remain diagnostics, matching the
 * established best-effort workspace overlay contract.
 */
export function readStrictLayeredSettings(cwd: string, options: ReadLayeredSettingsOptions = {}): LayeredSettings {
	const layered = readLayeredSettings(cwd, options) as InternalLayeredSettings;
	const reportedUserIssues = layered.issues
		.filter((issue) => issue.origin === "user")
		.map(({ path, message, kind }): SettingsIssue => ({ path, message, ...(kind ? { kind } : {}) }));
	const userIssues = [...reportedUserIssues, ...layered[STRICT_USER_ISSUES]].filter(
		(issue, index, all) =>
			all.findIndex(
				(candidate) =>
					candidate.path === issue.path && candidate.message === issue.message && candidate.kind === issue.kind,
			) === index,
	);
	if (userIssues.length > 0) throw new SettingsValidationError(userIssues);
	return layered;
}

/**
 * Atomically persist a mutation of the effective workspace settings into the
 * user layer. The candidate user document is re-layered with the same project
 * files before it is written. This preserves references to project-only
 * targets while refusing a mutation that a higher-precedence project leaf
 * would silently override.
 */
export function updateLayeredSettings(cwd: string, mutate: SettingsMutator): ClioSettings {
	let committed: ClioSettings | null = null;
	updateSavedSettingsDocument((saved) => {
		const userValidation = validateSettings(saved);
		if (userValidation.issues.length > 0) throw new SettingsValidationError(userValidation.issues);
		const issues: SettingsLayerIssue[] = [];
		const prepared = prepareProjectLayers(cwd, issues, isRecord(saved) ? saved : undefined);
		const user: RawLayer = {
			origin: "user",
			path: settingsPath(),
			blob: isRecord(saved) ? saved : {},
		};
		const before = validateLayerStack(user, prepared, issues).settings;
		const candidate = structuredClone(before);
		const next = mutate(candidate) ?? candidate;
		const candidateValidation = validateSettings(JSON.parse(JSON.stringify(next)));
		if (candidateValidation.issues.length > 0) throw new SettingsValidationError(candidateValidation.issues);

		const nextSaved = applySettingsDelta(saved, before, candidateValidation.settings);
		const finalIssues: SettingsLayerIssue[] = [];
		const final = validateLayerStack(
			{ origin: "user", path: settingsPath(), blob: isRecord(nextSaved) ? nextSaved : {} },
			prepared,
			finalIssues,
		).settings;
		if (!deepEquals(final, candidateValidation.settings)) {
			throw new Error("a higher-precedence project setting prevents this settings update");
		}
		committed = final;
		return nextSaved;
	});
	if (committed === null) throw new Error("layered settings update did not commit");
	return committed;
}

/**
 * Persist one explicit project-scoped settings mutation in the private local
 * layer. The existing settings surface must already be trusted, unless both
 * project files are absent. The exact bytes written are then approved so the
 * setting remains active on the next read and boot; a later manual edit still
 * invalidates that approval.
 */
export function updateProjectLocalSettings(cwd: string, mutate: SettingsMutator): ClioSettings {
	const localFile = join(cwd, ".clio-coder", "settings.local.yaml");
	const configDir = join(cwd, ".clio-coder");
	try {
		if (lstatSync(configDir).isSymbolicLink()) throw new Error(`project settings path is a symlink: ${configDir}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return withStateFileLockSync(localFile, () => {
		for (const path of [configDir, join(configDir, "settings.yaml"), localFile]) {
			try {
				if (lstatSync(path).isSymbolicLink()) throw new Error(`project settings path is a symlink: ${path}`);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		const beforeSurface = captureProjectSurface(cwd, "settings");
		const bothAbsent = beforeSurface.files.every((file) => file.text === null && file.error === undefined);
		if (beforeSurface.verdict !== "trusted" && !bothAbsent) {
			throw new Error(
				`project settings are ${beforeSurface.verdict}; review with clio-coder config trust settings before saving`,
			);
		}
		const current = readStrictLayeredSettings(cwd).settings;
		const candidate = structuredClone(current);
		const next = mutate(candidate) ?? candidate;
		const validation = validateSettings(JSON.parse(JSON.stringify(next)));
		if (validation.issues.length > 0) throw new SettingsValidationError(validation.issues);
		const localIssues: SettingsLayerIssue[] = [];
		const local = readRawLayer("project.local", localFile, localIssues, beforeSurface.files[1]?.text ?? undefined);
		if (localIssues.length > 0 || (local.blob === undefined && beforeSurface.files[1]?.text !== null)) {
			throw new Error("project local settings cannot be parsed for saving");
		}
		const saved = applySettingsDelta(local.blob ?? {}, current, validation.settings);
		const credentialIssues: SettingsLayerIssue[] = [];
		stripCredentials(saved, "project.local", "", credentialIssues);
		if (credentialIssues.length > 0) {
			throw new Error(`credentials are not allowed in project settings: ${credentialIssues[0]?.path}`);
		}
		const userIssues: SettingsLayerIssue[] = [];
		const user = readRawLayer("user", settingsPath(), userIssues);
		const stackIssues: SettingsLayerIssue[] = [];
		const prepared = prepareProjectLayers(cwd, stackIssues, user.blob);
		if (stackIssues.length > 0) throw new Error(`project settings cannot be saved: ${stackIssues[0]?.message}`);
		stackIssues.push(...userIssues);
		const final = validateLayerStack(
			user,
			{
				...prepared,
				local: { origin: "project.local", path: localFile, blob: saved as Record<string, unknown> },
			},
			stackIssues,
		).settings;
		if (stackIssues.length > 0 || !deepEquals(final, validation.settings)) {
			throw new Error("project settings save would not produce the requested effective settings");
		}
		const bytes = renderYamlPreservingLayout(beforeSurface.files[1]?.text ?? null, saved);
		const teamBefore = beforeSurface.files[0]?.hash;
		safeResourceWrite(localFile, bytes, { mode: 0o600 });
		const afterSurface = captureProjectSurface(cwd, "settings");
		if (
			afterSurface.files[0]?.hash !== teamBefore ||
			afterSurface.files[1]?.text !== bytes ||
			!afterSurface.contentHash
		) {
			throw new Error("project settings changed while saving; review with clio-coder config trust settings");
		}
		recordProjectSurfaceTrust(cwd, "settings", afterSurface.contentHash);
		const committed = readStrictLayeredSettings(cwd).settings;
		if (!deepEquals(committed, validation.settings)) {
			throw new Error("project settings save was overridden by another settings layer");
		}
		return committed;
	});
}

/**
 * Effective origin of one dotted key path: the layer that set it, or built-in
 * when no layer did. A parent path's origin applies when the exact leaf was not
 * individually tracked.
 */
export function settingsSourceFor(sources: Record<string, SettingsOrigin>, keyPath: string): SettingsOrigin {
	const path = sources[keyPath]
		? keyPath
		: (Object.keys(sources).find((path) => settingPathSegments(path).join(".") === keyPath) ?? keyPath);
	const segments = settingPathSegments(path);
	while (segments.length > 0) {
		const direct = sources[settingPath(segments)];
		if (direct) return direct;
		segments.pop();
	}
	return "built-in";
}

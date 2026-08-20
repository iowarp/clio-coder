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
 *
 * Merge semantics, documented and explicit: objects deep-merge key by key;
 * arrays and scalars replace wholesale (a later layer's array wins entirely).
 * Replacing arrays keeps the result predictable and avoids ambiguous element
 * identity. Reads are best-effort: a missing file is skipped, and a malformed
 * file degrades to the lower layers with an issue rather than throwing.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
	applySettingsDelta,
	type ClioSettings,
	type SettingsMutator,
	SettingsValidationError,
	settingsPath,
	updateSavedSettingsDocument,
	validateSettings,
} from "./config.js";

export type SettingsOrigin = "built-in" | "user" | "project" | "project.local" | "cli";

export interface SettingsLayerIssue {
	origin: SettingsOrigin;
	path: string;
	message: string;
}

export interface SettingsLayerInfo {
	origin: SettingsOrigin;
	path: string;
	present: boolean;
}

export interface LayeredSettings {
	settings: ClioSettings;
	/** Dotted leaf path to the origin that set it. Keys not present here are built-in defaults. */
	sources: Record<string, SettingsOrigin>;
	issues: SettingsLayerIssue[];
	layers: SettingsLayerInfo[];
}

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

interface RawLayer {
	origin: SettingsOrigin;
	path: string;
	blob: Record<string, unknown> | undefined;
}

function readRawLayer(origin: SettingsOrigin, path: string, issues: SettingsLayerIssue[]): RawLayer {
	if (!existsSync(path)) return { origin, path, blob: undefined };
	let parsed: unknown;
	try {
		parsed = parseYaml(readFileSync(path, "utf8"));
	} catch (err) {
		issues.push({ origin, path, message: `invalid YAML: ${err instanceof Error ? err.message : String(err)}` });
		return { origin, path, blob: undefined };
	}
	if (parsed === null || parsed === undefined) return { origin, path, blob: {} };
	if (!isRecord(parsed)) {
		issues.push({ origin, path, message: "settings file must be a mapping at the root" });
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
		mergeInto(merged, layer.blob, layer.origin, "", sources);
	}
	return { merged, sources };
}

function mergeInto(
	target: Record<string, unknown>,
	source: Record<string, unknown>,
	origin: SettingsOrigin,
	prefix: string,
	sources: Record<string, SettingsOrigin>,
): void {
	for (const [key, value] of Object.entries(source)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (isRecord(value)) {
			const existing = target[key];
			const nested = isRecord(existing) ? existing : {};
			mergeInto(nested, value, origin, path, sources);
			target[key] = nested;
			sources[path] = origin;
		} else {
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

function prepareProjectLayers(cwd: string, issues: SettingsLayerIssue[]): PreparedLayers {
	const projectFile = join(cwd, ".clio-coder", "settings.yaml");
	const localFile = join(cwd, ".clio-coder", "settings.local.yaml");
	const projectRaw = readRawLayer("project", projectFile, issues);
	const localRaw = readRawLayer("project.local", localFile, issues);
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
	const prepared = prepareProjectLayers(cwd, issues);
	const { settings, sources } = validateLayerStack(user, prepared, issues);

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
	};
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
		const prepared = prepareProjectLayers(cwd, issues);
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
 * Effective origin of one dotted key path: the layer that set it, or built-in
 * when no layer did. A parent path's origin applies when the exact leaf was not
 * individually tracked.
 */
export function settingsSourceFor(sources: Record<string, SettingsOrigin>, keyPath: string): SettingsOrigin {
	let prefix = keyPath;
	while (prefix.length > 0) {
		const direct = sources[prefix];
		if (direct) return direct;
		const bracket = prefix.lastIndexOf("[");
		if (bracket >= 0) {
			const arrayKey = prefix.slice(0, bracket);
			const hit = sources[arrayKey];
			if (hit) return hit;
		}
		const dot = prefix.lastIndexOf(".");
		if (dot < 0) break;
		prefix = prefix.slice(0, dot);
	}
	return "built-in";
}

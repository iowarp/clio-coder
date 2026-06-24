/**
 * Scoped settings layering. Effective settings come from four file layers plus
 * CLI flags, lowest precedence first:
 *
 *   built-in  <  user settings.yaml  <  project .clio/settings.yaml
 *             <  project .clio/settings.local.yaml  <  CLI flags
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
import { type ClioSettings, settingsPath, validateSettings } from "./config.js";

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
export function mergeLayersWithSources(layers: ReadonlyArray<RawLayer>): {
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

/**
 * Read and layer settings for `cwd`, returning the validated effective settings
 * plus per-leaf source attribution. Never throws: validation issues and layer
 * problems are returned, and the effective settings always validate (invalid
 * merges fall back to the schema defaults for the offending keys).
 */
export function readLayeredSettings(cwd: string, options: ReadLayeredSettingsOptions = {}): LayeredSettings {
	const issues: SettingsLayerIssue[] = [];
	const userFile = options.userPath ?? settingsPath();
	const projectFile = join(cwd, ".clio", "settings.yaml");
	const localFile = join(cwd, ".clio", "settings.local.yaml");

	const user = readRawLayer("user", userFile, issues);
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

	const { merged, sources } = mergeLayersWithSources([user, project, local]);
	const validation = validateSettings(merged);
	for (const issue of validation.issues) {
		issues.push({ origin: "user", path: issue.path, message: issue.message });
	}

	return {
		settings: validation.settings,
		sources,
		issues,
		layers: [
			{ origin: "built-in", path: "(defaults)", present: true },
			{ origin: "user", path: userFile, present: user.blob !== undefined },
			{ origin: "project", path: projectFile, present: projectRaw.blob !== undefined },
			{ origin: "project.local", path: localFile, present: localRaw.blob !== undefined },
		],
	};
}

/**
 * Effective origin of one dotted key path: the layer that set it, or built-in
 * when no layer did. A parent path's origin applies when the exact leaf was not
 * individually tracked.
 */
export function settingsSourceFor(sources: Record<string, SettingsOrigin>, keyPath: string): SettingsOrigin {
	const direct = sources[keyPath];
	if (direct) return direct;
	let prefix = keyPath;
	while (prefix.includes(".")) {
		prefix = prefix.slice(0, prefix.lastIndexOf("."));
		const hit = sources[prefix];
		if (hit) return hit;
	}
	return "built-in";
}

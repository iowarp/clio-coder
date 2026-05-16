import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type {
	ClioExtensionManifest,
	ExtensionCandidate,
	ExtensionDiagnostic,
	ExtensionManifestResources,
} from "./types.js";

const MANIFEST_NAMES = ["clio-extension.yaml", "clio-extension.yml", "clio-extension.json"] as const;

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function trimString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function validateId(id: string): string | null {
	if (id.length > 80) return "id exceeds 80 characters";
	if (!/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/.test(id)) {
		return "id must use lowercase letters, numbers, dots, underscores, or hyphens and start/end alphanumeric";
	}
	return null;
}

function readJsonOrYaml(filePath: string): unknown {
	const raw = readFileSync(filePath, "utf8");
	if (filePath.endsWith(".json")) return JSON.parse(raw);
	return parseYaml(raw);
}

function normalizeResources(value: unknown): ExtensionManifestResources {
	if (!isRecord(value)) return {};
	const out: ExtensionManifestResources = {};
	const skills = trimString(value.skills);
	const prompts = trimString(value.prompts);
	const themes = trimString(value.themes);
	if (skills) out.skills = skills;
	if (prompts) out.prompts = prompts;
	if (themes) out.themes = themes;
	return out;
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out = value.map((entry) => trimString(entry)).filter((entry): entry is string => entry !== undefined);
	return out.length > 0 ? out : undefined;
}

export function parseExtensionManifest(
	value: unknown,
	manifestPath: string,
): {
	manifest?: ClioExtensionManifest;
	diagnostics: ExtensionDiagnostic[];
} {
	const diagnostics: ExtensionDiagnostic[] = [];
	if (!isRecord(value)) {
		return { diagnostics: [{ type: "error", message: "extension manifest must be an object", path: manifestPath }] };
	}
	if (value.manifestVersion !== 1) {
		diagnostics.push({ type: "error", message: "manifestVersion must be 1", path: manifestPath });
	}
	const id = trimString(value.id);
	const name = trimString(value.name) ?? id;
	const version = trimString(value.version);
	const description = trimString(value.description);
	if (!id) diagnostics.push({ type: "error", message: "id is required", path: manifestPath });
	else {
		const idError = validateId(id);
		if (idError) diagnostics.push({ type: "error", message: idError, path: manifestPath });
	}
	if (!version) diagnostics.push({ type: "error", message: "version is required", path: manifestPath });
	if (!description) diagnostics.push({ type: "error", message: "description is required", path: manifestPath });
	const resources = normalizeResources(value.resources);
	const tools = stringArray(value.tools);
	const settings = stringArray(value.settings);
	const compatibility = isRecord(value.compatibility)
		? { ...(trimString(value.compatibility.clio) ? { clio: trimString(value.compatibility.clio) as string } : {}) }
		: undefined;
	if (!id || !name || !version || !description || diagnostics.some((diag) => diag.type === "error")) {
		return { diagnostics };
	}
	const manifest: ClioExtensionManifest = {
		manifestVersion: 1,
		id,
		name,
		version,
		description,
		resources,
	};
	if (tools) manifest.tools = tools;
	if (settings) manifest.settings = settings;
	if (compatibility && Object.keys(compatibility).length > 0) manifest.compatibility = compatibility;
	return { manifest, diagnostics };
}

export function findExtensionManifestPath(root: string): string | null {
	for (const name of MANIFEST_NAMES) {
		const candidate = path.join(root, name);
		try {
			if (statSync(candidate).isFile()) return candidate;
		} catch {
			// absent
		}
	}
	return null;
}

export function loadManifestFromRoot(root: string): ExtensionCandidate {
	const manifestPath = findExtensionManifestPath(root);
	if (!manifestPath) {
		return {
			path: root,
			valid: false,
			diagnostics: [{ type: "error", message: "extension manifest not found", path: root }],
		};
	}
	try {
		const parsed = parseExtensionManifest(readJsonOrYaml(manifestPath), manifestPath);
		return {
			path: root,
			manifestPath,
			...(parsed.manifest ? { manifest: parsed.manifest } : {}),
			valid: parsed.manifest !== undefined && !parsed.diagnostics.some((diag) => diag.type === "error"),
			diagnostics: parsed.diagnostics,
		};
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return {
			path: root,
			manifestPath,
			valid: false,
			diagnostics: [{ type: "error", message: `extension manifest could not be read: ${reason}`, path: manifestPath }],
		};
	}
}

export function discoverExtensionPackages(root: string): ExtensionCandidate[] {
	const full = path.resolve(root);
	if (!existsSync(full)) {
		return [{ path: full, valid: false, diagnostics: [{ type: "error", message: "path does not exist", path: full }] }];
	}
	const stat = statSync(full);
	if (!stat.isDirectory()) {
		return [
			{
				path: full,
				valid: false,
				diagnostics: [{ type: "error", message: "extension path is not a directory", path: full }],
			},
		];
	}
	const direct = loadManifestFromRoot(full);
	if (direct.valid || direct.manifestPath) return [direct];
	const candidates: ExtensionCandidate[] = [];
	for (const entry of readdirSync(full, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		const child = path.join(full, entry.name);
		const loaded = loadManifestFromRoot(child);
		if (loaded.valid || loaded.manifestPath) candidates.push(loaded);
	}
	const discovered = candidates.length > 0 ? candidates : [direct];
	const ids = new Map<string, ExtensionCandidate[]>();
	for (const candidate of discovered) {
		const id = candidate.manifest?.id;
		if (!id) continue;
		const group = ids.get(id) ?? [];
		group.push(candidate);
		ids.set(id, group);
	}
	for (const [id, group] of ids) {
		if (group.length < 2) continue;
		for (const candidate of group) {
			candidate.valid = false;
			candidate.diagnostics.push({
				type: "error",
				message: `duplicate extension id ${id}`,
				path: candidate.manifestPath ?? candidate.path,
			});
		}
	}
	return discovered;
}

export function extensionManifestYaml(manifest: ClioExtensionManifest): string {
	return stringifyYaml(manifest);
}

import { type Dirent, existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { parseExtensionCapabilities, resolveExtensionEntrypoint } from "./command-schema.js";
import { evaluateClioCompatibility } from "./compatibility.js";
import { parseExtensionRuntime } from "./runtime-schema.js";
import type { ClioExtensionManifest, ExtensionCandidate, ExtensionDiagnostic } from "./types.js";

const MANIFEST_NAMES = ["clio-coder-extension.yaml", "clio-coder-extension.yml", "clio-coder-extension.json"] as const;
const MANIFEST_KEYS = new Set(["id", "name", "version", "description", "compatibility", "capabilities", "runtime"]);
const COMPATIBILITY_KEYS = new Set(["clio"]);
/**
 * Keys a domain package used to declare here. They are named so the refusal
 * points at the plugin installer instead of reading as a typo.
 */
const PLUGIN_OWNED_KEYS = new Set(["resources", "skills", "prompts", "agents", "fleets", "themes"]);
const PLUGIN_GUIDANCE = "domain resources belong in a plugin: clio-coder library install <path>";

function compareNames(a: { name: string }, b: { name: string }): number {
	return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

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

function rejectUnknownKeys(
	value: Record<string, unknown>,
	allowed: ReadonlySet<string>,
	label: string,
	manifestPath: string,
	diagnostics: ExtensionDiagnostic[],
): void {
	for (const key of Object.keys(value).sort()) {
		if (!allowed.has(key)) {
			diagnostics.push({ type: "error", message: `unknown ${label} key '${key}'`, path: manifestPath });
		}
	}
}

function rejectManifestKeys(
	value: Record<string, unknown>,
	manifestPath: string,
	diagnostics: ExtensionDiagnostic[],
): void {
	for (const key of Object.keys(value).sort()) {
		if (MANIFEST_KEYS.has(key)) continue;
		diagnostics.push({
			type: "error",
			message: PLUGIN_OWNED_KEYS.has(key)
				? `harness extensions cannot declare '${key}'; ${PLUGIN_GUIDANCE}`
				: `unknown manifest key '${key}'`,
			path: manifestPath,
		});
	}
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
	rejectManifestKeys(value, manifestPath, diagnostics);
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
	let capabilities: ClioExtensionManifest["capabilities"];
	let runtime: ClioExtensionManifest["runtime"];
	if (value.runtime !== undefined) {
		try {
			runtime = parseExtensionRuntime(value.runtime);
		} catch (error) {
			diagnostics.push({
				type: "error",
				message: error instanceof Error ? error.message : String(error),
				path: manifestPath,
			});
		}
	}
	if (value.capabilities !== undefined) {
		try {
			capabilities = parseExtensionCapabilities(value.capabilities, id ?? "");
		} catch (error) {
			diagnostics.push({
				type: "error",
				message: error instanceof Error ? error.message : String(error),
				path: manifestPath,
			});
		}
	}
	let compatibility: ClioExtensionManifest["compatibility"];
	if (value.compatibility !== undefined) {
		if (!isRecord(value.compatibility)) {
			diagnostics.push({ type: "error", message: "compatibility must be an object", path: manifestPath });
		} else {
			rejectUnknownKeys(value.compatibility, COMPATIBILITY_KEYS, "compatibility", manifestPath, diagnostics);
			if (!("clio" in value.compatibility)) {
				compatibility = {};
			} else {
				const range = trimString(value.compatibility.clio);
				if (range === undefined) {
					diagnostics.push({
						type: "error",
						message: "compatibility.clio must be a non-empty semver range",
						path: manifestPath,
					});
				} else {
					const evaluation = evaluateClioCompatibility(range);
					if (!evaluation.rangeValid) {
						diagnostics.push({
							type: "error",
							message: `extension ${id ?? "<unknown>"} declares malformed compatibility.clio range '${range}'`,
							path: manifestPath,
						});
					} else {
						compatibility = { clio: range };
					}
				}
			}
		}
	}
	if (!id || !name || !version || !description || diagnostics.some((diag) => diag.type === "error")) {
		return { diagnostics };
	}
	const manifest: ClioExtensionManifest = { id, name, version, description };
	if (runtime) manifest.runtime = runtime;
	if (capabilities) manifest.capabilities = capabilities;
	if (compatibility && Object.keys(compatibility).length > 0) manifest.compatibility = compatibility;
	const clioRange = manifest.compatibility?.clio;
	if (clioRange !== undefined) {
		const evaluation = evaluateClioCompatibility(clioRange);
		if (!evaluation.satisfied) {
			diagnostics.push({
				type: "error",
				message: `extension ${manifest.id} requires Clio '${clioRange}', but running Clio version is '${evaluation.runningVersion}'`,
				path: manifestPath,
			});
		}
	}
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
		if (parsed.manifest?.runtime) {
			try {
				resolveExtensionEntrypoint(root, parsed.manifest.runtime.entrypoint);
			} catch (error) {
				parsed.diagnostics.push({
					type: "error",
					message: `runtime: ${error instanceof Error ? error.message : String(error)}`,
					path: manifestPath,
				});
			}
		}
		for (const tool of parsed.manifest?.capabilities?.tools ?? []) {
			try {
				resolveExtensionEntrypoint(root, tool.entrypoint);
			} catch (error) {
				parsed.diagnostics.push({
					type: "error",
					message: `command tool ${tool.name}: ${error instanceof Error ? error.message : String(error)}`,
					path: manifestPath,
				});
			}
		}
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
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(full);
	} catch (error) {
		return [
			{
				path: full,
				valid: false,
				diagnostics: [
					{
						type: "error",
						message: `extension path could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
						path: full,
					},
				],
			},
		];
	}
	if (!stat.isDirectory()) {
		return [
			{
				path: full,
				valid: false,
				diagnostics: [{ type: "error", message: "extension path is not a directory", path: full }],
			},
		];
	}
	let canonicalFull: string;
	try {
		canonicalFull = realpathSync(full);
	} catch (error) {
		return [
			{
				path: full,
				valid: false,
				diagnostics: [
					{
						type: "error",
						message: `extension path could not be canonicalized: ${error instanceof Error ? error.message : String(error)}`,
						path: full,
					},
				],
			},
		];
	}
	const direct = loadManifestFromRoot(canonicalFull);
	if (direct.valid || direct.manifestPath) return [direct];
	const candidates: ExtensionCandidate[] = [];
	const discoveryFailures: ExtensionCandidate[] = [];
	const spellingsByCanonicalRoot = new Map<string, string[]>();
	let entries: Dirent<string>[];
	try {
		entries = readdirSync(canonicalFull, { withFileTypes: true, encoding: "utf8" });
	} catch (error) {
		return [
			{
				path: canonicalFull,
				valid: false,
				diagnostics: [
					{
						type: "error",
						message: `extension directory could not be read: ${error instanceof Error ? error.message : String(error)}`,
						path: canonicalFull,
					},
				],
			},
		];
	}
	for (const entry of entries.sort(compareNames)) {
		if (entry.name.startsWith(".")) continue;
		const child = path.join(canonicalFull, entry.name);
		try {
			if (!entry.isDirectory() && !(entry.isSymbolicLink() && statSync(child).isDirectory())) continue;
			const canonicalChild = realpathSync(child);
			const spellings = spellingsByCanonicalRoot.get(canonicalChild) ?? [];
			spellings.push(child);
			spellingsByCanonicalRoot.set(canonicalChild, spellings);
		} catch (error) {
			discoveryFailures.push({
				path: child,
				valid: false,
				diagnostics: [
					{
						type: "error",
						message: `extension child could not be canonicalized: ${error instanceof Error ? error.message : String(error)}`,
						path: child,
					},
				],
			});
		}
	}
	for (const canonicalChild of [...spellingsByCanonicalRoot.keys()].sort()) {
		const loaded = loadManifestFromRoot(canonicalChild);
		const spellings = spellingsByCanonicalRoot.get(canonicalChild) ?? [];
		if (spellings.length > 1) {
			loaded.diagnostics.push({
				type: "warning",
				message: `duplicate canonical extension root loaded once; discovered as ${spellings.sort().join(", ")}`,
				path: canonicalChild,
			});
		}
		if (loaded.valid || loaded.manifestPath) candidates.push(loaded);
	}
	const discovered = [...candidates, ...discoveryFailures].sort((a, b) =>
		a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
	);
	if (discovered.length === 0) discovered.push(direct);
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

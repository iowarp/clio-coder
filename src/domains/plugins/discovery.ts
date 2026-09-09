import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { evaluateClioCompatibility } from "../extensions/compatibility.js";
import { isLibraryKind, type LibraryRequirementRef } from "../resources/library-types.js";
import { pluginContentDigestWithCapture } from "./integrity.js";
import type {
	ClioPluginConfiguration,
	PluginCandidate,
	PluginComponent,
	PluginComponentKind,
	PluginDiagnostic,
	PluginManifest,
	PluginResourceKind,
	PluginResources,
} from "./types.js";

export const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
export const PLUGIN_EXTENSION_KEY = "ai.iowarp.clio";
export const PLUGIN_RESOURCE_KINDS: readonly PluginResourceKind[] = ["skills", "prompts", "agents", "fleets", "themes"];
const COMPONENT_KINDS = new Set(["prompt", "agent", "skill", "fleet", "script", "resource", "tool"]);
const ROOT_KEYS = new Set([
	"$schema",
	"name",
	"version",
	"description",
	"author",
	"homepage",
	"repository",
	"license",
	"keywords",
	"extensions",
]);

export function isPluginId(value: string): boolean {
	return (
		value.length <= 64 && /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(value) && value !== "state.json"
	);
}

export function pluginPathContained(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Resolve a declared file or directory against the canonical installed root. */
export function pluginResourcePath(root: string, value: string, allowRoot = false): string {
	if (!value || value.includes("\\") || path.isAbsolute(value))
		throw new Error(`plugin path must be relative: ${value}`);
	const lexicalRoot = path.resolve(root);
	const lexical = path.resolve(lexicalRoot, value);
	if ((!allowRoot && lexical === lexicalRoot) || !pluginPathContained(lexicalRoot, lexical))
		throw new Error(`plugin path escapes root: ${value}`);
	const canonicalRoot = realpathSync(lexicalRoot);
	const canonical = realpathSync(lexical);
	if (!pluginPathContained(canonicalRoot, canonical) || (!allowRoot && canonical === canonicalRoot))
		throw new Error(`plugin path escapes through a symbolic link: ${value}`);
	return canonical;
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
	for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`unknown ${label} key '${key}'`);
}

function components(value: unknown, root: string): PluginComponent[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 1024)
		throw new Error("components must be an array of at most 1024 entries");
	const refs = new Map<string, PluginComponent>();
	for (const raw of value) {
		if (!record(raw)) throw new Error("component must be an object");
		requireKeys(raw, new Set(["kind", "id", "path", "requires"]), "component");
		if (typeof raw.kind !== "string" || !COMPONENT_KINDS.has(raw.kind)) throw new Error("unsupported component kind");
		if (typeof raw.id !== "string" || raw.id.length > 80 || !/^[a-z0-9][a-z0-9._-]*$/u.test(raw.id))
			throw new Error("component id must be a stable lowercase identifier");
		if (typeof raw.path !== "string") throw new Error(`component ${raw.id} must have a relative path`);
		const file = pluginResourcePath(root, raw.path);
		if (!statSync(file).isFile()) throw new Error(`component ${raw.id} path must be a file`);
		if (raw.kind === "skill" && path.basename(file) !== "SKILL.md")
			throw new Error(`skill component ${raw.id} must point to SKILL.md`);
		if (
			raw.requires !== undefined &&
			(!Array.isArray(raw.requires) || raw.requires.some((ref) => typeof ref !== "string"))
		)
			throw new Error(`component ${raw.id} requires must be an array of component references`);
		const item: PluginComponent = {
			kind: raw.kind as PluginComponentKind,
			id: raw.id,
			path: raw.path,
			...(raw.requires !== undefined ? { requires: raw.requires as string[] } : {}),
		};
		const ref = `${item.kind}:${item.id}`;
		if (refs.has(ref)) throw new Error(`duplicate component reference: ${ref}`);
		refs.set(ref, item);
	}
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (ref: string): void => {
		if (visiting.has(ref)) throw new Error(`component dependency cycle at ${ref}`);
		if (visited.has(ref)) return;
		const item = refs.get(ref);
		if (!item) throw new Error(`missing component reference: ${ref}`);
		visiting.add(ref);
		for (const dependency of item.requires ?? []) visit(dependency);
		visiting.delete(ref);
		visited.add(ref);
	};
	for (const ref of refs.keys()) visit(ref);
	return [...refs.values()];
}

function clioConfiguration(value: unknown, root: string): ClioPluginConfiguration {
	if (value !== undefined && !record(value)) throw new Error(`${PLUGIN_EXTENSION_KEY} must be an object`);
	const raw = value ?? {};
	requireKeys(
		raw,
		new Set(["manifestVersion", "kind", "requires", "evals", "compatibility", "resources", "components"]),
		PLUGIN_EXTENSION_KEY,
	);
	if (value !== undefined && raw.manifestVersion !== 1) throw new Error("Clio plugin manifestVersion must be 1");
	const kind = raw.kind ?? "plugin";
	if (!isLibraryKind(kind)) throw new Error("package kind must be plugin, skill, agent, prompt, or fleet");
	if (
		raw.requires !== undefined &&
		(!Array.isArray(raw.requires) ||
			raw.requires.some(
				(ref) => typeof ref !== "string" || !/^(plugin|skill|agent|prompt|fleet):[a-z0-9][a-z0-9.-]*$/.test(ref),
			))
	)
		throw new Error("package requires must contain kind:name references");
	const evals: Record<string, string> = {};
	if (raw.evals !== undefined) {
		if (!record(raw.evals)) throw new Error("package evals must map names to Suite v2 files");
		for (const [id, file] of Object.entries(raw.evals)) {
			if (!isPluginId(id) || typeof file !== "string" || !statSync(pluginResourcePath(root, file)).isFile())
				throw new Error(`invalid package eval: ${id}`);
			evals[id] = file;
		}
	}
	let compatibility: ClioPluginConfiguration["compatibility"];
	if (raw.compatibility !== undefined) {
		if (!record(raw.compatibility)) throw new Error("compatibility must be an object");
		requireKeys(raw.compatibility, new Set(["clio"]), "compatibility");
		if (
			raw.compatibility.clio !== undefined &&
			(typeof raw.compatibility.clio !== "string" || !evaluateClioCompatibility(raw.compatibility.clio).rangeValid)
		)
			throw new Error("compatibility.clio must be a valid SemVer range");
		compatibility = raw.compatibility as { clio?: string };
	}
	const resources: PluginResources = {};
	if (existsSync(path.join(root, "skills"))) resources.skills = "skills";
	if (raw.resources !== undefined) {
		if (!record(raw.resources)) throw new Error("resources must be an object");
		requireKeys(raw.resources, new Set(PLUGIN_RESOURCE_KINDS), "resources");
		for (const kind of PLUGIN_RESOURCE_KINDS) {
			const resource = raw.resources[kind];
			if (resource === undefined) continue;
			if (typeof resource !== "string") throw new Error(`resources.${kind} must be a relative directory`);
			resources[kind] = resource;
		}
	}
	for (const [resourceKind, relative] of Object.entries(resources)) {
		const full = pluginResourcePath(root, relative, kind === "skill" && relative === ".");
		if (!statSync(full).isDirectory()) throw new Error(`resources.${resourceKind} must be a directory`);
		if (
			resourceKind === "skills" &&
			relative !== "." &&
			path.resolve(root, relative) !== path.join(path.resolve(root), "skills")
		)
			throw new Error("portable skills must use the root skills directory");
	}
	const inventory = components(raw.components, root);
	const componentRoots: Partial<Record<PluginComponentKind, PluginResourceKind>> = {
		prompt: "prompts",
		agent: "agents",
		skill: "skills",
		fleet: "fleets",
	};
	for (const item of inventory) {
		const resourceKind = componentRoots[item.kind];
		if (!resourceKind) continue;
		const resource = resources[resourceKind];
		if (
			!resource ||
			!pluginPathContained(
				pluginResourcePath(root, resource, kind === "skill" && resource === "."),
				pluginResourcePath(root, item.path),
			)
		)
			throw new Error(`component ${item.kind}:${item.id} is outside its declared resource root`);
	}
	if (kind !== "plugin") {
		const publicItems = inventory.filter((item) => ["prompt", "agent", "skill", "fleet"].includes(item.kind));
		if (publicItems.length !== 1 || publicItems[0]?.kind !== kind)
			throw new Error(`a ${kind} package must declare exactly one public ${kind} component`);
		if (Object.keys(resources).some((resource) => resource !== `${kind}s`))
			throw new Error(`a ${kind} package may only declare its ${kind}s resource root`);
	}
	return {
		manifestVersion: 1,
		kind,
		resources,
		components: inventory,
		...(raw.requires ? { requires: raw.requires as LibraryRequirementRef[] } : {}),
		...(raw.evals ? { evals } : {}),
		...(compatibility ? { compatibility } : {}),
	};
}

export function parsePluginManifest(raw: string, root: string): PluginManifest {
	const value: unknown = JSON.parse(raw);
	if (!record(value)) throw new Error("plugin manifest must be an object");
	requireKeys(value, ROOT_KEYS, "plugin manifest");
	if (value.$schema !== PLUGIN_SCHEMA) throw new Error(`plugin $schema must be ${PLUGIN_SCHEMA}`);
	if (typeof value.name !== "string" || !isPluginId(value.name))
		throw new Error("plugin name must be a portable identifier of 1 to 64 characters and may not be state.json");
	for (const field of ["version", "description", "homepage", "repository", "license"]) {
		if (value[field] !== undefined && typeof value[field] !== "string") throw new Error(`${field} must be a string`);
	}
	if (
		typeof value.version !== "string" ||
		!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
			value.version,
		)
	)
		throw new Error("package version must be an explicit Semantic Version (for example 1.0.0)");
	if (value.author !== undefined) {
		if (!record(value.author)) throw new Error("author must be an object");
		requireKeys(value.author, new Set(["name", "email", "url"]), "author");
		if (Object.values(value.author).some((field) => typeof field !== "string"))
			throw new Error("author fields must be strings");
	}
	if (
		value.keywords !== undefined &&
		(!Array.isArray(value.keywords) || value.keywords.some((field) => typeof field !== "string"))
	)
		throw new Error("keywords must be an array of strings");
	if (
		value.extensions !== undefined &&
		(!record(value.extensions) || Object.values(value.extensions).some((field) => !record(field)))
	)
		throw new Error("extensions must contain namespaced objects");
	const extensions = value.extensions as Record<string, Record<string, unknown>> | undefined;
	const clio = clioConfiguration(extensions?.[PLUGIN_EXTENSION_KEY], root);
	return { ...(value as unknown as Omit<PluginManifest, "clio">), clio };
}

/** Hash once, then parse the exact manifest bytes covered by that digest. */
export function readPluginManifest(root: string): PluginCandidate {
	const resolved = path.resolve(root);
	const manifestPath = path.join(resolved, "plugin.json");
	const diagnostics: PluginDiagnostic[] = [];
	try {
		if (existsSync(path.join(resolved, "state.json")))
			throw new Error("root state.json is reserved for plugin installation state");
		const digest = pluginContentDigestWithCapture(resolved, { capture: ["plugin.json"] });
		const bytes = digest.captured.get("plugin.json");
		if (!bytes) throw new Error("plugin.json must be a regular file at the plugin root");
		const manifest = parsePluginManifest(bytes.toString("utf8"), resolved);
		if (existsSync(path.join(resolved, "mcp.json")))
			diagnostics.push({
				type: "warning",
				message: "MCP declarations are preserved; this Clio version does not execute MCP servers",
				path: path.join(resolved, "mcp.json"),
			});
		return {
			path: resolved,
			manifestPath,
			manifest,
			valid: true,
			diagnostics,
			contentDigest: digest.digest,
			manifestDigest: createHash("sha256").update(bytes).digest("hex"),
		};
	} catch (error) {
		diagnostics.push({
			type: "error",
			message: error instanceof Error ? error.message : String(error),
			path: manifestPath,
		});
		return { path: resolved, manifestPath, valid: false, diagnostics };
	}
}

export function discoverPluginPackages(root: string): PluginCandidate[] {
	if (existsSync(path.join(root, "plugin.json"))) return [readPluginManifest(root)];
	try {
		return readdirSync(root)
			.sort()
			.filter((name) => !name.startsWith(".") && lstatSync(path.join(root, name)).isDirectory())
			.map((name) => readPluginManifest(path.join(root, name)));
	} catch {
		return [readPluginManifest(root)];
	}
}

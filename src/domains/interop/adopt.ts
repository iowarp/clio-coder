import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { clioConfigDir } from "../../core/xdg.js";
import { parseAgentRecipeSchema } from "../agents/index.js";
import {
	listInstalledPlugins,
	PLUGIN_EXTENSION_KEY,
	PLUGIN_SCHEMA,
	pluginBaseDir,
	readPluginManifest,
} from "../plugins/index.js";
import { loadPromptTemplates } from "../resources/prompts/loader.js";
import { normalizedSkillHash } from "../resources/skills/content-hash.js";
import { loadSkills } from "../resources/skills/loader.js";
import { installInteropPackage } from "./install.js";
import { inventoryText } from "./inventory.js";
import type { InteropAgentId, InteropInventory, InteropInventoryItem } from "./types.js";

export type AdoptionKind = "skill" | "agent" | "prompt" | "plugin";
export interface InteropAdoptionEntry {
	item: InteropInventoryItem;
	action: "install" | "skip";
	reason: string;
	id?: string;
	destination?: string;
	digest?: string;
	omitted?: string[];
	/** Immutable bytes reviewed by the operator. Never serialized by the CLI. */
	files?: Readonly<Record<string, string>>;
}
export interface InteropAdoptionPlan {
	host: InteropAgentId;
	cwd: string;
	scope: "user" | "project";
	entries: InteropAdoptionEntry[];
}
const DATA_EXTENSIONS = new Set([".md", ".txt", ".rst", ".csv", ".bib"]);
const FORBIDDEN_PARTS = new Set([
	"hooks",
	"output-styles",
	"scripts",
	"tools",
	"node_modules",
	".git",
	".claude-plugin",
	".codex-plugin",
]);
function safeName(name: string): string {
	const value = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 45)
		.replace(/-$/u, "");
	if (!value) throw new Error("No safe resource identifier.");
	return value;
}
function tree(root: string, dataOnly = false, omitted: string[] = []): Record<string, string> {
	const files: Record<string, string> = {};
	let bytes = 0;
	const visit = (dir: string, depth: number): void => {
		if (depth > 12) throw new Error("Source tree exceeds depth limit.");
		if (lstatSync(dir).isSymbolicLink()) throw new Error("Symbolic links are not adoptable.");
		for (const name of readdirSync(dir).sort()) {
			const file = path.join(dir, name);
			const relative = path.relative(root, file).split(path.sep).join("/");
			if (dataOnly && relative.split("/").some((part) => FORBIDDEN_PARTS.has(part) || part === "fleets")) {
				omitted.push(relative);
				continue;
			}
			const stat = lstatSync(file);
			if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
				throw new Error("Symbolic links and special files are not adoptable.");
			if (stat.isDirectory()) visit(file, depth + 1);
			else {
				if (dataOnly && relative !== "plugin.json" && (!safeData(relative) || (stat.mode & 0o111) !== 0)) {
					omitted.push(relative);
					continue;
				}
				if ((stat.mode & 0o111) !== 0) throw new Error(`Executable file is not adoptable: ${path.relative(root, file)}`);
				const text = inventoryText(file);
				bytes += Buffer.byteLength(text);
				if (bytes > 16 * 1024 * 1024 || Object.keys(files).length >= 2048)
					throw new Error("Source tree exceeds adoption limits.");
				files[path.relative(root, file).split(path.sep).join("/")] = text;
			}
		}
	};
	visit(root, 0);
	return files;
}
function digest(files: Readonly<Record<string, string>>): string {
	const hash = createHash("sha256");
	for (const key of Object.keys(files).sort())
		hash
			.update(key)
			.update("\0")
			.update(files[key] ?? "")
			.update("\0");
	return hash.digest("hex");
}
function prose(text: string): { metadata: Record<string, unknown>; body: string } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
	if (!match) return { metadata: {}, body: text };
	const metadata: unknown = parseYaml(match[1] ?? "");
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
		throw new Error("Invalid resource frontmatter.");
	return { metadata: metadata as Record<string, unknown>, body: match[2] ?? "" };
}
function safeData(file: string): boolean {
	return !file.split("/").some((part) => FORBIDDEN_PARTS.has(part)) && DATA_EXTENSIONS.has(path.extname(file));
}
function prepared(
	item: InteropInventoryItem,
	host: InteropAgentId,
): { id: string; version: string; files: Record<string, string>; note: string; omitted: string[] } {
	const omitted: string[] = [];
	let files: Record<string, string>;
	let id: string;
	let version = "0.0.0";
	let note = "Text only; foreign execution settings are not imported.";
	if (item.kind === "plugin") {
		const candidate = readPluginManifest(item.path);
		if (!candidate.valid || !candidate.manifest)
			throw new Error("Not adoptable: a valid portable root plugin.json is required.");
		const manifest = candidate.manifest;
		id = manifest.name;
		version = manifest.version ?? "0.0.0";
		// Do not silently change the meaning of portable packages by removing dependencies.
		files = tree(item.path, true, omitted);
		const raw = JSON.parse(files["plugin.json"] ?? "{}") as Record<string, unknown>;
		const resources = Object.fromEntries(
			Object.entries(manifest.clio.resources).filter(([key]) => ["skills", "agents", "prompts"].includes(key)),
		);
		const components = manifest.clio.components.filter(
			(component) =>
				["skill", "agent", "prompt", "resource"].includes(component.kind) && files[component.path] !== undefined,
		);
		const retained = new Set(components.map((component) => `${component.kind}:${component.id}`));
		if (components.some((component) => component.requires?.some((ref) => !retained.has(ref))))
			throw new Error("Not adoptable: retained resources require omitted executable components.");
		raw.extensions = {
			[PLUGIN_EXTENSION_KEY]: {
				manifestVersion: 1,
				resources,
				components,
				...(manifest.clio.compatibility ? { compatibility: manifest.clio.compatibility } : {}),
			},
		};
		files["plugin.json"] = JSON.stringify(raw, null, 2);
		note =
			"Data-only portable projection; hooks, MCP, scripts, tools, fleets and host settings are skipped. References to omitted files are unavailable.";
	} else {
		id = safeName(`${host}-${item.kind}-${item.name}`);
		const resourceId = safeName(item.name);
		const plural = `${item.kind}s`;
		let componentPath: string;
		if (item.kind === "skill") {
			const source = tree(path.dirname(item.path));
			if (Object.keys(source).some((file) => !safeData(file)))
				throw new Error("Not adoptable: skill contains executable or non-text companion files.");
			const skill = prose(source["SKILL.md"] ?? "");
			if (typeof skill.metadata.name !== "string" || typeof skill.metadata.description !== "string")
				throw new Error("Skill requires name and description frontmatter.");
			// Never carry a foreign audit stamp across the approval boundary.
			delete skill.metadata["clio-coder"];
			delete skill.metadata.clio;
			for (const key of [
				"audit",
				"installed-hash",
				"source-url",
				"installed-by",
				"hooks",
				"mcpServers",
				"allowed-tools",
				"tools",
				"context",
				"agent",
			])
				delete skill.metadata[key];
			source["SKILL.md"] =
				`---\n${stringifyYaml({ ...skill.metadata, "clio-coder": { audit: "unknown" } })}---\n${skill.body}`;
			files = Object.fromEntries(Object.entries(source).map(([file, text]) => [`skills/${resourceId}/${file}`, text]));
			componentPath = `skills/${resourceId}/SKILL.md`;
		} else {
			if ((lstatSync(item.path).mode & 0o111) !== 0) throw new Error("Executable files are not adoptable.");
			const raw = inventoryText(item.path);
			const parsed = item.path.endsWith(".toml")
				? (() => {
						const data = parseToml(raw);
						if (typeof data.developer_instructions !== "string") throw new Error("Agent developer_instructions is unknown.");
						return { metadata: data as Record<string, unknown>, body: data.developer_instructions };
					})()
				: prose(raw);
			if (!parsed.body.trim()) throw new Error("Empty resource body.");
			let metadata: Record<string, unknown> = {
				description:
					typeof parsed.metadata.description === "string"
						? parsed.metadata.description
						: `Adopted ${item.kind} ${item.name}`,
			};
			if (item.kind === "agent") {
				metadata = {
					...metadata,
					version: 1,
					name: item.name,
					tools: { required: ["read"], optional: ["grep", "find", "ls"] },
					skills: [],
					audience: "custom",
					category: "research",
					capabilityClass: "read-only",
					latencyClass: "balanced",
					projectContextTier: "bounded",
					budget: { toolCalls: 24, readReserve: 4, synthesis: true },
					resultContract: { kind: "artifact-report" },
					tags: ["interop"],
				};
				note =
					"Persona copied into a read-only Clio recipe; host tools, permissions, model, hooks and skill bindings are omitted.";
			}
			if (item.kind === "agent")
				parseAgentRecipeSchema({
					id: resourceId,
					source: "plugin",
					filepath: item.path,
					body: parsed.body,
					frontmatter: metadata,
				});
			componentPath = `${plural}/${resourceId}.md`;
			files = { [componentPath]: `---\n${stringifyYaml(metadata)}---\n${parsed.body}` };
		}
		files["plugin.json"] = JSON.stringify(
			{
				$schema: PLUGIN_SCHEMA,
				name: id,
				version,
				description: `Adopted ${item.kind} from ${host}`,
				extensions: {
					[PLUGIN_EXTENSION_KEY]: {
						manifestVersion: 1,
						kind: item.kind,
						resources: { [plural]: plural },
						components: [{ kind: item.kind, id: resourceId, path: componentPath }],
					},
				},
			},
			null,
			2,
		);
	}
	const manifest = JSON.parse(files["plugin.json"] ?? "{}") as { extensions?: Record<string, unknown> };
	manifest.extensions = {
		...manifest.extensions,
		"ai.iowarp.clio.interop": { host, source: item.path, sourceScope: item.scope, untrusted: true },
	};
	files["plugin.json"] = `${JSON.stringify(manifest, null, 2)}\n`;
	return { id, version, files, note, omitted };
}
export function planInteropAdoption(input: {
	host: InteropAgentId;
	inventory: InteropInventory;
	cwd?: string;
	scope?: "user" | "project";
	kind?: AdoptionKind;
}): InteropAdoptionPlan {
	const cwd = path.resolve(input.cwd ?? process.cwd());
	const scope = input.scope ?? "user";
	const installed = listInstalledPlugins(cwd, { all: true });
	const installedSkills = loadSkills({
		cwd,
		roots: [
			{ path: path.join(clioConfigDir(), "skills"), scope: "user" },
			{ path: path.join(cwd, ".clio-coder/skills"), scope: "project" },
			...installed.flatMap((pkg) =>
				pkg.resources.skills
					? [{ path: path.join(pkg.rootPath, pkg.resources.skills), rootPath: pkg.rootPath, scope: "package" as const }]
					: [],
			),
		],
	}).items;
	const installedPrompts = loadPromptTemplates({
		cwd,
		roots: [
			{ path: path.join(clioConfigDir(), "prompts"), scope: "user" },
			{ path: path.join(cwd, ".clio-coder/prompts"), scope: "project" },
			...installed.flatMap((pkg) =>
				pkg.resources.prompts
					? [{ path: path.join(pkg.rootPath, pkg.resources.prompts), rootPath: pkg.rootPath, scope: "package" as const }]
					: [],
			),
		],
	}).items;
	const promptBodies = new Set(
		installedPrompts.flatMap((prompt) => {
			try {
				return [prose(inventoryText(prompt.filePath)).body];
			} catch {
				return [];
			}
		}),
	);
	const installedContent = new Set(
		installed.flatMap((pkg) => {
			try {
				const files = tree(pkg.rootPath);
				delete files["plugin.json"];
				return [digest(files)];
			} catch {
				return [];
			}
		}),
	);
	const planned = new Set<string>();
	const plan: InteropAdoptionPlan = { host: input.host, cwd, scope, entries: [] };
	for (const item of input.inventory.items) {
		const skip = (reason: string): void => {
			plan.entries.push({ item, action: "skip", reason });
		};
		if (!["skill", "agent", "prompt", "plugin"].includes(item.kind)) {
			skip(`Not adoptable: ${item.kind} is executable configuration or unsupported presentation data.`);
			continue;
		}
		if (input.kind && item.kind !== input.kind) {
			skip(`Excluded by --kind ${input.kind}.`);
			continue;
		}
		if (item.plugin && !input.kind && planned.has(item.plugin)) {
			skip("Provided by an installed or planned portable plugin.");
			continue;
		}
		try {
			if (
				item.kind === "skill" &&
				installedSkills.some((skill) => skill.normalizedHash === normalizedSkillHash(inventoryText(item.path)))
			) {
				skip("Already installed: same skill content digest.");
				continue;
			}
			if (item.kind === "prompt" && promptBodies.has(prose(inventoryText(item.path)).body)) {
				skip("Already installed: same prompt content digest.");
				continue;
			}
			const value = prepared(item, input.host);
			const hash = digest(value.files);
			if (item.kind === "plugin" && installed.some((pkg) => pkg.id === value.id && pkg.version === value.version)) {
				planned.add(item.path);
				skip("Already installed: same package id and version.");
				continue;
			}
			const resourceFiles = { ...value.files };
			delete resourceFiles["plugin.json"];
			if (Object.keys(resourceFiles).length > 0 && installedContent.has(digest(resourceFiles))) {
				skip("Already installed: same content digest.");
				continue;
			}

			if (installed.some((pkg) => pkg.id === value.id && pkg.scope === scope) || planned.has(value.id)) {
				skip("Package identifier collision; existing content will not be replaced.");
				continue;
			}
			planned.add(value.id);
			if (item.kind === "plugin") planned.add(item.path);
			plan.entries.push({
				item,
				action: "install",
				id: value.id,
				destination: path.join(pluginBaseDir(scope, cwd), value.id),
				files: value.files,
				digest: hash,
				reason: value.note,
				omitted: value.omitted,
			});
		} catch (error) {
			skip(error instanceof Error ? error.message : String(error));
		}
	}
	return plan;
}
export function renderInteropAdoptionPlan(plan: InteropAdoptionPlan): string {
	return [
		`Adopt resources from ${plan.host} into Clio (${plan.scope})?`,
		...plan.entries.flatMap((entry) => [
			`${entry.action.toUpperCase()} ${entry.item.kind} ${entry.item.name} (${entry.item.scope})`,
			`  Source: ${entry.item.path}`,
			...(entry.destination ? [`  Destination: ${entry.destination}`, `  SHA-256: ${entry.digest}`] : []),
			`  ${entry.reason}`,
			...(entry.omitted ?? []).map((file) => `  SKIP ${file}: executable, host-specific, or non-text data.`),
		]),
		"Foreign resources remain untrusted until the project-import trust setting is enabled.",
		"Host files are never changed. Approval applies only to the displayed content.",
	].join("\n");
}
export function applyInteropAdoption(
	plan: InteropAdoptionPlan,
	approved: boolean,
): { installed: string[]; diagnostics: string[] } {
	const result = { installed: [] as string[], diagnostics: [] as string[] };
	if (!approved) {
		result.diagnostics.push("Approval required; nothing installed.");
		return result;
	}
	for (const entry of plan.entries) {
		if (entry.action !== "install" || !entry.files || !entry.id) continue;
		let staging: string | undefined;
		try {
			if (digest(entry.files) !== entry.digest || digest(prepared(entry.item, plan.host).files) !== entry.digest)
				throw new Error("Source or plan changed after review; inspect a new plan.");
			staging = mkdtempSync(path.join(tmpdir(), "clio-interop-adopt-"));
			for (const [file, text] of Object.entries(entry.files)) {
				const target = path.join(staging, file);
				mkdirSync(path.dirname(target), { recursive: true });
				writeFileSync(target, text, { mode: 0o644 });
			}
			const candidate = readPluginManifest(staging);
			if (!candidate.valid || !candidate.contentDigest)
				throw new Error(candidate.diagnostics.map((d) => d.message).join("; "));
			const installed = installInteropPackage({
				sourcePath: staging,
				kind: entry.item.kind as AdoptionKind,
				trust: "foreign",
				cwd: plan.cwd,
				scope: plan.scope,
				expectedId: entry.id,
				expectedDigest: candidate.contentDigest,
				origin: { kind: "interop", host: plan.host, source: path.resolve(entry.item.path) },
			});
			if (installed.plugin) result.installed.push(installed.plugin.id);
			result.diagnostics.push(...installed.diagnostics.map((d) => d.message));
		} catch (error) {
			result.diagnostics.push(`${entry.item.name}: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			if (staging) rmSync(staging, { recursive: true, force: true });
		}
	}
	return result;
}

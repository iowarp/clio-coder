import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { clioConfigDir } from "../../core/xdg.js";
import {
	listInstalledPlugins,
	PLUGIN_EXTENSION_KEY,
	PLUGIN_SCHEMA,
	pluginBaseDir,
	readPluginInstallRecord,
	readPluginManifest,
} from "../plugins/index.js";
import type { PluginOrigin } from "../plugins/types.js";
import { validateLibraryPackage } from "../resources/library-validation.js";
import { loadPromptTemplates } from "../resources/prompts/loader.js";
import { normalizedSkillHash } from "../resources/skills/content-hash.js";
import { loadSkills } from "../resources/skills/loader.js";
import { detectForeignPlugin, type ForeignResourceOutcome, projectForeignPlugin } from "./foreign.js";
import { installInteropPackage } from "./install.js";
import { inventoryText } from "./inventory.js";
import { digest, projectAgent, projectPrompt, projectSkill, prose, safeName, tree } from "./projection.js";
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
	requirements?: string[];
	/** Manifest format the package was read as; absent for loose resources. */
	format?: "portable" | "claude-code" | "codex";
	/** Per-resource conversion results for foreign-format packages. */
	outcomes?: ForeignResourceOutcome[];
	/** Host features present in the source that adoption never activates. */
	unsupported?: string[];
	/** Immutable bytes reviewed by the operator. Never serialized by the CLI. */
	files?: Readonly<Record<string, string>>;
}
export interface InteropAdoptionPlan {
	host: InteropAgentId;
	cwd: string;
	scope: "user" | "project";
	entries: InteropAdoptionEntry[];
}
export interface PreparedAdoption {
	id: string;
	version: string;
	files: Record<string, string>;
	note: string;
	omitted: string[];
	requirements: string[];
	format?: "portable" | "claude-code" | "codex";
	outcomes?: ForeignResourceOutcome[];
	unsupported?: string[];
}
/** Portable data-only projection shared by local adoption and explicit import. */
export function preparePortablePackage(root: string): PreparedAdoption {
	const candidate = readPluginManifest(root);
	if (!candidate.valid || !candidate.manifest)
		throw new Error(
			`Not adoptable: invalid portable root plugin.json (${candidate.diagnostics.map((d) => d.message).join("; ")}).`,
		);
	const manifest = candidate.manifest;
	const omitted: string[] = [];
	// Do not silently change the meaning of portable packages by removing dependencies.
	const files = tree(root, true, omitted);
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
	// Preserve the declared package kind; a kind whose only public component is dropped is not a useful plugin.
	const kind = manifest.clio.kind ?? "plugin";
	if (!["plugin", "skill", "agent", "prompt"].includes(kind))
		throw new Error(
			`Not adoptable: ${kind} packages have no data-only projection; install them through the library instead.`,
		);
	if (kind !== "plugin" && !components.some((component) => component.kind === kind))
		throw new Error(`Not adoptable: the ${kind} package's public ${kind} component is not projectable.`);
	// The portable skills/ convention needs no Clio component graph. Enumerate
	// through the shared readers so implicit recipes and actual runtime names
	// get the same checks as explicitly declared components.
	const validation = validateLibraryPackage(root);
	if (!validation.valid)
		throw new Error(
			`Not adoptable: invalid recipe content (${validation.validation.diagnostics
				.filter((item) => item.severity === "error")
				.map((item) => item.message)
				.join("; ")}).`,
		);
	const recipes = validation.validation.resources.filter(
		(resource) => ["skill", "agent", "prompt"].includes(resource.kind) && files[resource.path] !== undefined,
	);
	if (recipes.length === 0) throw new Error("Not adoptable: the portable package has no supported data-only recipes.");
	// Retained recipe text that names an omitted companion cannot be claimed working.
	const outcomes: ForeignResourceOutcome[] = [];
	for (const resource of recipes) {
		const component = components.find((item) => item.kind === resource.kind && item.path === resource.path);
		// A root SKILL.md owns the whole package as its companion scope.
		const skillDir = resource.kind === "skill" ? path.posix.dirname(resource.path) : undefined;
		const dir = skillDir === undefined ? undefined : skillDir === "." ? "" : `${skillDir}/`;
		const texts = Object.entries(files)
			.filter(([file]) => file !== "plugin.json" && (dir === undefined ? file === resource.path : file.startsWith(dir)))
			.map(([, text]) => text);
		// Own companions match by package path or basename; shared assets elsewhere only by explicit package path.
		const needed = omitted.filter((file) => {
			const own = dir !== undefined && file.startsWith(dir);
			const base = path.posix.basename(file);
			return texts.some((text) => text.includes(file) || (own && base.includes(".") && text.includes(base)));
		});
		if (needed.length)
			throw new Error(
				`Not adoptable: ${resource.kind} ${resource.name} references omitted companions (${needed.join(", ")}); the data-only import cannot claim it works. Use library install for script-bearing packages.`,
			);
		outcomes.push({
			kind: resource.kind as ForeignResourceOutcome["kind"],
			name: resource.name,
			source: resource.path,
			status: "converted",
			...(component ? { id: component.id } : {}),
			destination: resource.path,
		});
	}
	raw.extensions = {
		[PLUGIN_EXTENSION_KEY]: {
			manifestVersion: 1,
			...(kind !== "plugin" ? { kind } : {}),
			...(manifest.clio.requires ? { requires: manifest.clio.requires } : {}),
			resources,
			components,
			...(manifest.clio.compatibility ? { compatibility: manifest.clio.compatibility } : {}),
		},
	};
	files["plugin.json"] = JSON.stringify(raw, null, 2);
	return {
		id: manifest.name,
		version: manifest.version ?? "0.0.0",
		files,
		note:
			"Data-only portable projection; hooks, MCP, scripts, tools, fleets and host settings are skipped. References to omitted files are unavailable.",
		omitted,
		requirements: [...(manifest.clio.requires ?? [])],
		format: "portable",
		outcomes,
	};
}
/** Foreign-format (Claude Code / Codex) package normalized at the import boundary. */
export function prepareForeignPackage(
	root: string,
	format?: "claude-code" | "codex",
): PreparedAdoption & { format: "claude-code" | "codex" } {
	const detection = detectForeignPlugin(root, format);
	if (detection.format === "portable") throw new Error("Portable root plugin.json present; use the portable route.");
	if (detection.format === "none") throw new Error(`Not adoptable: ${detection.diagnostics.join(" ")}`);
	const projection = projectForeignPlugin({
		root,
		format: detection.format,
		...(detection.manifestPath ? { manifestPath: detection.manifestPath } : {}),
	});
	if (!projection.outcomes.some((outcome) => outcome.status === "converted"))
		throw new Error(
			`Not adoptable: no supported recipe converted from ${detection.manifestPath}${
				projection.outcomes.length
					? ` (${projection.outcomes.map((o) => `${o.kind} ${o.name}: ${o.reason ?? "unsupported"}`).join("; ")})`
					: ""
			}.`,
		);
	return {
		id: projection.id,
		version: projection.version,
		files: projection.files,
		note: `${detection.format === "claude-code" ? "Claude Code" : "Codex"} plugin normalized to a portable Clio package; hooks, MCP, LSP, scripts and host settings are never activated.${
			projection.notes.length ? ` ${projection.notes.join(" ")}` : ""
		}`,
		omitted: projection.omitted,
		requirements: projection.requirements,
		format: detection.format,
		outcomes: projection.outcomes,
		unsupported: projection.unsupported,
	};
}
function prepared(item: InteropInventoryItem, host: InteropAgentId): PreparedAdoption {
	let value: PreparedAdoption;
	if (item.kind === "plugin") {
		const detection = detectForeignPlugin(item.path);
		// An invalid portable manifest is diagnosed; it is never hidden by a foreign fallback.
		value =
			detection.format === "portable" || detection.format === "none"
				? preparePortablePackage(item.path)
				: prepareForeignPackage(item.path, detection.format);
	} else {
		const id = safeName(`${host}-${item.kind}-${item.name}`);
		const plural = `${item.kind}s`;
		let note = "Text only; foreign execution settings are not imported.";
		const resource =
			item.kind === "skill"
				? projectSkill({ skillDir: path.dirname(item.path), fallbackName: item.name })
				: item.kind === "agent"
					? projectAgent({ file: item.path, name: item.name })
					: projectPrompt({ file: item.path, name: item.name });
		if (item.kind === "agent")
			note =
				"Persona copied into a read-only Clio recipe; host tools, permissions, model, hooks and skill bindings are omitted.";
		const files = { ...resource.files };
		files["plugin.json"] = JSON.stringify(
			{
				$schema: PLUGIN_SCHEMA,
				name: id,
				version: "0.0.0",
				description: `Adopted ${item.kind} from ${host}`,
				extensions: {
					[PLUGIN_EXTENSION_KEY]: {
						manifestVersion: 1,
						kind: item.kind,
						resources: { [plural]: plural },
						components: [{ kind: item.kind, id: resource.id, path: resource.componentPath }],
					},
				},
			},
			null,
			2,
		);
		value = {
			id,
			version: "0.0.0",
			files,
			note,
			omitted: [],
			requirements: [],
			...(resource.omittedFields.length
				? {
						outcomes: [
							{
								kind: item.kind as "skill" | "agent" | "prompt",
								name: resource.name,
								source: item.path,
								status: "converted",
								id: resource.id,
								destination: resource.componentPath,
								omittedFields: resource.omittedFields,
							},
						],
					}
				: {}),
		};
	}
	const manifest = JSON.parse(value.files["plugin.json"] ?? "{}") as { extensions?: Record<string, unknown> };
	manifest.extensions = {
		...manifest.extensions,
		"ai.iowarp.clio.interop": {
			host,
			source: item.path,
			sourceScope: item.scope,
			untrusted: true,
			...(value.format ? { format: value.format } : {}),
		},
	};
	value.files["plugin.json"] = `${JSON.stringify(manifest, null, 2)}\n`;
	return value;
}
/** Requirements must already be usable; adoption never expands the reviewed import set. */
export function vendorOf(format: PreparedAdoption["format"]): "claude-code" | "codex" | undefined {
	return format === "claude-code" || format === "codex" ? format : undefined;
}
export function unmetRequirements(
	requirements: ReadonlyArray<string>,
	cwd: string,
	scope: "user" | "project",
	/** When set, direct requirements came from vendor dependencies and need matching import provenance. */
	vendor?: "claude-code" | "codex",
): string[] {
	if (requirements.length === 0) return [];
	const available = new Map(
		listInstalledPlugins(cwd, { all: true, ...(scope === "user" ? { scope } : {}) })
			.filter((pkg) => pkg.loadable)
			.map((pkg) => [`${pkg.kind ?? "plugin"}:${pkg.id}`, pkg]),
	);
	const problems = new Set<string>();
	if (vendor)
		for (const ref of requirements) {
			const pkg = available.get(ref);
			if (!pkg) continue;
			const origin = readPluginInstallRecord(pkg.id, { cwd, scope: pkg.scope })?.origin;
			const provenance =
				typeof origin === "object" && (origin.kind === "import" || origin.kind === "interop") ? origin.format : undefined;
			if (provenance !== vendor)
				problems.add(
					`${ref} (installed package is not an imported ${vendor} plugin; a same-named native package does not satisfy a vendor dependency)`,
				);
		}
	const visiting = new Set<string>();
	const checked = new Set<string>();
	const visit = (ref: string): void => {
		if (visiting.has(ref)) {
			problems.add(`${ref} (dependency cycle)`);
			return;
		}
		if (checked.has(ref)) return;
		const dependency = available.get(ref);
		if (!dependency) {
			problems.add(`${ref} (missing, inactive, or unavailable in ${scope} scope)`);
			return;
		}
		visiting.add(ref);
		for (const nested of dependency.manifest?.clio.requires ?? []) visit(nested);
		visiting.delete(ref);
		checked.add(ref);
	};
	for (const ref of requirements) visit(ref);
	return [...problems];
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
			const missing = unmetRequirements(value.requirements, cwd, scope, vendorOf(value.format));
			if (missing.length) {
				skip(
					`Unsatisfied package requirements: ${missing.join(", ")}. Install dependencies through the library and review a new plan; no extra resources are imported.`,
				);
				continue;
			}
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
				requirements: value.requirements,
				...(value.format ? { format: value.format } : {}),
				...(value.outcomes?.length ? { outcomes: value.outcomes } : {}),
				...(value.unsupported?.length ? { unsupported: value.unsupported } : {}),
			});
		} catch (error) {
			skip(error instanceof Error ? error.message : String(error));
		}
	}
	return plan;
}
function renderOutcomes(outcomes: ReadonlyArray<ForeignResourceOutcome> | undefined): string[] {
	return (outcomes ?? []).map((outcome) => {
		const detail = [
			...(outcome.omittedFields?.length ? [`omitted frontmatter: ${outcome.omittedFields.join(", ")}`] : []),
			...(outcome.omittedFiles?.length ? [`omitted files: ${outcome.omittedFiles.join(", ")}`] : []),
			...(outcome.reason ? [outcome.reason] : []),
		];
		return outcome.status === "converted"
			? `  CONVERT ${outcome.kind} ${outcome.name} -> ${outcome.destination}${detail.length ? ` (${detail.join("; ")})` : ""}`
			: `  UNSUPPORTED ${outcome.kind} ${outcome.name} (${outcome.source}): ${detail.join("; ")}`;
	});
}
export function renderInteropAdoptionPlan(plan: InteropAdoptionPlan): string {
	return [
		`Adopt resources from ${plan.host} into Clio (${plan.scope})?`,
		...plan.entries.flatMap((entry) => [
			`${entry.action.toUpperCase()} ${entry.item.kind} ${entry.item.name} (${entry.item.scope})`,
			`  Source: ${entry.item.path}`,
			...(entry.destination ? [`  Destination: ${entry.destination}`, `  SHA-256: ${entry.digest}`] : []),
			`  ${entry.reason}`,
			...(entry.format && entry.format !== "portable"
				? [`  Format: ${entry.format} (normalized to a portable Clio package)`]
				: []),
			...(entry.requirements?.length ? [`  Requires installed packages: ${entry.requirements.join(", ")}`] : []),
			...renderOutcomes(entry.outcomes),
			...(entry.unsupported ?? []).map((feature) => `  UNSUPPORTED ${feature}`),
			...(entry.omitted ?? []).map((file) => `  SKIP ${file}: executable, host-specific, or non-text data.`),
		]),
		"Foreign resources remain untrusted until the project-import trust setting is enabled.",
		"Host files are never changed. Approval applies only to the displayed content.",
	].join("\n");
}
function interopOrigin(host: InteropAgentId, entry: InteropAdoptionEntry): PluginOrigin {
	const marketplace =
		entry.item.marketplace && entry.item.marketplace !== "unknown" ? entry.item.marketplace : undefined;
	return {
		kind: "interop",
		host,
		source: path.resolve(entry.item.path),
		...(entry.format ? { format: entry.format } : {}),
		...(marketplace ? { marketplace } : {}),
	};
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
			const current = prepared(entry.item, plan.host);
			if (digest(entry.files) !== entry.digest || digest(current.files) !== entry.digest)
				throw new Error("Source or plan changed after review; inspect a new plan.");
			const missing = unmetRequirements(current.requirements, plan.cwd, plan.scope, vendorOf(current.format));
			if (missing.length)
				throw new Error(
					`Unsatisfied package requirements after review: ${missing.join(", ")}. No extra resources are imported.`,
				);
			staging = mkdtempSync(path.join(tmpdir(), "clio-coder-interop-adopt-"));
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
				origin: interopOrigin(plan.host, entry),
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

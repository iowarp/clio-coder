/**
 * Documented foreign plugin formats normalized into a portable Clio package at
 * the import boundary. Sources: the saved Claude Code plugin reference
 * (.claude-plugin/plugin.json, default skills/, root SKILL.md fallback,
 * commands/ and agents/ with manifest overrides) and the OpenAI plugin reference
 * (.codex-plugin/plugin.json compatibility manifest with a skills path).
 *
 * The projection is text only. Hooks, MCP, LSP, apps, monitors, output styles,
 * scripts and host settings are reported and never activated.
 */
import { existsSync, lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { isSemanticVersion } from "../extensions/compatibility.js";
import { isPluginId, PLUGIN_EXTENSION_KEY, PLUGIN_SCHEMA } from "../plugins/index.js";
import type { ForeignPackageFormat, PluginComponent } from "../plugins/types.js";
import { inventoryText } from "./inventory.js";
import { type ProjectedResource, projectAgent, projectPrompt, projectSkill, safeName, tree } from "./projection.js";

export type ForeignPluginFormat = Exclude<ForeignPackageFormat, "portable">;

export const FOREIGN_MANIFESTS: ReadonlyArray<{ format: ForeignPackageFormat; path: string }> = [
	{ format: "portable", path: "plugin.json" },
	{ format: "claude-code", path: ".claude-plugin/plugin.json" },
	{ format: "codex", path: ".codex-plugin/plugin.json" },
];

export interface ForeignPluginDetection {
	format: ForeignPackageFormat | "none";
	manifestPath?: string;
	candidates: Array<{ format: ForeignPackageFormat; path: string }>;
	ambiguous: boolean;
	diagnostics: string[];
}

/**
 * Deterministic precedence: a root plugin.json is always the portable manifest
 * and is never bypassed by a hidden vendor manifest. Two hidden manifests need
 * an explicit format.
 */
export function detectForeignPlugin(root: string, explicit?: ForeignPluginFormat): ForeignPluginDetection {
	const present = (relative: string): boolean => {
		try {
			lstatSync(path.join(root, relative));
			return true;
		} catch {
			return false;
		}
	};
	// Any entry named plugin.json is authoritative; a directory or link there is a diagnosed native error, never a fallback.
	const candidates = FOREIGN_MANIFESTS.filter(({ path: relative }) => present(relative));
	const diagnostics: string[] = [];
	const portable = candidates.find((candidate) => candidate.format === "portable");
	if (portable) {
		if (!lstatSync(path.join(root, "plugin.json")).isFile())
			diagnostics.push("Root plugin.json exists but is not a regular file; the portable manifest is invalid.");
		if (explicit)
			diagnostics.push(`Root plugin.json is portable; --format ${explicit} is ignored and no foreign fallback runs.`);
		for (const other of candidates.filter((candidate) => candidate.format !== "portable"))
			diagnostics.push(`Ignoring ${other.path}: the portable root plugin.json takes precedence.`);
		return { format: "portable", manifestPath: portable.path, candidates, ambiguous: false, diagnostics };
	}
	const hidden = candidates.filter((candidate) => candidate.format !== "portable");
	if (hidden.length === 0)
		return {
			format: "none",
			candidates,
			ambiguous: false,
			diagnostics: [
				"No plugin manifest found: expected plugin.json, .claude-plugin/plugin.json or .codex-plugin/plugin.json.",
			],
		};
	if (explicit) {
		const chosen = hidden.find((candidate) => candidate.format === explicit);
		if (!chosen)
			return {
				format: "none",
				candidates,
				ambiguous: false,
				diagnostics: [`No ${explicit} manifest present; found ${hidden.map((item) => item.path).join(", ")}.`],
			};
		return { format: chosen.format, manifestPath: chosen.path, candidates, ambiguous: false, diagnostics };
	}
	if (hidden.length > 1)
		return {
			format: "none",
			candidates,
			ambiguous: true,
			diagnostics: [
				`Both ${hidden.map((item) => item.path).join(" and ")} are present; choose --format claude or --format codex.`,
			],
		};
	const only = hidden[0] as { format: ForeignPluginFormat; path: string };
	return { format: only.format, manifestPath: only.path, candidates, ambiguous: false, diagnostics };
}

export interface ForeignResourceOutcome {
	kind: "skill" | "agent" | "prompt";
	name: string;
	source: string;
	status: "converted" | "unsupported";
	id?: string;
	destination?: string;
	reason?: string;
	omittedFields?: string[];
	omittedFiles?: string[];
}

export interface ForeignPluginProjection {
	format: ForeignPluginFormat;
	manifestPath: string;
	id: string;
	version: string;
	description: string;
	files: Record<string, string>;
	/** Clio requirement refs derived from vendor dependencies; they must already be installed. */
	requirements: string[];
	outcomes: ForeignResourceOutcome[];
	/** Host features declared or present that Clio never activates through import. */
	unsupported: string[];
	/** Files in the source tree that were not projected. */
	omitted: string[];
	notes: string[];
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Manifest path fields: string or array of `./`-relative entries; anything else is unsupported. */
function pathList(value: unknown, field: string, problems: string[]): string[] {
	if (value === undefined) return [];
	const items = typeof value === "string" ? [value] : Array.isArray(value) ? value : undefined;
	if (!items || items.some((item) => typeof item !== "string")) {
		problems.push(`Manifest ${field} must be a path or list of paths; ignored.`);
		return [];
	}
	return items as string[];
}

/** Contain a manifest path inside the package root; escapes and symlinks are refused. */
function contained(root: string, relative: string): string {
	if (relative.includes("\\") || relative.includes("\0") || path.isAbsolute(relative))
		throw new Error(`Manifest path is not relative: ${relative}`);
	const full = path.resolve(root, relative);
	const rel = path.relative(root, full);
	if (rel === ".." || rel.startsWith(`..${path.sep}`)) throw new Error(`Manifest path escapes the package: ${relative}`);
	let cursor = root;
	for (const part of rel.split(path.sep).filter(Boolean)) {
		cursor = path.join(cursor, part);
		if (lstatSync(cursor).isSymbolicLink()) throw new Error(`Manifest path crosses a symbolic link: ${relative}`);
	}
	return full;
}

function relativeTo(root: string, file: string): string {
	return path.relative(root, file).split(path.sep).join("/");
}

function isDir(file: string): boolean {
	try {
		return lstatSync(file).isDirectory();
	} catch {
		return false;
	}
}
function isFile(file: string): boolean {
	try {
		return lstatSync(file).isFile();
	} catch {
		return false;
	}
}

/** Skill directories reachable from one declared skills path, in documented shapes. */
function skillDirectories(root: string, declared: string): string[] {
	const base = contained(root, declared);
	if (!isDir(base)) return [];
	if (isFile(path.join(base, "SKILL.md"))) return [base];
	return readdirSync(base)
		.sort()
		.map((name) => path.join(base, name))
		.filter((dir) => !lstatSync(dir).isSymbolicLink() && isDir(dir) && isFile(path.join(dir, "SKILL.md")));
}

/** Markdown files reachable from one declared commands/agents path: a file or a directory of files. */
function markdownFiles(root: string, declared: string, extensions: ReadonlyArray<string>): string[] {
	const base = contained(root, declared);
	if (isFile(base)) return extensions.some((ext) => base.endsWith(ext)) ? [base] : [];
	if (!isDir(base)) return [];
	const found: string[] = [];
	const walk = (dir: string, depth: number): void => {
		if (depth > 6) return;
		for (const name of readdirSync(dir).sort()) {
			const file = path.join(dir, name);
			const stat = lstatSync(file);
			if (stat.isSymbolicLink()) continue;
			if (stat.isDirectory()) walk(file, depth + 1);
			else if (extensions.some((ext) => name.endsWith(ext))) found.push(file);
		}
	};
	walk(base, 0);
	return found;
}

const CLAUDE_UNSUPPORTED_FIELDS = [
	"hooks",
	"mcpServers",
	"lspServers",
	"outputStyles",
	"workflows",
	"experimental",
	"userConfig",
	"channels",
	"defaultEnabled",
];
const CODEX_UNSUPPORTED_FIELDS = ["apps", "hooks", "mcpServers", "interface"];
const UNSUPPORTED_FILES = [
	"hooks/hooks.json",
	".mcp.json",
	"mcp.json",
	".lsp.json",
	".app.json",
	"monitors/monitors.json",
	"output-styles",
	"scripts",
	"tools",
];

/**
 * Normalize one foreign package tree into a portable Clio package. Source files
 * are only read. Every resource has an outcome; every dropped host feature is
 * named in `unsupported`.
 */
export function projectForeignPlugin(input: {
	root: string;
	format: ForeignPluginFormat;
	manifestPath?: string;
}): ForeignPluginProjection {
	const root = path.resolve(input.root);
	const manifestPath =
		input.manifestPath ?? (input.format === "claude-code" ? ".claude-plugin/plugin.json" : ".codex-plugin/plugin.json");
	const manifestFile = contained(root, manifestPath);
	if (!isFile(manifestFile)) throw new Error(`Missing ${manifestPath}.`);
	const parsed: unknown = JSON.parse(inventoryText(manifestFile));
	if (!record(parsed)) throw new Error(`${manifestPath} must be a JSON object.`);
	const notes: string[] = [];
	const unsupported: string[] = [];
	const outcomes: ForeignResourceOutcome[] = [];
	const rawName = typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : "";
	if (!rawName) throw new Error(`${manifestPath} requires a name.`);
	const id = isPluginId(rawName) ? rawName : safeName(rawName);
	if (id !== rawName) notes.push(`Package name "${rawName}" normalized to Clio id "${id}".`);
	let version = "0.0.0";
	if (parsed.version === undefined) notes.push("Vendor manifest declares no version; projected as 0.0.0.");
	else if (isSemanticVersion(parsed.version)) version = parsed.version as string;
	else throw new Error(`${manifestPath} version ${JSON.stringify(parsed.version)} is not a Semantic Version.`);
	notes.push(
		`Vendor identity: ${manifestPath} name ${JSON.stringify(rawName)}, version ${parsed.version === undefined ? "absent" : JSON.stringify(parsed.version)}.`,
	);
	const description =
		typeof parsed.description === "string"
			? parsed.description
			: `Imported ${input.format === "claude-code" ? "Claude Code" : "Codex"} plugin ${rawName}`;
	const fieldList = input.format === "claude-code" ? CLAUDE_UNSUPPORTED_FIELDS : CODEX_UNSUPPORTED_FIELDS;
	for (const field of fieldList)
		if (parsed[field] !== undefined) unsupported.push(`${manifestPath}#${field}: never activated by Clio import.`);
	// Vendor dependencies are prerequisites: a plain name maps to the same-named
	// imported Clio package and must already be installed; anything else blocks.
	const requirements: string[] = [];
	if (parsed.dependencies !== undefined) {
		if (!Array.isArray(parsed.dependencies)) throw new Error(`${manifestPath} dependencies must be an array.`);
		for (const dependency of parsed.dependencies) {
			const name = typeof dependency === "string" ? dependency : record(dependency) ? dependency.name : undefined;
			if (typeof name !== "string" || !name.trim())
				throw new Error(`${manifestPath} declares a dependency without a name; the package cannot be imported.`);
			if (record(dependency) && dependency.version !== undefined)
				throw new Error(
					`${manifestPath} dependency ${name} declares version constraint ${JSON.stringify(dependency.version)}; version-constrained vendor dependencies are not supported. Import ${name} first and remove the constraint in a reviewed copy, or skip this package.`,
				);
			if (record(dependency)) {
				const unknown = Object.keys(dependency).filter((key) => !["name", "version"].includes(key));
				if (unknown.length)
					throw new Error(
						`${manifestPath} dependency ${name} declares unsupported fields ${unknown.join(", ")}; source or marketplace constrained dependencies cannot be imported.`,
					);
			}
			// Identity is the exact vendor name; a lossy rename could match an unrelated package.
			if (!isPluginId(name))
				throw new Error(
					`${manifestPath} dependency ${JSON.stringify(name)} is not a portable identifier; it cannot be matched to an imported package.`,
				);
			requirements.push(`plugin:${name}`);
			notes.push(
				`Vendor dependency ${name} requires plugin:${name} imported from the same ${input.format} format; native packages with that id do not satisfy it.`,
			);
		}
	}
	for (const file of UNSUPPORTED_FILES)
		if (existsSync(path.join(root, file))) unsupported.push(`${file}: host runtime content is not imported.`);

	// Every source file is either projected or listed as omitted.
	const omittedTree: string[] = [];
	const sourceFiles = tree(root, true, omittedTree);
	const projected = new Set<string>();
	const files: Record<string, string> = {};
	const components: PluginComponent[] = [];
	const resources: Record<string, string> = {};
	const usedIds = new Map<string, string>();
	const claim = (resource: ProjectedResource, kind: "skill" | "agent" | "prompt", source: string): boolean => {
		const key = `${kind}:${resource.id}`;
		const previous = usedIds.get(key);
		if (previous) {
			outcomes.push({
				kind,
				name: resource.name,
				source,
				status: "unsupported",
				reason: `Resource id ${resource.id} already provided by ${previous}.`,
			});
			return false;
		}
		usedIds.set(key, source);
		return true;
	};
	const declaredSkills: string[] = [];
	const declaredCommands: string[] = [];
	const declaredAgents: string[] = [];
	const problems: string[] = [];
	const skillsField = pathList(parsed.skills, "skills", problems);
	if (input.format === "claude-code") {
		declaredSkills.push("skills", ...skillsField);
		const commands = pathList(parsed.commands, "commands", problems);
		declaredCommands.push(...(commands.length ? commands : ["commands"]));
		if (
			commands.length &&
			isDir(path.join(root, "commands")) &&
			!commands.some((c) => path.resolve(root, c) === path.join(root, "commands"))
		)
			notes.push("Manifest commands replaces the default commands/ directory; the default folder is not scanned.");
		const agents = pathList(parsed.agents, "agents", problems);
		declaredAgents.push(...(agents.length ? agents : ["agents"]));
		if (
			agents.length &&
			isDir(path.join(root, "agents")) &&
			!agents.some((a) => path.resolve(root, a) === path.join(root, "agents"))
		)
			notes.push("Manifest agents replaces the default agents/ directory; the default folder is not scanned.");
	} else {
		declaredSkills.push(...(skillsField.length ? skillsField : ["skills"]));
		if (isDir(path.join(root, "commands")) || isDir(path.join(root, "agents")))
			notes.push("commands/ and agents/ are not Codex plugin components and were not imported.");
	}
	notes.push(...problems);

	const seenSkillDirs = new Set<string>();
	const skillDirs: string[] = [];
	for (const declared of declaredSkills) {
		try {
			for (const dir of skillDirectories(root, declared))
				if (!seenSkillDirs.has(dir)) {
					seenSkillDirs.add(dir);
					skillDirs.push(dir);
				}
		} catch (error) {
			unsupported.push(`skills path ${declared}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (
		input.format === "claude-code" &&
		skillDirs.length === 0 &&
		!isDir(path.join(root, "skills")) &&
		skillsField.length === 0 &&
		isFile(path.join(root, "SKILL.md"))
	) {
		skillDirs.push(root);
		notes.push("Root SKILL.md loaded as the plugin's single skill (documented Claude Code fallback).");
	}
	// Sibling roots are separate components, never a root skill's companions.
	const siblingRoots = new Set(
		[
			".claude-plugin",
			".codex-plugin",
			"skills",
			"commands",
			"agents",
			...declaredCommands,
			...declaredAgents,
			...skillsField,
		]
			.map((entry) => entry.replace(/^\.\//u, "").split("/")[0] ?? "")
			.filter((entry) => entry && entry !== "."),
	);
	for (const dir of skillDirs) {
		const source = dir === root ? "SKILL.md" : `${relativeTo(root, dir)}/SKILL.md`;
		const fallbackName = dir === root ? rawName : path.basename(dir);
		const prefix = dir === root ? "" : `${relativeTo(root, dir)}/`;
		try {
			const resource = projectSkill({
				skillDir: dir,
				fallbackName,
				lenient: true,
				...(dir === root ? { excludeTopLevel: siblingRoots } : {}),
			});
			const omittedFiles = resource.omittedFiles.map((file) => `${prefix}${file}`);
			if (resource.requiredOmissions.length) {
				outcomes.push({
					kind: "skill",
					name: resource.name,
					source,
					status: "unsupported",
					reason: `Instructions reference omitted companions: ${resource.requiredOmissions.join(", ")}.`,
					omittedFields: resource.omittedFields,
					omittedFiles,
				});
				continue;
			}
			if (!claim(resource, "skill", source)) continue;
			Object.assign(files, resource.files);
			components.push({ kind: "skill", id: resource.id, path: resource.componentPath });
			resources.skills = "skills";
			for (const file of Object.keys(resource.files))
				projected.add(`${prefix}${file.slice(`skills/${resource.id}/`.length)}`);
			outcomes.push({
				kind: "skill",
				name: resource.name,
				source,
				status: "converted",
				id: resource.id,
				destination: resource.componentPath,
				...(resource.omittedFields.length ? { omittedFields: resource.omittedFields } : {}),
				...(omittedFiles.length ? { omittedFiles } : {}),
			});
		} catch (error) {
			outcomes.push({
				kind: "skill",
				name: fallbackName,
				source,
				status: "unsupported",
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}
	const collect = (
		declared: string[],
		kind: "agent" | "prompt",
		extensions: ReadonlyArray<string>,
		convert: (file: string, name: string) => ProjectedResource,
	): void => {
		const seen = new Set<string>();
		for (const entry of declared) {
			let found: string[];
			try {
				found = markdownFiles(root, entry, extensions);
			} catch (error) {
				unsupported.push(`${kind} path ${entry}: ${error instanceof Error ? error.message : String(error)}`);
				continue;
			}
			for (const file of found) {
				if (seen.has(file)) continue;
				seen.add(file);
				const source = relativeTo(root, file);
				const name = path.basename(file, path.extname(file));
				try {
					const resource = convert(file, name);
					if (!claim(resource, kind, source)) continue;
					Object.assign(files, resource.files);
					components.push({ kind, id: resource.id, path: resource.componentPath });
					resources[`${kind}s`] = `${kind}s`;
					projected.add(source);
					outcomes.push({
						kind,
						name: resource.name,
						source,
						status: "converted",
						id: resource.id,
						destination: resource.componentPath,
						...(resource.omittedFields.length ? { omittedFields: resource.omittedFields } : {}),
					});
				} catch (error) {
					outcomes.push({
						kind,
						name,
						source,
						status: "unsupported",
						reason: error instanceof Error ? error.message : String(error),
					});
				}
			}
		}
	};
	if (input.format === "claude-code") {
		collect(declaredCommands, "prompt", [".md"], (file, name) => projectPrompt({ file, name }));
		const convertedSkills = new Set(
			outcomes.filter((o) => o.kind === "skill" && o.status === "converted").map((o) => o.name),
		);
		collect(declaredAgents, "agent", [".md"], (file, name) => {
			const declared = projectAgent({ file, name }).bindings;
			// A bound skill that did not convert is a missing prerequisite, not a cosmetic omission.
			const bound = declared.filter((skill) => !convertedSkills.has(skill));
			if (bound.length)
				throw new Error(`Agent binds skills that were not converted: ${bound.join(", ")}; Clio cannot honor the binding.`);
			// Bindings are expressed through the real Clio schema and resolve inside this package's skill root.
			return projectAgent({ file, name, bindSkills: declared });
		});
	}
	const omitted = [
		...omittedTree,
		...Object.keys(sourceFiles).filter((file) => !projected.has(file) && file !== manifestPath),
	].sort();
	files["plugin.json"] = `${JSON.stringify(
		{
			$schema: PLUGIN_SCHEMA,
			name: id,
			version,
			description,
			...(record(parsed.author) && Object.values(parsed.author).every((v) => typeof v === "string")
				? {
						author: Object.fromEntries(
							Object.entries(parsed.author).filter(([key]) => ["name", "email", "url"].includes(key)),
						),
					}
				: {}),
			...(typeof parsed.homepage === "string" ? { homepage: parsed.homepage } : {}),
			...(typeof parsed.repository === "string" ? { repository: parsed.repository } : {}),
			...(typeof parsed.license === "string" ? { license: parsed.license } : {}),
			...(Array.isArray(parsed.keywords) && parsed.keywords.every((k) => typeof k === "string")
				? { keywords: parsed.keywords }
				: {}),
			extensions: {
				[PLUGIN_EXTENSION_KEY]: {
					manifestVersion: 1,
					...(requirements.length ? { requires: requirements } : {}),
					resources,
					components,
				},
			},
		},
		null,
		2,
	)}\n`;
	return {
		format: input.format,
		manifestPath,
		id,
		version,
		description,
		files,
		requirements,
		outcomes,
		unsupported: [...new Set(unsupported)],
		omitted: [...new Set(omitted)],
		notes,
	};
}

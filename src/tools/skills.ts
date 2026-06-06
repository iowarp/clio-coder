import { execFileSync } from "node:child_process";
import { type Dirent, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { stringify as stringifyYaml } from "yaml";
import { ToolNames } from "../core/tool-names.js";
import { clioConfigDir } from "../core/xdg.js";
import { loadSkills, modelVisibleSkills, type Skill } from "../domains/resources/index.js";
import type { ToolResult, ToolSpec } from "./registry.js";

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEFAULT_TREE_ENTRIES = 50;
const MAX_TREE_ENTRIES = 200;
const SCAFFOLD_DIRS = ["scripts", "references", "assets"] as const;

export interface SkillToolDeps {
	getCwd?: () => string;
}

function cwdFromDeps(deps?: SkillToolDeps): string {
	return deps?.getCwd?.() ?? process.cwd();
}

function validateSkillName(name: unknown): string | null {
	if (typeof name !== "string" || name.trim().length === 0) return "missing name";
	const trimmed = name.trim();
	if (trimmed.length > 64) return "name exceeds 64 characters";
	if (!SKILL_NAME_PATTERN.test(trimmed)) {
		return "name must use lowercase letters, numbers, and single hyphens";
	}
	return null;
}

function buildResourceTree(baseDir: string, maxEntries: number): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		if (out.length >= maxEntries) return;
		let entries: Dirent<string>[];
		try {
			entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
		} catch {
			return;
		}
		for (const entry of entries) {
			if (out.length >= maxEntries) return;
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const full = path.join(dir, entry.name);
			const rel = path.relative(baseDir, full).split(path.sep).join("/");
			if (entry.isDirectory()) {
				out.push(`${rel}/`);
				walk(full);
			} else if (entry.isFile()) {
				out.push(rel);
			}
		}
	};
	walk(baseDir);
	return out;
}

function renderReadSkillOutput(skill: Skill, tree: string[] | null): string {
	const lines = [
		`<skill name="${skill.name}" scope="${skill.scope}" source="${skill.source}" hash="${skill.hash}">`,
		`path: ${skill.filePath}`,
		`base_dir: ${skill.baseDir}`,
		`disable_model_invocation: ${skill.disableModelInvocation}`,
	];
	if (skill.diagnostics.length > 0) {
		lines.push(`diagnostics: ${skill.diagnostics.map((d) => d.message).join("; ")}`);
	}
	const metadataKeys = Object.keys(skill.metadata);
	if (metadataKeys.length > 0) lines.push(`metadata: ${metadataKeys.join(", ")}`);
	if (tree) {
		lines.push("resources:");
		for (const entry of tree) lines.push(`  ${entry}`);
	}
	lines.push("", skill.content, "</skill>");
	return lines.join("\n");
}

export function createReadSkillTool(deps: SkillToolDeps = {}): ToolSpec {
	return {
		name: ToolNames.ReadSkill,
		description:
			"Load the full body and metadata of an available coding skill by name. Use after matching the # Skills catalog; referenced files are relative to the returned base_dir. This never executes bundled scripts.",
		parameters: Type.Object({
			name: Type.String({ description: "Skill name from the available skills catalog." }),
			include_tree: Type.Optional(
				Type.Boolean({ description: "List sibling files under the skill base_dir. Default: false." }),
			),
			max_tree_entries: Type.Optional(
				Type.Number({ description: `Cap on listed resource entries. Default: ${DEFAULT_TREE_ENTRIES}.` }),
			),
		}),
		baseActionClass: "read",
		executionMode: "parallel",
		async run(args): Promise<ToolResult> {
			const name = typeof args.name === "string" ? args.name.trim() : "";
			if (name.length === 0) return { kind: "error", message: "read_skill: missing name" };
			const list = loadSkills({ cwd: cwdFromDeps(deps) });
			const visible = modelVisibleSkills(list.items);
			const skill = visible.find((item) => item.name === name);
			if (!skill) {
				const available = visible.map((item) => item.name).join(", ");
				const suffix = available.length > 0 ? ` Available skills: ${available}.` : " No skills are currently available.";
				return { kind: "error", message: `read_skill: unknown skill "${name}".${suffix}` };
			}
			const includeTree = args.include_tree === true;
			const maxEntries =
				typeof args.max_tree_entries === "number" && args.max_tree_entries > 0
					? Math.min(Math.floor(args.max_tree_entries), MAX_TREE_ENTRIES)
					: DEFAULT_TREE_ENTRIES;
			const tree = includeTree ? buildResourceTree(skill.baseDir, maxEntries) : null;
			const output = renderReadSkillOutput(skill, tree);
			return {
				kind: "ok",
				output,
				details: {
					name: skill.name,
					description: skill.description,
					path: skill.filePath,
					baseDir: skill.baseDir,
					hash: skill.hash,
					source: skill.source,
					scope: skill.scope,
					disableModelInvocation: skill.disableModelInvocation,
					diagnostics: skill.diagnostics.map((d) => d.message),
					metadata: skill.metadata,
					...(skill.provenance ? { provenance: skill.provenance } : {}),
					...(tree ? { tree } : {}),
				},
			};
		},
	};
}

interface FrontmatterFields {
	name: string;
	description: string;
	license?: string;
	version?: string;
	compatibility?: string;
	allowedTools?: string[];
	metadata?: Record<string, unknown>;
}

function renderSkillFile(fields: FrontmatterFields, body: string): string {
	const frontmatter: Record<string, unknown> = {
		name: fields.name,
		description: fields.description,
	};
	if (fields.license) frontmatter.license = fields.license;
	if (fields.version) frontmatter.version = fields.version;
	if (fields.compatibility) frontmatter.compatibility = fields.compatibility;
	if (fields.allowedTools && fields.allowedTools.length > 0) frontmatter["allowed-tools"] = fields.allowedTools;
	if (fields.metadata && Object.keys(fields.metadata).length > 0) frontmatter.metadata = fields.metadata;
	const yaml = stringifyYaml(frontmatter).trimEnd();
	return ["---", yaml, "---", "", body.trimEnd(), ""].join("\n");
}

function destinationIsGitignored(cwd: string, filePath: string): boolean {
	try {
		execFileSync("git", ["check-ignore", "-q", filePath], { cwd, stdio: "ignore", timeout: 2000 });
		return true;
	} catch {
		return false;
	}
}

export function createSkillTool(deps: SkillToolDeps = {}): ToolSpec {
	return {
		name: ToolNames.CreateSkill,
		description:
			"Create a new reusable coding skill as a SKILL.md folder in the project or user skill store. Use only for durable patterns worth reusing.",
		parameters: Type.Object({
			name: Type.String({ description: "Lowercase skill name using hyphens, for example review-tests." }),
			description: Type.String({ description: "One concise sentence describing when to use the skill." }),
			body: Type.String({ description: "Markdown instructions to store in SKILL.md." }),
			scope: Type.Optional(
				Type.Union([Type.Literal("project"), Type.Literal("user")], { description: "Default: project." }),
			),
			overwrite: Type.Optional(Type.Boolean({ description: "Overwrite an existing skill file. Default: false." })),
			with_scaffold: Type.Optional(
				Type.Boolean({ description: "Also create scripts/, references/, and assets/ folders. Default: false." }),
			),
			license: Type.Optional(Type.String({ description: "Optional SPDX license identifier." })),
			version: Type.Optional(Type.String({ description: "Optional skill version string." })),
			compatibility: Type.Optional(Type.String({ description: "Optional compatibility note." })),
			allowed_tools: Type.Optional(Type.Array(Type.String(), { description: "Optional allowed-tools frontmatter list." })),
			metadata: Type.Optional(
				Type.Record(Type.String(), Type.Unknown(), { description: "Optional extra frontmatter metadata." }),
			),
		}),
		baseActionClass: "write",
		executionMode: "sequential",
		async run(args): Promise<ToolResult> {
			const name = typeof args.name === "string" ? args.name.trim() : "";
			const nameError = validateSkillName(name);
			if (nameError) return { kind: "error", message: `create_skill: ${nameError}` };
			const description = typeof args.description === "string" ? args.description.trim() : "";
			if (description.length === 0) return { kind: "error", message: "create_skill: missing description" };
			if (description.length > 1024)
				return { kind: "error", message: "create_skill: description exceeds 1024 characters" };
			const body = typeof args.body === "string" ? args.body.trim() : "";
			if (body.length === 0) return { kind: "error", message: "create_skill: missing body" };

			const scope = args.scope === "user" ? "user" : "project";
			const cwd = cwdFromDeps(deps);
			const root = scope === "user" ? path.join(clioConfigDir(), "skills") : path.join(cwd, ".clio", "skills");
			const skillDir = path.join(root, name);
			const filePath = path.join(skillDir, "SKILL.md");
			const overwrite = args.overwrite === true;
			if (existsSync(filePath) && !overwrite) {
				return { kind: "error", message: `create_skill: skill already exists: ${filePath}` };
			}

			const fields: FrontmatterFields = {
				name,
				description,
				...(typeof args.license === "string" && args.license.trim().length > 0 ? { license: args.license.trim() } : {}),
				...(typeof args.version === "string" && args.version.trim().length > 0 ? { version: args.version.trim() } : {}),
				...(typeof args.compatibility === "string" && args.compatibility.trim().length > 0
					? { compatibility: args.compatibility.trim() }
					: {}),
				...(Array.isArray(args.allowed_tools)
					? { allowedTools: args.allowed_tools.filter((t): t is string => typeof t === "string") }
					: {}),
				...(args.metadata && typeof args.metadata === "object" && !Array.isArray(args.metadata)
					? { metadata: args.metadata as Record<string, unknown> }
					: {}),
			};

			mkdirSync(skillDir, { recursive: true });
			writeFileSync(filePath, renderSkillFile(fields, body), {
				encoding: "utf8",
				flag: overwrite ? "w" : "wx",
			});

			const scaffolded: string[] = [];
			if (args.with_scaffold === true) {
				for (const dir of SCAFFOLD_DIRS) {
					const target = path.join(skillDir, dir);
					mkdirSync(target, { recursive: true });
					writeFileSync(path.join(target, ".gitkeep"), "", { encoding: "utf8" });
					scaffolded.push(dir);
				}
			}

			const gitignored = destinationIsGitignored(cwd, filePath);
			const notes: string[] = [`created ${scope} skill ${name} at ${filePath}`];
			if (scaffolded.length > 0) notes.push(`scaffolded ${scaffolded.join(", ")}`);
			if (gitignored) notes.push("warning: destination is gitignored and will not be tracked");

			return {
				kind: "ok",
				output: notes.join("\n"),
				details: {
					name,
					scope,
					path: filePath,
					...(scaffolded.length > 0 ? { scaffolded } : {}),
					gitignored,
				},
			};
		},
	};
}

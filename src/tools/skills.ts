import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { stringify as stringifyYaml } from "yaml";
import { safeResourceWrite } from "../core/safe-resource-write.js";
import { ToolNames } from "../core/tool-names.js";
import { clioConfigDir } from "../core/xdg.js";
import type { LoadSkillsInput } from "../domains/resources/index.js";
import type { ToolResult, ToolSpec } from "./registry.js";
import { stringEnum } from "./string-enum.js";

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface SkillToolDeps {
	getCwd?: () => string;
	getSkillLoaderOptions?: () => Pick<
		LoadSkillsInput,
		"trustProjectCompatRoots" | "disableDiscovery" | "explicitSkillPaths"
	>;
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

interface FrontmatterFields {
	name: string;
	description: string;
	allowedTools?: string[];
	requires?: string[];
}

function renderSkillFile(fields: FrontmatterFields, body: string): string {
	const frontmatter: Record<string, unknown> = {
		name: fields.name,
		description: fields.description,
	};
	if (fields.allowedTools && fields.allowedTools.length > 0) frontmatter["allowed-tools"] = fields.allowedTools;
	if (fields.requires && fields.requires.length > 0) frontmatter.requires = fields.requires;
	const yaml = stringifyYaml(frontmatter).trimEnd();
	return ["---", yaml, "---", "", body.trimEnd(), ""].join("\n");
}

/**
 * Normalize a create_skill `requires` list to `skill:<name>` entries, the form
 * the loader's unmet-dependency diagnostics understand. Bare skill names are
 * accepted and prefixed; anything else is a validation error.
 */
function normalizeRequires(raw: unknown): { requires?: string[]; error?: string } {
	if (raw === undefined) return {};
	if (!Array.isArray(raw)) return { error: "requires must be an array of skill:<name> entries" };
	const requires: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== "string") return { error: "requires entries must be strings" };
		const trimmed = entry.trim();
		const name = trimmed.startsWith("skill:") ? trimmed.slice("skill:".length).trim() : trimmed;
		if (validateSkillName(name) !== null) {
			return { error: `invalid requires entry "${entry}"; use skill:<lowercase-hyphen-name>` };
		}
		const normalized = `skill:${name}`;
		if (!requires.includes(normalized)) requires.push(normalized);
	}
	return requires.length > 0 ? { requires } : {};
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
			"Create a reusable coding skill as a SKILL.md folder in the project or user skill store. Use only for durable patterns worth reusing.",
		parameters: Type.Object({
			name: Type.String({ description: "Lowercase hyphenated skill name, e.g. review-tests." }),
			description: Type.String({ description: "One sentence describing when to use the skill." }),
			body: Type.String({ description: "Markdown instructions for SKILL.md." }),
			scope: Type.Optional(stringEnum(["project", "user"], "Default: project.")),
			overwrite: Type.Optional(Type.Boolean({ description: "Overwrite an existing skill." })),
			allowed_tools: Type.Optional(Type.Array(Type.String(), { description: "allowed-tools frontmatter list." })),
			requires: Type.Optional(
				Type.Array(Type.String(), {
					description: "Skill dependencies as skill:<name> entries; the loader warns when one is missing.",
				}),
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

			const normalizedRequires = normalizeRequires(args.requires);
			if (normalizedRequires.error) {
				return { kind: "error", message: `create_skill: ${normalizedRequires.error}` };
			}

			const fields: FrontmatterFields = {
				name,
				description,
				...(Array.isArray(args.allowed_tools)
					? { allowedTools: args.allowed_tools.filter((t): t is string => typeof t === "string") }
					: {}),
				...(normalizedRequires.requires ? { requires: normalizedRequires.requires } : {}),
			};

			mkdirSync(skillDir, { recursive: true });
			const content = renderSkillFile(fields, body);
			if (overwrite) {
				safeResourceWrite(filePath, content, { backup: true, encoding: "utf8" });
			} else {
				writeFileSync(filePath, content, {
					encoding: "utf8",
					flag: "wx",
				});
			}

			const gitignored = destinationIsGitignored(cwd, filePath);
			const notes: string[] = [`created ${scope} skill ${name} at ${filePath}`];
			if (gitignored) notes.push("warning: destination is gitignored and will not be tracked");

			return {
				kind: "ok",
				output: notes.join("\n"),
				details: {
					name,
					scope,
					path: filePath,
					gitignored,
				},
			};
		},
	};
}

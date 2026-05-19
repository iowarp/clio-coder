import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import { clioConfigDir } from "../core/xdg.js";
import { loadSkills } from "../domains/resources/index.js";
import type { ToolResult, ToolSpec } from "./registry.js";

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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

function quoteYamlString(value: string): string {
	return JSON.stringify(value);
}

function renderSkillFile(name: string, description: string, body: string): string {
	const normalizedBody = body.trimEnd();
	return [
		"---",
		`name: ${quoteYamlString(name)}`,
		`description: ${quoteYamlString(description)}`,
		"---",
		"",
		normalizedBody,
		"",
	].join("\n");
}

export function createReadSkillTool(deps: SkillToolDeps = {}): ToolSpec {
	return {
		name: ToolNames.ReadSkill,
		description:
			"Load the full body of an available coding skill by name. Use after matching the # Skills catalog; referenced files are relative to the returned base_dir.",
		parameters: Type.Object({
			name: Type.String({ description: "Skill name from the available skills catalog." }),
		}),
		baseActionClass: "read",
		executionMode: "parallel",
		async run(args): Promise<ToolResult> {
			const name = typeof args.name === "string" ? args.name.trim() : "";
			if (name.length === 0) return { kind: "error", message: "read_skill: missing name" };
			const list = loadSkills({ cwd: cwdFromDeps(deps) });
			const skill = list.items.find((item) => item.name === name);
			if (!skill) {
				const available = list.items.map((item) => item.name).join(", ");
				const suffix = available.length > 0 ? ` Available skills: ${available}.` : " No skills are currently available.";
				return { kind: "error", message: `read_skill: unknown skill "${name}".${suffix}` };
			}
			const output = [
				`<skill name="${skill.name}" scope="${skill.sourceInfo.scope}">`,
				`path: ${skill.filePath}`,
				`base_dir: ${skill.baseDir}`,
				"",
				skill.content,
				"</skill>",
			].join("\n");
			return { kind: "ok", output, details: { path: skill.filePath, baseDir: skill.baseDir } };
		},
	};
}

export function createSkillTool(deps: SkillToolDeps = {}): ToolSpec {
	return {
		name: ToolNames.CreateSkill,
		description:
			"Create a new reusable coding skill as SKILL.md in the project or user skill store. Use only for durable patterns worth reusing.",
		parameters: Type.Object({
			name: Type.String({ description: "Lowercase skill name using hyphens, for example review-tests." }),
			description: Type.String({ description: "One concise sentence describing when to use the skill." }),
			body: Type.String({ description: "Markdown instructions to store in SKILL.md." }),
			scope: Type.Optional(
				Type.Union([Type.Literal("project"), Type.Literal("user")], { description: "Default: project." }),
			),
			overwrite: Type.Optional(Type.Boolean({ description: "Overwrite an existing skill file. Default: false." })),
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
			const root =
				scope === "user" ? path.join(clioConfigDir(), "skills") : path.join(cwdFromDeps(deps), ".clio", "skills");
			const skillDir = path.join(root, name);
			const filePath = path.join(skillDir, "SKILL.md");
			const overwrite = args.overwrite === true;
			if (existsSync(filePath) && !overwrite) {
				return { kind: "error", message: `create_skill: skill already exists: ${filePath}` };
			}
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(filePath, renderSkillFile(name, description, body), {
				encoding: "utf8",
				flag: overwrite ? "w" : "wx",
			});
			return {
				kind: "ok",
				output: `created ${scope} skill ${name} at ${filePath}`,
				details: { name, scope, path: filePath },
			};
		},
	};
}

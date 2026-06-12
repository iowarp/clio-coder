import { execFileSync } from "node:child_process";
import { type Dirent, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { stringify as stringifyYaml } from "yaml";
import { safeResourceWrite } from "../core/safe-resource-write.js";
import { ToolNames } from "../core/tool-names.js";
import { clioConfigDir } from "../core/xdg.js";
import {
	checkSkillDrift,
	type LoadSkillsInput,
	loadSkills,
	modelVisibleSkills,
	type Skill,
} from "../domains/resources/index.js";
import type { ToolInvokeOptions, ToolResult, ToolSpec } from "./registry.js";
import { stringEnum } from "./string-enum.js";

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEFAULT_TREE_ENTRIES = 50;

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

function skillSourceOrigin(skill: Skill): string {
	return skill.sourceInfo.source ?? `${skill.source}-${skill.scope}`;
}

function renderReadSkillOutput(skill: Skill, tree: string[] | null): string {
	const sourceOrigin = skillSourceOrigin(skill);
	const lines = [
		`<skill name="${skill.name}" scope="${skill.scope}" source="${skill.source}" origin="${sourceOrigin}" hash="${skill.hash}">`,
		`path: ${skill.filePath}`,
		`base_dir: ${skill.baseDir}`,
		`source_origin: ${sourceOrigin}`,
		`disable_model_invocation: ${skill.disableModelInvocation}`,
	];
	if (skill.allowedTools) lines.push(`allowed_tools: ${skill.allowedTools.join(", ")}`);
	if (skill.disallowedTools) lines.push(`disallowed_tools: ${skill.disallowedTools.join(", ")}`);
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

function policyIsRecipeBound(policy: { requests: ReadonlyArray<{ source: string }> }): boolean {
	return policy.requests.length > 0 && policy.requests.every((request) => request.source === "recipe");
}

function pendingSkillPolicyError(name: string, options: ToolInvokeOptions | undefined): string | null {
	const policy = options?.pendingSkillPolicy;
	if (!policy) {
		return "read_skill: no pending skill request is active this turn. Skills can only be loaded after an explicit /skill:<name> task, /skill <name> task, or selector choice.";
	}
	const allowed = [...new Set(policy.allowedSkillNames.map((entry) => entry.trim()).filter(Boolean))];
	if (allowed.length === 0) {
		return "read_skill: no pending skill request is active this turn. Skills can only be loaded after an explicit /skill:<name> task, /skill <name> task, or selector choice.";
	}
	const recipeBound = policyIsRecipeBound(policy);
	if (!allowed.includes(name)) {
		return recipeBound
			? `read_skill: this agent run may load only its declared skill(s): ${allowed.join(", ")}.`
			: `read_skill: this turn has pending skill request(s): ${allowed.join(", ")}. Load only those before doing anything else.`;
	}
	if (policy.loadedSkillNames.has(name)) {
		return recipeBound
			? `read_skill: skill ${name} is already loaded in this run; continue with its workflow.`
			: `read_skill: pending skill ${name} already loaded this turn; continue with the loaded workflow and call ask_user if an interview/choice is needed.`;
	}
	return null;
}

function pendingSkillRequestFor(name: string, options: ToolInvokeOptions | undefined) {
	return options?.pendingSkillPolicy?.requests.find((request) => request.name === name) ?? null;
}

function renderPendingSkillTask(name: string, options: ToolInvokeOptions | undefined): string[] {
	const request = pendingSkillRequestFor(name, options);
	if (!request) return [];
	// Recipe-bound loads carry no user task; the worker already has its assignment.
	if (request.source === "recipe") return [];
	const task = request.args.trim();
	const lines = [
		"Pending skill request",
		`name: ${request.name}`,
		`source: ${request.source}`,
		`task: ${task.length > 0 ? task : "(none supplied)"}`,
	];
	if (task.length > 0) {
		lines.push(
			"",
			"Treat task as the user's starting subject for this skill workflow. Do not ask what the subject is again; ask_user only for missing follow-up decisions.",
		);
	}
	lines.push("");
	return lines;
}

function renderSkillsList(skills: ReadonlyArray<Skill>): string {
	if (skills.length === 0) return "No skills are installed.";
	const lines = [
		"Available skills. Skill bodies load only after an explicit operator request; when one fits the task, suggest the operator run /skill <name>.",
		"",
	];
	for (const skill of skills) {
		lines.push(`- ${skill.name} (${skill.scope}): ${skill.description}`);
	}
	return lines.join("\n");
}

export function createReadSkillTool(deps: SkillToolDeps = {}): ToolSpec {
	return {
		name: ToolNames.ReadSkill,
		description:
			"List available coding skills (call with no name) or load a requested skill's body by name. This never executes bundled scripts.",
		parameters: Type.Object({
			name: Type.Optional(Type.String({ description: "Skill name to load. Omit to list available skills." })),
			include_tree: Type.Optional(Type.Boolean({ description: "Also list files under the skill base_dir." })),
		}),
		baseActionClass: "read",
		executionMode: "parallel",
		async run(args, options): Promise<ToolResult> {
			const name = typeof args.name === "string" ? args.name.trim() : "";
			if (name.length === 0) {
				const list = loadSkills({ cwd: cwdFromDeps(deps), ...(deps.getSkillLoaderOptions?.() ?? {}) });
				const visible = modelVisibleSkills(list.items);
				return {
					kind: "ok",
					output: renderSkillsList(visible),
					details: { skills: visible.map((skill) => ({ name: skill.name, scope: skill.scope })) },
				};
			}
			const policyError = pendingSkillPolicyError(name, options);
			if (policyError) return { kind: "error", message: policyError };
			const list = loadSkills({ cwd: cwdFromDeps(deps), ...(deps.getSkillLoaderOptions?.() ?? {}) });
			const visible = modelVisibleSkills(list.items);
			const skill = visible.find((item) => item.name === name);
			if (!skill) {
				const available = visible.map((item) => item.name).join(", ");
				const suffix = available.length > 0 ? ` Available skills: ${available}.` : " No skills are currently available.";
				return { kind: "error", message: `read_skill: unknown skill "${name}".${suffix}` };
			}
			const includeTree = args.include_tree === true;
			const tree = includeTree ? buildResourceTree(skill.baseDir, DEFAULT_TREE_ENTRIES) : null;
			const pendingRequest = pendingSkillRequestFor(name, options);
			const pendingTask = pendingRequest?.args.trim() ?? "";
			// Provenance pinning: marketplace-installed skills (registry-id
			// frontmatter) are compared against the local pinned manifest. A
			// mismatch annotates the result and is recorded with the
			// activation; it never blocks, the normal tool safety gates still
			// govern whatever the skill asks for.
			const drift = skill.provenance?.registryId ? checkSkillDrift(skill, cwdFromDeps(deps)) : null;
			const driftWarning =
				drift === "mismatch"
					? `WARNING skill_drift: '${skill.name}' content (sha256 ${skill.hash.slice(0, 12)}…) no longer matches its pinned marketplace hash; the installed skill drifted from its audited content.`
					: null;
			const output = [
				...(driftWarning !== null ? [driftWarning] : []),
				...renderPendingSkillTask(name, options),
				renderReadSkillOutput(skill, tree),
			].join("\n");
			const pendingPolicy = options?.pendingSkillPolicy;
			if (pendingPolicy) {
				pendingPolicy.loadedSkillNames.add(name);
				pendingPolicy.loadedSkillPolicies.set(name, {
					...(skill.allowedTools ? { allowedTools: skill.allowedTools } : {}),
					...(skill.disallowedTools ? { disallowedTools: skill.disallowedTools } : {}),
				});
			}
			return {
				kind: "ok",
				output,
				details: {
					name: skill.name,
					description: skill.description,
					...(pendingTask.length > 0 ? { pendingTask } : {}),
					path: skill.filePath,
					baseDir: skill.baseDir,
					hash: skill.hash,
					source: skill.source,
					sourceOrigin: skillSourceOrigin(skill),
					sourceInfo: skill.sourceInfo,
					scope: skill.scope,
					disableModelInvocation: skill.disableModelInvocation,
					...(skill.allowedTools ? { allowedTools: skill.allowedTools } : {}),
					...(skill.disallowedTools ? { disallowedTools: skill.disallowedTools } : {}),
					diagnostics: skill.diagnostics.map((d) => d.message),
					metadata: skill.metadata,
					...(skill.provenance ? { provenance: skill.provenance } : {}),
					...(drift !== null ? { drift } : {}),
					...(tree ? { tree } : {}),
				},
			};
		},
	};
}

interface FrontmatterFields {
	name: string;
	description: string;
	allowedTools?: string[];
}

function renderSkillFile(fields: FrontmatterFields, body: string): string {
	const frontmatter: Record<string, unknown> = {
		name: fields.name,
		description: fields.description,
	};
	if (fields.allowedTools && fields.allowedTools.length > 0) frontmatter["allowed-tools"] = fields.allowedTools;
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
			"Create a reusable coding skill as a SKILL.md folder in the project or user skill store. Use only for durable patterns worth reusing.",
		parameters: Type.Object({
			name: Type.String({ description: "Lowercase hyphenated skill name, e.g. review-tests." }),
			description: Type.String({ description: "One sentence describing when to use the skill." }),
			body: Type.String({ description: "Markdown instructions for SKILL.md." }),
			scope: Type.Optional(stringEnum(["project", "user"], "Default: project.")),
			overwrite: Type.Optional(Type.Boolean({ description: "Overwrite an existing skill." })),
			allowed_tools: Type.Optional(Type.Array(Type.String(), { description: "allowed-tools frontmatter list." })),
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
				...(Array.isArray(args.allowed_tools)
					? { allowedTools: args.allowed_tools.filter((t): t is string => typeof t === "string") }
					: {}),
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

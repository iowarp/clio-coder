import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { stringify as stringifyYaml } from "yaml";
import { safeResourceWrite } from "../core/safe-resource-write.js";
import { ToolNames } from "../core/tool-names.js";
import { clioConfigDir } from "../core/xdg.js";
import { withFileMutationQueue } from "./file-mutation-queue.js";
import { resolveToCwd } from "./path-utils.js";
import type { ToolResult, ToolSpec } from "./registry.js";
import { stringEnum } from "./string-enum.js";

/**
 * The artifact tool: terminal document writers and the skill store behind one
 * surface. kind=plan|review|report writes a Markdown artifact (default
 * PLAN.md / REVIEW.md / REPORT.md at the project root) and terminates the
 * turn: writing the artifact IS the answer, so pi-agent-core skips the
 * follow-up LLM call that would only summarize it. kind=skill creates a
 * SKILL.md folder in the project or user skill store with validated
 * frontmatter; it is not terminal.
 */

const ARTIFACT_KINDS = ["plan", "review", "report", "skill"] as const;
type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

const TERMINAL_KIND_PATHS: Record<Exclude<ArtifactKind, "skill">, string> = {
	plan: "PLAN.md",
	review: "REVIEW.md",
	report: "REPORT.md",
};

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface ArtifactToolDeps {
	getCwd?: () => string;
}

function cwdFromDeps(deps?: ArtifactToolDeps): string {
	return deps?.getCwd?.() ?? process.cwd();
}

function validateSkillName(name: unknown): string | null {
	if (typeof name !== "string" || name.trim().length === 0) return "missing skill name";
	const trimmed = name.trim();
	if (trimmed.length > 64) return "skill name exceeds 64 characters";
	if (!SKILL_NAME_PATTERN.test(trimmed)) {
		return "skill name must use lowercase letters, numbers, and single hyphens";
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
 * Normalize a skill `requires` list to `skill:<name>` entries, the form the
 * loader's unmet-dependency diagnostics understand. Bare skill names are
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

function insideWorkspace(target: string, cwd: string): boolean {
	const rel = path.relative(path.resolve(cwd), target);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function writeTerminalArtifact(
	kind: Exclude<ArtifactKind, "skill">,
	args: Record<string, unknown>,
	cwd: string,
): Promise<ToolResult> {
	const content = typeof args.content === "string" ? args.content : "";
	if (content.length === 0) return { kind: "error", message: `artifact: kind=${kind} requires non-empty content` };
	const rawPath =
		typeof args.path === "string" && args.path.trim().length > 0 ? args.path.trim() : TERMINAL_KIND_PATHS[kind];
	const target = resolveToCwd(rawPath, cwd);
	if (!insideWorkspace(target, cwd)) {
		return { kind: "error", message: `artifact: path escapes workspace root: ${target}` };
	}
	const title = typeof args.title === "string" ? args.title.trim() : "";
	const body = title.length > 0 && !content.trimStart().startsWith("#") ? `# ${title}\n\n${content}` : content;
	try {
		await withFileMutationQueue(target, async () => {
			mkdirSync(path.dirname(target), { recursive: true });
			writeFileSync(target, body, "utf8");
		});
	} catch (err) {
		return { kind: "error", message: `artifact: ${err instanceof Error ? err.message : String(err)}` };
	}
	const rel = path.relative(cwd, target) || rawPath;
	return {
		kind: "ok",
		output: `wrote ${kind} artifact (${Buffer.byteLength(body, "utf8")}B) to ${rel}`,
		details: { kind, paths: [target] },
		// Writing the artifact is the whole turn; terminate skips the follow-up
		// LLM call that would only restate what was just written.
		terminate: true,
	};
}

async function writeSkillArtifact(args: Record<string, unknown>, cwd: string): Promise<ToolResult> {
	const name = typeof args.title === "string" ? args.title.trim() : "";
	const nameError = validateSkillName(name.length > 0 ? name : undefined);
	if (nameError) return { kind: "error", message: `artifact: kind=skill uses title as the skill name; ${nameError}` };
	const description = typeof args.description === "string" ? args.description.trim() : "";
	if (description.length === 0) return { kind: "error", message: "artifact: kind=skill requires description" };
	if (description.length > 1024) return { kind: "error", message: "artifact: description exceeds 1024 characters" };
	const body = typeof args.content === "string" ? args.content.trim() : "";
	if (body.length === 0) return { kind: "error", message: "artifact: kind=skill requires non-empty content" };

	const scope = args.scope === "user" ? "user" : "project";
	const root = scope === "user" ? path.join(clioConfigDir(), "skills") : path.join(cwd, ".clio", "skills");
	const skillDir = path.join(root, name);
	const filePath = path.join(skillDir, "SKILL.md");
	const overwrite = args.overwrite === true;
	if (existsSync(filePath) && !overwrite) {
		return { kind: "error", message: `artifact: skill already exists: ${filePath} (pass overwrite=true to replace)` };
	}

	const normalizedRequires = normalizeRequires(args.requires);
	if (normalizedRequires.error) {
		return { kind: "error", message: `artifact: ${normalizedRequires.error}` };
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
		writeFileSync(filePath, content, { encoding: "utf8", flag: "wx" });
	}

	const gitignored = destinationIsGitignored(cwd, filePath);
	const notes: string[] = [`created ${scope} skill ${name} at ${filePath}`];
	if (gitignored) notes.push("warning: destination is gitignored and will not be tracked");

	return {
		kind: "ok",
		output: notes.join("\n"),
		details: { kind: "skill", name, scope, path: filePath, gitignored, paths: [filePath] },
	};
}

/** Tolerate weak-model shapes: allowed_tools / requires sent as JSON strings. */
export function prepareArtifactArguments(args: Record<string, unknown>): Record<string, unknown> {
	if (!args || typeof args !== "object" || Array.isArray(args)) return args;
	const next: Record<string, unknown> = { ...args };
	for (const key of ["allowed_tools", "requires"] as const) {
		if (typeof next[key] !== "string") continue;
		try {
			const parsed = JSON.parse(next[key] as string) as unknown;
			if (Array.isArray(parsed)) next[key] = parsed;
		} catch {
			// Leave the malformed string; run() reports the shape error.
		}
	}
	return next;
}

export function createArtifactTool(deps: ArtifactToolDeps = {}): ToolSpec {
	return {
		name: ToolNames.Artifact,
		description:
			"Write a named artifact: kind=plan|review|report writes a terminal Markdown document (default PLAN.md/REVIEW.md/REPORT.md) and completes the turn; kind=skill creates a reusable SKILL.md (title is the skill name, description required).",
		parameters: Type.Object({
			kind: stringEnum(ARTIFACT_KINDS, "Artifact kind."),
			content: Type.String({ description: "Full Markdown body." }),
			title: Type.Optional(Type.String({ description: "Document title, or the skill name for kind=skill." })),
			path: Type.Optional(Type.String({ description: "Override the default artifact path (plan/review/report)." })),
			description: Type.Optional(Type.String({ description: "kind=skill: one sentence describing when to use it." })),
			scope: Type.Optional(stringEnum(["project", "user"], "kind=skill: store scope (default project).")),
			overwrite: Type.Optional(Type.Boolean({ description: "kind=skill: overwrite an existing skill." })),
			allowed_tools: Type.Optional(Type.Array(Type.String(), { description: "kind=skill: allowed-tools frontmatter." })),
			requires: Type.Optional(
				Type.Array(Type.String(), { description: "kind=skill: dependencies as skill:<name> entries." }),
			),
		}),
		baseActionClass: "write",
		executionMode: "sequential",
		prepareArguments: prepareArtifactArguments,
		async run(rawArgs): Promise<ToolResult> {
			const args = prepareArtifactArguments(rawArgs);
			const kind = typeof args.kind === "string" ? args.kind : "";
			if (!(ARTIFACT_KINDS as ReadonlyArray<string>).includes(kind)) {
				return { kind: "error", message: `artifact: kind must be plan, review, report, or skill; got '${kind}'` };
			}
			const cwd = cwdFromDeps(deps);
			if (kind === "skill") return writeSkillArtifact(args, cwd);
			return writeTerminalArtifact(kind as Exclude<ArtifactKind, "skill">, args, cwd);
		},
	};
}

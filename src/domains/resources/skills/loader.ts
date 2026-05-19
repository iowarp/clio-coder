import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
	type ResourceCandidate,
	type ResourceDiagnostic,
	type ResourceScope,
	type ResourceSourceInfo,
	resolveResourceCollisions,
} from "../collision.js";
import {
	defaultScopedResourceRoots,
	readRootEntries,
	sourceInfoForRoot,
	splitYamlFrontmatter,
	stringField,
} from "../common-loader.js";

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

export interface Skill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	content: string;
	sourceInfo: ResourceSourceInfo;
	disableModelInvocation: boolean;
}

export interface SkillRoot {
	path: string;
	scope: ResourceScope;
	source?: string;
}

export interface SkillList {
	items: Skill[];
	diagnostics: ResourceDiagnostic[];
}

export interface LoadSkillsInput {
	cwd?: string;
	roots?: ReadonlyArray<SkillRoot>;
}

export type SkillExpansion =
	| {
			expanded: false;
			text: string;
			args: string;
			diagnostics: ResourceDiagnostic[];
	  }
	| {
			expanded: true;
			text: string;
			args: string;
			skill: Skill;
			diagnostics: ResourceDiagnostic[];
	  };

function defaultSkillRoots(cwd: string): SkillRoot[] {
	return defaultScopedResourceRoots("skills", cwd);
}

function splitSkillFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
	const split = splitYamlFrontmatter(raw);
	if (!split.ok && split.reason === "missing") {
		throw new Error("skill file is missing YAML frontmatter");
	}
	if (!split.ok && split.reason === "missing closing delimiter") {
		throw new Error("skill file is missing a closing YAML frontmatter delimiter");
	}
	if (!split.ok && split.reason === "must be a YAML object") {
		throw new Error("skill frontmatter must be a YAML object");
	}
	if (!split.ok) throw new Error(`skill frontmatter is ${split.reason}`);
	return split;
}

function booleanField(frontmatter: Record<string, unknown>, key: string): boolean {
	return frontmatter[key] === true;
}

function validationSubject(filePath: string): string {
	return path.basename(filePath) === "SKILL.md" ? path.basename(path.dirname(filePath)) : path.basename(filePath, ".md");
}

function validateSkillName(name: string, expectedName: string): string[] {
	const errors: string[] = [];
	if (name !== expectedName) errors.push(`name "${name}" does not match skill path "${expectedName}"`);
	if (name.length > MAX_NAME_LENGTH) errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
	if (!/^[a-z0-9-]+$/.test(name)) {
		errors.push("name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)");
	}
	if (name.startsWith("-") || name.endsWith("-")) errors.push("name must not start or end with a hyphen");
	if (name.includes("--")) errors.push("name must not contain consecutive hyphens");
	return errors;
}

function validateDescription(description: string | null): string[] {
	if (!description) return ["description is required"];
	if (description.length > MAX_DESCRIPTION_LENGTH) {
		return [`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`];
	}
	return [];
}

function loadSkillFile(
	filePath: string,
	root: SkillRoot,
): { candidate: ResourceCandidate<Skill> | null; diagnostics: ResourceDiagnostic[] } {
	const diagnostics: ResourceDiagnostic[] = [];
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return {
			candidate: null,
			diagnostics: [{ type: "warning", message: `skill file could not be read: ${reason}`, path: filePath }],
		};
	}

	let parsed: { frontmatter: Record<string, unknown>; body: string };
	try {
		parsed = splitSkillFrontmatter(raw);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return { candidate: null, diagnostics: [{ type: "warning", message: reason, path: filePath }] };
	}

	const expectedName = validationSubject(filePath);
	const name = stringField(parsed.frontmatter, "name") ?? expectedName;
	const description = stringField(parsed.frontmatter, "description");
	for (const message of validateDescription(description)) diagnostics.push({ type: "warning", message, path: filePath });
	for (const message of validateSkillName(name, expectedName))
		diagnostics.push({ type: "warning", message, path: filePath });
	if (!description) return { candidate: null, diagnostics };

	const baseDir = path.dirname(filePath);
	const sourceInfo: ResourceSourceInfo = sourceInfoForRoot(root, filePath);
	const skill: Skill = {
		name,
		description,
		filePath,
		baseDir,
		content: parsed.body.trim(),
		sourceInfo,
		disableModelInvocation: booleanField(parsed.frontmatter, "disable-model-invocation"),
	};
	return { candidate: { name, value: skill, source: sourceInfo }, diagnostics };
}

function isSkillMarkdownFile(entryName: string): boolean {
	return entryName === "SKILL.md" || entryName.endsWith(".md");
}

function collectSkills(
	root: SkillRoot,
	dir: string,
	diagnostics: ResourceDiagnostic[],
	includeRootFiles: boolean,
): ResourceCandidate<Skill>[] {
	if (!existsSync(dir)) return [];
	let entries: Dirent<string>[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		diagnostics.push({ type: "warning", message: `skill root could not be read: ${reason}`, path: dir });
		return [];
	}

	const skillEntry = entries.find((entry) => entry.name === "SKILL.md" && entry.isFile());
	if (skillEntry) {
		const loaded = loadSkillFile(path.join(dir, skillEntry.name), root);
		diagnostics.push(...loaded.diagnostics);
		return loaded.candidate ? [loaded.candidate] : [];
	}

	const candidates: ResourceCandidate<Skill>[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			candidates.push(...collectSkills(root, fullPath, diagnostics, false));
			continue;
		}
		if (!includeRootFiles || !entry.isFile() || !isSkillMarkdownFile(entry.name)) continue;
		const loaded = loadSkillFile(fullPath, root);
		diagnostics.push(...loaded.diagnostics);
		if (loaded.candidate) candidates.push(loaded.candidate);
	}
	return candidates;
}

function loadSkillRoot(root: SkillRoot, diagnostics: ResourceDiagnostic[]): ResourceCandidate<Skill>[] {
	const entries = readRootEntries(root, "skill", diagnostics);
	if (entries.length === 0) return [];
	return collectSkills(root, root.path, diagnostics, true);
}

export function loadSkills(input: LoadSkillsInput = {}): SkillList {
	const cwd = input.cwd ?? process.cwd();
	const roots = input.roots ?? defaultSkillRoots(cwd);
	const diagnostics: ResourceDiagnostic[] = [];
	const candidates = roots.flatMap((root) => loadSkillRoot(root, diagnostics));
	const resolved = resolveResourceCollisions(candidates);
	return {
		items: [...resolved.winners].sort((a, b) => a.name.localeCompare(b.name)),
		diagnostics: [...diagnostics, ...resolved.diagnostics],
	};
}

function escapeXmlAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeXmlText(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatSkillsCatalogForPrompt(skills: SkillList): string {
	const visible = skills.items.filter((skill) => !skill.disableModelInvocation);
	if (visible.length === 0) return "";
	const lines = [
		"# Skills",
		"",
		"Use skills when their descriptions match the task. This catalog intentionally includes only names and descriptions; call read_skill to load the full SKILL.md body and resolve any referenced files relative to that skill's base directory.",
		"",
		"<available_skills>",
	];
	for (const skill of visible) {
		lines.push(
			`  <skill name="${escapeXmlAttribute(skill.name)}" scope="${escapeXmlAttribute(skill.sourceInfo.scope)}">`,
		);
		lines.push(`    <description>${escapeXmlText(skill.description)}</description>`);
		lines.push("  </skill>");
	}
	lines.push("</available_skills>");
	return lines.join("\n");
}

function parseSkillCommand(input: string): { name: string; args: string } | null {
	const trimmed = input.trim();
	if (!trimmed.startsWith("/skill:")) return null;
	const rest = trimmed.slice("/skill:".length);
	const separator = rest.search(/\s/);
	const name = separator === -1 ? rest : rest.slice(0, separator);
	if (name.length === 0) return null;
	const args = separator === -1 ? "" : rest.slice(separator).trim();
	return { name, args };
}

export function expandSkillInvocationInput(input: string, skills: SkillList): SkillExpansion {
	const command = parseSkillCommand(input);
	if (!command) return { expanded: false, text: input, args: "", diagnostics: skills.diagnostics };
	const skill = skills.items.find((entry) => entry.name === command.name);
	if (!skill) return { expanded: false, text: input, args: command.args, diagnostics: skills.diagnostics };
	const block = [
		`<skill name="${escapeXmlAttribute(skill.name)}" location="${escapeXmlAttribute(skill.filePath)}">`,
		`References are relative to ${skill.baseDir}.`,
		"",
		skill.content,
		"</skill>",
	].join("\n");
	return {
		expanded: true,
		text: command.args.length > 0 ? `${block}\n\n${command.args}` : block,
		args: command.args,
		skill,
		diagnostics: skills.diagnostics,
	};
}

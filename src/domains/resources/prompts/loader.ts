import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { clioConfigDir } from "../../../core/xdg.js";
import {
	type ResourceCandidate,
	type ResourceDiagnostic,
	type ResourceScope,
	type ResourceSourceInfo,
	resolveResourceCollisions,
} from "../collision.js";
import { parseCommandArgs, substituteArgs } from "./substitute.js";

export interface PromptTemplate {
	name: string;
	description: string;
	content: string;
	filePath: string;
	sourceInfo: ResourceSourceInfo;
	argumentHint?: string;
}

export interface PromptTemplateRoot {
	path: string;
	scope: ResourceScope;
	source?: string;
}

export interface PromptTemplateList {
	items: PromptTemplate[];
	diagnostics: ResourceDiagnostic[];
}

export interface LoadPromptTemplatesInput {
	cwd?: string;
	roots?: ReadonlyArray<PromptTemplateRoot>;
}

export type PromptTemplateExpansion =
	| {
			expanded: false;
			text: string;
			args: string[];
			diagnostics: ResourceDiagnostic[];
	  }
	| {
			expanded: true;
			text: string;
			args: string[];
			template: PromptTemplate;
			diagnostics: ResourceDiagnostic[];
	  };

interface ParsedPromptFrontmatter {
	frontmatter: Record<string, unknown>;
	body: string;
}

function defaultPromptTemplateRoots(cwd: string): PromptTemplateRoot[] {
	return [
		{ path: path.join(clioConfigDir(), "prompts"), scope: "user", source: "config" },
		{ path: path.join(cwd, ".clio", "prompts"), scope: "project", source: "project" },
	];
}

function splitOptionalFrontmatter(
	raw: string,
	filePath: string,
	diagnostics: ResourceDiagnostic[],
): ParsedPromptFrontmatter {
	const opening = raw.match(/^---\r?\n/);
	if (!opening) return { frontmatter: {}, body: raw };

	const closeRegex = /\r?\n---(?:\r?\n|$)/g;
	closeRegex.lastIndex = opening[0].length;
	const closing = closeRegex.exec(raw);
	if (!closing) {
		diagnostics.push({
			type: "warning",
			message: "prompt template frontmatter is missing a closing delimiter; treating the file as plain markdown",
			path: filePath,
		});
		return { frontmatter: {}, body: raw };
	}

	const frontmatterText = raw.slice(opening[0].length, closing.index);
	let parsed: unknown;
	try {
		parsed = parseYaml(frontmatterText);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		diagnostics.push({
			type: "warning",
			message: `prompt template frontmatter is invalid YAML: ${reason}`,
			path: filePath,
		});
		return { frontmatter: {}, body: raw.slice(closing.index + closing[0].length) };
	}

	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		diagnostics.push({
			type: "warning",
			message: "prompt template frontmatter must be a YAML object",
			path: filePath,
		});
		return { frontmatter: {}, body: raw.slice(closing.index + closing[0].length) };
	}

	return {
		frontmatter: parsed as Record<string, unknown>,
		body: raw.slice(closing.index + closing[0].length),
	};
}

function fallbackDescription(body: string): string {
	const line = body
		.split(/\r?\n/)
		.map((entry) => entry.trim())
		.find((entry) => entry.length > 0);
	if (!line) return "Prompt template";
	const normalized = line.replace(/^#{1,6}\s+/, "");
	return normalized.length > 60 ? `${normalized.slice(0, 57)}...` : normalized;
}

function stringField(frontmatter: Record<string, unknown>, key: string): string | null {
	const value = frontmatter[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function loadPromptFile(
	filePath: string,
	root: PromptTemplateRoot,
	diagnostics: ResourceDiagnostic[],
): ResourceCandidate<PromptTemplate> | null {
	const ext = path.extname(filePath).toLowerCase();
	if (ext !== ".md") return null;
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		diagnostics.push({ type: "warning", message: `prompt template could not be read: ${reason}`, path: filePath });
		return null;
	}

	const name = path.basename(filePath, ext);
	if (name.trim().length === 0) return null;
	const { frontmatter, body } = splitOptionalFrontmatter(raw, filePath, diagnostics);
	const description = stringField(frontmatter, "description") ?? fallbackDescription(body);
	const argumentHint = stringField(frontmatter, "argument-hint") ?? stringField(frontmatter, "argumentHint");
	const sourceInfo: ResourceSourceInfo = {
		path: filePath,
		scope: root.scope,
		...(root.source ? { source: root.source } : {}),
	};
	const template: PromptTemplate = {
		name,
		description,
		content: body.trim(),
		filePath,
		sourceInfo,
	};
	if (argumentHint) template.argumentHint = argumentHint;
	return { name, value: template, source: sourceInfo };
}

function loadPromptRoot(
	root: PromptTemplateRoot,
	diagnostics: ResourceDiagnostic[],
): ResourceCandidate<PromptTemplate>[] {
	if (!existsSync(root.path)) return [];
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(root.path);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		diagnostics.push({
			type: "warning",
			message: `prompt template root could not be stat'ed: ${reason}`,
			path: root.path,
		});
		return [];
	}
	if (!stat.isDirectory()) {
		diagnostics.push({ type: "warning", message: "prompt template root is not a directory", path: root.path });
		return [];
	}

	let entries: Dirent<string>[];
	try {
		entries = readdirSync(root.path, { withFileTypes: true });
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		diagnostics.push({ type: "warning", message: `prompt template root could not be read: ${reason}`, path: root.path });
		return [];
	}

	const candidates: ResourceCandidate<PromptTemplate>[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isFile()) continue;
		const candidate = loadPromptFile(path.join(root.path, entry.name), root, diagnostics);
		if (candidate) candidates.push(candidate);
	}
	return candidates;
}

export function loadPromptTemplates(input: LoadPromptTemplatesInput = {}): PromptTemplateList {
	const cwd = input.cwd ?? process.cwd();
	const roots = input.roots ?? defaultPromptTemplateRoots(cwd);
	const diagnostics: ResourceDiagnostic[] = [];
	const candidates = roots.flatMap((root) => loadPromptRoot(root, diagnostics));
	const resolved = resolveResourceCollisions(candidates);
	return {
		items: [...resolved.winners].sort((a, b) => a.name.localeCompare(b.name)),
		diagnostics: [...diagnostics, ...resolved.diagnostics],
	};
}

function parsePromptCommand(input: string): { name: string; rest: string } | null {
	const trimmed = input.trim();
	if (!trimmed.startsWith("/")) return null;
	const withoutSlash = trimmed.slice(1);
	const separator = withoutSlash.search(/\s/);
	const name = separator === -1 ? withoutSlash : withoutSlash.slice(0, separator);
	if (name.length === 0 || name.includes("/")) return null;
	const rest = separator === -1 ? "" : withoutSlash.slice(separator).trim();
	return { name, rest };
}

export function expandPromptTemplateInput(input: string, templates: PromptTemplateList): PromptTemplateExpansion {
	const command = parsePromptCommand(input);
	if (!command) return { expanded: false, text: input, args: [], diagnostics: templates.diagnostics };
	const template = templates.items.find((entry) => entry.name === command.name);
	if (!template) return { expanded: false, text: input, args: [], diagnostics: templates.diagnostics };
	const args = parseCommandArgs(command.rest);
	return {
		expanded: true,
		text: substituteArgs(template.content, args),
		args,
		template,
		diagnostics: templates.diagnostics,
	};
}

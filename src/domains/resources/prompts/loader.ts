import { readFileSync } from "node:fs";
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

function defaultPromptTemplateRoots(cwd: string): PromptTemplateRoot[] {
	return defaultScopedResourceRoots("prompts", cwd);
}

function splitOptionalFrontmatter(
	raw: string,
	filePath: string,
	diagnostics: ResourceDiagnostic[],
): { frontmatter: Record<string, unknown>; body: string } {
	const split = splitYamlFrontmatter(raw);
	if (split.ok) return split;
	if (split.reason === "missing") return { frontmatter: {}, body: raw };
	const message =
		split.reason === "missing closing delimiter"
			? "prompt template frontmatter is missing a closing delimiter; treating the file as plain markdown"
			: split.reason === "must be a YAML object"
				? "prompt template frontmatter must be a YAML object"
				: `prompt template frontmatter is ${split.reason}`;
	diagnostics.push({ type: "warning", message, path: filePath });
	return { frontmatter: {}, body: split.body };
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
	const sourceInfo: ResourceSourceInfo = sourceInfoForRoot(root, filePath);
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
	const candidates: ResourceCandidate<PromptTemplate>[] = [];
	for (const entry of readRootEntries(root, "prompt template", diagnostics)) {
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

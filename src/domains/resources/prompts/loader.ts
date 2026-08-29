import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseCommandArgs, substituteArgs } from "../../../engine/prompt-templates.js";
import { INTEROP_AGENT_KINDS } from "../../interop/registry.js";
import {
	type ResourceCandidate,
	type ResourceDiagnostic,
	type ResourceScope,
	type ResourceSourceInfo,
	resolveResourceCollisions,
} from "../collision.js";
import {
	COMPAT_RESOURCE_PRECEDENCE,
	defaultScopedResourceRoots,
	sourceInfoForRoot,
	splitYamlFrontmatter,
	stringField,
} from "../common-loader.js";
import { projectCompatTrusted } from "../skills/loader.js";

export interface PromptTemplate {
	name: string;
	description: string;
	content: string;
	filePath: string;
	sourceInfo: ResourceSourceInfo;
	/** False for a project compatibility root until the operator opts in; such a template refuses to expand. */
	trusted: boolean;
	argumentHint?: string;
}

export interface PromptTemplateRoot {
	path: string;
	/** Present only for an installed extension resource root. */
	rootPath?: string;
	scope: ResourceScope;
	source?: string;
	precedence?: number;
	trusted?: boolean;
}

export interface PromptTemplateList {
	items: PromptTemplate[];
	diagnostics: ResourceDiagnostic[];
}

export interface LoadPromptTemplatesInput {
	cwd?: string;
	roots?: ReadonlyArray<PromptTemplateRoot>;
	/** Override the user home dir used for shared compatibility roots (testing). */
	home?: string;
	/** Opt in to model-visible project compatibility roots (.claude/commands, .codex/prompts). */
	trustProjectCompatRoots?: boolean;
	/** Names owned by another command registry and unavailable to templates. */
	reservedNames?: ReadonlySet<string>;
}

export type PromptTemplateExpansion =
	| {
			expanded: false;
			text: string;
			args: string[];
			diagnostics: ResourceDiagnostic[];
			/**
			 * Set when the input named a template that exists and refused to expand.
			 * A caller that would otherwise pass the text through says this instead:
			 * the operator asked for a template, not for a message beginning with a
			 * slash, so sending the literal `/name` to the model answers nothing.
			 */
			refusal?: { template: PromptTemplate; message: string };
	  }
	| {
			expanded: true;
			text: string;
			args: string[];
			template: PromptTemplate;
			diagnostics: ResourceDiagnostic[];
	  };

/**
 * Clio's own prompt roots plus the command and prompt directories the other
 * agents on the machine own. A foreign prompt is text substituted into a
 * message the operator typed, so a project-scope one stays untrusted behind the
 * same opt-in a project-scope foreign skill needs.
 */
function defaultPromptTemplateRoots(input: LoadPromptTemplatesInput = {}): PromptTemplateRoot[] {
	const cwd = input.cwd ?? process.cwd();
	const home = input.home ?? homedir();
	const trustProject = projectCompatTrusted(input.trustProjectCompatRoots);
	const compat: PromptTemplateRoot[] = [];
	for (const kind of INTEROP_AGENT_KINDS) {
		if (kind.userPromptRoot !== undefined) {
			compat.push({
				path: path.join(home, kind.userPromptRoot),
				scope: "user",
				source: `${kind.id}-user`,
				precedence: COMPAT_RESOURCE_PRECEDENCE.userCompat,
				trusted: true,
			});
		}
		if (kind.projectPromptRoot !== undefined) {
			compat.push({
				path: path.join(cwd, kind.projectPromptRoot),
				scope: "project",
				source: `${kind.id}-project`,
				precedence: COMPAT_RESOURCE_PRECEDENCE.projectCompat,
				trusted: trustProject,
			});
		}
	}
	return [...defaultScopedResourceRoots("prompts", cwd), ...compat];
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

// Keep the suffix deliberately conservative. Prompt prose commonly places a
// comma, parenthesis, or full stop immediately after an @path; treating that
// punctuation as part of the filesystem reference makes a valid template look
// unresolved. Extension bundles use portable path components, so these are the
// only characters needed in a reference while still allowing `..` to be
// detected and rejected by the containment check below.
const EXTENSION_ROOT_REFERENCE = /\$\{extensionRoot\}(\/[A-Za-z0-9._~%+@/-]*)?/g;
const EXTENSION_ROOT_TOKEN = "$" + "{extensionRoot}";

function contained(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Resolve only existing paths contained by the declaring extension package. */
function resolveExtensionReferences(
	body: string,
	root: PromptTemplateRoot,
	filePath: string,
	diagnostics: ResourceDiagnostic[],
): string | null {
	if (root.rootPath === undefined || !body.includes(EXTENSION_ROOT_TOKEN)) return body;
	let canonicalRoot: string;
	try {
		canonicalRoot = realpathSync(root.rootPath);
	} catch (error) {
		diagnostics.push({
			type: "warning",
			message: `extension root could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
			path: filePath,
		});
		return null;
	}
	let invalid: string | null = null;
	const resolved = body.replace(EXTENSION_ROOT_REFERENCE, (reference, suffix: string | undefined) => {
		const candidate = path.resolve(canonicalRoot, `.${suffix ?? ""}`);
		try {
			const canonicalCandidate = realpathSync(candidate);
			if (!contained(canonicalRoot, canonicalCandidate)) invalid = reference;
		} catch {
			invalid = reference;
		}
		return candidate;
	});
	if (invalid !== null) {
		diagnostics.push({
			type: "warning",
			message: `prompt template has an unresolved or escaping extension reference: ${invalid}`,
			path: filePath,
		});
		return null;
	}
	return resolved;
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

	const relativePath = path.relative(root.path, filePath);
	if (
		relativePath === "" ||
		relativePath === ".." ||
		relativePath.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relativePath)
	) {
		diagnostics.push({ type: "warning", message: "prompt template escaped its discovery root", path: filePath });
		return null;
	}
	const name = relativePath.slice(0, -ext.length).split(path.sep).join(":");
	if (name.trim().length === 0) return null;
	const { frontmatter, body } = splitOptionalFrontmatter(raw, filePath, diagnostics);
	const resolvedBody = resolveExtensionReferences(body, root, filePath, diagnostics);
	if (resolvedBody === null) return null;
	const description = stringField(frontmatter, "description") ?? fallbackDescription(resolvedBody);
	const argumentHint = stringField(frontmatter, "argument-hint") ?? stringField(frontmatter, "argumentHint");
	const sourceInfo: ResourceSourceInfo = sourceInfoForRoot(root, filePath);
	const template: PromptTemplate = {
		name,
		description,
		content: resolvedBody.trim(),
		filePath,
		sourceInfo,
		trusted: root.trusted !== false,
	};
	if (argumentHint) template.argumentHint = argumentHint;
	return { name, value: template, source: sourceInfo };
}

function loadPromptRoot(
	root: PromptTemplateRoot,
	diagnostics: ResourceDiagnostic[],
): ResourceCandidate<PromptTemplate>[] {
	const candidates: ResourceCandidate<PromptTemplate>[] = [];
	const pending = [root.path];
	while (pending.length > 0) {
		const directory = pending.pop();
		if (!directory) continue;
		let entries: import("node:fs").Dirent[];
		try {
			const stat = lstatSync(directory);
			if (stat.isSymbolicLink() || !stat.isDirectory()) {
				diagnostics.push({
					type: "warning",
					message: "prompt template root contains a non-directory or symbolic link",
					path: directory,
				});
				continue;
			}
			entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			diagnostics.push({
				type: "warning",
				message: `prompt template directory could not be read: ${error instanceof Error ? error.message : String(error)}`,
				path: directory,
			});
			continue;
		}
		for (const entry of [...entries].reverse()) {
			const filePath = path.join(directory, entry.name);
			if (entry.isSymbolicLink()) {
				diagnostics.push({ type: "warning", message: "prompt template symbolic link was ignored", path: filePath });
			} else if (entry.isDirectory()) {
				pending.push(filePath);
			} else if (entry.isFile()) {
				const candidate = loadPromptFile(filePath, root, diagnostics);
				if (candidate) candidates.push(candidate);
			}
		}
	}
	return candidates;
}

export function loadPromptTemplates(input: LoadPromptTemplatesInput = {}): PromptTemplateList {
	const roots = input.roots ?? defaultPromptTemplateRoots(input);
	const diagnostics: ResourceDiagnostic[] = [];
	const candidates = roots.flatMap((root) => loadPromptRoot(root, diagnostics));
	const resolved = resolveResourceCollisions(candidates);
	const items: PromptTemplate[] = [];
	for (const template of resolved.winners) {
		if (input.reservedNames?.has(template.name) === true) {
			diagnostics.push({
				type: "collision",
				message: `prompt template /${template.name} conflicts with the built-in slash command /${template.name} and was ignored`,
				path: template.filePath,
			});
			continue;
		}
		items.push(template);
	}
	return {
		items: items.sort((a, b) => a.name.localeCompare(b.name)),
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
	if (!template.trusted) {
		const message = `prompt template ${template.name} comes from an untrusted project root; set skills.trustProjectCompatRoots to use it`;
		return {
			expanded: false,
			text: input,
			args: [],
			diagnostics: [...templates.diagnostics, { type: "warning", message, path: template.filePath }],
			refusal: { template, message },
		};
	}
	const args = parseCommandArgs(command.rest);
	return {
		expanded: true,
		text: substituteArgs(template.content, args),
		args,
		template,
		diagnostics: templates.diagnostics,
	};
}

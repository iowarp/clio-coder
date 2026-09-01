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
	/**
	 * Why this template cannot be expanded, when a load-time failure left it
	 * with no usable body. It is loaded anyway, so the namespaced command is
	 * recognized and invoking it reports this reason instead of "not a command"
	 * (issue #245). `content` is empty on such a template and nothing may send
	 * it to a model.
	 */
	unavailable?: string;
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

/**
 * The outcome of a step that may leave the template with no usable body.
 * `reason` is the one sentence that becomes both the diagnostic the `/prompts`
 * overlay renders and the refusal the operator gets when they invoke the
 * command, so the two can never disagree.
 */
type BodyResolution = { body: string } | { reason: string };

/**
 * Resolve only existing paths contained by the declaring extension package.
 *
 * The safety half is unchanged: a missing or escaping reference never expands
 * and never reads outside the package. What changed is what the caller does
 * with the failure, which used to be dropping the template entirely.
 */
function resolveExtensionReferences(body: string, root: PromptTemplateRoot): BodyResolution {
	if (root.rootPath === undefined || !body.includes(EXTENSION_ROOT_TOKEN)) return { body };
	let canonicalRoot: string;
	try {
		canonicalRoot = realpathSync(root.rootPath);
	} catch (error) {
		return { reason: `extension root could not be resolved: ${error instanceof Error ? error.message : String(error)}` };
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
		return { reason: `prompt template has an unresolved or escaping extension reference: ${invalid}` };
	}
	return { body: resolved };
}

/**
 * A template that exists and cannot run.
 *
 * Dropping it made the operator's namespaced command answer "not a command",
 * so an extension author's single bad `${extensionRoot}` path read to their
 * users as "the prompt was never installed" (issue #245). The template is
 * loaded with an empty body and the reason attached instead, which is the same
 * shape an untrusted project template already had, so the existing refusal
 * path carries it to the operator with no new machinery.
 */
function unavailableTemplate(
	name: string,
	filePath: string,
	root: PromptTemplateRoot,
	reason: string,
	diagnostics: ResourceDiagnostic[],
	description?: string,
): ResourceCandidate<PromptTemplate> {
	diagnostics.push({ type: "warning", message: reason, path: filePath });
	const sourceInfo: ResourceSourceInfo = sourceInfoForRoot(root, filePath);
	return {
		name,
		value: {
			name,
			description: description ?? "Prompt template (unavailable)",
			content: "",
			filePath,
			sourceInfo,
			trusted: root.trusted !== false,
			unavailable: `${reason} (${filePath})`,
		},
		source: sourceInfo,
	};
}

function loadPromptFile(
	filePath: string,
	root: PromptTemplateRoot,
	diagnostics: ResourceDiagnostic[],
): ResourceCandidate<PromptTemplate> | null {
	const ext = path.extname(filePath).toLowerCase();
	if (ext !== ".md") return null;

	// The name comes before the read, so a file that exists but cannot be read
	// still has a command the operator can invoke and be told why.
	const relativePath = path.relative(root.path, filePath);
	if (
		relativePath === "" ||
		relativePath === ".." ||
		relativePath.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relativePath)
	) {
		// The one failure that stays a drop: the path is outside the discovery
		// root, so there is no name here to offer a command under.
		diagnostics.push({ type: "warning", message: "prompt template escaped its discovery root", path: filePath });
		return null;
	}
	const name = relativePath.slice(0, -ext.length).split(path.sep).join(":");
	if (name.trim().length === 0) return null;

	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return unavailableTemplate(name, filePath, root, `prompt template could not be read: ${reason}`, diagnostics);
	}

	const { frontmatter, body } = splitOptionalFrontmatter(raw, filePath, diagnostics);
	const declaredDescription = stringField(frontmatter, "description");
	const resolution = resolveExtensionReferences(body, root);
	if ("reason" in resolution) {
		return unavailableTemplate(name, filePath, root, resolution.reason, diagnostics, declaredDescription ?? undefined);
	}
	const description = declaredDescription ?? fallbackDescription(resolution.body);
	const argumentHint = stringField(frontmatter, "argument-hint") ?? stringField(frontmatter, "argumentHint");
	const sourceInfo: ResourceSourceInfo = sourceInfoForRoot(root, filePath);
	const template: PromptTemplate = {
		name,
		description,
		content: resolution.body.trim(),
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
	const framed = input.trimStart();
	if (!framed.startsWith("/")) return null;
	const withoutSlash = framed.slice(1);
	const separator = withoutSlash.search(/\s/);
	const name = separator === -1 ? withoutSlash : withoutSlash.slice(0, separator);
	if (name.length === 0 || name.includes("/")) return null;
	// Leading whitespace before `/` and the first whitespace after the command
	// are framing. A CRLF pair is one delimiter. Every subsequent byte belongs
	// to the argument payload, including indentation, blank lines, and trailing
	// whitespace, so raw `$ARGUMENTS` substitution can be exact at its boundary.
	const delimiterWidth = separator !== -1 && withoutSlash.slice(separator, separator + 2) === "\r\n" ? 2 : 1;
	const rest = separator === -1 ? "" : withoutSlash.slice(separator + delimiterWidth);
	return { name, rest };
}

export function expandPromptTemplateInput(input: string, templates: PromptTemplateList): PromptTemplateExpansion {
	const command = parsePromptCommand(input);
	if (!command) return { expanded: false, text: input, args: [], diagnostics: templates.diagnostics };
	const template = templates.items.find((entry) => entry.name === command.name);
	if (!template) return { expanded: false, text: input, args: [], diagnostics: templates.diagnostics };
	// A load-time failure refuses before anything else, and before the trust
	// check, because there is no body here to be trusted or untrusted.
	if (template.unavailable !== undefined) {
		const message = `prompt template /${template.name} cannot run: ${template.unavailable}`;
		return {
			expanded: false,
			text: input,
			args: [],
			diagnostics: templates.diagnostics,
			refusal: { template, message },
		};
	}
	if (!template.trusted) {
		const message = `prompt template ${template.name} comes from an untrusted project root; set integrations.projectResources.trustProjectImports to use it`;
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
		text: substituteArgs(template.content, args, command.rest),
		args,
		template,
		diagnostics: templates.diagnostics,
	};
}

import type { ProjectType } from "../session/workspace/project-type.js";
import type { AdoptionScanResult } from "./adoption.js";
import type { BootstrapStructuredOutput } from "./bootstrap.js";
import { renderCodewikiDigest } from "./codewiki/digest.js";
import type { Codewiki } from "./codewiki/indexer.js";
import type { SiblingContextFile } from "./sibling-files.js";

export const BOOTSTRAP_PROMPT = `You are the clio-coder bootstrap agent. Your job is to write the custom sections of CLIO.md for the project at <cwd>. CLIO.md is a lean, project-specific handbook that the clio-coder coding agent loads on every session, so write for an experienced engineer who has never seen this repository and is about to change it.

You are being dispatched through Clio's internal Scout shadow agent. Read the repository before you answer: start with code_nav (modes symbol, path, entries, outline, deps, dependents, wiki) against the index Clio just built, then read the specific files that decide behavior. Do not write files, run tests, or use external sources. For this bootstrap task, the JSON-only response contract below overrides Scout's normal evidence-report format.

You will be given:
- The repository-derived project name. Return it exactly as projectName; do not substitute a path or invent a brand.
- The detected project type.
- The existing CLIO.md when one is present. Treat it as evidence; Clio preserves its human-owned fields outside your response.
- A structural digest from the codewiki index: module count, entry points, and top directories.
- A sanitized adoption scan of project-local agent configs, including Claude Code context files and skills (CLAUDE.md, .claude/CLAUDE.md, project settings/commands/agents/skills), Codex (AGENTS.md, CODEX.md, .codex/AGENTS.md, .codex/skills), Gemini (GEMINI.md, .gemini/GEMINI.md, .gemini config/rules), Cursor (.cursor/rules/*.mdc and *.md), OpenCode (.opencode/skills), and GitHub Copilot (.github/copilot-instructions.md, .github/skills).
- Global user preferences only when the user explicitly opted in.

THE CITATION RULE, which Clio enforces after you answer: a line survives only when it contains at least one backticked token, and every backticked token names something real in this repository, meaning an indexed file path, a symbol, a runnable package script, or a string that occurs in the supplied evidence. A line that cites nothing is deleted. A line that cites something that does not exist is deleted. Write every line so that it names the file, symbol, or command it is about.

Clio's deterministic layer owns the project name, identity, conventions, hard invariants, the navigation and repository-shape sections, agent-context provenance, and the verification-command section. Set projectName to the supplied expectedProjectName, keep identity to one short sentence, and return empty conventions and invariants arrays.

Your contribution is two to four custom H2 sections, chosen from these, in this order of value:
- "Architecture": the control flow a change has to travel through, named file by file. Say which module owns which decision, and which files are coupled and must change together. This is the section that requires reading, so it is the one worth the most.
- "Gotchas": invariants that are easy to break. Each item names the file that enforces it and the consequence of breaking it, especially where a violation degrades silently instead of failing loudly.
- "Extending": for the two or three most likely kinds of change, the exact set of files that must be touched together.
- "Commands": only development commands that Clio's verification section will not already state, such as running a single test, a dry-run mode, or a debug environment variable.

Prefer specific over complete. Six lines that name real files beat twenty lines of summary. State a size warning when a file is large enough that reading it top to bottom is the wrong move. A fenced block is acceptable for commands; Clio inlines it.

Copy commands, file paths, symbols, and version constraints exactly. Never repair, combine, or paraphrase a shell command. Never invent an API endpoint, an example, an ownership team, a review requirement, a release process, or a file count. If you did not read it or it was not supplied, do not write it.

Do not include a project map, a file tree, a dependency inventory, a language-idiom list, preferences, communication-style content, secrets, credentials, auth tokens, caches, histories, generated state, fingerprint metadata, or imported-context provenance. Clio adds its deterministic surfaces after parsing. Keep the complete custom-section payload under 2500 bytes.

Return one assistant message containing only compact JSON with this exact shape. Do not include markdown fences, prose, explanation, or commentary:
{
  "projectName": "string",
  "identity": "string",
  "conventions": ["string"],
  "invariants": ["string"],
  "sections": [{ "title": "string", "body": "markdown string" }]
}`;

/** Provider-enforced counterpart to the JSON contract in BOOTSTRAP_PROMPT. */
export const BOOTSTRAP_OUTPUT_JSON_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["projectName", "identity", "conventions", "invariants", "sections"],
	properties: {
		// Keep the provider schema to llama.cpp's portable grammar subset.
		// parseBootstrapModelOutput enforces all string and array bounds below.
		projectName: { type: "string" },
		identity: { type: "string" },
		conventions: {
			type: "array",
			items: { type: "string" },
		},
		invariants: {
			type: "array",
			items: { type: "string" },
		},
		sections: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["title", "body"],
				properties: {
					title: { type: "string" },
					body: { type: "string" },
				},
			},
		},
	},
} satisfies Record<string, unknown>;

export interface BootstrapPromptInput {
	cwd: string;
	expectedProjectName?: string;
	projectType: ProjectType;
	siblingFiles: ReadonlyArray<SiblingContextFile>;
	adoption: AdoptionScanResult;
	existingClioMdText?: string;
	codewiki?: Codewiki;
}

function truncate(value: string, max: number): string {
	if (value.length <= max) return value;
	const marker = "\n[truncated]";
	if (max <= marker.length) return value.slice(0, max);
	return `${value.slice(0, max - marker.length)}${marker}`;
}

export const BOOTSTRAP_INPUT_MAX_CHARS = 48_000;
export const BOOTSTRAP_SIBLING_MAX_FILES = 12;
export const BOOTSTRAP_SIBLING_CONTENT_MAX_CHARS = 12_000;

function sourceSummaries(
	files: ReadonlyArray<SiblingContextFile>,
	adoption: AdoptionScanResult,
): Array<Record<string, unknown>> {
	const selected = files.slice(0, BOOTSTRAP_SIBLING_MAX_FILES);
	const perFileLimit = Math.min(
		3000,
		Math.max(1, Math.floor(BOOTSTRAP_SIBLING_CONTENT_MAX_CHARS / Math.max(1, selected.length))),
	);
	const displayPath = new Map(adoption.sources.map((source) => [source.path, source.displayPath] as const));
	return selected.map((file) => ({
		scope: file.source,
		path: truncate(displayPath.get(file.path) ?? file.path, 240),
		content: truncate(file.content, perFileLimit),
	}));
}

function compactImportedRules(adoption: AdoptionScanResult): Array<Record<string, unknown>> {
	return adoption.importedRules.slice(0, 12).map((rule) => ({
		text: truncate(rule.text, 240),
		sources: rule.sources.slice(0, 2).map((source) => truncate(source, 160)),
		providers: rule.providers.slice(0, 2).map((provider) => truncate(provider, 80)),
		...(rule.directoryScopes
			? { directoryScopes: rule.directoryScopes.slice(0, 2).map((scope) => truncate(scope, 160)) }
			: {}),
		...(rule.conflictKey ? { conflictKey: truncate(rule.conflictKey, 80) } : {}),
	}));
}

function compactConflicts(adoption: AdoptionScanResult): Array<Record<string, unknown>> {
	return adoption.conflicts.slice(0, 6).map((conflict) => ({
		key: truncate(conflict.key, 80),
		kept: truncate(conflict.kept, 240),
		keptSources: conflict.keptSources.slice(0, 2).map((source) => truncate(source, 160)),
		skipped: conflict.skipped.slice(0, 1).map((skipped) => ({
			text: truncate(skipped.text, 240),
			source: truncate(skipped.source, 160),
			provider: truncate(skipped.provider, 80),
		})),
	}));
}

function compactRejected(adoption: AdoptionScanResult): Array<Record<string, unknown>> {
	return adoption.rejected.slice(0, 8).map((rejected) => ({
		path: truncate(rejected.displayPath, 240),
		scope: rejected.scope,
		...(rejected.provider ? { provider: rejected.provider } : {}),
		reason: truncate(rejected.reason, 160),
	}));
}

export function buildBootstrapPrompt(input: BootstrapPromptInput): string {
	const siblingFiles = sourceSummaries(input.siblingFiles, input.adoption);
	const importedRules = compactImportedRules(input.adoption);
	const conflicts = compactConflicts(input.adoption);
	const rejected = compactRejected(input.adoption);
	const adoption = {
		includeGlobal: input.adoption.includeGlobal,
		sourceCount: input.adoption.sources.length,
		presentedSourceCount: siblingFiles.length,
		importedRuleCount: input.adoption.importedRules.length,
		conflictCount: input.adoption.conflicts.length,
		rejectedCount: input.adoption.rejected.length,
		importedRules,
		conflicts,
		rejected,
	};
	const payload = {
		projectRoot: ".",
		expectedProjectName: truncate(input.expectedProjectName ?? "Project", 80),
		projectType: input.projectType,
		...(input.existingClioMdText ? { existingClioMd: truncate(input.existingClioMdText, 8000) } : {}),
		...(input.codewiki ? { codewikiDigest: renderCodewikiDigest(input.codewiki, 1200) } : {}),
		siblingFiles,
		adoption,
	};
	let serialized = JSON.stringify(payload);
	while (serialized.length > BOOTSTRAP_INPUT_MAX_CHARS) {
		if (rejected.length > 0) rejected.pop();
		else if (conflicts.length > 0) conflicts.pop();
		else if (siblingFiles.length > 1) siblingFiles.pop();
		else if (importedRules.length > 1) importedRules.pop();
		else break;
		adoption.presentedSourceCount = siblingFiles.length;
		serialized = JSON.stringify(payload);
	}
	if (serialized.length > BOOTSTRAP_INPUT_MAX_CHARS) {
		serialized = JSON.stringify({
			projectRoot: ".",
			expectedProjectName: truncate(input.expectedProjectName ?? "Project", 80),
			projectType: input.projectType,
			...(input.existingClioMdText ? { existingClioMd: truncate(input.existingClioMdText, 2000) } : {}),
			...(input.codewiki ? { codewikiDigest: renderCodewikiDigest(input.codewiki, 1200) } : {}),
			siblingFiles: [],
			adoption: {
				includeGlobal: input.adoption.includeGlobal,
				sourceCount: input.adoption.sources.length,
				presentedSourceCount: 0,
				importedRuleCount: input.adoption.importedRules.length,
				conflictCount: input.adoption.conflicts.length,
				rejectedCount: input.adoption.rejected.length,
			},
		});
	}
	return `${BOOTSTRAP_PROMPT}\n\n<bootstrap-input>\n${serialized}\n</bootstrap-input>`;
}

function extractJsonObject(text: string): unknown {
	const trimmed = text.trim();
	if (trimmed.startsWith("{") && trimmed.endsWith("}")) return JSON.parse(trimmed);
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)?.[1]?.trim();
	if (fenced?.startsWith("{")) return JSON.parse(fenced);
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
	throw new Error("bootstrap model output did not contain a JSON object");
}

function stringArray(value: unknown, key: string, maxItems: number, maxChars: number): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error(`bootstrap model output '${key}' must be an array`);
	return value
		.map((item, index) => {
			if (typeof item !== "string") throw new Error(`bootstrap model output '${key}[${index}]' must be a string`);
			return item.replace(/\s+/g, " ").trim();
		})
		.filter((item) => item.length > 0)
		.slice(0, maxItems)
		.map((item) => item.slice(0, maxChars));
}

function stringField(record: Record<string, unknown>, key: string, maxChars: number): string {
	const value = record[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`bootstrap model output '${key}' must be a non-empty string`);
	}
	return value.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

function structuredSections(value: unknown): NonNullable<BootstrapStructuredOutput["sections"]> {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("bootstrap model output 'sections' must be an array");
	return value
		.map((item, index) => {
			if (typeof item !== "object" || item === null || Array.isArray(item)) {
				throw new Error(`bootstrap model output 'sections[${index}]' must be an object`);
			}
			const record = item as Record<string, unknown>;
			if (typeof record.title !== "string" || record.title.trim().length === 0) {
				throw new Error(`bootstrap model output 'sections[${index}].title' must be a non-empty string`);
			}
			if (typeof record.body !== "string" || record.body.trim().length === 0) {
				throw new Error(`bootstrap model output 'sections[${index}].body' must be a non-empty string`);
			}
			return {
				title: record.title.replace(/\s+/g, " ").trim().slice(0, 80),
				body: record.body.trim().slice(0, 2500),
			};
		})
		.filter((section) => section.title.length > 0 && section.body.length > 0)
		.slice(0, 8);
}

export function parseBootstrapModelOutput(text: string): BootstrapStructuredOutput {
	const parsed = extractJsonObject(text);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("bootstrap model output must be a JSON object");
	}
	const record = parsed as Record<string, unknown>;
	return {
		projectName: stringField(record, "projectName", 80),
		identity: stringField(record, "identity", 600),
		conventions: stringArray(record.conventions, "conventions", 6, 200),
		invariants: stringArray(record.invariants, "invariants", 3, 280),
		sections: structuredSections(record.sections),
	};
}

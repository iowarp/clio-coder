import type { ProjectType } from "../session/workspace/project-type.js";
import type { AdoptionScanResult } from "./adoption.js";
import { type BootstrapStructuredOutput, codewikiEntryPoints } from "./bootstrap.js";
import type { Codewiki } from "./codewiki/indexer.js";
import type { SiblingContextFile } from "./sibling-files.js";

export const BOOTSTRAP_PROMPT = `You are the clio-coder bootstrap agent. Your job is to produce a single CLIO.md file for the project at <cwd>. CLIO.md is a lean, project-specific context file that the clio-coder coding agent loads on every session.

You are being dispatched through Clio's internal Scout shadow agent. Use Scout's read-only tools only when the structured <bootstrap-input> is insufficient. Do not write files, run tests, or use external sources. For this bootstrap task, the JSON-only response contract below overrides Scout's normal evidence-report format.

You will be given:
- The detected project type.
- The existing CLIO.md when one is present. Treat it as the primary source of truth for project-specific guidance. Preserve useful manual sections unless they are clearly obsolete from inspected evidence.
- A structural digest from the codewiki index: module count, entry points, and top directories. Ground the identity and any architecture sections in this real structure; do not invent files.
- A sanitized adoption scan of project-local agent configs, including Claude Code context files and skills (CLAUDE.md, .claude/CLAUDE.md, project settings/commands/agents/skills), Codex (AGENTS.md, CODEX.md, .codex/AGENTS.md, .codex/skills), Gemini (GEMINI.md, .gemini/GEMINI.md, .gemini config/rules), Cursor (.cursor/rules/*.mdc and *.md), OpenCode (.opencode/skills), and GitHub Copilot (.github/copilot-instructions.md, .github/skills).
- Global user preferences only when the user explicitly opted in.

Produce a proposed CLIO.md draft with these possible sections:

1. Identity. One paragraph, at most four sentences and at most 600 characters. The project name as H1, then a paragraph naming the stack, role, and what the project is. Do not list project files. Do not state language-generic conventions. Do not include build commands.

2. Conventions. Zero to six bullet points, each at most 200 characters. Project-specific verifiable rules only. If sibling agent-context files contain such rules, distill them. If they do not, omit the section.

3. Hard invariants. Zero to three numbered rules, each at most 280 characters. Only include rules the project enforces at build time. If the project has none, omit the section.

4. Custom H2 sections. Prefer four to eight sections when the repository structure supports them, each with a title and markdown body. Use these for repository-specific architecture boundaries, ownership boundaries, context-retrieval strategy, generated/local artifact policy, workflow traps, failure modes, and verification expectations that are not obvious from the language. Keep each section dense and actionable for a coding agent. Do not add generic "how to build/test" guidance. If an existing CLIO.md is supplied, preserve its useful custom sections instead of replacing them with generic architecture prose.

5. Imported agent context. Only when adoption mode is requested. Use the scanner-provided provenance, conflict policy, adopted rules, conflicts, and rejected source summaries.

Total CLIO.md size target: 2500-8000 bytes without adoption, or compact and provenance-rich with adoption.

CLIO.md is a versioned, human-owned project handbook equivalent to CLAUDE.md, AGENTS.md, and GEMINI.md. It may be generated or updated by context-init, but it is not an ignored transient artifact. Do not tell agents to avoid committing CLIO.md, do not call CLIO.md disposable, and do not describe it as generated state. The generated/local artifact policy applies to .clio/* state, proposals, codewiki data, caches, and handoff files unless the repository explicitly says otherwise. If you include an artifact policy section, state that CLIO.md is versioned and .clio/* is ignored local state unless explicitly force-added.

Do not invent ownership teams, review requirements, release processes, module export conventions, migration requirements, or file counts unless they are present in the input or verified by Scout tools.

Do not include a project map, file tree, language-idiom list, preferences, communication style content, secrets, credentials, auth tokens, caches, histories, generated state, or fingerprint metadata. Build/test commands are appropriate only when they are project-specific verification expectations an agent should actually run. If adoption mode is requested, add only the sanitized provenance section supplied by the scanner rather than concatenating raw source files.

Return one assistant message containing only compact JSON with this exact shape. Do not include markdown fences, prose, explanation, or commentary:
{
  "projectName": "string",
  "identity": "string",
  "conventions": ["string"],
  "invariants": ["string"],
  "sections": [{ "title": "string", "body": "markdown string" }]
}`;

export interface BootstrapPromptInput {
	cwd: string;
	projectType: ProjectType;
	siblingFiles: ReadonlyArray<SiblingContextFile>;
	adoption: AdoptionScanResult;
	existingClioMdText?: string;
	codewiki?: Codewiki;
}

/**
 * Compact structural digest of the codewiki for the bootstrap prompt: module
 * count, entry points, and the top directories by file count. Grounds the model
 * in the real source tree without dumping the full index.
 */
function topTwoSegments(path: string): string {
	const dirParts = path.split("/").slice(0, -1);
	if (dirParts.length === 0) return ".";
	return dirParts.slice(0, 2).join("/");
}

function summarizeCodewiki(codewiki: Codewiki): Record<string, unknown> {
	const dirCounts = new Map<string, number>();
	for (const entry of codewiki.entries) {
		const top = topTwoSegments(entry.path);
		dirCounts.set(top, (dirCounts.get(top) ?? 0) + 1);
	}
	const topDirs = [...dirCounts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, 8)
		.map(([dir, count]) => `${dir} (${count})`);
	return {
		moduleCount: codewiki.entries.length,
		entryPoints: codewikiEntryPoints(codewiki, 8),
		entryPointSummaries: codewiki.entries
			.filter((entry) => entry.kind === "entry-point" && entry.summary)
			.slice(0, 8)
			.map((entry) => ({ path: entry.path, summary: entry.summary })),
		topDirectories: topDirs,
	};
}

function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max)}\n[truncated]`;
}

function sourceSummary(file: SiblingContextFile): Record<string, unknown> {
	return {
		scope: file.source,
		path: file.path,
		content: truncate(file.content, 4000),
	};
}

export function buildBootstrapPrompt(input: BootstrapPromptInput): string {
	const payload = {
		cwd: input.cwd,
		projectType: input.projectType,
		...(input.existingClioMdText ? { existingClioMd: truncate(input.existingClioMdText, 8000) } : {}),
		...(input.codewiki ? { structure: summarizeCodewiki(input.codewiki) } : {}),
		siblingFiles: input.siblingFiles.map(sourceSummary),
		adoption: {
			includeGlobal: input.adoption.includeGlobal,
			sourceCount: input.adoption.sources.length,
			importedRules: input.adoption.importedRules,
			conflicts: input.adoption.conflicts,
			rejected: input.adoption.rejected,
		},
	};
	return `${BOOTSTRAP_PROMPT}\n\n<bootstrap-input>\n${JSON.stringify(payload, null, 2)}\n</bootstrap-input>`;
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

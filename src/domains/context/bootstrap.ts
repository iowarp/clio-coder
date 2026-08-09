import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import type { ContextActivityPayload } from "../../core/bus-events.js";
import { classifyProjectPreload, type ProjectPreloadClass } from "../prompts/preload.js";
import { detectProjectType, type ProjectType } from "../session/workspace/project-type.js";
import {
	type AdoptionScanResult,
	adoptionSnapshotsHash,
	renderImportedAgentContext,
	scanAgentConfigs,
} from "./adoption.js";
import { type ClioMdSection, type ParsedClioMd, parseClioMd, serializeClioMd, tryReadClioMd } from "./clio-md.js";
import { buildCodewiki, type Codewiki, writeCodewiki } from "./codewiki/indexer.js";
import { computeFingerprint } from "./fingerprint.js";
import { renderPromptContext } from "./prompt-context.js";
import type { SiblingContextFile } from "./sibling-files.js";
import {
	type BootstrapGenerationMode,
	type BootstrapGenerationState,
	type BootstrapParserOutcome,
	readClioState,
	statePath as resolveStatePath,
	writeClioState,
} from "./state.js";

export interface BootstrapStructuredOutput {
	projectName: string;
	identity: string;
	conventions: string[];
	invariants: string[];
	sections?: ClioMdSection[];
	importedAgentContext?: string;
}

export interface BootstrapIo {
	stdout: (s: string) => void;
	stderr: (s: string) => void;
}

/**
 * Input handed to a CLIO.md generator. Carries the adoption scan plus the freshly
 * built codewiki so generators can ground their output in the real repository
 * structure (entry points, key modules) instead of guessing from prose alone.
 */
export interface BootstrapGenerateInput {
	cwd: string;
	expectedProjectName?: string;
	projectType: ProjectType;
	siblingFiles: ReadonlyArray<SiblingContextFile>;
	adoption: AdoptionScanResult;
	codewiki: Codewiki;
	existingClioMd?: ParsedClioMd;
	existingClioMdText?: string;
	progress?: BootstrapProgressSink;
	reportGeneration?: BootstrapGenerationSink;
}

export type BootstrapGenerate = (
	input: BootstrapGenerateInput,
) => BootstrapStructuredOutput | Promise<BootstrapStructuredOutput>;

export type BootstrapProgressEvent = Omit<ContextActivityPayload, "kind" | "at">;
export type BootstrapProgressSink = (event: BootstrapProgressEvent) => void;

export interface BootstrapScoutTelemetry {
	structuredOutputMode: "native-schema" | "prompt-parser";
	runId?: string;
	targetId?: string;
	wireModelId?: string;
	runtimeId?: string;
	runtimeKind?: string;
	thinkingLevel?: string;
	tokens?: {
		total: number;
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		reasoning?: number;
	};
	toolCalls?: number;
	toolFailures?: number;
	toolBlocked?: number;
	durationMs?: number;
	promptBytes: number;
	outputBytes: number;
}

export interface BootstrapGenerationTelemetry {
	mode: BootstrapGenerationMode;
	parserOutcome: BootstrapParserOutcome;
	fallbackReason?: string;
	scout?: BootstrapScoutTelemetry;
}

export type BootstrapGenerationSink = (telemetry: BootstrapGenerationTelemetry) => void;

export type BootstrapFallbackMode = "existing" | "heuristic";

export interface BootstrapFallbackResult {
	mode: BootstrapFallbackMode;
	output: BootstrapStructuredOutput;
}

export interface RunBootstrapInput {
	cwd?: string;
	io?: BootstrapIo;
	modelId?: string;
	now?: () => Date;
	confirmGitignore?: () => boolean | Promise<boolean>;
	preview?: boolean;
	adopt?: boolean;
	applyClioMd?: boolean;
	rewriteClioMd?: boolean;
	proposeClioMd?: boolean;
	includeGlobalImports?: boolean;
	homeDir?: string;
	generate?: BootstrapGenerate;
	onProgress?: BootstrapProgressSink;
}

export interface RunBootstrapResult {
	clioMdPath: string;
	statePath: string;
	siblingFiles: ReadonlyArray<SiblingContextFile>;
	output: BootstrapStructuredOutput;
	projectType: ProjectType;
	summary: RunBootstrapSummary;
	adoption: AdoptionScanResult;
	telemetry: {
		generation: BootstrapGenerationTelemetry;
	};
	/**
	 * How the session compiler will preload the project context that exists
	 * on disk after this run: full, synopsis (with the limit that forced it),
	 * or none. In preview mode this reflects the current on-disk state, since
	 * preview writes nothing.
	 */
	preload: ProjectPreloadClass;
}

export interface RunBootstrapSummary {
	action: "wrote" | "refreshed" | "preserved" | "proposed" | "previewed";
	contextFileCount: number;
	contextFileNames: string[];
	codewikiEntries: number;
	dirtyFiles: number;
	adoption: RunBootstrapAdoptionSummary;
	proposalPath?: string;
}

export interface RunBootstrapAdoptionSummary {
	mode: "scan" | "adopt" | "preview";
	sourceCount: number;
	projectSourceCount: number;
	globalSourceCount: number;
	importedRuleCount: number;
	conflictCount: number;
	rejectedCount: number;
	includeGlobal: boolean;
}

function out(io: BootstrapIo | undefined, message: string): void {
	io?.stdout(message);
}

function warn(io: BootstrapIo | undefined, message: string): void {
	io?.stderr(message);
}

function progress(input: RunBootstrapInput, event: BootstrapProgressEvent): void {
	input.onProgress?.(event);
}

function readJsonFile(filePath: string): unknown {
	try {
		return JSON.parse(readFileSync(filePath, "utf8"));
	} catch {
		return null;
	}
}

function stringField(value: unknown, key: string): string | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const field = (value as Record<string, unknown>)[key];
	return typeof field === "string" && field.trim().length > 0 ? field.trim() : null;
}

function titleFromPackageName(raw: string): string {
	const base = raw.includes("/") ? (raw.split("/").pop() ?? raw) : raw;
	return base
		.split(/[-_]+/)
		.filter(Boolean)
		.map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
		.join(" ");
}

function projectName(cwd: string): string {
	const pkg = readJsonFile(join(cwd, "package.json"));
	const name = stringField(pkg, "name");
	if (name) return titleFromPackageName(name);
	try {
		const readme = readFileSync(join(cwd, "README.md"), "utf8");
		const heading = /^#\s+(.+?)\s*$/m.exec(readme)?.[1]?.trim();
		if (heading) return heading.slice(0, 80);
	} catch {
		// fall back to directory name
	}
	return titleFromPackageName(parse(cwd).base || "Project");
}

function projectTypeLabel(projectType: ProjectType): string {
	switch (projectType) {
		case "typescript":
			return "TypeScript/Node.js";
		case "javascript":
			return "JavaScript/Node.js";
		case "python":
			return "Python";
		case "rust":
			return "Rust";
		case "go":
			return "Go";
		case "c":
			return "C";
		case "c++":
			return "C++";
		case "java":
			return "Java";
		case "ruby":
			return "Ruby";
		case "c#":
			return "C#";
		case "polyglot":
			return "polyglot";
		case "dotfiles":
			return "dotfiles";
		case "unknown":
			return "software";
	}
}

function allContextText(files: ReadonlyArray<SiblingContextFile>): string {
	return files.map((file) => file.content).join("\n\n");
}

function readReadmeSummary(cwd: string): string | null {
	let readme: string;
	try {
		readme = readFileSync(join(cwd, "README.md"), "utf8");
	} catch {
		return null;
	}
	const cleanedReadme = readme
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<picture\b[\s\S]*?<\/picture>/gi, "")
		.replace(/^\s*<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]>\s*$/gim, "")
		.replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, "")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/<img\b[^>]*>/gi, "")
		.replace(/<[^>]+>/g, "")
		.replace(/[*_~]/g, "");
	const paragraphs = cleanedReadme
		.split(/\n\s*\n/)
		.map((part) =>
			part
				.replace(/^\s*#{1,6}\s+.*$/gm, "")
				.replace(/^\s*[-|: ]+\s*$/gm, "")
				.trim(),
		)
		.filter(
			(part) =>
				part.length >= 20 && /[A-Za-z]{3}/.test(part) && !part.startsWith("```") && !/^table of contents$/i.test(part),
		);
	const first = paragraphs[0];
	if (!first) return null;
	const cleaned = first.replace(/\s+/g, " ").replace(/\.$/, "").trim();
	return cleaned.length > 0 ? cleaned : null;
}

function defaultIdentity(cwd: string, projectType: ProjectType, files: ReadonlyArray<SiblingContextFile>): string {
	const name = projectName(cwd);
	const context = allContextText(files);
	if (/Clio owns the agent loop/i.test(context) && /pi-(?:ai|SDK)/i.test(context)) {
		return [
			"Clio Coder is IOWarp's orchestrator coding agent, named for the Greek muse of history and developed by the Gnosis Research Center at Illinois Tech under PI @akougkas. CLIO stands for Context Layer for Input/Output.",
			"pi-ai is accessed through the engine boundary.",
			"Clio owns the agent loop, TUI, session format, tool registry, and identity.",
		].join(" ");
	}
	const pkg = readJsonFile(join(cwd, "package.json"));
	const description = stringField(pkg, "description") ?? readReadmeSummary(cwd);
	const stack = projectTypeLabel(projectType);
	const head = `${name} is a ${stack} project.`;
	if (!description) return head.slice(0, 600);
	const cleaned = description.replace(/\.$/, "").trim();
	const role = /^[a-z]/.test(cleaned) ? `It is ${cleaned}.` : `${cleaned}.`;
	return `${head} ${role}`.slice(0, 600);
}

function pushUnique(target: string[], value: string): void {
	if (target.includes(value)) return;
	target.push(value);
}

const RULE_KEYWORDS = /\b(always|never|must|should|prefer|avoid|do not|don't|use)\b/i;
const SKIP_BULLET_PATTERNS = [/^marker\s*[:=]/i, /marker[-_:]\s*\w+-\w+/i, /^todo\b/i, /^note\b/i, /^example\b/i];

function harvestSiblingBullets(files: ReadonlyArray<SiblingContextFile>): string[] {
	const out: string[] = [];
	for (const file of files) {
		for (const rawLine of file.content.split("\n")) {
			const match = /^[\s>]*[-*]\s+(.+?)\s*$/.exec(rawLine);
			if (!match) continue;
			const bullet = match[1]?.trim();
			if (!bullet || bullet.length < 5) continue;
			if (bullet.length > 200) continue;
			if (SKIP_BULLET_PATTERNS.some((re) => re.test(bullet))) continue;
			if (!RULE_KEYWORDS.test(bullet)) continue;
			out.push(bullet);
		}
	}
	return out;
}

function inferConventions(cwd: string, projectType: ProjectType, files: ReadonlyArray<SiblingContextFile>): string[] {
	const conventions: string[] = [];
	const context = allContextText(files);
	const pkg = readJsonFile(join(cwd, "package.json"));
	const packageText = typeof pkg === "object" && pkg !== null ? JSON.stringify(pkg) : "";
	if (
		/Local imports end in `?\.js`?/i.test(context) ||
		(projectType === "typescript" && existsSync(join(cwd, "tsconfig.json")))
	) {
		pushUnique(conventions, "Local imports end in `.js`. Tests use `node:test`. Avoid `any` without a tracking issue.");
	} else if (/node:test/i.test(context) || /node --import tsx --test|node --test/.test(packageText)) {
		pushUnique(conventions, "Tests use `node:test`.");
	}
	if (/No em-dash|em-dash/i.test(context)) {
		pushUnique(
			conventions,
			"No em-dash clause separators in code, comments, commits, or responses. Write full sentences.",
		);
	}
	if (/Commit subjects|conventional commit|Imperative, lowercase|lowercase-typed subjects/i.test(context)) {
		pushUnique(
			conventions,
			"Commit subjects are imperative, lowercase, conventional, at most 72 characters, and end without a period.",
		);
	}
	for (const bullet of harvestSiblingBullets(files)) pushUnique(conventions, bullet);
	return conventions.slice(0, 6);
}

function inferInvariants(files: ReadonlyArray<SiblingContextFile>): string[] {
	const context = allContextText(files);
	const invariants: string[] = [];
	if (/Engine boundary/i.test(context)) {
		pushUnique(invariants, "Engine boundary. Only `src/engine/**` may value-import `@earendil-works/pi-*`.");
	}
	if (/Worker isolation/i.test(context)) {
		pushUnique(
			invariants,
			"Worker isolation. `src/worker/**` never imports `src/domains/**` except `src/domains/providers`.",
		);
	}
	if (/Domain independence/i.test(context)) {
		pushUnique(
			invariants,
			"Domain independence. `src/domains/<x>/**` never imports `src/domains/<y>/extension.ts` for `y != x`.",
		);
	}
	return invariants.slice(0, 3);
}

function topTwoSegments(path: string): string {
	const dirParts = path.split("/").slice(0, -1);
	if (dirParts.length === 0) return ".";
	return dirParts.slice(0, 2).join("/");
}

function indexedSourceFileCount(codewiki: Codewiki): number {
	return codewiki.files.filter((file) => file.lang !== "config").length;
}

/** Measure how the session compiler will preload the on-disk project context. */
function measureProjectPreload(cwd: string): ProjectPreloadClass {
	const promptContext = renderPromptContext(cwd);
	return classifyProjectPreload({ hasClioMd: promptContext.clioMd !== null, text: promptContext.text });
}

function topCodewikiDirectories(codewiki: Codewiki, limit = 8): string[] {
	const dirCounts = new Map<string, number>();
	for (const file of codewiki.files) {
		if (file.lang === "config") continue;
		const top = topTwoSegments(file.path);
		dirCounts.set(top, (dirCounts.get(top) ?? 0) + 1);
	}
	return [...dirCounts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, limit)
		.map(([dir, count]) => `${dir} (${count})`);
}

function packageScripts(cwd: string): Record<string, string> {
	const pkg = readJsonFile(join(cwd, "package.json"));
	if (typeof pkg !== "object" || pkg === null || Array.isArray(pkg)) return {};
	const scripts = (pkg as Record<string, unknown>).scripts;
	if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) return {};
	const out: Record<string, string> = {};
	for (const [name, command] of Object.entries(scripts)) {
		if (typeof command === "string" && command.trim().length > 0) out[name] = command.trim();
	}
	return out;
}

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/**
 * The command prefix an agent must actually type in this repository. The
 * handbook used to hardcode `npm run`, which is simply wrong in a pnpm, yarn, or
 * bun workspace. A handbook that names a command the repository cannot run is
 * worse than one that names no command at all: the agent runs it, it fails, and
 * the failure looks like the agent's own mistake.
 */
export function packageManager(cwd: string): PackageManager {
	const declared = stringField(readJsonFile(join(cwd, "package.json")), "packageManager")?.split("@")[0];
	if (declared === "pnpm" || declared === "yarn" || declared === "bun" || declared === "npm") return declared;
	if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
	if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
	if (existsSync(join(cwd, "bun.lock")) || existsSync(join(cwd, "bun.lockb"))) return "bun";
	return "npm";
}

/** A script whose command rewrites the tree cannot serve as a verification gate. */
const MUTATING_SCRIPT_RE = /(?:^|\s)--(?:fix|write)(?:\s|$)/;

function verificationSection(cwd: string): ClioMdSection | null {
	const scripts = packageScripts(cwd);
	const pm = packageManager(cwd);
	const hasScript = (name: string) => typeof scripts[name] === "string";
	const command = (name: string) => `\`${pm} run ${name}\``;
	// Prefer a non-mutating `:check` variant. Naming an autofixer as the gate
	// tells the agent to rewrite the working tree instead of judging it, which
	// turns a verification step into an unreviewed diff.
	const gate = (name: string): string | null => {
		if (hasScript(`${name}:check`)) return `${name}:check`;
		return hasScript(name) && !MUTATING_SCRIPT_RE.test(scripts[name] ?? "") ? name : null;
	};
	const lines: string[] = [];
	const baseline = ["typecheck", "lint", "format"]
		.map(gate)
		.filter((name): name is string => name !== null)
		.map(command);
	if (baseline.length > 0) {
		lines.push(`Before handoff, run ${baseline.join(", ")}.`);
	}
	if (hasScript("build")) {
		lines.push(`Run ${command("build")} after CLI, worker, packaging, or generated-dist changes.`);
	}
	const targeted = ["test:contracts", "test:smoke", "check:boundaries"].filter(hasScript).map(command);
	if (targeted.length > 0) {
		lines.push(`Use targeted checks for narrower risk: ${targeted.join(", ")}.`);
	}
	if (hasScript("test")) {
		lines.push(`Run ${command("test")} when behavior crosses domains, tool contracts, smoke flows, or boundaries.`);
	}
	if (hasScript("ci")) {
		lines.push(`Use ${command("ci")} for the full local gate before committing broad or shared behavior changes.`);
	}
	if (lines.length === 0) return null;
	return { title: "Verification expectations", body: lines.join(" ") };
}

const VERIFICATION_SECTION_RE = /\bverification\b/i;

interface ModelGroundingCorpus {
	lower: string;
	indexedPaths: ReadonlySet<string>;
}

/**
 * Everything Scout is allowed to cite: sibling agent-context prose, the existing
 * handbook, every indexed path, every indexed symbol, and every runnable package
 * script rendered the way this repository would type it.
 */
function createModelGroundingCorpus(input: BootstrapGenerateInput): ModelGroundingCorpus {
	let siblingBudget = 64_000;
	const siblingEvidence: string[] = [];
	for (const file of input.siblingFiles) {
		if (siblingBudget <= 0) break;
		const chunk = file.content.slice(0, siblingBudget);
		siblingEvidence.push(chunk);
		siblingBudget -= chunk.length;
	}
	const indexedPaths = new Set(input.codewiki.files.map((file) => file.path));
	const pm = packageManager(input.cwd);
	const scripts = packageScripts(input.cwd);
	const evidence = [
		...siblingEvidence,
		(input.existingClioMdText ?? "").slice(0, 8000),
		input.expectedProjectName ?? "",
		input.projectType,
		[...indexedPaths].join("\n").slice(0, 64_000),
		...Object.entries(scripts).flatMap(([name, command]) => [`${pm} run ${name}`, `${pm} ${name}`, command]),
		input.codewiki.symbols
			.map((symbol) => symbol.name)
			.join("\n")
			.slice(0, 128_000),
	].join("\n");
	return { lower: evidence.toLowerCase(), indexedPaths };
}

const CODE_TOKEN_RE = /`([^`\n]+)`/g;

function groundedToken(token: string, evidence: ModelGroundingCorpus): boolean {
	return evidence.lower.includes(token.toLowerCase()) || evidence.indexedPaths.has(token.replace(/^\.\//, ""));
}

/**
 * Keep a Scout line only when it cites the repository and every citation is real.
 *
 * This used to require the line to be a verbatim member of the sibling-file
 * corpus, which made Scout a copier rather than a reader: in a repository with no
 * sibling agent-context files, and that is exactly the repository `context init`
 * exists for, the corpus held only paths and symbol names, so no sentence could
 * ever match and the model's entire contribution was deleted by construction.
 *
 * The replacement rule is one sentence and strictly more general than the term
 * blacklist it also replaces: a line must contain at least one backticked token,
 * and every backticked token must name a real indexed path, symbol, script, or
 * a string that occurs in the supplied evidence. "A dedicated team owns every
 * change" cites nothing and is dropped. "`src/commands.ts` owns argv parsing and
 * the help text" names a file that exists and survives. An invented command like
 * `npm publish` in a repository with no publish script is dropped even though the
 * rest of the sentence is unremarkable, which was the real failure mode.
 */
function groundedModelBody(body: string, evidence: ModelGroundingCorpus): string {
	const kept: string[] = [];
	let inFence = false;
	for (const rawLine of body.split(/\r?\n/)) {
		const trimmed = rawLine.trim();
		if (trimmed.startsWith("```")) {
			inFence = !inFence;
			continue;
		}
		if (trimmed.length === 0 || /^#{1,6}\s|^---+$/.test(trimmed)) continue;
		// A fenced command block is the single highest-value thing Scout can return,
		// and dropping the fence used to drop the commands with it. Inline the line
		// instead, so it faces the same citation rule as any other line.
		const line = inFence ? `\`${trimmed.replace(/`/g, "")}\`` : trimmed;
		const codeTokens = [...line.matchAll(CODE_TOKEN_RE)]
			.map((match) => match[1]?.trim())
			.filter((token): token is string => token !== undefined && token.length > 0);
		if (codeTokens.length === 0) continue;
		if (!codeTokens.every((token) => groundedToken(token, evidence))) continue;
		if (line.replace(CODE_TOKEN_RE, "").trim().length === 0 && !inFence) continue;
		kept.push(line);
	}
	const bounded: string[] = [];
	let length = 0;
	for (const line of kept) {
		const nextLength = length + (bounded.length > 0 ? 1 : 0) + line.length;
		if (nextLength > 1200) break;
		bounded.push(line);
		length = nextLength;
	}
	return bounded.join("\n").trim();
}

function sanitizeModelSection(section: ClioMdSection, evidence: ModelGroundingCorpus): ClioMdSection | null {
	const body = groundedModelBody(section.body, evidence);
	if (body.length < 40) return null;
	const title = section.title.replace(/\s+/g, " ").trim();
	return title.length > 0 ? { title, body } : null;
}

function stabilizeGeneratedOutput(
	input: BootstrapGenerateInput,
	base: BootstrapStructuredOutput,
	onModelSectionRetained?: () => void,
	groundModelOutput = false,
): BootstrapStructuredOutput {
	const existing = input.existingClioMd;
	const conventions: string[] = [];
	for (const convention of existing?.conventions ?? []) pushUnique(conventions, convention);
	for (const convention of inferConventions(input.cwd, input.projectType, input.siblingFiles)) {
		pushUnique(conventions, convention);
	}
	const invariants: string[] = [];
	for (const invariant of existing?.invariants ?? []) pushUnique(invariants, invariant);
	for (const invariant of inferInvariants(input.siblingFiles)) pushUnique(invariants, invariant);

	const verification = verificationSection(input.cwd);
	const inferredSections = inferHeuristicSections(input);
	const existingSections = existing?.sections ?? [];
	const ordinarySections: ClioMdSection[] = [];
	const modelSections = new Set<ClioMdSection>();
	const seenSectionTitles = new Set<string>();
	const addSection = (section: ClioMdSection): boolean => {
		if (VERIFICATION_SECTION_RE.test(section.title)) return false;
		const titleKey = section.title.replace(/\s+/g, " ").trim().toLowerCase();
		if (seenSectionTitles.has(titleKey)) return false;
		seenSectionTitles.add(titleKey);
		ordinarySections.push(section);
		return true;
	};
	for (const section of existing ? [...existingSections, ...inferredSections] : inferredSections) addSection(section);
	const groundingCorpus = groundModelOutput ? createModelGroundingCorpus(input) : null;
	for (const section of base.sections ?? []) {
		const sanitized = groundingCorpus ? sanitizeModelSection(section, groundingCorpus) : section;
		if (sanitized && addSection(sanitized)) modelSections.add(sanitized);
	}
	const ordinaryLimit = verification ? 6 : 7;
	const retainedOrdinarySections = ordinarySections.slice(0, ordinaryLimit);
	for (const section of retainedOrdinarySections) {
		if (modelSections.has(section)) onModelSectionRetained?.();
	}
	return {
		...base,
		projectName: existing?.projectName ?? projectName(input.cwd),
		identity: existing?.identity ?? defaultIdentity(input.cwd, input.projectType, input.siblingFiles),
		conventions: conventions.slice(0, 6),
		invariants: invariants.slice(0, 3),
		sections: [...retainedOrdinarySections, ...(verification ? [verification] : [])],
	};
}

/**
 * The handbook sections whose every fact is read straight off the codewiki index:
 * how many files it holds, which modules anchor it, where the mass sits. They are
 * the only sections nothing but the index can author, and equally the only ones
 * that are wrong the moment the tree moves, so `context refresh` re-derives them
 * in place and leaves every other section to its human or model author.
 */
export function codewikiSections(codewiki: Codewiki): ClioMdSection[] {
	const sections: ClioMdSection[] = [];
	const entryPoints = codewikiEntryPoints(codewiki, 8);
	const indexedCount = indexedSourceFileCount(codewiki);
	if (entryPoints.length > 0) {
		sections.push({
			title: "Context retrieval",
			body: [
				`The codewiki currently indexes ${indexedCount} source file${indexedCount === 1 ? "" : "s"}.`,
				`Start orientation with these indexed entry points: ${entryPoints.map((entry) => `\`${entry}\``).join(", ")}.`,
				"Use `code_nav` (modes: symbol, path, entries, outline, deps, dependents, wiki) before broad reads when the task is navigational.",
			].join(" "),
		});
	}
	const topDirs = topCodewikiDirectories(codewiki);
	if (topDirs.length > 0) {
		sections.push({
			title: "Repository shape",
			body: [
				`Largest indexed areas: ${topDirs.join(", ")}.`,
				"Treat this as an orientation hint, not a complete file map; refresh the codewiki after structural edits.",
			].join(" "),
		});
	}
	return sections;
}

function inferHeuristicSections(input: BootstrapGenerateInput): ClioMdSection[] {
	const sections: ClioMdSection[] = [...codewikiSections(input.codewiki)];
	const invariants = inferInvariants(input.siblingFiles);
	if (invariants.length > 0) {
		sections.push({
			title: "Architecture boundaries",
			body: invariants.map((item) => `- ${item}`).join("\n"),
		});
	}
	if (input.adoption.sources.length > 0) {
		const sourceNames = input.adoption.sources
			.map((source) => `\`${source.displayPath}\``)
			.slice(0, 8)
			.join(", ");
		sections.push({
			title: "Agent context interop",
			body: [
				`Bootstrap scanned ${input.adoption.sources.length} sibling context source${input.adoption.sources.length === 1 ? "" : "s"}: ${sourceNames}${input.adoption.sources.length > 8 ? ", ..." : ""}.`,
				"Run `clio context init --adopt` to refresh the managed provenance section when those sources change.",
			].join(" "),
		});
	}
	return sections.slice(0, 6);
}

/**
 * Deterministic CLIO.md generator. Distills identity, conventions, and invariants
 * from sibling agent-context files and package metadata without a model. Used as
 * the offline path and as the fallback when model-driven generation is
 * unavailable or fails.
 */
function heuristicBootstrapOutputSync(input: BootstrapGenerateInput): BootstrapStructuredOutput {
	return stabilizeGeneratedOutput(input, {
		projectName: projectName(input.cwd),
		identity: defaultIdentity(input.cwd, input.projectType, input.siblingFiles),
		conventions: inferConventions(input.cwd, input.projectType, input.siblingFiles),
		invariants: inferInvariants(input.siblingFiles),
		sections: inferHeuristicSections(input),
	});
}

export const heuristicBootstrapOutput: BootstrapGenerate = heuristicBootstrapOutputSync;

function bootstrapOutputFromParsed(parsed: ParsedClioMd): BootstrapStructuredOutput {
	const out: BootstrapStructuredOutput = {
		projectName: parsed.projectName,
		identity: parsed.identity,
		conventions: [...parsed.conventions],
		invariants: [...parsed.invariants],
	};
	if (parsed.sections.length > 0) {
		out.sections = parsed.sections.map((section) => ({ title: section.title, body: section.body }));
	}
	if (parsed.importedAgentContext) out.importedAgentContext = parsed.importedAgentContext;
	return out;
}

export function existingClioMdBootstrapOutput(cwd: string): BootstrapStructuredOutput | null {
	const parsed = tryReadClioMd(cwd);
	if (!parsed?.ok) return null;
	return bootstrapOutputFromParsed(parsed.value);
}

export function fallbackBootstrapOutput(input: BootstrapGenerateInput): BootstrapFallbackResult {
	const existing = input.existingClioMd
		? bootstrapOutputFromParsed(input.existingClioMd)
		: existingClioMdBootstrapOutput(input.cwd);
	if (existing) return { mode: "existing", output: existing };
	return { mode: "heuristic", output: heuristicBootstrapOutputSync(input) };
}

function readExistingClioMdText(cwd: string): string | null {
	try {
		return readFileSync(join(cwd, "CLIO.md"), "utf8");
	} catch {
		return null;
	}
}

function replaceImportedAgentContext(
	output: BootstrapStructuredOutput,
	importedAgentContext: string,
): BootstrapStructuredOutput {
	const { importedAgentContext: _old, ...rest } = output;
	if (importedAgentContext.length === 0) return rest;
	return { ...rest, importedAgentContext };
}

function loadBootstrapSiblingFiles(adoption: AdoptionScanResult): SiblingContextFile[] {
	return adoption.sources.map((source) => ({
		source: source.scope,
		path: source.path,
		content: source.content,
	}));
}

function gitStatus(cwd: string): string {
	try {
		return execFileSync("git", ["status", "--short"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return "";
	}
}

function countStatusLines(status: string): number {
	return status
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean).length;
}

function basenameList(paths: ReadonlyArray<string>): string {
	const names = paths.map((path) => parse(path).base).sort((a, b) => a.localeCompare(b));
	if (names.length === 0) return "";
	if (names.length <= 3) return names.join(", ");
	return `${names.slice(0, 3).join(", ")} +${names.length - 3}`;
}

function formatAdoptionLine(summary: RunBootstrapSummary): string | null {
	const adoption = summary.adoption;
	const shouldRender =
		summary.action === "previewed" ||
		adoption.mode === "adopt" ||
		adoption.globalSourceCount > 0 ||
		adoption.conflictCount > 0 ||
		adoption.rejectedCount > 0;
	if (!shouldRender) return null;
	const global = adoption.includeGlobal ? `${adoption.globalSourceCount} global` : "global off";
	const verb = adoption.mode === "adopt" ? "imported" : "scanned";
	return `  adoption ${verb} ${adoption.sourceCount} source${adoption.sourceCount === 1 ? "" : "s"} (${adoption.projectSourceCount} project, ${global}); ${adoption.importedRuleCount} candidate rule${adoption.importedRuleCount === 1 ? "" : "s"}; ${adoption.conflictCount} conflict${adoption.conflictCount === 1 ? "" : "s"}; ${adoption.rejectedCount} rejected`;
}

function formatBootstrapSummary(summary: RunBootstrapSummary): string {
	const contextLine =
		summary.contextFileCount > 0
			? `folded ${summary.contextFileCount} context file${summary.contextFileCount === 1 ? "" : "s"} (${basenameList(summary.contextFileNames)})`
			: "no sibling context files found";
	const dirtyLine =
		summary.dirtyFiles === 0
			? "workspace clean"
			: `workspace has ${summary.dirtyFiles} dirty file${summary.dirtyFiles === 1 ? "" : "s"}`;
	if (summary.action === "previewed") {
		const adoptionLine = formatAdoptionLine(summary);
		return [
			"clio context init preview",
			`  ${contextLine}; codewiki would index ${summary.codewikiEntries} entr${summary.codewikiEntries === 1 ? "y" : "ies"}; ${dirtyLine}; no files written`,
			...(adoptionLine ? [adoptionLine] : []),
			"",
		].join("\n");
	}
	const adoptionLine = formatAdoptionLine(summary);
	const proposalLine = summary.proposalPath ? `  proposal written ${summary.proposalPath}` : null;
	if (summary.action === "preserved") {
		return [
			"clio context init preserved CLIO.md",
			`  ${contextLine}; codewiki rebuilt ${summary.codewikiEntries} entr${summary.codewikiEntries === 1 ? "y" : "ies"}; state refreshed; ${dirtyLine}`,
			"  CLIO.md is treated as human-owned. Use --apply to replace it with a generated draft, --propose to write an ignored proposal, or --adopt to refresh only imported agent context.",
			...(adoptionLine ? [adoptionLine] : []),
			"",
		].join("\n");
	}
	if (summary.action === "proposed") {
		return [
			"clio context init proposed CLIO.md",
			`  ${contextLine}; codewiki rebuilt ${summary.codewikiEntries} entr${summary.codewikiEntries === 1 ? "y" : "ies"}; state refreshed; ${dirtyLine}`,
			...(proposalLine ? [proposalLine] : []),
			"  CLIO.md was not changed. Re-run with --apply only after reviewing the proposal.",
			...(adoptionLine ? [adoptionLine] : []),
			"",
		].join("\n");
	}
	return [
		`clio context init ${summary.action} CLIO.md`,
		`  ${contextLine}; codewiki rebuilt ${summary.codewikiEntries} entr${summary.codewikiEntries === 1 ? "y" : "ies"}; state refreshed; ${dirtyLine}`,
		"  git policy: .clio/ stays ignored by default; CLIO.md stays versioned and human-owned. Force-add .clio assets only when you explicitly intend to share them.",
		...(proposalLine ? [proposalLine] : []),
		...(adoptionLine ? [adoptionLine] : []),
		"",
	].join("\n");
}

const CLIO_GITIGNORE_LINE = ".clio/";
const CLIO_GITIGNORE_DYNAMIC_LINES = new Set<string>([".clio/codewiki.json", ".clio/state.json", ".clio/handoffs/"]);

function normalizedGitignoreLines(content: string): string[] {
	return content.split(/\r?\n/).map((line) => line.trim());
}

function hasBlanketClioIgnore(content: string): boolean {
	return normalizedGitignoreLines(content).some(isBlanketClioIgnoreLine);
}

function isBlanketClioIgnoreLine(line: string): boolean {
	if (line.length === 0 || line.startsWith("#") || line.startsWith("!")) return false;
	return /^(?:\/|\*\*\/)?\.clio(?:\/|\/\*|\/\*\*)?$/.test(line);
}

function hasDynamicOnlyClioIgnore(content: string): boolean {
	const lines = new Set(normalizedGitignoreLines(content));
	for (const line of CLIO_GITIGNORE_DYNAMIC_LINES) {
		if (!lines.has(line)) return false;
	}
	return true;
}

function migrateClioGitignore(content: string): string {
	const lines = content.split(/\r?\n/);
	const kept = lines.filter((line) => {
		const trimmed = line.trim();
		return !isBlanketClioIgnoreLine(trimmed) && !CLIO_GITIGNORE_DYNAMIC_LINES.has(trimmed);
	});
	while (kept.length > 0 && kept[kept.length - 1]?.trim() === "") kept.pop();
	const prefix = kept.length > 0 ? [...kept, ""] : [];
	return `${[...prefix, CLIO_GITIGNORE_LINE].join("\n")}\n`;
}

async function ensureGitignore(cwd: string, input: RunBootstrapInput): Promise<void> {
	const gitignorePath = join(cwd, ".gitignore");
	let content = "";
	try {
		content = readFileSync(gitignorePath, "utf8");
	} catch {
		content = "";
	}
	if (hasBlanketClioIgnore(content)) {
		if (hasDynamicOnlyClioIgnore(content)) writeFileSync(gitignorePath, migrateClioGitignore(content), "utf8");
		return;
	}
	if (hasDynamicOnlyClioIgnore(content)) {
		writeFileSync(gitignorePath, migrateClioGitignore(content), "utf8");
		return;
	}
	const confirmed = input.confirmGitignore ? await input.confirmGitignore() : false;
	if (!confirmed) {
		warn(
			input.io,
			"clio context init: .gitignore does not ignore .clio/; local context, skills, agents, and handoffs may leak into commits.\n",
		);
		return;
	}
	writeFileSync(gitignorePath, migrateClioGitignore(content), "utf8");
}

function serializeBootstrapOutput(output: BootstrapStructuredOutput): string {
	return serializeClioMd({ ...output, fingerprint: null });
}

function writeClioMdFile(cwd: string, output: BootstrapStructuredOutput): string {
	const clioMdPath = join(cwd, "CLIO.md");
	mkdirSync(dirname(clioMdPath), { recursive: true });
	const serialized = serializeBootstrapOutput(output);
	const parsed = parseClioMd(serialized);
	if (!parsed.ok) throw new Error(`bootstrap produced invalid CLIO.md: ${parsed.errors.join("; ")}`);
	writeFileSync(clioMdPath, serialized, "utf8");
	return clioMdPath;
}

function timestampForPath(now: Date): string {
	return now
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "Z");
}

function writeClioMdProposal(cwd: string, now: Date, output: BootstrapStructuredOutput): string {
	const dir = join(cwd, ".clio", "proposals");
	mkdirSync(dir, { recursive: true });
	const proposalPath = join(dir, `CLIO-${timestampForPath(now)}.md`);
	writeFileSync(proposalPath, serializeBootstrapOutput(output), "utf8");
	return proposalPath;
}

function boundedStateString(value: string | undefined, maxChars: number): string | undefined {
	if (value === undefined) return undefined;
	const bounded = value.replace(/\s+/g, " ").trim().slice(0, maxChars);
	return bounded.length > 0 ? bounded : undefined;
}

function safeStateCounter(value: number | undefined): number | undefined {
	return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function durableGenerationTelemetry(telemetry: BootstrapGenerationTelemetry): BootstrapGenerationState {
	const state: BootstrapGenerationState = {
		mode: telemetry.mode,
		parserOutcome: telemetry.parserOutcome,
	};
	const fallbackReason = boundedStateString(telemetry.fallbackReason, 500);
	if (fallbackReason) state.fallbackReason = fallbackReason;
	const scout = telemetry.scout;
	if (!scout) return state;
	state.structuredOutputMode = scout.structuredOutputMode;
	for (const [key, value] of [
		["runId", scout.runId],
		["targetId", scout.targetId],
		["wireModelId", scout.wireModelId],
		["runtimeId", scout.runtimeId],
		["runtimeKind", scout.runtimeKind],
		["thinkingLevel", scout.thinkingLevel],
	] as const) {
		const bounded = boundedStateString(value, 512);
		if (bounded) state[key] = bounded;
	}
	for (const [key, value] of [
		["tokenCount", scout.tokens?.total],
		["toolCalls", scout.toolCalls],
		["durationMs", scout.durationMs],
		["promptBytes", scout.promptBytes],
		["outputBytes", scout.outputBytes],
	] as const) {
		const counter = safeStateCounter(value);
		if (counter !== undefined) state[key] = counter;
	}
	return state;
}

function writeProjectState(
	cwd: string,
	projectType: ProjectType,
	now: Date,
	indexedAt: string,
	adoption: AdoptionScanResult,
	recordAdoption: boolean,
	codewikiVersion: number,
	generation: BootstrapGenerationTelemetry,
	generated: boolean,
): string {
	const finalFingerprint = computeFingerprint(cwd);
	const statePath = resolveStatePath(cwd);
	const prev = readClioState(cwd);
	// lastBootstrap describes how the CLIO.md on disk was produced, not what the
	// most recent run happened to do. A run that generated nothing leaves the
	// handbook untouched, so overwriting a recorded `scout` provenance with
	// `existing` would claim the handbook has no model authorship behind it.
	const lastBootstrap = generated
		? durableGenerationTelemetry(generation)
		: (prev?.lastBootstrap ?? durableGenerationTelemetry(generation));
	const contextSources = recordAdoption ? adoption.sourceSnapshots : prev?.contextSources;
	const contextSourceHash = contextSources ? adoptionSnapshotsHash(contextSources) : undefined;
	writeClioState(cwd, {
		version: 1,
		projectType,
		fingerprint: finalFingerprint,
		codewikiVersion,
		lastInitAt: now.toISOString(),
		lastSessionAt: now.toISOString(),
		lastIndexedAt: indexedAt,
		lastBootstrap,
		...(contextSources ? { contextSources } : {}),
		...(contextSourceHash ? { contextSourceHash } : {}),
	});
	return statePath;
}

/**
 * Publish the deterministic index before Scout runs so a worker-side code_nav
 * call reuses this build instead of demand-building the same repository again.
 * This is an index checkpoint, not a completed init: lastInitAt remains unchanged
 * until CLIO.md handling succeeds below.
 */
function persistCodewikiForGeneration(
	cwd: string,
	projectType: ProjectType,
	indexedAt: string,
	codewiki: Codewiki,
): void {
	writeCodewiki(cwd, codewiki);
	const prev = readClioState(cwd);
	writeClioState(cwd, {
		version: 1,
		projectType,
		fingerprint: computeFingerprint(cwd, codewiki),
		codewikiVersion: codewiki.version,
		...(prev?.contextSources ? { contextSources: prev.contextSources } : {}),
		...(prev?.contextSourceHash ? { contextSourceHash: prev.contextSourceHash } : {}),
		...(prev?.lastInitAt ? { lastInitAt: prev.lastInitAt } : {}),
		...(prev?.lastBootstrap ? { lastBootstrap: prev.lastBootstrap } : {}),
		lastSessionAt: prev?.lastSessionAt ?? indexedAt,
		lastIndexedAt: indexedAt,
	});
}

function summarizeAdoption(
	adoption: AdoptionScanResult,
	mode: RunBootstrapAdoptionSummary["mode"],
): RunBootstrapAdoptionSummary {
	let projectSourceCount = 0;
	let globalSourceCount = 0;
	for (const source of adoption.sources) {
		if (source.scope === "global") globalSourceCount += 1;
		else projectSourceCount += 1;
	}
	return {
		mode,
		sourceCount: adoption.sources.length,
		projectSourceCount,
		globalSourceCount,
		importedRuleCount: adoption.importedRules.length,
		conflictCount: adoption.conflicts.length,
		rejectedCount: adoption.rejected.length,
		includeGlobal: adoption.includeGlobal,
	};
}

/**
 * Top entry-point modules from the codewiki, used to orient a fresh session.
 * Entries the indexer tagged as "entry point" come first; otherwise the most
 * imported modules (highest in-degree) stand in as the structural anchors.
 */
function codewikiEntryPoints(codewiki: Codewiki, limit = 6): string[] {
	const fileById = new Map(codewiki.files.map((file) => [file.id, file] as const));
	const tagged = codewiki.files
		.filter((file) => file.lang !== "config" && file.role === "entry")
		.map((file) => file.path)
		.sort((a, b) => a.localeCompare(b));
	if (tagged.length >= limit) return tagged.slice(0, limit);
	const inDegree = new Map<string, number>();
	for (const edge of codewiki.edges) {
		if (!("toFileId" in edge)) continue;
		inDegree.set(edge.toFileId, (inDegree.get(edge.toFileId) ?? 0) + 1);
	}
	const ranked = [...inDegree.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([fileId]) => fileById.get(fileId)?.path)
		.filter((path): path is string => typeof path === "string")
		.filter((path) => !tagged.includes(path));
	return [...tagged, ...ranked].slice(0, limit);
}

export async function runBootstrap(input: RunBootstrapInput = {}): Promise<RunBootstrapResult> {
	const cwd = input.cwd ?? process.cwd();
	const projectType = detectProjectType(cwd);
	progress(input, {
		phase: "scan",
		status: "started",
		message: "scanning project and sibling agent context",
		detail: projectType,
	});
	const adoption = scanAgentConfigs({
		cwd,
		...(input.homeDir ? { homeDir: input.homeDir } : {}),
		includeGlobal: input.includeGlobalImports === true,
	});
	const siblingFiles = loadBootstrapSiblingFiles(adoption);
	progress(input, {
		phase: "scan",
		status: "completed",
		message:
			siblingFiles.length === 0
				? "no sibling context files found"
				: `folded ${siblingFiles.length} sibling context file${siblingFiles.length === 1 ? "" : "s"}`,
		current: siblingFiles.length,
		total: siblingFiles.length,
	});
	const now = input.now?.() ?? new Date();
	const indexedAt = now.toISOString();
	// Index the repository before generation so the generator can ground CLIO.md
	// in the real structure (entry points, key modules), not just sibling prose.
	progress(input, { phase: "codewiki", status: "started", message: "building codewiki index" });
	const codewiki = await buildCodewiki({ cwd, language: projectType, generatedAt: indexedAt });
	const codewikiEntryCount = indexedSourceFileCount(codewiki);
	progress(input, {
		phase: "codewiki",
		status: "completed",
		message: `indexed ${codewikiEntryCount} source file${codewikiEntryCount === 1 ? "" : "s"}`,
		current: codewikiEntryCount,
		total: codewikiEntryCount,
	});
	if (input.preview !== true) {
		await ensureGitignore(cwd, input);
		persistCodewikiForGeneration(cwd, projectType, indexedAt, codewiki);
	}
	const hadClioMd = existsSync(join(cwd, "CLIO.md"));
	const useExistingClioMdAsSource = hadClioMd && input.rewriteClioMd !== true;
	const existingClioMdText = useExistingClioMdAsSource ? readExistingClioMdText(cwd) : null;
	const existingClioMd = useExistingClioMdAsSource ? tryReadClioMd(cwd) : null;
	const existingParsed = existingClioMd?.ok ? existingClioMd.value : undefined;
	const replaceClioMd = input.applyClioMd === true || input.rewriteClioMd === true;
	if (
		input.adopt === true &&
		input.preview !== true &&
		hadClioMd &&
		!existingParsed &&
		!replaceClioMd &&
		input.proposeClioMd !== true
	) {
		const detail = existingClioMd && !existingClioMd.ok ? ` (${existingClioMd.error})` : "";
		throw new Error(
			`cannot refresh Imported agent context because CLIO.md is malformed${detail}; use --apply or --rewrite after reviewing the handbook`,
		);
	}
	// A supplied generator *is* the request to generate: both entry points
	// withhold `generate` for --heuristic and --preview and supply it otherwise.
	// An existing CLIO.md used to suppress generation entirely, so a plain
	// `clio context init` on an initialized repository dispatched nothing, wrote
	// `lastBootstrap.mode: "existing"`, and looked identical to a run that had no
	// route at all. The handbook still reaches the generator as source (see
	// `useExistingClioMdAsSource`), so this refreshes rather than replaces.
	const shouldGenerate = !hadClioMd || replaceClioMd || input.proposeClioMd === true || input.generate !== undefined;
	let output: BootstrapStructuredOutput;
	let generation: BootstrapGenerationTelemetry = {
		mode: shouldGenerate ? "heuristic" : existingParsed ? "existing" : "heuristic",
		parserOutcome: "not-run",
	};
	let reportedGeneration: BootstrapGenerationTelemetry | undefined;
	const reportGeneration: BootstrapGenerationSink = (reported) => {
		if (reportedGeneration === undefined) reportedGeneration = reported;
	};
	if (shouldGenerate) {
		progress(input, {
			phase: "generate",
			status: "started",
			message: input.generate ? "drafting CLIO.md with scout" : "drafting CLIO.md with heuristic",
		});
		output = await (input.generate ?? heuristicBootstrapOutput)({
			cwd,
			expectedProjectName: projectName(cwd),
			projectType,
			siblingFiles,
			adoption,
			codewiki,
			...(existingParsed ? { existingClioMd: existingParsed } : {}),
			...(existingClioMdText ? { existingClioMdText } : {}),
			...(input.onProgress ? { progress: input.onProgress } : {}),
			reportGeneration,
		});
		generation = reportedGeneration ?? generation;
		let retainedModelSections = 0;
		output = stabilizeGeneratedOutput(
			{
				cwd,
				expectedProjectName: projectName(cwd),
				projectType,
				siblingFiles,
				adoption,
				codewiki,
				...(existingParsed ? { existingClioMd: existingParsed } : {}),
				...(existingClioMdText ? { existingClioMdText } : {}),
			},
			output,
			() => {
				retainedModelSections += 1;
			},
			generation.mode === "scout",
		);
		if (generation.mode === "scout" && retainedModelSections === 0) {
			generation = {
				...generation,
				mode: "heuristic",
				fallbackReason: "Scout draft contributed no evidence-grounded custom sections",
			};
		}
		progress(input, {
			phase: "generate",
			status: "completed",
			message: `${output.projectName}: ${output.sections?.length ?? 0} custom section${(output.sections?.length ?? 0) === 1 ? "" : "s"}`,
			detail: `${generation.mode}; parser=${generation.parserOutcome}`,
		});
	} else {
		output = existingParsed
			? bootstrapOutputFromParsed(existingParsed)
			: await heuristicBootstrapOutput({ cwd, projectType, siblingFiles, adoption, codewiki });
		progress(input, {
			phase: "generate",
			status: "completed",
			message: hadClioMd ? "preserving existing CLIO.md; no generated rewrite requested" : "using heuristic CLIO.md draft",
		});
	}
	if (input.adopt === true) {
		output = replaceImportedAgentContext(output, renderImportedAgentContext(adoption));
	}
	const readNames = siblingFiles.map((file) => file.path).sort((a, b) => a.localeCompare(b));
	const previewStatus = gitStatus(cwd);
	if (input.preview === true) {
		progress(input, { phase: "clio-md", status: "completed", message: "preview ready; no files written" });
		const summary: RunBootstrapSummary = {
			action: "previewed",
			contextFileCount: readNames.length,
			contextFileNames: readNames,
			codewikiEntries: codewikiEntryCount,
			dirtyFiles: countStatusLines(previewStatus),
			adoption: summarizeAdoption(adoption, "preview"),
		};
		out(input.io, formatBootstrapSummary(summary));
		return {
			clioMdPath: join(cwd, "CLIO.md"),
			statePath: resolveStatePath(cwd),
			siblingFiles,
			output,
			projectType,
			summary,
			adoption,
			telemetry: { generation },
			preload: measureProjectPreload(cwd),
		};
	}

	let clioMdPath = join(cwd, "CLIO.md");
	let proposalPath: string | undefined;
	let action: RunBootstrapSummary["action"] = "preserved";
	progress(input, {
		phase: "clio-md",
		status: "started",
		message: hadClioMd ? "preserving CLIO.md" : "writing CLIO.md",
	});
	if (!hadClioMd) {
		clioMdPath = writeClioMdFile(cwd, output);
		action = "wrote";
	} else if (replaceClioMd) {
		clioMdPath = writeClioMdFile(cwd, output);
		action = "refreshed";
	} else if (input.adopt === true && existingParsed) {
		clioMdPath = writeClioMdFile(cwd, output);
		action = "refreshed";
	} else if (input.proposeClioMd === true) {
		proposalPath = writeClioMdProposal(cwd, now, output);
		action = "proposed";
	}
	progress(input, {
		phase: "clio-md",
		status: "completed",
		message:
			action === "wrote"
				? "CLIO.md written"
				: action === "refreshed"
					? "CLIO.md refreshed"
					: action === "proposed"
						? "CLIO.md proposal written"
						: "CLIO.md preserved",
		detail: proposalPath ?? clioMdPath,
	});
	const adoptionApplied = input.adopt === true && (action === "wrote" || action === "refreshed");
	progress(input, { phase: "state", status: "started", message: "persisting codewiki and project state" });
	const statePath = writeProjectState(
		cwd,
		projectType,
		now,
		indexedAt,
		adoption,
		adoptionApplied,
		codewiki.version,
		generation,
		shouldGenerate,
	);
	progress(input, {
		phase: "state",
		status: "completed",
		message: `state updated; ${codewikiEntryCount} codewiki entr${codewikiEntryCount === 1 ? "y" : "ies"}`,
	});

	const postStatus = gitStatus(cwd);
	const summary: RunBootstrapSummary = {
		action,
		contextFileCount: readNames.length,
		contextFileNames: readNames,
		codewikiEntries: codewikiEntryCount,
		dirtyFiles: countStatusLines(postStatus),
		adoption: summarizeAdoption(adoption, adoptionApplied ? "adopt" : "scan"),
		...(proposalPath ? { proposalPath } : {}),
	};
	out(input.io, formatBootstrapSummary(summary));
	const preload = measureProjectPreload(cwd);
	out(input.io, `  preload: ${preload.label}\n`);
	if (preload.mode === "full" && preload.nearLimit) {
		warn(
			input.io,
			`  warning: project context is within 10% of the preload limit (${preload.chars} chars of 8000, ${preload.lines} lines of 220); the next growth may flip it to a synopsis\n`,
		);
	}
	progress(input, {
		phase: "done",
		status: "completed",
		message: `${summary.action} CLIO.md; ${summary.dirtyFiles} dirty file${summary.dirtyFiles === 1 ? "" : "s"}; preload: ${preload.label}`,
	});
	return {
		clioMdPath,
		statePath,
		siblingFiles,
		output,
		projectType,
		summary,
		adoption,
		telemetry: { generation },
		preload,
	};
}

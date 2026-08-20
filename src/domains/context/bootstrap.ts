import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import type { ContextActivityPayload } from "../../core/bus-events.js";
import { classifyProjectPreload, type ProjectPreloadClass } from "../prompts/preload.js";
import { detectProjectType, type ProjectType } from "../session/workspace/project-type.js";
import {
	type AdoptionScanResult,
	adoptionSnapshotsHash,
	RULE_KEYWORDS,
	renderImportedAgentContext,
	scanAgentConfigs,
} from "./adoption.js";
import { type ClioMdSection, type ParsedClioMd, parseClioMd, serializeClioMd, tryReadClioMd } from "./clio-md.js";
import { buildCodewikiCandidate, coordinateCodewikiWrite } from "./codewiki/coordinator.js";
import type { Codewiki } from "./codewiki/schema.js";
import type { Fingerprint } from "./fingerprint.js";
import { type ProjectMetadata, readProjectMetadata } from "./project-metadata.js";
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
 * Input handed to a CLIO-CODER.md generator. Carries the adoption scan plus the freshly
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

export interface BootstrapRunTelemetry {
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
	run?: BootstrapRunTelemetry;
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

/**
 * A name a manifest chose is already the project's own spelling; a name read
 * off a package identifier or a directory is a slug that has to be titled.
 */
function projectNameFrom(metadata: ProjectMetadata, cwd: string): string {
	const declared = metadata.name;
	if (declared) {
		return metadata.nameSource === "package.json" ? titleFromPackageName(declared) : declared.slice(0, 80);
	}
	return titleFromPackageName(parse(cwd).base || "Project");
}

function projectName(cwd: string): string {
	return projectNameFrom(readProjectMetadata(cwd), cwd);
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

interface DeterministicIdentity {
	/** The identity sentence the deterministic path produces. */
	text: string;
	/**
	 * True when nothing but the project name and the stack label reached the
	 * sentence, so `text` is the bare `<name> is a <stack> project.` template.
	 * That happens only when no manifest, no research metadata, and no README
	 * variant in this repository describes it at all. The flag is what decides
	 * whether a model-authored identity is allowed to win, so the caller never
	 * has to pattern-match the rendering.
	 */
	bare: boolean;
	/** Repo-relative file the description came from, or null when bare. */
	descriptionSource: string | null;
}

function resolveDefaultIdentity(
	cwd: string,
	projectType: ProjectType,
	files: ReadonlyArray<SiblingContextFile>,
): DeterministicIdentity {
	const metadata = readProjectMetadata(cwd);
	const name = projectNameFrom(metadata, cwd);
	const context = allContextText(files);
	if (/Clio owns the agent loop/i.test(context) && /pi-(?:ai|SDK)/i.test(context)) {
		return {
			text: [
				"Clio Coder is IOWarp's orchestrator coding agent, named for the Greek muse of history and developed by the Gnosis Research Center at Illinois Tech (github.com/grc-iit, @grc-iit) and the IOWarp team. CLIO stands for Context Layer for Input/Output.",
				"pi-ai is accessed through the engine boundary.",
				"Clio owns the agent loop, TUI, session format, tool registry, and identity.",
			].join(" "),
			bare: false,
			descriptionSource: null,
		};
	}
	const stack = projectTypeLabel(projectType);
	const head = `${name} is a ${stack} project.`;
	const description = metadata.description;
	if (!description) return { text: head.slice(0, 600), bare: true, descriptionSource: null };
	const cleaned = description.replace(/\.$/, "").trim();
	const role = /^[a-z]/.test(cleaned) ? `It is ${cleaned}.` : `${cleaned}.`;
	return { text: `${head} ${role}`.slice(0, 600), bare: false, descriptionSource: metadata.descriptionSource };
}

/**
 * Identity precedence for a stabilized handbook, below an existing `CLIO-CODER.md`
 * identity, which always wins. The deterministic sentence is evidence read off
 * the repository, so it outranks anything the model wrote. The single exception
 * is the bare case: with no `package.json` description and no `README.md`
 * summary the deterministic path can only say `<name> is a <stack> project.`,
 * which tells a reader nothing the directory name did not. A model sentence is
 * strictly better than that, and only than that.
 */
function stabilizedIdentity(input: BootstrapGenerateInput, modelIdentity: unknown): string {
	const deterministic = resolveDefaultIdentity(input.cwd, input.projectType, input.siblingFiles);
	const model = typeof modelIdentity === "string" ? modelIdentity.trim() : "";
	if (deterministic.bare && model.length > 0) return model;
	return deterministic.text;
}

function pushUnique(target: string[], value: string): void {
	if (target.includes(value)) return;
	target.push(value);
}

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

/**
 * The extension local imports actually carry, measured from the specifiers the
 * indexer already extracted. Reported only on a clear majority so a repository
 * mid-migration is described as having no rule rather than the wrong one.
 */
function localImportExtension(codewiki: Codewiki): string | null {
	const counts = new Map<string, number>();
	let total = 0;
	for (const file of codewiki.files) {
		for (const specifier of file.imports) {
			if (!specifier.startsWith(".")) continue;
			total += 1;
			const extension = /\.([A-Za-z0-9]+)$/.exec(specifier)?.[1];
			const key = extension === undefined ? "" : `.${extension}`;
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
	}
	if (total < 4) return null;
	for (const [extension, count] of counts) {
		if (extension.length > 0 && count / total >= 0.8) return extension;
	}
	return null;
}

function inferConventions(cwd: string, files: ReadonlyArray<SiblingContextFile>, codewiki: Codewiki): string[] {
	const conventions: string[] = [];
	const context = allContextText(files);
	const pkg = readJsonFile(join(cwd, "package.json"));
	const packageText = typeof pkg === "object" && pkg !== null ? JSON.stringify(pkg) : "";
	// A convention here is read as fact on every turn, so it is measured or it
	// is not stated. The stack alone decides nothing: a repository that imports
	// `./money.ts` under allowImportingTsExtensions is told to break its own
	// build by a rule inferred from the presence of a tsconfig.
	const declaredJs = /Local imports end in `?\.js`?/i.test(context);
	const importExtension = declaredJs ? ".js" : localImportExtension(codewiki);
	if (importExtension !== null) {
		pushUnique(conventions, `Local imports end in \`${importExtension}\`.`);
	}
	if (/node:test/i.test(context) || /node --import tsx --test|node --test/.test(packageText)) {
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

function indexedSourceFileCount(codewiki: Codewiki): number {
	return codewiki.files.filter((file) => file.lang !== "config").length;
}

/** Measure how the session compiler will preload the on-disk project context. */
function measureProjectPreload(cwd: string): ProjectPreloadClass {
	const promptContext = renderPromptContext(cwd);
	return classifyProjectPreload({ hasClioMd: promptContext.clioMd !== null, text: promptContext.text });
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

/**
 * A citation anchored to a location: `src/cart.ts:26`, `src/cart.ts:40-42`, or
 * `src/cart.ts:26:8`. The codewiki digest handed to the model prints its key
 * symbols in exactly this form, so this is the shape a model that read the
 * evidence writes back.
 */
const CITED_LOCATION_RE = /^(.*[^:]):(\d+)(?:[-:]\d+)?$/;

/** A symbol written as a call: `priceCart()`. */
const CITED_CALL_RE = /^(.+?)\(\s*\)$/;

function groundedName(token: string, evidence: ModelGroundingCorpus): boolean {
	return evidence.lower.includes(token.toLowerCase()) || evidence.indexedPaths.has(token.replace(/^\.\//, ""));
}

/**
 * The names a citation carries under its decoration. The corpus holds paths,
 * symbol names, and scripts, so a token that adds a file offset or call parens
 * to one of them cannot match it whole, and requiring the whole token to match
 * deleted precisely the lines that had done the most reading. A Gotchas section
 * whose five bullets each named a real file and line lost all five and
 * vanished; the run after that lost every line that wrote `priceCart()` for the
 * symbol `priceCart`. Peeling the decoration cannot loosen the rule, because
 * the bare name still has to ground on its own.
 */
function citedNames(token: string): string[] {
	const names: string[] = [];
	let current = token;
	for (let round = 0; round < 2; round += 1) {
		const next = (CITED_CALL_RE.exec(current)?.[1] ?? CITED_LOCATION_RE.exec(current)?.[1])?.trim();
		if (next === undefined || next.length === 0 || next === current) break;
		names.push(next);
		current = next;
	}
	return names;
}

function groundedToken(token: string, evidence: ModelGroundingCorpus): boolean {
	return groundedName(token, evidence) || citedNames(token).some((name) => groundedName(name, evidence));
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
	for (const convention of inferConventions(input.cwd, input.siblingFiles, input.codewiki)) {
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
		identity: existing?.identity ?? stabilizedIdentity(input, base.identity),
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
				"Run `clio-coder context init --adopt` to refresh the managed provenance section when those sources change.",
			].join(" "),
		});
	}
	return sections.slice(0, 6);
}

/**
 * Deterministic CLIO-CODER.md generator. Distills identity, conventions, and invariants
 * from sibling agent-context files and package metadata without a model. Used as
 * the offline path and as the fallback when model-driven generation is
 * unavailable or fails.
 */
function heuristicBootstrapOutputSync(input: BootstrapGenerateInput): BootstrapStructuredOutput {
	return stabilizeGeneratedOutput(input, {
		projectName: projectName(input.cwd),
		identity: resolveDefaultIdentity(input.cwd, input.projectType, input.siblingFiles).text,
		conventions: inferConventions(input.cwd, input.siblingFiles, input.codewiki),
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

function existingClioMdBootstrapOutput(cwd: string): BootstrapStructuredOutput | null {
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
		return readFileSync(join(cwd, "CLIO-CODER.md"), "utf8");
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
			"clio-coder context init preview",
			`  ${contextLine}; codewiki would index ${summary.codewikiEntries} entr${summary.codewikiEntries === 1 ? "y" : "ies"}; ${dirtyLine}; no files written`,
			...(adoptionLine ? [adoptionLine] : []),
			"",
		].join("\n");
	}
	const adoptionLine = formatAdoptionLine(summary);
	const proposalLine = summary.proposalPath ? `  proposal written ${summary.proposalPath}` : null;
	if (summary.action === "preserved") {
		return [
			"clio-coder context init preserved CLIO-CODER.md",
			`  ${contextLine}; codewiki rebuilt ${summary.codewikiEntries} entr${summary.codewikiEntries === 1 ? "y" : "ies"}; state refreshed; ${dirtyLine}`,
			"  CLIO-CODER.md is treated as human-owned. Use --apply to replace it with a generated draft, --propose to write an ignored proposal, or --adopt to refresh only imported agent context.",
			...(adoptionLine ? [adoptionLine] : []),
			"",
		].join("\n");
	}
	if (summary.action === "proposed") {
		return [
			"clio-coder context init proposed CLIO-CODER.md",
			`  ${contextLine}; codewiki rebuilt ${summary.codewikiEntries} entr${summary.codewikiEntries === 1 ? "y" : "ies"}; state refreshed; ${dirtyLine}`,
			...(proposalLine ? [proposalLine] : []),
			"  CLIO-CODER.md was not changed. Re-run with --apply only after reviewing the proposal.",
			...(adoptionLine ? [adoptionLine] : []),
			"",
		].join("\n");
	}
	return [
		`clio-coder context init ${summary.action} CLIO-CODER.md`,
		`  ${contextLine}; codewiki rebuilt ${summary.codewikiEntries} entr${summary.codewikiEntries === 1 ? "y" : "ies"}; state refreshed; ${dirtyLine}`,
		"  git policy: .clio-coder/ stays ignored by default; CLIO-CODER.md stays versioned and human-owned. Force-add .clio-coder assets only when you explicitly intend to share them.",
		...(proposalLine ? [proposalLine] : []),
		...(adoptionLine ? [adoptionLine] : []),
		"",
	].join("\n");
}

const CLIO_GITIGNORE_LINE = ".clio-coder/";
const CLIO_GITIGNORE_DYNAMIC_LINES = new Set<string>([
	".clio-coder/codewiki.json",
	".clio-coder/state.json",
	".clio-coder/handoffs/",
]);

function normalizedGitignoreLines(content: string): string[] {
	return content.split(/\r?\n/).map((line) => line.trim());
}

function hasBlanketClioIgnore(content: string): boolean {
	return normalizedGitignoreLines(content).some(isBlanketClioIgnoreLine);
}

function isBlanketClioIgnoreLine(line: string): boolean {
	if (line.length === 0 || line.startsWith("#") || line.startsWith("!")) return false;
	return /^(?:\/|\*\*\/)?\.clio-coder(?:\/|\/\*|\/\*\*)?$/.test(line);
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
		// The remedy is one flag away and the warning used to name neither it
		// nor the line, leaving the operator to guess the pattern Clio writes.
		warn(
			input.io,
			"clio-coder context init: .gitignore does not ignore .clio-coder/; local context, skills, agents, and handoffs may leak into commits.\n" +
				`  rerun with --yes to append '${CLIO_GITIGNORE_LINE}' to .gitignore without prompting, or add that line yourself.\n`,
		);
		return;
	}
	writeFileSync(gitignorePath, migrateClioGitignore(content), "utf8");
}

function serializeBootstrapOutput(output: BootstrapStructuredOutput): string {
	return serializeClioMd({ ...output, fingerprint: null });
}

function writeClioMdFile(cwd: string, output: BootstrapStructuredOutput): string {
	const clioMdPath = join(cwd, "CLIO-CODER.md");
	mkdirSync(dirname(clioMdPath), { recursive: true });
	const serialized = serializeBootstrapOutput(output);
	const parsed = parseClioMd(serialized);
	if (!parsed.ok) throw new Error(`bootstrap produced invalid CLIO-CODER.md: ${parsed.errors.join("; ")}`);
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
	const dir = join(cwd, ".clio-coder", "proposals");
	mkdirSync(dir, { recursive: true });
	const proposalPath = join(dir, `CLIO-CODER-${timestampForPath(now)}.md`);
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
	const run = telemetry.run;
	if (!run) return state;
	state.structuredOutputMode = run.structuredOutputMode;
	for (const [key, value] of [
		["runId", run.runId],
		["targetId", run.targetId],
		["wireModelId", run.wireModelId],
		["runtimeId", run.runtimeId],
		["runtimeKind", run.runtimeKind],
		["thinkingLevel", run.thinkingLevel],
	] as const) {
		const bounded = boundedStateString(value, 512);
		if (bounded) state[key] = bounded;
	}
	for (const [key, value] of [
		["tokenCount", run.tokens?.total],
		["toolCalls", run.toolCalls],
		["durationMs", run.durationMs],
		["promptBytes", run.promptBytes],
		["outputBytes", run.outputBytes],
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
	fingerprint: Fingerprint,
	generation: BootstrapGenerationTelemetry,
	generated: boolean,
): string {
	const statePath = resolveStatePath(cwd);
	const prev = readClioState(cwd);
	// lastBootstrap describes how the CLIO-CODER.md on disk was produced, not what the
	// most recent run happened to do. A run that generated nothing leaves the
	// handbook untouched, so overwriting a recorded `model` provenance with
	// `existing` would claim the handbook has no model authorship behind it.
	const lastBootstrap = generated
		? durableGenerationTelemetry(generation)
		: (prev?.lastBootstrap ?? durableGenerationTelemetry(generation));
	const contextSources = recordAdoption ? adoption.sourceSnapshots : prev?.contextSources;
	const contextSourceHash = contextSources ? adoptionSnapshotsHash(contextSources) : undefined;
	writeClioState(cwd, {
		version: 1,
		projectType,
		fingerprint,
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
 * until CLIO-CODER.md handling succeeds below.
 */
function persistCodewikiForGeneration(
	cwd: string,
	projectType: ProjectType,
	indexedAt: string,
	codewiki: Codewiki,
	fingerprint: Fingerprint,
): void {
	const prev = readClioState(cwd);
	writeClioState(cwd, {
		version: 1,
		projectType,
		fingerprint,
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
	// Index the repository before generation so the generator can ground CLIO-CODER.md
	// in the real structure (entry points, key modules), not just sibling prose.
	progress(input, { phase: "codewiki", status: "started", message: "building codewiki index" });
	let codewiki: Codewiki;
	let codewikiFingerprint: Fingerprint;
	if (input.preview === true) {
		const candidate = await buildCodewikiCandidate(cwd, projectType);
		codewiki = candidate.codewiki;
		codewikiFingerprint = candidate.fingerprint;
	} else {
		const coordinated = await coordinateCodewikiWrite(cwd, () => ({ kind: "build", cwd, language: projectType }), {
			beforeCommit: (_result, workspace) => ensureGitignore(workspace, input),
			afterCommit: ({ codewiki: committed, fingerprint }, workspace) =>
				persistCodewikiForGeneration(workspace, projectType, indexedAt, committed, fingerprint),
		});
		if (!coordinated) throw new Error("codewiki bootstrap transaction did not commit");
		codewiki = coordinated.codewiki;
		codewikiFingerprint = coordinated.worker.fingerprint;
	}
	const codewikiEntryCount = indexedSourceFileCount(codewiki);
	progress(input, {
		phase: "codewiki",
		status: "completed",
		message: `indexed ${codewikiEntryCount} source file${codewikiEntryCount === 1 ? "" : "s"}`,
		current: codewikiEntryCount,
		total: codewikiEntryCount,
	});
	const hadClioMd = existsSync(join(cwd, "CLIO-CODER.md"));
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
			`cannot refresh Imported agent context because CLIO-CODER.md is malformed${detail}; use --apply or --rewrite after reviewing the handbook`,
		);
	}
	// A supplied generator *is* the request to generate: both entry points
	// withhold `generate` for --heuristic and --preview and supply it otherwise.
	// An existing CLIO-CODER.md used to suppress generation entirely, so a plain
	// `clio-coder context init` on an initialized repository dispatched nothing, wrote
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
			message: input.generate
				? "drafting CLIO-CODER.md with the bootstrap agent"
				: "drafting CLIO-CODER.md with heuristic",
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
			generation.mode === "model",
		);
		if (generation.mode === "model" && retainedModelSections === 0) {
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
			message: hadClioMd
				? "preserving existing CLIO-CODER.md; no generated rewrite requested"
				: "using heuristic CLIO-CODER.md draft",
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
			clioMdPath: join(cwd, "CLIO-CODER.md"),
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

	let clioMdPath = join(cwd, "CLIO-CODER.md");
	let proposalPath: string | undefined;
	let action: RunBootstrapSummary["action"] = "preserved";
	progress(input, {
		phase: "clio-md",
		status: "started",
		message: hadClioMd ? "preserving CLIO-CODER.md" : "writing CLIO-CODER.md",
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
				? "CLIO-CODER.md written"
				: action === "refreshed"
					? "CLIO-CODER.md refreshed"
					: action === "proposed"
						? "CLIO-CODER.md proposal written"
						: "CLIO-CODER.md preserved",
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
		codewikiFingerprint,
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
		message: `${summary.action} CLIO-CODER.md; ${summary.dirtyFiles} dirty file${summary.dirtyFiles === 1 ? "" : "s"}; preload: ${preload.label}`,
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

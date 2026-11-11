import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, parse, posix, relative, resolve } from "node:path";
import { isReleaseOnlyWorkflow, readCiFileRuns } from "../../core/ci-commands.js";
import type { ContextOperationFact } from "../../core/context-operation.js";
import { internalGitArgv } from "../../core/internal-git.js";
import { ensureProjectIgnore } from "../../core/project-root.js";
import { runCommandVector } from "../../core/safe-exec.js";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import type { ContextActivityPayload } from "../../core/telemetry/live-events.js";
import { sumFacts } from "../../core/telemetry/pricing.js";
import type { RunUsageFacts } from "../../core/telemetry/schemas.js";
import { createTomlFileReader, type TomlFileReader, tomlTableAt } from "../../core/toml.js";
import { enumerateWorkspaceFiles, enumerateWorkspaceFilesAsync } from "../../core/workspace-files.js";
import { pythonProposals } from "../../tools/verify/toolchain.js";
import { INTEROP_AGENT_KINDS } from "../interop/registry.js";
import {
	FULL_PROJECT_CONTEXT_MAX_CHARS,
	FULL_PROJECT_CONTEXT_MAX_LINES,
	type ProjectPreloadClass,
	selectProjectPreload,
} from "../prompts/preload.js";
import { detectProjectType, type ProjectType } from "../session/workspace/project-type.js";
import {
	type AdoptionScanResult,
	adoptionSnapshotsHash,
	RULE_KEYWORDS,
	renderImportedAgentContext,
	restrictAdoptionScan,
	scanAgentConfigs,
} from "./adoption.js";
import type { BootstrapDepth, BootstrapEvidence } from "./bootstrap-evidence.js";
import { collectBootstrapEvidence } from "./bootstrap-evidence.js";
import {
	type ClioMdSection,
	HANDBOOK_TARGETS,
	loadProjectClioMd,
	type ParsedClioMd,
	parseClioMd,
	serializeClioMd,
	tryReadClioMd,
} from "./clio-md.js";
import { readCodewiki } from "./codewiki/artifact.js";
import {
	buildCodewikiCandidate,
	coordinateCodewikiExclusive,
	coordinateCodewikiWrite,
} from "./codewiki/coordinator.js";
import type { Codewiki } from "./codewiki/schema.js";
import { collectEnforcementInventory, type EnforcementInventory } from "./enforcement-inventory.js";
import type { Fingerprint } from "./fingerprint.js";
import {
	fitGeneratedHandbook,
	handbookBlocks,
	normalizeHandbookRule,
	type ProtectedHandbook,
} from "./handbook-budget.js";
import { handbookLedgerPath } from "./handbook-ledger.js";
import { instructionUnits } from "./instruction-units.js";
import { ContextOperationAbortError } from "./operation-result.js";
import { packageManager } from "./package-manager.js";
import { indexProgressSink } from "./progress.js";
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
import { contradictingFact, factClaims, treeFacts } from "./tree-facts.js";

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
	/** Operation-scoped parsed TOML documents shared by bootstrap consumers. */
	tomlFiles?: TomlFileReader;
	projectType: ProjectType;
	siblingFiles: ReadonlyArray<SiblingContextFile>;
	adoption: AdoptionScanResult;
	codewiki: Codewiki;
	existingClioMd?: ParsedClioMd;
	existingClioMdText?: string;
	/**
	 * Hard invariants of the handbook a rewrite replaces. The draft ignores
	 * them as source; each one whose cited paths and symbols still exist is
	 * carried forward verbatim.
	 */
	previousInvariants?: ReadonlyArray<string>;
	/**
	 * Custom sections of the handbook a rewrite replaces. Handbook units route a
	 * section to fleet workers by its title, so a title the draft drops is
	 * carried with the blocks that name a check the repository still defines.
	 */
	previousSections?: ReadonlyArray<ClioMdSection>;
	/** What CI runs and which custom checks exist; the model explains each as a rule. */
	enforcement?: EnforcementInventory;
	depth?: BootstrapDepth;
	evidence?: BootstrapEvidence;
	repositoryFiles?: ReadonlyArray<string>;
	progress?: BootstrapProgressSink;
	reportGeneration?: BootstrapGenerationSink;
	assessDraft?: (draft: BootstrapStructuredOutput) => string | null;
	/** Sections the evidence supports that a draft omits, each with the evidence that supports it. */
	missingSections?: (draft: BootstrapStructuredOutput) => ExpectedSection[];
	/** Receives one entry per instruction unit the authored-rule pass judged; only the final pass passes one. */
	handbookLedger?: HandbookLedgerEntry[];
}

/** One adopted instruction unit and the verdict that decided whether it entered CLIO-CODER.md. */
export interface HandbookLedgerEntry {
	id: string;
	text: string;
	origin: "adopted" | "handbook";
	source: { file: string; line: number };
	citations: string[];
	verdict: "verified" | "stale" | "unverifiable" | "contradicted";
	reason: string;
	kept: boolean;
	/** Renumbered checker ids `--verify` found; when this is the only problem, `--apply` rewrites them. */
	ruleIds?: { from: string; to: string }[];
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
	/** The generation run's spend, one fact per quantity (#434). */
	spend?: RunUsageFacts;
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
	/** The dispatch whose draft this generation reports on. */
	run?: BootstrapRunTelemetry;
	/**
	 * Every dispatch this generation made, in order: schema fallback, repair and
	 * section requests each spend tokens and tool calls that `run` alone omits.
	 */
	runs?: ReadonlyArray<BootstrapRunTelemetry>;
	/** Monotonic span of the whole generation, every dispatch included. */
	durationMs?: number;
	repairRan?: boolean;
	repairProducedHandbook?: boolean;
}

export type BootstrapGenerationSink = (telemetry: BootstrapGenerationTelemetry) => void;

export type BootstrapFallbackMode = "existing" | "heuristic";

export interface BootstrapFallbackResult {
	mode: BootstrapFallbackMode;
	output: BootstrapStructuredOutput;
}

export interface RunBootstrapInput {
	signal?: AbortSignal;
	cwd?: string;
	io?: BootstrapIo;
	modelId?: string;
	now?: () => Date;
	preview?: boolean;
	adopt?: boolean;
	applyClioMd?: boolean;
	rewriteClioMd?: boolean;
	proposeClioMd?: boolean;
	includeGlobalImports?: boolean;
	homeDir?: string;
	generate?: BootstrapGenerate;
	onProgress?: BootstrapProgressSink;
	depth?: BootstrapDepth;
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
	 * on disk after this run with unknown tool capability: full, partial,
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
	/** Restated rules merged and checker ids corrected while compiling, when there were any. */
	compile?: HandbookCompileReport;
	/** What the generated handbook absorbed from sibling handbooks, when a draft judged their rules. */
	absorb?: AbsorbReport;
}

/** Verdict counts from the handbook ledger and every rule that did not enter CLIO-CODER.md as written. */
export interface AbsorbReport {
	counts: Record<HandbookLedgerEntry["verdict"], number>;
	rules: { status: "dropped" | "contradicted" | "merged"; file: string; line: number; text: string; reason: string }[];
	/** Sibling handbooks read as sources; Clio never modifies them. */
	handbooks: string[];
}

function buildAbsorbReport(
	ledger: ReadonlyArray<HandbookLedgerEntry>,
	compile: HandbookCompileReport,
	handbooks: ReadonlyArray<string>,
): AbsorbReport {
	const counts: AbsorbReport["counts"] = { verified: 0, stale: 0, unverifiable: 0, contradicted: 0 };
	const rules: AbsorbReport["rules"] = [];
	for (const entry of ledger) {
		counts[entry.verdict] += 1;
		if (entry.kept) continue;
		rules.push({
			status: entry.verdict === "contradicted" ? "contradicted" : "dropped",
			file: entry.source.file,
			line: entry.source.line,
			text: entry.text,
			reason: entry.reason,
		});
	}
	for (const pair of compile.merged) {
		const source = ledger.find((entry) => pair.dropped.includes(entry.text));
		if (!source) continue;
		rules.push({
			status: "merged",
			file: source.source.file,
			line: source.source.line,
			text: source.text,
			reason: `restates: ${pair.kept.replace(/\s+/g, " ").trim()}`,
		});
	}
	return { counts, rules, handbooks: [...handbooks] };
}

const ABSORB_LINE_CAP = 20;

function formatAbsorbLines(summary: RunBootstrapSummary): string[] {
	const absorb = summary.absorb;
	if (!absorb) return [];
	const clip = (text: string): string => {
		const flat = text.replace(/\s+/g, " ").trim();
		return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
	};
	const { counts } = absorb;
	const lines = [
		`  absorbed rules: ${counts.verified} verified, ${counts.stale} stale, ${counts.contradicted} contradicted, ${counts.unverifiable} unverifiable`,
	];
	for (const rule of absorb.rules.slice(0, ABSORB_LINE_CAP))
		lines.push(`    ${rule.status} ${rule.file}:${rule.line} ${clip(rule.text)} (${clip(rule.reason)})`);
	if (absorb.rules.length > ABSORB_LINE_CAP)
		lines.push(`    and ${absorb.rules.length - ABSORB_LINE_CAP} more in the ledger`);
	if (absorb.handbooks.length > 0)
		lines.push(`  absorbed handbooks: ${absorb.handbooks.join(", ")}; Clio did not modify them`);
	return lines;
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

function projectName(cwd: string, tomlFiles: TomlFileReader): string {
	return projectNameFrom(readProjectMetadata(cwd, tomlFiles), cwd);
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

/** Only project-wide instructions may become unconditional handbook rules. */
function handbookInstructionFiles(input: BootstrapGenerateInput): SiblingContextFile[] {
	const projectPaths = new Set(
		INTEROP_AGENT_KINDS.flatMap((kind) => kind.instructionFiles.map((file) => resolve(input.cwd, file))),
	);
	const allowed = new Set(
		input.adoption.sources
			.filter((source) => {
				if (source.kind !== "instructions") return false;
				if (source.scope === "project") return projectPaths.has(source.path);
				return input.adoption.includeGlobal && source.path === resolve(input.adoption.homeDir, ".codex/AGENTS.md");
			})
			.map((source) => source.path),
	);
	return input.siblingFiles.filter((file) => allowed.has(file.path));
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
	tomlFiles: TomlFileReader,
): DeterministicIdentity {
	const metadata = readProjectMetadata(cwd, tomlFiles);
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
	// A description is usually a noun phrase; one opening with an article
	// ("An open-source coding agent") read as a verbless sentence after the head.
	const phrase = /^(?:A|An|The)\s/.test(cleaned) ? `${cleaned[0]?.toLowerCase() ?? ""}${cleaned.slice(1)}` : cleaned;
	const role = /^[a-z]/.test(phrase) ? `It is ${phrase}.` : `${phrase}.`;
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
function stabilizedIdentity(input: BootstrapGenerateInput, modelIdentity: unknown, tomlFiles: TomlFileReader): string {
	const deterministic = resolveDefaultIdentity(input.cwd, input.projectType, handbookInstructionFiles(input), tomlFiles);
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
	// An uncited sibling bullet is kept only when no tree fact contradicts it; a cited one is adopted
	// only through the verified authored-rule pass, which checks its citations against the tree.
	const facts = treeFacts(cwd);
	for (const bullet of harvestSiblingBullets(files)) {
		if (!/`[^`\n]+`/.test(bullet) && !contradictingFact(bullet, facts)) pushUnique(conventions, bullet);
	}
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
	return selectProjectPreload(promptContext, null, { cwd }).classification;
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

export { type PackageManager, packageManager } from "./package-manager.js";

/** A script whose command rewrites the tree cannot serve as a verification gate. */
const MUTATING_SCRIPT_RE = /(?:^|\s)--(?:fix|write)(?:\s|$)/;

/**
 * First preset a human could actually invoke: named and not hidden. Hidden
 * presets exist only to be inherited from, so naming one in the handbook would
 * hand the agent a command CMake refuses to run.
 */
function cmakePresetName(presets: unknown, key: string): string | null {
	if (typeof presets !== "object" || presets === null || Array.isArray(presets)) return null;
	const list = (presets as Record<string, unknown>)[key];
	if (!Array.isArray(list)) return null;
	for (const entry of list) {
		if ((entry as Record<string, unknown> | null)?.hidden === true) continue;
		const name = stringField(entry, "name");
		if (name !== null) return name;
	}
	return null;
}

/**
 * CMake presets are the project's own declared configure/build/test recipes,
 * the same authority package.json scripts carry for Node. A CMake tree without
 * presets stays silent: nothing there declares a runnable command, and a
 * guessed `cmake -B build` fails on exactly the toolchain-file and MPI-wrapper
 * projects this tool targets. Configure, build, and test are each named
 * independently: a project can declare a visible build preset without a
 * visible configure preset (e.g. the configure preset is the hidden base
 * every build preset inherits from), and that build command is still one the
 * agent can run.
 */
function cmakeVerificationLines(cwd: string): string[] {
	const presets = readJsonFile(join(cwd, "CMakePresets.json"));
	if (presets === null) return [];
	const configure = cmakePresetName(presets, "configurePresets");
	const build = cmakePresetName(presets, "buildPresets");
	const test = cmakePresetName(presets, "testPresets");
	const lines: string[] = [];
	if (configure !== null) lines.push(`Configure with \`cmake --preset ${configure}\`.`);
	if (build !== null) lines.push(`Build with \`cmake --build --preset ${build}\`.`);
	if (test !== null) lines.push(`Run tests with \`ctest --preset ${test}\`.`);
	return lines;
}

/**
 * Python has no single scripts manifest, so this names a runner only where the
 * project declares one: a tox configuration declares `tox`, a pytest
 * configuration or dependency declares `pytest`, and test modules under
 * `tests/` with neither declare the standard-library unittest runner. A uv
 * project runs each through `uv run`, because a bare interpreter does not see
 * the project environment. Tox wins when both are declared because it
 * typically wraps the pytest run. Detection is shared with the verify tool's
 * derived checks, so the handbook names the command verify would run.
 */
function pythonVerificationLines(cwd: string, tomlFiles: TomlFileReader): string[] {
	const launcher = existsSync(join(cwd, "uv.lock")) ? "uv run " : "";
	const pyproject = tomlFiles.read("pyproject.toml");
	if (existsSync(join(cwd, "tox.ini")) || (pyproject !== null && tomlTableAt(pyproject, ["tool", "tox"]))) {
		return [`Run \`${launcher}tox\`.`];
	}
	if (
		existsSync(join(cwd, "pytest.ini")) ||
		(pyproject !== null && tomlTableAt(pyproject, ["tool", "pytest", "ini_options"]))
	) {
		return [`Run \`${launcher}pytest\`.`];
	}
	const derived = pythonProposals(cwd, []).find((proposal) => proposal.tags.includes("test"));
	return derived ? [`Run the Python tests with \`${derived.command.join(" ")}\`.`] : [];
}

/** CI steps that prepare the machine rather than judge the change. */
const CI_SETUP_RE =
	/^(?:uv\s+(?:sync|venv|pip|python\s+install)|pip3?\s+install|python3?\s+-m\s+pip\b|(?:npm|pnpm|yarn|bun)\s+(?:ci|install)\b|yarn$|corepack\b|sudo\b|apt(?:-get)?\b|brew\b|curl\b|wget\b|git\s+(?:config|fetch|clone|submodule)\b|cd\b|echo\b|export\b|mkdir\b|cp\b|mv\b|rm\b|ls\b|cat\b)/;
const MAX_CI_GATE_COMMANDS = 8;

/**
 * The commands each pipeline file runs, named exactly with the events that
 * start it. A repository whose gate is a script (`scripts/gate.sh`) or a make
 * target declares nothing a manifest reader sees, so without this line its
 * handbook named no command and agents recorded that they could not run the
 * tests. The line states what a file runs, never that CI gates a change, and a
 * workflow that runs only on a tag or a release is left out.
 */
function ciGateLines(cwd: string): string[] {
	const named = new Set<string>();
	const lines: string[] = [];
	for (const { file, commands, triggers } of readCiFileRuns(cwd)) {
		if (isReleaseOnlyWorkflow(triggers)) continue;
		const steps = commands
			.filter((command) => !CI_SETUP_RE.test(command) && !command.includes("$") && !command.includes("`"))
			.filter((command) => !named.has(command))
			.slice(0, MAX_CI_GATE_COMMANDS - named.size);
		if (steps.length === 0) continue;
		for (const command of steps) named.add(command);
		const events = triggers ? ` on ${triggers.map((entry) => `\`${entry.event}\``).join(", ")}` : "";
		lines.push(`\`${file}\` runs ${steps.map((command) => `\`${command}\``).join(", ")}${events}.`);
		if (named.size >= MAX_CI_GATE_COMMANDS) break;
	}
	if (lines.length === 0) return [];
	return [...lines, "These are workflow steps, not authorization to expand the current task."];
}

function verificationSection(cwd: string, tomlFiles: TomlFileReader): ClioMdSection | null {
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
		lines.push(`Available static checks: ${baseline.join(", ")}.`);
	}
	if (hasScript("build")) {
		lines.push(`Build command: ${command("build")}; rebuild when the selected validation consumes compiled output.`);
	}
	const targeted = ["test:contracts", "test:smoke", "check:boundaries"].filter(hasScript).map(command);
	if (targeted.length > 0) {
		lines.push(`Use targeted checks for narrower risk: ${targeted.join(", ")}.`);
	}
	if (hasScript("test")) {
		lines.push(`Declared test command: ${command("test")}.`);
		const selection = scripts.test;
		// Preserve literal selection rather than guessing that every test root runs in CI.
		// Oversized or Markdown-active commands remain available at their source path.
		if (selection && selection.length <= 1200 && !/[`\r\n]/.test(selection)) {
			lines.push(
				`Exact package.json#scripts.test: \`${selection}\`. Other test scripts have separate selection; check which command runs a test before claiming coverage.`,
			);
		}
	}
	if (hasScript("ci")) {
		lines.push(`Full CI command, when requested: ${command("ci")}.`);
	}
	lines.push(...cmakeVerificationLines(cwd));
	// Cargo's commands are defined by the toolchain, not by each project, so
	// naming them for any Cargo workspace carries the same confidence as a
	// declared package script.
	const cargo = tomlFiles.read("Cargo.toml");
	if (cargo !== null && (tomlTableAt(cargo, ["package"]) || tomlTableAt(cargo, ["workspace"]))) {
		lines.push("Cargo validation commands: `cargo build` and `cargo test`.");
	}
	// Go's commands are defined by the toolchain, not by each project, so
	// naming them for any module carries the same confidence as a declared
	// package script.
	if (existsSync(join(cwd, "go.mod"))) {
		lines.push("Go validation commands: `go build ./...` and `go test ./...`.");
	}
	lines.push(...pythonVerificationLines(cwd, tomlFiles));
	lines.unshift(...ciGateLines(cwd));
	if (lines.length === 0) return null;
	lines.push(
		"Choose checks relevant to the change within the user-authorized scope and authored project policy. `verify` can run declared checks; an authorized command it cannot run can be executed through `bash`.",
	);
	return { title: "Verification expectations", body: lines.join(" ") };
}

const VERIFICATION_SECTION_RE = /\bverification\b/i;

interface ModelGroundingCorpus {
	lower: string;
	indexedPaths: ReadonlySet<string>;
	symbolDefinitions: ReadonlyMap<string, ReadonlySet<string>>;
	/** Every visible repository path, including docs, configs and CI files the codemap does not index. */
	repositoryPaths: ReadonlySet<string>;
	/** Lowercased text of the visible repository files, read once on first need. */
	repositoryText: () => string;
	/** Lowercased text of one visible repository file, or null when it cannot be read. */
	fileText: (path: string) => string | null;
	/** Opening text of each long package script body, whitespace-collapsed. */
	scriptRecitals: ReadonlyArray<string>;
	/** Script-specific bodies prevent test:full's smoke glob from being attributed to test. */
	scriptBodies: ReadonlyMap<string, string>;
	/** The repository's launcher identifies exact script invocations in model citations. */
	packageManager: string;
}

/** Long enough that quoting it restates the script rather than naming a command. */
const SCRIPT_RECITAL_CHARS = 40;

/** Files larger than this are data, not rules; skip them when grounding citations. */
const GROUNDING_FILE_MAX_BYTES = 1024 * 1024;
/** Total text read for grounding; bounds memory on very large repositories. */
const GROUNDING_TEXT_MAX_BYTES = 96 * 1024 * 1024;

function repositoryGroundingText(cwd: string, paths: ReadonlyArray<string>): string {
	const chunks: string[] = [];
	let total = 0;
	for (const path of paths) {
		if (total >= GROUNDING_TEXT_MAX_BYTES) break;
		try {
			const full = join(cwd, path);
			if (statSync(full).size > GROUNDING_FILE_MAX_BYTES) continue;
			const bytes = readFileSync(full);
			if (bytes.includes(0)) continue;
			chunks.push(bytes.toString("utf8").toLowerCase());
			total += bytes.length;
		} catch {
			// A file that vanished or cannot be read simply grounds nothing.
		}
	}
	return chunks.join("\n");
}

/**
 * Root files a generation run never reads or cites: its own output, and Clio's
 * hand-written CLIO-DEV.md, which the generated handbook is compared against.
 */
const GENERATION_EXCLUDED_FILES: ReadonlySet<string> = new Set(["CLIO-CODER.md", "CLIO-DEV.md"]);

/**
 * Everything Scout is allowed to cite: every indexed path, every indexed symbol,
 * every runnable package script rendered the way this repository would type it,
 * and the text of repository files. Sibling agent-context prose and the existing
 * handbook are quoted to the model as input, never evidence: a rule stated only
 * in a sibling handbook would otherwise ground the model line that copies it.
 */
function createModelGroundingCorpus(input: BootstrapGenerateInput): ModelGroundingCorpus {
	const siblingPaths = new Set(input.siblingFiles.map((file) => relative(input.cwd, file.path).split("\\").join("/")));
	const indexedPaths = new Set(input.codewiki.files.map((file) => file.path));
	const pathsById = new Map(input.codewiki.files.map((file) => [file.id, file.path]));
	const symbolDefinitions = new Map<string, Set<string>>();
	for (const symbol of input.codewiki.symbols) {
		const path = pathsById.get(symbol.fileId);
		if (path === undefined) continue;
		const definitions = symbolDefinitions.get(symbol.name) ?? new Set<string>();
		definitions.add(path);
		symbolDefinitions.set(symbol.name, definitions);
	}
	const pm = packageManager(input.cwd);
	const scripts = packageScripts(input.cwd);
	const evidence = [
		...(input.evidence?.files
			.filter((file) => !siblingPaths.has(file.path))
			.map((file) => `${file.path}\n${file.excerpt}`) ?? []),
		...(input.enforcement ? [JSON.stringify(input.enforcement)] : []),
		input.expectedProjectName ?? "",
		input.projectType,
		[...indexedPaths].join("\n").slice(0, 64_000),
		...Object.entries(scripts).flatMap(([name, command]) => [`${pm} run ${name}`, `${pm} ${name}`, command]),
		input.codewiki.symbols
			.map((symbol) => symbol.name)
			.join("\n")
			.slice(0, 128_000),
	].join("\n");
	let repositoryPaths: ReadonlyArray<string> = input.repositoryFiles ?? [];
	try {
		if (!input.repositoryFiles)
			repositoryPaths = enumerateWorkspaceFiles(input.cwd).filter((path) => !GENERATION_EXCLUDED_FILES.has(path));
	} catch {
		// An unreadable tree leaves the indexed evidence as the only grounding.
	}
	let text: string | null = null;
	const fileTexts = new Map<string, string | null>();
	const textPaths = repositoryPaths.filter((path) => !siblingPaths.has(path));
	return {
		lower: evidence.toLowerCase(),
		indexedPaths,
		symbolDefinitions,
		// Five models attributed test:full's glob to test; keep each script's own selector evidence.
		scriptBodies: new Map(Object.entries(scripts)),
		packageManager: pm,
		scriptRecitals: Object.values(scripts)
			.map((command) => command.replace(/\s+/g, " ").trim())
			.filter((command) => command.length >= SCRIPT_RECITAL_CHARS)
			.map((command) => command.slice(0, SCRIPT_RECITAL_CHARS)),
		repositoryPaths: new Set(repositoryPaths),
		repositoryText: () => {
			text ??= repositoryGroundingText(input.cwd, textPaths);
			return text;
		},
		fileText: (path) => {
			if (!fileTexts.has(path))
				fileTexts.set(path, textPaths.includes(path) ? repositoryGroundingText(input.cwd, [path]) || null : null);
			return fileTexts.get(path) ?? null;
		},
	};
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

/** A concrete file path: a directory part and a file name with an extension, no pattern, home or URL. */
const CONCRETE_FILE_RE = /^[^\s~/:][^\s:]*\/[^\s/]*\.[A-Za-z0-9]+$/;

function groundedLiteral(literal: string, evidence: ModelGroundingCorpus): boolean {
	const lower = literal.toLowerCase();
	const path = literal.replace(/^\.\//, "").replace(/\/$/, "");
	// Cited paths decide which workers receive a rule (`handbook-units.ts`), so a
	// file path must name a file from the repository root. A substring match let
	// `tests/chat-composer.test.ts` through for `apps/clio-coder-gui/tests/`, and
	// the rule then claimed the GUI tests live at the root.
	if (CONCRETE_FILE_RE.test(path)) return evidence.indexedPaths.has(path) || evidence.repositoryPaths.has(path);
	if (evidence.lower.includes(lower) || evidence.indexedPaths.has(path) || evidence.repositoryPaths.has(path))
		return true;
	// A directory is real when some visible file lives under it.
	if (literal.includes("/")) {
		for (const candidate of evidence.repositoryPaths) if (candidate.startsWith(`${path}/`)) return true;
	}
	return evidence.repositoryText().includes(lower);
}

/**
 * A one-level glob, `docs/*.md`, over a directory holding files it would match
 * deeper down. It reads as the directory's whole scope: a handbook said the
 * documentation-links check covers `docs/*.md` and two root guides, "all
 * three", while the check reads Markdown under `docs/` at every depth.
 */
function narrowerThanTree(token: string, evidence: ModelGroundingCorpus): boolean {
	const slash = token.lastIndexOf("/");
	const dir = token.slice(0, slash).replace(/^\.\//, "");
	const name = token.slice(slash + 1);
	if (slash <= 0 || !name.includes("*") || name.includes("**") || /[?<>{}[\]]/.test(name) || /[*?<>{}[\]]/.test(dir))
		return false;
	const pattern = new RegExp(
		`^${name
			.split("*")
			.map((piece) => piece.replace(/[.+^$()|\\]/g, "\\$&"))
			.join("[^/]*")}$`,
	);
	for (const path of evidence.repositoryPaths) {
		if (!path.startsWith(`${dir}/`)) continue;
		const rest = path.slice(dir.length + 1);
		if (rest.includes("/") && pattern.test(rest.slice(rest.lastIndexOf("/") + 1))) return true;
	}
	return false;
}

/**
 * A citation may be a pattern rather than a name: a glob (`src/engine/**`,
 * `CLIO_*`), a placeholder (`tests/<name>.test.ts`), or a command chain joined
 * with `&&`. Each literal piece of at least three characters must ground on
 * its own, so a pattern can never smuggle in a name the repository lacks, and
 * a one-level glob must not hide deeper matches (`narrowerThanTree`).
 */
function groundedName(token: string, evidence: ModelGroundingCorpus): boolean {
	const parts = token.split(/\s*&&\s*/).filter((part) => part.length > 0);
	if (parts.length > 1) return parts.every((part) => groundedName(part, evidence));
	if (narrowerThanTree(token, evidence)) return false;
	const literals = token
		.split(/<[^<>]*>|\*+|\?|\{[^{}]*\}/)
		.map((piece) => piece.trim())
		.filter((piece) => piece.length > 0);
	if (literals.length === 1 && literals[0] === token) return groundedLiteral(token, evidence);
	const meaningful = literals.filter((piece) => piece.replace(/[^A-Za-z0-9]/g, "").length >= 3);
	return meaningful.length > 0 && meaningful.every((piece) => groundedLiteral(piece, evidence));
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
 * A slash makes a word a path only when it names one. Two prose words joined
 * by a slash (verb pairs, the input-output abbreviation) grounded as a
 * substring somewhere and came back wrapped as code. Patterns pass on to the citation
 * rule, which grounds their literal pieces.
 */
function repositoryPathToken(token: string, evidence: ModelGroundingCorpus): boolean {
	const path = token.replace(/^\.\//, "").replace(/\/$/, "");
	if (/[*?<>{}]/.test(path)) return true;
	if (evidence.indexedPaths.has(path) || evidence.repositoryPaths.has(path)) return true;
	for (const candidate of evidence.repositoryPaths) if (candidate.startsWith(`${path}/`)) return true;
	return false;
}

/**
 * A case hump marks an identifier, except in a proper noun: `TypeScript` and
 * `GitHub` are PascalCase words, not names in this repository. A PascalCase
 * word is code only when the index defines it; lowerCamel is always code.
 */
function camelCaseIdentifier(token: string, evidence: ModelGroundingCorpus): boolean {
	if (!/[a-z0-9][A-Z]/.test(token)) return false;
	return /^[a-z]/.test(token) || evidence.symbolDefinitions.has(token.replace(/\(\)$/, ""));
}

// Nemotron's accurate first draft cited no names in backticks, so the citation rule dropped every line.
// Backtick a bare name only when it reads as code and passes the same check a backticked citation faces.
function wrapBareCitations(line: string, evidence: ModelGroundingCorpus): string {
	return line
		.split(/(`[^`\n]*`|\]\([^)\s]*\))/)
		.map((part, index) => {
			if (index % 2 === 1) return part;
			return part.replace(
				/\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?[A-Za-z0-9_:@./*-]+|[A-Za-z0-9_$@.][A-Za-z0-9_$@./*?+<>-]*/g,
				(match) => {
					const token = match.replace(/[.,;:!?]+$/, "");
					const punctuation = match.slice(token.length);
					const words = token.split(/\s+/);
					const script = words[1] === "run" && words.length === 3 ? words[2] : words.length === 2 ? words[1] : undefined;
					const invocation =
						words[0] === evidence.packageManager && script !== undefined && evidence.scriptBodies.has(script);
					// "e.g" or "bold**" must not count as a name.
					const dotted = token.replace(/\b\w{1,2}\./g, "");
					const codeLike =
						/[_@]/.test(token) ||
						(token.includes("/") ? repositoryPathToken(token, evidence) : camelCaseIdentifier(token, evidence)) ||
						(dotted.includes(".") && /^\.?[\w-]+(?:\.[\w-]+)*$/.test(dotted));
					return invocation || (codeLike && groundedToken(token, evidence)) ? `\`${token}\`${punctuation}` : match;
				},
			);
		})
		.join("");
}

// Real symbols were attributed to importing files; use indexed definitions to correct unambiguous ownership.
// A path followed by 's ("in the index file's sibling") names a neighbor, not the owner: leave it.
function correctSymbolAttributions(line: string, evidence: ModelGroundingCorpus): string {
	return line.replace(
		/(`[A-Za-z_$][\w$]*(?:\(\))?`(?:\s*(?:,\s*(?:(?:and|or)\s+)?|(?:and|or)\s+)`[A-Za-z_$][\w$]*(?:\(\))?`)*)\s+(in|from|of)\s+`([^`\n]+)`(?!['\u2019]s\b)/g,
		(match, symbols: string, relation: string, citedPath: string) => {
			const path = citedPath.replace(/^\.\//, "");
			if (!/^[\w./-]+\.[A-Za-z0-9]+$/.test(path)) return match;
			const owners = [...symbols.matchAll(CODE_TOKEN_RE)].map((symbol) => {
				const definitions = evidence.symbolDefinitions.get((symbol[1] ?? "").replace(/\(\)$/, ""));
				if (definitions?.has(path)) return path;
				return definitions?.size === 1 ? [...definitions][0] : undefined;
			});
			const owner = owners[0];
			if (owner === undefined || owner === path || !owners.every((candidate) => candidate === owner)) return match;
			return `${symbols} ${relation} \`${owner}\``;
		},
	);
}

const REVIEW_REQUIREMENT_RE = /\breviewers?\b|\brequired reviews?\b/i;
/** An approval gate: approval in a sentence about a deployment environment, not "approval before disabling a check". */
const APPROVAL_GATE_RE = /^(?=.*\bapprov(?:al|als|e|es|ed|ing)\b)(?=.*\benvironments?\b)/is;
/**
 * Review policy stated as configuration: branch protection and rulesets
 * (`required_pull_request_reviews`, `required_approving_review_count`,
 * `require_code_owner_reviews`), deployment environments (`reviewers:`,
 * `required_reviewers`), or a CODEOWNERS file.
 */
const REVIEW_POLICY_KEY_RE =
	/["']?\b(?:required_pull_request_reviews|required_approving_review_count|require_code_owner_reviews?|required_reviewers|dismiss_stale_reviews|require_last_push_approval|reviewers)["']?\s*:/i;

function statesReviewPolicy(path: string, text: string): boolean {
	return /(?:^|\/)CODEOWNERS$/.test(path) || REVIEW_POLICY_KEY_RE.test(text) || REVIEW_REQUIREMENT_RE.test(text);
}

/** A cited path as the repository names it: `./src/cart.ts:26` is `src/cart.ts`. */
function citedPath(token: string): string {
	const path = token.trim().replace(/^\.\//, "");
	return CITED_LOCATION_RE.exec(path)?.[1] ?? path;
}

/** Cut `drop` from each parenthesized citation list, `(`a`, `b`)`, and the list when none remain. */
function withoutCitations(sentence: string, drop: ReadonlySet<string>): string {
	return sentence.replace(/\s*\((`[^`\n]+`(?:\s*(?:,|;|\band\b)\s*`[^`\n]+`)*)\)/g, (list, inner: string) => {
		const spans = [...inner.matchAll(CODE_TOKEN_RE)];
		const kept = spans.filter((span) => !drop.has(citedPath(span[1] ?? ""))).map((span) => span[0]);
		if (kept.length === spans.length) return list;
		return kept.length > 0 ? ` (${kept.join(", ")})` : "";
	});
}

/** A line's list marker, and its prose sentences split without breaking inside a code span. */
function proseSentences(line: string): { prefix: string; sentences: string[] } {
	const prefix = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?/.exec(line)?.[0] ?? "";
	const body = line.slice(prefix.length);
	const masked = body.replace(/`[^`\n]*`/g, (span) => `\`${"x".repeat(span.length - 2)}\``);
	const sentences: string[] = [];
	let from = 0;
	for (const match of masked.matchAll(/[.!?](?=\s+[A-Z`*])/g)) {
		const at = (match.index ?? 0) + 1;
		sentences.push(body.slice(from, at));
		from = at;
	}
	sentences.push(body.slice(from));
	return { prefix, sentences };
}

interface ClaimCitations {
	/** Which code spans are cited files; concrete paths below the root by default. */
	cites?: (path: string) => boolean;
	/** Cited files that do not support the claim, cut from citation lists when another cited file does. */
	unsupporting?: (cited: string[]) => string[];
	/** The evidence was read in full and contradicts the claim: cut the sentence instead of marking it. */
	refuted?: (cited: string[]) => boolean;
}

/**
 * Append `(unverified: …)` to each sentence of a line that makes a `claim` the
 * files it cites do not support; `unsupported` names what is missing, or null.
 * The claim may still hold, so the sentence stays, marked as not found in what
 * it cites, rather than vanishing as a safety rule.
 */
function withUnsupportedClaimsMarked(
	line: string,
	claim: RegExp,
	unsupported: (cited: string[]) => string | null,
	citations: ClaimCitations = {},
): string {
	if (!claim.test(line)) return line;
	const cites = citations.cites ?? ((path: string) => CONCRETE_FILE_RE.test(path));
	const { prefix, sentences } = proseSentences(line);
	const marked = sentences.map((sentence) => {
		if (!claim.test(sentence)) return sentence;
		const cited = [
			...new Set([...sentence.matchAll(CODE_TOKEN_RE)].map((match) => citedPath(match[1] ?? "")).filter(cites)),
		];
		const missing = cited.length > 0 ? unsupported(cited) : null;
		if (missing === null) return withoutCitations(sentence, new Set(citations.unsupporting?.(cited) ?? []));
		if (citations.refuted?.(cited) === true) return "";
		const note = ` (unverified: ${missing})`;
		const end = /([.!?])(\s*)$/.exec(sentence);
		return end ? `${sentence.slice(0, end.index)}${note}${end[1]}${end[2]}` : `${sentence.trimEnd()}${note}`;
	});
	return `${prefix}${marked.join("").trim()}`;
}

/**
 * Every generated handbook said the `release` environment "in
 * `.github/workflows/release.yml`" requires the owner as reviewer: the path is
 * real, so the citation grounded, but reviewers are a GitHub environment setting
 * that only `CONTRIBUTING.md` describes, and the workflow names no reviewer. A
 * later one cited both for the environment's owner approval; the workflow is cut
 * from that citation list, since the guide states the policy.
 */
function withUnsupportedReviewRequirementsMarked(line: string, evidence: ModelGroundingCorpus): string {
	const statesPolicy = (path: string): boolean => {
		const text = evidence.fileText(path);
		return text === null || statesReviewPolicy(path, text);
	};
	return withUnsupportedClaimsMarked(
		line,
		new RegExp(`${REVIEW_REQUIREMENT_RE.source}|${APPROVAL_GATE_RE.source}`, "is"),
		(cited) =>
			cited.some(statesPolicy) ? null : `${cited.map((path) => `\`${path}\``).join(", ")} states no review policy`,
		{
			// A root guide such as `CONTRIBUTING.md` states review policy, so it counts as cited.
			cites: (path) => CONCRETE_FILE_RE.test(path) || evidence.repositoryPaths.has(path),
			unsupporting: (cited) => cited.filter((path) => !statesPolicy(path)),
		},
	);
}

/** CI named in prose: an acronym, never a lowercase `ci-tests` stem. */
const CI_PROSE_RE = /\bCI\b|\b[Cc]ontinuous [Ii]ntegration\b|\bGitHub Actions\b/;
const WORKFLOW_PATH_RE = /\.github\/workflows\b/;

/** Cut each sentence of a line that `drops`; the line is empty when none remains. */
function withoutSentences(line: string, drops: (sentence: string) => boolean): string {
	const { prefix, sentences } = proseSentences(line);
	const kept = sentences.filter((sentence) => !drops(sentence));
	if (kept.length === sentences.length) return line;
	const body = kept.join("").trim();
	return body ? `${prefix}${body}` : "";
}

/**
 * Cut each sentence of a model line that speaks for CI, in either voice. Clio
 * does not verify what CI runs, so a rule names the check and what it refuses:
 * handbooks said both pin `--check` modes "fail CI on drift" when CI reached
 * neither by name, and a phrase list of passive claims let "CI enforces" and
 * "CI will reject" through. The line drops when no sentence remains.
 */
function withoutCiStatements(line: string): string {
	return withoutSentences(line, namesCi);
}

function namesCi(text: string): boolean {
	return CI_PROSE_RE.test(text.replace(/`[^`\n]*`/g, ""));
}

/** Where a clause ends inside a sentence: a colon, a semicolon, or a comma before `so`, `and` or `but`. */
const CLAUSE_END_RE = /(?:[:;]|,(?=\s+(?:so|and|but)\s))(?=\s)/g;

/**
 * Cut the clauses of a line that speak for CI and keep the rest of each
 * sentence. A carried hard invariant states its rule before a colon and its
 * reason after it, as in "Keep X: `scripts/check.js` fails CI otherwise", so
 * cutting the whole sentence would drop the rule with the claim. A kept
 * clause loses the conjunction that tied it to a cut one. A sentence with no
 * clause left drops whole, and the line is empty when none remains.
 */
function withoutCiClauses(line: string): string {
	if (!namesCi(line)) return line;
	const { prefix, sentences } = proseSentences(line);
	const kept = sentences.flatMap((sentence) => {
		if (!namesCi(sentence)) return [sentence];
		const masked = sentence.replace(/`[^`\n]*`/g, (span) => `\`${"x".repeat(span.length - 2)}\``);
		const clauses: string[] = [];
		let from = 0;
		for (const match of masked.matchAll(CLAUSE_END_RE)) {
			const at = (match.index ?? 0) + 1;
			clauses.push(sentence.slice(from, at));
			from = at;
		}
		clauses.push(sentence.slice(from));
		const remaining = clauses.flatMap((clause, index) => {
			if (namesCi(clause)) return [];
			const previous = clauses[index - 1];
			return [previous !== undefined && namesCi(previous) ? clause.replace(/^(\s*)(?:so|and|but)\s+/, "$1") : clause];
		});
		if (remaining.length === 0) return [];
		const body = remaining.join("").replace(/[\s:;,]+$/, "");
		const opened = namesCi(clauses[0] ?? "")
			? body.replace(/^(\s*)(\p{Ll})/u, (_, space: string, letter: string) => `${space}${letter.toUpperCase()}`)
			: body;
		return [/[.!?]$/.test(opened) ? opened : `${opened}.`];
	});
	const body = kept.join(" ").replace(/\s+/g, " ").trim();
	return body ? `${prefix}${body}` : "";
}

/**
 * Cut each sentence that cites a workflow file. A workflow defines what CI
 * runs, and every generated handbook cited `.github/workflows/release.yml` for
 * an owner review that only `CONTRIBUTING.md` states; the path is real, so the
 * citation grounded. A citation list that also names a supporting guide has
 * already lost the workflow (`withUnsupportedReviewRequirementsMarked`).
 */
function withoutWorkflowCitations(line: string): string {
	return withoutSentences(line, (sentence) => WORKFLOW_PATH_RE.test(sentence));
}

const PRELOAD_CLAIM_RE = /\bpre-?load(?:s|ed|ing)?\b/i;
const MODULE_FILE_RE = /\.(?:[cm]?[jt]s|tsx|jsx)$/;
const SHELL_SYNTAX_RE = /[;&|<>`$(){}\n'"\\]/;
const NODE_PRELOAD_FLAGS = new Set(["--import", "--require", "-r", "--loader", "--experimental-loader"]);
/** Options without a value that leave Node running the program after its preloads. */
const NODE_RUNNING_FLAGS = new Set(["--test", "--watch", "--enable-source-maps", "--no-warnings", "--trace-warnings"]);
/** Options with an inline value that leave Node running the program, and the values each accepts. */
const NODE_RUNNING_VALUED_FLAGS = new Map([["--test-concurrency", /^[1-9]\d*$/]]);

/**
 * What a package script makes Node preload and run, read only from a plain
 * `node` command whose preload flags precede the program. Shell syntax (an
 * `echo`, a `cd` before the command, a chain) and flags after the program,
 * which become the program's own arguments, prove nothing. So does any option
 * not known to leave Node running the program: a non-executing mode such as
 * `--check`, an unknown flag, or an invalid value such as
 * `--disable-proto=invalid`, on which Node exits before it preloads anything.
 */
function plainNodeLaunch(script: string, dir: string): { preloads: string[]; program: string | null } | null {
	if (SHELL_SYNTAX_RE.test(script)) return null;
	const words = script.trim().split(/\s+/);
	if (words[0] !== "node") return null;
	const preloads: string[] = [];
	for (let index = 1; index < words.length; index++) {
		const word = words[index] ?? "";
		if (word === "--") {
			const program = words[index + 1];
			return { preloads, program: program === undefined ? null : posix.join(dir, program) };
		}
		if (!word.startsWith("-")) return { preloads, program: posix.join(dir, word) };
		const equals = word.indexOf("=");
		const flag = equals === -1 ? word : word.slice(0, equals);
		const inline = equals === -1 ? undefined : word.slice(equals + 1);
		if (NODE_PRELOAD_FLAGS.has(flag)) {
			const value = inline ?? words[++index];
			if (!value || value.startsWith("-")) return null;
			preloads.push(posix.join(dir, value));
			continue;
		}
		const runs = inline === undefined ? NODE_RUNNING_FLAGS.has(flag) : NODE_RUNNING_VALUED_FLAGS.get(flag)?.test(inline);
		if (!runs) return null;
	}
	return { preloads, program: null };
}

/**
 * Mark a module a line calls preloaded that no package script preloads. A
 * generated handbook called both `tests/harness/tmp-root.ts` and
 * `tests/harness/scratch-env.ts` preloaded; `test:file` preloads only the first,
 * and tests import the second's helpers. Scripts of every visible package.json
 * count, resolved from that package's directory, so a workspace app's own
 * preload is supported. Only a plain `node` command counts (`plainNodeLaunch`);
 * anything less certain marks the claim. The program such a script runs, such
 * as a test runner, is the launcher, not a claimed preload.
 */
function withUnsupportedPreloadsMarked(line: string, evidence: ModelGroundingCorpus): string {
	if (!PRELOAD_CLAIM_RE.test(line)) return line;
	// fileText is lowercased, so every comparison here is.
	const preloaded = new Set<string>();
	const launchers = new Set<string>();
	const scriptTexts: string[] = [];
	const addPreloads = (dir: string, script: string): void => {
		scriptTexts.push(script.toLowerCase());
		const launch = plainNodeLaunch(script, dir);
		if (!launch) return;
		for (const path of launch.preloads) preloaded.add(path.toLowerCase());
		if (launch.program) launchers.add(launch.program.toLowerCase());
	};
	for (const script of evidence.scriptBodies.values()) addPreloads("", script);
	for (const path of evidence.repositoryPaths) {
		if (!path.endsWith("/package.json")) continue;
		try {
			const scripts = (JSON.parse(evidence.fileText(path) ?? "{}") as { scripts?: unknown }).scripts;
			if (!scripts || typeof scripts !== "object") continue;
			for (const script of Object.values(scripts))
				if (typeof script === "string") addPreloads(posix.dirname(path), script);
		} catch {
			// An unparsable manifest preloads nothing.
		}
	}
	const missingPreloads = (cited: string[]): string[] =>
		cited.filter(
			(path) => MODULE_FILE_RE.test(path) && !preloaded.has(path.toLowerCase()) && !launchers.has(path.toLowerCase()),
		);
	// A module no script text names, and that launches nothing itself, is verified absent: the claim is
	// dropped, not marked. A cited launcher such as a spawn script may preload in its own code.
	const namedByNoScript = (path: string): boolean => {
		const lower = path.toLowerCase();
		if (/--(?:import|require|loader)\b|preload/.test(evidence.fileText(path) ?? "--import")) return false;
		return !scriptTexts.some((text) => text.includes(lower) || text.includes(posix.basename(lower)));
	};
	return withUnsupportedClaimsMarked(
		line,
		PRELOAD_CLAIM_RE,
		(cited) => {
			const missing = missingPreloads(cited);
			if (missing.length === 0) return null;
			return `${missing.map((path) => `\`${path}\``).join(", ")} ${missing.length === 1 ? "is" : "are"} not preloaded by a package script`;
		},
		{ refuted: (cited) => scriptTexts.length > 0 && missingPreloads(cited).every(namedByNoScript) },
	);
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
	const maxChars = MODEL_SECTION_MAX_CHARS;
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
		// Keep a nested bullet's indentation; flattening it turned a recipe's
		// sub-steps into unrelated top-level rules.
		const indent = inFence ? "" : (/^(\s*)[-*+]\s/.exec(rawLine)?.[1] ?? "").replace(/\t/g, "  ");
		const cited = correctSymbolAttributions(
			wrapBareCitations(inFence ? `\`${trimmed.replace(/`/g, "")}\`` : `${indent}${trimmed}`, evidence),
			evidence,
		);
		const marked = withUnsupportedReviewRequirementsMarked(cited, evidence);
		const line = withoutWorkflowCitations(
			inFence ? cited : withUnsupportedPreloadsMarked(withoutCiStatements(marked), evidence),
		);
		if (!line) continue;
		const codeTokens = [...line.matchAll(CODE_TOKEN_RE)]
			.map((match) => match[1]?.trim())
			.filter((token): token is string => token !== undefined && token.length > 0);
		if (codeTokens.length === 0) continue;
		// Five of six models broadened test's four explicit smoke files to test:full's glob.
		// Judge a single named script against its own body, rather than the repository-wide corpus.
		const invokedScripts = new Set(
			codeTokens.flatMap((token) => {
				const words = token.split(/\s+/);
				const name = words[1] === "run" && words.length === 3 ? words[2] : words.length === 2 ? words[1] : undefined;
				return words[0] === evidence.packageManager && name !== undefined && evidence.scriptBodies.has(name) ? [name] : [];
			}),
		);
		if (invokedScripts.size === 1) {
			const command = evidence.scriptBodies.get([...invokedScripts][0] ?? "") ?? "";
			if (codeTokens.some((token) => /[*?]/.test(token) && !command.includes(token))) continue;
		}
		if (!codeTokens.every((token) => groundedToken(token, evidence))) continue;
		// The verification section already carries every declared script exactly.
		// A rule that quotes a script body restates the manifest, and a small model
		// copying a long one cut it short and then guessed at what the cut hid.
		const collapsed = line.replace(/\s+/g, " ");
		if (!inFence && evidence.scriptRecitals.some((recital) => collapsed.includes(recital))) continue;
		if (line.replace(CODE_TOKEN_RE, "").trim().length === 0 && !inFence) continue;
		kept.push(line);
	}
	const bounded: string[] = [];
	let length = 0;
	for (const line of kept) {
		const nextLength = length + (bounded.length > 0 ? 1 : 0) + line.length;
		if (nextLength > maxChars) break;
		bounded.push(line);
		length = nextLength;
	}
	return bounded.join("\n").trim();
}

/**
 * A grounded model section may use the whole per-section budget the parser
 * allows. At 1200 characters a recipe section was cut after two bullets.
 */
const MODEL_SECTION_MAX_CHARS = HANDBOOK_TARGETS.sectionChars;

/** One model-written rule line, kept only when it passes the citation rule whole. */
function groundedModelLine(line: string, evidence: ModelGroundingCorpus | null): string | null {
	const trimmed = line.replace(/\s+/g, " ").trim();
	if (trimmed.length === 0) return null;
	if (!evidence) return trimmed;
	return groundedModelBody(trimmed, evidence) || null;
}

const RULE_LANGUAGE_RE = /\b(?:never|must|forbidden|required|do not|don't|preserve|only|ask the user before)\b/i;
const MAX_UNVERIFIABLE_RULES = 6;

/**
 * Root handbooks are authored policy, but a sibling handbook may be stale or
 * wrong about this tree. Every unit is verified before it is adopted: one whose
 * citations all resolve is kept with its source line, one citing a path or
 * script the tree lacks is stale, one asserting a tree fact the tree states
 * otherwise is contradicted, and at most a few uncited rules survive, ranked by
 * how many sources state them.
 */
function authoredProjectRules(
	input: BootstrapGenerateInput,
	output: BootstrapStructuredOutput,
	corpus: ModelGroundingCorpus,
): ClioMdSection[] {
	const normalize = normalizeHandbookRule;
	const generated = normalize(
		[...output.invariants, ...output.conventions, ...(output.sections ?? []).map((section) => section.body)].join("\n"),
	);
	const facts = treeFacts(input.cwd, input.enforcement?.ciCommands ?? []);
	const units: Array<{ line: string; file: string; at: number; operating: boolean; key: string; order: number }> = [];
	const sourcesByKey = new Map<string, Set<string>>();
	for (const file of handbookInstructionFiles(input)) {
		const source = relative(input.cwd, file.path).split("\\").join("/");
		// Global preferences remain separate; only project-wide handbooks become
		// unconditional project rules, and fenced examples supply no policy.
		if (source.startsWith("../")) continue;
		// Hard-wrapped handbooks emitted 30+ physical-line fragments; retain complete rules with their heading scope.
		for (const unit of instructionUnits(file.content, 600, source)) {
			const line = unit.text.replace(/^Project rules:\s*/i, "").trim();
			if (line.length === 0) continue;
			const key = normalize(line);
			const stating = sourcesByKey.get(key) ?? new Set<string>();
			stating.add(source);
			sourcesByKey.set(key, stating);
			units.push({
				line,
				file: unit.file,
				at: unit.line,
				operating: /\b(?:operating|development sessions|default scope|development checks)\b/i.test(unit.heading),
				key,
				order: units.length,
			});
		}
	}
	const ledger = input.handbookLedger;
	const record = (
		unit: (typeof units)[number],
		citations: string[],
		verdict: HandbookLedgerEntry["verdict"],
		reason: string,
		kept: boolean,
	): void => {
		ledger?.push({
			id: createHash("sha256").update(`${unit.file}:${unit.at}:${unit.line}`).digest("hex").slice(0, 12),
			text: unit.line,
			origin: "adopted",
			source: { file: unit.file, line: unit.at },
			citations,
			verdict,
			reason,
			kept,
		});
	};
	const candidates: Array<{
		unit: (typeof units)[number];
		line: string;
		citations: string[];
		verified: boolean;
		emphasized: boolean;
	}> = [];
	const seen = new Set<string>();
	for (const unit of units) {
		const citations = [...unit.line.matchAll(CODE_TOKEN_RE)].map((match) => match[1] ?? "").filter(Boolean);
		const grounded = groundedModelBody(unit.line, corpus);
		if (citations.length > 0 && grounded.length === 0) {
			const unresolved = citations.filter((token) => !groundedToken(token, corpus));
			record(
				unit,
				citations,
				"stale",
				unresolved.length > 0
					? `does not resolve in this tree: ${unresolved.join(", ")}`
					: "its citations do not pass the citation rule",
				false,
			);
			continue;
		}
		const fact = contradictingFact(unit.line, facts);
		if (fact) {
			record(unit, citations, "contradicted", `${fact.source} states ${fact.key} ${fact.value}`, false);
			continue;
		}
		const verified = grounded.length > 0;
		const line = verified ? grounded.replace(/\s*\n\s*/g, " ") : unit.line;
		const sentences = line.split(/(?<=[.!?])\s+(?=[A-Z])/).map(normalize);
		if (seen.has(unit.key)) {
			record(unit, citations, verified ? "verified" : "unverifiable", "an earlier unit states it", false);
			continue;
		}
		if (sentences.every((sentence) => generated.includes(sentence))) {
			seen.add(unit.key);
			record(unit, citations, verified ? "verified" : "unverifiable", "the draft already states it", true);
			continue;
		}
		seen.add(unit.key);
		// Fragment-heavy handbooks hid strong policy; prefer caps or bold rule language under the cap.
		const emphasized =
			/\b(?:NEVER|MUST|CRITICAL|IMPORTANT)\b/.test(line) ||
			[...line.matchAll(/\*\*([^*]+)\*\*|__([^_]+)__/g)].some((match) =>
				/\b(?:never|must|critical|important)\b/i.test(match[1] ?? match[2] ?? ""),
			);
		candidates.push({ unit, line, citations, verified, emphasized });
	}
	// A rule nothing cites survives only as one of the few most-stated rules, and never against a kept rule.
	const keptClaims = candidates.filter((candidate) => candidate.verified).flatMap((c) => factClaims(c.line));
	const unverifiable = candidates
		.filter((candidate) => !candidate.verified)
		.sort(
			(a, b) =>
				(sourcesByKey.get(b.unit.key)?.size ?? 0) - (sourcesByKey.get(a.unit.key)?.size ?? 0) ||
				a.unit.order - b.unit.order,
		);
	const admitted = new Set<(typeof candidates)[number]>(candidates.filter((candidate) => candidate.verified));
	let uncited = 0;
	for (const candidate of unverifiable) {
		const against = factClaims(candidate.line).find((claim) =>
			keptClaims.some((kept) => kept.key === claim.key && kept.value !== claim.value),
		);
		if (against) {
			record(candidate.unit, candidate.citations, "contradicted", `a kept rule states another ${against.key}`, false);
			continue;
		}
		if (!RULE_LANGUAGE_RE.test(candidate.line) || uncited >= MAX_UNVERIFIABLE_RULES) {
			record(candidate.unit, candidate.citations, "unverifiable", "cites nothing the tree can check", false);
			continue;
		}
		uncited += 1;
		admitted.add(candidate);
	}
	// Bound both sections together so numerous authored rules cannot overwhelm the lean handbook.
	const retained: typeof candidates = [];
	let chars = 0;
	const rendered = (candidate: (typeof candidates)[number]): string =>
		`- ${candidate.line} (source: ${candidate.unit.file}:${candidate.unit.at})`;
	for (const candidate of [...admitted].sort(
		(a, b) => Number(b.emphasized) - Number(a.emphasized) || a.unit.order - b.unit.order,
	)) {
		const length = rendered(candidate).length + 1;
		const fits = retained.length < 16 && chars + length <= 5000;
		record(
			candidate.unit,
			candidate.citations,
			candidate.verified ? "verified" : "unverifiable",
			fits
				? candidate.verified
					? "every citation resolves"
					: "cites nothing, but sources state it and nothing contradicts it"
				: "over the authored-rule budget",
			fits,
		);
		if (!fits) continue;
		retained.push(candidate);
		chars += length;
	}
	const rules: string[] = [];
	const operating: string[] = [];
	// Priority decides survival, while source order keeps the retained rules readable in their original context.
	for (const candidate of retained.sort((a, b) => a.unit.order - b.unit.order))
		(candidate.unit.operating ? operating : rules).push(rendered(candidate));
	return [
		...(operating.length ? [{ title: "Operating instructions from project handbooks", body: operating.join("\n") }] : []),
		...(rules.length ? [{ title: "Authored project rules", body: rules.join("\n") }] : []),
	];
}

function sanitizeModelSection(section: ClioMdSection, evidence: ModelGroundingCorpus): ClioMdSection | null {
	const body = groundedModelBody(section.body, evidence);
	if (body.length < 40) return null;
	const title = section.title.replace(/\s+/g, " ").trim();
	return title.length > 0 ? { title, body } : null;
}

// Repeated boundary rules consumed both invariant and convention slots; compare stable citation and prose tokens.
// Citations keep a leading backtick so the two kinds stay apart.
function handbookRuleTokens(rule: string): ReadonlySet<string> {
	return new Set(
		[
			...normalizeHandbookRule(rule)
				.toLowerCase()
				.matchAll(/`([^`\n]+)`|\b[a-z]{4,}\b/g),
		].map((match) => (match[1] !== undefined ? `\`${match[1]}` : match[0])),
	);
}

// A path below the root: a root document such as `CONTRIBUTING.md` is cited as the source of unrelated rules.
const CITED_FILE_RE = /^`[^`\s/]+\/[^`\s]/;

/** Most words match: two bullets that only cite the same files may state different obligations. */
/** Two rules that cite different checker ids (`rule3`, `rule9`) are different rules, however alike they read. */
function sameRuleIds(a: string, b: string): boolean {
	const ids = (text: string): string => [...new Set(text.match(/\brule\d+\b/g) ?? [])].sort().join(",");
	const left = ids(a);
	const right = ids(b);
	return left === "" || right === "" || left === right;
}

/**
 * The kept rule this one rewords: most of its words match. With `citedFloor`, a lower share also counts when
 * both cite the same file below the root, as two wordings of one handbook rule usually do.
 */
function rewordedRule<T extends ReadonlySet<string>>(
	tokens: ReadonlySet<string>,
	kept: ReadonlyArray<T>,
	citedFloor?: number,
): T | undefined {
	return kept.find((other) => {
		const shorter = tokens.size <= other.size ? tokens : other;
		const longer = tokens.size <= other.size ? other : tokens;
		if (shorter.size === 0) return false;
		const shared = [...shorter].filter((token) => longer.has(token));
		const share = shared.length / shorter.size;
		if (share >= 0.7) return true;
		return citedFloor !== undefined && share >= citedFloor && shared.some((token) => CITED_FILE_RE.test(token));
	});
}

/**
 * Two rules are one when most words match, or when they cite the same files
 * and names. A model that states a rule as an invariant and again as a change
 * recipe rewords it (Clio's own settings rule shared 42% of its words with its
 * restatement) but cites the same `src/core/defaults.ts` symbols in both.
 */
function restatesHandbookRule(tokens: ReadonlySet<string>, kept: ReadonlyArray<ReadonlySet<string>>): boolean {
	const citations = [...tokens].filter((token) => token.startsWith("`"));
	return kept.some((other) => {
		const shorter = tokens.size <= other.size ? tokens : other;
		const longer = tokens.size <= other.size ? other : tokens;
		if (shorter.size > 0 && [...shorter].filter((token) => longer.has(token)).length / shorter.size >= 0.7) return true;
		const otherCitations = [...other].filter((token) => token.startsWith("`"));
		const shared = citations.filter((token) => other.has(token));
		const fewest = Math.min(citations.length, otherCitations.length);
		return shared.length >= 2 && shared.some((token) => CITED_FILE_RE.test(token)) && shared.length / fewest >= 2 / 3;
	});
}

const CHECKER_SECTION_TITLE = "Checker-enforced invariants";

interface CheckerRule {
	code: string;
	path: string;
	/** The rule as one or more whole sentences, its paths marked as code. */
	sentence: string;
	/** It constrains imports between path sets, so it is a hard invariant of the build. */
	architectural: boolean;
}

const IMPORT_RULE_RE = /\b(?:value-)?import(?:s|er|ers|ed|ing)?\b/i;
const RULE_PATH_RE = /@?[\w.*<>-]+(?:\/[\w.*<>-]*)+/g;
const RULE_CODE_TOKEN_RE =
	/(@?[\w.*<>-]+(?:\/[\w.*<>-]*)+|\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|\b[\w*-]+\.(?:[cm]?[jt]sx?|json|md|ya?ml)\b)/g;

/**
 * A path in a rule's prose names repository paths when it is a pattern, a
 * package scope, or exists here; `messages/ledger` in a sentence is prose.
 */
function rulePathToken(token: string, files: ReadonlySet<string>, directories: ReadonlySet<string>): boolean {
	if (!token.includes("/")) return true;
	if (/[*<>]/.test(token) || token.startsWith("@")) return true;
	const path = token.replace(/\/$/, "");
	return files.has(path) || directories.has(path);
}

function markRuleCode(text: string, files: ReadonlySet<string>, directories: ReadonlySet<string>): string {
	return text.replace(RULE_CODE_TOKEN_RE, (match) => {
		const token = match.replace(/\.+$/, "");
		if (!rulePathToken(token, files, directories)) return match;
		return `\`${token}\`${match.slice(token.length)}`;
	});
}

/**
 * Every coded rule the project's checkers declare, as a whole sentence with
 * its subject. The failure message is the fallback only: it names the
 * offending file and interpolates the rule's subject away.
 */
function checkerRuleList(input: BootstrapGenerateInput): CheckerRule[] {
	const files = new Set(input.repositoryFiles ?? []);
	const directories = new Set<string>();
	for (const file of files) {
		const parts = file.split("/");
		for (let index = 1; index < parts.length; index += 1) directories.add(parts.slice(0, index).join("/"));
	}
	const rules: CheckerRule[] = [];
	for (const file of input.enforcement?.checkFiles ?? []) {
		for (const rule of file.rules ?? []) {
			const text =
				rule.source === "failure" ? `A file that ${rule.text.replace(/^…\s*/, "").replace(/\(…\s*\)/g, "")}` : rule.text;
			const sentence = markRuleCode(text.replace(/[\s.;:,]+$/, ""), files, directories);
			const paths = [...rule.text.matchAll(RULE_PATH_RE)].length;
			rules.push({
				code: rule.code,
				path: file.path,
				sentence: `${sentence}. Checked as \`${rule.code}\` by \`${file.path}\`.`,
				architectural: IMPORT_RULE_RE.test(rule.text) && paths > 0,
			});
		}
	}
	const number = (code: string): number => Number(/\d+/.exec(code)?.[0] ?? 0);
	return rules.sort((a, b) => a.path.localeCompare(b.path) || number(a.code) - number(b.code));
}

/** What compiling the handbook merged or corrected in the rules it kept; reported, never silent. */
interface HandbookCompileReport {
	merged: { kept: string; dropped: string }[];
	ruleIds: { from: string; to: string }[];
	unknownRuleIds: string[];
}

/**
 * A rule that cites one checker id (`rule15`) is held against the checker's own rules. When another id's text
 * matches the rule clearly better, the id was renumbered since the rule was written and is rewritten; when no
 * checker rule matches and the id is absent, it is reported. A sentence the checker section derived is left as is.
 */
function correctedRuleIds(line: string, rules: ReadonlyArray<CheckerRule>, report?: HandbookCompileReport): string {
	if (rules.length === 0) return line;
	const ids = [...new Set([...line.matchAll(/\brule\d+\b/g)].map((match) => match[0]))];
	const id = ids[0];
	if (ids.length !== 1 || id === undefined || rules.some((rule) => rule.sentence === line)) return line;
	const tokens = handbookRuleTokens(line.replaceAll(id, " "));
	const score = (rule: CheckerRule): number => {
		const own = handbookRuleTokens(rule.sentence.replace(/\s*Checked as `[^`]+` by `[^`]+`\.$/, ""));
		return own.size === 0 ? 0 : [...own].filter((token) => tokens.has(token)).length / own.size;
	};
	let best: { code: string; score: number } | undefined;
	let cited = -1;
	for (const rule of rules) {
		const value = score(rule);
		if (rule.code === id) cited = Math.max(cited, value);
		if (!best || value > best.score) best = { code: rule.code, score: value };
	}
	if (!best || best.score < 0.3) {
		if (cited < 0 && !report?.unknownRuleIds.includes(id)) report?.unknownRuleIds.push(id);
		return line;
	}
	// Rules of one checker share its vocabulary, so a renumbering must win clearly: on this repository's own
	// handbook a correct id scored 0.27 against 0.38 for a neighbour, and the renumbered owner rule 0.27 against 0.46.
	if (best.code === id || best.score < 0.4 || best.score - Math.max(cited, 0) < 0.15) return line;
	report?.ruleIds.push({ from: id, to: best.code });
	return line.replace(new RegExp(`\\b${id}\\b`, "g"), best.code);
}

/** Whether handbook prose names a rule code, alone (`rule8`) or in a list (`rules 10 and 14`). */
function namesRuleCode(code: string, text: string): boolean {
	const lower = text.toLowerCase();
	const exact = code.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	if (new RegExp(`(?:^|[^a-z0-9])${exact}(?![a-z0-9])`).test(lower)) return true;
	const parts = /^([a-z]+)(\d+[a-z]?)$/.exec(code.toLowerCase());
	if (!parts) return false;
	return new RegExp(`\\b${parts[1]}s\\s+(?:[\\w-]+\\s*(?:,|and|or|/|&)\\s*)*${parts[2]}(?![a-z0-9])`).test(lower);
}

/** Scripts npm runs on install, pack, publish and version without being asked. */
const LIFECYCLE_SCRIPTS: ReadonlySet<string> = new Set([
	"preinstall",
	"install",
	"postinstall",
	"prepublish",
	"preprepare",
	"prepare",
	"postprepare",
	"prepublishOnly",
	"prepack",
	"postpack",
	"publish",
	"postpublish",
	"preversion",
	"version",
	"postversion",
	"dependencies",
]);

interface EnforcementNames {
	/** Lifecycle scripts package.json declares: cited only in backticks. */
	scripts: ReadonlySet<string>;
	/** Single-word failure codes (`lint`): cited in backticks, or named bare before "check" ("the prompts check"). */
	codes: ReadonlySet<string>;
	/** Codes with a hyphen or digit (`case-portable-paths`, `rule12`) and check functions, which prose names bare. */
	named: ReadonlyArray<string>;
}

/**
 * Every name under which the inventory shows a check failing a change: the
 * checks and coded failures check files define, and the lifecycle scripts npm
 * runs unasked. A check file's path is not one: a rule citing
 * `scripts/check-hygiene.ts` may name a check that file no longer defines.
 */
function enforcementNames(input: BootstrapGenerateInput): EnforcementNames {
	const scripts = new Set(Object.keys(packageScripts(input.cwd)).filter((name) => LIFECYCLE_SCRIPTS.has(name)));
	const codes = new Set<string>();
	const named = new Set<string>();
	const addCode = (code: string): void => {
		if (/[-\d]/.test(code)) named.add(code);
		else codes.add(code);
	};
	for (const file of input.enforcement?.checkFiles ?? []) {
		for (const check of file.checks) named.add(check);
		for (const failure of file.failures) {
			const head = /^([\w.:/-]+): /.exec(failure)?.[1];
			for (const code of head?.split("/") ?? []) addCode(code);
		}
		for (const rule of file.rules ?? []) addCode(rule.code);
	}
	return { scripts, codes, named: [...named] };
}

/** A check function (`checkCasePortablePaths`) keyed as its failure code (`case-portable-paths`). */
function checkCode(name: string): string {
	return /^check[A-Z]/.test(name)
		? name
				.slice(5)
				.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
				.toLowerCase()
		: name.toLowerCase();
}

/** The enforcement a rule names, typed so a script and a code of one name stay apart: `script:prepublishOnly`, `code:case-portable-paths`. */
function namedEnforcement(rule: string, names: EnforcementNames): string[] {
	const found = new Set<string>();
	for (const match of rule.matchAll(/`([^`\n]+)`/g)) {
		const token = (match[1] ?? "").trim();
		const script = /^(?:pnpm|npm|yarn|bun)(?: run)? ([\w:.-]+)$/.exec(token)?.[1] ?? token;
		if (names.scripts.has(script)) found.add(`script:${script}`);
		if (names.codes.has(token)) found.add(`code:${token.toLowerCase()}`);
	}
	const lower = rule.toLowerCase();
	for (const code of names.codes) {
		const exact = code.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		if (new RegExp(`(?<![\\w\`.:-])${exact}\\s+checks?\\b`).test(lower)) found.add(`code:${code.toLowerCase()}`);
	}
	for (const name of names.named) if (namesRuleCode(name, rule)) found.add(`code:${checkCode(name)}`);
	return [...found];
}

/**
 * The previous handbook's hard invariants, verbatim, while every path and
 * symbol each one cites still grounds. A rewrite drafts afresh, and small
 * models left check-enforced rules (case-colliding paths, retired HTML docs,
 * the gitignored-literal join, the throwing `prepublishOnly`) out of Hard
 * invariants, and reworded the published-tag rule only `CONTRIBUTING.md`
 * states. A rule whose citations no longer ground is not carried. A carried
 * rule keeps every word except a clause that names CI, which model text loses
 * too: a claim an older handbook made about CI otherwise survived every
 * rewrite. A sentence that cites a workflow file is cut whole.
 */
function groundedPreviousInvariants(input: BootstrapGenerateInput, corpus: ModelGroundingCorpus): CarriedInvariant[] {
	const carried: CarriedInvariant[] = [];
	for (const invariant of input.previousInvariants ?? []) {
		const source = withoutWorkflowCitations(invariant.replace(/\s+/g, " ").trim());
		const rule = withoutCiClauses(source);
		if (!rule || carried.some((entry) => entry.rule === rule) || groundedModelLine(rule, corpus) === null) continue;
		carried.push({ rule, modelCopy: withoutCiStatements(source) });
	}
	return carried;
}

/**
 * A carried rule and each run of its leading clauses: a model that shortened
 * "Keep X: Y." to "Keep X." restated the carried rule and adds nothing to it.
 */
function carriedRuleKeys(rule: string): string[] {
	const clauses = rule.split(/(?<=[.;:!?])\s+/);
	return clauses.map((_, index) => clauses.slice(0, index + 1).join(" "));
}

interface CarriedInvariant {
	rule: string;
	/** What grounding leaves of a model copy of the previous rule: its sentences that name CI are cut whole. */
	modelCopy: string;
}

/**
 * Sections of the replaced handbook, cut to the blocks that name a check the
 * repository still defines and whose citations still ground. A rewrite on mini
 * dropped Docs and prose, the section documentation workers receive, while its
 * documentation-links, product-namespace and prompts checks all still existed.
 * A block is grounded like model text, so its sentences that name CI are cut.
 */
function enforcedPreviousSections(
	input: BootstrapGenerateInput,
	names: EnforcementNames,
	corpus: ModelGroundingCorpus,
): ClioMdSection[] {
	const carried: ClioMdSection[] = [];
	for (const section of input.previousSections ?? []) {
		if (section.title === CHECKER_SECTION_TITLE) continue;
		const blocks = handbookBlocks(section.body).flatMap((block) => {
			if (namedEnforcement(block, names).length === 0) return [];
			const grounded = groundedModelBody(block, corpus);
			return grounded && namedEnforcement(grounded, names).length > 0 ? [grounded] : [];
		});
		if (blocks.length > 0) carried.push({ title: section.title, body: blocks.join("\n") });
	}
	return carried;
}

/**
 * A model rule the checker already states: it names only codes the checker
 * declares in `stated`, or restates one of them in other words.
 */
function restatesCheckerRule(
	rule: string,
	stated: ReadonlyArray<CheckerRule>,
	all: ReadonlyArray<CheckerRule>,
	statedTokens: ReadonlyArray<ReadonlySet<string>>,
): boolean {
	const named = all.filter((checker) => namesRuleCode(checker.code, rule));
	if (named.length > 0) return named.every((checker) => stated.includes(checker));
	return restatesHandbookRule(handbookRuleTokens(rule), statedTokens);
}

/**
 * The coded rules not stated above, listed so a checker rule is never silently
 * missing from the handbook. A rule the handbook names by code, or a kept rule
 * states word for word, is left out. Sharing its citations is not stating it:
 * a gotcha that `SURFACE_TOTAL_EXEMPTIONS` only shrinks cost rule14, that the
 * surfaces sum no token or cost field, its place here.
 */
function uncoveredCheckerSection(
	rules: ReadonlyArray<CheckerRule>,
	handbook: string,
	keptKeys: ReadonlySet<string>,
): ClioMdSection | null {
	const lines: string[] = [];
	let chars = 0;
	for (const rule of rules) {
		if (namesRuleCode(rule.code, handbook)) continue;
		if (keptKeys.has(normalizeHandbookRule(rule.sentence))) continue;
		const line = `- ${rule.sentence}`;
		if (chars + line.length + 1 > HANDBOOK_TARGETS.sectionChars - 200) break;
		lines.push(line);
		chars += line.length + 1;
	}
	if (lines.length === 0) return null;
	return {
		title: CHECKER_SECTION_TITLE,
		body: [
			"Rules the project's checks declare that the rules above do not state, each in its checker's words. A change that breaks one fails that check.",
			...lines,
		].join("\n"),
	};
}

/** Strictness flags whose meaning an agent cannot read off ordinary code. */
const TSCONFIG_STRICT_FLAGS: ReadonlyArray<readonly [string, string]> = [
	["exactOptionalPropertyTypes", "an optional property is omitted, never assigned `undefined`"],
	["noUncheckedIndexedAccess", "an index access yields `T | undefined`"],
	["noImplicitOverride", "an overriding member is marked `override`"],
	["noPropertyAccessFromIndexSignature", "an index-signature key is read with brackets"],
];

/**
 * The root `tsconfig.json` strictness flags a handbook does not already name,
 * as one convention. Two drafts in a row dropped this line, and it decides
 * whether code compiles.
 */
function tsconfigConvention(cwd: string, handbook: string): string | null {
	let options: Record<string, unknown> = {};
	try {
		const raw = readFileSync(join(cwd, "tsconfig.json"), "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^\s*\/\/.*$/gm, "")
			.replace(/,(\s*[}\]])/g, "$1");
		const parsed = JSON.parse(raw) as { compilerOptions?: Record<string, unknown> };
		options = parsed.compilerOptions ?? {};
	} catch {
		// No root tsconfig, or one this reader cannot parse: no convention is stated.
		return null;
	}
	const enabled = TSCONFIG_STRICT_FLAGS.filter(([flag]) => options[flag] === true && !handbook.includes(flag));
	if (enabled.length === 0) return null;
	return `\`tsconfig.json\` enables ${enabled.map(([flag, meaning]) => `\`${flag}\` (${meaning})`).join(", ")}.`;
}

export interface ExpectedSection {
	title: string;
	reason: string;
}

/**
 * The sections a handbook must carry when the evidence supports them. A draft
 * from the same model on the same repository kept Change recipes in one run
 * and dropped the whole section in the next, and nothing said so.
 */
function missingHandbookSections(
	input: Pick<BootstrapGenerateInput, "cwd" | "enforcement">,
	draft: Pick<BootstrapStructuredOutput, "sections">,
): ExpectedSection[] {
	const titles = (draft.sections ?? []).map((section) => section.title);
	const missing: ExpectedSection[] = [];
	const checks = (input.enforcement?.checkFiles ?? []).filter((file) => file.failures.length > 0);
	if (checks.length > 0 && !titles.some((title) => /recipe/i.test(title))) {
		missing.push({
			title: "Change recipes",
			reason: `${checks.map((file) => file.path).join(", ")} report failures a change can only fix by editing files together`,
		});
	}
	if (typeof packageScripts(input.cwd).test === "string" && !titles.some((title) => /\btests?\b/i.test(title))) {
		missing.push({ title: "Tests", reason: "package.json declares a test script" });
	}
	return missing;
}

function stabilizeGeneratedOutput(
	input: BootstrapGenerateInput,
	base: BootstrapStructuredOutput,
	onModelSectionRetained?: () => void,
	groundModelOutput = false,
	onProtected?: (content: ProtectedHandbook) => void,
	report?: HandbookCompileReport,
): BootstrapStructuredOutput {
	const tomlFiles = input.tomlFiles ?? createTomlFileReader(input.cwd);
	const existing = input.existingClioMd;
	const groundingCorpus = groundModelOutput ? createModelGroundingCorpus(input) : null;
	// Human-authored rules first, then the model's grounded rules, then the
	// sibling-file heuristics, so a generated rule never displaces an authored one.
	const conventions: string[] = [];
	for (const convention of existing?.conventions ?? []) pushUnique(conventions, convention);
	for (const convention of base.conventions ?? []) {
		const grounded = groundedModelLine(convention, groundingCorpus);
		if (grounded) {
			pushUnique(conventions, grounded);
			if (groundModelOutput) onModelSectionRetained?.();
		}
	}
	for (const convention of conventions.length === 0
		? inferConventions(input.cwd, handbookInstructionFiles(input), input.codewiki)
		: []) {
		pushUnique(conventions, convention);
	}
	const invariants: string[] = [];
	for (const invariant of existing?.invariants ?? []) pushUnique(invariants, invariant);
	for (const invariant of base.invariants ?? []) {
		const grounded = groundedModelLine(invariant, groundingCorpus);
		if (grounded) {
			pushUnique(invariants, grounded);
			if (groundModelOutput) onModelSectionRetained?.();
		}
	}
	for (const invariant of inferInvariants(handbookInstructionFiles(input))) pushUnique(invariants, invariant);
	// A checker rule that constrains imports between path sets is a hard
	// invariant: it leads, in the checker's own declaration, and a model rule
	// that only restates one gives way to it.
	const checkerRules = checkerRuleList(input);
	const architectural = checkerRules.filter((rule) => rule.architectural);
	const architecturalTokens = architectural.map((rule) => handbookRuleTokens(rule.sentence));
	const restatesArchitecture = (rule: string): boolean =>
		architectural.length > 0 && restatesCheckerRule(rule, architectural, checkerRules, architecturalTokens);
	const names = enforcementNames(input);
	const carryCorpus =
		(input.previousInvariants?.length ?? 0) > 0 || (input.previousSections?.length ?? 0) > 0
			? (groundingCorpus ?? createModelGroundingCorpus(input))
			: null;
	const carriedInvariants = carryCorpus
		? groundedPreviousInvariants(input, carryCorpus).filter((entry) => !restatesArchitecture(entry.rule))
		: [];
	const carried = carriedInvariants.map((entry) => entry.rule);
	const carriedBlocks = carryCorpus ? enforcedPreviousSections(input, names, carryCorpus) : [];
	// A model rule gives way to carried content only when it states it, or its leading clauses, word for word.
	// One that resembles a carried rule may add a clause, flip a prohibition or change its scope, so both stay.
	// A model copy of a carried invariant loses its CI sentences, so what remains of it counts as the carried rule too.
	const carriedKeys = new Set(
		[
			...carriedInvariants.flatMap((entry) => [...carriedRuleKeys(entry.rule), entry.modelCopy]),
			...carriedBlocks.flatMap((section) => handbookBlocks(section.body)).flatMap(carriedRuleKeys),
		]
			.filter((rule) => rule.length > 0)
			.map(normalizeHandbookRule),
	);
	const duplicatesCarried = (rule: string): boolean => carriedKeys.has(normalizeHandbookRule(rule));
	// Checker import rules, carried rules and authored rules lead and are never cut: a model rule gives way to
	// them, and the cap applies to model rules alone. When they exceed the target on their own they all stay,
	// and the handbook parser warns that hard invariants exceed it.
	const authoredInvariants = existing?.invariants ?? [];
	const protectedInvariants: string[] = [];
	for (const rule of architectural) {
		if (!authoredInvariants.includes(rule.sentence)) pushUnique(protectedInvariants, rule.sentence);
	}
	// Carried and authored rules lead and are not cut for length, but one that rewords an earlier one is the
	// same rule twice: the first wording stays and the pair is reported.
	const protectedWording = new Map<ReadonlySet<string>, string>();
	const rewordingOf = (rule: string): string | undefined => {
		const candidates = [...protectedWording].filter(([, kept]) => sameRuleIds(rule, kept)).map(([tokens]) => tokens);
		const match = rewordedRule(handbookRuleTokens(rule), candidates, 0.55);
		return match ? protectedWording.get(match) : undefined;
	};
	const pushProtected = (rule: string): void => {
		if (protectedInvariants.includes(rule)) return;
		const kept = rewordingOf(rule);
		if (kept !== undefined) {
			report?.merged.push({ kept, dropped: rule });
			return;
		}
		protectedWording.set(handbookRuleTokens(rule), rule);
		protectedInvariants.push(rule);
	};
	for (const rule of carried) if (!authoredInvariants.includes(rule)) pushProtected(rule);
	for (const rule of authoredInvariants) pushProtected(rule);
	// A previous section block counts as stated only by a rule the final fit cannot cut, word for word.
	const protectedKeys = new Set(protectedInvariants.map(normalizeHandbookRule));
	// A model rule that only resembles a carried one may flip it or add a clause, so it stays (see above).
	const modelInvariants = invariants.filter(
		(rule) =>
			!authoredInvariants.includes(rule) &&
			!protectedInvariants.includes(rule) &&
			!restatesArchitecture(rule) &&
			!duplicatesCarried(rule),
	);
	const retainedInvariants = [
		...protectedInvariants,
		...modelInvariants.slice(0, Math.max(0, HANDBOOK_TARGETS.invariants - protectedInvariants.length)),
	];
	const uncarriedInvariantTokens = retainedInvariants.filter((rule) => !carried.includes(rule)).map(handbookRuleTokens);
	const typescriptConvention = tsconfigConvention(
		input.cwd,
		[...retainedInvariants, ...conventions, ...(base.sections ?? []).map((section) => section.body)].join("\n"),
	);
	// Invariants win over conventions, then both win over section bullets so boundary rules appear once.
	const retainedConventions = [
		...(typescriptConvention ? [typescriptConvention] : []),
		...conventions
			.filter(
				(rule) =>
					!restatesHandbookRule(handbookRuleTokens(rule), uncarriedInvariantTokens) &&
					!duplicatesCarried(rule) &&
					!restatesArchitecture(rule),
			)
			.slice(0, HANDBOOK_TARGETS.conventions - (typescriptConvention ? 1 : 0)),
	];
	const uncarriedRuleTokens = [...uncarriedInvariantTokens, ...retainedConventions.map(handbookRuleTokens)];

	const verification = verificationSection(input.cwd, tomlFiles);
	const inferredSections = inferHeuristicSections(input);
	const existingSections = existing?.sections ?? [];
	const ordinarySections: ClioMdSection[] = [];
	const modelSections = new Set<ClioMdSection>();
	const seenSectionTitles = new Set<string>();
	const addSection = (section: ClioMdSection, modelSection = false, carriedSection = false): boolean => {
		if (VERIFICATION_SECTION_RE.test(section.title)) return false;
		const restatesKept = (block: string): boolean =>
			carriedSection
				? protectedKeys.has(normalizeHandbookRule(block))
				: restatesHandbookRule(handbookRuleTokens(block), uncarriedRuleTokens) || duplicatesCarried(block);
		// A bullet that rewords an earlier bullet of the same section is dropped; the first wording stays.
		const keptHere = new Map<ReadonlySet<string>, string>();
		const body = handbookBlocks(section.body)
			.filter((block) => {
				if (!/^\s*(?:[-*+]\s|\d+[.)]\s)/.test(block)) return true;
				if (restatesKept(block) || restatesArchitecture(block)) return false;
				if (!carriedSection) {
					// Plurals fold to one word here so "links" and "link" match between two bullets of one section.
					const tokens = new Set(
						[...handbookRuleTokens(block)].map((token) => (token.startsWith("`") ? token : token.replace(/s$/, ""))),
					);
					const match = rewordedRule(
						tokens,
						[...keptHere].filter(([, kept]) => sameRuleIds(block, kept)).map(([keys]) => keys),
						0.55,
					);
					if (match) {
						report?.merged.push({ kept: keptHere.get(match) ?? "", dropped: block });
						return false;
					}
					keptHere.set(tokens, block);
				}
				return true;
			})
			.join("\n");
		if (!body.trim()) return false;
		const titleKey = section.title.replace(/\s+/g, " ").trim().toLowerCase();
		if (seenSectionTitles.has(titleKey)) return false;
		seenSectionTitles.add(titleKey);
		const retained = body === section.body ? section : { ...section, body };
		ordinarySections.push(retained);
		if (modelSection) modelSections.add(retained);
		return true;
	};
	const authoredRules = authoredProjectRules(input, base, groundingCorpus ?? createModelGroundingCorpus(input));
	for (const section of authoredRules) addSection(section);
	// Authored sections, then the model's grounded sections, then heuristics:
	// the model reads the repository, the heuristics only read its metadata.
	// The checker section is derived on every run; a stale copy from the previous handbook is not authored.
	for (const section of existingSections) if (section.title !== CHECKER_SECTION_TITLE) addSection(section);
	for (const section of base.sections ?? []) {
		const sanitized = groundingCorpus ? sanitizeModelSection(section, groundingCorpus) : section;
		if (sanitized) addSection(sanitized, true);
	}
	// A previous section returns under its title when the draft dropped the title. Under a kept title, its
	// enforced blocks lead, verbatim, and the model's blocks follow unless one states a carried block word for
	// word: naming the same check is not stating the same instruction. A block a protected rule or an earlier
	// carried block states word for word is not repeated. Only the carried blocks are protected, so neither the
	// section limit nor the final fit cuts them, while the model's additions fit like any other content.
	const carriedSections = new Map<ClioMdSection, string[]>();
	const carriedSeen = new Set(protectedKeys);
	for (const section of carriedBlocks) {
		const blocks = handbookBlocks(section.body).filter((block) => {
			const blockKey = normalizeHandbookRule(block);
			if (carriedSeen.has(blockKey)) return false;
			carriedSeen.add(blockKey);
			return true;
		});
		if (blocks.length === 0) continue;
		const key = section.title.replace(/\s+/g, " ").trim().toLowerCase();
		const index = ordinarySections.findIndex((kept) => kept.title.replace(/\s+/g, " ").trim().toLowerCase() === key);
		const current = ordinarySections[index];
		if (!current) {
			const retained = addSection({ title: section.title, body: blocks.join("\n") }, false, true)
				? ordinarySections.at(-1)
				: undefined;
			if (retained) carriedSections.set(retained, handbookBlocks(retained.body));
			continue;
		}
		const blockKeys = new Set(blocks.map(normalizeHandbookRule));
		const additions = handbookBlocks(current.body).filter((block) => !blockKeys.has(normalizeHandbookRule(block)));
		const merged = { ...current, body: [...blocks, ...additions].join("\n") };
		ordinarySections[index] = merged;
		if (modelSections.delete(current)) modelSections.add(merged);
		carriedSections.set(merged, blocks);
	}
	const keptRules = [
		...retainedInvariants,
		...retainedConventions,
		...ordinarySections.flatMap((section) => handbookBlocks(section.body)),
	];
	const checkerSection = uncoveredCheckerSection(
		checkerRules.filter((rule) => !rule.architectural),
		keptRules.join("\n"),
		new Set(keptRules.map(normalizeHandbookRule)),
	);
	if (checkerSection) addSection(checkerSection);
	for (const section of inferredSections) addSection(section);
	const ordinaryLimit = verification ? HANDBOOK_TARGETS.sections - 1 : HANDBOOK_TARGETS.sections;
	let room = ordinaryLimit - carriedSections.size;
	const retainedOrdinarySections = ordinarySections.filter((section) => carriedSections.has(section) || room-- > 0);
	for (const section of retainedOrdinarySections) {
		if (modelSections.has(section)) onModelSectionRetained?.();
	}
	onProtected?.({
		invariants: protectedInvariants,
		sections: [...carriedSections].map(([section, blocks]) => ({ title: section.title, body: blocks.join("\n") })),
	});
	const fixIds = (line: string): string => correctedRuleIds(line, checkerRules, report);
	return {
		...base,
		projectName: existing?.projectName ?? projectName(input.cwd, tomlFiles),
		identity: existing?.identity ?? stabilizedIdentity(input, base.identity, tomlFiles),
		conventions: retainedConventions.map(fixIds),
		invariants: retainedInvariants.map(fixIds),
		sections: [
			...retainedOrdinarySections.map((section) => {
				const body = handbookBlocks(section.body).map(fixIds).join("\n");
				return body === section.body ? section : { ...section, body };
			}),
			...(verification ? [verification] : []),
		],
	};
}

function inferHeuristicSections(input: BootstrapGenerateInput): ClioMdSection[] {
	// No entry-point or layout section: a repository tour costs every session
	// tokens and does not shorten the path to the right file. The session prompt
	// already routes navigation through `code_nav`.
	const sections: ClioMdSection[] = [];
	const invariants = inferInvariants(handbookInstructionFiles(input));
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
	const tomlFiles = input.tomlFiles ?? createTomlFileReader(input.cwd);
	const sharedInput = input.tomlFiles ? input : { ...input, tomlFiles };
	return stabilizeGeneratedOutput(sharedInput, {
		projectName: projectName(input.cwd, tomlFiles),
		identity: resolveDefaultIdentity(input.cwd, input.projectType, handbookInstructionFiles(input), tomlFiles).text,
		conventions: inferConventions(input.cwd, handbookInstructionFiles(input), input.codewiki),
		invariants: inferInvariants(handbookInstructionFiles(input)),
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
	if (!parsed?.ok || !parsed.value) return null;
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

function gitOutput(cwd: string, args: ReadonlyArray<string>): string | null {
	try {
		return execFileSync("git", internalGitArgv(args, cwd), {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			maxBuffer: 64 * 1024 * 1024,
		});
	} catch {
		return null;
	}
}

/**
 * Project context sources Git does not track, when the handbook itself will
 * be committed. Those sources are private to this checkout (a gitignored
 * `.claude/CLAUDE.md`, an untracked personal `AGENTS.md`), and folding them
 * into a tracked CLIO-CODER.md published one maintainer's machine paths, hosts
 * and private routing to every contributor. An ignored handbook stays local
 * and may still draw on them; outside Git nothing is shared, so nothing is withheld.
 */
function uncommittedContextSources(cwd: string, adoption: AdoptionScanResult): string[] {
	const project = adoption.sources.filter((source) => source.scope === "project");
	if (project.length === 0) return [];
	const top = gitOutput(cwd, ["rev-parse", "--show-toplevel"])?.trim();
	if (!top) return [];
	// `check-ignore` prints the path when a rule ignores it; an ignored handbook is not shared.
	if ((gitOutput(cwd, ["check-ignore", "--", "CLIO-CODER.md"]) ?? "").trim().length > 0) return [];
	const listed = gitOutput(top, ["ls-files", "-z", "--full-name"]);
	if (listed === null) return [];
	const tracked = new Set(listed.split("\0").filter((path) => path.length > 0));
	return project
		.map((source) => source.path)
		.filter((path) => {
			const rel = relative(top, path).split("\\").join("/");
			return rel.startsWith("../") || !tracked.has(rel);
		});
}

function gitStatus(cwd: string): string {
	try {
		return execFileSync("git", internalGitArgv(["status", "--short"], cwd), {
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

function formatCompileLines(summary: RunBootstrapSummary): string[] {
	const compile = summary.compile;
	if (!compile) return [];
	const clip = (rule: string): string => {
		const flat = rule.replace(/\s+/g, " ").trim();
		return flat.length > 100 ? `${flat.slice(0, 99)}…` : flat;
	};
	const lines: string[] = [];
	if (compile.merged.length > 0) {
		lines.push(`  merged ${compile.merged.length} restated rule${compile.merged.length === 1 ? "" : "s"}`);
		if (summary.action === "previewed")
			for (const pair of compile.merged) lines.push(`    kept: ${clip(pair.kept)}`, `    dropped: ${clip(pair.dropped)}`);
	}
	for (const fix of compile.ruleIds) lines.push(`  rule id ${fix.from} rewritten to ${fix.to}`);
	for (const id of compile.unknownRuleIds) lines.push(`  rule id ${id} not found in the checker`);
	return lines;
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
			`  ${contextLine}; codemap would index ${summary.codewikiEntries} entr${summary.codewikiEntries === 1 ? "y" : "ies"}; ${dirtyLine}; no files written`,
			...(adoptionLine ? [adoptionLine] : []),
			...formatCompileLines(summary),
			...formatAbsorbLines(summary),
			"",
		].join("\n");
	}
	const adoptionLine = formatAdoptionLine(summary);
	const proposalLine = summary.proposalPath ? `  proposal written ${summary.proposalPath}` : null;
	if (summary.action === "preserved") {
		return [
			"clio-coder context init preserved CLIO-CODER.md",
			`  ${contextLine}; codemap reconciled ${summary.codewikiEntries} entr${summary.codewikiEntries === 1 ? "y" : "ies"}; state refreshed; ${dirtyLine}`,
			"  CLIO-CODER.md is treated as human-owned. Use --apply to replace it with a generated draft, --propose to write an ignored proposal, or --adopt to refresh only imported agent context.",
			...(adoptionLine ? [adoptionLine] : []),
			"",
		].join("\n");
	}
	if (summary.action === "proposed") {
		return [
			"clio-coder context init proposed CLIO-CODER.md",
			`  ${contextLine}; codemap reconciled ${summary.codewikiEntries} entr${summary.codewikiEntries === 1 ? "y" : "ies"}; state refreshed; ${dirtyLine}`,
			...(proposalLine ? [proposalLine] : []),
			summary.proposalPath
				? `  CLIO-CODER.md was not changed. After reviewing the proposal, write it with clio-coder context init --accept ${proposalId(summary.proposalPath)}`
				: "  CLIO-CODER.md was not changed.",
			...(adoptionLine ? [adoptionLine] : []),
			...formatCompileLines(summary),
			...formatAbsorbLines(summary),
			"",
		].join("\n");
	}
	return [
		`clio-coder context init ${summary.action} CLIO-CODER.md`,
		`  ${contextLine}; codemap reconciled ${summary.codewikiEntries} entr${summary.codewikiEntries === 1 ? "y" : "ies"}; state refreshed; ${dirtyLine}`,
		"  git policy: CLIO-CODER.md and what you author under .clio-coder/ can be committed; .clio-coder/.gitignore keeps generated files and *.local.yaml out of Git.",
		...(proposalLine ? [proposalLine] : []),
		...(adoptionLine ? [adoptionLine] : []),
		...formatCompileLines(summary),
		...formatAbsorbLines(summary),
		"",
	].join("\n");
}

function isBlanketClioIgnoreLine(line: string): boolean {
	if (line.length === 0 || line.startsWith("#") || line.startsWith("!")) return false;
	return /^(?:\/|\*\*\/)?\.clio-coder(?:\/|\/\*|\/\*\*)?$/.test(line);
}

/**
 * Clio's own `.clio-coder/.gitignore` keeps generated files out of Git, and it
 * never edits the project's file. A blanket rule there, which earlier versions
 * of `context init` wrote, is the operator's to remove, so it is only named: Git
 * does not descend into an excluded parent, so authored files cannot be shared.
 */
function warnOfBlanketClioIgnore(cwd: string, io: BootstrapIo | undefined): void {
	let content: string;
	try {
		content = readFileSync(join(cwd, ".gitignore"), "utf8");
	} catch {
		return;
	}
	if (!content.split(/\r?\n/).some((line) => isBlanketClioIgnoreLine(line.trim()))) return;
	out(
		io,
		"  .gitignore ignores all of .clio-coder/, so settings, skills and rules there cannot be committed; remove that line to share them\n",
	);
}

function serializeBootstrapOutput(output: BootstrapStructuredOutput): string {
	const serialized = serializeClioMd({ ...output, fingerprint: null });
	const parsed = parseClioMd(serialized);
	if (!parsed.ok) throw new Error(`bootstrap produced invalid CLIO-CODER.md: ${parsed.errors.join("; ")}`);
	return serialized;
}

/**
 * Every adopted unit `context init` judged, with its verdict, so an operator can
 * see why a sibling handbook rule did or did not reach CLIO-CODER.md.
 */
function writeHandbookLedger(cwd: string, entries: ReadonlyArray<HandbookLedgerEntry>): void {
	const commit = gitOutput(cwd, ["rev-parse", "HEAD"])?.trim() || null;
	mkdirSync(dirname(handbookLedgerPath(cwd)), { recursive: true });
	writeFileSync(
		handbookLedgerPath(cwd),
		`${JSON.stringify({ version: 1, commit, entries: entries.map((entry) => ({ ...entry, commit })) }, null, 2)}\n`,
		"utf8",
	);
}

/** The effective handbook's rules re-checked against the current tree by `context init --verify`. */
export interface HandbookVerification {
	/** Repository-relative paths of the handbook files that were checked. */
	files: string[];
	commit: string | null;
	entries: HandbookLedgerEntry[];
}

/**
 * Re-ground every rule of the effective handbook without a model: its
 * backticked citations against the tree, its tree-fact claims against the
 * tree-fact table, and its checker ids against the enforcement inventory.
 * Records the verdicts and the commit in the handbook ledger.
 */
export async function verifyHandbook(cwd: string): Promise<HandbookVerification> {
	const loaded = loadProjectClioMd(cwd);
	const handbooks = loaded.files.map((file) => ({
		file: relative(cwd, file.path).split("\\").join("/"),
		path: file.path,
		content: file.source,
	}));
	const repositoryFiles = (await enumerateWorkspaceFilesAsync(cwd)).filter(
		(path) => !GENERATION_EXCLUDED_FILES.has(path),
	);
	const projectType = detectProjectType(cwd);
	const codewiki = readCodewiki(cwd) ?? (await buildCodewikiCandidate(cwd, projectType)).codewiki;
	const enforcement = collectEnforcementInventory(cwd, repositoryFiles);
	const input: BootstrapGenerateInput = {
		cwd,
		projectType,
		// The handbook under review is the claim, never its own evidence.
		siblingFiles: handbooks.map((handbook) => ({ source: "handbook", path: handbook.path, content: handbook.content })),
		adoption: scanAgentConfigs({ cwd, includeGlobal: false }),
		codewiki,
		enforcement,
		repositoryFiles,
	};
	const corpus = createModelGroundingCorpus(input);
	const facts = treeFacts(cwd, enforcement.ciCommands ?? []);
	const checkerRules = checkerRuleList(input);
	const codes = new Set(checkerRules.map((rule) => rule.code));
	const entries: HandbookLedgerEntry[] = [];
	for (const handbook of handbooks) {
		for (const unit of instructionUnits(handbook.content, 600, handbook.file)) {
			const line = unit.text.trim();
			if (line.length === 0) continue;
			const citations = [...line.matchAll(CODE_TOKEN_RE)].map((match) => match[1] ?? "").filter(Boolean);
			const ids = [...new Set([...line.matchAll(/\brule\d+\b/g)].map((match) => match[0]))];
			const entry = (
				verdict: HandbookLedgerEntry["verdict"],
				reason: string,
				ruleIds: { from: string; to: string }[] = [],
			): void => {
				entries.push({
					id: createHash("sha256").update(`${unit.file}:${unit.line}:${line}`).digest("hex").slice(0, 12),
					text: line,
					origin: "handbook",
					source: { file: unit.file, line: unit.line },
					citations,
					verdict,
					reason,
					kept: true,
					...(ruleIds.length > 0 ? { ruleIds } : {}),
				});
			};
			// A rule is stale when nothing it cites survives grounding, or when a concrete file it names is gone.
			const missing = citations.filter((token) => !groundedToken(token, corpus));
			const missingFile = missing.some((token) => CONCRETE_FILE_RE.test(citedPath(token)));
			if (citations.length > 0 && (missingFile || groundedModelBody(line, corpus).length === 0)) {
				entry(
					"stale",
					missing.length > 0
						? `does not resolve in this tree: ${missing.join(", ")}`
						: "its citations do not pass the citation rule",
				);
				continue;
			}
			if (codes.size > 0 && ids.length > 0) {
				const report: HandbookCompileReport = { merged: [], ruleIds: [], unknownRuleIds: [] };
				correctedRuleIds(line, checkerRules, report);
				if (report.ruleIds.length > 0) {
					const changes = report.ruleIds.map((change) => `${change.from} is now ${change.to}`).join(", ");
					entry("stale", `renumbered rule id: ${changes}`, report.ruleIds);
					continue;
				}
				const unknown = [...new Set([...report.unknownRuleIds, ...ids.filter((id) => !codes.has(id))])];
				if (unknown.length > 0) {
					entry("stale", `no checker declares ${unknown.join(", ")}`);
					continue;
				}
			}
			const fact = contradictingFact(line, facts);
			if (fact) {
				entry("contradicted", `${fact.source} states ${fact.key} ${fact.value}`);
				continue;
			}
			if (citations.length > 0 || ids.length > 0) entry("verified", "every citation resolves");
			else entry("unverifiable", "cites nothing the tree can check");
		}
	}
	const commit = gitOutput(cwd, ["rev-parse", "HEAD"])?.trim() || null;
	const ledger = {
		version: 1,
		commit,
		verifiedCommit: commit ?? "uncommitted",
		verifiedAt: new Date().toISOString(),
		entries: entries.map((entry) => ({ ...entry, commit })),
	};
	mkdirSync(dirname(handbookLedgerPath(cwd)), { recursive: true });
	writeFileSync(handbookLedgerPath(cwd), `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
	return { files: handbooks.map((handbook) => handbook.file), commit, entries };
}

/** How many physical lines the unit starting at 0-based `start` spans: a list item with its continuation, or a paragraph. */
function unitLineSpan(lines: ReadonlyArray<string>, start: number): number {
	let end = start + 1;
	while (end < lines.length) {
		const next = lines[end] ?? "";
		if (next.trim().length === 0 || /^\s*(?:[-*+]|\d+[.)])\s/.test(next) || /^\s*#/.test(next)) break;
		end += 1;
	}
	return end - start;
}

/**
 * The edit `--verify --apply` makes and shows: each stale or contradicted rule
 * is removed, except one whose only fault is a renumbered checker id, which is
 * rewritten to the id the checker declares now. Returns one unified diff per file.
 */
export function applyHandbookVerification(
	cwd: string,
	verification: HandbookVerification,
): Array<{ file: string; diff: string }> {
	const results: Array<{ file: string; diff: string }> = [];
	for (const file of verification.files) {
		const flagged = verification.entries
			.filter((entry) => entry.source.file === file && (entry.verdict === "stale" || entry.verdict === "contradicted"))
			.sort((a, b) => b.source.line - a.source.line);
		if (flagged.length === 0) continue;
		const path = join(cwd, file);
		const lines = readFileSync(path, "utf8").split("\n");
		const hunks: string[] = [];
		for (const entry of flagged) {
			const start = entry.source.line - 1;
			const count = unitLineSpan(lines, start);
			const before = lines.slice(start, start + count);
			const changes = entry.ruleIds ?? [];
			const after =
				changes.length === 0
					? []
					: before.map((text) =>
							changes.reduce((current, change) => current.replace(new RegExp(`\\b${change.from}\\b`, "g"), change.to), text),
						);
			lines.splice(start, count, ...after);
			hunks.unshift(
				[
					`@@ -${start + 1},${count} +${start + 1},${after.length} @@ ${entry.reason}`,
					...before.map((text) => `-${text}`),
					...after.map((text) => `+${text}`),
				].join("\n"),
			);
		}
		writeFileSync(path, lines.join("\n"), "utf8");
		results.push({ file, diff: [`--- a/${file}`, `+++ b/${file}`, ...hunks].join("\n") });
	}
	return results;
}

function writeClioMdFile(cwd: string, output: BootstrapStructuredOutput): string {
	const clioMdPath = join(cwd, "CLIO-CODER.md");
	mkdirSync(dirname(clioMdPath), { recursive: true });
	const serialized = serializeBootstrapOutput(output);
	safeResourceWrite(clioMdPath, serialized);
	return clioMdPath;
}

function timestampForPath(now: Date): string {
	return now
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "Z");
}

function writeClioMdProposal(
	cwd: string,
	now: Date,
	output: BootstrapStructuredOutput,
	generation: BootstrapGenerationTelemetry,
	existingSource: string | null,
	absorb: AbsorbReport | undefined,
): string {
	const dir = join(cwd, ".clio-coder", "proposals");
	ensureProjectIgnore(cwd);
	mkdirSync(dir, { recursive: true });
	const proposalPath = join(dir, `CLIO-CODER-${timestampForPath(now)}-${randomUUID()}.md`);
	const serialized = serializeBootstrapOutput(output);
	writeFileSync(proposalPath, serialized, { encoding: "utf8", flag: "wx" });
	// Proposal provenance belongs to the candidate, never to the untouched handbook.
	writeFileSync(
		`${proposalPath}.json`,
		`${JSON.stringify({
			version: 1,
			createdAt: now.toISOString(),
			handbookPath: join(cwd, "CLIO-CODER.md"),
			sourceHash: existingSource === null ? null : createHash("sha256").update(existingSource).digest("hex"),
			proposalHash: createHash("sha256").update(serialized).digest("hex"),
			generation: durableGenerationTelemetry(generation),
			...(absorb ? { absorb } : {}),
		})}\n`,
		{ encoding: "utf8", flag: "wx" },
	);
	return proposalPath;
}

function proposalsDir(cwd: string): string {
	return join(cwd, ".clio-coder", "proposals");
}

/** A proposal's id: its file name without `CLIO-CODER-` and `.md`, which `--accept` takes. */
export function proposalId(proposalPath: string): string {
	return parse(proposalPath).name.replace(/^CLIO-CODER-/, "");
}

function resolveProposal(cwd: string, ref: string | undefined): { path: string } | { error: string } {
	const dir = proposalsDir(cwd);
	let names: string[];
	try {
		names = readdirSync(dir)
			.filter((name) => /^CLIO-CODER-.+\.md$/.test(name))
			.sort((a, b) => a.localeCompare(b));
	} catch {
		names = [];
	}
	if (ref === undefined) {
		const latest = names.at(-1);
		return latest ? { path: join(dir, latest) } : { error: "no proposal in .clio-coder/proposals" };
	}
	if (ref.includes("/") || ref.includes("\\")) {
		const path = resolve(cwd, ref);
		if (dirname(path) !== dir || !names.includes(parse(path).base))
			return { error: `${ref} is not a proposal in .clio-coder/proposals` };
		return { path };
	}
	const matches = names.filter(
		(name) => name === ref || name === `${ref}.md` || name === `CLIO-CODER-${ref}.md` || name.endsWith(`-${ref}.md`),
	);
	if (matches.length === 1) return { path: join(dir, matches[0] as string) };
	return { error: matches.length === 0 ? `no proposal matches ${ref}` : `${ref} matches ${matches.length} proposals` };
}

export type AcceptProposalResult =
	| { ok: true; proposalPath: string; handbookPath: string }
	| { ok: false; proposalPath?: string; reason: string };

/**
 * Writes a stored proposal's bytes to CLIO-CODER.md, but only while the handbook
 * still hashes to the sidecar's `sourceHash`, so an edit made after the draft
 * was written is never overwritten. `ref` is a proposal path, file name or id;
 * without it the newest proposal is taken.
 */
export function acceptHandbookProposal(cwd: string, ref?: string): AcceptProposalResult {
	const resolved = resolveProposal(cwd, ref);
	if ("error" in resolved) return { ok: false, reason: resolved.error };
	const proposalPath = resolved.path;
	let sidecar: { sourceHash?: unknown; proposalHash?: unknown };
	let bytes: Buffer;
	try {
		sidecar = JSON.parse(readFileSync(`${proposalPath}.json`, "utf8")) as typeof sidecar;
		bytes = readFileSync(proposalPath);
	} catch {
		return { ok: false, proposalPath, reason: "the proposal or its .json sidecar cannot be read" };
	}
	const sha = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
	if (sidecar.proposalHash !== sha(bytes))
		return { ok: false, proposalPath, reason: "the proposal was edited after it was written" };
	const current = readExistingClioMdText(cwd);
	const currentHash = current === null ? null : sha(current);
	if (sidecar.sourceHash !== currentHash)
		return {
			ok: false,
			proposalPath,
			reason: "CLIO-CODER.md changed since the proposal was written; run context init --propose again",
		};
	const handbookPath = join(cwd, "CLIO-CODER.md");
	safeResourceWrite(handbookPath, bytes);
	return { ok: true, proposalPath, handbookPath };
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
		...(telemetry.repairRan !== undefined ? { repairRan: telemetry.repairRan } : {}),
		...(telemetry.repairProducedHandbook !== undefined
			? { repairProducedHandbook: telemetry.repairProducedHandbook }
			: {}),
	};
	const fallbackReason = boundedStateString(telemetry.fallbackReason, 500);
	if (fallbackReason) state.fallbackReason = fallbackReason;
	// The generation's own span, kept even when no dispatch ran; one dispatch's
	// receipt is not the span of several.
	const durationMs = safeStateCounter(telemetry.durationMs);
	if (durationMs !== undefined) state.durationMs = durationMs;
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
	// A dispatch without a run id never started a worker and spent nothing.
	const runs = (telemetry.runs ?? [run]).filter((entry) => entry === run || entry.runId !== undefined);
	const measuredTotal = (entries: ReadonlyArray<BootstrapRunTelemetry>): number | undefined => {
		const sum = sumFacts(entries.flatMap((entry) => (entry.spend ? [entry.spend.totalTokens] : [])));
		return sum.coverage.measured === entries.length ? sum.measured : undefined;
	};
	const across = (field: (entry: BootstrapRunTelemetry) => number | undefined): number | undefined => {
		let total = 0;
		for (const entry of runs) {
			const value = field(entry);
			if (value === undefined) return undefined;
			total += value;
		}
		return total;
	};
	for (const [key, value] of [
		// The project state keeps a plain count, so a total is recorded only when every dispatch measured its own (#434).
		["tokenCount", measuredTotal(runs)],
		["toolCalls", across((entry) => entry.toolCalls)],
		["promptBytes", across((entry) => entry.promptBytes)],
		["outputBytes", across((entry) => entry.outputBytes)],
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
	published: boolean,
): string {
	const statePath = resolveStatePath(cwd);
	const prev = readClioState(cwd);
	// lastBootstrap describes how the CLIO-CODER.md on disk was produced, not what the
	// most recent run happened to do. Proposals retain their own generation record.
	const lastBootstrap = published ? durableGenerationTelemetry(generation) : prev?.lastBootstrap;
	const contextSources = recordAdoption ? adoption.sourceSnapshots : prev?.contextSources;
	const contextSourceHash = contextSources ? adoptionSnapshotsHash(contextSources) : undefined;
	writeClioState(cwd, {
		version: 1,
		projectType: prev?.projectType ?? projectType,
		fingerprint: prev?.fingerprint ?? fingerprint,
		codewikiVersion: prev?.codewikiVersion ?? codewikiVersion,
		...(published
			? { bootstrapFingerprint: fingerprint }
			: prev?.bootstrapFingerprint
				? { bootstrapFingerprint: prev.bootstrapFingerprint }
				: {}),
		lastInitAt: now.toISOString(),
		lastSessionAt: now.toISOString(),
		lastIndexedAt: prev?.lastIndexedAt ?? indexedAt,
		...(lastBootstrap ? { lastBootstrap } : {}),
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
	writeClioState(
		cwd,
		{
			version: 1,
			projectType,
			fingerprint,
			codewikiVersion: codewiki.version,
			...(prev?.contextSources ? { contextSources: prev.contextSources } : {}),
			...(prev?.contextSourceHash ? { contextSourceHash: prev.contextSourceHash } : {}),
			...(prev?.lastInitAt ? { lastInitAt: prev.lastInitAt } : {}),
			...(prev?.lastBootstrap ? { lastBootstrap: prev.lastBootstrap } : {}),
			...(prev?.bootstrapFingerprint ? { bootstrapFingerprint: prev.bootstrapFingerprint } : {}),
			lastSessionAt: prev?.lastSessionAt ?? indexedAt,
			lastIndexedAt: indexedAt,
		},
		codewiki,
	);
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

export async function runBootstrap(input: RunBootstrapInput = {}): Promise<RunBootstrapResult> {
	const committed: ContextOperationFact[] = [];
	try {
		return await runBootstrapWork(input, committed);
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError")
			throw new ContextOperationAbortError(error.message, committed);
		throw error;
	}
}

async function runBootstrapWork(
	input: RunBootstrapInput,
	committed: ContextOperationFact[],
): Promise<RunBootstrapResult> {
	input.signal?.throwIfAborted();
	const cwd = input.cwd ?? process.cwd();
	const tomlFiles = createTomlFileReader(cwd);
	const projectType = detectProjectType(cwd);
	progress(input, {
		phase: "scan",
		status: "started",
		message: "scanning project and sibling agent context",
		detail: projectType,
	});
	const scanned = scanAgentConfigs({
		cwd,
		...(input.homeDir ? { homeDir: input.homeDir } : {}),
		includeGlobal: input.includeGlobalImports === true,
	});
	const withheld = new Set(uncommittedContextSources(cwd, scanned));
	const adoption = withheld.size > 0 ? restrictAdoptionScan(scanned, (path) => !withheld.has(path)) : scanned;
	if (withheld.size > 0) {
		out(
			input.io,
			`  left out ${withheld.size} context source${withheld.size === 1 ? "" : "s"} Git does not track, because CLIO-CODER.md is not ignored and would publish them: ${[
				...withheld,
			]
				.map((path) => relative(cwd, path).split("\\").join("/"))
				.slice(0, 6)
				.join(", ")}${withheld.size > 6 ? ", ..." : ""}\n`,
		);
	}
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
	progress(input, { phase: "codewiki", status: "started", message: "reconciling codemap index" });
	let codewiki: Codewiki;
	let codewikiFingerprint: Fingerprint;
	if (input.preview === true) {
		const candidate = await buildCodewikiCandidate(cwd, projectType, indexProgressSink(input.onProgress), input.signal);
		codewiki = candidate.codewiki;
		codewikiFingerprint = candidate.fingerprint;
	} else {
		const coordinated = await coordinateCodewikiWrite(
			cwd,
			(current) => ({
				kind: "ensure",
				cwd,
				language: projectType,
				current,
				previous: readClioState(cwd)?.fingerprint ?? null,
			}),
			{
				onProgress: indexProgressSink(input.onProgress),
				...(input.signal ? { signal: input.signal } : {}),
				beforeCommit: async (_result, workspace) => {
					warnOfBlanketClioIgnore(workspace, input.io);
				},
				afterCommit: ({ codewiki: indexed, fingerprint }, workspace) => {
					persistCodewikiForGeneration(workspace, projectType, indexedAt, indexed, fingerprint);
					committed.push({ kind: "indexed", unit: "source-files", count: indexedSourceFileCount(indexed) });
				},
			},
		);
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
	input.signal?.throwIfAborted();
	const hadClioMd = existsSync(join(cwd, "CLIO-CODER.md"));
	const originalClioMdText = readExistingClioMdText(cwd);
	const useExistingClioMdAsSource = hadClioMd && input.rewriteClioMd !== true;
	const existingClioMdText = useExistingClioMdAsSource ? originalClioMdText : null;
	const existingClioMd = useExistingClioMdAsSource ? tryReadClioMd(cwd) : null;
	const existingParsed = existingClioMd?.ok ? existingClioMd.value : undefined;
	const replaced = hadClioMd && input.rewriteClioMd === true ? tryReadClioMd(cwd) : null;
	const previousInvariants = replaced?.ok && replaced.value ? replaced.value.invariants : [];
	const previousSections = replaced?.ok && replaced.value ? replaced.value.sections : [];
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
			`cannot refresh Imported agent context because CLIO-CODER.md has no structured projection${detail}; use --apply or --rewrite after reviewing the handbook`,
		);
	}
	// A supplied generator *is* the request to generate: both entry points
	// withhold `generate` for --heuristic and --preview and supply it otherwise.
	// For an existing handbook, retain that work as a proposal unless replacement
	// or adoption was explicitly requested. Generation never implies publication.
	const adoptionOnly = input.adopt === true && hadClioMd && !replaceClioMd && input.proposeClioMd !== true;
	const shouldGenerate =
		!hadClioMd || replaceClioMd || input.proposeClioMd === true || (input.generate !== undefined && !adoptionOnly);
	const shouldPropose =
		input.proposeClioMd === true || (hadClioMd && input.generate !== undefined && !replaceClioMd && input.adopt !== true);
	let output: BootstrapStructuredOutput;
	let protectedContent: ProtectedHandbook | undefined;
	const compileReport: HandbookCompileReport = { merged: [], ruleIds: [], unknownRuleIds: [] };
	const compiled = (): { compile?: HandbookCompileReport } =>
		compileReport.merged.length + compileReport.ruleIds.length + compileReport.unknownRuleIds.length > 0
			? { compile: compileReport }
			: {};
	let generation: BootstrapGenerationTelemetry = {
		mode: shouldGenerate ? "heuristic" : existingParsed ? "existing" : "heuristic",
		parserOutcome: "not-run",
	};
	let reportedGeneration: BootstrapGenerationTelemetry | undefined;
	const reportGeneration: BootstrapGenerationSink = (reported) => {
		if (reportedGeneration === undefined) reportedGeneration = reported;
	};
	let enforcementSeen: EnforcementInventory | undefined;
	let handbookLedger: HandbookLedgerEntry[] | undefined;
	if (shouldGenerate) {
		const depth = input.depth ?? "standard";
		// The handbook this run writes is its output, not repository evidence. A
		// tracked draft let a rewrite ground slash-joined prose in its own
		// previous text; only --apply hands the old handbook over, as existingClioMd.
		// Clio's own hand-written CLIO-DEV.md stays out too, so a generated
		// handbook can be compared with it instead of copying it.
		const repositoryFiles = (await enumerateWorkspaceFilesAsync(cwd)).filter(
			(path) => !GENERATION_EXCLUDED_FILES.has(path),
		);
		const enforcement = collectEnforcementInventory(cwd, repositoryFiles);
		enforcementSeen = enforcement;
		const anchors = codewiki.files
			.filter((file) => file.lang !== "config" && file.role !== "test")
			.sort(
				(a, b) =>
					Number(b.role === "entry") - Number(a.role === "entry") ||
					b.imports.length - a.imports.length ||
					a.path.localeCompare(b.path),
			)
			.slice(0, depth === "quick" ? 2 : depth === "deep" ? 8 : 4)
			.map((file) => file.path);
		const evidence = collectBootstrapEvidence(cwd, repositoryFiles, enforcement, depth, anchors);
		progress(input, {
			phase: "generate",
			status: "started",
			message: input.generate
				? "drafting CLIO-CODER.md with the bootstrap agent"
				: "drafting CLIO-CODER.md with heuristic",
		});
		const generateInput: BootstrapGenerateInput = {
			cwd,
			expectedProjectName: projectName(cwd, tomlFiles),
			tomlFiles,
			projectType,
			siblingFiles,
			adoption,
			codewiki,
			enforcement,
			depth,
			evidence,
			repositoryFiles,
			...(existingParsed ? { existingClioMd: existingParsed } : {}),
			...(existingClioMdText ? { existingClioMdText } : {}),
			...(previousInvariants.length > 0 ? { previousInvariants } : {}),
			...(previousSections.length > 0 ? { previousSections } : {}),
			...(input.onProgress ? { progress: input.onProgress } : {}),
			reportGeneration,
			missingSections: (draft) => missingHandbookSections({ cwd, enforcement }, draft),
			// Deterministic sampling repeats an empty draft unless a bounded repair receives grounding feedback.
			assessDraft: (draft) => {
				let retained = 0;
				stabilizeGeneratedOutput(
					generateInput,
					draft,
					() => {
						retained += 1;
					},
					true,
				);
				if (retained > 0) return null;
				const rules = [
					...draft.invariants,
					...draft.conventions,
					...(draft.sections ?? []).flatMap((section) => handbookBlocks(section.body)),
				];
				const corpus = createModelGroundingCorpus(generateInput);
				const tokens = rules.flatMap((rule) =>
					[...correctSymbolAttributions(rule, corpus).matchAll(CODE_TOKEN_RE)].map((match) => match[1] ?? ""),
				);
				const unknown = [...new Set(tokens.filter((token) => !groundedToken(token, corpus)))].slice(0, 12);
				const reason =
					rules.length === 0
						? "no rules"
						: tokens.length === 0
							? "no rules cited a file or symbol"
							: unknown.length > 0
								? `rules cited unknown tokens: ${unknown.join(", ")}`
								: "no rules or sections passed the citation and retention filters";
				return `The draft had ${rules.length} rules; none survived grounding (${reason}). Write the invariants, change recipes and test rules supported by the original evidence brief, each citing its file in backticks. Return the complete handbook JSON.`;
			},
		};
		input.signal?.throwIfAborted();
		output = await (input.generate ?? heuristicBootstrapOutput)(generateInput);
		input.signal?.throwIfAborted();
		generation = reportedGeneration ?? generation;
		let retainedModelSections = 0;
		const ledgerEntries: HandbookLedgerEntry[] = [];
		handbookLedger = ledgerEntries;
		output = stabilizeGeneratedOutput(
			{
				cwd,
				expectedProjectName: projectName(cwd, tomlFiles),
				tomlFiles,
				projectType,
				siblingFiles,
				adoption,
				codewiki,
				evidence,
				enforcement,
				repositoryFiles,
				handbookLedger: ledgerEntries,
				...(existingParsed ? { existingClioMd: existingParsed } : {}),
				...(existingClioMdText ? { existingClioMdText } : {}),
				...(previousInvariants.length > 0 ? { previousInvariants } : {}),
				...(previousSections.length > 0 ? { previousSections } : {}),
			},
			output,
			() => {
				retainedModelSections += 1;
			},
			generation.mode === "model",
			(content) => {
				protectedContent = content;
			},
			compileReport,
		);
		if (generation.mode === "model" && retainedModelSections === 0) {
			generation = {
				...generation,
				mode: "heuristic",
				fallbackReason: "bootstrap draft contributed no evidence-grounded rules or sections",
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
			: await heuristicBootstrapOutput({ cwd, tomlFiles, projectType, siblingFiles, adoption, codewiki });
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
	if (shouldGenerate && generation.mode !== "existing") {
		output = fitGeneratedHandbook(output, protectedContent, ({ chars, lines }) =>
			warn(
				input.io,
				`  warning: the carried and authored hard invariants and carried section blocks exceed the CLIO-CODER.md target on their own (${chars} characters, ${lines} lines; target ${HANDBOOK_TARGETS.chars} and ${HANDBOOK_TARGETS.lines}); they were kept whole. Shorten or retire them in the handbook.\n`,
			),
		);
	}
	if (shouldGenerate && generation.mode === "model") {
		for (const section of missingHandbookSections(
			{ cwd, ...(enforcementSeen ? { enforcement: enforcementSeen } : {}) },
			output,
		)) {
			warn(
				input.io,
				`  warning: the generated CLIO-CODER.md has no ${section.title} section although ${section.reason}; rerun \`clio-coder context init --rewrite\` to draft it again.\n`,
			);
		}
	}
	const readNames = siblingFiles.map((file) => file.path).sort((a, b) => a.localeCompare(b));
	const absorb = handbookLedger
		? buildAbsorbReport(
				handbookLedger,
				compileReport,
				readNames.map((path) => (isAbsolute(path) ? relative(cwd, path) : path)),
			)
		: undefined;
	const absorbed = (): { absorb?: AbsorbReport } => (absorb ? { absorb } : {});
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
			...compiled(),
			...absorbed(),
		};
		out(input.io, formatBootstrapSummary(summary));
		progress(input, { phase: "done", status: "completed", message: "context preview ready; no files written" });
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
	progress(input, {
		phase: "clio-md",
		status: "started",
		message: hadClioMd ? "preserving CLIO-CODER.md" : "writing CLIO-CODER.md",
	});
	const action = await coordinateCodewikiExclusive(
		cwd,
		(): RunBootstrapSummary["action"] => {
			const wouldPublish =
				!hadClioMd || (replaceClioMd && generation.mode !== "existing") || (input.adopt && existingParsed);
			const sourceChanged = hadClioMd !== existsSync(clioMdPath) || originalClioMdText !== readExistingClioMdText(cwd);
			if (shouldPropose || (wouldPublish && sourceChanged)) {
				proposalPath = writeClioMdProposal(cwd, now, output, generation, originalClioMdText, absorb);
				if (sourceChanged)
					warn(input.io, "CLIO-CODER.md changed during initialization; the generated draft was saved as a proposal.\n");
				return "proposed";
			} else if (wouldPublish) {
				clioMdPath = writeClioMdFile(cwd, output);
				return hadClioMd ? "refreshed" : "wrote";
			}
			return "preserved";
		},
		input.signal,
	);
	if (handbookLedger) writeHandbookLedger(cwd, handbookLedger);
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
	progress(input, { phase: "state", status: "started", message: "persisting codemap and project state" });
	const statePath = await coordinateCodewikiExclusive(cwd, () =>
		writeProjectState(
			cwd,
			projectType,
			now,
			indexedAt,
			adoption,
			adoptionApplied,
			codewiki.version,
			codewikiFingerprint,
			generation,
			action === "wrote" || action === "refreshed",
		),
	);
	progress(input, {
		phase: "state",
		status: "completed",
		message: `state updated; ${codewikiEntryCount} codemap entr${codewikiEntryCount === 1 ? "y" : "ies"}`,
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
		...compiled(),
		...absorbed(),
	};
	out(input.io, formatBootstrapSummary(summary));
	if (action === "wrote" || action === "refreshed") {
		const ignored = await runCommandVector("git", internalGitArgv(["check-ignore", "--quiet", "--", "CLIO-CODER.md"]), {
			cwd,
			workspaceRoot: cwd,
			timeoutMs: 5_000,
			maxOutputBytes: 4_096,
		});
		if (ignored.exitCode === 0) {
			warn(
				input.io,
				"  warning: CLIO-CODER.md was written but is ignored by Git. Remove its matching ignore rule or add !CLIO-CODER.md to .gitignore if you want to version it; then git add CLIO-CODER.md. The matching handbook ignore rule was left unchanged.\n",
			);
		}
	}
	const preload = measureProjectPreload(cwd);
	out(input.io, `  project instructions: ${preload.label}\n`);
	if (preload.mode === "full" && preload.nearLimit) {
		warn(
			input.io,
			`  warning: project context is within 10% of the preload limit (${preload.chars} UTF-16 units of ${FULL_PROJECT_CONTEXT_MAX_CHARS}, ${preload.lines} rendered lines of ${FULL_PROJECT_CONTEXT_MAX_LINES}); further growth may omit authored suffixes\n`,
		);
	}
	progress(input, {
		phase: "done",
		status: "completed",
		message: `${summary.action} CLIO-CODER.md; ${summary.dirtyFiles} dirty file${summary.dirtyFiles === 1 ? "" : "s"}; project instructions: ${preload.label}`,
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

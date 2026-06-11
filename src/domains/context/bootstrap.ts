import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import type { ContextActivityPayload } from "../../core/bus-events.js";
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
import type { SiblingContextFile } from "./sibling-files.js";
import { readClioState, statePath as resolveStatePath, writeClioState } from "./state.js";

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
	projectType: ProjectType;
	siblingFiles: ReadonlyArray<SiblingContextFile>;
	adoption: AdoptionScanResult;
	codewiki: Codewiki;
	existingClioMd?: ParsedClioMd;
	existingClioMdText?: string;
	progress?: BootstrapProgressSink;
}

export type BootstrapGenerate = (
	input: BootstrapGenerateInput,
) => BootstrapStructuredOutput | Promise<BootstrapStructuredOutput>;

export type BootstrapProgressEvent = Omit<ContextActivityPayload, "kind" | "at">;
export type BootstrapProgressSink = (event: BootstrapProgressEvent) => void;

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
		case "python":
			return "Python";
		case "rust":
			return "Rust";
		case "go":
			return "Go";
		case "c++":
			return "C++";
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
	const paragraphs = readme
		.split(/\n\s*\n/)
		.map((part) => part.trim())
		.filter((part) => part.length > 0 && !part.startsWith("#") && !part.startsWith("```"));
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
			"Clio Coder is IOWarp's orchestrator coding agent.",
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

function topCodewikiDirectories(codewiki: Codewiki, limit = 8): string[] {
	const dirCounts = new Map<string, number>();
	for (const entry of codewiki.entries) {
		const top = topTwoSegments(entry.path);
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

function verificationSection(cwd: string): ClioMdSection | null {
	const scripts = packageScripts(cwd);
	const hasScript = (name: string) => typeof scripts[name] === "string";
	const command = (name: string) => `\`npm run ${name}\``;
	const lines: string[] = [];
	const baseline = ["typecheck", "lint"].filter(hasScript).map(command);
	if (baseline.length > 0) {
		lines.push(`Before handoff, run ${baseline.join(" and ")} for TypeScript and style checks.`);
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

function contextArtifactsSection(): ClioMdSection {
	return {
		title: "Context artifacts",
		body: [
			"`CLIO.md` is the versioned, human-owned project handbook and should be reviewed like source when intentionally changed.",
			"`.clio/codewiki.json`, `.clio/state.json`, `.clio/proposals/`, and `.clio/handoffs/` are ignored local context-engine artifacts.",
			"Do not commit `.clio/*` unless the user explicitly asks to force-add a shared artifact.",
			"`context-init --propose` writes ignored drafts; `--apply` updates from the existing handbook; `--rewrite` generates a fresh handbook from repository structure and sibling context.",
		].join(" "),
	};
}

const ARTIFACT_SECTION_RE = /\b(artifact|generated|local state|local file|context artifact)\b/i;
const VERIFICATION_SECTION_RE = /\bverification\b/i;
const SOURCE_SPARSE_RISK_RE =
	/\b(ownership|dedicated team|review requirement|migration chain|workflow traps|failure modes)\b/i;

function sourceSparseBootstrap(input: BootstrapGenerateInput): boolean {
	return (
		input.siblingFiles.length === 0 &&
		input.adoption.importedRules.length === 0 &&
		input.existingClioMd === undefined &&
		input.existingClioMdText === undefined
	);
}

function sourceSparseNeedsHeuristicFloor(input: BootstrapGenerateInput, output: BootstrapStructuredOutput): boolean {
	if (!sourceSparseBootstrap(input)) return false;
	return (output.sections ?? []).some((section) => SOURCE_SPARSE_RISK_RE.test(`${section.title}\n${section.body}`));
}

function stabilizeGeneratedOutput(
	input: BootstrapGenerateInput,
	output: BootstrapStructuredOutput,
): BootstrapStructuredOutput {
	const base = sourceSparseNeedsHeuristicFloor(input, output)
		? {
				...output,
				projectName: projectName(input.cwd),
				identity: defaultIdentity(input.cwd, input.projectType, input.siblingFiles),
				conventions: inferConventions(input.cwd, input.projectType, input.siblingFiles),
				invariants: inferInvariants(input.siblingFiles),
				sections: inferHeuristicSections(input),
			}
		: output;
	const verification = verificationSection(input.cwd);
	const ordinarySections = (base.sections ?? []).filter(
		(section) => !ARTIFACT_SECTION_RE.test(section.title) && !VERIFICATION_SECTION_RE.test(section.title),
	);
	const ordinaryLimit = verification ? 6 : 7;
	return {
		...base,
		sections: [
			...ordinarySections.slice(0, ordinaryLimit),
			...(verification ? [verification] : []),
			contextArtifactsSection(),
		],
	};
}

function inferHeuristicSections(input: BootstrapGenerateInput): ClioMdSection[] {
	const sections: ClioMdSection[] = [];
	const entryPoints = codewikiEntryPoints(input.codewiki, 8);
	if (entryPoints.length > 0) {
		sections.push({
			title: "Context retrieval",
			body: [
				`The codewiki currently indexes ${input.codewiki.entries.length} module${input.codewiki.entries.length === 1 ? "" : "s"}.`,
				`Start orientation with these indexed entry points: ${entryPoints.map((entry) => `\`${entry}\``).join(", ")}.`,
				"Use `entry_points`, `where_is`, and `find_symbol` before broad reads when the task is navigational.",
			].join(" "),
		});
	}
	const topDirs = topCodewikiDirectories(input.codewiki);
	if (topDirs.length > 0) {
		sections.push({
			title: "Repository shape",
			body: [
				`Largest indexed areas: ${topDirs.join(", ")}.`,
				"Treat this as an orientation hint, not a complete file map; refresh the codewiki after structural edits.",
			].join(" "),
		});
	}
	const invariants = inferInvariants(input.siblingFiles);
	if (invariants.length > 0) {
		sections.push({
			title: "Architecture boundaries",
			body: invariants.map((item) => `- ${item}`).join("\n"),
		});
	}
	if (input.adoption.sources.length > 0) {
		const sourceNames = input.adoption.sources
			.map((source) => `\`${source.path}\``)
			.slice(0, 8)
			.join(", ");
		sections.push({
			title: "Sibling agent context",
			body: [
				`Bootstrap scanned ${input.adoption.sources.length} sibling context source${input.adoption.sources.length === 1 ? "" : "s"}: ${sourceNames}${input.adoption.sources.length > 8 ? ", ..." : ""}.`,
				"Imported rules appear in the provenance section only when adoption mode is enabled.",
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
			"clio context-init preview",
			`  ${contextLine}; codewiki would index ${summary.codewikiEntries} entr${summary.codewikiEntries === 1 ? "y" : "ies"}; ${dirtyLine}; no files written`,
			...(adoptionLine ? [adoptionLine] : []),
			"",
		].join("\n");
	}
	const adoptionLine = formatAdoptionLine(summary);
	const proposalLine = summary.proposalPath ? `  proposal written ${summary.proposalPath}` : null;
	if (summary.action === "preserved") {
		return [
			"clio context-init preserved CLIO.md",
			`  ${contextLine}; codewiki rebuilt ${summary.codewikiEntries} entr${summary.codewikiEntries === 1 ? "y" : "ies"}; state refreshed; ${dirtyLine}`,
			"  CLIO.md is treated as human-owned. Use --apply to replace it with a generated draft, --propose to write an ignored proposal, or --adopt to refresh only imported agent context.",
			...(adoptionLine ? [adoptionLine] : []),
			"",
		].join("\n");
	}
	if (summary.action === "proposed") {
		return [
			"clio context-init proposed CLIO.md",
			`  ${contextLine}; codewiki rebuilt ${summary.codewikiEntries} entr${summary.codewikiEntries === 1 ? "y" : "ies"}; state refreshed; ${dirtyLine}`,
			...(proposalLine ? [proposalLine] : []),
			"  CLIO.md was not changed. Re-run with --apply only after reviewing the proposal.",
			...(adoptionLine ? [adoptionLine] : []),
			"",
		].join("\n");
	}
	return [
		`clio context-init ${summary.action} CLIO.md`,
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
	return normalizedGitignoreLines(content).some((line) => line === ".clio" || line === ".clio/");
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
		return trimmed !== ".clio" && trimmed !== ".clio/" && !CLIO_GITIGNORE_DYNAMIC_LINES.has(trimmed);
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
			"clio context-init: .gitignore does not ignore .clio/; local context, skills, agents, and handoffs may leak into commits.\n",
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

function writeProjectState(
	cwd: string,
	projectType: ProjectType,
	now: Date,
	indexedAt: string,
	adoption: AdoptionScanResult,
	recordAdoption: boolean,
): string {
	const finalFingerprint = computeFingerprint(cwd);
	const statePath = resolveStatePath(cwd);
	const prev = readClioState(cwd);
	const contextSources = recordAdoption ? adoption.sourceSnapshots : (prev?.contextSources ?? []);
	const contextSourceHash = contextSources.length > 0 ? adoptionSnapshotsHash(contextSources) : undefined;
	writeClioState(cwd, {
		version: 1,
		projectType,
		fingerprint: finalFingerprint,
		lastInitAt: now.toISOString(),
		lastSessionAt: now.toISOString(),
		lastIndexedAt: indexedAt,
		...(contextSources.length > 0 ? { contextSources } : {}),
		...(contextSourceHash ? { contextSourceHash } : {}),
	});
	return statePath;
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
export function codewikiEntryPoints(codewiki: Codewiki, limit = 6): string[] {
	const tagged = codewiki.entries.filter((entry) => entry.kind === "entry-point").map((entry) => entry.path);
	if (tagged.length >= limit) return tagged.slice(0, limit);
	const inDegree = new Map<string, number>();
	for (const entry of codewiki.entries) {
		for (const target of entry.imports) inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
	}
	const ranked = [...inDegree.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([path]) => path)
		.filter((path) => !tagged.includes(path));
	return [...tagged, ...ranked].slice(0, limit);
}

/**
 * Seed the context engine's read side. Writes a starter handoff that
 * `context-prime` consumes on the next session so a fresh agent reconstructs
 * intent instead of cold-starting. Never clobbers handoffs written by
 * `context-handoff`: it only seeds when no handoff exists yet.
 */
function seedInitialHandoff(cwd: string, output: BootstrapStructuredOutput, codewiki: Codewiki, now: Date): void {
	const dir = join(cwd, ".clio", "handoffs");
	try {
		if (existsSync(dir) && readdirSync(dir).some((name) => /^handoff-.*\.md$/.test(name))) return;
	} catch {
		// Unreadable dir is treated as empty; the write below recreates it.
	}
	const date = now.toISOString().slice(0, 10);
	const entryPoints = codewikiEntryPoints(codewiki);
	const lines = [
		`# Handoff ${date}: context-init`,
		"",
		`**Project:** ${output.projectName}`,
		"",
		"## Focus",
		"Fresh repository orientation. No work in progress yet; CLIO.md and the codewiki were just bootstrapped.",
		"",
		"## Where things stand",
		`- Identity: ${output.identity}`,
		`- Codewiki indexed ${codewiki.entries.length} module${codewiki.entries.length === 1 ? "" : "s"} (use entry_points, where_is, find_symbol).`,
		...(entryPoints.length > 0 ? ["- Entry points:", ...entryPoints.map((path) => `  - ${path}`)] : []),
		"",
		"## Suggested first step",
		"Read CLIO.md for conventions and invariants, then state the task before changing code.",
		"",
		"_Seeded by /context-init. context-handoff overwrites this with a real brief at the end of a working session._",
		"",
	];
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `handoff-${date}-context-init.md`), lines.join("\n"), "utf8");
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
	const codewiki = buildCodewiki({ cwd, language: projectType, generatedAt: indexedAt });
	progress(input, {
		phase: "codewiki",
		status: "completed",
		message: `indexed ${codewiki.entries.length} module${codewiki.entries.length === 1 ? "" : "s"}`,
		current: codewiki.entries.length,
		total: codewiki.entries.length,
	});
	const hadClioMd = existsSync(join(cwd, "CLIO.md"));
	const useExistingClioMdAsSource = hadClioMd && input.rewriteClioMd !== true;
	const existingClioMdText = useExistingClioMdAsSource ? readExistingClioMdText(cwd) : null;
	const existingClioMd = useExistingClioMdAsSource ? tryReadClioMd(cwd) : null;
	const existingParsed = existingClioMd?.ok ? existingClioMd.value : undefined;
	const shouldGenerate = !hadClioMd || input.applyClioMd === true || input.proposeClioMd === true;
	let output: BootstrapStructuredOutput;
	if (shouldGenerate) {
		progress(input, {
			phase: "generate",
			status: "started",
			message: input.generate ? "drafting CLIO.md with scout" : "drafting CLIO.md with heuristic",
		});
		output = await (input.generate ?? heuristicBootstrapOutput)({
			cwd,
			projectType,
			siblingFiles,
			adoption,
			codewiki,
			...(existingParsed ? { existingClioMd: existingParsed } : {}),
			...(existingClioMdText ? { existingClioMdText } : {}),
			...(input.onProgress ? { progress: input.onProgress } : {}),
		});
		progress(input, {
			phase: "generate",
			status: "completed",
			message: `${output.projectName}: ${output.sections?.length ?? 0} custom section${(output.sections?.length ?? 0) === 1 ? "" : "s"}`,
		});
		output = stabilizeGeneratedOutput(
			{
				cwd,
				projectType,
				siblingFiles,
				adoption,
				codewiki,
				...(existingParsed ? { existingClioMd: existingParsed } : {}),
				...(existingClioMdText ? { existingClioMdText } : {}),
			},
			output,
		);
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
			codewikiEntries: codewiki.entries.length,
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
		};
	}

	await ensureGitignore(cwd, input);
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
	} else if (input.applyClioMd === true) {
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
	progress(input, { phase: "state", status: "started", message: "persisting codewiki and project state" });
	writeCodewiki(cwd, codewiki);
	const statePath = writeProjectState(cwd, projectType, now, indexedAt, adoption, input.adopt === true);
	progress(input, {
		phase: "state",
		status: "completed",
		message: `state updated; ${codewiki.entries.length} codewiki entr${codewiki.entries.length === 1 ? "y" : "ies"}`,
	});
	progress(input, { phase: "handoff", status: "started", message: "seeding initial handoff" });
	seedInitialHandoff(cwd, output, codewiki, now);
	progress(input, { phase: "handoff", status: "completed", message: "handoff ready" });

	const postStatus = gitStatus(cwd);
	const summary: RunBootstrapSummary = {
		action,
		contextFileCount: readNames.length,
		contextFileNames: readNames,
		codewikiEntries: codewiki.entries.length,
		dirtyFiles: countStatusLines(postStatus),
		adoption: summarizeAdoption(adoption, input.adopt === true ? "adopt" : "scan"),
		...(proposalPath ? { proposalPath } : {}),
	};
	out(input.io, formatBootstrapSummary(summary));
	progress(input, {
		phase: "done",
		status: "completed",
		message: `${summary.action} CLIO.md; ${summary.dirtyFiles} dirty file${summary.dirtyFiles === 1 ? "" : "s"}`,
	});
	return {
		clioMdPath,
		statePath,
		siblingFiles,
		output,
		projectType,
		summary,
		adoption,
	};
}

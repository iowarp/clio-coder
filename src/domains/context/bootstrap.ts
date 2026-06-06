import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { detectProjectType, type ProjectType } from "../session/workspace/project-type.js";
import {
	type AdoptionScanResult,
	adoptionSnapshotsHash,
	renderImportedAgentContext,
	scanAgentConfigs,
} from "./adoption.js";
import { type ClioMdFingerprintFooter, parseClioMd, serializeClioMd } from "./clio-md.js";
import { buildCodewiki, writeCodewiki } from "./codewiki/indexer.js";
import { computeFingerprint, fingerprintsEqual } from "./fingerprint.js";
import type { SiblingContextFile } from "./sibling-files.js";
import { readClioState, statePath as resolveStatePath, writeClioState } from "./state.js";

export interface BootstrapStructuredOutput {
	projectName: string;
	identity: string;
	conventions: string[];
	invariants: string[];
	importedAgentContext?: string;
}

export interface BootstrapIo {
	stdout: (s: string) => void;
	stderr: (s: string) => void;
}

export interface RunBootstrapInput {
	cwd?: string;
	io?: BootstrapIo;
	modelId?: string;
	now?: () => Date;
	confirmGitignore?: () => boolean | Promise<boolean>;
	preview?: boolean;
	adopt?: boolean;
	includeGlobalImports?: boolean;
	homeDir?: string;
	generate?: (input: {
		cwd: string;
		projectType: ProjectType;
		siblingFiles: ReadonlyArray<SiblingContextFile>;
		adoption: AdoptionScanResult;
	}) => BootstrapStructuredOutput | Promise<BootstrapStructuredOutput>;
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
	action: "wrote" | "refreshed" | "previewed";
	contextFileCount: number;
	contextFileNames: string[];
	codewikiEntries: number;
	dirtyFiles: number;
	adoption: RunBootstrapAdoptionSummary;
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

function defaultGenerate(input: {
	cwd: string;
	projectType: ProjectType;
	siblingFiles: ReadonlyArray<SiblingContextFile>;
	adoption: AdoptionScanResult;
}): BootstrapStructuredOutput {
	return {
		projectName: projectName(input.cwd),
		identity: defaultIdentity(input.cwd, input.projectType, input.siblingFiles),
		conventions: inferConventions(input.cwd, input.projectType, input.siblingFiles),
		invariants: inferInvariants(input.siblingFiles),
	};
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
			"clio init preview",
			`  ${contextLine}; codewiki would index ${summary.codewikiEntries} entr${summary.codewikiEntries === 1 ? "y" : "ies"}; ${dirtyLine}; no files written`,
			...(adoptionLine ? [adoptionLine] : []),
			"",
		].join("\n");
	}
	const adoptionLine = formatAdoptionLine(summary);
	return [
		`clio init ${summary.action} CLIO.md`,
		`  ${contextLine}; codewiki rebuilt ${summary.codewikiEntries} entr${summary.codewikiEntries === 1 ? "y" : "ies"}; fingerprint updated; ${dirtyLine}`,
		...(adoptionLine ? [adoptionLine] : []),
		"",
	].join("\n");
}

async function ensureGitignore(cwd: string, input: RunBootstrapInput): Promise<void> {
	const gitignorePath = join(cwd, ".gitignore");
	let content = "";
	try {
		content = readFileSync(gitignorePath, "utf8");
	} catch {
		content = "";
	}
	if (/^\.clio\/?$/m.test(content)) return;
	const confirmed = input.confirmGitignore ? await input.confirmGitignore() : false;
	if (!confirmed) {
		warn(input.io, "clio init: .clio/ is not gitignored; local indices may leak into commits.\n");
		return;
	}
	const prefix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
	writeFileSync(gitignorePath, `${content}${prefix}.clio/\n`, "utf8");
}

function writeArtifacts(
	cwd: string,
	projectType: ProjectType,
	modelId: string,
	now: Date,
	output: BootstrapStructuredOutput,
	adoption: AdoptionScanResult,
): { clioMdPath: string; statePath: string } {
	const clioMdPath = join(cwd, "CLIO.md");
	mkdirSync(dirname(clioMdPath), { recursive: true });
	let fingerprint = computeFingerprint(cwd);
	for (let i = 0; i < 4; i += 1) {
		const footer: ClioMdFingerprintFooter = {
			initAt: now.toISOString(),
			model: modelId,
			gitHead: fingerprint.gitHead,
			treeHash: fingerprint.treeHash,
			loc: fingerprint.loc,
		};
		const serialized = serializeClioMd({ ...output, fingerprint: footer });
		const parsed = parseClioMd(serialized);
		if (!parsed.ok) throw new Error(`bootstrap produced invalid CLIO.md: ${parsed.errors.join("; ")}`);
		writeFileSync(clioMdPath, serialized, "utf8");
		const next = computeFingerprint(cwd);
		if (fingerprintsEqual(fingerprint, next)) break;
		fingerprint = next;
	}
	const finalFingerprint = computeFingerprint(cwd);
	const statePath = resolveStatePath(cwd);
	const contextSources = adoption.sourceSnapshots;
	writeClioState(cwd, {
		version: 1,
		projectType,
		fingerprint: finalFingerprint,
		bootstrapFingerprint: finalFingerprint,
		lastInitAt: now.toISOString(),
		lastSessionAt: now.toISOString(),
		...(contextSources.length > 0 ? { contextSources, contextSourceHash: adoptionSnapshotsHash(contextSources) } : {}),
	});
	return { clioMdPath, statePath };
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
	const cwd = input.cwd ?? process.cwd();
	const projectType = detectProjectType(cwd);
	const adoption = scanAgentConfigs({
		cwd,
		...(input.homeDir ? { homeDir: input.homeDir } : {}),
		includeGlobal: input.includeGlobalImports === true,
	});
	const siblingFiles = loadBootstrapSiblingFiles(adoption);
	let output = await (input.generate ?? defaultGenerate)({ cwd, projectType, siblingFiles, adoption });
	if (input.adopt === true) {
		const importedAgentContext = renderImportedAgentContext(adoption);
		if (importedAgentContext.length > 0) output = { ...output, importedAgentContext };
	}
	const now = input.now?.() ?? new Date();
	const indexedAt = now.toISOString();
	const codewiki = buildCodewiki({ cwd, language: projectType, generatedAt: indexedAt });
	const readNames = siblingFiles.map((file) => file.path).sort((a, b) => a.localeCompare(b));
	const previewStatus = gitStatus(cwd);
	if (input.preview === true) {
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
	const hadClioMd = existsSync(join(cwd, "CLIO.md"));
	const paths = writeArtifacts(cwd, projectType, input.modelId ?? "local-bootstrap", now, output, adoption);
	writeCodewiki(cwd, codewiki);
	const state = readClioState(cwd);
	if (state) writeClioState(cwd, { ...state, lastIndexedAt: indexedAt });

	const postStatus = gitStatus(cwd);
	const summary: RunBootstrapSummary = {
		action: hadClioMd ? "refreshed" : "wrote",
		contextFileCount: readNames.length,
		contextFileNames: readNames,
		codewikiEntries: codewiki.entries.length,
		dirtyFiles: countStatusLines(postStatus),
		adoption: summarizeAdoption(adoption, input.adopt === true ? "adopt" : "scan"),
	};
	out(input.io, formatBootstrapSummary(summary));
	return {
		...paths,
		siblingFiles,
		output,
		projectType,
		summary,
		adoption,
	};
}

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { loadProjectContextFiles } from "../prompts/context-files.js";
import { detectProjectType, type ProjectType } from "../session/workspace/project-type.js";
import { type ClioMdFingerprintFooter, parseClioMd, serializeClioMd } from "./clio-md.js";
import { computeFingerprint, fingerprintsEqual } from "./fingerprint.js";
import { loadSiblingContextFiles, type SiblingContextFile } from "./sibling-files.js";
import { writeClioState } from "./state.js";

export interface BootstrapStructuredOutput {
	projectName: string;
	identity: string;
	conventions: string[];
	invariants: string[];
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
	generate?: (input: {
		cwd: string;
		projectType: ProjectType;
		siblingFiles: ReadonlyArray<SiblingContextFile>;
	}) => BootstrapStructuredOutput;
}

export interface RunBootstrapResult {
	clioMdPath: string;
	statePath: string;
	siblingFiles: ReadonlyArray<SiblingContextFile>;
	output: BootstrapStructuredOutput;
	projectType: ProjectType;
}

const BOOTSTRAP_CONTEXT_FILE_NAMES = ["CLAUDE.md", "AGENTS.md", "GEMINI.md", "CODEX.md"] as const;

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

function defaultIdentity(cwd: string, projectType: ProjectType, files: ReadonlyArray<SiblingContextFile>): string {
	const name = projectName(cwd);
	const context = allContextText(files);
	if (/Clio owns the agent loop/i.test(context) && /pi SDK/i.test(context)) {
		return [
			"Clio Coder is IOWarp's orchestrator coding agent.",
			"The pi SDK is a vendored engine accessed only through the engine boundary.",
			"Clio owns the agent loop, TUI, session format, tool registry, and identity.",
		].join(" ");
	}
	const pkg = readJsonFile(join(cwd, "package.json"));
	const description = stringField(pkg, "description");
	const role = description
		? `It is ${description.replace(/\.$/, "")}.`
		: `It is a ${projectTypeLabel(projectType)} project.`;
	return `${name} is a ${projectTypeLabel(projectType)} project. ${role}`.slice(0, 600);
}

function pushUnique(target: string[], value: string): void {
	if (target.includes(value)) return;
	target.push(value);
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
	return conventions.slice(0, 6);
}

function inferInvariants(files: ReadonlyArray<SiblingContextFile>): string[] {
	const context = allContextText(files);
	const invariants: string[] = [];
	if (/Engine boundary/i.test(context)) {
		pushUnique(invariants, "Engine boundary. Only `src/engine/**` may value-import `@mariozechner/pi-*`.");
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
}): BootstrapStructuredOutput {
	return {
		projectName: projectName(input.cwd),
		identity: defaultIdentity(input.cwd, input.projectType, input.siblingFiles),
		conventions: inferConventions(input.cwd, input.projectType, input.siblingFiles),
		invariants: inferInvariants(input.siblingFiles),
	};
}

function loadBootstrapSiblingFiles(cwd: string): SiblingContextFile[] {
	const fromPromptLoader = loadProjectContextFiles({ cwd, fileNames: BOOTSTRAP_CONTEXT_FILE_NAMES }).map((file) => ({
		source: "project",
		path: file.path,
		content: file.content,
	}));
	const direct = loadSiblingContextFiles(cwd);
	const byPath = new Map<string, SiblingContextFile>();
	for (const file of [...fromPromptLoader, ...direct]) byPath.set(file.path, file);
	return [...byPath.values()];
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
	const statePath = join(cwd, ".clio", "state.json");
	writeClioState(cwd, {
		version: 1,
		projectType,
		fingerprint: finalFingerprint,
		lastInitAt: now.toISOString(),
		lastSessionAt: now.toISOString(),
	});
	return { clioMdPath, statePath };
}

export async function runBootstrap(input: RunBootstrapInput = {}): Promise<RunBootstrapResult> {
	const cwd = input.cwd ?? process.cwd();
	const projectType = detectProjectType(cwd);
	const siblingFiles = loadBootstrapSiblingFiles(cwd);
	const output = (input.generate ?? defaultGenerate)({ cwd, projectType, siblingFiles });
	await ensureGitignore(cwd, input);
	const paths = writeArtifacts(
		cwd,
		projectType,
		input.modelId ?? "local-bootstrap",
		input.now?.() ?? new Date(),
		output,
	);

	const readNames = siblingFiles.map((file) => file.path).sort((a, b) => a.localeCompare(b));
	const summary =
		readNames.length > 0
			? `clio init: folded ${readNames.length} context file(s) into CLIO.md. Clio will not read them again unless you re-run /init.\n`
			: "clio init: wrote CLIO.md. No sibling context files were found.\n";
	out(input.io, summary);
	const status = gitStatus(cwd);
	out(input.io, status.length > 0 ? `git status --short:\n${status}` : "git status --short: clean\n");
	return {
		...paths,
		siblingFiles,
		output,
		projectType,
	};
}

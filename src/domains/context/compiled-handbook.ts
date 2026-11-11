/**
 * The handbook a repository without CLIO-CODER.md gets: compiled from its own
 * checkers, the verified rules of other harnesses' handbooks, its verification
 * commands and its tree facts, with no model call (`compileHandbookFromTree`).
 *
 * The compile reads the tree, so it is cached twice. On disk under
 * `.clio-coder/state/`, keyed by a fingerprint of its inputs, so a new session
 * over an unchanged tree reuses it; in process per repository root, revalidated
 * by the size and mtime of the files it read, so prompt assembly and every
 * bounded dispatch pay a few stat calls. The Markdown file is what the prompt
 * names as the handbook's path, so a read of an omitted line resolves.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { clioProjectRoot } from "../../core/project-root.js";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { enumerateWorkspaceFiles } from "../../core/workspace-files.js";
import { scanAgentConfigs } from "./adoption.js";
import { compileHandbookFromTree } from "./bootstrap.js";
import type { ProjectPromptContext } from "./contract.js";
import { collectEnforcementInventory } from "./enforcement-inventory.js";
import { renderPromptContext } from "./prompt-context.js";

export interface CompiledProjectHandbook {
	/** Absolute path of the cached Markdown; the prompt cites it as the handbook's path. */
	path: string;
	source: string;
	/** Repository-relative files its rules came from. */
	sources: string[];
	rules: number;
}

/** Bumped when the compile's output changes for the same inputs, so an older cache is not reused. */
const COMPILE_VERSION = 1;

/** Root files whose content the compile reads beyond the checkers and handbooks. */
const MANIFESTS: ReadonlyArray<string> = [
	"package.json",
	"tsconfig.json",
	"biome.json",
	"biome.jsonc",
	".prettierrc",
	".prettierrc.json",
	"Cargo.toml",
	"go.mod",
	"pyproject.toml",
	"setup.cfg",
	"CMakeLists.txt",
];

interface Stamp {
	path: string;
	stamp: string;
}

const memo = new Map<string, { stamps: Stamp[]; value: CompiledProjectHandbook | null }>();

function compiledHandbookPath(root: string): string {
	return join(root, ".clio-coder", "state", "compiled-handbook.md");
}

function sidecarPath(root: string): string {
	return join(root, ".clio-coder", "state", "compiled-handbook.json");
}

function stampOf(path: string): string {
	try {
		const stat = statSync(path);
		return `${stat.size}:${stat.mtimeMs}`;
	} catch {
		return "absent";
	}
}

function readCache(root: string, fingerprint: string): CompiledProjectHandbook | null {
	try {
		const meta = JSON.parse(readFileSync(sidecarPath(root), "utf8")) as Record<string, unknown>;
		if (meta.fingerprint !== fingerprint || !Array.isArray(meta.sources) || typeof meta.rules !== "number") return null;
		const path = compiledHandbookPath(root);
		const source = readFileSync(path, "utf8");
		if (createHash("sha256").update(source).digest("hex") !== meta.contentSha256) return null;
		return { path, source, sources: meta.sources.filter((entry) => typeof entry === "string"), rules: meta.rules };
	} catch {
		return null;
	}
}

/**
 * Only `.clio-coder/state/` is written. A repository without `.clio-coder/`
 * has no ignore file there, so the state directory ignores itself rather than
 * adding one beside the operator's files.
 */
function writeCache(root: string, fingerprint: string, value: CompiledProjectHandbook): void {
	try {
		const ignore = join(root, ".clio-coder", "state", ".gitignore");
		if (!existsSync(join(root, ".clio-coder", ".gitignore")) && !existsSync(ignore))
			safeResourceWrite(ignore, "*\n", { encoding: "utf8" });
		safeResourceWrite(value.path, value.source, { encoding: "utf8" });
		const meta = {
			version: COMPILE_VERSION,
			fingerprint,
			contentSha256: createHash("sha256").update(value.source).digest("hex"),
			sources: value.sources,
			rules: value.rules,
		};
		safeResourceWrite(sidecarPath(root), `${JSON.stringify(meta, null, 2)}\n`, { encoding: "utf8" });
	} catch {
		// The cache saves the next session a compile; the compiled text is still delivered.
	}
}

function dropCache(root: string): void {
	for (const path of [compiledHandbookPath(root), sidecarPath(root)]) rmSync(path, { force: true });
}

/**
 * The compiled handbook for the repository holding `cwd`, or null when it has
 * nothing checkable to say. Callers ask only when no CLIO-CODER.md loaded.
 */
export function compiledProjectHandbook(cwd: string): CompiledProjectHandbook | null {
	const root = clioProjectRoot(cwd);
	const known = memo.get(root);
	if (known?.stamps.every(({ path, stamp }) => stampOf(path) === stamp)) return known.value;
	let files: string[];
	try {
		files = enumerateWorkspaceFiles(root);
	} catch {
		files = [];
	}
	const adoption = scanAgentConfigs({ cwd: root, includeGlobal: false, workspaceFiles: files });
	const enforcement = collectEnforcementInventory(root, files);
	const read = [
		...new Set([
			...adoption.sources.map((source) => source.path),
			...enforcement.checkFiles.map((file) => join(root, file.path)),
			...MANIFESTS.map((name) => join(root, name)),
		]),
	].sort();
	const hash = createHash("sha256").update(`v${COMPILE_VERSION}\0${files.join("\n")}\0${adoption.sourceHash}\0`);
	hash.update(JSON.stringify(enforcement));
	for (const path of read) {
		hash.update(`\0${relative(root, path)}\0`);
		try {
			hash.update(readFileSync(path));
		} catch {
			hash.update("absent");
		}
	}
	const fingerprint = hash.digest("hex");
	// Stamped before the compile reads, so an edit made while it runs triggers the next one.
	const stamps = read.map((path) => ({ path, stamp: stampOf(path) }));
	let value = readCache(root, fingerprint);
	if (!value) {
		const compiled = compileHandbookFromTree({ cwd: root, repositoryFiles: files, adoption, enforcement });
		if (compiled) {
			value = {
				path: compiledHandbookPath(root),
				source: compiled.markdown,
				sources: compiled.sources,
				rules: compiled.rules,
			};
			writeCache(root, fingerprint, value);
		} else if (existsSync(sidecarPath(root))) {
			dropCache(root);
		}
	}
	// The root's own entry list catches a handbook or checker added beside it; stamped after the cache write lands.
	memo.set(root, { stamps: [...stamps, { path: root, stamp: stampOf(root) }], value });
	return value;
}

/** The project prompt context every session surface and dispatch shares: the authored handbook, else the compiled one. */
export function renderEffectivePromptContext(cwd: string): ProjectPromptContext {
	return renderPromptContext(cwd, { compile: compiledProjectHandbook });
}

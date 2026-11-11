/**
 * The project rules a delegated harness (Claude Code, Codex, Pi, OpenCode)
 * receives. Such a harness reads its own instruction files from the
 * repository; this compiles the run's handbook together with the rules of
 * those files that still hold into one rule set (see `compilePeerHandbook`)
 * and says how it reaches the harness: in place of the files when the runtime
 * declares a switch that skips them, beside them otherwise. Nothing here
 * writes to the files or argues with them.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { internalGitArgv } from "../../core/internal-git.js";
import { runCommandVector } from "../../core/safe-exec.js";
import type { HandbookLedgerEntry } from "../context/bootstrap.js";
import { judgeInstructionFiles } from "../context/bootstrap.js";
import { type CompiledHandbook, compileHandbook, type HandbookAudience } from "../context/handbook-units.js";
import { compilePeerHandbook } from "../context/peer-handbook.js";
import { treeFacts } from "../context/tree-facts.js";
import type { RepositoryInstructionFiles } from "../providers/types/runtime-descriptor.js";

export interface PeerInstructions {
	delivery: RepositoryInstructionFiles["delivery"];
	/** The harness's instruction files this run found, relative to the repository root. */
	files: string[];
	/** Rules of those files the tree no longer supports. */
	stale: number;
	/** Rules of those files that hold but did not fit the bound. */
	notCarried: number;
	/** The compiled rules; absent when the handbook has no sections to compile, so the run keeps its usual message. */
	text?: string;
}

interface PeerFile {
	file: string;
	path: string;
	content: string;
}

/** The repository root above `cwd`: the nearest directory holding a `.git` entry, else `cwd`. */
function repositoryRoot(cwd: string): string {
	let directory = resolve(cwd);
	while (!existsSync(join(directory, ".git"))) {
		const parent = dirname(directory);
		if (parent === directory) return resolve(cwd);
		directory = parent;
	}
	return directory;
}

function readFile(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/** The instruction files the harness reads in each directory from the repository root down to `cwd`. */
function findPeerInstructionFiles(cwd: string, declared: RepositoryInstructionFiles): PeerFile[] {
	const root = repositoryRoot(cwd);
	const below = relative(root, resolve(cwd));
	const directories = [root];
	if (below.length > 0 && !below.startsWith("..")) {
		for (const part of below.split(sep)) directories.push(join(directories.at(-1) ?? root, part));
	}
	const found: PeerFile[] = [];
	const take = (directory: string, name: string): boolean => {
		const path = join(directory, name);
		const content = readFile(path);
		if (content === null) return false;
		found.push({ file: relative(root, path).split(sep).join("/"), path, content });
		return true;
	};
	for (const directory of directories) {
		let any = false;
		for (const name of declared.files) any = take(directory, name) || any;
		if (!any) for (const name of declared.fallback ?? []) if (take(directory, name)) break;
	}
	return found;
}

const judged = new Map<string, Promise<HandbookLedgerEntry[]>>();
const JUDGED_CACHE_MAX = 16;

async function headOf(root: string): Promise<string> {
	const result = await runCommandVector("git", internalGitArgv(["-C", root, "rev-parse", "HEAD"]), { timeoutMs: 5000 });
	return result.exitCode === 0 ? result.stdout.trim() : "";
}

/** Judging walks the tree, so a verdict is reused while the commit and the files are unchanged. */
async function judgePeerFiles(cwd: string, files: ReadonlyArray<PeerFile>): Promise<HandbookLedgerEntry[]> {
	const root = repositoryRoot(cwd);
	const key = createHash("sha256")
		.update([root, await headOf(root), ...files.flatMap((file) => [file.file, file.content])].join("\0"))
		.digest("hex");
	const held = judged.get(key);
	if (held !== undefined) return held;
	const pending = judgeInstructionFiles(cwd, files, "adopted");
	judged.set(key, pending);
	pending.catch(() => judged.delete(key));
	if (judged.size > JUDGED_CACHE_MAX) judged.delete(judged.keys().next().value ?? key);
	return pending;
}

interface PeerInstructionsInput {
	declared: RepositoryInstructionFiles | undefined;
	cwd: string;
	/** The run's authored handbooks, as the bounded project message would select from them. */
	handbookSources: ReadonlyArray<{ source: string; path: string }>;
	audience: ReadonlyArray<HandbookAudience>;
	workingPaths: ReadonlyArray<string>;
	maxChars: number;
	/** Clio tool and recipe names: a handbook rule citing one only makes sense inside Clio. */
	clioNames: ReadonlyArray<string>;
}

/**
 * Null when the runtime reads no instruction files or the repository has none
 * of them, so the run is unchanged. Single source is used only when the
 * handbook compiled; a handbook of prose alone keeps its usual message and the
 * harness's files are read beside it.
 */
export async function resolvePeerInstructions(input: PeerInstructionsInput): Promise<PeerInstructions | null> {
	if (input.declared === undefined) return null;
	const files = findPeerInstructionFiles(input.cwd, input.declared);
	if (files.length === 0) return null;
	const peerRules = await judgePeerFiles(input.cwd, files);
	const names = files.map((file) => file.file);
	const compiled = input.handbookSources.map(({ source, path }) => compileHandbook(source, path));
	const handbooks = compiled.filter((handbook): handbook is CompiledHandbook => handbook !== null);
	if (handbooks.length !== compiled.length) {
		const stale = peerRules.filter((rule) => rule.verdict === "stale" || rule.verdict === "contradicted").length;
		return { delivery: "coexist", files: names, stale, notCarried: 0 };
	}
	const peer = compilePeerHandbook(handbooks, {
		audience: input.audience,
		cwd: input.cwd,
		workingPaths: input.workingPaths,
		maxChars: input.maxChars,
		peerRules,
		facts: treeFacts(repositoryRoot(input.cwd)),
		clioNames: input.clioNames,
	});
	return {
		delivery: input.declared.delivery,
		files: names,
		stale: peer.stale,
		notCarried: peer.notCarried,
		text: peer.text,
	};
}

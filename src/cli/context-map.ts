import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CLIO_ARTIFACT_DIR } from "../core/artifact-paths.js";
import { codemapPath, legacyCodewikiPath } from "../domains/context/codewiki/artifact.js";
import { type CodewikiCoordinatedResult, coordinateCodewikiWrite } from "../domains/context/codewiki/coordinator.js";
import type { Codewiki } from "../domains/context/codewiki/schema.js";
import { buildRepoMap, renderRepoMap } from "../domains/context/wiki/repo-map.js";
import { publishFileAtomically, withFileMutationQueue } from "../tools/file-mutation-queue.js";

const HELP = `Usage:
  clio-coder context map [--out <path>] [--json]

Create a standalone interactive HTML map from current repository evidence,
without model calls or a separate renderer. Builds or refreshes the index.

Options:
  --out <path>    HTML destination (default: ${CLIO_ARTIFACT_DIR}/maps/<repo>.html)
  --json         print an artifact receipt
`;

/** Where the map lands when the operator names no path: a human-transient map artifact. */
function defaultRepoMapPath(cwd: string): string {
	return path.join(cwd, CLIO_ARTIFACT_DIR, "maps", `${path.basename(cwd)}.html`);
}

function gitValue(cwd: string, args: string[], raw = false): string | null {
	try {
		const out = execFileSync("git", args, { cwd, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).toString("utf8");
		// Porcelain status columns start with a meaningful space; trimming would shift them.
		return raw ? out : out.trim();
	} catch {
		return null;
	}
}

type SourceState = "clean" | "dirty" | "unknown";

/**
 * Status entries that make the working tree differ from HEAD, minus this
 * command's own untracked outputs.
 *
 * The map writes its index and its HTML before provenance is read again on the
 * next run, so counting them made every repeat map of a clean checkout dirty.
 * Only an untracked entry at exactly one of `generated` is dropped. Untracked
 * files are listed individually (`--untracked-files=all`), because the
 * default collapses a wholly untracked `.clio-coder/` into one entry, and
 * dropping that would hide every other file in it. Tracked changes, renames
 * and any other untracked path still count.
 */
function workingTreeChanges(cwd: string, generated: ReadonlyArray<string>): string[] | null {
	const status = gitValue(cwd, ["status", "--porcelain", "-z", "--untracked-files=all"], true);
	const top = gitValue(cwd, ["rev-parse", "--show-toplevel"]);
	if (status === null || top === null) return null;
	const own = new Set(
		generated.flatMap((file) => {
			const inside = path.relative(top, file);
			return inside === "" || inside.startsWith("..") || path.isAbsolute(inside) ? [] : [inside.split(path.sep).join("/")];
		}),
	);
	const changes: string[] = [];
	const records = status.split("\0");
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index] as string;
		if (record.length < 4) continue;
		const code = record.slice(0, 2);
		// A rename or copy carries its original path as the next record.
		if (code.includes("R") || code.includes("C")) index += 1;
		if (code === "??" && own.has(record.slice(3))) continue;
		changes.push(record);
	}
	return changes;
}

/** A successful empty status means clean; unavailable Git evidence never does. */
function repositoryFacts(
	cwd: string,
	codewiki: Codewiki,
	indexedHead: string | null,
	generated: ReadonlyArray<string>,
): { sourceState: SourceState; repository?: { url: string; revision: string } } {
	const revision = gitValue(cwd, ["rev-parse", "--verify", "HEAD"]);
	const changes = workingTreeChanges(cwd, generated);
	if (!revision || changes === null) return { sourceState: "unknown" };
	if (changes.length > 0 || revision !== indexedHead) return { sourceState: "dirty" };
	// Source paths in the map are workspace-relative. A nested workspace has
	// no proven repository-relative path mapping, so cannot supply citations.
	if (gitValue(cwd, ["rev-parse", "--show-prefix"]) !== "") return { sourceState: "unknown" };
	const tree = gitValue(cwd, ["ls-tree", "-r", "-z", revision]);
	if (tree === null) return { sourceState: "unknown" };
	const blobs = new Map<string, string>();
	for (const entry of tree.split("\0")) {
		const match = /^100[0-7]{3} blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry);
		if (match) blobs.set(match[2] as string, match[1] as string);
	}
	try {
		for (const file of codewiki.files) {
			const contents = readFileSync(path.join(cwd, file.path));
			// Verify both parser input identity and immutable Git blob identity.
			// This also catches ignored/untracked inputs and assume-unchanged files
			// that a successful `git status` alone cannot certify.
			const indexedHash = createHash("sha256").update(contents.toString("utf8")).digest("hex").slice(0, 16);
			const blob = createHash("sha1").update(`blob ${contents.length}\0`).update(contents).digest("hex");
			if (indexedHash !== file.hash || blobs.get(file.path) !== blob) return { sourceState: "dirty" };
		}
	} catch {
		return { sourceState: "unknown" };
	}
	const remote = gitValue(cwd, ["remote", "get-url", "origin"]);
	if (!remote) return { sourceState: "clean" };
	let url = remote.endsWith(".git") ? remote.slice(0, -4) : remote;
	const ssh = /^git@([^:]+):(.+)$/.exec(url);
	if (ssh) url = `https://${ssh[1]}/${ssh[2]}`;
	return { sourceState: "clean", repository: { url, revision } };
}

export async function runContextMapCommand(args: string[]): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(HELP);
		return 0;
	}
	let out: string | null = null;
	let json = false;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] as string;
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--out") {
			const value = args[index + 1];
			if (!value || value.startsWith("--")) {
				process.stderr.write("clio-coder context map: --out requires a path\n");
				return 2;
			}
			out = value;
			index += 1;
			continue;
		}
		process.stderr.write(`clio-coder context map: unknown flag ${arg}\n`);
		return 2;
	}
	const cwd = process.cwd();
	const target = out ? path.resolve(cwd, out) : defaultRepoMapPath(cwd);
	if (!/\.html?$/i.test(target)) {
		process.stderr.write("clio-coder context map: output path must end in .html or .htm\n");
		return 2;
	}
	let reconciled: CodewikiCoordinatedResult | null;
	try {
		reconciled = await coordinateCodewikiWrite(cwd, (current, workspace) => ({
			kind: "ensure",
			cwd: workspace,
			current,
			...(current ? { language: current.language } : {}),
			previous: null,
		}));
	} catch (error) {
		process.stderr.write(
			`clio-coder context map: index refresh failed: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		return 1;
	}
	if (!reconciled) {
		process.stderr.write("clio-coder context map: could not build a repository index\n");
		return 1;
	}
	// Exactly what this command writes into the workspace: the index (canonical
	// or the legacy file it may still be reconciling), this run's HTML, and the
	// fixed default HTML an earlier run without --out left behind.
	const facts = repositoryFacts(cwd, reconciled.codewiki, reconciled.worker.fingerprint.gitHead, [
		codemapPath(cwd),
		legacyCodewikiPath(cwd),
		target,
		defaultRepoMapPath(cwd),
	]);
	const map = buildRepoMap(reconciled.codewiki, path.basename(cwd));

	const html = renderRepoMap(map, facts);
	try {
		await withFileMutationQueue(target, () => publishFileAtomically(target, html));
	} catch (error) {
		process.stderr.write(`clio-coder context map: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
	const payload = {
		path: target,
		format: "html",
		areas: map.areas.length,
		relationships: map.relationships.length,
		files: map.fileCount,
		bytes: Buffer.byteLength(html),
		sha256: createHash("sha256").update(html).digest("hex"),
		repository:
			facts.repository && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(facts.repository.url) ? facts.repository : null,
		index: "reconciled",
		sourceState: facts.sourceState,
	};
	process.stdout.write(
		json
			? `${JSON.stringify(payload, null, 2)}\n`
			: `clio-coder context map wrote ${target}\n  ${payload.files} files, ${payload.areas} areas, ${payload.relationships} import relationships\n  Open the HTML in a browser, or use /skill map-codebase for Clio's guided explanation.\n`,
	);
	return 0;
}

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CLIO_ARTIFACT_DIR } from "../core/artifact-paths.js";
import { type CodewikiCoordinatedResult, coordinateCodewikiWrite } from "../domains/context/codewiki/coordinator.js";
import type { Codewiki } from "../domains/context/codewiki/schema.js";
import { buildArchitectureSeed, serializeArchitectureSeed } from "../domains/context/wiki/map-seed.js";

const HELP = `Usage:
  clio-coder context map [--out <path>] [--json]

Write an archify architecture seed for the current repository from the codewiki
index, without model calls. The seed is the starting spec for the archify skill:
components are the largest directory areas, connections are collapsed import
edges. The index is reconciled with current files before mapping; sources are
pinned only when clean Git evidence matches those files.

Options:
  --out <path>    where to write the seed (default: ${CLIO_ARTIFACT_DIR}/maps/<repo>.architecture.json)
  --json          print machine-readable details about the written seed
`;

/** Where the seed lands when the operator names no path: a human-transient map artifact. */
function defaultMapSeedPath(cwd: string): string {
	return path.join(cwd, CLIO_ARTIFACT_DIR, "maps", `${path.basename(cwd)}.architecture.json`);
}

function gitValue(cwd: string, args: string[]): string | null {
	try {
		const out = execFileSync("git", args, { cwd, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] })
			.toString("utf8")
			.trim();
		return out;
	} catch {
		return null;
	}
}

type SourceState = "clean" | "dirty" | "unknown";

/** A successful empty status means clean; unavailable Git evidence never does. */
function repositoryFacts(
	cwd: string,
	codewiki: Codewiki,
	indexedHead: string | null,
): { sourceState: SourceState; repository?: { url: string; revision: string } } {
	const revision = gitValue(cwd, ["rev-parse", "--verify", "HEAD"]);
	const status = gitValue(cwd, ["status", "--porcelain", "--untracked-files=normal"]);
	if (!revision || status === null) return { sourceState: "unknown" };
	if (status !== "" || revision !== indexedHead) return { sourceState: "dirty" };
	// Source paths in the seed are workspace-relative. A nested workspace has
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
	let reconciled: CodewikiCoordinatedResult | null;
	try {
		reconciled = await coordinateCodewikiWrite(
			cwd,
			(current, workspace) =>
				current
					? {
							kind: "ensure",
							cwd: workspace,
							current,
							language: current.language,
							// Map evidence must reconcile actual inputs, even if a state file
							// happens to carry a matching fingerprint from another operation.
							previous: null,
						}
					: null,
			{ requireExisting: true },
		);
	} catch (error) {
		process.stderr.write(
			`clio-coder context map: index refresh failed: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		return 1;
	}
	if (!reconciled) {
		process.stderr.write(
			"clio-coder context map: no codewiki index in .clio-coder/codewiki.json; run `clio-coder context index` first\n",
		);
		return 1;
	}
	const facts = repositoryFacts(cwd, reconciled.codewiki, reconciled.worker.fingerprint.gitHead);
	const seed = buildArchitectureSeed(reconciled.codewiki, {
		title: path.basename(cwd),
		repository: facts.repository,
	});
	const target = out ? path.resolve(cwd, out) : defaultMapSeedPath(cwd);
	mkdirSync(path.dirname(target), { recursive: true });
	writeFileSync(target, serializeArchitectureSeed(seed), "utf8");
	const payload = {
		path: target,
		components: seed.components.length,
		connections: seed.connections.length,
		repository: seed.meta.repository ?? null,
		index: "reconciled",
		sourceState: facts.sourceState,
	};
	if (json) {
		process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
		return 0;
	}
	process.stdout.write(
		[
			`clio-coder context map wrote ${target}`,
			`  ${payload.components} components, ${payload.connections} connections${
				payload.repository
					? `, sources pinned at ${payload.repository.revision.slice(0, 12)}`
					: `; no source citations (source state: ${payload.sourceState}; requires verified clean files and a GitHub origin at a full revision)`
			}`,
			payload.repository
				? "  next: validate and deliver it with the archify skill, passing --repo-root ."
				: "  next: validate and deliver it with the archify skill (without --repo-root)",
			"",
		].join("\n"),
	);
	return 0;
}

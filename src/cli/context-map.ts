import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CLIO_ARTIFACT_DIR } from "../core/artifact-paths.js";
import { readCodewiki } from "../domains/context/codewiki/artifact.js";
import { buildArchitectureSeed, serializeArchitectureSeed } from "../domains/context/wiki/map-seed.js";

const HELP = `Usage:
  clio-coder context map [--out <path>] [--json]

Write an archify architecture seed for the current repository from the codewiki
index, without model calls. The seed is the starting spec for the archify skill:
components are the largest directory areas, connections are collapsed import
edges, and sources point at indexed files and lines.

Options:
  --out <path>    where to write the seed (default: ${CLIO_ARTIFACT_DIR}/maps/<repo>.architecture.json)
  --json          print machine-readable details about the written seed
`;

/** Where the seed lands when the operator names no path: a human-transient map artifact. */
export function defaultMapSeedPath(cwd: string): string {
	return path.join(cwd, CLIO_ARTIFACT_DIR, "maps", `${path.basename(cwd)}.architecture.json`);
}

function gitValue(cwd: string, args: string[]): string | null {
	try {
		const out = execFileSync("git", args, { cwd, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] })
			.toString("utf8")
			.trim();
		return out.length > 0 ? out : null;
	} catch {
		return null;
	}
}

/** The origin remote as an https URL and HEAD as a full sha, when git can say. */
function repositoryFacts(cwd: string): { url: string; revision: string } | undefined {
	const remote = gitValue(cwd, ["remote", "get-url", "origin"]);
	const revision = gitValue(cwd, ["rev-parse", "--verify", "HEAD"]);
	if (!remote || !revision) return undefined;
	let url = remote.endsWith(".git") ? remote.slice(0, -4) : remote;
	const ssh = /^git@([^:]+):(.+)$/.exec(url);
	if (ssh) url = `https://${ssh[1]}/${ssh[2]}`;
	return { url, revision };
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
	const codewiki = readCodewiki(cwd);
	if (!codewiki) {
		process.stderr.write(
			"clio-coder context map: no codewiki index in .clio-coder/codewiki.json; run `clio-coder context index` first\n",
		);
		return 1;
	}
	const seed = buildArchitectureSeed(codewiki, {
		title: path.basename(cwd),
		repository: repositoryFacts(cwd),
	});
	const target = out ? path.resolve(cwd, out) : defaultMapSeedPath(cwd);
	mkdirSync(path.dirname(target), { recursive: true });
	writeFileSync(target, serializeArchitectureSeed(seed), "utf8");
	const payload = {
		path: target,
		components: seed.components.length,
		connections: seed.connections.length,
		repository: seed.meta.repository ?? null,
	};
	if (json) {
		process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
		return 0;
	}
	process.stdout.write(
		[
			`clio-coder context map wrote ${target}`,
			`  ${payload.components} components, ${payload.connections} connections${payload.repository ? `, revision ${payload.repository.revision.slice(0, 12)}` : ", no GitHub revision recorded"}`,
			"  next: validate and deliver it with the archify skill, passing --repo-root .",
			"",
		].join("\n"),
	);
	return 0;
}

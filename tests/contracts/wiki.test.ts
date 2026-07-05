import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Codewiki } from "../../src/domains/context/codewiki/indexer.js";
import {
	buildWikiPrompt,
	computeWikiContentHash,
	listWikiPages,
	readWikiMeta,
	runWikiGenerate,
	validateWikiLayout,
	validateWikiMeta,
	wikiDir,
	wikiMetaPath,
	wikiStaleness,
	writeWikiMeta,
} from "../../src/domains/context/index.js";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TSX_LOADER = join(REPO_ROOT, "node_modules/tsx/dist/loader.mjs");

function runContextHandler(
	cwd: string,
	args: ReadonlyArray<string>,
): { status: number; stdout: string; stderr: string } {
	const moduleUrl = pathToFileURL(join(REPO_ROOT, "src/cli/context.ts")).href;
	const script = [
		`const mod = await import(${JSON.stringify(moduleUrl)});`,
		`const code = await mod.runContextCommand(JSON.parse(process.env.CLIO_TEST_ARGS ?? "[]"));`,
		"process.exitCode = code;",
	].join("\n");
	const child = spawnSync(process.execPath, ["--import", TSX_LOADER, "--eval", script], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, CLIO_TEST_ARGS: JSON.stringify(args) },
	});
	if (child.error) throw child.error;
	return { status: child.status ?? 0, stdout: child.stdout, stderr: child.stderr };
}

function writeProjectFile(cwd: string): void {
	mkdirSync(join(cwd, "src"), { recursive: true });
	writeFileSync(join(cwd, "src", "index.ts"), "export const main = true;\n", "utf8");
}

function writeWikiPage(cwd: string, name: string, text: string): void {
	mkdirSync(wikiDir(cwd), { recursive: true });
	writeFileSync(join(wikiDir(cwd), name), text, "utf8");
}

function git(cwd: string, args: ReadonlyArray<string>): string {
	const child = spawnSync("git", [...args], { cwd, encoding: "utf8" });
	if (child.error) throw child.error;
	if (child.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${child.stderr}`);
	}
	return child.stdout.trim();
}

function initGitRepo(cwd: string): string {
	git(cwd, ["init"]);
	git(cwd, ["config", "user.email", "clio-test@example.com"]);
	git(cwd, ["config", "user.name", "Clio Test"]);
	git(cwd, ["add", "."]);
	git(cwd, ["commit", "-m", "initial"]);
	return git(cwd, ["rev-parse", "--verify", "HEAD"]);
}

function promptCodewiki(): Codewiki {
	return {
		version: 4,
		language: "typescript",
		files: [
			{
				id: "f_index",
				path: "src/index.ts",
				lang: "typescript",
				loc: 1,
				role: "entry",
				hash: "abcd",
				imports: [],
			},
		],
		symbols: [{ name: "main", kind: "const", fileId: "f_index", line: 1 }],
		edges: [],
	};
}

describe("contracts/wiki", () => {
	let scratch: string;
	let originalCwd: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		scratch = mkdtempSync(join(tmpdir(), "clio-wiki-"));
		process.chdir(scratch);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		rmSync(scratch, { recursive: true, force: true });
	});

	it("roundtrips and validates wiki metadata", () => {
		const meta = {
			version: 1 as const,
			updatedAt: "2026-07-04T00:00:00.000Z",
			gitHead: null,
			model: "test-model",
			contentHash: "0".repeat(64),
			pages: [
				{ path: "quickstart.md", title: "Quickstart" },
				{ path: "architecture.md", title: "Architecture" },
			],
		};

		writeWikiMeta(scratch, meta);

		deepStrictEqual(readWikiMeta(scratch), {
			...meta,
			pages: [...meta.pages].sort((a, b) => a.path.localeCompare(b.path)),
		});
		ok(validateWikiMeta(meta).ok);
		const malformed = validateWikiMeta({ ...meta, contentHash: "not-a-hash" });
		strictEqual(malformed.ok, false);
		writeFileSync(wikiMetaPath(scratch), JSON.stringify({ version: 2 }), "utf8");
		strictEqual(readWikiMeta(scratch), null);
	});

	it("validates missing quickstart, page overflow, and empty pages", () => {
		let validation = validateWikiLayout(scratch);
		strictEqual(validation.ok, false);
		if (!validation.ok) ok(validation.problems.some((problem) => problem.includes("quickstart.md")));

		writeWikiPage(scratch, "quickstart.md", "# Quickstart\n");
		for (let i = 1; i <= 8; i += 1) writeWikiPage(scratch, `page-${i}.md`, `# Page ${i}\n`);
		validation = validateWikiLayout(scratch);
		strictEqual(validation.ok, false);
		if (!validation.ok) ok(validation.problems.some((problem) => problem.includes("maximum is 8")));

		rmSync(wikiDir(scratch), { recursive: true, force: true });
		writeWikiPage(scratch, "quickstart.md", "# Quickstart\n");
		writeWikiPage(scratch, "empty.md", " \n");
		validation = validateWikiLayout(scratch);
		strictEqual(validation.ok, false);
		if (!validation.ok) ok(validation.problems.some((problem) => problem.includes("empty.md is empty")));
	});

	it("reports absent, fresh, and stale wiki staleness from git metadata", () => {
		strictEqual(wikiStaleness(scratch).state, "absent");

		writeProjectFile(scratch);
		writeWikiPage(scratch, "quickstart.md", "# Quickstart\n");
		const head = initGitRepo(scratch);
		writeWikiMeta(scratch, {
			version: 1,
			updatedAt: "2026-07-04T00:00:00.000Z",
			gitHead: head,
			model: "test-model",
			contentHash: "0".repeat(64),
			pages: listWikiPages(scratch),
		});

		deepStrictEqual(wikiStaleness(scratch), { state: "fresh" });

		writeFileSync(join(scratch, "src", "extra.ts"), "export const extra = true;\n", "utf8");
		git(scratch, ["add", "src/extra.ts"]);
		git(scratch, ["commit", "-m", "add extra"]);
		const stale = wikiStaleness(scratch);
		strictEqual(stale.state, "stale");
		if (stale.state === "stale") ok(stale.changedFiles >= 1);
	});

	it("degrades git-less wiki staleness checks to fresh with a warning", () => {
		writeWikiPage(scratch, "quickstart.md", "# Quickstart\n");
		writeWikiMeta(scratch, {
			version: 1,
			updatedAt: "2026-07-04T00:00:00.000Z",
			gitHead: "abc123",
			model: "test-model",
			contentHash: "0".repeat(64),
			pages: listWikiPages(scratch),
		});

		const staleness = wikiStaleness(scratch);
		strictEqual(staleness.state, "fresh");
		match(staleness.warning ?? "", /current git HEAD is missing/);
	});

	it("generates pages with a fake callback and preserves metadata on noop", async () => {
		writeProjectFile(scratch);
		const modes: string[] = [];
		const cannedGenerate = async (input: { cwd: string; mode: "init" | "update"; prompt: string }): Promise<void> => {
			modes.push(input.mode);
			ok(input.prompt.includes("## Codewiki digest"));
			writeWikiPage(
				input.cwd,
				"quickstart.md",
				"# Quickstart\n\nThis project exposes `src/index.ts`.\n\n- [Architecture](architecture.md): Runtime map.\n",
			);
			writeWikiPage(input.cwd, "architecture.md", "# Architecture\n\nThe entry point is `src/index.ts:1`.\n");
		};

		const first = await runWikiGenerate({ cwd: scratch, model: "test-model", generate: cannedGenerate });

		strictEqual(first.status, "generated");
		strictEqual(first.pages, 2);
		const meta = readWikiMeta(scratch);
		ok(meta);
		strictEqual(meta.model, "test-model");
		strictEqual(meta.contentHash, computeWikiContentHash(scratch));
		deepStrictEqual(
			meta.pages.map((page) => page.path),
			["architecture.md", "quickstart.md"],
		);
		const rawMeta = readFileSync(wikiMetaPath(scratch), "utf8");
		const updatedAt = meta.updatedAt;

		await new Promise((resolve) => setTimeout(resolve, 5));
		const second = await runWikiGenerate({ cwd: scratch, model: "test-model", generate: cannedGenerate });

		strictEqual(second.status, "noop");
		strictEqual(second.pages, 2);
		strictEqual(readFileSync(wikiMetaPath(scratch), "utf8"), rawMeta);
		strictEqual(readWikiMeta(scratch)?.updatedAt, updatedAt);
		deepStrictEqual(modes, ["init", "update"]);
	});

	it("writes valid metadata for an existing wiki when a no-op generator leaves content unchanged", async () => {
		writeProjectFile(scratch);
		writeWikiPage(scratch, "quickstart.md", "# Quickstart\n\nExisting wiki page.\n");
		const contentHash = computeWikiContentHash(scratch);

		const result = await runWikiGenerate({
			cwd: scratch,
			model: "test-model",
			generate: () => {
				// The generator intentionally leaves the existing page untouched.
			},
		});

		strictEqual(result.status, "generated");
		strictEqual(result.pages, 1);
		const meta = readWikiMeta(scratch);
		ok(meta);
		strictEqual(meta.model, "test-model");
		strictEqual(meta.contentHash, contentHash);
		deepStrictEqual(meta.pages, [{ path: "quickstart.md", title: "Quickstart" }]);
	});

	it("returns validation failures without writing metadata", async () => {
		writeProjectFile(scratch);

		const result = await runWikiGenerate({
			cwd: scratch,
			model: "test-model",
			generate: (input) => {
				writeWikiPage(input.cwd, "notes.md", "# Notes\n");
			},
		});

		strictEqual(result.status, "failed");
		ok(result.problems?.some((problem) => problem.includes("quickstart.md")));
		strictEqual(existsSync(wikiMetaPath(scratch)), false);
	});

	it("returns a structured failure when no model runtime is injected", async () => {
		writeProjectFile(scratch);

		const result = await runWikiGenerate({ cwd: scratch, model: "test-model" });

		strictEqual(result.status, "failed");
		ok(result.problems?.some((problem) => /model runtime/i.test(problem)));
		strictEqual(existsSync(wikiMetaPath(scratch)), false);
	});

	it("composes init and update prompts from fragments, digest, and git evidence", () => {
		const initPrompt = buildWikiPrompt({ cwd: scratch, mode: "init", codewiki: promptCodewiki() });
		ok(initPrompt.includes("## Codewiki digest"));
		ok(initPrompt.includes("Structure requirements:"));
		ok(initPrompt.includes("src/index.ts"));

		const updatePrompt = buildWikiPrompt({
			cwd: scratch,
			mode: "update",
			codewiki: promptCodewiki(),
			gitHead: "0000000000000000000000000000000000000000",
		});
		ok(updatePrompt.includes("## Git evidence"));
		ok(updatePrompt.includes("Git evidence unavailable") || updatePrompt.includes("Git evidence is empty"));
	});

	it("prints CLI wiki status with and without metadata", async () => {
		let captured = runContextHandler(scratch, ["wiki", "--status"]);
		strictEqual(captured.status, 0);
		strictEqual(captured.stderr, "");
		match(captured.stdout, /^wiki: absent \(0 pages\)$/m);

		writeWikiPage(scratch, "quickstart.md", "# Quickstart\n");
		writeWikiMeta(scratch, {
			version: 1,
			updatedAt: "2026-07-04T00:00:00.000Z",
			gitHead: "abc123",
			model: "test-model",
			contentHash: "1".repeat(64),
			pages: listWikiPages(scratch),
		});

		captured = runContextHandler(scratch, ["wiki", "--status"]);
		strictEqual(captured.status, 0);
		strictEqual(captured.stderr, "");
		match(captured.stdout, /^wiki: present \(1 page\)$/m);
		match(captured.stdout, /^updatedAt: 2026-07-04T00:00:00\.000Z$/m);
		match(captured.stdout, /^gitHead: abc123$/m);
		match(captured.stdout, /^staleness: gitHead differs from current HEAD \(none\)$/m);
	});
});

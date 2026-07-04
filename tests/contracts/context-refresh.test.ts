import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { BusChannels, type ContextActivityPayload } from "../../src/core/bus-events.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus, type SafeEventBus } from "../../src/core/event-bus.js";
import { createContextBundle } from "../../src/domains/context/extension.js";
import {
	computeFingerprint,
	listWikiPages,
	renderPromptContext,
	runContextRefresh,
	serializeClioMd,
	wikiDir,
	writeWikiMeta,
} from "../../src/domains/context/index.js";
import { readClioState } from "../../src/domains/context/state.js";

const scratchRoots: string[] = [];

afterEach(() => {
	for (const root of scratchRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function scratchProject(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-refresh-"));
	scratchRoots.push(root);
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "refresh-fixture", type: "module" }), "utf8");
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "index.ts"), "export const refreshFixtureSymbol = true;\n", "utf8");
	return root;
}

function writeFixtureClioMd(cwd: string): string {
	const text = serializeClioMd({
		projectName: "Refresh Fixture",
		identity: "Refresh Fixture is a TypeScript project used to test context refresh.",
		conventions: ["Keep prose byte-stable across refresh."],
		invariants: ["Refresh never edits prose."],
		fingerprint: {
			initAt: "2026-05-01T00:00:00.000Z",
			model: "test-model",
			gitHead: null,
			treeHash: "0".repeat(64),
			loc: 1,
		},
	});
	writeFileSync(join(cwd, "CLIO.md"), text, "utf8");
	return text;
}

function git(cwd: string, args: ReadonlyArray<string>): string {
	const child = spawnSync("git", [...args], { cwd, encoding: "utf8" });
	if (child.error) throw child.error;
	if (child.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${child.stderr}`);
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

function writeWikiFixture(cwd: string, gitHead: string | null): void {
	mkdirSync(wikiDir(cwd), { recursive: true });
	writeFileSync(join(wikiDir(cwd), "quickstart.md"), "# Quickstart\n\nStart with `src/index.ts`.\n", "utf8");
	writeWikiMeta(cwd, {
		version: 1,
		updatedAt: "2026-07-04T00:00:00.000Z",
		gitHead,
		model: "test-model",
		contentHash: "0".repeat(64),
		pages: listWikiPages(cwd),
	});
}

function context(events: ContextActivityPayload[]): DomainContext {
	const bus: SafeEventBus = createSafeEventBus();
	bus.on(BusChannels.ContextActivity, (event) => {
		events.push(event);
	});
	return {
		bus,
		getContract: () => undefined,
	};
}

describe("contracts/context-refresh", () => {
	it("rebuilds the codewiki and state without changing CLIO.md bytes", async () => {
		const cwd = scratchProject();
		const before = writeFixtureClioMd(cwd);
		let stdout = "";

		const result = await runContextRefresh({
			cwd,
			now: () => new Date("2026-07-02T00:00:00.000Z"),
			io: { stdout: (s) => (stdout += s), stderr: () => undefined },
		});
		strictEqual(result.action, "refreshed");
		ok(result.codewikiEntries >= 1, "codewiki indexed at least the fixture source file");
		strictEqual("clioMdRestamped" in result, false);
		strictEqual(
			stdout,
			`clio context refresh: codewiki rebuilt (${result.codewikiEntries} source file${result.codewikiEntries === 1 ? "" : "s"})\n`,
		);

		const after = readFileSync(join(cwd, "CLIO.md"), "utf8");
		strictEqual(after, before);

		ok(existsSync(join(cwd, ".clio", "codewiki.json")), "codewiki.json written");
		const state = readClioState(cwd);
		strictEqual(state?.fingerprint.treeHash, computeFingerprint(cwd).treeHash);
	});

	it("emits context-refresh activity through the context contract", async () => {
		const cwd = scratchProject();
		const events: ContextActivityPayload[] = [];
		const bundle = createContextBundle(context(events));

		const result = await bundle.contract.runContextRefresh({ cwd });

		strictEqual(result.action, "refreshed");
		deepStrictEqual(
			events.map((event) => event.kind),
			["context-refresh", "context-refresh", "context-refresh"],
		);
		deepStrictEqual(
			events.map((event) => event.phase),
			["codewiki", "state", "done"],
		);
		deepStrictEqual(
			events.map((event) => event.status),
			["started", "running", "completed"],
		);
	});

	it("emits a failed context-refresh activity when refresh throws", async () => {
		const cwd = scratchProject();
		writeFileSync(join(cwd, ".clio"), "not a directory\n", "utf8");
		const events: ContextActivityPayload[] = [];
		const bundle = createContextBundle(context(events));

		await rejects(() => bundle.contract.runContextRefresh({ cwd }));

		const last = events.at(-1);
		strictEqual(last?.kind, "context-refresh");
		strictEqual(last?.phase, "done");
		strictEqual(last?.status, "failed");
		strictEqual(last?.message, "context refresh failed");
	});

	it("clears the stale codewiki marker in the rendered project context", async () => {
		const cwd = scratchProject();
		writeFixtureClioMd(cwd);
		await runContextRefresh({ cwd });

		// Drift the tree, then confirm the marker points at /context refresh.
		writeFileSync(join(cwd, "src", "extra.ts"), "export const extra = 1;\n", "utf8");
		const stale = renderPromptContext(cwd);
		ok(stale.text.includes("(stale; run /context refresh)"));

		await runContextRefresh({ cwd });
		const fresh = renderPromptContext(cwd);
		strictEqual(fresh.text.includes("(stale;"), false);
		ok(fresh.text.includes("<codewiki>available; use code_nav</codewiki>"));
	});

	it("refreshes without CLIO.md and leaves CLIO.md absent", async () => {
		const cwd = scratchProject();
		const result = await runContextRefresh({ cwd });
		strictEqual("clioMdRestamped" in result, false);
		ok(existsSync(join(cwd, ".clio", "codewiki.json")));
		strictEqual(existsSync(join(cwd, "CLIO.md")), false);
	});

	it("updates the wiki after the L1 rebuild only when wiki is explicitly true", async () => {
		const cwd = scratchProject();
		writeWikiFixture(cwd, null);
		let called = 0;
		let sawRebuiltCodewiki = false;

		const result = await runContextRefresh({
			cwd,
			wiki: true,
			wikiGenerate: (input) => {
				called += 1;
				strictEqual(input.mode, "update");
				sawRebuiltCodewiki = existsSync(join(input.cwd, ".clio", "codewiki.json"));
			},
		});

		strictEqual(called, 1);
		strictEqual(sawRebuiltCodewiki, true);
		strictEqual(result.wiki?.status, "noop");
		strictEqual(result.wiki?.pages, 1);
		strictEqual(result.hint, undefined);
	});

	it("returns a stale wiki hint on ordinary refresh without calling the wiki generator", async () => {
		const cwd = scratchProject();
		const head = initGitRepo(cwd);
		writeWikiFixture(cwd, head);
		writeFileSync(join(cwd, "src", "extra.ts"), "export const extra = true;\n", "utf8");
		git(cwd, ["add", "src/extra.ts"]);
		git(cwd, ["commit", "-m", "add extra"]);
		let called = 0;

		const result = await runContextRefresh({
			cwd,
			wiki: false,
			wikiGenerate: () => {
				called += 1;
			},
		});

		strictEqual(called, 0);
		strictEqual(result.wiki, undefined);
		strictEqual(result.hint, "wiki is stale; run clio context refresh --wiki or clio context wiki --update");
	});

	it("does not run or hint wiki refresh when no wiki exists", async () => {
		const cwd = scratchProject();
		let called = 0;

		const result = await runContextRefresh({
			cwd,
			wiki: true,
			wikiGenerate: () => {
				called += 1;
			},
		});

		strictEqual(called, 0);
		strictEqual(result.wiki, undefined);
		strictEqual(result.hint, undefined);
	});
});

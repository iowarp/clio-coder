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
	readWikiMeta,
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
	writeFileSync(join(cwd, "CLIO-CODER.md"), text, "utf8");
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

/** A promoted wiki that finished 12 of its 32 planned pages and is not stale. */
function writePartialWikiFixture(cwd: string): void {
	writeWikiFixture(cwd, null);
	const meta = readWikiMeta(cwd);
	ok(meta);
	writeWikiMeta(cwd, {
		...meta,
		generation: {
			requestedDepth: "detailed",
			depth: "detailed",
			sourceFiles: 1,
			sourceLines: 1,
			pagesPlanned: 32,
			pagesWritten: 12,
		},
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
	it("rebuilds the codewiki and state without changing CLIO-CODER.md bytes", async () => {
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
			`clio-coder context refresh: codewiki rebuilt (${result.codewikiEntries} source file${result.codewikiEntries === 1 ? "" : "s"})\n`,
		);

		const after = readFileSync(join(cwd, "CLIO-CODER.md"), "utf8");
		strictEqual(after, before);

		ok(existsSync(join(cwd, ".clio-coder", "codewiki.json")), "codewiki.json written");
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
		writeFileSync(join(cwd, ".clio-coder"), "not a directory\n", "utf8");
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

	it("refreshes without CLIO-CODER.md and leaves CLIO-CODER.md absent", async () => {
		const cwd = scratchProject();
		const result = await runContextRefresh({ cwd });
		strictEqual("clioMdRestamped" in result, false);
		strictEqual(result.clioMd, "absent");
		ok(existsSync(join(cwd, ".clio-coder", "codewiki.json")));
		strictEqual(existsSync(join(cwd, "CLIO-CODER.md")), false);
	});

	/**
	 * The index-owned sections state file counts, entry points and where the mass
	 * of the tree sits. Those are the only handbook facts nothing but the index can
	 * author, and the only ones that are wrong the moment a file moves. Refresh
	 * rebuilds the index anyway, so leaving them stale was leaving the handbook
	 * confidently wrong about the repository it had just re-read.
	 */
	it("re-derives the index-owned handbook sections against the rebuilt codewiki", async () => {
		const cwd = scratchProject();
		writeFileSync(
			join(cwd, "CLIO-CODER.md"),
			serializeClioMd({
				projectName: "Refresh Fixture",
				identity: "Refresh Fixture is a TypeScript project used to test context refresh.",
				conventions: ["Keep prose byte-stable across refresh."],
				invariants: ["Refresh never edits prose."],
				sections: [
					{ title: "Context retrieval", body: "The codewiki currently indexes 4096 source files." },
					{ title: "Architecture", body: "`src/index.ts` is the only module a change travels through." },
				],
			}),
			"utf8",
		);

		const result = await runContextRefresh({ cwd });

		strictEqual(result.clioMd, "updated");
		const after = readFileSync(join(cwd, "CLIO-CODER.md"), "utf8");
		strictEqual(after.includes("4096 source files"), false, after);
		ok(after.includes(`indexes ${result.codewikiEntries} source file`), after);
		// Sections the index does not author survive untouched, prose and all.
		ok(after.includes("`src/index.ts` is the only module a change travels through."), after);
		ok(after.includes("Keep prose byte-stable across refresh."), after);
	});

	/**
	 * Curation replaces; it never grows. A handbook that never asked for an
	 * index-owned section does not get handed one on a routine refresh.
	 */
	it("leaves a handbook without index-owned sections byte-identical", async () => {
		const cwd = scratchProject();
		const before = writeFixtureClioMd(cwd);

		const result = await runContextRefresh({ cwd });

		strictEqual(result.clioMd, "unchanged");
		strictEqual(readFileSync(join(cwd, "CLIO-CODER.md"), "utf8"), before);
	});

	/**
	 * A malformed handbook is the same as no handbook: nothing in this repository
	 * may require CLIO-CODER.md to exist or to parse, least of all the command whose job
	 * is to keep the index healthy.
	 */
	it("refreshes past a malformed CLIO-CODER.md without failing", async () => {
		const cwd = scratchProject();
		writeFileSync(join(cwd, "CLIO-CODER.md"), "no heading here, just prose\n", "utf8");

		const result = await runContextRefresh({ cwd });

		strictEqual(result.action, "refreshed");
		strictEqual(result.clioMd, "absent");
		strictEqual(readFileSync(join(cwd, "CLIO-CODER.md"), "utf8"), "no heading here, just prose\n");
		ok(existsSync(join(cwd, ".clio-coder", "codewiki.json")));
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
				sawRebuiltCodewiki = existsSync(join(input.cwd, ".clio-coder", "codewiki.json"));
			},
		});

		strictEqual(called, 1);
		strictEqual(sawRebuiltCodewiki, true);
		// The fixture is a hand-authored page with no front matter. The assembly
		// pass normalizes it and generates the navigation, so the first run over
		// such a wiki is a real change even though the generator wrote nothing.
		strictEqual(result.wiki?.status, "generated");
		strictEqual(result.wiki?.pages, 1);
		strictEqual(result.hint, undefined);

		// Assembly is idempotent: once normalized, a generator that writes nothing
		// produces a byte-identical tree and the run is a no-op.
		const second = await runContextRefresh({ cwd, wiki: true, wikiGenerate: () => undefined });
		strictEqual(second.wiki?.status, "noop");
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
		strictEqual(result.hint, "wiki is stale; run clio-coder context refresh --wiki or clio-coder context wiki --update");
	});

	// --wiki with no wiki on disk used to return silently, so the operator saw a
	// bare "codewiki rebuilt" line and no sign that the request had been dropped.
	it("says so instead of silently dropping --wiki when no wiki exists", async () => {
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
		strictEqual(result.hint, "no wiki exists, so --wiki had nothing to update; run clio-coder context wiki to build one");
	});

	// A page is the unit of work, so a run that loses pages to a deadline still
	// promotes what it finished. That wiki is current with the tree and therefore
	// never "stale", which used to mean an ordinary refresh said nothing at all
	// about the 20 pages it still owed.
	it("hints that a partial wiki owes pages even when it is not stale", async () => {
		const cwd = scratchProject();
		writePartialWikiFixture(cwd);

		const result = await runContextRefresh({ cwd, wiki: false });

		strictEqual(result.wiki, undefined);
		strictEqual(
			result.hint,
			"wiki is incomplete: 12 of 32 planned pages written, 20 owed; run clio-coder context wiki --update to resume",
		);
	});

	it("advertises a partial wiki to the model as partial", () => {
		const cwd = scratchProject();
		writePartialWikiFixture(cwd);

		const rendered = renderPromptContext(cwd);
		ok(rendered.text.includes("incomplete: 12 of 32 planned pages written, 20 owed"), rendered.text);
	});

	it("leaves a complete wiki unqualified", async () => {
		const cwd = scratchProject();
		writeWikiFixture(cwd, null);

		const result = await runContextRefresh({ cwd, wiki: false });

		strictEqual(result.hint, undefined);
		strictEqual(renderPromptContext(cwd).text.includes("incomplete"), false);
	});
});

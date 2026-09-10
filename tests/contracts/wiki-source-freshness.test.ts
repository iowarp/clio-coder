import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { computeFingerprint } from "../../src/domains/context/fingerprint.js";
import { runWikiGenerate, type WikiGenerate } from "../../src/domains/context/wiki/generate.js";
import { readWikiMeta, writeWikiMeta } from "../../src/domains/context/wiki/meta.js";
import { writeWikiPlanFile } from "../../src/domains/context/wiki/plan-store.js";
import { changedPathsSince, wikiStaleness, wikiStalenessAsync } from "../../src/domains/context/wiki/staleness.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

describe("wiki source freshness without a usable Git comparison", () => {
	let isolated: IsolatedClioEnv;
	let cwd: string;
	beforeEach(async () => {
		isolated = await isolateClioEnv("clio-coder-wiki-source-freshness-");
		cwd = join(isolated.dir, "repo");
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, ".gitignore"), ".clio-coder/\n");
		writeFileSync(join(cwd, "package.json"), "{}\n");
		for (const name of ["a", "b"]) writeFileSync(join(cwd, "src", `${name}.ts`), `export const ${name} = 1;\n`);
		git("init", "-q");
		git("add", ".");
		git("-c", "user.name=Fixture", "-c", "user.email=fixture@local", "commit", "-qm", "initial");
	});
	afterEach(() => isolated.restore());
	function git(...args: string[]) {
		return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	}
	function run(generate: WikiGenerate) {
		return runWikiGenerate({ cwd, model: "source-contract", generate });
	}
	async function initialize() {
		const result = await run((input) => {
			const pages = ["a", "b"].map((name) => ({
				path: `${name}.md`,
				title: name.toUpperCase(),
				intent: `Document ${name}`,
				sources: [`src/${name}.ts`],
				status: "written" as const,
				attempts: 1,
			}));
			for (const page of pages) {
				writeFileSync(
					join(input.outputDir, page.path),
					`---\ntitle: ${page.title}\nsources:\n  - ${page.sources[0]}\n---\n# ${page.title}\n\nOriginal prose.\n`,
				);
			}
			writeWikiPlanFile(input.outputDir, { version: 1, overview: "Fixture project", pages });
		});
		assert.equal(result.status, "generated");
		assert.equal(result.pending, 0);
	}
	function changeSource() {
		// Different size makes the fingerprint change independent of timestamp resolution.
		writeFileSync(join(cwd, "src/a.ts"), "export const a = 222;\n");
	}
	function changeRecordedHead(gitHead: string | null) {
		const meta = readWikiMeta(cwd);
		assert.ok(meta);
		writeWikiMeta(cwd, { ...meta, gitHead });
	}
	async function assertVerdict(state: "fresh" | "stale") {
		const sync = wikiStaleness(cwd);
		assert.deepEqual(await wikiStalenessAsync(cwd), sync);
		assert.equal(sync.state, state);
		return sync;
	}
	it("does not certify matching source bytes and HEAD when Git diff fails", async () => {
		await initialize();
		await assertVerdict("fresh");
		writeFileSync(join(cwd, ".git/index"), "invalid index");
		const verdict = await assertVerdict("stale");
		assert.match(verdict.warning ?? "", /git diff failed/u);
	});
	const failures = [
		{ name: "missing recorded HEAD", apply: () => changeRecordedHead(null), warning: /recorded gitHead is missing/u },
		{
			name: "missing current HEAD",
			apply: () => rmSync(join(cwd, ".git"), { recursive: true }),
			warning: /current git HEAD is missing/u,
		},
		{ name: "unresolvable recorded HEAD", apply: () => changeRecordedHead("0".repeat(40)), warning: /git diff failed/u },
	];
	for (const failure of failures) {
		it(`reports a changed source fingerprint as stale with ${failure.name}`, async () => {
			await initialize();
			failure.apply();
			changeSource();
			assert.notEqual(computeFingerprint(cwd).treeHash, readWikiMeta(cwd)?.sourceTreeHash);
			const verdict = await assertVerdict("stale");
			assert.match(verdict.warning ?? "", failure.warning);
		});
		it(`cannot certify legacy metadata without a source fingerprint and ${failure.name}`, async () => {
			await initialize();
			failure.apply();
			const meta = readWikiMeta(cwd);
			assert.ok(meta);
			const { sourceTreeHash: _sourceTreeHash, ...legacy } = meta;
			writeWikiMeta(cwd, legacy);
			const verdict = await assertVerdict("stale");
			assert.match(verdict.warning ?? "", failure.warning);
		});
		it(`distinguishes an unavailable path comparison with ${failure.name}`, async () => {
			await initialize();
			failure.apply();
			assert.equal(changedPathsSince(cwd, readWikiMeta(cwd)?.gitHead ?? null), null);
		});
		it(`revalidates changed sources and preserves failed refresh evidence with ${failure.name}`, async () => {
			await initialize();
			failure.apply();
			changeSource();
			const before = readWikiMeta(cwd);
			const prose = readFileSync(join(cwd, ".clio-coder/wiki/a.md"), "utf8");
			const failed = await run((input) => {
				assert.deepEqual(
					input.plan.pages.map((page) => page.status),
					["pending", "pending"],
				);
				assert.deepEqual(
					input.plan.pages.map((page) => page.attempts),
					[0, 0],
				);
				writeWikiPlanFile(input.outputDir, {
					...input.plan,
					pages: input.plan.pages.map((page) => ({ ...page, attempts: page.attempts + 1 })),
				});
			});
			assert.equal(failed.status, "noop");
			assert.equal(failed.pending, 2);
			assert.equal(readWikiMeta(cwd)?.sourceTreeHash, before?.sourceTreeHash);
			assert.equal(readFileSync(join(cwd, ".clio-coder/wiki/a.md"), "utf8"), prose);
			await assertVerdict("stale");
			const recovered = await run((input) => {
				assert.deepEqual(
					input.plan.pages.map((page) => page.status),
					["pending", "pending"],
				);
				assert.deepEqual(
					input.plan.pages.map((page) => page.attempts),
					[1, 1],
				);
				writeWikiPlanFile(input.outputDir, {
					...input.plan,
					pages: input.plan.pages.map((page) => ({ ...page, status: "written", attempts: page.attempts + 1 })),
				});
			});
			assert.equal(recovered.status, "noop");
			assert.equal(recovered.pending, 0);
			assert.equal(readWikiMeta(cwd)?.sourceTreeHash, computeFingerprint(cwd).treeHash);
			assert.equal(readWikiMeta(cwd)?.updatedAt, before?.updatedAt);
			await assertVerdict(failure.name === "missing current HEAD" ? "stale" : "fresh");
		});
		it(`requires revalidation of matching covered sources with ${failure.name}`, async () => {
			await initialize();
			failure.apply();
			const before = readWikiMeta(cwd);
			const verdict = await assertVerdict("stale");
			assert.match(verdict.warning ?? "", failure.warning);
			const result = await run((input) => {
				assert.deepEqual(
					input.plan.pages.map((page) => page.status),
					["pending", "pending"],
				);
			});
			assert.equal(result.status, "noop");
			assert.equal(result.pending, 2);
			assert.equal(readWikiMeta(cwd)?.contentHash, before?.contentHash);
			assert.equal(readWikiMeta(cwd)?.updatedAt, before?.updatedAt);
		});
	}
	it("revalidates a dirty-source publication after rollback even when Git confirms no changed paths", async () => {
		changeSource();
		await initialize();
		git("checkout", "--", "src/a.ts");
		const before = readWikiMeta(cwd);
		assert.deepEqual(changedPathsSince(cwd, before?.gitHead ?? null), []);
		assert.notEqual(computeFingerprint(cwd).treeHash, before?.sourceTreeHash);
		await assertVerdict("stale");
		const result = await run((input) => {
			assert.deepEqual(
				input.plan.pages.map((page) => page.status),
				["pending", "written"],
			);
			writeWikiPlanFile(input.outputDir, {
				...input.plan,
				pages: input.plan.pages.map((page) => ({ ...page, status: "written", attempts: 1 })),
			});
		});
		assert.equal(result.status, "noop");
		assert.equal(result.pending, 0);
		assert.equal(readWikiMeta(cwd)?.sourceTreeHash, computeFingerprint(cwd).treeHash);
		await assertVerdict("fresh");
	});
});

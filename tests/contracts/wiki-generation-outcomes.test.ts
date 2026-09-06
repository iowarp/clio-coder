import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { modelWikiGenerate } from "../../src/cli/wiki-generate.js";
import { runWikiGenerate } from "../../src/domains/context/wiki/generate.js";
import { readWikiMeta } from "../../src/domains/context/wiki/meta.js";
import type { WikiPlan, WikiPlanPage } from "../../src/domains/context/wiki/plan.js";
import { readWikiPlanFile, writeWikiPlanFile } from "../../src/domains/context/wiki/plan-store.js";
import { wikiCompleteness, wikiStaleness, wikiStalenessAsync } from "../../src/domains/context/wiki/staleness.js";
import type { DispatchContract } from "../../src/domains/dispatch/contract.js";
import type { JobSpec } from "../../src/domains/dispatch/validation.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

const page = (name: string): WikiPlanPage => ({
	path: `${name}.md`,
	title: name.toUpperCase(),
	intent: `Document ${name}`,
	sources: [`src/${name}.ts`],
	status: "pending",
	attempts: 0,
});
const content = (name: string, version: number) =>
	`---\ntitle: ${name.toUpperCase()}\nsources:\n  - src/${name}.ts\n---\n# ${name.toUpperCase()}\n\n${name} version ${version}.\n`;
function generator(action: (spec: JobSpec, path: string | undefined) => number | undefined) {
	let sequence = 0;
	const dispatch = {
		abort() {},
		async dispatch(spec: JobSpec) {
			const path = /Write the file `([^`]+)` and nothing else\./u.exec(spec.task)?.[1];
			const exitCode = action(spec, path) ?? 0;
			return {
				runId: `fixture-${++sequence}`,
				events: (async function* () {})(),
				finalPromise: Promise.resolve({ exitCode }),
			};
		},
	} as unknown as DispatchContract;
	return modelWikiGenerate({ dispatch });
}

describe("wiki generation outcomes", () => {
	let isolated: IsolatedClioEnv;
	let cwd: string;
	beforeEach(async () => {
		isolated = await isolateClioEnv("clio-wiki-outcomes-");
		cwd = join(isolated.dir, "repo");
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, ".gitignore"), ".clio-coder/\n");
		writeFileSync(join(cwd, "package.json"), "{}\n");
		for (const name of ["a", "b", "extra"]) writeFileSync(join(cwd, "src", `${name}.ts`), `export const ${name} = 1;\n`);
		git("init", "-q");
		git("add", ".");
		git("-c", "user.name=Fixture", "-c", "user.email=fixture@local", "commit", "-qm", "initial");
	});
	afterEach(() => isolated.restore());
	function git(...args: string[]) {
		return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	}
	function run(generate: ReturnType<typeof generator>) {
		return runWikiGenerate({ cwd, model: "fixture", generate });
	}
	async function initialize() {
		const plan: WikiPlan = { version: 1, overview: "Fixture project", pages: [page("a"), page("b")] };
		const result = await run(
			generator((spec, path) => {
				if (!path) writeWikiPlanFile(spec.writeRoots?.[0] as string, plan);
				else writeFileSync(path, content(path.endsWith("a.md") ? "a" : "b", 1));
			}),
		);
		assert.equal(result.pending, 0);
	}
	it("keeps a failed seeded refresh pending while publishing another completed page", async () => {
		await initialize();
		for (const name of ["a", "b"]) writeFileSync(join(cwd, "src", `${name}.ts`), `export const ${name} = 2;\n`);
		const attempted: string[] = [];
		const result = await run(
			generator((_spec, path) => {
				if (!path) return;
				attempted.push(path.endsWith("a.md") ? "a" : "b");
				if (path.endsWith("a.md")) return 1;
				writeFileSync(path, content("b", 2));
			}),
		);
		assert.deepEqual(attempted, ["a", "b"]);
		assert.equal(result.pending, 1);
		assert.equal(readWikiMeta(cwd)?.plan?.pages[0]?.status, "pending");
		assert.equal(wikiCompleteness(cwd)?.owed, 1);
		assert.equal(wikiStaleness(cwd).state, "stale");
		assert.equal((await wikiStalenessAsync(cwd)).state, "stale");
		assert.match(readFileSync(join(cwd, ".clio-coder/wiki/a.md"), "utf8"), /a version 1/u);
	});
	it("persists new pending pages and attempts when page content is unchanged", async () => {
		await initialize();
		const before = readWikiMeta(cwd);
		const result = await run(
			generator((spec, path) => {
				if (path) return 1;
				const dir = spec.writeRoots?.[0] as string;
				const plan = readWikiPlanFile(dir);
				assert.ok(plan);
				plan.pages.push(page("extra"));
				writeWikiPlanFile(dir, plan);
			}),
		);
		assert.equal(result.status, "noop");
		assert.equal(result.pending, 1);
		const after = readWikiMeta(cwd);
		assert.equal(after?.plan?.pages.length, 3);
		assert.equal(after?.plan?.pages[2]?.attempts, 1);
		assert.equal(after?.generation?.pagesWritten, 2);
		assert.equal(after?.updatedAt, before?.updatedAt);
		assert.equal(after?.contentHash, before?.contentHash);
		const nextAttempts: string[] = [];
		await run(
			generator((_spec, path) => {
				if (path) {
					nextAttempts.push(path);
					return 1;
				}
			}),
		);
		assert.equal(nextAttempts.length, 1);
		assert.equal(readWikiMeta(cwd)?.plan?.pages[2]?.attempts, 2);
	});
	it("accepts successful unchanged-content validation and reads completed checkpoint progress", async () => {
		await initialize();
		writeFileSync(join(cwd, "src/a.ts"), "export const a = 2;\n");
		let dispatched = 0;
		const result = await run(
			generator((_spec, path) => {
				if (path) dispatched++;
			}),
		);
		assert.equal(dispatched, 1);
		assert.equal(result.status, "noop");
		assert.equal(result.pending, 0);
		assert.equal(readWikiMeta(cwd)?.plan?.pages[0]?.attempts, 1);
		assert.equal(wikiStaleness(cwd).state, "fresh");
	});
});

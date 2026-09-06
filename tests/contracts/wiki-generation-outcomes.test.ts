import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { modelWikiGenerate } from "../../src/cli/wiki-generate.js";
import { runWikiGenerate } from "../../src/domains/context/wiki/generate.js";
import { computeWikiContentHash, readWikiMeta } from "../../src/domains/context/wiki/meta.js";
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
	function crash(step: "backup" | "publish") {
		let signal: string | null | undefined;
		try {
			execFileSync(
				process.execPath,
				["--import", "tsx", fileURLToPath(new URL("../fixtures/wiki/publication-crash.ts", import.meta.url)), cwd, step],
				{
					cwd: process.cwd(),
					env: process.env,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
					timeout: 30_000,
				},
			);
		} catch (error) {
			signal = (error as { signal?: string | null }).signal;
		}
		assert.equal(signal, "SIGKILL");
	}
	async function initialize(citedSources = ["src/a.ts"]) {
		const plan: WikiPlan = { version: 1, overview: "Fixture project", pages: [page("a"), page("b")] };
		const result = await run(
			generator((spec, path) => {
				if (!path) writeWikiPlanFile(spec.writeRoots?.[0] as string, plan);
				else
					writeFileSync(
						path,
						path.endsWith("a.md")
							? content("a", 1).replace("  - src/a.ts", citedSources.map((source) => `  - ${source}`).join("\n"))
							: content("b", 1),
					);
			}),
		);
		assert.equal(result.pending, 0);
	}
	it("tracks README/config bytes, preserved-mtime edits, and mixed dirty rollback", async () => {
		writeFileSync(join(cwd, "README.md"), "before\n");
		writeFileSync(join(cwd, "settings.yaml"), "value: 1\n");
		writeFileSync(join(cwd, "src/a.ts"), "export const a = 2;\n");
		await initialize(["src/a.ts", "README.md", "settings.yaml"]);
		assert.equal(wikiStaleness(cwd).state, "fresh");
		for (const [path, value] of [
			["README.md", "after!\n"],
			["settings.yaml", "value: 2\n"],
		] as const) {
			const before = statSync(join(cwd, path));
			writeFileSync(join(cwd, path), value);
			utimesSync(join(cwd, path), before.atime, before.mtime);
			assert.equal(wikiStaleness(cwd).state, "stale");
			assert.equal((await wikiStalenessAsync(cwd)).state, "stale");
			const attempted: string[] = [];
			await run(
				generator((_spec, output) => {
					if (output) attempted.push(output);
				}),
			);
			assert.equal(attempted.length, 1);
			assert.ok(attempted[0]?.endsWith("a.md"));
			assert.equal(wikiStaleness(cwd).state, "fresh");
		}
		git("checkout", "--", "src/a.ts");
		writeFileSync(join(cwd, "src/b.ts"), "export const b = 2;\n");
		const attempted: string[] = [];
		await run(
			generator((_spec, output) => {
				if (output) attempted.push(output);
			}),
		);
		assert.equal(attempted.length, 2);
	});
	it("requeues source bytes changed during generation and conservatively revalidates legacy evidence", async () => {
		await initialize();
		const result = await run(
			generator((_spec, path) => {
				if (!path) {
					const source = join(cwd, "src/a.ts");
					const before = statSync(source);
					writeFileSync(source, "export const a = 2;\n");
					utimesSync(source, before.atime, before.mtime);
				}
			}),
		);
		assert.equal(result.pending, 1);
		assert.equal(readWikiMeta(cwd)?.plan?.pages[0]?.status, "pending");
		assert.equal(wikiStaleness(cwd).state, "stale");
		await run(generator(() => {}));
		const meta = readWikiMeta(cwd);
		assert.ok(meta?.plan);
		delete meta.plan.sourceContent;
		writeFileSync(join(cwd, ".clio-coder/wiki/meta.json"), JSON.stringify(meta));
		assert.equal(wikiStaleness(cwd).state, "stale");
		const attempted: string[] = [];
		await run(
			generator((_spec, path) => {
				if (path) attempted.push(path);
			}),
		);
		assert.equal(attempted.length, 2);
	});
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
		await run(generator((_spec, path) => (path ? 1 : undefined)));
		const messages: string[] = [];
		const exhausted = await runWikiGenerate({
			cwd,
			model: "fixture",
			generate: generator((_spec, path) => {
				assert.equal(path, undefined, "exhausted pages are not dispatched again");
			}),
			onProgress: (event) => {
				messages.push(event.message);
			},
		});
		assert.equal(exhausted.pending, 1);
		assert.equal(messages.includes("every planned page is already current"), false);
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
	it("revalidates staged completed pages when sources change before resume", async () => {
		await initialize();
		const stopped = await runWikiGenerate({
			cwd,
			model: "fixture",
			generate(input) {
				writeWikiPlanFile(input.outputDir, {
					...input.plan,
					pages: input.plan.pages.map((entry) => ({ ...entry, status: entry.path === "a.md" ? "written" : "pending" })),
				});
				throw new Error("interrupted before B");
			},
		});
		assert.equal(stopped.status, "failed");
		writeFileSync(join(cwd, "src/a.ts"), "export const a = 2;\n");
		const attempted: string[] = [];
		const result = await run(
			generator((_spec, path) => {
				assert.ok(path);
				const name = path.endsWith("a.md") ? "a" : "b";
				attempted.push(name);
				writeFileSync(path, content(name, 2));
			}),
		);
		assert.deepEqual(attempted, ["a", "b"]);
		assert.equal(result.pending, 0);
	});
	it("restores the last publication after SIGKILL between publication renames", async () => {
		await initialize();
		crash("backup");
		assert.equal(existsSync(join(cwd, ".clio-coder/wiki")), false);
		assert.equal(existsSync(join(cwd, ".clio-coder/wiki-prev/b.md")), true);
		const result = await runWikiGenerate({
			cwd,
			model: "fixture",
			generate(input) {
				const plan: WikiPlan = { version: 1, overview: "Fixture project", pages: [page("a"), page("b")] };
				writeWikiPlanFile(input.outputDir, plan);
				writeFileSync(join(input.outputDir, "a.md"), content("a", 3));
			},
		});
		assert.notEqual(result.status, "failed");
		assert.match(readFileSync(join(cwd, ".clio-coder/wiki/b.md"), "utf8"), /b version 1/u);
		assert.ok(readWikiMeta(cwd));
	});
	it("resumes a matching checkpoint without repeating completed dispatches", async () => {
		await initialize();
		await runWikiGenerate({
			cwd,
			model: "fixture",
			generate(input) {
				writeWikiPlanFile(input.outputDir, {
					...input.plan,
					pages: input.plan.pages.map((entry) => ({ ...entry, status: entry.path === "a.md" ? "written" : "pending" })),
				});
				throw new Error("stop before B");
			},
		});
		const attempted: string[] = [];
		await run(
			generator((_spec, path) => {
				assert.ok(path);
				attempted.push(path);
			}),
		);
		assert.equal(attempted.length, 1);
		assert.ok(attempted[0]?.endsWith("b.md"));
	});
	it("revalidates old checkpoints with no source identity", async () => {
		await initialize();
		const dir = join(cwd, ".clio-coder/wiki-staging-legacy");
		mkdirSync(dir);
		writeWikiPlanFile(dir, { version: 1, overview: "Fixture", pages: [{ ...page("a"), status: "written" }, page("b")] });
		writeFileSync(join(dir, "a.md"), content("a", 1));
		const attempted: string[] = [];
		await run(
			generator((_spec, path) => {
				assert.ok(path);
				attempted.push(path);
				writeFileSync(path, content(path.endsWith("a.md") ? "a" : "b", 2));
			}),
		);
		assert.equal(attempted.length, 2);
	});
	it("keeps the complete new pair after SIGKILL following the second rename", async () => {
		await initialize();
		crash("publish");
		assert.equal(existsSync(join(cwd, ".clio-coder/wiki-prev/b.md")), true);
		const published = readWikiMeta(cwd);
		assert.ok(published);
		assert.equal(published.contentHash, computeWikiContentHash(cwd));
		assert.match(readFileSync(join(cwd, ".clio-coder/wiki/a.md"), "utf8"), /Additional detail before interruption/u);
		mkdirSync(join(cwd, ".clio-coder/wiki-staging-orphan"));
		await runWikiGenerate({ cwd, model: "fixture" });
		assert.deepEqual(readWikiMeta(cwd), published);
		assert.equal(existsSync(join(cwd, ".clio-coder/wiki-prev")), false);
	});
	it("restores the valid backup and preserves an invalid live tree for inspection", async () => {
		await initialize();
		const previous = readWikiMeta(cwd);
		crash("publish");
		writeFileSync(join(cwd, ".clio-coder/wiki/meta.json"), "incomplete metadata");
		await runWikiGenerate({ cwd, model: "fixture" });
		assert.deepEqual(readWikiMeta(cwd), previous);
		assert.match(readFileSync(join(cwd, ".clio-coder/wiki/b.md"), "utf8"), /b version 1/u);
		const retained = readdirSync(join(cwd, ".clio-coder")).find((name) => name.startsWith("wiki-interrupted-"));
		assert.ok(retained);
		assert.match(
			readFileSync(join(cwd, ".clio-coder", retained, "wiki/a.md"), "utf8"),
			/Additional detail before interruption/u,
		);
	});
	it("preserves both damaged publication trees when neither validates", async () => {
		await initialize();
		crash("publish");
		for (const dir of ["wiki", "wiki-prev"])
			writeFileSync(join(cwd, ".clio-coder", dir, "meta.json"), "incomplete metadata");
		await assert.rejects(runWikiGenerate({ cwd, model: "fixture" }), /wiki recovery requires a valid publication/u);
		for (const dir of ["wiki", "wiki-prev"]) assert.equal(existsSync(join(cwd, ".clio-coder", dir, "b.md")), true);
	});
	it("retains discovered dependencies through no-op updates and failed deletion refreshes", async () => {
		await initialize(["src/a.ts", "src/extra.ts"]);
		const unchanged = await run(
			generator((_spec, path) => {
				assert.equal(path, undefined);
			}),
		);
		assert.equal(unchanged.status, "noop");
		assert.deepEqual(readWikiMeta(cwd)?.plan?.pages[0]?.dependencies, ["src/a.ts", "src/extra.ts"]);
		rmSync(join(cwd, "src/extra.ts"));
		const attempts: string[] = [];
		const fail = generator((_spec, path) => {
			if (path) {
				attempts.push(path);
				return 1;
			}
		});
		const changed = await run(fail);
		assert.equal(changed.pending, 1);
		assert.equal(attempts.length, 1);
		assert.ok(attempts[0]?.endsWith("a.md"));
		// Assembly removes its now-resolved repair marker on the next pass.
		await run(fail);
		const noop = await run(fail);
		assert.equal(noop.status, "noop");
		assert.equal(noop.pending, 1);
		assert.deepEqual(readWikiMeta(cwd)?.plan?.pages[0]?.dependencies, ["src/a.ts", "src/extra.ts"]);
		assert.equal(readWikiMeta(cwd)?.plan?.pages[0]?.attempts, 3);
	});
});

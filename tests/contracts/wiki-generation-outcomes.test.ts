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
import { readWikiPlanFile, sanitizeWikiPlan, writeWikiPlanFile } from "../../src/domains/context/wiki/plan-store.js";
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
	it("keeps successful writers with invalid evidence pending and makes their next repair actionable", async () => {
		const onePage: WikiPlan = { version: 1, overview: "Fixture", pages: [page("a")] };
		for (const [version, invalid] of [
			`${content("a", 1)}\nSee \`src/a.ts:999\`.\n`,
			`${content("a", 1)}\nSee \`src/invented.ts\`.\n`,
			"---\nsources: [src/a.ts]\n---\n# Only a heading\n",
		].entries()) {
			const result = await run(
				generator((spec, path) => {
					if (!path) writeWikiPlanFile(spec.writeRoots?.[0] as string, onePage);
					else writeFileSync(path, invalid);
				}),
			);
			assert.equal(result.pending, 1);
			const failedPage = readWikiMeta(cwd)?.plan?.pages[0];
			assert.equal(failedPage?.status, "pending");
			assert.equal(failedPage?.lastFailure?.phase, "validation");
			assert.match(failedPage?.lastFailure?.detail ?? "", /evidence check failed/u);
			assert.match(failedPage?.lastFailure?.runId ?? "", /^fixture-/u);
			const repaired = await runWikiGenerate({
				cwd,
				model: "fixture",
				retryPending: true,
				generate: generator((_spec, path) => {
					assert.ok(path, "explicit repair preserves the plan rather than admitting another planner");
					writeFileSync(path, content("a", 2));
				}),
			});
			assert.equal(repaired.pending, 0);
			assert.equal(readWikiMeta(cwd)?.plan?.pages[0]?.lastFailure, undefined);
			assert.equal(readWikiMeta(cwd)?.plan?.pages[0]?.attempts, (failedPage?.attempts ?? 0) + 1);
			// Requeue this same page for the next deliberately bad writer result.
			writeFileSync(join(cwd, "src/a.ts"), `export const a = ${version + 2};\n`);
		}
	});
	it("revalidates mechanically invalid saved pages before reusing their successful checkpoint", async () => {
		await initialize();
		const dir = join(cwd, ".clio-coder", "wiki-staging-revalidate");
		mkdirSync(dir);
		const saved = readWikiMeta(cwd)?.plan;
		assert.ok(saved);
		writeWikiPlanFile(dir, saved);
		writeFileSync(join(dir, "a.md"), `${content("a", 1)}\nSee \`src/a.ts:999\`.\n`);
		writeFileSync(join(dir, "b.md"), content("b", 1));
		const attempted: string[] = [];
		const result = await run(
			generator((_spec, path) => {
				assert.ok(path);
				attempted.push(path);
				writeFileSync(path, content("a", 2));
			}),
		);
		assert.equal(result.pending, 0);
		assert.equal(attempted.length, 1);
		assert.ok(attempted[0]?.endsWith("a.md"));
	});
	it("checkpoints authored JS aliases against the actual TypeScript source bytes", async () => {
		await initialize(["src/a.js"]);
		assert.equal(wikiStaleness(cwd).state, "fresh");
		assert.deepEqual(readWikiMeta(cwd)?.plan?.pages[0]?.dependencies, ["src/a.ts"]);
		writeFileSync(join(cwd, "src/a.ts"), "export const a = 2;\n");
		const attempted: string[] = [];
		await run(
			generator((_spec, path) => {
				if (path) attempted.push(path);
			}),
		);
		assert.equal(attempted.length, 1);
		assert.ok(attempted[0]?.endsWith("a.md"));
		assert.equal(wikiStaleness(cwd).state, "fresh");
	});
	it("revalidates body-only source citations and retires removed dependencies after a successful repair", async () => {
		const onePage: WikiPlan = { version: 1, overview: "Fixture", pages: [page("a")] };
		const first = await run(
			generator((spec, path) => {
				if (!path) writeWikiPlanFile(spec.writeRoots?.[0] as string, onePage);
				else writeFileSync(path, `${content("a", 1)}\nSee \`src/extra.ts:1\`.\n`);
			}),
		);
		assert.equal(first.pending, 0);
		assert.ok(readWikiMeta(cwd)?.plan?.pages[0]?.dependencies?.includes("src/extra.ts"));
		rmSync(join(cwd, "src/extra.ts"));
		const failed = await run(generator((_spec, path) => (path ? 1 : 0)));
		assert.equal(failed.pending, 1);
		assert.ok(readWikiMeta(cwd)?.plan?.pages[0]?.dependencies?.includes("src/extra.ts"));
		const repaired = await runWikiGenerate({
			cwd,
			model: "fixture",
			retryPending: true,
			generate: generator((_spec, path) => {
				if (path) writeFileSync(path, content("a", 2));
			}),
		});
		assert.equal(repaired.pending, 0);
		assert.deepEqual(readWikiMeta(cwd)?.plan?.pages[0]?.dependencies, ["src/a.ts"]);
		assert.equal(wikiStaleness(cwd).state, "fresh");
	});
	it("revalidates revised page specifications, retires dropped pages, and preserves writer additions", async () => {
		await initialize();
		for (const change of ["intent", "sources"] as const) {
			const attempted: string[] = [];
			await run(
				generator((spec, path) => {
					if (path) {
						attempted.push(path);
						return;
					}
					const dir = spec.writeRoots?.[0] as string;
					const plan = readWikiPlanFile(dir);
					assert.ok(plan?.pages[0]);
					if (change === "intent") plan.pages[0].intent = "Document additional guarantees";
					else plan.pages[0].sources = ["src/extra.ts"];
					writeWikiPlanFile(dir, plan);
				}),
			);
			assert.equal(attempted.length, 1);
			assert.ok(attempted[0]?.endsWith("a.md"));
			assert.equal(readWikiMeta(cwd)?.plan?.pages[0]?.attempts, 1);
		}
		const result = await run(
			generator((spec, path) => {
				if (path) {
					writeFileSync(path, `${content("a", 2)}\n[More](extra.md)\n`);
					writeFileSync(join(spec.writeRoots?.[0] as string, "extra.md"), content("extra", 1));
					return;
				}
				const dir = spec.writeRoots?.[0] as string;
				const plan = readWikiPlanFile(dir);
				assert.ok(plan?.pages[0]);
				plan.pages = [{ ...plan.pages[0], intent: "Explain the linked detail" }];
				writeWikiPlanFile(dir, plan);
			}),
		);
		assert.equal(result.pending, 1);
		assert.equal(existsSync(join(cwd, ".clio-coder/wiki/b.md")), false);
		assert.equal(existsSync(join(cwd, ".clio-coder/wiki/extra.md")), true);
		assert.equal(readWikiMeta(cwd)?.plan?.pages.find((entry) => entry.path === "extra.md")?.status, "pending");
		assert.match(readFileSync(join(cwd, ".clio-coder/wiki/a.md"), "utf8"), /\[More\]\(extra.md\)/u);
		await run(
			generator((_spec, path) => {
				if (path) assert.ok(path.endsWith("extra.md"));
			}),
		);
		assert.equal(existsSync(join(cwd, ".clio-coder/wiki/b.md")), false);
		assert.equal(readWikiMeta(cwd)?.generation?.pagesWritten, 2);
	});
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
	it("retries exhausted partial-publication work once without replanning or erasing attempts", async () => {
		const initial = await run(
			generator((spec, path) => {
				if (!path) {
					writeWikiPlanFile(spec.writeRoots?.[0] as string, {
						version: 1,
						overview: "Fixture",
						pages: [page("a"), page("b")],
					});
					return;
				}
				const name = path.endsWith("a.md") ? "a" : "b";
				writeFileSync(path, content(name, 1));
				return name === "b" ? 1 : 0;
			}),
		);
		assert.equal(initial.pending, 1);
		assert.equal(readWikiMeta(cwd)?.gitHead, null, "first partial publication has no whole-wiki certification");
		for (let attempt = 2; attempt <= 3; attempt++) {
			const tried: string[] = [];
			await run(
				generator((_spec, path) => {
					if (!path) return;
					tried.push(path.endsWith("b.md") ? "b" : "a");
					return 1;
				}),
			);
			assert.deepEqual(tried, ["b"], "completed source-matching A survives partial publication");
			assert.equal(readWikiMeta(cwd)?.plan?.pages[1]?.attempts, attempt);
		}
		const failedPage = readWikiMeta(cwd)?.plan?.pages[1];
		assert.equal(failedPage?.lastFailure?.phase, "writer");
		assert.match(failedPage?.lastFailure?.detail ?? "", /exit 1/u);
		assert.ok(failedPage?.lastFailure?.runId);
		let calls = 0;
		const retried = await runWikiGenerate({
			cwd,
			model: "fixture",
			retryPending: true,
			generate: generator((_spec, path) => {
				assert.ok(path?.endsWith("b.md"), "explicit retry does not plan or rewrite A");
				calls++;
			}),
		});
		assert.equal(calls, 1);
		assert.equal(retried.pending, 0);
		const plan = readWikiMeta(cwd)?.plan;
		assert.equal(plan?.pages[0]?.attempts, 1);
		assert.equal(plan?.pages[1]?.attempts, 4, "explicit retry retains prior failed attempts");
		assert.equal(plan?.pages[1]?.lastFailure, undefined);
		assert.equal(wikiStaleness(cwd).state, "fresh");
	});
	it("records unadmitted work without spending a writer attempt and keeps it retryable", async () => {
		await initialize();
		writeFileSync(join(cwd, "src/b.ts"), "export const b = 2;\n");
		const result = await run(
			generator((_spec, path) => {
				if (path) throw new Error("fixture target cooling down");
			}),
		);
		assert.equal(result.pending, 1);
		const failedPage = readWikiMeta(cwd)?.plan?.pages[1];
		assert.equal(failedPage?.attempts, 0);
		assert.deepEqual(failedPage?.lastFailure, { phase: "admission", detail: "fixture target cooling down" });
		let calls = 0;
		const recovered = await runWikiGenerate({
			cwd,
			model: "fixture",
			retryPending: true,
			generate: generator((_spec, path) => {
				assert.ok(path?.endsWith("b.md"));
				calls++;
			}),
		});
		assert.equal(calls, 1);
		assert.equal(recovered.pending, 0);
		assert.equal(readWikiMeta(cwd)?.plan?.pages[1]?.attempts, 1);
	});
	it("does not invent a plan or call a model for an empty explicit retry", async () => {
		let calls = 0;
		const result = await runWikiGenerate({
			cwd,
			model: "fixture",
			retryPending: true,
			generate: () => {
				calls++;
			},
		});
		assert.equal(result.status, "failed");
		assert.match(result.problems?.join(" ") ?? "", /no saved wiki plan/u);
		assert.equal(calls, 0);
		assert.equal(readWikiMeta(cwd), null);
	});
	it("does not trust authored failure or retry accounting", () => {
		const prior: WikiPlan = {
			version: 1,
			overview: "Fixture",
			pages: [{ ...page("a"), attempts: 3, lastFailure: { phase: "writer", detail: "fetch failed", runId: "original" } }],
		};
		const authored = {
			...prior,
			pages: [
				{ ...prior.pages[0], status: "written", attempts: 0, lastFailure: { phase: "admission", detail: "invented" } },
			],
		};
		assert.deepEqual(sanitizeWikiPlan(authored, prior, { trustStatus: false })?.pages, prior.pages);
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
	for (const change of ["unchanged", "changed source", "failed Git comparison", "legacy checkpoint"] as const) {
		it(`resumes the first publication checkpoint with ${change}`, async () => {
			const stopped = await runWikiGenerate({
				cwd,
				model: "fixture",
				generate: generator((spec, path) => {
					if (!path)
						writeWikiPlanFile(spec.writeRoots?.[0] as string, {
							version: 1,
							overview: "Fixture project",
							pages: [page("a"), page("b")],
						});
					else writeFileSync(path, content("a", 1));
				}),
				onProgress(event) {
					if (event.message === "wrote a.md (1/2)") throw new Error("interrupted before first publication");
				},
			});
			assert.equal(stopped.status, "failed");
			assert.equal(readWikiMeta(cwd), null, "no published Git baseline exists yet");
			const dir = readdirSync(join(cwd, ".clio-coder")).find((name) => name.startsWith("wiki-staging-"));
			assert.ok(dir);
			const staged = readWikiPlanFile(join(cwd, ".clio-coder", dir));
			assert.ok(staged);
			assert.deepEqual(
				staged?.pages.map((entry) => entry.status),
				["written", "pending"],
			);
			assert.equal(staged.sourceGitHead, git("rev-parse", "HEAD").trim());
			if (change === "changed source") writeFileSync(join(cwd, "src/a.ts"), "export const a = 2;\n");
			if (change === "failed Git comparison") writeFileSync(join(cwd, ".git/index"), "invalid index");
			if (change === "legacy checkpoint") {
				delete staged.sourceGitHead;
				writeWikiPlanFile(join(cwd, ".clio-coder", dir), staged);
			}
			const attempted: string[] = [];
			const result = await run(
				generator((_spec, path) => {
					assert.ok(path, "a resumed checkpoint does not repeat planning");
					const name = path.endsWith("a.md") ? "a" : "b";
					attempted.push(name);
					writeFileSync(path, content(name, 2));
				}),
			);
			assert.deepEqual(attempted, change === "unchanged" ? ["b"] : ["a", "b"]);
			assert.equal(result.pending, 0);
		});
	}
	it("keeps checkpoint Git identity harness-owned across authored replanning", () => {
		const sourceGitHead = git("rev-parse", "HEAD").trim();
		const previous: WikiPlan = { version: 1, overview: "Fixture", pages: [page("a")], sourceGitHead };
		const authored = { ...previous, sourceGitHead: "0".repeat(40) };
		assert.equal(sanitizeWikiPlan(authored, previous, { trustStatus: false })?.sourceGitHead, sourceGitHead);
		assert.equal(sanitizeWikiPlan(authored, undefined, { trustStatus: false })?.sourceGitHead, undefined);
		assert.equal(sanitizeWikiPlan({ ...authored, sourceGitHead: "HEAD" })?.sourceGitHead, undefined);
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

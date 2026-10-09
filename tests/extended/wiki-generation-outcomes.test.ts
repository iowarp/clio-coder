import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { WikiModelRoute } from "../../src/cli/wiki-generate.js";
import { modelWikiGenerate } from "../../src/cli/wiki-generate.js";
import { runWikiGenerate } from "../../src/domains/context/wiki/generate.js";
import { computeWikiContentHash, readWikiMeta, writeWikiMeta } from "../../src/domains/context/wiki/meta.js";
import type { WikiPlan, WikiPlanPage } from "../../src/domains/context/wiki/plan.js";
import { readWikiPlanFile, sanitizeWikiPlan, writeWikiPlanFile } from "../../src/domains/context/wiki/plan-store.js";
import { wikiCompleteness, wikiStaleness } from "../../src/domains/context/wiki/staleness.js";
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
/** A faux terminal receipt for runs that fail with a coded outcome and tool activity. */
interface FauxReceipt {
	exitCode: number;
	outcomeCode?: string;
	mutatingSucceeded?: boolean;
}
function generator(
	action: (spec: JobSpec, path: string | undefined) => number | FauxReceipt | undefined,
	route?: WikiModelRoute,
) {
	let sequence = 0;
	const dispatch = {
		abort() {},
		async dispatch(spec: JobSpec) {
			const prompted = /(?:Write the file|Repair the existing draft at) `([^`]+)` and nothing else\./u.exec(
				spec.task,
			)?.[1];
			// Repair prompts cite the draft relative to the job cwd; resolve it like a real worker would.
			const path = prompted ? resolve(spec.cwd ?? process.cwd(), prompted) : undefined;
			const acted = action(spec, path) ?? 0;
			const faux = typeof acted === "number" ? { exitCode: acted } : acted;
			const receipt = {
				exitCode: faux.exitCode,
				...(faux.outcomeCode !== undefined ? { outcomeCode: faux.outcomeCode } : {}),
				...(faux.mutatingSucceeded !== undefined
					? { toolActivity: { calls: 1, succeeded: 1, failed: 0, blocked: 0, mutatingSucceeded: faux.mutatingSucceeded } }
					: {}),
			};
			return {
				runId: `fixture-${++sequence}`,
				events: (async function* () {})(),
				finalPromise: Promise.resolve(receipt),
			};
		},
	} as unknown as DispatchContract;
	return modelWikiGenerate({ dispatch, ...(route ? { route } : {}) });
}

describe("wiki generation outcomes", () => {
	let isolated: IsolatedClioEnv;
	let cwd: string;
	beforeEach(async () => {
		isolated = await isolateClioEnv("clio-coder-wiki-outcomes-");
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
	function run(generate: ReturnType<typeof generator>, replan = false) {
		return runWikiGenerate({ cwd, model: "fixture", generate, replan });
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
	for (const target of ["written", "pending draft", "empty", "missing"] as const) {
		it(`validates links to a later planned sibling before it becomes ${target} and applies publication statuses`, async () => {
			const plan: WikiPlan = {
				version: 1,
				overview: "Fixture",
				pages: [page("a"), { ...page("b"), path: "section/b.md" }],
			};
			const requests: string[] = [];
			const links = "[Sibling](section/b.md#details) and [Reference][sibling].\n\n[sibling]: section/b.md#details\n";
			const result = await run(
				generator((spec, path) => {
					if (!path) {
						const outputDir = spec.writeRoots?.[0] as string;
						mkdirSync(join(outputDir, "section"), { recursive: true });
						if (target !== "missing") writeFileSync(join(outputDir, "section/b.md"), "# B\n");
						writeWikiPlanFile(outputDir, plan);
						return;
					}
					assert.equal(spec.agentId, "wiki-writer", "a planned forward link does not trigger mechanical repair");
					if (path.endsWith("a.md")) {
						requests.push("a.md");
						writeFileSync(path, `${content("a", 1)}${links}`);
						return;
					}
					requests.push("section/b.md");
					const checkpoint = readWikiPlanFile(join(path, "../.."));
					assert.equal(checkpoint?.pages[0]?.status, "written", "the earlier page validates before its sibling is written");
					assert.equal(checkpoint?.pages[0]?.attempts, 1);
					if (target === "written" || target === "pending draft")
						writeFileSync(path, `${content("b", 1)}[Earlier](../a.md)\n`);
					return target === "written" ? 0 : 1;
				}),
			);
			assert.deepEqual(requests, ["a.md", "section/b.md"]);
			const available = target === "written" || target === "pending draft";
			const complete = target === "written" ? 2 : available ? 1 : 0;
			assert.equal(result.pending, 2 - complete);
			const saved = readWikiMeta(cwd);
			assert.deepEqual(
				saved?.plan?.pages.map((entry) => entry.status),
				[available ? "written" : "pending", target === "written" ? "written" : "pending"],
			);
			assert.equal(saved?.generation?.pagesWritten, complete);
			assert.equal(existsSync(join(cwd, ".clio-coder/wiki/section/b.md")), available);
			assert.ok(readFileSync(join(cwd, ".clio-coder/wiki/a.md"), "utf8").includes(links));
			if (!available) assert.match(saved?.plan?.pages[0]?.lastFailure?.detail ?? "", /section\/b\.md/u);
			for (const name of ["index.md", "quickstart.md"]) {
				const navigation = readFileSync(join(cwd, ".clio-coder/wiki", name), "utf8");
				assert.ok(navigation.includes(`${complete} complete, ${2 - complete} pending.`));
				if (target === "pending draft" && name === "quickstart.md")
					assert.match(navigation, /\[B\]\(section\/b\.md\) \(pending draft\)/u);
				if (!available) assert.doesNotMatch(navigation, /\[B\]\(section\/b\.md\)/u);
			}
			if (target === "pending draft") {
				const section = readFileSync(join(cwd, ".clio-coder/wiki/section/index.md"), "utf8");
				assert.match(section, /0 complete, 1 pending/u);
				assert.match(section, /\[B\]\(b\.md\) \(pending draft\)/u);
			}
		});
	}
	for (const resultKind of ["invalid", "valid", "failed receipt"] as const) {
		const succeeds = resultKind === "valid";
		it(`dispatches one bounded repair with complete diagnostics and ${succeeds ? "credits its validated edit" : `keeps ${resultKind} pending`}`, async () => {
			const plan: WikiPlan = { version: 1, overview: "Fixture", pages: [page("a")] };
			const invalid =
				content("a", 1).replace("  - src/a.ts", "  - src/a.ts\n  - bench/missing.ts") +
				Array.from({ length: 12 }, (_, n) => `See \`src/${n === 11 ? "x".repeat(330) : ""}missing-${n}.ts\`.\n`).join("");
			const requests: JobSpec[] = [];
			const result = await run(
				generator(
					(spec, path) => {
						requests.push(spec);
						assert.equal(spec.workerProfile, "writer-profile");
						assert.equal(spec.target, "explicit-target");
						if (!path) {
							writeWikiPlanFile(spec.writeRoots?.[0] as string, plan);
							return;
						}
						if (spec.agentId === "wiki-repair") {
							assert.deepEqual(spec.budget, { toolCalls: 10, readReserve: 4 });
							assert.deepEqual(spec.writeRoots, [path]);
							assert.equal(spec.denyTools?.includes("write"), true);
							assert.equal(spec.denyTools?.includes("code_nav"), true);
							assert.equal(spec.denyTools?.includes("edit"), false);
							const data = /```json\s+([\s\S]*?)\s+```/u.exec(spec.task)?.[1];
							assert.ok(data);
							const diagnostics = JSON.parse(data).diagnostics;
							assert.equal(diagnostics.length, 13);
							assert.ok(JSON.stringify(diagnostics).length > 500);
							assert.match(diagnostics.at(-1), /missing-11/u);
							assert.ok(diagnostics.at(-1).length > 300);
							assert.doesNotMatch(spec.task, /Read every one|Indexed symbols|Repository guidance/u);
							assert.equal(spec.intent?.readRoots.includes("."), false);
						}
						writeFileSync(path, spec.agentId === "wiki-repair" && resultKind !== "invalid" ? content("a", 2) : invalid);
						if (spec.agentId === "wiki-repair" && resultKind === "failed receipt") return 1;
					},
					{ workerProfile: "writer-profile", target: "explicit-target" },
				),
			);
			assert.deepEqual(
				requests.map((spec) => spec.agentId),
				["wiki-writer", "wiki-writer", "wiki-repair"],
			);
			assert.equal(result.pending, succeeds ? 0 : 1);
			const saved = readWikiMeta(cwd)?.plan?.pages[0];
			assert.equal(saved?.attempts, 2);
			assert.equal(saved?.status, succeeds ? "written" : "pending");
			if (!succeeds) {
				assert.match(saved?.lastFailure?.detail ?? "", /repair failed/u);
				assert.ok((saved?.lastFailure?.detail.length ?? 0) <= 500);
				await run(
					generator((spec, path) => {
						assert.equal(spec.agentId, "wiki-writer");
						assert.ok(path);
						writeFileSync(path, content("a", 3));
					}),
				);
				assert.equal(readWikiMeta(cwd)?.plan?.pages[0]?.status, "written");
			}
		});
	}
	for (const [attempts, retryPending] of [
		[2, false],
		[3, true],
		[0, true],
	] as const) {
		it(`refuses an extra repair after a writer with ${attempts} prior attempts and retryPending=${retryPending}`, async () => {
			await initialize();
			const dir = join(cwd, ".clio-coder/wiki-staging-repair-limit");
			mkdirSync(dir);
			const saved = readWikiMeta(cwd)?.plan;
			assert.ok(saved?.pages[0]);
			saved.pages[0].status = "pending";
			saved.pages[0].attempts = attempts;
			saved.pages[0].lastFailure = { phase: "writer", detail: "Previous writer failed", runId: "failed-writer" };
			writeWikiPlanFile(dir, saved);
			writeFileSync(join(dir, "a.md"), content("a", 1));
			writeFileSync(join(dir, "b.md"), content("b", 1));
			const requests: string[] = [];
			const result = await runWikiGenerate({
				cwd,
				model: "fixture",
				retryPending,
				generate: generator((spec, path) => {
					assert.ok(path);
					requests.push(spec.agentId ?? "");
					writeFileSync(path, `${content("a", 1)}See \`src/missing.ts\`.\n`);
				}),
			});
			assert.deepEqual(requests, ["wiki-writer"]);
			assert.equal(result.pending, 1);
			assert.equal(readWikiMeta(cwd)?.plan?.pages[0]?.attempts, attempts + 1);
			assert.equal(readWikiMeta(cwd)?.plan?.pages[0]?.lastFailure?.phase, "validation");
		});
	}
	describe("tool-call cap after a write", () => {
		const capped = (mutatingSucceeded?: boolean): FauxReceipt => ({
			exitCode: 1,
			outcomeCode: "worker_tool_call_cap_exhausted",
			...(mutatingSucceeded !== undefined ? { mutatingSucceeded } : {}),
		});
		async function seedPending() {
			await initialize();
			const dir = join(cwd, ".clio-coder/wiki-staging-capped");
			mkdirSync(dir);
			const saved = readWikiMeta(cwd)?.plan;
			assert.ok(saved?.pages[0]);
			saved.pages[0].status = "pending";
			saved.pages[0].attempts = 0;
			saved.pages[0].lastFailure = { phase: "writer", detail: "Previous writer failed", runId: "failed-writer" };
			writeWikiPlanFile(dir, saved);
			writeFileSync(join(dir, "a.md"), content("a", 1));
			writeFileSync(join(dir, "b.md"), content("b", 1));
		}
		const resume = (
			generate: ReturnType<typeof generator>,
			progress?: (event: { message: string; detail?: string }) => void,
		) =>
			runWikiGenerate({
				cwd,
				model: "fixture",
				retryPending: true,
				generate,
				...(progress ? { onProgress: progress } : {}),
			});

		it("writes a capped run whose draft passes the evidence gate without another dispatch", async () => {
			await seedPending();
			const requests: string[] = [];
			const events: Array<{ message: string; detail?: string }> = [];
			const result = await resume(
				generator((spec, path) => {
					assert.ok(path);
					requests.push(spec.agentId ?? "");
					writeFileSync(path, content("a", 2));
					return capped(true);
				}),
				(event) => events.push(event),
			);
			assert.deepEqual(requests, ["wiki-writer"]);
			assert.equal(result.pending, 0);
			assert.equal(readWikiMeta(cwd)?.plan?.pages[0]?.status, "written");
			assert.equal(readWikiMeta(cwd)?.plan?.pages[0]?.completedAfterCap, true);
			assert.equal(readWikiMeta(cwd)?.plan?.pages[1]?.completedAfterCap, undefined);
			assert.ok(events.some((event) => /^wrote a\.md after tool-call cap \(/u.test(event.message)));
			const summary = events.find((event) => event.message === "wiki invocation usage");
			assert.match(summary?.detail ?? "", /pages completed after tool-call cap=1 \(a\.md\)/u);
		});

		it("clears the cap marker when a later normal writer rewrites the page", async () => {
			await seedPending();
			await resume(
				generator((_spec, path) => {
					assert.ok(path);
					writeFileSync(path, content("a", 2));
					return capped(true);
				}),
			);
			assert.equal(readWikiMeta(cwd)?.plan?.pages[0]?.completedAfterCap, true);
			writeFileSync(join(cwd, "src/a.ts"), "export const a = 2;\n");
			const events: Array<{ message: string; detail?: string }> = [];
			await runWikiGenerate({
				cwd,
				model: "fixture",
				onProgress: (event) => events.push(event),
				generate: generator((_spec, path) => {
					assert.ok(path);
					writeFileSync(path, content("a", 3));
				}),
			});
			assert.equal(readWikiMeta(cwd)?.plan?.pages[0]?.status, "written");
			assert.equal(readWikiMeta(cwd)?.plan?.pages[0]?.completedAfterCap, undefined);
			assert.doesNotMatch(
				events.find((event) => event.message === "wiki invocation usage")?.detail ?? "",
				/tool-call cap/u,
			);
		});

		it("never persists the cap marker on a page that is not written", async () => {
			await seedPending();
			await resume(
				generator((_spec, path) => {
					assert.ok(path);
					writeFileSync(path, content("a", 2));
					return capped(true);
				}),
			);
			const rawPlan = () => JSON.parse(readFileSync(join(cwd, ".clio-coder/wiki/meta.json"), "utf8")).plan as WikiPlan;
			assert.equal(rawPlan().pages[0]?.completedAfterCap, true);
			const stale = structuredClone(rawPlan());
			assert.ok(stale.pages[0]);
			stale.pages[0].status = "pending";
			const dir = join(cwd, ".clio-coder/wiki-staging-reset");
			mkdirSync(dir);
			writeWikiPlanFile(dir, stale);
			const onDisk = JSON.parse(readFileSync(join(dir, "_plan.json"), "utf8")) as WikiPlan;
			assert.equal(onDisk.pages[0]?.status, "pending");
			assert.equal("completedAfterCap" in (onDisk.pages[0] ?? {}), false);
			const meta = readWikiMeta(cwd);
			assert.ok(meta);
			writeWikiMeta(cwd, { ...meta, plan: stale });
			const rawMeta = rawPlan();
			assert.equal(rawMeta.pages[0]?.status, "pending");
			assert.equal("completedAfterCap" in (rawMeta.pages[0] ?? {}), false);
		});

		it("never marks a normally completed page", async () => {
			await initialize();
			for (const entry of readWikiMeta(cwd)?.plan?.pages ?? []) assert.equal(entry.completedAfterCap, undefined);
		});

		it("records a capped run with an invalid draft as a validation failure and repairs it next", async () => {
			await seedPending();
			const first = await resume(
				generator((_spec, path) => {
					assert.ok(path);
					writeFileSync(path, `${content("a", 2)}See \`src/missing.ts\`.\n`);
					return capped(true);
				}),
			);
			assert.equal(first.pending, 1);
			const failed = readWikiMeta(cwd)?.plan?.pages[0];
			assert.equal(failed?.status, "pending");
			assert.equal(failed?.lastFailure?.phase, "validation");
			assert.match(failed?.lastFailure?.detail ?? "", /worker_tool_call_cap_exhausted/u);
			assert.match(failed?.lastFailure?.runId ?? "", /^fixture-/u);
			const requests: string[] = [];
			const repaired = await resume(
				generator((spec, path) => {
					assert.ok(path);
					requests.push(spec.agentId ?? "");
					writeFileSync(path, content("a", 2));
				}),
			);
			assert.deepEqual(requests, ["wiki-repair"]);
			assert.equal(repaired.pending, 0);
		});

		for (const mutatingSucceeded of [false, undefined]) {
			it(`keeps a capped run with mutatingSucceeded=${mutatingSucceeded} a writer failure`, async () => {
				await seedPending();
				const first = await resume(
					generator((_spec, path) => {
						assert.ok(path);
						writeFileSync(path, content("a", 2));
						return capped(mutatingSucceeded);
					}),
				);
				assert.equal(first.pending, 1);
				const failed = readWikiMeta(cwd)?.plan?.pages[0];
				assert.equal(failed?.lastFailure?.phase, "writer");
				assert.match(failed?.lastFailure?.detail ?? "", /worker_tool_call_cap_exhausted/u);
				const requests: string[] = [];
				await resume(
					generator((spec, path) => {
						assert.ok(path);
						requests.push(spec.agentId ?? "");
						writeFileSync(path, content("a", 2));
					}),
				);
				assert.deepEqual(requests, ["wiki-writer"]);
			});
		}

		for (const [label, touch] of [
			["rewrites the seeded page with identical bytes", (path: string) => writeFileSync(path, content("a", 1))],
			[
				"only mutates a different staged page",
				(path: string) => writeFileSync(join(dirname(path), "b.md"), content("b", 2)),
			],
		] as const) {
			it(`keeps a capped run that ${label} a writer failure`, async () => {
				await seedPending();
				const first = await resume(
					generator((_spec, path) => {
						assert.ok(path);
						touch(path);
						return capped(true);
					}),
				);
				assert.equal(first.pending, 1);
				const failed = readWikiMeta(cwd)?.plan?.pages[0];
				assert.equal(failed?.status, "pending");
				assert.equal(failed?.lastFailure?.phase, "writer");
				const requests: string[] = [];
				await resume(
					generator((spec, path) => {
						assert.ok(path);
						requests.push(spec.agentId ?? "");
						writeFileSync(path, content("a", 2));
					}),
				);
				assert.deepEqual(requests, ["wiki-writer"]);
			});
		}
	});
	for (const resumed of [false, true]) {
		it(`validates ${resumed ? "resumed" : "newly authored"} plan anchors before dispatching writers`, async () => {
			writeFileSync(join(isolated.dir, "outside.ts"), "outside\n");
			symlinkSync(join(isolated.dir, "outside.ts"), join(cwd, "src/escape.ts"));
			symlinkSync(join(cwd, "src/a.ts"), join(cwd, "src/alias.ts"));
			const invalid = ["src/missing.ts", "../outside.ts", "src/escape.ts", "src", join(cwd, "src/a.ts")];
			const plan: WikiPlan = {
				version: 1,
				overview: "Fixture",
				pages: [{ ...page("a"), sources: ["src/a.ts", "src/alias.ts", ...invalid], status: "written", attempts: 3 }],
			};
			const requests: JobSpec[] = [];
			const checkpoints: Array<WikiPlan | null> = [];
			const outputDir = join(cwd, ".clio-coder/wiki-staging-anchors");
			mkdirSync(outputDir, { recursive: true });
			writeWikiPlanFile(outputDir, resumed ? plan : { ...plan, pages: [page("a")] });
			const saved = readWikiPlanFile(outputDir);
			assert.ok(saved);
			await generator((spec, path) => {
				requests.push(spec);
				if (!path) writeWikiPlanFile(outputDir, plan);
				else {
					checkpoints.push(readWikiPlanFile(outputDir));
					writeFileSync(path, content("a", 1));
				}
			})({
				cwd,
				outputDir,
				mode: resumed ? "update" : "init",
				resumed,
				plan: saved,
				unclaimedAreas: [],
				codewiki: { version: 5, language: "typescript", files: [], symbols: [], edges: [] },
				generation: { requestedDepth: "simple", depth: "simple", sourceFiles: 1, sourceLines: 1, plan: saved },
			});
			assert.equal(readWikiPlanFile(outputDir)?.pages[0]?.status, "written");
			assert.equal(requests.length, resumed ? 1 : 2);
			assert.equal(checkpoints.length, 1);
			assert.deepEqual(checkpoints[0]?.pages[0]?.sources, ["src/a.ts", "src/alias.ts"]);
			assert.equal(checkpoints[0]?.pages[0]?.status, "pending");
			assert.equal(checkpoints[0]?.pages[0]?.attempts, 0);
			const writerTask = requests.at(-1)?.task ?? "";
			assert.ok(writerTask.includes("- src/a.ts\n- src/alias.ts"));
			for (const source of invalid) assert.equal(writerTask.includes(`- ${source}\n`), false, source);
		});
	}
	it("publishes draft labels and counts from the same statuses as metadata after link repair and dropped pages", async () => {
		const result = await runWikiGenerate({
			cwd,
			model: "fixture",
			generate(input) {
				mkdirSync(join(input.outputDir, "section"), { recursive: true });
				writeFileSync(join(input.outputDir, "a.md"), `${content("a", 1)}\n[Empty](<section/empty.md> "Optional title")\n`);
				writeFileSync(join(input.outputDir, "b.md"), `${content("b", 1)}\n[Section](section/index.md)\n`);
				writeFileSync(join(input.outputDir, "section/empty.md"), "# Empty\n");
				writeFileSync(join(input.outputDir, "section/extra.md"), content("extra", 1));
				writeFileSync(join(input.outputDir, "draft.md"), `${content("a", 1)}\n[Missing](missing.md)\n`);
				writeWikiPlanFile(input.outputDir, {
					...input.plan,
					pages: [
						{ ...page("a"), status: "written", attempts: 1 },
						{ ...page("b"), status: "written", attempts: 1 },
						{ ...page("extra"), path: "section/empty.md", status: "written", attempts: 1 },
						{
							...page("a"),
							path: "draft.md",
							lastFailure: { phase: "writer", detail: "writer failed", runId: "failed-run" },
						},
					],
				});
			},
		});
		assert.equal(result.pending, 4);
		const meta = readWikiMeta(cwd);
		assert.equal(meta?.generation?.pagesWritten, 1);
		assert.equal(meta?.generation?.pagesPlanned, 5);
		assert.equal(meta?.plan?.pages.find((entry) => entry.path === "a.md")?.lastFailure?.phase, "validation");
		assert.equal(meta?.plan?.pages.find((entry) => entry.path === "a.md")?.status, "pending");
		assert.match(
			meta?.plan?.pages.find((entry) => entry.path === "a.md")?.lastFailure?.detail ?? "",
			/section\/empty.md/,
		);
		assert.equal(meta?.plan?.pages.find((entry) => entry.path === "b.md")?.status, "written");
		assert.equal(meta?.plan?.pages.find((entry) => entry.path === "draft.md")?.lastFailure?.phase, "writer");
		assert.equal(existsSync(join(cwd, ".clio-coder/wiki/section/empty.md")), false);
		for (const name of ["quickstart.md", "index.md"]) {
			const navigation = readFileSync(join(cwd, ".clio-coder/wiki", name), "utf8");
			assert.match(navigation, /1 complete, 4 pending/);
			assert.match(navigation, /\[a\]\(a.md\) \(pending draft\)/i);
			assert.doesNotMatch(navigation, /\[b\]\(b.md\) \(pending draft\)/i);
		}
		assert.match(readFileSync(join(cwd, ".clio-coder/wiki/section/index.md"), "utf8"), /0 complete, 2 pending/);
	});

	it("preserves substantive coverage gaps as pending drafts until a writer completes the assignment", async () => {
		const gap = "Inspect the admission rejection branch and its focused test.";
		const draft = content("a", 1).replace("---\n#", `coverage_gaps:\n  - ${JSON.stringify(gap)}\n---\n#`);
		const result = await runWikiGenerate({
			cwd,
			model: "fixture",
			generate(input) {
				writeFileSync(join(input.outputDir, "a.md"), draft);
				writeWikiPlanFile(input.outputDir, { ...input.plan, pages: [{ ...page("a"), status: "written", attempts: 1 }] });
			},
		});
		assert.equal(result.pending, 1);
		assert.equal(readWikiMeta(cwd)?.generation?.pagesWritten, 0);
		assert.match(readWikiMeta(cwd)?.plan?.pages[0]?.lastFailure?.detail ?? "", /Coverage gaps:/);
		assert.match(readFileSync(join(cwd, ".clio-coder/wiki/a.md"), "utf8"), /coverage_gaps:/);
		assert.match(readFileSync(join(cwd, ".clio-coder/wiki/quickstart.md"), "utf8"), /0 complete, 1 pending/);
		let calls = 0;
		const completed = await runWikiGenerate({
			cwd,
			model: "fixture",
			retryPending: true,
			generate: generator((_spec, path) => {
				assert.ok(path);
				calls++;
				writeFileSync(path, content("a", 2));
			}),
		});
		assert.equal(calls, 1);
		assert.equal(completed.pending, 0);
		assert.equal(readWikiMeta(cwd)?.plan?.pages[0]?.lastFailure, undefined);
	});

	for (const resumed of [false, true]) {
		it(`routes ${resumed ? "saved" : "fresh"} coverage failures to normal writing without repair`, async () => {
			const gap = "Inspect the admission rejection branch and its focused test.";
			const draft = content("a", 1).replace("---\n#", `coverage_gaps:\n  - ${JSON.stringify(gap)}\n---\n#`);
			const plan: WikiPlan = { version: 1, overview: "Fixture", pages: [page("a")] };
			if (resumed) {
				await initialize();
				const dir = join(cwd, ".clio-coder/wiki-staging-coverage");
				mkdirSync(dir);
				const saved = readWikiMeta(cwd)?.plan;
				assert.ok(saved?.pages[0]);
				saved.pages[0].status = "pending";
				saved.pages[0].lastFailure = { phase: "validation", detail: gap, runId: "successful-writer" };
				writeWikiPlanFile(dir, saved);
				writeFileSync(join(dir, "a.md"), draft);
				writeFileSync(join(dir, "b.md"), content("b", 1));
			}
			const requests: string[] = [];
			const result = await run(
				generator((spec, path) => {
					requests.push(spec.agentId ?? "");
					if (!path) writeWikiPlanFile(spec.writeRoots?.[0] as string, plan);
					else writeFileSync(path, draft);
				}),
			);
			assert.deepEqual(requests, resumed ? ["wiki-writer"] : ["wiki-writer", "wiki-writer"]);
			assert.equal(result.pending, 1);
			const pending = readWikiMeta(cwd)?.plan?.pages[0];
			assert.equal(pending?.attempts, resumed ? 2 : 1);
			assert.equal(pending?.lastFailure?.phase, "writer");
			assert.match(pending?.lastFailure?.detail ?? "", /Coverage gap/u);
			let calls = 0;
			const completed = await run(
				generator((spec, path) => {
					assert.equal(spec.agentId, "wiki-writer");
					assert.ok(path);
					calls++;
					writeFileSync(path, content("a", 2));
				}),
			);
			assert.equal(calls, 1);
			assert.equal(completed.pending, 0);
		});
	}
	for (const fixed of [false, true]) {
		it(`blocks reuse of a broken wiki link and ${fixed ? "credits" : "rejects"} the gated repair`, async () => {
			await initialize();
			const dir = join(cwd, ".clio-coder/wiki-staging-link");
			mkdirSync(dir);
			const saved = readWikiMeta(cwd)?.plan;
			assert.ok(saved?.pages[0]);
			saved.pages[0].status = "pending";
			saved.pages[0].attempts = 3;
			saved.pages[0].lastFailure = { phase: "validation", detail: "Historical gate failure", runId: "successful-writer" };
			const draft = `${content("a", 1)}[Missing](missing.md)\n`;
			writeWikiPlanFile(dir, saved);
			writeFileSync(join(dir, "a.md"), draft);
			writeFileSync(join(dir, "b.md"), content("b", 1));
			let calls = 0;
			const repair = generator((spec, path) => {
				assert.equal(spec.agentId, "wiki-repair");
				assert.ok(path);
				assert.match(spec.task, /Repair unresolved wiki link/u);
				assert.match(spec.task, /missing\.md/u);
				calls++;
				writeFileSync(path, fixed ? `${content("a", 1)}[Existing page](b.md)\n` : draft);
			});
			const result = await run(repair);
			assert.equal(calls, 0);
			assert.equal(result.pending, 1, "the shared link gate blocks zero-dispatch reuse before exhausted filtering");
			assert.equal(readWikiMeta(cwd)?.plan?.pages[0]?.attempts, 3);
			const retried = await runWikiGenerate({ cwd, model: "fixture", retryPending: true, generate: repair });
			assert.equal(calls, 1);
			assert.equal(retried.pending, fixed ? 0 : 1);
			assert.equal(readWikiMeta(cwd)?.plan?.pages[0]?.attempts, 4);
			assert.equal(readWikiMeta(cwd)?.plan?.pages[0]?.status, fixed ? "written" : "pending");
		});
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
			assert.equal(failedPage?.lastFailure?.phase, "writer");
			assert.match(failedPage?.lastFailure?.detail ?? "", /repair failed/u);
			assert.match(failedPage?.lastFailure?.detail ?? "", /^repair failed: evidence check failed: \[/u);
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
	for (const changed of [false, true]) {
		it(`${changed ? "writes immediately" : "credits without dispatch"} a pending valid draft with ${changed ? "changed" : "unchanged"} source bytes`, async () => {
			await initialize();
			const dir = join(cwd, ".clio-coder/wiki-staging-pending");
			mkdirSync(dir);
			const saved = readWikiMeta(cwd)?.plan;
			assert.ok(saved?.pages[0]);
			saved.pages[0].status = "pending";
			saved.pages[0].attempts = changed ? 1 : 3;
			saved.pages[0].lastFailure = { phase: "validation", detail: "Historical gate failure", runId: "successful-writer" };
			writeWikiPlanFile(dir, saved);
			writeFileSync(join(dir, "a.md"), content("a", 1));
			writeFileSync(join(dir, "b.md"), content("b", 1));
			if (changed) writeFileSync(join(cwd, "src/a.ts"), "export const a = 2;\n");
			let dispatches = 0;
			const result = await run(
				generator((spec, path) => {
					dispatches++;
					assert.equal(spec.agentId, "wiki-writer");
					assert.ok(path?.endsWith("a.md"));
					assert.ok(path);
					writeFileSync(path, content("a", 2));
				}),
			);
			assert.equal(dispatches, changed ? 1 : 0);
			assert.equal(result.pending, 0);
			assert.equal(readWikiMeta(cwd)?.plan?.pages[0]?.attempts, changed ? 2 : 3);
			assert.equal(readWikiMeta(cwd)?.plan?.pages[0]?.status, "written");
			assert.equal(readWikiMeta(cwd)?.plan?.pages[0]?.lastFailure, undefined);
		});
	}
	for (const attempts of [1, 3]) {
		it(`requires normal writing for a changed body dependency and unrelated bad line with ${attempts} previous attempts`, async () => {
			await initialize();
			const dir = join(cwd, ".clio-coder/wiki-staging-body-dependency");
			mkdirSync(dir);
			const saved = readWikiMeta(cwd)?.plan;
			assert.ok(saved?.pages[0]);
			saved.pages[0].status = "pending";
			saved.pages[0].attempts = attempts;
			saved.pages[0].lastFailure = { phase: "validation", detail: "Historical gate failure", runId: "successful-writer" };
			assert.deepEqual(saved.pages[0].dependencies, ["src/a.ts"]);
			writeWikiPlanFile(dir, saved);
			writeFileSync(join(dir, "a.md"), `${content("a", 1)}See \`b.ts\` for b version 1.\nSee \`src/a.ts:999\`.\n`);
			writeFileSync(join(dir, "b.md"), content("b", 1));
			writeFileSync(join(cwd, "src/b.ts"), "export const b = 2;\n");
			let dispatches = 0;
			const write = generator((spec, path) => {
				assert.equal(spec.agentId, "wiki-writer");
				assert.ok(path);
				dispatches++;
				writeFileSync(path, path.endsWith("a.md") ? `${content("a", 1)}See \`b.ts\` for b version 2.\n` : content("b", 2));
			});
			const result = await run(write);
			assert.equal(result.pending, attempts === 3 ? 1 : 0);
			assert.equal(dispatches, attempts === 3 ? 1 : 2, "B is refreshed; A requires available normal-writer admission");
			if (attempts === 3) {
				const retained = readWikiMeta(cwd)?.plan?.pages[0]?.lastFailure;
				assert.equal(retained?.phase, "validation");
				assert.equal(retained?.detail, "Historical gate failure");
				assert.equal(retained?.runId, undefined);
				const stillPending = await run(write);
				assert.equal(stillPending.pending, 1, "replacing the baseline cannot make the stale draft reusable");
				assert.equal(dispatches, 1);
				const retried = await runWikiGenerate({ cwd, model: "fixture", retryPending: true, generate: write });
				assert.equal(retried.pending, 0);
				assert.equal(dispatches, 2);
			}
			assert.equal(readWikiMeta(cwd)?.plan?.pages[0]?.attempts, attempts + 1);
		});
	}
	it("requires normal writing when a real failed draft loses a body-only dependency", async () => {
		writeFileSync(join(cwd, "src/helper.ts"), "export const helper = 1;\n");
		await initialize();
		const dir = join(cwd, ".clio-coder/wiki-staging-deleted-dependency");
		mkdirSync(dir);
		const saved = readWikiMeta(cwd)?.plan;
		assert.ok(saved?.pages[0]);
		saved.pages[0].status = "pending";
		saved.pages[0].attempts = 2;
		saved.pages[0].lastFailure = { phase: "writer", detail: "Previous writer failed", runId: "failed-writer" };
		writeWikiPlanFile(dir, saved);
		writeFileSync(join(dir, "a.md"), content("a", 1));
		writeFileSync(join(dir, "b.md"), content("b", 1));
		const failed = await run(
			generator((spec, path) => {
				assert.equal(spec.agentId, "wiki-writer");
				assert.ok(path);
				writeFileSync(path, `${content("a", 1)}See \`src/helper.ts\` and \`src/missing.ts\`.\n`);
			}),
		);
		assert.equal(failed.pending, 1);
		const checkpoint = readWikiMeta(cwd)?.plan?.pages[0];
		assert.equal(checkpoint?.attempts, 3);
		assert.equal(checkpoint?.lastFailure?.phase, "validation");
		assert.ok(checkpoint?.dependencies?.includes("src/helper.ts"));
		rmSync(join(cwd, "src/helper.ts"));
		let calls = 0;
		const retried = await runWikiGenerate({
			cwd,
			model: "fixture",
			retryPending: true,
			generate: generator((spec, path) => {
				assert.equal(spec.agentId, "wiki-writer");
				assert.ok(path);
				calls++;
				writeFileSync(path, content("a", 2));
			}),
		});
		assert.equal(calls, 1);
		assert.equal(retried.pending, 0);
		assert.equal(readWikiMeta(cwd)?.plan?.pages[0]?.attempts, 4);
	});
	it("keeps a non-regular first draft local and admits the next page", async () => {
		await initialize();
		const dir = join(cwd, ".clio-coder/wiki-staging-non-regular");
		mkdirSync(join(dir, "a.md"), { recursive: true });
		const saved = readWikiMeta(cwd)?.plan;
		assert.ok(saved);
		for (const entry of saved.pages) {
			entry.status = "pending";
			entry.lastFailure = { phase: "validation", detail: "Historical gate failure", runId: "successful-writer" };
		}
		writeWikiPlanFile(dir, saved);
		writeFileSync(join(dir, "b.md"), `${content("b", 1)}See \`src/b.ts:999\`.\n`);
		const requests: string[] = [];
		const result = await run(
			generator((spec, path) => {
				assert.ok(path);
				requests.push(path.endsWith("a.md") ? "a" : "b");
				if (path.endsWith("a.md")) {
					assert.equal(spec.agentId, "wiki-writer");
					return 1;
				}
				assert.equal(spec.agentId, "wiki-repair");
				writeFileSync(path, content("b", 2));
			}),
		);
		assert.deepEqual(requests, ["a", "b"]);
		assert.equal(result.status, "generated");
		assert.equal(result.pending, 1);
		assert.equal(readWikiMeta(cwd)?.plan?.pages[0]?.status, "pending");
		assert.equal(readWikiMeta(cwd)?.plan?.pages[1]?.status, "written");
	});
	it("writes a missing validation-failed draft immediately", async () => {
		await initialize();
		const dir = join(cwd, ".clio-coder/wiki-staging-missing");
		mkdirSync(dir);
		const saved = readWikiMeta(cwd)?.plan;
		assert.ok(saved?.pages[0]);
		saved.pages[0].status = "pending";
		saved.pages[0].lastFailure = { phase: "validation", detail: "Historical gate failure", runId: "successful-writer" };
		writeWikiPlanFile(dir, saved);
		writeFileSync(join(dir, "b.md"), content("b", 1));
		let dispatches = 0;
		const result = await run(
			generator((spec, path) => {
				assert.equal(spec.agentId, "wiki-writer");
				assert.ok(path);
				dispatches++;
				writeFileSync(path, content("a", 2));
			}),
		);
		assert.equal(dispatches, 1);
		assert.equal(result.pending, 0);
		assert.equal(readWikiMeta(cwd)?.plan?.pages[0]?.attempts, 2);
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
				true,
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
				const [kept, dropped] = plan.pages;
				assert.ok(kept && dropped);
				// The retired page's sources move onto the survivor so the revision keeps ownership coverage.
				plan.pages = [{ ...kept, intent: "Explain the linked detail", sources: [...kept.sources, ...dropped.sources] }];
				writeWikiPlanFile(dir, plan);
			}),
			true,
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
			true,
		);
		assert.equal(existsSync(join(cwd, ".clio-coder/wiki/b.md")), false);
		assert.equal(readWikiMeta(cwd)?.generation?.pagesWritten, 2);
	});
	it("skips planner and writer dispatch for a complete wiki with unchanged evidence", async () => {
		await initialize();
		const before = readWikiMeta(cwd);
		let dispatches = 0;
		const result = await run(
			generator(() => {
				dispatches++;
			}),
		);
		assert.equal(dispatches, 0);
		assert.equal(result.status, "noop");
		assert.equal(readWikiMeta(cwd)?.contentHash, before?.contentHash);
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
			assert.equal(wikiStaleness(cwd).state, "stale");
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
			true,
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
			true,
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
		assert.equal(wikiStaleness(cwd).state, "stale");
		assert.match(readFileSync(join(cwd, ".clio-coder/wiki/a.md"), "utf8"), /a version 1/u);
	});
	it("updates navigation for new pending pages while preserving existing page content and attempts", async () => {
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
			true,
		);
		assert.equal(result.status, "generated");
		assert.equal(result.pending, 1);
		const after = readWikiMeta(cwd);
		assert.equal(after?.plan?.pages.length, 3);
		assert.equal(after?.plan?.pages[2]?.attempts, 1);
		assert.equal(after?.generation?.pagesWritten, 2);
		assert.notEqual(after?.contentHash, before?.contentHash);
		assert.match(readFileSync(join(cwd, ".clio-coder/wiki/quickstart.md"), "utf8"), /2 complete, 1 pending/);
		const nextAttempts: string[] = [];
		await run(
			generator((_spec, path) => {
				if (path) {
					nextAttempts.push(path);
					return 1;
				}
			}),
			true,
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
		const forged = { ...authored, pages: [{ ...authored.pages[0], completedAfterCap: true }] };
		assert.deepEqual(sanitizeWikiPlan(forged, prior, { trustStatus: false })?.pages, prior.pages);
		const fresh = { ...forged, pages: [{ ...forged.pages[0], lastFailure: undefined }] };
		assert.equal(sanitizeWikiPlan(fresh, undefined, { trustStatus: false })?.pages[0]?.completedAfterCap, undefined);
		assert.equal(sanitizeWikiPlan(fresh, undefined, { trustStatus: true })?.pages[0]?.completedAfterCap, true);
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

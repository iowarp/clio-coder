import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { armInternalDispatchDeadline } from "../../src/cli/internal-dispatch.js";
import { generateWikiWithDocumenter } from "../../src/cli/wiki-generate.js";
import { configureGuardrails } from "../../src/core/guardrails.js";
import { CODEWIKI_VERSION, type Codewiki } from "../../src/domains/context/codewiki/indexer.js";
import type { WikiGenerateInput, WikiGenerationPlan, WikiPlan } from "../../src/domains/context/index.js";
import { readWikiPlanFile, writeWikiPlanFile } from "../../src/domains/context/index.js";
import type { AbortReason, DispatchContract } from "../../src/domains/dispatch/contract.js";
import type { RunReceipt } from "../../src/domains/dispatch/types.js";
import type { JobSpec } from "../../src/domains/dispatch/validation.js";

interface AbortCall {
	runId: string;
	reason?: AbortReason;
}

const EMPTY_CODEWIKI: Codewiki = {
	version: CODEWIKI_VERSION,
	language: "typescript",
	files: [],
	symbols: [],
	edges: [],
};

function plan(...paths: string[]): WikiPlan {
	return {
		version: 1,
		overview: "",
		pages: paths.map((path) => ({
			path,
			title: path.replace(/\.md$/, ""),
			intent: `Document ${path}.`,
			sources: [],
			status: "pending" as const,
			attempts: 0,
		})),
	};
}

function generation(pagePlan: WikiPlan): WikiGenerationPlan {
	return { requestedDepth: "simple", depth: "simple", sourceFiles: 1, sourceLines: 1, plan: pagePlan };
}

function wikiInput(outputDir: string, pagePlan: WikiPlan, cwd = "/tmp"): WikiGenerateInput {
	return {
		cwd,
		mode: "update",
		outputDir,
		codewiki: EMPTY_CODEWIKI,
		generation: generation(pagePlan),
		plan: pagePlan,
		resumed: false,
		unclaimedAreas: [],
	};
}

interface FakeDispatch {
	dispatch: DispatchContract;
	submitted: JobSpec[];
	abortCalls: AbortCall[];
}

/**
 * Dispatch fake driven by a per-call behavior function. Returning "hang" leaves
 * the event stream open until abort, which is what the wall-clock deadline is
 * there to end.
 */
function fakeDispatch(behavior: (spec: JobSpec, call: number) => "hang" | Partial<RunReceipt>): FakeDispatch {
	const submitted: JobSpec[] = [];
	const abortCalls: AbortCall[] = [];
	const dispatch = {
		dispatch: async (spec: JobSpec) => {
			submitted.push(spec);
			const outcome = behavior(spec, submitted.length);
			const runId = `run-${submitted.length}`;
			if (outcome !== "hang") {
				return {
					runId,
					events: (async function* () {
						yield* [];
					})(),
					finalPromise: Promise.resolve({ exitCode: 0, ...outcome } as RunReceipt),
				};
			}
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let settle!: (receipt: RunReceipt) => void;
			const finalPromise = new Promise<RunReceipt>((resolve) => {
				settle = resolve;
			});
			hangs.set(runId, () => {
				release();
				settle({ exitCode: 1, failureMessage: "aborted" } as RunReceipt);
			});
			return {
				runId,
				events: (async function* () {
					await gate;
					yield* [];
				})(),
				finalPromise,
			};
		},
		abort: (runId: string, reason?: AbortReason) => {
			abortCalls.push({ runId, ...(reason !== undefined ? { reason } : {}) });
			hangs.get(runId)?.();
		},
	} as unknown as DispatchContract;
	const hangs = new Map<string, () => void>();
	return { dispatch, submitted, abortCalls };
}

function writePage(outputDir: string, relPath: string, text: string): void {
	const target = join(outputDir, relPath);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, text, "utf8");
}

function withStaging(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "clio-wiki-dispatch-"));
	return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("wiki generation dispatch", () => {
	it("writes one page per dispatch on the wiki-writer recipe", async () => {
		configureGuardrails({ internalDispatchTimeoutMs: 60_000 });
		await withStaging(async (dir) => {
			const pagePlan = plan("architecture.md", "domains/dispatch.md");
			const fake = fakeDispatch((_spec, call) => {
				if (call === 1) writeWikiPlanFile(dir, pagePlan);
				else writePage(dir, call === 2 ? "architecture.md" : "domains/dispatch.md", "# Page\n\nBody.\n");
				return {};
			});

			await generateWikiWithDocumenter(fake.dispatch, wikiInput(dir, pagePlan));

			// One planning dispatch, then one per page. The whole wiki is never a
			// single worker's job, so no single wall clock has to cover it.
			strictEqual(fake.submitted.length, 3);
			deepStrictEqual([...new Set(fake.submitted.map((spec) => spec.agentId))], ["wiki-writer"]);
			for (const spec of fake.submitted) {
				deepStrictEqual([...(spec.denyTools ?? [])], ["git"]);
				deepStrictEqual([...(spec.writeRoots ?? [])], [dir]);
			}
			match(fake.submitted[1]?.task ?? "", /architecture\.md/);
			match(fake.submitted[2]?.task ?? "", /domains\/dispatch\.md/);
		});
		configureGuardrails(undefined);
	});

	it("keeps writing the remaining pages after one page dispatch times out", async () => {
		// The failure this whole design exists to remove: one page that never
		// finishes used to abort the run and delete every page around it.
		configureGuardrails({ internalDispatchTimeoutMs: 40 });
		await withStaging(async (dir) => {
			const pagePlan = plan("a.md", "b.md", "c.md");
			const fake = fakeDispatch((_spec, call) => {
				if (call === 1) return {};
				if (call === 2) return "hang";
				writePage(dir, call === 3 ? "b.md" : "c.md", "# Page\n\nBody.\n");
				return {};
			});

			await generateWikiWithDocumenter(fake.dispatch, wikiInput(dir, pagePlan));

			strictEqual(fake.submitted.length, 4, "the timed-out page does not end the run");
			ok(!existsSync(join(dir, "a.md")), "the page that timed out was not written");
			ok(existsSync(join(dir, "b.md")) && existsSync(join(dir, "c.md")), "the pages after it were");
			strictEqual(fake.abortCalls[0]?.reason?.cause, "timeout", "the abort names the timeout on the receipt");
			const checkpoint = readWikiPlanFile(dir);
			strictEqual(checkpoint?.pages.find((page) => page.path === "a.md")?.status, "pending");
			strictEqual(checkpoint?.pages.find((page) => page.path === "b.md")?.status, "written");
		});
		configureGuardrails(undefined);
	});

	it("records a page as written when the file exists, whatever the receipt says", async () => {
		// The artifact is the postcondition. A writer that wrote its page and then
		// ended on its tool budget produced the page.
		configureGuardrails({ internalDispatchTimeoutMs: 60_000 });
		await withStaging(async (dir) => {
			const pagePlan = plan("a.md");
			const fake = fakeDispatch((_spec, call) => {
				if (call === 1) return {};
				writePage(dir, "a.md", "# A\n\nWritten before the budget ran out.\n");
				return { exitCode: 1, outcomeCode: "worker_tool_call_cap_exhausted" };
			});

			await generateWikiWithDocumenter(fake.dispatch, wikiInput(dir, pagePlan));

			strictEqual(readWikiPlanFile(dir)?.pages[0]?.status, "written");
		});
		configureGuardrails(undefined);
	});

	it("checkpoints the plan after every page so an interrupted run resumes", async () => {
		configureGuardrails({ internalDispatchTimeoutMs: 60_000 });
		await withStaging(async (dir) => {
			const pagePlan = plan("a.md", "b.md");
			const observed: Array<string | undefined> = [];
			const fake = fakeDispatch((_spec, call) => {
				if (call === 1) return {};
				observed.push(readWikiPlanFile(dir)?.pages.find((page) => page.path === "a.md")?.status);
				writePage(dir, call === 2 ? "a.md" : "b.md", "# Page\n\nBody.\n");
				return {};
			});

			await generateWikiWithDocumenter(fake.dispatch, wikiInput(dir, pagePlan));

			// By the time the second page is dispatched, the first is already
			// recorded on disk: the checkpoint is not deferred to the end.
			deepStrictEqual(observed, ["pending", "written"]);
		});
		configureGuardrails(undefined);
	});

	it("stops between pages when the run budget is spent and leaves the rest owed", async () => {
		configureGuardrails({ internalDispatchTimeoutMs: 60_000 });
		await withStaging(async (dir) => {
			const pagePlan = plan("a.md", "b.md", "c.md");
			const progress: string[] = [];
			const fake = fakeDispatch((_spec, call) => {
				if (call === 1) return {};
				writePage(dir, "a.md", "# A\n\nBody.\n");
				return {};
			});

			await generateWikiWithDocumenter(
				fake.dispatch,
				{ ...wikiInput(dir, pagePlan), progress: (event) => progress.push(event.message) },
				{},
				// A budget this small is spent by the time the first page returns.
				1,
			);

			ok(fake.submitted.length < 4, "the budget stops the run short of every page");
			ok(
				progress.some((message) => /run budget reached with \d+ pages? unwritten/.test(message)),
				`the operator is told what remains: ${progress.join(" | ")}`,
			);
		});
		configureGuardrails(undefined);
	});

	it("skips planning on a resumed run and writes only the pages still owed", async () => {
		configureGuardrails({ internalDispatchTimeoutMs: 60_000 });
		await withStaging(async (dir) => {
			const resumed: WikiPlan = {
				...plan("a.md", "b.md"),
				pages: plan("a.md", "b.md").pages.map((page) =>
					page.path === "a.md" ? { ...page, status: "written" as const, attempts: 1 } : page,
				),
			};
			writePage(dir, "a.md", "# A\n\nAlready written.\n");
			const fake = fakeDispatch(() => {
				writePage(dir, "b.md", "# B\n\nBody.\n");
				return {};
			});

			await generateWikiWithDocumenter(fake.dispatch, { ...wikiInput(dir, resumed), plan: resumed, resumed: true });

			// Re-planning a resumed wiki would churn the paths the finished pages
			// already link to, so the plan is settled once per wiki, not per run.
			strictEqual(fake.submitted.length, 1);
			match(fake.submitted[0]?.task ?? "", /b\.md/);
		});
		configureGuardrails(undefined);
	});

	it("falls back to the indexed candidate plan when the planner does not finish", async () => {
		configureGuardrails({ internalDispatchTimeoutMs: 60_000 });
		await withStaging(async (dir) => {
			const pagePlan = plan("a.md");
			const progress: string[] = [];
			const fake = fakeDispatch((_spec, call) => {
				if (call === 1) return { exitCode: 1 };
				writePage(dir, "a.md", "# A\n\nBody.\n");
				return {};
			});

			await generateWikiWithDocumenter(fake.dispatch, {
				...wikiInput(dir, pagePlan),
				progress: (event) => progress.push(event.message),
			});

			ok(progress.includes("planner did not finish; using the indexed candidate plan"));
			strictEqual(fake.submitted.length, 2, "page writing proceeds on the candidate plan");
		});
		configureGuardrails(undefined);
	});

	it("ignores a status a planning pass tries to author for itself", async () => {
		configureGuardrails({ internalDispatchTimeoutMs: 60_000 });
		await withStaging(async (dir) => {
			const pagePlan = plan("a.md");
			const fake = fakeDispatch((_spec, call) => {
				if (call === 1) {
					// A planner claiming its pages are already finished would skip
					// every one of them forever.
					writeFileSync(
						join(dir, "_plan.json"),
						JSON.stringify({ pages: [{ path: "a.md", title: "A", intent: "x", status: "written" }] }),
						"utf8",
					);
					return {};
				}
				writePage(dir, "a.md", "# A\n\nBody.\n");
				return {};
			});

			await generateWikiWithDocumenter(fake.dispatch, wikiInput(dir, pagePlan));

			strictEqual(fake.submitted.length, 2, "the page is still written");
		});
		configureGuardrails(undefined);
	});

	it("gives up on a page after its attempt limit instead of retrying forever", async () => {
		configureGuardrails({ internalDispatchTimeoutMs: 60_000 });
		await withStaging(async (dir) => {
			const exhausted: WikiPlan = {
				...plan("a.md"),
				pages: plan("a.md").pages.map((page) => ({ ...page, attempts: 3 })),
			};
			// A written page is needed so the run counts as resumed and skips planning.
			writePage(dir, "b.md", "# B\n\nBody.\n");
			const withWritten: WikiPlan = {
				...exhausted,
				pages: [...exhausted.pages, { path: "b.md", title: "B", intent: "", sources: [], status: "written", attempts: 1 }],
			};
			const fake = fakeDispatch(() => ({}));

			await generateWikiWithDocumenter(fake.dispatch, {
				...wikiInput(dir, withWritten),
				plan: withWritten,
				resumed: true,
			});

			strictEqual(fake.submitted.length, 0, "a page that has failed its limit is left alone");
		});
		configureGuardrails(undefined);
	});

	it("names a page's anchor sources and its sibling pages in the page prompt", async () => {
		configureGuardrails({ internalDispatchTimeoutMs: 60_000 });
		await withStaging(async (dir) => {
			const pagePlan: WikiPlan = {
				version: 1,
				overview: "",
				pages: [
					{
						path: "domains/dispatch.md",
						title: "Dispatch",
						intent: "Document admission.",
						sources: ["src/domains/dispatch/validation.ts"],
						status: "pending",
						attempts: 0,
					},
					{ path: "cli.md", title: "CLI", intent: "Document the CLI.", sources: [], status: "pending", attempts: 0 },
				],
			};
			const fake = fakeDispatch((_spec, call) => {
				if (call >= 2) writePage(dir, call === 2 ? "domains/dispatch.md" : "cli.md", "# P\n\nBody.\n");
				return {};
			});

			await generateWikiWithDocumenter(fake.dispatch, wikiInput(dir, pagePlan));

			const pageTask = fake.submitted[1]?.task ?? "";
			match(pageTask, /src\/domains\/dispatch\/validation\.ts/, "the anchor sources are named");
			match(pageTask, /cli\.md — CLI/, "the sibling pages a link may point at are named");
			ok(!pageTask.includes("codewiki v"), "the repository-wide digest stays out of a page dispatch");
		});
		configureGuardrails(undefined);
	});
});

describe("internal generator dispatch deadline", () => {
	it("clear() disarms the timer so no late abort fires", async () => {
		configureGuardrails({ internalDispatchTimeoutMs: 10 });
		try {
			const abortCalls: AbortCall[] = [];
			const dispatch = {
				abort: (runId: string, reason?: AbortReason) => abortCalls.push({ runId, ...(reason ? { reason } : {}) }),
			} as unknown as DispatchContract;
			const deadline = armInternalDispatchDeadline(dispatch, "run-deadline-1", "wiki page a.md");
			deadline.clear();
			await new Promise((resolve) => setTimeout(resolve, 30));
			strictEqual(deadline.timedOut(), false);
			strictEqual(abortCalls.length, 0);
			ok(deadline.message().includes("guardrails.internalDispatchTimeoutMs"));
		} finally {
			configureGuardrails(undefined);
		}
	});

	it("lets latency-sensitive callers cap a larger configured deadline", async () => {
		configureGuardrails({ internalDispatchTimeoutMs: 60_000 });
		try {
			const abortCalls: AbortCall[] = [];
			const dispatch = {
				abort: (runId: string, reason?: AbortReason) => abortCalls.push({ runId, ...(reason ? { reason } : {}) }),
			} as unknown as DispatchContract;
			const deadline = armInternalDispatchDeadline(dispatch, "run-deadline-1", "bootstrap scout", process.env, 10);
			await new Promise((resolve) => setTimeout(resolve, 30));
			strictEqual(deadline.timedOut(), true);
			strictEqual(abortCalls.length, 1);
			strictEqual(abortCalls[0]?.reason?.cause, "timeout");
			match(deadline.message(), /latency ceiling/);
			deadline.clear();
		} finally {
			configureGuardrails(undefined);
		}
	});
});

describe("wiki page prompt", () => {
	it("tells a revising writer that the current page is already staged", async () => {
		configureGuardrails({ internalDispatchTimeoutMs: 60_000 });
		await withStaging(async (dir) => {
			const pagePlan = plan("a.md");
			writePage(dir, "a.md", "# A\n\nSeeded.\n");
			const fake = fakeDispatch(() => ({}));

			await generateWikiWithDocumenter(fake.dispatch, wikiInput(dir, pagePlan));

			match(fake.submitted[1]?.task ?? "", /Revision/);
			match(fake.submitted[1]?.task ?? "", /revise it in place/);
			strictEqual(readFileSync(join(dir, "a.md"), "utf8"), "# A\n\nSeeded.\n", "the seed is untouched by dispatch");
		});
		configureGuardrails(undefined);
	});
});

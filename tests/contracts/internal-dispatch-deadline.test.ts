import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { armInternalDispatchDeadline } from "../../src/cli/internal-dispatch.js";
import { generateWikiWithDocumenter } from "../../src/cli/wiki-generate.js";
import { configureGuardrails } from "../../src/core/guardrails.js";
import type { WikiGenerationPlan } from "../../src/domains/context/index.js";
import type { AbortReason, DispatchContract } from "../../src/domains/dispatch/contract.js";
import type { RunReceipt } from "../../src/domains/dispatch/types.js";
import type { JobSpec } from "../../src/domains/dispatch/validation.js";

interface AbortCall {
	runId: string;
	reason?: AbortReason;
}

/**
 * Minimal dispatch fake for the internal generator seam: one run whose event
 * stream stays open until abort, mirroring a worker that keeps streaming
 * without finishing. Abort ends the stream and settles the receipt.
 */
function fakeDispatch(options: { exitCode: number; endImmediately?: boolean }): {
	dispatch: DispatchContract;
	abortCalls: AbortCall[];
} {
	const abortCalls: AbortCall[] = [];
	let releaseEvents!: () => void;
	const eventsGate = new Promise<void>((resolve) => {
		releaseEvents = resolve;
	});
	let resolveFinal!: (receipt: RunReceipt) => void;
	const finalPromise = new Promise<RunReceipt>((resolve) => {
		resolveFinal = resolve;
	});
	const settle = (): void => {
		releaseEvents();
		resolveFinal({ exitCode: options.exitCode, failureMessage: "settled" } as RunReceipt);
	};
	if (options.endImmediately) settle();
	async function* events(): AsyncIterableIterator<unknown> {
		// The stream carries no events; it exists to stay open until settle().
		await eventsGate;
		yield* [];
	}
	const dispatch = {
		dispatch: async () => ({ runId: "run-deadline-1", events: events(), finalPromise }),
		abort: (runId: string, reason?: AbortReason) => {
			abortCalls.push({ runId, ...(reason !== undefined ? { reason } : {}) });
			settle();
		},
	} as unknown as DispatchContract;
	return { dispatch, abortCalls };
}

const SIMPLE_PLAN: WikiGenerationPlan = {
	requestedDepth: "simple",
	depth: "simple",
	sourceFiles: 1,
	sourceLines: 1,
	researchAgents: 0,
	minPages: 0,
	maxPages: 5,
	minPageBytes: 0,
	focusAreas: [],
};
const WIKI_INPUT = {
	cwd: "/tmp",
	mode: "update" as const,
	prompt: "update the wiki",
	outputDir: "/tmp/staging",
	plan: SIMPLE_PLAN,
};

describe("internal generator dispatch deadline", () => {
	it("aborts a run that streams past the deadline and names the timeout in the failure", async () => {
		configureGuardrails({ internalDispatchTimeoutMs: 25 });
		try {
			const { dispatch, abortCalls } = fakeDispatch({ exitCode: 1 });
			await rejects(generateWikiWithDocumenter(dispatch, WIKI_INPUT), (err: Error) => {
				match(err.message, /wiki documenter timed out after \d+s and was aborted/);
				match(err.message, /CLIO_INTERNAL_DISPATCH_TIMEOUT_MS/);
				return true;
			});
			strictEqual(abortCalls.length, 1, "the deadline aborts exactly once");
			strictEqual(abortCalls[0]?.reason?.cause, "timeout", "the receipt-facing abort carries the timeout cause");
		} finally {
			configureGuardrails(undefined);
		}
	});

	it("keeps the plain failure path when the run fails before the deadline", async () => {
		configureGuardrails({ internalDispatchTimeoutMs: 60_000 });
		try {
			const { dispatch, abortCalls } = fakeDispatch({ exitCode: 1, endImmediately: true });
			await rejects(generateWikiWithDocumenter(dispatch, WIKI_INPUT), /wiki documenter failed with exit 1/);
			strictEqual(abortCalls.length, 1, "a non-timeout failure keeps the existing abort");
			strictEqual(abortCalls[0]?.reason, undefined, "a non-timeout abort carries no timeout cause");
		} finally {
			configureGuardrails(undefined);
		}
	});

	it("does not abort a run that completes before the deadline", async () => {
		configureGuardrails({ internalDispatchTimeoutMs: 60_000 });
		try {
			const { dispatch, abortCalls } = fakeDispatch({ exitCode: 0, endImmediately: true });
			await generateWikiWithDocumenter(dispatch, WIKI_INPUT);
			strictEqual(abortCalls.length, 0, "a completed run is never aborted");
		} finally {
			configureGuardrails(undefined);
		}
	});

	it("lets the configured documenter profile choose the thinking level", async () => {
		configureGuardrails({ internalDispatchTimeoutMs: 60_000 });
		try {
			let submitted: JobSpec | null = null;
			const dispatch = {
				dispatch: async (spec: JobSpec) => {
					submitted = spec;
					return {
						runId: "run-profile-1",
						events: (async function* () {
							yield* [];
						})(),
						finalPromise: Promise.resolve({ exitCode: 0 } as RunReceipt),
					};
				},
				abort: () => {},
			} as unknown as DispatchContract;

			await generateWikiWithDocumenter(dispatch, WIKI_INPUT);

			ok(submitted);
			strictEqual("thinkingLevel" in submitted, false);
		} finally {
			configureGuardrails(undefined);
		}
	});

	it("surfaces concise documenter tool progress while draining events", async () => {
		configureGuardrails({ internalDispatchTimeoutMs: 60_000 });
		try {
			const progress: string[] = [];
			const dispatch = {
				dispatch: async () => ({
					runId: "run-progress-1",
					events: (async function* () {
						yield { type: "agent_start" };
						yield { type: "clio_tool_start", payload: { tool: "read" } };
						yield { type: "clio_tool_finish", payload: { tool: "read", outcome: "ok" } };
					})(),
					finalPromise: Promise.resolve({ exitCode: 0 } as RunReceipt),
				}),
				abort: () => {},
			} as unknown as DispatchContract;

			await generateWikiWithDocumenter(dispatch, {
				...WIKI_INPUT,
				progress: (event) => progress.push(`${event.message}|${event.detail ?? ""}`),
			});

			deepStrictEqual(
				progress.map((entry) => entry.replace(/elapsed \d+(ms|s)/, "elapsed <n>")),
				[
					"dispatching primary wiki documenter|direct research",
					"documenter started wiki update|elapsed <n>",
					"documenter made 1 tool attempt|elapsed <n>; read=1",
				],
			);
		} finally {
			configureGuardrails(undefined);
		}
	});

	it("runs one focused completion pass after a deterministic tool-loop failure", async () => {
		configureGuardrails({ internalDispatchTimeoutMs: 60_000 });
		try {
			const submitted: JobSpec[] = [];
			const dispatch = {
				dispatch: async (spec: JobSpec) => {
					submitted.push(spec);
					const attempt = submitted.length;
					return {
						runId: `run-recovery-${attempt}`,
						events: (async function* () {
							yield { type: "agent_start" };
						})(),
						finalPromise: Promise.resolve({
							exitCode: attempt === 1 ? 1 : 0,
							outcomeCode: attempt === 1 ? "loop_guard_tools_disabled_exhausted" : null,
						} as RunReceipt),
					};
				},
				abort: () => {},
			} as unknown as DispatchContract;

			await generateWikiWithDocumenter(dispatch, WIKI_INPUT);

			strictEqual(submitted.length, 2);
			strictEqual(submitted[0]?.task, WIKI_INPUT.prompt);
			match(submitted[1]?.task ?? "", /Focused recovery pass/);
			match(submitted[1]?.task ?? "", /preserve|staged pages/i);
			deepStrictEqual(submitted[1]?.writeRoots, [WIKI_INPUT.outputDir]);
		} finally {
			configureGuardrails(undefined);
		}
	});

	it("launches a mandatory expansion pass when a successful writer leaves detailed breadth incomplete", async () => {
		configureGuardrails({ internalDispatchTimeoutMs: 60_000 });
		try {
			const tasks: string[] = [];
			const dispatch = {
				dispatch: async (spec: JobSpec) => {
					tasks.push(spec.task);
					return {
						runId: `run-breadth-${tasks.length}`,
						events: (async function* () {
							yield* [];
						})(),
						finalPromise: Promise.resolve({ exitCode: 0 } as RunReceipt),
					};
				},
				abort: () => {},
			} as unknown as DispatchContract;

			await generateWikiWithDocumenter(dispatch, {
				...WIKI_INPUT,
				outputDir: "/tmp/clio-wiki-contract-nonexistent",
				plan: { ...SIMPLE_PLAN, depth: "detailed", requestedDepth: "detailed", minPages: 10, maxPages: 16 },
			});

			// Breadth is re-read after every pass, and the attempt bound is what stops
			// the loop. Artifact validation, not this loop, refuses the final shortfall.
			strictEqual(tasks.length, 3);
			strictEqual(tasks[0], WIKI_INPUT.prompt);
			for (const task of tasks.slice(1)) {
				match(task, /Mandatory breadth completion pass/);
				match(task, /not allowed to return a no-op/);
				match(task, /10-16 pages/);
			}
		} finally {
			configureGuardrails(undefined);
		}
	});

	it("hands a staged candidate to artifact validation when recovery ends after successful writes", async () => {
		configureGuardrails({ internalDispatchTimeoutMs: 60_000 });
		try {
			let attempts = 0;
			const progress: string[] = [];
			const dispatch = {
				dispatch: async () => {
					attempts += 1;
					return {
						runId: `run-staged-${attempts}`,
						events: (async function* () {
							yield* [];
						})(),
						finalPromise: Promise.resolve({
							exitCode: 1,
							outcomeCode: attempts === 1 ? "loop_guard_tools_disabled_exhausted" : "worker_tool_call_cap_exhausted",
							toolActivity: {
								calls: 1,
								succeeded: attempts === 1 ? 1 : 0,
								failed: 0,
								blocked: attempts === 1 ? 0 : 1,
								mutatingSucceeded: attempts === 1,
							},
						} as RunReceipt),
					};
				},
				abort: () => {},
			} as unknown as DispatchContract;

			await generateWikiWithDocumenter(dispatch, {
				...WIKI_INPUT,
				progress: (event) => progress.push(event.message),
			});

			strictEqual(attempts, 2);
			ok(progress.includes("documenter stopped after producing a staged candidate; validating artifact"));
		} finally {
			configureGuardrails(undefined);
		}
	});

	it("scales detailed generation through area researchers and briefs one coherent writer", async () => {
		configureGuardrails({ internalDispatchTimeoutMs: 60_000 });
		try {
			const submitted: JobSpec[] = [];
			const dispatch = {
				dispatch: async (spec: JobSpec) => {
					submitted.push(spec);
					const scout = spec.agentId === "scout";
					const failedScoutContract = scout && submitted.length === 1;
					return {
						runId: `run-${submitted.length}`,
						events: (async function* () {
							yield* [];
						})(),
						finalPromise: Promise.resolve({
							exitCode: failedScoutContract ? 1 : 0,
							...(failedScoutContract ? { outcomeCode: "result_contract_exhausted" } : {}),
							...(scout ? { output: { state: "final", text: '{"findings":[]}', bytes: 15, truncated: false } } : {}),
						} as RunReceipt),
					};
				},
				abort: () => {},
			} as unknown as DispatchContract;

			await generateWikiWithDocumenter(
				dispatch,
				{
					...WIKI_INPUT,
					plan: {
						requestedDepth: "detailed",
						depth: "detailed",
						sourceFiles: 1_000,
						sourceLines: 200_000,
						researchAgents: 2,
						minPages: 0,
						maxPages: 16,
						minPageBytes: 0,
						focusAreas: ["src/domains/dispatch", "tests/contracts"],
					},
				},
				{ target: "dynamo", model: "nemotron", thinkingLevel: "high" },
			);

			deepStrictEqual(
				submitted.map((spec) => spec.agentId),
				["scout", "scout", "documenter"],
			);
			strictEqual(submitted[0]?.autonomy, "read-only");
			for (const spec of submitted) {
				strictEqual(spec.target, "dynamo");
				strictEqual(spec.model, "nemotron");
				strictEqual(spec.thinkingLevel, "high");
			}
			match(submitted[2]?.briefing ?? "", /src\/domains\/dispatch/);
			match(submitted[2]?.briefing ?? "", /tests\/contracts/);
		} finally {
			configureGuardrails(undefined);
		}
	});

	it("bounds detailed research to waves of four concurrent scouts", async () => {
		configureGuardrails({ internalDispatchTimeoutMs: 60_000 });
		try {
			const areas = Array.from({ length: 8 }, (_, index) => `src/domains/area-${index}`);
			const progress: string[] = [];
			let scoutsInFlight = 0;
			let peakScoutsInFlight = 0;
			let scoutsDispatched = 0;
			const dispatch = {
				dispatch: async (spec: JobSpec) => {
					const scout = spec.agentId === "scout";
					if (scout) {
						scoutsDispatched += 1;
						scoutsInFlight += 1;
						peakScoutsInFlight = Math.max(peakScoutsInFlight, scoutsInFlight);
					}
					return {
						runId: `run-wave-${scoutsDispatched}`,
						events: (async function* () {
							yield* [];
						})(),
						// Settle on a later macrotask so every researcher in a wave is
						// genuinely concurrent. A coordinator that ignored the wave width
						// would show all eight in flight at once.
						finalPromise: new Promise<RunReceipt>((resolve) => {
							setTimeout(() => {
								if (scout) scoutsInFlight -= 1;
								resolve({
									exitCode: 0,
									...(scout ? { output: { state: "final", text: '{"findings":[]}', bytes: 15, truncated: false } } : {}),
								} as RunReceipt);
							}, 5);
						}),
					};
				},
				abort: () => {},
			} as unknown as DispatchContract;

			await generateWikiWithDocumenter(dispatch, {
				...WIKI_INPUT,
				progress: (event) => progress.push(event.message),
				plan: { ...SIMPLE_PLAN, depth: "detailed", requestedDepth: "detailed", researchAgents: 8, focusAreas: areas },
			});

			strictEqual(scoutsDispatched, 8);
			strictEqual(peakScoutsInFlight, 4);
			ok(progress.includes("starting wiki research wave 1/2"));
			ok(progress.includes("starting wiki research wave 2/2"));
		} finally {
			configureGuardrails(undefined);
		}
	});

	it("runs a deepening pass when the staged wiki meets breadth but leaves thin pages", async () => {
		configureGuardrails({ internalDispatchTimeoutMs: 60_000 });
		const staging = mkdtempSync(join(tmpdir(), "clio-wiki-thin-"));
		try {
			writeFileSync(join(staging, "quickstart.md"), "x".repeat(2_000), "utf8");
			writeFileSync(join(staging, "architecture.md"), "# thin\n", "utf8");
			const tasks: string[] = [];
			const dispatch = {
				dispatch: async (spec: JobSpec) => {
					tasks.push(spec.task);
					return {
						runId: `run-thin-${tasks.length}`,
						events: (async function* () {
							yield* [];
						})(),
						finalPromise: Promise.resolve({ exitCode: 0 } as RunReceipt),
					};
				},
				abort: () => {},
			} as unknown as DispatchContract;

			await generateWikiWithDocumenter(dispatch, {
				...WIKI_INPUT,
				outputDir: staging,
				plan: { ...SIMPLE_PLAN, depth: "detailed", requestedDepth: "detailed", minPages: 2, minPageBytes: 1_200 },
			});

			// The pass names only the thin page, so a deepening request can never be
			// satisfied by padding a page that was already substantive.
			match(tasks[1] ?? "", /Mandatory quality completion pass/);
			match(tasks[1] ?? "", /architecture\.md/);
			ok(!/quickstart\.md is/.test(tasks[1] ?? ""));
		} finally {
			rmSync(staging, { recursive: true, force: true });
			configureGuardrails(undefined);
		}
	});

	it("clear() disarms the timer so no late abort fires", async () => {
		configureGuardrails({ internalDispatchTimeoutMs: 10 });
		try {
			const { dispatch, abortCalls } = fakeDispatch({ exitCode: 0 });
			const deadline = armInternalDispatchDeadline(dispatch, "run-deadline-1", "wiki documenter");
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
			const { dispatch, abortCalls } = fakeDispatch({ exitCode: 1 });
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

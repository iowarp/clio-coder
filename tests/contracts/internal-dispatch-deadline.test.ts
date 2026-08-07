import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { armInternalDispatchDeadline } from "../../src/cli/internal-dispatch.js";
import { generateWikiWithDocumenter } from "../../src/cli/wiki-generate.js";
import { configureGuardrails } from "../../src/core/guardrails.js";
import type { WikiGenerationPlan } from "../../src/domains/context/index.js";
import type { AbortReason, DispatchContract, DispatchRequest } from "../../src/domains/dispatch/contract.js";
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
		const outputDir = mkdtempSync(join(tmpdir(), "clio-wiki-progress-"));
		try {
			const progress: string[] = [];
			const dispatch = {
				dispatch: async () => {
					mkdirSync(outputDir, { recursive: true });
					writeFileSync(join(outputDir, "quickstart.md"), "# Quickstart\n\nValid.\n", "utf8");
					return {
						runId: "run-progress-1",
						events: (async function* () {
							yield { type: "agent_start" };
							yield { type: "clio_tool_start", payload: { tool: "read" } };
							yield { type: "clio_tool_finish", payload: { tool: "read", outcome: "ok" } };
						})(),
						finalPromise: Promise.resolve({ exitCode: 0 } as RunReceipt),
					};
				},
				abort: () => {},
			} as unknown as DispatchContract;

			await generateWikiWithDocumenter(dispatch, {
				...WIKI_INPUT,
				outputDir,
				progress: (event) => progress.push(`${event.message}|${event.detail ?? ""}`),
			});

			deepStrictEqual(
				progress.map((entry) => entry.replace(/elapsed \d+(ms|s)/, "elapsed <n>")),
				[
					"dispatching wiki documenter|single-owner direct research",
					"documenter started wiki update|elapsed <n>",
					"documenter made 1 tool attempt|elapsed <n>; read=1",
				],
			);
		} finally {
			rmSync(outputDir, { recursive: true, force: true });
			configureGuardrails(undefined);
		}
	});

	it("runs one focused completion pass after a deterministic tool-loop failure", async () => {
		configureGuardrails({ internalDispatchTimeoutMs: 60_000 });
		const outputDir = mkdtempSync(join(tmpdir(), "clio-wiki-recovery-"));
		try {
			const submitted: JobSpec[] = [];
			const dispatch = {
				dispatch: async (spec: JobSpec) => {
					submitted.push(spec);
					const attempt = submitted.length;
					if (attempt === 2) {
						mkdirSync(outputDir, { recursive: true });
						writeFileSync(join(outputDir, "quickstart.md"), "# Quickstart\n\nRecovered.\n", "utf8");
					}
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

			await generateWikiWithDocumenter(dispatch, { ...WIKI_INPUT, outputDir });

			strictEqual(submitted.length, 2);
			strictEqual(submitted[0]?.task, WIKI_INPUT.prompt);
			match(submitted[1]?.task ?? "", /Focused recovery pass/);
			match(submitted[1]?.task ?? "", /preserve|staged pages/i);
			deepStrictEqual(submitted[1]?.writeRoots, [outputDir]);
		} finally {
			rmSync(outputDir, { recursive: true, force: true });
			configureGuardrails(undefined);
		}
	});

	it("names why the first call was blocked instead of only counting blocks", async () => {
		configureGuardrails({ internalDispatchTimeoutMs: 60_000 });
		const outputDir = mkdtempSync(join(tmpdir(), "clio-wiki-block-reason-"));
		const progress: string[] = [];
		try {
			const dispatch = {
				dispatch: async () => {
					mkdirSync(outputDir, { recursive: true });
					writeFileSync(join(outputDir, "quickstart.md"), "# Quickstart\n\nValid.\n", "utf8");
					return {
						runId: "run-block-reason",
						events: (async function* () {
							yield {
								type: "clio_tool_finish",
								payload: {
									tool: "read",
									outcome: "blocked",
									reason:
										"loop detected: read was called 3 times with identical arguments among this turn's recent tool calls. Repeating the exact call is blocked.",
								},
							};
						})(),
						finalPromise: Promise.resolve({ exitCode: 0 } as RunReceipt),
					};
				},
				abort: () => {},
			} as unknown as DispatchContract;

			await generateWikiWithDocumenter(dispatch, {
				...WIKI_INPUT,
				outputDir,
				progress: (event) => progress.push(event.detail ?? ""),
			});

			const blockedLine = progress.find((detail) => detail.includes("blocked=1"));
			ok(blockedLine, "the blocked call is reported");
			// A count says a run is in trouble; the reason says which kind of trouble.
			ok(blockedLine?.includes("loop detected"), `the reason rides the progress line: ${blockedLine}`);
			ok((blockedLine?.length ?? 0) < 200, "the line stays one line");
		} finally {
			rmSync(outputDir, { recursive: true, force: true });
			configureGuardrails(undefined);
		}
	});

	it("promotes a valid staged wiki when the last attempt ended on its budget", async () => {
		// The writer stopped the way its budget told it to. What it staged is a
		// candidate like any other, so validation decides; deleting it here threw
		// away a correct wiki because of how its author stopped.
		configureGuardrails({ internalDispatchTimeoutMs: 60_000 });
		const outputDir = mkdtempSync(join(tmpdir(), "clio-wiki-budget-keep-"));
		const progress: string[] = [];
		try {
			const dispatch = {
				dispatch: async () => {
					mkdirSync(outputDir, { recursive: true });
					writeFileSync(join(outputDir, "quickstart.md"), "# Quickstart\n\nStaged before the budget ran out.\n", "utf8");
					return {
						runId: "run-budget-keep",
						events: (async function* () {
							yield* [];
						})(),
						finalPromise: Promise.resolve({
							exitCode: 1,
							outcomeCode: "worker_tool_call_cap_exhausted",
						} as RunReceipt),
					};
				},
				abort: () => {},
			} as unknown as DispatchContract;

			await generateWikiWithDocumenter(dispatch, {
				...WIKI_INPUT,
				outputDir,
				progress: (event) => progress.push(event.message),
			});

			ok(
				progress.includes("documenter ended on its budget; staged wiki passed validation"),
				"the operator is told the promotion rests on validation, not on the writer's exit",
			);
		} finally {
			rmSync(outputDir, { recursive: true, force: true });
			configureGuardrails(undefined);
		}
	});

	it("fails a budget-exhausted run whose staged wiki does not validate", async () => {
		configureGuardrails({ internalDispatchTimeoutMs: 60_000 });
		const outputDir = mkdtempSync(join(tmpdir(), "clio-wiki-budget-invalid-"));
		try {
			const dispatch = {
				dispatch: async () => ({
					runId: "run-budget-invalid",
					events: (async function* () {
						yield* [];
					})(),
					finalPromise: Promise.resolve({
						exitCode: 1,
						outcomeCode: "worker_tool_call_cap_exhausted",
					} as RunReceipt),
				}),
				abort: () => {},
			} as unknown as DispatchContract;

			await rejects(
				generateWikiWithDocumenter(dispatch, { ...WIKI_INPUT, outputDir }),
				/staged wiki also failed validation: quickstart\.md is missing/,
			);
		} finally {
			rmSync(outputDir, { recursive: true, force: true });
			configureGuardrails(undefined);
		}
	});

	it("does not retry when a successful writer produces fewer pages than the depth guidance", async () => {
		configureGuardrails({ internalDispatchTimeoutMs: 60_000 });
		const outputDir = mkdtempSync(join(tmpdir(), "clio-wiki-breadth-"));
		try {
			const submitted: JobSpec[] = [];
			const dispatch = {
				dispatch: async (spec: JobSpec) => {
					submitted.push(spec);
					mkdirSync(outputDir, { recursive: true });
					writeFileSync(join(outputDir, "quickstart.md"), "# Quickstart\n\nOne page.\n", "utf8");
					return {
						runId: `run-breadth-${submitted.length}`,
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
				outputDir,
				plan: { ...SIMPLE_PLAN, depth: "detailed", requestedDepth: "detailed", minPages: 10, maxPages: 16 },
			});

			strictEqual(submitted.length, 1);
		} finally {
			rmSync(outputDir, { recursive: true, force: true });
			configureGuardrails(undefined);
		}
	});

	it("allows one budget recovery and then fails if the recovery also exhausts", async () => {
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

			await rejects(
				generateWikiWithDocumenter(dispatch, {
					...WIKI_INPUT,
					progress: (event) => progress.push(event.message),
				}),
				/wiki documenter failed/,
			);

			strictEqual(attempts, 2);
			ok(progress.includes("documenter budget exhausted; starting focused recovery"));
		} finally {
			configureGuardrails(undefined);
		}
	});

	it("uses the shipped documenter agent for a detailed update", async () => {
		configureGuardrails({ internalDispatchTimeoutMs: 60_000 });
		const outputDir = mkdtempSync(join(tmpdir(), "clio-wiki-update-"));
		try {
			const submitted: JobSpec[] = [];
			const dispatch = {
				dispatch: async (spec: JobSpec) => {
					submitted.push(spec);
					mkdirSync(outputDir, { recursive: true });
					writeFileSync(join(outputDir, "quickstart.md"), "# Quickstart\n\nValid.\n", "utf8");
					return {
						runId: `run-update-${submitted.length}`,
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
				outputDir,
				plan: {
					...SIMPLE_PLAN,
					requestedDepth: "detailed",
					depth: "detailed",
					focusAreas: ["src/domains/dispatch", "tests/contracts"],
				},
			});

			strictEqual(submitted.length, 1);
			strictEqual(submitted[0]?.agentId, "documenter");
			ok(!("assignmentDeadlineAt" in (submitted[0] as DispatchRequest)));
		} finally {
			rmSync(outputDir, { recursive: true, force: true });
			configureGuardrails(undefined);
		}
	});

	it("does not run sequential coverage passes for detailed init", async () => {
		configureGuardrails({ internalDispatchTimeoutMs: 60_000 });
		const outputDir = mkdtempSync(join(tmpdir(), "clio-wiki-init-"));
		try {
			const submitted: JobSpec[] = [];
			const dispatch = {
				dispatch: async (spec: JobSpec) => {
					submitted.push(spec);
					mkdirSync(outputDir, { recursive: true });
					writeFileSync(join(outputDir, "quickstart.md"), "# Quickstart\n\nValid.\n", "utf8");
					return {
						runId: `run-specialist-${submitted.length}`,
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
				mode: "init",
				outputDir,
				plan: {
					...SIMPLE_PLAN,
					requestedDepth: "detailed",
					depth: "detailed",
					focusAreas: ["src/domains/area-0", "src/domains/area-1"],
				},
			});

			strictEqual(submitted.length, 1);
			strictEqual(submitted[0]?.agentId, "documenter");
		} finally {
			rmSync(outputDir, { recursive: true, force: true });
			configureGuardrails(undefined);
		}
	});

	it("feeds deterministic validation failures back to the documenter for repair", async () => {
		configureGuardrails({ internalDispatchTimeoutMs: 60_000 });
		const root = mkdtempSync(join(tmpdir(), "clio-wiki-reference-"));
		const staging = join(root, "staging");
		try {
			writeFileSync(join(root, "source.ts"), "export const live = true;\n", "utf8");
			mkdirSync(staging);
			writeFileSync(join(staging, "quickstart.md"), "# Quickstart\n\nOwner: `src/missing.ts:20`.\n", "utf8");
			writeFileSync(join(staging, "architecture.md"), "# Architecture\n\nSubstantive.\n", "utf8");
			const tasks: string[] = [];
			const dispatch = {
				dispatch: async (spec: JobSpec) => {
					tasks.push(spec.task);
					if (tasks.length === 2) {
						writeFileSync(join(staging, "quickstart.md"), "# Quickstart\n\nSee [Architecture](architecture.md).\n", "utf8");
					}
					return {
						runId: `run-reference-${tasks.length}`,
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
				cwd: root,
				outputDir: staging,
				plan: { ...SIMPLE_PLAN, minPages: 2 },
			});

			strictEqual(tasks.length, 2);
			match(tasks[1] ?? "", /Validation repair pass/);
			match(tasks[1] ?? "", /cites missing source path src\/missing\.ts/);
		} finally {
			rmSync(root, { recursive: true, force: true });
			configureGuardrails(undefined);
		}
	});

	it("does not deepen thin pages because byte floor is guidance, not validation", async () => {
		configureGuardrails({ internalDispatchTimeoutMs: 60_000 });
		const staging = mkdtempSync(join(tmpdir(), "clio-wiki-thin-"));
		try {
			mkdirSync(staging, { recursive: true });
			writeFileSync(join(staging, "quickstart.md"), "# Quickstart\n\nSee [Architecture](architecture.md).\n", "utf8");
			writeFileSync(join(staging, "architecture.md"), "# thin\n", "utf8");
			const submitted: JobSpec[] = [];
			const dispatch = {
				dispatch: async (spec: JobSpec) => {
					submitted.push(spec);
					return {
						runId: `run-thin-${submitted.length}`,
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

			strictEqual(submitted.length, 1);
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

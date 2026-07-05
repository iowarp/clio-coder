import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { armInternalDispatchDeadline } from "../../src/cli/internal-dispatch.js";
import { generateWikiWithDocumenter } from "../../src/cli/wiki-generate.js";
import { configureGuardrails } from "../../src/core/guardrails.js";
import type { AbortReason, DispatchContract } from "../../src/domains/dispatch/contract.js";
import type { RunReceipt } from "../../src/domains/dispatch/types.js";

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

const WIKI_INPUT = { cwd: "/tmp", mode: "update" as const, prompt: "update the wiki", outputDir: "/tmp/staging" };

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

	it("surfaces documenter tool progress while draining events", async () => {
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
					"dispatching internal documenter shadow agent|agent=documenter",
					"documenter started wiki update|elapsed <n>",
					"documenter running read|elapsed <n>",
					"documenter read ok|elapsed <n>",
				],
			);
		} finally {
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
});

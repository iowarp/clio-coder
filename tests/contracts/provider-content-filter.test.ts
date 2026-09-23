import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import {
	affectsTargetBreaker,
	classifyFailure,
	decideRetry,
	isInfrastructureFailure,
} from "../../src/domains/dispatch/failure-classification.js";
import type { RunTerminationEvidence } from "../../src/domains/dispatch/outcome.js";
import type { SpawnedWorker } from "../../src/domains/dispatch/worker-spawn.js";
import inceptionRuntime from "../../src/domains/providers/runtimes/cloud/inception.js";
import { isProviderContentFilter } from "../../src/engine/ai.js";
import { openAICompletionsApiProvider } from "../../src/engine/apis/openai-completions.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

const REFUSAL =
	"I'm sorry, but I can't share details of my architecture or training process. Would you like to learn about how language models work in general instead?";

/** The bytes Inception sent, captured through a logging proxy on 2026-09-23: HTTP 200, one error frame. */
function contentFilterResponse(): Response {
	const frame = { error: { message: REFUSAL, type: "content_filter_error", param: null, code: "content_filter" } };
	return new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

/** An ordinary in-stream error frame, which must keep its message untouched. */
function serverErrorResponse(): Response {
	const frame = { error: { message: "upstream worker crashed", type: "server_error", code: "internal_error" } };
	return new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function mercury(): Model<"openai-completions"> {
	return inceptionRuntime.synthesizeModel(
		{ id: "inception", runtime: "inception", defaultModel: "mercury-2.5" },
		"mercury-2.5",
		null,
	) as Model<"openai-completions">;
}

async function terminalError(response: () => Response): Promise<string | undefined> {
	const events: AssistantMessageEvent[] = [];
	const context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] } as unknown as Context;
	for await (const event of openAICompletionsApiProvider.streamSimple(mercury(), context, {
		apiKey: "test-key",
		fetch: async () => response(),
	})) {
		events.push(event);
	}
	const last = events.at(-1);
	ok(last?.type === "error", JSON.stringify(last));
	strictEqual(last.error.stopReason, "error");
	return last.error.errorMessage;
}

const evidence: RunTerminationEvidence = {
	exitCode: 1,
	abortedByOperator: false,
	stallKilled: false,
	timedOut: false,
	permissionFailure: false,
	policyDenied: null,
	stopReason: null,
};

describe("provider content filter", () => {
	it("names an in-stream content_filter frame as a refusal, not as the model's own words", async () => {
		strictEqual(
			await terminalError(contentFilterResponse),
			`provider content filter refused the response (content_filter): ${REFUSAL}`,
		);
	});

	it("leaves any other in-stream error frame as the provider wrote it", async () => {
		strictEqual(await terminalError(serverErrorResponse), "upstream worker crashed");
	});

	it("recognizes both the rewritten frame and pi's content_filter finish reason", () => {
		ok(isProviderContentFilter(`provider content filter refused the response (content_filter): ${REFUSAL}`));
		ok(isProviderContentFilter("Provider finish_reason: content_filter"));
		strictEqual(isProviderContentFilter(REFUSAL), false);
	});

	it("retries a filtered worker on its own route without charging the target breaker", () => {
		// A scout ends on a structured handoff and writes no stderr, so the provider
		// error message is the only evidence of what happened.
		const failureClass = classifyFailure(
			evidence,
			{ exitCode: 1, signal: null },
			"failed",
			null,
			`provider content filter refused the response (content_filter): ${REFUSAL}`,
		);
		strictEqual(failureClass, "provider-refusal");
		strictEqual(affectsTargetBreaker(failureClass), false);
		strictEqual(isInfrastructureFailure(failureClass), false);
		deepStrictEqual(decideRetry(failureClass, 0, 2), {
			retry: true,
			excludedRouteParts: [],
			qualityEscalation: null,
			reasonCode: "retry-provider-refusal",
		});
		strictEqual(decideRetry(failureClass, 2, 2).retry, false);
		strictEqual(
			classifyFailure(
				evidence,
				{
					exitCode: 1,
					signal: null,
					stderrTail: "[worker] agent ended with stopReason=error: Provider finish_reason: content_filter",
				},
				"failed",
				null,
			),
			"provider-refusal",
		);
	});

	it("keeps an unfiltered provider failure on the path it took before", () => {
		strictEqual(classifyFailure(evidence, { exitCode: 1, signal: null }, "failed", null, REFUSAL), "worker-runtime");
		strictEqual(classifyFailure(evidence, { exitCode: 1, signal: null }, "failed", null), "worker-runtime");
	});
});

describe("a filtered worker in dispatch", () => {
	beforeEach(() => isolateDispatchState());
	afterEach(() => restoreDispatchState());

	it("leaves the target breaker closed after the provider's filter stops a worker", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.fleet.retry.maxRetries = 0;
		let spawned = 0;
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			heartbeatIntervalMs: 3_600_000,
			spawnWorker: () => {
				spawned += 1;
				const worker: SpawnedWorker = {
					pid: null,
					promise: Promise.resolve({ exitCode: 1, signal: null }),
					heartbeatAt: { current: Date.now(), monotonic: performance.now() },
					abort: () => {},
					send: () => true,
					events: (async function* () {
						yield {
							type: "message_end",
							message: {
								role: "assistant",
								content: [],
								stopReason: "error",
								usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
								errorMessage: `provider content filter refused the response (content_filter): ${REFUSAL}`,
							},
						};
					})(),
				};
				return worker;
			},
		});
		await bundle.extension.start();
		try {
			const request = {
				agentId: "scout",
				executionRole: "researcher" as const,
				task: "Inspect isolated fixture evidence.",
				requestOrigin: "internal" as const,
				resultContractOverride: { kind: "provenance-report" as const },
			};
			const first = await bundle.contract.dispatch(request);
			strictEqual((await first.finalPromise).outcome, "failed");
			deepStrictEqual(bundle.contract.routeBreakers?.(), []);
			const second = await bundle.contract.dispatch(request);
			await second.finalPromise;
			strictEqual(spawned, 2, "the second dispatch reached a worker instead of a cooling-down refusal");
		} finally {
			await bundle.extension.stop?.();
		}
	});
});

describe("a structured-handoff worker's provider error", () => {
	it("classifies from the provider message when the worker wrote no stderr", () => {
		const classify = (message: string) =>
			classifyFailure(evidence, { exitCode: 1, signal: null }, "failed", null, message);
		strictEqual(
			classify('429: {"message":"Rate limit reached: input token limit exceeded","type":"rate_limit_error"}'),
			"target-rate-limit",
		);
		strictEqual(classify("401 Unauthorized"), "target-auth");
		strictEqual(classify("Request timed out."), "target-transient");
		strictEqual(classify("Connection error."), "target-transient");
		strictEqual(
			classify("exceed_context_size_error: request (9000 tokens) exceeds the available context size (8192 tokens)"),
			"deterministic-task",
		);
	});
});

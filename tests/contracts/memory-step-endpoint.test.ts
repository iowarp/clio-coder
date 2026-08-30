import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { BusChannels, type MemoryStepCompletedPayload } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { TaskMemoryBank } from "../../src/domains/memory/task-bank.js";
import { createMemoryInterventionRegistration } from "../../src/domains/middleware/memory-intervention.js";
import { announceMemoryStepEndpoint } from "../../src/domains/middleware/memory-step-endpoint.js";
import { foregroundStreamUsage, registerForegroundStream } from "../../src/domains/providers/index.js";

const ENDPOINT_KEY = "http://192.168.86.141:8080";

function recorder() {
	const bus = createSafeEventBus();
	const seen: MemoryStepCompletedPayload[] = [];
	bus.on(BusChannels.MemoryStepCompleted, (payload) => {
		seen.push(payload);
	});
	return { bus, seen };
}

/**
 * The disturbance is caused by the request leaving the process, not by the
 * answer coming back: a llama.cpp prefill runs to completion whether or not the
 * client is still listening. So every path out of `complete` announces once,
 * and a boundary that never called `complete` announces nothing.
 */
describe("contracts/memory step endpoint announcement", () => {
	it("announces once when the step resolves", async () => {
		const { bus, seen } = recorder();
		const complete = announceMemoryStepEndpoint({ bus, endpointKey: ENDPOINT_KEY, targetId: "mini" }, async () => ({
			text: "<no_intervention/>",
		}));

		const result = await complete({});

		strictEqual(result.text, "<no_intervention/>");
		deepStrictEqual(seen, [{ endpointKey: ENDPOINT_KEY, targetId: "mini" }]);
	});

	it("announces once when the transport aborts on the intervention timeout", async () => {
		const { bus, seen } = recorder();
		const abort = new Error("The operation was aborted");
		abort.name = "AbortError";
		const complete = announceMemoryStepEndpoint({ bus, endpointKey: ENDPOINT_KEY, targetId: "mini" }, async () => {
			throw abort;
		});

		await rejects(complete({}), (error: Error) => error.name === "AbortError");

		deepStrictEqual(seen, [{ endpointKey: ENDPOINT_KEY, targetId: "mini" }]);
	});

	it("announces once when the transport throws for any other reason", async () => {
		const { bus, seen } = recorder();
		const complete = announceMemoryStepEndpoint({ bus, endpointKey: ENDPOINT_KEY, targetId: "mini" }, async () => {
			throw new Error("fetch failed");
		});

		await rejects(complete({}), /fetch failed/);

		strictEqual(seen.length, 1);
	});

	/**
	 * The route decides the endpoint once; a step that both resolves and reports
	 * usage must not be counted twice now that the usage sink no longer emits.
	 */
	it("announces exactly once per request across repeated steps", async () => {
		const { bus, seen } = recorder();
		const complete = announceMemoryStepEndpoint({ bus, endpointKey: ENDPOINT_KEY, targetId: "mini" }, async () => ({
			text: "ok",
			usage: { input: 10, output: 2 },
		}));

		await complete({});
		await complete({});

		strictEqual(seen.length, 2);
	});

	it("announces nothing when the route has no canonical endpoint", async () => {
		const { bus, seen } = recorder();
		const complete = announceMemoryStepEndpoint({ bus, endpointKey: null, targetId: "mini" }, async () => ({
			text: "ok",
		}));

		await complete({});

		strictEqual(seen.length, 0);
	});

	/**
	 * A skipped boundary sent no bytes, so the chat target's prefix cache is
	 * untouched and the next turn owes no explanation. The wrapper gets this for
	 * free by sitting on `complete`, which `endpoint_busy` never reaches.
	 */
	it("announces nothing for an endpoint_busy skip", async () => {
		const { bus, seen } = recorder();
		const release = registerForegroundStream(ENDPOINT_KEY);
		try {
			let modelCalls = 0;
			const registration = createMemoryInterventionRegistration({
				bank: new TaskMemoryBank(),
				telemetry: { record: () => {} },
				getModelClient: () => ({
					complete: announceMemoryStepEndpoint({ bus, endpointKey: ENDPOINT_KEY, targetId: "mini" }, async () => {
						modelCalls += 1;
						return { text: "<operations>[]</operations>\n<no_intervention/>" };
					}),
				}),
				backgroundEndpointBusy: () => (foregroundStreamUsage()[ENDPOINT_KEY] ?? 0) > 0,
			});

			const skipped = await registration.runPromptedStep({ deterministicTrigger: true, task: "busy endpoint" });

			strictEqual(skipped.reason, "endpoint_busy");
			strictEqual(modelCalls, 0);
			strictEqual(seen.length, 0);

			release();
			await registration.runPromptedStep({ deterministicTrigger: true, task: "free endpoint" });

			strictEqual(modelCalls, 1);
			deepStrictEqual(seen, [{ endpointKey: ENDPOINT_KEY, targetId: "mini" }]);
		} finally {
			// registerForegroundStream hands back an idempotent release.
			release();
		}
	});

	/**
	 * The failure F2 describes end to end at the seam: the policy resolves a
	 * timed-out step with `usage: null`, so the usage sink hears nothing, and the
	 * announcement has to have already happened inside the client.
	 */
	it("announces a timed-out step the usage sink never sees", async () => {
		const { bus, seen } = recorder();
		const registration = createMemoryInterventionRegistration({
			bank: new TaskMemoryBank(),
			telemetry: { record: () => {} },
			getModelClient: () => ({
				complete: announceMemoryStepEndpoint(
					{ bus, endpointKey: ENDPOINT_KEY, targetId: "mini" },
					async (request: { signal?: AbortSignal }) =>
						await new Promise<{ text: string }>((_resolve, reject) => {
							request.signal?.addEventListener("abort", () => {
								const abort = new Error("The operation was aborted");
								abort.name = "AbortError";
								reject(abort);
							});
						}),
				),
			}),
			timeoutMs: 20,
			onStepUsage: () => {
				ok(false, "a timed-out step reports no usage");
			},
		});

		const result = await registration.runPromptedStep({ deterministicTrigger: true, task: "slow endpoint" });

		strictEqual(result.usage, null);
		deepStrictEqual(seen, [{ endpointKey: ENDPOINT_KEY, targetId: "mini" }]);
	});
});

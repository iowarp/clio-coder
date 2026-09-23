/**
 * Dispatch routing never waits on a decision model.
 *
 * With the `routing` site bound, admission used to await the decision model on
 * every dispatch, for up to 3s, before a worker could start. Routing now runs
 * on the rules alone, so a bound site, however slow, sees no request from
 * dispatch and the worker starts as it would unbound.
 */

import { ok, strictEqual } from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DispatchRequest } from "../../src/domains/dispatch/contract.js";
import type { SpawnedWorker } from "../../src/domains/dispatch/worker-spawn.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import typesafeJevRuntime from "../../src/domains/providers/runtimes/cloud/typesafe-jev.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { closeServer } from "../harness/openai-compat-fixture.js";

beforeEach(() => isolateDispatchState());
afterEach(() => restoreDispatchState());

const REQUEST: DispatchRequest = {
	agentId: "scout",
	executionRole: "researcher",
	task: "Map how the footer renders dispatch notices.",
	requestOrigin: "internal",
	resultContractOverride: { kind: "provenance-report" },
};

/** A decision endpoint that answers every question, 2.5s late. */
async function slowJev(): Promise<{ server: Server; url: string; requests: () => number }> {
	let requests = 0;
	const server = createServer((req, res) => {
		requests += 1;
		req.resume();
		setTimeout(() => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ model: "jev-fixture", answers: {} }));
		}, 2_500);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests: () => requests };
}

async function spawnDelayMs(bindRouting: boolean, jevUrl: string): Promise<number> {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.fleet.retry.maxRetries = 0;
	settings.targets = [
		{ id: "default", runtime: "openai", defaultModel: "gpt-4o" },
		{ id: "jev", runtime: "typesafe-jev", url: jevUrl, defaultModel: "jev-latest" },
	];
	settings.fleet.default = { target: "default", model: "gpt-4o", thinkingLevel: "off" };
	settings.fleet.profiles["system-one"] = { target: "jev", model: "jev-latest", thinkingLevel: "off" };
	if (bindRouting) settings.fleet.decisionProfiles = { routing: "system-one" };
	const context = dispatchStubContext({ settings });
	const providers = context.getContract<ProvidersContract>("providers");
	ok(providers);
	const stubRuntime = providers.getRuntime.bind(providers);
	providers.getRuntime = (id) => (id === typesafeJevRuntime.id ? typesafeJevRuntime : stubRuntime(id));
	let spawnedAt = 0;
	const bundle = makeDispatchBundle(context, {
		heartbeatIntervalMs: 3_600_000,
		spawnWorker: () => {
			spawnedAt = performance.now();
			const worker: SpawnedWorker = {
				pid: null,
				promise: Promise.resolve({ exitCode: 0, signal: null }),
				heartbeatAt: { current: Date.now(), monotonic: performance.now() },
				abort: () => {},
				send: () => true,
				events: (async function* () {
					yield {
						type: "message_end",
						message: {
							role: "assistant",
							stopReason: "stop",
							content: JSON.stringify({ confirmedFacts: [], missingEvidence: [], nextInspections: [] }),
						},
					};
				})(),
			};
			return worker;
		},
	});
	await bundle.extension.start();
	try {
		const startedAt = performance.now();
		const run = await bundle.contract.dispatch(REQUEST);
		await run.finalPromise;
		ok(spawnedAt > 0, "the worker was spawned");
		return spawnedAt - startedAt;
	} finally {
		await bundle.extension.stop?.();
	}
}

it("admits a dispatch without asking a bound routing site", { timeout: 20_000 }, async () => {
	const jev = await slowJev();
	try {
		const unbound = await spawnDelayMs(false, jev.url);
		const bound = await spawnDelayMs(true, jev.url);
		strictEqual(jev.requests(), 0, "dispatch sent the decision model a request");
		ok(
			bound < 1_500,
			`a bound routing site delayed the spawn to ${Math.round(bound)}ms (unbound ${Math.round(unbound)}ms)`,
		);
	} finally {
		await closeServer(jev.server);
	}
});

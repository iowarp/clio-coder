import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Model } from "@earendil-works/pi-ai";

import { resetLmStudioHostCatalogs } from "../../src/domains/providers/runtimes/common/lmstudio-http.js";
import lmstudioRuntime from "../../src/domains/providers/runtimes/local-native/lmstudio.js";
import type { ProbeContext } from "../../src/domains/providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";
import { resetAnnouncedResidencyFacts } from "../../src/engine/apis/lmstudio.js";
import { openAICompletionsApiProvider } from "../../src/engine/apis/openai-completions.js";
import { type ResidencyNotice, resetResidencyState, setResidencyNoticeSink } from "../../src/engine/apis/residency.js";
import { type FakeLmStudioFixture, startFakeLmStudioServer } from "../harness/fake-lmstudio-server.js";

const fixtures: FakeLmStudioFixture[] = [];
const probeContext: ProbeContext = { credentialsPresent: new Set<string>(), httpTimeoutMs: 2_000 };

afterEach(async () => {
	setResidencyNoticeSink(null);
	resetResidencyState();
	resetLmStudioHostCatalogs();
	resetAnnouncedResidencyFacts();
	await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

async function fake(hostIdentity: "dynamo" | "zbook", servedModel?: string): Promise<FakeLmStudioFixture> {
	const fixture = await startFakeLmStudioServer({ hostIdentity, ...(servedModel ? { servedModel } : {}) });
	fixtures.push(fixture);
	return fixture;
}

function target(
	server: FakeLmStudioFixture,
	id: "dynamo" | "zbook",
	defaultModel = `qwen3.8-27b-${id}`,
): TargetDescriptor {
	return { id, runtime: "lmstudio", url: server.url, defaultModel };
}

function model(descriptor: TargetDescriptor, requestedId: string): Model<"openai-completions"> {
	return lmstudioRuntime.synthesizeModel(descriptor, requestedId, null) as Model<"openai-completions">;
}

async function drainChat(descriptor: TargetDescriptor, requestedId: string): Promise<Array<Record<string, unknown>>> {
	const events: Array<Record<string, unknown>> = [];
	const stream = openAICompletionsApiProvider.streamSimple(
		model(descriptor, requestedId),
		{ messages: [{ role: "user", content: "hello", timestamp: 0 }] },
		{ apiKey: "lm-studio" },
	);
	for await (const event of stream) events.push(event as unknown as Record<string, unknown>);
	return events;
}

describe("contracts/lmstudio host and instance identity", () => {
	it("replays the LM Link v0 listing with two loaded instances and one unloaded bare key", async () => {
		const server = await fake("dynamo");
		const response = await fetch(`${server.url}/api/v0/models`);
		const body = (await response.json()) as { data: Array<{ id: string; state: string }> };
		deepStrictEqual(
			body.data.slice(0, 3).map(({ id, state }) => ({ id, state })),
			[
				{ id: "qwen3.8-27b-dynamo", state: "loaded" },
				{ id: "qwen3.8-27b-zbook", state: "loaded" },
				{ id: "qwen3.8-27b", state: "not-loaded" },
			],
		);
	});

	it("resolves a bare key to each host default without loading another instance", async () => {
		const dynamoServer = await fake("dynamo");
		const zbookServer = await fake("zbook");
		const dynamo = target(dynamoServer, "dynamo");
		const zbook = target(zbookServer, "zbook");
		await lmstudioRuntime.probe?.(dynamo, probeContext);
		await lmstudioRuntime.probe?.(zbook, probeContext);

		await drainChat(dynamo, "qwen3.8-27b");
		await drainChat(zbook, "qwen3.8-27b");

		strictEqual(dynamoServer.requestsFor("/v1/chat/completions").at(-1)?.body?.model, "qwen3.8-27b-dynamo");
		strictEqual(zbookServer.requestsFor("/v1/chat/completions").at(-1)?.body?.model, "qwen3.8-27b-zbook");
		strictEqual(dynamoServer.requestsFor("/api/v1/models/load").length, 0);
		strictEqual(zbookServer.requestsFor("/api/v1/models/load").length, 0);
	});

	it("offers instances before unloaded keys and suppresses a resident bare key", async () => {
		const dynamoServer = await fake("dynamo");
		const dynamo = target(dynamoServer, "dynamo");
		const result = await lmstudioRuntime.probe?.(dynamo, probeContext);
		ok(result?.ok, result?.error);
		deepStrictEqual(result.models?.slice(0, 3), ["qwen3.8-27b-dynamo", "qwen3.8-27b-zbook", "coder-unloaded"]);
		strictEqual(result.models?.includes("qwen3.8-27b"), false);
		strictEqual(result.modelStates?.["coder-unloaded"]?.state, "unloaded");
		strictEqual(result.modelStates?.["coder-unloaded"]?.detail, "not loaded (LM Studio will load it on first use)");
	});

	it("keeps server JIT behavior for a catalogued key with no instances", async () => {
		const server = await fake("dynamo");
		const descriptor = target(server, "dynamo");
		await drainChat(descriptor, "coder-unloaded");
		strictEqual(server.requestsFor("/v1/chat/completions").at(-1)?.body?.model, "coder-unloaded");
		strictEqual(server.requestsFor("/api/v1/models/load").length, 0);
	});

	it("flags an explicitly selected cross-host instance as an LM Link peer", async () => {
		const dynamoServer = await fake("dynamo");
		const zbookServer = await fake("zbook");
		const dynamo = target(dynamoServer, "dynamo");
		const zbook = target(zbookServer, "zbook");
		await lmstudioRuntime.probe?.(dynamo, probeContext);
		await lmstudioRuntime.probe?.(zbook, probeContext);
		const refreshed = await lmstudioRuntime.probe?.(dynamo, probeContext);
		match(refreshed?.modelStates?.["qwen3.8-27b-zbook"]?.detail ?? "", /also loaded on zbook/);

		const notices: ResidencyNotice[] = [];
		setResidencyNoticeSink((notice) => notices.push(notice));
		await drainChat(dynamo, "qwen3.8-27b-zbook");
		ok(notices.some((notice) => notice.level === "warning" && notice.message.includes("LM Link peer")));
		strictEqual(dynamoServer.requestsFor("/v1/chat/completions").at(-1)?.body?.model, "qwen3.8-27b-zbook");
	});

	/**
	 * Residency runs before every request and the same facts held every turn,
	 * so the peer warning printed once per turn (issue #185). One fact, one
	 * notice per process; and the response's own `model` field is what names
	 * the instance that answered, which the footer and usage ledger read as
	 * `responseModel` when it differs from the request.
	 */
	it("warns about an LM Link peer once per process and records the served id", async () => {
		const dynamoServer = await fake("dynamo", "ornith-1.5-35b-a3b");
		const zbookServer = await fake("zbook");
		const dynamo = target(dynamoServer, "dynamo");
		await lmstudioRuntime.probe?.(dynamo, probeContext);
		await lmstudioRuntime.probe?.(target(zbookServer, "zbook"), probeContext);
		resetAnnouncedResidencyFacts();

		const notices: ResidencyNotice[] = [];
		setResidencyNoticeSink((notice) => notices.push(notice));
		const first = await drainChat(dynamo, "qwen3.8-27b-zbook");
		await drainChat(dynamo, "qwen3.8-27b-zbook");
		await drainChat(dynamo, "qwen3.8-27b-zbook");
		const peerWarnings = notices.filter(
			(notice) => notice.level === "warning" && notice.message.includes("LM Link peer"),
		);
		strictEqual(peerWarnings.length, 1, `one warning for three turns: ${JSON.stringify(notices.map((n) => n.message))}`);
		ok(peerWarnings[0]?.message.includes("'qwen3.8-27b-zbook'"), peerWarnings[0]?.message);
		ok(peerWarnings[0]?.message.includes("also loaded on zbook"), peerWarnings[0]?.message);
		strictEqual(peerWarnings[0]?.detail?.requestedModel, "qwen3.8-27b-zbook");

		const done = first.find((event) => event.type === "done") as { message?: { responseModel?: unknown } } | undefined;
		strictEqual(done?.message?.responseModel, "ornith-1.5-35b-a3b", "the served id rides on the assistant message");
	});

	it("refuses an unadvertised model before the completion endpoint is called", async () => {
		const server = await fake("dynamo");
		const events = await drainChat(target(server, "dynamo"), "qwen3.6-27b");
		const error = events.find((event) => event.type === "error") as { error?: { errorMessage?: string } } | undefined;
		match(error?.error?.errorMessage ?? "", /Resident instances: qwen3\.8-27b-dynamo, qwen3\.8-27b-zbook/);
		strictEqual(server.requestsFor("/v1/chat/completions").length, 0);
	});
});

import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { residentModelsSummary } from "../../src/cli/targets.js";
import {
	ensureLlamaCppResidency,
	type LlamaCppResidencyInput,
	parseLlamaCppResident,
	parseLlamaCppResidentModels,
	parseLlamaCppRouterProps,
	resetLlamaCppResidencyState,
} from "../../src/engine/apis/llamacpp-residency.js";
import {
	type ResidencyNotice,
	setProtectedModelsProvider,
	setResidencyNoticeSink,
} from "../../src/engine/apis/residency.js";

const SCOUT = "MiniCPM5-1B-Q8_0-131K";
const CODER = "Qwopus3.6-35B-A3B-Coder-MTP-Q4_K_M-262K";

function modelsPayload(entries: Array<{ id: string; state: string; tags?: string[] }>): unknown {
	return {
		data: entries.map((entry) => ({
			id: entry.id,
			object: "model",
			status: { value: entry.state },
			...(entry.tags ? { tags: entry.tags } : {}),
		})),
	};
}

function jsonResponse(payload: unknown): Response {
	return new Response(JSON.stringify(payload), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

interface RouterCall {
	url: string;
	method: string;
	body?: unknown;
}

/**
 * Minimal stateful fake of the mini router: /v1/models reflects load state,
 * /props advertises capacity, POST /models/load|unload mutate the state.
 */
function fakeRouter(initial: Array<{ id: string; state: string; tags?: string[] }>, maxInstances?: number) {
	const states = new Map(initial.map((entry) => [entry.id, entry.state]));
	const tags = new Map(initial.map((entry) => [entry.id, entry.tags ?? []]));
	const calls: RouterCall[] = [];
	const fetchImpl = (async (url: unknown, init?: RequestInit) => {
		const href = String(url);
		const method = init?.method ?? "GET";
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		calls.push({ url: href, method, body });
		if (href.endsWith("/v1/models")) {
			return jsonResponse(
				modelsPayload([...states.entries()].map(([id, state]) => ({ id, state, tags: tags.get(id) ?? [] }))),
			);
		}
		if (href.endsWith("/props")) {
			return jsonResponse(maxInstances === undefined ? {} : { max_instances: maxInstances });
		}
		if (href.endsWith("/models/load")) {
			states.set(String(body.model), "loaded");
			return jsonResponse({ ok: true });
		}
		if (href.endsWith("/models/unload")) {
			states.set(String(body.model), "unloaded");
			return jsonResponse({ ok: true });
		}
		throw new Error(`unexpected fetch ${method} ${href}`);
	}) as typeof fetch;
	const posts = () => calls.filter((call) => call.method === "POST").map((call) => [call.url, call.body]);
	return { fetchImpl, calls, posts, states };
}

/**
 * A load rejection whose following `/v1/models` snapshots are scripted. The
 * first listing is always the stale `unloaded` snapshot that made Clio POST;
 * later entries model the router's state after its own wake raced that POST.
 */
function rejectingLoadRouter(input: { status: number; body: string; statesAfterPost: string[] }) {
	const modelId = "race-model";
	const calls: RouterCall[] = [];
	let modelReads = 0;
	const fetchImpl = (async (url: unknown, init?: RequestInit) => {
		const href = String(url);
		const method = init?.method ?? "GET";
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		calls.push({ url: href, method, body });
		if (href.endsWith("/v1/models")) {
			const laterIndex = Math.min(Math.max(0, modelReads - 1), Math.max(0, input.statesAfterPost.length - 1));
			const state = modelReads === 0 ? "unloaded" : (input.statesAfterPost[laterIndex] ?? "unloaded");
			modelReads += 1;
			return jsonResponse(modelsPayload([{ id: modelId, state }]));
		}
		if (href.endsWith("/props")) return jsonResponse({ max_instances: 1 });
		if (href.endsWith("/models/load")) {
			return new Response(input.body, {
				status: input.status,
				headers: { "content-type": "application/json" },
			});
		}
		throw new Error(`unexpected fetch ${method} ${href}`);
	}) as typeof fetch;
	return { fetchImpl, calls, modelId, modelReads: () => modelReads };
}

function ensureInput(fetchImpl: typeof fetch, keepModelId: string, managed = true): LlamaCppResidencyInput {
	return {
		baseUrl: "http://mini:8080/v1",
		targetId: "mini",
		runtimeId: "llamacpp",
		keepModelId,
		managed,
		fetchImpl,
		withLock: async (_targetKey, fn) => fn(),
	};
}

describe("contracts/llamacpp router residency", () => {
	let notices: ResidencyNotice[];

	beforeEach(() => {
		resetLlamaCppResidencyState();
		notices = [];
		setResidencyNoticeSink((notice) => notices.push(notice));
	});

	afterEach(() => {
		setResidencyNoticeSink(null);
		setProtectedModelsProvider(null);
		resetLlamaCppResidencyState();
	});

	it("parses resident ids from the router models payload", () => {
		const payload = modelsPayload([
			{ id: "coder", state: "loaded" },
			{ id: "warming", state: "loading", tags: ["role:scout"] },
			{ id: "cold", state: "unloaded" },
		]);
		deepStrictEqual(parseLlamaCppResident(payload), ["coder", "warming"]);
		deepStrictEqual(parseLlamaCppResidentModels(payload), [
			{ id: "coder", tags: [] },
			{ id: "warming", tags: ["role:scout"] },
		]);
		deepStrictEqual(parseLlamaCppResident({}), []);
		deepStrictEqual(parseLlamaCppResident(null), []);
		deepStrictEqual(parseLlamaCppResident({ data: [{ id: 42 }] }), []);
	});

	it("parses router capacity from /props", () => {
		deepStrictEqual(parseLlamaCppRouterProps({ max_instances: 2 }), { maxInstances: 2 });
		deepStrictEqual(parseLlamaCppRouterProps({ max_instances: 0 }), {});
		deepStrictEqual(parseLlamaCppRouterProps({ max_instances: "2" }), {});
		deepStrictEqual(parseLlamaCppRouterProps(null), {});
	});

	it("scout-as-keep never evicts the co-resident coder within capacity (the shipped regression)", async () => {
		const router = fakeRouter(
			[
				{ id: SCOUT, state: "loaded", tags: ["role:scout", "pinned:true"] },
				{ id: CODER, state: "loaded", tags: ["role:code"] },
			],
			2,
		);

		await ensureLlamaCppResidency(ensureInput(router.fetchImpl, SCOUT));

		deepStrictEqual(router.posts(), [], "a scout turn with both models resident must not touch the router");
		strictEqual(router.states.get(CODER), "loaded");
	});

	it("coder-as-keep leaves the pinned scout resident within capacity", async () => {
		const router = fakeRouter(
			[
				{ id: SCOUT, state: "loaded", tags: ["role:scout", "pinned:true"] },
				{ id: CODER, state: "loaded", tags: ["role:code"] },
			],
			2,
		);

		await ensureLlamaCppResidency(ensureInput(router.fetchImpl, CODER));

		deepStrictEqual(router.posts(), []);
		strictEqual(router.states.get(SCOUT), "loaded");
	});

	it("loads into a free slot without evicting anything", async () => {
		const router = fakeRouter(
			[
				{ id: SCOUT, state: "loaded", tags: ["role:scout", "pinned:true"] },
				{ id: CODER, state: "unloaded", tags: ["role:code"] },
			],
			2,
		);

		await ensureLlamaCppResidency(ensureInput(router.fetchImpl, CODER));

		deepStrictEqual(router.posts(), [["http://mini:8080/models/load", { model: CODER }]]);
		strictEqual(router.states.get(SCOUT), "loaded");
		strictEqual(notices[0]?.kind, "co-resident");
	});

	it("treats a rejected load followed by a loading snapshot as the router wake race", async () => {
		const router = rejectingLoadRouter({
			status: 500,
			body: '{"error":{"message":"wake already claimed the slot"}}',
			statesAfterPost: ["loading", "loaded"],
		});

		await ensureLlamaCppResidency(ensureInput(router.fetchImpl, router.modelId));

		strictEqual(router.modelReads(), 3, "the rejection is re-read once, then the ordinary loaded wait completes");
		strictEqual(router.calls.filter((call) => call.method === "POST" && call.url.endsWith("/models/load")).length, 1);
	});

	it("treats the router's already-running rejection as an in-progress load", async () => {
		const router = rejectingLoadRouter({
			status: 400,
			body: '{"error":{"code":400,"message":"model is already running"}}',
			// The body itself wins even when the immediate confirming snapshot is
			// still stale; the normal wait observes the completed wake next.
			statesAfterPost: ["unloaded", "loaded"],
		});

		await ensureLlamaCppResidency(ensureInput(router.fetchImpl, router.modelId));

		strictEqual(router.modelReads(), 3);
	});

	it("preserves a real load rejection and includes the router response body", async () => {
		const responseBody = '{"error":{"code":500,"message":"insufficient VRAM"}}';
		const router = rejectingLoadRouter({ status: 500, body: responseBody, statesAfterPost: ["unloaded"] });

		await rejects(ensureLlamaCppResidency(ensureInput(router.fetchImpl, router.modelId)), (error: unknown) => {
			ok(error instanceof Error);
			ok(error.message.includes("HTTP 500"), error.message);
			ok(error.message.includes(responseBody), error.message);
			return true;
		});

		strictEqual(router.modelReads(), 2, "a definitively unloaded re-read rejects without entering the wait loop");
	});

	it("capacity-full eviction picks the non-protected resident, spares the pinned scout, and config-protected models", async () => {
		setProtectedModelsProvider(() => ["configured-model"]);
		const router = fakeRouter(
			[
				{ id: SCOUT, state: "loaded", tags: ["role:scout", "pinned:true"] },
				{ id: "configured-model", state: "loaded" },
				{ id: "old-scratch", state: "loaded" },
				{ id: "new-code", state: "unloaded" },
			],
			3,
		);

		await ensureLlamaCppResidency(ensureInput(router.fetchImpl, "new-code"));

		deepStrictEqual(router.posts(), [
			["http://mini:8080/models/unload", { model: "old-scratch" }],
			["http://mini:8080/models/load", { model: "new-code" }],
		]);
		strictEqual(router.states.get(SCOUT), "loaded");
		strictEqual(router.states.get("configured-model"), "loaded");
	});

	it("declines with an error notice when every slot is pinned", async () => {
		const router = fakeRouter(
			[
				{ id: SCOUT, state: "loaded", tags: ["role:scout", "pinned:true"] },
				{ id: "pinned-coder", state: "loaded", tags: ["pinned:true"] },
			],
			2,
		);

		await ensureLlamaCppResidency(ensureInput(router.fetchImpl, "third-model"));

		deepStrictEqual(router.posts(), []);
		strictEqual(notices.at(-1)?.kind, "will-not-fit");
		strictEqual(notices.at(-1)?.level, "error");
	});

	/**
	 * The mini stranding of 2026-08-16 (#72): on a one-slot router a pinned
	 * override displaced the configured worker model, and because a pinned
	 * resident is never an eviction candidate, the worker model could not come
	 * back until someone unloaded the override by hand on the server.
	 */
	it("capacity-1: declines a pinned override instead of stranding the configured worker model (#72)", async () => {
		setProtectedModelsProvider(() => [{ modelId: "Nemo-3.5-Lightning", role: "worker" as const }]);
		const router = fakeRouter(
			[
				{ id: "Nemo-3.5-Lightning", state: "loaded" },
				{ id: SCOUT, state: "unloaded", tags: ["pinned:true"] },
			],
			1,
		);

		await ensureLlamaCppResidency(ensureInput(router.fetchImpl, SCOUT));

		deepStrictEqual(router.posts(), [], "no unload and no load may happen");
		strictEqual(router.states.get("Nemo-3.5-Lightning"), "loaded");
		strictEqual(notices.at(-1)?.kind, "will-not-fit");
		strictEqual(notices.at(-1)?.level, "error");
		strictEqual(notices.at(-1)?.detail?.configProtected, true);
		ok(notices.at(-1)?.message.includes("Nemo-3.5-Lightning"), notices.at(-1)?.message);

		// The configured worker model is still servable afterwards.
		resetLlamaCppResidencyState();
		notices = [];
		await ensureLlamaCppResidency(ensureInput(router.fetchImpl, "Nemo-3.5-Lightning"));
		deepStrictEqual(router.posts(), []);
		strictEqual(
			notices.some((notice) => notice.kind === "will-not-fit"),
			false,
		);
	});

	it("capacity-1: a pinned override still displaces an unprotected resident", async () => {
		const router = fakeRouter(
			[
				{ id: "scratch", state: "loaded" },
				{ id: SCOUT, state: "unloaded", tags: ["pinned:true"] },
			],
			1,
		);

		await ensureLlamaCppResidency(ensureInput(router.fetchImpl, SCOUT));

		deepStrictEqual(router.posts(), [
			["http://mini:8080/models/unload", { model: "scratch" }],
			["http://mini:8080/models/load", { model: SCOUT }],
		]);
	});

	it("CLIO_CODER_RESIDENCY/lifecycle opt-out (managed=false) observes without loading or unloading", async () => {
		const router = fakeRouter(
			[
				{ id: SCOUT, state: "loaded", tags: ["role:scout", "pinned:true"] },
				{ id: "other", state: "loaded" },
				{ id: "wanted", state: "unloaded" },
			],
			2,
		);

		await ensureLlamaCppResidency(ensureInput(router.fetchImpl, "wanted", false));

		deepStrictEqual(router.posts(), [], "observe-only must never mutate the router");
	});

	it("TTL-dedupes repeat ensures for the same (target, model)", async () => {
		let now = 1_000;
		const router = fakeRouter([{ id: CODER, state: "loaded", tags: ["role:code"] }], 2);
		const input = { ...ensureInput(router.fetchImpl, CODER), now: () => now, ttlMs: 10_000 };

		await ensureLlamaCppResidency(input);
		const callsAfterFirst = router.calls.length;
		ok(callsAfterFirst > 0);

		now += 100;
		await ensureLlamaCppResidency(input);
		strictEqual(router.calls.length, callsAfterFirst, "a TTL-fresh ensure must not refetch");
	});

	it("restores a pinned resident displaced by a capacity-unknown load", async () => {
		// Without readable capacity the router may satisfy the load by
		// displacing its LRU resident. The fake mimics that: loading new-code
		// silently unloads the scout once.
		const calls: RouterCall[] = [];
		let modelPolls = 0;
		const fetchImpl = (async (url: unknown, init?: RequestInit) => {
			const href = String(url);
			const method = init?.method ?? "GET";
			const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
			calls.push({ url: href, method, body });
			if (href === "http://mini:8080/v1/models") {
				modelPolls += 1;
				const entries =
					modelPolls === 1
						? [
								{ id: SCOUT, state: "loaded", tags: ["role:scout", "pinned:true"] },
								{ id: "old-code", state: "loaded", tags: ["role:code"] },
								{ id: "new-code", state: "unloaded", tags: ["role:code"] },
							]
						: modelPolls < 4
							? [
									{ id: SCOUT, state: "unloaded", tags: ["role:scout", "pinned:true"] },
									{ id: "new-code", state: "loaded", tags: ["role:code"] },
								]
							: [
									{ id: SCOUT, state: "loaded", tags: ["role:scout", "pinned:true"] },
									{ id: "new-code", state: "loaded", tags: ["role:code"] },
								];
				return jsonResponse(modelsPayload(entries));
			}
			if (href === "http://mini:8080/props") return jsonResponse({});
			if (href === "http://mini:8080/models/unload" || href === "http://mini:8080/models/load") {
				return jsonResponse({ ok: true });
			}
			throw new Error(`unexpected fetch ${method} ${href}`);
		}) as typeof fetch;

		await ensureLlamaCppResidency(ensureInput(fetchImpl, "new-code"));

		deepStrictEqual(
			calls.filter((call) => call.method === "POST").map((call) => [call.url, call.body]),
			[
				["http://mini:8080/models/unload", { model: "old-code" }],
				["http://mini:8080/models/load", { model: "new-code" }],
				["http://mini:8080/models/load", { model: SCOUT }],
			],
		);
		ok(
			!calls.some(
				(call) => call.url === "http://mini:8080/models/unload" && JSON.stringify(call.body ?? {}).includes("MiniCPM"),
			),
			"scout/pinned resident must never be unloaded",
		);
	});

	it("does not manage non-router llama.cpp model payloads", async () => {
		const calls: string[] = [];
		const fetchImpl = (async (url: unknown, init?: RequestInit) => {
			calls.push(`${init?.method ?? "GET"} ${String(url)}`);
			return jsonResponse({ data: [{ id: "new-code", object: "model", owned_by: "llamacpp" }] });
		}) as typeof fetch;

		await ensureLlamaCppResidency(ensureInput(fetchImpl, "new-code"));

		deepStrictEqual(calls, ["GET http://mini:8080/v1/models"]);
	});

	it("degrades fetch failures silently and never throws", async () => {
		await ensureLlamaCppResidency(
			ensureInput(
				(async () => {
					throw new Error("offline");
				}) as typeof fetch,
				"coder",
			),
		);
		strictEqual(notices.length, 0);
	});
});

describe("contracts/targets residency summary", () => {
	it("summarizes discovered model load states for the probe notes column", () => {
		strictEqual(residentModelsSummary(undefined), null);
		strictEqual(residentModelsSummary(null), null);
		strictEqual(residentModelsSummary({}), null);
		strictEqual(
			residentModelsSummary({
				a: { state: "loaded" },
				b: { state: "unloaded" },
				c: { state: "loading" },
			}),
			"resident: a, c (loading)",
		);
		strictEqual(residentModelsSummary({ a: { state: "unloaded" }, b: { state: "unknown" } }), "resident: none");
	});
});

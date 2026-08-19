import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	ensureLlamaCppResidency,
	type LlamaCppResidencyInput,
	resetLlamaCppResidencyState,
} from "../../src/engine/apis/llamacpp-residency.js";
import {
	type ResidencyNotice,
	setProtectedModelsProvider,
	setResidencyNoticeSink,
} from "../../src/engine/apis/residency.js";

const RESIDENT = "Qwen3.8-27B-IQ4_NL-262K";
const ABSENT = "Qwen3.8-27B-GONE-262K";

function jsonResponse(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

interface RouterCall {
	url: string;
	method: string;
	body?: unknown;
}

/**
 * Router fake that mirrors the mini node's real failure: /models/load answers
 * 404 for an id it does not serve, while /models/unload happily unloads the
 * resident one. A reconciler that unloads before it checks the catalog leaves
 * this router holding nothing, which is exactly what #127 reproduced live.
 */
function fakeRouter(
	initial: Array<{ id: string; state: string; tags?: string[] }>,
	maxInstances?: number,
	/** Ids whose load is rejected with this status even though the router lists them. */
	loadFailures?: ReadonlyMap<string, number>,
) {
	const states = new Map(initial.map((entry) => [entry.id, entry.state]));
	const tags = new Map(initial.map((entry) => [entry.id, entry.tags ?? []]));
	const calls: RouterCall[] = [];
	const fetchImpl = (async (url: unknown, init?: RequestInit) => {
		const href = String(url);
		const method = init?.method ?? "GET";
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		calls.push({ url: href, method, body });
		if (href.endsWith("/v1/models")) {
			return jsonResponse({
				data: [...states.entries()].map(([id, state]) => ({
					id,
					object: "model",
					status: { value: state },
					tags: tags.get(id) ?? [],
				})),
			});
		}
		if (href.endsWith("/props")) {
			return jsonResponse(maxInstances === undefined ? {} : { max_instances: maxInstances });
		}
		if (href.endsWith("/models/load")) {
			const id = String(body.model);
			if (!states.has(id)) return jsonResponse({ error: "File Not Found" }, 404);
			const failure = loadFailures?.get(id);
			if (failure !== undefined) return jsonResponse({ error: "load rejected" }, failure);
			states.set(id, "loaded");
			return jsonResponse({ ok: true });
		}
		if (href.endsWith("/models/unload")) {
			states.set(String(body.model), "unloaded");
			return jsonResponse({ ok: true });
		}
		throw new Error(`unexpected fetch ${method} ${href}`);
	}) as typeof fetch;
	const posts = () => calls.filter((call) => call.method === "POST").map((call) => call.url);
	const resident = () => [...states.entries()].filter(([, state]) => state === "loaded").map(([id]) => id);
	return { fetchImpl, posts, resident, states };
}

function ensureInput(fetchImpl: typeof fetch, keepModelId: string): LlamaCppResidencyInput {
	return {
		baseUrl: "http://mini:8080/v1",
		targetId: "mini",
		runtimeId: "llamacpp",
		keepModelId,
		managed: true,
		fetchImpl,
		withLock: async (_targetKey, fn) => fn(),
	};
}

describe("contracts/llamacpp residency catalog guard (#127)", () => {
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

	it("never unloads the resident model for a keep model the router does not serve", async () => {
		const router = fakeRouter([{ id: RESIDENT, state: "loaded" }], 1);

		await ensureLlamaCppResidency(ensureInput(router.fetchImpl, ABSENT));

		deepStrictEqual(router.posts(), [], "no load or unload may be attempted for an unserved model");
		deepStrictEqual(router.resident(), [RESIDENT], "the resident model stays loaded");
	});

	it("reports why residency was skipped instead of failing silently", async () => {
		const router = fakeRouter([{ id: RESIDENT, state: "loaded" }], 1);

		await ensureLlamaCppResidency(ensureInput(router.fetchImpl, ABSENT));

		strictEqual(notices.length, 1);
		const notice = notices[0];
		ok(notice);
		strictEqual(notice.kind, "will-not-fit");
		strictEqual(notice.level, "error");
		strictEqual(notice.targetId, "mini");
		strictEqual(notice.model, ABSENT);
		match(notice.message, /does not serve/);
	});

	it("restores the evicted model when the replacement load is rejected", async () => {
		// The keep model is in the catalog, so the loadability gate passes and the
		// reconcile proceeds to evict. The load then fails the way an out-of-memory
		// or 5xx load does, which the gate cannot predict.
		const router = fakeRouter(
			[
				{ id: RESIDENT, state: "loaded" },
				{ id: "Qwen3.6-27B-UD-Q4_K_XL-262K", state: "unloaded" },
			],
			1,
			new Map([["Qwen3.6-27B-UD-Q4_K_XL-262K", 500]]),
		);

		let failure: unknown;
		try {
			await ensureLlamaCppResidency(ensureInput(router.fetchImpl, "Qwen3.6-27B-UD-Q4_K_XL-262K"));
		} catch (error) {
			failure = error;
		}

		ok(failure instanceof Error, "the load's own failure still reaches the caller");
		match((failure as Error).message, /HTTP 500/);
		deepStrictEqual(router.resident(), [RESIDENT], "the evicted model is put back rather than left unloaded");
		ok(
			notices.some((notice) => /restored/.test(notice.message)),
			"the restore is reported to the operator",
		);
	});

	it("restores the evicted model when the replacement load 404s after the listing", async () => {
		// TOCTOU: the preset passes the gate because it is in the listing, then
		// disappears before the load. Same P0 shape as the catalog miss, but only
		// the restore can catch it.
		const router = fakeRouter(
			[
				{ id: RESIDENT, state: "loaded" },
				{ id: "Qwen3.6-27B-UD-Q4_K_XL-262K", state: "unloaded" },
			],
			1,
			new Map([["Qwen3.6-27B-UD-Q4_K_XL-262K", 404]]),
		);

		await ensureLlamaCppResidency(ensureInput(router.fetchImpl, "Qwen3.6-27B-UD-Q4_K_XL-262K")).catch(() => undefined);

		deepStrictEqual(router.resident(), [RESIDENT]);
	});

	it("still evicts and loads normally when the keep model is in the catalog", async () => {
		const router = fakeRouter(
			[
				{ id: RESIDENT, state: "loaded" },
				{ id: "Qwen3.6-27B-UD-Q4_K_XL-262K", state: "unloaded" },
			],
			1,
		);

		await ensureLlamaCppResidency(ensureInput(router.fetchImpl, "Qwen3.6-27B-UD-Q4_K_XL-262K"));

		deepStrictEqual(router.resident(), ["Qwen3.6-27B-UD-Q4_K_XL-262K"]);
		ok(
			router.posts().some((url) => url.endsWith("/models/unload")),
			"a full router still frees a slot for a model it does serve",
		);
	});
});
